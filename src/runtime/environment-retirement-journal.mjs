// The Broker's own record of retired environments (docs/architecture/approval-tiers.md, "A: reversible by default", issue #115 step 1).
//
// WHO WRITES IT: only Broker-side code (a Host Broker or its prototype) holds a journal object; the Control Plane is never given one. Nothing in an operation
// (environment.retire / environment.purge) carries a time, a deadline or a "scheduled" flag, and `retire()` takes none: the retirement time is read from the
// clock this journal was built with, and the deadline is that time + the retention this journal was built with (host configuration, default 7 days).
// So a Control Plane cannot create, edit, extend or back-date a record. A second retire of the same environment returns the stored record unchanged.
//
// IDENTITY: every record carries a random 128-bit `incarnationId` made here, at retire time, plus the project and the generation. The Broker also writes that id
// (and the project) into the VM's own Notes. Every later action on the record (requested purge, scheduled purge, destroy's clean-up) must find the same
// computerId + generation + projectId + incarnationId on the VM and in the record; a restored backup or a reused id carries another incarnation and is never matched.
//
// STORAGE: a SQLite database (node:sqlite, as the operation store). Every change is one BEGIN IMMEDIATE transaction that reads and then writes, so two journal
// objects (or two Broker processes) over the same file serialize and neither can overwrite the other's record from a stale snapshot. WAL + synchronous=FULL makes a
// commit, including a delete, durable before the call returns; there is no rename to lose. A file that is not this schema makes the journal refuse to open
// (`retirement_journal_corrupt`): no scheduled purge runs from a record nobody can vouch for. Without `filePath` the database is in memory (tests).
// The file must live where only the Broker can write it; protecting that path is the Broker host's job.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// TODO(#115): retention disk budget (when full: refuse new creates and retires, never purge early). Not implemented in step 1.
const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INCARNATION_RE = /^[a-f0-9]{32}$/;
const UNREACHABLE_CODES = new Set([5, 6, 8, 10, 13, 14]);

export class RetirementJournalError extends Error {
  constructor(code) { super(code); this.name = 'RetirementJournalError'; this.code = code; }
}

const isId = (value) => typeof value === 'string' && ID_RE.test(value);
const isMs = (value) => Number.isSafeInteger(value) && value >= 0;
const isIncarnation = (value) => typeof value === 'string' && INCARNATION_RE.test(value);

function toRecord(row) {
  const record = Object.freeze({
    computerId: row.computer_id, projectId: row.project_id, generation: row.generation,
    incarnationId: row.incarnation_id, retiredAtMs: row.retired_at_ms, deadlineMs: row.deadline_ms,
  });
  if (!isId(record.computerId) || !isId(record.projectId) || !Number.isSafeInteger(record.generation) || record.generation < 1
    || !isIncarnation(record.incarnationId) || !isMs(record.retiredAtMs) || !isMs(record.deadlineMs) || record.deadlineMs <= record.retiredAtMs) {
    throw new RetirementJournalError('retirement_journal_corrupt');
  }
  return record;
}

