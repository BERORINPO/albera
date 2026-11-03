import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureExecutableIdentity } from './executable-identity.mjs';

// Secret store of the Control Plane service (docs/architecture/control-plane-service.md "Secret storage" and "Files and ACLs"; Proposed / NOT VERIFIED).
// It keeps a credential the owner types into the room (a Claude Code setup-token, optionally an API key) as a DPAPI blob in `<secretsDir>\<name>.dpapi`.
// DPAPI CurrentUser scope with the entropy `albera.<name>.v1`: only the same account (the Control Plane's virtual account) can open the blob, and only with that entropy.
//
// Node has no DPAPI binding, so every protect / unprotect is one run of the trusted pipe client helper in its `secret` mode (SecretMode.cs): the helper file is checked against
// its SHA-256 manifest first (and against `helperSha256` when the caller pins the build), then started WITHOUT a shell as a child with this process's token.
//   Node -> helper : [int32 LE length][op][entropyLength][entropy][data]    op 1 = protect (plaintext, 1..4096 bytes), op 2 = unprotect (blob, 1..8192 bytes)
//   helper -> Node : [int32 LE length][0][data]   or   [int32 LE length][1][word]   word: invalid_request, too_large, protect_failed, unprotect_failed, internal_error
// Plaintext reaches this process only inside save() (the caller's value) and load() (the returned Buffer). Buffers this module owns are zeroed as soon as the call is over; a JavaScript
// string the caller passed cannot be wiped, and Node gives no guarantee about copies made inside its streams, so this is best effort and is not a claim.
//
// The module never creates `secretsDir`: setup makes the folder with its protected DACL in one call (the installer rule), and a folder that is missing is `store_unavailable`.
// The path comes from the caller. Failures are the fixed codes of SECRET_STORE_ERROR_CODES; no code, message or log line carries a value, a path or text from the OS.
// One writer per name is assumed (the room service). Trust level: the same-user round trip is measured by the integration test; that another identity cannot unprotect was measured in the lab (PR #175).

const DEFAULT_HELPER_PATH = fileURLToPath(new URL('./windows-broker-pipe-client/bin/Release/net10.0-windows/win-x64/publish/albera-windows-broker-pipe-client.exe', import.meta.url)); // arch-allow: the one trusted pipe client helper; its SHA-256 manifest is verified before every launch
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u; // a credential kind: a file name and a part of the entropy, never a path
const OP_PROTECT = 1;
const OP_UNPROTECT = 2;
const REPLY_OK = 0;
const REPLY_REFUSED = 1;
const HELPER_GRACE_MS = 2000;
const HASH_PREFIX_LENGTH = 8;

export const SECRET_LIMITS = Object.freeze({ maxValueBytes: 4096, maxBlobBytes: 8192, defaultTimeoutMs: 10_000, minTimeoutMs: 1000, maxTimeoutMs: 60_000 });
/** The exit code the helper must use with each word it can report (SecretMode.cs); any other pair is `invalid_response`. */
const HELPER_WORD_EXIT = Object.freeze({ invalid_request: 64, too_large: 64, protect_failed: 0, unprotect_failed: 0, internal_error: 70 });
export const SECRET_STORE_ERROR_CODES = Object.freeze([
  'invalid_config', 'invalid_name', 'invalid_value', 'not_found', 'store_unavailable', 'unsupported_platform', 'helper_unavailable', 'timeout', 'transport_error', 'invalid_response',
  ...Object.keys(HELPER_WORD_EXIT),
]);

/** A failure with a fixed code. The message is the code, so nothing else can leak through it. */
export class SecretStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SecretStoreError';
    this.code = code;
  }
}

/** @param {unknown} name @returns {string} the name, when it is a credential kind this store accepts */
export function assertSecretName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw new SecretStoreError('invalid_name');
  return name;
}

/** The DPAPI entropy of a credential kind. */
export const entropyOf = (name) => `albera.${assertSecretName(name)}.v1`;

/** A private copy of the value as bytes (1 to 4096), which the caller wipes with fill(0). A string is UTF-8. */
export function toSecretBuffer(value) {
  const copy = typeof value === 'string' ? Buffer.from(value, 'utf8') : ArrayBuffer.isView(value) ? Buffer.from(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) : null;
  if (copy === null || copy.length < 1 || copy.length > SECRET_LIMITS.maxValueBytes) {
    copy?.fill(0);
    throw new SecretStoreError('invalid_value');
  }
  return copy;
}

