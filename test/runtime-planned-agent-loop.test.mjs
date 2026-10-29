import test from 'node:test';
import assert from 'node:assert/strict';
import { HyperVDesktopDriver } from '../src/runtime/hyperv-desktop-driver.mjs';
import { createMockDesktopBroker } from '../src/runtime/mock-desktop-broker.mjs';
import { createDesktopAgentLoop, MODEL_PRICES } from '../src/runtime/desktop-agent-loop.mjs';
import { createPlannedAgentLoop } from '../src/runtime/planned-agent-loop.mjs';
import { MAX_GOALS, PLANNER_OUTPUT_SCHEMA, PLANNER_SYSTEM_PROMPT, checkPrompt, parsePlannerReply, planNote } from '../src/runtime/desktop-planner.mjs';
import { createAnthropicPlannerClient } from '../src/runtime/anthropic-planner-client.mjs';
import { createFakePlannerClient, fakeDecision, fakePlannerText } from '../src/runtime/fake-planner-client.mjs';
import { createFakeComputerUseClient, fakeReply, fakeText, fakeToolUse } from '../src/runtime/fake-computer-use-client.mjs';
import { createAgentFleet } from '../src/runtime/agent-fleet.mjs';
import { createAgentStatusBoard } from '../src/runtime/agent-status-board.mjs';
import { createRoomJournal } from '../src/runtime/room-journal.mjs';
import { parseWorkspace } from '../src/runtime/workspace.mjs';
import { parseRuntimeArgs } from '../src/runtime/entry.mjs';

const screen = Object.freeze({ width: 64, height: 48 });
const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const lease = Object.freeze({ desktopSessionId: 'desktop-1', ownerType: 'AI', ownerId: 'agent-1', generation: 1, expiresAt: '2026-10-30T13:00:00.000Z' });
const prices = MODEL_PRICES['claude-haiku-5-5'];
const plannerPrices = MODEL_PRICES['claude-sonnet-5-5'];
const bigLimits = { maxSteps: 50, maxUsd: 10, maxMs: 3_600_000 };
const move = () => fakeReply([fakeToolUse('mouse_move', { coordinate: [7, 9] })]);
const plan = (...goals) => fakeDecision('plan', { goals, reason: 'split' });
const decide = (decision, reason = 'seen', goals = []) => fakeDecision(decision, { goals, reason });
const reply = (obj, stopReason = 'end_turn') => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], stopReason });

function setup({ hands = [], planner = [], limits = bigLimits, goalMaxSteps, maxReplans, events = [] } = {}) {
  const broker = createMockDesktopBroker(screen);
  const driver = new HyperVDesktopDriver({ broker, resolveCurrentLease: async () => lease, now: () => NOW, screen });
  const client = createFakeComputerUseClient(hands);
  const plannerClient = createFakePlannerClient(planner);
  const loop = createPlannedAgentLoop({
    driver, client, plannerClient, vmId: 'vm-1', lease, task: 'make a folder and a note', limits, prices, plannerPrices,
    now: () => NOW, onEvent: (e) => events.push(e), ...(goalMaxSteps ? { goalMaxSteps } : {}), ...(maxReplans !== undefined ? { maxReplans } : {}),
  });
  return { broker, client, plannerClient, loop, events };
}
const handsTasks = (client) => client.calls.filter((c) => c.messages.length === 1).map((c) => c.messages[0].content.find((b) => b.type === 'text').text);

// ---- planner replies: parsing and refusal ----

test('planner reply: the exact JSON shape is accepted; text is cleaned and cut', () => {
  const ok = parsePlannerReply(reply({ decision: 'plan', goals: ['Open \u001b[31mNotepad.', 'x'.repeat(500)], reason: 'two steps' }), 'plan');
  assert.equal(ok.ok, true);
  assert.equal(ok.decision, 'plan');
  assert.equal(ok.goals[0], 'Open  [31mNotepad.');
  assert.equal(ok.goals[1].length, 200);
  assert.ok(Object.isFrozen(ok.goals));
  const next = parsePlannerReply(reply({ decision: 'next', goals: ['ignored'], reason: 'r'.repeat(900) }), 'check');
  assert.deepEqual([next.decision, next.goals, next.reason.length], ['next', [], 200]);
  assert.equal(parsePlannerReply(reply({ decision: 'replan', goals: ['a', 'b'], reason: '' }), 'check').goals.length, 2);
});

