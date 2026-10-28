import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DurableEnvironmentOperationCoordinator } from '../src/runtime/environment-operations.mjs';
import { reserveComputerForRun } from '../src/runtime/computer-scheduler.mjs';
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
  let store = await openSqliteEnvironmentStore(databasePath, { now, verifyWindowsAcl: async () => {}, ...options });
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
      store = await openSqliteEnvironmentStore(databasePath, { now, verifyWindowsAcl: async () => {}, ...options });
      coordinator = new DurableEnvironmentOperationCoordinator({ store, provider, providerTimeoutMs: 100 });
    },
    get store() { return store; },
  };
}

function spawnSynchronizedStoreWorker(workerPath, databasePath, workerId, mode) {
  const child = spawn(process.execPath, [workerPath, databasePath, String(workerId), mode], {
    cwd: path.dirname(path.dirname(workerPath)), shell: false, windowsHide: true,
    env: Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP'].filter((key) => process.env[key])
      .map((key) => [key, process.env[key]])),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  let resolveReady;
  let rejectReady;
  let readySettled = false;
  let resolveResult;
  let rejectResult;
  let resultSettled = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; child.once('error', reject); });
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    lines.close();
    if (!readySettled) { readySettled = true; rejectReady(new Error(`store_worker_exited_before_ready_${code ?? signal ?? 'unknown'}`)); }
    if (!resultSettled) {
      resultSettled = true;
      rejectResult(new Error(`store_worker_exited_${code ?? signal ?? 'unknown'}`));
    }
    resolve();
  }));
  lines.on('line', (line) => {
    if (line === 'READY' && !readySettled) { readySettled = true; resolveReady(); }
    else if (line.startsWith('RESULT ')) {
      resultSettled = true;
      try { resolveResult(JSON.parse(line.slice(7))); }
      catch { rejectResult(new Error('store_worker_result_invalid')); }
    }
  });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-1024); });
  child.on('exit', () => { if (!resultSettled && stderr) rejectResult(new Error(`store_worker_failed: ${stderr}`)); });
  return { child, ready, result, exited };
}

test('SQLite store uses WAL, FULL synchronous writes, foreign keys, and a versioned schema', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.store.diagnostics(), { journalMode: 'wal', synchronous: 2, foreignKeys: 1, schemaVersion: 3 });
  assert.equal(f.store.getComputer(f.computerId).generation, 1);
  if (process.platform !== 'win32') assert.equal((await stat(f.databasePath)).mode & 0o777, 0o600);
});

