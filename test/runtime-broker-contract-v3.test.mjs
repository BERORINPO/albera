import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACTIONS_BY_PURPOSE, PURPOSES } from '../src/runtime/broker-contract/action-digest.mjs';
import { MAX_RECEIPT_BYTES } from '../src/runtime/broker-contract/receipt-v2.mjs';
import {
  POLICY_BASIS_ACTIONS, RECEIPT_BASES, RECEIPT_V3_FIELDS, RECEIPT_V3_VERSION, parseReceipt, parseReceiptV3, validateReceipt, validateReceiptV3,
} from '../src/runtime/broker-contract/receipt-v3.mjs';
import { StrictJsonError, parseStrictJson } from '../src/runtime/broker-contract/strict-json.mjs';

// Receipt v3 (issue #115 step 3): the shared vectors for the JS validator, the schema, the v2 compatibility of the dispatcher, and the reference implementation
// of the tier policy rules that the C# side (TierPolicy.cs, run by test/receipt-v2-dotnet-harness) must reproduce.
const contractDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'runtime', 'broker-contract');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(contractDir, name), 'utf8'));
const vectors = readJson('test-vectors-v3.json');
const v2Vectors = readJson('test-vectors.json');
const schema = readJson('receipt-v3.schema.json');

function verdictOf(validate, vector) {
  const bytes = vector.receiptBase64 !== undefined ? Buffer.from(vector.receiptBase64, 'base64') : Buffer.from(vector.receiptJson, 'utf8');
  const { now, environment, expected, actionJson } = vector.context;
  let action = null;
  try { action = parseStrictJson(actionJson, 3); } catch (error) { if (!(error instanceof StrictJsonError)) throw error; }
  const verdict = validate(bytes, { clock: () => now, environment, expected, action });
  return verdict.ok ? { ok: true } : { ok: false, code: verdict.code, ...(verdict.field === undefined ? {} : { field: verdict.field }) };
}

// ---- the tier policy, written out from the rules in TierPolicy.cs (an independent second implementation) ---------------------------------------------------------------------
const KNOWN_ACTIONS = new Set(PURPOSES.flatMap((p) => ACTIONS_BY_PURPOSE[p]));
const policyHash = (rev, tier, prompts) => `sha256:${createHash('sha256').update(['albera.policy-hash.v1', String(rev), tier, ...[...prompts].sort()].join('\0')).digest('hex')}`;
const noPromptSet = (tier, prompts) => (tier === 'standard' ? POLICY_BASIS_ACTIONS.filter((a) => !prompts.includes(a)) : []);

function referencePolicy(text) {
  if (text.length === 0 || Buffer.byteLength(text) > 1024) return null;
  let root;
  try { root = parseStrictJson(text, 2); } catch (error) { if (error instanceof StrictJsonError) return null; throw error; }
  if (Object.keys(root).sort().join() !== 'overrides,rev,tier,v' || root.v !== 1 || !Number.isSafeInteger(root.rev) || root.rev < 0) return null;
  if (!['careful', 'standard'].includes(root.tier) || root.overrides === null || typeof root.overrides !== 'object') return null;
  const prompts = Object.keys(root.overrides);
  if (prompts.some((a) => root.overrides[a] !== 'prompt' || !KNOWN_ACTIONS.has(a))) return null;
  return { rev: root.rev, tier: root.tier, prompts: prompts.sort() };
}

test('v3 vectors: file shape and coverage of the basis, shape and binding boundaries', () => {
  assert.equal(vectors.contract, 'albera.receipt-v3.vectors');
  const names = vectors.receiptVectors.map((v) => v.name);
  assert.equal(new Set(names).size, names.length, 'vector names are unique');
  assert.ok(vectors.receiptVectors.length >= 50 && vectors.policyVectors.length >= 30 && vectors.loosenVectors.length >= 8);
  for (const required of [
    'valid-v3-presence-start', 'valid-v3-policy-environment-inspect', 'valid-v3-policy-environment-stop', 'valid-v3-policy-task-cancel', 'valid-v3-policy-workspace-inspect',
    'valid-v3-policy-version-expected-is-ignored', 'valid-v3-all-ids-at-64-chars', 'v3-policy-basis-refused-for-environment-destroy', 'v3-policy-basis-refused-for-environment-purge',
    'v3-policy-basis-refused-for-environment-create', 'v3-policy-basis-refused-for-environment-start', 'v3-policy-basis-refused-for-task-start-guest',
    'v3-policy-basis-refused-for-synthetic-noop', 'v3-basis-unknown-word', 'v3-basis-grant-reserved', 'v3-basis-missing', 'v3-policy-version-v2-style-label',
    'v3-duplicate-key-basis-later-wins-attack', 'v3-binding-leaseId', 'v3-digest-tampered',
  ]) assert.ok(names.includes(required), `vector ${required} exists`);
});

