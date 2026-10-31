import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DurableEnvironmentOperationCoordinator } from '../src/runtime/environment-operations.mjs';
import { reserveComputerForRun } from '../src/runtime/computer-scheduler.mjs';
import { FlowJournalError } from '../src/runtime/approved-operation-journal.mjs';
import { EnvironmentStoreError, openSqliteEnvironmentStore, restoreSqliteEnvironmentStore } from '../src/runtime/sqlite-operation-store.mjs';
import { LocalEnvironmentHostBroker } from '../src/runtime/environment-host-broker.mjs';
import { HyperVEnvironmentProvider } from '../src/runtime/hyperv-environment-provider.mjs';
import { MockEnvironmentProvider } from '../src/runtime/mock-environment-provider.mjs';
import { createRetirementJournal } from '../src/runtime/environment-retirement-journal.mjs';
import { createGuestEventIntake } from '../src/runtime/guest-event-intake.mjs';
import { createGuestSessionCapabilityService } from '../src/runtime/guest-session-capability.mjs';

const spec = {
  projectId: 'project-a', kind: 'ephemeral', os: 'linux', architecture: 'x64',
  imageDigest: `sha256:${'b'.repeat(64)}`, capabilities: ['terminal'],
  networkProfileId: 'deny-egress-v1', securityProfileId: 'guest-restricted-v1',
  resources: { vcpu: 2, memoryMiB: 2048, diskGiB: 32 },
};
const WAL_JOURNAL_SIZE_LIMIT_BYTES = 4 * 1024 * 1024;

async function fixture(t, {
  provider: injectedProvider, authorizeOperation: injectedAuthorizer,
  providerFactory, prepareStore, prepareProvider, ...storeOptions
} = {}) {
  const root = await mkdtemp(path.join(os.homedir(), '.albera-operation-store-test-'));
  const databasePath = path.join(root, 'operations.sqlite');
  let nowMs = Date.parse('2026-10-28T00:00:00.000Z');
  const now = () => new Date(nowMs).toISOString();
  const advance = (milliseconds) => { nowMs += milliseconds; };
  const authorizeOperation = injectedAuthorizer ?? (({ operation, actionDigest, purpose }) => ({
    decision: 'approved', approvalId: randomUUID(), approverId: 'human-approver',
    operationId: operation.operationId, idempotencyKey: operation.idempotencyKey,
    subjectId: operation.subjectId, projectId: operation.projectId, policyVersion: operation.policyVersion,
    actionDigest, purpose, expiresAt: new Date(nowMs + 60_000).toISOString(),
  }));
  let store = await openSqliteEnvironmentStore(databasePath, {
    now, verifyWindowsAcl: async () => {}, recoverInterruptedRequests: true, ...storeOptions,
  });
  prepareStore?.(store, { advance });
  t.after(async () => {
    store?.close();
    await rm(root, { recursive: true, force: true });
  });
  const provider = injectedProvider ?? providerFactory?.({ root, now }) ?? new MockEnvironmentProvider({ now });
  prepareProvider?.(provider);
  const broker = new LocalEnvironmentHostBroker({ store, provider });
  let coordinator = new DurableEnvironmentOperationCoordinator({ store, broker, authorizeOperation, nowMs: () => nowMs, providerTimeoutMs: 100 });
  const computerId = 'computer-a';
  const registered = store.registerComputer({ computerId, projectId: 'project-a', providerId: provider.providerId });
  const lease = store.reserveLease({
    leaseId: 'lease-a', subjectId: 'human-a', projectId: 'project-a', taskId: 'task-a', runId: 'run-a', computerId,
    expiresAt: new Date(nowMs + 60 * 60 * 1000).toISOString(),
  });
  const operation = (action, overrides = {}) => ({
    operationId: `operation-${action}-a`, idempotencyKey: `idem-${action}-a`, subjectId: lease.subjectId,
    projectId: lease.projectId, taskId: lease.taskId, runId: lease.runId, computerId, providerId: provider.providerId,
    leaseId: lease.leaseId, expectedGeneration: lease.generation, policyVersion: 1, action,
    ...(action === 'create' ? { spec } : {}), ...overrides,
  });
  return {
    root, databasePath, now, advance,
    provider, broker, operation, computerId, lease, authorizeOperation,
    get coordinator() { return coordinator; },
    reopen: async () => {
      store.close();
      store = await openSqliteEnvironmentStore(databasePath, {
        now, verifyWindowsAcl: async () => {}, recoverInterruptedRequests: true, ...storeOptions,
      });
      coordinator = new DurableEnvironmentOperationCoordinator({ store, broker: new LocalEnvironmentHostBroker({ store, provider }), authorizeOperation, nowMs: () => nowMs, providerTimeoutMs: 100 });
    },
    get store() { return store; },
  };
}

async function recordExecutionApproval(f, operation, begun) {
  const authorization = await f.authorizeOperation({
    operation, actionDigest: `sha256:${begun.operation.actionDigest}`, purpose: 'execute',
  });
  return f.store.recordOperationAuthorization(operation.operationId, authorization, { purpose: 'execute' });
}

