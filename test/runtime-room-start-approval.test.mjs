import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createApprovedOperationFlow } from '../src/runtime/approved-operation-flow.mjs';
import { createMemoryFlowJournal } from '../src/runtime/approved-operation-journal.mjs';
import { createAgentFleet } from '../src/runtime/agent-fleet.mjs';
import { createAgentStatusBoard } from '../src/runtime/agent-status-board.mjs';
import { HyperVDesktopDriver } from '../src/runtime/hyperv-desktop-driver.mjs';
import { createMockDesktopBroker } from '../src/runtime/mock-desktop-broker.mjs';
import { parseRuntimeArgs, RUNTIME_HELP } from '../src/runtime/entry.mjs';
import { createRoomHost, NUDGE_TASK } from '../src/runtime/room-host.mjs';
import { cleanParams, LEDGER_CODES, validLedgerEntry } from '../src/runtime/room-contract.mjs';
import { gatedRecheckTask, GATED_NUDGE_TASK } from '../src/runtime/room-starts.mjs';
import { createTaskStartGate, isStartableTask } from '../src/runtime/task-start-gate.mjs';
import { createTestAuthority, signedReceipt, stableUuid } from '../scripts/issue-22-approval-authority-fixture.mjs';

// The control room starts a hand for a card effect (nudge, recheck) only after the task.start gate says ok (#115 follow-up, step A2).
// The gates here are fakes (a deferred promise, so the "person is being asked" time is under the test's control); the last test puts the real
// approved-operation flow behind a real gate (in-memory journal, fake Broker / Authority: a wiring check, not the real pipes).
const screen = Object.freeze({ width: 64, height: 48 });
const VMS = [{ vmId: 'vm-a', label: 'Alpha', task: 'open notepad and write hello' }, { vmId: 'vm-b', label: 'Beta', task: 'rename the report' }];
const until = async (condition, what) => {
  for (let i = 0; i < 200; i += 1) { if (condition()) return; await new Promise((resolve) => setImmediate(resolve)); }
  assert.fail(`timed out waiting for ${what}`);
};
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function fakeJournal(now) {
  const entries = [];
  return {
    entries,
    record: ({ vmId, actor, code, params }) => {
      const entry = Object.freeze({ seq: entries.length + 1, at: now(), vmId, actor, code, params: cleanParams(params) });
      entries.push(entry);
      return entry;
    },
    recordFleetEvent: () => null,
    since: (seq) => entries.filter((e) => e.seq > seq),
    lastSeq: () => entries.length,
  };
}

function fakeDirector() {
  const outputs = [];
  const cards = new Map();
  return {
    queue(output) { outputs.push(output); },
    tick() {
      const out = outputs.shift() ?? { acts: [], ledger: [] };
      for (const act of out.acts) if (act?.type === 'card') cards.set(act.card.cardId, { ...act.card, open: true });
      return out;
    },
    decide(cardId, choiceId) {
      const card = cards.get(cardId);
      if (!card) return { ok: false, code: 'card_unknown' };
      if (!card.open) return { ok: false, code: 'card_closed' };
      if (!card.choices.some((c) => c.choiceId === choiceId)) return { ok: false, code: 'choice_unknown' };
      card.open = false;
      return { ok: true, ledger: [] };
    },
  };
}

function fakeFleet({ busy = new Set(), refuse = null, initialJobCount = 0, idle = async () => {} } = {}) {
  const calls = [];
  return {
    calls, initialJobCount,
    startJob(vmId, task) { calls.push(['startJob', vmId, task]); return refuse ? { ok: false, code: refuse } : { ok: true }; },
    stopVm(vmId) { calls.push(['stopVm', vmId]); return busy.delete(vmId); },
    idle,
  };
}

/** A gate that records what it was asked and answers when the test says so. */
function deferredGate() {
  const asked = [];
  return {
    asked,
    async startApproved(request) {
      asked.push(request);
      return new Promise((resolve) => { asked.at(-1).answer = resolve; });
    },
  };
}