test('every v3 receipt vector gives the pinned verdict through the dispatching validator and through the v3 validator itself', () => {
  for (const vector of vectors.receiptVectors) {
    assert.deepEqual(verdictOf(validateReceipt, vector), vector.expected, vector.name);
    if (JSON.parse(vector.receiptJson || '{}').v === 3) assert.deepEqual(verdictOf(validateReceiptV3, vector), vector.expected, `${vector.name} (direct)`);
  }
});

test('the dispatcher changes no v2 verdict: every v2 vector gives the same answer through validateReceipt, except a body that claims "v":3', () => {
  assert.ok(v2Vectors.receiptVectors.length >= 80);
  for (const vector of v2Vectors.receiptVectors.filter((v) => v.name !== 'version-3')) assert.deepEqual(verdictOf(validateReceipt, vector), vector.expected, vector.name);
  // A v2-shaped body with "v":3 used to be a `version` failure of v2. It now claims v3, so v3 refuses it for its shape (no basis, a label as policyVersion). Still refused.
  const claimsV3 = v2Vectors.receiptVectors.find((v) => v.name === 'version-3');
  assert.deepEqual(claimsV3.expected, { ok: false, code: 'version', field: 'v' }, 'v2 alone still says version');
  assert.deepEqual(verdictOf(validateReceipt, claimsV3), { ok: false, code: 'schema', field: 'policyVersion' });
});

test('basis: only presence and policy exist; a grant basis and every other word is a schema failure on basis, and a v3 receipt is never read as v2', () => {
  assert.deepEqual(RECEIPT_BASES, ['presence', 'policy']);
  const byName = (name) => vectors.receiptVectors.find((v) => v.name === name).expected;
  for (const name of ['v3-basis-unknown-word', 'v3-basis-grant-reserved', 'v3-basis-grant-bare', 'v3-basis-case-variant', 'v3-basis-empty', 'v3-basis-number', 'v3-basis-missing']) {
    assert.deepEqual(byName(name), { ok: false, code: 'schema', field: 'basis' }, name);
  }
  assert.deepEqual(byName('v3-version-field-is-2'), { ok: false, code: 'schema', field: '$extra' }, 'claims v2 but carries basis: v2 has no such field');
  const valid = vectors.receiptVectors.find((v) => v.name === 'valid-v3-policy-environment-stop');
  assert.equal(parseReceipt(Buffer.from(valid.receiptJson)).receipt.v, RECEIPT_V3_VERSION);
  const v2 = v2Vectors.receiptVectors.find((v) => v.name === 'valid-broker-operation');
  assert.equal(parseReceipt(Buffer.from(v2.receiptJson)).receipt.v, 2);
  assert.equal(parseReceiptV3(Buffer.from(v2.receiptJson)).code, 'schema', 'the v3 parser does not accept a v2 receipt');
});

test('policy basis: the contract caps what a policy can skip to reads and risk-reducing actions; nothing that deletes, creates, starts or runs work', () => {
  assert.deepEqual([...POLICY_BASIS_ACTIONS].sort(), ['environment.inspect', 'environment.stop', 'task.cancel', 'workspace.inspect']);
  for (const action of POLICY_BASIS_ACTIONS) assert.ok(KNOWN_ACTIONS.has(action));
  for (const never of ['environment.create', 'environment.start', 'environment.destroy', 'environment.retire', 'environment.purge', 'task.start', 'synthetic.noop']) {
    assert.equal(POLICY_BASIS_ACTIONS.includes(never), false, never);
  }
  for (const vector of vectors.receiptVectors.filter((v) => v.name.startsWith('v3-policy-basis-refused-for-'))) {
    assert.deepEqual(vector.expected, { ok: false, code: 'basis_action', field: 'basis' }, vector.name);
  }
});

test('the v3 validator table equals receipt-v3.schema.json, and the schema keeps every v2 rule that v3 does not change', () => {
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, RECEIPT_V3_FIELDS.map(([name]) => name));
  const stripped = Object.fromEntries(Object.entries(schema.properties).map(([name, { description, ...rest }]) => {
    assert.equal(typeof description, 'string', `${name} is documented`);
    return [name, rest];
  }));
  assert.deepEqual(stripped, JSON.parse(JSON.stringify(Object.fromEntries(RECEIPT_V3_FIELDS))));
  assert.equal(RECEIPT_V3_FIELDS.length, 23);
  const v2Schema = readJson('receipt-v2.schema.json');
  for (const name of Object.keys(v2Schema.properties).filter((n) => !['v', 'policyVersion', 'approverKeyId'].includes(n))) {
    const { description: _a, ...v3 } = schema.properties[name];
    const { description: _b, ...v2 } = v2Schema.properties[name];
    assert.deepEqual(v3, v2, `${name} is unchanged from v2`);
  }
  assert.deepEqual(RECEIPT_V3_FIELDS.map(([n]) => n).filter((n) => n === 'basis' || n === 'policyVersion'), ['policyVersion', 'basis']);
});

