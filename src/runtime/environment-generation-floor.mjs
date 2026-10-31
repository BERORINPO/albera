// The Broker's own durable "generation floor" (issue #133, restore). For the Hyper-V prototype a VM's generation is the `generation` in its Notes, and a checkpoint restore brings back the Notes of the
// moment of the checkpoint (an OLDER or equal generation). If the Broker could not write the new generation afterwards (the Notes write fails, or the process dies between the restore and the write), the
// old generation would pass every check again. So BEFORE a restore is asked for, the Broker raises this floor to the generation the restore will issue; every operation then refuses a VM whose Notes
// generation is below the floor of its own VM id, until a successful restore brings the Notes up to it. The floor is bound to the VM's own Hyper-V id: a different VM under the same computer id is not fenced by it.
// PENDING vs COMMITTED: a raise is first PENDING. It fences exactly like a committed floor (so a crash or an unknown outcome leaves the VM fenced), but the Broker can WITHDRAW it when the restore op
// answers definitely "not applied" (it refused before changing anything, e.g. there is no checkpoint): a refused restore must not brick the VM. A successful restore COMMITS it. A committed floor only
// ever rises. `get` reports the effective floor: the higher of the two. A pending raise is shared by every attempt that asks for the same generation, each with its own TOKEN; `withdraw` gives up one
// attempt's hold and the raise goes away only when the LAST holder has withdrawn (an attempt that crashed or whose outcome is unknown never withdraws, so it keeps the VM fenced).
//
// STORAGE and WHO WRITES: exactly like environment-retirement-journal.mjs: a SQLite file (node:sqlite) only Broker-side code holds; WAL + synchronous=FULL, so a change is durable when it returns;
// every change is one BEGIN IMMEDIATE transaction; a file that is not this schema is refused (`generation_floor_corrupt`). Without `filePath` it is in memory (tests; nothing then survives a crash).
// An unreadable floor must never mean "no floor": callers treat any thrown error as a refusal.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;
const VM_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class GenerationFloorError extends Error {
  constructor(code) { super(code); this.name = 'GenerationFloorError'; this.code = code; }
}

