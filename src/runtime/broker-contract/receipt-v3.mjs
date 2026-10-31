// Approval receipt v3 validator (docs/architecture/approval-tiers.md, issue #115 step 3). Pure: no I/O, no ambient clock (the caller injects one).
// v3 is receipt v2 plus `basis` (why no further proof was needed) and a `policyVersion` that is the hash of the tier policy in force. v2 rejects unknown
// fields, so the new field cannot live there; v2 stays as it is and is always presence-based. Same rules as receipt-v2.mjs: verify the ECDSA signature over
// exactly the receipt bytes FIRST (outside this module), the receipt's own actionDigest is never trusted, and everything in `ctx.expected` comes from
// Broker-trusted state. The C# twin is ReceiptV3.cs; test-vectors-v3.json pins both, and receipt-v3.schema.json must equal RECEIPT_V3_FIELDS (tested).
//
//   basis `presence`  a person approved this exact action (as in v2)
//   basis `policy`    the Authority's own tier policy said this action needs no person. Only the actions in POLICY_BASIS_ACTIONS can carry it: the contract caps
//                     what a policy may ever skip, so a receipt for any other action with this basis is refused even if the Authority signed it.
//   (a `grant:<id>` basis is reserved for a later step; today it is a schema failure on `basis`)
//
// attestationDigest (optional, step 3b): the digest of the Broker's attestation that the Authority's rule relied on. Present exactly when basis is `policy` and the action is in
// ATTESTED_POLICY_BASIS_ACTIONS; absent for every other receipt. environment.start: a no-person receipt that is only valid with a Broker NETWORK attestation (network-attestation.mjs)
// saying the VM has no network. task.start (step 4): only valid with a Broker TASK-START attestation (task-start-attestation.mjs) saying no network AND a Production checkpoint was
// taken; it travels in this same field (no new receipt field), and the two kinds cannot be mistaken for each other because their domains differ. Such a receipt is also only valid for an
// action whose args name the VM: `args.vmId`, the Hyper-V VM id the attestation was made for (code `attestation`, field `vmId`, when it is missing or malformed). The Broker must refuse
// to start any VM whose own id differs from it.
// environment.create is NOT attested: no VM exists before create, so nothing could be bound; it always needs a person. The Broker has no attestation to compare it with here, so like policyVersion it is checked for its shape and
// for being present or absent as the rule requires; the Authority's signature is what covers it.
//
// policyVersion is checked for its shape only. The Broker has no copy of the Authority's policy to compare it with, so it is an audit field: the Authority's
// signature is what covers it. (In v2 the Broker compares policyVersion with its own configured value; v3 drops that binding.)
import { ACTIONS_BY_PURPOSE, ActionDigestError, computeActionDigest, validateActionDto } from './action-digest.mjs';
import {
  ISSUER, MAX_IAT_SKEW_SECONDS, MAX_RECEIPT_BYTES, MAX_TTL_SECONDS, RECEIPT_V2_FIELDS, parseReceiptV2, validateReceiptV2,
} from './receipt-v2.mjs';
import { isVmId } from './network-attestation.mjs';
import { StrictJsonError, parseStrictJson } from './strict-json.mjs';

export const RECEIPT_V3_VERSION = 3;
export const RECEIPT_BASES = Object.freeze(['presence', 'policy']);
/** What a tier policy may let the Authority sign without a person and without any attestation: reads and risk-reducing actions only. */
export const POLICY_BASIS_ACTIONS = Object.freeze(['environment.inspect', 'environment.stop', 'workspace.inspect', 'task.cancel']);
/** What a tier policy may let the Authority sign without a person ONLY with a Broker attestation (the receipt then carries its digest): a network attestation that says "none" for
 *  environment.start, a task-start attestation (network none + a Production checkpoint) for task.start. Which kind goes with which action is the Authority's rule, not this list's. */
export const ATTESTED_POLICY_BASIS_ACTIONS = Object.freeze(['environment.start', 'task.start']);
/** True for an action that can carry basis policy at all (with or without an attestation). Nothing else can, whatever the Authority signed. */
export const isPolicyBasisAction = (action) => POLICY_BASIS_ACTIONS.includes(action) || ATTESTED_POLICY_BASIS_ACTIONS.includes(action);

/** Field name to JSON Schema fragment: the v2 table with `v` = 3, a hash-shaped `policyVersion` and `basis` right after it. */
export const RECEIPT_V3_FIELDS = Object.freeze(RECEIPT_V2_FIELDS.flatMap(([name, spec]) => {
  if (name === 'v') return [[name, { type: 'integer', const: RECEIPT_V3_VERSION }]];
  if (name === 'policyVersion') return [[name, { type: 'string', pattern: '^sha256:[0-9a-f]{64}$', maxLength: 71 }], ['basis', { type: 'string', enum: RECEIPT_BASES }]];
  return [[name, spec]];
}));

/** Fields a receipt MAY carry (all others are required): the digest of the attestation a no-person rule relied on. Not part of the schema's `required`. */
export const RECEIPT_V3_OPTIONAL_FIELDS = Object.freeze([['attestationDigest', { type: 'string', pattern: '^sha256:[0-9a-f]{64}$', maxLength: 71 }]]);

/** Receipt fields that Broker-trusted state must supply. Unlike v2 there is no policyVersion (see the header). projectId, computerId and action come from ctx.action. */
const EXPECTED_FIELDS = Object.freeze(['audience', 'purpose', 'operationId', 'idempotencyKey', 'leaseId', 'leaseGeneration', 'brokerEpoch', 'brokerChallenge']);
const BINDING_ORDER = Object.freeze([...EXPECTED_FIELDS, 'projectId', 'computerId', 'action']);