function spawnSynchronizedStoreWorker(workerPath, databasePath, workerId, mode, ...args) {
  const child = spawn(process.execPath, [workerPath, databasePath, String(workerId), mode, ...args], {
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
  // 'close', not 'exit': 'exit' can fire before the last stdout line (the RESULT) has been read, which failed a run with store_worker_exited_0 although the worker had answered.
  const exited = new Promise((resolve) => child.once('close', (code, signal) => {
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
  child.on('close', () => { if (!resultSettled && stderr) rejectResult(new Error(`store_worker_failed: ${stderr}`)); });
  return { child, ready, result, exited };
}

test('SQLite store uses WAL, FULL synchronous writes, foreign keys, and a versioned schema', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.store.diagnostics(), {
    journalMode: 'wal', synchronous: 2, foreignKeys: 1, walAutoCheckpointPages: 1000,
    walJournalSizeLimitBytes: WAL_JOURNAL_SIZE_LIMIT_BYTES,
    maxRecords: 20_000, maxGuestRecords: 5_000, schemaVersion: 6,
  });
  assert.equal(f.store.getComputer(f.computerId).generation, 1);
  if (process.platform !== 'win32') assert.equal((await stat(f.databasePath)).mode & 0o777, 0o600);
});

test('PASSIVE WAL checkpoint preserves journal reads while an independent connection pins a snapshot', async (t) => {
  const f = await fixture(t);
  const reader = new DatabaseSync(f.databasePath);
  let readerOpen = true;
  try {
    reader.exec('BEGIN');
    const initialComputerCount = reader.prepare('SELECT COUNT(*) AS count FROM computers').get().count;
    const computerIds = Array.from({ length: 12 }, (_, index) => `wal-reader-computer-${index}`);
    for (const computerId of computerIds) {
      f.store.registerComputer({ computerId, projectId: 'project-a', providerId: 'mock' });
    }

    const duringReader = f.store.checkpointWal();
    assert.equal(duringReader.mode, 'PASSIVE');
    assert.ok(duringReader.logFrames >= duringReader.checkpointedFrames);
    assert.ok(duringReader.remainingFrames >= 0);
    assert.ok(duringReader.remainingFrames > 0, 'the active reader can defer checkpoint progress');
    assert.equal(reader.prepare('SELECT COUNT(*) AS count FROM computers').get().count, initialComputerCount,
      'the pinned reader retains its original snapshot after a checkpoint attempt');

    reader.exec('COMMIT');
    reader.close();
    readerOpen = false;
    const afterReader = f.store.checkpointWal();
    assert.equal(afterReader.remainingFrames, 0);
    for (const computerId of computerIds) {
      assert.equal(f.store.getComputer(computerId).computerId, computerId);
      assert.equal(f.store.listEvents(computerId)[0].type, 'computer.registered');
    }
  } finally {
    if (readerOpen) reader.close();
  }
});

test('WAL size limit trims a reset log but does not truncate frames pinned by a reader', async (t) => {
  const f = await fixture(t);
  const reader = new DatabaseSync(f.databasePath);
  let readerOpen = true;
  try {
    reader.exec('BEGIN');
    const initialCount = reader.prepare('SELECT COUNT(*) AS count FROM computers').get().count;
    const computerIds = Array.from({ length: 1_300 }, (_, index) => `wal-size-limit-computer-${index}`);
    for (const computerId of computerIds) {
      f.store.registerComputer({ computerId, projectId: 'project-a', providerId: 'mock' });
    }

    const pinnedCheckpoint = f.store.checkpointWal();
    assert.ok(pinnedCheckpoint.remainingFrames > 0, 'a pinned read snapshot prevents full checkpoint/reset');
    const pinnedWalBytes = (await stat(`${f.databasePath}-wal`)).size;
    assert.ok(pinnedWalBytes > WAL_JOURNAL_SIZE_LIMIT_BYTES,
      'journal_size_limit is not a hard bound while an older reader pins the WAL');
    assert.equal(reader.prepare('SELECT COUNT(*) AS count FROM computers').get().count, initialCount);

    reader.exec('COMMIT');
    reader.close();
    readerOpen = false;
    const releasedCheckpoint = f.store.checkpointWal();
    assert.equal(releasedCheckpoint.remainingFrames, 0);
    f.store.registerComputer({ computerId: 'wal-size-limit-after-release', projectId: 'project-a', providerId: 'mock' });
    assert.ok((await stat(`${f.databasePath}-wal`)).size <= WAL_JOURNAL_SIZE_LIMIT_BYTES,
      'the next write resets the fully checkpointed WAL to its configured idle size');
    assert.equal(f.store.getComputer(computerIds.at(-1)).computerId, computerIds.at(-1));
  } finally {
    if (readerOpen) reader.close();
  }
});

test('event pages use stable aggregate cursors and reject invalid or future cursors', async (t) => {
  const f = await fixture(t);
  const first = f.store.readEventPage(f.computerId, { limit: 1 });
  assert.equal(first.status, 'OK');
  assert.deepEqual(first.events.map((event) => event.sequence), [1]);
  assert.equal(first.nextSequence, 1);
  assert.equal(first.headSequence, 2);
  assert.equal(first.hasMore, true);
  const second = f.store.readEventPage(f.computerId, { afterSequence: first.nextSequence, limit: 1 });
  assert.equal(second.status, 'OK');
  assert.deepEqual(second.events.map((event) => event.sequence), [2]);
  assert.equal(second.nextSequence, 2);
  assert.equal(second.hasMore, false);
  assert.throws(() => f.store.readEventPage(f.computerId, { afterSequence: -1 }), /invalid_event_query/);
  assert.throws(() => f.store.readEventPage(f.computerId, { afterSequence: 3 }),
    (error) => error instanceof EnvironmentStoreError && error.code === 'event_cursor_ahead');
});

test('event pages require snapshot resync when retained aggregate history has a gap', async (t) => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.databasePath);
  try { db.prepare('DELETE FROM events WHERE aggregate_id = ? AND aggregate_seq = 1').run(f.computerId); }
  finally { db.close(); }
  const page = f.store.readEventPage(f.computerId, { afterSequence: 0 });
  assert.equal(page.status, 'RESYNC_REQUIRED');
  assert.deepEqual(page.events, []);
  assert.equal(page.firstAvailableSequence, 2);
  assert.equal(page.headSequence, 2);
});

test('SQLite snapshot restore verifies the backup, recovers pending work, and fences every restored Lease generation', async (t) => {
  const f = await fixture(t);
  const request = f.operation('start');
  f.store.beginOperation(request);
  const backupPath = path.join(f.root, 'operations-backup.sqlite');
  assert.deepEqual(await f.store.backupTo(backupPath), { status: 'BACKED_UP', schemaVersion: 6 });
  assert.equal(f.store.getOperation(request.operationId).status, 'REQUESTED', 'snapshot does not mutate the live store');
  if (process.platform !== 'win32') assert.equal((await stat(backupPath)).mode & 0o777, 0o600);

  const restoredPath = path.join(f.root, 'operations-restored.sqlite');
  const restored = await restoreSqliteEnvironmentStore(backupPath, restoredPath, {
    now: f.now, verifyWindowsAcl: async () => {},
  });
  assert.equal(restored.getOperation(request.operationId).status, 'UNKNOWN');
  assert.equal(restored.getOperation(request.operationId).errorCode, 'host_interrupted');
  assert.equal(restored.getComputer(f.computerId).generation, f.lease.generation + 1);
  assert.equal(restored.getComputer(f.computerId).observedState, 'unknown');
  assert.equal(restored.getLease(f.lease.leaseId).state, 'REVOKED');
  await assert.rejects(stat(`${restoredPath}.restore-incomplete`), (error) => error.code === 'ENOENT');
  assert.ok(restored.listEvents(f.computerId).some((event) => event.type === 'computer.snapshot_restored'));
  assert.throws(() => restored.beginOperation({ ...request, operationId: 'operation-start-after-restore', idempotencyKey: 'idem-start-after-restore' }),
    (error) => error.code === 'stale_generation');
  assert.equal(f.store.getLease(f.lease.leaseId).state, 'ACTIVE', 'restore does not mutate the source store');
  restored.close();
});

test('SQLite restore migrates a valid schema v3 snapshot without changing source bytes or dropping existing rows', async (t) => {
  const f = await fixture(t);
  const computer = f.store.getComputer(f.computerId);
  const lease = f.store.getLease(f.lease.leaseId);
  const operation = f.operation('create');
  f.store.beginOperation(operation);
  const priorEventCount = f.store.listEvents(f.computerId).length;
  const backupPath = path.join(f.root, 'schema-v3.backup.sqlite');
  const restoredPath = path.join(f.root, 'schema-v3.restored.sqlite');
  await f.store.backupTo(backupPath);
  const legacy = new DatabaseSync(backupPath);
  legacy.exec('DROP TABLE flow_operations; DROP TABLE operation_authorizations; PRAGMA user_version = 3');
  legacy.close();
  const sourceBytes = await readFile(backupPath);

  const restored = await restoreSqliteEnvironmentStore(backupPath, restoredPath, {
    now: () => '2026-10-28T00:00:00.000Z', verifyWindowsAcl: async () => {},
  });
  assert.equal(restored.diagnostics().schemaVersion, 6);
  const restoredComputer = restored.getComputer(f.computerId);
  assert.equal(restoredComputer.computerId, computer.computerId);
  assert.equal(restoredComputer.projectId, computer.projectId);
  assert.equal(restoredComputer.providerId, computer.providerId);
  assert.equal(restoredComputer.generation, computer.generation + 1, 'restore advances the stored Computer epoch');
  assert.equal(restored.getLease(f.lease.leaseId).leaseId, lease.leaseId);
  assert.equal(restored.getLease(f.lease.leaseId).generation, lease.generation, 'the historical Lease row is retained');
  assert.equal(restored.getLease(f.lease.leaseId).state, 'REVOKED', 'restore revokes the historical Lease');
  assert.equal(restored.getOperation(operation.operationId).status, 'UNKNOWN', 'pre-restore operation is retained and conservatively recovered');
  assert.ok(restored.listEvents(f.computerId).length > priorEventCount, 'existing events remain and restore fencing is appended');
  restored.close();
  assert.deepEqual(await readFile(backupPath), sourceBytes, 'restoring never rewrites the legacy snapshot');
});

test('SQLite backup and restore refuse overwrite, tampering, and path aliasing without deleting existing data', async (t) => {
  const f = await fixture(t);
  const backupPath = path.join(f.root, 'operations-backup.sqlite');
  await f.store.backupTo(backupPath);
  await assert.rejects(f.store.backupTo(backupPath), (error) => error.code === 'backup_destination_exists');
  await assert.rejects(restoreSqliteEnvironmentStore(backupPath, f.databasePath, {
    now: f.now, verifyWindowsAcl: async () => {},
  }), (error) => error.code === 'restore_destination_exists');

  const occupiedPath = path.join(f.root, 'occupied.sqlite');
  await writeFile(occupiedPath, 'preserve existing bytes', { flag: 'wx' });
  await assert.rejects(restoreSqliteEnvironmentStore(backupPath, occupiedPath, {
    now: f.now, verifyWindowsAcl: async () => {},
  }), (error) => error.code === 'restore_destination_exists');
  assert.equal(await readFile(occupiedPath, 'utf8'), 'preserve existing bytes');

  const tamperedPath = path.join(f.root, 'tampered.sqlite');
  await writeFile(tamperedPath, 'not a sqlite snapshot', { mode: 0o600, flag: 'wx' });
  await assert.rejects(restoreSqliteEnvironmentStore(tamperedPath, path.join(f.root, 'must-not-exist.sqlite'), {
    now: f.now, verifyWindowsAcl: async () => {},
  }), (error) => error.code === 'snapshot_invalid');
  await assert.rejects(stat(path.join(f.root, 'must-not-exist.sqlite')), (error) => error.code === 'ENOENT');
});

test('incomplete SQLite restore leaves a fail-closed marker that blocks ordinary store opens', async (t) => {
  const f = await fixture(t);
  const backupPath = path.join(f.root, 'operations-backup.sqlite');
  const restoredPath = path.join(f.root, 'incomplete-restore.sqlite');
  await f.store.backupTo(backupPath);
  await assert.rejects(restoreSqliteEnvironmentStore(backupPath, restoredPath, {
    now: () => 'invalid-clock', verifyWindowsAcl: async () => {},
  }), (error) => error.code === 'clock_invalid');

  const markerPath = `${restoredPath}.restore-incomplete`;
  assert.ok((await stat(restoredPath)).isFile(), 'preserve copied data for diagnosis');
  assert.match(await readFile(markerPath, 'utf8'), /^ALBERA_SQLITE_RECOVERY_OWNER_V1_INCOMPLETE:/);
  await assert.rejects(openSqliteEnvironmentStore(restoredPath, { verifyWindowsAcl: async () => {} }),
    (error) => error.code === 'restore_incomplete_marker_present');
});

test('restore releases its marker without overwriting a database created after its absence check', async (t) => {
  const f = await fixture(t);
  const backupPath = path.join(f.root, 'operations-backup.sqlite');
  const destinationPath = path.join(f.root, 'racing-restore.sqlite');
  const markerPath = `${destinationPath}.restore-incomplete`;
  await f.store.backupTo(backupPath);
  let injected = false;
  const verifyWindowsAcl = async (target) => {
    if (!injected && target === markerPath) {
      injected = true;
      await writeFile(destinationPath, 'created-by-concurrent-normal-open', { flag: 'wx', mode: 0o600 });
    }
  };

  await assert.rejects(restoreSqliteEnvironmentStore(backupPath, destinationPath, {
    now: f.now, verifyWindowsAcl,
  }), (error) => error.code === 'restore_destination_exists');
  assert.equal(await readFile(destinationPath, 'utf8'), 'created-by-concurrent-normal-open');
  await assert.rejects(stat(markerPath), (error) => error.code === 'ENOENT');
});

test('ordinary SQLite store open rechecks the restore marker after opening the database', async (t) => {
  const root = await mkdtemp(path.join(os.homedir(), '.albera-operation-store-restore-race-'));
  const databasePath = path.join(root, 'racing-open.sqlite');
  t.after(() => rm(root, { recursive: true, force: true }));
  function MarkerAppearingDatabase(filePath) {
    const db = new DatabaseSync(filePath);
    writeFileSync(`${filePath}.restore-incomplete`, 'ALBERA_SQLITE_RECOVERY_OWNER_V1_INCOMPLETE:test-race\n', { flag: 'wx', mode: 0o600 });
    return db;
  }

  await assert.rejects(openSqliteEnvironmentStore(databasePath, {
    verifyWindowsAcl: async () => {}, DatabaseImpl: MarkerAppearingDatabase,
  }), (error) => error.code === 'restore_incomplete_marker_present');
  assert.match(await readFile(`${databasePath}.restore-incomplete`, 'utf8'), /INCOMPLETE:test-race/);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0, 'the rejected opener did not migrate or expose the database'); }
  finally { db.close(); }
  await assert.rejects(openSqliteEnvironmentStore(databasePath, { verifyWindowsAcl: async () => {} }),
    (error) => error.code === 'restore_incomplete_marker_present');
});

test('failed restore invalidation rolls back all journal changes and leaves the destination quarantined', async (t) => {
  const f = await fixture(t);
  const request = f.operation('start');
  f.store.beginOperation(request);
  const backupPath = path.join(f.root, 'operations-backup.sqlite');
  const restoredPath = path.join(f.root, 'failed-restore.sqlite');
  await f.store.backupTo(backupPath);
  function FailingRestoreDatabase(filePath) {
    const db = new DatabaseSync(filePath);
    let shouldFail = true;
    return new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') return (sql) => {
          if (shouldFail && sql.includes('INSERT INTO events')) {
            shouldFail = false;
            throw new Error('injected_restore_event_failure');
          }
          return target.prepare(sql);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  await assert.rejects(restoreSqliteEnvironmentStore(backupPath, restoredPath, {
    now: f.now, verifyWindowsAcl: async () => {}, DatabaseImpl: FailingRestoreDatabase,
  }), (error) => error.code === 'store_transaction_failed');
  const db = new DatabaseSync(restoredPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT status FROM operations WHERE id = ?').get(request.operationId).status, 'REQUESTED');
    assert.equal(db.prepare('SELECT generation FROM computers WHERE id = ?').get(f.computerId).generation, f.lease.generation);
    assert.equal(db.prepare('SELECT state FROM leases WHERE id = ?').get(f.lease.leaseId).state, 'ACTIVE');
  } finally { db.close(); }
  assert.match(await readFile(`${restoredPath}.restore-incomplete`, 'utf8'), /INCOMPLETE:/);
  await assert.rejects(openSqliteEnvironmentStore(restoredPath, { verifyWindowsAcl: async () => {} }),
    (error) => error.code === 'restore_incomplete_marker_present');
});

test('abrupt restore-owner exit after database copy keeps the destination quarantined', async (t) => {
  const f = await fixture(t);
  const backupPath = path.join(f.root, 'operations-backup.sqlite');
  const restoredPath = path.join(f.root, 'crashed-restore.sqlite');
  await f.store.backupTo(backupPath);
  const moduleUrl = new URL('../src/runtime/sqlite-operation-store.mjs', import.meta.url).href;
  const source = `import { restoreSqliteEnvironmentStore } from ${JSON.stringify(moduleUrl)};\nawait restoreSqliteEnvironmentStore(process.argv[1], process.argv[2], { now: () => process.exit(77), verifyWindowsAcl: async () => {} });`;
  const childEnv = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']
    .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, backupPath, restoredPath], {
    cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))), shell: false, windowsHide: true,
    env: childEnv, stdio: 'ignore',
  });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: 77, signal: null });
  assert.ok((await stat(restoredPath)).isFile());
  assert.match(await readFile(`${restoredPath}.restore-incomplete`, 'utf8'), /^ALBERA_SQLITE_RECOVERY_OWNER_V1_INCOMPLETE:/);
  await assert.rejects(openSqliteEnvironmentStore(restoredPath, { verifyWindowsAcl: async () => {} }),
    (error) => error.code === 'restore_incomplete_marker_present');
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
    assert.equal(store.diagnostics().schemaVersion, 6);
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
  db.exec('DROP TABLE flow_operations; DROP TABLE operation_authorizations; DROP TABLE guest_event_receipts; PRAGMA user_version = 2');
  db.close();
  await f.reopen();
  assert.equal(f.store.diagnostics().schemaVersion, 6);
  assert.equal(f.store.getComputer(f.computerId).generation, computer.generation);
  assert.equal(f.store.getLease(f.lease.leaseId).runId, lease.runId);
  assert.deepEqual(f.store.recordGuestEvent({
    protocolVersion: 1, type: 'guest.event', messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    computerId: f.computerId, runId: lease.runId, generation: lease.generation, sequence: 1,
    occurredAt: '2026-10-28T00:00:00.000Z', eventType: 'heartbeat', agentVersion: '0.1.0',
  }).status, 'ACCEPTED');
});

test('schema v3 migration adds durable approval records without changing existing operation state', async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  f.store.beginOperation(request);
  f.store.recordProviderOutcome(request.operationId, { errorCode: 'fixture_failed', outcome: 'not_applied' });
  const before = f.store.getOperation(request.operationId);
  f.store.close();
  const db = new DatabaseSync(f.databasePath);
  db.exec('DROP TABLE flow_operations; DROP TABLE operation_authorizations; PRAGMA user_version = 3');
  db.close();
  await f.reopen();
  assert.equal(f.store.diagnostics().schemaVersion, 6);
  assert.deepEqual(f.store.getOperation(request.operationId), before);
  assert.deepEqual(f.store.listOperationAuthorizations(request.operationId), []);
});

