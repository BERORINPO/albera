// Action digest v1: SHA-256 over a canonical, domain-separated, length-prefixed binary encoding of the action DTO.
// The Approval Authority computes it from the DTO; nothing here accepts a digest from the Control Plane. The C# twin is ActionDigest.cs;
// test-vectors.json pins both (including the preimage bytes). Pure: no I/O, no clock (node:crypto is used for hashing only).
//
//   preimage = UTF8("albera.action-digest.v1") 0x00 enc(purpose) enc(dto)
//   enc(string) = 0x53 u32be(byteLength) utf8        enc(int)  = 0x49 i64be        enc(bool) = 0x42 (0x00|0x01)
//   enc(map)    = 0x4D u32be(entryCount) { enc(key) enc(value) } sorted by key, ordinal (keys are ASCII)
//   digest      = "sha256:" lowercase-hex(SHA-256(preimage))
//
// The DTO is exactly { action, projectId, computerId, args }. args is a flat map of string | safe integer | boolean. Strings are never
// normalized (NFC and NFD forms hash differently) and must be well-formed and free of control / line-separator / bidi characters.
import { createHash } from 'node:crypto';

export const DIGEST_DOMAIN = 'albera.action-digest.v1';
export const PURPOSES = Object.freeze(['broker.operation', 'guest.command']);
export const ACTIONS_BY_PURPOSE = Object.freeze({
  'broker.operation': Object.freeze(['environment.create', 'environment.inspect', 'environment.start', 'environment.stop', 'environment.destroy', 'environment.retire', 'environment.purge', 'synthetic.noop']),
  'guest.command': Object.freeze(['task.start', 'task.cancel', 'workspace.inspect', 'synthetic.noop']),
});
export const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$';
export const MAX_ARGS = 16;
export const MAX_ARG_STRING_BYTES = 256;
const ARG_KEY_RE = /^[a-z][A-Za-z0-9]{0,31}$/;
const ID_RE = new RegExp(ID_PATTERN);
// Control characters, the Arabic letter mark, left/right marks, line/paragraph separators and bidi embeddings/isolates: they can make a
// string look different on the approval screen than the bytes that are hashed. [first, last] code points.
const UNSAFE_RANGES = Object.freeze([[0x0, 0x1f], [0x7f, 0x9f], [0x61c, 0x61c], [0x200e, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]]);
const DTO_KEYS = ['action', 'args', 'computerId', 'projectId'];

export class ActionDigestError extends Error {
  /** @param {string} code @param {string} [field] */
  constructor(code, field) { super(code); this.name = 'ActionDigestError'; this.code = code; this.field = field; }
}
const invalid = (field) => new ActionDigestError('invalid_action', field);

function readPlain(input, field) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid(field);
  const proto = Object.getPrototypeOf(input);
  if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(input).length > 0) throw invalid(field);
  const out = Object.create(null);
  for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    if (!d.enumerable || !Object.hasOwn(d, 'value')) throw invalid(field);
    out[key] = d.value;
  }
  return out;
}

export function isSafeText(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (UNSAFE_RANGES.some(([first, last]) => code >= first && code <= last)) return false;
  }
  return true;
}

/** Validate an action DTO for a purpose and return a frozen normalized copy. @throws {ActionDigestError} code invalid_action */
export function validateActionDto(purpose, dto) {
  if (!PURPOSES.includes(purpose)) throw invalid('purpose');
  const d = readPlain(dto, 'dto');
  const keys = Object.keys(d).sort();
  if (keys.length !== DTO_KEYS.length || keys.some((k, n) => k !== DTO_KEYS[n])) throw invalid('dto');
  if (!ACTIONS_BY_PURPOSE[purpose].includes(d.action)) throw invalid('action');
  for (const f of ['projectId', 'computerId']) if (typeof d[f] !== 'string' || !ID_RE.test(d[f])) throw invalid(f);
  const args = readPlain(d.args, 'args');
  const names = Object.keys(args);
  if (names.length > MAX_ARGS) throw invalid('args');
  for (const name of names) {
    const v = args[name];
    const ok = ARG_KEY_RE.test(name) && (
      (typeof v === 'string' && isSafeText(v) && Buffer.byteLength(v, 'utf8') <= MAX_ARG_STRING_BYTES)
      || (Number.isSafeInteger(v) && !Object.is(v, -0)) || typeof v === 'boolean');
    if (!ok) throw invalid('args');
  }
  return Object.freeze({ action: d.action, projectId: d.projectId, computerId: d.computerId, args: Object.freeze({ ...args }) });
}

function encString(s) {
  const bytes = Buffer.from(s, 'utf8');
  const head = Buffer.alloc(5);
  head[0] = 0x53;
  head.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([head, bytes]);
}
function encValue(v) {
  if (typeof v === 'string') return encString(v);
  if (typeof v === 'boolean') return Buffer.from([0x42, v ? 1 : 0]);
  if (typeof v === 'number') {
    const out = Buffer.alloc(9);
    out[0] = 0x49;
    out.writeBigInt64BE(BigInt(v), 1);
    return out;
  }
  return encMap(v);
}
function encMap(map) {
  const names = Object.keys(map).sort(); // keys are ASCII, so UTF-16 order equals ordinal byte order
  const head = Buffer.alloc(5);
  head[0] = 0x4d;
  head.writeUInt32BE(names.length, 1);
  return Buffer.concat([head, ...names.flatMap((n) => [encString(n), encValue(map[n])])]);
}

/** The exact bytes that are hashed. @returns {Buffer} */
export function canonicalizeAction(purpose, dto) {
  const normalized = validateActionDto(purpose, dto);
  return Buffer.concat([Buffer.from(DIGEST_DOMAIN, 'utf8'), Buffer.from([0]), encString(purpose), encMap(normalized)]);
}

/** @returns {string} "sha256:" + 64 lowercase hex characters */
export function computeActionDigest(purpose, dto) {
  return `sha256:${createHash('sha256').update(canonicalizeAction(purpose, dto)).digest('hex')}`;
}
