import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBoard, detectFormatSuspect, selectTranscriptTargets } from '../src/core/board.mjs';
import { FORBIDDEN_OUTPUT_KEYS } from '../src/shared/constants.mjs';
import { toSessionRecord } from '../src/adapters/session-record.mjs';
import { DAY, HOUR, MIN, NOW, ROOTS, cid, rec, sid, synth, tails, ti } from './helpers/fixtures.mjs';

/**
 * @param {any[]} sessions
 * @param {{turns?: Record<string, ReturnType<typeof ti>>, archived?: string[], sourceStats?: any, demo?: boolean}} [o]
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

test('文字数の上限: title 200 / 本文 600 / 親の title 40 / cwd 260 (code point 単位)', () => {
  const long = '字'.repeat(1000);
  const parent = rec(1, { title: '親'.repeat(100) });
  const s = rec(2, { title: long, cwd: 'C:\\work\\alpha\\' + 'd'.repeat(400), lastFocusedAt: NOW - 2 * HOUR, turnWrapUp: { description: '😀'.repeat(800) }, spawnedFrom: { sessionId: sid(1) } });
  const b = board([parent, s]);
  const card = b.buckets.unread.find((/** @type {any} */ c) => c.id === sid(2));
  assert.equal(Array.from(card.title).length, 200);
  assert.ok(card.title.endsWith('…'));
  assert.equal(Array.from(card.body).length, 600);
  assert.equal(Array.from(card.family.parentTitle).length, 40);
  assert.equal(Array.from(card.detail.cwd).length, 260);
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
