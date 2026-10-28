import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, lstat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { assertPrivatePosixStorage, assertSingleLink } from './audit-journal.mjs';
import { assertPrivateWindowsAcl, RuntimeStorageAclError } from './windows-acl.mjs';
import { EnvironmentProviderError, validateEnvironmentOperation, validateObservedEnvironment } from './environment-provider.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_RECORDS = 20_000;
const HARD_MAX_RECORDS = 100_000;
const DESIRED_STATES = Object.freeze({ create: 'off', inspect: null, start: 'running', stop: 'off', destroy: 'missing' });

export class EnvironmentStoreError extends Error {
  constructor(code) { super(code); this.name = 'EnvironmentStoreError'; this.code = code; }
}

/** Open a private, single-host SQLite WAL store. This module is not exposed through Observer routes. */
export async function openSqliteEnvironmentStore(databasePath, {
  verifyWindowsAcl = assertPrivateWindowsAcl,
  now = () => new Date().toISOString(),
  maxRecords = DEFAULT_MAX_RECORDS,
  DatabaseImpl = Database,
} = {}) {
  if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath) || path.resolve(databasePath) !== databasePath
    || databasePath === path.parse(databasePath).root || (process.platform === 'win32' && isWindowsUncPath(databasePath))) {
    throw new EnvironmentStoreError('database_path_invalid');
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 32 || maxRecords > HARD_MAX_RECORDS) throw new TypeError('invalid_store_capacity');
  if (typeof now !== 'function' || typeof DatabaseImpl !== 'function') throw new TypeError('invalid_store_options');
  const directory = path.dirname(databasePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) throw new EnvironmentStoreError('database_directory_invalid');
  assertPrivatePosixStorage(directoryInfo, 'database_directory_permissions', 'directory');
  await verifyAcl(verifyWindowsAcl, directory, 'directory');

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
  try {
    db = new DatabaseImpl(databasePath, { timeout: 5000 });
    const after = await lstat(databasePath);
    if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new EnvironmentStoreError('database_changed_during_open');
    }
    assertSingleLink(after, 'database_hard_linked_file');
    assertPrivatePosixStorage(after, 'database_file_permissions', 'file');
    await verifyAcl(verifyWindowsAcl, databasePath, 'file');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const mode = db.pragma('journal_mode = WAL', { simple: true });
    if (String(mode).toLowerCase() !== 'wal') throw new EnvironmentStoreError('wal_mode_unavailable');
    db.pragma('synchronous = FULL');
    const [integrity] = db.pragma('quick_check(1)');
    if (integrity?.quick_check !== 'ok') throw new EnvironmentStoreError('database_integrity_failed');
    migrate(db);
    const store = new SqliteEnvironmentOperationStore(db, { now, maxRecords });
    store.recoverInterruptedRequests();
    return store;
  } catch (error) {
    db?.close();
    if (error instanceof EnvironmentStoreError || error instanceof RuntimeStorageAclError) throw error;
    // Preserve the database and sidecars for diagnosis; never repair or delete uncertain state.
    throw new EnvironmentStoreError('database_open_failed');
  }
}

class SqliteEnvironmentOperationStore {
  #db;
  #now;
  #maxRecords;
  #closed = false;

