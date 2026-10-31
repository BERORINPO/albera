import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, open, readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { assertPrivatePosixStorage, assertSingleLink } from './audit-journal.mjs';
import { FlowJournalError } from './approved-operation-journal.mjs';
import { assertBrokerRequestMatchesAuthorization, validateBrokerRequest, validateGuestEvent } from './boundary-protocols.mjs';
import { assertPrivateWindowsAcl, RuntimeStorageAclError } from './windows-acl.mjs';
import { EnvironmentProviderError, validateEnvironmentCapacity, validateEnvironmentOperation, validateEnvironmentQuota, validateEnvironmentSpec, validateObservedEnvironment } from './environment-provider.mjs';

const SCHEMA_VERSION = 6;
const FLOW_RECORD_SCHEMA = 1; // the version of the JSON in flow_operations.record_json, independent of the database schema
const FLOW_MAX_FROM_PHASES = 16;
const DEFAULT_MAX_RECORDS = 20_000;
const HARD_MAX_RECORDS = 100_000;
const DEFAULT_GUEST_RECORD_RATIO = 0.25;
const MAX_GUEST_RECORD_RATIO = 0.75;
const WAL_AUTOCHECKPOINT_PAGES = 1_000;
const WAL_JOURNAL_SIZE_LIMIT_BYTES = 4 * 1024 * 1024;
const RECOVERY_OWNER_MAGIC = 'ALBERA_SQLITE_RECOVERY_OWNER_V1';
const RESTORE_INVALIDATE = Symbol('restoreInvalidate');
const RESTORE_MODE = Symbol('restoreMode');
const DESIRED_STATES = Object.freeze({ create: 'off', inspect: null, start: 'running', stop: 'off', destroy: 'missing', retire: 'retired', purge: 'missing' });

export class EnvironmentStoreError extends Error {
  constructor(code) { super(code); this.name = 'EnvironmentStoreError'; this.code = code; }
}

/** Open a private, single-host SQLite WAL store. This module is not exposed through Observer routes. */
export async function openSqliteEnvironmentStore(databasePath, {
  verifyWindowsAcl = assertPrivateWindowsAcl,
  now = () => new Date().toISOString(),
  maxRecords = DEFAULT_MAX_RECORDS,
  maxGuestRecords = Math.floor(maxRecords * DEFAULT_GUEST_RECORD_RATIO),
  DatabaseImpl = DatabaseSync,
  recoverInterruptedRequests = false,
  [RESTORE_MODE]: restoreSnapshot = false,
} = {}) {
  if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath) || path.resolve(databasePath) !== databasePath
    || databasePath === path.parse(databasePath).root || (process.platform === 'win32' && isWindowsUncPath(databasePath))) {
    throw new EnvironmentStoreError('database_path_invalid');
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 32 || maxRecords > HARD_MAX_RECORDS) throw new TypeError('invalid_store_capacity');
  if (!Number.isSafeInteger(maxGuestRecords) || maxGuestRecords < 2
    || maxGuestRecords > Math.floor(maxRecords * MAX_GUEST_RECORD_RATIO)) {
    throw new TypeError('invalid_guest_store_capacity');
  }
  if (typeof now !== 'function' || typeof DatabaseImpl !== 'function' || typeof recoverInterruptedRequests !== 'boolean'
    || typeof restoreSnapshot !== 'boolean' || (restoreSnapshot && !recoverInterruptedRequests)) {
    throw new TypeError('invalid_store_options');
  }
  const directory = path.dirname(databasePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) throw new EnvironmentStoreError('database_directory_invalid');
  assertPrivatePosixStorage(directoryInfo, 'database_directory_permissions', 'directory');
  await verifyAcl(verifyWindowsAcl, directory, 'directory');
  if (!restoreSnapshot) await assertNoRestoreMarker(databasePath);

  try {
    const handle = await open(databasePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.close();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new EnvironmentStoreError('database_create_failed');
  }

  let before;
  try {
    before = await lstat(databasePath);
    if (!before.isFile() || before.isSymbolicLink()) throw new EnvironmentStoreError('database_file_invalid');
    assertSingleLink(before, 'database_hard_linked_file');
    assertPrivatePosixStorage(before, 'database_file_permissions', 'file');
    await verifyAcl(verifyWindowsAcl, databasePath, 'file');
  } catch (error) {
    if (error instanceof EnvironmentStoreError || error instanceof RuntimeStorageAclError) throw error;
    throw new EnvironmentStoreError('database_file_invalid');
  }

  let db;
  let recoveryOwnerLock;
  try {
    if (recoverInterruptedRequests) recoveryOwnerLock = await acquireRecoveryOwnerLock(databasePath, verifyWindowsAcl);
    db = new DatabaseImpl(databasePath);
    const after = await lstat(databasePath);
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new EnvironmentStoreError('database_changed_during_open');
    }
    // Close the check/create race with restore: if restore installed its marker
    // after the initial check, this opener must not expose the copied database.
    if (!restoreSnapshot) await assertNoRestoreMarker(databasePath);
    assertSingleLink(after, 'database_hard_linked_file');
    assertPrivatePosixStorage(after, 'database_file_permissions', 'file');
    await verifyAcl(verifyWindowsAcl, databasePath, 'file');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    // Refuse a database written by a newer version before any mutating PRAGMA (journal_mode rewrites the header and creates -wal/-shm).
    const existingVersion = db.prepare('PRAGMA user_version').get()?.user_version;
    if (!Number.isSafeInteger(existingVersion) || existingVersion > SCHEMA_VERSION) throw new EnvironmentStoreError('database_schema_newer');
    const mode = db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
    if (String(mode).toLowerCase() !== 'wal') throw new EnvironmentStoreError('wal_mode_unavailable');
    db.exec('PRAGMA synchronous = FULL');
    db.exec(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    db.exec(`PRAGMA journal_size_limit = ${WAL_JOURNAL_SIZE_LIMIT_BYTES}`);
    const integrity = db.prepare('PRAGMA quick_check(1)').get()?.quick_check;
    if (integrity !== 'ok') throw new EnvironmentStoreError('database_integrity_failed');
    migrate(db);
    const store = new SqliteEnvironmentOperationStore(db, {
      databasePath, verifyWindowsAcl, now, maxRecords, maxGuestRecords, recoveryOwnerLock,
    });
    // Recovery is opt-in and holds a fail-closed owner marker for the store's lifetime.
    if (recoverInterruptedRequests) {
      if (restoreSnapshot) store[RESTORE_INVALIDATE]();
      else store.recoverInterruptedRequests();
    }
    return store;
  } catch (error) {
    db?.close();
    recoveryOwnerLock?.release();
    if (error instanceof EnvironmentStoreError || error instanceof RuntimeStorageAclError) throw error;
    // Preserve the database and sidecars for diagnosis; never repair or delete uncertain state.
    throw new EnvironmentStoreError('database_open_failed');
  }
}

/** Restore a verified snapshot to a new private DB, fence every Computer generation, and recover pending work.
 * The created database is preserved on error for diagnosis; callers must not expose it until this resolves. */
export async function restoreSqliteEnvironmentStore(backupPath, databasePath, options = {}) {
  const verifyWindowsAcl = options.verifyWindowsAcl ?? assertPrivateWindowsAcl;
  if (typeof backupPath !== 'string' || !path.isAbsolute(backupPath) || path.resolve(backupPath) !== backupPath
    || typeof databasePath !== 'string' || !path.isAbsolute(databasePath) || path.resolve(databasePath) !== databasePath
    || backupPath === databasePath || path.dirname(backupPath) !== path.dirname(databasePath)) {
    throw new EnvironmentStoreError('restore_path_invalid');
  }
  const directory = path.dirname(databasePath);
  const directoryInfo = await lstat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) throw new EnvironmentStoreError('database_directory_invalid');
  assertPrivatePosixStorage(directoryInfo, 'database_directory_permissions', 'directory');
  await verifyAcl(verifyWindowsAcl, directory, 'directory');
  await assertPrivateDatabaseFile(backupPath, verifyWindowsAcl, 'backup');
  await verifyStandaloneSnapshot(backupPath);
  if (await lstat(databasePath).then(() => true, () => false)) throw new EnvironmentStoreError('restore_destination_exists');
  const restoreMarker = await createRestoreMarker(databasePath, verifyWindowsAcl);
  let store;
  try {
    try { await copyFile(backupPath, databasePath, fsConstants.COPYFILE_EXCL); }
    catch (error) {
      if (error?.code === 'EEXIST') {
        // A normal open may have created this previously absent destination after
        // our first check. EXCL guarantees no snapshot bytes were copied; release
        // only our marker so the competing opener is not left quarantined.
        await releaseRestoreMarker(restoreMarker, verifyWindowsAcl);
        throw new EnvironmentStoreError('restore_destination_exists');
      }
      throw new EnvironmentStoreError('restore_copy_failed');
    }
    if (process.platform !== 'win32') await chmod(databasePath, 0o600);
    await assertPrivateDatabaseFile(databasePath, verifyWindowsAcl, 'restored_database');
    store = await openSqliteEnvironmentStore(databasePath, {
      ...options, verifyWindowsAcl, recoverInterruptedRequests: true, [RESTORE_MODE]: true,
    });
    await releaseRestoreMarker(restoreMarker, verifyWindowsAcl);
    return store;
  } catch (error) {
    store?.close();
    throw error;
  }
}