test('schema v1 migration preserves existing Computer and Lease rows', async (t) => {
  const root = await mkdtemp(path.join(os.homedir(), '.albera-operation-store-migration-'));
  const databasePath = path.join(root, 'operations.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE computers (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, provider_id TEXT NOT NULL,
      desired_state TEXT NOT NULL, observed_state TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation >= 1),
      row_version INTEGER NOT NULL CHECK(row_version >= 1), observed_at TEXT
    ) STRICT;
    CREATE TABLE leases (
      id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
      computer_id TEXT NOT NULL REFERENCES computers(id), generation INTEGER NOT NULL CHECK(generation >= 1),
      expires_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('ACTIVE','EXPIRED','REVOKED','QUARANTINED','RELEASED')),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX one_unreleased_lease_per_computer ON leases(computer_id) WHERE state <> 'RELEASED';
    CREATE TABLE operations (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, subject_id TEXT NOT NULL, project_id TEXT NOT NULL,
      task_id TEXT NOT NULL, run_id TEXT NOT NULL, computer_id TEXT NOT NULL REFERENCES computers(id),
      provider_id TEXT NOT NULL, lease_id TEXT NOT NULL REFERENCES leases(id), generation INTEGER NOT NULL CHECK(generation >= 1),
      action TEXT NOT NULL CHECK(action IN ('create','inspect','start','stop','destroy')),
      action_digest TEXT NOT NULL, request_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('REQUESTED','UNKNOWN','SUCCEEDED','FAILED')),
      desired_state TEXT, observed_state TEXT NOT NULL, observed_at TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(subject_id, project_id, idempotency_key)
    ) STRICT;
    CREATE TABLE events (
      id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, aggregate_seq INTEGER NOT NULL,
      operation_id TEXT REFERENCES operations(id), event_type TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      provenance TEXT NOT NULL CHECK(provenance IN ('control_plane','provider','untrusted_guest')),
      payload_json TEXT NOT NULL, recorded_at TEXT NOT NULL, UNIQUE(aggregate_id, aggregate_seq)
    ) STRICT;
    INSERT INTO computers VALUES ('legacy-computer','legacy-project','mock','missing','missing',1,1,NULL);
    INSERT INTO leases VALUES ('legacy-lease','human','legacy-project','task','run','legacy-computer',1,'2026-10-29T00:00:00.000Z','ACTIVE','2026-10-28T00:00:00.000Z');
    PRAGMA user_version = 1;
  `);
  db.close();
  if (process.platform !== 'win32') await chmod(databasePath, 0o600);
  let store;
  try {
    store = await openSqliteEnvironmentStore(databasePath, { verifyWindowsAcl: async () => {} });
    assert.equal(store.diagnostics().schemaVersion, 3);
    assert.equal(store.getComputer('legacy-computer').projectId, 'legacy-project');
    assert.equal(store.getComputer('legacy-computer').capacity, null);
    assert.equal(store.getLease('legacy-lease').state, 'ACTIVE');
    assert.equal(store.getLease('legacy-lease').requirements, null);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('schema v2 migration creates the durable Guest event inbox without deleting existing rows', async (t) => {
  const f = await fixture(t);
  const computer = f.store.getComputer(f.computerId);
  const lease = f.store.getLease(f.lease.leaseId);
  f.store.close();
  const db = new DatabaseSync(f.databasePath);
  db.exec('DROP TABLE guest_event_receipts; PRAGMA user_version = 2');
  db.close();
  await f.reopen();
  assert.equal(f.store.diagnostics().schemaVersion, 3);
  assert.equal(f.store.getComputer(f.computerId).generation, computer.generation);
  assert.equal(f.store.getLease(f.lease.leaseId).runId, lease.runId);
  assert.deepEqual(f.store.recordGuestEvent({
    protocolVersion: 1, type: 'guest.event', messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    computerId: f.computerId, runId: lease.runId, generation: lease.generation, sequence: 1,
    occurredAt: '2026-10-28T00:00:00.000Z', eventType: 'heartbeat', agentVersion: '0.1.0',
  }).status, 'ACCEPTED');
});

test('durable Guest event intake acknowledges exact retries and rejects replay, gaps, conflicts and stale leases', async (t) => {
  const f = await fixture(t);
  const event = {
    protocolVersion: 1, type: 'guest.event', messageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    computerId: f.computerId, runId: f.lease.runId, generation: f.lease.generation, sequence: 1,
    occurredAt: '2026-10-28T00:00:00.000Z', eventType: 'heartbeat', agentVersion: '0.1.0',
  };
  assert.deepEqual(f.store.recordGuestEvent(event), { status: 'ACCEPTED', messageId: event.messageId, sequence: 1 });
  assert.deepEqual(f.store.recordGuestEvent(event),
    { status: 'DUPLICATE', messageId: event.messageId, sequence: 1 }, 'same message id and payload remains idempotent after restart-safe persistence');
  assert.throws(() => f.store.recordGuestEvent({ ...event, agentVersion: '0.2.0' }),
    (error) => error.code === 'guest_message_id_conflict');
  assert.throws(() => f.store.recordGuestEvent({ ...event, messageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    (error) => error.code === 'guest_event_replayed');
  assert.throws(() => f.store.recordGuestEvent({ ...event, messageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sequence: 3 }),
    (error) => error.code === 'guest_event_sequence_mismatch');
  assert.equal(f.store.listEvents(f.computerId).filter((record) => record.provenance === 'untrusted_guest').length, 1);
  await f.reopen();
  assert.equal(f.store.recordGuestEvent(event).status, 'DUPLICATE');
  f.store.revokeLease(f.lease.leaseId, { reason: 'restore' });
  assert.throws(() => f.store.recordGuestEvent({
    ...event, messageId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', sequence: 2,
  }), (error) => error.code === 'guest_generation_stale');
});

test('durable Guest event intake rejects inactive, expired, unknown and malformed host context', async (t) => {
  const f = await fixture(t);
  const event = {
    protocolVersion: 1, type: 'guest.event', messageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    computerId: f.computerId, runId: f.lease.runId, generation: f.lease.generation, sequence: 1,
    occurredAt: '2026-10-28T00:00:00.000Z', eventType: 'heartbeat', agentVersion: '0.1.0',
  };
  assert.throws(() => f.store.recordGuestEvent({ ...event, computerId: 'unknown-computer' }),
    (error) => error.code === 'guest_computer_unknown');
  assert.throws(() => f.store.recordGuestEvent({ ...event, runId: 'unknown-run' }),
    (error) => error.code === 'guest_lease_inactive');
  assert.throws(() => f.store.recordGuestEvent({ ...event, sequence: 0 }),
    (error) => error.code === 'guest_event_invalid');
  f.advance(60 * 60 * 60 * 1000);
  assert.throws(() => f.store.recordGuestEvent(event), (error) => error.code === 'guest_lease_inactive');
  assert.equal(f.store.listEvents(f.computerId).some((record) => record.provenance === 'untrusted_guest'), false);
});

test('scheduler atomically reserves only compatible host capacity and enforces hard project quotas', async (t) => {
  const f = await fixture(t);
  const capacity = { os: 'linux', architecture: 'x64', capabilities: ['terminal'],
    networkProfileIds: ['deny-egress-v1'], securityProfileIds: ['guest-restricted-v1'],
    resources: { vcpu: 4, memoryMiB: 4096, diskGiB: 64 } };
  f.store.registerComputer({ computerId: 'sched-a', projectId: 'sched-project', providerId: 'mock', capacity });
  f.store.registerComputer({ computerId: 'sched-b', projectId: 'sched-project', providerId: 'mock', capacity: {
    ...capacity, resources: { vcpu: 8, memoryMiB: 8192, diskGiB: 128 },
  } });
  const requirements = { ...spec, projectId: 'sched-project' };
  const quota = { maxComputers: 1, vcpu: 4, memoryMiB: 4096, diskGiB: 64 };
  const leaseBase = { leaseId: 'sched-lease-a', subjectId: 'human-a', taskId: 'task-sched', runId: 'run-sched',
    expiresAt: new Date(Date.parse(f.now()) + 60 * 60 * 1000).toISOString() };
  const reserved = reserveComputerForRun({ store: f.store, lease: leaseBase, requirements, quota });
  assert.equal(reserved.status, 'PROPOSED');
  assert.equal(reserved.computerId, 'sched-a', 'best fit is deterministic');
  assert.equal(reserved.lease.requirements.resources.vcpu, 2);
  assert.throws(() => reserveComputerForRun({ store: f.store,
    lease: { ...leaseBase, leaseId: 'sched-lease-b', taskId: 'task-sched-b', runId: 'run-sched-b' }, requirements, quota,
  }), (error) => error.code === 'project_quota_exceeded');
  assert.equal(f.store.getLease('sched-lease-b'), null);
});

test('scheduler treats expired or revoked reservations as held until observed release', async (t) => {
  const f = await fixture(t);
  const capacity = { os: 'linux', architecture: 'x64', capabilities: ['terminal'],
    networkProfileIds: ['deny-egress-v1'], securityProfileIds: ['guest-restricted-v1'],
    resources: { vcpu: 4, memoryMiB: 4096, diskGiB: 64 } };
  f.store.registerComputer({ computerId: 'held-a', projectId: 'held-project', providerId: 'mock', capacity });
  const requirements = { ...spec, projectId: 'held-project' };
  const quota = { maxComputers: 1, vcpu: 4, memoryMiB: 4096, diskGiB: 64 };
  const leaseBase = { subjectId: 'human-a', taskId: 'held-task', runId: 'held-run',
    expiresAt: new Date(Date.parse(f.now()) + 60 * 60 * 1000).toISOString() };
  reserveComputerForRun({ store: f.store, lease: { ...leaseBase, leaseId: 'held-lease' }, requirements, quota });
  f.store.expireLeases(new Date(Date.parse(f.now()) + 2 * 60 * 60 * 1000).toISOString());
  const result = reserveComputerForRun({ store: f.store,
    lease: { ...leaseBase, leaseId: 'held-next-lease', taskId: 'held-next-task', runId: 'held-next-run' }, requirements, quota,
  });
  assert.equal(result.status, 'NO_CAPACITY');
  assert.ok(result.reasonCodes.includes('lease_unavailable'));
});

test('legacy outstanding lease with unknown resource usage blocks quota admission', async (t) => {
  const f = await fixture(t);
  const capacity = { os: 'linux', architecture: 'x64', capabilities: ['terminal'],
    networkProfileIds: ['deny-egress-v1'], securityProfileIds: ['guest-restricted-v1'],
    resources: { vcpu: 4, memoryMiB: 4096, diskGiB: 64 } };
  f.store.registerComputer({ computerId: 'unknown-usage', projectId: 'project-a', providerId: 'mock', capacity });
  assert.throws(() => reserveComputerForRun({ store: f.store,
    lease: { leaseId: 'unknown-usage-lease', subjectId: 'human-a', taskId: 'unknown-task', runId: 'unknown-run',
      expiresAt: new Date(Date.parse(f.now()) + 60 * 60 * 1000).toISOString() },
    requirements: spec, quota: { maxComputers: 2, vcpu: 8, memoryMiB: 8192, diskGiB: 128 },
  }), (error) => error.code === 'project_usage_unknown');
});

test('separate processes cannot exceed an atomic project quota during simultaneous placement', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.homedir(), '.albera-scheduler-race-'));
  const databasePath = path.join(root, 'operations.sqlite');
  const workerPath = fileURLToPath(new URL('../scripts/runtime-scheduler-contender.mjs', import.meta.url));
  const capacity = { os: 'linux', architecture: 'x64', capabilities: ['terminal'],
    networkProfileIds: ['deny-egress-v1'], securityProfileIds: ['guest-restricted-v1'],
    resources: { vcpu: 4, memoryMiB: 4096, diskGiB: 32 } };
  let store = await openSqliteEnvironmentStore(databasePath, { verifyWindowsAcl: async () => {} });
  store.registerComputer({ computerId: 'race-computer-a', projectId: 'race-project', providerId: 'mock', capacity });
  store.registerComputer({ computerId: 'race-computer-b', projectId: 'race-project', providerId: 'mock', capacity });
  store.close();
  store = undefined;

  const workers = [];
  t.after(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    }
    await Promise.all(workers.map((worker) => worker.exited));
    store?.close();
    await rm(root, { recursive: true, force: true });
  });

  workers.push(...Array.from({ length: 8 }, (_, index) => spawnSynchronizedStoreWorker(workerPath, databasePath, index + 1, 'scheduler')));
  const allResults = Promise.all(workers.map((worker) => worker.result));
  allResults.catch(() => {});
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.child.stdin.end('go\n');
  const outcomes = await allResults;
  await Promise.all(workers.map((worker) => worker.exited));

  const winners = outcomes.filter((outcome) => outcome.status === 'PROPOSED');
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.ok(outcomes.every((outcome) => outcome.status === 'NO_CAPACITY'
    || outcome.status === 'PROPOSED' || ['project_quota_exceeded', 'computer_already_leased'].includes(outcome.errorCode)), JSON.stringify(outcomes));

  store = await openSqliteEnvironmentStore(databasePath, { verifyWindowsAcl: async () => {} });
  const activeLeases = outcomes.map(({ leaseId }) => leaseId).filter(Boolean)
    .map((leaseId) => store.getLease(leaseId)).filter((lease) => lease?.state === 'ACTIVE');
  assert.equal(activeLeases.length, 1);
});

test('separate processes durably accept one copy of a synchronized Guest event delivery', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const workerPath = fileURLToPath(new URL('../scripts/runtime-scheduler-contender.mjs', import.meta.url));
  f.store.close();
  const workers = Array.from({ length: 8 }, (_, index) => spawnSynchronizedStoreWorker(workerPath, f.databasePath, index + 1, 'guest-event'));
  t.after(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    }
    await Promise.all(workers.map((worker) => worker.exited));
  });

  const allResults = Promise.all(workers.map((worker) => worker.result));
  allResults.catch(() => {});
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.child.stdin.end('go\n');
  const outcomes = await allResults;
  await Promise.all(workers.map((worker) => worker.exited));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'ACCEPTED').length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'DUPLICATE').length, 7, JSON.stringify(outcomes));

  await f.reopen();
  const guestEvents = f.store.listEvents(f.computerId).filter((event) => event.provenance === 'untrusted_guest');
  assert.equal(guestEvents.length, 1);
  assert.equal(guestEvents[0].type, 'guest.heartbeat');
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
  const fencedEvents = f.store.listEvents(f.computerId).filter((event) => event.type === 'operation.reconciliation_fenced').length;
  f.store.recordReconciliation(request.operationId, {
    computerId: f.computerId, providerId: 'mock', state: 'off', generation: f.lease.generation, observedAt: f.now(),
  });
  assert.equal(f.store.listEvents(f.computerId).filter((event) => event.type === 'operation.reconciliation_fenced').length, fencedEvents,
    'repeated stale-generation inspection does not grow the event log');
});

test('policy revocation denies further requests without pretending a VM restore advanced its generation', async (t) => {
  const f = await fixture(t);
  const revoked = f.store.revokeLease(f.lease.leaseId, { reason: 'policy_changed' });
  assert.equal(revoked.generation, f.lease.generation);
  assert.throws(() => f.store.beginOperation(f.operation('start', {
    operationId: 'operation-revoked-start', idempotencyKey: 'idem-revoked-start',
  })), (error) => error.code === 'lease_not_authorized');
  assert.equal(f.store.getComputer(f.computerId).observedState, 'unknown');
});

test('a later restore advances generation even after an earlier policy revocation', async (t) => {
  const f = await fixture(t);
  f.store.revokeLease(f.lease.leaseId, { reason: 'policy_changed' });
  const restored = f.store.revokeLease(f.lease.leaseId, { reason: 'restore' });
  assert.equal(restored.generation, f.lease.generation + 1);
  assert.equal(f.store.revokeLease(f.lease.leaseId, { reason: 'restore' }).generation, restored.generation,
    'replay is idempotent after the Computer generation has advanced');
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
  assert.equal(next.generation, f.lease.generation, 'ordinary task reassignment does not simulate a VM restore');
});

test('a released off Computer can be leased to a new Run without desynchronizing Provider generation', async (t) => {
  const f = await fixture(t);
  const create = f.operation('create');
  assert.equal((await f.coordinator.execute(create)).status, 'SUCCEEDED');
  const { spec: _spec, ...inspectRequest } = create;
  const observed = await f.provider.inspect({ ...inspectRequest, action: 'inspect' });
  f.store.releaseLease(f.lease.leaseId, observed);
  const nextLease = f.store.reserveLease({
    leaseId: 'lease-next', subjectId: f.lease.subjectId, projectId: f.lease.projectId,
    taskId: 'task-next', runId: 'run-next', computerId: f.computerId,
    expiresAt: new Date(Date.parse(f.now()) + 60_000).toISOString(),
  });
  const start = f.operation('start', {
    operationId: 'operation-start-next', idempotencyKey: 'idem-start-next',
    leaseId: nextLease.leaseId, taskId: nextLease.taskId, runId: nextLease.runId,
    expectedGeneration: nextLease.generation,
  });
  const started = await f.coordinator.execute(start);
  assert.equal(started.status, 'SUCCEEDED');
  assert.equal(started.generation, f.lease.generation);
  assert.equal(started.observedState, 'running');
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
  await assert.rejects(openSqliteEnvironmentStore(linkPath, { verifyWindowsAcl: async () => {} }), (error) => error.code === 'database_file_invalid');
  await assert.rejects(openSqliteEnvironmentStore(targetPath, { verifyWindowsAcl: async () => {} }), (error) => error.code === 'database_open_failed' || error.code === 'database_integrity_failed');
  assert.equal(await readFile(targetPath, 'utf8'), 'user-owned-bytes');
});
