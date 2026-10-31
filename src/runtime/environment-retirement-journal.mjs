// The Broker's own record of retired environments (docs/architecture/approval-tiers.md, "A: reversible by default", issue #115 step 1).
//
// WHO WRITES IT: only Broker-side code (a Host Broker or its prototype) holds a journal object; the Control Plane is never given one. Nothing in an operation
// (environment.retire / environment.purge) carries a time, a deadline or a "scheduled" flag, and `retire()` takes none: the retirement time is read from the
// clock this journal was built with, and the deadline is that time + the retention this journal was built with (host configuration, default 7 days).
// So a Control Plane cannot create, edit, extend or back-date a record. A second retire of the same environment returns the stored record unchanged.
//
// DURABILITY: with `filePath` every change is written to a temp file, flushed, and renamed over the record file before `retire()` / `remove()` returns, and the
// file is read back when the journal is built (a Broker restart). A file that cannot be read or does not match the record shape makes construction throw
// `retirement_journal_corrupt` (fail closed: no scheduled purge runs from a record nobody can vouch for). Without `filePath` the journal is in memory only (tests).
// The file must live where only the Broker can write it; protecting that path is the Broker host's job (this module only refuses malformed content).
//
// Identity of a record: computerId + generation (the incarnation the Broker knows today). Binding it to a Broker-attested incarnation id is step 2 of #115.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';

export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// TODO(#115): retention disk budget (when full: refuse new creates and retires, never purge early). Not implemented in step 1.
const FILE_VERSION = 1;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RECORD_KEYS = ['computerId', 'projectId', 'generation', 'retiredAtMs', 'deadlineMs'];

export class RetirementJournalError extends Error {
  constructor(code) { super(code); this.name = 'RetirementJournalError'; this.code = code; }
}

const isId = (value) => typeof value === 'string' && ID_RE.test(value);
const isMs = (value) => Number.isSafeInteger(value) && value >= 0;

function validRecord(record) {
  return record !== null && typeof record === 'object' && !Array.isArray(record)
    && Object.keys(record).length === RECORD_KEYS.length && RECORD_KEYS.every((key) => Object.hasOwn(record, key))
    && isId(record.computerId) && isId(record.projectId) && Number.isSafeInteger(record.generation) && record.generation >= 1
    && isMs(record.retiredAtMs) && isMs(record.deadlineMs) && record.deadlineMs > record.retiredAtMs;
}

function loadRecords(filePath) {
  let text;
  try { text = readFileSync(filePath, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new RetirementJournalError('retirement_journal_corrupt');
  }
  let data;
  try { data = JSON.parse(text); }
  catch { throw new RetirementJournalError('retirement_journal_corrupt'); }
  if (data === null || typeof data !== 'object' || data.v !== FILE_VERSION || !Array.isArray(data.records)
    || data.records.some((record) => !validRecord(record))
    || new Set(data.records.map((record) => record.computerId)).size !== data.records.length) {
    throw new RetirementJournalError('retirement_journal_corrupt');
  }
  return data.records;
}

function persist(filePath, records) {
  const temp = `${filePath}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'w');
    writeSync(fd, JSON.stringify({ v: FILE_VERSION, records }));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, filePath);
  } catch {
    if (fd !== undefined) try { closeSync(fd); } catch { /* the write already failed */ }
    try { unlinkSync(temp); } catch { /* nothing to clean up */ }
    throw new RetirementJournalError('retirement_journal_write_failed');
  }
}

/**
 * @param {{ filePath?: string, nowMs?: () => number, retentionMs?: number }} [options] host configuration, never operation input
 * @returns {{ nowMs(): number, retire(identity: { computerId: string, projectId: string, generation: number }): object, get(computerId: string): object | null,
 *   list(): object[], expired(atMs: number): object[], remove(computerId: string): boolean }}
 */
export function createRetirementJournal({ filePath, nowMs = Date.now, retentionMs = DEFAULT_RETENTION_MS } = {}) {
  if ((filePath !== undefined && (typeof filePath !== 'string' || filePath.length === 0)) || typeof nowMs !== 'function'
    || !Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new TypeError('invalid_retirement_journal_options');
  const records = new Map((filePath === undefined ? [] : loadRecords(filePath)).map((record) => [record.computerId, Object.freeze({ ...record })]));
  const clock = () => {
    const value = nowMs();
    if (!isMs(value)) throw new RetirementJournalError('retirement_clock_invalid');
    return value;
  };
  const list = () => [...records.values()].sort((a, b) => a.deadlineMs - b.deadlineMs || a.computerId.localeCompare(b.computerId));
  const save = (next) => { if (filePath !== undefined) persist(filePath, [...next.values()]); };

  return {
    nowMs: clock,

    /** Record a retirement at the journal's own time. An already retired environment keeps its original record (deadline included). */
    retire({ computerId, projectId, generation } = {}) {
      if (!isId(computerId) || !isId(projectId) || !Number.isSafeInteger(generation) || generation < 1) throw new RetirementJournalError('retirement_invalid');
      const existing = records.get(computerId);
      if (existing) {
        if (existing.projectId !== projectId || existing.generation !== generation) throw new RetirementJournalError('retirement_conflict');
        return existing;
      }
      const retiredAtMs = clock();
      const record = Object.freeze({ computerId, projectId, generation, retiredAtMs, deadlineMs: retiredAtMs + retentionMs });
      const next = new Map(records).set(computerId, record);
      save(next); // durable before the caller reports the retirement
      records.set(computerId, record);
      return record;
    },

    get(computerId) { return records.get(computerId) ?? null; },

    list,

    /** Records whose own deadline has passed at `atMs` (inclusive). */
    expired(atMs) {
      if (!isMs(atMs)) throw new RetirementJournalError('retirement_clock_invalid');
      return list().filter((record) => record.deadlineMs <= atMs);
    },

    remove(computerId) {
      if (!records.has(computerId)) return false;
      const next = new Map(records);
      next.delete(computerId);
      save(next);
      records.delete(computerId);
      return true;
    },
  };
}

/**
 * The scheduled purge, shared by every Broker implementation. It reads only the Broker's own journal and a clock: it takes no operation, receipt, flag or time from the
 * Control Plane. `purgeRecord(record)` is the Broker's own removal and answers 'purged', 'already_missing' or 'skipped' (the environment no longer matches the record);
 * a record is dropped from the journal after the first two. One failing environment does not stop the others.
 * @param {{ journal: ReturnType<typeof createRetirementJournal>, atMs?: number | Date, purgeRecord: (record: object) => Promise<string> | string }} input
 * @returns {Promise<readonly object[]>} one `{ computerId, outcome, code? }` per expired record
 */
export async function purgeExpired({ journal, atMs, purgeRecord }) {
  const at = atMs === undefined ? journal.nowMs() : atMs instanceof Date ? atMs.getTime() : atMs;
  const results = [];
  for (const record of journal.expired(at)) {
    try {
      const outcome = await purgeRecord(record);
      if (outcome === 'purged' || outcome === 'already_missing') journal.remove(record.computerId);
      results.push(Object.freeze({ computerId: record.computerId, outcome }));
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : 'provider_outcome_unknown';
      results.push(Object.freeze({ computerId: record.computerId, outcome: 'failed', code }));
    }
  }
  return Object.freeze(results);
}
