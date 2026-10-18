import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OVERVIEW_SHELF_MAX } from '../src/shared/constants.mjs';
import { makeT } from '../public/i18n.mjs';
import { markMove, overviewModel } from '../public/overview.mjs';
import { visibleModel } from '../public/ui-state.mjs';

const en = makeT('en');
/** @param {string} id @param {string} project @param {Record<string, any>} [o] */
const c = (id, project, o = {}) => ({
  id, title: id, body: '', since: 0, lastActivityAt: 0,
  project: project === '(other)' ? { key: '(other)', label: null, extra: 0 } : { key: project, label: project, extra: 0 },
  ...o,
});

/** @param {Record<string, any>} [o] */
function board(o = {}) {
  return {
    v: 2,
    counts: {},
    buckets: {
      needs_you: [c('n1', 'beta', { lastActivityAt: 10 })],
      trouble: [c('t1', 'alpha', { lastActivityAt: 50 })],
      unread: [c('u1', '(other)', { lastActivityAt: 90 })],
      working: [c('w1', 'gamma', { lastActivityAt: 70 }), c('w2', 'beta', { lastActivityAt: 80 })],
    },
    recentGroups: [
      { key: 'delta', label: 'delta', items: [c('r1', 'delta', { lastActivityAt: 30 })] },
      { key: 'beta', label: 'beta', items: [c('r2', 'beta', { lastActivityAt: 5 })] },
    ],
    cleanupGroups: [
      { reason: 'routine_old', items: [c('k1', 'epsilon', { lastActivityAt: 20, routine: { runIds: ['k1', 'k2', 'k3'] } })] },
      { reason: 'idle_30d', projects: [{ key: 'delta', items: [c('i1', 'delta', { lastActivityAt: 1 })] }] },
    ],
    families: {},
    ...o,
  };
}

test('overviewModel: 返事待ちのある棚が先、次に止まったかも・未読・作業中。フォルダなしは同じ順位の最後', () => {
  const m = overviewModel(board(), visibleModel(board(), { t: en }), {});
  assert.deepEqual(m.live.map((s) => s.key), ['beta', 'alpha', '(other)', 'gamma']);
  const beta = m.live[0];
  assert.deepEqual(beta.marks.map((/** @type {any} */ x) => [x.pile, x.id]), [['needs_you', 'n1'], ['working', 'w2'], ['recent', 'r2']], '欄の順、その中は行の順');
});

test('overviewModel: 最近と片付けだけの棚は静かな棚にたたみ、片付けは印でなく数 (runIds を数える)', () => {
  const m = overviewModel(board(), visibleModel(board(), { t: en }), {});
  assert.deepEqual(m.quiet.map((s) => s.key), ['delta', 'epsilon'], '新しい順');
  assert.equal(m.quiet[1].cleanup, 3);
  assert.equal(m.quiet[1].marks.length, 0);
  assert.equal(m.quiet[0].cleanup, 1);
  assert.deepEqual(m.quietCounts, { recent: 1, cleanup: 4 });
  assert.equal(m.showQuiet, false);
  assert.equal(overviewModel(board(), visibleModel(board(), { t: en }), { overviewQuiet: true }).showQuiet, true);
});

test('overviewModel: 1 棚 60 個まで、残りは more。切られるのは最近から', () => {
  const many = Array.from({ length: 70 }, (_, i) => c(`r${i}`, 'big'));
  const b = board({ recentGroups: [{ key: 'big', label: 'big', items: many }] });
  b.buckets.working.push(c('wb', 'big'));
  const m = overviewModel(b, visibleModel(b, { t: en }), {});
  const big = m.live.find((s) => s.key === 'big');
  assert.equal(big.marks.length, OVERVIEW_SHELF_MAX);
  assert.equal(big.more, 71 - OVERVIEW_SHELF_MAX);
  assert.equal(big.marks[0].id, 'wb', '作業中が先に残る');
});

test('overviewModel: 絞り込んだ集合だけを出す。何も無ければ empty', () => {
  const v = visibleModel(board(), { q: 'w1', t: en });
  const m = overviewModel(board(), v, {});
  assert.deepEqual(m.live.map((s) => s.key), ['gamma']);
  assert.equal(m.quiet.length, 0);
  const none = overviewModel(board(), visibleModel(board(), { q: 'zzz', t: en }), {});
  assert.equal(none.empty, true);
});

test('markMove: ←→ と j/k は読む順、↑↓ は前後の棚の同じ位置 (端でとまる)、Home / End、Enter と Esc', () => {
  const L = [3, 1, 4];
  assert.deepEqual(markMove('ArrowRight', { shelf: 0, index: 1 }, L), { shelf: 0, index: 2 });
  assert.deepEqual(markMove('j', { shelf: 0, index: 2 }, L), { shelf: 1, index: 0 });
  assert.deepEqual(markMove('ArrowRight', { shelf: 2, index: 3 }, L), { shelf: 2, index: 3 });
  assert.deepEqual(markMove('k', { shelf: 1, index: 0 }, L), { shelf: 0, index: 2 });
  assert.deepEqual(markMove('ArrowLeft', { shelf: 0, index: 0 }, L), { shelf: 0, index: 0 });
  assert.deepEqual(markMove('ArrowDown', { shelf: 0, index: 2 }, L), { shelf: 1, index: 0 });
  assert.deepEqual(markMove('ArrowDown', { shelf: 1, index: 0 }, L), { shelf: 2, index: 0 });
  assert.deepEqual(markMove('ArrowUp', { shelf: 2, index: 3 }, L), { shelf: 1, index: 0 });
  assert.deepEqual(markMove('ArrowUp', { shelf: 0, index: 1 }, L), { shelf: 0, index: 1 });
  assert.deepEqual(markMove('Home', { shelf: 2, index: 2 }, L), { shelf: 0, index: 0 });
  assert.deepEqual(markMove('End', { shelf: 0, index: 0 }, L), { shelf: 2, index: 3 });
  assert.equal(markMove('Enter', { shelf: 0, index: 0 }, L), 'activate');
  assert.equal(markMove(' ', { shelf: 0, index: 0 }, L), 'activate');
  assert.equal(markMove('Escape', { shelf: 0, index: 0 }, L), 'close');
  assert.equal(markMove('z', { shelf: 0, index: 0 }, []), 'close');
  assert.equal(markMove('x', { shelf: 0, index: 0 }, L), null);
});
