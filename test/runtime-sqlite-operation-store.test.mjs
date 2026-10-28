import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableEnvironmentOperationCoordinator } from '../src/runtime/environment-operations.mjs';
import { EnvironmentStoreError, openSqliteEnvironmentStore } from '../src/runtime/sqlite-operation-store.mjs';
import { MockEnvironmentProvider } from '../src/runtime/mock-environment-provider.mjs';

const spec = {
  projectId: 'project-a', kind: 'ephemeral', os: 'linux', architecture: 'x64',
  imageDigest: `sha256:${'b'.repeat(64)}`, capabilities: ['terminal'],
  networkProfileId: 'deny-egress-v1', securityProfileId: 'guest-restricted-v1',
  resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 32 },
};

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.homedir(), '.albera-operation-store-test-'));
  const databasePath = path.join(root, 'operations.sqlite');
  let nowMs = Date.parse('2026-10-28T00:00:00.000Z');
  const now = () => new Date(nowMs).toISOString();
  let store = await openSqliteEnvironmentStore(databasePath, { now, ...options });
  t.after(async () => {
    store?.close();
    await rm(root, { recursive: true, force: true });
  });
  const provider = new MockEnvironmentProvider({ now });
  let coordinator = new DurableEnvironmentOperationCoordinator({ store, provider, providerTimeoutMs: 100 });
  const computerId = 'computer-a';
  const registered = store.registerComputer({ computerId, projectId: 'project-a', providerId: 'mock' });
  const lease = store.reserveLease({
    leaseId: 'lease-a', subjectId: 'human-a', projectId: 'project-a', taskId: 'task-a', runId: 'run-a', computerId,
    expiresAt: new Date(nowMs + 60 * 60 * 1000).toISOString(),
  });
  const operation = (action, overrides = {}) => ({
    operationId: `operation-${action}-a`, idempotencyKey: `idem-${action}-a`, subjectId: lease.subjectId,
    projectId: lease.projectId, taskId: lease.taskId, runId: lease.runId, computerId, providerId: 'mock',
    leaseId: lease.leaseId, expectedGeneration: lease.generation, policyVersion: 1, action,
    ...(action === 'create' ? { spec } : {}), ...overrides,
  });
  return {
    root, databasePath, now, advance: (milliseconds) => { nowMs += milliseconds; },
    provider, operation, computerId, lease,
    get coordinator() { return coordinator; },
    reopen: async () => {
      store.close();
      store = await openSqliteEnvironmentStore(databasePath, { now, ...options });
      coordinator = new DurableEnvironmentOperationCoordinator({ store, provider, providerTimeoutMs: 100 });
    },
    get store() { return store; },
  };
}

test('SQLite store uses WAL, FULL synchronous writes, foreign keys, and a versioned schema', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.store.diagnostics(), { journalMode: 'wal', synchronous: 2, foreignKeys: 1, schemaVersion: 1 });
  assert.equal(f.store.getComputer(f.computerId).generation, 2);
  if (process.platform !== 'win32') assert.equal((await stat(f.databasePath)).mode & 0o777, 0o600);
});

test('durable intent is recorded before provider action and idempotent replay never repeats the side effect', async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  const first = await f.coordinator.execute(request);
  assert.equal(first.status, 'SUCCEEDED');
  assert.equal(first.desiredState, 'off');
  assert.equal(first.observedState, 'off');
  assert.equal(f.store.listEvents(f.computerId).find((event) => event.type === 'operation.succeeded').provenance, 'provider');
  const duplicate = await f.coordinator.execute({ ...request, operationId: 'operation-create-retry' });
  assert.equal(duplicate.operationId, request.operationId);
  assert.equal(f.store.listEvents(request.operationId).length, 1);
  await assert.rejects(f.coordinator.execute({ ...request, operationId: 'operation-create-conflict', spec: { ...spec, resources: { ...spec.resources, vcpu: 3 } } }),
    (error) => error instanceof EnvironmentStoreError && error.code === 'idempotency_conflict');
});

test('operation intent interrupted by host close becomes UNKNOWN after reopen and is inspected without blind replay', async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  const begun = f.store.beginOperation(request);
  assert.equal(begun.created, true);
  assert.equal(begun.operation.status, 'REQUESTED');
  await f.reopen();
  assert.equal(f.store.getOperation(request.operationId).status, 'UNKNOWN');
  const reconciled = await f.coordinator.reconcile(request.operationId);
  assert.equal(reconciled.status, 'UNKNOWN', 'missing provider state is not proof that retry is safe');
  assert.equal(f.store.getComputer(f.computerId).observedState, 'missing');
  assert.equal((await f.coordinator.execute(request)).status, 'UNKNOWN');
});

test('timeout after provider success reconciles by inspection and never duplicates create', async (t) => {
  const f = await fixture(t);
  f.provider.failNext('create', { timing: 'after', code: 'provider_timeout' });
  const request = f.operation('create');
  const uncertain = await f.coordinator.execute(request);
  assert.equal(uncertain.status, 'UNKNOWN');
  assert.equal(uncertain.errorCode, 'provider_timeout');
  const reconciled = await f.coordinator.reconcile(request.operationId);
  assert.equal(reconciled.status, 'SUCCEEDED');
  assert.equal(reconciled.observedState, 'off');
  assert.equal((await f.coordinator.execute(request)).operationId, request.operationId);
});

