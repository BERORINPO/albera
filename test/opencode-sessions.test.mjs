import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createOpenCodeSessionsSource } from '../src/adapters/opencode-sessions-fs.mjs';
import { buildBoard } from '../src/core/board.mjs';
import { NOW } from './helpers/fixtures.mjs';

const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
const supported = major > 24 || (major === 24 && minor >= 4) || (major === 22 && minor >= 18);
const dirs = new Set();
after(async () => Promise.all([...dirs].map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pigeonholes-opencode-'));
  dirs.add(dir);
  const dbPath = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
  `);
  return { dir, dbPath, db };
}

test('OpenCode V2 SQLiteをread-onlyで読み、安全な状態イベントだけを同じBoardに出す', { skip: !supported }, async () => {
  const { dir, dbPath, db } = await fixture();
  const ids = ['secret-session-active', 'secret-session-done', 'secret-session-interrupted', 'secret-session-failed', 'secret-session-unknown'];
  const insertSession = db.prepare('INSERT INTO session_v2 VALUES (?, ?, NULL, ?, ?, NULL)');
  const insertEvent = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)');
  const at = NOW - 60_000;
  for (let i = 0; i < ids.length; i++) insertSession.run(ids[i], dir, at - i * 1000, at + 3000);
  insertEvent.run('m1', ids[0], 'user', 1, at, JSON.stringify({ prompt: 'PRIVATE-PROMPT', env: { TOKEN: 'PRIVATE-ENV' } }));
  insertEvent.run('m2', ids[0], 'assistant', 2, at + 500, JSON.stringify({ tool: 'PRIVATE-TOOL', output: 'PRIVATE-OUTPUT' }));
  insertEvent.run('m3', ids[1], 'idle', 3, at + 1000, JSON.stringify({ outcome: 'succeeded', message: 'PRIVATE-RESULT' }));
  insertEvent.run('m4', ids[2], 'idle', 4, at + 1500, JSON.stringify({ outcome: 'interrupted', reason: 'PRIVATE-REASON' }));
  insertEvent.run('m5', ids[3], 'idle', 5, at + 2000, JSON.stringify({ outcome: 'failed', error: 'PRIVATE-ERROR' }));
  insertEvent.run('m6', ids[4], 'user', 6, at + 2500, JSON.stringify({ prompt: 'PRIVATE-UNKNOWN-PROMPT' }));
  insertEvent.run('m7', ids[4], 'idle', 7, at + 2600, '{malformed-json');
  insertEvent.run('m8', ids[4], 'future_secret_type', 8, at + 2700, JSON.stringify({ secret: 'PRIVATE-UNKNOWN' }));
  db.close();
  const before = await fs.readFile(dbPath);

  const { sessions, stats } = await createOpenCodeSessionsSource({ root: dbPath }).load();
  assert.equal(stats.parsed, 5);
  const byLastEvent = (type) => sessions.find((session) => session.events.at(-1)?.type === type);
  assert.deepEqual(byLastEvent('turn_started')?.lifecycle, { status: 'active', startedAt: at });
  assert.deepEqual(byLastEvent('turn_completed')?.events.map((event) => event.type), ['turn_completed']);
  assert.deepEqual(byLastEvent('turn_aborted')?.events.map((event) => event.type), ['turn_aborted']);
  assert.deepEqual(byLastEvent('turn_failed')?.events.map((event) => event.type), ['turn_failed']);
  assert.equal(sessions.find((session) => session.lifecycle.status === 'unknown')?.lifecycle.status, 'unknown', 'malformed terminal data does not look active');
  const board = buildBoard({ sessions, archivedIds: new Set(), turns: new Map(), now: NOW, roots: [dir], sourceStats: { sources: { opencode: stats } } });
  const wire = JSON.stringify(board);
  for (const secret of [...ids, dir, 'PRIVATE-PROMPT', 'PRIVATE-ENV', 'PRIVATE-TOOL', 'PRIVATE-OUTPUT', 'PRIVATE-RESULT', 'PRIVATE-REASON', 'PRIVATE-ERROR', 'PRIVATE-UNKNOWN', 'malformed-json']) assert.equal(wire.includes(secret), false, `sensitive value escaped: ${secret}`);
  assert.deepEqual(await fs.readFile(dbPath), before, 'database bytes remain unchanged after reading');
  assert.deepEqual((await fs.readdir(dir)).sort(), ['opencode.db'], 'read-only scan creates no database sidecar files');
});

test('OpenCode legacy/unknown database schema and older SQLite runtime fail closed', { skip: !supported }, async () => {
  const { dbPath, db } = await fixture();
  db.exec('DROP TABLE session_v2; DROP TABLE session_message; CREATE TABLE session (id TEXT);');
  db.close();
  const legacy = await createOpenCodeSessionsSource({ root: dbPath }).load();
  assert.equal(legacy.sessions.length, 0);
  assert.equal(legacy.stats.bad, 1);
  const oldRuntime = await createOpenCodeSessionsSource({ root: dbPath, version: '22.5.0' }).load();
  assert.equal(oldRuntime.sessions.length, 0);
  assert.equal(oldRuntime.stats.unsupportedRuntime, true);
  const early24 = await createOpenCodeSessionsSource({ root: dbPath, version: '24.3.0' }).load();
  assert.equal(early24.sessions.length, 0);
  assert.equal(early24.stats.unsupportedRuntime, true);
  const supported24 = await createOpenCodeSessionsSource({ root: dbPath, version: '24.4.0' }).load();
  assert.equal(supported24.stats.unsupportedRuntime, false);
});
