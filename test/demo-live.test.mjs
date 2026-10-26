// entry/demo.mjs: デモの合成データは時刻とともに作り直され、作業中の行が止まったかもへ流れていかない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBoard, selectTranscriptTargets } from '../src/core/board.mjs';
import { attachFolders } from '../src/adapters/session-record.mjs';
import { liveDemoSources } from '../src/entry/demo.mjs';
import { DEMO_REBUILD_MS, HOUR } from '../src/shared/constants.mjs';

/** service.mjs と同じ順で盤面を作る (サーバーなし)。 @param {ReturnType<typeof liveDemoSources>} src @param {number} now */
async function boardAt(src, now) {
  const loaded = await src.sessionsSource.load();
  const sessions = await attachFolders(loaded.sessions, (p) => src.folderHints.hintFor(p));
  const targets = selectTranscriptTargets(sessions, loaded.archivedIds, now);
  const byCli = await src.transcriptsSource.read(targets.map((t) => t.cliSessionId));
  const turns = new Map();
  for (const t of targets) {
    const ti = byCli.get(t.cliSessionId);
    if (ti) turns.set(t.sessionId, ti);
  }
  return buildBoard({ sessions, archivedIds: loaded.archivedIds, turns, now, roots: ['/home/tester'], sourceStats: loaded.stats, transcriptStats: src.transcriptsSource.stats(), scanMs: 0, demo: true });
}

for (const lang of /** @type {const} */ (['en', 'ja'])) {
  test(`liveDemoSources (${lang}): 2 時間後も作業中は作業中のまま、経過時間は作り直しの時刻から測る`, async () => {
    let now = Date.UTC(2026, 0, 15, 12, 0, 0);
    const src = liveDemoSources(lang, () => now);
    const first = await boardAt(src, now);
    assert.equal(first.counts.working, 5);
    assert.equal(first.counts.trouble, 3);
    const ids = first.buckets.working.map((c) => c.id).sort();
    const startedFirst = first.buckets.working.map((c) => (typeof c.startedAt === 'number' ? now - c.startedAt : null));

    now += 2 * HOUR;
    const later = await boardAt(src, now);
    assert.equal(later.counts.working, 5, 'working rows did not drift into another pile');
    assert.equal(later.counts.trouble, 3);
    assert.deepEqual(later.buckets.working.map((c) => c.id).sort(), ids, 'the same IDs every rebuild');
    assert.deepEqual(later.buckets.working.map((c) => (typeof c.startedAt === 'number' ? now - c.startedAt : null)), startedFirst);
  });
}

test('liveDemoSources: DEMO_REBUILD_MS 未満なら作り直さない (同じ合成データを返す)', async () => {
  let now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const src = liveDemoSources('en', () => now);
  const a = await src.sessionsSource.load();
  now += DEMO_REBUILD_MS - 1;
  const b = await src.sessionsSource.load();
  assert.deepEqual(b.sessions.map((s) => s.lastActivityAt), a.sessions.map((s) => s.lastActivityAt));
  now += 1;
  const c = await src.sessionsSource.load();
  assert.notDeepEqual(c.sessions.map((s) => s.lastActivityAt), a.sessions.map((s) => s.lastActivityAt));
});

test('liveDemoSources exposes synthetic worktree inventory without invoking Git', async () => {
  const src = liveDemoSources('ja', () => Date.UTC(2026, 0, 15, 12, 0, 0));
  const loaded = await src.sessionsSource.load();
  const session = loaded.sessions.find((item) => item.cwd && !item.isArchived);
  assert.ok(session);
  const items = await src.worktreeSource.listForCwd(session.cwd);
  assert.ok(items.length <= 20);
  if (items.length) {
    assert.equal(typeof items[0].status, 'string');
    assert.equal(typeof items[0].current, 'boolean');
  }
  assert.ok(!JSON.stringify(items).includes(session.cwd));
});
