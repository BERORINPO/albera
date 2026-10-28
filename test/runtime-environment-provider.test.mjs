import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentOperationCoordinator } from '../src/runtime/environment-operations.mjs';
import { EnvironmentProviderError, validateEnvironmentCapacity, validateEnvironmentOperation, validateEnvironmentQuota, validateEnvironmentSpec } from '../src/runtime/environment-provider.mjs';
import { HyperVEnvironmentProvider } from '../src/runtime/hyperv-environment-provider.mjs';
import { MockEnvironmentProvider } from '../src/runtime/mock-environment-provider.mjs';

const spec = Object.freeze({
  projectId: 'project-a',
  kind: 'ephemeral',
  os: 'linux',
  architecture: 'x64',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  capabilities: ['terminal'],
  networkProfileId: 'deny-egress-v1',
  securityProfileId: 'guest-restricted-v1',
  resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 32 },
});

function operation(action, overrides = {}) {
  return {
    operationId: `operation-${action}-1`,
    idempotencyKey: `idem-${action}-1`,
    subjectId: 'human-local',
    projectId: 'project-a',
    taskId: 'task-1',
    runId: 'run-1',
    computerId: 'computer-1',
    providerId: 'mock',
    leaseId: 'lease-1',
    expectedGeneration: 1,
    policyVersion: 1,
    action,
    ...(action === 'create' ? { spec } : {}),
    ...overrides,
  };
}

function hypervOperation(action, overrides = {}) {
  return operation(action, { providerId: 'hyperv', ...overrides });
}

test('environment contract rejects malformed IDs, generations, paths and arbitrary executable fields', () => {
  assert.throws(() => validateEnvironmentSpec({ ...spec, imageDigest: '/tmp/image.vhdx' }), /invalid_environment_spec/);
  assert.throws(() => validateEnvironmentSpec({ ...spec, networkProfileId: '../switch' }), /invalid_environment_spec/);
  assert.throws(() => validateEnvironmentOperation(operation('start', { expectedGeneration: 0 })), /invalid_environment_operation/);
  assert.throws(() => validateEnvironmentOperation(operation('start', { executable: 'powershell', command: 'anything' })), /invalid_environment_operation/);
  assert.throws(() => validateEnvironmentOperation(operation('create', { spec: { ...spec, resources: { ...spec.resources, vcpu: 0 } } })), /invalid_environment_spec/);
  assert.throws(() => validateEnvironmentOperation(Object.assign(Object.create({ action: 'start' }), operation('start'))), /invalid_environment_operation/);
  let getterCalled = false;
  const getterOperation = operation('start');
  Object.defineProperty(getterOperation, 'taskId', { get() { getterCalled = true; return 'task-1'; } });
  assert.throws(() => validateEnvironmentOperation(getterOperation), /invalid_environment_operation/);
  assert.equal(getterCalled, false);
});

test('Hyper-V adapter maps only fixed typed lifecycle methods and validates observations', async () => {
  const calls = [];
  const methods = Object.fromEntries([
    ['createVm', 'off'], ['inspectVm', 'off'], ['startVm', 'running'],
    ['stopVm', 'off'], ['removeVm', 'missing'],
  ].map(([name, observedState]) => [name, async (op) => {
    calls.push([name, op.action]);
    return { computerId: op.computerId, providerId: 'hyperv', state: observedState,
      generation: op.expectedGeneration, observedAt: '2026-10-28T00:00:00.000Z' };
  }]));
  const provider = new HyperVEnvironmentProvider({ broker: methods });
  for (const action of ['create', 'inspect', 'start', 'stop', 'destroy']) {
    const result = await provider[action](hypervOperation(action));
    assert.equal(result.providerId, 'hyperv');
  }
  assert.deepEqual(calls, [
    ['createVm', 'create'], ['inspectVm', 'inspect'], ['startVm', 'start'],
    ['stopVm', 'stop'], ['removeVm', 'destroy'],
  ]);
});

test('Hyper-V adapter rejects malformed or mismatched operations before Broker dispatch', async () => {
  let calls = 0;
  const methods = Object.fromEntries(['createVm', 'inspectVm', 'startVm', 'stopVm', 'removeVm']
    .map((name) => [name, async () => { calls++; throw new Error('must not be called'); }]));
  const provider = new HyperVEnvironmentProvider({ broker: methods });
  await assert.rejects(provider.start(hypervOperation('start', { command: 'powershell' })),
    (error) => error.code === 'invalid_environment_operation' && error.outcome === 'not_applied');
  await assert.rejects(provider.start(operation('start')), (error) => error.code === 'provider_operation_mismatch');
  await assert.rejects(provider.stop(hypervOperation('start')), (error) => error.code === 'provider_operation_mismatch');
  assert.equal(calls, 0);
});

