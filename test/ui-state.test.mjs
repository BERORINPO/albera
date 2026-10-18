import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SKIP_EXPLAIN_MS } from '../src/shared/constants.mjs';
import { makeT } from '../public/i18n.mjs';
import {
  batchProgress, cardIndex, checkState, cleanupIds, commitCopy, cursorAfter, familyTree, focusSignature, groupState, nextUp, planCopy,
  presentIds, pruneSelection, rowIds, selbarMode, stepOf, suggestedIds, visibleModel,
} from '../public/ui-state.mjs';

const ids = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => `id${i + 1}`);
const en = makeT('en');
/** @param {string} id @param {Record<string, any>} [o] */
const c = (id, o = {}) => ({ id, bucket: 'recent', title: id, body: '', project: { key: 'demo-app', label: 'demo-app', extra: 0 }, ...o });

/** 合成の盤面 (v2 の形)。 */
function board() {
  return {
    v: 2,
    counts: { needs_you: 2, trouble: 1, unread: 1, working: 1, recent: 2, cleanup: 5, recommended: 3, active: 12, archived: 0 },
    buckets: {
      needs_you: [c('n1', { bucket: 'needs_you', since: 1 }), c('n2', { bucket: 'needs_you', since: 2, family: { rootId: 'r1', parentId: 'r1' } })],
      trouble: [c('t1', { bucket: 'trouble', reason: 'stalled', reasonParams: { via: 'tool' } })],
      unread: [c('u1', { bucket: 'unread' })],
      working: [c('w1', { bucket: 'working', family: { rootId: 'r1', parentId: 'n2' }, createdAt: 3 })],
    },
    recentGroups: [{ key: 'demo-app', label: 'demo-app', items: [c('r1', { createdAt: 1 }), c('r2')] }],
    cleanupGroups: [
      { reason: 'routine_old', recommendedReason: true, count: 3, recommendedCount: 3, items: [c('k1', { bucket: 'cleanup', routine: { runIds: ['k1', 'k0', 'kz'] }, cleanup: { recommended: true } })] },
      { reason: 'idle_7d', recommendedReason: false, count: 2, recommendedCount: 0, projects: [{ key: 'notes', label: 'notes', items: [c('i1', { bucket: 'cleanup', project: { key: 'notes', label: 'notes' }, cleanup: { recommended: false } }), c('i2', { bucket: 'cleanup', cleanup: { recommended: false, note: 'starred' } })] }] },
    ],
    families: { r1: { title: 'Root', memberIds: ['r1', 'n2', 'w1', 'kz'] } },
    stats: { formatSuspect: null },
  };
}

test('planCopy: まだコピーしていない先頭 50 件。全部コピー済みなら最初から', () => {
  const sel = ids(120);
  const p1 = planCopy(sel, new Set(), 50);
  assert.deepEqual([p1.chunk.length, p1.from, p1.to, p1.restart], [50, 1, 50, false]);
  const p2 = planCopy(sel, new Set(sel.slice(0, 50)), 50);
  assert.deepEqual([p2.chunk[0], p2.from, p2.to], ['id51', 51, 100]);
  const p3 = planCopy(sel, new Set(sel.slice(0, 100)), 50);
  assert.deepEqual([p3.from, p3.to], [101, 120]);
  const again = planCopy(sel, new Set(sel), 50);
  assert.deepEqual([again.chunk[0], again.from, again.to, again.restart], ['id1', 1, 50, true]);
});

test('planCopy は copied を書き換えない (コピーに失敗したら何も進まない)', () => {
  const sel = ids(30);
  const copied = new Set();
  const plan = planCopy(sel, copied, 50);
  assert.equal(copied.size, 0);
  assert.deepEqual(planCopy(sel, copied, 50), plan);
});

test('commitCopy: 成功した分だけ印を付けた新しい Set。最初からのときは付け直す', () => {
  const sel = ids(60);
  const copied = new Set();
  const after1 = commitCopy(sel, copied, planCopy(sel, copied, 50));
  assert.equal(copied.size, 0, '元の Set は変えない');
  assert.equal(after1.size, 50);
  const after2 = commitCopy(sel, after1, planCopy(sel, after1, 50));
  assert.equal(after2.size, 60);
  const after3 = commitCopy(sel, after2, planCopy(sel, after2, 50));
  assert.deepEqual([after3.size, after3.has('id51')], [50, false]);
});

