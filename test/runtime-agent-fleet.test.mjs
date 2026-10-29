import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentStatusBoard } from '../src/runtime/agent-status-board.mjs';
import { createAgentFleet } from '../src/runtime/agent-fleet.mjs';
import { HyperVDesktopDriver } from '../src/runtime/hyperv-desktop-driver.mjs';
import { createMockDesktopBroker } from '../src/runtime/mock-desktop-broker.mjs';
import { MODEL_PRICES } from '../src/runtime/desktop-agent-loop.mjs';
import { createFakeComputerUseClient, fakeReply, fakeText, fakeToolUse } from '../src/runtime/fake-computer-use-client.mjs';
import { parseRuntimeArgs, RUNTIME_HELP } from '../src/runtime/entry.mjs';

const screen = Object.freeze({ width: 64, height: 48 });
const prices = MODEL_PRICES['claude-haiku-5-5'];
const limits = { maxSteps: 50, maxUsd: 10, maxMs: 3_600_000 };
// $0.10 per response at the Haiku price
const move = () => fakeReply([fakeToolUse('mouse_move', { coordinate: [7, 9] })], { usage: { input_tokens: 1_000_000, output_tokens: 0 } });

// ---- status board ----

test('board: aggregates step, action and end events per VM', () => {
  const board = createAgentStatusBoard();
  assert.deepEqual(board.snapshot(), {});
  board.record('vm-a', { type: 'step', step: 1, usd: 0.0012, ms: 5, toolUses: 1 });
  board.record('vm-a', { type: 'action', step: 1, action: 'left_click', ok: true, cursor: [3, 4] });
  let a = board.snapshot()['vm-a'];
  assert.deepEqual([a.state, a.step, a.actions, a.usd, a.cursor, a.lastAction, a.outcome], ['running', 1, 1, 0.0012, [3, 4], 'left_click', null]);
  board.record('vm-a', { type: 'end', outcome: 'claimed_done', claim: 'DONE: ok', steps: 2, actions: 1, usd: 0.003 });
  a = board.snapshot()['vm-a'];
  assert.deepEqual([a.state, a.step, a.usd, a.outcome, a.claim], ['done', 2, 0.003, 'claimed_done', 'DONE: ok']);
});

test('board: claim is capped and sanitized; bad input is ignored; snapshot is a copy', () => {
  const board = createAgentStatusBoard();
  board.record('vm-a', { type: 'end', outcome: 'claimed_done', claim: `DONE\u001b[31m ${'x'.repeat(500)}`, steps: 1, actions: 0, usd: 0 });
  const claim = board.snapshot()['vm-a'].claim;
  assert.ok(claim.length <= 200);
  assert.ok(!/[\u0000-\u001f]/.test(claim));
  board.record('../bad', { type: 'step', step: 1 });
  board.record('vm-b', null);
  board.record('vm-c', { type: 'action', action: '<script>', cursor: [-1, 2] });
  const snap = board.snapshot();
  assert.equal(snap['../bad'], undefined);
  assert.equal(snap['vm-c'].lastAction, null);
  assert.equal(snap['vm-c'].cursor, null);
  snap['vm-a'].claim = 'changed';
  assert.notEqual(board.snapshot()['vm-a'].claim, 'changed');
});

test('board: typed text, key names and unknown fields never appear in the snapshot', () => {
  const board = createAgentStatusBoard();
  board.record('vm-a', { type: 'action', action: 'type', ok: true, cursor: [1, 1], textLength: 8, text: 'hunter2-secret', key: 'ctrl+alt+del', png: 'AAAA' });
  board.record('vm-a', { type: 'step', step: 1, usd: 0, secret: 'sk-ant-xyz' });
  const json = JSON.stringify(board.snapshot());
  for (const leak of ['hunter2', 'ctrl+alt', 'AAAA', 'sk-ant', 'textLength']) assert.ok(!json.includes(leak), leak);
  assert.deepEqual(Object.keys(board.snapshot()['vm-a']).sort(), ['actions', 'claim', 'cursor', 'lastAction', 'lastActionAt', 'note', 'outcome', 'state', 'step', 'usd']);
});

// ---- fleet argument parsing ----

