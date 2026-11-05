// The talk panel in room-ui (talk.mjs, words-talk.mjs, api.mjs): the pure parts as plain functions, the words in both languages, the calls api.mjs makes, the rules the source must keep, and the
// panel end to end on a small fake DOM (test/helpers/fake-dom.mjs; there is no browser in the test run, so how it LOOKS is not checked here).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { MAIN_AI_FAILURES } from '../src/runtime/main-ai-contract.mjs';
import * as api from '../src/runtime/room-ui/api.mjs';
import { makeWords } from '../src/runtime/room-ui/i18n.mjs';
import { TALK_WORDS_MAX, failureLine, resultCode, sendFlow, wordsProblem } from '../src/runtime/room-ui/talk.mjs';
import panelWords from '../src/runtime/room-ui/words-panels.mjs';
import talkWords from '../src/runtime/room-ui/words-talk.mjs';
import { makeFakeDocument } from './helpers/fake-dom.mjs';
import { startRouteHost } from './helpers/room-route-host.mjs';

const words = makeWords(talkWords, panelWords);
const source = (name) => fs.readFileSync(new URL(`../src/runtime/room-ui/${name}`, import.meta.url), 'utf8');
const original = { document: globalThis.document, fetch: globalThis.fetch };
const realSetTimeout = globalThis.setTimeout;
const until = async (check, what) => {
  for (let i = 0; i < 300; i += 1) { if (check()) return; await new Promise((resolve) => { realSetTimeout(resolve, 5); }); }
  throw new Error(`timed out waiting for ${what}`);
};
const cp = (code) => String.fromCodePoint(code);
const GOAL = 'Open Notepad and type hello';
const PROPOSAL = { goal: GOAL, computerId: 'pc-01', label: 'Alpha PC' };

// ---- pure parts ----

test('wordsProblem matches the host: 1 to 1000 characters, newline and tab allowed, no other control or direction mark', () => {
  assert.equal(TALK_WORDS_MAX, 1000);
  assert.equal(wordsProblem('Open Notepad'), null);
  assert.equal(wordsProblem(`two${cp(10)}lines${cp(9)}tab`), null);
  assert.equal(wordsProblem('a'.repeat(1000)), null);
  assert.equal(wordsProblem('a'.repeat(1001)), 'words_too_long');
  for (const empty of ['', '   ', `${cp(10)}`, 5, null, undefined]) assert.equal(wordsProblem(empty), 'words_empty', String(empty));
  for (const bad of [cp(0), cp(0x1b), cp(0x7f), cp(0x85), cp(0x202e), cp(0x2028), cp(0x2066), cp(0xd800)]) assert.equal(wordsProblem(`x${bad}`), 'words_unsafe', `U+${bad.codePointAt(0).toString(16)}`);
});

test('resultCode: locked, unreachable, the host\'s own code, or request_failed', () => {
  assert.equal(resultCode({ ok: true, status: 200, body: {} }), null);
  assert.equal(resultCode({ ok: false, status: 401, body: { error: 'session_required' } }), 'locked');
  assert.equal(resultCode({ ok: false, status: 0, body: null }), 'unreachable');
  assert.equal(resultCode({ ok: false, status: 502, body: { error: 'credential_missing' } }), 'credential_missing');
  assert.equal(resultCode({ ok: false, status: 500, body: null }), 'request_failed');
  assert.equal(resultCode({ ok: false, status: 500, body: { error: 5 } }), 'request_failed');
  assert.equal(resultCode(undefined), 'unreachable');
});

test('sendFlow checks the words first and sends nothing when they cannot be sent; a host answer is its conversation or its fixed code', async () => {
  const sent = [];
  const send = async (text) => { sent.push(text); return { ok: true, status: 200, body: { ok: true, messages: [{ id: 'm-1', who: 'you', text }] } }; };
  assert.deepEqual(await sendFlow({ text: '   ', send }), { code: 'words_empty' });
  assert.deepEqual(await sendFlow({ text: 'a'.repeat(1001), send }), { code: 'words_too_long' });
  assert.deepEqual(sent, []);
  assert.deepEqual(await sendFlow({ text: 'hi', send }), { code: 'sent', body: { ok: true, messages: [{ id: 'm-1', who: 'you', text: 'hi' }] } });
  assert.deepEqual(await sendFlow({ text: 'hi', send: async () => ({ ok: false, status: 502, body: { error: 'reply_invalid' } }) }), { code: 'reply_invalid' });
  assert.deepEqual(await sendFlow({ text: 'hi', send: async () => ({ ok: false, status: 0, body: null }) }), { code: 'unreachable' });
  assert.deepEqual(await sendFlow({ text: 'hi', send: async () => ({ ok: true, status: 200, body: { ok: true } }) }), { code: 'request_failed' }, 'a body with no conversation is not a success');
});