test('the widest v3 receipt fits the same limits as v2 (1280 bytes, the 2 KiB Broker frame)', () => {
  const widest = vectors.receiptVectors.find((v) => v.name === 'valid-v3-all-ids-at-64-chars');
  const size = Buffer.byteLength(widest.receiptJson);
  assert.ok(size <= MAX_RECEIPT_BYTES, `${size} bytes`);
  assert.equal(widest.expected.ok, true);
});

test('policy vectors: the hash, the compact form and the no-prompt set follow the documented rules, and the accept / reject set matches the reference reader', () => {
  for (const vector of vectors.policyVectors) {
    const policy = referencePolicy(vector.json);
    if (!vector.expected.ok) {
      assert.equal(policy, null, `${vector.name} must be rejected`);
      continue;
    }
    assert.ok(policy, `${vector.name} must be accepted`);
    const { rev, tier, prompts } = policy;
    assert.equal(vector.expected.revision, rev, vector.name);
    assert.equal(vector.expected.tier, tier, vector.name);
    assert.deepEqual(vector.expected.prompts, prompts, vector.name);
    assert.equal(vector.expected.hash, policyHash(rev, tier, prompts), `${vector.name}: hash`);
    assert.deepEqual(vector.expected.noPrompt, [...noPromptSet(tier, prompts)].sort(), `${vector.name}: no-prompt set`);
    assert.equal(vector.expected.canonicalJson, JSON.stringify({ v: 1, rev, tier, overrides: Object.fromEntries(prompts.map((a) => [a, 'prompt'])) }), `${vector.name}: compact form`);
    assert.ok(vector.expected.noPrompt.every((a) => POLICY_BASIS_ACTIONS.includes(a)), `${vector.name}: never wider than the contract cap`);
  }
  const careful = vectors.policyVectors.find((v) => v.name === 'careful-rev0-empty').expected;
  assert.deepEqual([careful.noPrompt, careful.hash], [[], policyHash(0, 'careful', [])], 'the default (no file) skips nobody');
  // Same policy, different bytes: the hash is of the meaning.
  const byName = (name) => vectors.policyVectors.find((v) => v.name === name).expected.hash;
  assert.equal(byName('standard-rev3-two-overrides-unordered'), byName('standard-rev3-pretty-printed-same-policy'));
  assert.notEqual(byName('standard-rev1-empty'), byName('standard-rev2-stop-prompts'));
});

test('a policy change needs a presence signature exactly when it lets an action skip a person that could not before (by effect, not by tier name)', () => {
  for (const { name, from, to, loosens } of vectors.loosenVectors) {
    const a = referencePolicy(from);
    const b = referencePolicy(to);
    const before = new Set(noPromptSet(a.tier, a.prompts));
    const added = noPromptSet(b.tier, b.prompts).filter((action) => !before.has(action));
    assert.equal(added.length > 0, loosens, name);
  }
  const effect = (name) => vectors.loosenVectors.find((v) => v.name === name).loosens;
  assert.equal(effect('careful-to-standard'), true);
  assert.equal(effect('standard-to-careful'), false);
  assert.equal(effect('standard-prompt-set-swapped-is-loosening-by-effect'), true, 'a smaller prompt set is not the test: a newly skipped action is');
});

test('the policy message is domain separated from the presence and self-check messages and covers the hash of the complete new policy', () => {
  const { messageHex, policyJson } = vectors.policyMessage;
  const { rev, tier, prompts } = referencePolicy(policyJson);
  const message = Buffer.from(messageHex, 'hex');
  assert.equal(message.toString('utf8'), `albera.policy.v1\0${policyHash(rev, tier, prompts)}`);
  for (const other of ['albera.presence.v1\0', 'albera.selfcheck.v1\0']) {
    assert.equal(message.subarray(0, other.length).equals(Buffer.from(other)), false);
    assert.equal(Buffer.from(other).subarray(0, 'albera.policy.v1\0'.length).equals(Buffer.from('albera.policy.v1\0')), false);
  }
});

test('arch: receipt-v3.mjs is pure like the rest of the contract folder (no clock, env, network or file access)', () => {
  const source = fs.readFileSync(path.join(contractDir, 'receipt-v3.mjs'), 'utf8').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  for (const re of [/\bDate\b/, /\bprocess\./, /\bfetch\(/, /node:/, /\brequire\(/, /\bperformance\./]) assert.ok(!re.test(source), `receipt-v3.mjs matches ${re}`);
});
