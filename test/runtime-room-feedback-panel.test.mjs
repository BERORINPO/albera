// The feedback panel in room-ui (feedback.mjs, words-feedback.mjs, api.mjs sendFeedback / getFeedback): the pure parts as plain functions, the calls api.mjs makes, the words, the rules the source
// must keep, and the page end to end on a small fake DOM (test/helpers/fake-dom.mjs; there is no browser in the test run). The address is never written here: FEEDBACK_ENDPOINT / FEEDBACK_ORIGIN
// come from the contract, because the real one is not decided yet.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import * as api from '../src/runtime/room-ui/api.mjs';
import { FEEDBACK_ENDPOINT, FEEDBACK_MAX_CHARS, FEEDBACK_RESULT_CODES, RECEIPT_RE } from '../src/runtime/feedback-contract.mjs';
import {
  INSTALL_KEY, REQUEST_VERSION, TOAST_MS, assessText, base64url, buildRequest, draftKey, installDayOf, loadInstallSecret, newDraftId, nextDraft, resultKey, roomState, secretRanges, sendFlow, textProblem, utcDay,
} from '../src/runtime/room-ui/feedback.mjs';
import feedbackWords from '../src/runtime/room-ui/words-feedback.mjs';
import panelWords from '../src/runtime/room-ui/words-panels.mjs';
import { makeWords } from '../src/runtime/room-ui/i18n.mjs';
import { makeFakeDocument } from './helpers/fake-dom.mjs';
import { FAKE_SECRETS } from './helpers/fake-secrets.mjs';

const source = (name) => fs.readFileSync(new URL(`../src/runtime/room-ui/${name}`, import.meta.url), 'utf8');
const words = makeWords(panelWords, feedbackWords);
const original = { document: globalThis.document, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
const realSetTimeout = original.setTimeout;
const until = async (check, what) => {
  for (let i = 0; i < 200; i += 1) { if (check()) return; await new Promise((resolve) => { realSetTimeout(resolve, 5); }); }
  throw new Error(`timed out waiting for ${what}`);
};

// Synthetic look-alikes, put together at run time (test/helpers/fake-secrets.mjs).
const FAKE = {
  anthropic: FAKE_SECRETS.anthropic_key, openai: FAKE_SECRETS.openai_key, github: FAKE_SECRETS.github_token, slack: FAKE_SECRETS.slack_token,
  aws: FAKE_SECRETS.aws_key, google: FAKE_SECRETS.google_key, stripe: FAKE_SECRETS.stripe_key, privateKey: FAKE_SECRETS.private_key, jwt: FAKE_SECRETS.jwt,
};

// ---- ids ----

test('base64url has no padding and no + or /; a draft id is 22 characters of it', () => {
  assert.equal(base64url(new Uint8Array([251, 255, 254])), '-__-');
  assert.equal(base64url(new Uint8Array([1])), 'AQ');
  const id = newDraftId(() => new Uint8Array(16).fill(255));
  assert.match(id, /^[A-Za-z0-9_-]{22}$/u);
  assert.match(newDraftId(), /^[A-Za-z0-9_-]{22}$/u);
  assert.notEqual(newDraftId(), newDraftId());
});

test('the same draft keeps its id, a changed text is a new draft, and a draft with no key yet takes the first key', () => {
  let made = 0;
  const makeId = () => `id-${(made += 1)}`;
  const first = nextDraft({ id: 'start', key: null }, draftKey('hello'), makeId);
  assert.deepEqual(first, { id: 'start', key: 'hello' });
  assert.deepEqual(nextDraft(first, draftKey('  hello \n'), makeId), { id: 'start', key: 'hello' }, 'white space at the ends is not a change');
  assert.deepEqual(nextDraft(first, draftKey('hello!'), makeId), { id: 'id-1', key: 'hello!' });
  assert.equal(made, 1);
});

test('installDayOf is HMAC-SHA256 of the UTC date under the install secret: 43 characters, one value per day, and different installs differ', async () => {
  const secret = new Uint8Array(32).map((_, i) => i + 1);
  const day = new Date('2026-11-04T23:59:59.000Z');
  assert.equal(utcDay(day), '2026-11-04');
  assert.equal(utcDay(new Date('2026-11-05T00:00:00.000Z')), '2026-11-05');
  const value = await installDayOf(secret, day);
  assert.match(value, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(value, createHmac('sha256', secret).update('2026-11-04').digest('base64url'));
  assert.equal(await installDayOf(secret, new Date('2026-11-04T00:00:00.000Z')), value, 'the same UTC day, the same value');
  assert.notEqual(await installDayOf(secret, new Date('2026-11-05T00:00:00.000Z')), value, 'the next day cannot be joined to this one');
  assert.notEqual(await installDayOf(new Uint8Array(32).fill(9), day), value);
});

test('the install secret is 32 random bytes kept under one key; storage that is missing, broken or holds something else gives a page-only secret', () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } };
  const made = loadInstallSecret(storage, (n) => new Uint8Array(n).fill(7));
  assert.equal(made.length, 32);
  assert.deepEqual([...store.keys()], [INSTALL_KEY]);
  assert.equal(INSTALL_KEY, 'albera:v1:feedback-install');
  assert.match(store.get(INSTALL_KEY), /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(loadInstallSecret(storage, () => { throw new Error('a second one must not be made'); }), made, 'the saved one is read back');

  store.set(INSTALL_KEY, 'not a secret');
  assert.equal(loadInstallSecret(storage, (n) => new Uint8Array(n).fill(1)).length, 32);
  assert.notEqual(store.get(INSTALL_KEY), 'not a secret', 'something else under the key is replaced');
  const broken = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
  assert.equal(loadInstallSecret(broken).length, 32);
  assert.equal(loadInstallSecret(undefined).length, 32);
  assert.equal(loadInstallSecret(null).length, 32);
});