test('fleet args: jobs, defaults and limits', () => {
  const o = parseRuntimeArgs(['fleet', '--job', 'vm-a=open notepad', '--job', 'vm-b=a=b task', '--max-usd-total', '1.5', '--port', '8080']);
  assert.equal(o.command, 'fleet');
  assert.deepEqual(o.jobs.map((j) => [j.vmId, j.task]), [['vm-a', 'open notepad'], ['vm-b', 'a=b task']]);
  assert.deepEqual([o.maxUsdTotal, o.maxUsdPerVm, o.maxSteps, o.maxMinutes, o.port], [1.5, 0.5, 40, 15, 8080]);
  assert.equal(parseRuntimeArgs(['fleet', '--help']).help, true);
});

test('fleet args: bad input is rejected', () => {
  const bad = (args, re) => assert.throws(() => parseRuntimeArgs(['fleet', ...args]), re, args.join(' '));
  bad([], /runtime_fleet_job_required/);
  bad(['--job', 'vm-a'], /runtime_fleet_job_invalid/);
  bad(['--job', 'vm-a='], /runtime_fleet_job_invalid/);
  bad(['--job', '=task'], /runtime_fleet_job_invalid/);
  bad(['--job', '../x=task'], /runtime_fleet_job_invalid/);
  bad(['--job', 'vm-a=t', '--job', 'vm-a=u'], /runtime_fleet_vm_duplicate/);
  bad(['--job', `vm-a=${'x'.repeat(2001)}`], /runtime_agent_task_too_long/);
  bad(['--job', 'vm-a=t', '--max-usd-total', '0'], /runtime_agent_limit_invalid/);
  bad(['--job', 'vm-a=t', '--max-steps', '1.5'], /runtime_agent_limit_invalid/);
  bad(['--job', 'vm-a=t', '--model', 'gpt-x'], /runtime_agent_model_unknown/);
  bad(['--job', 'vm-a=t', '--port', '70000'], /runtime_port_invalid/);
  bad(['--job', 'vm-a=t', '--max-usd', '1'], /invalid_runtime_option/);
  bad(['--job', 'vm-a=t', '--max-minutes', '1', '--max-minutes', '2'], /runtime_option_must_be_unique/);
  const nine = Array.from({ length: 9 }, (_, i) => ['--job', `vm-${i}=t`]).flat();
  bad(nine, /runtime_fleet_too_many_jobs/);
  assert.equal(parseRuntimeArgs(['fleet', ...nine.slice(0, 16)]).jobs.length, 8);
  assert.ok(RUNTIME_HELP.includes('albera-runtime fleet'));
});

// ---- fleet run (Fake client + mock broker only) ----

function fleetSetup({ scripts, totalMaxUsd = 100 } = {}) {
  const brokers = new Map();
  const clients = new Map();
  const leases = new Map();
  const jobs = Object.keys(scripts).map((vmId) => ({ vmId, task: `task for ${vmId}` }));
  const fleet = createAgentFleet({
    jobs, limits, prices, totalMaxUsd,
    createDriver: (vmId, lease) => {
      leases.set(vmId, lease);
      const broker = createMockDesktopBroker(screen);
      brokers.set(vmId, broker);
      return new HyperVDesktopDriver({ broker, resolveCurrentLease: async () => lease, screen });
    },
    createClient: (vmId) => {
      const client = createFakeComputerUseClient(scripts[vmId]);
      clients.set(vmId, client);
      return client;
    },
  });
  return { fleet, brokers, clients, leases };
}

test('fleet: two jobs run at once with separate leases and finish independently', async () => {
  const { fleet, brokers, leases } = fleetSetup({
    scripts: { 'vm-a': [move(), fakeText('DONE: a')], 'vm-b': [fakeReply([fakeToolUse('left_click', { coordinate: [1, 2] })]), fakeText('FAILED: b')] },
  });
  const { results, totalUsd } = await fleet.run();
  assert.equal(results['vm-a'].outcome, 'claimed_done');
  assert.equal(results['vm-b'].outcome, 'claimed_failed');
  assert.equal(leases.get('vm-a').ownerId, 'albera-agent-vm-a');
  assert.equal(leases.get('vm-b').ownerId, 'albera-agent-vm-b');
  assert.notEqual(leases.get('vm-a').desktopSessionId, leases.get('vm-b').desktopSessionId);
  assert.equal(brokers.get('vm-a').inputs[0].action.action, 'mouse_move');
  assert.equal(brokers.get('vm-b').inputs[0].action.action, 'left_click');
  assert.ok(totalUsd > 0.09);
  const snap = fleet.board.snapshot();
  assert.deepEqual([snap['vm-a'].state, snap['vm-a'].outcome, snap['vm-a'].claim], ['done', 'claimed_done', 'DONE: a']);
  assert.equal(snap['vm-b'].outcome, 'claimed_failed');
});

