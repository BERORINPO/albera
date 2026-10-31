import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ACTIONS_BY_PURPOSE, ActionDigestError, DIGEST_DOMAIN, PURPOSES, canonicalizeAction, computeActionDigest, validateActionDto,
} from '../src/runtime/broker-contract/action-digest.mjs';
import {
  DEFAULT_TTL_SECONDS, MAX_IAT_SKEW_SECONDS, MAX_RECEIPT_BYTES, MAX_TTL_SECONDS, RECEIPT_V2_FIELDS, parseReceiptV2, validateReceiptV2,
} from '../src/runtime/broker-contract/receipt-v2.mjs';
import { StrictJsonError, parseStrictJson } from '../src/runtime/broker-contract/strict-json.mjs';

const contractDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'runtime', 'broker-contract');
const vectors = JSON.parse(fs.readFileSync(path.join(contractDir, 'test-vectors.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(contractDir, 'receipt-v2.schema.json'), 'utf8'));

/** The verdict shape shared with the C# harness (test/receipt-v2-dotnet-harness). */
export function runDigestVector(vector) {
  try {
    const dto = parseStrictJson(vector.dtoJson, 3);
    return { ok: true, digest: computeActionDigest(vector.purpose, dto), preimageHex: canonicalizeAction(vector.purpose, dto).toString('hex') };
  } catch (error) {
    if (error instanceof StrictJsonError) return { ok: false, code: 'malformed' };
    if (error instanceof ActionDigestError) return { ok: false, code: error.code, field: error.field };
    throw error;
  }
}

export function runReceiptVector(vector) {
  const bytes = vector.receiptBase64 !== undefined ? Buffer.from(vector.receiptBase64, 'base64') : Buffer.from(vector.receiptJson, 'utf8');
  const { now, environment, expected, actionJson } = vector.context;
  let action = null;
  try { action = parseStrictJson(actionJson, 3); } catch (error) { if (!(error instanceof StrictJsonError)) throw error; }
  const verdict = validateReceiptV2(bytes, { clock: () => now, environment, expected, action });
  return verdict.ok ? { ok: true } : { ok: false, code: verdict.code, ...(verdict.field === undefined ? {} : { field: verdict.field }) };
}

test('test vectors: file shape and coverage of every boundary the contract names', () => {
  assert.equal(vectors.contract, 'albera.receipt-v2.vectors');
  assert.ok(vectors.digestVectors.length >= 12 && vectors.receiptVectors.length >= 12);
  const names = new Set([...vectors.digestVectors, ...vectors.receiptVectors].map((v) => v.name));
  assert.equal(names.size, vectors.digestVectors.length + vectors.receiptVectors.length, 'vector names are unique');
  for (const required of [
    'valid-broker-operation', 'valid-ttl-exactly-300', 'ttl-301', 'valid-iat-exactly-now-plus-30', 'iat-now-plus-31', 'expired-at-exactly-exp',
    'valid-last-second-before-exp', 'extra-key', 'missing-nonce', 'wrong-type-leaseGeneration-string', 'duplicate-key', 'test-issuer-rejected-in-production',
    'unicode-raw', 'unicode-escaped-same-digest', 'unicode-nfd-differs', 'key-order-a', 'key-order-b', 'domain-separation-broker', 'domain-separation-guest',
    'digest-tampered', 'digest-computed-under-other-purpose', 'valid-all-ids-at-64-chars',
  ]) assert.ok(names.has(required), `vector ${required} exists`);
});

test('every digest vector gives the pinned verdict, digest and preimage bytes', () => {
  for (const vector of vectors.digestVectors) assert.deepEqual(runDigestVector(vector), vector.expected, vector.name);
});

test('every receipt vector gives the pinned verdict', () => {
  for (const vector of vectors.receiptVectors) assert.deepEqual(runReceiptVector(vector), vector.expected, vector.name);
});

test('action digest: key order and whitespace do not matter; unicode escaping does not matter; normalization is never applied', () => {
  const digest = (name) => vectors.digestVectors.find((v) => v.name === name).expected.digest;
  assert.equal(digest('key-order-a'), digest('key-order-b'));
  assert.equal(digest('key-order-a'), digest('start-mixed-args'));
  assert.equal(digest('whitespace-is-not-part-of-the-digest'), digest('start-mixed-args'));
  assert.equal(digest('unicode-raw'), digest('unicode-escaped-same-digest'));
  assert.notEqual(digest('unicode-raw'), digest('unicode-nfd-differs'));
  assert.equal(digest('escapes-quote-backslash-slash'), digest('escapes-plain-equivalent'));
});

test('action digest: the same DTO under another purpose gives another digest (domain separation), and the domain is part of the preimage', () => {
  const byName = (name) => vectors.digestVectors.find((v) => v.name === name).expected;
  assert.notEqual(byName('domain-separation-broker').digest, byName('domain-separation-guest').digest);
  const dto = { action: 'synthetic.noop', projectId: 'p', computerId: 'c', args: {} };
  const preimage = canonicalizeAction('broker.operation', dto);
  assert.ok(preimage.subarray(0, DIGEST_DOMAIN.length + 1).equals(Buffer.concat([Buffer.from(DIGEST_DOMAIN), Buffer.from([0])])));
  assert.deepEqual(PURPOSES, ['broker.operation', 'guest.command']);
  for (const purpose of PURPOSES) assert.ok(ACTIONS_BY_PURPOSE[purpose].includes('synthetic.noop'));
});

test('action digest: hostile in-memory DTOs are rejected without running their code', () => {
  const dto = { action: 'synthetic.noop', projectId: 'p', computerId: 'c', args: {} };
  let ran = false;
  const getter = { ...dto };
  Object.defineProperty(getter, 'projectId', { enumerable: true, get() { ran = true; return 'p'; } });
  const withSymbol = { ...dto, [Symbol('x')]: 1 };
  class Odd { constructor() { Object.assign(this, dto); } }
  const hostile = [
    getter, withSymbol, new Odd(), null, [], 'x', { ...dto, args: { n: -0 } }, { ...dto, args: { n: 1.5 } }, { ...dto, args: { n: Number.NaN } },
    { ...dto, args: { n: 2 ** 53 } }, { ...dto, args: { n: null } }, { ...dto, args: { n: undefined } }, { ...dto, args: { n: 1n } }, { ...dto, args: Object.create({ inherited: 1 }) },
    { ...dto, args: { note: '\ud800' } }, { ...dto, args: { note: 'a\u0000b' } },
  ];
  for (const bad of hostile) assert.throws(() => computeActionDigest('broker.operation', bad), ActionDigestError);
  assert.equal(ran, false);
  assert.throws(() => computeActionDigest('broker.other', dto), ActionDigestError);
  assert.ok(Object.isFrozen(validateActionDto('broker.operation', dto)));
  assert.ok(Object.isFrozen(validateActionDto('broker.operation', dto).args));
  assert.equal(computeActionDigest('broker.operation', Object.assign(Object.create(null), dto)), computeActionDigest('broker.operation', dto));
});

test('strict JSON: grammar edge cases that must be identical in both languages', () => {
  assert.deepEqual({ ...parseStrictJson('{"a":1}', 1) }, { a: 1 });
  for (const text of ['', '{', '{"a":1', '{"a":1}x', '{"a":1,}', '{"a" 1}', "{'a':1}", '{"a":01}', '{"a":-}', '{"a":+1}', '{"a":1.0}', '{"a":1E1}', '{"a":-0}',
    '{"a":nul}', '{"a":null}', '{"a":[]}', '{"a":"\\x"}', '{"a":"\\u12"}', '{"a":{"b":1}}', '/*c*/{"a":1}', String.fromCharCode(0xfeff) + '{"a":1}', '{"a":1}{"a":1}', '{"a":1,"a":1}']) {
    assert.throws(() => parseStrictJson(text, 1), StrictJsonError, JSON.stringify(text));
  }
  assert.deepEqual({ ...parseStrictJson(' \t\r\n{ "a" : true , "b" : false }\n', 1) }, { a: true, b: false });
  assert.deepEqual({ ...parseStrictJson('{"\\u0061":"\\ud83d\\ude00"}', 1) }, { a: '\u{1f600}' });
  assert.equal(Object.getPrototypeOf(parseStrictJson('{"__proto__":1}', 1)), null);
  assert.throws(() => parseStrictJson('{"a":{"b":{"c":1}}}', 2), StrictJsonError);
  assert.equal(parseStrictJson('{"a":{"b":{"c":1}}}', 3).a.b.c, 1);
});

test('receipt: the validator table equals receipt-v2.schema.json (no drift between code and the published schema)', () => {
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, RECEIPT_V2_FIELDS.map(([name]) => name));
  const stripped = Object.fromEntries(Object.entries(schema.properties).map(([name, { description, ...rest }]) => {
    assert.equal(typeof description, 'string', `${name} is documented`);
    return [name, rest];
  }));
  assert.deepEqual(stripped, JSON.parse(JSON.stringify(Object.fromEntries(RECEIPT_V2_FIELDS))));
  assert.equal(RECEIPT_V2_FIELDS.length, 22);
});

test('receipt: the largest legal receipt fits the 2 KiB Broker frame; TTL constants match the design', () => {
  const widest = vectors.receiptVectors.find((v) => v.name === 'valid-all-ids-at-64-chars');
  const size = Buffer.byteLength(widest.receiptJson);
  assert.ok(size <= MAX_RECEIPT_BYTES, `${size} bytes`);
  const frame = JSON.stringify({ receipt: Buffer.alloc(MAX_RECEIPT_BYTES).toString('base64'), signature: Buffer.alloc(64).toString('base64') });
  assert.ok(Buffer.byteLength(frame) <= 2048, `a ${MAX_RECEIPT_BYTES}-byte receipt frames to ${Buffer.byteLength(frame)} bytes`);
  assert.deepEqual([DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, MAX_IAT_SKEW_SECONDS], [120, 300, 30]);
});

test('receipt: validation never trusts the digest in the receipt and needs the trusted DTO', () => {
  const valid = vectors.receiptVectors.find((v) => v.name === 'valid-broker-operation');
  const bytes = Buffer.from(valid.receiptJson);
  const { now, environment, expected, actionJson } = valid.context;
  const action = parseStrictJson(actionJson, 3);
  const context = { clock: () => now, environment, expected, action };
  const verdict = validateReceiptV2(bytes, context);
  assert.equal(verdict.ok, true);
  assert.ok(Object.isFrozen(verdict) && Object.isFrozen(verdict.receipt));
  assert.equal(verdict.receipt.actionDigest, computeActionDigest('broker.operation', action));
  assert.equal(validateReceiptV2(bytes, { ...context, action: undefined }).code, 'invalid_context');
  assert.equal(validateReceiptV2(bytes, undefined).code, 'invalid_context');
  assert.equal(validateReceiptV2(bytes, { ...context, clock: () => 1.5 }).code, 'invalid_context');
  assert.equal(validateReceiptV2(bytes, { ...context, clock: () => { throw new Error('boom'); } }).code, 'invalid_context');
  assert.equal(validateReceiptV2('{}', context).code, 'malformed');
  assert.equal(validateReceiptV2(bytes.toString(), context).code, 'malformed');
  assert.deepEqual(parseReceiptV2(bytes).receipt.v, 2);
  assert.equal(parseReceiptV2(Buffer.from('{}')).code, 'schema');
});

test('receipt: an error verdict never echoes attacker-controlled text', () => {
  const evil = vectors.receiptVectors.find((v) => v.name === 'extra-key-proto');
  const verdict = runReceiptVector(evil);
  assert.deepEqual(verdict, { ok: false, code: 'schema', field: '$extra' });
  const text = JSON.stringify(vectors.receiptVectors.map((v) => v.expected));
  assert.ok(!/x"|authority|proj-/.test(text));
});

test('arch: the contract folder stays pure (no clock, env, network or file access)', () => {
  const forbidden = [/\bDate\b/, /\bprocess\./, /\bfetch\(/, /node:(?!crypto)/, /\brequire\(/, /\bperformance\./];
  for (const file of ['action-digest.mjs', 'receipt-v2.mjs', 'strict-json.mjs']) {
    const source = fs.readFileSync(path.join(contractDir, file), 'utf8').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
    for (const re of forbidden) assert.ok(!re.test(source), `${file} matches ${re}`);
  }
});

test('retire and purge are new broker.operation actions with their own digests; destroy keeps its meaning and its name (issue #115 step 1)', () => {
  assert.deepEqual(ACTIONS_BY_PURPOSE['broker.operation'].filter((a) => /retire|purge|destroy/.test(a)), ['environment.destroy', 'environment.retire', 'environment.purge']);
  assert.deepEqual(schema.properties.action.enum.filter((a) => /retire|purge|destroy/.test(a)), ['environment.destroy', 'environment.retire', 'environment.purge']);
  assert.equal(ACTIONS_BY_PURPOSE['guest.command'].some((a) => /retire|purge/.test(a)), false);
  const digest = (name) => vectors.digestVectors.find((v) => v.name === name).expected.digest;
  assert.equal(new Set([digest('retire-empty-args'), digest('purge-empty-args'), digest('destroy-empty-args')]).size, 3);
  const verdict = (name) => vectors.receiptVectors.find((v) => v.name === name).expected;
  assert.deepEqual(verdict('valid-retire-operation'), { ok: true });
  assert.deepEqual(verdict('valid-purge-operation'), { ok: true });
  for (const swapped of ['purge-receipt-for-retire-action', 'retire-receipt-for-destroy-action', 'destroy-receipt-for-purge-action']) {
    assert.deepEqual(verdict(swapped), { ok: false, code: 'binding', field: 'action' }, 'a receipt for one action never authorizes another');
  }
});
