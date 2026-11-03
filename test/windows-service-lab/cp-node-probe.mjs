// Lab probe (test-only): runs as a CHILD of the Control Plane stand-in service in the disposable VM (lab-control-plane-service.ps1, check cp1_node_sqlite), so it measures what the
// service identity can do with node.exe and node:sqlite. Usage: node cp-node-probe.mjs <folder>
// It opens a journal the way src/runtime/sqlite-operation-store.mjs does (DatabaseSync, the same PRAGMAs: foreign_keys, busy_timeout, WAL, synchronous FULL, quick_check), writes a
// row in a transaction, closes, opens again, reads the row back, and reports the files SQLite left in <folder> (the -wal and -shm files need the folder to be writable).
// Prints ONE JSON line: { probe: "cp", id: "node-sqlite", ok, step, ... }. It never throws: a failure names the step that failed and the error's name and code.
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const folder = process.argv[2];
const line = { probe: 'cp', id: 'node-sqlite', ok: false, step: 'start', nodeVersion: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch };

function describeFolder(dir) {
  try { return readdirSync(dir).sort().map((name) => ({ name, bytes: statSync(path.join(dir, name)).size })); } catch { return []; }
}

try {
  if (!folder) throw new Error('usage: cp-node-probe.mjs <folder>');
  line.step = 'import_node_sqlite';
  const { DatabaseSync } = await import('node:sqlite');
  line.step = 'make_folder';
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'cp-journal.sqlite');
  line.step = 'open';
  let db = new DatabaseSync(file);
  line.step = 'pragmas';
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  line.journalMode = String(db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode).toLowerCase();
  db.exec('PRAGMA synchronous = FULL');
  line.quickCheck = db.prepare('PRAGMA quick_check(1)').get()?.quick_check;
  line.sqliteVersion = db.prepare('select sqlite_version() as v').get()?.v;
  line.step = 'write';
  db.exec('create table if not exists operations (id text primary key, state text not null, updated integer not null) strict');
  db.exec('begin immediate');
  db.prepare('insert into operations (id, state, updated) values (?, ?, ?)').run('lab-op-1', 'UNKNOWN', 1);
  db.exec('commit');
  line.step = 'read_same_connection';
  line.readSameConnection = db.prepare('select state from operations where id = ?').get('lab-op-1')?.state === 'UNKNOWN';
  db.close();
  line.step = 'reopen';
  db = new DatabaseSync(file);
  line.reopenedRow = db.prepare('select state, updated from operations where id = ?').get('lab-op-1')?.state ?? null;
  line.step = 'checkpoint';
  line.walCheckpoint = db.prepare('pragma wal_checkpoint(passive)').get() ?? null;
  db.close();
  line.files = describeFolder(folder);
  line.ok = line.journalMode === 'wal' && line.quickCheck === 'ok' && line.readSameConnection === true && line.reopenedRow === 'UNKNOWN';
  line.step = 'done';
} catch (error) {
  line.error = { name: error?.name ?? 'Error', code: error?.code ?? null, errcode: error?.errcode ?? null, message: String(error?.message ?? error).slice(0, 200) };
  line.files = folder && existsSync(folder) ? describeFolder(folder) : [];
}
console.log(JSON.stringify(line));
