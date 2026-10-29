import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnvironmentControlPlane } from '../src/runtime/environment-control-plane.mjs';

const sessionId = '0123456789abcdef0123456789abcdef';
const otherSessionId = 'fedcba9876543210fedcba9876543210';
const input = Object.freeze({
  operationId: 'op-1', idempotencyKey: 'idem-1', projectId: 'project-1', taskId: 'task-1',
  runId: 'run-1', computerId: 'computer-1', providerId: 'mock', leaseId: 'lease-1',
  expectedGeneration: 1, action: 'start',
});

function fixture() {
  const calls = [];
  const record = { subjectId: sessionId, request: { subjectId: sessionId } };
  const coordinator = {
    async execute(operation) {
      calls.push(['execute', operation]);
      return { ...operation, generation: 1, status: 'SUCCEEDED', desiredState: 'running', observedState: 'running', observedAt: '2026-10-28T00:00:00.000Z', errorCode: null, createdAt: 1, updatedAt: 2, request: { secret: true }, authorization: 'secret' };
    },
    async reconcile(operationId) { calls.push(['reconcile', operationId]); return { operationId, subjectId: sessionId, projectId: 'project-1', generation: 1, action: 'start', status: 'UNKNOWN', desiredState: 'running', observedState: 'unknown', request: { secret: true } }; },
  };
  const store = { getOperation() { return record; } };
  const control = createEnvironmentControlPlane({ coordinator, store, policyVersionForProject: ({ subjectId, projectId }) => {
    calls.push(['policy', subjectId, projectId]);
    return 4;
  } });
  return { control, calls, coordinator, store, record };
}

test('environment control plane binds session identity and trusted policy, then projects safe operation state', async () => {
  const f = fixture();
  const result = await f.control.execute({ sessionId, input });
  assert.equal(f.calls[0][0], 'policy');
  assert.equal(f.calls[0][1], sessionId);
  assert.deepEqual(f.calls[1][1], { ...input, subjectId: sessionId, policyVersion: 4 });
  assert.equal(result.subjectId, sessionId);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal('request' in result, false);
  assert.equal('authorization' in result, false);
});

test('environment control plane rejects caller supplied trust fields and malformed DTOs', async () => {
  const f = fixture();
  await assert.rejects(f.control.execute({ sessionId, input: { ...input, subjectId: otherSessionId } }), { code: 'invalid_request' });
  await assert.rejects(f.control.execute({ sessionId, input: { ...input, policyVersion: 999 } }), { code: 'invalid_request' });
  await assert.rejects(f.control.execute({ sessionId, input: { ...input, approval: true } }), { code: 'invalid_request' });
  assert.equal(f.calls.some(([kind]) => kind === 'execute'), false);
});

test('reconciliation hides another session operation before coordinator call', async () => {
  const f = fixture();
  f.record.subjectId = otherSessionId;
  f.record.request.subjectId = otherSessionId;
  await assert.rejects(f.control.reconcile({ sessionId, operationId: 'op-1' }), { code: 'unknown_operation' });
  assert.equal(f.calls.some(([kind]) => kind === 'reconcile'), false);
});

test('environment control plane captures method references and masks policy lookup failures', async () => {
  const f = fixture();
  const original = f.coordinator.execute;
  const control = createEnvironmentControlPlane({ coordinator: f.coordinator, store: f.store, policyVersionForProject: () => 2 });
  f.coordinator.execute = async () => { throw new Error('replacement'); };
  assert.notEqual(f.coordinator.execute, original);
  const result = await control.execute({ sessionId, input });
  assert.equal(result.status, 'SUCCEEDED');
  const denied = createEnvironmentControlPlane({ coordinator: f.coordinator, store: f.store, policyVersionForProject: () => { throw new Error('private detail'); } });
  await assert.rejects(denied.execute({ sessionId, input }), { code: 'policy_unavailable' });
});

test('environment control plane normalizes hostile Coordinator error reflection', async () => {
  const secret = 'credential-like coordinator exception text';
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); } });
  const record = { subjectId: sessionId, request: { subjectId: sessionId } };
  const control = createEnvironmentControlPlane({
    coordinator: {
      async execute() { throw hostile; },
      async reconcile() { throw hostile; },
    },
    store: { getOperation: () => record },
    policyVersionForProject: () => 1,
  });
  for (const action of [
    () => control.execute({ sessionId, input }),
    () => control.reconcile({ sessionId, operationId: 'op-1' }),
  ]) {
    await assert.rejects(action(), (error) => {
      assert.equal(error.code, 'operation_unavailable');
      assert.equal(error.message, 'operation_unavailable');
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});
