// 引き継ぎ (spec/ui.md §9.1–§9.4) の純粋関数と、それにつながる好み・キー・詳しくの作り直し (合成データ)。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HANDOFF, HOUR, MIN, UI_STORAGE_KEY } from '../src/shared/constants.mjs';
import { dueIds, handoffArmed, handoffPlan, handoffText, latchHandoffs, pruneHandoffs, rescueText } from '../public/handoff.mjs';
import { makeT } from '../public/i18n.mjs';
import { keyAction } from '../public/keys.mjs';
import { detailStamp } from '../public/rows.mjs';
import { loadPrefs, savePrefs, setView, state, storeHandoff } from '../public/state.mjs';
import { cardIndex } from '../public/ui-state.mjs';

const en = makeT('en');
const ja = makeT('ja');
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const ID = 'local_00000000-0000-4000-8000-0000000000aa';
/** @param {string|undefined} level @param {number} [pct] */
const ctxAt = (level, pct = 80) => ({ used: pct * 2000, window: 200000, inferred: false, pct, compactAt: 167000, ...(level ? { level } : {}) });
/** @param {Record<string, any>} o */
const card = (o) => ({ id: ID, title: 'Demo task', bucket: 'unread', reason: 'unread', lastActivityAt: NOW - HOUR, detail: {}, ...o });

test('handoffText: 7 行、{pct} を埋め、{ が残らない (en / ja)。ツールの名前も題名も入れない', () => {
  for (const t of [en, ja]) {
    const text = handoffText(t, { pct: 82 });
    const lines = text.split('\n');
    assert.equal(lines.length, 7, t.lang);
    assert.ok(lines[0].includes('82%'), t.lang);
    assert.ok(!text.includes('{'), t.lang);
    assert.ok(!/session_|update_plan|Agent\b/.test(text), t.lang);
  }
  assert.equal(handoffText(en, { pct: 82 }).split('\n')[6], 'Do nothing else.');
  assert.ok(handoffText(ja, { pct: 82 }).startsWith('この会話のコンテキストは約 82% まで埋まっています。'));
});

test('rescueText: 3 行、{id} を埋める (ID を含む唯一の指示文)', () => {
  for (const t of [en, ja]) {
    const lines = rescueText(t, { id: ID }).split('\n');
    assert.equal(lines.length, 3, t.lang);
    assert.ok(lines[0].includes(ID), t.lang);
    assert.ok(!lines.join('\n').includes('{'), t.lang);
  }
});

test('handoffPlan: 欄 × 段階 × 最後に動いた時刻 (23 時間 / 25 時間) × コピーの記録', () => {
  const levels = [undefined, 'notice', 'due', 'soon'];
  for (const bucket of ['unread', 'recent']) {
    for (const level of levels) {
      for (const age of [23 * HOUR, 25 * HOUR]) {
        for (const stored of [undefined, { at: NOW - HOUR, pct: 80 }]) {
          const p = handoffPlan(card({ bucket, context: ctxAt(level), lastActivityAt: NOW - age }), stored, NOW);
          const label = `${bucket} ${level} ${age / HOUR}h ${stored ? 'copied' : '-'}`;
          assert.equal(p.guide, 'handoff', label);
          assert.equal(p.why, null, label);
          const due = level === 'due' || level === 'soon';
          assert.equal(p.row, due && age < HANDOFF.ROW_MS ? (stored ? 'copied' : 'button') : null, label);
        }
      }
    }
  }
  assert.deepEqual(handoffPlan(card({ bucket: 'unread' }), undefined, NOW), { guide: null, row: null, why: 'handoff.whyUnknown' }, 'context が無ければ案内も無い');
  for (const level of levels) {
    assert.deepEqual(handoffPlan(card({ bucket: 'needs_you', reason: 'asking', context: ctxAt(level) }), undefined, NOW), { guide: null, row: null, why: 'ctx.answerFirst' });
    assert.deepEqual(handoffPlan(card({ bucket: 'working', reason: 'turn', context: ctxAt(level) }), undefined, NOW), { guide: null, row: null, why: 'ctx.afterWork' });
  }
  assert.deepEqual(handoffPlan(card({ bucket: 'cleanup', reason: 'idle_7d' }), undefined, NOW), { guide: null, row: null, why: 'handoff.whyUnknown' });
});