test('planner reply: anything that is not the JSON shape is refused, never repaired', () => {
  const bad = [
    [fakePlannerText('not json'), 'plan'],
    [fakePlannerText('["plan"]'), 'plan'],
    [reply({ decision: 'plan', goals: ['a'] }), 'plan'],
    [reply({ decision: 'plan', goals: ['a'], reason: '', extra: 1 }), 'plan'],
    [reply({ decision: 'done', goals: [], reason: '' }), 'plan'],
    [reply({ decision: 'plan', goals: [], reason: '' }), 'check'],
    [reply({ decision: 'next', goals: [1], reason: '' }), 'check'],
    [reply({ decision: 'next', goals: [], reason: 5 }), 'check'],
    [reply({ decision: 'plan', goals: ['a'], reason: '' }, 'max_tokens'), 'plan'],
    [{ content: 'x', stopReason: 'end_turn' }, 'plan'],
  ];
  for (const [r, phase] of bad) assert.equal(parsePlannerReply(r, phase).code, 'planner_bad_output', JSON.stringify(r));
  const many = Array.from({ length: MAX_GOALS + 1 }, (_, i) => `goal ${i}`);
  assert.equal(parsePlannerReply(reply({ decision: 'plan', goals: many, reason: '' }), 'plan').code, 'planner_bad_plan');
  assert.equal(parsePlannerReply(reply({ decision: 'plan', goals: [], reason: '' }), 'plan').code, 'planner_bad_plan');
  assert.equal(parsePlannerReply(reply({ decision: 'plan', goals: ['  \u0007 '], reason: '' }), 'plan').code, 'planner_bad_plan');
  assert.equal(parsePlannerReply({ content: [], stopReason: 'refusal' }, 'plan').code, 'planner_refused');
});

test('planner prompts: notes are prefixed and cut; the check prompt carries the plan, the claim and the replans left', () => {
  assert.equal(planNote(2, 4, 'clicked'), '[plan 2/4] clicked');
  assert.ok(planNote(1, 1, 'y'.repeat(400)).length <= 160);
  const text = checkPrompt({ task: 'T', done: ['old'], goals: ['a', 'b'], index: 0, outcome: 'claimed_done', claim: 'DONE\u0007 ok', replansLeft: 0, image: { type: 'image' } })[0].content[1].text;
  assert.match(text, /Sub-goals already confirmed:\n- old/);
  assert.match(text, /1\. a {3}<- the hands just worked on this/);
  assert.match(text, /they said: "DONE  ok"/);
  assert.match(text, /no replans are left/);
  assert.deepEqual(PLANNER_OUTPUT_SCHEMA.required, ['decision', 'goals', 'reason']);
  assert.equal(PLANNER_OUTPUT_SCHEMA.additionalProperties, false);
});

// ---- planned loop ----

test('planned loop: sub-goals run in order, the hands see only the sub-goal, and the planner ends with a DONE claim', async () => {
  const { loop, client, plannerClient, events, broker } = setup({
    planner: [plan('Create a folder named plan-test on the Desktop.', 'Open the folder plan-test.'), decide('next'), decide('done', 'folder is open')],
    hands: [move(), fakeText('DONE: made it'), fakeText('DONE: opened')],
  });
  const result = await loop.run();
  assert.deepEqual([result.outcome, result.claim], ['claimed_done', 'DONE: folder is open']);
  assert.deepEqual(handsTasks(client), ['Create a folder named plan-test on the Desktop.', 'Open the folder plan-test.']);
  assert.equal(plannerClient.calls.length, 3);
  assert.equal(plannerClient.calls[0].system, PLANNER_SYSTEM_PROMPT);
  assert.equal(plannerClient.calls[0].messages[0].content[0].type, 'image');
  assert.match(plannerClient.calls[2].messages[0].content[1].text, /Sub-goals already confirmed:\n- Create a folder/);
  assert.equal(broker.inputs.length, 1);
  assert.deepEqual(result.plan, { goals: 2, confirmed: 2, replans: 0 });
  assert.equal(result.steps, 6);
  assert.equal(result.actions, 1);
});

