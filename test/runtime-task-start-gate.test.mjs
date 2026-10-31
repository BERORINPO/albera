import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createApprovedOperationFlow } from '../src/runtime/approved-operation-flow.mjs';
import { createMemoryFlowJournal } from '../src/runtime/approved-operation-journal.mjs';
import { createTaskStartGate, isStartableTask, TASK_START_MAX_BYTES, TASK_START_REFUSALS } from '../src/runtime/task-start-gate.mjs';
import { createTestAuthority, signedReceipt, stableUuid } from '../scripts/issue-22-approval-authority-fixture.mjs';

// Unit tests of the task.start gate (src/runtime/task-start-gate.mjs) with a fake flow, then the gate on top of the REAL approved-operation flow with an
// in-memory journal and a fake Broker / Approval Authority (a synthetic check: it proves the wiring of the gate and the flow, not the real pipes).
const PROJECT = 'project-1';
const computerIdFor = (vmId) => ({ 'vm-a': 'computer-a', 'vm-b': 'computer-b' })[vmId];

/** A flow that answers with the scripted results in order (a result, or a function of the request) and remembers every request. */
function fakeFlow(...script) {
  const requests = [];
  return {
    requests,
    async run(request) {
      requests.push(request);
      const next = script.length > 1 ? script.shift() : script[0];
      return typeof next === 'function' ? next(request) : next;
    },
  };
}
const claimed = (request, extra = {}) => ({ status: 'claimed', operationId: request.operationId, phase: 'CLAIMED', cycle: 1, replayed: false, ...extra });
const idCounter = () => { let n = 0; return () => `start-${(n += 1)}`; };
const makeGate = (flow, extra = {}) => createTaskStartGate({ flow, projectId: PROJECT, computerIdFor, newOperationId: idCounter(), ...extra });

test('gate: a claimed result is ok, and the flow got exactly the task.start DTO of that VM and task for purpose guest.command', async () => {
  const flow = fakeFlow(claimed);
  const result = await makeGate(flow).startApproved({ vmId: 'vm-a', task: 'close the dialog' });
  assert.deepEqual(result, { ok: true });
  assert.equal(flow.requests.length, 1);
  assert.deepEqual(flow.requests[0], {
    operationId: 'start-1', purpose: 'guest.command',
    action: { action: 'task.start', projectId: PROJECT, computerId: 'computer-a', args: { task: 'close the dialog' } },
  });
});

test('gate: every status other than claimed is a refusal with a fixed code', async () => {
  const table = [['denied', 'start_denied'], ['expired', 'start_expired'], ['failed', 'start_failed'], ['retryable', 'start_retryable'], ['unknown', 'start_unknown'], ['mystery', 'start_error'], [undefined, 'start_error']];
  for (const [status, code] of table) {
    const result = await makeGate(fakeFlow({ status, operationId: 'start-1', replayed: false })).startApproved({ vmId: 'vm-a', task: 'x' });
    assert.deepEqual(result, { ok: false, code }, String(status));
    assert.ok(TASK_START_REFUSALS.includes(result.code));
  }
  for (const odd of [null, undefined, 'claimed', 42]) {
    assert.deepEqual(await makeGate(fakeFlow(odd)).startApproved({ vmId: 'vm-a', task: 'x' }), { ok: false, code: 'start_error' });
  }
});

test('gate: a flow that throws, or an operation id source that throws, never starts', async () => {
  const thrower = { async run() { throw new Error('secret detail'); } };
  assert.deepEqual(await makeGate(thrower).startApproved({ vmId: 'vm-a', task: 'x' }), { ok: false, code: 'start_error' });
  const flow = fakeFlow(claimed);
  const broken = makeGate(flow, { newOperationId: () => { throw new Error('no entropy'); } });
  assert.deepEqual(await broken.startApproved({ vmId: 'vm-a', task: 'x' }), { ok: false, code: 'start_error' });
  assert.equal(flow.requests.length, 0);
});

test('gate: a claim that only replays an older operation, or names another operation, is not an approval of this start', async () => {
  assert.deepEqual(await makeGate(fakeFlow((r) => claimed(r, { replayed: true }))).startApproved({ vmId: 'vm-a', task: 'x' }), { ok: false, code: 'start_replayed' });
  assert.deepEqual(await makeGate(fakeFlow((r) => claimed(r, { replayed: undefined }))).startApproved({ vmId: 'vm-a', task: 'x' }), { ok: false, code: 'start_replayed' });
  assert.deepEqual(await makeGate(fakeFlow((r) => claimed(r, { operationId: 'someone-else' }))).startApproved({ vmId: 'vm-a', task: 'x' }), { ok: false, code: 'start_error' });
});