const card = (cardId, vmId, effects = ['stop', 'nudge', 'recheck']) => ({
  type: 'card',
  card: {
    cardId, vmId, code: 'stalled', params: { seconds: 60 }, openedAt: 1,
    choices: effects.map((effect, i) => ({ choiceId: `${cardId}-c${i}`, code: `pick_${effect}`, effect })), figure: null,
  },
});

async function start(t, { vms = VMS, fleet = fakeFleet(), startGate } = {}) {
  const now = () => Date.parse('2026-10-31T12:00:00.000Z');
  const journal = fakeJournal(now);
  const director = fakeDirector();
  const broker = createMockDesktopBroker(screen);
  const host = createRoomHost({
    vms, board: createAgentStatusBoard({ now }), journal, director, fleet, now, captureIntervalMs: 60_000, tickMs: 60_000, startGate,
    driver: (resolveCurrentLease) => new HyperVDesktopDriver({ broker, resolveCurrentLease, now, screen }),
  });
  const address = await host.listen(0);
  t.after(() => host.close());
  const origin = new URL(address.url).origin;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' };
  const session = await fetch(`${address.url}api/session`, { method: 'POST', headers, body: JSON.stringify({ bootstrapCode: address.bootstrapCode }) });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const decide = async (cardId, choiceId) => {
    const res = await fetch(`${address.url}api/decide`, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ cardId, choiceId }) });
    return { status: res.status, body: await res.json() };
  };
  const openCards = (...cards) => { director.queue({ acts: cards, ledger: [] }); host.tickOnce(); };
  const ledger = () => journal.entries.filter((e) => e.code.startsWith('start_')).map((e) => [e.vmId, e.actor, e.code, e.params]);
  return { host, fleet, journal, decide, openCards, ledger, startGate };
}

test('gated nudge: the answer is pending_approval at once, nothing is stopped or started until the gate says ok, then the approved task is started', async (t) => {
  const gate = deferredGate();
  const r = await start(t, { startGate: gate, fleet: fakeFleet({ busy: new Set(['vm-a']) }) });
  r.openCards(card('c1', 'vm-a'));
  const res = await r.decide('c1', 'c1-c1');
  assert.deepEqual([res.status, res.body], [200, { ok: true, effect: 'nudge', result: 'pending_approval' }]);
  await until(() => gate.asked.length === 1, 'the approval request');
  await settle();
  assert.deepEqual(r.fleet.calls, [], 'while the approval is pending the running hands are left alone');
  assert.deepEqual(gate.asked.map(({ vmId, task }) => [vmId, task]), [['vm-a', GATED_NUDGE_TASK]]);
  gate.asked[0].answer({ ok: true });
  await until(() => r.fleet.calls.length === 2, 'the start');
  assert.deepEqual(r.fleet.calls, [['stopVm', 'vm-a'], ['startJob', 'vm-a', gate.asked[0].task]], 'the job gets exactly the approved task');
  assert.deepEqual(r.ledger(), [['vm-a', 'bero', 'start_approved', {}]]);
});

test('gated: a refusal never stops or starts anything and is recorded with its fixed code; a throwing or odd gate counts as start_error', async (t) => {
  for (const [answer, code] of [[{ ok: false, code: 'start_denied' }, 'start_denied'], [{ ok: false, code: 'start_unknown' }, 'start_unknown'], [{ ok: false, code: 'secret path C:\\x' }, 'start_error'],
    [1, 'start_error'], [null, 'start_error'], [{ ok: 'yes' }, 'start_error']]) {
    const gate = { async startApproved() { return answer; } };
    const r = await start(t, { startGate: gate, fleet: fakeFleet({ busy: new Set(['vm-a']) }) });
    r.openCards(card('c1', 'vm-a'));
    assert.equal((await r.decide('c1', 'c1-c1')).body.result, 'pending_approval');
    await until(() => r.ledger().length === 1, 'the refusal');
    assert.deepEqual(r.fleet.calls, []);
    assert.deepEqual(r.ledger(), [['vm-a', 'bero', 'start_refused', { code }]]);
  }
  const thrower = { async startApproved() { throw new Error('boom C:\\secret'); } };
  const r = await start(t, { startGate: thrower });
  r.openCards(card('c1', 'vm-a'));
  await r.decide('c1', 'c1-c1');
  await until(() => r.ledger().length === 1, 'the refusal');
  assert.deepEqual(r.fleet.calls, []);
  assert.deepEqual(r.ledger(), [['vm-a', 'bero', 'start_refused', { code: 'start_error' }]]);
});

