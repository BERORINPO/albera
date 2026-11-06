// The WSL bridge's wire format, Node side (ADR-012, "The WSL bridge"). The bridge's Wire.cs, Limits.cs and Reason.cs are the canon; test/runtime-wsl2-bridge-client.test.mjs reads those files and fails when
// a number or a word here differs, and the bridge's own harness parses frames made here. Pure: no process, file or clock access.
//
//   frame     u32 big-endian length, then that many bytes. Length 0 is never valid. One connection carries one request and one reply.
//   request   u8 verb, u8 id length (1..64), id (ASCII, the operation id), then the body
//               1 begin  body = the signed run lease as strict JSON      2 exec  body = u32 seconds, command (UTF-8)
//               3 put    body = u32 path length, path, data              4 get   body = path
//               5 end    body empty                                      6 stop  body empty
//   response  u8 status (0 ok, 1 refused), then for ok the verb's answer, for refused one fixed word
//               begin: empty    exec: i32 exit code, u8 flags (1 output cut, 2 out of time), output    put: empty    get: the bytes    end, stop: empty
// There is no field for a Windows path, a Windows command line or a distribution name. Everything in a reply except the status and the refusal word comes from the job's side and is data.

const MIB = 1024 * 1024;
export const VERBS = Object.freeze({ begin: 1, exec: 2, put: 3, get: 4, end: 5, stop: 6 });
export const WIRE_LIMITS = Object.freeze({
  maxLeaseBytes: 4096, maxCommandBytes: 64 * 1024, maxPathBytes: 512, maxPutBytes: 16 * MIB, maxGetBytes: 16 * MIB, maxOutputBytes: MIB, maxExecSeconds: 3600,
  maxRequestFrame: 16 * MIB + 512 + 1024, // Limits.MaxRequestFrame: a put of the largest size, its path and the header fields
  maxWordBytes: 64,
});
export const EXEC_FLAGS = Object.freeze({ outputCut: 1, outOfTime: 2 });

/** Every word a refusal can carry (Reason.cs). Any other refusal text is a reply that is not the bridge's. */
export const BRIDGE_REASONS = Object.freeze([
  'bad_frame', 'bad_verb', 'bad_args', 'peer_denied', 'internal',
  'lease_missing', 'lease_malformed', 'lease_signature', 'lease_not_yet_valid', 'lease_expired', 'lease_target', 'lease_generation', 'lease_used', 'base_moved', 'repository_unknown', 'head_unreadable',
  'image_missing', 'image_hash', 'wsl_unavailable', 'wsl_old', 'kernel_old', 'floor_expired', 'run_name', 'run_exists', 'too_many_runs', 'state_unwritable', 'state_full', 'import_failed',
  'agent_start', 'bundle_failed', 'bundle_too_large',
  'no_run', 'run_busy', 'calls_exhausted', 'too_large', 'bad_path', 'agent_gone', 'agent_limit', 'agent_timeout', 'unregister_failed',
  'agent_bad_path', 'agent_too_large', 'agent_file_error', 'agent_no_start', 'agent_failed',
]);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const WORD_MAX_REPLY = 1 + WIRE_LIMITS.maxWordBytes;
const EXEC_HEADER_BYTES = 5;
const MAX_REPLY = Object.freeze({
  begin: WORD_MAX_REPLY, put: WORD_MAX_REPLY, end: WORD_MAX_REPLY, stop: WORD_MAX_REPLY,
  exec: 1 + EXEC_HEADER_BYTES + WIRE_LIMITS.maxOutputBytes, get: 1 + WIRE_LIMITS.maxGetBytes,
});

/** A request that cannot be sent, or a reply that is not one. `code` is fixed text; the message never holds a value. */
export class WireError extends Error {
  constructor(code) { super(code); this.name = 'WireError'; this.code = code; }
}
const invalidRequest = () => new WireError('invalid_request');
const invalidResponse = () => new WireError('invalid_response');
const u32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };

/** The whole frame of a payload. */
export function frameOf(payload) {
  if (payload.length < 1 || payload.length > WIRE_LIMITS.maxRequestFrame) throw invalidRequest();
  return Buffer.concat([u32(payload.length), payload]);
}

function request(verb, id, body = Buffer.alloc(0)) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw invalidRequest();
  const name = Buffer.from(id, 'ascii');
  return frameOf(Buffer.concat([Buffer.from([VERBS[verb], name.length]), name, body]));
}