test('planned loop: events keep the loop shape, notes start with [plan i/n], and board and journal accept them', async () => {
  const { loop, events } = setup({
    planner: [plan('Goal one.', 'Goal two.'), decide('next'), decide('done')],
    hands: [move(), fakeText('DONE: one'), fakeText('DONE: two')],
  });
  await loop.run();
  const steps = events.filter((e) => e.type === 'step');
  assert.deepEqual(steps.map((e) => e.step), [1, 2, 3, 4, 5, 6]);
  assert.ok(steps.every((e) => /^\[plan \d\/\d\]( |$)/.test(e.note) && e.note.length <= 160), JSON.stringify(steps.map((e) => e.note)));
  assert.deepEqual(steps.map((e) => e.note.slice(0, 10)), ['[plan 0/2]', '[plan 1/2]', '[plan 1/2]', '[plan 1/2]', '[plan 2/2]', '[plan 2/2]']);
  assert.ok(steps.every((e, i) => i === 0 || e.usd >= steps[i - 1].usd));
  assert.equal(events.filter((e) => e.type === 'end').length, 1);
  const action = events.find((e) => e.type === 'action');
  assert.equal(action.step, 2);
  const planEvent = events.find((e) => e.type === 'plan');
  assert.deepEqual(planEvent, { type: 'plan', revision: 0, goals: ['Goal one.', 'Goal two.'] });

  // Same keys as a plain loop's events.
  const plainEvents = [];
  const broker = createMockDesktopBroker(screen);
  const plain = createDesktopAgentLoop({
    driver: new HyperVDesktopDriver({ broker, resolveCurrentLease: async () => lease, now: () => NOW, screen }),
    client: createFakeComputerUseClient([move(), fakeText('DONE')]), vmId: 'vm-1', lease, task: 't', limits: bigLimits, prices,
    now: () => NOW, onEvent: (e) => plainEvents.push(e),
  });
  await plain.run();
  for (const type of ['step', 'action', 'end']) {
    assert.deepEqual(Object.keys(events.find((e) => e.type === type)).sort(), Object.keys(plainEvents.find((e) => e.type === type)).sort(), type);
  }

  const board = createAgentStatusBoard({ now: () => NOW });
  const journal = createRoomJournal({ now: () => NOW });
  for (const e of events) { board.record('vm-1', e); journal.recordFleetEvent('vm-1', e); }
  const snap = board.snapshot()['vm-1'];
  assert.deepEqual([snap.state, snap.outcome, snap.step], ['done', 'claimed_done', 6]);
  const codes = journal.all().map((e) => e.code);
  assert.equal(codes.filter((c) => c === 'hands_step').length, 6);
  assert.equal(codes.at(-1), 'hands_ended');
  assert.ok(journal.all().filter((e) => e.code === 'hands_step').every((e) => e.params.note.startsWith('[plan ')));
});

