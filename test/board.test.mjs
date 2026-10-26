import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBoard, detectFormatSuspect, selectTranscriptTargets } from '../src/core/board.mjs';
import { FORBIDDEN_OUTPUT_KEYS, FORBIDDEN_WIRE_KEYS } from '../src/shared/constants.mjs';
import { toSessionRecord } from '../src/adapters/session-record.mjs';
import { DAY, HOUR, MIN, NOW, ROOTS, cid, rec, sid, synth, synth2, tails, ti, usageOf } from './helpers/fixtures.mjs';

/**
 * @param {any[]} sessions
 * @param {{turns?: Record<string, ReturnType<typeof ti>>, archived?: string[], sourceStats?: any, demo?: boolean,
 *   tailFacts?: Map<string, any>, prevContext?: Map<string, any>}} [o]
 * @returns {any}
 */
function board(sessions, o = {}) {
  return buildBoard({
    sessions,
    archivedIds: new Set(o.archived ?? []),
    turns: new Map(Object.entries(o.turns ?? {})),
    now: NOW,
    roots: ROOTS,
    sourceStats: o.sourceStats,
    demo: o.demo,
    tailFacts: o.tailFacts,
    prevContext: o.prevContext,
  });
}
const allCleanupRows = (/** @type {any} */ b) => b.cleanupGroups.flatMap((/** @type {any} */ g) => g.items ?? g.projects.flatMap((/** @type {any} */ p) => p.items));
const group = (/** @type {any} */ b, /** @type {string} */ reason) => b.cleanupGroups.find((/** @type {any} */ g) => g.reason === reason);
const idle = (/** @type {number} */ n, /** @type {Record<string, unknown>} */ f = {}) => rec(n, { lastActivityAt: NOW - 40 * DAY, lastFocusedAt: NOW - 40 * DAY + MIN, createdAt: NOW - 41 * DAY, ...f });
const ids = (/** @type {any[]} */ cards) => cards.map((c) => c.id);

test('v は 2。件数の合計は非アーカイブ件数と一致し、アーカイブ済み (isArchived / idx) は出さない', () => {
  const sessions = [rec(1), rec(2, { isArchived: true }), rec(3), idle(4)];
  const b = board(sessions, { archived: [sid(3)] });
  assert.equal(b.v, 2);
  const c = b.counts;
  assert.equal(c.active, 2);
  assert.equal(c.archived, 2);
  assert.equal(c.needs_you + c.trouble + c.unread + c.working + c.recent + c.cleanup, c.active);
  assert.ok(!JSON.stringify(b).includes(sid(2)));
});

test('provider source state is projected only as a safe enum; Claude cards stay unchanged', () => {
  const codex = { ...rec(801), source: 'codex', lifecycle: { status: 'unexpected-sensitive-state' }, events: [] };
  const claude = rec(802);
  const result = board([codex, claude]);
  const cards = [...result.buckets.needs_you, ...result.buckets.trouble, ...result.buckets.unread, ...result.buckets.working, ...result.recentGroups.flatMap((g) => g.items), ...allCleanupRows(result)];
  const codexCard = cards.find((card) => card.id === codex.sessionId);
  const claudeCard = cards.find((card) => card.id === claude.sessionId);
  assert.equal(codexCard?.sourceState, 'unknown');
  assert.equal(JSON.stringify(result).includes('unexpected-sensitive-state'), false);
  assert.equal('sourceState' in claudeCard, false);
});

test('盤面に言葉は入らない: reasonText・gloss・グループの label が無く、stats.demo と formatSuspect がある', () => {
  const b = board([rec(1), idle(2), rec(3, { cwd: '', originCwd: '' })], { demo: true });
  const json = JSON.stringify(b);
  assert.ok(!json.includes('"reasonText"'));
  assert.ok(!json.includes('"gloss"'));
  for (const g of b.cleanupGroups) assert.equal('label' in g, false);
  assert.equal(b.stats.demo, true);
  assert.equal(b.stats.formatSuspect, null);
  assert.equal(board([rec(1)]).stats.demo, false);
});

test('定期実行: 最新回だけがカードになり、古い回は片付け候補の 1 行にまとまる (reasonParams で回数と最新回の場所)', () => {
  const runs = [0, 1, 2, 3].map((i) =>
    rec(10 + i, { title: '【毎朝】合成の調査', scheduledTaskId: 'synthetic-routine', createdAt: NOW - i * DAY - HOUR, lastActivityAt: NOW - i * DAY - 50 * MIN }),
  );
  const turns = {
    [sid(10)]: ti(tails.tool(), 50 * MIN), // 最新回: ツールの途中で止まっている
    [sid(11)]: ti(tails.tool(), DAY + 50 * MIN),
    [sid(12)]: ti(tails.tool(), 2 * DAY + 50 * MIN),
    [sid(13)]: ti(tails.ended(), 3 * DAY + 50 * MIN),
  };
  const b = board(runs, { turns });
  assert.equal(b.buckets.trouble.length, 1);
  const card = b.buckets.trouble[0];
  assert.equal(card.id, sid(10));
  assert.deepEqual({ ...card.routine }, { id: 'synthetic-routine', runs: 4, completed: 1, stalled: 2, latestBucket: 'trouble' });
  const g = group(b, 'routine_old');
  assert.equal(g.items.length, 1);
  assert.equal(g.count, 3);
  const row = g.items[0];
  assert.deepEqual(row.routine.runIds, [sid(11), sid(12), sid(13)]);
  assert.equal(row.title, '【毎朝】合成の調査');
  assert.equal(row.reason, 'routine_old');
  assert.deepEqual(row.reasonParams, { older: 3, total: 4, latestBucket: 'trouble' });
  assert.equal(row.timeKind, 'latest');
  assert.equal(row.cleanup.recommended, true);
});

test('定期実行: 最新回も 30 日以上前なら、全部の回が 1 行に合流する (latestBucket は送らない)', () => {
  const runs = [0, 1, 2].map((i) => idle(20 + i, { scheduledTaskId: 'old-routine', createdAt: NOW - (90 + i) * DAY }));
  const b = board(runs);
  const g = group(b, 'routine_old');
  assert.equal(g.items.length, 1);
  assert.equal(g.items[0].routine.runIds.length, 3);
  assert.deepEqual(g.items[0].reasonParams, { older: 3, total: 3 });
  assert.equal(group(b, 'idle_30d').count, 0);
  assert.equal(b.counts.cleanup, 3);
  assert.equal(b.counts.recommended, 3);
});