test('pruneSelection: 片付けの欄から居なくなった ID は外し、盤面から消えたものを数える', () => {
  const r = pruneSelection(new Set(['a', 'b', 'c']), new Set(['a', 'c']), new Set(['a', 'c']), new Set(['a']));
  assert.deepEqual([...r.selected], ['a']);
  assert.deepEqual([...r.copied], ['a']);
  assert.equal(r.archived, 1);
});

test('batchProgress: 0 件・途中・全部・2 分後', () => {
  const batch = ['a', 'b', 'c', 'd'];
  assert.deepEqual(batchProgress(batch, new Set(batch), 1000), { total: 4, done: 0, left: 4, stale: false });
  assert.deepEqual(batchProgress(batch, new Set(['c', 'd']), 1000), { total: 4, done: 2, left: 2, stale: false });
  assert.deepEqual(batchProgress(batch, new Set(), 1000), { total: 4, done: 4, left: 0, stale: false });
  assert.equal(batchProgress(batch, new Set(['d']), SKIP_EXPLAIN_MS).stale, true);
  assert.equal(batchProgress(batch, new Set(['d']), SKIP_EXPLAIN_MS - 1).stale, false);
});

test('selbarMode と stepOf: 帯の状態と手順の段', () => {
  assert.equal(selbarMode(0, null), 'none');
  assert.equal(selbarMode(3, null), 'picked');
  assert.equal(selbarMode(3, { total: 3, done: 0, stale: false }), 'copied');
  assert.equal(selbarMode(1, { total: 3, done: 2, stale: false }), 'progress');
  assert.equal(selbarMode(0, { total: 3, done: 3, stale: true }), 'done');
  assert.equal(selbarMode(1, { total: 3, done: 2, stale: true }), 'left');
  assert.equal(selbarMode(3, { total: 3, done: 0, stale: true }), 'left');
  assert.equal(stepOf(0, false), 1);
  assert.equal(stepOf(2, false), 2);
  assert.equal(stepOf(0, true), 3);
  assert.equal(stepOf(5, true), 3);
});

test('checkState と groupState: 3 状態', () => {
  const sel = new Set(['a', 'b']);
  assert.equal(checkState(['a', 'b'], sel), 'on');
  assert.equal(checkState(['a', 'x'], sel), 'mixed');
  assert.equal(checkState(['x'], sel), 'off');
  assert.equal(groupState(['a', 'b'], ['a', 'b', 'z'], sel), 'on', 'おすすめを全部選べば on');
  assert.equal(groupState(['a', 'y'], ['a', 'y', 'z'], sel), 'mixed');
  assert.equal(groupState(['y'], ['y', 'a'], sel), 'mixed', 'おすすめ外だけ選んでいても mixed');
  assert.equal(groupState(['y'], ['y', 'z'], sel), 'off');
});

test('nextUp: 返事待ち > 止まったかも > 未読 の先頭 (古い順の先頭)', () => {
  const b = board();
  assert.equal(nextUp(b)?.card.id, 'n1');
  b.buckets.needs_you = [];
  assert.deepEqual([nextUp(b)?.pile, nextUp(b)?.card.id], ['trouble', 't1']);
  b.buckets.trouble = [];
  assert.equal(nextUp(b)?.pile, 'unread');
  b.buckets.unread = [];
  assert.equal(nextUp(b), null);
  assert.equal(nextUp(null), null);
});

test('cursorAfter: 同じ欄・別の欄へ移った・欄が空になった・何も無い', () => {
  const lists = (/** @type {Record<string, string[]>} */ o) => ['needs_you', 'trouble', 'unread', 'working', 'recent', 'cleanup'].map((pile) => ({ pile, ids: o[pile] ?? [] }));
  const cur = { id: 'b', pile: 'needs_you', index: 1 };
  assert.deepEqual(cursorAfter(cur, lists({ needs_you: ['x', 'a', 'b'] })), { cursor: { id: 'b', pile: 'needs_you', index: 2 }, moved: null });
  assert.deepEqual(cursorAfter(cur, lists({ needs_you: ['a', 'c'], working: ['b'] })), { cursor: { id: 'c', pile: 'needs_you', index: 1 }, moved: { id: 'b', to: 'working' } });
  assert.deepEqual(cursorAfter(cur, lists({ needs_you: ['a'] })).cursor, { id: 'a', pile: 'needs_you', index: 0 }, 'はみ出したら最後の行');
  assert.deepEqual(cursorAfter(cur, lists({ unread: ['u'], recent: ['r'] })).cursor, { id: 'u', pile: 'unread', index: 0 }, '次の空でない欄');
  assert.deepEqual(cursorAfter({ id: 'z', pile: 'cleanup', index: 0 }, lists({ needs_you: ['a'] })).cursor, { id: 'a', pile: 'needs_you', index: 0 }, '後ろに無ければ最初から');
  assert.deepEqual(cursorAfter(cur, lists({})), { cursor: null, moved: null });
  assert.deepEqual(cursorAfter(null, lists({ needs_you: ['a'] })), { cursor: null, moved: null });
});

