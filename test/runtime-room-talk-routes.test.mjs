// The room's talk panel routes (src/runtime/room-talk-routes.mjs) on the REAL room host over the Fake main AI (src/runtime/fake-main-ai.mjs). No process, no token, no model. What these prove: the
// model's text is untrusted and is checked before anything is shown; a proposal is only shown and starts nothing; the host's own request checks hold for the new routes; a failure is a fixed code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFakeMainAi, fakeReply } from '../src/runtime/fake-main-ai.mjs';
import { disabledMainAi } from '../src/runtime/main-ai-contract.mjs';
import { createRoomJobRoutes } from '../src/runtime/room-job-routes.mjs';
import { HISTORY_MESSAGES, MAX_MESSAGES, TALK_MAX_BODY_BYTES, createRoomTalkRoutes } from '../src/runtime/room-talk-routes.mjs';
import { TARGETS, createFakeApprovals, createFakeHands, deferred } from './helpers/fake-room-jobs.mjs';
import { startRouteHost } from './helpers/room-route-host.mjs';

const TALK = 'api/talk';
const RESET = 'api/talk/reset';
const GOAL = 'Open Notepad and type hello';
const PROPOSE = { goal: GOAL, computerId: 'pc-01', maxStarts: 3, minutes: 30 };
const say = (text, extra = {}) => fakeReply({ say: text, ...extra });

async function start(t, { replies = [], hold, mainAi, withJobs = false, targets = () => TARGETS } = {}) {
  const ai = mainAi ?? createFakeMainAi({ replies, hold });
  const logs = [];
  const approvals = createFakeApprovals();
  const hands = createFakeHands();
  const routes = [...createRoomTalkRoutes({ mainAi: ai, targets, log: (line) => logs.push(line) }), ...(withJobs ? createRoomJobRoutes({ approvals, hands, targets: () => TARGETS }) : [])];
  const r = await startRouteHost(t, routes);
  return { ...r, ai, logs, approvals, hands, talk: (words) => r.call('POST', TALK, { body: { words } }) };
}

test('an empty room: no messages, available, not busy', async (t) => {
  const r = await start(t);
  const res = await r.call('GET', TALK);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, available: true, busy: false, messages: [] });
});

test('a turn: the person\'s words and Bero\'s say are kept in order, and the model is given the words and the computers', async (t) => {
  const r = await start(t, { replies: [say('Hello, owner.')] });
  const res = await r.talk('Hi Bero');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, available: true, busy: false, messages: [{ id: 'm-1', who: 'you', text: 'Hi Bero' }, { id: 'm-2', who: 'bero', text: 'Hello, owner.' }] });
  assert.deepEqual(r.ai.calls, [{ words: 'Hi Bero', state: { computers: [{ computerId: 'pc-01', label: 'Alpha PC' }, { computerId: 'pc-02', label: 'Beta PC' }], history: [] } }]);
  assert.deepEqual((await r.call('GET', TALK)).json.messages, res.json.messages);
});

test('a proposal is shown as goal + computer only: maxStarts and minutes never leave the host', async (t) => {
  const r = await start(t, { replies: [say('I can do that.', { propose: PROPOSE })] });
  const res = await r.talk('Please type hello in Notepad on Alpha');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.messages[1].proposal, { goal: GOAL, computerId: 'pc-01', label: 'Alpha PC' });
  assert.doesNotMatch(res.text, /maxStarts|minutes/u);
  assert.doesNotMatch((await r.call('GET', TALK)).text, /maxStarts|minutes/u);
});

test('what the model is shown of earlier turns: who said what and which job it proposed, never the numbers; at most the last 10', async (t) => {
  const r = await start(t, { replies: [say('A.', { propose: PROPOSE }), say('B.')] });
  await r.talk('first');
  await r.talk('second');
  assert.deepEqual(r.ai.calls[1].state.history, [
    { who: 'you', text: 'first' },
    { who: 'bero', text: 'A.', proposed: { goal: GOAL, computerId: 'pc-01' } },
  ]);
  assert.doesNotMatch(JSON.stringify(r.ai.calls[1]), /maxStarts|minutes/u);

  const long = await start(t, { replies: Array.from({ length: 8 }, (_, i) => say(`answer ${i}`)) });
  for (let i = 0; i < 8; i += 1) await long.talk(`question ${i}`);
  assert.equal(long.ai.calls[7].state.history.length, HISTORY_MESSAGES);
  assert.equal(long.ai.calls[7].state.history.at(-1).text, 'answer 6');
});

