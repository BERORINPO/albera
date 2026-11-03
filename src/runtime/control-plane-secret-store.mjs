import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { captureExecutableIdentity } from './executable-identity.mjs';

// Secret store of the Control Plane service (docs/architecture/control-plane-service.md "Secret storage" and "Files and ACLs"; Proposed / NOT VERIFIED).
// It keeps a credential the owner types into the room (a Claude Code setup-token, optionally an API key) as a DPAPI blob in `<secretsDir>\<name>.dpapi`, plus `<name>.meta`:
// a small JSON file with the first 8 hex of the value's SHA-256 and the save time (no plaintext), so that status() reads a file and never decrypts.
// DPAPI CurrentUser scope with the entropy `albera.<name>.v1`: only the same account (the Control Plane's virtual account) can open the blob, and only with that entropy.
// The names are a frozen list, SECRET_NAMES: the two credential kinds of the contract (section 5), nothing else.
//
// Node has no DPAPI binding, so every protect / unprotect is one run of the trusted pipe client helper in its `secret` mode (SecretMode.cs): the helper file is checked against
// its SHA-256 manifest AND against `helperSha256` first, then started WITHOUT a shell as a child with this process's token. `helperPath` (absolute) and `helperSha256` are required,
// with no default, as `desktop.helperPath` / `desktop.helperSha256` are in the room's settings: the caller names the installed helper, never a build output of the repository.
//   Node -> helper : [int32 LE length][op][entropyLength][entropy][data]    op 1 = protect (plaintext, 1..4096 bytes), op 2 = unprotect (blob, 1..8192 bytes)
//   helper -> Node : [int32 LE length][0][data]   or   [int32 LE length][1][word]   word: invalid_request, too_large, protect_failed, unprotect_failed, internal_error
// Plaintext reaches this process only inside save() (the caller's value) and load() (the returned Buffer). Buffers this module owns are zeroed as soon as the call is over; a JavaScript
// string the caller passed cannot be wiped, and Node gives no guarantee about copies made inside its streams, so this is best effort and is not a claim.
//
// The module never creates `secretsDir`: setup makes the folder with its protected DACL in one call (the installer rule), and a folder that is missing is `store_unavailable`.
// The path comes from the caller. Failures are the fixed codes of SECRET_STORE_ERROR_CODES; no code, message or log line carries a value, a path or text from the OS.
// One writer per name is assumed (the room service). Trust level: the same-user round trip is measured by the integration test; that another identity cannot unprotect was measured in the lab (PR #175).

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
/** The credential kinds the Control Plane stores (control-plane-service.md section 5); exactly one is selected in its service settings. A name is a file name and a part of the entropy, never a path. */
export const SECRET_NAMES = Object.freeze(['claude-oauth-token', 'anthropic-api-key']);
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