test('untrusted Guest events have a separate record budget and exact retries remain free at the limit', async (t) => {
  const f = await fixture(t, { maxRecords: 32, maxGuestRecords: 4 });
  const baseEvent = {
    protocolVersion: 1, type: 'guest.event', computerId: f.computerId, runId: f.lease.runId,
    generation: f.lease.generation, occurredAt: f.now(), eventType: 'heartbeat', agentVersion: '1.0',
  };
  const first = { ...baseEvent, messageId: randomUUID(), sequence: 1 };
  const second = { ...baseEvent, messageId: randomUUID(), sequence: 2 };
  assert.equal(f.store.recordGuestEvent(first).status, 'ACCEPTED');
  assert.equal(f.store.recordGuestEvent(second).status, 'ACCEPTED');
  assert.equal(f.store.recordGuestEvent(first).status, 'DUPLICATE', 'dedupe does not consume additional budget');
  assert.throws(() => f.store.recordGuestEvent({ ...baseEvent, messageId: randomUUID(), sequence: 3 }),
    (error) => error.code === 'guest_event_capacity');
  const db = new DatabaseSync(f.databasePath);
  const guestRecordCount = db.prepare(`SELECT (SELECT COUNT(*) FROM guest_event_receipts)
    + (SELECT COUNT(*) FROM events WHERE provenance = 'untrusted_guest') AS count`).get().count;
  db.close();
  assert.equal(guestRecordCount, 4, 'capacity refusal inserts neither a receipt nor a journal event');
  assert.equal(f.store.listEvents(f.computerId).filter((record) => record.provenance === 'untrusted_guest').length, 2,
    'capacity refusal leaves the Guest event journal unchanged');
  const controlOperation = f.operation('inspect');
  assert.equal(f.store.beginOperation(controlOperation).operation.status, 'REQUESTED',
    'the Guest-only budget leaves shared store capacity for Host control operations');
});

test('Guest record budget cannot be configured above three quarters of shared store capacity', async () => {
  await assert.rejects(openSqliteEnvironmentStore(path.join(os.tmpdir(), `albera-invalid-guest-budget-${randomUUID()}.sqlite`), {
    maxRecords: 32, maxGuestRecords: 25, verifyWindowsAcl: async () => {},
  }), (error) => error instanceof TypeError && error.message === 'invalid_guest_store_capacity');
});

test('global Store record capacity fails closed without replacing earlier journal state', async (t) => {
  const f = await fixture(t, { maxRecords: 32, maxGuestRecords: 4 });
  const countRecords = () => {
    const db = new DatabaseSync(f.databasePath);
    try {
      return db.prepare(`SELECT (SELECT COUNT(*) FROM computers) + (SELECT COUNT(*) FROM operations)
        + (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM leases)
        + (SELECT COUNT(*) FROM guest_event_receipts) + (SELECT COUNT(*) FROM operation_authorizations) AS count`).get().count;
    } finally { db.close(); }
  };
  let index = 0;
  while (countRecords() + 2 <= 32) {
    f.store.registerComputer({ computerId: `capacity-computer-${index++}`, projectId: 'project-a', providerId: 'mock' });
  }
  const countAtLimit = countRecords();
  const lastComputer = f.store.getComputer(`capacity-computer-${index - 1}`);
  assert.throws(() => f.store.registerComputer({ computerId: 'capacity-computer-rejected', projectId: 'project-a', providerId: 'mock' }),
    (error) => error.code === 'store_capacity_exceeded');
  assert.equal(countRecords(), countAtLimit, 'capacity refusal does not delete or partially replace journal records');
  assert.equal(f.store.getComputer(lastComputer.computerId).computerId, lastComputer.computerId);
  assert.equal(f.store.getComputer('capacity-computer-rejected'), null);
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

test('Guest capability context resolves only the current active Computer, Run, Lease and generation', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.store.resolveActiveGuestSessionContext({ computerId: f.computerId, runId: f.lease.runId }), {
    computerId: f.computerId, leaseId: f.lease.leaseId, runId: f.lease.runId, generation: f.lease.generation,
    leaseExpiresAt: f.lease.expiresAt,
  });
  assert.throws(() => f.store.resolveActiveGuestSessionContext({ computerId: f.computerId, runId: 'other-run' }),
    (error) => error.code === 'guest_session_context_unavailable');
  f.store.revokeLease(f.lease.leaseId, { reason: 'restore' });
  assert.throws(() => f.store.resolveActiveGuestSessionContext({ computerId: f.computerId, runId: f.lease.runId }),
    (error) => error.code === 'guest_session_context_unavailable');
});

test('Guest capability context refuses expired Leases', async (t) => {
  const f = await fixture(t);
  f.advance(60 * 60 * 1000);
  assert.throws(() => f.store.resolveActiveGuestSessionContext({ computerId: f.computerId, runId: f.lease.runId }),
    (error) => error.code === 'guest_session_context_unavailable');
});

test('Guest capability authenticates SQLite-backed event intake and is revoked after restore', async (t) => {
  const f = await fixture(t);
  const capability = createGuestSessionCapabilityService({
    resolveActiveContext: f.store.resolveActiveGuestSessionContext.bind(f.store), now: f.now,
  });
  t.after(() => capability.close());
  const issued = await capability.issue({ computerId: f.computerId, runId: f.lease.runId });
  const operation = f.operation('start');
  f.store.beginOperation(operation);
  const intake = createGuestEventIntake({
    store: f.store, authenticateTransport: capability.authenticateTransport,
    resolveGuestContext: async ({ peer }) => peer,
  });
  const message = {
    protocolVersion: 1, type: 'guest.event', messageId: randomUUID(), computerId: f.computerId,
    runId: f.lease.runId, generation: f.lease.generation, sequence: 1,
    occurredAt: f.now(), eventType: 'operation.completed', operationId: operation.operationId,
    claimedOutcome: 'succeeded',
  };
  assert.equal((await intake.receive({
    transport: { guestSessionCredential: issued.credential }, message,
  })).status, 'ACCEPTED');
  assert.equal(f.store.getOperation(operation.operationId).status, 'REQUESTED',
    'Guest capability cannot complete a Host-owned operation');
  assert.equal(f.store.listEvents(f.computerId).find((record) => record.type === 'guest.operation.completed')?.provenance,
    'untrusted_guest');
  f.store.revokeLease(f.lease.leaseId, { reason: 'restore' });
  await assert.rejects(intake.receive({
    transport: { guestSessionCredential: issued.credential },
    message: { ...message, messageId: randomUUID(), sequence: 2 },
  }), (error) => error.code === 'guest_authentication_failed');
});

test('GuestEventIntake binds an authenticated transport to Host identity and records claims without changing operations', async (t) => {
  const f = await fixture(t);
  const operation = f.operation('start');
  f.store.beginOperation(operation);
  let resolverCalls = 0;
  const intake = createGuestEventIntake({
    store: f.store,
    authenticateTransport: async ({ transport }) => transport?.peer === 'host-authenticated' ? 'peer-a' : false,
    resolveGuestContext: async ({ peer }) => {
      resolverCalls += 1;
      assert.equal(peer, 'peer-a');
      return { computerId: f.computerId, runId: f.lease.runId, generation: f.lease.generation };
    },
  });
  const message = {
    protocolVersion: 1, type: 'guest.event', messageId: randomUUID(), computerId: f.computerId,
    runId: f.lease.runId, generation: f.lease.generation, sequence: 1,
    occurredAt: f.now(), eventType: 'operation.completed', operationId: operation.operationId,
    claimedOutcome: 'succeeded',
  };

  assert.deepEqual(await intake.receive({ transport: { peer: 'host-authenticated' }, message }), {
    status: 'ACCEPTED', messageId: message.messageId, sequence: 1,
  });
  assert.equal(f.store.getOperation(operation.operationId).status, 'REQUESTED', 'Guest outcome is a claim and does not complete a Host operation');
  const guestRecords = f.store.listEvents(f.computerId).filter((record) => record.provenance === 'untrusted_guest');
  assert.equal(guestRecords.length, 1);
  assert.equal(guestRecords[0].type, 'guest.operation.completed');
  assert.equal(guestRecords[0].provenance, 'untrusted_guest');
  assert.deepEqual(await intake.receive({ transport: { peer: 'host-authenticated' }, message }), {
    status: 'DUPLICATE', messageId: message.messageId, sequence: 1,
  });
  assert.equal(f.store.listEvents(f.computerId).filter((record) => record.provenance === 'untrusted_guest').length, 1);

  const resolverCallsBeforeDeniedPeer = resolverCalls;
  await assert.rejects(intake.receive({ transport: { peer: 'untrusted' }, message }),
    (error) => error.code === 'guest_authentication_failed');
  assert.equal(resolverCalls, resolverCallsBeforeDeniedPeer, 'failed transport authentication never resolves Guest identity');

  await assert.rejects(intake.receive({
    transport: { peer: 'host-authenticated' },
    message: { ...message, messageId: randomUUID(), computerId: 'attacker-computer', sequence: 2 },
  }), (error) => error.code === 'guest_identity_mismatch');
  assert.equal(f.store.listEvents(f.computerId).filter((record) => record.provenance === 'untrusted_guest').length, 1);
});

test('Guest intake normalizes hostile Store error reflection without leaking exception text', async () => {
  const secret = 'credential-like store exception text';
  const hostile = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error(secret); },
  });
  const intake = createGuestEventIntake({
    store: { recordGuestEvent() { throw hostile; } },
    authenticateTransport: async () => 'peer-a',
    resolveGuestContext: async () => ({ computerId: 'computer-a', runId: 'run-a', generation: 1 }),
  });
  const message = {
    protocolVersion: 1, type: 'guest.event', messageId: randomUUID(), computerId: 'computer-a', runId: 'run-a',
    generation: 1, sequence: 1, occurredAt: '2026-10-28T00:00:00.000Z', eventType: 'heartbeat', agentVersion: '0.1.0',
  };
  await assert.rejects(intake.receive({ transport: {}, message }), (error) => {
    assert.equal(error.code, 'guest_event_store_unavailable');
    assert.equal(error.message, 'guest_event_store_unavailable');
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('GuestEventIntake rejects a pre-restore peer generation at the durable Store fence', async (t) => {
  const f = await fixture(t);
  const oldGeneration = f.lease.generation;
  f.store.revokeLease(f.lease.leaseId, { reason: 'restore' });
  const intake = createGuestEventIntake({
    store: f.store,
    authenticateTransport: async () => 'authenticated-old-peer',
    resolveGuestContext: async () => ({
      computerId: f.computerId, runId: f.lease.runId, generation: oldGeneration,
    }),
  });
  const message = {
    protocolVersion: 1, type: 'guest.event', messageId: randomUUID(), computerId: f.computerId,
    runId: f.lease.runId, generation: oldGeneration, sequence: 1,
    occurredAt: f.now(), eventType: 'heartbeat', agentVersion: '0.1.0',
  };

  await assert.rejects(intake.receive({ transport: {}, message }),
    (error) => error.code === 'guest_generation_stale');
  assert.equal(f.store.getComputer(f.computerId).generation, oldGeneration + 1);
  assert.equal(f.store.listEvents(f.computerId).some((record) => record.provenance === 'untrusted_guest'), false);
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

test('separate processes atomically claim one Broker dispatch from the durable journal', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  const begun = f.store.beginOperation(request);
  await recordExecutionApproval(f, request, begun);
  const workerPath = fileURLToPath(new URL('../scripts/runtime-scheduler-contender.mjs', import.meta.url));
  f.store.close();
  const workers = Array.from({ length: 8 }, (_, index) => spawnSynchronizedStoreWorker(
    workerPath, f.databasePath, index + 1, 'broker-dispatch', request.operationId,
    String(request.expectedGeneration), begun.operation.actionDigest,
  ));
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

  assert.equal(outcomes.filter((outcome) => outcome.status === 'CLAIMED').length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter((outcome) => outcome.errorCode === 'operation_not_dispatchable').length, 7, JSON.stringify(outcomes));
  await f.reopen();
  assert.equal(f.store.getOperation(request.operationId).status, 'UNKNOWN');
  assert.equal(f.store.listOperationAuthorizations(request.operationId)[0].state, 'CONSUMED', 'the one-time claim is consumed by the winning transaction');
  assert.equal(f.store.listEvents(f.computerId).filter((event) => event.type === 'operation.dispatch_authorized').length, 1);
  assert.equal(f.store.listEvents(f.computerId).filter((event) => event.type === 'operation.authorization_consumed').length, 1);
});

test('separate processes with one idempotency key and payload persist exactly one operation', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const workerPath = fileURLToPath(new URL('../scripts/runtime-scheduler-contender.mjs', import.meta.url));
  f.store.close();
  const workers = Array.from({ length: 8 }, (_, index) => spawnSynchronizedStoreWorker(
    workerPath, f.databasePath, index + 1, 'idempotency-same',
  ));
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

  assert.equal(outcomes.filter((outcome) => outcome.status === 'CREATED').length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter((outcome) => outcome.status === 'REPLAYED').length, 7, JSON.stringify(outcomes));
  assert.ok(outcomes.every((outcome) => outcome.operationId === 'race-operation-shared-idempotency'), JSON.stringify(outcomes));
  await f.reopen();
  assert.equal(f.store.getOperation('race-operation-shared-idempotency').status, 'UNKNOWN');
  assert.equal(f.store.listEvents('race-operation-shared-idempotency').filter((event) => event.type === 'operation.requested').length, 1);
});

test('separate processes cannot reuse one idempotency key for different payloads', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const workerPath = fileURLToPath(new URL('../scripts/runtime-scheduler-contender.mjs', import.meta.url));
  f.store.close();
  const workers = Array.from({ length: 8 }, (_, index) => spawnSynchronizedStoreWorker(
    workerPath, f.databasePath, index + 1, 'idempotency-conflict',
  ));
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

  assert.equal(outcomes.filter((outcome) => outcome.status === 'CREATED').length, 1, JSON.stringify(outcomes));
  assert.ok(outcomes.filter((outcome) => outcome.errorCode === 'idempotency_conflict').length >= 1, JSON.stringify(outcomes));
  assert.ok(outcomes.every((outcome) => outcome.status === 'CREATED' || outcome.status === 'REPLAYED'
    || outcome.errorCode === 'idempotency_conflict'), JSON.stringify(outcomes));
  await f.reopen();
  assert.ok(['start', 'stop'].includes(f.store.getOperation('race-operation-shared-idempotency').action));
  assert.equal(f.store.listEvents('race-operation-shared-idempotency').filter((event) => event.type === 'operation.requested').length, 1);
});

test('separate processes admit only one unresolved mutation for the same Computer generation', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const workerPath = fileURLToPath(new URL('../scripts/runtime-scheduler-contender.mjs', import.meta.url));
  f.store.close();
  const workers = Array.from({ length: 8 }, (_, index) => spawnSynchronizedStoreWorker(
    workerPath, f.databasePath, index + 1, 'begin-operation',
  ));
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

  assert.equal(outcomes.filter((outcome) => outcome.status === 'CREATED').length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter((outcome) => outcome.errorCode === 'computer_operation_unresolved').length, 7, JSON.stringify(outcomes));
  await f.reopen();
  const admitted = outcomes.find((outcome) => outcome.status === 'CREATED');
  assert.equal(f.store.getOperation(admitted.operationId).status, 'UNKNOWN', 'startup recovery marks the admitted but undispatched intent uncertain');
});