  constructor(db, { now, maxRecords }) { this.#db = db; this.#now = now; this.#maxRecords = maxRecords; }

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

  registerComputer({ computerId, projectId, providerId }) {
    this.#assertOpen();
    if (![computerId, projectId, providerId].every(isId)) throw new EnvironmentStoreError('computer_registration_invalid');
    const timestamp = this.#timestamp();
    return this.#transaction(() => {
      this.#assertCapacity(2);
      const existing = this.#db.prepare('SELECT * FROM computers WHERE id = ?').get(computerId);
      if (existing) {
        if (existing.project_id !== projectId || existing.provider_id !== providerId) throw new EnvironmentStoreError('computer_id_conflict');
        return mapComputer(existing);
      }
      this.#db.prepare(`INSERT INTO computers (id, project_id, provider_id, desired_state, observed_state, generation, row_version, observed_at)
        VALUES (?, ?, ?, 'missing', 'missing', 1, 1, ?)`)
        .run(computerId, projectId, providerId, timestamp);
      this.#event(computerId, null, 'computer.registered', { projectId, providerId, generation: 1 }, timestamp);
      return mapComputer(this.#db.prepare('SELECT * FROM computers WHERE id = ?').get(computerId));
    });
  }

  /** Reserve one exclusive, generation-fenced Lease; expired/revoked Leases continue holding capacity. */
  reserveLease({ leaseId, subjectId, projectId, taskId, runId, computerId, expiresAt }) {
    this.#assertOpen();
    if (![leaseId, subjectId, projectId, taskId, runId, computerId].every(isId) || !isTimestamp(expiresAt)) {
      throw new EnvironmentStoreError('lease_request_invalid');
    }
    const timestamp = this.#timestamp();
    const normalizedExpiry = new Date(Date.parse(expiresAt)).toISOString();
    if (Date.parse(normalizedExpiry) <= Date.parse(timestamp)) throw new EnvironmentStoreError('lease_expiry_invalid');
    return this.#transaction(() => {
      this.#assertCapacity(2);
      const prior = this.#db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId);
      if (prior) {
        if (!sameLease(prior, { subjectId, projectId, taskId, runId, computerId, expiresAt: normalizedExpiry })) throw new EnvironmentStoreError('lease_id_conflict');
        return mapLease(prior);
      }
      const computer = this.#db.prepare('SELECT * FROM computers WHERE id = ?').get(computerId);
      if (!computer || computer.project_id !== projectId) throw new EnvironmentStoreError('computer_not_owned');
      const outstanding = this.#db.prepare(`SELECT id FROM leases WHERE computer_id = ? AND state <> 'RELEASED' LIMIT 1`).get(computerId);
      if (outstanding) throw new EnvironmentStoreError('computer_already_leased');
      const generation = computer.generation + 1;
      this.#db.prepare('UPDATE computers SET generation = ?, row_version = row_version + 1 WHERE id = ? AND generation = ?')
        .run(generation, computerId, computer.generation);
      this.#db.prepare(`INSERT INTO leases (id, subject_id, project_id, task_id, run_id, computer_id, generation, expires_at, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`)
        .run(leaseId, subjectId, projectId, taskId, runId, computerId, generation, normalizedExpiry, timestamp);
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

  /** Revoke authority and advance the computer epoch; this does not stop any guest/process. */
  revokeLease(leaseId, { reason = 'revoked' } = {}) {
    this.#assertOpen();
    if (!isId(leaseId) || !['revoked', 'restore', 'policy_changed'].includes(reason)) throw new EnvironmentStoreError('lease_revoke_invalid');
    const timestamp = this.#timestamp();
    return this.#transaction(() => {
      const lease = this.#db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId);
      if (!lease) throw new EnvironmentStoreError('lease_unknown');
      if (lease.state === 'RELEASED' || lease.state === 'REVOKED') return { lease: mapLease(lease), generation: this.#computerGeneration(lease.computer_id) };
      const computer = this.#db.prepare('SELECT * FROM computers WHERE id = ?').get(lease.computer_id);
      const generation = computer.generation + 1;
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
        this.#db.prepare("UPDATE operations SET error_code = 'stale_generation', updated_at = ? WHERE id = ?").run(timestamp, operationId);
        this.#event(record.computer_id, operationId, 'operation.reconciliation_fenced', {
          action: record.action, status: 'UNKNOWN', generation: record.generation,
        }, timestamp, 'provider');
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

  getComputer(computerId) {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM computers WHERE id = ?').get(computerId);
    return row ? mapComputer(row) : null;
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
      .map((row) => ({ id: row.id, aggregateId: row.aggregate_id, sequence: row.aggregate_seq, operationId: row.operation_id,
        type: row.event_type, schemaVersion: row.schema_version, provenance: row.provenance, payload: JSON.parse(row.payload_json), recordedAt: row.recorded_at }));
  }

  diagnostics() {
    this.#assertOpen();
    return Object.freeze({
      journalMode: String(this.#db.pragma('journal_mode', { simple: true })).toLowerCase(),
      synchronous: this.#db.pragma('synchronous', { simple: true }),
      foreignKeys: this.#db.pragma('foreign_keys', { simple: true }),
      schemaVersion: this.#db.pragma('user_version', { simple: true }),
    });
  }

  close() {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
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
    const count = this.#db.prepare('SELECT (SELECT COUNT(*) FROM computers) + (SELECT COUNT(*) FROM operations) + (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM leases) AS count').get().count;
    if (count + additional > this.#maxRecords) throw new EnvironmentStoreError('store_capacity_exceeded');
  }

  #timestamp() {
    const value = this.#now();
    if (!isTimestamp(value)) throw new EnvironmentStoreError('clock_invalid');
    return new Date(Date.parse(value)).toISOString();
  }

  #transaction(callback) {
    this.#assertOpen();
    try { return this.#db.transaction(callback).immediate(); }
    catch (error) {
      if (error instanceof EnvironmentStoreError || error instanceof EnvironmentProviderError) throw error;
      throw new EnvironmentStoreError('store_transaction_failed');
    }
  }

  #assertOpen() { if (this.#closed) throw new EnvironmentStoreError('store_closed'); }
}

function migrate(db) {
  const version = db.pragma('user_version', { simple: true });
  if (!Number.isSafeInteger(version) || version > SCHEMA_VERSION) throw new EnvironmentStoreError('database_schema_newer');
  if (version === SCHEMA_VERSION) return;
  if (version !== 0) throw new EnvironmentStoreError('database_schema_unsupported');
  db.transaction(() => {
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
      CREATE INDEX operations_computer_idx ON operations(computer_id, created_at);
      CREATE INDEX events_operation_idx ON events(operation_id, aggregate_seq);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }).immediate();
}

function mapComputer(row) {
  return Object.freeze({ computerId: row.id, projectId: row.project_id, providerId: row.provider_id,
    desiredState: row.desired_state, observedState: row.observed_state, generation: row.generation,
    rowVersion: row.row_version, observedAt: row.observed_at });
}

function mapLease(row) {
  return Object.freeze({ leaseId: row.id, subjectId: row.subject_id, projectId: row.project_id, taskId: row.task_id,
    runId: row.run_id, computerId: row.computer_id, generation: row.generation, expiresAt: row.expires_at,
    state: row.state, createdAt: row.created_at });
}

function sameLease(row, expected) {
  return row.subject_id === expected.subjectId && row.project_id === expected.projectId && row.task_id === expected.taskId
    && row.run_id === expected.runId && row.computer_id === expected.computerId && row.expires_at === expected.expiresAt;
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

async function verifyAcl(verifyWindowsAcl, target, kind) {
  try { await verifyWindowsAcl(target, { kind }); }
  catch (error) {
    if (error instanceof RuntimeStorageAclError) throw error;
    throw new EnvironmentStoreError('database_acl_check_failed');
  }
}