test('片付け候補は固定順の理由グループで、20 行を超えたらプロジェクト別に分ける', () => {
  const many = Array.from({ length: 21 }, (_, i) => idle(100 + i, { cwd: `C:\\work\\p${i % 2}`, originCwd: `C:\\work\\p${i % 2}` }));
  const b = board(many);
  assert.deepEqual(b.cleanupGroups.map((/** @type {any} */ g) => g.reason), ['retried', 'routine_old', 'pr_done', 'old_error', 'old_question', 'idle_30d', 'idle_7d']);
  const g = group(b, 'idle_30d');
  assert.equal(g.items, undefined);
  assert.deepEqual(g.projects.map((/** @type {any} */ p) => [p.label, p.count]).sort(), [['p0', 11], ['p1', 10]]);
  const twenty = board(many.slice(0, 20));
  assert.equal(group(twenty, 'idle_30d').items.length, 20);
});

test('片付け候補のプロジェクト別サブグループで、フォルダなしは label null で最後', () => {
  const many = Array.from({ length: 21 }, (_, i) => idle(100 + i, i < 3 ? { cwd: '', originCwd: '', lastActivityAt: NOW - 31 * DAY } : {}));
  const g = group(board(many), 'idle_30d');
  const last = g.projects[g.projects.length - 1];
  assert.deepEqual([last.key, last.label, last.count], ['(other)', null, 3]);
  assert.equal(g.projects[0].label, 'alpha');
});

test('おすすめから外す条件 5 種 (NoteCode) と、おすすめに入らない理由', () => {
  const parent = idle(1, { title: '親' });
  const child = rec(2, { spawnedFrom: { sessionId: sid(1) }, lastActivityAt: NOW - MIN, lastFocusedAt: NOW });
  const sessions = [
    parent,
    child,
    idle(3, { prs: [{ prNumber: 7, repo: 'o/r', state: 'OPEN' }] }),
    idle(4, { autoArchiveExempt: true }),
    idle(5, { isStarred: true }),
    idle(6, { lastFocusedAt: NOW - 50 * DAY }),
    idle(7),
    rec(8, { lastActivityAt: NOW - 10 * DAY, lastFocusedAt: NOW - 10 * DAY }),
  ];
  const b = board(sessions, { turns: { [sid(2)]: ti(tails.tool(), 30 * 1000) } });
  const rows = new Map(allCleanupRows(b).map((/** @type {any} */ r) => [r.id, r.cleanup]));
  assert.deepEqual(rows.get(sid(1)), { recommended: false, note: 'child' });
  assert.deepEqual(rows.get(sid(3)), { recommended: false, note: 'open_pr' });
  assert.deepEqual(rows.get(sid(4)), { recommended: false, note: 'exempt' });
  assert.deepEqual(rows.get(sid(5)), { recommended: false, note: 'starred' });
  assert.deepEqual(rows.get(sid(6)), { recommended: false, note: 'unread' });
  assert.deepEqual(rows.get(sid(7)), { recommended: true });
  assert.deepEqual(rows.get(sid(8)), { recommended: false }); // 7〜30 日はおすすめ外
  assert.equal(b.counts.recommended, 1);
});

test('おすすめ除外は決まった順に 1 つだけ (open_pr が exempt / starred より先)', () => {
  const s = idle(1, { prs: [{ prNumber: 1, repo: 'o/r', state: 'OPEN' }], autoArchiveExempt: true, isStarred: true });
  assert.deepEqual(allCleanupRows(board([s]))[0].cleanup, { recommended: false, note: 'open_pr' });
});

test('並び: 返事待ち・止まったかも・未読は古い順 (一番長く待っているものが先頭)、作業中は新しい順', () => {
  const ask = (/** @type {number} */ n, /** @type {number} */ ago) => rec(n, { lastActivityAt: NOW - ago, postTurnSummary: { status_category: 'blocked', needs_action: `質問 ${n}` } });
  const unread = (/** @type {number} */ n, /** @type {number} */ ago) => rec(n, { lastActivityAt: NOW - ago, lastFocusedAt: NOW - ago - HOUR });
  const err = (/** @type {number} */ n, /** @type {number} */ ago) => rec(n, { lastActivityAt: NOW - ago, error: 'API Error: x', errorAt: NOW - ago });
  const work = (/** @type {number} */ n) => rec(n, { lastActivityAt: NOW - MIN });
  const sessions = [ask(1, 5 * MIN), ask(2, 3 * HOUR), ask(3, HOUR), unread(4, 2 * HOUR), unread(5, 6 * HOUR), err(6, MIN), err(7, 2 * DAY), work(8), work(9), work(10)];
  const turns = { [sid(8)]: ti(tails.tool(), 10 * MIN), [sid(9)]: ti(tails.tool(), 1 * MIN), [sid(10)]: ti(tails.tool(), 5 * MIN) };
  const b = board(sessions, { turns });
  assert.deepEqual(ids(b.buckets.needs_you), [sid(2), sid(3), sid(1)]);
  assert.deepEqual(ids(b.buckets.unread), [sid(5), sid(4)]);
  assert.deepEqual(ids(b.buckets.trouble), [sid(7), sid(6)]);
  assert.deepEqual(ids(b.buckets.working), [sid(9), sid(10), sid(8)]);
});

test('並び: 同じ時刻なら id 順で安定させる', () => {
  const same = [3, 1, 2].map((n) => rec(n, { lastActivityAt: NOW - HOUR, postTurnSummary: { needs_action: '答えて' } }));
  assert.deepEqual(ids(board(same).buckets.needs_you), [sid(1), sid(2), sid(3)]);
});

