// Approval receipt v2 validator (ADR-002 "Receipt v2", Proposed). Pure: no I/O, no ambient clock (the caller injects one).
// The signed content is the JSON bytes as sent. Verify the ECDSA signature over exactly those bytes FIRST (outside this module), then call
// validateReceiptV2 with the verified bytes. The receipt's own actionDigest is never trusted: it is compared with a digest recomputed from the
// trusted action DTO in `ctx.action`. Everything in `ctx.expected` comes from Broker-trusted state, never from the request. The C# twin is
// ReceiptV2.cs; test-vectors.json pins both, and receipt-v2.schema.json must equal RECEIPT_V2_FIELDS (tested).
import { ACTIONS_BY_PURPOSE, ID_PATTERN, PURPOSES, ActionDigestError, computeActionDigest, validateActionDto } from './action-digest.mjs';
import { StrictJsonError, parseStrictJson } from './strict-json.mjs';

export const RECEIPT_VERSION = 2;
export const ISSUER = 'albera-approval-authority';
export const MAX_TTL_SECONDS = 300;
export const DEFAULT_TTL_SECONDS = 120;
export const MAX_IAT_SKEW_SECONDS = 30;
/** 2 KiB wire frame minus the envelope and the base64 of a 64-byte signature leaves about 1.4 KB for the base64 receipt. */
export const MAX_RECEIPT_BYTES = 1280;

const id = { type: 'string', pattern: ID_PATTERN, maxLength: 64 };
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', maxLength: 36 };
// 128 bits as unpadded base64url: 22 characters whose last one carries only 2 bits, so it must be one of A Q g w (canonical form).
const bits128 = { type: 'string', pattern: '^[A-Za-z0-9_-]{21}[AQgw]$', maxLength: 22 };
const counter = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };

/** Field name to JSON Schema fragment. This table is the validator; receipt-v2.schema.json is the same table in file form. */
export const RECEIPT_V2_FIELDS = Object.freeze([
  ['v', { type: 'integer', const: RECEIPT_VERSION }],
  ['kid', id],
  ['issuer', { type: 'string', pattern: '^albera-(approval-authority|test-[a-z0-9-]{1,32})$', maxLength: 44 }],
  ['audience', { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$', maxLength: 64 }],
  ['purpose', { type: 'string', enum: PURPOSES }],
  ['approvalId', uuid],
  ['receiptId', uuid],
  ['nonce', bits128],
  ['operationId', id],
  ['idempotencyKey', id],
  ['action', { type: 'string', enum: [...new Set(PURPOSES.flatMap((p) => ACTIONS_BY_PURPOSE[p]))] }],
  ['actionDigest', { type: 'string', pattern: '^sha256:[0-9a-f]{64}$', maxLength: 71 }],
  ['projectId', id],
  ['computerId', id],
  ['leaseId', id],
  ['leaseGeneration', counter],
  ['brokerEpoch', counter],
  ['brokerChallenge', bits128],
  ['policyVersion', id],
  ['approverKeyId', id],
  ['iat', counter],
  ['exp', counter],
]);

/** Receipt fields that Broker-trusted state must supply; any mismatch is a `binding` failure. projectId, computerId and action come from ctx.action. */
const EXPECTED_FIELDS = Object.freeze(['audience', 'purpose', 'operationId', 'idempotencyKey', 'leaseId', 'leaseGeneration', 'brokerEpoch', 'brokerChallenge', 'policyVersion']);
const BINDING_ORDER = Object.freeze([...EXPECTED_FIELDS, 'projectId', 'computerId', 'action']);

const FIELD_NAMES = new Set(RECEIPT_V2_FIELDS.map(([name]) => name));
const PATTERNS = new Map(RECEIPT_V2_FIELDS.filter(([, s]) => s.pattern).map(([name, s]) => [name, new RegExp(s.pattern)]));
const SPEC = new Map(RECEIPT_V2_FIELDS);

function fits(name, value) {
  const spec = SPEC.get(name);
  if (spec.type === 'integer') return Number.isSafeInteger(value) && (spec.const === undefined || value === spec.const) && (spec.minimum === undefined || value >= spec.minimum);
  if (typeof value !== 'string') return false;
  if (spec.enum) return spec.enum.includes(value);
  return value.length <= spec.maxLength && PATTERNS.get(name).test(value);
}

const fail = (code, field) => Object.freeze(field === undefined ? { ok: false, code } : { ok: false, code, field });

/** @returns {{ok:true, receipt:object}|{ok:false, code:string, field?:string}} */
function parseReceiptBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) return fail('malformed');
  let data;
  try {
    data = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), 1); // a receipt is flat: nested objects are malformed
  } catch (error) {
    if (error instanceof StrictJsonError || error instanceof TypeError) return fail('malformed');
    throw error;
  }
  if (Object.keys(data).some((key) => !FIELD_NAMES.has(key))) return fail('schema', '$extra');
  for (const [name] of RECEIPT_V2_FIELDS) {
    if (!Object.hasOwn(data, name)) return fail('schema', name);
    if (name !== 'v' ? !fits(name, data[name]) : !Number.isSafeInteger(data.v)) return fail('schema', name);
  }
  if (data.v !== RECEIPT_VERSION) return fail('version', 'v');
  return Object.freeze({ ok: true, receipt: Object.freeze(data) });
}

