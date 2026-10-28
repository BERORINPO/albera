import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { LocalEnvironmentHostBroker } from '../src/runtime/environment-host-broker.mjs';
import { MockEnvironmentProvider } from '../src/runtime/mock-environment-provider.mjs';
import { openSqliteEnvironmentStore } from '../src/runtime/sqlite-operation-store.mjs';
import { validateBrokerRequest, validateBrokerResponse } from '../src/runtime/boundary-protocols.mjs';

const CONTROL_PLANE_SID = 'S-1-5-80-1001';
const WRONG_SERVICE_SID = 'S-1-5-80-2002';
const spec = {
  projectId: 'project-a', kind: 'ephemeral', os: 'linux', architecture: 'x64',
  imageDigest: `sha256:${'c'.repeat(64)}`, capabilities: ['terminal'],
  networkProfileId: 'deny-egress-v1', securityProfileId: 'guest-restricted-v1',
  resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 24 },
};

function createMockIpc({ broker, expectedServiceSid }) {
  const connectionPrincipals = new WeakMap();
  const seenRequestIds = new Set();
  const connect = (serviceSid) => {
    const connection = Object.freeze(Object.create(null));
    connectionPrincipals.set(connection, serviceSid);
    return Object.freeze({ send: (request) => receive(connection, request) });
  };
  const receive = async (connection, input) => {
    const principal = connectionPrincipals.get(connection);
    if (principal !== expectedServiceSid) return Object.freeze({ error: 'authorization_denied' });

    let request;
    try { request = validateBrokerRequest(input); }
    catch { return Object.freeze({ error: 'invalid_request' }); }
    if (seenRequestIds.has(request.requestId)) return Object.freeze({ error: 'replay_denied' });
    seenRequestIds.add(request.requestId);

    try {
      const claim = broker.claimOperation(request);
      const observed = await broker.executeClaim(claim);
      return validateBrokerResponse({
        protocolVersion: 1, type: 'broker.operation.response', requestId: request.requestId,
        operationId: request.operationId, expectedGeneration: request.expectedGeneration,
        status: 'succeeded', observedState: observed.state, observedAt: observed.observedAt,
      });
    } catch (error) {
      const { status, errorCode } = safeBrokerError(error);
      return validateBrokerResponse({
        protocolVersion: 1, type: 'broker.operation.response', requestId: request.requestId,
        operationId: request.operationId, expectedGeneration: request.expectedGeneration,
        status, observedState: 'unknown', errorCode,
      });
    }
  };
  return Object.freeze({ connect });
}

function safeBrokerError(error) {
  const code = ownData(error, 'code');
  if (code === 'stale_generation') return { status: 'denied', errorCode: 'generation_mismatch' };
  if (code === 'operation_not_dispatchable') return { status: 'denied', errorCode: 'operation_conflict' };
  if (code === 'operation_unknown') return { status: 'denied', errorCode: 'operation_unknown' };
  if (['authorization_expired', 'broker_authorization_missing', 'broker_authorization_mismatch', 'lease_not_authorized'].includes(code)) {
    return { status: 'denied', errorCode: 'authorization_denied' };
  }
  // Do not project exception text or arbitrary error.code values across IPC.
  return { status: 'unknown', errorCode: 'provider_state_unknown' };
}

function ownData(value, key) {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}

async function fixture(t, { approvalTtlMs = 60_000, providerFailure } = {}) {
  let nowMs = Date.parse('2026-10-28T00:00:00.000Z');
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-mock-broker-ipc-'));
  let store = await openSqliteEnvironmentStore(path.join(root, 'operations.sqlite'), {
    now: () => new Date(nowMs).toISOString(), verifyWindowsAcl: async () => {},
  });
  const provider = new MockEnvironmentProvider({ now: () => new Date(nowMs).toISOString() });
  let createCalls = 0;
  const create = provider.create.bind(provider);
  provider.create = async (...args) => {
    createCalls++;
    if (providerFailure) throw providerFailure;
    return create(...args);
  };
  const broker = new LocalEnvironmentHostBroker({ store, provider });
  store.registerComputer({ computerId: 'computer-a', projectId: 'project-a', providerId: provider.providerId });
  const lease = store.reserveLease({
    leaseId: 'lease-a', subjectId: 'subject-a', projectId: 'project-a', taskId: 'task-a',
    runId: 'run-a', computerId: 'computer-a', expiresAt: new Date(nowMs + 60 * 60_000).toISOString(),
  });
  const operation = {
    operationId: 'operation-create-a', idempotencyKey: 'idem-create-a', subjectId: lease.subjectId,
    projectId: lease.projectId, taskId: lease.taskId, runId: lease.runId, computerId: 'computer-a',
    providerId: provider.providerId, leaseId: lease.leaseId, expectedGeneration: lease.generation,
    policyVersion: 1, action: 'create', spec,
  };
  const begun = store.beginOperation(operation);
  const actionDigest = `sha256:${begun.operation.actionDigest}`;
  store.recordOperationAuthorization(operation.operationId, {
    decision: 'approved', approvalId: 'approval-create-a', approverId: 'human-a',
    operationId: operation.operationId, idempotencyKey: operation.idempotencyKey,
    subjectId: operation.subjectId, projectId: operation.projectId, policyVersion: operation.policyVersion,
    actionDigest, purpose: 'execute', expiresAt: new Date(nowMs + approvalTtlMs).toISOString(),
  }, { purpose: 'execute' });
  const ipc = createMockIpc({ broker, expectedServiceSid: CONTROL_PLANE_SID });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return {
    store, provider, broker, ipc, operation, actionDigest,
    request: (overrides = {}) => ({
      protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
      operationId: operation.operationId, expectedGeneration: operation.expectedGeneration,
      actionDigest, ...overrides,
    }),
    connect: (sid = CONTROL_PLANE_SID) => ipc.connect(sid),
    advance: (milliseconds) => { nowMs += milliseconds; },
    get createCalls() { return createCalls; },
  };
}

