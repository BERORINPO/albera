import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from './executable-identity.mjs';
import { BROKER_CLIENT_LIMITS, validateServerExpectation } from './windows-broker-client.mjs'; // arch-allow: the pipe-server expectation and the timeout bounds have one definition, the Broker client's
import { DESKTOP_BROKER_LIMITS, checkCaptureRequest, checkInputRequest, desktopClientError, readPngHeader } from './desktop-broker-client-contract.mjs';

// Node client for the Host Broker's DESKTOP pipe (ADR-002 "Amendment 2026-11-03", "Desktop pipe" and "Desktop lease"; Proposed / NOT VERIFIED). It replaces the prototype that drives Hyper-V as
// the calling user (hyperv-desktop-broker-prototype.mjs) once the room is wired to it; nothing imports it yet. Interface and errors: desktop-broker-client-contract.mjs.
//
// Node cannot inspect who owns a pipe server, and a desktop session is long (a capture every second) with large replies (a PNG of up to 8 MiB), so the claim client's one-process-per-request
// scheme does not fit. Instead a session is ONE helper process (the same trusted .NET helper, started with the argument `desktop`) that lives while the session does:
//   Node --stdin/stdout frames--> helper --desktop pipe--> Broker        each frame [int32 little-endian length][payload]; the shapes are listed at the top of DesktopSession.cs (the helper side).
// The helper opens the pipe with SQOS identification and, on the connected handle and before it writes the first byte, requires the pipe's owner, the server process id (the SCM's for a service),
// session 0 and the image hash that `expect` names (the same checks, the same code, as for the claim pipe). Only then does it send `open`; this client trusts nothing else about the pipe.
//
// Sessions: `captureVmScreen` uses a `view` session per computer; `sendVmInput` an `act` session per (computer, operationId, leaseGeneration), which a NEWER lease for that computer replaces (a call
// with an older lease never closes a newer lease's session). The lease's generation may be left out (the Control Plane cannot know it): the open then joins the lease that is current for that
// operationId, and the Broker's accepted reply names the generation, which is what "newer" is measured with. One request
// at a time per session; any failure ends the session (a refusal is final: the Broker closes after `denied`), and the next call opens a new one, which is verified again. An unused session is closed
// after `idleCloseMs` (before the Broker's own 60 s idle close). The Broker's reasons never reach this client: a refusal is the fixed `denied` (brokerCode), and it is also the answer for a VM that
// does not exist, a lease that is not current and a capture that failed, so the caller cannot tell those apart (the Broker's own log can).
// Trust level: SAME-USER VERIFIED, like the claim client. The service path (SCM PID, `NT SERVICE` owner, session 0) is NOT VERIFIED until the approved lab run (#23); do not wire this client before then.

const DEFAULT_HELPER_PATH = fileURLToPath(new URL('./windows-broker-pipe-client/bin/Release/net10.0-windows/win-x64/publish/albera-windows-broker-pipe-client.exe', import.meta.url)); // arch-allow: the one trusted pipe client helper; its SHA-256 manifest is verified before every launch
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PIPE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,120}$/u; // plus the `_desktop` suffix: at most 128
const HELPER_GRACE_MS = 3000; // the helper has its own deadlines; this only catches a helper that hangs past them
const CLOSE_WAIT_MS = 2000;
const REQUEST_TIMEOUT_BOUNDS = Object.freeze({ min: 1000, max: 120_000 });
const MAX_IDLE_CLOSE_MS = 55_000;
export const DESKTOP_CLIENT_DEFAULTS = Object.freeze({ openTimeoutMs: BROKER_CLIENT_LIMITS.defaultTimeoutMs, captureTimeoutMs: 20_000, inputTimeoutMs: 45_000, idleCloseMs: 45_000 });
/** The codes the helper itself can report (DesktopSession.cs / Program.cs). Anything else it sends is `invalid_response`, so a helper cannot put its own text into an error. */
const HELPER_CODES = Object.freeze(['denied', 'invalid_request', 'access_denied', 'broker_unavailable', 'server_identity_mismatch', 'server_identity_unavailable', 'timeout', 'transport_error', 'invalid_response', 'response_too_large']);