function openDatabase(filePath) {
  let db;
  try {
    db = new DatabaseSync(filePath ?? ':memory:');
    db.prepare(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`).run();
    if (filePath !== undefined) {
      const mode = db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
      if (String(mode).toLowerCase() !== 'wal') throw new RetirementJournalError('retirement_journal_unavailable');
    }
    db.prepare('PRAGMA synchronous = FULL').run();
    // First creation and the version check are one immediate transaction, so two openers cannot both create the schema.
    db.prepare('BEGIN IMMEDIATE').run();
    try {
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version === 0) {
        const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table'").get().n;
        if (tables !== 0) throw new RetirementJournalError('retirement_journal_corrupt'); // some other database
        db.prepare(`CREATE TABLE retirements (
          computer_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation >= 1),
          incarnation_id TEXT NOT NULL CHECK(length(incarnation_id) = 32), retired_at_ms INTEGER NOT NULL CHECK(retired_at_ms >= 0),
          deadline_ms INTEGER NOT NULL CHECK(deadline_ms > retired_at_ms)
        ) STRICT`).run();
        db.prepare(`PRAGMA user_version = ${SCHEMA_VERSION}`).run();
      }
      else if (version !== SCHEMA_VERSION
        || db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'retirements'").get().n !== 1) {
        throw new RetirementJournalError('retirement_journal_corrupt');
      }
      db.prepare('COMMIT').run();
    } catch (error) {
      try { db.prepare('ROLLBACK').run(); } catch { /* preserve the original failure */ }
      throw error;
    }
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* already unusable */ }
    if (error instanceof RetirementJournalError) throw error;
    // SQLite result codes (low byte): busy, locked, read-only, I/O error, full, cannot open = the store is not reachable; anything else = what is there is not our database.
    throw new RetirementJournalError(UNREACHABLE_CODES.has(Number(error?.errcode) & 0xff) ? 'retirement_journal_unavailable' : 'retirement_journal_corrupt');
  }
}

/**
 * @param {{ filePath?: string, nowMs?: () => number, retentionMs?: number }} [options] host configuration, never operation input
 * @returns {{ nowMs(): number, retire(identity: { computerId: string, projectId: string, generation: number }): object, get(computerId: string): object | null,
 *   list(): object[], expired(atMs: number): object[], remove(computerId: string, incarnationId: string): boolean, close(): void }}
 */
export function createRetirementJournal({ filePath, nowMs = Date.now, retentionMs = DEFAULT_RETENTION_MS } = {}) {
  if ((filePath !== undefined && (typeof filePath !== 'string' || filePath.length === 0)) || typeof nowMs !== 'function'
    || !Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new TypeError('invalid_retirement_journal_options');
  const db = openDatabase(filePath);
  const clock = () => {
    const value = nowMs();
    if (!isMs(value)) throw new RetirementJournalError('retirement_clock_invalid');
    return value;
  };
  // One read-modify-write unit. A journal error from the callback passes through; anything SQLite throws is a failed write (nothing is half-applied: it rolls back).
  const transaction = (callback) => {
    try {
      db.prepare('BEGIN IMMEDIATE').run();
      try {
        const result = callback();
        db.prepare('COMMIT').run();
        return result;
      } catch (error) {
        try { db.prepare('ROLLBACK').run(); } catch { /* preserve the original failure */ }
        throw error;
      }
    } catch (error) {
      throw error instanceof RetirementJournalError ? error : new RetirementJournalError('retirement_journal_write_failed');
    }
  };
  const read = (callback) => {
    try { return callback(); } catch (error) { throw error instanceof RetirementJournalError ? error : new RetirementJournalError('retirement_journal_unavailable'); }
  };
  const list = () => read(() => db.prepare('SELECT * FROM retirements ORDER BY deadline_ms, computer_id').all().map(toRecord));

  return {
    nowMs: clock,

    /** Record a retirement at the journal's own time with a new incarnation id. An already retired environment keeps its original record (deadline and id included). */
    retire({ computerId, projectId, generation } = {}) {
      if (!isId(computerId) || !isId(projectId) || !Number.isSafeInteger(generation) || generation < 1) throw new RetirementJournalError('retirement_invalid');
      return transaction(() => {
        const row = db.prepare('SELECT * FROM retirements WHERE computer_id = ?').get(computerId);
        if (row) {
          const existing = toRecord(row);
          if (existing.projectId !== projectId || existing.generation !== generation) throw new RetirementJournalError('retirement_conflict');
          return existing;
        }
        const retiredAtMs = clock();
        const record = Object.freeze({ computerId, projectId, generation, incarnationId: randomBytes(16).toString('hex'), retiredAtMs, deadlineMs: retiredAtMs + retentionMs });
        db.prepare('INSERT INTO retirements (computer_id, project_id, generation, incarnation_id, retired_at_ms, deadline_ms) VALUES (?, ?, ?, ?, ?, ?)')
          .run(record.computerId, record.projectId, record.generation, record.incarnationId, record.retiredAtMs, record.deadlineMs);
        return record;
      });
    },

    get(computerId) {
      const row = read(() => db.prepare('SELECT * FROM retirements WHERE computer_id = ?').get(computerId));
      return row ? toRecord(row) : null;
    },

    list,

    /** Records whose own deadline has passed at `atMs` (inclusive). */
    expired(atMs) {
      if (!isMs(atMs)) throw new RetirementJournalError('retirement_clock_invalid');
      return list().filter((record) => record.deadlineMs <= atMs);
    },

    /** Delete exactly this incarnation's record; a record of another incarnation under the same id is left alone. Durable when it returns. */
    remove(computerId, incarnationId) {
      if (!isId(computerId) || !isIncarnation(incarnationId)) throw new RetirementJournalError('retirement_invalid');
      return transaction(() => db.prepare('DELETE FROM retirements WHERE computer_id = ? AND incarnation_id = ?').run(computerId, incarnationId).changes > 0);
    },

    close() { try { db.close(); } catch { /* already closed */ } },
  };
}

/**
 * The scheduled purge, shared by every Broker implementation. It reads only the Broker's own journal and a clock: it takes no operation, receipt, flag or time from the
 * Control Plane. `purgeRecord(record)` is the Broker's own removal and answers 'purged', 'already_missing' or 'skipped' (the environment no longer matches the record:
 * not applied, the record is kept); a record is dropped from the journal after the first two. One failing environment does not stop the others.
 * @param {{ journal: ReturnType<typeof createRetirementJournal>, atMs?: number | Date, purgeRecord: (record: object) => Promise<string> | string }} input
 * @returns {Promise<readonly object[]>} one `{ computerId, outcome, code? }` per expired record
 */
export async function purgeExpired({ journal, atMs, purgeRecord }) {
  const at = atMs === undefined ? journal.nowMs() : atMs instanceof Date ? atMs.getTime() : atMs;
  const results = [];
  for (const record of journal.expired(at)) {
    try {
      const outcome = await purgeRecord(record);
      if (outcome === 'purged' || outcome === 'already_missing') journal.remove(record.computerId, record.incarnationId);
      results.push(Object.freeze({ computerId: record.computerId, outcome }));
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : 'provider_outcome_unknown';
      results.push(Object.freeze({ computerId: record.computerId, outcome: 'failed', code }));
    }
  }
  return Object.freeze(results);
}