test('Lease release and a new mutation cannot both win a cross-process race', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const workerPath = fileURLToPath(new URL('../scripts/runtime-scheduler-contender.mjs', import.meta.url));
  f.store.close();
  const mutation = spawnSynchronizedStoreWorker(workerPath, f.databasePath, 1, 'begin-operation');
  const release = spawnSynchronizedStoreWorker(workerPath, f.databasePath, 2, 'release-lease');
  const workers = [mutation, release];
  t.after(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    }
    await Promise.all(workers.map((worker) => worker.exited));
  });

  const outcomesPromise = Promise.all(workers.map((worker) => worker.result));
  outcomesPromise.catch(() => {});
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.child.stdin.end('go\n');
  const [mutationResult, releaseResult] = await outcomesPromise;
  await Promise.all(workers.map((worker) => worker.exited));

  await f.reopen();
  const lease = f.store.getLease(f.lease.leaseId);
  if (mutationResult.status === 'CREATED') {
    assert.equal(releaseResult.errorCode, 'computer_operation_unresolved');
    assert.equal(lease.state, 'ACTIVE');
    assert.equal(f.store.getOperation(mutationResult.operationId).status, 'UNKNOWN');
  } else {
    assert.equal(mutationResult.errorCode, 'lease_not_authorized');
    assert.equal(releaseResult.status, 'RELEASED');
    assert.equal(lease.state, 'RELEASED');
  }
});

test('abrupt host exit after durable intent recovers to UNKNOWN without replay', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const workerPath = fileURLToPath(new URL('../scripts/runtime-scheduler-contender.mjs', import.meta.url));
  f.store.close();
  const worker = spawnSynchronizedStoreWorker(workerPath, f.databasePath, 1, 'crash-after-begin');
  t.after(async () => {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    await worker.exited;
  });
  const result = worker.result;
  await worker.ready;
  worker.child.stdin.end('go\n');
  const operation = await result;
  await worker.exited;

  assert.equal(worker.child.exitCode, 23, JSON.stringify(operation));
  assert.equal(operation.status, 'REQUESTED');
  await f.reopen();
  const recovered = f.store.getOperation(operation.operationId);
  assert.equal(recovered.status, 'UNKNOWN');
  assert.equal(recovered.errorCode, 'host_interrupted');
  const retry = f.store.beginOperation({
    operationId: operation.operationId, idempotencyKey: 'race-idempotency-1',
    subjectId: 'human-a', projectId: 'project-a', taskId: 'task-a', runId: 'run-a',
    computerId: f.computerId, providerId: 'mock', leaseId: f.lease.leaseId,
    expectedGeneration: f.lease.generation, policyVersion: 1, action: 'start',
  });
  assert.equal(retry.created, false);
  assert.equal(retry.operation.status, 'UNKNOWN');
});

test('abrupt host exit after dispatch claim preserves UNKNOWN and denies redispatch', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  const begun = f.store.beginOperation(request);
  await recordExecutionApproval(f, request, begun);
  const workerPath = fileURLToPath(new URL('../scripts/runtime-scheduler-contender.mjs', import.meta.url));
  f.store.close();
  const worker = spawnSynchronizedStoreWorker(workerPath, f.databasePath, 1, 'crash-after-dispatch',
    request.operationId, String(request.expectedGeneration), begun.operation.actionDigest);
  t.after(async () => {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    await worker.exited;
  });
  const result = worker.result;
  await worker.ready;
  worker.child.stdin.end('go\n');
  const claim = await result;
  await worker.exited;

  assert.equal(worker.child.exitCode, 24, JSON.stringify(claim));
  assert.equal(claim.status, 'CLAIMED');
  await f.reopen();
  assert.equal(f.store.getOperation(request.operationId).status, 'UNKNOWN');
  assert.throws(() => f.store.resolveBrokerDispatch({
    protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
    operationId: request.operationId, expectedGeneration: request.expectedGeneration,
    actionDigest: `sha256:${begun.operation.actionDigest}`,
  }), (error) => error.code === 'operation_not_dispatchable');
});

test('abrupt process exit before dispatch transaction commit rolls back the claim and recovers without Provider I/O', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  const begun = f.store.beginOperation(request);
  await recordExecutionApproval(f, request, begun);
  const workerPath = fileURLToPath(new URL('../scripts/runtime-scheduler-contender.mjs', import.meta.url));
  f.store.close();
  const worker = spawnSynchronizedStoreWorker(workerPath, f.databasePath, 1, 'crash-before-dispatch-commit',
    request.operationId, String(request.expectedGeneration), begun.operation.actionDigest);
  t.after(async () => {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    await worker.exited;
  });
  const result = worker.result;
  await worker.ready;
  worker.child.stdin.end('go\n');
  const claim = await result;
  await worker.exited;

  assert.equal(worker.child.exitCode, 26, JSON.stringify(claim));
  assert.equal(claim.status, 'EXIT_BEFORE_COMMIT');
  await f.reopen();
  assert.equal(f.store.getOperation(request.operationId).status, 'UNKNOWN');
  assert.equal(f.store.getOperation(request.operationId).errorCode, 'host_interrupted');
  assert.equal(f.store.listOperationAuthorizations(request.operationId)[0].state, 'RECORDED',
    'uncommitted consumption is rolled back; startup recovery still prevents execution');
  assert.equal(f.store.listEvents(f.computerId).filter((event) => event.type === 'operation.authorization_consumed').length, 0);
  assert.equal(f.store.listEvents(f.computerId).filter((event) => event.type === 'operation.dispatch_authorized').length, 0);
  assert.throws(() => f.store.resolveBrokerDispatch({
    protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
    operationId: request.operationId, expectedGeneration: request.expectedGeneration,
    actionDigest: `sha256:${begun.operation.actionDigest}`,
  }), (error) => error.code === 'operation_not_dispatchable');
});

test('process crash after a durable Provider side effect reconciles by inspect without duplicate create', { timeout: 60_000 }, async (t) => {
  const providerStatePath = path.join(os.tmpdir(), `albera-provider-observation-${randomUUID()}.json`);
  let createCalls = 0;
  let inspectCalls = 0;
  const f = await fixture(t, {
    providerFactory: ({ now }) => {
      const observe = (operation, state) => ({
        computerId: operation.computerId, providerId: 'mock', state,
        generation: operation.expectedGeneration, observedAt: now(),
      });
      return {
        providerId: 'mock',
        async create(operation) { createCalls++; return observe(operation, 'off'); },
        async inspect(operation) {
          inspectCalls++;
          let providerState;
          try { providerState = JSON.parse(await readFile(providerStatePath, 'utf8')); }
          catch { return observe(operation, 'missing'); }
          return observe(operation, providerState.state);
        },
        async start(operation) { return observe(operation, 'running'); },
        async stop(operation) { return observe(operation, 'off'); },
        async destroy(operation) { return observe(operation, 'missing'); },
      };
    },
  });
  t.after(() => rm(providerStatePath, { force: true }));
  const request = f.operation('create');
  const begun = f.store.beginOperation(request);
  await recordExecutionApproval(f, request, begun);

  const workerPath = fileURLToPath(new URL('../scripts/runtime-scheduler-contender.mjs', import.meta.url));
  f.store.close();
  const worker = spawnSynchronizedStoreWorker(workerPath, f.databasePath, 1, 'crash-after-provider-effect',
    request.operationId, String(request.expectedGeneration), begun.operation.actionDigest, providerStatePath);
  t.after(async () => {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    await worker.exited;
  });
  const resultLine = worker.result;
  await worker.ready;
  worker.child.stdin.end('go\n');
  const providerEffect = await resultLine;
  await worker.exited;

  assert.equal(worker.child.exitCode, 25, JSON.stringify(providerEffect));
  assert.equal(providerEffect.status, 'SIDE_EFFECT');
  assert.deepEqual(JSON.parse(await readFile(providerStatePath, 'utf8')), { state: 'off', generation: request.expectedGeneration });

  await f.reopen();
  assert.equal(f.store.getOperation(request.operationId).status, 'UNKNOWN');
  const reconciled = await f.coordinator.reconcile(request.operationId);
  assert.equal(reconciled.status, 'SUCCEEDED');
  assert.equal(reconciled.observedState, 'off');
  assert.equal(inspectCalls, 1);
  assert.equal(createCalls, 0, 'recovery must inspect the persisted provider effect, not repeat create');
  assert.equal((await f.coordinator.execute(request)).status, 'SUCCEEDED');
  assert.equal(createCalls, 0, 'idempotent replay after reconciliation does not dispatch create');
});

test('startup recovery marks only an interrupted pre-dispatch request UNKNOWN', async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  f.store.beginOperation(request);
  const passiveStore = await openSqliteEnvironmentStore(f.databasePath, {
    now: f.now, verifyWindowsAcl: async () => {},
  });
  assert.equal(passiveStore.getOperation(request.operationId).status, 'REQUESTED', 'default observer handle does not run startup recovery');
  passiveStore.close();
  await f.reopen();
  assert.equal(f.store.getOperation(request.operationId).status, 'UNKNOWN');
  assert.equal(f.store.getOperation(request.operationId).errorCode, 'host_interrupted');
});

test('SQLite Operation ID cannot be reused with a different idempotency key or payload', async (t) => {
  const f = await fixture(t);
  const original = f.operation('create');
  const created = f.store.beginOperation(original);
  assert.equal(created.created, true);

  assert.throws(() => f.store.beginOperation(f.operation('start', {
    operationId: original.operationId,
    idempotencyKey: 'different-idempotency-key',
  })), (error) => error instanceof EnvironmentStoreError && error.code === 'operation_id_conflict');

  assert.equal(f.store.getOperation(original.operationId).action, 'create');
  assert.equal(f.store.listEvents(original.operationId).filter((event) => event.type === 'operation.requested').length, 1,
    'the rejected duplicate creates no second durable intent');
});

