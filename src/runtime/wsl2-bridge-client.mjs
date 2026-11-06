import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { captureExecutableIdentity } from './executable-identity.mjs';
import { decodeReply, encodeRequest, maxReplyBytes, WireError, WireFrameReader } from './wsl2-bridge-wire.mjs';

// The Control Plane's client of the WSL bridge (ADR-012, "The WSL bridge"; Proposed / NOT VERIFIED). Nothing wires it to a job yet.
//
// Node cannot see who owns a pipe server, so this file never opens the pipe. Every call starts the trusted pipe client helper (the program `helperPath` names, after its SHA-256 is checked against the
// manifest beside it and the caller's pin) with the single argument `wsl-bridge`:
//   Node -> helper   one start frame [int32 little-endian length][JSON]: { pipeName, timeoutMs, replyTimeoutMs, expect: { ownerSid[, imageSha256] } }
//   helper           opens the pipe with SQOS identification and compares the pipe's owner with `ownerSid` (and the server image with `imageSha256`) on the CONNECTED handle
//   helper -> Node   one frame in the same form: { ok: true } or { ok: false, code }
//   Node -> helper   only after { ok: true }: the wire request. The helper relays those bytes, then the bridge's reply, without reading them.
// So nothing of a lease, a command or a file is handed over before the server is proved, and a server that fails the check gets no byte: the call is refused with `server_identity_mismatch`.
// This client owns the wire: the frame bounds and every decision about a reply are here and in wsl2-bridge-wire.mjs. The helper's environment is a short allowlist, so no token of this process reaches it.
//
// A failure is a Wsl2BridgeError with a fixed `code` and an `outcome`:
//   not_applied  nothing reached the bridge (the helper, the identity check, a bad argument)
//   refused      the bridge answered with a refusal word (`code` is that word)
//   unknown      the request left and no good reply came (timeout, short read, bad reply): the bridge may have acted
// One request per connection, as the bridge serves it. It takes no lock: the bridge answers `run_busy` to a second call on a run.

export const BRIDGE_CLIENT_DEFAULTS = Object.freeze({ connectTimeoutMs: 5000, beginTimeoutMs: 300_000, execGraceMs: 35_000, fileTimeoutMs: 35_000, endTimeoutMs: 60_000,
  bundleTimeoutMs: 120_000 + 60_000, // the bridge lets git run 120 s and waits 30 s more for the agent; the rest is for carrying up to 64 MiB through the helper
  statusTimeoutMs: 65_000, // the bridge's own git reads a head in at most 60 s
});
export const STATUS_REQUEST_ID = 'status'; // the id field of a status frame: no run is named
export const HELPER_MODE = 'wsl-bridge';
const MAX_REPLY_TIMEOUT_MS = 3_890_000; // plus the grace: within the helper's bound of 3,900,000
const MIN_REPLY_TIMEOUT_MS = 1000;
const HELPER_GRACE_MS = 3000; // the connect wait is the helper's and this catches a helper that hangs past it; the reply wait is ours, and the helper gives up this much later, as a limit for a helper nobody ended
const MAX_HOST_FRAME_BYTES = 256;
const HELPER_ENV_NAMES = Object.freeze(['SystemRoot', 'windir', 'TEMP', 'TMP']);
const PIPE_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/u;
const SID_RE = /^S-1-\d{1,10}(?:-\d{1,10}){1,15}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
// What the helper may say before the request is sent. `broker_unavailable` is its word for a pipe that is not there, whichever server was asked for.
const HELPER_CODES = Object.freeze({ access_denied: 'access_denied', broker_unavailable: 'bridge_unavailable', invalid_request: 'invalid_request', server_identity_mismatch: 'server_identity_mismatch', server_identity_unavailable: 'server_identity_unavailable' });

export class Wsl2BridgeError extends Error {
  constructor(code, outcome) { super(code); this.name = 'Wsl2BridgeError'; this.code = code; this.outcome = outcome; }
}
const notApplied = (code) => new Wsl2BridgeError(code, 'not_applied');

function helperEnvironment() {
  const env = {};
  for (const name of HELPER_ENV_NAMES) if (typeof process.env[name] === 'string') env[name] = process.env[name];
  return env;
}

/** The helper must match the SHA-256 recorded next to it at build time and the digest the caller pinned. Same scheme as the Broker clients. */
async function verifyHelper(helperPath, pinnedSha256) {
  try {
    const manifest = JSON.parse(await readFile(`${helperPath}.manifest.json`, 'utf8'));
    if (manifest?.sha256 !== pinnedSha256) throw new Error('helper_not_the_pinned_build');
    if ((await captureExecutableIdentity(helperPath)).sha256 !== pinnedSha256) throw new Error('helper_digest_mismatch');
  } catch { throw notApplied('helper_unavailable'); }
}

function hostFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const head = Buffer.alloc(4);
  head.writeInt32LE(body.length);
  return Buffer.concat([head, body]);
}

/** The helper's answer once a whole frame is there, with the bytes after it; null while it is incomplete. Throws when it is not one of the two allowed shapes. Nothing was sent yet, so every failure is not_applied. */
function readHelperAnswer(bytes) {
  if (bytes.length < 4) return null;
  const length = bytes.readInt32LE(0);
  if (length < 1 || length > MAX_HOST_FRAME_BYTES) throw notApplied('invalid_response');
  if (bytes.length < 4 + length) return null;
  let answer;
  try { answer = JSON.parse(bytes.subarray(4, 4 + length).toString('utf8')); } catch { throw notApplied('invalid_response'); }
  const keys = answer !== null && typeof answer === 'object' ? Object.keys(answer).sort().join(',') : '';
  if (bytes.length !== 4 + length) throw notApplied('invalid_response'); // nothing was asked yet: more bytes mean the helper is out of step
  if (answer?.ok === true && keys === 'ok') return true;
  if (answer?.ok === false && keys === 'code,ok' && Object.hasOwn(HELPER_CODES, answer.code)) throw notApplied(HELPER_CODES[answer.code]);
  throw notApplied('invalid_response');
}

/** One connection: start the helper, wait for the proof, send `frame`, read one reply of `verb`. Resolves with the reply payload; rejects with a Wsl2BridgeError. */
function exchange(config, verb, frame, replyTimeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let settled = false;
    let spawned = false;
    let sent = false;
    let head = Buffer.alloc(0);
    const reader = new WireFrameReader();
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* already gone */ }
      fn(value);
    };
    const fail = (code) => settle(reject, new Wsl2BridgeError(code, sent ? 'unknown' : 'not_applied'));
    const failWith = (error) => {
      if (error instanceof Wsl2BridgeError) settle(reject, error);
      else fail(error instanceof WireError ? error.code : 'transport_error');
    };
    const arm = (ms) => { clearTimeout(timer); if (!settled) timer = setTimeout(() => fail('timeout'), ms); };
    const onProved = () => {
      sent = true; // from here the outcome is unknown even if the write fails
      arm(replyTimeoutMs);
      child.stdin.write(frame);
    };
    const onData = (chunk) => {
      if (settled) return; // a late answer of a call already refused: it must not send the request or start a timer
      try {
        if (!sent) {
          head = Buffer.concat([head, chunk]);
          if (readHelperAnswer(head) === true) onProved();
          return;
        }
        reader.push(chunk);
        const payload = reader.next(maxReplyBytes(verb));
        if (payload === null) return;
        if (reader.pending) throw new WireError('invalid_response'); // one connection carries one reply
        settle(resolve, payload);
      } catch (error) { failWith(error); }
    };
    try {
      child = config.spawnImpl(config.helperPath, [HELPER_MODE], { shell: false, windowsHide: true, env: helperEnvironment(), stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { fail('helper_unavailable'); return; }
    arm(config.connectTimeoutMs + HELPER_GRACE_MS);
    child.once('spawn', () => { spawned = true; });
    child.once('error', () => fail(spawned ? 'transport_error' : 'helper_unavailable'));
    child.once('close', () => fail(sent ? 'short_read' : 'transport_error')); // a stream that ends part way is never a reply
    child.stdin.on('error', () => {}); // a helper that already exited is reported through its close
    child.stdout.on('data', onData);
    child.stdin.write(hostFrame({ pipeName: config.pipeName, timeoutMs: config.connectTimeoutMs, replyTimeoutMs: replyTimeoutMs + HELPER_GRACE_MS, expect: config.expect }));
  });
}

