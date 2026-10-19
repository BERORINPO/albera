// 画面の不具合の再発防止 (合成データ): 絞り込み中のグループのチェック・見えている行でのカーソル・選び直し・
// 新着の印の期限・全体の署名とキー・詳しくの作り直し・開閉の記録の後始末・1 文字キーと Shift。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPick, hiddenPicks } from '../public/cleanup.mjs';
import { makeT } from '../public/i18n.mjs';
import { keyAction } from '../public/keys.mjs';
import { detailStamp } from '../public/rows.mjs';
import { pruneNew, reselectLeft, state } from '../public/state.mjs';
import { cardIndex, cursorAfter, listsFromRows, reselectIds, stalePrefKeys, visibleModel } from '../public/ui-state.mjs';

const en = makeT('en');
const NOW = Date.UTC(2026, 9, 17, 11, 0, 0);
/** @param {string} id @param {string} title @param {Record<string, any>} [o] */
const k = (id, title, o = {}) => ({ id, title, body: '', bucket: 'cleanup', project: { key: 'demo-app', label: 'demo-app' }, cleanup: { recommended: true }, ...o });

/** 片付けに 1 グループ (行のまま) と、プロジェクト別のサブグループのグループ。 */
function board() {
  return {
    v: 2,
    counts: { cleanup: 6, recommended: 6, active: 6 },
    buckets: { needs_you: [], trouble: [], unread: [], working: [] },
    recentGroups: [{ key: 'notes', label: 'notes', items: [] }],
    cleanupGroups: [
      { reason: 'idle_30d', items: [k('a1', 'Old chat 1'), k('a2', 'Old chat 2'), k('a3', 'Old chat 10')] },
      { reason: 'retried', projects: [{ key: 'demo-app', label: 'demo-app', items: [k('b1', 'Retry chat 1'), k('b2', 'Retry other')] }] },
    ],
    stats: {},
  };
}

/** applyPick に渡すチェックボックスの代わり (使うのは dataset と checked だけ)。 @param {Record<string, string>} dataset */
const box = (dataset) => /** @type {any} */ ({ dataset, checked: true, closest: () => null });

test('applyPick: 絞り込み中のグループのチェックは、見えている行だけを選ぶ・外す (隠れた行には触らない)', () => {
  const b = board();
  state.board = b;
  state.selected = new Set();
  const visible = visibleModel(b, { q: 'chat 1', t: en });
  assert.ok(applyPick(box({ action: 'pick-group', reason: 'idle_30d' }), visible));
  assert.deepEqual([...state.selected], ['a1', 'a3'], 'Old chat 2 は隠れているので選ばない');
  // 絞り込み前に隠れた行だけを選んでいた: 見た目は off なので、押すと見えている行を選ぶ (前の選択は消さない)
  state.selected = new Set(['a2']);
  applyPick(box({ action: 'pick-group', reason: 'idle_30d' }), visible);
  assert.deepEqual([...state.selected].sort(), ['a1', 'a2', 'a3']);
  // 見えている行が全部選ばれていれば、押すと見えている行だけを外す
  applyPick(box({ action: 'pick-group', reason: 'idle_30d' }), visible);
  assert.deepEqual([...state.selected], ['a2']);
  // サブグループも同じ
  state.selected = new Set();
  applyPick(box({ action: 'pick-sub', reason: 'retried', key: 'demo-app' }), visible);
  assert.deepEqual([...state.selected], ['b1']);
  // 絞り込みが無ければ盤面のとおり
  state.selected = new Set();
  applyPick(box({ action: 'pick-group', reason: 'idle_30d' }), visibleModel(b, { q: '', t: en }));
  assert.deepEqual([...state.selected], ['a1', 'a2', 'a3']);
});