test('startup recovery holds one exclusive owner marker and preserves stale markers for manual review', async (t) => {
  const f = await fixture(t);
  const lockPath = `${f.databasePath}.recovery-owner`;
  const originalMarker = await readFile(lockPath);
  await assert.rejects(openSqliteEnvironmentStore(f.databasePath, {
    verifyWindowsAcl: async () => {}, recoverInterruptedRequests: true,
  }), (error) => error.code === 'recovery_owner_locked');
  assert.deepEqual(await readFile(lockPath), originalMarker, 'a competing owner does not alter the live owner marker');

  const shared = await openSqliteEnvironmentStore(f.databasePath, { verifyWindowsAcl: async () => {} });
  shared.close();
  f.store.close();
  assert.equal(await readFile(lockPath).then(() => true, () => false), false, 'clean close releases the exact owned marker');

  const staleMarker = 'operator-reviewed-recovery-owner-marker';
  await writeFile(lockPath, staleMarker, { mode: 0o600 });
  await assert.rejects(openSqliteEnvironmentStore(f.databasePath, {
    verifyWindowsAcl: async () => {}, recoverInterruptedRequests: true,
  }), (error) => error.code === 'recovery_owner_locked');
  assert.equal(await readFile(lockPath, 'utf8'), staleMarker, 'startup never guesses whether an existing marker is stale');
});

test('durable intent is recorded before provider action and idempotent replay never repeats the side effect', async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  const first = await f.coordinator.execute(request);
  assert.equal(first.status, 'SUCCEEDED');
  assert.equal(first.desiredState, 'off');
  assert.equal(first.observedState, 'off');
  const approvals = f.store.listOperationAuthorizations(request.operationId);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].purpose, 'execute');
  assert.equal(approvals[0].state, 'CONSUMED');
  assert.equal(approvals[0].actionDigest, `sha256:${f.store.getOperation(request.operationId).actionDigest}`);
  assert.ok(f.store.listEvents(f.computerId).some((event) => event.type === 'operation.authorization_recorded'));
  assert.ok(f.store.listEvents(f.computerId).some((event) => event.type === 'operation.authorization_consumed'));
  assert.doesNotMatch(JSON.stringify(approvals), /token|secret|credential/i);
  assert.equal(f.store.listEvents(f.computerId).find((event) => event.type === 'operation.succeeded').provenance, 'provider');
  const duplicate = await f.coordinator.execute({ ...request, operationId: 'operation-create-retry' });
  assert.equal(duplicate.operationId, request.operationId);
  assert.equal(f.store.listEvents(request.operationId).length, 1);
  await assert.rejects(f.coordinator.execute({ ...request, operationId: 'operation-create-conflict', spec: { ...spec, resources: { ...spec.resources, vcpu: 3 } } }),
    (error) => error instanceof EnvironmentStoreError && error.code === 'idempotency_conflict');
});

test('durable coordinator requires a trusted authorization callback', async (t) => {
  const f = await fixture(t);
  assert.throws(() => new DurableEnvironmentOperationCoordinator({ store: f.store, broker: f.broker }),
    (error) => error instanceof TypeError && error.message === 'authorization_required');
  const coordinator = new DurableEnvironmentOperationCoordinator({
    store: f.store, broker: f.broker, authorizeOperation: () => ({}), nowMs: () => Number.NaN,
  });
  await assert.rejects(coordinator.execute(f.operation('create')),
    (error) => error.code === 'authorization_clock_invalid');
  assert.equal(f.store.getOperation('operation-create-a'), null);
});

test('authorization denial fails before journaling and raw denial details are not returned', async (t) => {
  const f = await fixture(t, { authorizeOperation: async () => { throw new Error('token=secret-denial-detail'); } });
  const request = f.operation('create');
  await assert.rejects(f.coordinator.execute(request), (error) => {
    assert.equal(error.code, 'authorization_denied');
    assert.doesNotMatch(error.message, /secret-denial-detail/);
    return true;
  });
  assert.equal(f.store.getOperation(request.operationId), null);
  assert.equal(f.store.listEvents(request.operationId).length, 0);
});

test('authorization grant must bind the exact subject, project, policy, digest and purpose', async (t) => {
  const mutations = [
    ['decision', (grant) => ({ ...grant, decision: 'denied' })],
    ['operation', (grant) => ({ ...grant, operationId: 'operation-other' })],
    ['idempotency key', (grant) => ({ ...grant, idempotencyKey: 'idempotency-other' })],
    ['subject', (grant) => ({ ...grant, subjectId: 'human-other' })],
    ['project', (grant) => ({ ...grant, projectId: 'project-other' })],
    ['policy', (grant) => ({ ...grant, policyVersion: grant.policyVersion + 1 })],
    ['digest', (grant) => ({ ...grant, actionDigest: `sha256:${'0'.repeat(64)}` })],
    ['purpose', (grant) => ({ ...grant, purpose: 'reconcile' })],
    ['extra data', (grant) => ({ ...grant, accessToken: 'must-not-be-accepted' })],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async (subtest) => {
      const f = await fixture(subtest, { authorizeOperation: ({ operation, actionDigest, purpose }) => mutate({
        decision: 'approved', approvalId: randomUUID(), approverId: 'human-approver',
        operationId: operation.operationId, idempotencyKey: operation.idempotencyKey,
        subjectId: operation.subjectId, projectId: operation.projectId, policyVersion: operation.policyVersion,
        actionDigest, purpose, expiresAt: new Date(Date.parse('2026-10-28T00:01:00.000Z')).toISOString(),
      }) });
      const request = f.operation('create');
      await assert.rejects(f.coordinator.execute(request), (error) => error.code === 'authorization_invalid');
      assert.equal(f.store.getOperation(request.operationId), null);
    });
  }
});

test('expired and overlong authorization grants fail closed before journaling', async (t) => {
  for (const [label, offset] of [['expired', -1], ['overlong', 5 * 60 * 1000 + 1]]) {
    await t.test(label, async (subtest) => {
      const f = await fixture(subtest, { authorizeOperation: ({ operation, actionDigest, purpose }) => ({
        decision: 'approved', approvalId: randomUUID(), approverId: 'human-approver',
        operationId: operation.operationId, idempotencyKey: operation.idempotencyKey,
        subjectId: operation.subjectId, projectId: operation.projectId, policyVersion: operation.policyVersion,
        actionDigest, purpose, expiresAt: new Date(Date.parse('2026-10-28T00:00:00.000Z') + offset).toISOString(),
      }) });
      const request = f.operation('create');
      await assert.rejects(f.coordinator.execute(request), (error) => error.code === 'authorization_expired'
        || error.code === 'authorization_invalid');
      assert.equal(f.store.getOperation(request.operationId), null);
    });
  }
});

test('authorization expiring after the durable dispatch claim prevents provider I/O', async (t) => {
  const calls = { create: 0 };
  const f = await fixture(t, {
    prepareProvider(provider) {
      const create = provider.create.bind(provider);
      provider.create = async (...args) => { calls.create++; return create(...args); };
    },
    prepareStore(store, { advance }) {
      const resolve = store.resolveBrokerDispatch.bind(store);
      store.resolveBrokerDispatch = (...args) => {
        const operation = resolve(...args);
        advance(2 * 60 * 1000);
        return operation;
      };
    },
  });
  const request = f.operation('create');
  const result = await f.coordinator.execute(request);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorCode, 'authorization_expired');
  assert.equal(calls.create, 0);
  assert.equal(f.store.getOperation(request.operationId).status, 'FAILED');
});

test('durable authorization ledger rejects mismatches, expired claims and reused approval IDs', async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  const begun = f.store.beginOperation(request);
  const authorization = await f.authorizeOperation({
    operation: request, actionDigest: `sha256:${begun.operation.actionDigest}`, purpose: 'execute',
  });

  assert.throws(() => f.store.recordOperationAuthorization(request.operationId,
    { ...authorization, purpose: 'reconcile' }, { purpose: 'execute' }),
  (error) => error instanceof EnvironmentStoreError && error.code === 'authorization_record_mismatch');
  assert.throws(() => f.store.recordOperationAuthorization(request.operationId,
    { ...authorization, actionDigest: `sha256:${'0'.repeat(64)}` }, { purpose: 'execute' }),
  (error) => error instanceof EnvironmentStoreError && error.code === 'authorization_record_mismatch');

  const recorded = f.store.recordOperationAuthorization(request.operationId, authorization, { purpose: 'execute' });
  assert.equal(recorded.state, 'RECORDED');
  assert.throws(() => f.store.recordOperationAuthorization(request.operationId, authorization, { purpose: 'execute' }),
    (error) => error instanceof EnvironmentStoreError && error.code === 'authorization_reused');
  assert.equal(f.store.listOperationAuthorizations(request.operationId).length, 1);

  const expiredFixture = await fixture(t);
  const expiredOperation = expiredFixture.operation('create');
  const expiredBegin = expiredFixture.store.beginOperation(expiredOperation);
  const shortGrant = await expiredFixture.authorizeOperation({
    operation: expiredOperation, actionDigest: `sha256:${expiredBegin.operation.actionDigest}`, purpose: 'execute',
  });
  expiredFixture.advance(60_001);
  assert.throws(() => expiredFixture.store.recordOperationAuthorization(expiredOperation.operationId, shortGrant, { purpose: 'execute' }),
    (error) => error instanceof EnvironmentStoreError && error.code === 'authorization_expired');
  assert.equal(expiredFixture.store.listOperationAuthorizations(expiredOperation.operationId).length, 0);
});

test('Broker dispatch refuses an expired approval while the Lease remains active', async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  const begun = f.store.beginOperation(request);
  await recordExecutionApproval(f, request, begun);
  f.advance(6 * 60 * 1000);
  assert.throws(() => f.store.resolveBrokerDispatch({
    protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
    operationId: request.operationId, expectedGeneration: request.expectedGeneration,
    actionDigest: `sha256:${begun.operation.actionDigest}`,
  }), (error) => error instanceof EnvironmentStoreError && error.code === 'authorization_expired');
  assert.equal(f.store.getOperation(request.operationId).status, 'REQUESTED');
  assert.equal(f.store.listOperationAuthorizations(request.operationId)[0].state, 'RECORDED');
});

test('UNKNOWN reconciliation requires a separate inspect-bound authorization', async (t) => {
  let inspections = 0;
  const f = await fixture(t, { authorizeOperation: ({ operation, actionDigest, purpose }) => {
    if (purpose === 'reconcile') throw new Error('approval_missing');
    return {
      decision: 'approved', approvalId: randomUUID(), approverId: 'human-approver',
      operationId: operation.operationId, idempotencyKey: operation.idempotencyKey,
      subjectId: operation.subjectId, projectId: operation.projectId, policyVersion: operation.policyVersion,
      actionDigest, purpose, expiresAt: new Date(Date.parse('2026-10-28T00:01:00.000Z')).toISOString(),
    };
  }, prepareProvider(provider) {
    const inspect = provider.inspect.bind(provider);
    provider.inspect = async (...args) => { inspections++; return inspect(...args); };
  } });
  f.provider.failNext('create', { timing: 'after', code: 'provider_reply_lost' });
  const request = f.operation('create');
  assert.equal((await f.coordinator.execute(request)).status, 'UNKNOWN');
  await assert.rejects(f.coordinator.reconcile(request.operationId), (error) => error.code === 'authorization_denied');
  assert.equal(inspections, 0);
  assert.equal(f.store.getOperation(request.operationId).status, 'UNKNOWN');
});

test('Broker journal resolution binds the typed reference and atomically claims one dispatch under a live Lease', async (t) => {
  const f = await fixture(t);
  const input = f.operation('create');
  const begun = f.store.beginOperation(input);
  assert.throws(() => f.store.beginOperation(f.operation('start')),
    (error) => error instanceof EnvironmentStoreError && error.code === 'computer_operation_unresolved');
  const brokerRef = {
    protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
    operationId: input.operationId, expectedGeneration: input.expectedGeneration,
    actionDigest: `sha256:${begun.operation.actionDigest}`,
  };
  assert.throws(() => f.store.resolveBrokerDispatch(brokerRef),
    (error) => error instanceof EnvironmentStoreError && error.code === 'broker_authorization_missing');
  assert.equal(f.store.getOperation(input.operationId).status, 'REQUESTED', 'missing approval cannot claim the dispatch');
  await recordExecutionApproval(f, input, begun);
  assert.deepEqual(f.store.resolveBrokerDispatch(brokerRef), input);
  assert.equal(f.store.getOperation(input.operationId).status, 'UNKNOWN', 'dispatch intent is durable before provider I/O');
  assert.throws(() => f.store.resolveBrokerDispatch({ ...brokerRef, requestId: randomUUID() }),
    (error) => error instanceof EnvironmentStoreError && error.code === 'operation_not_dispatchable');
  assert.throws(() => f.store.resolveBrokerDispatch({ ...brokerRef, actionDigest: `sha256:${'f'.repeat(64)}` }),
    (error) => error instanceof EnvironmentStoreError && error.code === 'broker_authorization_mismatch');
});

