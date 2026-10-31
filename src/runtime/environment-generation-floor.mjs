// The Broker's own durable "generation floor" (issue #133, restore). For the Hyper-V prototype a VM's generation is the `generation` in its Notes, and a checkpoint restore brings back the Notes of the
// moment of the checkpoint (an OLDER or equal generation). If the Broker could not write the new generation afterwards (the Notes write fails, or the process dies between the restore and the write), the
// old generation would pass every check again. So BEFORE a restore is asked for, the Broker raises this floor to the generation the restore will issue; every operation then refuses a VM whose Notes
// generation is below the floor of its own VM id, until a successful restore brings the Notes up to it. The floor only ever rises (a lower value is ignored), and it is bound to the VM's own Hyper-V id:
// a different VM under the same computer id is not fenced by it.
//
// STORAGE and WHO WRITES: exactly like environment-retirement-journal.mjs: a SQLite file (node:sqlite) only Broker-side code holds; WAL + synchronous=FULL, so `raise` is durable when it returns;
// every change is one BEGIN IMMEDIATE transaction; a file that is not this schema is refused (`generation_floor_corrupt`). Without `filePath` it is in memory (tests; nothing then survives a crash).
// An unreadable floor must never mean "no floor": callers treat any thrown error as a refusal.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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
        db.prepare('CREATE TABLE floors (computer_id TEXT PRIMARY KEY, vm_id TEXT NOT NULL CHECK(length(vm_id) = 36), generation INTEGER NOT NULL CHECK(generation >= 1)) STRICT').run();
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
 * @returns {{ get(computerId: string): { vmId: string, generation: number } | null, raise(computerId: string, vmId: string, generation: number): void, close(): void }}
 */
export function createGenerationFloor({ filePath } = {}) {
  if (filePath !== undefined && (typeof filePath !== 'string' || filePath.length === 0)) throw new TypeError('invalid_generation_floor_options');
  const db = openDatabase(filePath);
  const wrap = (callback) => {
    try { return callback(); } catch (error) { throw error instanceof GenerationFloorError ? error : new GenerationFloorError('generation_floor_unavailable'); }
  };
  return {
    get(computerId) {
      if (typeof computerId !== 'string' || !ID_RE.test(computerId)) throw new GenerationFloorError('generation_floor_invalid');
      const row = wrap(() => db.prepare('SELECT vm_id, generation FROM floors WHERE computer_id = ?').get(computerId));
      return row ? Object.freeze({ vmId: row.vm_id, generation: Number(row.generation) }) : null;
    },

    /** Durable when it returns. Raises the floor of this computer's VM; the same VM never goes down, another VM id replaces the record. */
    raise(computerId, vmId, generation) {
      if (typeof computerId !== 'string' || !ID_RE.test(computerId) || typeof vmId !== 'string' || !VM_ID_RE.test(vmId) || !Number.isSafeInteger(generation) || generation < 1) {
        throw new GenerationFloorError('generation_floor_invalid');
      }
      wrap(() => {
        db.prepare('BEGIN IMMEDIATE').run();
        try {
          const row = db.prepare('SELECT vm_id, generation FROM floors WHERE computer_id = ?').get(computerId);
          if (!row || row.vm_id !== vmId) db.prepare('INSERT OR REPLACE INTO floors (computer_id, vm_id, generation) VALUES (?, ?, ?)').run(computerId, vmId, generation);
          else if (generation > Number(row.generation)) db.prepare('UPDATE floors SET generation = ? WHERE computer_id = ?').run(generation, computerId);
          db.prepare('COMMIT').run();
        } catch (error) {
          try { db.prepare('ROLLBACK').run(); } catch { /* keep the original failure */ }
          throw error;
        }
      });
    },

    close() { try { db.close(); } catch { /* already closed */ } },
  };
}
