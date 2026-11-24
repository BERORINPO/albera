// `room-service` and the talk panel (src/runtime/room-service-wiring.mjs, room-service-config.mjs): the REAL main AI (Claude Code with no tools) runs only when the service file says `mainAi: true`.
// By default the panel is there and says it is not available, and nothing about a token or a process is touched. The real room host, routes and approval wiring with the Fakes of
// test/helpers/room-service-world.mjs; the real main AI adapter runs here over a FAKE child process (test/helpers/fake-claude-child.mjs). No claude, no token of anyone, no model.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createFakeMainAi, fakeReply } from '../src/runtime/fake-main-ai.mjs';
import { parseServiceConfig } from '../src/runtime/room-service-config.mjs';
import { answers, createFakeClaude, replyLines } from './helpers/fake-claude-child.mjs';
import { makeServiceWorld, until } from './helpers/room-service-world.mjs';

const CP_SID = 'S-1-5-80-1111111111-2222222222-3333333333-4444444444-5555555555';
const OWNER_SID = 'S-1-5-21-1000000000-2000000000-3000000000-1001';
const INSTALL = path.resolve(path.sep, 'albera-test');
const valid = (patch = {}) => ({
  claude: { executable: path.join(INSTALL, 'claude.exe'), executableSha256: 'a'.repeat(64) }, ui: { controlPlaneSid: CP_SID, approverSid: OWNER_SID }, ...patch,
});
const parse = (object) => parseServiceConfig(JSON.stringify(object), { installDir: INSTALL });
const codeOf = (fn) => { try { fn(); } catch (error) { return error.message; } return 'no error'; };
const GOAL = 'Open Notepad and type hello';

// ---- the setting ----

test('the service file\'s `mainAi` is an optional boolean and the default is off', () => {
  assert.equal(parse(valid()).mainAi, false, 'absent: off');
  assert.equal(parse(valid({ mainAi: false })).mainAi, false);
  assert.equal(parse(valid({ mainAi: true })).mainAi, true);
  for (const bad of ['true', 'false', 1, 0, null, {}, []]) assert.equal(codeOf(() => parse(valid({ mainAi: bad }))), 'room_service_config_main_ai', JSON.stringify(bad));
  assert.equal(codeOf(() => parse(valid({ mainai: true }))), 'room_service_config_unknown_key', 'a misspelt key is refused, not ignored');
});

// ---- the service ----

test('by default the panel is there and says it is not available; no token is read and no process is started', async (t) => {
  const w = await makeServiceWorld(t);
  const loads = [];
  const secretStore = { ...w.secretStore, load: async (name) => { loads.push(name); return w.secretStore.load(name); } };
  let spawned = 0;
  await w.start({ secretStore, mainAiOptions: { spawnImpl: () => { spawned += 1; throw new Error('must not start'); } } });
  const room = await w.open();
  assert.equal(room.unlocked, 200);
  assert.deepEqual((await room.call('GET', 'api/talk')).json, { ok: true, available: false, busy: false, messages: [] });
  const turn = await room.call('POST', 'api/talk', { words: 'hello' });
  assert.deepEqual([turn.status, turn.json], [502, { error: 'main_ai_disabled' }]);
  assert.deepEqual([loads, spawned], [[], 0]);
});

test('with mainAi on and no token the turn is credential_missing (not a generic error), and nothing is started', async (t) => {
  const w = await makeServiceWorld(t, { servicePatch: { mainAi: true }, token: null });
  let spawned = 0;
  await w.start({ mainAiOptions: { spawnImpl: () => { spawned += 1; throw new Error('must not start'); } } });
  const room = await w.open();
  const turn = await room.call('POST', 'api/talk', { words: 'hello' });
  assert.deepEqual([turn.status, turn.json], [502, { error: 'credential_missing' }]);
  assert.equal(spawned, 0);
  assert.ok(w.logs.includes('main-ai ended code=credential_missing'));
  assert.ok(!w.logs.join('\n').includes('hello'), 'the log carries codes only');
});