const ALL_FIELDS = [...RECEIPT_V3_FIELDS, ...RECEIPT_V3_OPTIONAL_FIELDS];
const FIELD_NAMES = new Set(ALL_FIELDS.map(([name]) => name));
const PATTERNS = new Map(ALL_FIELDS.filter(([, s]) => s.pattern).map(([name, s]) => [name, new RegExp(s.pattern)]));
const SPEC = new Map(ALL_FIELDS);

function fits(name, value) {
  const spec = SPEC.get(name);
  if (spec.type === 'integer') return Number.isSafeInteger(value) && (spec.const === undefined || value === spec.const) && (spec.minimum === undefined || value >= spec.minimum);
  if (typeof value !== 'string') return false;
  if (spec.enum) return spec.enum.includes(value);
  return value.length <= spec.maxLength && PATTERNS.get(name).test(value);
}

const fail = (code, field) => Object.freeze(field === undefined ? { ok: false, code } : { ok: false, code, field });

/** @returns {{ok:true, receipt:object}|{ok:false, code:string, field?:string}} */
export function parseReceiptV3(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) return fail('malformed');
  let data;
  try {
    data = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), 1); // a receipt is flat: nested objects are malformed
  } catch (error) {
    if (error instanceof StrictJsonError || error instanceof TypeError) return fail('malformed');
    throw error;
  }
  if (Object.keys(data).some((key) => !FIELD_NAMES.has(key))) return fail('schema', '$extra');
  for (const [name] of RECEIPT_V3_FIELDS) {
    if (!Object.hasOwn(data, name)) return fail('schema', name);
    if (name !== 'v' ? !fits(name, data[name]) : !Number.isSafeInteger(data.v)) return fail('schema', name);
  }
  for (const [name] of RECEIPT_V3_OPTIONAL_FIELDS) if (Object.hasOwn(data, name) && !fits(name, data[name])) return fail('schema', name);
  if (data.v !== RECEIPT_V3_VERSION) return fail('version', 'v');
  return Object.freeze({ ok: true, receipt: Object.freeze(data) });
}

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
 * Full verdict for receipt v3 bytes whose signature has already been verified. Same context as validateReceiptV2 (a `policyVersion` in `expected` is ignored).
 * @returns {{ok:true, receipt:object}|{ok:false, code:string, field?:string}} codes: invalid_context malformed schema version issuer action_pair basis_action attestation ttl
 *   not_yet_valid expired binding action_digest. Checks run in that order; `field` is only ever a fixed field name or "$extra".
 */
export function validateReceiptV3(bytes, ctx) {
  const context = readContext(ctx);
  if (!context) return fail('invalid_context');
  const parsed = parseReceiptV3(bytes);
  if (!parsed.ok) return parsed;
  const r = parsed.receipt;
  if (r.issuer !== ISSUER && !(context.environment === 'test' && r.issuer.startsWith('albera-test-'))) return fail('issuer', 'issuer');
  if (!ACTIONS_BY_PURPOSE[r.purpose].includes(r.action)) return fail('action_pair', 'action');
  if (r.basis === 'policy' && !isPolicyBasisAction(r.action)) return fail('basis_action', 'basis');
  // The digest is there exactly when a no-person receipt for an attested action needs it: never for a person's approval, never for an action that needs no attestation.
  if (Object.hasOwn(r, 'attestationDigest') !== (r.basis === 'policy' && ATTESTED_POLICY_BASIS_ACTIONS.includes(r.action))) return fail('attestation', 'attestationDigest');
  if (r.basis === 'policy' && ATTESTED_POLICY_BASIS_ACTIONS.includes(r.action) && !isVmId(context.dto.args.vmId)) return fail('attestation', 'vmId');
  if (r.exp <= r.iat || r.exp - r.iat > MAX_TTL_SECONDS) return fail('ttl', 'exp');
  if (r.iat > context.now + MAX_IAT_SKEW_SECONDS) return fail('not_yet_valid', 'iat');
  if (context.now >= r.exp) return fail('expired', 'exp');
  const trusted = { ...context.expected, projectId: context.dto.projectId, computerId: context.dto.computerId, action: context.dto.action };
  for (const name of BINDING_ORDER) if (r[name] !== trusted[name]) return fail('binding', name);
  if (r.actionDigest !== computeActionDigest(r.purpose, context.dto)) return fail('action_digest', 'actionDigest');
  return parsed;
}

/** The version a receipt claims: 3 only for a strict flat JSON object whose `v` is the integer 3, otherwise 2 (v2 then reports whatever is wrong with it). */
function claimsV3(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) return false;
  try {
    return parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), 1).v === RECEIPT_V3_VERSION;
  } catch (error) {
    if (error instanceof StrictJsonError || error instanceof TypeError) return false;
    throw error;
  }
}

/** Structure only, for either version. Anything that does not claim `"v":3` is read as v2, so every v2 verdict is unchanged. */
export function parseReceipt(bytes) {
  return claimsV3(bytes) ? parseReceiptV3(bytes) : parseReceiptV2(bytes);
}

/** Full verdict for either version. A v2 receipt is always presence-based. */
export function validateReceipt(bytes, ctx) {
  return claimsV3(bytes) ? validateReceiptV3(bytes, ctx) : validateReceiptV2(bytes, ctx);
}