test('handoffPlan: 止まったかもは soon か contextExceeded で救出の案内。理由の言葉は limit とそれ以外', () => {
  const stuck = (/** @type {Record<string, any>} */ o) => handoffPlan(card({ bucket: 'trouble', reason: 'stalled', ...o }), undefined, NOW);
  assert.deepEqual(stuck({ context: ctxAt('soon', 92) }), { guide: 'rescue', row: null, why: null });
  assert.deepEqual(stuck({ context: ctxAt('due') }), { guide: null, row: null, why: 'handoff.whyStuck' });
  assert.deepEqual(stuck({ detail: { contextExceeded: 1 } }), { guide: 'rescue', row: null, why: null }, 'context が無くても上限超えの記録で');
  assert.deepEqual(stuck({ reason: 'limit', context: ctxAt('due') }), { guide: null, row: null, why: 'ctx.afterLimit' });
  assert.deepEqual(stuck({ reason: 'limit', context: ctxAt('soon') }), { guide: 'rescue', row: null, why: null });
  for (const why of ['ctx.answerFirst', 'ctx.afterWork', 'ctx.afterLimit', 'handoff.whyStuck', 'handoff.whyUnknown']) assert.ok(en.has(why) && ja.has(why), why);
});

test('handoffArmed: 記録なし・24 時間後・+5 ポイント・そのあとの要約で出し直す。+4 では出さない', () => {
  const stored = { at: NOW - HOUR, pct: 80 };
  const c = (/** @type {number} */ pct, /** @type {any} */ compacted) => card({ context: { ...ctxAt('due', pct), ...(compacted ? { compacted } : {}) } });
  assert.equal(handoffArmed(c(80), undefined, NOW), true);
  assert.equal(handoffArmed(c(80), stored, NOW), false);
  assert.equal(handoffArmed(c(84), stored, NOW), false, '+4');
  assert.equal(handoffArmed(c(85), stored, NOW), true, '+5');
  assert.equal(handoffArmed(c(80), stored, stored.at + HANDOFF.COPIED_MS - 1), false);
  assert.equal(handoffArmed(c(80), stored, stored.at + HANDOFF.COPIED_MS), true, '24 時間');
  assert.equal(handoffArmed(c(80, { at: stored.at - MIN, trigger: 'auto' }), stored, NOW), false, 'コピーより前の要約');
  assert.equal(handoffArmed(c(80, { at: stored.at + MIN, trigger: 'auto' }), stored, NOW), true, 'コピーより後の要約');
});

test('dueIds: due / soon で、いま引き継げる (案内のある) ものを割合の高い順、同じなら ID 順。作業中・返事待ち・上限・片付けは入れない', () => {
  const b = {
    buckets: {
      needs_you: [card({ id: 'n1', bucket: 'needs_you', context: ctxAt('due', 81) })],
      trouble: [
        card({ id: 't1', bucket: 'trouble', context: ctxAt('notice', 60) }),
        card({ id: 't2', bucket: 'trouble', reason: 'stalled', context: ctxAt('soon', 92) }),
        card({ id: 't3', bucket: 'trouble', reason: 'limit', context: ctxAt('due', 88) }),
      ],
      unread: [card({ id: 'u2', context: ctxAt('soon', 90) }), card({ id: 'u1', context: ctxAt('due', 81) })],
      working: [card({ id: 'w1', bucket: 'working', context: ctxAt('due', 85) }), card({ id: 'w2', bucket: 'working' })],
    },
    recentGroups: [{ key: 'p', items: [card({ id: 'r1', bucket: 'recent', context: ctxAt('soon', 95) })] }],
    cleanupGroups: [{ reason: 'idle_7d', items: [card({ id: 'c1', bucket: 'cleanup', context: ctxAt('soon', 99) })] }],
  };
  assert.deepEqual(dueIds(b), ['r1', 't2', 'u2', 'u1']);
  assert.deepEqual(dueIds(null), []);
});

test('latchHandoffs: コピーのあとに要約された・割合が REARM_PCT 以上下がった記録を落とす。何も落とさなければ同じ表', () => {
  const stored = { at: NOW - HOUR, pct: 82 };
  const map = { a: stored, b: stored, c: stored, gone: stored };
  const b = {
    buckets: {
      needs_you: [], trouble: [], working: [],
      unread: [
        card({ id: 'a', context: { ...ctxAt('due', 84), compacted: { at: NOW - 30 * MIN, trigger: 'auto' } } }),
        card({ id: 'b', context: ctxAt(undefined, 20) }),
        card({ id: 'c', context: ctxAt('due', 84) }),
      ],
    },
    recentGroups: [],
  };
  const out = latchHandoffs(map, b);
  assert.deepEqual(Object.keys(out).sort(), ['c', 'gone'], '要約のあとと、割合が下がったものを落とす (盤面に無いものは触らない)');
  assert.ok('a' in map, '元の表は書き換えない');
  const keep = { c: stored };
  assert.equal(latchHandoffs(keep, b), keep);
  assert.equal(latchHandoffs({}, b).constructor, Object);
  // 落としたあとは、要約の印が末尾から消えた次の due でボタンが出る
  const later = card({ id: 'a', context: ctxAt('due', 84) });
  assert.equal(handoffPlan(later, out.a, NOW).row, 'button');
  assert.equal(handoffPlan(later, stored, NOW).row, 'copied', '記録が残っていれば出ない (これを防ぐのが latch)');
});