test('with mainAi on and an executable that is not trusted the token is never read', async (t) => {
  const w = await makeServiceWorld(t, { servicePatch: { mainAi: true } });
  w.claudeGuard.trusted = false;
  const loads = [];
  const secretStore = { ...w.secretStore, load: async (name) => { loads.push(name); return w.secretStore.load(name); } };
  await w.start({ secretStore, mainAiOptions: { spawnImpl: () => { throw new Error('must not start'); } } });
  const turn = await (await w.open()).call('POST', 'api/talk', { words: 'hello' });
  assert.deepEqual([turn.status, turn.json], [502, { error: 'claude_untrusted' }]);
  assert.deepEqual(loads, []);
});

test('with mainAi on: Bero answers through the real adapter, proposes a job, and the proposal starts only through the job route, where it waits for the person', async (t) => {
  const w = await makeServiceWorld(t, { servicePatch: { mainAi: true } });
  w.approval.approved = false; // the person has not decided: the Authority keeps answering `pending`
  const reply = fakeReply({ say: 'I can do that.', propose: { goal: GOAL, computerId: 'computer-a', maxStarts: 2, minutes: 10 } });
  const fake = createFakeClaude(answers(replyLines(reply)));
  await w.start({ mainAiOptions: { spawnImpl: fake.spawnImpl, killTreeImpl: fake.killTreeImpl, io: { exists: async () => false } } });
  const room = await w.open();

  const talked = await room.call('POST', 'api/talk', { words: 'Please type hello in Notepad' });
  assert.equal(talked.status, 200, talked.text);
  assert.deepEqual(talked.json.messages[1].proposal, { goal: GOAL, computerId: 'computer-a', label: 'albera-computer-a' });
  assert.doesNotMatch(talked.text, /maxStarts|minutes/u);
  assert.equal(fake.spawned.length, 1);
  assert.deepEqual(w.approval.submissions, [], 'talking asked the Authority for nothing');
  assert.equal(w.driverSeen.length, 0, 'and started no hands');

  // The card's button: the existing job route, with the goal as the task.
  const job = await room.call('POST', 'api/jobs', { computerId: 'computer-a', task: GOAL });
  assert.equal(job.status, 202, job.text);
  await until(() => w.approval.submissions.length === 1, 'the approval request');
  assert.equal(w.approval.submissions[0].action.args.task, GOAL);
  assert.equal(w.driverSeen.length, 0, 'nothing starts before the approval');
});

test('a Fake main AI can replace either one, and it is closed with the service', async (t) => {
  const w = await makeServiceWorld(t);
  const ai = createFakeMainAi({ replies: [fakeReply({ say: 'Fake here.' })] });
  const service = await w.start({ mainAi: ai });
  const room = await w.open();
  assert.deepEqual((await room.call('GET', 'api/talk')).json.available, true);
  assert.equal((await room.call('POST', 'api/talk', { words: 'hi' })).json.messages[1].text, 'Fake here.');
  await service.close();
  assert.equal(ai.closed, true);
});

test('closing the service ends a turn that is still running, by the PID it started', async (t) => {
  const w = await makeServiceWorld(t, { servicePatch: { mainAi: true } });
  const fake = createFakeClaude(async (child) => { await child.gotInput; child.say(replyLines('{}')[0]); }); // proves itself, then never answers
  const service = await w.start({ mainAiOptions: { spawnImpl: fake.spawnImpl, killTreeImpl: fake.killTreeImpl, io: { exists: async () => false } } });
  const room = await w.open();
  const pending = room.call('POST', 'api/talk', { words: 'hello' });
  await until(() => fake.spawned.length === 1, 'the child');
  await service.close();
  const turn = await pending.catch(() => ({ status: 0 }));
  assert.ok([502, 0, 503].includes(turn.status), String(turn.status));
  assert.deepEqual(fake.killed, [fake.spawned[0].child.pid]);
});