test('planned loop: replan replaces the rest of the plan; a third replan is refused', async () => {
  const { loop, client, events } = setup({
    planner: [plan('Goal A.'), decide('replan', 'try again', ['Goal B.', 'Goal C.']), decide('next'), decide('done')],
    hands: [fakeText('FAILED: no'), fakeText('DONE: b'), fakeText('DONE: c')],
  });
  const result = await loop.run();
  assert.equal(result.outcome, 'claimed_done');
  assert.deepEqual(handsTasks(client), ['Goal A.', 'Goal B.', 'Goal C.']);
  assert.deepEqual(events.filter((e) => e.type === 'plan').map((e) => e.revision), [0, 1]);
  assert.deepEqual(result.plan, { goals: 2, confirmed: 2, replans: 1 });

  const again = setup({
    planner: [plan('A.'), decide('replan', 'r', ['A.']), decide('replan', 'r', ['A.']), decide('replan', 'r', ['A.'])],
    hands: [fakeText('FAILED'), fakeText('FAILED'), fakeText('FAILED')],
  });
  const limited = await again.loop.run();
  assert.deepEqual([limited.outcome, limited.reason], ['limit_reached', 'max_replans']);
  assert.match(again.plannerClient.calls[3].messages[0].content[1].text, /no replans are left/);
});

test('planned loop: a sub-goal that runs out of its own steps goes to the planner, which can end with FAILED', async () => {
  const { loop, client, plannerClient } = setup({
    goalMaxSteps: 2,
    planner: [plan('Goal A.'), decide('failed', 'the window never opened')],
    hands: [move(), move(), move()],
  });
  const result = await loop.run();
  assert.deepEqual([result.outcome, result.claim], ['claimed_failed', 'FAILED: the window never opened']);
  assert.equal(client.calls.length, 2);
  assert.match(plannerClient.calls[1].messages[0].content[1].text, /outcome limit_reached/);
});

test('planned loop: the planner can refuse the task at once; bad planner output ends the run', async () => {
  const failed = setup({ planner: [fakeDecision('failed', { reason: 'needs a terminal' })] });
  const r1 = await failed.loop.run();
  assert.deepEqual([r1.outcome, r1.claim], ['claimed_failed', 'FAILED: needs a terminal']);
  assert.equal(failed.client.calls.length, 0);

  const bad = setup({ planner: [fakePlannerText('Sure! Here is my plan: 1. open notepad')] });
  const r2 = await bad.loop.run();
  assert.deepEqual([r2.outcome, r2.reason], ['error', 'planner_bad_output']);
  assert.match(bad.events.find((e) => e.type === 'step').note, /planner output refused/);

  const refused = setup({ planner: [{ content: [], stopReason: 'refusal', usage: {} }] });
  assert.equal((await refused.loop.run()).outcome, 'refused');

  const broken = setup({ planner: [Object.assign(new Error('x'), { code: 'anthropic_http_400_invalid_request_error' })] });
  assert.deepEqual(Object.values((({ outcome, reason }) => ({ outcome, reason }))(await broken.loop.run())), ['error', 'anthropic_http_400_invalid_request_error']);
});

test('planned loop: planner and hands share one USD limit', async () => {
  const sonnetMillion = { input_tokens: 1_000_000, output_tokens: 0 }; // $2.00 at the Sonnet price
  const haikuMillion = { input_tokens: 1_000_000, output_tokens: 0 }; // $0.10 at the Haiku price
  const { loop, events } = setup({
    limits: { maxSteps: 50, maxUsd: 2.25, maxMs: 3_600_000 },
    planner: [fakeDecision('plan', { goals: ['A.', 'B.'], reason: '', usage: sonnetMillion }), decide('next')],
    hands: Array.from({ length: 10 }, () => fakeReply([fakeToolUse('mouse_move', { coordinate: [1, 1] })], { usage: haikuMillion })),
  });
  const result = await loop.run();
  assert.deepEqual([result.outcome, result.reason], ['limit_reached', 'max_usd']);
  assert.ok(result.usd >= 2.25 && result.usd < 2.4, String(result.usd));
  assert.equal(events.filter((e) => e.type === 'step').at(-1).usd, result.usd);

  // The planner alone can use up the budget: no hands step runs.
  const early = setup({ limits: { maxSteps: 50, maxUsd: 1, maxMs: 3_600_000 }, planner: [fakeDecision('plan', { goals: ['A.'], reason: '', usage: sonnetMillion })] });
  const r = await early.loop.run();
  assert.deepEqual([r.outcome, r.reason], ['limit_reached', 'max_usd']);
  assert.equal(early.client.calls.length, 0);
});