test('hiddenPicks: 絞り込みで隠れた選択は filtered、閉じた欄・サブグループの中は closed (絞り込み中のサブグループは開いている)', () => {
  const b = board();
  const sel = new Set(['a1', 'a2', 'b1', 'b2']);
  const none = visibleModel(b, { q: '', t: en });
  assert.deepEqual(hiddenPicks(b, sel, { open: {} }, none), { closed: 2, filtered: 0 }, 'サブグループは既定で閉じている');
  assert.deepEqual(hiddenPicks(b, sel, { open: { 'sub:retried:demo-app': true } }, none), { closed: 0, filtered: 0 });
  assert.deepEqual(hiddenPicks(b, sel, { open: { cleanup: false } }, none), { closed: 4, filtered: 0 }, '欄ごと閉じている');
  const filtered = visibleModel(b, { q: 'chat 1', t: en });
  assert.deepEqual(hiddenPicks(b, sel, { open: {} }, filtered), { closed: 0, filtered: 2 }, 'a2 と b2 は絞り込みで隠れ、b1 は開いたサブグループの中');
  assert.deepEqual(hiddenPicks(b, sel, { open: { cleanup: false } }, filtered), { closed: 2, filtered: 2 });
});

test('cursorAfter + listsFromRows: 見えている行で決め直すと、次の行は隠れた行ではなく見えている次の行', () => {
  // 返事待ち [alpha, beta, gamma, beta two] を "beta" で絞ると [beta, beta two]。カーソルは beta (見えている行の 0 番目)
  const was = { id: 'beta', pile: 'needs_you', index: 0 };
  const visibleAfter = listsFromRows([{ id: 'beta two', pile: 'needs_you' }]);
  assert.deepEqual(cursorAfter(was, visibleAfter).cursor, { id: 'beta two', pile: 'needs_you', index: 0 });
  // 最近: 前のグループの 6 件目以降は「残りを表示」の後ろ。見えている行の 5 番目 (B0) が抜けたら、見えている次 (B1)
  const rows = ['A0', 'A1', 'A2', 'A3', 'A4', 'B1', 'B2'].map((id) => ({ id, pile: 'recent' }));
  assert.equal(cursorAfter({ id: 'B0', pile: 'recent', index: 5 }, listsFromRows(rows)).cursor?.id, 'B1');
  // 欄が空になったら次の空でない欄の先頭
  assert.deepEqual(cursorAfter({ id: 'x', pile: 'trouble', index: 0 }, listsFromRows([{ id: 'w1', pile: 'working' }])).cursor, { id: 'w1', pile: 'working', index: 0 });
});

test('reselectIds / reselectLeft: 選び直すのは今も片付けの欄にある ID だけ (別の欄へ移ったものは入れない)', () => {
  assert.deepEqual(reselectIds(['a', 'b', 'c'], new Set(['c', 'a'])), ['a', 'c']);
  const b = board();
  b.buckets.unread = [k('a2', 'Old chat 2', { bucket: 'unread' })];
  b.cleanupGroups[0].items = b.cleanupGroups[0].items.filter((c) => c.id !== 'a2');
  state.board = b;
  state.batch = { ids: ['a1', 'a2', 'gone'], lastCopyAt: 0, activeAtStart: 6, text: '' };
  state.copied = new Set(['a1', 'a2']);
  reselectLeft();
  assert.deepEqual([...state.selected], ['a1'], 'a2 は未読へ移った・gone は片付いた');
  assert.deepEqual([...state.copied], ['a2'], '選び直した ID のコピー済みの印だけ外す');
  assert.equal(state.batch, null);
});

test('pruneNew: 期限の切れた新着の印だけを消し、消したかどうかを返す (毎分の書き直しが止まらないように)', () => {
  state.newUntil = new Map([['needs_you:a', NOW - 1], ['needs_you:b', NOW + 1000]]);
  assert.equal(pruneNew(NOW), true);
  assert.deepEqual([...state.newUntil.keys()], ['needs_you:b']);
  assert.equal(pruneNew(NOW), false);
});