class SqliteEnvironmentOperationStore {
  #db;
  #databasePath;
  #verifyWindowsAcl;
  #now;
  #maxRecords;
  #maxGuestRecords;
  #recoveryOwnerLock;
  #closed = false;
  #flowJournal;

  constructor(db, { databasePath, verifyWindowsAcl, now, maxRecords, maxGuestRecords, recoveryOwnerLock }) {
    this.#db = db; this.#databasePath = databasePath; this.#verifyWindowsAcl = verifyWindowsAcl;
    this.#now = now; this.#maxRecords = maxRecords; this.#maxGuestRecords = maxGuestRecords;
    this.#recoveryOwnerLock = recoveryOwnerLock;
  }

  /** Create an exclusive, consistent SQLite snapshot inside the same private storage directory. */
  async backupTo(backupPath) {
    this.#assertOpen();
    if (typeof backupPath !== 'string' || !path.isAbsolute(backupPath) || path.resolve(backupPath) !== backupPath
      || path.dirname(backupPath) !== path.dirname(this.#databasePath)
      || [this.#databasePath, `${this.#databasePath}-wal`, `${this.#databasePath}-shm`, `${this.#databasePath}.recovery-owner`].includes(backupPath)) {
      throw new EnvironmentStoreError('backup_path_invalid');
    }
    const directory = path.dirname(this.#databasePath);
    const stagingDirectory = await mkdtemp(path.join(directory, '.albera-sqlite-backup-'));
    try {
      if (process.platform !== 'win32') await chmod(stagingDirectory, 0o700);
      const stageInfo = await lstat(stagingDirectory);
      assertPrivatePosixStorage(stageInfo, 'backup_staging_permissions', 'directory');
      await verifyAcl(this.#verifyWindowsAcl, stagingDirectory, 'directory');
      const stagedPath = path.join(stagingDirectory, 'snapshot.sqlite');
      this.#db.exec(`VACUUM INTO '${quoteSqliteString(stagedPath)}'`);
      if (process.platform !== 'win32') await chmod(stagedPath, 0o600);
      await assertPrivateDatabaseFile(stagedPath, this.#verifyWindowsAcl, 'backup');
      await verifyStandaloneSnapshot(stagedPath);
      try { await link(stagedPath, backupPath); }
      catch (error) {
        if (error?.code === 'EEXIST') throw new EnvironmentStoreError('backup_destination_exists');
        throw new EnvironmentStoreError('backup_publish_failed');
      }
      await unlink(stagedPath);
      await assertPrivateDatabaseFile(backupPath, this.#verifyWindowsAcl, 'backup');
      return Object.freeze({ status: 'BACKED_UP', schemaVersion: SCHEMA_VERSION });
    } catch (error) {
      if (error instanceof EnvironmentStoreError || error instanceof RuntimeStorageAclError) throw error;
      throw new EnvironmentStoreError('backup_failed');
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Invalidate restored authority before a restored store can be handed to a caller. */
  [RESTORE_INVALIDATE]() {
    this.#assertOpen();
    const timestamp = this.#timestamp();
    return this.#transaction(() => {
      const pending = this.#db.prepare("SELECT id, computer_id FROM operations WHERE status = 'REQUESTED'").all();
      const computers = this.#db.prepare('SELECT id, generation FROM computers ORDER BY id').all();
      const activeLeases = this.#db.prepare("SELECT id, computer_id FROM leases WHERE state <> 'RELEASED'").all();
      this.#assertCapacity(computers.length + activeLeases.length + pending.length);
      const updatePending = this.#db.prepare("UPDATE operations SET status = 'UNKNOWN', error_code = 'host_interrupted', updated_at = ? WHERE id = ? AND status = 'REQUESTED'");
      for (const operation of pending) {
        updatePending.run(timestamp, operation.id);
        this.#event(operation.id, operation.id, 'operation.unknown', { status: 'UNKNOWN', errorCode: 'host_interrupted' }, timestamp);
      }
      for (const computer of computers) {
        if (computer.generation >= Number.MAX_SAFE_INTEGER) throw new EnvironmentStoreError('generation_exhausted');
        const generation = computer.generation + 1;
        this.#db.prepare("UPDATE computers SET generation = ?, observed_state = 'unknown', observed_at = ?, row_version = row_version + 1 WHERE id = ?")
          .run(generation, timestamp, computer.id);
        this.#event(computer.id, null, 'computer.snapshot_restored', { generation }, timestamp);
      }
      this.#db.prepare("UPDATE leases SET state = 'REVOKED' WHERE state <> 'RELEASED'").run();
      for (const lease of activeLeases) {
        this.#event(lease.computer_id, null, 'lease.revoked', { leaseId: lease.id, reason: 'snapshot_restore' }, timestamp);
      }
      return Object.freeze({ computersInvalidated: computers.length, leasesRevoked: activeLeases.length });
    });
  }

  /** Convert process-interrupted REQUESTED work to UNKNOWN; no provider action is replayed. */
  recoverInterruptedRequests() {
    this.#assertOpen();
    const timestamp = this.#timestamp();
    this.#transaction(() => {
      const pending = this.#db.prepare("SELECT id, computer_id FROM operations WHERE status = 'REQUESTED'").all();
      const update = this.#db.prepare("UPDATE operations SET status = 'UNKNOWN', error_code = 'host_interrupted', updated_at = ? WHERE id = ? AND status = 'REQUESTED'");
      const updateComputer = this.#db.prepare("UPDATE computers SET observed_state = 'unknown', observed_at = ?, row_version = row_version + 1 WHERE id = ?");
      for (const row of pending) {
        update.run(timestamp, row.id);
        updateComputer.run(timestamp, row.computer_id);
        this.#event(row.id, row.id, 'operation.unknown', { status: 'UNKNOWN', errorCode: 'host_interrupted' }, timestamp);
      }
    });
  }

  registerComputer({ computerId, projectId, providerId, capacity }) {
    this.#assertOpen();
    if (![computerId, projectId, providerId].every(isId)) throw new EnvironmentStoreError('computer_registration_invalid');
    let capacityJson = null;
    if (capacity !== undefined) {
      try { capacityJson = JSON.stringify(validateEnvironmentCapacity(capacity)); }
      catch { throw new EnvironmentStoreError('computer_capacity_invalid'); }
    }
    const timestamp = this.#timestamp();
    return this.#transaction(() => {
      this.#assertCapacity(2);
      const existing = this.#db.prepare('SELECT * FROM computers WHERE id = ?').get(computerId);
      if (existing) {
        if (existing.project_id !== projectId || existing.provider_id !== providerId) throw new EnvironmentStoreError('computer_id_conflict');
        if (capacityJson !== null && existing.capacity_json !== capacityJson) throw new EnvironmentStoreError('computer_capacity_conflict');
        return mapComputer(existing);
      }
      this.#db.prepare(`INSERT INTO computers (id, project_id, provider_id, desired_state, observed_state, generation, row_version, observed_at, capacity_json)
        VALUES (?, ?, ?, 'missing', 'missing', 1, 1, ?, ?)`)
        .run(computerId, projectId, providerId, timestamp, capacityJson);
      this.#event(computerId, null, 'computer.registered', { projectId, providerId, generation: 1 }, timestamp);
      return mapComputer(this.#db.prepare('SELECT * FROM computers WHERE id = ?').get(computerId));
    });
  }

  /** Reserve one exclusive Lease. The Computer generation advances on restore, not ordinary task reassignment. */
  reserveLease({ leaseId, subjectId, projectId, taskId, runId, computerId, expiresAt, requirements, quota }) {
    this.#assertOpen();
    if (![leaseId, subjectId, projectId, taskId, runId, computerId].every(isId) || !isTimestamp(expiresAt)) {
      throw new EnvironmentStoreError('lease_request_invalid');
    }
    let reservationJson = null;
    let quotaJson = null;
    if ((requirements === undefined) !== (quota === undefined)) throw new EnvironmentStoreError('lease_reservation_invalid');
    if (requirements !== undefined) {
      try {
        const spec = validateEnvironmentSpec(requirements);
        if (spec.projectId !== projectId) throw new TypeError('project_mismatch');
        reservationJson = JSON.stringify(spec);
        quotaJson = JSON.stringify(validateEnvironmentQuota(quota));
      } catch { throw new EnvironmentStoreError('lease_reservation_invalid'); }
    }
    const timestamp = this.#timestamp();
    const normalizedExpiry = new Date(Date.parse(expiresAt)).toISOString();
    if (Date.parse(normalizedExpiry) <= Date.parse(timestamp)) throw new EnvironmentStoreError('lease_expiry_invalid');
    return this.#transaction(() => {
      this.#assertCapacity(2);
      const prior = this.#db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId);
      if (prior) {
        if (!sameLease(prior, { subjectId, projectId, taskId, runId, computerId, expiresAt: normalizedExpiry, reservationJson, quotaJson })) throw new EnvironmentStoreError('lease_id_conflict');
        return mapLease(prior);
      }
      const computer = this.#db.prepare('SELECT * FROM computers WHERE id = ?').get(computerId);
      if (!computer || computer.project_id !== projectId) throw new EnvironmentStoreError('computer_not_owned');
      if (reservationJson !== null) {
        if (!computer.capacity_json) throw new EnvironmentStoreError('computer_capacity_unknown');
        if (!fitsCapacity(JSON.parse(computer.capacity_json), JSON.parse(reservationJson))) throw new EnvironmentStoreError('computer_incompatible');
        this.#assertProjectQuota(projectId, JSON.parse(reservationJson), JSON.parse(quotaJson), leaseId);
      }
      const outstanding = this.#db.prepare(`SELECT id FROM leases WHERE computer_id = ? AND state <> 'RELEASED' LIMIT 1`).get(computerId);
      if (outstanding) throw new EnvironmentStoreError('computer_already_leased');
      const generation = computer.generation;
      this.#db.prepare('UPDATE computers SET row_version = row_version + 1 WHERE id = ? AND generation = ?')
        .run(computerId, computer.generation);
      this.#db.prepare(`INSERT INTO leases (id, subject_id, project_id, task_id, run_id, computer_id, generation, expires_at, state, created_at, reservation_json, quota_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`)
        .run(leaseId, subjectId, projectId, taskId, runId, computerId, generation, normalizedExpiry, timestamp, reservationJson, quotaJson);
      this.#event(computerId, null, 'lease.issued', { leaseId, projectId, taskId, runId, generation, expiresAt: normalizedExpiry }, timestamp);
      return mapLease(this.#db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId));
    });
  }

  /** Mark expired leases without treating expiry as proof that the provider stopped. */
  expireLeases(at = this.#timestamp()) {
    this.#assertOpen();
    if (!isTimestamp(at)) throw new TypeError('invalid_expiry_time');
    const cutoff = new Date(Date.parse(at)).toISOString();
    return this.#transaction(() => {
      const expired = this.#db.prepare("SELECT id, computer_id FROM leases WHERE state = 'ACTIVE' AND expires_at <= ?").all(cutoff);
      const update = this.#db.prepare("UPDATE leases SET state = 'EXPIRED' WHERE id = ? AND state = 'ACTIVE'");
      for (const lease of expired) {
        update.run(lease.id);
        this.#event(lease.computer_id, null, 'lease.expired', { leaseId: lease.id }, cutoff);
      }
      return expired.length;
    });
  }

  /** Revoke Lease authority. Only restore advances the Computer epoch; revocation never asserts the guest stopped. */
  revokeLease(leaseId, { reason = 'revoked' } = {}) {
    this.#assertOpen();
    if (!isId(leaseId) || !['revoked', 'restore', 'policy_changed'].includes(reason)) throw new EnvironmentStoreError('lease_revoke_invalid');
    const timestamp = this.#timestamp();
    return this.#transaction(() => {
      const lease = this.#db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId);
      if (!lease) throw new EnvironmentStoreError('lease_unknown');
      const computer = this.#db.prepare('SELECT * FROM computers WHERE id = ?').get(lease.computer_id);
      if (lease.state === 'RELEASED' || (lease.state === 'REVOKED'
        && (reason !== 'restore' || computer.generation !== lease.generation))) {
        return { lease: mapLease(lease), generation: computer.generation };
      }
      const generation = computer.generation + (reason === 'restore' && computer.generation === lease.generation ? 1 : 0);
      this.#db.prepare("UPDATE leases SET state = 'REVOKED' WHERE id = ?").run(leaseId);
      this.#db.prepare("UPDATE computers SET generation = ?, observed_state = 'unknown', observed_at = ?, row_version = row_version + 1 WHERE id = ?")
        .run(generation, timestamp, lease.computer_id);
      this.#event(lease.computer_id, null, 'lease.revoked', { leaseId, reason, generation }, timestamp);
      return { lease: mapLease(this.#db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId)), generation };
    });
  }

  /** Release capacity only with a current-generation observation that the computer is off or absent. */
  releaseLease(leaseId, observed) {
    this.#assertOpen();
    const timestamp = this.#timestamp();
    return this.#transaction(() => {
      const lease = this.#db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId);
      if (!lease) throw new EnvironmentStoreError('lease_unknown');
      if (lease.state === 'RELEASED') return mapLease(lease);
      const computer = this.#db.prepare('SELECT * FROM computers WHERE id = ?').get(lease.computer_id);
      if (hasUnresolvedProviderMutation(this.#db, computer.id, computer.generation)) {
        throw new EnvironmentStoreError('computer_operation_unresolved');
      }
      const observation = validateObservedEnvironment(observed, { computerId: computer.id, providerId: computer.provider_id });
      if (observation.generation !== computer.generation || !['off', 'missing'].includes(observation.state)) {
        throw new EnvironmentStoreError('stop_not_confirmed');
      }
      this.#db.prepare("UPDATE leases SET state = 'RELEASED' WHERE id = ?").run(leaseId);
      this.#db.prepare('UPDATE computers SET observed_state = ?, observed_at = ?, row_version = row_version + 1 WHERE id = ?')
        .run(observation.state, observation.observedAt, computer.id);
      this.#event(computer.id, null, 'lease.released', { leaseId, observedState: observation.state, generation: computer.generation }, timestamp);
      return mapLease(this.#db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId));
    });
  }

  /** Persist idempotent intent before any Provider side effect. `created` is true only once. */
  beginOperation(input) {
    this.#assertOpen();
    const operation = validateEnvironmentOperation(input);
    const actionDigest = digestOperation(operation);
    const timestamp = this.#timestamp();
    return this.#transaction(() => {
      const prior = this.#db.prepare('SELECT * FROM operations WHERE subject_id = ? AND project_id = ? AND idempotency_key = ?')
        .get(operation.subjectId, operation.projectId, operation.idempotencyKey);
      if (prior) {
        if (prior.action_digest !== actionDigest) throw new EnvironmentStoreError('idempotency_conflict');
        return { created: false, operation: this.#getOperationRow(prior) };
      }
      if (this.#db.prepare('SELECT id FROM operations WHERE id = ?').get(operation.operationId)) throw new EnvironmentStoreError('operation_id_conflict');
      const computer = this.#db.prepare('SELECT * FROM computers WHERE id = ?').get(operation.computerId);
      if (!computer || computer.project_id !== operation.projectId || computer.provider_id !== operation.providerId) throw new EnvironmentStoreError('computer_not_owned');
      if (computer.generation !== operation.expectedGeneration) throw new EnvironmentStoreError('stale_generation');
      const lease = this.#db.prepare('SELECT * FROM leases WHERE id = ?').get(operation.leaseId);
      if (!lease || lease.subject_id !== operation.subjectId || lease.project_id !== operation.projectId
        || lease.task_id !== operation.taskId || lease.run_id !== operation.runId || lease.computer_id !== operation.computerId
        || lease.generation !== operation.expectedGeneration || lease.state !== 'ACTIVE' || Date.parse(lease.expires_at) <= Date.parse(timestamp)) {
        throw new EnvironmentStoreError('lease_not_authorized');
      }
      if (operation.action !== 'inspect'
        && hasUnresolvedProviderMutation(this.#db, operation.computerId, operation.expectedGeneration)) {
        throw new EnvironmentStoreError('computer_operation_unresolved');
      }
      this.#assertCapacity(2);
      this.#db.prepare(`INSERT INTO operations (
        id, idempotency_key, subject_id, project_id, task_id, run_id, computer_id, provider_id, lease_id, generation,
        action, action_digest, request_json, status, desired_state, observed_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?)`)
        .run(operation.operationId, operation.idempotencyKey, operation.subjectId, operation.projectId, operation.taskId,
          operation.runId, operation.computerId, operation.providerId, operation.leaseId, operation.expectedGeneration, operation.action,
          actionDigest, JSON.stringify(operation), DESIRED_STATES[operation.action], computer.observed_state, timestamp, timestamp);
      this.#db.prepare('UPDATE computers SET desired_state = ?, row_version = row_version + 1 WHERE id = ?')
        .run(DESIRED_STATES[operation.action] ?? computer.desired_state, computer.id);
      this.#event(operation.operationId, operation.operationId, 'operation.requested', {
        action: operation.action, desiredState: DESIRED_STATES[operation.action], generation: operation.expectedGeneration,
      }, timestamp);
      return { created: true, operation: this.#getOperationRow(this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(operation.operationId)) };
    });
  }

  /** Persist only non-secret approval evidence. The trusted authorizer remains responsible for identity and policy verification. */
  recordOperationAuthorization(operationId, authorization, { purpose } = {}) {
    this.#assertOpen();
    if (!isId(operationId) || !['execute', 'reconcile'].includes(purpose)) {
      throw new EnvironmentStoreError('authorization_record_invalid');
    }
    const timestamp = this.#timestamp();
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId);
      if (!row) throw new EnvironmentStoreError('operation_unknown');
      if (row.status !== (purpose === 'execute' ? 'REQUESTED' : 'UNKNOWN')) {
        throw new EnvironmentStoreError('authorization_operation_state_invalid');
      }
      let request;
      try { request = validateEnvironmentOperation(JSON.parse(row.request_json)); }
      catch { throw new EnvironmentStoreError('operation_journal_corrupt'); }
      const { spec: _spec, ...requestWithoutSpec } = request;
      const authorizationDigest = purpose === 'execute' ? row.action_digest
        : digestOperation({ ...requestWithoutSpec, action: 'inspect' });
      const normalized = normalizeOperationAuthorization(authorization, {
        operationId: row.id, idempotencyKey: row.idempotency_key, subjectId: row.subject_id,
        projectId: row.project_id, policyVersion: request.policyVersion,
        actionDigest: `sha256:${authorizationDigest}`, purpose, nowMs: Date.parse(timestamp),
      });
      if (this.#db.prepare('SELECT approval_id FROM operation_authorizations WHERE approval_id = ?').get(normalized.approvalId)) {
        throw new EnvironmentStoreError('authorization_reused');
      }
      this.#assertCapacity(2);
      const state = purpose === 'reconcile' ? 'CONSUMED' : 'RECORDED';
      this.#db.prepare(`INSERT INTO operation_authorizations (
        approval_id, operation_id, purpose, operation_idempotency_key, approver_id, subject_id, project_id,
        policy_version, action_digest, expires_at, state, recorded_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(normalized.approvalId, row.id, purpose, row.idempotency_key, normalized.approverId,
          row.subject_id, row.project_id, request.policyVersion, authorizationDigest, normalized.expiresAt,
          state, timestamp, purpose === 'reconcile' ? timestamp : null);
      this.#event(row.computer_id, row.id, purpose === 'reconcile' ? 'operation.authorization_consumed' : 'operation.authorization_recorded', {
        approvalId: normalized.approvalId, approverId: normalized.approverId, subjectId: row.subject_id,
        projectId: row.project_id, actionDigest: `sha256:${authorizationDigest}`, policyVersion: request.policyVersion,
        purpose, generation: row.generation, expiresAt: normalized.expiresAt,
      }, timestamp);
      return mapOperationAuthorization(this.#db.prepare('SELECT * FROM operation_authorizations WHERE approval_id = ?').get(normalized.approvalId));
    });
  }

  listOperationAuthorizations(operationId) {
    this.#assertOpen();
    if (!isId(operationId)) throw new EnvironmentStoreError('operation_id_invalid');
    return this.#db.prepare('SELECT * FROM operation_authorizations WHERE operation_id = ? ORDER BY recorded_at, approval_id')
      .all(operationId).map(mapOperationAuthorization);
  }

  recordProviderOutcome(operationId, { observed, errorCode, outcome = 'unknown' } = {}) {
    this.#assertOpen();
    if (!isId(operationId)) throw new EnvironmentStoreError('operation_id_invalid');
    if (!['unknown', 'not_applied'].includes(outcome)) throw new EnvironmentStoreError('provider_outcome_invalid');
    if (errorCode !== undefined && !/^[a-z0-9_]{1,64}$/.test(errorCode)) errorCode = 'provider_outcome_unknown';
    const timestamp = this.#timestamp();
    return this.#transaction(() => {
      const record = this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId);
      if (!record) throw new EnvironmentStoreError('operation_unknown');
      if (record.status !== 'REQUESTED' && record.status !== 'UNKNOWN') return this.#getOperationRow(record);
      const computer = this.#db.prepare('SELECT generation FROM computers WHERE id = ?').get(record.computer_id);
      const generationCurrent = computer?.generation === record.generation;
      let state = generationCurrent && outcome === 'not_applied' ? record.observed_state : 'unknown';
      let status = generationCurrent && outcome === 'not_applied' ? 'FAILED' : 'UNKNOWN';
      let observedAt = generationCurrent && outcome === 'not_applied' ? record.observed_at : null;
      if (observed) {
        try {
          const valid = validateObservedEnvironment(observed, { computerId: record.computer_id, providerId: record.provider_id });
          if (generationCurrent && valid.generation === record.generation) {
            state = valid.state;
            observedAt = valid.observedAt;
            if (record.action === 'inspect' || state === record.desired_state) status = 'SUCCEEDED';
            else status = 'UNKNOWN';
          }
        } catch { status = 'UNKNOWN'; state = 'unknown'; observedAt = null; }
      }

      this.#db.prepare('UPDATE operations SET status = ?, observed_state = ?, observed_at = ?, error_code = ?, updated_at = ? WHERE id = ?')
        .run(status, state, observedAt, status === 'SUCCEEDED' ? null : (errorCode ?? null), timestamp, operationId);
      this.#db.prepare('UPDATE computers SET observed_state = ?, observed_at = ?, row_version = row_version + 1 WHERE id = ? AND generation = ?')
        .run(state, observedAt, record.computer_id, record.generation);
      this.#event(record.computer_id, operationId, `operation.${status.toLowerCase()}`, {
        action: record.action, status, desiredState: record.desired_state, observedState: state,
        generation: record.generation, ...(errorCode && status !== 'SUCCEEDED' ? { errorCode } : {}),
      }, timestamp, 'provider');
      return this.#getOperationRow(this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId));
    });
  }

  recordReconciliation(operationId, observed, { errorCode } = {}) {
    this.#assertOpen();
    if (!isId(operationId)) throw new EnvironmentStoreError('operation_id_invalid');
    if (errorCode !== undefined && !/^[a-z0-9_]{1,64}$/.test(errorCode)) errorCode = 'provider_outcome_unknown';
    const timestamp = this.#timestamp();
    return this.#transaction(() => {
      const record = this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId);
      if (!record) throw new EnvironmentStoreError('operation_unknown');
      if (record.status !== 'UNKNOWN') return this.#getOperationRow(record);
      const computer = this.#db.prepare('SELECT generation FROM computers WHERE id = ?').get(record.computer_id);
      if (computer?.generation !== record.generation) {
        if (record.error_code !== 'stale_generation') {
          this.#db.prepare("UPDATE operations SET error_code = 'stale_generation', updated_at = ? WHERE id = ?").run(timestamp, operationId);
          this.#event(record.computer_id, operationId, 'operation.reconciliation_fenced', {
            action: record.action, status: 'UNKNOWN', generation: record.generation,
          }, timestamp, 'provider');
        }
        return this.#getOperationRow(this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId));
      }
      let state = 'unknown';
      let observedAt = null;
      try {
        const valid = validateObservedEnvironment(observed, { computerId: record.computer_id, providerId: record.provider_id });
        if (valid.generation === record.generation) { state = valid.state; observedAt = valid.observedAt; }
      } catch { /* malformed or missing provider observations preserve UNKNOWN */ }
      const status = (record.action === 'inspect' || state === record.desired_state) && state !== 'unknown' ? 'SUCCEEDED' : 'UNKNOWN';
      this.#db.prepare('UPDATE operations SET status = ?, observed_state = ?, observed_at = ?, error_code = ?, updated_at = ? WHERE id = ?')
        .run(status, state, observedAt, status === 'SUCCEEDED' ? null : (errorCode ?? record.error_code), timestamp, operationId);
      this.#db.prepare('UPDATE computers SET observed_state = ?, observed_at = ?, row_version = row_version + 1 WHERE id = ? AND generation = ?')
        .run(state, observedAt, record.computer_id, record.generation);
      this.#event(record.computer_id, operationId, status === 'SUCCEEDED' ? 'operation.reconciled' : 'operation.unknown', {
        action: record.action, status, desiredState: record.desired_state, observedState: state, generation: record.generation,
      }, timestamp, 'provider');
      return this.#getOperationRow(this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId));
    });
  }

  getOperation(operationId) {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId);
    return row ? this.#getOperationRow(row) : null;
  }

  /**
   * Resolve a bounded Broker reference against the authoritative journal immediately before dispatch.
   * The caller must authenticate the OS transport separately; this method does not authenticate callers.
   */
  resolveBrokerDispatch(input) {
    this.#assertOpen();
    let request;
    try { request = validateBrokerRequest(input); }
    catch { throw new EnvironmentStoreError('broker_request_invalid'); }
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(request.operationId);
      if (!row) throw new EnvironmentStoreError('operation_unknown');
      let journalOperation;
      try { journalOperation = validateEnvironmentOperation(JSON.parse(row.request_json)); }
      catch { throw new EnvironmentStoreError('operation_journal_corrupt'); }
      if (journalOperation.operationId !== row.id || journalOperation.idempotencyKey !== row.idempotency_key
        || digestOperation(journalOperation) !== row.action_digest) {
        throw new EnvironmentStoreError('operation_journal_corrupt');
      }
      try {
        assertBrokerRequestMatchesAuthorization(request, {
          operationId: row.id, expectedGeneration: row.generation, actionDigest: `sha256:${row.action_digest}`,
        });
      } catch { throw new EnvironmentStoreError('broker_authorization_mismatch'); }
      if (row.status !== 'REQUESTED') throw new EnvironmentStoreError('operation_not_dispatchable');
      const computer = this.#db.prepare('SELECT generation FROM computers WHERE id = ?').get(row.computer_id);
      if (computer?.generation !== row.generation) throw new EnvironmentStoreError('stale_generation');
      const lease = this.#db.prepare('SELECT * FROM leases WHERE id = ?').get(row.lease_id);
      if (!lease || lease.subject_id !== row.subject_id || lease.project_id !== row.project_id
        || lease.task_id !== row.task_id || lease.run_id !== row.run_id || lease.computer_id !== row.computer_id
        || lease.generation !== row.generation || lease.state !== 'ACTIVE'
        || Date.parse(lease.expires_at) <= Date.parse(this.#timestamp())) {
        throw new EnvironmentStoreError('lease_not_authorized');
      }
      const timestamp = this.#timestamp();
      const authorization = this.#db.prepare(`SELECT * FROM operation_authorizations
        WHERE operation_id = ? AND purpose = 'execute'`).get(row.id);
      if (!authorization || authorization.state !== 'RECORDED'
        || authorization.operation_idempotency_key !== row.idempotency_key
        || authorization.subject_id !== row.subject_id || authorization.project_id !== row.project_id
        || authorization.policy_version !== journalOperation.policyVersion
        || authorization.action_digest !== row.action_digest) {
        throw new EnvironmentStoreError('broker_authorization_missing');
      }
      if (Date.parse(authorization.expires_at) <= Date.parse(timestamp)) {
        throw new EnvironmentStoreError('authorization_expired');
      }
      // Claim dispatch durably before the external side effect. A crash after this point is UNKNOWN and must reconcile, never replay.
      this.#assertCapacity(2);
      this.#db.prepare("UPDATE operation_authorizations SET state = 'CONSUMED', consumed_at = ? WHERE approval_id = ? AND state = 'RECORDED'")
        .run(timestamp, authorization.approval_id);
      this.#event(row.computer_id, row.id, 'operation.authorization_consumed', {
        approvalId: authorization.approval_id, approverId: authorization.approver_id,
        subjectId: row.subject_id, projectId: row.project_id, actionDigest: `sha256:${row.action_digest}`,
        policyVersion: journalOperation.policyVersion, purpose: 'execute', generation: row.generation,
        expiresAt: authorization.expires_at,
      }, timestamp);
      this.#db.prepare("UPDATE operations SET status = 'UNKNOWN', updated_at = ? WHERE id = ? AND status = 'REQUESTED'")
        .run(timestamp, row.id);
      this.#event(row.computer_id, row.id, 'operation.dispatch_authorized', {
        action: row.action, generation: row.generation, status: 'UNKNOWN',
      }, timestamp);
      return Object.freeze({ ...journalOperation });
    });
  }

  /** Resolve a reconciliation inspect only from the UNKNOWN journal row and its consumed inspect grant. */
  resolveBrokerInspection({ operationId, approvalId } = {}) {
    this.#assertOpen();
    if (!isId(operationId) || !isId(approvalId)) throw new EnvironmentStoreError('broker_inspection_invalid');
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId);
      if (!row) throw new EnvironmentStoreError('operation_unknown');
      if (row.status !== 'UNKNOWN') throw new EnvironmentStoreError('operation_not_reconcilable');
      let journalOperation;
      try { journalOperation = validateEnvironmentOperation(JSON.parse(row.request_json)); }
      catch { throw new EnvironmentStoreError('operation_journal_corrupt'); }
      if (journalOperation.operationId !== row.id || journalOperation.idempotencyKey !== row.idempotency_key
        || digestOperation(journalOperation) !== row.action_digest) {
        throw new EnvironmentStoreError('operation_journal_corrupt');
      }
      const { spec: _spec, ...requestWithoutSpec } = journalOperation;
      const inspectOperation = validateEnvironmentOperation({ ...requestWithoutSpec, action: 'inspect' });
      const inspectDigest = digestOperation(inspectOperation);
      const authorization = this.#db.prepare(`SELECT * FROM operation_authorizations
        WHERE approval_id = ? AND operation_id = ? AND purpose = 'reconcile'`).get(approvalId, row.id);
      if (!authorization || authorization.state !== 'CONSUMED' || !authorization.consumed_at
        || authorization.operation_idempotency_key !== row.idempotency_key
        || authorization.subject_id !== row.subject_id || authorization.project_id !== row.project_id
        || authorization.policy_version !== journalOperation.policyVersion
        || authorization.action_digest !== inspectDigest) {
        throw new EnvironmentStoreError('broker_inspection_unauthorized');
      }
      if (Date.parse(authorization.expires_at) <= Date.parse(this.#timestamp())) {
        throw new EnvironmentStoreError('authorization_expired');
      }
      const computer = this.#db.prepare('SELECT generation FROM computers WHERE id = ?').get(row.computer_id);
      if (computer?.generation !== row.generation) throw new EnvironmentStoreError('stale_generation');
      return inspectOperation;
    });
  }

  getComputer(computerId) {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM computers WHERE id = ?').get(computerId);
    return row ? mapComputer(row) : null;
  }

  listComputers(projectId) {
    this.#assertOpen();
    if (!isId(projectId)) throw new TypeError('invalid_project_id');
    return this.#db.prepare('SELECT * FROM computers WHERE project_id = ? ORDER BY id').all(projectId).map((row) => {
      const lease = this.#db.prepare("SELECT id, state FROM leases WHERE computer_id = ? AND state <> 'RELEASED'").get(row.id);
      return Object.freeze({ ...mapComputer(row), leaseAvailable: !lease });
    });
  }

  getLease(leaseId) {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId);
    return row ? mapLease(row) : null;
  }

  listEvents(aggregateId, { limit = 1000 } = {}) {
    this.#assertOpen();
    if (!isId(aggregateId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError('invalid_event_query');
    return this.#db.prepare('SELECT * FROM events WHERE aggregate_id = ? ORDER BY aggregate_seq LIMIT ?').all(aggregateId, limit)
      .map(mapEvent);
  }

  /** Read a stable per-aggregate event page; callers must snapshot/resync on a retained-history gap. */
  readEventPage(aggregateId, { afterSequence = 0, limit = 1000 } = {}) {
    this.#assertOpen();
    if (!isId(aggregateId) || !Number.isSafeInteger(afterSequence) || afterSequence < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError('invalid_event_query');
    this.#db.exec('BEGIN');
    try {
      const bounds = this.#db.prepare('SELECT MIN(aggregate_seq) AS first_sequence, MAX(aggregate_seq) AS head_sequence FROM events WHERE aggregate_id = ?')
        .get(aggregateId);
      const headSequence = bounds.head_sequence ?? 0;
      if (afterSequence > headSequence) throw new EnvironmentStoreError('event_cursor_ahead');
      if (bounds.first_sequence !== null && afterSequence < bounds.first_sequence - 1) {
        this.#db.exec('COMMIT');
        return Object.freeze({
          status: 'RESYNC_REQUIRED', events: Object.freeze([]), afterSequence,
          firstAvailableSequence: bounds.first_sequence, headSequence,
        });
      }
      const rows = this.#db.prepare('SELECT * FROM events WHERE aggregate_id = ? AND aggregate_seq > ? ORDER BY aggregate_seq LIMIT ?')
        .all(aggregateId, afterSequence, limit + 1);
      if (rows.length > 0 && rows[0].aggregate_seq !== afterSequence + 1) {
        this.#db.exec('COMMIT');
        return Object.freeze({
          status: 'RESYNC_REQUIRED', events: Object.freeze([]), afterSequence,
          firstAvailableSequence: rows[0].aggregate_seq, headSequence,
        });
      }
      for (let index = 1; index < rows.length; index += 1) {
        if (rows[index].aggregate_seq !== rows[index - 1].aggregate_seq + 1) {
          this.#db.exec('COMMIT');
          return Object.freeze({
            status: 'RESYNC_REQUIRED', events: Object.freeze([]), afterSequence,
            firstAvailableSequence: rows[index].aggregate_seq, headSequence,
          });
        }
      }
      const hasMore = rows.length > limit;
      const events = rows.slice(0, limit).map(mapEvent);
      const nextSequence = events.at(-1)?.sequence ?? afterSequence;
      this.#db.exec('COMMIT');
      return Object.freeze({ status: 'OK', events: Object.freeze(events), nextSequence, headSequence, hasMore });
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve the original read failure */ }
      throw error;
    }
  }

  /** Resolve only Host-owned, active Lease context for issuing a Guest event-ingress capability. */
  resolveActiveGuestSessionContext({ computerId, runId } = {}) {
    this.#assertOpen();
    if (!isId(computerId) || !isId(runId)) throw new EnvironmentStoreError('guest_session_context_invalid');
    const timestamp = this.#timestamp();
    const row = this.#db.prepare(`SELECT c.id AS computer_id, c.generation, l.id AS lease_id, l.run_id, l.expires_at
      FROM computers c JOIN leases l ON l.computer_id = c.id
      WHERE c.id = ? AND l.run_id = ? AND l.project_id = c.project_id
        AND l.generation = c.generation AND l.state = 'ACTIVE' AND l.expires_at > ?
      ORDER BY l.created_at DESC LIMIT 1`).get(computerId, runId, timestamp);
    if (!row) throw new EnvironmentStoreError('guest_session_context_unavailable');
    return Object.freeze({
      computerId: row.computer_id, leaseId: row.lease_id, runId: row.run_id,
      generation: row.generation, leaseExpiresAt: row.expires_at,
    });
  }

  /** Persist a validated but untrusted Guest claim after the caller authenticates its transport. */
  recordGuestEvent(input) {
    this.#assertOpen();
    let event;
    try { event = validateGuestEvent(input); }
    catch { throw new EnvironmentStoreError('guest_event_invalid'); }
    const timestamp = this.#timestamp();
    const digest = createHash('sha256').update(JSON.stringify(sortObject(event))).digest('hex');
    return this.#transaction(() => {
      const computer = this.#db.prepare('SELECT generation FROM computers WHERE id = ?').get(event.computerId);
      if (!computer) throw new EnvironmentStoreError('guest_computer_unknown');
      if (computer.generation !== event.generation) throw new EnvironmentStoreError('guest_generation_stale');
      const lease = this.#db.prepare(`SELECT state, expires_at FROM leases
        WHERE computer_id = ? AND run_id = ? AND generation = ? ORDER BY created_at DESC LIMIT 1`)
        .get(event.computerId, event.runId, event.generation);
      if (!lease || lease.state !== 'ACTIVE' || Date.parse(lease.expires_at) <= Date.parse(timestamp)) {
        throw new EnvironmentStoreError('guest_lease_inactive');
      }
      const byMessage = this.#db.prepare('SELECT * FROM guest_event_receipts WHERE message_id = ?').get(event.messageId);
      if (byMessage) {
        if (byMessage.computer_id !== event.computerId || byMessage.run_id !== event.runId
          || byMessage.generation !== event.generation || byMessage.sequence !== event.sequence || byMessage.payload_digest !== digest) {
          throw new EnvironmentStoreError('guest_message_id_conflict');
        }
        return Object.freeze({ status: 'DUPLICATE', messageId: event.messageId, sequence: event.sequence });
      }
      const last = this.#db.prepare(`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM guest_event_receipts
        WHERE computer_id = ? AND run_id = ? AND generation = ?`)
        .get(event.computerId, event.runId, event.generation).sequence;
      if (event.sequence <= last) throw new EnvironmentStoreError('guest_event_replayed');
      if (event.sequence !== last + 1) throw new EnvironmentStoreError('guest_event_sequence_mismatch');
      this.#assertGuestEventCapacity(2);
      this.#assertCapacity(2);
      this.#db.prepare(`INSERT INTO guest_event_receipts
        (message_id, computer_id, run_id, generation, sequence, payload_digest, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(event.messageId, event.computerId, event.runId, event.generation, event.sequence, digest, timestamp);
      const { provenance, ...payload } = event;
      this.#event(event.computerId, null, `guest.${event.eventType}`, payload, timestamp, provenance);
      return Object.freeze({ status: 'ACCEPTED', messageId: event.messageId, sequence: event.sequence });
    });
  }

  /**
   * The durable approved-operation journal (the port in approved-operation-journal.mjs, same semantics as createMemoryFlowJournal). `advance` is one
   * transaction whose UPDATE is the compare-and-set (`revision = ? AND phase IN (...)`); the store owns `revision` (0 on begin, +1 per advance) and a patch cannot set
   * `revision` or `operationId`. A rejection (FlowJournalError 'conflict' / 'unknown_operation' / 'invalid_record', or a store error) means nothing was written.
   */
  flowJournal() {
    this.#assertOpen();
    this.#flowJournal ??= Object.freeze({
      begin: (record) => this.#flowBegin(record),
      advance: (operationId, expectedRevision, from, patch) => this.#flowAdvance(operationId, expectedRevision, from, patch),
      get: (operationId) => this.#flowGet(operationId),
    });
    return this.#flowJournal;
  }

  #flowBegin(record) {
    const body = flowBody(record, true);
    return this.#transaction(() => {
      const stored = this.#db.prepare('SELECT * FROM flow_operations WHERE operation_id = ?').get(record.operationId);
      if (stored) return Object.freeze({ created: false, record: mapFlowRecord(stored) });
      this.#assertCapacity(1);
      this.#db.prepare('INSERT INTO flow_operations (operation_id, revision, phase, record_schema, record_json) VALUES (?, 0, ?, ?, ?)')
        .run(record.operationId, record.phase, FLOW_RECORD_SCHEMA, body);
      return Object.freeze({ created: true, record: mapFlowRecord(this.#db.prepare('SELECT * FROM flow_operations WHERE operation_id = ?').get(record.operationId)) });
    });
  }

  #flowAdvance(operationId, expectedRevision, from, patch) {
    if (!isFlowId(operationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Array.isArray(from) || from.length < 1
      || from.length > FLOW_MAX_FROM_PHASES || !from.every(isFlowId) || !isPlainObject(patch)) throw new FlowJournalError('invalid_record');
    const changes = Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'operationId' && key !== 'revision'));
    if ('phase' in changes && !isFlowId(changes.phase)) throw new FlowJournalError('invalid_record');
    return this.#transaction(() => {
      const stored = this.#db.prepare('SELECT * FROM flow_operations WHERE operation_id = ?').get(operationId);
      if (!stored) throw new FlowJournalError('unknown_operation');
      const merged = { ...mapFlowRecord(stored), ...changes };
      for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]; // JSON has no undefined: a patch value of undefined removes the field
      const result = this.#db.prepare(`UPDATE flow_operations SET revision = revision + 1, phase = ?, record_json = ?
        WHERE operation_id = ? AND revision = ? AND phase IN (${from.map(() => '?').join(', ')})`)
        .run(merged.phase, flowBody(merged, false), operationId, expectedRevision, ...from);
      if (result.changes !== 1) throw new FlowJournalError('conflict');
      return mapFlowRecord(this.#db.prepare('SELECT * FROM flow_operations WHERE operation_id = ?').get(operationId));
    });
  }

  #flowGet(operationId) {
    this.#assertOpen();
    if (!isFlowId(operationId)) throw new FlowJournalError('invalid_record');
    const stored = this.#db.prepare('SELECT * FROM flow_operations WHERE operation_id = ?').get(operationId);
    return stored ? mapFlowRecord(stored) : null;
  }

  diagnostics() {
    this.#assertOpen();
    return Object.freeze({
      journalMode: String(this.#db.prepare('PRAGMA journal_mode').get()?.journal_mode).toLowerCase(),
      synchronous: this.#db.prepare('PRAGMA synchronous').get()?.synchronous,
      foreignKeys: this.#db.prepare('PRAGMA foreign_keys').get()?.foreign_keys,
      walAutoCheckpointPages: this.#db.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint,
      walJournalSizeLimitBytes: this.#db.prepare('PRAGMA journal_size_limit').get()?.journal_size_limit,
      maxRecords: this.#maxRecords,
      maxGuestRecords: this.#maxGuestRecords,
      schemaVersion: this.#db.prepare('PRAGMA user_version').get()?.user_version,
    });
  }

  /** Run one non-blocking WAL checkpoint; readers may defer frames without losing journal data. */
  checkpointWal() {
    this.#assertOpen();
    let row;
    try { row = this.#db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get(); }
    catch { throw new EnvironmentStoreError('wal_checkpoint_failed'); }
    const logFrames = row?.log;
    const checkpointedFrames = row?.checkpointed;
    const busy = row?.busy;
    if (![logFrames, checkpointedFrames, busy].every(Number.isSafeInteger)) {
      throw new EnvironmentStoreError('wal_checkpoint_failed');
    }
    const remainingFrames = logFrames < 0 ? 0 : Math.max(0, logFrames - checkpointedFrames);
    return Object.freeze({
      mode: 'PASSIVE', busy: busy !== 0,
      logFrames: Math.max(0, logFrames), checkpointedFrames: Math.max(0, checkpointedFrames), remainingFrames,
    });
  }

  close() {
    if (this.#closed) return;
    try { this.#db.close(); }
    finally {
      this.#closed = true;
      this.#recoveryOwnerLock?.release();
    }
  }

  #getOperationRow(row) {
    return {
      operationId: row.id, idempotencyKey: row.idempotency_key, subjectId: row.subject_id, projectId: row.project_id,
      taskId: row.task_id, runId: row.run_id, computerId: row.computer_id, providerId: row.provider_id, leaseId: row.lease_id,
      generation: row.generation, action: row.action, actionDigest: row.action_digest, status: row.status,
      desiredState: row.desired_state, observedState: row.observed_state, observedAt: row.observed_at,
      errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at,
      request: JSON.parse(row.request_json),
    };
  }

  #computerGeneration(computerId) {
    const row = this.#db.prepare('SELECT generation FROM computers WHERE id = ?').get(computerId);
    if (!row) throw new EnvironmentStoreError('computer_unknown');
    return row.generation;
  }

  #event(aggregateId, operationId, eventType, payload, timestamp, provenance = 'control_plane') {
    if (!['control_plane', 'provider', 'untrusted_guest'].includes(provenance)) throw new EnvironmentStoreError('event_provenance_invalid');
    this.#assertCapacity(1);
    const seq = this.#db.prepare('SELECT COALESCE(MAX(aggregate_seq), 0) + 1 AS seq FROM events WHERE aggregate_id = ?').get(aggregateId).seq;
    this.#db.prepare(`INSERT INTO events (id, aggregate_id, aggregate_seq, operation_id, event_type, schema_version, provenance, payload_json, recorded_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(randomUUID(), aggregateId, seq, operationId, eventType, provenance, JSON.stringify(payload), timestamp);
  }

  #assertCapacity(additional) {
    const count = this.#db.prepare('SELECT (SELECT COUNT(*) FROM computers) + (SELECT COUNT(*) FROM operations) + (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM leases) + (SELECT COUNT(*) FROM guest_event_receipts) + (SELECT COUNT(*) FROM operation_authorizations) + (SELECT COUNT(*) FROM flow_operations) AS count').get().count;
    if (count + additional > this.#maxRecords) throw new EnvironmentStoreError('store_capacity_exceeded');
  }

  #assertGuestEventCapacity(additional) {
    const count = this.#db.prepare(`SELECT (SELECT COUNT(*) FROM guest_event_receipts)
      + (SELECT COUNT(*) FROM events WHERE provenance = 'untrusted_guest') AS count`).get().count;
    if (count + additional > this.#maxGuestRecords) throw new EnvironmentStoreError('guest_event_capacity');
  }

  #assertProjectQuota(projectId, reservation, quota, leaseId) {
    const active = this.#db.prepare("SELECT computer_id, reservation_json, quota_json FROM leases WHERE project_id = ? AND state <> 'RELEASED' AND id <> ?")
      .all(projectId, leaseId);
    let vcpu = 0;
    let memoryMiB = 0;
    let diskGiB = 0;
    for (const row of active) {
      if (!row.reservation_json || !row.quota_json) throw new EnvironmentStoreError('project_usage_unknown');
      if (row.quota_json !== JSON.stringify(quota)) throw new EnvironmentStoreError('project_quota_conflict');
      const resources = JSON.parse(row.reservation_json).resources;
      vcpu += resources.vcpu;
      memoryMiB += resources.memoryMiB;
      diskGiB += resources.diskGiB;
    }
    if (active.length + 1 > quota.maxComputers || vcpu + reservation.resources.vcpu > quota.vcpu
      || memoryMiB + reservation.resources.memoryMiB > quota.memoryMiB
      || diskGiB + reservation.resources.diskGiB > quota.diskGiB) throw new EnvironmentStoreError('project_quota_exceeded');
  }

  #timestamp() {
    const value = this.#now();
    if (!isTimestamp(value)) throw new EnvironmentStoreError('clock_invalid');
    return new Date(Date.parse(value)).toISOString();
  }

  #transaction(callback) {
    this.#assertOpen();
    try { return inTransaction(this.#db, callback); }
    catch (error) {
      if (error instanceof EnvironmentStoreError || error instanceof EnvironmentProviderError || error instanceof FlowJournalError) throw error;
      throw new EnvironmentStoreError('store_transaction_failed');
    }
  }

  #assertOpen() { if (this.#closed) throw new EnvironmentStoreError('store_closed'); }
}

// The CHECK on `action` is part of the table, so a new action name needs a table rebuild (v6: 'retire', 'purge', issue #115). One definition serves the first create and the rebuild.
function operationsTableSql(name) {
  return `CREATE TABLE ${name} (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, subject_id TEXT NOT NULL, project_id TEXT NOT NULL,
        task_id TEXT NOT NULL, run_id TEXT NOT NULL, computer_id TEXT NOT NULL REFERENCES computers(id),
        provider_id TEXT NOT NULL, lease_id TEXT NOT NULL REFERENCES leases(id), generation INTEGER NOT NULL CHECK(generation >= 1),
        action TEXT NOT NULL CHECK(action IN ('create','inspect','start','stop','destroy','retire','purge')),
        action_digest TEXT NOT NULL, request_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('REQUESTED','UNKNOWN','SUCCEEDED','FAILED')),
        desired_state TEXT, observed_state TEXT NOT NULL, observed_at TEXT, error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(subject_id, project_id, idempotency_key)
      ) STRICT;`;
}

const OPERATION_COLUMNS = 'id, idempotency_key, subject_id, project_id, task_id, run_id, computer_id, provider_id, lease_id, generation, action, action_digest, request_json, status, desired_state, observed_state, observed_at, error_code, created_at, updated_at';

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  if (!Number.isSafeInteger(version) || version > SCHEMA_VERSION) throw new EnvironmentStoreError('database_schema_newer');
  if (version === SCHEMA_VERSION) return;
  if (![0, 1, 2, 3, 4, 5].includes(version)) throw new EnvironmentStoreError('database_schema_unsupported');
  // The rebuild drops a table other tables point at, so foreign keys must be off while it runs (PRAGMA foreign_keys cannot change inside a transaction); they are checked and switched back on after.
  const rebuildsOperations = version >= 1;
  if (rebuildsOperations) db.exec('PRAGMA foreign_keys = OFF');
  try {
    migrateInTransaction(db, version, rebuildsOperations);
  } finally {
    if (rebuildsOperations) db.exec('PRAGMA foreign_keys = ON');
  }
}

function migrateInTransaction(db, version, rebuildsOperations) {
  inTransaction(db, () => {
    if (version === 0) db.exec(`
      CREATE TABLE computers (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, provider_id TEXT NOT NULL,
        desired_state TEXT NOT NULL, observed_state TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation >= 1),
        row_version INTEGER NOT NULL CHECK(row_version >= 1), observed_at TEXT, capacity_json TEXT
      ) STRICT;
      CREATE TABLE leases (
        id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
        computer_id TEXT NOT NULL REFERENCES computers(id), generation INTEGER NOT NULL CHECK(generation >= 1),
        expires_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('ACTIVE','EXPIRED','REVOKED','QUARANTINED','RELEASED')),
        created_at TEXT NOT NULL, reservation_json TEXT, quota_json TEXT
      ) STRICT;
      CREATE UNIQUE INDEX one_unreleased_lease_per_computer ON leases(computer_id) WHERE state <> 'RELEASED';
      ${operationsTableSql('operations')}
      CREATE TABLE events (
        id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, aggregate_seq INTEGER NOT NULL,
        operation_id TEXT REFERENCES operations(id), event_type TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        provenance TEXT NOT NULL CHECK(provenance IN ('control_plane','provider','untrusted_guest')),
        payload_json TEXT NOT NULL, recorded_at TEXT NOT NULL, UNIQUE(aggregate_id, aggregate_seq)
      ) STRICT;
      CREATE INDEX operations_computer_idx ON operations(computer_id, created_at);
      CREATE INDEX events_operation_idx ON events(operation_id, aggregate_seq);
    `);
    else if (version === 1) db.exec('ALTER TABLE computers ADD COLUMN capacity_json TEXT; ALTER TABLE leases ADD COLUMN reservation_json TEXT; ALTER TABLE leases ADD COLUMN quota_json TEXT;');
    if (version <= 2) db.exec(`CREATE TABLE guest_event_receipts (
      message_id TEXT PRIMARY KEY, computer_id TEXT NOT NULL REFERENCES computers(id), run_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation >= 1), sequence INTEGER NOT NULL CHECK(sequence >= 1),
      payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64), received_at TEXT NOT NULL,
      UNIQUE(computer_id, run_id, generation, sequence)
    ) STRICT;`);
    if (version <= 3) db.exec(`CREATE TABLE operation_authorizations (
      approval_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id),
      purpose TEXT NOT NULL CHECK(purpose IN ('execute','reconcile')),
      operation_idempotency_key TEXT NOT NULL, approver_id TEXT NOT NULL, subject_id TEXT NOT NULL, project_id TEXT NOT NULL,
      policy_version INTEGER NOT NULL CHECK(policy_version >= 1), action_digest TEXT NOT NULL CHECK(length(action_digest) = 64),
      expires_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('RECORDED','CONSUMED')),
      recorded_at TEXT NOT NULL, consumed_at TEXT
    ) STRICT;
    CREATE INDEX operation_authorizations_operation_idx ON operation_authorizations(operation_id, purpose, recorded_at);`);
    // v5: the durable approved-operation flow journal (approved-operation-journal.mjs). `revision` and `phase` are columns so the compare-and-set is one UPDATE ... WHERE;
    // the rest of the record is JSON. `phase` has no CHECK: a corrupt or future phase must be readable so the flow can report it instead of the store refusing to open.
    if (version <= 4) db.exec(`CREATE TABLE flow_operations (
      operation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 0), phase TEXT NOT NULL CHECK(length(phase) >= 1),
      record_schema INTEGER NOT NULL, record_json TEXT NOT NULL
    ) STRICT;`);
    // v6: 'retire' and 'purge' are accepted actions. A database created at v6 already has them; an older one gets its operations table rebuilt with the same rows.
    if (rebuildsOperations) {
      db.exec(`${operationsTableSql('operations_v6')}
        INSERT INTO operations_v6 (${OPERATION_COLUMNS}) SELECT ${OPERATION_COLUMNS} FROM operations;
        DROP TABLE operations;
        ALTER TABLE operations_v6 RENAME TO operations;
        CREATE INDEX operations_computer_idx ON operations(computer_id, created_at);`);
      if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new EnvironmentStoreError('database_schema_unsupported');
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

function inTransaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original transaction failure */ }
    throw error;
  }
}

function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isFlowId(value) { return typeof value === 'string' && value.length >= 1 && value.length <= 128; }

/** The JSON stored for a flow record: everything except the three columns (`operationId`, `revision`, `phase`), which stay the single source of truth. */
function flowBody(record, withIdentity) {
  if (!isPlainObject(record) || (withIdentity && (!isFlowId(record.operationId) || !isFlowId(record.phase)))) throw new FlowJournalError('invalid_record');
  const { operationId, revision, phase, ...rest } = record;
  try { return JSON.stringify(rest); } catch { throw new FlowJournalError('invalid_record'); }
}

function mapFlowRecord(row) {
  if (row.record_schema !== FLOW_RECORD_SCHEMA) throw new FlowJournalError('record_schema_unsupported');
  let body;
  try { body = JSON.parse(row.record_json); } catch { throw new FlowJournalError('record_corrupt'); }
  if (!isPlainObject(body)) throw new FlowJournalError('record_corrupt');
  return Object.freeze({ ...body, operationId: row.operation_id, revision: row.revision, phase: row.phase });
}

function mapComputer(row) {
  return Object.freeze({ computerId: row.id, projectId: row.project_id, providerId: row.provider_id,
    desiredState: row.desired_state, observedState: row.observed_state, generation: row.generation,
    rowVersion: row.row_version, observedAt: row.observed_at,
    capacity: row.capacity_json ? JSON.parse(row.capacity_json) : null });
}

function mapLease(row) {
  return Object.freeze({ leaseId: row.id, subjectId: row.subject_id, projectId: row.project_id, taskId: row.task_id,
    runId: row.run_id, computerId: row.computer_id, generation: row.generation, expiresAt: row.expires_at,
    state: row.state, createdAt: row.created_at,
    requirements: row.reservation_json ? JSON.parse(row.reservation_json) : null,
    quota: row.quota_json ? JSON.parse(row.quota_json) : null });
}

function mapEvent(row) {
  return { id: row.id, aggregateId: row.aggregate_id, sequence: row.aggregate_seq,
    operationId: row.operation_id, type: row.event_type, schemaVersion: row.schema_version,
    provenance: row.provenance, payload: JSON.parse(row.payload_json), recordedAt: row.recorded_at };
}

function mapOperationAuthorization(row) {
  return Object.freeze({
    approvalId: row.approval_id, operationId: row.operation_id, purpose: row.purpose,
    idempotencyKey: row.operation_idempotency_key, approverId: row.approver_id,
    subjectId: row.subject_id, projectId: row.project_id, policyVersion: row.policy_version,
    actionDigest: `sha256:${row.action_digest}`, expiresAt: row.expires_at,
    state: row.state, recordedAt: row.recorded_at, consumedAt: row.consumed_at,
  });
}

function normalizeOperationAuthorization(authorization, expected) {
  const keys = ['decision', 'approvalId', 'approverId', 'operationId', 'idempotencyKey', 'subjectId', 'projectId',
    'policyVersion', 'actionDigest', 'purpose', 'expiresAt'];
  let descriptors;
  try {
    if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)
      || Object.getPrototypeOf(authorization) !== Object.prototype || Object.getOwnPropertySymbols(authorization).length > 0
      || Object.keys(authorization).length !== keys.length) throw new Error('invalid_authorization');
    descriptors = Object.getOwnPropertyDescriptors(authorization);
  } catch { throw new EnvironmentStoreError('authorization_record_invalid'); }
  if (keys.some((key) => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new EnvironmentStoreError('authorization_record_invalid');
  }
  const grant = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  if (grant.decision !== 'approved' || !isId(grant.approvalId) || !isId(grant.approverId)
    || grant.operationId !== expected.operationId || grant.idempotencyKey !== expected.idempotencyKey
    || grant.subjectId !== expected.subjectId || grant.projectId !== expected.projectId
    || grant.policyVersion !== expected.policyVersion || grant.actionDigest !== expected.actionDigest
    || grant.purpose !== expected.purpose || typeof grant.expiresAt !== 'string') {
    throw new EnvironmentStoreError('authorization_record_mismatch');
  }
  const expiresAtMs = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= expected.nowMs) throw new EnvironmentStoreError('authorization_expired');
  if (!Number.isSafeInteger(expected.nowMs) || expiresAtMs > expected.nowMs + 5 * 60 * 1000) {
    throw new EnvironmentStoreError('authorization_record_invalid');
  }
  return Object.freeze({ ...grant, expiresAt: new Date(expiresAtMs).toISOString() });
}

function sameLease(row, expected) {
  return row.subject_id === expected.subjectId && row.project_id === expected.projectId && row.task_id === expected.taskId
    && row.run_id === expected.runId && row.computer_id === expected.computerId && row.expires_at === expected.expiresAt
    && row.reservation_json === expected.reservationJson && row.quota_json === expected.quotaJson;
}

function fitsCapacity(capacity, spec) {
  const supported = new Set(capacity.capabilities);
  return capacity.os === spec.os && capacity.architecture === spec.architecture
    && spec.capabilities.every((capability) => supported.has(capability))
    && capacity.networkProfileIds.includes(spec.networkProfileId)
    && capacity.securityProfileIds.includes(spec.securityProfileId)
    && capacity.resources.vcpu >= spec.resources.vcpu
    && capacity.resources.memoryMiB >= spec.resources.memoryMiB
    && capacity.resources.diskGiB >= spec.resources.diskGiB;
}

function digestOperation(operation) {
  const { operationId: _operationId, idempotencyKey: _idempotencyKey, ...payload } = operation;
  return createHash('sha256').update(JSON.stringify(sortObject(payload))).digest('hex');
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

function isId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }
function isTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function isWindowsUncPath(value) { return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value); }

function hasUnresolvedProviderMutation(db, computerId, generation) {
  return Boolean(db.prepare(`SELECT id FROM operations
    WHERE computer_id = ? AND generation = ?
      AND action IN ('create', 'start', 'stop', 'destroy', 'retire', 'purge')
      AND status IN ('REQUESTED', 'UNKNOWN')
    LIMIT 1`).get(computerId, generation));
}

async function acquireRecoveryOwnerLock(databasePath, verifyWindowsAcl) {
  const lockPath = `${databasePath}.recovery-owner`;
  const token = JSON.stringify({ magic: RECOVERY_OWNER_MAGIC, pid: process.pid, nonce: randomUUID() });
  let descriptor;
  try {
    descriptor = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR
      | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new EnvironmentStoreError('recovery_owner_locked');
    throw new EnvironmentStoreError('recovery_owner_lock_unavailable');
  }

  let identity;
  try {
    identity = fstatSync(descriptor);
    assertSingleLink(identity, 'recovery_owner_lock_hard_linked');
    assertPrivatePosixStorage(identity, 'recovery_owner_lock_permissions', 'file');
    writeFileSync(descriptor, token, 'utf8');
    fsyncSync(descriptor);
    await verifyAcl(verifyWindowsAcl, lockPath, 'file');
  } catch (error) {
    try { closeSync(descriptor); } catch { /* preserve the original failure */ }
    try {
      const current = lstatSync(lockPath);
      if (identity && current.dev === identity.dev && current.ino === identity.ino && readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath);
    } catch { /* preserve unexpected lock state for diagnosis */ }
    if (error instanceof EnvironmentStoreError || error instanceof RuntimeStorageAclError) throw error;
    throw new EnvironmentStoreError('recovery_owner_lock_unavailable');
  }

  let released = false;
  return Object.freeze({
    release() {
      if (released) return;
      closeSync(descriptor);
      const current = lstatSync(lockPath);
      if (current.dev !== identity.dev || current.ino !== identity.ino || readFileSync(lockPath, 'utf8') !== token) {
        throw new EnvironmentStoreError('recovery_owner_lock_changed');
      }
      unlinkSync(lockPath);
      released = true;
    },
  });
}

async function verifyAcl(verifyWindowsAcl, target, kind) {
  try { await verifyWindowsAcl(target, { kind }); }
  catch (error) {
    if (error instanceof RuntimeStorageAclError) throw error;
    throw new EnvironmentStoreError('database_acl_check_failed');
  }
}

async function assertNoRestoreMarker(databasePath) {
  const marker = await lstat(`${databasePath}.restore-incomplete`).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw new EnvironmentStoreError('restore_marker_check_failed');
  });
  if (marker) throw new EnvironmentStoreError('restore_incomplete_marker_present');
}

async function assertPrivateDatabaseFile(databasePath, verifyWindowsAcl, prefix) {
  let info;
  try { info = await lstat(databasePath); }
  catch { throw new EnvironmentStoreError(`${prefix}_file_invalid`); }
  if (!info.isFile() || info.isSymbolicLink()) throw new EnvironmentStoreError(`${prefix}_file_invalid`);
  assertSingleLink(info, `${prefix}_hard_linked_file`);
  assertPrivatePosixStorage(info, `${prefix}_file_permissions`, 'file');
  await verifyAcl(verifyWindowsAcl, databasePath, 'file');
}

async function createRestoreMarker(databasePath, verifyWindowsAcl) {
  const markerPath = `${databasePath}.restore-incomplete`;
  const token = `${RECOVERY_OWNER_MAGIC}_INCOMPLETE:${randomUUID()}\n`;
  let handle;
  try {
    handle = await open(markerPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(token, 'utf8');
    await handle.sync();
  } catch (error) {
    if (error?.code === 'EEXIST') throw new EnvironmentStoreError('restore_in_progress');
    throw new EnvironmentStoreError('restore_marker_create_failed');
  } finally { await handle?.close(); }
  await assertPrivateDatabaseFile(markerPath, verifyWindowsAcl, 'restore_marker');
  const identity = await lstat(markerPath);
  return Object.freeze({ markerPath, token, dev: identity.dev, ino: identity.ino });
}

async function releaseRestoreMarker(marker, verifyWindowsAcl) {
  let current;
  try { current = await lstat(marker.markerPath); }
  catch { throw new EnvironmentStoreError('restore_marker_changed'); }
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== marker.dev || current.ino !== marker.ino
    || await readFile(marker.markerPath, 'utf8').catch(() => null) !== marker.token) {
    throw new EnvironmentStoreError('restore_marker_changed');
  }
  await assertPrivateDatabaseFile(marker.markerPath, verifyWindowsAcl, 'restore_marker');
  try { await unlink(marker.markerPath); }
  catch { throw new EnvironmentStoreError('restore_marker_release_failed'); }
}

async function verifyStandaloneSnapshot(snapshotPath) {
  let db;
  try {
    db = new DatabaseSync(snapshotPath, { readOnly: true });
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').all().length !== 0
      || !Number.isSafeInteger(version) || version < 1 || version > SCHEMA_VERSION) {
      throw new EnvironmentStoreError('snapshot_integrity_failed');
    }
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
    const requiredTables = ['computers', 'leases', 'operations', 'events'];
    if (version >= 2) requiredTables.push('guest_event_receipts');
    if (version >= 4) requiredTables.push('operation_authorizations');
    if (version >= 5) requiredTables.push('flow_operations');
    if (!requiredTables.every((name) => tables.has(name))) {
      throw new EnvironmentStoreError('snapshot_schema_invalid');
    }
  } catch (error) {
    if (error instanceof EnvironmentStoreError) throw error;
    throw new EnvironmentStoreError('snapshot_invalid');
  } finally { db?.close(); }
}

function quoteSqliteString(value) { return value.replaceAll("'", "''"); }