test('作業中のカードは、ターンを始めた指示の時刻 (startedAt) を持つ。分からなければ無い', () => {
  const started = NOW - 23 * MIN;
  const a = rec(1, { lastActivityAt: NOW - MIN });
  const b2 = rec(2, { lastActivityAt: NOW - MIN });
  const bg = rec(3, { lastActivityAt: NOW - 30 * MIN });
  const b = board([a, b2, bg], { turns: { [sid(1)]: ti(tails.tool(started), MIN), [sid(2)]: ti(tails.tool(), 2 * MIN), [sid(3)]: ti(tails.ended(), 30 * MIN, MIN) } });
  const cards = new Map(b.buckets.working.map((/** @type {any} */ c) => [c.id, c]));
  assert.equal(cards.get(sid(1)).startedAt, started);
  assert.equal('startedAt' in cards.get(sid(2)), false);
  assert.equal(cards.get(sid(3)).reason, 'background');
  assert.equal('startedAt' in cards.get(sid(3)), false);
  // 作業中以外のカードには付けない
  const stalled = board([rec(4, { lastActivityAt: NOW - 3 * HOUR })], { turns: { [sid(4)]: ti(tails.tool(NOW - 4 * HOUR), 3 * HOUR) } });
  assert.equal('startedAt' in stalled.buckets.trouble[0], false);
});

test('formatSuspect no_timestamps: 日時の無いレコードが 20% を超える (5 件以上) と、おすすめを全部切る', () => {
  const dated = Array.from({ length: 6 }, (_, i) => idle(10 + i));
  const undated = [1, 2].map((n) => rec(n, { lastActivityAt: undefined, createdAt: undefined, lastFocusedAt: undefined }));
  const b = board([...dated, ...undated]);
  assert.equal(b.stats.formatSuspect, 'no_timestamps');
  const rows = allCleanupRows(b);
  assert.ok(rows.length >= 8);
  for (const r of rows) assert.equal(r.cleanup.recommended, false);
  for (const g of b.cleanupGroups) assert.equal(g.recommendedCount, 0);
  assert.equal(b.counts.recommended, 0);
  // 注記 (NoteCode) はそのまま残る
  const pinned = board([...dated, ...undated, idle(30, { isStarred: true })]);
  assert.equal(allCleanupRows(pinned).find((/** @type {any} */ r) => r.id === sid(30)).cleanup.note, 'starred');
  // 20% ちょうどなら疑わない (2 / 10)
  const ok = board([...Array.from({ length: 8 }, (_, i) => idle(40 + i)), ...undated]);
  assert.equal(ok.stats.formatSuspect, null);
  assert.ok(ok.counts.recommended > 0);
});

test('formatSuspect no_timestamps: 非アーカイブが 5 件未満なら疑わない', () => {
  const undated = [1, 2, 3, 4].map((n) => rec(n, { lastActivityAt: undefined, createdAt: undefined }));
  assert.equal(board(undated).stats.formatSuspect, null);
  assert.equal(detectFormatSuspect([...undated, rec(5, { lastActivityAt: undefined, createdAt: undefined })], { files: 5, dirs: 1 }), 'no_timestamps');
  // アーカイブ済みは数えない
  const archived = [5, 6, 7].map((n) => rec(n, { isArchived: true, lastActivityAt: undefined, createdAt: undefined }));
  assert.equal(board([idle(10), idle(11), ...archived]).stats.formatSuspect, null);
});

test('formatSuspect no_session_files: 組織フォルダはあるのに local_*.json が 0 件', () => {
  const b = board([], { sourceStats: { files: 0, parsed: 0, bad: 0, stale: 0, dirs: 2 } });
  assert.equal(b.stats.formatSuspect, 'no_session_files');
  assert.equal(b.counts.recommended, 0);
  // フォルダも無いなら (アプリを使っていないだけ) 疑わない
  assert.equal(board([], { sourceStats: { files: 0, parsed: 0, bad: 0, stale: 0, dirs: 0 } }).stats.formatSuspect, null);
  // ファイルがあれば疑わない
  assert.equal(board([idle(1)], { sourceStats: { files: 1, parsed: 1, bad: 0, stale: 0, dirs: 1 } }).stats.formatSuspect, null);
});

test('家族: 子の印に親の title、親の印に子の内訳、families に全員', () => {
  const root = rec(1, { title: '親の会話', isArchived: true });
  const p = rec(2, { title: 'P', spawnedFrom: { sessionId: sid(1) } });
  const c1 = rec(3, { spawnedFrom: { sessionId: sid(2) }, lastActivityAt: NOW - MIN });
  const c2 = rec(4, { spawnedFrom: { sessionId: sid(2) }, postTurnSummary: { needs_action: '答えて' } });
  const orphan = rec(5, { spawnedFrom: { sessionId: sid(99) } });
  const b = board([root, p, c1, c2, orphan], { turns: { [sid(3)]: ti(tails.tool(), 10 * 1000) } });
  const cards = new Map([...b.buckets.working, ...b.buckets.needs_you, ...b.recentGroups.flatMap((/** @type {any} */ g) => g.items)].map((c) => [c.id, c]));
  assert.equal(cards.get(sid(2)).family.parentTitle, '親の会話');
  assert.deepEqual(cards.get(sid(2)).family.children, { total: 2, working: 1, needs_you: 1, trouble: 0, unread: 0 });
  assert.equal(cards.get(sid(3)).family.rootId, sid(1));
  assert.equal(cards.get(sid(5)).family.parentTitle, null);
  assert.equal(cards.get(sid(5)).family.rootId, undefined);
  assert.deepEqual(b.families[sid(1)], { title: '親の会話', memberIds: [sid(2), sid(3), sid(4)] });
});

test('本文: 返事待ちは needs_action、未読は turnWrapUp、無ければ lastTurnReport の要約', () => {
  const ask = rec(1, { postTurnSummary: { status_category: 'blocked', status_detail: 'detail', needs_action: 'A と B のどちら?' } });
  const wrap = rec(2, { lastFocusedAt: NOW - 2 * HOUR, turnWrapUp: { description: '直した。' }, lastTurnReport: '"使わない"' });
  const report = rec(3, { lastFocusedAt: NOW - 2 * HOUR, lastTurnReport: '"[PR #1](https://github.com/o/r/pull/1) を出した ⏎ 長い本文"' });
  const b = board([ask, wrap, report]);
  assert.equal(b.buckets.needs_you[0].body, 'A と B のどちら?');
  assert.equal(b.buckets.needs_you[0].detail.statusDetail, 'detail');
  const unread = new Map(b.buckets.unread.map((/** @type {any} */ c) => [c.id, c.body]));
  assert.equal(unread.get(sid(2)), '直した。');
  assert.equal(unread.get(sid(3)), 'PR #1 を出した');
});