/** @param {unknown} name @returns {string} the name, when it is one of SECRET_NAMES */
export function assertSecretName(name) {
  if (typeof name !== 'string' || !SECRET_NAMES.includes(name)) throw new SecretStoreError('invalid_name');
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

const SAVED_AT_PATTERN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u;
const META_MAX_BYTES = 256;
const NO_META = Object.freeze({ sha256Prefix: null, savedAt: null });

/** The meta file's text as { sha256Prefix, savedAt }, or NO_META for anything that is not exactly those two keys in their shapes. It holds no secret, so a bad one is simply not shown. */
function parseMeta(text) {
  try {
    const value = JSON.parse(text);
    const keys = value !== null && typeof value === 'object' ? Object.keys(value).sort().join(',') : '';
    if (keys !== 'savedAt,sha256Prefix' || !/^[a-f0-9]{8}$/u.test(value.sha256Prefix) || !SAVED_AT_PATTERN.test(value.savedAt)) return NO_META;
    return Object.freeze({ sha256Prefix: value.sha256Prefix, savedAt: value.savedAt });
  } catch { return NO_META; }
}

/** The helper must match the SHA-256 recorded next to it at build time AND the digest the caller pinned. Same scheme as the other pipe client launchers, with the pin required. */
async function verifyHelper(helperPath, pinnedSha256) {
  try {
    const manifest = JSON.parse(await readFile(`${helperPath}.manifest.json`, 'utf8'));
    if (typeof manifest?.sha256 !== 'string' || !SHA256_PATTERN.test(manifest.sha256)) throw new Error('invalid_manifest');
    if (manifest.sha256 !== pinnedSha256) throw new Error('helper_not_the_pinned_build');
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
 * @param {{ secretsDir: string, helperPath: string, helperSha256: string, timeoutMs?: number, now?: () => Date, spawnImpl?: typeof spawn }} options
 *   `secretsDir` is an absolute path made by setup. `helperPath` (absolute) and `helperSha256` (64 lower-case hex) are REQUIRED: the installed helper and its pinned build, as in the room's
 *   `desktop` settings; the helper also needs its `<helperPath>.manifest.json`. `spawnImpl` and `now` are test seams.
 */
export function createControlPlaneSecretStore({ secretsDir, helperPath, helperSha256, timeoutMs = SECRET_LIMITS.defaultTimeoutMs, now = () => new Date(), spawnImpl } = {}) {
  if (typeof secretsDir !== 'string' || !path.isAbsolute(secretsDir) || typeof helperPath !== 'string' || !path.isAbsolute(helperPath) || typeof helperSha256 !== 'string' || !SHA256_PATTERN.test(helperSha256)
    || !Number.isInteger(timeoutMs) || timeoutMs < SECRET_LIMITS.minTimeoutMs || timeoutMs > SECRET_LIMITS.maxTimeoutMs || typeof now !== 'function') {
    throw new SecretStoreError('invalid_config');
  }
  const blobOf = (name) => path.join(secretsDir, `${assertSecretName(name)}.dpapi`);
  const metaOf = (name) => path.join(secretsDir, `${assertSecretName(name)}.meta`);

  async function helper(op, name, data, maxData) {
    if (spawnImpl === undefined && process.platform !== 'win32') throw new SecretStoreError('unsupported_platform');
    await verifyHelper(helperPath, helperSha256);
    return runHelper(spawnImpl ?? spawn, helperPath, requestFrame(op, entropyOf(name), data), maxData, timeoutMs);
  }

  /** Temp file in the same folder, flushed, then renamed over the old file: a reader sees the old file or the new one, never half of one. */
  async function writeAtomic(file, bytes) {
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await open(temp, 'wx');
      await handle.writeFile(bytes);
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

  /** Delete a file. Resolves true when there was one, false when there was none. */
  async function remove(file) {
    try {
      await unlink(file);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new SecretStoreError('store_unavailable');
    }
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

  /** The meta file, or NO_META when it is missing, too large or not in the documented shape. */
  async function readMeta(file) {
    try {
      const info = await stat(file);
      return info.isFile() && info.size <= META_MAX_BYTES ? parseMeta(await readFile(file, 'utf8')) : NO_META;
    } catch { return NO_META; }
  }

  const store = {
    /**
     * Protect and store `value` (a string or bytes, 1 to 4096) under `name`, replacing any earlier one, and write the meta file beside it. Resolves with the status; the value is not in it.
     * The old meta is removed first and the new one written last, so an interrupted save leaves a blob without meta (status shows no hash) and never a meta that names another value.
     */
    async save(name, value) {
      const file = blobOf(name);
      const plaintext = toSecretBuffer(value);
      try {
        const blob = await helper(OP_PROTECT, name, plaintext, SECRET_LIMITS.maxBlobBytes);
        const meta = { sha256Prefix: sha256Prefix(plaintext), savedAt: now().toISOString() };
        await remove(metaOf(name));
        await writeAtomic(file, blob);
        await writeAtomic(metaOf(name), Buffer.from(`${JSON.stringify(meta)}\n`, 'utf8'));
        return Object.freeze({ present: true, ...meta });
      } finally { plaintext.fill(0); }
    },

    /** The value as a Buffer that belongs to the caller, who wipes it with fill(0) after use. `not_found` when nothing is stored; `unprotect_failed` when this account cannot open the blob. */
    async load(name) {
      const blob = await readBlob(blobOf(name));
      try { return await helper(OP_UNPROTECT, name, blob, SECRET_LIMITS.maxValueBytes); } finally { blob.fill(0); }
    },

    /** Delete the blob and its meta file. Resolves true when there was a blob, false when there was none. */
    async erase(name) {
      const existed = await remove(blobOf(name));
      await remove(metaOf(name));
      return existed;
    },

    /**
     * Whether a credential is stored, the first 8 hex digits of its SHA-256 and when it was saved, from the meta file: nothing is decrypted and no helper runs. The hash and the date are null
     * when the meta file is missing or damaged (an interrupted save). It does not say that this account can open the blob; verify() does.
     */
    async status(name) {
      const file = blobOf(name); // the name is checked before anything else
      let present;
      try { present = (await stat(file)).isFile(); } catch (error) {
        if (error?.code === 'ENOENT') return Object.freeze({ present: false, ...NO_META });
        throw new SecretStoreError('store_unavailable');
      }
      return Object.freeze({ present, ...(present ? await readMeta(metaOf(name)) : NO_META) });
    },

    /**
     * The explicit check: opens the blob (one helper run) and wipes the plaintext at once. `readable: false` is a blob this account cannot open (damaged, or made by another account or after a
     * reinstall): the room asks for the credential again. When readable, the hash is that of the value just opened, so it is right even if the meta file is stale; the date comes from the meta file.
     */
    async verify(name) {
      const meta = await readMeta(metaOf(name));
      try {
        const plaintext = await store.load(name);
        try { return Object.freeze({ present: true, readable: true, sha256Prefix: sha256Prefix(plaintext), savedAt: meta.savedAt }); } finally { plaintext.fill(0); }
      } catch (error) {
        if (error?.code === 'not_found') return Object.freeze({ present: false, readable: false, ...NO_META });
        if (error?.code === 'unprotect_failed') return Object.freeze({ present: true, readable: false, sha256Prefix: null, savedAt: meta.savedAt });
        throw error;
      }
    },
  };
  return Object.freeze(store);
}