test('gate: an invalid task is refused before the flow runs (no approval is requested for it)', async () => {
  const flow = fakeFlow(claimed);
  const gate = makeGate(flow);
  const bad = ['', 'a'.repeat(TASK_START_MAX_BYTES + 1), 'あ'.repeat(86), 'two\nlines', 'tab\there', 'bidi ‮ text', 'c1 \u0085 char', 'lone \ud800 surrogate', 'mark ‏', 42, null, undefined, {}, ['x']];
  for (const task of bad) assert.deepEqual(await gate.startApproved({ vmId: 'vm-a', task }), { ok: false, code: 'task_invalid' }, JSON.stringify(task));
  assert.equal(flow.requests.length, 0);
  assert.equal(isStartableTask('a'.repeat(TASK_START_MAX_BYTES)), true, '256 bytes is the limit');
  assert.equal(isStartableTask('あ'.repeat(85)), true, '255 bytes');
  assert.equal(isStartableTask('あ'.repeat(86)), false, '258 bytes');
});

test('gate: a VM the host has no computer for is refused before the flow runs; the computer always follows the VM', async () => {
  const flow = fakeFlow(claimed);
  const gate = makeGate(flow);
  for (const vmId of ['vm-unknown', '', undefined, 7, '__proto__']) assert.deepEqual(await gate.startApproved({ vmId, task: 'x' }), { ok: false, code: 'vm_unknown' }, String(vmId));
  assert.equal(flow.requests.length, 0);
  for (const bad of [() => { throw new Error('x'); }, () => 'has space', () => '', () => 5]) {
    assert.deepEqual(await makeGate(flow, { computerIdFor: bad }).startApproved({ vmId: 'vm-a', task: 'x' }), { ok: false, code: 'vm_unknown' });
  }
  assert.equal(flow.requests.length, 0);
  await gate.startApproved({ vmId: 'vm-a', task: 'one' });
  await gate.startApproved({ vmId: 'vm-b', task: 'two' });
  assert.deepEqual(flow.requests.map((r) => [r.action.computerId, r.action.args.task, r.operationId]), [['computer-a', 'one', 'start-1'], ['computer-b', 'two', 'start-2']]);
});

test('gate: each start gets its own operation id; the gate keeps no state between starts', async () => {
  const flow = fakeFlow(claimed);
  const gate = makeGate(flow);
  assert.equal((await gate.startApproved({ vmId: 'vm-a', task: 'same' })).ok, true);
  assert.equal((await gate.startApproved({ vmId: 'vm-a', task: 'same' })).ok, true);
  assert.deepEqual(flow.requests.map((r) => r.operationId), ['start-1', 'start-2']);
});

test('gate: construction needs a flow, the two functions and a valid project id', () => {
  const ok = { flow: fakeFlow(claimed), projectId: PROJECT, computerIdFor, newOperationId: idCounter() };
  assert.doesNotThrow(() => createTaskStartGate(ok));
  for (const bad of [{ flow: {} }, { flow: undefined }, { computerIdFor: undefined }, { newOperationId: undefined }, { projectId: 'has space' }, { projectId: '' }, { projectId: 5 }]) {
    assert.throws(() => createTaskStartGate({ ...ok, ...bad }), TypeError);
  }
  assert.throws(() => createTaskStartGate(), TypeError);
});

// ---- the gate on the real flow (in-memory journal, fake Broker and Approval Authority) ----

const START_MS = 1_800_000_000_000;
function realStack(mode) {
  const authorityKey = createTestAuthority();
  const world = { clock: START_MS, submissions: [], claims: [], decided: new Map() };
  const seconds = () => Math.floor(world.clock / 1000);
  const broker = {
    async fence() { return { ok: true, brokerEpoch: 1, leaseGeneration: 7, leaseId: 'lease-1', brokerChallenge: randomBytes(16).toString('base64url') }; },
    async claim(args) { world.claims.push(args); return { ok: true, state: 'UNKNOWN', action: args.action?.action ?? 'synthetic.noop' }; },
    async inspect() { return { ok: false, code: 'denied' }; },
  };
  const authority = {
    async submit(fields) {
      world.submissions.push(fields);
      const approvalId = stableUuid(`${fields.operationId}/${fields.idempotencyKey}`);
      world.decided.set(approvalId, fields);
      return { ok: true, approvalId, state: 'pending', expiresAt: seconds() + 60 };
    },
    async status({ approvalId }) {
      if (mode === 'deny') return { ok: false, code: 'human_denied' };
      if (mode === 'pending') return { ok: true, state: 'pending', expiresAt: seconds() + 60 };
      const fields = world.decided.get(approvalId);
      return {
        ok: true, state: 'approved',
        ...signedReceipt({
          authority: authorityKey, name: fields.idempotencyKey, now: seconds(), ttlSeconds: 120, approvalId, operationId: fields.operationId, idempotencyKey: fields.idempotencyKey,
          leaseId: fields.leaseId, projectId: fields.action.projectId, computerId: fields.action.computerId,
          fence: { brokerEpoch: fields.brokerEpoch, leaseGeneration: fields.leaseGeneration, brokerChallenge: fields.brokerChallenge },
          purpose: fields.purpose, action: fields.action.action, args: fields.action.args,
        }),
      };
    },
  };
  const flow = createApprovedOperationFlow({ broker, authority, journal: createMemoryFlowJournal(), now: () => world.clock, sleep: async (ms) => { world.clock += ms; } });
  let n = 0;
  return { world, gate: createTaskStartGate({ flow, projectId: PROJECT, computerIdFor, newOperationId: () => `real-${(n += 1)}` }) };
}

