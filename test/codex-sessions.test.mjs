import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createCodexSessionsSource } from '../src/adapters/codex-sessions-fs.mjs';
import { opaqueProviderSessionId } from '../src/adapters/opaque-session-id.mjs';
import { buildBoard } from '../src/core/board.mjs';
import { NOW, ROOTS, rec, uuid } from './helpers/fixtures.mjs';

const temps = new Set();
const SAFE_TEST_CWD = path.join(path.parse(process.cwd()).root, 'work', 'alpha');
after(async () => Promise.all([...temps].map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function fixtureHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pigeonholes-codex-'));
  temps.add(dir);
  return dir;
}

function envelope(type, payload, at) {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
}

function meta(id, source = 'cli', originator = 'codex', cwd = SAFE_TEST_CWD) {
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
  const noSourceId = uuid(506);
  const unsupportedOriginatorId = uuid(507);
  const mismatchNameId = uuid(508);
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
  const missingSource = JSON.parse(meta(noSourceId));
  delete missingSource.payload.source;
  await rollout(home, noSourceId, [JSON.stringify(missingSource)]);
  await rollout(home, unsupportedOriginatorId, [meta(unsupportedOriginatorId, 'cli', 'unknown-producer')]);
  await rollout(home, mismatchNameId, [meta(uuid(509))]);

  const source = createCodexSessionsSource({ root: home });
  const { sessions, stats } = await source.load();
  assert.equal(sessions.length, 3);
  assert.equal(stats.parsed, 3);
  assert.equal(stats.bad, 5);
  assert.equal(stats.notCli, 2, 'non-CLI marker states are counted without retaining their values');
  assert.equal(stats.missingSource, 1);
  assert.equal(stats.otherSource, 1);
  assert.equal(stats.unsupportedOriginator, 1);
  assert.equal(stats.filenameMismatch, 1);
  assert.equal((await source.load()).stats.unsupportedOriginator, 1, 'safe reason counts survive the read-only stat cache');
  assert.equal(JSON.stringify(stats).includes('vscode'), false, 'the rejected producer value does not enter diagnostics');
  assert.equal(JSON.stringify(stats).includes('unknown-producer'), false, 'unsupported originator values do not enter diagnostics');
  const diagnosticBoard = buildBoard({ sessions, archivedIds: new Set(), turns: new Map(), now: NOW, roots: ROOTS, sourceStats: { sources: { codex: stats } } });
  assert.deepEqual(diagnosticBoard.stats.sources.codex, {
    files: 8, detected: 3, working: 1, trouble: 0, recent: 2,
    active: 1, completed: 1, interrupted: 1, failed: 0, unknown: 0, rejected: 5,
    notCli: 2, missingSource: 1, otherSource: 1, unsupportedOriginator: 1, filenameMismatch: 1,
  });
  assert.doesNotMatch(JSON.stringify(diagnosticBoard.stats.sources.codex), /vscode|unknown-producer|[A-Z]:\\\\/i);
  const active = sessions.find((s) => s.sessionId === opaqueProviderSessionId('codex', activeId));
  const done = sessions.find((s) => s.sessionId === opaqueProviderSessionId('codex', doneId));
  const aborted = sessions.find((s) => s.sessionId === opaqueProviderSessionId('codex', abortedId));
  assert.deepEqual(active.lifecycle, { status: 'active', startedAt: activeAt });
  const mixedBoard = buildBoard({ sessions, archivedIds: new Set(), turns: new Map(), now: NOW, roots: ROOTS });
  const boardItems = [...mixedBoard.buckets.working, ...mixedBoard.recentGroups.flatMap((group) => group.items), ...mixedBoard.cleanupGroups.flatMap((group) => group.items ?? group.projects.flatMap((project) => project.items))];
  assert.equal(boardItems.find((card) => card.id === active.sessionId)?.sourceState, 'active');
  assert.equal(boardItems.find((card) => card.id === done.sessionId)?.sourceState, 'complete');
  assert.equal(boardItems.find((card) => card.id === aborted.sessionId)?.sourceState, 'interrupted');
  for (const providerId of [activeId, doneId, abortedId]) assert.equal(JSON.stringify(mixedBoard).includes(providerId), false, 'provider-native session ID stays out of board wire');
  assert.deepEqual(active.events, [{ type: 'turn_started', at: activeAt }]);
  assert.deepEqual(done.lifecycle, { status: 'complete' });
  assert.deepEqual(done.events, [{ type: 'turn_started', at: doneAt - 10_000 }, { type: 'turn_completed', at: doneAt }]);
  assert.deepEqual(aborted.lifecycle, { status: 'interrupted' });
  assert.deepEqual(aborted.events, [{ type: 'turn_started', at: activeAt - 10_000 }, { type: 'turn_aborted', at: activeAt }]);
  const safe = JSON.stringify(sessions);
  for (const secret of ['NEVER-WIRE-THIS-PROMPT', 'NEVER-WIRE-THIS-KEY', 'NEVER-WIRE-PROMPT', 'NEVER-WIRE-COMMAND', 'NEVER-WIRE-ENV', 'NEVER-WIRE-UNKNOWN', 'NEVER-WIRE-BROKEN', 'NEVER-WIRE-ANSWER', 'private-id']) {
    assert.equal(safe.includes(secret), false, `sensitive value escaped: ${secret}`);
  }
  assert.equal(active.cwd, SAFE_TEST_CWD); // adapter 内部の project 判定だけに使用
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
  const aborted = mixed.recentGroups.flatMap((g) => g.items).find((c) => c.id === opaqueProviderSessionId('codex', abortedId));
  assert.ok(aborted, 'aborted turn is terminal and does not remain working/stuck');
  assert.deepEqual(aborted.events.map((e) => e.type), ['turn_started', 'turn_aborted']);
  assert.deepEqual(mixed.stats.sources.codex, {
    files: 3, detected: 3, working: 1, trouble: 0, recent: 2,
    active: 1, completed: 1, interrupted: 1, failed: 0, unknown: 0, rejected: 0,
    notCli: 0, missingSource: 0, otherSource: 0, unsupportedOriginator: 0, filenameMismatch: 0,
    wslShareStatus: 'not_configured',
  });
  const wire = JSON.stringify(mixed);
  for (const secret of ['PRIVATE-PROMPT', 'PRIVATE-OUTPUT', 'PRIVATE-REASON', SAFE_TEST_CWD, 'base_instructions', 'environment_secret']) assert.equal(wire.includes(secret), false);
  const malformedStatus = await createCodexSessionsSource({ root: home, wslShareStatus: 'C:\\private\\share' }).load();
  assert.equal(malformedStatus.stats.wslShareStatus, 'not_applicable', 'adapter status accepts only fixed categories');
  assert.equal(JSON.stringify(malformedStatus.stats).includes('C:\\private\\share'), false);
});