/** Structure only (grammar, exact keys, types, formats, version). Says nothing about trust; use validateReceiptV2 before acting on a receipt. */
export function parseReceiptV2(bytes) {
  return parseReceiptBytes(bytes);
}

/** An injected clock that throws or returns anything but a non-negative safe integer is an unusable context (fail closed). */
function readClock(clock) {
  try {
    const now = clock();
    return Number.isSafeInteger(now) && now >= 0 ? now : null;
  } catch {
    return null;
  }
}

function readContext(ctx) {
  try {
    const { clock, environment, expected, action } = ctx ?? {};
    if (typeof clock !== 'function' || (environment !== 'production' && environment !== 'test')) return null;
    const now = readClock(clock);
    if (now === null) return null;
    if (expected === null || typeof expected !== 'object') return null;
    for (const name of EXPECTED_FIELDS) if (!fits(name, expected[name])) return null;
    const dto = validateActionDto(expected.purpose, action);
    return { now, environment, expected, dto };
  } catch (error) {
    if (error instanceof ActionDigestError || error instanceof TypeError) return null;
    throw error;
  }
}

/**
 * Full verdict for receipt bytes whose signature has already been verified.
 * @param {Uint8Array} bytes the signed JSON, byte for byte
 * @param {{clock: () => number, environment: 'production'|'test', expected: object, action: object}} ctx
 *   clock returns Unix seconds; expected holds audience, purpose, operationId, idempotencyKey, leaseId, leaseGeneration, brokerEpoch,
 *   brokerChallenge and policyVersion from trusted state; action is the trusted action DTO (digest, projectId, computerId, action derive from it)
 * @returns {{ok:true, receipt:object}|{ok:false, code:string, field?:string}} codes: invalid_context malformed schema version issuer action_pair ttl
 *   not_yet_valid expired binding action_digest. Checks run in that order; `field` is only ever a fixed field name or "$extra".
 */
export function validateReceiptV2(bytes, ctx) {
  const context = readContext(ctx);
  if (!context) return fail('invalid_context');
  const parsed = parseReceiptBytes(bytes);
  if (!parsed.ok) return parsed;
  const r = parsed.receipt;
  if (r.issuer !== ISSUER && !(context.environment === 'test' && r.issuer.startsWith('albera-test-'))) return fail('issuer', 'issuer');
  if (!ACTIONS_BY_PURPOSE[r.purpose].includes(r.action)) return fail('action_pair', 'action');
  if (r.exp <= r.iat || r.exp - r.iat > MAX_TTL_SECONDS) return fail('ttl', 'exp');
  if (r.iat > context.now + MAX_IAT_SKEW_SECONDS) return fail('not_yet_valid', 'iat');
  if (context.now >= r.exp) return fail('expired', 'exp');
  const trusted = { ...context.expected, projectId: context.dto.projectId, computerId: context.dto.computerId, action: context.dto.action };
  for (const name of BINDING_ORDER) if (r[name] !== trusted[name]) return fail('binding', name);
  if (r.actionDigest !== computeActionDigest(r.purpose, context.dto)) return fail('action_digest', 'actionDigest');
  return parsed;
}