/** A failure inside a session. `code` is from HELPER_CODES or one of this client's own; `notApplied` is true when nothing reached the Broker that could have acted. */
class SessionFailure extends Error {
  constructor(code, notApplied) {
    super(code);
    this.code = code;
    this.notApplied = notApplied;
  }
}

const toClientError = (failure) => {
  if (!(failure instanceof SessionFailure)) return desktopClientError('desktop_unavailable', 'unknown', 'transport_error');
  return desktopClientError(failure.code === 'timeout' ? 'desktop_broker_timeout' : 'desktop_unavailable', failure.notApplied ? 'not_applied' : 'unknown', failure.code);
};

const frameOf = (value) => {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const head = Buffer.alloc(4);
  head.writeInt32LE(body.length);
  return Buffer.concat([head, body]);
};

/** Complete frames out of a stream of chunks; a large frame is joined once, when it is complete. */
class FrameReader {
  #chunks = [];
  #size = 0;

  get pending() { return this.#size > 0; }

  push(chunk) {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
  }

  /** The next frame body, or null while it is incomplete. Throws RangeError('too_large') above `max` and RangeError('empty') below 1; both are decided before the body is buffered. */
  next(max) {
    if (this.#size < 4) return null;
    if (this.#chunks[0].length < 4) this.#chunks = [Buffer.concat(this.#chunks)];
    const length = this.#chunks[0].readInt32LE(0);
    if (length < 1) throw new RangeError('empty');
    if (length > max) throw new RangeError('too_large');
    if (this.#size < 4 + length) return null;
    const all = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks);
    const rest = all.subarray(4 + length);
    this.#chunks = rest.length > 0 ? [rest] : [];
    this.#size = rest.length;
    return all.subarray(4, 4 + length);
  }
}

const parseObject = (body) => {
  try {
    const value = JSON.parse(body.toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
};
const keysOf = (value) => Object.keys(value).sort().join(',');

/** One helper process = one session. Requests run one at a time; the first failure ends the session for good. */
class DesktopSession {
  #child;
  #reader = new FrameReader();
  #waiter = null;
  #death = null;
  #queue = Promise.resolve();
  #idle = null;
  #busy = true; // the open is in flight until markReady
  #exited;
  #options;
  /** The generation of the lease an act session joined (the Broker's accepted reply); null for a view session. */
  leaseGeneration = null;

  constructor(child, options) {
    this.#child = child;
    this.#options = options;
    let spawned = false;
    this.#exited = new Promise((resolve) => { child.once('close', resolve); child.once('error', resolve); });
    child.once('spawn', () => { spawned = true; });
    child.once('error', () => this.#die(spawned ? 'transport_error' : 'helper_unavailable'));
    child.once('close', () => this.#die('transport_error'));
    child.stdin.on('error', () => {}); // a helper that already exited is reported through its close
    child.stdout.on('data', (chunk) => { this.#reader.push(chunk); this.#pump(); });
  }

  get alive() { return this.#death === null; }

  write(value) { this.#child.stdin.write(frameOf(value)); }

  /** The next frame as a JSON object with `ok: true`. `{ ok: false, code }` ends the session with that code, anything else with invalid_response. */
  async readOk(max, timeoutMs) {
    const object = parseObject(await this.#read(max, timeoutMs));
    if (object?.ok === true) return object;
    throw this.#die(object?.ok === false && keysOf(object) === 'code,ok' && HELPER_CODES.includes(object.code) ? object.code : 'invalid_response');
  }

  /**
   * Send `request`, then read the header; with `size` (a capture) also the PNG frame, which must be what the header says and `size`. Resolves with `{ png }` for a capture and `{}` for an input;
   * rejects with a SessionFailure. Calls queue: the stream carries one request at a time.
   */
  exchange(request, timeoutMs, size = null) {
    const run = async () => {
      if (this.#death !== null) throw new SessionFailure('session_closed', true);
      this.#busy = true;
      clearTimeout(this.#idle);
      const answer = this.readOk(DESKTOP_BROKER_LIMITS.maxReplyHeaderBytes, timeoutMs); // listening before the write: an answer can arrive within it
      this.write(request);
      const header = await answer;
      let reply = {};
      if (size === null) {
        if (keysOf(header) !== 'ok') throw this.#die('invalid_response');
      } else {
        const valid = keysOf(header) === 'bytes,height,ok,width' && header.width === size.width && header.height === size.height
          && Number.isSafeInteger(header.bytes) && header.bytes >= 1 && header.bytes <= DESKTOP_BROKER_LIMITS.maxPngBytes;
        if (!valid) throw this.#die('invalid_response');
        const png = await this.#read(DESKTOP_BROKER_LIMITS.maxPngBytes, timeoutMs);
        const shape = readPngHeader(png);
        if (png.length !== header.bytes || shape?.width !== header.width || shape?.height !== header.height) throw this.#die('invalid_response');
        reply = { png };
      }
      this.markReady();
      return reply;
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => {});
    return result;
  }

  /**
   * The open or the request is answered. More bytes than the answer mean the stream is out of step: the answer is kept, the session is not reused. Otherwise start the idle clock, so an
   * unused session is closed before the Broker's own idle close would make its next request fail.
   */
  markReady() {
    if (this.#reader.pending) this.#die('transport_error');
    this.#busy = false;
    clearTimeout(this.#idle);
    if (this.#death === null) {
      this.#idle = setTimeout(() => { void this.close(); }, this.#options.idleCloseMs);
      this.#idle.unref();
    }
  }

  /** The next frame (at most `max` bytes) within `timeoutMs` plus the helper's grace. */
  #read(max, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.#death !== null) { reject(new SessionFailure(this.#death, false)); return; }
      const timer = setTimeout(() => this.#die('timeout'), timeoutMs + HELPER_GRACE_MS);
      const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
      this.#waiter = { max, resolve: settle(resolve), reject: settle(reject) };
      this.#pump();
    });
  }

  #pump() {
    if (this.#waiter === null) {
      if (!this.#busy && this.#reader.pending) this.#die('transport_error'); // a frame nobody asked for (for example the helper's late timeout): the stream is not trustworthy
      return;
    }
    let body;
    try { body = this.#reader.next(this.#waiter.max); } catch (error) { this.#die(error.message === 'too_large' ? 'response_too_large' : 'invalid_response'); return; }
    if (body === null) return;
    const { resolve } = this.#waiter;
    this.#waiter = null;
    resolve(body);
  }

  /** End the session at once with `code` (the first code wins) and reject what waits. Never throws; returns the failure for `throw this.#die(...)`. */
  #die(code) {
    if (this.#death === null) {
      this.#death = code;
      clearTimeout(this.#idle);
      try { this.#child.kill(); } catch { /* already gone */ }
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter?.reject(this.#failure());
      this.#options.onClose();
    }
    return this.#failure();
  }

  /** What the session died of. Only a request the helper itself called malformed (`invalid_request`) is known not to have been written. */
  #failure() { return new SessionFailure(this.#death, this.#death === 'invalid_request'); }

  /** Close quietly: the helper ends when its stdin does. Resolves when the process is gone (a helper that does not leave within a moment is killed). */
  close() {
    if (this.#death === null) {
      this.#death = 'closed';
      clearTimeout(this.#idle);
      this.#waiter?.reject(new SessionFailure('closed', false));
      this.#waiter = null;
      this.#options.onClose();
      try { this.#child.stdin.end(); } catch { /* already gone */ }
      const killer = setTimeout(() => { try { this.#child.kill(); } catch { /* already gone */ } }, CLOSE_WAIT_MS);
      killer.unref();
      void this.#exited.then(() => clearTimeout(killer));
    }
    return this.#exited;
  }
}

/** The helper must match the SHA-256 recorded next to it at build time and, when the caller pinned one (`helperSha256`), that one too. Same scheme as the claim client. */
async function verifyHelper(helperPath, pinnedSha256) {
  try {
    const manifest = JSON.parse(await readFile(`${helperPath}.manifest.json`, 'utf8'));
    if (typeof manifest?.sha256 !== 'string' || !SHA256_PATTERN.test(manifest.sha256)) throw new Error('invalid_manifest');
    if (pinnedSha256 !== null && manifest.sha256 !== pinnedSha256) throw new Error('helper_not_the_pinned_build');
    if ((await captureExecutableIdentity(helperPath)).sha256 !== manifest.sha256) throw new Error('helper_digest_mismatch');
  } catch { throw new SessionFailure('helper_unavailable', true); }
}

function readOptions(options) {
  const { pipeName, expect, helperPath = DEFAULT_HELPER_PATH, helperSha256 = null, spawnImpl = spawn, openTimeoutMs = DESKTOP_CLIENT_DEFAULTS.openTimeoutMs,
    captureTimeoutMs = DESKTOP_CLIENT_DEFAULTS.captureTimeoutMs, inputTimeoutMs = DESKTOP_CLIENT_DEFAULTS.inputTimeoutMs, idleCloseMs = DESKTOP_CLIENT_DEFAULTS.idleCloseMs } = options ?? {};
  const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  try {
    const valid = typeof pipeName === 'string' && PIPE_NAME_PATTERN.test(pipeName) && typeof helperPath === 'string' && typeof spawnImpl === 'function'
      && (helperSha256 === null || (typeof helperSha256 === 'string' && SHA256_PATTERN.test(helperSha256)))
      && inRange(openTimeoutMs, BROKER_CLIENT_LIMITS.minTimeoutMs, BROKER_CLIENT_LIMITS.maxTimeoutMs)
      && [captureTimeoutMs, inputTimeoutMs].every((ms) => inRange(ms, REQUEST_TIMEOUT_BOUNDS.min, REQUEST_TIMEOUT_BOUNDS.max)) && inRange(idleCloseMs, 1000, MAX_IDLE_CLOSE_MS);
    if (!valid) throw new TypeError('invalid');
    return Object.freeze({ pipeName: `${pipeName}_desktop`, expect: validateServerExpectation(expect), helperPath, helperSha256, spawnImpl, openTimeoutMs, captureTimeoutMs, inputTimeoutMs, idleCloseMs });
  } catch { throw new TypeError('invalid_desktop_broker_client_options'); }
}

/**
 * Verify the helper, start it in desktop mode, send the start frame and wait for the Broker's accepted `open`. Resolves with the session or rejects with a SessionFailure (never applied: an open sends
 * no input). An act open is accepted only with `{ ok: true, leaseGeneration }` (the generation the Broker joined, equal to the one named if any); a view open only with `{ ok: true }`.
 */
async function openSession(config, open, requestTimeoutMs, onClose) {
  if (config.spawnImpl === spawn && process.platform !== 'win32') throw new SessionFailure('unsupported_platform', true);
  await verifyHelper(config.helperPath, config.helperSha256);
  let child;
  try { child = config.spawnImpl(config.helperPath, ['desktop'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { throw new SessionFailure('helper_unavailable', true); }
  const session = new DesktopSession(child, { idleCloseMs: config.idleCloseMs, onClose });
  try {
    const answer = session.readOk(DESKTOP_BROKER_LIMITS.maxReplyHeaderBytes, config.openTimeoutMs);
    session.write({ pipeName: config.pipeName, timeoutMs: config.openTimeoutMs, requestTimeoutMs, expect: config.expect, open });
    const accepted = await answer;
    const joined = accepted.leaseGeneration;
    const valid = open.mode === 'act'
      ? keysOf(accepted) === 'leaseGeneration,ok' && Number.isSafeInteger(joined) && joined >= 1 && (open.leaseGeneration === undefined || open.leaseGeneration === joined)
      : keysOf(accepted) === 'ok';
    if (!valid) throw new SessionFailure('invalid_response', false);
    if (open.mode === 'act') session.leaseGeneration = joined;
  } catch (error) {
    await session.close();
    throw new SessionFailure(error instanceof SessionFailure ? error.code : 'transport_error', true);
  }
  session.markReady();
  if (!session.alive) throw new SessionFailure('transport_error', true); // the helper said more than the accepted open
  return session;
}

/**
 * The desktop Broker client. `pipeName` is the Broker config's pipe name (the claim pipe's; the desktop pipe is `<pipeName>_desktop`), `expect` what the pipe server must be (as for
 * `sendBrokerRequest`: `{ ownerSid, pid }` in tests, `{ serviceName }` in production, optional `imageSha256`). `helperPath` and `spawnImpl` are test seams (a custom helper still needs
 * its `<helperPath>.manifest.json`; `helperSha256` pins the helper build: the manifest must say that digest). Returns a plain object with own data properties only, which is the shape HyperVDesktopDriver
 * accepts as its broker.
 * @param {{ pipeName: string, expect: object, helperPath?: string, helperSha256?: string, spawnImpl?: typeof spawn, openTimeoutMs?: number, captureTimeoutMs?: number, inputTimeoutMs?: number, idleCloseMs?: number }} options
 */
export function createWindowsDesktopBrokerClient(options) {
  const config = readOptions(options);
  const sessions = new Map(); // key -> { promise }
  const acts = new Map(); // computerId -> { entry, generation } of the live act session that holds the newest lease this client knows (a generation is known once its open was answered)
  let closed = false;

  function acquire(key, open, requestTimeoutMs) {
    let entry = sessions.get(key);
    if (entry === undefined) {
      entry = {};
      const forget = () => {
        if (sessions.get(key) === entry) sessions.delete(key);
        if (acts.get(open.computerId)?.entry === entry) acts.delete(open.computerId);
      };
      entry.promise = openSession(config, open, requestTimeoutMs, forget).catch((error) => { forget(); throw error; });
      sessions.set(key, entry);
    }
    return entry;
  }

  /**
   * An act session whose open was answered becomes the computer's lease holder only when its generation is greater than the live holder's, and then closes the holder (a newer lease replaces the
   * older). If it is not newer it is the one that is closed, and its call fails before any input is sent: a call with an older lease must never end a newer lease's session.
   */
  function adoptAct(computerId, entry, session) {
    const live = acts.get(computerId);
    if (live !== undefined && live.entry !== entry) {
      if (session.leaseGeneration <= live.generation) { void session.close(); throw new SessionFailure('lease_superseded', true); }
      void live.entry.promise.then((older) => older.close(), () => {});
    }
    acts.set(computerId, { entry, generation: session.leaseGeneration });
  }

  /** Run `send` on the session for `key`; a session that was closed (idle) between the lookup and the use is replaced once. */
  async function run(key, open, requestTimeoutMs, send) {
    for (let attempt = 0; ; attempt += 1) {
      if (closed) throw desktopClientError('desktop_unavailable', 'not_applied', 'closed');
      try {
        const entry = acquire(key, open, requestTimeoutMs);
        return await send(await entry.promise, entry);
      } catch (error) {
        if (error instanceof SessionFailure && error.code === 'session_closed' && attempt === 0) continue;
        throw toClientError(error);
      }
    }
  }

  return Object.freeze({
    async captureVmScreen(request) {
      const { computerId, width, height } = checkCaptureRequest(request);
      const { png } = await run(`view:${computerId}`, { computerId, mode: 'view' }, config.captureTimeoutMs,
        (session) => session.exchange({ capture: { width, height } }, config.captureTimeoutMs, { width, height }));
      return png;
    },
    async sendVmInput(request) {
      const { computerId, operationId, leaseGeneration, steps } = checkInputRequest(request);
      const key = `act:${computerId}:${operationId}:${leaseGeneration ?? 'current'}`;
      const live = acts.get(computerId);
      // A lease that names a generation older than the live holder's is stale: refuse it without opening anything or touching the holder.
      if (leaseGeneration !== null && live !== undefined && live.entry !== sessions.get(key) && live.generation > leaseGeneration) throw desktopClientError('desktop_unavailable', 'not_applied', 'lease_superseded');
      const open = { computerId, mode: 'act', operationId, ...(leaseGeneration === null ? {} : { leaseGeneration }) };
      await run(key, open, config.inputTimeoutMs, (session, entry) => {
        adoptAct(computerId, entry, session);
        return session.exchange({ input: { steps } }, config.inputTimeoutMs);
      });
      return Object.freeze({ ok: true });
    },
    /** End every session (the helpers exit) and refuse further calls. */
    async close() {
      closed = true;
      await Promise.all([...sessions.values()].map((entry) => entry.promise.then((session) => session.close(), () => {})));
    },
  });
}