// ---- the text ----

test('every secret shape is painted where it is, found with findSecrets alone', () => {
  for (const [name, value] of Object.entries(FAKE)) {
    const text = `before ${value} after`;
    assert.deepEqual(secretRanges(text), [[7, 7 + value.length]], name);
    assert.equal(text.slice(...secretRanges(text)[0]), value, name);
  }
  assert.deepEqual(secretRanges(`${FAKE.anthropic}`), [[0, FAKE.anthropic.length]], 'a secret that is the whole text');
});

test('several secrets are painted in the order they stand in the text, not the order of the rules', () => {
  const text = `1 ${FAKE.jwt} 2 ${FAKE.anthropic} 3 ${FAKE.aws}\n4 ${FAKE.privateKey}\n5 ${FAKE.github}`;
  const found = secretRanges(text).map(([start, end]) => text.slice(start, end));
  assert.deepEqual(found, [FAKE.jwt, FAKE.anthropic, FAKE.aws, FAKE.privateKey, FAKE.github]);
  const sorted = secretRanges(text);
  assert.ok(sorted.every(([start, end], i) => start < end && (i === 0 || sorted[i - 1][1] <= start)), 'ascending and not overlapping');
});

test('a text with no secret has no ranges, and ordinary words are not secrets', () => {
  for (const text of ['', 'The camera froze after approval.', 'task-start-attestation-vectors.json failed', 'ask-for-approval-0123456789abcdefghij', 'commit 7403ef2 broke it']) {
    assert.deepEqual(secretRanges(text), [], text);
  }
});

test('a secret blocks sending and is painted; mail and paths do not block (they are not looked for)', () => {
  const secret = assessText(`my key: ${FAKE.anthropic}`);
  assert.deepEqual([secret.blocked, secret.canSend, secret.problem], [true, false, null]);
  assert.deepEqual(secret.ranges, [[8, 8 + FAKE.anthropic.length]]);
  assert.deepEqual([assessText('mail taro@example.com about C:\\Users\\taro\\log.txt 0123456789abcdefABCDEF0123456789ab').blocked, assessText('mail taro@example.com').canSend], [false, true]);
  assert.deepEqual({ ...assessText('hello') }, { ranges: [], blocked: false, problem: null, canSend: true });
});