test('inspection failure remains UNKNOWN and no implicit provider retry is performed', async (t) => {
  const f = await fixture(t);
  f.provider.failNext('create', { timing: 'after', code: 'create_reply_lost' });
  f.provider.failNext('inspect', { timing: 'before', code: 'provider_unavailable' });
  const request = f.operation('create');
  assert.equal((await f.coordinator.execute(request)).status, 'UNKNOWN');
  const result = await f.coordinator.reconcile(request.operationId);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.errorCode, 'provider_unavailable');
});

test('unowned computers, stale generations, mismatched providers, expired and revoked leases are denied', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.store.reserveLease({ leaseId: 'lease-foreign', subjectId: 'human-b', projectId: 'project-b', taskId: 'task-b', runId: 'run-b', computerId: f.computerId, expiresAt: new Date(Date.parse(f.now()) + 60_000).toISOString() }),
    (error) => error.code === 'computer_not_owned');
  assert.throws(() => f.store.beginOperation(f.operation('create', { providerId: 'hyperv' })),
    (error) => error.code === 'computer_not_owned');
  const revoked = f.store.revokeLease(f.lease.leaseId, { reason: 'restore' });
  assert.equal(revoked.generation, f.lease.generation + 1);
  assert.equal(f.store.getComputer(f.computerId).observedState, 'unknown');
  assert.throws(() => f.store.beginOperation(f.operation('stop', { operationId: 'stale-stop', idempotencyKey: 'stale-stop-key' })),
    (error) => error.code === 'stale_generation');
  assert.equal(f.store.revokeLease(f.lease.leaseId, { reason: 'restore' }).generation, revoked.generation, 'revoke replay is idempotent');
});

test('reconciliation from a revoked generation stays UNKNOWN even when the provider reports the old desired state', async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  f.store.beginOperation(request);
  f.store.recordProviderOutcome(request.operationId, { errorCode: 'provider_reply_lost' });
  f.store.revokeLease(f.lease.leaseId, { reason: 'restore' });
  const reconciled = f.store.recordReconciliation(request.operationId, {
    computerId: f.computerId, providerId: 'mock', state: 'off', generation: f.lease.generation,
    observedAt: f.now(),
  });
  assert.equal(reconciled.status, 'UNKNOWN');
  assert.equal(reconciled.errorCode, 'stale_generation');
  assert.equal(f.store.getComputer(f.computerId).observedState, 'unknown');
});

test('Lease expiry does not free a computer; release requires current-generation stop observation', async (t) => {
  const f = await fixture(t);
  f.advance(2 * 60 * 60 * 1000);
  assert.equal(f.store.expireLeases(), 1);
  assert.equal(f.store.getLease(f.lease.leaseId).state, 'EXPIRED');
  assert.throws(() => f.store.reserveLease({ leaseId: 'lease-b', subjectId: 'human-a', projectId: 'project-a', taskId: 'task-b', runId: 'run-b', computerId: f.computerId, expiresAt: new Date(Date.parse(f.now()) + 60_000).toISOString() }),
    (error) => error.code === 'computer_already_leased');
  assert.throws(() => f.store.releaseLease(f.lease.leaseId, { computerId: f.computerId, providerId: 'mock', state: 'running', generation: f.lease.generation, observedAt: f.now() }),
    (error) => error.code === 'stop_not_confirmed');
  const released = f.store.releaseLease(f.lease.leaseId, { computerId: f.computerId, providerId: 'mock', state: 'off', generation: f.lease.generation, observedAt: f.now() });
  assert.equal(released.state, 'RELEASED');
  const next = f.store.reserveLease({ leaseId: 'lease-b', subjectId: 'human-a', projectId: 'project-a', taskId: 'task-b', runId: 'run-b', computerId: f.computerId, expiresAt: new Date(Date.parse(f.now()) + 60_000).toISOString() });
  assert.equal(next.generation, f.lease.generation + 1);
});

test('operation/event storage excludes prompts and arbitrary secret fields', async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  assert.throws(() => f.store.beginOperation({ ...request, api_key: 'must-not-be-persisted' }), /invalid_environment_operation/);
  const result = await f.coordinator.execute(request);
  const bytes = await readFile(f.databasePath);
  assert.equal(bytes.includes(Buffer.from('password')), false);
  assert.equal(JSON.stringify(result).includes('api_key'), false);
  assert.equal(JSON.stringify(f.store.listEvents(request.operationId)).includes('prompt'), false);
});

test('database open refuses symlink paths and preserves existing corrupt database bytes', async (t) => {
  const f = await fixture(t);
  const linkPath = path.join(f.root, 'linked.sqlite');
  const targetPath = path.join(f.root, 'target.sqlite');
  await writeFile(targetPath, 'user-owned-bytes', { mode: 0o600 });
  const { symlink } = await import('node:fs/promises');
  try { await symlink(targetPath, linkPath); } catch { return t.skip('symlink creation is unavailable'); }
  await assert.rejects(openSqliteEnvironmentStore(linkPath), (error) => error.code === 'database_file_invalid');
  await assert.rejects(openSqliteEnvironmentStore(targetPath), (error) => error.code === 'database_open_failed' || error.code === 'database_integrity_failed');
  assert.equal(await readFile(targetPath, 'utf8'), 'user-owned-bytes');
});