test('本文: 止まっているかもは "" (理由の文は画面が reasonParams から作る)', () => {
  const s = rec(1, { error: 'API Error: overloaded', errorAt: NOW - HOUR, turnWrapUp: { description: '要約' } });
  const card = board([s]).buckets.trouble[0];
  assert.deepEqual([card.reason, card.body, card.reasonParams], ['error', '', { error: 'API Error: overloaded' }]);
});

test('本文: 質問文の無い質問ツールの返事待ちは "" (古い needs_action に落とさない)、reasonParams.ask で種類', () => {
  const stale = { postTurnSummary: { status_category: 'blocked', needs_action: '前のターンの古い質問' }, lastActivityAt: NOW - 5 * MIN };
  const plan = rec(1, stale);
  const blank = rec(2, stale);
  const b = board([plan, blank], {
    turns: { [sid(1)]: ti(tails.asking('', 'ExitPlanMode'), 5 * MIN), [sid(2)]: ti(tails.asking(''), 5 * MIN) },
  });
  const cards = new Map(b.buckets.needs_you.map((/** @type {any} */ c) => [c.id, c]));
  assert.deepEqual([cards.get(sid(1)).reason, cards.get(sid(1)).body, cards.get(sid(1)).reasonParams], ['asking', '', { ask: 'plan' }]);
  assert.deepEqual([cards.get(sid(2)).body, cards.get(sid(2)).reasonParams], ['', { ask: 'question' }]);
});

test('文字数の上限: title 200 / 本文 600 / 親の title 40。完全な cwd は wire に出さない', () => {
  const long = '字'.repeat(1000);
  const parent = rec(1, { title: '親'.repeat(100) });
  const s = rec(2, { title: long, cwd: 'C:\\work\\alpha\\' + 'd'.repeat(400), lastFocusedAt: NOW - 2 * HOUR, turnWrapUp: { description: '😀'.repeat(800) }, spawnedFrom: { sessionId: sid(1) } });
  const b = board([parent, s]);
  const card = b.buckets.unread.find((/** @type {any} */ c) => c.id === sid(2));
  assert.equal(Array.from(card.title).length, 200);
  assert.ok(card.title.endsWith('…'));
  assert.equal(Array.from(card.body).length, 600);
  assert.equal(Array.from(card.family.parentTitle).length, 40);
  assert.equal('cwd' in card.detail, false);
  assert.ok(!JSON.stringify(card).includes('C:\\work\\alpha'));
});

test('Git worktree detail is an allowlist and suppresses path-like refs and private fields', () => {
  const s = Object.assign(rec(1, { branch: 'C:\\private\\branch', worktreeName: '\\\\server\\share' }), {
    gitWorktree: { branch: 'feature/canvas', status: 'changed', changed: 2, untracked: 1, conflicted: 0, locked: true, prunable: false,
      path: 'C:\\private\\repo', lockedReason: 'private secret reason', commonDir: 'C:\\private\\repo\\.git' },
  });
  const b = board([s]);
  const cards = [...Object.values(b.buckets).flat(), ...b.recentGroups.flatMap((g) => g.items)];
  const card = cards.find((c) => c.id === sid(1));
  assert.deepEqual(card.detail.gitWorktree, { branch: 'feature/canvas', status: 'changed', changed: 2, untracked: 1, conflicted: 0, locked: true, prunable: false });
  assert.equal(card.detail.branch, undefined);
  assert.equal(card.detail.worktreeName, undefined);
  const json = JSON.stringify(card);
  for (const secret of ['C:\\private', 'server\\share', 'private secret reason', 'lockedReason', 'worktreePath', 'commonDir']) assert.ok(!json.includes(secret), secret);
});

test('出力に元データの大きな項目と folder hints は入らない (許可した項目だけ)', () => {
  const raw = {
    sessionId: sid(1), cliSessionId: cid(1), title: 't', createdAt: NOW - HOUR, lastActivityAt: NOW - HOUR, isArchived: false,
    remoteMcpServersConfig: [{ name: 'x', token: 'should-not-leak' }], promptAppendSnapshot: { a: 1 }, enabledMcpTools: { a: true },
    sessionPermissionUpdates: [1], permissionMode: 'bypassPermissions', model: 'm', pendingFirstStart: { since: NOW, task: 'secret-task-text' },
  };
  const s = /** @type {any} */ ({ ...toSessionRecord(raw), folders: { origin: { kind: 'repo', name: 'hint-only-name' }, cwd: { kind: 'container' } } });
  const json = JSON.stringify(board([s]));
  assert.ok(FORBIDDEN_OUTPUT_KEYS.includes('folders'));
  for (const key of FORBIDDEN_OUTPUT_KEYS) assert.ok(!json.includes(`"${key}"`), key);
  assert.ok(!json.includes('should-not-leak'));
  assert.ok(!json.includes('secret-task-text'));
  assert.ok(!json.includes('bypassPermissions'));
  assert.ok(!json.includes('"container"'));
  assert.ok(!json.includes('"cwd"'));
  // hint の名前はプロジェクト名としてだけ出る (起動しないまま止まっているので「止まっているかも」)
  assert.deepEqual(board([s]).buckets.trouble[0].project, { key: 'hint-only-name', label: 'hint-only-name', extra: 0 });
});

test('PR のリンクは https://github.com/ のときだけ', () => {
  const s = rec(1, { prs: [{ prNumber: 1, repo: 'o/r', state: 'OPEN', url: 'https://github.com/o/r/pull/1' }, { prNumber: 2, repo: 'o/r', state: 'OPEN', url: 'javascript:alert(1)' }] });
  const card = board([s]).recentGroups[0].items[0];
  const urlOf = new Map(card.prs.map((/** @type {any} */ p) => [p.num, p.url]));
  assert.deepEqual([urlOf.get(1), urlOf.get(2)], ['https://github.com/o/r/pull/1', null]);
});