test('gated: two quick decisions on one card make one approval request; a second card for the same VM waits for the first', async (t) => {
  const gate = deferredGate();
  const r = await start(t, { startGate: gate });
  r.openCards(card('c1', 'vm-a'), card('c2', 'vm-a'));
  const [first, second] = await Promise.all([r.decide('c1', 'c1-c1'), r.decide('c1', 'c1-c2')]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal([first, second].find((x) => x.status === 409).body.error, 'card_closed');
  await until(() => gate.asked.length === 1, 'the approval request');
  const other = await r.decide('c2', 'c2-c2');
  assert.deepEqual(other.body, { ok: true, effect: 'recheck', result: 'approval_in_progress' });
  await settle();
  assert.equal(gate.asked.length, 1, 'one approval request in total');
  gate.asked[0].answer({ ok: true });
  await until(() => r.fleet.calls.some(([name]) => name === 'startJob'), 'the start');
  assert.equal(r.fleet.calls.filter(([name]) => name === 'startJob').length, 1);
  // The approval is over: the VM can be asked about again.
  await settle();
  r.openCards(card('c3', 'vm-a'));
  assert.equal((await r.decide('c3', 'c3-c1')).body.result, 'pending_approval');
});

test('gated: a job is only ever started on the VM and with the task that were approved', async (t) => {
  const gate = deferredGate();
  const r = await start(t, { startGate: gate });
  r.openCards(card('ca', 'vm-a', ['nudge']), card('cb', 'vm-b', ['recheck']));
  await r.decide('ca', 'ca-c0');
  await r.decide('cb', 'cb-c0');
  await until(() => gate.asked.length === 2, 'both requests');
  gate.asked[1].answer({ ok: true }); // vm-b is approved first, vm-a stays pending
  await until(() => r.fleet.calls.length >= 1, 'the vm-b start');
  await settle();
  assert.deepEqual(r.fleet.calls, [['stopVm', 'vm-b'], ['startJob', 'vm-b', gatedRecheckTask('rename the report')]]);
  gate.asked[0].answer({ ok: false, code: 'start_denied' });
  await until(() => r.ledger().length === 2, 'the vm-a refusal');
  assert.deepEqual(r.fleet.calls.filter(([name, vmId]) => name === 'startJob' && vmId === 'vm-a'), []);
  assert.deepEqual(r.ledger().map(([vmId, , code]) => `${vmId}:${code}`).sort(), ['vm-a:start_refused', 'vm-b:start_approved']);
});

test('gated: after an approval the fleet may still refuse (busy, budget): that is recorded as start_refused with the fleet code', async (t) => {
  const r = await start(t, { startGate: { async startApproved() { return { ok: true }; } }, fleet: fakeFleet({ refuse: 'over_budget' }) });
  r.openCards(card('c1', 'vm-a'));
  await r.decide('c1', 'c1-c1');
  await until(() => r.ledger().length === 2, 'the ledger');
  assert.deepEqual(r.ledger().map(([, , code, params]) => [code, params]), [['start_approved', {}], ['start_refused', { code: 'over_budget' }]]);
});

test('gated: a recheck is asked about with a text that fits task.start, built from the VM\'s own task; a VM with no task asks for nothing', async (t) => {
  const long = `${'open the settings and change the language to Japanese, '.repeat(30)}end`;
  const vms = [{ vmId: 'vm-a', label: 'Alpha', task: long }, { vmId: 'vm-b', label: 'Beta' }, { vmId: 'vm-c', label: 'Gamma', task: 'say \u202e hi\u0085 \ud800 ok\nnext' }];
  const gate = deferredGate();
  const r = await start(t, { vms, startGate: gate });
  r.openCards(card('ca', 'vm-a', ['recheck']), card('cb', 'vm-b', ['recheck']), card('cc', 'vm-c', ['recheck']));
  assert.equal((await r.decide('ca', 'ca-c0')).body.result, 'pending_approval');
  assert.equal((await r.decide('cb', 'cb-c0')).body.result, 'no_task');
  assert.equal((await r.decide('cc', 'cc-c0')).body.result, 'pending_approval');
  await until(() => gate.asked.length === 2, 'the requests');
  for (const { task } of gate.asked) assert.ok(isStartableTask(task), `fits the contract: ${task}`);
  assert.ok(gate.asked[0].task.startsWith('Change nothing.') && gate.asked[0].task.includes('open the settings'));
  assert.ok(Buffer.byteLength(gate.asked[0].task) <= 256 && Buffer.byteLength(gate.asked[0].task) > 240, 'a long task is cut to fill the limit');
  assert.ok(gate.asked[1].task.includes('say  hi'), 'unsafe characters are dropped, newline becomes a space');
  assert.equal(gatedRecheckTask('x'), 'Change nothing. Look at the screen and decide whether this task is done: "x". Reply with one line starting with DONE, or FAILED and what is missing.');
  assert.ok(isStartableTask(GATED_NUDGE_TASK) && !isStartableTask(NUDGE_TASK), 'the plain nudge text is 263 bytes: too long for a task.start');
});

test('gated: stop is not a start and needs no approval', async (t) => {
  const gate = deferredGate();
  const r = await start(t, { startGate: gate, fleet: fakeFleet({ busy: new Set(['vm-a']) }) });
  r.openCards(card('c1', 'vm-a'));
  assert.equal((await r.decide('c1', 'c1-c0')).body.result, 'stopped');
  assert.deepEqual(r.fleet.calls, [['stopVm', 'vm-a']]);
  assert.equal(gate.asked.length, 0);
});

test('gated: a host that closes while the approval is pending starts nothing', async (t) => {
  const gate = deferredGate();
  const r = await start(t, { startGate: gate });
  r.openCards(card('c1', 'vm-a'));
  await r.decide('c1', 'c1-c1');
  await until(() => gate.asked.length === 1, 'the request');
  await r.host.close();
  gate.asked[0].answer({ ok: true });
  await settle();
  assert.deepEqual(r.fleet.calls, []);
});

test('without a gate the room starts as before: no pending answer, no start ledger entries, the plain texts', async (t) => {
  const r = await start(t, { fleet: fakeFleet({ busy: new Set(['vm-a']) }) });
  r.openCards(card('c1', 'vm-a'));
  assert.deepEqual((await r.decide('c1', 'c1-c1')).body, { ok: true, effect: 'nudge', result: 'started' });
  assert.deepEqual(r.fleet.calls, [['stopVm', 'vm-a'], ['startJob', 'vm-a', NUDGE_TASK]]);
  assert.deepEqual(r.ledger(), []);
});

test('the host refuses a start gate that cannot approve; the ledger codes for starts are valid entries', () => {
  const base = { vms: VMS, board: createAgentStatusBoard(), journal: fakeJournal(Date.now), director: fakeDirector(), fleet: fakeFleet(), driver: { capture() {} } };
  assert.throws(() => createRoomHost({ ...base, startGate: {} }), TypeError);
  assert.throws(() => createRoomHost({ ...base, startGate: 'yes' }), TypeError);
  for (const code of ['start_approved', 'start_refused']) {
    assert.ok(LEDGER_CODES.includes(code));
    assert.ok(validLedgerEntry({ seq: 1, at: 0, vmId: 'vm-a', actor: 'bero', code, params: code === 'start_refused' ? { code: 'start_denied' } : {} }));
  }
});

test('with a gate the host refuses a fleet that would start initial jobs without it (or does not say how many it has); without a gate any fleet is accepted', () => {
  const base = { vms: VMS, board: createAgentStatusBoard(), journal: fakeJournal(Date.now), director: fakeDirector(), driver: { capture() {} } };
  const gate = { async startApproved() { return { ok: true }; } };
  const silent = fakeFleet();
  delete silent.initialJobCount; // a fleet that does not say
  for (const fleet of [fakeFleet({ initialJobCount: 1 }), fakeFleet({ initialJobCount: '0' }), silent]) {
    assert.throws(() => createRoomHost({ ...base, fleet, startGate: gate }), /without initial jobs/);
    assert.doesNotThrow(() => createRoomHost({ ...base, fleet }));
  }
  assert.doesNotThrow(() => createRoomHost({ ...base, fleet: fakeFleet(), startGate: gate }));
  const fleet = (jobs) => createAgentFleet({ jobs, keepAlive: true, vmIds: ['vm-a'], createDriver: () => ({ capture() {}, act() {} }), createClient: () => ({ send() {} }), limits: { maxSteps: 1, maxUsd: 1, maxMs: 1000 }, prices: { input: 1, output: 1 }, totalMaxUsd: 1 });
  assert.equal(fleet([]).initialJobCount, 0);
  assert.equal(fleet([{ vmId: 'vm-a', task: 'x' }]).initialJobCount, 1);
});

test('gated: a person choosing stop on the VM while its approval is pending cancels it, so a later ok starts nothing', async (t) => {
  const gate = deferredGate();
  const r = await start(t, { startGate: gate, fleet: fakeFleet({ busy: new Set(['vm-a']) }) });
  r.openCards(card('c1', 'vm-a'));
  assert.equal((await r.decide('c1', 'c1-c1')).body.result, 'pending_approval');
  await until(() => gate.asked.length === 1, 'the approval request');
  r.openCards(card('c2', 'vm-a'));
  assert.equal((await r.decide('c2', 'c2-c0')).body.effect, 'stop');
  gate.asked[0].answer({ ok: true });
  await until(() => r.ledger().length === 1, 'the cancellation');
  assert.deepEqual(r.fleet.calls, [['stopVm', 'vm-a']], 'only the stop the person chose');
  assert.deepEqual(r.ledger(), [['vm-a', 'bero', 'start_refused', { code: 'start_cancelled' }]]);
});

test('gated: the host closing while the old loop is being stopped means the approved job is not started', async (t) => {
  const gate = { async startApproved() { return { ok: true }; } };
  let release;
  const idle = () => new Promise((resolve) => { release = resolve; });
  const r = await start(t, { startGate: gate, fleet: fakeFleet({ busy: new Set(['vm-a']), idle }) });
  r.openCards(card('c1', 'vm-a'));
  await r.decide('c1', 'c1-c1');
  await until(() => typeof release === 'function', 'the wait for the old loop');
  await r.host.close();
  release();
  await settle();
  assert.deepEqual(r.fleet.calls, [['stopVm', 'vm-a']]);
});

// ---- the real gate on the real flow ----

function realGate(mode) {
  const authorityKey = createTestAuthority();
  const world = { clock: 1_800_000_000_000, submissions: [], claims: [], fields: new Map() };
  const seconds = () => Math.floor(world.clock / 1000);
  const broker = {
    async fence() { return { ok: true, brokerEpoch: 1, leaseGeneration: 7, leaseId: 'lease-1', brokerChallenge: randomBytes(16).toString('base64url') }; },
    async claim(args) { world.claims.push(args); return { ok: true, state: 'UNKNOWN', action: args.action?.action }; },
    async inspect() { return { ok: false, code: 'denied' }; },
  };
  const authority = {
    async submit(f) {
      world.submissions.push(f);
      const approvalId = stableUuid(`${f.operationId}/${f.idempotencyKey}`);
      world.fields.set(approvalId, f);
      return { ok: true, approvalId, state: 'pending', expiresAt: seconds() + 60 };
    },
    async status({ approvalId }) {
      if (mode === 'deny') return { ok: false, code: 'human_denied' };
      const f = world.fields.get(approvalId);
      return {
        ok: true, state: 'approved',
        ...signedReceipt({
          authority: authorityKey, name: f.idempotencyKey, now: seconds(), ttlSeconds: 120, approvalId, operationId: f.operationId, idempotencyKey: f.idempotencyKey,
          leaseId: f.leaseId, projectId: f.action.projectId, computerId: f.action.computerId,
          fence: { brokerEpoch: f.brokerEpoch, leaseGeneration: f.leaseGeneration, brokerChallenge: f.brokerChallenge },
          purpose: f.purpose, action: f.action.action, args: f.action.args,
        }),
      };
    },
  };
  const flow = createApprovedOperationFlow({ broker, authority, journal: createMemoryFlowJournal(), now: () => world.clock, sleep: async (ms) => { world.clock += ms; } });
  let n = 0;
  const gate = createTaskStartGate({ flow, projectId: 'project-1', computerIdFor: (vmId) => `computer-${vmId}`, newOperationId: () => `room-start-${(n += 1)}` });
  return { world, gate };
}

test('real gate + real flow: the claimed DTO, the submitted DTO and the started task are the same string', async (t) => {
  const { world, gate } = realGate('approve');
  const r = await start(t, { startGate: gate, fleet: fakeFleet({ busy: new Set(['vm-a']) }) });
  r.openCards(card('c1', 'vm-a'));
  await r.decide('c1', 'c1-c1');
  await until(() => r.fleet.calls.some(([name]) => name === 'startJob'), 'the start');
  const started = r.fleet.calls.find(([name]) => name === 'startJob');
  assert.deepEqual(started, ['startJob', 'vm-a', GATED_NUDGE_TASK]);
  assert.deepEqual(world.submissions.map((s) => [s.purpose, s.action.action, s.action.computerId, s.action.args.task]), [['guest.command', 'task.start', 'computer-vm-a', started[2]]]);
  assert.deepEqual(world.claims.map((c) => c.action.args.task), [started[2]]);
  assert.deepEqual(r.ledger().map((e) => e[2]), ['start_approved']);
});

test('real gate + real flow: a denied approval starts nothing', async (t) => {
  const { world, gate } = realGate('deny');
  const r = await start(t, { startGate: gate, fleet: fakeFleet({ busy: new Set(['vm-a']) }) });
  r.openCards(card('c1', 'vm-a'));
  await r.decide('c1', 'c1-c1');
  await until(() => r.ledger().length === 1, 'the refusal');
  assert.deepEqual(r.fleet.calls, []);
  assert.equal(world.claims.length, 0);
  assert.deepEqual(r.ledger(), [['vm-a', 'bero', 'start_refused', { code: 'start_denied' }]]);
});

// ---- the CLI option ----

test('room --require-start-approval needs --approval (the pair is covered in runtime-room-approval-wiring.test.mjs); help still says an ungated room does not ask', () => {
  const base = ['room', '--job', 'vm-a=do the thing'];
  assert.equal(parseRuntimeArgs(base).requireStartApproval, undefined);
  assert.equal(parseRuntimeArgs([...base, '--require-start-approval', '--approval', 'a.json']).requireStartApproval, true);
  assert.throws(() => parseRuntimeArgs([...base, '--require-start-approval']), /runtime_room_start_approval_needs_settings/);
  assert.throws(() => parseRuntimeArgs([...base, '--require-start-approval', '--require-start-approval', '--approval', 'a.json']), /runtime_option_must_be_unique/);
  assert.throws(() => parseRuntimeArgs(['room', '--demo', '--require-start-approval', '--approval', 'a.json']), /invalid_runtime_option/);
  assert.match(RUNTIME_HELP, /--require-start-approval/);
  assert.match(RUNTIME_HELP, /room does NOT ask for approval before it starts a hand/);
});

// ---- the initial jobs of a gated room (A3): the fleet has none; each is requested through the host's start path ----

test('requestStart (the gated room\'s initial jobs): each job is asked of the gate once, nothing starts before the answer, and the job gets exactly the approved task', async (t) => {
  const gate = deferredGate();
  const r = await start(t, { startGate: gate });
  const answers = await Promise.all(VMS.map((vm) => r.host.requestStart(vm.vmId, vm.task)));
  assert.deepEqual(answers, ['pending_approval', 'pending_approval']);
  await until(() => gate.asked.length === 2, 'both approval requests');
  assert.deepEqual(gate.asked.map(({ vmId, task }) => [vmId, task]), VMS.map((vm) => [vm.vmId, vm.task]));
  await settle();
  assert.deepEqual(r.fleet.calls, [], 'nothing starts while the approvals are pending');
  gate.asked[1].answer({ ok: true });
  await until(() => r.fleet.calls.some(([name]) => name === 'startJob'), 'the second start');
  assert.deepEqual(r.fleet.calls, [['stopVm', 'vm-b'], ['startJob', 'vm-b', VMS[1].task]]);
  gate.asked[0].answer({ ok: false, code: 'start_denied' });
  await until(() => r.ledger().length === 2, 'the ledger');
  assert.deepEqual(r.ledger(), [['vm-b', 'bero', 'start_approved', {}], ['vm-a', 'bero', 'start_refused', { code: 'start_denied' }]]);
  assert.deepEqual(r.fleet.calls.filter(([name]) => name === 'startJob').map(([, vmId]) => vmId), ['vm-b'], 'the refused VM never started');
});

test('requestStart: a refusal of every kind starts nothing; an unknown VM, an empty task and a closed host are answered without asking the gate', async (t) => {
  for (const code of ['start_denied', 'start_expired', 'start_failed', 'start_retryable', 'start_unknown', 'vm_unknown', 'task_invalid']) {
    const gate = { async startApproved() { return { ok: false, code }; } };
    const r = await start(t, { startGate: gate });
    assert.equal(await r.host.requestStart('vm-a', 'do it'), 'pending_approval');
    await until(() => r.ledger().length === 1, `the refusal ${code}`);
    assert.deepEqual(r.fleet.calls, []);
    assert.deepEqual(r.ledger(), [['vm-a', 'bero', 'start_refused', { code }]]);
  }
  const gate = deferredGate();
  const r = await start(t, { startGate: gate });
  assert.equal(await r.host.requestStart('vm-zzz', 'do it'), 'vm_unknown');
  assert.equal(await r.host.requestStart('vm-a', ''), 'vm_unknown');
  assert.equal(await r.host.requestStart('vm-a', 42), 'vm_unknown');
  await r.host.close();
  assert.equal(await r.host.requestStart('vm-a', 'do it'), 'host_closing');
  assert.equal(gate.asked.length, 0);
});

test('a gated room built the way the CLI builds it: a fleet with no initial jobs but known VMs, the real gate from the wiring, and every initial job goes through the gate', async (t) => {
  const stub = { async startApproved() { return { ok: true }; } };
  // The wiring's own gate over fake clients (see runtime-room-approval-wiring.test.mjs for the binding); here only the shape of the room matters.
  const fleet = createAgentFleet({
    jobs: [], keepAlive: true, vmIds: VMS.map((vm) => vm.vmId), createDriver: () => ({ capture() {}, act() {} }), createClient: () => ({ send() {} }),
    limits: { maxSteps: 1, maxUsd: 1, maxMs: 1000 }, prices: { input: 1, output: 1 }, totalMaxUsd: 1,
  });
  assert.equal(fleet.initialJobCount, 0);
  const started = [];
  const spy = { ...fleet, startJob: (vmId, task) => { started.push([vmId, task]); return { ok: true }; } };
  const gate = { asked: [], async startApproved(request) { this.asked.push(request); return stub.startApproved(); } };
  const r = await start(t, { startGate: gate, fleet: { ...spy, idle: async () => {} } });
  await Promise.all(VMS.map((vm) => r.host.requestStart(vm.vmId, vm.task)));
  await until(() => started.length === 2, 'both starts');
  assert.deepEqual(gate.asked.map(({ vmId, task }) => [vmId, task]), VMS.map((vm) => [vm.vmId, vm.task]), 'the gate was asked once per job');
  assert.deepEqual(started, VMS.map((vm) => [vm.vmId, vm.task]));
});