/** The same rule as Bridge.SafePath: relative, UTF-8, no control character, no backslash, no empty step, no `..` step. It keeps an honest caller honest; it is not a boundary (the job can reach all of /work). */
export function isSafeRunPath(path) {
  if (typeof path !== 'string' || path.length === 0 || Buffer.byteLength(path) > WIRE_LIMITS.maxPathBytes || path.startsWith('/') || !path.isWellFormed()) return false;
  return !/[\u0000-\u001f\\\u007f]/u.test(path) && path.split('/').every((step) => step !== '..' && step.length > 0);
}

const pathBytes = (path) => { if (!isSafeRunPath(path)) throw invalidRequest(); return Buffer.from(path, 'utf8'); };
const asBytes = (value) => { if (typeof value === 'string') return Buffer.from(value, 'utf8'); if (value instanceof Uint8Array) return Buffer.from(value); throw invalidRequest(); };

export const encodeRequest = Object.freeze({
  begin(id, lease) {
    const bytes = asBytes(lease);
    if (bytes.length < 1 || bytes.length > WIRE_LIMITS.maxLeaseBytes) throw invalidRequest();
    return request('begin', id, bytes);
  },
  run(id, seconds, command) {
    const valid = Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= WIRE_LIMITS.maxExecSeconds && typeof command === 'string' && command.length > 0 && !command.includes('\0') && command.isWellFormed();
    if (!valid || Buffer.byteLength(command) > WIRE_LIMITS.maxCommandBytes) throw invalidRequest();
    return request('exec', id, Buffer.concat([u32(seconds), Buffer.from(command, 'utf8')]));
  },
  put(id, path, data) {
    const name = pathBytes(path);
    const bytes = asBytes(data);
    if (bytes.length > WIRE_LIMITS.maxPutBytes) throw invalidRequest();
    return request('put', id, Buffer.concat([u32(name.length), name, bytes]));
  },
  get: (id, path) => request('get', id, pathBytes(path)),
  end: (id) => request('end', id),
  stop: (id) => request('stop', id),
});

/** The largest reply payload a verb can have: what the frame reader is told, so nothing larger is ever buffered. */
export const maxReplyBytes = (verb) => MAX_REPLY[verb];

/** Complete frames out of a stream of chunks. A length of 0 or over the bound is refused from the four header bytes alone, before anything of the body is kept. */
export class WireFrameReader {
  #chunks = [];
  #size = 0;

  get pending() { return this.#size > 0; }

  push(chunk) {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
  }

  /** The next payload, or null while it is incomplete. Throws WireError response_too_large / invalid_response. */
  next(max) {
    if (this.#size < 4) return null;
    if (this.#chunks[0].length < 4) this.#chunks = [Buffer.concat(this.#chunks)];
    const length = this.#chunks[0].readUInt32BE(0);
    if (length === 0) throw invalidResponse();
    if (length > max) throw new WireError('response_too_large');
    if (this.#size < 4 + length) return null;
    const all = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks);
    const rest = all.subarray(4 + length);
    this.#chunks = rest.length > 0 ? [rest] : [];
    this.#size = rest.length;
    return all.subarray(4, 4 + length);
  }
}

function decodeExec(body) {
  if (body.length < EXEC_HEADER_BYTES) throw invalidResponse();
  return { exitCode: body.readInt32BE(0), flags: body[4], output: body.subarray(EXEC_HEADER_BYTES) };
}

/**
 * One reply payload of `verb`. A refusal must be a word of BRIDGE_REASONS; verbs that answer nothing must answer nothing.
 * @returns {{ ok: true, value: object } | { ok: false, reason: string }} `value` is `{}`, `{ data }` for get, or `{ exitCode, flags, output }` for exec
 */
export function decodeReply(verb, payload) {
  if (payload.length < 1 || payload[0] > 1) throw invalidResponse();
  const body = payload.subarray(1);
  if (payload[0] === 1) {
    const reason = body.toString('latin1');
    if (!BRIDGE_REASONS.includes(reason)) throw invalidResponse();
    return { ok: false, reason };
  }
  if (verb === 'exec') return { ok: true, value: decodeExec(body) };
  if (verb === 'get') return { ok: true, value: { data: body } };
  if (body.length !== 0) throw invalidResponse();
  return { ok: true, value: {} };
}