/** The first 8 hex digits of the SHA-256 of a value: what the room shows after a save, never the value. */
export const sha256Prefix = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, HASH_PREFIX_LENGTH);

const absent = () => Object.freeze({ present: false, readable: false, sha256Prefix: null, savedAt: null });

/** The helper must match the SHA-256 recorded next to it at build time and, when the caller pinned one, that digest too. Same scheme as the other pipe client launchers. */
async function verifyHelper(helperPath, pinnedSha256) {
  try {
    const manifest = JSON.parse(await readFile(`${helperPath}.manifest.json`, 'utf8'));
    if (typeof manifest?.sha256 !== 'string' || !SHA256_PATTERN.test(manifest.sha256)) throw new Error('invalid_manifest');
    if (pinnedSha256 !== null && manifest.sha256 !== pinnedSha256) throw new Error('helper_not_the_pinned_build');
    if ((await captureExecutableIdentity(helperPath)).sha256 !== manifest.sha256) throw new Error('helper_digest_mismatch');
  } catch { throw new SecretStoreError('helper_unavailable'); }
}

function requestFrame(op, entropy, data) {
  const entropyBytes = Buffer.from(entropy, 'ascii');
  const length = 2 + entropyBytes.length + data.length;
  const frame = Buffer.alloc(4 + length);
  frame.writeInt32LE(length, 0);
  frame[4] = op;
  frame[5] = entropyBytes.length;
  entropyBytes.copy(frame, 6);
  data.copy(frame, 6 + entropyBytes.length);
  return frame;
}

/** The one reply frame of the helper: the data of a success, or the error that a refusal or a malformed reply is. `exitCode` is the helper's. */
function parseReply(chunks, exitCode, maxData) {
  const reply = Buffer.concat(chunks);
  try {
    if (reply.length < 5 || reply.readInt32LE(0) !== reply.length - 4) throw new SecretStoreError('invalid_response');
    if (reply[4] === REPLY_OK) {
      if (exitCode !== 0 || reply.length - 5 < 1 || reply.length - 5 > maxData) throw new SecretStoreError('invalid_response');
      return Buffer.from(reply.subarray(5));
    }
    const word = reply.subarray(5).toString('latin1');
    if (reply[4] !== REPLY_REFUSED || !Object.hasOwn(HELPER_WORD_EXIT, word) || HELPER_WORD_EXIT[word] !== exitCode) throw new SecretStoreError('invalid_response');
    throw new SecretStoreError(word);
  } finally { reply.fill(0); }
}

/** One helper run: one request frame in, one reply frame out. Resolves with the data, rejects with a SecretStoreError, never leaves a child running. */
function runHelper(spawnImpl, helperPath, frame, maxData, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let child;
    let spawned = false;
    let settled = false;
    let timer;
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* already gone */ }
      frame.fill(0);
      try { settle(); } finally { for (const chunk of chunks) chunk.fill(0); }
    };
    const fail = (code) => finish(() => reject(new SecretStoreError(code)));
    try {
      child = spawnImpl(helperPath, ['secret'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { fail('helper_unavailable'); return; }
    timer = setTimeout(() => fail('timeout'), timeoutMs + HELPER_GRACE_MS);
    child.once('spawn', () => { spawned = true; });
    child.once('error', () => fail(spawned ? 'transport_error' : 'helper_unavailable'));
    child.stdin.on('error', () => {}); // a helper that refuses early closes its stdin; its reply and exit code say why
    child.stdout.on('data', (chunk) => {
      if (settled) { chunk.fill(0); return; }
      chunks.push(chunk);
      received += chunk.length;
      if (received > maxData + 16) fail('invalid_response');
    });
    child.once('close', (code) => finish(() => {
      try { resolve(parseReply(chunks, code, maxData)); } catch (error) { reject(error); }
    }));
    child.stdin.end(frame);
  });
}

/**
 * @param {{ secretsDir: string, helperPath?: string, helperSha256?: string|null, timeoutMs?: number, spawnImpl?: typeof spawn }} options
 *   `secretsDir` is an absolute path made by setup. `helperPath` and `spawnImpl` are test seams (a custom helper needs its `<helperPath>.manifest.json`);
 *   `helperSha256` pins the helper build, as the other launchers' option of the same name does.
 */