test('planned loop: stop() during a planner call or a sub-goal ends the run as stopped', async () => {
  let loopRef;
  const waiting = setup({ planner: [() => { loopRef.stop('stopped_by_user'); return Object.assign(new Error('aborted'), { code: 'planner_aborted' }); }] });
  loopRef = waiting.loop;
  assert.deepEqual(Object.values((({ outcome, reason }) => ({ outcome, reason }))(await waiting.loop.run())), ['stopped', 'stopped_by_user']);

  const inGoal = setup({ planner: [plan('A.')], hands: [() => { loopRef.stop('stopped_by_human'); return move(); }, move()] });
  loopRef = inGoal.loop;
  const r = await inGoal.loop.run();
  assert.deepEqual([r.outcome, r.reason], ['stopped', 'stopped_by_human']);
  assert.equal(inGoal.plannerClient.calls.length, 1);
});

test('planned loop: options are validated', () => {
  const base = setup();
  const make = (patch) => () => createPlannedAgentLoop({
    driver: { capture() {}, act() {} }, client: { send() {} }, plannerClient: { send() {} }, vmId: 'v', lease, task: 't',
    limits: bigLimits, prices, plannerPrices, ...patch,
  });
  assert.ok(base.loop);
  assert.throws(make({ plannerClient: null }), { message: 'invalid_planner_client' });
  assert.throws(make({ plannerPrices: undefined }), { message: 'invalid_planner_prices' });
  assert.throws(make({ goalMaxSteps: 0 }), { message: 'invalid_goal_steps' });
  assert.throws(make({ maxReplans: 3 }), { message: 'invalid_max_replans' });
});

// ---- fleet: planner + hands against the total limit ----

test('fleet with a planner: every job is planned, and planner costs count toward the total limit', async () => {
  const sonnetHalf = { input_tokens: 250_000, output_tokens: 0 }; // $0.50
  const plannerClients = new Map();
  const fleet = createAgentFleet({
    jobs: [{ vmId: 'vm-a', task: 'A' }, { vmId: 'vm-b', task: 'B' }], limits: bigLimits, prices, totalMaxUsd: 0.9,
    createDriver: (vmId, l) => new HyperVDesktopDriver({ broker: createMockDesktopBroker(screen), resolveCurrentLease: async () => l, screen }),
    createClient: () => createFakeComputerUseClient(Array.from({ length: 20 }, move)),
    planner: {
      prices: plannerPrices,
      createClient: (vmId) => {
        const c = createFakePlannerClient([fakeDecision('plan', { goals: ['Do it.'], reason: '', usage: sonnetHalf })]);
        plannerClients.set(vmId, c);
        return c;
      },
    },
  });
  const { results, totalUsd, stopReason } = await fleet.run();
  assert.equal(stopReason, 'max_usd_total');
  assert.ok(totalUsd >= 0.9 && totalUsd < 1.2, String(totalUsd));
  for (const r of Object.values(results)) assert.equal(r.outcome, 'stopped');
  assert.equal(plannerClients.size, 2);
  assert.throws(() => createAgentFleet({ jobs: [{ vmId: 'v', task: 't' }], limits: bigLimits, prices, totalMaxUsd: 1, createDriver() {}, createClient() {}, planner: { prices } }), { message: 'invalid_fleet_planner' });
});

// ---- planner client ----

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl, calls };
}
const okResponse = () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: { input_tokens: 1 } }), { status: 200 });
const errResponse = (status, type = 'overloaded_error') => new Response(JSON.stringify({ error: { type, message: 'sk-ant-SECRETKEY is bad' } }), { status });