// ---- words ----

test('words: both languages have the same keys and the same {slots}; every failure code has a line, and none is a bare key', () => {
  const slots = (text) => [...text.matchAll(/\{([a-zA-Z]+)\}/gu)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(talkWords.en).sort(), Object.keys(talkWords.ja).sort());
  for (const key of Object.keys(talkWords.en)) assert.deepEqual(slots(talkWords.ja[key]), slots(talkWords.en[key]), key);
  assert.ok(Object.keys(talkWords.en).every((key) => key.startsWith('talk.')));
  const codes = [...MAIN_AI_FAILURES, 'words_empty', 'words_too_long', 'words_unsafe', 'reply_invalid', 'invalid_request', 'locked', 'unreachable', 'request_failed', 'some_future_code'];
  for (const lang of ['en', 'ja']) {
    globalThis.location = { search: `?lang=${lang}` }; // the language of the words under test, not of the machine that runs the test
    const w = makeWords(talkWords, panelWords);
    delete globalThis.location;
    for (const code of codes) {
      const line = failureLine(w, code);
      assert.ok(line.length > 0 && !line.startsWith('talk.') && !line.startsWith('panel.') && !/\{[a-z]+\}/u.test(line), `${lang} ${code}: ${line}`);
    }
    assert.match(failureLine(w, 'some_future_code'), /some_future_code/u, 'a code with no line of its own is said with the code');
  }
});

test('a missing token is said as its own line that points to the Credentials panel, not as a start error', () => {
  for (const lang of ['en', 'ja']) {
    const text = talkWords[lang]['talk.err.credential_missing'];
    assert.ok(text.length > 10);
    assert.ok(!/start_error/u.test(text));
  }
  assert.match(talkWords.en['talk.err.credential_missing'], /Credentials/u);
  assert.notEqual(failureLine(words, 'credential_missing'), failureLine(words, 'credential_unreadable'));
  assert.notEqual(failureLine(words, 'credential_missing'), failureLine(words, 'brand_new_code'));
});

test('no word promises a number of runs or minutes: nothing enforces one in this version', () => {
  for (const lang of ['en', 'ja']) {
    for (const [key, text] of Object.entries(talkWords[lang])) assert.doesNotMatch(text, /maxStarts|minutes?\b|starts? left|times\b|回数|分間|分以内|何回/iu, `${lang} ${key}`);
  }
  const code = source('talk.mjs').split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).join('\n');
  assert.doesNotMatch(code, /maxStarts|minutes/u, 'the panel code never reads the numbers (the host does not even send them)');
});

// ---- calls ----

test('api.mjs: the talk calls use relative paths and post exactly the documented bodies', async (t) => {
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url, init }); return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  t.after(() => { globalThis.fetch = original.fetch; });
  await api.getTalk();
  await api.sendTalk('hello');
  await api.resetTalk();
  assert.deepEqual(seen.map((s) => [s.init.method ?? 'GET', s.url, s.init.body ?? null]), [
    ['GET', 'api/talk', null], ['POST', 'api/talk', JSON.stringify({ words: 'hello' })], ['POST', 'api/talk/reset', '{}'],
  ]);
  assert.ok(seen.every((s) => s.init.credentials === 'same-origin' && s.init.cache === 'no-store'));
  assert.ok(seen.filter((s) => s.init.method === 'POST').every((s) => s.init.headers['Content-Type'] === 'application/json'));
  assert.ok(!seen.some((s) => s.url.includes('hello') || s.url.includes('?')), 'the words are never in an address');
});

// ---- the panel on a fake DOM ----

/** Boot the panel on a fake document with a scripted host. `host(method, url, body)` answers like the room host; every call is recorded. */
async function openPanel(t, host) {
  const { document, byId } = makeFakeDocument({ 'talk-panel': 'aside', 'open-talk': 'button' });
  byId['talk-panel'].hidden = true;
  const calls = [];
  globalThis.document = document;
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body === undefined ? null : JSON.parse(init.body);
    calls.push([init.method ?? 'GET', url, body]);
    const answer = await host(init.method ?? 'GET', url, body);
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(async () => {
    await new Promise((resolve) => { realSetTimeout(resolve, 40); }); // a call still in flight finishes against this document, not against none
    if (original.document === undefined) delete globalThis.document; else globalThis.document = original.document;
    globalThis.fetch = original.fetch;
  });
  await import(`../src/runtime/room-ui/talk.mjs?page=${Math.random()}`);
  const panel = byId['talk-panel'];
  const buttons = () => [...panel.descendants()].filter((n) => n.tag === 'button');
  const buttonNamed = (text) => buttons().find((b) => b.textContent === text);
  return {
    panel, opener: byId['open-talk'], calls, buttons, buttonNamed, input: panel.byTag('textarea'), log: panel.byClass('talk-log'),
    texts: () => [...panel.descendants()].map((n) => n.textContent),
    open: async () => {
      byId['open-talk'].fire('click');
      await until(() => calls.length > 0, 'the first GET');
      await new Promise((resolve) => { realSetTimeout(resolve, 30); }); // the answer to that GET has been drawn (the stub answers at once)
    },
  };
}