export function createControlPlaneSecretStore({ secretsDir, helperPath = DEFAULT_HELPER_PATH, helperSha256 = null, timeoutMs = SECRET_LIMITS.defaultTimeoutMs, spawnImpl } = {}) {
  if (typeof secretsDir !== 'string' || !path.isAbsolute(secretsDir) || typeof helperPath !== 'string' || !Number.isInteger(timeoutMs)
    || timeoutMs < SECRET_LIMITS.minTimeoutMs || timeoutMs > SECRET_LIMITS.maxTimeoutMs || (helperSha256 !== null && !SHA256_PATTERN.test(String(helperSha256)))) {
    throw new SecretStoreError('invalid_config');
  }
  const fileOf = (name) => path.join(secretsDir, `${assertSecretName(name)}.dpapi`);

  async function helper(op, name, data, maxData) {
    if (spawnImpl === undefined && process.platform !== 'win32') throw new SecretStoreError('unsupported_platform');
    await verifyHelper(helperPath, helperSha256);
    return runHelper(spawnImpl ?? spawn, helperPath, requestFrame(op, entropyOf(name), data), maxData, timeoutMs);
  }

  /** Temp file in the same folder, flushed, then renamed over the old blob: a reader sees the old blob or the new one, never half of one. */
  async function writeAtomic(file, blob) {
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await open(temp, 'wx');
      await handle.writeFile(blob);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, file);
    } catch {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw new SecretStoreError('store_unavailable');
    }
  }

  async function savedAtOf(file) {
    try { return (await stat(file)).mtime.toISOString(); } catch { throw new SecretStoreError('store_unavailable'); }
  }

  async function readBlob(file) {
    let blob;
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new SecretStoreError('store_unavailable');
      if (info.size < 1 || info.size > SECRET_LIMITS.maxBlobBytes) throw new SecretStoreError('unprotect_failed'); // not something DPAPI made
      blob = await readFile(file);
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      throw new SecretStoreError(error?.code === 'ENOENT' ? 'not_found' : 'store_unavailable');
    }
    if (blob.length < 1 || blob.length > SECRET_LIMITS.maxBlobBytes) throw new SecretStoreError('unprotect_failed');
    return blob;
  }

  const store = {
    /** Protect and store `value` (a string or bytes, 1 to 4096) under `name`, replacing any earlier one. Resolves with the status; the value is not in it. */
    async save(name, value) {
      const file = fileOf(name);
      const plaintext = toSecretBuffer(value);
      try {
        await writeAtomic(file, await helper(OP_PROTECT, name, plaintext, SECRET_LIMITS.maxBlobBytes));
        return Object.freeze({ present: true, readable: true, sha256Prefix: sha256Prefix(plaintext), savedAt: await savedAtOf(file) });
      } finally { plaintext.fill(0); }
    },

    /** The value as a Buffer that belongs to the caller, who wipes it with fill(0) after use. `not_found` when nothing is stored; `unprotect_failed` when this account cannot open the blob. */
    async load(name) {
      const blob = await readBlob(fileOf(name));
      try { return await helper(OP_UNPROTECT, name, blob, SECRET_LIMITS.maxValueBytes); } finally { blob.fill(0); }
    },

    /** Delete the blob. Resolves true when there was one, false when there was none. */
    async erase(name) {
      try {
        await unlink(fileOf(name));
        return true;
      } catch (error) {
        if (error instanceof SecretStoreError) throw error;
        if (error?.code === 'ENOENT') return false;
        throw new SecretStoreError('store_unavailable');
      }
    },

    /**
     * Whether a credential is stored, whether this account can open it, the first 8 hex digits of its SHA-256 and when it was saved. The value is opened to hash it and wiped at once.
     * `readable: false` is a blob this account cannot open (damaged, or made by another account or after a reinstall): the room asks for the credential again.
     */
    async status(name) {
      const file = fileOf(name);
      let info;
      try { info = await stat(file); } catch (error) {
        if (error?.code === 'ENOENT') return absent();
        throw new SecretStoreError('store_unavailable');
      }
      const savedAt = info.mtime.toISOString();
      try {
        const plaintext = await store.load(name);
        try { return Object.freeze({ present: true, readable: true, sha256Prefix: sha256Prefix(plaintext), savedAt }); } finally { plaintext.fill(0); }
      } catch (error) {
        if (error?.code === 'not_found') return absent();
        if (error?.code === 'unprotect_failed') return Object.freeze({ present: true, readable: false, sha256Prefix: null, savedAt });
        throw error;
      }
    },
  };
  return Object.freeze(store);
}