test('stalePrefKeys: 盤面に無いプロジェクトのサブグループと最近の開閉だけ (ほかの記録は残す)', () => {
  const prefs = { open: { recent: true, cleanup: false, 'sub:retried:demo-app': true, 'sub:retried:gone': true, 'sub:idle_30d:demo-app': false }, more: { unread: true, 'recent:notes': true, 'recent:gone': true } };
  assert.deepEqual(stalePrefKeys(prefs, board()), { open: ['sub:retried:gone', 'sub:idle_30d:demo-app'], more: ['recent:gone'], prefs: [] });
  assert.deepEqual(stalePrefKeys(prefs, null), { open: [], more: [], prefs: [] }, '盤面が無ければ何も消さない');
  // v0.1 の全体 (Overview) の好みは、盤面が無くても落とす (キャンバスの遠くの縮尺に置き換わった)
  assert.deepEqual(stalePrefKeys({ ...prefs, overview: true, overviewQuiet: false }, null).prefs, ['overview', 'overviewQuiet']);
});

test('keyAction: 1 文字のキーは Shift つきでも文字のまま効く (/ や数字に Shift が要る配列)。Shift+Enter・Shift+Space・Shift+矢印は無視', () => {
  const on = { keysOn: true, target: /** @type {const} */ ('none') };
  assert.equal(keyAction({ key: '/', shiftKey: true }, on), 'filter', 'ドイツ語の配列は Shift+7');
  assert.equal(keyAction({ key: '1', shiftKey: true }, on), 'jump:needs_you', 'フランス語の配列は数字の段に Shift');
  assert.equal(keyAction({ key: '?', shiftKey: true }, on), 'help');
  assert.equal(keyAction({ key: 'J', shiftKey: true }, on), null);
  assert.equal(keyAction({ key: 'Enter', shiftKey: true }, on), null);
  assert.equal(keyAction({ key: ' ', shiftKey: true }, on), null);
  assert.equal(keyAction({ key: 'ArrowDown', shiftKey: true }, on), null);
  // チェックボックスは 'control' (文字を受けない部品): j / x / c は効き、Space と Enter はブラウザのまま
  const control = { keysOn: true, target: /** @type {const} */ ('control') };
  assert.equal(keyAction({ key: 'x' }, control), 'pick');
  assert.equal(keyAction({ key: 'c' }, control), 'copy');
  assert.equal(keyAction({ key: ' ' }, control), null);
  assert.equal(keyAction({ key: 'Escape' }, control), 'escape');
});

test('detailStamp: ほかのカードが変わっただけでは変わらない。親子の木に出るメンバーの欄・言語・日付が変われば変わる', () => {
  const fam = { rootId: 'r', parentId: 'r' };
  const mk = (/** @type {string} */ siblingTitle, /** @type {string} */ rootPile = 'unread') => {
    const b = {
      buckets: { needs_you: [{ id: 'c', title: 'Child', family: fam }], trouble: [], unread: rootPile === 'unread' ? [{ id: 'r', title: 'Root' }] : [], working: rootPile === 'working' ? [{ id: 'r', title: 'Root' }] : [{ id: 'x', title: siblingTitle }] },
      recentGroups: [], cleanupGroups: [], families: { r: { title: 'Root', memberIds: ['r', 'c'] } },
    };
    if (rootPile === 'unread') b.buckets.working = [{ id: 'x', title: siblingTitle }];
    return b;
  };
  /** @param {any} b @param {any} [t] @param {number} [now] */
  const stamp = (b, t = en, now = NOW) => detailStamp(/** @type {any} */ ({ t, board: b, index: cardIndex(b), now }), 'c');
  assert.equal(stamp(mk('one')), stamp(mk('two')), '親子でないカードの変化では作り直さない');
  assert.notEqual(stamp(mk('one')), stamp(mk('one', 'working')), '根が別の欄へ移った');
  assert.notEqual(stamp(mk('one')), stamp(mk('one'), makeT('ja')));
  assert.notEqual(stamp(mk('one')), stamp(mk('one'), en, NOW + 24 * 3600 * 1000), '日付が変わった (「今日」の表示)');
});