const conversation = (messages, extra = {}) => ({ body: { ok: true, available: true, busy: false, messages, ...extra } });

test('opening the panel reads the conversation; messages are drawn as text and a proposal as a card with the goal and the computer only', async (t) => {
  const markup = '<img src=x onerror=alert(1)>';
  const p = await openPanel(t, () => conversation([
    { id: 'm-1', who: 'you', text: 'Please type hello' }, { id: 'm-2', who: 'bero', text: markup, proposal: PROPOSAL },
  ]));
  assert.equal(p.opener.textContent, words.t('talk.open'));
  await p.open();
  assert.equal(p.panel.hidden, false);
  assert.deepEqual(p.calls, [['GET', 'api/talk', null]]);
  await until(() => p.log.children.length === 2, 'the log');
  const [youMsg, beroMsg] = p.log.children;
  assert.equal(youMsg.byClass('talk-text').textContent, 'Please type hello');
  assert.equal(beroMsg.byClass('talk-text').textContent, markup, 'the model\'s words are text; nothing was parsed as markup');
  assert.ok([...beroMsg.descendants()].every((n) => !n.tag.includes('img') && n.tag !== 'script'));
  const card = beroMsg.byClass('talk-card');
  assert.deepEqual([...card.descendants()].filter((n) => !n.children.length || n.own).map((n) => n.textContent).filter(Boolean), [
    words.t('talk.card_title'), words.t('talk.card_goal'), GOAL, words.t('talk.card_computer'), 'Alpha PC', words.t('talk.card_ask'),
  ], 'the card says the goal and the computer, and nothing about runs or minutes');
  assert.equal(card.byTag('button').disabled, false);
});

test('"Ask to start" sends the goal to the existing job route as the task, then shows the match code and the next step; the card cannot be pressed twice', async (t) => {
  const p = await openPanel(t, (method, url) => (url === 'api/jobs'
    ? { status: 202, body: { ok: true, job: { jobId: 'job-1', kind: 'task', computerId: 'pc-01', task: GOAL, state: 'awaiting_approval', approvalId: 'a', actionDigest: 'sha256:x', matchCode: '4821' } } }
    : conversation([{ id: 'm-1', who: 'bero', text: 'I can do that.', proposal: PROPOSAL }])));
  await p.open();
  await until(() => p.log.children.length === 1, 'the card');
  const ask = p.buttonNamed(words.t('talk.card_ask'));
  ask.fire('click');
  await until(() => p.calls.some(([, url]) => url === 'api/jobs'), 'the job request');
  assert.deepEqual(p.calls.at(-1), ['POST', 'api/jobs', { computerId: 'pc-01', task: GOAL }]);
  await until(() => p.log.byClass('match-code'), 'the match code');
  assert.equal(p.log.byClass('match-code').textContent, '4821');
  assert.ok(p.texts().includes(words.t('talk.card_sent')));
  assert.equal(ask.disabled, true);
  assert.equal(p.calls.filter(([, url]) => url === 'api/jobs').length, 1);
});

test('"Ask to start" that the host refuses says why in a fixed line, and the button comes back', async (t) => {
  const p = await openPanel(t, (method, url) => (url === 'api/jobs'
    ? { status: 409, body: { error: 'approval_in_progress' } }
    : conversation([{ id: 'm-1', who: 'bero', text: 'Sure.', proposal: PROPOSAL }])));
  await p.open();
  await until(() => p.log.children.length === 1, 'the card');
  const ask = p.buttonNamed(words.t('talk.card_ask'));
  ask.fire('click');
  await until(() => p.texts().some((text) => text.includes('approval_in_progress')), 'the refusal');
  assert.equal(ask.disabled, false);
  assert.equal(p.log.byClass('match-code'), undefined);
});

test('Send: the words go to the host, the conversation is drawn again and the box is emptied; the words travel in the body, never in an address', async (t) => {
  const p = await openPanel(t, (method, url, body) => (method === 'POST'
    ? conversation([{ id: 'm-1', who: 'you', text: body.words }, { id: 'm-2', who: 'bero', text: 'Hello.' }])
    : conversation([])));
  await p.open();
  p.input.value = 'Hi Bero';
  p.buttonNamed(words.t('talk.send')).fire('click');
  await until(() => p.log.children.length === 2, 'the answer');
  assert.deepEqual(p.calls.at(-1), ['POST', 'api/talk', { words: 'Hi Bero' }]);
  assert.equal(p.input.value, '');
  assert.equal(p.log.children[1].byClass('talk-text').textContent, 'Hello.');
  assert.equal(p.buttonNamed(words.t('talk.send')).disabled, false);
});