test('a reply that is not usable is ONE fixed code and is never asked again; nothing of that turn is kept', async (t) => {
  const bad = [
    'Sure, I can do that.', '{"say": "x"', '[]', '{}', '{"say": ""}', fakeReply({ say: 'x', extra: 1 }),
    fakeReply({ say: 'x', propose: PROPOSE, done: true }), fakeReply({ say: 'x', propose: { ...PROPOSE, maxStarts: 99 } }), fakeReply({ say: 'x', propose: { ...PROPOSE, goal: 'a\nb' } }),
    fakeReply({ say: 'esc\u001b[31m' }), fakeReply({ say: 'x'.repeat(2001) }), fakeReply({ say: 'x', propose: { ...PROPOSE, computerId: 'pc-99' } }), 'x'.repeat(9000),
  ];
  const r = await start(t, { replies: bad });
  for (const [i, reply] of bad.entries()) {
    const res = await r.talk('SECRET-WORDS please');
    assert.deepEqual([res.status, res.json], [502, { error: 'reply_invalid' }], String(reply).slice(0, 40));
    assert.equal(r.ai.calls.length, i + 1, 'exactly one call per request: no retry');
  }
  assert.deepEqual((await r.call('GET', TALK)).json.messages, [], 'the words are kept only with an answer they got');
  assert.ok(r.logs.every((line) => /^talk reply_invalid reason=[a-z_]+$/u.test(line)), r.logs.join('|'));
  assert.ok(!r.logs.join('\n').includes('SECRET-WORDS'));
});

test('a proposal for a computer this room does not offer is refused, even though the reply is well formed', async (t) => {
  const r = await start(t, { replies: [say('x', { propose: { ...PROPOSE, computerId: 'pc-03' } })], targets: () => [{ computerId: 'pc-01', label: 'Alpha PC' }] });
  const res = await r.talk('do it on pc-03');
  assert.deepEqual([res.status, res.json], [502, { error: 'reply_invalid' }]);
  assert.deepEqual(r.logs, ['talk reply_invalid reason=computer']);
});

test('next and done are valid replies that Phase 1 ignores: only the say is shown, nothing else happens', async (t) => {
  const r = await start(t, { replies: [say('On it.', { next: { task: 'Click Save' } }), say('All done.', { done: true })], withJobs: true });
  const first = await r.talk('go');
  const second = await r.talk('finish');
  assert.deepEqual(first.json.messages[1], { id: 'm-2', who: 'bero', text: 'On it.' });
  assert.deepEqual(second.json.messages[3], { id: 'm-4', who: 'bero', text: 'All done.' });
  assert.doesNotMatch(first.text + second.text, /Click Save|proposal/u);
  assert.deepEqual([r.approvals.asked, r.hands.started], [[], []]);
});

test('say is folded to one paragraph and shown as text; markup in it stays text', async (t) => {
  const r = await start(t, { replies: [say('line one\nline two\t<b>bold</b>')] });
  const res = await r.talk('hi');
  assert.equal(res.json.messages[1].text, 'line one line two <b>bold</b>');
});