test('PR は open を先に新しい順に並べてから 10 件で切る (後から作った open が落ちない)', () => {
  const prs = [
    ...Array.from({ length: 10 }, (_, i) => ({ prNumber: i + 1, repo: 'o/r', state: 'MERGED' })),
    { prNumber: 11, repo: 'o/r', state: 'OPEN' },
    { prNumber: 12, repo: 'o/r', state: 'OPEN' },
  ];
  const card = board([rec(1, { prs })]).recentGroups[0].items[0];
  assert.equal(card.prs.length, 10);
  assert.deepEqual(card.prs.slice(0, 3).map((/** @type {any} */ p) => [p.num, p.state]), [[12, 'OPEN'], [11, 'OPEN'], [10, 'MERGED']]);
  assert.equal(card.detail.prsMore, 2);
  // 片付け候補の「PR がまだ open」の行でも、その open の PR が一覧に入る
  const old = idle(2, { prs });
  const row = allCleanupRows(board([old])).find((/** @type {any} */ r) => r.id === sid(2));
  assert.equal(row.cleanup.note, 'open_pr');
  assert.ok(row.prs.some((/** @type {any} */ p) => p.state === 'OPEN'));
});

test('PR 済みの行: reasonParams.prs は紐づけた順の先頭 2 件 (状態はコードのまま)、残りは more', () => {
  const two = idle(1, { lastActivityAt: NOW - 3 * DAY, lastFocusedAt: NOW - 3 * DAY + MIN, prs: [{ prNumber: 1, repo: 'o/alpha-app', state: 'MERGED' }, { prNumber: 1, repo: 'o/beta-app', state: 'MERGED' }] });
  const same = idle(2, { lastActivityAt: NOW - 3 * DAY, lastFocusedAt: NOW - 3 * DAY + MIN, prs: [{ prNumber: 3, repo: 'o/r', state: 'MERGED' }, { prNumber: 4, repo: 'o/r', state: 'CLOSED' }, { prNumber: 5, repo: 'o/r', state: 'MERGED' }] });
  const rows = new Map(group(board([two, same]), 'pr_done').items.map((/** @type {any} */ r) => [r.id, r]));
  assert.deepEqual(rows.get(sid(1)).reasonParams, { prs: [{ num: 1, repo: 'o/alpha-app', state: 'MERGED' }, { num: 1, repo: 'o/beta-app', state: 'MERGED' }] });
  assert.deepEqual(rows.get(sid(2)).reasonParams, { prs: [{ num: 3, repo: 'o/r', state: 'MERGED' }, { num: 4, repo: 'o/r', state: 'CLOSED' }], more: 1 });
});

test('片付け候補の行の reasonParams: old_error は先頭 80 字、old_question は質問 (無ければ省く)、他の理由は無い', () => {
  const oldErr = rec(1, { createdAt: NOW - 10 * DAY, lastActivityAt: NOW - 9 * DAY, error: ' API Error: ' + 'e'.repeat(200), errorAt: NOW - 9 * DAY });
  const oldQ = rec(2, { lastActivityAt: NOW - 9 * DAY, postTurnSummary: { needs_action: '  どちらにしますか?  ' } });
  const blocked = rec(3, { lastActivityAt: NOW - 9 * DAY, postTurnSummary: { status_category: 'blocked', needs_action: '' } });
  const detailOnly = rec(6, { lastActivityAt: NOW - 9 * DAY, postTurnSummary: { status_category: 'blocked', needs_action: '   ', status_detail: '確認待ち' } });
  const b = board([oldErr, oldQ, blocked, idle(4), rec(5, { lastActivityAt: NOW - 10 * DAY, lastFocusedAt: NOW - 10 * DAY }), detailOnly]);
  const rows = new Map(allCleanupRows(b).map((/** @type {any} */ r) => [r.id, r]));
  const e = rows.get(sid(1)).reasonParams.error;
  assert.ok(e.startsWith('API Error: '));
  assert.equal(Array.from(e).length, 80);
  assert.deepEqual(rows.get(sid(2)).reasonParams, { question: 'どちらにしますか?' });
  assert.equal(rows.get(sid(3)).reason, 'old_question');
  assert.equal('reasonParams' in rows.get(sid(3)), false);
  assert.equal('reasonParams' in rows.get(sid(4)), false);
  assert.equal('reasonParams' in rows.get(sid(5)), false);
  // needs_action が空白だけなら status_detail を使う
  assert.deepEqual(rows.get(sid(6)).reasonParams, { question: '確認待ち' });
});

test('片付け候補の行: やり直し済みの起動失敗は reason だけ', () => {
  const failed = rec(1, { title: '同じ作業', createdAt: NOW - 3 * HOUR, lastActivityAt: NOW - 3 * HOUR, error: 'Git is broken', errorAt: NOW - 3 * HOUR, errorCategory: 'git_startup_failed' });
  const retry = rec(2, { title: '同じ作業', createdAt: NOW - 2 * HOUR, lastActivityAt: NOW - HOUR });
  const row = group(board([failed, retry]), 'retried').items[0];
  assert.deepEqual([row.reason, 'reasonParams' in row, row.cleanup.recommended], ['retried', false, true]);
});

test('質問ツール (AskUserQuestion) の返事待ちは「あなたの返事待ち」で、本文は質問文', () => {
  const s = rec(1, { lastActivityAt: NOW - 20 * MIN, lastFocusedAt: NOW - 20 * MIN });
  const b = board([s], { turns: { [sid(1)]: ti(tails.asking('青と緑のどちらにしますか?'), 20 * MIN) } });
  assert.equal(b.buckets.working.length, 0);
  assert.equal(b.buckets.needs_you.length, 1);
  const card = b.buckets.needs_you[0];
  assert.deepEqual([card.reason, card.body, card.timeKind, card.since], ['asking', '青と緑のどちらにしますか?', 'waiting', NOW - 20 * MIN]);
  assert.deepEqual(card.reasonParams, { ask: 'question' });
});

test('定期実行の履歴: 中断で終わった回は「完了」ではなく「途中で止まった」に数える', () => {
  const runs = [0, 1, 2, 3].map((i) => rec(10 + i, { title: '定期', scheduledTaskId: 'rt', createdAt: NOW - i * DAY - HOUR, lastActivityAt: NOW - i * DAY - 50 * MIN }));
  const interrupted = [tails.tool(), synth.interrupted(), ''].join('\n');
  const turns = {
    [sid(10)]: ti(tails.ended(), 50 * MIN),
    [sid(11)]: ti(tails.ended(), DAY + 50 * MIN),
    [sid(12)]: ti(interrupted, 2 * DAY + 50 * MIN),
    [sid(13)]: ti(tails.asking(), 3 * DAY + 50 * MIN),
  };
  const b = board(runs, { turns });
  const card = [...b.buckets.unread, ...b.recentGroups.flatMap((/** @type {any} */ g) => g.items)].find((/** @type {any} */ c) => c.id === sid(10));
  assert.deepEqual([card.routine.completed, card.routine.stalled], [1, 2]);
  // 定期実行の古い回の質問は返事待ちに出さず、片付け候補にまとめる
  assert.equal(b.buckets.needs_you.length, 0);
});