test('an empty or too long text cannot be sent; the limit is the contract\'s', () => {
  for (const empty of ['', '   ', '\n\t ']) assert.deepEqual([textProblem(empty), assessText(empty).canSend], ['empty_text', false], JSON.stringify(empty));
  assert.equal(assessText('x'.repeat(FEEDBACK_MAX_CHARS)).canSend, true);
  assert.deepEqual([textProblem('x'.repeat(FEEDBACK_MAX_CHARS + 1)), assessText('x'.repeat(FEEDBACK_MAX_CHARS + 1)).canSend], ['text_too_long', false]);
  assert.equal(textProblem(` ${'x'.repeat(FEEDBACK_MAX_CHARS)} `), null, 'the ends are trimmed before the count, as they are before the send');
});

test('the request is exactly { v, text, draftId, installDay, version }, with the text trimmed', () => {
  const request = buildRequest({ text: '  The camera froze.\n', draftId: 'd'.repeat(22), installDay: 'i'.repeat(43), version: '0.2.0' });
  assert.deepEqual({ ...request }, { v: 1, text: 'The camera froze.', draftId: 'd'.repeat(22), installDay: 'i'.repeat(43), version: '0.2.0' });
  assert.deepEqual(Object.keys(request), ['v', 'text', 'draftId', 'installDay', 'version']);
  assert.equal(REQUEST_VERSION, 1);
  assert.ok(Object.isFrozen(request));
});

// ---- what the room and the intake answer ----

test('roomState: on only with the version to send; 404 is "off in this room", 401 is "locked"', () => {
  assert.deepEqual(roomState({ ok: true, status: 200, body: { ok: true, endpoint: FEEDBACK_ENDPOINT, version: '0.2.0 (7403ef2)' } }), { state: 'on', version: '0.2.0 (7403ef2)' });
  assert.deepEqual(roomState({ ok: false, status: 404, body: { error: 'not_found' } }), { state: 'off', version: null });
  assert.deepEqual(roomState({ ok: false, status: 401, body: { error: 'session_required' } }), { state: 'locked', version: null });
  for (const bad of [
    { ok: false, status: 0, body: null }, { ok: false, status: 500, body: null }, { ok: true, status: 200, body: { ok: true } }, { ok: true, status: 200, body: { ok: true, version: '' } },
    { ok: true, status: 200, body: { ok: true, version: 'x'.repeat(65) } }, { ok: true, status: 200, body: { ok: true, version: 'v\u3042' } }, { ok: true, status: 200, body: { ok: true, version: 7 } }, { ok: true, status: 200, body: null },
  ]) assert.deepEqual(roomState(bad), { state: 'down', version: null }, JSON.stringify(bad.body));
});

test('sendFlow: a receipt is believed only in the receipt shape; failures become the contract\'s codes; a lost connection is its own', async () => {
  const request = buildRequest({ text: 'hi', draftId: 'd'.repeat(22), installDay: 'i'.repeat(43), version: '1' });
  const seen = [];
  const answer = (result) => async (sent) => { seen.push(sent); return result; };
  assert.deepEqual(await sendFlow({ request, send: answer({ ok: true, status: 201, body: { receipt: 'FB-7K3Q-2M' } }) }), { code: 'created', receipt: 'FB-7K3Q-2M' });
  assert.deepEqual(await sendFlow({ request, send: answer({ ok: true, status: 200, body: { receipt: 'FB-7K3Q-2M', duplicate: true } }) }), { code: 'duplicate', receipt: 'FB-7K3Q-2M' });
  assert.deepEqual(seen, [request, request], 'the request goes to send() as it is');
  for (const body of [{ receipt: 'FB-7k3q-2m' }, { receipt: 'nope' }, { receipt: 5 }, {}, null]) {
    assert.deepEqual(await sendFlow({ request, send: answer({ ok: true, status: 201, body }) }), { code: 'intake_unavailable' }, JSON.stringify(body));
  }
  assert.deepEqual(await sendFlow({ request, send: answer({ ok: false, status: 0, body: null }) }), { code: 'unreachable' });
  const failures = FEEDBACK_RESULT_CODES.filter((code) => code !== 'created' && code !== 'duplicate');
  assert.ok(failures.length > 5);
  for (const code of failures) assert.deepEqual(await sendFlow({ request, send: answer({ ok: false, status: 422, body: { error: code } }) }), { code }, code);
  for (const body of [{ error: 'created' }, { error: 'made_up' }, { error: 5 }, {}, null]) {
    assert.deepEqual(await sendFlow({ request, send: answer({ ok: false, status: 500, body }) }), { code: 'intake_unavailable' }, JSON.stringify(body));
  }
});