test('fleet: the total cost limit stops every loop', async () => {
  const script = () => Array.from({ length: 20 }, move);
  const { fleet, clients } = fleetSetup({ scripts: { 'vm-a': script(), 'vm-b': script() }, totalMaxUsd: 0.35 });
  const { results, totalUsd, stopReason } = await fleet.run();
  assert.equal(stopReason, 'max_usd_total');
  for (const r of Object.values(results)) assert.deepEqual([r.outcome, r.reason], ['stopped', 'max_usd_total']);
  assert.ok(totalUsd >= 0.35 && totalUsd < 0.6, String(totalUsd));
  for (const client of clients.values()) assert.ok(client.remaining > 10, 'loops did not run to the end of their scripts');
});

test('fleet: stop() (Ctrl+C) stops both loops, including one waiting on the AI', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let sends = 0;
  const hang = async () => { sends++; await waiting; return move(); };
  const { fleet, brokers } = fleetSetup({ scripts: { 'vm-a': [hang, move()], 'vm-b': [hang, move()] } });
  const running = fleet.run();
  while (sends < 2) await new Promise((resolve) => setImmediate(resolve));
  fleet.stop('stopped_by_user');
  release();
  const { results, stopReason } = await running;
  assert.equal(stopReason, 'stopped_by_user');
  for (const r of Object.values(results)) assert.deepEqual([r.outcome, r.reason], ['stopped', 'stopped_by_user']);
  for (const broker of brokers.values()) assert.equal(broker.inputs.length, 0, 'no action after stop');
});

test('fleet: jobs are validated', () => {
  const base = { createDriver: () => ({}), createClient: () => ({}), limits, prices, totalMaxUsd: 1 };
  assert.throws(() => createAgentFleet({ ...base, jobs: [] }), /invalid_fleet_jobs/);
  assert.throws(() => createAgentFleet({ ...base, jobs: [{ vmId: 'a', task: 't' }, { vmId: 'a', task: 't' }] }), /invalid_fleet_jobs/);
  assert.throws(() => createAgentFleet({ ...base, jobs: Array.from({ length: 9 }, (_, i) => ({ vmId: `v${i}`, task: 't' })) }), /invalid_fleet_jobs/);
  assert.throws(() => createAgentFleet({ ...base, totalMaxUsd: 0, jobs: [{ vmId: 'a', task: 't' }] }), /invalid_fleet_total_limit/);
});

// ---- room mode: startJob / stopVm (Fake client + mock broker only) ----

function roomFleet({ scripts = {}, jobs = [], vmIds = ['vm-a', 'vm-b'], perVm = 10, totalMaxUsd = 100 } = {}) {
  const events = [];
  const leases = [];
  const brokers = new Map();
  const fleet = createAgentFleet({
    jobs, vmIds, keepAlive: true, limits: { ...limits, maxUsd: perVm }, prices, totalMaxUsd,
    createDriver: (vmId, lease) => {
      leases.push(lease);
      if (!brokers.has(vmId)) brokers.set(vmId, createMockDesktopBroker(screen));
      return new HyperVDesktopDriver({ broker: brokers.get(vmId), resolveCurrentLease: async () => lease, screen });
    },
    createClient: (vmId, task) => createFakeComputerUseClient(scripts[task] ?? [fakeText('DONE')]),
    onEvent: (vmId, event) => events.push([vmId, event.type, event.task]),
  });
  return { fleet, events, leases, brokers };
}
const settle = async (fleet, vmId) => { await fleet.idle(vmId); };