test('task_complete.error は本文を捨てて失敗状態だけを出し、不正なerror形式は完了扱いしない', async () => {
  const home = await fixtureHome();
  const failedId = uuid(604);
  const malformedId = uuid(605);
  const unknownCodeId = uuid(607);
  const failedAt = NOW - 45_000;
  const startedAt = failedAt - 5_000;
  await rollout(home, failedId, [
    meta(failedId),
    envelope('event_msg', { type: 'task_started' }, startedAt),
    envelope('event_msg', { type: 'task_complete', error: { message: 'NEVER-WIRE-ERROR-TEXT' } }, failedAt),
  ]);
  await rollout(home, malformedId, [
    meta(malformedId),
    envelope('event_msg', { type: 'task_started' }, startedAt),
    envelope('event_msg', { type: 'task_complete', error: 'unexpected-shape' }, failedAt),
  ]);
  await rollout(home, unknownCodeId, [
    meta(unknownCodeId),
    envelope('event_msg', { type: 'task_started' }, startedAt),
    envelope('event_msg', { type: 'task_complete', error: { message: 'PRIVATE-FUTURE-ERROR', codex_error_info: 'future_error_kind' } }, failedAt),
  ]);

  const { sessions, stats } = await createCodexSessionsSource({ root: home }).load();
  const failed = sessions.find((session) => session.sessionId === opaqueProviderSessionId('codex', failedId));
  const malformed = sessions.find((session) => session.sessionId === opaqueProviderSessionId('codex', malformedId));
  const unknownCode = sessions.find((session) => session.sessionId === opaqueProviderSessionId('codex', unknownCodeId));
  assert.deepEqual(failed.lifecycle, { status: 'failed' });
  assert.deepEqual(failed.events, [{ type: 'turn_started', at: startedAt }, { type: 'turn_failed', at: failedAt }]);
  assert.deepEqual(malformed.lifecycle, { status: 'unknown' });
  assert.deepEqual(malformed.events, [{ type: 'turn_started', at: startedAt }, { type: 'turn_unknown', at: failedAt }]);
  assert.deepEqual(unknownCode.lifecycle, { status: 'unknown' });
  assert.deepEqual(stats, {
    files: 3, parsed: 3, bad: 0, stale: 0, dirs: 1, notCli: 0, missingSource: 0, otherSource: 0,
    unsupportedOriginator: 0, filenameMismatch: 0, wslShareStatus: 'not_applicable',
  });
  const board = buildBoard({ sessions, archivedIds: new Set(), turns: new Map(), now: NOW, roots: ROOTS, sourceStats: { sources: { codex: stats } } });
  const allItems = [...board.buckets.working, ...board.recentGroups.flatMap((group) => group.items)];
  assert.equal(allItems.find((card) => card.id === failed.sessionId)?.sourceState, 'failed');
  assert.equal(board.stats.sources.codex.failed, 1);
  assert.equal(board.stats.sources.codex.unknown, 2);
  const wire = JSON.stringify(board);
  assert.equal(wire.includes('NEVER-WIRE-ERROR-TEXT'), false);
  assert.equal(wire.includes('unexpected-shape'), false);
  assert.equal(wire.includes('PRIVATE-FUTURE-ERROR'), false);
  assert.equal(wire.includes('future_error_kind'), false);
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
