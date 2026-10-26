import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createCodexSessionsSource } from '../src/adapters/codex-sessions-fs.mjs';
import { buildBoard } from '../src/core/board.mjs';
import { NOW, ROOTS, rec, uuid } from './helpers/fixtures.mjs';

const temps = new Set();
after(async () => Promise.all([...temps].map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function fixtureHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pigeonholes-codex-'));
  temps.add(dir);
  return dir;
}

function envelope(type, payload, at) {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
}

function meta(id, source = 'cli', originator = 'codex', cwd = 'C:\\work\\alpha') {
  return envelope('session_meta', {
    id,
    session_id: id,
    source,
    originator,
    timestamp: new Date(NOW - 5 * 60_000).toISOString(),
    cwd,
    base_instructions: { text: 'NEVER-WIRE-THIS-PROMPT' },
    environment_secret: 'NEVER-WIRE-THIS-KEY',
  }, NOW - 5 * 60_000);
}

async function rollout(home, id, rows) {
  const dir = path.join(home, 'sessions', '2026', '10', '17');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-17T11-00-00-${id}.jsonl`);
  await fs.writeFile(file, rows.join('\n') + '\n');
  return file;
}

test('Codex CLI rollout を検出し、turn status と allowlist イベントだけを返す', async () => {
  const home = await fixtureHome();
  const activeId = uuid(501);
  const doneId = uuid(502);
  const ignoredId = uuid(503);
  const abortedId = uuid(505);
  const activeAt = NOW - 2 * 60_000;
  const doneAt = NOW - 60_000;
  const activeFile = await rollout(home, activeId, [
    meta(activeId),
    envelope('event_msg', { type: 'task_started', turn_id: 'sensitive-turn-id', prompt: 'NEVER-WIRE-PROMPT' }, activeAt),
    envelope('event_msg', { type: 'exec_command_begin', command: 'NEVER-WIRE-COMMAND', env: { API_KEY: 'NEVER-WIRE-ENV' } }, activeAt + 1000),
    '{ broken json with NEVER-WIRE-BROKEN',
    envelope('event_msg', { type: 'future_sensitive_event', token: 'NEVER-WIRE-UNKNOWN' }, activeAt + 2000),
  ]);
  await rollout(home, doneId, [
    meta(doneId),
    envelope('event_msg', { type: 'task_started', turn_id: 'secret' }, doneAt - 10_000),
    envelope('event_msg', { type: 'task_complete', last_agent_message: 'NEVER-WIRE-ANSWER', duration_ms: 10_000 }, doneAt),
  ]);
  await rollout(home, abortedId, [
    meta(abortedId),
    envelope('event_msg', { type: 'task_started' }, activeAt - 10_000),
    envelope('event_msg', { type: 'turn_aborted', reason: 'interrupted', turn_id: 'private-id' }, activeAt),
  ]);
  await rollout(home, ignoredId, [meta(ignoredId, 'vscode')]);
  await rollout(home, uuid(504), ['not json']);

  const source = createCodexSessionsSource({ root: home });
  const { sessions, stats } = await source.load();
  assert.equal(sessions.length, 3);
  assert.equal(stats.parsed, 3);
  assert.equal(stats.bad, 2);
  assert.equal(stats.notCli, 1, 'records without the CLI marker are counted without retaining their source value');
  assert.equal((await source.load()).stats.notCli, 1, 'the safe reason count survives the read-only stat cache');
  assert.equal(JSON.stringify(stats).includes('vscode'), false, 'the rejected producer value does not enter diagnostics');
  const active = sessions.find((s) => s.sessionId === `codex_${activeId}`);
  const done = sessions.find((s) => s.sessionId === `codex_${doneId}`);
  const aborted = sessions.find((s) => s.sessionId === `codex_${abortedId}`);
  assert.deepEqual(active.lifecycle, { status: 'active', startedAt: activeAt });
  const mixedBoard = buildBoard({ sessions, archivedIds: new Set(), turns: new Map(), now: NOW, roots: ROOTS });
  const boardItems = [...mixedBoard.buckets.working, ...mixedBoard.recentGroups.flatMap((group) => group.items), ...mixedBoard.cleanupGroups.flatMap((group) => group.items ?? group.projects.flatMap((project) => project.items))];
  assert.equal(boardItems.find((card) => card.id === active.sessionId)?.sourceState, 'active');
  assert.equal(boardItems.find((card) => card.id === done.sessionId)?.sourceState, 'complete');
  assert.equal(boardItems.find((card) => card.id === aborted.sessionId)?.sourceState, 'interrupted');
  assert.deepEqual(active.events, [{ type: 'turn_started', at: activeAt }]);
  assert.deepEqual(done.lifecycle, { status: 'complete' });
  assert.deepEqual(done.events, [{ type: 'turn_started', at: doneAt - 10_000 }, { type: 'turn_completed', at: doneAt }]);
  assert.deepEqual(aborted.lifecycle, { status: 'interrupted' });
  assert.deepEqual(aborted.events, [{ type: 'turn_started', at: activeAt - 10_000 }, { type: 'turn_aborted', at: activeAt }]);
  const safe = JSON.stringify(sessions);
  for (const secret of ['NEVER-WIRE-THIS-PROMPT', 'NEVER-WIRE-THIS-KEY', 'NEVER-WIRE-PROMPT', 'NEVER-WIRE-COMMAND', 'NEVER-WIRE-ENV', 'NEVER-WIRE-UNKNOWN', 'NEVER-WIRE-BROKEN', 'NEVER-WIRE-ANSWER', 'private-id']) {
    assert.equal(safe.includes(secret), false, `sensitive value escaped: ${secret}`);
  }
  assert.equal(active.cwd, 'C:\\work\\alpha'); // adapter 内部の project 判定だけに使用
});

test('Codex と Claude を混在しても Claude card は同一で、Codex wire に path や本文を含めない', async () => {
  const home = await fixtureHome();
  const activeId = uuid(601);
  const doneId = uuid(602);
  const abortedId = uuid(603);
  const activeAt = NOW - 2 * 60_000;
  const doneAt = NOW - 60_000;
  await rollout(home, activeId, [meta(activeId), envelope('event_msg', { type: 'task_started', prompt: 'PRIVATE-PROMPT' }, activeAt)]);
  await rollout(home, doneId, [meta(doneId), envelope('event_msg', { type: 'task_started' }, doneAt - 1000), envelope('event_msg', { type: 'task_complete', output: 'PRIVATE-OUTPUT' }, doneAt)]);
  await rollout(home, abortedId, [meta(abortedId), envelope('event_msg', { type: 'task_started' }, activeAt - 1000), envelope('event_msg', { type: 'turn_aborted', reason: 'PRIVATE-REASON' }, activeAt)]);
  const { sessions, stats } = await createCodexSessionsSource({ root: home, wslShareStatus: 'not_configured' }).load();
  const claude = rec(11);
  const build = (items, sourceStats) => buildBoard({ sessions: items, archivedIds: new Set(), turns: new Map(), now: NOW, roots: ROOTS, sourceStats });
  const base = build([claude]);
  const mixed = build([claude, ...sessions], { sources: { codex: stats } });
  const claudeCard = (b) => [...b.buckets.needs_you, ...b.buckets.trouble, ...b.buckets.unread, ...b.buckets.working, ...b.recentGroups.flatMap((g) => g.items)].find((c) => c.id === claude.sessionId);
  assert.deepEqual(claudeCard(mixed), claudeCard(base));
  assert.ok(mixed.buckets.working.some((c) => c.source === 'codex'));
  const completed = mixed.recentGroups.flatMap((g) => g.items).find((c) => c.source === 'codex');
  assert.ok(completed);
  assert.deepEqual(completed.events.map((e) => e.type), ['turn_started', 'turn_completed']);
  const aborted = mixed.recentGroups.flatMap((g) => g.items).find((c) => c.id === `codex_${abortedId}`);
  assert.ok(aborted, 'aborted turn is terminal and does not remain working/stuck');
  assert.deepEqual(aborted.events.map((e) => e.type), ['turn_started', 'turn_aborted']);
  assert.deepEqual(mixed.stats.sources.codex, {
    files: 3, detected: 3, working: 1, trouble: 0, recent: 2,
    active: 1, completed: 1, interrupted: 1, failed: 0, unknown: 0, rejected: 0,
    notCli: 0,
    wslShareStatus: 'not_configured',
  });
  const wire = JSON.stringify(mixed);
  for (const secret of ['PRIVATE-PROMPT', 'PRIVATE-OUTPUT', 'PRIVATE-REASON', 'C:\\work\\alpha', 'base_instructions', 'environment_secret']) assert.equal(wire.includes(secret), false);
  const malformedStatus = await createCodexSessionsSource({ root: home, wslShareStatus: 'C:\\private\\share' }).load();
  assert.equal(malformedStatus.stats.wslShareStatus, 'not_applicable', 'adapter status accepts only fixed categories');
  assert.equal(JSON.stringify(malformedStatus.stats).includes('C:\\private\\share'), false);
});

test('CLI と originator の組が合わない Codex ファイルは採用しない', async () => {
  const home = await fixtureHome();
  await rollout(home, uuid(701), [meta(uuid(701), 'cli', 'Codex Desktop')]);
  const { sessions } = await createCodexSessionsSource({ root: home }).load();
  assert.equal(sessions.length, 0);
});

test('明示された WSL share 用 cwd mapper だけが POSIX cwd を内部変換し、wire は場所コードだけ返す', async () => {
  const home = await fixtureHome();
  const id = uuid(801);
  const at = NOW - 30_000;
  await rollout(home, id, [meta(id, 'cli', 'codex', '/home/dev/project'), envelope('event_msg', { type: 'task_started' }, at)]);
  const share = '\\\\wsl.localhost\\Ubuntu';
  const mapped = (cwd) => cwd === '/home/dev/project' ? `${share}\\home\\dev\\project` : null;
  const { sessions } = await createCodexSessionsSource({ root: home, cwdMapper: mapped }).load();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].cwd, `${share}\\home\\dev\\project`);
  assert.equal(sessions[0].executionLocation, 'wsl');
  const board = buildBoard({ sessions, archivedIds: new Set(), turns: new Map(), now: NOW, roots: ROOTS });
  const card = board.buckets.working.find((item) => item.source === 'codex');
  assert.equal(card.detail.executionLocation, 'wsl');
  assert.equal(JSON.stringify(board).includes('wsl.localhost'), false);
  assert.equal(JSON.stringify(board).includes('home\\\\dev\\\\project'), false);
});
