import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { createRuntimeApi } from '../src/runtime/api.mjs';
import { createEnvironmentControlPlane } from '../src/runtime/environment-control-plane.mjs';
import { DurableEnvironmentOperationCoordinator } from '../src/runtime/environment-operations.mjs';
import { LocalEnvironmentHostBroker } from '../src/runtime/environment-host-broker.mjs';
import { MockEnvironmentProvider } from '../src/runtime/mock-environment-provider.mjs';
import { openSqliteEnvironmentStore } from '../src/runtime/sqlite-operation-store.mjs';

const sessionId = '11223344556677889900aabbccddeeff';
const environmentSpec = {
  projectId: 'project-a', kind: 'ephemeral', os: 'linux', architecture: 'x64',
  imageDigest: `sha256:${'c'.repeat(64)}`, capabilities: ['terminal'],
  networkProfileId: 'deny-egress-v1', securityProfileId: 'guest-restricted-v1',
  resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 24 },
};

function send(address, token, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: address.host, port: address.port, method: 'POST', path: route,
      headers: {
        Host: `${address.host}:${address.port}`, Authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('authenticated Runtime API drives durable MockProvider create, UNKNOWN reconciliation, and idempotent replay', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'albera-control-plane-'));
  const store = await openSqliteEnvironmentStore(path.join(root, 'operations.sqlite'), { verifyWindowsAcl: async () => {} });
  const provider = new MockEnvironmentProvider();
  let providerCreates = 0;
  let providerStarts = 0;
  let providerStops = 0;
  let providerDestroys = 0;
  let providerInspections = 0;
  const create = provider.create.bind(provider);
  const start = provider.start.bind(provider);
  const stop = provider.stop.bind(provider);
  const destroy = provider.destroy.bind(provider);
  const inspect = provider.inspect.bind(provider);
  provider.create = async (operation) => { providerCreates++; return create(operation); };
  provider.start = async (operation) => { providerStarts++; return start(operation); };
  provider.stop = async (operation) => { providerStops++; return stop(operation); };
  provider.destroy = async (operation) => { providerDestroys++; return destroy(operation); };
  provider.inspect = async (operation) => { providerInspections++; return inspect(operation); };
  let grantCount = 0;
  let denyAuthorizations = false;
  const authorizeOperation = ({ operation, actionDigest, purpose }) => {
    grantCount++;
    if (denyAuthorizations) throw new Error('private denial detail');
    return {
      decision: 'approved', approvalId: randomUUID(), approverId: 'synthetic-human',
      operationId: operation.operationId, idempotencyKey: operation.idempotencyKey,
      subjectId: operation.subjectId, projectId: operation.projectId, policyVersion: operation.policyVersion,
      actionDigest, purpose, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  };
  const broker = new LocalEnvironmentHostBroker({ store, provider });
  const coordinator = new DurableEnvironmentOperationCoordinator({ store, broker, authorizeOperation, providerTimeoutMs: 1_000 });
  store.registerComputer({ computerId: 'computer-a', projectId: 'project-a', providerId: 'mock' });
  store.reserveLease({
    leaseId: 'lease-a', subjectId: sessionId, projectId: 'project-a', taskId: 'task-a', runId: 'run-a', computerId: 'computer-a',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  const environmentControlPlane = createEnvironmentControlPlane({
    coordinator,
    store,
    policyVersionForProject({ subjectId, projectId }) {
      if (subjectId !== sessionId || projectId !== 'project-a') throw new Error('policy denied');
      return 1;
    },
  });
  const gateway = { start: async () => {}, stop: async () => {}, list: () => [], events: () => [], close: async () => {} };
  const api = createRuntimeApi({ gateway, environmentControlPlane });
  const token = api.createCredential(['environments:execute', 'environments:reconcile'], { sessionId });
  const address = await api.listen();
  t.after(async () => { await api.close(); store.close(); await rm(root, { recursive: true, force: true }); });

  const body = {
    operationId: 'operation-create-a', idempotencyKey: 'idem-create-a', projectId: 'project-a',
    taskId: 'task-a', runId: 'run-a', computerId: 'computer-a', providerId: 'mock', leaseId: 'lease-a',
    expectedGeneration: 1, action: 'create', spec: environmentSpec,
  };
  const spoofed = await send(address, token, '/v1/environments/operations', { ...body, subjectId: 'another-user' });
  assert.equal(spoofed.status, 400);
  assert.equal(store.getOperation(body.operationId), null);
  assert.equal(providerCreates, 0);

  denyAuthorizations = true;
  const deniedBody = { ...body, operationId: 'operation-denied-a', idempotencyKey: 'idem-denied-a' };
  const denied = await send(address, token, '/v1/environments/operations', deniedBody);
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body, { error: 'authorization_denied' });
  assert.equal(store.getOperation(deniedBody.operationId), null);
  assert.equal(providerCreates, 0);
  denyAuthorizations = false;

  provider.failNext('create', { timing: 'after', code: 'reply_lost' });
  const uncertain = await send(address, token, '/v1/environments/operations', body);
  assert.equal(uncertain.status, 200);
  assert.equal(uncertain.body.operation.subjectId, sessionId);
  assert.equal(uncertain.body.operation.status, 'UNKNOWN');
  assert.equal('request' in uncertain.body.operation, false);
  assert.equal(providerCreates, 1);
  assert.equal(store.getOperation(body.operationId).status, 'UNKNOWN');

  const foreign = await send(address, api.createCredential(['environments:reconcile'], { sessionId: 'ffeeddccbbaa00998877665544332211' }), `/v1/environments/operations/${body.operationId}/reconcile`);
  assert.equal(foreign.status, 404);
  assert.equal(providerInspections, 0);

  const reconciled = await send(address, token, `/v1/environments/operations/${body.operationId}/reconcile`);
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.operation.status, 'SUCCEEDED');
  assert.equal(reconciled.body.operation.observedState, 'off');
  assert.equal(providerInspections, 1);
  assert.equal(store.listOperationAuthorizations(body.operationId).map((entry) => entry.purpose).sort().join(','), 'execute,reconcile');

  const replay = await send(address, token, '/v1/environments/operations', body);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.operation.status, 'SUCCEEDED');
  assert.equal(providerCreates, 1, 'idempotent replay does not repeat a Provider mutation');

  const submit = async (action) => send(address, token, '/v1/environments/operations', {
    operationId: `operation-${action}-a`, idempotencyKey: `idem-${action}-a`, projectId: 'project-a',
    taskId: 'task-a', runId: 'run-a', computerId: 'computer-a', providerId: 'mock', leaseId: 'lease-a',
    expectedGeneration: 1, action,
  });
  const started = await submit('start');
  assert.equal(started.status, 200);
  assert.equal(started.body.operation.status, 'SUCCEEDED');
  assert.equal(started.body.operation.observedState, 'running');
  assert.equal(providerStarts, 1);

  const inspected = await submit('inspect');
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body.operation.status, 'SUCCEEDED');
  assert.equal(inspected.body.operation.observedState, 'running');
  assert.equal(providerInspections, 2, 'one inspect reconciles the lost reply and another serves the explicit state query');

  const stopped = await submit('stop');
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.operation.status, 'SUCCEEDED');
  assert.equal(stopped.body.operation.observedState, 'off');
  assert.equal(providerStops, 1);

  const destroyed = await send(address, token, '/v1/environments/operations', {
    operationId: 'operation-destroy-a', idempotencyKey: 'idem-destroy-a', projectId: 'project-a',
    taskId: 'task-a', runId: 'run-a', computerId: 'computer-a', providerId: 'mock', leaseId: 'lease-a',
    expectedGeneration: 1, action: 'destroy',
  });
  assert.equal(destroyed.status, 200);
  assert.equal(destroyed.body.operation.status, 'SUCCEEDED');
  assert.equal(destroyed.body.operation.observedState, 'missing');
  assert.equal(providerDestroys, 1);
  assert.equal(grantCount, 8, 'each execute/reconcile request gets a fresh authorization decision, including denied requests');
});