// ---- calls ----

test('api.mjs: getFeedback asks this room; sendFeedback is the one call to another origin, with no cookie, no referrer and no cache, and it never throws', async (t) => {
  const seen = [];
  const real = globalThis.fetch;
  let fail = false;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    if (fail) throw new TypeError('Failed to fetch');
    return new Response('{"receipt":"FB-7K3Q-2M"}', { status: 201, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = real; });
  await api.getFeedback();
  const request = buildRequest({ text: 'hi', draftId: 'd'.repeat(22), installDay: 'i'.repeat(43), version: '1' });
  const sent = await api.sendFeedback(request);
  assert.deepEqual(sent, { ok: true, status: 201, body: { receipt: 'FB-7K3Q-2M' } });
  assert.equal(seen[0].url, 'api/feedback');
  assert.deepEqual([seen[0].init.credentials, seen[0].init.cache, seen[0].init.method], ['same-origin', 'no-store', undefined]);
  assert.equal(seen[1].url, FEEDBACK_ENDPOINT);
  assert.deepEqual([seen[1].init.method, seen[1].init.mode, seen[1].init.credentials, seen[1].init.referrerPolicy, seen[1].init.cache], ['POST', 'cors', 'omit', 'no-referrer', 'no-store']);
  assert.equal(seen[1].init.headers['Content-Type'], 'application/json');
  assert.equal(seen[1].init.body, JSON.stringify(request));
  fail = true;
  assert.deepEqual(await api.sendFeedback(request), { ok: false, status: 0, body: null });
  assert.deepEqual(await api.getFeedback(), { ok: false, status: 0, body: null });
});

// ---- words ----

test('words: en and ja have the same keys, every key the script uses exists, and every result code has words in both', () => {
  assert.deepEqual(Object.keys(feedbackWords.en).sort(), Object.keys(feedbackWords.ja).sort());
  const used = new Set();
  for (const m of source('feedback.mjs').matchAll(/'(feedback\.[a-z_.]+)'/gu)) used.add(m[1]);
  for (const key of ['sent', 'where', 'ip']) used.add(`feedback.more.${key}`); // built as `feedback.more.${key}`
  for (const key of used) assert.ok(Object.hasOwn(feedbackWords.en, key), `missing in en: ${key}`);
  for (const lang of ['en', 'ja']) {
    for (const code of [...FEEDBACK_RESULT_CODES, 'unreachable']) assert.ok(Object.hasOwn(feedbackWords[lang], `feedback.result.${code}`), `${lang}: no words for ${code}`);
    for (const text of Object.values(feedbackWords[lang])) assert.ok(!/<[a-z]/iu.test(text), 'no markup in words');
  }
  assert.equal(resultKey('daily_limit'), 'feedback.result.daily_limit');
  assert.equal(resultKey('unreachable'), 'feedback.result.unreachable');
  assert.equal(resultKey('made_up'), 'feedback.result.intake_unavailable');
  assert.equal(resultKey(undefined), 'feedback.result.intake_unavailable');
});

test('words: the Japanese lines are the v2 mock\'s, and what the panel says it sends is what it sends', () => {
  const ja = feedbackWords.ja;
  assert.equal(ja['feedback.stop'], 'API キーらしき文字列があります。消してから送ってください。');
  assert.equal(ja['feedback.note'], '運営にだけ届きます (公開されません)。');
  assert.equal(ja['feedback.more_link'], '詳しく');
  assert.equal(ja['feedback.done'], '届きました (受付番号 {receipt})');
  assert.match(ja['feedback.failed'], /^送れませんでした: \{reason\}。文はそのまま残っています。$/u);
  assert.match(ja['feedback.more.sent'], /版番号/u);
  assert.match(ja['feedback.more.sent'], /使い捨ての番号/u);
  assert.match(ja['feedback.more.sent'], /その日だけの導入番号/u);
  assert.equal(feedbackWords.en['feedback.done'].replace('{receipt}', 'FB-7K3Q-2M'), 'Sent (receipt number FB-7K3Q-2M)');
});