test('an adapter failure is its own fixed code: a missing token is credential_missing, not a generic start error; a code it should not give, a throw and a lie are main_ai_failed', async (t) => {
  const cases = [
    [{ ok: false, code: 'credential_missing' }, 'credential_missing'], [{ ok: false, code: 'claude_untrusted' }, 'claude_untrusted'], [{ ok: false, code: 'timeout' }, 'timeout'],
    [{ ok: false, code: 'capability_unverified' }, 'capability_unverified'], [{ ok: false, code: 'main_ai_disabled' }, 'main_ai_disabled'],
    [{ ok: false, code: 'C:\\secret\\path' }, 'main_ai_failed'], [{ ok: false }, 'main_ai_failed'], [{ ok: true }, 'main_ai_failed'], [{ ok: true, text: 5 }, 'main_ai_failed'], [null, 'main_ai_failed'],
    [() => { throw new Error('boom with C:\\secret\\path'); }, 'main_ai_failed'],
  ];
  const r = await start(t, { replies: cases.map(([reply]) => reply) });
  for (const [, code] of cases) {
    const res = await r.talk('hi');
    assert.deepEqual([res.status, res.json], [502, { error: code }]);
    assert.doesNotMatch(res.text, /secret|boom/u);
  }
  assert.deepEqual((await r.call('GET', TALK)).json.messages, []);
  assert.notEqual(cases[0][1], 'start_error');
});

test('the disabled adapter: GET says available false, a turn is the fixed main_ai_disabled', async (t) => {
  const r = await start(t, { mainAi: disabledMainAi });
  assert.deepEqual((await r.call('GET', TALK)).json, { ok: true, available: false, busy: false, messages: [] });
  assert.deepEqual([(await r.talk('hi')).status, (await r.talk('hi')).json], [502, { error: 'main_ai_disabled' }]);
});

