import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createCopilotSessionsSource } from '../src/adapters/copilot-sessions-fs.mjs';
import { buildBoard } from '../src/core/board.mjs';
import { NOW, ROOTS, rec, uuid } from './helpers/fixtures.mjs';

const temps = new Set();
after(async () => Promise.all([...temps].map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function fixtureHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pigeonholes-copilot-'));
  temps.add(dir);
  return dir;
}

function event(type, data, at) {
  return JSON.stringify({ type, timestamp: new Date(at).toISOString(), data });
}

async function writeSession(home, id, rows) {
  const dir = path.join(home, 'session-state', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'events.jsonl'), `${rows.join('\n')}\n`);
}

function start(id, at, extra = {}) {
  return event('session.start', {
    producer: 'copilot-agent', sessionId: id, startTime: new Date(at).toISOString(),
    context: { cwd: 'C:\\private\\repo', ...extra.context },
    prompt: 'PRIVATE-PROMPT', environment: { TOKEN: 'PRIVATE-ENV' }, ...extra,
  }, at);
}

test('Copilotイベントを検出し、進行中・完了・中断を安全な要約にする', async () => {
  const home = await fixtureHome();
  const activeId = uuid(801);
  const doneId = uuid(802);
  const abortedId = uuid(803);
  const activeAt = NOW - 2 * 60_000;
  const doneAt = NOW - 60_000;
  await writeSession(home, activeId, [
    start(activeId, activeAt),
    event('assistant.turn_start', { prompt: 'PRIVATE-PROMPT', tool_input: 'PRIVATE-TOOL-INPUT' }, activeAt + 1_000),
    '{ malformed PRIVATE-BROKEN',
    event('future.secret_event', { secret: 'PRIVATE-UNKNOWN' }, activeAt + 2_000),
  ]);
  await writeSession(home, doneId, [start(doneId, doneAt - 10_000), event('assistant.turn_start', {}, doneAt - 5_000), event('assistant.turn_end', { output: 'PRIVATE-OUTPUT' }, doneAt)]);
  await writeSession(home, abortedId, [start(abortedId, activeAt - 10_000), event('assistant.turn_start', {}, activeAt - 5_000), event('abort', { reason: 'PRIVATE-REASON' }, activeAt)]);
  const { sessions, stats } = await createCopilotSessionsSource({ root: home }).load();
  assert.equal(sessions.length, 3);
  assert.equal(stats.parsed, 3);
  const active = sessions.find((s) => s.sessionId === `copilot_${activeId}`);
  const done = sessions.find((s) => s.sessionId === `copilot_${doneId}`);
  const aborted = sessions.find((s) => s.sessionId === `copilot_${abortedId}`);
  assert.deepEqual(active.lifecycle, { status: 'active', startedAt: activeAt + 1_000 });
  assert.deepEqual(active.events, [{ type: 'turn_started', at: activeAt }, { type: 'turn_started', at: activeAt + 1_000 }]);
  assert.deepEqual(done.lifecycle, { status: 'complete' });
  assert.deepEqual(done.events.map((e) => e.type), ['turn_started', 'turn_started', 'turn_completed']);
  assert.deepEqual(aborted.events.map((e) => e.type), ['turn_started', 'turn_started', 'turn_aborted']);
  for (const secret of ['PRIVATE-PROMPT', 'PRIVATE-ENV', 'PRIVATE-TOOL-INPUT', 'PRIVATE-BROKEN', 'PRIVATE-UNKNOWN', 'PRIVATE-OUTPUT', 'PRIVATE-REASON']) {
    assert.equal(JSON.stringify(sessions).includes(secret), false, `sensitive value escaped: ${secret}`);
  }
});

test('形式不整合と未知producerは安全に除外し、合成カードのwireにパスを出さない', async () => {
  const home = await fixtureHome();
  const goodId = uuid(811);
  const wrongProducerId = uuid(812);
  const mismatchId = uuid(813);
  await writeSession(home, goodId, [start(goodId, NOW), event('assistant.turn_start', { command: 'PRIVATE-COMMAND' }, NOW + 1_000)]);
  await writeSession(home, wrongProducerId, [start(wrongProducerId, NOW, { producer: 'unknown-agent' })]);
  await writeSession(home, mismatchId, [start(uuid(999), NOW)]);
  const { sessions, stats } = await createCopilotSessionsSource({ root: home }).load();
  assert.equal(sessions.length, 1);
  assert.equal(stats.bad, 2);
  const claude = rec(11);
  const build = (items, sourceStats) => buildBoard({
    sessions: items, archivedIds: new Set(), turns: new Map(), now: NOW + 5_000,
    roots: ROOTS, sourceStats,
  });
  const base = build([claude]);
  const board = build([claude, ...sessions], { sources: { copilot: stats } });
  const card = (value) => [...value.buckets.needs_you, ...value.buckets.trouble, ...value.buckets.unread, ...value.buckets.working, ...value.recentGroups.flatMap((group) => group.items)].find((item) => item.id === claude.sessionId);
  assert.deepEqual(card(board), card(base), 'adding a Copilot source leaves the Claude card unchanged');
  const copilotCard = [...board.buckets.working, ...board.recentGroups.flatMap((group) => group.items)].find((card) => card.source === 'copilot');
  assert.ok(copilotCard);
  const wire = JSON.stringify(board);
  for (const secret of ['PRIVATE-COMMAND', 'PRIVATE-PROMPT', 'C:\\private\\repo', 'PRIVATE-ENV']) assert.equal(wire.includes(secret), false);
  assert.deepEqual(board.stats.sources.copilot, {
    files: 3, detected: 1, working: 1, trouble: 0, recent: 0,
    active: 1, completed: 0, interrupted: 0, unknown: 0, rejected: 2,
  });
});

test('Copilotセッション保存先が無ければ空で返す', async () => {
  const missing = path.join(await fixtureHome(), 'missing');
  const result = await createCopilotSessionsSource({ root: missing }).load();
  assert.equal(result.sessions.length, 0);
  assert.equal(result.stats.files, 0);
});
