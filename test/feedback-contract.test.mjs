import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkFeedback, dedupeText, findSecrets, normalizeText, receiptFromBytes, RECEIPT_RE, secretRanges, textsOf,
  FEEDBACK_ENDPOINT, FEEDBACK_ORIGIN, FEEDBACK_MAX_CHARS,
} from '../src/runtime/feedback-contract.mjs';
import { FAKE_SECRETS, FAKE_SECRETS_MORE } from './helpers/fake-secrets.mjs';

// Synthetic look-alikes, put together at run time (test/helpers/fake-secrets.mjs).
const FAKE = FAKE_SECRETS;
const char = (code) => String.fromCharCode(code);

const request = (extra = {}) => ({ v: 1, text: 'The camera froze after approval.', draftId: 'd'.repeat(22), installDay: 'i'.repeat(43), version: '0.2.0 (7403ef2)', ...extra });

test('every secret shape is found once, by its own code, with the range the panel paints', () => {
  for (const [code, value] of Object.entries(FAKE)) {
    const text = `before ${value} after`;
    assert.deepEqual(secretRanges(text), [{ code, start: 7, end: 7 + value.length }], code);
    assert.deepEqual(findSecrets(text), [{ code, length: value.length }], code);
  }
});

test('ranges are sorted and never overlap, even when two rules match the same string', () => {
  const text = `a ${FAKE.github_token} b ${FAKE.anthropic_key} c`;
  const ranges = secretRanges(text);
  assert.deepEqual(ranges.map((range) => range.code), ['github_token', 'anthropic_key']);
  assert.ok(ranges[0].end <= ranges[1].start);
  assert.equal(text.slice(ranges[1].start, ranges[1].end), FAKE.anthropic_key);
});

test('other shapes of the same families are found too, also right after letters when the prefix cannot be part of a word', () => {
  const more = FAKE_SECRETS_MORE;
  for (const text of more) assert.equal(findSecrets(`see ${text} here`).length, 1, text);
  assert.deepEqual(findSecrets(`APIKEY${FAKE.anthropic_key}`).map((hit) => hit.code), ['anthropic_key']);
  assert.deepEqual(findSecrets(`token=${FAKE.github_token}`).map((hit) => hit.code), ['github_token']);
});

test('ordinary words and paths are not secrets', () => {
  for (const text of [
    'task-start-attestation-vectors.json failed', 'ask-for-approval-0123456789abcdefghij', 'risk_live_mode is on', 'the desk-0123456789012345678901 id',
    'commit 7403ef2 broke it', 'mail me at taro@example.com', '/tmp/sk-2026-11-04-session-log.txt', 'xoxo-thanks-for-the-great-app', 'open https://example.com/a:b@c',
    'Authorization: Bearer <redacted>', 'shelf_and_half_done',
  ]) {
    assert.deepEqual(findSecrets(text), [], text);
  }
});

// The Worker has 10 ms of CPU on the Free plan; a quadratic rule took 19 ms on 4000 letters before its scheme got a start and a cap. The bound here is loose
// for slow CI machines (all rules together measured under 0.1 ms on these inputs, 2026-11-04).
test('the scan of the longest text stays fast (no runaway backtracking)', () => {
  const fillers = ['sk-'.repeat(1333), 'a'.repeat(4000), 'a+'.repeat(2000), 'x://a:'.repeat(666), 'SG.'.repeat(1333), 'Authorization: Bearer '.repeat(180),
    `${'eyJ'.repeat(600)}.`, `-----BEGIN PRIVATE KEY-----${'x'.repeat(3970)}`];
  for (const filler of fillers) {
    const started = performance.now();
    secretRanges(filler);
    assert.ok(performance.now() - started < 50, `${filler.slice(0, 12)}...`);
  }
});

test('checkFeedback keeps only the five fields and normalizes the text', () => {
  const result = checkFeedback(request({ text: '  line one\r\nline two  ' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.text, 'line one\nline two');
  assert.ok(Object.isFrozen(result.value));
  assert.deepEqual(Object.keys(result.value), ['v', 'text', 'draftId', 'installDay', 'version']);
  assert.deepEqual(textsOf(result.value), ['line one\nline two', '0.2.0 (7403ef2)']);
});

test('checkFeedback refuses each kind of bad request with its code', () => {
  const cases = [
    [null, 'invalid_request'],
    [request({ kind: 'bug' }), 'invalid_request'],
    [request({ diagnostics: {} }), 'invalid_request'],
    [request({ v: 2 }), 'invalid_request'],
    [request({ draftId: 'short' }), 'invalid_request'],
    [request({ installDay: 'has space in it 123' }), 'invalid_request'],
    [request({ version: '' }), 'invalid_request'],
    [request({ version: `0.2.0${char(10)}` }), 'invalid_request'],
    [request({ text: ' \n ' }), 'empty_text'],
    [request({ text: 'x'.repeat(FEEDBACK_MAX_CHARS + 1) }), 'text_too_long'],
    [request({ text: `right${char(0x202e)}to left` }), 'unsafe_text'],
    [request({ text: `zero${char(0x200b)}width` }), 'unsafe_text'],
    [request({ text: `bell${char(7)}` }), 'unsafe_text'],
    [request({ text: `soft${char(0xad)}hyphen` }), 'unsafe_text'],
    [request({ text: `tag${String.fromCodePoint(0xe0041)}char` }), 'unsafe_text'],
    [request({ text: `lone${char(0x200d)}joiner` }), 'unsafe_text'],
  ];
  for (const [payload, code] of cases) assert.deepEqual(checkFeedback(payload), { ok: false, code }, JSON.stringify(payload)?.slice(0, 80));
});

test('a joiner inside an emoji is ordinary text', () => {
  const coder = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);
  const heart = String.fromCodePoint(0x2764, 0xfe0f, 0x200d, 0x1f525);
  assert.equal(checkFeedback(request({ text: `thanks ${coder} ${heart}` })).ok, true);
});

test('dedupeText folds case, width and white space', () => {
  assert.equal(dedupeText(` ${'Ｈｅｌｌｏ'}\r\n  World `), dedupeText('hello world'));
  assert.equal(normalizeText('a\rb'), 'a\nb');
});

test('receipt numbers have the documented shape and use all 30 bits', () => {
  assert.equal(receiptFromBytes(new Uint8Array([0, 0, 0, 0])), 'FB-0000-00');
  assert.equal(receiptFromBytes(new Uint8Array([255, 255, 255, 255])), 'FB-ZZZZ-ZZ');
  assert.match(receiptFromBytes(new Uint8Array([1, 2, 3, 4])), RECEIPT_RE);
  assert.notEqual(receiptFromBytes(new Uint8Array([0, 0, 0, 4])), receiptFromBytes(new Uint8Array([0, 0, 0, 0])));
  assert.throws(() => receiptFromBytes(new Uint8Array(3)));
});

test('the endpoint is one https origin with a fixed path', () => {
  assert.match(FEEDBACK_ENDPOINT, /^https:\/\/[a-z0-9.-]+\/v1\/feedback$/);
  assert.equal(FEEDBACK_ORIGIN, FEEDBACK_ENDPOINT.replace(/\/v1\/feedback$/, ''));
});