function openDatabase(filePath) {
  let db;
  try {
    db = new DatabaseSync(filePath ?? ':memory:');
    db.prepare(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`).run();
    if (filePath !== undefined) db.prepare('PRAGMA journal_mode = WAL').get();
    db.prepare('PRAGMA synchronous = FULL').run();
    db.prepare('BEGIN IMMEDIATE').run();
    try {
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version === 0) {
        if (db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table'").get().n !== 0) throw new GenerationFloorError('generation_floor_corrupt');
        // generation = the committed floor (0 = none yet); pending_generation = a raise a restore has asked for and not finished; holders = JSON array of the raise tokens of every attempt that
        // asked for exactly that pending generation and has not yet answered "not applied" (empty exactly when pending_generation is NULL)
        db.prepare(`CREATE TABLE floors (computer_id TEXT PRIMARY KEY, vm_id TEXT NOT NULL CHECK(length(vm_id) = 36), generation INTEGER NOT NULL CHECK(generation >= 0),
          pending_generation INTEGER CHECK(pending_generation IS NULL OR pending_generation >= 1), holders TEXT NOT NULL DEFAULT '[]') STRICT`).run();
        db.prepare(`PRAGMA user_version = ${SCHEMA_VERSION}`).run();
      }
      else if (version !== SCHEMA_VERSION || db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'floors'").get().n !== 1) {
        throw new GenerationFloorError('generation_floor_corrupt');
      }
      db.prepare('COMMIT').run();
    } catch (error) {
      try { db.prepare('ROLLBACK').run(); } catch { /* keep the original failure */ }
      throw error;
    }
    return db;
  } catch (error) {
    try { db?.close(); } catch { /* unusable anyway */ }
    throw error instanceof GenerationFloorError ? error : new GenerationFloorError('generation_floor_unavailable');
  }
}

/**
 * @param {{ filePath?: string }} [options] host configuration, never operation input
 * @returns {{ get(computerId: string): { vmId: string, generation: number } | null, raise(computerId: string, vmId: string, generation: number, token: string): void,
 *   commit(computerId: string, vmId: string, generation: number): void, withdraw(computerId: string, vmId: string, generation: number, token: string): void, close(): void }}
 */
export function createGenerationFloor({ filePath } = {}) {
  if (filePath !== undefined && (typeof filePath !== 'string' || filePath.length === 0)) throw new TypeError('invalid_generation_floor_options');
  const db = openDatabase(filePath);
  const wrap = (callback) => {
    try { return callback(); } catch (error) { throw error instanceof GenerationFloorError ? error : new GenerationFloorError('generation_floor_unavailable'); }
  };
  // `token` is checked only where one is given (raise, withdraw): a unique id of one restore attempt.
  const checkedKey = (computerId, vmId, generation, ...token) => {
    if (typeof computerId !== 'string' || !ID_RE.test(computerId) || typeof vmId !== 'string' || !VM_ID_RE.test(vmId) || !Number.isSafeInteger(generation) || generation < 1
      || (token.length > 0 && (typeof token[0] !== 'string' || !TOKEN_RE.test(token[0])))) {
      throw new GenerationFloorError('generation_floor_invalid');
    }
  };
  const holdersOf = (row) => {
    let holders;
    try { holders = JSON.parse(row.holders); } catch { throw new GenerationFloorError('generation_floor_corrupt'); }
    if (!Array.isArray(holders) || !holders.every((held) => typeof held === 'string')) throw new GenerationFloorError('generation_floor_corrupt');
    return holders;
  };
  // One BEGIN IMMEDIATE transaction: read this computer's row, let `change` modify it.
  const inTransaction = (computerId, change) => wrap(() => {
    db.prepare('BEGIN IMMEDIATE').run();
    try {
      change(db.prepare('SELECT vm_id, generation, pending_generation, holders FROM floors WHERE computer_id = ?').get(computerId));
      db.prepare('COMMIT').run();
    } catch (error) {
      try { db.prepare('ROLLBACK').run(); } catch { /* keep the original failure */ }
      throw error;
    }
  });
  const pendingOf = (row) => (row.pending_generation === null ? 0 : Number(row.pending_generation));
  return {
    get(computerId) {
      if (typeof computerId !== 'string' || !ID_RE.test(computerId)) throw new GenerationFloorError('generation_floor_invalid');
      const row = wrap(() => db.prepare('SELECT vm_id, generation, pending_generation FROM floors WHERE computer_id = ?').get(computerId));
      return row ? Object.freeze({ vmId: row.vm_id, generation: Math.max(Number(row.generation), pendingOf(row)) }) : null;
    },

    /**
     * Durable when it returns. Records `generation` as the PENDING floor of this computer's VM (it fences at once) on behalf of the attempt that holds `token` (unique per attempt).
     * Attempts that ask for the SAME pending generation share it: each is a holder, and the pending raise goes away only when every holder has withdrawn (see `withdraw`). A higher generation
     * folds the lower pending one into the committed floor (its holders can no longer withdraw it). Another VM id replaces the record. A generation at or below what is already recorded is ignored.
     */
    raise(computerId, vmId, generation, token) {
      checkedKey(computerId, vmId, generation, token);
      inTransaction(computerId, (row) => {
        if (!row || row.vm_id !== vmId) {
          db.prepare("INSERT OR REPLACE INTO floors (computer_id, vm_id, generation, pending_generation, holders) VALUES (?, ?, 0, ?, ?)").run(computerId, vmId, generation, JSON.stringify([token]));
          return;
        }
        if (generation <= Number(row.generation) || generation < pendingOf(row)) return; // never lower
        if (generation === pendingOf(row)) {
          const holders = holdersOf(row);
          if (!holders.includes(token)) db.prepare('UPDATE floors SET holders = ? WHERE computer_id = ?').run(JSON.stringify([...holders, token]), computerId);
          return;
        }
        db.prepare('UPDATE floors SET generation = ?, pending_generation = ?, holders = ? WHERE computer_id = ?').run(Math.max(Number(row.generation), pendingOf(row)), generation, JSON.stringify([token]), computerId);
      });
    },

    /** The restore succeeded: this pending raise (whoever holds it) becomes committed (a no-op when it is not the pending one). */
    commit(computerId, vmId, generation) {
      checkedKey(computerId, vmId, generation);
      inTransaction(computerId, (row) => {
        if (row?.vm_id === vmId && pendingOf(row) === generation) db.prepare("UPDATE floors SET generation = ?, pending_generation = NULL, holders = '[]' WHERE computer_id = ?").run(Math.max(Number(row.generation), generation), computerId);
      });
    },

    /**
     * The restore op of the attempt holding `token` answered definitely "not applied": that attempt gives up its hold. The pending raise goes away only when it was the LAST holder, because every
     * other holder (a concurrent attempt, or an earlier one that crashed or whose outcome was unknown) may yet restore. A wrong token, another generation or VM, and a committed floor: nothing changes.
     */
    withdraw(computerId, vmId, generation, token) {
      checkedKey(computerId, vmId, generation, token);
      inTransaction(computerId, (row) => {
        if (row?.vm_id !== vmId || pendingOf(row) !== generation) return;
        const holders = holdersOf(row);
        if (!holders.includes(token)) return;
        const rest = holders.filter((held) => held !== token);
        if (rest.length > 0) db.prepare('UPDATE floors SET holders = ? WHERE computer_id = ?').run(JSON.stringify(rest), computerId);
        else if (Number(row.generation) === 0) db.prepare('DELETE FROM floors WHERE computer_id = ?').run(computerId);
        else db.prepare("UPDATE floors SET pending_generation = NULL, holders = '[]' WHERE computer_id = ?").run(computerId);
      });
    },

    close() { try { db.close(); } catch { /* already closed */ } },
  };
}