test('Hyper-V adapter preserves ambiguous Broker failures and rejects stale mutation observations', async () => {
  const ambiguous = Object.assign(new Error('broker_timeout'), { code: 'broker_timeout' });
  const provider = new HyperVEnvironmentProvider({ broker: {
    createVm: async () => { throw ambiguous; },
    inspectVm: async (op) => ({ computerId: op.computerId, providerId: 'hyperv', state: 'off', generation: 2, observedAt: '2026-10-28T00:00:00.000Z' }),
    startVm: async (op) => ({ computerId: op.computerId, providerId: 'hyperv', state: 'running', generation: 2, observedAt: '2026-10-28T00:00:00.000Z' }),
    stopVm: async () => {}, removeVm: async () => {},
  } });
  await assert.rejects(provider.create(hypervOperation('create')), (error) => error === ambiguous);
  await assert.rejects(provider.start(hypervOperation('start')), (error) => error.code === 'stale_provider_observation');
  const inspected = await provider.inspect(hypervOperation('inspect'));
  assert.equal(inspected.generation, 2);
});

test('Hyper-V adapter requires the complete fixed Broker method set', () => {
  assert.throws(() => new HyperVEnvironmentProvider({ broker: { startVm() {} } }), /invalid_hyperv_broker_client/);
  const broker = Object.create({ createVm() {} });
  Object.assign(broker, { inspectVm() {}, startVm() {}, stopVm() {}, removeVm() {} });
  assert.throws(() => new HyperVEnvironmentProvider({ broker }), /invalid_hyperv_broker_client/);
});

test('placement capacity and quotas accept bounded host policy and reject malformed data', () => {
  const capacity = validateEnvironmentCapacity({
    os: 'linux', architecture: 'x64', capabilities: ['terminal', 'browser'],
    networkProfileIds: ['deny-egress-v1'], securityProfileIds: ['guest-restricted-v1'],
    resources: { vcpu: 8, memoryMiB: 8192, diskGiB: 128 },
  });
  assert.deepEqual(capacity.capabilities, ['browser', 'terminal']);
  assert.equal(Object.isFrozen(capacity.resources), true);
  assert.throws(() => validateEnvironmentCapacity({
    os: 'linux', architecture: 'x64', capabilities: ['powershell'],
    networkProfileIds: ['deny-egress-v1'], securityProfileIds: ['guest-restricted-v1'],
    resources: { vcpu: 8, memoryMiB: 8192, diskGiB: 128 },
  }), /invalid_environment_capacity/);
  assert.throws(() => validateEnvironmentCapacity({
    os: 'linux', architecture: 'x64', capabilities: [],
    networkProfileIds: ['deny-egress-v1'], securityProfileIds: ['guest-restricted-v1'],
    resources: { vcpu: 8, memoryMiB: 8192, diskGiB: 128 }, guestReported: true,
  }), /invalid_environment_capacity/);
  assert.deepEqual(validateEnvironmentQuota({ maxComputers: 2, vcpu: 8, memoryMiB: 8192, diskGiB: 256 }),
    { maxComputers: 2, vcpu: 8, memoryMiB: 8192, diskGiB: 256 });
  assert.throws(() => validateEnvironmentQuota({ maxComputers: 2, vcpu: 8, memoryMiB: 8192 }), /invalid_environment_quota/);
});

test('MockProvider drives typed lifecycle and reports observed state separately from requested state', async () => {
  const provider = new MockEnvironmentProvider();
  const coordinator = new EnvironmentOperationCoordinator({ provider });
  const created = await coordinator.execute(operation('create'));
  assert.equal(created.status, 'SUCCEEDED');
  assert.equal(created.desiredState, 'off');
  assert.equal(created.observedState, 'off');

  const started = await coordinator.execute(operation('start'));
  assert.equal(started.status, 'SUCCEEDED');
  assert.equal(started.desiredState, 'running');
  assert.equal(started.observedState, 'running');
});

test('idempotency returns prior result and rejects key reuse with a changed payload', async () => {
  let calls = 0;
  const provider = new MockEnvironmentProvider();
  const counted = Object.fromEntries(['create', 'inspect', 'start', 'stop', 'destroy'].map((method) => [method, async (op) => {
    calls++;
    return provider[method](op);
  }]));
  const coordinator = new EnvironmentOperationCoordinator({ provider: counted });
  const request = operation('create');
  const first = await coordinator.execute(request);
  const repeated = await coordinator.execute({ ...request, operationId: 'new-retry-operation-id' });
  assert.equal(calls, 1);
  assert.deepEqual(repeated, first);
  await assert.rejects(coordinator.execute({ ...request, operationId: 'operation-create-2', spec: { ...spec, resources: { ...spec.resources, vcpu: 3 } } }),
    (error) => error instanceof EnvironmentProviderError && error.code === 'idempotency_conflict');
  assert.equal(calls, 1);
});