// ---- source guards ----

test('feedback.mjs source: no HTML injection, no web address, no log, one thing stored and never the text, one import from the contract and only what the contract is known to keep', () => {
  const text = source('feedback.mjs');
  assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/u);
  assert.doesNotMatch(text, /https?:\/\//u);
  assert.doesNotMatch(text, /console\.|sessionStorage|document\.cookie|\bfetch\(/u);
  const sets = [...text.matchAll(/\.setItem\(([^)]*)\)/gu)].map((m) => m[1]);
  assert.deepEqual(sets, ['INSTALL_KEY, base64url(bytes'], 'the only thing put in storage is the install secret'); // the capture stops at the first ")" of base64url(bytes)
  const code = text.split('\n').filter((line) => !/^\s*(?:\/\/|\/\*|\*)/u.test(line)).join('\n');
  assert.equal([...code.matchAll(/localStorage/gu)].length, 1, 'localStorage is touched in one place');
  const names = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/feedback-contract\.mjs'/gu)].flatMap((m) => m[1].split(',').map((n) => n.trim()).filter(Boolean));
  assert.deepEqual(names.sort(), ['FEEDBACK_MAX_CHARS', 'FEEDBACK_RESULT_CODES', 'RECEIPT_RE', 'findSecrets', 'secretRanges as contractRanges']);
  assert.match(source('api.mjs'), /import \{ FEEDBACK_ENDPOINT \} from '\.\/feedback-contract\.mjs'/u);
  assert.doesNotMatch(text, /checkFeedback|SECRET_RULES|PRIVATE_RULES|maskWith|findPrivate/u, 'no privacy question, no mask button: a secret is deleted, not masked');
});

test('the page has the button, the drawer and the script', () => {
  const page = source('index.html');
  for (const needle of ['id="open-feedback"', 'id="feedback-panel"', 'src="feedback.mjs"']) assert.ok(page.includes(needle), needle);
  assert.match(source('panels.css'), /\.fb-layer mark \{[^}]*background/u);
});

// ---- the page, end to end, on a fake DOM ----

const GOOD_ROOM = { status: 200, body: { ok: true, endpoint: FEEDBACK_ENDPOINT, version: '0.2.0 (test)' } };
let loads = 0;

/** Build the panel on a fake document and a stubbed fetch: `rooms` answers GET api/feedback, `intake(init)` answers the POST. Timers are recorded, not run. */
async function openPage(t, { room = GOOD_ROOM, intake = () => ({ status: 201, body: { receipt: 'FB-7K3Q-2M' } }) } = {}) {
  const { document, byId, body } = makeFakeDocument({ 'feedback-panel': 'aside', 'open-feedback': 'button' });
  byId['feedback-panel'].hidden = true;
  const calls = [];
  const timers = [];
  globalThis.document = document;
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const answer = url === FEEDBACK_ENDPOINT ? await intake(init) : room;
    if (answer.status === 0) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { // always back to what the file started with, whatever order the hooks of several pages in one test run in
    Object.assign(globalThis, { fetch: original.fetch, setTimeout: original.setTimeout });
    if (original.document === undefined) delete globalThis.document; else globalThis.document = original.document;
  });
  await import(`../src/runtime/room-ui/feedback.mjs?page=${(loads += 1)}`);
  const panel = byId['feedback-panel'];
  const ui = {
    panel, opener: byId['open-feedback'], calls, timers, body,
    text: panel.byTag('textarea'), send: [...panel.descendants()].find((n) => n.tag === 'button' && n.classList.has('primary')),
    stop: panel.byClass('fb-stop'), err: panel.byClass('fb-err'), status: panel.byClass('fb-status'), layer: panel.byClass('fb-layer'), field: panel.byClass('fb-field'),
    more: panel.byTag('a'), details: panel.byClass('fb-more'), close: panel.byClass('panel-close'),
    toast: body.children.find((n) => n.classList?.has('fb-toast')),
    posts: () => calls.filter((c) => c.url === FEEDBACK_ENDPOINT),
    marks: () => ui.layer.children.filter((n) => n.tag === 'mark').map((n) => n.textContent),
    type(value) { ui.text.value = value; ui.text.fire('input'); },
  };
  ui.opener.fire('click');
  await until(() => calls.length > 0 && ui.status !== undefined, 'the room to answer');
  await new Promise((resolve) => { realSetTimeout(resolve, 20); });
  return ui;
}