test('dispatchParentId の擬似 ID (local_ditto_*) は親として扱わない', () => {
  const s = rec(1, { dispatchParentId: 'local_ditto_00000000-0000-4000-8000-0000000d1770' });
  const card = board([s]).recentGroups[0].items[0];
  assert.equal(card.family, undefined);
});

test('文字数の上限: プロジェクト名 (key / label / グループ名) と親の ID も上限内', () => {
  const s = rec(1, { originCwd: 'C:/work/' + 'A'.repeat(5000), cwd: '', spawnedFrom: { sessionId: 'p'.repeat(5000) }, lastFocusedAt: NOW });
  const b = board([s]);
  const card = b.recentGroups[0].items[0];
  assert.ok(Array.from(card.project.label).length <= 200);
  assert.ok(Array.from(card.project.key).length <= 200);
  assert.ok(Array.from(b.recentGroups[0].label).length <= 200);
  assert.equal(card.family, undefined, '形の合わない親 ID は出さない');
  for (const [k, v] of Object.entries(card)) if (typeof v === 'string') assert.ok(v.length <= 600, k);
});

test('最近のグループはプロジェクト別で、フォルダなしは最後 (label null、gloss は無い)', () => {
  const b = board([
    rec(1, { cwd: 'C:\\work', originCwd: 'C:\\work', lastActivityAt: NOW - MIN, lastFocusedAt: NOW }),
    rec(2, { cwd: 'C:\\work\\beta', originCwd: 'C:\\work\\beta', lastActivityAt: NOW - 3 * HOUR }),
    rec(3, { lastActivityAt: NOW - 2 * HOUR }),
  ]);
  assert.deepEqual(b.recentGroups.map((/** @type {any} */ g) => g.label), ['alpha', 'beta', null]);
  assert.deepEqual(Object.keys(b.recentGroups[2]), ['key', 'label', 'items']);
  assert.equal(b.recentGroups[2].key, '(other)');
  const other = b.recentGroups[2].items[0];
  assert.deepEqual(other.project, { key: '(other)', label: null, extra: 0 });
});

test('会話ログを読むのは非アーカイブかつ最近 7 日のものだけ', () => {
  const t = selectTranscriptTargets([rec(1), rec(2, { isArchived: true }), idle(3), rec(4, { cliSessionId: undefined })], new Set(), NOW);
  assert.deepEqual(t, [{ sessionId: sid(1), cliSessionId: cid(1) }]);
});

test('統計: 最近で会話ログが無いもの / 形式を読めないものを数える', () => {
  const b = board([rec(1), rec(2), rec(3)], { turns: { [sid(1)]: ti(tails.ended(), HOUR), [sid(2)]: ti('{"type":"summary"}\n', HOUR) } });
  assert.deepEqual([b.stats.recentTotal, b.stats.recentWithTranscript, b.stats.transcriptsMissingRecent, b.stats.unknownTurnRecent], [3, 2, 1, 1]);
});

test('統計: cliSessionId の無いセッション (CLI が始まる前の起動失敗) は「会話ログが見つからない」に数えない', () => {
  const noCli = rec(2, { cliSessionId: undefined, errorCategory: 'git_startup_failed', error: 'Git is broken', errorAt: NOW - HOUR, pendingFirstStart: { since: NOW - HOUR } });
  const b = board([rec(1), noCli], { turns: { [sid(1)]: ti(tails.ended(), HOUR) } });
  assert.deepEqual([b.stats.recentTotal, b.stats.transcriptsMissingRecent], [2, 0]);
});

// --- v0.2: していること・コンテキスト・形式の異常 (spec/board.md §5.1〜§5.3・§9・§10) ---

const joinLines = (/** @type {string[]} */ ...lines) => lines.join('\n') + '\n';
/** 作業中の tail: 指示 → usage つきの Bash (まだ結果が無い)。 @param {number} used */
const workTail = (used, model = 'claude-test-1') =>
  joinLines(
    synth.prompt('go', NOW - 10 * MIN),
    synth2.tool('Bash', { command: 'npm test -- --grep private-case', description: 'Run the unit tests' }, { usage: usageOf(used), at: NOW - 2 * MIN, model }),
  );
/** 終わった tail: 指示 → usage つきの Edit → 結果 → 返事 → stop_hook_summary。 @param {number} used */
const endedTail = (used) =>
  joinLines(
    synth.prompt('go'),
    synth2.tool('Edit', { file_path: 'C:\\work\\alpha\\private-dir\\board.mjs' }, { usage: usageOf(used), at: NOW - HOUR }),
    synth.toolResult(),
    synth.text('done'),
    synth.stopHook(),
  );
/** 本筋の assistant 行はあるが usage の無い tail。 */
const noUsageTail = () => joinLines(synth.prompt('go'), synth.text('done'), synth.stopHook());
/** @param {any} b */
const liveCards = (b) => [...b.buckets.needs_you, ...b.buckets.trouble, ...b.buckets.unread, ...b.buckets.working, ...b.recentGroups.flatMap((/** @type {any} */ g) => g.items)];
/** @param {any} b @param {number} n */
const cardOf = (b, n) => [...liveCards(b), ...allCleanupRows(b)].find((c) => c.id === sid(n) || c.routine?.runIds?.includes(sid(n)));