test('Mock IPC accepts only the authenticated Control Plane peer and fixed journal-bound request', async (t) => {
  const f = await fixture(t);
  const client = f.connect();
  const response = await client.send(f.request());
  assert.equal(response.status, 'succeeded');
  assert.equal(response.operationId, f.operation.operationId);
  assert.equal(response.expectedGeneration, f.operation.expectedGeneration);
  assert.equal(response.observedState, 'off');
  assert.equal(f.createCalls, 1);
  assert.equal(f.store.getOperation(f.operation.operationId).status, 'UNKNOWN',
    'the Broker-side dispatch claim is UNKNOWN until the Control Plane persists the reply');
});

test('Mock IPC denies unauthenticated and wrong-service callers before journal or Provider access', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  for (const client of [f.ipc.connect('S-1-0-0'), f.ipc.connect(WRONG_SERVICE_SID)]) {
    assert.deepEqual(await client.send(request), { error: 'authorization_denied' });
  }
  assert.equal(f.store.getOperation(f.operation.operationId).status, 'REQUESTED');
  assert.equal(f.store.listOperationAuthorizations(f.operation.operationId)[0].state, 'RECORDED');
  assert.equal(f.createCalls, 0);
});

test('Mock IPC rejects caller-supplied identity, arbitrary actions, and malformed envelope fields', async (t) => {
  const f = await fixture(t);
  const client = f.connect();
  const request = f.request();
  assert.deepEqual(await client.send({ ...request, callerSid: CONTROL_PLANE_SID }), { error: 'invalid_request' });
  assert.deepEqual(await client.send({ ...request, action: 'powershell', command: 'Start-VM' }), { error: 'invalid_request' });
  assert.equal(f.store.getOperation(f.operation.operationId).status, 'REQUESTED');
  assert.equal(f.createCalls, 0);
});

test('Mock IPC consumes a request ID and a journaled operation at most once', async (t) => {
  const f = await fixture(t);
  const client = f.connect();
  const request = f.request();
  assert.equal((await client.send(request)).status, 'succeeded');
  assert.deepEqual(await client.send(request), { error: 'replay_denied' });
  const freshRequest = f.request();
  const secondDispatch = await client.send(freshRequest);
  assert.equal(secondDispatch.status, 'denied');
  assert.equal(secondDispatch.errorCode, 'operation_conflict');
  assert.equal(f.createCalls, 1);
});

test('Mock IPC rejects expired approval and stale Lease generation before Provider I/O', async (t) => {
  const expired = await fixture(t, { approvalTtlMs: 1_000 });
  expired.advance(1_001);
  const expiredResponse = await expired.connect().send(expired.request());
  assert.equal(expiredResponse.status, 'denied');
  assert.equal(expiredResponse.errorCode, 'authorization_denied');
  assert.equal(expired.store.getOperation(expired.operation.operationId).status, 'REQUESTED');
  assert.equal(expired.createCalls, 0);

  const stale = await fixture(t);
  stale.store.revokeLease('lease-a', { reason: 'restore' });
  const staleResponse = await stale.connect().send(stale.request());
  assert.equal(staleResponse.status, 'denied');
  assert.equal(staleResponse.errorCode, 'generation_mismatch');
  assert.equal(stale.createCalls, 0);
});

test('Mock IPC binds Operation ID, generation and digest to trusted journal state', async (t) => {
  const f = await fixture(t);
  const client = f.connect();
  for (const request of [
    f.request({ operationId: 'operation-other-a' }),
    f.request({ expectedGeneration: f.operation.expectedGeneration + 1 }),
    f.request({ actionDigest: `sha256:${'f'.repeat(64)}` }),
  ]) {
    const response = await client.send(request);
    assert.equal(response.status, 'denied');
  }
  assert.equal(f.store.getOperation(f.operation.operationId).status, 'REQUESTED');
  assert.equal(f.createCalls, 0);
});

test('Mock IPC projects secret-bearing Provider failures to a fixed safe response', async (t) => {
  const secret = 'token-secret-DO-NOT-RETURN';
  const failure = Object.assign(new Error(secret), { code: secret });
  const f = await fixture(t, { providerFailure: failure });
  const response = await f.connect().send(f.request());
  assert.equal(response.status, 'unknown');
  assert.equal(response.errorCode, 'provider_state_unknown');
  assert.doesNotMatch(JSON.stringify(response), /token-secret-DO-NOT-RETURN/);
  assert.equal(f.store.getOperation(f.operation.operationId).status, 'UNKNOWN',
    'provider exceptions after durable dispatch remain uncertain');
  assert.equal(f.createCalls, 1);
});