test('page: one box and one button; opening asks the room; the button waits for words; the explanation opens in place', async (t) => {
  const ui = await openPage(t);
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.calls[0].url, 'api/feedback');
  assert.equal(ui.opener.textContent, words.t('feedback.open'));
  assert.equal([...ui.panel.descendants()].filter((n) => n.tag === 'textarea').length, 1);
  assert.equal([...ui.panel.descendants()].filter((n) => n.tag === 'button' && n.classList.has('primary')).length, 1);
  assert.equal([...ui.panel.descendants()].filter((n) => n.tag === 'input').length, 0, 'no radio, no checkbox');
  assert.equal(ui.text.maxLength, FEEDBACK_MAX_CHARS);
  assert.equal(ui.send.disabled, true, 'nothing written yet');
  assert.equal(ui.stop.hidden, true);
  ui.type('The camera froze.');
  assert.equal(ui.send.disabled, false);
  assert.equal(ui.details.hidden, true);
  ui.more.fire('click');
  assert.equal(ui.details.hidden, false);
  assert.equal(ui.details.children.length, 3);
  ui.more.fire('click');
  assert.equal(ui.details.hidden, true);
  ui.type('   ');
  assert.equal(ui.send.disabled, true);
});

test('page: a secret stops the button, shows the red line and is painted where it is; deleting it frees the button; mail does not stop it', async (t) => {
  const ui = await openPage(t);
  const text = `I pasted ${FAKE.anthropic} and it failed.\nSecond line.`;
  ui.type(text);
  assert.equal(ui.stop.hidden, false);
  assert.equal(ui.stop.textContent, words.t('feedback.stop'));
  assert.equal(ui.send.disabled, true);
  assert.equal(ui.field.classList.has('bad'), true);
  assert.deepEqual(ui.marks(), [FAKE.anthropic]);
  assert.equal(ui.layer.textContent, `${text}\n`, 'the layer holds the same characters, plus the box\'s last line');
  ui.send.fire('click');
  await new Promise((resolve) => { realSetTimeout(resolve, 20); });
  assert.equal(ui.posts().length, 0, 'a secret is never sent, even if the click gets through');
  ui.type('I pasted it and it failed.\nSecond line.');
  assert.equal(ui.stop.hidden, true);
  assert.equal(ui.field.classList.has('bad'), false);
  assert.deepEqual(ui.marks(), []);
  assert.equal(ui.send.disabled, false);
  ui.type('mail me at taro@example.com, log C:\\Users\\taro\\x.log');
  assert.equal(ui.send.disabled, false, 'a private shape is not asked about');
});

test('page: sending posts exactly the request, then closes the panel, clears the box and shows the receipt on a toast that goes away', async (t) => {
  const ui = await openPage(t);
  ui.type('  The camera froze after approval.  ');
  ui.send.fire('click');
  await until(() => ui.panel.hidden === true, 'the panel to close');
  const [post] = ui.posts();
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.credentials, 'omit');
  const sent = JSON.parse(post.init.body);
  assert.deepEqual(Object.keys(sent), ['v', 'text', 'draftId', 'installDay', 'version']);
  assert.deepEqual([sent.v, sent.text, sent.version], [1, 'The camera froze after approval.', '0.2.0 (test)']);
  assert.match(sent.draftId, /^[A-Za-z0-9_-]{22}$/u);
  assert.match(sent.installDay, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(ui.text.value, '', 'the text is gone from the page');
  assert.equal(ui.toast.hidden, false);
  assert.equal(ui.toast.textContent, words.t('feedback.done', { receipt: 'FB-7K3Q-2M' }));
  assert.match(ui.toast.textContent, /FB-[0-9A-Z]{4}-[0-9A-Z]{2}/u);
  assert.equal(RECEIPT_RE.test('FB-7K3Q-2M'), true);
  const timer = ui.timers.find((x) => x.ms === TOAST_MS);
  assert.ok(timer, 'the toast is set to go away');
  timer.fn();
  assert.equal(ui.toast.hidden, true);
  ui.opener.fire('click');
  await until(() => ui.calls.filter((c) => c.url === 'api/feedback').length === 2, 'the room to be asked again');
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.send.disabled, true, 'a fresh, empty box');
});