test('local Host Broker accepts only its one-time journal-derived claim capability', async (t) => {
  let creates = 0;
  let replacements = 0;
  const f = await fixture(t, { prepareProvider(provider) {
    const create = provider.create.bind(provider);
    provider.create = (...args) => { creates++; return create(...args); };
  } });
  f.provider.create = () => { replacements++; throw new Error('replacement_provider_method_called'); };
  f.store.resolveBrokerDispatch = () => { throw new Error('replacement_store_resolver_called'); };
  const operation = f.operation('create');
  const begun = f.store.beginOperation(operation);
  await recordExecutionApproval(f, operation, begun);
  const claim = f.broker.claimOperation({
    protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
    operationId: operation.operationId, expectedGeneration: operation.expectedGeneration,
    actionDigest: `sha256:${begun.operation.actionDigest}`,
  });
  assert.deepEqual(Object.keys(claim), [], 'the Control Plane receives no Provider operation payload');
  const observed = await f.broker.executeClaim(claim);
  assert.equal(observed.state, 'off');
  assert.equal(creates, 1);
  assert.equal(replacements, 0, 'Provider method replacement after Broker construction cannot redirect dispatch');
  assert.equal(f.store.getOperation(operation.operationId).status, 'UNKNOWN', 'Broker uses the captured durable Store resolver');
  assert.throws(() => f.broker.executeClaim(claim), (error) => error.code === 'broker_claim_invalid');
  assert.equal(creates, 1, 'a consumed in-process dispatch capability cannot be replayed');
});

test('Host Broker resolves reconciliation inspection only from a consumed inspect authorization', async (t) => {
  let inspections = 0;
  const f = await fixture(t, { prepareProvider(provider) {
    const inspect = provider.inspect.bind(provider);
    provider.inspect = (...args) => { inspections++; return inspect(...args); };
  } });
  f.provider.failNext('create', { timing: 'after', code: 'create_reply_lost' });
  const operation = f.operation('create');
  assert.equal((await f.coordinator.execute(operation)).status, 'UNKNOWN');
  assert.throws(() => f.broker.inspectOperation({ operationId: operation.operationId, approvalId: randomUUID() }),
    (error) => error instanceof EnvironmentStoreError && error.code === 'broker_inspection_unauthorized');
  assert.equal(inspections, 0, 'forged approval reference does not reach the Provider');
  const reconciled = await f.coordinator.reconcile(operation.operationId);
  assert.equal(reconciled.status, 'SUCCEEDED');
  assert.equal(inspections, 1);
  const grants = f.store.listOperationAuthorizations(operation.operationId);
  assert.deepEqual(grants.map(({ purpose, state }) => [purpose, state]).sort(), [['execute', 'CONSUMED'], ['reconcile', 'CONSUMED']]);
});

test('Host Broker refuses inspection after restore advances the Computer generation', async (t) => {
  let inspections = 0;
  const f = await fixture(t, { prepareProvider(provider) {
    const inspect = provider.inspect.bind(provider);
    provider.inspect = (...args) => { inspections++; return inspect(...args); };
  } });
  f.provider.failNext('create', { timing: 'after', code: 'create_reply_lost' });
  const operation = f.operation('create');
  assert.equal((await f.coordinator.execute(operation)).status, 'UNKNOWN');
  f.store.revokeLease(f.lease.leaseId, { reason: 'restore' });
  const reconciled = await f.coordinator.reconcile(operation.operationId);
  assert.equal(reconciled.status, 'UNKNOWN');
  assert.equal(reconciled.errorCode, 'stale_generation');
  assert.equal(inspections, 0, 'a stale Lease epoch is rejected before Provider inspection');
});

test('Broker journal resolution refuses a stored operation payload whose digest no longer matches', async (t) => {
  const f = await fixture(t);
  const input = f.operation('create');
  const begun = f.store.beginOperation(input);
  await recordExecutionApproval(f, input, begun);
  const tamperedDb = new DatabaseSync(f.databasePath);
  tamperedDb.prepare('UPDATE operations SET request_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...input, policyVersion: input.policyVersion + 1 }), input.operationId);
  tamperedDb.close();
  assert.throws(() => f.store.resolveBrokerDispatch({
    protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
    operationId: input.operationId, expectedGeneration: input.expectedGeneration,
    actionDigest: `sha256:${begun.operation.actionDigest}`,
  }), (error) => error instanceof EnvironmentStoreError && error.code === 'operation_journal_corrupt');
});

test('Broker journal resolution rejects an expired, revoked, or restored Lease before dispatch', async (t) => {
  const expired = await fixture(t);
  const expiredInput = expired.operation('create');
  const expiredRecord = expired.store.beginOperation(expiredInput).operation;
  await recordExecutionApproval(expired, expiredInput, { operation: expiredRecord });
  expired.advance(60 * 60 * 1000);
  assert.throws(() => expired.store.resolveBrokerDispatch({
    protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
    operationId: expiredInput.operationId, expectedGeneration: expiredInput.expectedGeneration,
    actionDigest: `sha256:${expiredRecord.actionDigest}`,
  }), (error) => error.code === 'lease_not_authorized');

  const revoked = await fixture(t);
  const revokedInput = revoked.operation('create');
  const revokedRecord = revoked.store.beginOperation(revokedInput).operation;
  await recordExecutionApproval(revoked, revokedInput, { operation: revokedRecord });
  revoked.store.revokeLease(revoked.lease.leaseId, { reason: 'policy_changed' });
  assert.throws(() => revoked.store.resolveBrokerDispatch({
    protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
    operationId: revokedInput.operationId, expectedGeneration: revokedInput.expectedGeneration,
    actionDigest: `sha256:${revokedRecord.actionDigest}`,
  }), (error) => error.code === 'lease_not_authorized');

  const restored = await fixture(t);
  const restoredInput = restored.operation('create');
  const restoredRecord = restored.store.beginOperation(restoredInput).operation;
  await recordExecutionApproval(restored, restoredInput, { operation: restoredRecord });
  restored.store.revokeLease(restored.lease.leaseId, { reason: 'restore' });
  assert.throws(() => restored.store.resolveBrokerDispatch({
    protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
    operationId: restoredInput.operationId, expectedGeneration: restoredInput.expectedGeneration,
    actionDigest: `sha256:${restoredRecord.actionDigest}`,
  }), (error) => error.code === 'stale_generation');
});

test('operation intent interrupted by host close becomes UNKNOWN after reopen and is inspected without blind replay', async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  const begun = f.store.beginOperation(request);
  await recordExecutionApproval(f, request, begun);
  assert.equal(begun.created, true);
  assert.equal(begun.operation.status, 'REQUESTED');
  f.store.resolveBrokerDispatch({
    protocolVersion: 1, type: 'broker.operation.request', requestId: randomUUID(),
    operationId: request.operationId, expectedGeneration: request.expectedGeneration,
    actionDigest: `sha256:${begun.operation.actionDigest}`,
  });
  assert.equal(f.store.getOperation(request.operationId).status, 'UNKNOWN', 'dispatch claim precedes provider I/O');
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
  const approvals = f.store.listOperationAuthorizations(request.operationId);
  assert.deepEqual(approvals.map(({ purpose, state }) => [purpose, state]).sort(), [['execute', 'CONSUMED'], ['reconcile', 'CONSUMED']]);
  assert.equal((await f.coordinator.execute(request)).operationId, request.operationId);
});

test('provider action completing after coordinator timeout remains UNKNOWN until inspection and is never replayed', async (t) => {
  let state = 'off';
  let starts = 0;
  let stops = 0;
  const delayedProvider = {
    providerId: 'mock',
    create: async (operation) => ({ computerId: operation.computerId, providerId: 'mock', state: 'off',
      generation: operation.expectedGeneration, observedAt: '2026-10-28T00:00:00.000Z' }),
    inspect: async (operation) => ({ computerId: operation.computerId, providerId: 'mock', state,
      generation: operation.expectedGeneration, observedAt: '2026-10-28T00:00:01.000Z' }),
    start: async (operation) => {
      starts++;
      await new Promise((resolve) => setTimeout(resolve, 150));
      state = 'running';
      return { computerId: operation.computerId, providerId: 'mock', state,
        generation: operation.expectedGeneration, observedAt: '2026-10-28T00:00:02.000Z' };
    },
    stop: async (operation) => {
      stops++;
      state = 'off';
      return { computerId: operation.computerId, providerId: 'mock', state,
        generation: operation.expectedGeneration, observedAt: '2026-10-28T00:00:03.000Z' };
    },
    destroy: async (operation) => ({ computerId: operation.computerId, providerId: 'mock', state: 'missing',
      generation: operation.expectedGeneration, observedAt: '2026-10-28T00:00:04.000Z' }),
  };
  const f = await fixture(t, { provider: delayedProvider });
  const request = f.operation('start');

  const timedOut = await f.coordinator.execute(request);
  assert.equal(timedOut.status, 'UNKNOWN');
  assert.equal(timedOut.errorCode, 'provider_timeout');
  assert.equal(f.store.getOperation(request.operationId).status, 'UNKNOWN');
  await assert.rejects(f.coordinator.execute(f.operation('stop', {
    operationId: 'operation-stop-while-start-unknown', idempotencyKey: 'idem-stop-while-start-unknown',
  })), (error) => error.code === 'computer_operation_unresolved');
  assert.throws(() => f.store.releaseLease(f.lease.leaseId, {
    computerId: f.computerId, providerId: 'mock', state: 'off', generation: f.lease.generation,
    observedAt: '2026-10-28T00:00:01.000Z',
  }), (error) => error.code === 'computer_operation_unresolved');
  assert.equal(stops, 0);

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(state, 'running', 'the timed-out provider action may still complete');
  const reconciled = await f.coordinator.reconcile(request.operationId);
  assert.equal(reconciled.status, 'SUCCEEDED');
  assert.equal(reconciled.observedState, 'running');
  assert.equal((await f.coordinator.execute(request)).status, 'SUCCEEDED');
  assert.equal(starts, 1, 'idempotent replay never invokes a second provider mutation');
  const stopped = await f.coordinator.execute(f.operation('stop'));
  assert.equal(stopped.status, 'SUCCEEDED');
  assert.equal(stops, 1);
  const released = f.store.releaseLease(f.lease.leaseId, {
    computerId: f.computerId, providerId: 'mock', state: 'off', generation: f.lease.generation,
    observedAt: '2026-10-28T00:00:03.000Z',
  });
  assert.equal(released.state, 'RELEASED');
});