test('pruneHandoffs: 24 時間より前と、形の壊れた記録を落とす (元の表は書き換えない)', () => {
  const map = { a: { at: NOW - HOUR, pct: 80 }, old: { at: NOW - HANDOFF.COPIED_MS, pct: 80 }, bad: { at: 'x', pct: 1 }, nul: null, arr: [1] };
  const out = pruneHandoffs(map, NOW);
  assert.deepEqual(out, { a: { at: NOW - HOUR, pct: 80 } });
  assert.ok('old' in map);
  assert.deepEqual(pruneHandoffs(null, NOW), {});
  assert.deepEqual(pruneHandoffs([1, 2], NOW), {});
});

test('prefs.handoff と prefs.view: storage が無い・壊れていても既定値。読み書きの度に古い記録を落とす', () => {
  const g = /** @type {any} */ (globalThis);
  const before = g.localStorage;
  try {
    delete g.localStorage;
    loadPrefs();
    assert.equal(state.prefs.view, 'list');
    assert.deepEqual(state.prefs.handoff, {});
    assert.equal(state.storageOk, false);
    /** @type {Record<string, string>} */
    const store = { [UI_STORAGE_KEY]: '{not json' };
    g.localStorage = { getItem: (/** @type {string} */ k) => store[k] ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { store[k] = v; } };
    loadPrefs();
    assert.equal(state.prefs.view, 'list');
    assert.deepEqual(state.prefs.handoff, {});
    store[UI_STORAGE_KEY] = JSON.stringify({ view: 'sideways', handoff: { x: { at: Date.now() - HANDOFF.COPIED_MS - 1, pct: 80 }, y: { at: Date.now(), pct: 70 } } });
    loadPrefs();
    assert.equal(state.prefs.view, 'list', '知らない表示は list');
    assert.deepEqual(Object.keys(state.prefs.handoff), ['y']);
    setView('canvas');
    storeHandoff(ID, { at: Date.now(), pct: 83 });
    const saved = JSON.parse(store[UI_STORAGE_KEY]);
    assert.equal(saved.view, 'canvas');
    assert.equal(saved.handoff[ID].pct, 83);
    g.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    loadPrefs();
    savePrefs();
    assert.equal(state.prefs.view, 'list');
    assert.equal(state.storageOk, false);
  } finally {
    if (before === undefined) delete g.localStorage;
    else g.localStorage = before;
  }
});

test('keyAction: h は引き継ぎ。押しっぱなしは 1 回だけ、1 文字キーを止めると効かない、入力欄では何もしない', () => {
  const on = { keysOn: true, target: /** @type {const} */ ('none') };
  assert.equal(keyAction({ key: 'h' }, on), 'handoff');
  assert.equal(keyAction({ key: 'h' }, { keysOn: true, target: 'title' }), 'handoff');
  assert.equal(keyAction({ key: 'h', repeat: true }, on), null);
  assert.equal(keyAction({ key: 'h' }, { keysOn: false, target: 'none' }), null);
  assert.equal(keyAction({ key: 'h' }, { keysOn: true, target: 'field' }), null);
  assert.equal(keyAction({ key: 'h', isComposing: true }, on), null);
  assert.equal(keyAction({ key: 'H', shiftKey: true }, on), null);
});

test('detailStamp: そのカードの引き継ぎのコピー済みの状態が変われば変わる (案内を作り直す)', () => {
  const c = card({ context: ctxAt('due') });
  const b = { buckets: { needs_you: [], trouble: [], unread: [c], working: [] }, recentGroups: [], cleanupGroups: [], families: {} };
  const stamp = (/** @type {any} */ handoff) => detailStamp(/** @type {any} */ ({ t: en, board: b, index: cardIndex(b), now: NOW, handoff }), ID);
  assert.equal(stamp({}), stamp(undefined));
  assert.notEqual(stamp({}), stamp({ [ID]: { at: NOW - MIN, pct: 80 } }));
  assert.equal(stamp({ other: { at: NOW - MIN, pct: 80 } }), stamp({}), 'ほかのカードの記録では変わらない');
});