test('page: a send that arrives as a duplicate is told the same way, with the receipt it was given', async (t) => {
  const ui = await openPage(t, { intake: () => ({ status: 200, body: { receipt: 'FB-AAAA-BB', duplicate: true } }) });
  ui.type('The same words again.');
  ui.send.fire('click');
  await until(() => ui.panel.hidden === true, 'the panel to close');
  assert.equal(ui.toast.textContent, words.t('feedback.done', { receipt: 'FB-AAAA-BB' }));
});

test('page: one press, one send; the button is off while it goes', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ui = await openPage(t, { intake: async () => { await gate; return { status: 201, body: { receipt: 'FB-7K3Q-2M' } }; } });
  ui.type('Slow network.');
  ui.send.fire('click');
  ui.send.fire('click');
  ui.send.fire('click');
  await until(() => ui.posts().length > 0, 'the post');
  assert.equal(ui.send.disabled, true);
  assert.equal(ui.send.textContent, words.t('feedback.sending'));
  ui.send.fire('click');
  release();
  await until(() => ui.panel.hidden === true, 'the panel to close');
  assert.equal(ui.posts().length, 1, 'pressed four times, sent once');
});

test('page: a refusal says why in one line, keeps the text, and a retry carries the same draft id until the words change', async (t) => {
  let answer = { status: 429, body: { error: 'daily_limit' } };
  const ui = await openPage(t, { intake: () => answer });
  ui.type('Please add a dark mode.');
  ui.send.fire('click');
  await until(() => ui.err.hidden === false, 'the reason');
  assert.equal(ui.err.textContent, words.t('feedback.failed', { reason: words.t('feedback.result.daily_limit') }));
  assert.equal(ui.text.value, 'Please add a dark mode.');
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.send.disabled, false);
  assert.equal(ui.toast.hidden, true);
  ui.send.fire('click');
  await until(() => ui.posts().length === 2, 'the retry');
  await until(() => ui.send.disabled === false, 'the button back');
  ui.type('Please add a dark mode, please.');
  ui.send.fire('click');
  await until(() => ui.posts().length === 3, 'the edited send');
  const ids = ui.posts().map((p) => JSON.parse(p.init.body).draftId);
  assert.equal(ids[0], ids[1], 'the same draft, sent again: the same id');
  assert.notEqual(ids[1], ids[2], 'other words: another draft');
  answer = { status: 0, body: null };
  await until(() => ui.send.disabled === false, 'the button back');
  ui.send.fire('click');
  await until(() => ui.err.textContent.includes(words.t('feedback.result.unreachable')), 'the unreachable reason');
  answer = { status: 201, body: { receipt: 'FB-7K3Q-2M' } };
  ui.send.fire('click');
  await until(() => ui.panel.hidden === true, 'the panel to close');
  const after = ui.posts().map((p) => JSON.parse(p.init.body).draftId);
  assert.equal(after[3], after[4], 'a lost answer is retried under the same id');
});

test('page: feedback off in this room hides the box and says so; locked or unreachable keeps the box but the button waits', async (t) => {
  const off = await openPage(t, { room: { status: 404, body: { error: 'not_found' } } });
  assert.equal(off.status.textContent, words.t('feedback.off'));
  assert.equal(off.panel.children.at(-1).hidden, true, 'the form is hidden');
  off.type('hello');
  assert.equal(off.send.disabled, true);

  const locked = await openPage(t, { room: { status: 401, body: { error: 'session_required' } } });
  assert.equal(locked.status.textContent, words.t('panel.locked'));
  locked.type('hello');
  assert.equal(locked.send.disabled, true, 'without the room the version is not known, so it cannot be sent');
  assert.equal(locked.posts().length, 0);

  const down = await openPage(t, { room: { status: 0, body: null } });
  assert.equal(down.status.textContent, words.t('panel.unreachable'));
  down.type('hello');
  assert.equal(down.send.disabled, true);
});