test('real flow: an approved task.start is claimed with the exact DTO that was submitted, and the gate says ok', async () => {
  const { world, gate } = realStack('approve');
  assert.deepEqual(await gate.startApproved({ vmId: 'vm-a', task: 'close the dialog' }), { ok: true });
  const dto = { action: 'task.start', projectId: PROJECT, computerId: 'computer-a', args: { task: 'close the dialog' } };
  assert.deepEqual(world.submissions.map((s) => [s.purpose, s.action]), [['guest.command', dto]]);
  assert.deepEqual(world.claims.map((c) => c.action), [dto], 'the Broker got the same DTO next to the receipt');
});

test('real flow: a denied or expired approval refuses, and nothing is claimed', async () => {
  const denied = realStack('deny');
  assert.deepEqual(await denied.gate.startApproved({ vmId: 'vm-a', task: 'x' }), { ok: false, code: 'start_denied' });
  assert.equal(denied.world.claims.length, 0);
  const expired = realStack('pending');
  assert.deepEqual(await expired.gate.startApproved({ vmId: 'vm-a', task: 'x' }), { ok: false, code: 'start_expired' });
  assert.equal(expired.world.claims.length, 0);
});

test('real flow: an invalid task never reaches the Authority', async () => {
  const { world, gate } = realStack('approve');
  assert.deepEqual(await gate.startApproved({ vmId: 'vm-a', task: 'a'.repeat(257) }), { ok: false, code: 'task_invalid' });
  assert.deepEqual(await gate.startApproved({ vmId: 'vm-a', task: 'bidi ‮' }), { ok: false, code: 'task_invalid' });
  assert.equal(world.submissions.length, 0);
});

// ---- attestationFor (A3): the VM's Hyper-V id and generation join the args, so the flow can ask the Broker side for a task-start attestation ----

const VM_GUID = '11111111-2222-4333-8444-555555555555';
const attestable = (vmId) => (vmId === 'vm-a' ? { vmId: VM_GUID, expectedGeneration: 3 } : undefined);

test('gate: with attestationFor the args are { task, vmId, expectedGeneration } for a VM it knows and { task } alone for one it does not', async () => {
  const flow = fakeFlow(claimed);
  const gate = makeGate(flow, { attestationFor: attestable });
  await gate.startApproved({ vmId: 'vm-a', task: 'one' });
  await gate.startApproved({ vmId: 'vm-b', task: 'two' });
  assert.deepEqual(flow.requests.map((r) => r.action.args), [{ task: 'one', vmId: VM_GUID, expectedGeneration: 3 }, { task: 'two' }]);
  const plain = fakeFlow(claimed);
  await makeGate(plain).startApproved({ vmId: 'vm-a', task: 'one' });
  assert.deepEqual(plain.requests[0].action.args, { task: 'one' }, 'without attestationFor nothing changes');
});

test('gate: only vmId and expectedGeneration can come from attestationFor; an answer the contract cannot carry refuses the VM before any request', async () => {
  const flow = fakeFlow(claimed);
  const smuggle = makeGate(flow, { attestationFor: () => ({ vmId: VM_GUID, expectedGeneration: 3, shell: 'calc.exe', task: 'overwritten' }) });
  assert.deepEqual(await smuggle.startApproved({ vmId: 'vm-a', task: 'real' }), { ok: true });
  assert.deepEqual(flow.requests[0].action.args, { task: 'real', vmId: VM_GUID, expectedGeneration: 3 });
  const refusing = fakeFlow(claimed);
  for (const answer of [null, 'text', { vmId: VM_GUID }, { expectedGeneration: 3 }, { vmId: 7, expectedGeneration: 3 }, { vmId: VM_GUID, expectedGeneration: { n: 1 } }, 5]) {
    assert.deepEqual(await makeGate(refusing, { attestationFor: () => answer }).startApproved({ vmId: 'vm-a', task: 'x' }), { ok: false, code: 'vm_unknown' }, JSON.stringify(answer));
  }
  assert.deepEqual(await makeGate(refusing, { attestationFor: () => { throw new Error('boom'); } }).startApproved({ vmId: 'vm-a', task: 'x' }), { ok: false, code: 'vm_unknown' });
  assert.equal(refusing.requests.length, 0);
  assert.throws(() => createTaskStartGate({ flow: refusing, projectId: PROJECT, computerIdFor, newOperationId: idCounter(), attestationFor: 'yes' }), TypeError);
});