test('focusSignature: 作り直した同じ部品は同じ署名、別のグループの同じボタンは別の署名', () => {
  const attrs = (/** @type {Record<string, string>} */ o) => (/** @type {string} */ n) => o[n] ?? null;
  const a = focusSignature('button', attrs({ 'data-action': 'sub', 'data-list': 'sub:idle_30d:demo', type: 'button' }), 'demo');
  const b = focusSignature('BUTTON', attrs({ type: 'button', 'data-list': 'sub:idle_30d:demo', 'data-action': 'sub' }), 'demo');
  assert.equal(a, b);
  const x = focusSignature('input', attrs({ 'data-action': 'pick-group', 'data-reason': 'idle_30d' }), 'idle_30d');
  const y = focusSignature('input', attrs({ 'data-action': 'pick-group', 'data-reason': 'pr_done' }), 'pr_done');
  assert.notEqual(x, y);
});

test('盤面の ID: 定期実行の行は runIds の全部を受け持つ', () => {
  const b = board();
  assert.deepEqual(rowIds(b.cleanupGroups[0].items[0]), ['k1', 'k0', 'kz']);
  assert.deepEqual(rowIds(c('q')), ['q']);
  assert.equal(cardIndex(b).get('kz')?.card.id, 'k1');
  assert.equal(cardIndex(b).get('w1')?.pile, 'working');
  const present = presentIds(b);
  for (const id of ['n1', 'r2', 'k0', 'i2']) assert.ok(present.has(id), id);
  assert.deepEqual([...cleanupIds(b)].sort(), ['i1', 'i2', 'k0', 'k1', 'kz']);
  assert.deepEqual(suggestedIds(b), ['k1', 'k0', 'kz']);
});

test('visibleModel: 文字の絞り込みは今の言語の理由文でも当たり、一致数を数える', () => {
  const b = board();
  const none = visibleModel(b, { t: en });
  assert.equal(none.filtering, false);
  assert.equal(none.counts.cleanup, 5, '絞り込みが無ければサーバーの数');
  const v = visibleModel(b, { q: 'permission', t: en });
  assert.equal(v.filtering, true);
  assert.deepEqual(v.buckets.trouble.map((x) => x.id), ['t1']);
  assert.equal(v.total, 1);
  const k = visibleModel(b, { q: 'k1', t: en });
  assert.equal(k.counts.cleanup, 3, '定期実行の行は回の数で数える');
  const s = visibleModel(b, { q: 'i2', t: en });
  assert.equal(s.cleanupGroups[0].projects.length, 1);
});

test('visibleModel: 親子の絞り込みは根と子孫、定期実行は runIds のどれかが入っていれば', () => {
  const v = visibleModel(board(), { family: 'r1', t: en });
  assert.deepEqual(v.buckets.needs_you.map((x) => x.id), ['n2']);
  assert.deepEqual(v.buckets.working.map((x) => x.id), ['w1']);
  assert.deepEqual(v.recentGroups[0].items.map((x) => x.id), ['r1']);
  assert.deepEqual(v.cleanupGroups.map((g) => g.reason), ['routine_old']);
  assert.equal(v.total, 1 + 1 + 1 + 3);
  const both = visibleModel(board(), { family: 'r1', q: 'w1', t: en });
  assert.equal(both.total, 1, '文字と親子は AND');
});

test('familyTree: 根が先頭、子は作成の古い順、自分の印、上限と残りの数', () => {
  const b = board();
  const idx = cardIndex(b);
  const tree = familyTree(b, idx, 'r1', 'w1');
  assert.ok(tree);
  assert.equal(tree.roots[0].id, 'r1');
  const n2 = tree.roots[0].children.find((/** @type {any} */ n) => n.id === 'n2');
  assert.ok(n2);
  assert.equal(n2.children[0].id, 'w1');
  assert.equal(n2.children[0].self, true);
  assert.equal(tree.more, 0);
  const small = familyTree(b, idx, 'r1', 'w1', 2);
  assert.ok(small);
  assert.equal(small.more, 2);
  assert.equal(familyTree(b, idx, 'nope', 'w1'), null);
});