test('v0.2: context と activity は最近 7 日で transcript があるものだけ。返事待ちに activity は付かず、片付けにはどちらも付かない', () => {
  const runs = [0, 1].map((i) => rec(10 + i, { scheduledTaskId: 'synthetic-routine', createdAt: NOW - (i + 1) * HOUR, lastActivityAt: NOW - (i + 1) * HOUR + MIN, contextExceededCount: 3 }));
  const sessions = [
    rec(1), // 作業中
    rec(2), // 返事待ち (質問ツール)
    rec(3, { lastFocusedAt: undefined }), // 未読
    rec(4, { lastActivityAt: NOW - 8 * DAY, lastFocusedAt: NOW - 8 * DAY + MIN, createdAt: NOW - 9 * DAY }), // 8 日前 → 片付け
    rec(5), // 最近、transcript なし
    ...runs,
  ];
  const turns = {
    [sid(1)]: ti(workTail(150_000), MIN),
    [sid(2)]: ti(joinLines(synth.prompt('go'), synth2.usage(40_000), synth.ask('q1', 'どちら?')), MIN),
    [sid(3)]: ti(endedTail(90_000), HOUR),
    [sid(4)]: ti(endedTail(90_000), 8 * DAY),
    [sid(10)]: ti(endedTail(90_000), HOUR),
    [sid(11)]: ti(endedTail(90_000), 2 * HOUR),
  };
  const b = board(sessions, { turns });
  const working = cardOf(b, 1);
  assert.equal(working.bucket, 'working');
  assert.deepEqual(working.activity, { kind: 'test', target: 'npm test', note: 'Run the unit tests', live: true, at: NOW - 2 * MIN });
  assert.deepEqual(working.context, { used: 150_000, window: 200_000, inferred: true, pct: 75, compactAt: 167_000, level: 'due' });
  const asking = cardOf(b, 2);
  assert.equal(asking.bucket, 'needs_you');
  assert.equal(asking.activity, undefined);
  assert.equal(asking.context?.used, 40_000);
  const unread = cardOf(b, 3);
  assert.deepEqual(unread.activity, { kind: 'edit', target: 'board.mjs', live: false, at: NOW - HOUR });
  assert.equal(unread.context?.pct, 45);
  for (const n of [4, 11]) {
    const c = cardOf(b, n);
    assert.equal(c.bucket, 'cleanup', `${n}`);
    assert.equal(c.activity, undefined);
    assert.equal(c.context, undefined);
    assert.equal(c.detail.contextExceeded, undefined); // 片付けには付けない
  }
  assert.equal(cardOf(b, 5).activity, undefined);
  assert.equal(cardOf(b, 5).context, undefined);
  assert.notEqual(cardOf(b, 10).bucket, 'cleanup');
  assert.equal(cardOf(b, 10).detail.contextExceeded, 3); // 定期実行の最新回 (片付け以外)
});

test('v0.2: detail.contextExceeded は 1 以上の整数のときだけ', () => {
  const b = board([1, 2, 3, 4].map((n) => ({ ...rec(n), contextExceededCount: [2, 0, 1.5, undefined][n - 1] })));
  assert.equal(cardOf(b, 1).detail.contextExceeded, 2);
  for (const n of [2, 3, 4]) assert.equal('contextExceeded' in cardOf(b, n).detail, false);
});

test('v0.2: 作業中で subagent が動いていれば (subLive) activity は agents と n。止まったかもは live false で時点つき', () => {
  const turns = {
    [sid(1)]: ti(workTail(10_000), MIN, 30 * 1000, 3),
    [sid(2)]: ti(workTail(10_000), 40 * MIN, undefined, 5), // 無音 40 分 → 止まったかも (subLive は作業中だけに効く)
  };
  const b = board([rec(1), rec(2)], { turns });
  assert.deepEqual(cardOf(b, 1).activity, { kind: 'agents', n: 3, live: true, at: NOW - 2 * MIN });
  const stuck = cardOf(b, 2);
  assert.equal(stuck.bucket, 'trouble');
  assert.deepEqual(stuck.activity, { kind: 'test', target: 'npm test', note: 'Run the unit tests', live: false, at: NOW - 2 * MIN });
});

test('v0.2: stats.contextSeen / activitySeen / contextSuspect。A = 5 で 2 件欠け → true で全部の context が消える、1 件 → false', () => {
  const sessions = [1, 2, 3, 4, 5, 6].map((n) => rec(n));
  /** @param {number} missing */
  const turnsWith = (missing) => {
    /** @type {Record<string, any>} */
    const t = {};
    for (let n = 1; n <= 5; n++) t[sid(n)] = ti(n <= missing ? noUsageTail() : endedTail(20_000 * n), HOUR);
    t[sid(6)] = ti(joinLines(synth.prompt('go')), HOUR); // 返事のまだ無いセッションは分母に入れない
    return t;
  };
  const two = board(sessions, { turns: turnsWith(2) });
  assert.deepEqual([two.stats.contextSeen, two.stats.activitySeen, two.stats.contextSuspect], [3, 3, true]);
  assert.equal(liveCards(two).filter((c) => c.context).length, 0);
  assert.equal(liveCards(two).filter((c) => c.activity).length, 4); // activity は消さない (think を含む)
  const one = board(sessions, { turns: turnsWith(1) });
  assert.deepEqual([one.stats.contextSeen, one.stats.activitySeen, one.stats.contextSuspect], [4, 4, false]);
  assert.equal(liveCards(one).filter((c) => c.context).length, 4);
  // 4 件 (FORMAT_SUSPECT_MIN 未満) なら全部欠けても疑わない
  const few = board(sessions.slice(0, 4), { turns: Object.fromEntries([1, 2, 3, 4].map((n) => [sid(n), ti(noUsageTail(), HOUR)])) });
  assert.equal(few.stats.contextSuspect, false);
  const empty = board([rec(1)]).stats;
  assert.deepEqual([empty.contextSeen, empty.activitySeen, empty.contextSuspect], [0, 0, false]);
});

test('v0.2: 渡された tailFacts をそのまま使い (parse し直さない)、無いセッションは core がその場で作る', () => {
  const memo = new Map([
    [sid(1), { turn: { turn: 'ended', relevant: 1 }, activity: { kind: 'web', target: 'docs.example.com' }, context: { maxUsed: 0, hasAssistant: true } }],
  ]);
  const b = board([rec(1), rec(2)], { turns: { [sid(1)]: ti('not json at all\n', HOUR), [sid(2)]: ti(endedTail(20_000), HOUR) }, tailFacts: memo });
  assert.deepEqual(cardOf(b, 1).activity, { kind: 'web', target: 'docs.example.com', live: false });
  assert.equal(cardOf(b, 1).bucket, 'recent'); // memo のターン状態 (ended) で分類した
  assert.equal(b.stats.unknownTurnRecent, 0);
  assert.equal(cardOf(b, 2).activity?.kind, 'edit');
});