test('fleet room mode: startJob runs one job per VM, refuses a busy or unknown VM, and gives each job a new lease', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { fleet, events, leases } = roomFleet({ scripts: { slow: [async () => { await gate; return move(); }, fakeText('DONE: slow')], quick: [fakeText('DONE: quick')] } });
  const running = fleet.run();
  assert.deepEqual(fleet.startJob('vm-a', 'slow'), { ok: true });
  assert.deepEqual(fleet.startJob('vm-a', 'quick'), { ok: false, code: 'vm_busy' });
  assert.deepEqual(fleet.startJob('vm-z', 'quick'), { ok: false, code: 'vm_unknown' });
  assert.deepEqual(fleet.startJob('vm-b', ''), { ok: false, code: 'fleet_stopped' });
  assert.equal(fleet.isBusy('vm-a'), true);
  release();
  await settle(fleet, 'vm-a');
  assert.deepEqual(fleet.startJob('vm-a', 'quick'), { ok: true });
  await settle(fleet, 'vm-a');
  assert.deepEqual(leases.map((l) => [l.ownerId, l.generation]), [['albera-agent-vm-a', 1], ['albera-agent-vm-a', 2]]);
  assert.deepEqual(events.filter(([, type]) => type === 'start'), [['vm-a', 'start', 'slow'], ['vm-a', 'start', 'quick']]);
  fleet.close();
  const { results } = await running;
  assert.equal(results['vm-a'].claim, 'DONE: quick');
  assert.deepEqual(fleet.startJob('vm-b', 'quick'), { ok: false, code: 'fleet_stopped' });
});

test('fleet room mode: stopVm stops only that VM; run() waits for close()', async () => {
  const forever = Array.from({ length: 50 }, () => async () => { await new Promise((resolve) => setTimeout(resolve, 2)); return move(); });
  const { fleet } = roomFleet({ scripts: { loop: forever } });
  let done = false;
  const running = fleet.run().then((r) => { done = true; return r; });
  fleet.startJob('vm-a', 'loop');
  fleet.startJob('vm-b', 'loop');
  assert.equal(fleet.stopVm('vm-a'), true);
  await settle(fleet, 'vm-a');
  assert.equal(fleet.stopVm('vm-a'), false, 'nothing left to stop');
  assert.equal(fleet.isBusy('vm-b'), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(done, false, 'room mode stays alive after jobs end');
  fleet.close();
  const { results } = await running;
  assert.deepEqual([results['vm-a'].outcome, results['vm-a'].reason], ['stopped', 'stopped_by_human']);
  assert.deepEqual([results['vm-b'].outcome, results['vm-b'].reason], ['stopped', 'fleet_closed']);
});

test('fleet room mode: jobs on a VM share its USD limit, and the total limit covers new jobs', async () => {
  // each move() costs $0.10 at the Haiku price
  const { fleet } = roomFleet({ perVm: 0.25, totalMaxUsd: 0.45, scripts: { two: [move(), move(), fakeText('DONE')], one: [move(), fakeText('DONE')] } });
  const running = fleet.run();
  assert.deepEqual(fleet.startJob('vm-a', 'two'), { ok: true });
  await settle(fleet, 'vm-a');
  assert.ok(Math.abs(fleet.spentUsd() - 0.2) < 1e-3, String(fleet.spentUsd()));
  assert.deepEqual(fleet.startJob('vm-a', 'one'), { ok: true }, '$0.05 left on vm-a');
  await settle(fleet, 'vm-a');
  assert.deepEqual(fleet.startJob('vm-a', 'one'), { ok: false, code: 'over_budget' }, 'vm-a spent its own limit');
  assert.deepEqual(fleet.startJob('vm-b', 'two'), { ok: true });
  await settle(fleet, 'vm-b');
  assert.ok(fleet.spentUsd() >= 0.45);
  assert.deepEqual(fleet.startJob('vm-b', 'one'), { ok: false, code: 'over_budget' }, 'the total limit was reached');
  fleet.close();
  const { stopReason } = await running;
  assert.equal(stopReason, 'max_usd_total');
});

test('fleet room mode: needs at least one VM; the batch mode still needs jobs', () => {
  const base = { createDriver: () => ({}), createClient: () => ({}), limits, prices, totalMaxUsd: 1 };
  assert.throws(() => createAgentFleet({ ...base, jobs: [], keepAlive: true }), /invalid_fleet_jobs/);
  assert.throws(() => createAgentFleet({ ...base, jobs: [], vmIds: ['../x'], keepAlive: true }), /invalid_fleet_vms/);
  assert.throws(() => createAgentFleet({ ...base, jobs: [], vmIds: ['a'] }), /invalid_fleet_jobs/);
  assert.doesNotThrow(() => createAgentFleet({ ...base, jobs: [], vmIds: ['a'], keepAlive: true }));
});