test('planner client: structured output, no tools, and the key only in the header', async () => {
  const f = fakeFetch([okResponse()]);
  const client = createAnthropicPlannerClient({ apiKey: 'sk-ant-SECRETKEY', fetchImpl: f.impl, sleep: async () => {} });
  const out = await client.send([{ role: 'user', content: 'x' }], 'sys');
  assert.deepEqual(Object.keys(out).sort(), ['content', 'stopReason', 'usage']);
  const { init } = f.calls[0];
  assert.equal(init.headers['x-api-key'], 'sk-ant-SECRETKEY');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.deepEqual(body.output_config, { effort: 'medium', format: { type: 'json_schema', schema: PLANNER_OUTPUT_SCHEMA } });
  for (const key of ['tools', 'thinking', 'temperature', 'top_p', 'top_k']) assert.equal(key in body, false);
  assert.ok(!init.body.includes('SECRETKEY'));
});

test('planner client: 429 and 5xx are retried up to 3 times; errors never carry the key', async () => {
  const f = fakeFetch([errResponse(429, 'rate_limit_error'), errResponse(529), okResponse()]);
  const client = createAnthropicPlannerClient({ apiKey: 'sk-ant-SECRETKEY', fetchImpl: f.impl, sleep: async () => {} });
  assert.equal((await client.send([], 's')).stopReason, 'end_turn');
  assert.equal(f.calls.length, 3);
  const g = fakeFetch([errResponse(500), errResponse(500), errResponse(500), errResponse(500)]);
  const failing = createAnthropicPlannerClient({ apiKey: 'sk-ant-SECRETKEY', fetchImpl: g.impl, sleep: async () => {} });
  await assert.rejects(failing.send([], 's'), (error) => error.code === 'anthropic_http_500_overloaded_error' && !String(error.stack).includes('SECRETKEY'));
  assert.equal(g.calls.length, 4);
  const h = fakeFetch([errResponse(400, 'invalid_request_error')]);
  const fatal = createAnthropicPlannerClient({ apiKey: 'k', fetchImpl: h.impl, sleep: async () => {} });
  await assert.rejects(fatal.send([], 's'), { code: 'anthropic_http_400_invalid_request_error' });
  assert.equal(h.calls.length, 1);
  assert.throws(() => createAnthropicPlannerClient({ apiKey: '' }), { message: 'anthropic_api_key_required' });
  assert.throws(() => createAnthropicPlannerClient({ apiKey: 'k', effort: 'max' }), { message: 'invalid_planner_effort' });
});

// ---- command line and workspace ----

test('args: --planner for agent, fleet and room takes a priced model; the workspace takes limits.planner', () => {
  assert.equal(parseRuntimeArgs(['agent', '--vm', 'v1', '--task', 't']).planner, null);
  assert.equal(parseRuntimeArgs(['agent', '--vm', 'v1', '--task', 't', '--planner', 'claude-sonnet-5-5']).planner, 'claude-sonnet-5-5');
  assert.equal(parseRuntimeArgs(['fleet', '--job', 'v1=t', '--planner', 'claude-opus-5-5']).planner, 'claude-opus-5-5');
  assert.equal(parseRuntimeArgs(['room', '--job', 'v1=t', '--planner', 'claude-sonnet-5-5']).planner, 'claude-sonnet-5-5');
  assert.throws(() => parseRuntimeArgs(['agent', '--vm', 'v1', '--task', 't', '--planner', 'gpt-x']), { message: 'runtime_agent_model_unknown' });
  assert.throws(() => parseRuntimeArgs(['fleet', '--job', 'v1=t', '--planner', 'claude-sonnet-5-5', '--planner', 'claude-sonnet-5-5']), { message: 'runtime_option_must_be_unique' });
  const text = (limits) => JSON.stringify({ version: 1, name: 'w', vms: [{ vm: 'v1', task: 't' }], limits });
  const knownModels = Object.keys(MODEL_PRICES);
  assert.equal(parseWorkspace(text({ planner: 'claude-sonnet-5-5' }), { knownModels }).limits.planner, 'claude-sonnet-5-5');
  assert.throws(() => parseWorkspace(text({ planner: 'gpt-x' }), { knownModels }), { message: 'workspace_model_unknown' });
});