test('v0.2: 前回の段階 (prevContext) が帯に効く。別の会話ログの prev は使わない', () => {
  const used = Math.round(0.8 * 167_000); // f = 0.80: 新しく入るなら notice、due からなら帯の中
  const turns = { [sid(1)]: ti(endedTail(used), HOUR) };
  assert.equal(cardOf(board([rec(1)], { turns }), 1).context.level, 'notice');
  const prev = new Map([[sid(1), { cli: cid(1), level: 'due', used: used + 2000 }]]);
  assert.equal(cardOf(board([rec(1)], { turns, prevContext: prev }), 1).context.level, 'due');
  const other = new Map([[sid(1), { cli: cid(9), level: 'due', used: used + 2000 }]]);
  assert.equal(cardOf(board([rec(1)], { turns, prevContext: other }), 1).context.level, 'notice');
});

test('v0.2: 窓は model と tail の証拠から ([1m] → 1M、同じ model の別のセッションが 200K 超 → 1M 推定)', () => {
  const models = ['claude-test-1[1m]', 'claude-test-2', 'claude-test-2'];
  const sessions = [1, 2, 3].map((n) => ({ ...rec(n), model: models[n - 1] }));
  const b = board(sessions, {
    turns: { [sid(1)]: ti(endedTail(100_000), HOUR), [sid(2)]: ti(endedTail(400_000), HOUR), [sid(3)]: ti(endedTail(100_000), HOUR) },
  });
  assert.deepEqual([cardOf(b, 1).context.window, cardOf(b, 1).context.inferred], [1_000_000, false]);
  assert.deepEqual([cardOf(b, 2).context.window, cardOf(b, 2).context.inferred], [1_000_000, false]);
  assert.deepEqual([cardOf(b, 3).context.window, cardOf(b, 3).context.inferred, cardOf(b, 3).context.pct], [1_000_000, true, 10]);
});

/**
 * JSON を木として歩き、FORBIDDEN_WIRE_KEYS のキーと、prs[] の要素の外の 'state' を集める。
 * @param {unknown} node
 * @param {boolean} inPrsItem
 * @param {string} path
 * @param {string[]} bad
 */
function wireKeyViolations(node, inPrsItem = false, path = '$', bad = []) {
  if (Array.isArray(node)) {
    const isPrs = path.endsWith('.prs');
    node.forEach((v, i) => wireKeyViolations(v, isPrs, `${path}[${i}]`, bad));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_WIRE_KEYS.includes(k)) bad.push(`${path}.${k}`);
      if (k === 'state' && !inPrsItem) bad.push(`${path}.${k}`);
      wireKeyViolations(v, false, `${path}.${k}`, bad);
    }
  }
  return bad;
}

test('v0.2: 木の検査そのものが効くこと (model と、prs[] の外の state を見つける)', () => {
  assert.deepEqual(wireKeyViolations({ a: { model: 'x' } }), ['$.a.model']);
  assert.deepEqual(wireKeyViolations({ prs: [{ state: 'OPEN' }], reasonParams: { prs: [{ state: 'MERGED' }] } }), []);
  assert.deepEqual(wireKeyViolations({ state: 'x', prs: [{ deeper: { state: 'y' } }] }), ['$.state', '$.prs[0].deeper.state']);
});

test('v0.2: /api/board の JSON に model・command・input・file_path・description・usage などのキーは無く、state は prs[] の中だけ', () => {
  const rich = joinLines(
    synth.prompt('go', NOW - 10 * MIN),
    synth2.tool('TodoWrite', { todos: [{ content: 'Read C:\\work\\alpha\\private-dir\\plan.md', activeForm: 'Reading C:\\work\\alpha\\private-dir\\plan.md', status: 'in_progress' }] }),
    synth2.tool('WebFetch', { url: 'https://user:pw-secret@api.example.com/private/path?token=t0ken' }, { usage: usageOf(120_000) }),
    synth.toolResult(),
    synth2.compact({ trigger: 'auto', pre: 160_000, post: 30_000, at: NOW - 5 * MIN }),
    synth2.tool('Bash', { command: 'SECRET_VALUE=abc npm run deploy -- --target "C:\\work\\alpha\\private-dir"', description: 'Deploy to /home/tester/private-dir/out' }, { usage: usageOf(60_000), at: NOW - MIN }),
  );
  const sessions = [
    { ...rec(1), model: 'claude-test-1', contextExceededCount: 1 },
    { ...rec(2, { prs: [{ prNumber: 7, repo: 'o/r', state: 'MERGED', url: 'https://github.com/o/r/pull/7' }], lastActivityAt: NOW - 3 * DAY, lastFocusedAt: NOW - 3 * DAY + MIN }), model: 'claude-test-1' },
    { ...rec(3, { lastFocusedAt: undefined, prs: [{ prNumber: 8, repo: 'o/r', state: 'OPEN', url: 'https://github.com/o/r/pull/8' }] }), model: 'claude-test-1' },
  ];
  const b = board(sessions, { turns: { [sid(1)]: ti(rich, MIN), [sid(3)]: ti(rich, 30 * MIN) } });
  assert.equal(cardOf(b, 1).activity?.kind, 'run');
  assert.equal(cardOf(b, 1).activity?.step, 'Reading plan.md');
  assert.equal(cardOf(b, 1).activity?.note, 'Deploy to out');
  assert.equal(cardOf(b, 1).context?.used, 60_000);
  assert.equal(cardOf(b, 1).detail.contextExceeded, 1);
  assert.equal(cardOf(b, 2).reason, 'pr_done'); // reasonParams.prs[i].state がある
  assert.deepEqual(wireKeyViolations(JSON.parse(JSON.stringify(b))), []);
  const json = JSON.stringify(b);
  for (const key of FORBIDDEN_WIRE_KEYS) assert.ok(!json.includes(`"${key}"`), key);
  for (const raw of ['claude-test-1', 'SECRET_VALUE', 'private-dir', 'pw-secret', 't0ken', 'deploy --', '/private/path', 'compactMetadata']) {
    assert.ok(!json.includes(raw), raw);
  }
  assert.ok(json.includes('"state":"MERGED"'));
  assert.ok(json.includes('"state":"OPEN"'));
});