test('durable coordinator sanitizes hostile Provider error Proxies and preserves UNKNOWN', async (t) => {
  const secret = 'credential=never-disclose';
  const hostile = new Proxy({}, {
    get() { throw new Error(secret); },
    getOwnPropertyDescriptor() { throw new Error(secret); },
    ownKeys() { throw new Error(secret); },
  });
  const f = await fixture(t, {
    prepareProvider(provider) {
      provider.create = async () => { throw hostile; };
    },
  });
  const request = f.operation('create');

  const result = await f.coordinator.execute(request);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.errorCode, 'provider_outcome_unknown');
  assert.equal(f.store.getOperation(request.operationId).status, 'UNKNOWN');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('typed Hyper-V adapter reconciles lost create, start, and stop replies without replay', async (t) => {
  const calls = { create: 0, inspect: 0, start: 0, stop: 0, destroy: 0 };
  let state = 'missing';
  let loseFirstCreateReply = true;
  let loseFirstStartReply = true;
  let loseFirstStopReply = true;
  const broker = Object.fromEntries([
    ['createVm', 'create'], ['inspectVm', 'inspect'], ['startVm', 'start'],
    ['stopVm', 'stop'], ['removeVm', 'destroy'],
  ].map(([method, action]) => [method, async (operation) => {
    calls[action]++;
    if (action === 'create') {
      state = 'off';
      if (loseFirstCreateReply) {
        loseFirstCreateReply = false;
        throw Object.assign(new Error('transport_reply_lost credential=do-not-persist'), { code: 'provider_timeout' });
      }
    }
    if (action === 'start') {
      state = 'running';
      if (loseFirstStartReply) {
        loseFirstStartReply = false;
        throw Object.assign(new Error('start reply lost token=do-not-persist'), { code: 'credentialabcdef012345' });
      }
    }
    if (action === 'stop') {
      state = 'off';
      if (loseFirstStopReply) {
        loseFirstStopReply = false;
        throw Object.assign(new Error('stop reply lost secret=do-not-persist'), { code: 'provider_timeout' });
      }
    }
    if (action === 'destroy') state = 'missing';
    return {
      computerId: operation.computerId, providerId: 'hyperv', state,
      generation: operation.expectedGeneration, observedAt: '2026-10-28T00:00:00.000Z',
    };
  }]));
  const f = await fixture(t, { provider: new HyperVEnvironmentProvider({ broker }) });
  const assertFailureDetailNotPersisted = async (operationId, marker) => {
    const persisted = JSON.stringify({
      operation: f.store.getOperation(operationId),
      events: f.store.listEvents(operationId),
    });
    assert.doesNotMatch(persisted, new RegExp(marker));
    for (const suffix of ['', '-wal', '-shm']) {
      let databaseBytes;
      try { databaseBytes = await readFile(`${f.databasePath}${suffix}`); }
      catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      assert.equal(databaseBytes.includes(Buffer.from(marker)), false, `failure detail is absent from SQLite ${suffix || 'database'} bytes`);
    }
  };

  const create = f.operation('create');
  const uncertain = await f.coordinator.execute(create);
  assert.equal(uncertain.status, 'UNKNOWN');
  assert.equal(uncertain.errorCode, 'provider_timeout');
  assert.doesNotMatch(JSON.stringify(uncertain), /do-not-persist/);
  assert.equal(f.store.getOperation(create.operationId).status, 'UNKNOWN');
  await assertFailureDetailNotPersisted(create.operationId, 'do-not-persist');

  const reconciled = await f.coordinator.reconcile(create.operationId);
  assert.equal(reconciled.status, 'SUCCEEDED');
  assert.equal(reconciled.observedState, 'off');
  assert.equal((await f.coordinator.execute(create)).operationId, create.operationId);
  assert.equal(calls.create, 1, 'an uncertain create is not replayed');

  const startRequest = f.operation('start');
  const uncertainStart = await f.coordinator.execute(startRequest);
  assert.equal(uncertainStart.status, 'UNKNOWN');
  assert.equal(uncertainStart.errorCode, 'provider_outcome_unknown');
  assert.doesNotMatch(JSON.stringify(uncertainStart), /do-not-persist/);
  assert.equal(f.store.getOperation(startRequest.operationId).status, 'UNKNOWN');
  await assertFailureDetailNotPersisted(startRequest.operationId, 'do-not-persist');
  await assertFailureDetailNotPersisted(startRequest.operationId, 'credentialabcdef012345');
  const start = await f.coordinator.reconcile(startRequest.operationId);
  assert.equal(start.status, 'SUCCEEDED');
  assert.equal(start.observedState, 'running');
  assert.equal((await f.coordinator.execute(startRequest)).operationId, startRequest.operationId);
  assert.equal(calls.start, 1, 'an uncertain start is not replayed');
  const inspect = await f.coordinator.execute(f.operation('inspect'));
  assert.equal(inspect.status, 'SUCCEEDED');
  assert.equal(inspect.observedState, 'running');
  const stopRequest = f.operation('stop');
  const uncertainStop = await f.coordinator.execute(stopRequest);
  assert.equal(uncertainStop.status, 'UNKNOWN');
  assert.equal(uncertainStop.errorCode, 'provider_timeout');
  assert.doesNotMatch(JSON.stringify(uncertainStop), /do-not-persist/);
  assert.equal(f.store.getOperation(stopRequest.operationId).status, 'UNKNOWN');
  await assertFailureDetailNotPersisted(stopRequest.operationId, 'do-not-persist');
  const stop = await f.coordinator.reconcile(stopRequest.operationId);
  assert.equal(stop.status, 'SUCCEEDED');
  assert.equal(stop.observedState, 'off');
  assert.equal((await f.coordinator.execute(stopRequest)).operationId, stopRequest.operationId);
  assert.equal(calls.stop, 1, 'an uncertain stop is not replayed');
  assert.deepEqual(calls, { create: 1, inspect: 4, start: 1, stop: 1, destroy: 0 });
});

test('typed Hyper-V adapter reconciles a lost destroy reply by inspection without repeating removal', async (t) => {
  const calls = { create: 0, inspect: 0, destroy: 0 };
  let state = 'missing';
  let loseDestroyReply = true;
  const broker = {
    createVm: async (operation) => {
      calls.create++;
      state = 'off';
      return { computerId: operation.computerId, providerId: 'hyperv', state,
        generation: operation.expectedGeneration, observedAt: '2026-10-28T00:00:00.000Z' };
    },
    inspectVm: async (operation) => {
      calls.inspect++;
      return { computerId: operation.computerId, providerId: 'hyperv', state,
        generation: operation.expectedGeneration, observedAt: '2026-10-28T00:00:00.000Z' };
    },
    startVm: async () => { throw new Error('unexpected_start'); },
    stopVm: async () => { throw new Error('unexpected_stop'); },
    removeVm: async (operation) => {
      calls.destroy++;
      state = 'missing';
      if (loseDestroyReply) {
        loseDestroyReply = false;
        throw Object.assign(new Error('remove reply lost secret=never-expose'), { code: 'provider_timeout' });
      }
      return { computerId: operation.computerId, providerId: 'hyperv', state,
        generation: operation.expectedGeneration, observedAt: '2026-10-28T00:00:00.000Z' };
    },
  };
  const f = await fixture(t, { provider: new HyperVEnvironmentProvider({ broker }) });
  assert.equal((await f.coordinator.execute(f.operation('create'))).status, 'SUCCEEDED');

  const request = f.operation('destroy');
  const uncertain = await f.coordinator.execute(request);
  assert.equal(uncertain.status, 'UNKNOWN');
  assert.equal(uncertain.errorCode, 'provider_timeout');
  assert.doesNotMatch(JSON.stringify(uncertain), /never-expose/);
  assert.equal(f.store.getOperation(request.operationId).status, 'UNKNOWN');
  assert.doesNotMatch(JSON.stringify({
    operation: f.store.getOperation(request.operationId),
    events: f.store.listEvents(request.operationId),
  }), /never-expose/);
  assert.equal((await readFile(f.databasePath)).includes(Buffer.from('never-expose')), false);
  assert.equal(calls.destroy, 1);

  const reconciled = await f.coordinator.reconcile(request.operationId);
  assert.equal(reconciled.status, 'SUCCEEDED');
  assert.equal(reconciled.observedState, 'missing');
  assert.equal((await f.coordinator.execute(request)).operationId, request.operationId);
  assert.deepEqual(calls, { create: 1, inspect: 1, destroy: 1 });
});

test('Hyper-V start reply loss stays UNKNOWN when inspection lags, then reconciles without replay', async (t) => {
  const calls = { start: 0, inspect: 0 };
  let state = 'off';
  const observedAt = () => `2026-10-28T00:00:0${calls.inspect}.000Z`;
  const broker = {
    createVm: async () => { throw new Error('unexpected_create'); },
    inspectVm: async (operation) => {
      calls.inspect++;
      return { computerId: operation.computerId, providerId: 'hyperv', state,
        generation: operation.expectedGeneration, observedAt: observedAt() };
    },
    startVm: async () => {
      calls.start++;
      throw Object.assign(new Error('reply lost token=late-state-secret'), { code: 'provider_timeout' });
    },
    stopVm: async () => { throw new Error('unexpected_stop'); },
    removeVm: async () => { throw new Error('unexpected_remove'); },
  };
  const f = await fixture(t, { provider: new HyperVEnvironmentProvider({ broker }) });
  const request = f.operation('start');

  const uncertain = await f.coordinator.execute(request);
  assert.equal(uncertain.status, 'UNKNOWN');
  assert.equal(uncertain.errorCode, 'provider_timeout');
  assert.equal(calls.start, 1);

  const lagging = await f.coordinator.reconcile(request.operationId);
  assert.equal(lagging.status, 'UNKNOWN', 'a stale off observation is not proof that start failed');
  assert.equal(lagging.observedState, 'off');
  assert.equal(lagging.errorCode, 'provider_timeout');
  assert.equal(f.store.getComputer(f.computerId).observedState, 'off');
  assert.equal((await f.coordinator.execute(request)).status, 'UNKNOWN');
  assert.equal(calls.start, 1, 'neither a lagging observation nor replay retries start');

  await f.reopen();
  assert.equal(f.store.getOperation(request.operationId).status, 'UNKNOWN', 'reopening the durable Store preserves the uncertain operation');
  assert.equal((await f.coordinator.execute(request)).status, 'UNKNOWN');
  assert.equal(calls.start, 1, 'host restart and idempotent replay do not redispatch the provider action');

  state = 'running'; // The original provider action becomes visible after the first inspection.
  const reconciled = await f.coordinator.reconcile(request.operationId);
  assert.equal(reconciled.status, 'SUCCEEDED');
  assert.equal(reconciled.observedState, 'running');
  assert.equal((await f.coordinator.execute(request)).status, 'SUCCEEDED');
  assert.deepEqual(calls, { start: 1, inspect: 2 });
  assert.doesNotMatch(JSON.stringify({ operation: f.store.getOperation(request.operationId),
    events: f.store.listEvents(request.operationId) }), /late-state-secret/);
  assert.equal((await readFile(f.databasePath)).includes(Buffer.from('late-state-secret')), false);
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

// The durable approved-operation flow journal (schema v5; the port is in approved-operation-journal.mjs, the flow suite in runtime-approved-operation-flow.test.mjs).
const openPlain = (databasePath) => openSqliteEnvironmentStore(databasePath, { verifyWindowsAcl: async () => {} });
const FLOW_RECORD = Object.freeze({ operationId: 'flow-op-1', phase: 'INTENT', cycle: 1, action: { name: 'x', args: { n: [1, null, 'a'] } } });

test('schema v4 migration adds the flow journal without touching existing rows; flow records survive a reopen', async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  f.store.beginOperation(request);
  f.store.recordProviderOutcome(request.operationId, { errorCode: 'fixture_failed', outcome: 'not_applied' });
  const before = f.store.getOperation(request.operationId);
  f.store.close();
  const db = new DatabaseSync(f.databasePath);
  db.exec('DROP TABLE flow_operations; PRAGMA user_version = 4');
  db.close();
  await f.reopen();
  assert.equal(f.store.diagnostics().schemaVersion, 6);
  assert.deepEqual(f.store.getOperation(request.operationId), before);
  assert.equal(f.store.flowJournal().get(FLOW_RECORD.operationId), null);
  f.store.flowJournal().begin(FLOW_RECORD);
  f.store.flowJournal().advance(FLOW_RECORD.operationId, 0, ['INTENT'], { phase: 'FENCED', fence: { brokerEpoch: 3 } });
  await f.reopen(); // already at v6: no migration, no data loss
  assert.deepEqual(f.store.flowJournal().get(FLOW_RECORD.operationId),
    { operationId: 'flow-op-1', phase: 'FENCED', revision: 1, cycle: 1, action: FLOW_RECORD.action, fence: { brokerEpoch: 3 } });
  assert.deepEqual(f.store.getOperation(request.operationId), before);
});

test('a database written by a newer schema version is refused before the journal mode changes, and left byte-for-byte unchanged', async (t) => {
  const f = await fixture(t);
  f.store.flowJournal().begin(FLOW_RECORD);
  f.store.close();
  const db = new DatabaseSync(f.databasePath);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; PRAGMA user_version = 7');
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  db.close();
  const sidecars = [`${f.databasePath}-wal`, `${f.databasePath}-shm`];
  const exists = (file) => stat(file).then(() => true, () => false);
  assert.deepEqual(await Promise.all(sidecars.map(exists)), [false, false], 'precondition: a non-WAL database has no sidecars');
  const bytesBefore = await readFile(f.databasePath);
  await assert.rejects(f.reopen(), (error) => error instanceof EnvironmentStoreError && error.code === 'database_schema_newer');
  assert.deepEqual(await Promise.all(sidecars.map(exists)), [false, false], 'no -wal / -shm was created');
  assert.ok(bytesBefore.equals(await readFile(f.databasePath)), 'the database file bytes are unchanged (still not WAL)');
  const check = new DatabaseSync(f.databasePath, { readOnly: true });
  try {
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM flow_operations').get().n, 1);
  } finally { check.close(); }
});

test('flow journal rows carry a record schema version; a row from another version is refused, not guessed at', async (t) => {
  const f = await fixture(t);
  const journal = f.store.flowJournal();
  journal.begin(FLOW_RECORD);
  const raw = new DatabaseSync(f.databasePath);
  try {
    const row = raw.prepare('SELECT revision, phase, record_schema, record_json FROM flow_operations').get();
    assert.deepEqual([row.revision, row.phase, row.record_schema], [0, 'INTENT', 1]);
    assert.deepEqual(JSON.parse(row.record_json), { cycle: 1, action: FLOW_RECORD.action }, 'identity, revision and phase live in columns only');
    raw.exec('UPDATE flow_operations SET record_schema = 2');
  } finally { raw.close(); }
  assert.throws(() => journal.get(FLOW_RECORD.operationId), { code: 'record_schema_unsupported' });
  assert.throws(() => journal.advance(FLOW_RECORD.operationId, 0, ['INTENT'], { phase: 'FENCED' }), { code: 'record_schema_unsupported' });
});

test('flow journal rejects malformed input without writing, and a closed store rejects everything', async (t) => {
  const f = await fixture(t);
  const journal = f.store.flowJournal();
  for (const bad of [null, [], 'x', {}, { operationId: '', phase: 'INTENT' }, { operationId: 'a', phase: 5 }, { operationId: 'a', phase: 'INTENT', big: 10n }]) {
    assert.throws(() => journal.begin(bad), (error) => error instanceof FlowJournalError && error.code === 'invalid_record');
  }
  journal.begin(FLOW_RECORD);
  const id = FLOW_RECORD.operationId;
  for (const [revision, from, patch] of [[-1, ['INTENT'], {}], [0.5, ['INTENT'], {}], [0, [], {}], [0, 'INTENT', {}], [0, [''], {}], [0, ['INTENT'], null], [0, ['INTENT'], { phase: '' }], [0, ['INTENT'], { phase: undefined }]]) {
    assert.throws(() => journal.advance(id, revision, from, patch), { code: 'invalid_record' }, JSON.stringify([revision, from, patch]));
  }
  assert.throws(() => journal.advance('nope', 0, ['INTENT'], { phase: 'FENCED' }), { code: 'unknown_operation' });
  assert.deepEqual([journal.get(id).revision, journal.get(id).phase], [0, 'INTENT'], 'nothing was written');
  f.store.close();
  assert.throws(() => journal.get(id), { code: 'store_closed' });
  assert.throws(() => journal.begin(FLOW_RECORD), { code: 'store_closed' });
  assert.throws(() => journal.advance(id, 0, ['INTENT'], { phase: 'FENCED' }), { code: 'store_closed' });
});

test('flow journal records count against the store capacity; an existing record can still advance when the store is full', async (t) => {
  const f = await fixture(t, { maxRecords: 32, maxGuestRecords: 4 });
  const journal = f.store.flowJournal();
  let accepted = 0;
  for (; accepted < 100; accepted += 1) {
    try { journal.begin({ operationId: `cap-${accepted}`, phase: 'INTENT' }); } catch (error) {
      assert.equal(error.code, 'store_capacity_exceeded');
      break;
    }
  }
  assert.ok(accepted > 0 && accepted < 32, `accepted ${accepted}`);
  assert.equal(journal.get(`cap-${accepted}`), null, 'the refused record was not written');
  assert.equal(journal.advance('cap-0', 0, ['INTENT'], { phase: 'FENCED' }).revision, 1);
});

test('two connections to one database: begin is idempotent, and only the holder of the current revision and phase can advance', async (t) => {
  const f = await fixture(t);
  const other = await openPlain(f.databasePath);
  try {
    const a = f.store.flowJournal();
    const b = other.flowJournal();
    assert.equal(a.begin(FLOW_RECORD).created, true);
    const second = b.begin({ ...FLOW_RECORD, cycle: 99 });
    assert.deepEqual([second.created, second.record.cycle], [false, 1], 'the stored record wins');
    const outcomes = [a, b].map((journal) => { try { return journal.advance(FLOW_RECORD.operationId, 0, ['INTENT'], { phase: 'FENCED' }).revision; } catch (error) { return error.code; } });
    assert.deepEqual(outcomes, [1, 'conflict'], 'exactly one of two writers holding revision 0 wins');
    assert.equal(b.get(FLOW_RECORD.operationId).revision, 1, 'the other connection sees the committed record');
    assert.throws(() => b.advance(FLOW_RECORD.operationId, 1, ['INTENT'], { phase: 'SUBMITTED' }), { code: 'conflict' }, 'right revision, wrong phase');
    assert.equal(b.advance(FLOW_RECORD.operationId, 1, ['INTENT', 'FENCED'], { phase: 'SUBMITTED' }).revision, 2);
  } finally { other.close(); }
});

test('separate processes holding the same revision: exactly one advance wins', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  f.store.flowJournal().begin(FLOW_RECORD);
  const workerPath = fileURLToPath(new URL('../scripts/runtime-scheduler-contender.mjs', import.meta.url));
  const workers = Array.from({ length: 8 }, (_, index) => spawnSynchronizedStoreWorker(workerPath, f.databasePath, index + 1, 'flow-advance', FLOW_RECORD.operationId));
  t.after(async () => {
    for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
    await Promise.all(workers.map((worker) => worker.exited));
  });
  const allResults = Promise.all(workers.map((worker) => worker.result));
  allResults.catch(() => {});
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.child.stdin.end('go\n');
  const outcomes = await allResults;
  await Promise.all(workers.map((worker) => worker.exited));
  const winners = outcomes.filter((outcome) => outcome.status === 'WON');
  assert.equal(winners.length, 1, JSON.stringify(outcomes));
  assert.ok(outcomes.filter((outcome) => outcome.status !== 'WON').every((outcome) => outcome.errorCode === 'conflict'), JSON.stringify(outcomes));
  const stored = f.store.flowJournal().get(FLOW_RECORD.operationId);
  assert.deepEqual([stored.phase, stored.revision, stored.winner], ['FENCED', 1, winners[0].winner], "the stored record is the winner's");
});

// ---- #115 step 1: retire / purge are journaled and authorized like every other action ----

test('schema v5 migration rebuilds the operations table to accept retire and purge, keeping every row, key and index', async (t) => {
  const f = await fixture(t);
  const request = f.operation('create');
  const begun = f.store.beginOperation(request);
  await recordExecutionApproval(f, request, begun);
  f.store.recordProviderOutcome(request.operationId, { errorCode: 'fixture_failed', outcome: 'not_applied' });
  const before = f.store.getOperation(request.operationId);
  const authorizations = f.store.listOperationAuthorizations(request.operationId);
  f.store.close();
  // Put the v5 shape back: the same table with the old CHECK (no retire / purge) and user_version 5.
  const db = new DatabaseSync(f.databasePath);
  const { sql } = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'operations'").get();
  const oldSql = sql.replace(',\'retire\',\'purge\'', '').replace('CREATE TABLE operations (', 'CREATE TABLE operations_old (');
  assert.ok(!oldSql.includes('retire') && oldSql.includes('operations_old'), 'precondition: the rebuilt table is the v5 shape');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`BEGIN; ${oldSql}; INSERT INTO operations_old SELECT * FROM operations; DROP TABLE operations; ALTER TABLE operations_old RENAME TO operations;
    CREATE INDEX operations_computer_idx ON operations(computer_id, created_at); PRAGMA user_version = 5; COMMIT;`);
  assert.throws(() => db.exec("UPDATE operations SET action = 'retire'"), /CHECK/, 'precondition: the v5 table refuses the new action');
  db.close();
  await f.reopen();
  assert.equal(f.store.diagnostics().schemaVersion, 6);
  assert.equal(f.store.diagnostics().foreignKeys, 1, 'foreign keys are back on after the rebuild');
  assert.deepEqual(f.store.getOperation(request.operationId), before);
  assert.deepEqual(f.store.listOperationAuthorizations(request.operationId), authorizations);
  const retire = f.operation('retire');
  assert.equal(f.store.beginOperation(retire).created, true);
  assert.equal(f.store.getOperation(retire.operationId).desiredState, 'retired');
  assert.deepEqual(f.store.beginOperation({ ...request }).created, false, 'the idempotency key of the old row still works after the rebuild');
  f.store.close();
  const check = new DatabaseSync(f.databasePath, { readOnly: true });
  try {
    assert.equal(check.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'operations_computer_idx'").get().n, 1);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'operations_old' OR name = 'operations_v6'").get().n, 0);
  } finally { check.close(); }
});