test('one turn at a time: a second request while the model is thinking is 409 busy, reset too; GET shows busy; the first still completes', async (t) => {
  const gate = deferred();
  const r = await start(t, { replies: [say('slow answer')], hold: gate.promise });
  const first = r.talk('first');
  for (let i = 0; i < 200 && r.ai.calls.length === 0; i += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.equal(r.ai.calls.length, 1);
  assert.deepEqual([(await r.talk('second')).status, (await r.talk('second')).json], [409, { error: 'busy' }]);
  assert.deepEqual([(await r.call('POST', RESET, { body: {} })).status, r.ai.calls.length], [409, 1]);
  assert.equal((await r.call('GET', TALK)).json.busy, true);
  gate.resolve();
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal((await r.call('GET', TALK)).json.busy, false);
  assert.equal(r.ai.calls.length, 1, 'the refused requests never reached the model');
});

test('a failed turn frees the room for the next one', async (t) => {
  const r = await start(t, { replies: ['not json', say('fine')] });
  assert.equal((await r.talk('one')).status, 502);
  assert.equal((await r.talk('two')).status, 200);
});

test('the request: exactly { words }, 1 to 1000 characters, no control character; nothing reaches the model otherwise', async (t) => {
  const r = await start(t, { replies: [say('ok'), say('ok')] });
  const refusals = [
    [{ body: {} }, 'invalid_request'], [{ body: { words: 'x', extra: 1 } }, 'invalid_request'], [{ body: { words: ['x'] } }, 'words_empty'], [{ body: { words: 5 } }, 'words_empty'],
    [{ body: { words: '   ' } }, 'words_empty'], [{ body: { words: 'x'.repeat(1001) } }, 'words_too_long'], [{ body: { words: 'bad\u001b' } }, 'words_unsafe'], [{ body: { words: 'bidi\u202e' } }, 'words_unsafe'],
  ];
  for (const [options, code] of refusals) {
    const res = await r.call('POST', TALK, options);
    assert.deepEqual([res.status, res.json], [400, { error: code }], JSON.stringify(options).slice(0, 50));
  }
  assert.equal(r.ai.calls.length, 0);
  assert.equal((await r.talk('x'.repeat(1000))).status, 200);
  assert.equal((await r.talk('two lines\nand a tab\there')).status, 200);
});

test('the host\'s own checks hold for the talk routes: session, same origin, JSON, body size', async (t) => {
  const r = await start(t, { replies: [say('ok')] });
  const body = { words: 'hi' };
  assert.equal((await r.call('POST', TALK, { body, cookie: null })).status, 401);
  assert.equal((await r.call('GET', TALK, { cookie: null })).status, 401);
  assert.equal((await r.call('POST', TALK, { body, headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await r.call('POST', TALK, { body, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await r.call('POST', TALK, { body, headers: { 'Sec-Fetch-Site': undefined } })).status, 403);
  assert.equal((await r.call('GET', TALK, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await r.call('POST', TALK, { body, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await r.call('POST', TALK, { rawBody: JSON.stringify({ words: 'x'.repeat(TALK_MAX_BODY_BYTES) }) })).status, 413);
  assert.equal((await r.call('POST', TALK, { rawBody: '[]' })).status, 400);
  assert.equal((await r.call('POST', TALK, { rawBody: 'not json' })).status, 400);
  assert.equal(r.ai.calls.length, 0, 'none of these reached the model');
  assert.equal((await r.call('POST', TALK, { body })).status, 200);
});

test('a 1000-character Japanese turn still fits the body limit', async (t) => {
  const r = await start(t, { replies: [say('ok')] });
  assert.equal((await r.talk('\u3042'.repeat(1000))).status, 200);
});

test('memory is bounded: at most 40 messages are kept, the oldest go first; reset forgets everything', async (t) => {
  const turns = MAX_MESSAGES / 2 + 5;
  const r = await start(t, { replies: Array.from({ length: turns }, (_, i) => say(`answer ${i}`)) });
  for (let i = 0; i < turns; i += 1) await r.talk(`question ${i}`);
  const { messages } = (await r.call('GET', TALK)).json;
  assert.equal(messages.length, MAX_MESSAGES);
  assert.equal(messages[0].text, 'question 5');
  assert.equal(messages.at(-1).text, `answer ${turns - 1}`);
  const reset = await r.call('POST', RESET, { body: {} });
  assert.deepEqual([reset.status, reset.json.messages], [200, []]);
  assert.deepEqual((await r.call('GET', TALK)).json.messages, []);
  assert.equal((await r.call('POST', RESET, { body: { x: 1 } })).status, 400);
});

test('talking asks for nothing: a proposal starts only through the existing job route, where the person approves that one task', async (t) => {
  const r = await start(t, { replies: [say('I can do that.', { propose: PROPOSE })], withJobs: true });
  const talked = await r.talk('Type hello in Notepad');
  const { goal, computerId } = talked.json.messages[1].proposal;
  assert.deepEqual([r.approvals.asked, r.hands.started], [[], []], 'the proposal is only text so far');
  // The page's "Ask to start" button: the existing route, with the goal as the task.
  const job = await r.call('POST', 'api/jobs', { body: { computerId, task: goal } });
  assert.equal(job.status, 202);
  assert.deepEqual(r.approvals.asked, [{ computerId: 'pc-01', task: GOAL }]);
  assert.equal(r.hands.started.length, 0, 'nothing starts before the approval');
  r.approvals.approve(0);
  for (let i = 0; i < 200 && r.hands.started.length === 0; i += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.equal(r.hands.started.length, 1);
  assert.equal(r.hands.started[0].task, GOAL);
});

test('the file reaches no approval, Broker, hands or process: its only imports are the contract, the room contract and the id grammar', () => {
  const source = fs.readFileSync(new URL('../src/runtime/room-talk-routes.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import\b[^'"\n]*['"]([^'"]+)['"]/gmu)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./broker-contract/action-digest.mjs', './main-ai-contract.mjs', './room-contract.mjs']);
  assert.doesNotMatch(source.split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*|import\b)/u.test(line)).join('\n'), /approval|Broker|hands|spawn|child_process|fetch\(/iu, 'the code, not its comments or its three imports');
});

test('construction: a main AI with turn(), a targets function and a log function are required', () => {
  for (const bad of [undefined, {}, { mainAi: {}, targets: () => [] }, { mainAi: createFakeMainAi(), targets: 5 }, { mainAi: createFakeMainAi(), targets: () => [], log: 5 }]) {
    assert.throws(() => createRoomTalkRoutes(bad), { message: 'invalid_room_talk_dependencies' });
  }
  const routes = createRoomTalkRoutes({ mainAi: createFakeMainAi(), targets: () => [] });
  assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`), ['GET /api/talk', 'POST /api/talk', 'POST /api/talk/reset']);
  assert.ok(routes.every((route) => Object.isFrozen(route)));
});