test('a failed turn says the fixed line, keeps the words in the box, and credential_missing is its own line', async (t) => {
  let code = 'credential_missing';
  const p = await openPanel(t, (method) => (method === 'POST' ? { status: 502, body: { error: code } } : conversation([])));
  await p.open();
  p.input.value = 'Hi Bero';
  const send = p.buttonNamed(words.t('talk.send'));
  send.fire('click');
  await until(() => p.texts().includes(words.t('talk.err.credential_missing')), 'the token line');
  assert.equal(p.input.value, 'Hi Bero', 'the words are still there to send again');
  assert.equal(send.disabled, false);
  code = 'reply_invalid';
  send.fire('click');
  await until(() => p.texts().includes(words.t('talk.err.reply_invalid')), 'the reply line');
  assert.equal(p.calls.filter(([method]) => method === 'POST').length, 2, 'one request per press: the panel does not retry by itself');
});

test('words that cannot be sent are told at once and nothing is sent; Ctrl+Enter sends', async (t) => {
  const p = await openPanel(t, (method, url, body) => (method === 'POST' ? conversation([{ id: 'm-1', who: 'you', text: body.words }]) : conversation([])));
  await p.open();
  p.buttonNamed(words.t('talk.send')).fire('click');
  await until(() => p.texts().includes(words.t('talk.err.words_empty')), 'the empty line');
  p.input.value = 'x'.repeat(1001);
  p.buttonNamed(words.t('talk.send')).fire('click');
  await until(() => p.texts().includes(words.t('talk.err.words_too_long')), 'the long line');
  assert.equal(p.calls.filter(([method]) => method === 'POST').length, 0);
  p.input.value = 'by keyboard';
  p.input.fire('keydown', { key: 'Enter', ctrlKey: true });
  await until(() => p.calls.some(([method]) => method === 'POST'), 'the keyboard send');
  assert.deepEqual(p.calls.at(-1), ['POST', 'api/talk', { words: 'by keyboard' }]);
});

test('a room whose main AI is not switched on says so at once and cannot send; Clear asks the host to forget', async (t) => {
  const p = await openPanel(t, (method, url) => (url === 'api/talk/reset' ? conversation([]) : conversation([], { available: false })));
  await p.open();
  await until(() => p.texts().includes(words.t('talk.err.main_ai_disabled')), 'the not-available line');
  assert.equal(p.buttonNamed(words.t('talk.send')).disabled, true);
  p.buttonNamed(words.t('talk.reset')).fire('click');
  await until(() => p.calls.some(([, url]) => url === 'api/talk/reset'), 'the reset call');
  assert.deepEqual(p.calls.at(-1), ['POST', 'api/talk/reset', {}]);
});

test('a locked room and an unreachable host are told in the shared fixed lines', async (t) => {
  let status = 401;
  const p = await openPanel(t, () => ({ status, body: { error: 'session_required' } }));
  await p.open();
  await until(() => p.texts().includes(words.t('panel.locked')), 'the locked line');
  status = 0;
  globalThis.fetch = async () => { throw new TypeError('network'); };
  p.opener.fire('click'); // close
  p.opener.fire('click'); // open again
  await until(() => p.texts().includes(words.t('panel.unreachable')), 'the unreachable line');
});

// ---- rules the source must keep ----

test('the source: text only (no markup injection), the one fetch is api.mjs\'s, no address, no number of runs', () => {
  for (const name of ['talk.mjs', 'words-talk.mjs']) {
    const text = source(name);
    assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u, name);
    assert.doesNotMatch(text, /\bfetch\(/u, name);
    assert.doesNotMatch(text, /https?:\/\//u, name);
  }
  assert.ok(source('talk.mjs').split('\n').length <= 400);
  assert.match(source('index.html'), /id="open-talk"/u);
  assert.match(source('index.html'), /id="talk-panel"/u);
  assert.match(source('index.html'), /src="talk\.mjs"/u);
});

test('the host serves the talk panel\'s two files', async (t) => {
  const r = await startRouteHost(t, []);
  for (const name of ['talk.mjs', 'words-talk.mjs']) {
    const res = await fetch(`${r.address.url}${name}`);
    assert.equal(res.status, 200, name);
    assert.match(res.headers.get('content-type'), /text\/javascript/u);
    assert.equal(await res.text(), source(name), name);
  }
});