function readOptions(options) {
  const { pipeName, serverSid, serverImageSha256 = null, helperPath, helperSha256, spawnImpl = spawn, connectTimeoutMs = BRIDGE_CLIENT_DEFAULTS.connectTimeoutMs } = options ?? {};
  const valid = typeof pipeName === 'string' && PIPE_NAME_RE.test(pipeName) && typeof serverSid === 'string' && SID_RE.test(serverSid)
    && (serverImageSha256 === null || (typeof serverImageSha256 === 'string' && SHA256_RE.test(serverImageSha256)))
    && typeof helperPath === 'string' && helperPath.length > 0 && typeof helperSha256 === 'string' && SHA256_RE.test(helperSha256) && typeof spawnImpl === 'function'
    && Number.isInteger(connectTimeoutMs) && connectTimeoutMs >= 100 && connectTimeoutMs <= 30_000;
  if (!valid) throw new TypeError('invalid_wsl2_bridge_client_options');
  return Object.freeze({ pipeName, helperPath, helperSha256, spawnImpl, connectTimeoutMs, expect: Object.freeze({ ownerSid: serverSid, ...(serverImageSha256 === null ? {} : { imageSha256: serverImageSha256 }) }) });
}

/**
 * @param {{ pipeName: string, serverSid: string, serverImageSha256?: string, helperPath: string, helperSha256: string, spawnImpl?: typeof spawn, connectTimeoutMs?: number }} options
 *   `serverSid` is the SID the bridge runs as (the owner's), `helperSha256` the pinned build of the helper. `spawnImpl` is a test seam. A check the helper cannot do fails closed.
 * @returns the eight verbs (the wire verb exec is `run` here; `bundle` and `status` are for the Control Plane only and albera_shell never offers them to the model). Each resolves with the verb's answer or rejects with a Wsl2BridgeError. `timeoutMs` bounds the wait for the reply.
 */
export function createWsl2BridgeClient(options) {
  const config = readOptions(options);

  async function call(verb, encode, timeoutMs) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw notApplied('invalid_request');
    let frame;
    try { frame = encode(); } catch (error) { throw notApplied(error instanceof WireError ? error.code : 'invalid_request'); }
    if (config.spawnImpl === spawn && process.platform !== 'win32') throw notApplied('unsupported_platform');
    await verifyHelper(config.helperPath, config.helperSha256);
    const reply = Math.min(Math.max(timeoutMs, MIN_REPLY_TIMEOUT_MS), MAX_REPLY_TIMEOUT_MS);
    const payload = await exchange(config, verb, frame, reply);
    let decoded;
    try { decoded = decodeReply(verb, payload); } catch (error) { throw new Wsl2BridgeError(error instanceof WireError ? error.code : 'invalid_response', 'unknown'); }
    if (!decoded.ok) throw new Wsl2BridgeError(decoded.reason, 'refused');
    return decoded.value;
  }

  return Object.freeze({
    begin: (runId, lease, { timeoutMs = BRIDGE_CLIENT_DEFAULTS.beginTimeoutMs } = {}) => call('begin', () => encodeRequest.begin(runId, lease), timeoutMs),
    run: (runId, { seconds, command, timeoutMs = seconds * 1000 + BRIDGE_CLIENT_DEFAULTS.execGraceMs }) => call('exec', () => encodeRequest.run(runId, seconds, command), timeoutMs),
    put: (runId, path, data, { timeoutMs = BRIDGE_CLIENT_DEFAULTS.fileTimeoutMs } = {}) => call('put', () => encodeRequest.put(runId, path, data), timeoutMs),
    get: (runId, path, { timeoutMs = BRIDGE_CLIENT_DEFAULTS.fileTimeoutMs } = {}) => call('get', () => encodeRequest.get(runId, path), timeoutMs),
    end: (runId, { timeoutMs = BRIDGE_CLIENT_DEFAULTS.endTimeoutMs } = {}) => call('end', () => encodeRequest.end(runId), timeoutMs),
    stop: (runId, { timeoutMs = BRIDGE_CLIENT_DEFAULTS.endTimeoutMs } = {}) => call('stop', () => encodeRequest.stop(runId), timeoutMs),
    /** The bundle (a Buffer, at most WIRE_LIMITS.maxBundleBytes) of the repository the begin step cloned. The job supplies nothing. A bundle over the bridge's limit is refused as bundle_too_large and ends the run. */
    bundle: async (runId, { timeoutMs = BRIDGE_CLIENT_DEFAULTS.bundleTimeoutMs } = {}) => (await call('bundle', () => encodeRequest.bundle(runId), timeoutMs)).data,
    /** Whether a run could start on this machine's WSL and kernel: { kernelOk, reason }. With `repositoryId`, also `head` (the commit the bridge reads for it, or null). Needs no run. */
    status: ({ repositoryId, timeoutMs = BRIDGE_CLIENT_DEFAULTS.statusTimeoutMs } = {}) => call('status', () => encodeRequest.status(STATUS_REQUEST_ID, repositoryId), timeoutMs),
  });
}