test('retire and purge need the same human authorization as destroy, with their own action digests, and a denial reaches no provider', async (t) => {
  const seen = [];
  let deny = false;
  const retirements = createRetirementJournal();
  const provider = new MockEnvironmentProvider({ retirements });
  const calls = { retire: 0, purge: 0 };
  for (const action of Object.keys(calls)) {
    const method = provider[action].bind(provider);
    provider[action] = async (operation) => { calls[action]++; return method(operation); };
  }
  const f = await fixture(t, {
    provider,
    authorizeOperation: ({ operation, actionDigest, purpose }) => {
      seen.push({ action: operation.action, actionDigest, purpose });
      if (deny) throw new Error('private denial detail');
      return {
        decision: 'approved', approvalId: randomUUID(), approverId: 'human-approver', operationId: operation.operationId, idempotencyKey: operation.idempotencyKey,
        subjectId: operation.subjectId, projectId: operation.projectId, policyVersion: operation.policyVersion, actionDigest, purpose,
        expiresAt: new Date(Date.parse(f.now()) + 60_000).toISOString(),
      };
    },
  });
  const step = (action, n) => f.operation(action, { operationId: `operation-${action}-${n}`, idempotencyKey: `idem-${action}-${n}` });

  assert.equal((await f.coordinator.execute(f.operation('create'))).observedState, 'off');
  const purgeEarly = await f.coordinator.execute(step('purge', 1));
  assert.deepEqual([purgeEarly.status, purgeEarly.errorCode], ['FAILED', 'environment_not_retired'], 'a purge of an environment that is not retired is refused');

  deny = true;
  await assert.rejects(f.coordinator.execute(step('retire', 1)), (e) => e.code === 'authorization_denied');
  assert.equal(calls.retire, 0, 'a denied retire never reaches the provider');
  assert.equal(f.store.getOperation('operation-retire-1'), null, 'and leaves no journal row');
  assert.equal(retirements.list().length, 0);
  deny = false;

  const retired = await f.coordinator.execute(step('retire', 2));
  assert.deepEqual([retired.status, retired.desiredState, retired.observedState], ['SUCCEEDED', 'retired', 'retired']);
  assert.equal(retirements.get('computer-a').generation, f.lease.generation);
  const purged = await f.coordinator.execute(step('purge', 2));
  assert.deepEqual([purged.status, purged.desiredState, purged.observedState], ['SUCCEEDED', 'missing', 'missing']);
  assert.equal(retirements.list().length, 0);

  const actions = seen.map((entry) => entry.action);
  assert.deepEqual(actions, ['create', 'purge', 'retire', 'retire', 'purge'], 'every action was put to the authorizer, none was waved through');
  const digestOf = (action) => seen.find((entry) => entry.action === action).actionDigest;
  assert.notEqual(digestOf('retire'), digestOf('purge'));
  const destroy = f.operation('destroy', { operationId: 'operation-destroy-x', idempotencyKey: 'idem-destroy-x' });
  await f.coordinator.execute(destroy);
  assert.notEqual(seen.at(-1).actionDigest, digestOf('retire'));
  assert.notEqual(seen.at(-1).actionDigest, digestOf('purge'));
  assert.equal(seen.at(-1).action, 'destroy');
});

test('a retire or purge left UNKNOWN blocks the next mutation of that computer generation until it is reconciled', async (t) => {
  const f = await fixture(t);
  await f.coordinator.execute(f.operation('create'));
  f.provider.failNext('retire', { timing: 'after', code: 'reply_lost' });
  const unknown = await f.coordinator.execute(f.operation('retire'));
  assert.equal(unknown.status, 'UNKNOWN');
  assert.throws(() => f.store.beginOperation(f.operation('purge')), (e) => e.code === 'computer_operation_unresolved');
  const reconciled = await f.coordinator.reconcile(unknown.operationId);
  assert.deepEqual([reconciled.status, reconciled.observedState], ['SUCCEEDED', 'retired']);
});