test('timeout after side effect is UNKNOWN until inspection, and reconciliation never blindly repeats the action', async () => {
  const provider = new MockEnvironmentProvider();
  provider.failNext('create', { timing: 'after', code: 'provider_timeout' });
  const coordinator = new EnvironmentOperationCoordinator({ provider });
  const request = operation('create');
  const timedOut = await coordinator.execute(request);
  assert.equal(timedOut.status, 'UNKNOWN');
  assert.equal(timedOut.observedState, 'unknown');
  assert.equal(timedOut.errorCode, 'provider_timeout');

  const reconciled = await coordinator.reconcile(request.operationId);
  assert.equal(reconciled.status, 'SUCCEEDED');
  assert.equal(reconciled.observedState, 'off');
  const { spec: _spec, ...inspectRequest } = request;
  assert.equal((await provider.inspect({ ...inspectRequest, action: 'inspect' })).state, 'off');
});

test('provider failure before side effect is definitive; failed operation is not retried by idempotent replay', async () => {
  const provider = new MockEnvironmentProvider();
  provider.failNext('create', { timing: 'before' });
  const coordinator = new EnvironmentOperationCoordinator({ provider });
  const request = operation('create');
  const failed = await coordinator.execute(request);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'mock_provider_failure');
  assert.equal((await coordinator.execute(request)).status, 'FAILED');
  const { spec: _spec, ...inspectRequest } = request;
  assert.equal((await provider.inspect({ ...inspectRequest, action: 'inspect' })).state, 'missing');
});

test('inspection failure preserves UNKNOWN; it is not evidence the operation failed', async () => {
  const provider = new MockEnvironmentProvider();
  provider.failNext('create', { timing: 'after', code: 'provider_timeout' });
  provider.failNext('inspect', { timing: 'before', code: 'provider_unavailable' });
  const coordinator = new EnvironmentOperationCoordinator({ provider });
  const request = operation('create');
  assert.equal((await coordinator.execute(request)).status, 'UNKNOWN');
  const result = await coordinator.reconcile(request.operationId);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.errorCode, 'provider_unavailable');
});

test('ambiguous inspect is resolved by a later successful observation', async () => {
  const provider = new MockEnvironmentProvider();
  const coordinator = new EnvironmentOperationCoordinator({ provider });
  await coordinator.execute(operation('create'));
  provider.failNext('inspect', { timing: 'after', code: 'inspect_reply_lost' });
  const request = operation('inspect');
  const uncertain = await coordinator.execute(request);
  assert.equal(uncertain.status, 'UNKNOWN');
  const reconciled = await coordinator.reconcile(request.operationId);
  assert.equal(reconciled.status, 'SUCCEEDED');
  assert.equal(reconciled.observedState, 'off');
});

test('stale generations and cross-project operations fail closed', async () => {
  const provider = new MockEnvironmentProvider();
  const coordinator = new EnvironmentOperationCoordinator({ provider });
  await coordinator.execute(operation('create'));
  provider.restoreGeneration('computer-1', 2);
  const stale = await coordinator.execute(operation('start', { operationId: 'operation-start-stale', idempotencyKey: 'idem-start-stale' }));
  assert.equal(stale.status, 'FAILED');
  assert.equal(stale.errorCode, 'stale_generation');

  const foreign = await coordinator.execute(operation('start', {
    operationId: 'operation-start-foreign', idempotencyKey: 'idem-start-foreign', expectedGeneration: 2, projectId: 'project-b',
  }));
  assert.equal(foreign.status, 'FAILED');
  assert.equal(foreign.errorCode, 'project_mismatch');
});

test('operation snapshots expose allowlisted state and do not include credentials or provider details', async () => {
  const provider = new MockEnvironmentProvider();
  const coordinator = new EnvironmentOperationCoordinator({ provider });
  await assert.rejects(coordinator.execute(operation('create', { secret: 'never-export-this' })), /invalid_environment_operation/);
  const result = await coordinator.execute(operation('create'));
  assert.equal(Object.hasOwn(result, 'spec'), false);
  assert.equal(Object.hasOwn(result, 'providerId'), false);
});
