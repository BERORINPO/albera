// キャンバスの配置 (public/canvas-layout.mjs と public/canvas-desk.mjs、spec/ui.md §10.4)。データはすべて合成。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANVAS, DAY } from '../src/shared/constants.mjs';
import {
  arrange, buildSheets, colsFor, dropSheet, findSlip, FOLD_KEY, foldBlock, geometry, hasBand, layoutBoard, neighbour, orderSlots, pack, parseSeats, place, pushDown, readingOrder,
  settle, slipHeight, urgencyRank,
} from '../public/canvas-layout.mjs';

const { SLIP_W, SLIP_H, SLIP_H_MIN, SLIP_H_MAX, BACK_HEAD, FOLD_ROW, FOOT_H, GAP_X, GAP_Y, COLS_MIN, COLS_MAX, SNAP, NUDGE, SEAT_KEEP_MS } = CANVAS;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 18, 9, 0, 0);
const LIVE = ['needs_you', 'trouble', 'unread', 'working', 'recent'];
const PILES = [...LIVE, 'cleanup'];
const WIDE = 1280 / 800;
const NARROW = 400 / 700;

/** @param {string} key */
const proj = (key) => (key === '(other)' ? { key, label: null, extra: 0 } : { key, label: key, extra: 0 });
/** 合成のカード。 @param {string} id @param {string} pile @param {Record<string, any>} [o] */
const card = (id, pile, o = {}) => ({ id, bucket: pile, title: id, body: '', since: 0, lastActivityAt: 0, createdAt: 0, project: proj('alpha'), ...o });

/**
 * カードの並びから /api/board v2 の形を作る (片付けが 20 行を超えたらプロジェクト別のサブグループ)。
 * @param {Array<Record<string, any>>} cards @param {Record<string, any>} [families]
 */
function boardFrom(cards, families = {}) {
  /** @type {Record<string, any[]>} */
  const buckets = { needs_you: [], trouble: [], unread: [], working: [] };
  const recent = new Map();
  const cleanup = [];
  for (const c of cards) {
    if (c.bucket in buckets) buckets[c.bucket].push(c);
    else if (c.bucket === 'recent') {
      if (!recent.has(c.project.key)) recent.set(c.project.key, { key: c.project.key, label: c.project.label, items: [] });
      recent.get(c.project.key).items.push(c);
    } else cleanup.push(c);
  }
  const half = Math.ceil(cleanup.length / 2);
  const cleanupGroups = cleanup.length > 20
    ? [{ reason: 'idle_7d', count: cleanup.length, projects: [{ key: 'p1', items: cleanup.slice(0, half) }, { key: 'p2', items: cleanup.slice(half) }] }]
    : [{ reason: 'idle_7d', count: cleanup.length, items: cleanup }];
  return { v: 2, counts: {}, buckets, recentGroups: [...recent.values()], cleanupGroups, families, stats: {} };
}

/** @param {any} v */
function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

/** 決まった乱数 (mulberry32)。 @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 合成の盤面: n セッション、p プロジェクト。家族 (親は前のカード、別のプロジェクトのこともある) と定期実行の行も混ぜる。
 * @param {number} seed @param {number} n @param {number} p
 */
function randomCards(seed, n, p) {
  const r = rng(seed);
  const pick = (/** @type {any[]} */ xs) => xs[Math.floor(r() * xs.length)];
  /** @type {Array<Record<string, any>>} */
  const cards = [];
  /** @type {Map<string, string|undefined>} */
  const parent = new Map();
  for (let i = 0; i < n; i++) {
    const id = `s${String(i).padStart(4, '0')}`;
    const pid = i > 0 && r() < 0.3 ? cards[Math.floor(r() * i)].id : undefined;
    parent.set(id, pid);
    const key = p === 1 ? 'alpha' : r() < 0.06 ? '(other)' : `proj${Math.floor(r() * p)}`;
    const pile = pick(PILES);
    const extra = pile === 'cleanup' && r() < 0.1 ? { routine: { runIds: [id, `${id}-r1`, `${id}-r2`] } } : {};
    cards.push(card(id, pile, { project: proj(key), since: NOW - Math.floor(r() * 9 * DAY), lastActivityAt: NOW - Math.floor(r() * 9 * DAY), createdAt: NOW - Math.floor(r() * 30 * DAY), ...extra }));
  }
  /** @param {string} id */
  const rootOf = (id) => {
    let cur = id;
    for (let d = 0; d < 10 && parent.get(cur); d++) cur = /** @type {string} */ (parent.get(cur));
    return cur;
  };
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const c of cards) groups.set(rootOf(c.id), [...(groups.get(rootOf(c.id)) ?? []), c.id]);
  /** @type {Record<string, any>} */
  const families = {};
  for (const [root, ids] of groups) if (ids.length > 1) families[root] = { title: root, memberIds: ids };
  const withFamily = cards.map((c) => {
    const pid = parent.get(c.id);
    const root = rootOf(c.id);
    if (!pid && !families[root]) return c;
    return { ...c, family: { ...(families[root] ? { rootId: root } : {}), ...(pid ? { parentId: pid } : {}) } };
  });
  return { cards: withFamily, families };
}

/** 盤面をランダムに揺らす (欄が入れ替わる。プロジェクトは同じ)。 @param {Array<Record<string, any>>} cards @param {number} seed */
function flip(cards, seed) {
  const r = rng(seed);
  return cards.map((c) => (r() < 0.2 ? { ...c, bucket: PILES[Math.floor(r() * PILES.length)], since: c.since + Math.floor(r() * 1000) } : c));
}

/** 2 枚が (間も含めて) 重なるか。 @param {any} a @param {any} b */
const overlap = (a, b) => a.x < b.x + b.w + GAP_X && b.x < a.x + a.w + GAP_X && a.y < b.y + b.h + GAP_Y && b.y < a.y + a.h + GAP_Y;
/** @param {any[]} sheets */
function assertNoOverlap(sheets, msg = '') {
  for (let i = 0; i < sheets.length; i++) for (let j = i + 1; j < sheets.length; j++) assert.ok(!overlap(sheets[i], sheets[j]), `${msg} ${sheets[i].key} / ${sheets[j].key}`);
}

// ---------- 1. buildSheets ----------

test('buildSheets: プロジェクトごとに 1 枚 (key の順)。プロジェクトの無いカードは (other)、label は null', () => {
  const b = boardFrom([card('a', 'working', { project: proj('beta') }), card('b', 'recent'), card('c', 'unread', { project: undefined }), card('d', 'needs_you', { project: { key: 'beta', label: 'beta', extra: 2 } })]);
  const sheets = buildSheets(b);
  assert.deepEqual(sheets.map((s) => s.key), ['(other)', 'alpha', 'beta']);
  assert.equal(sheets[0].label, null);
  assert.deepEqual(sheets[0].project, { key: '(other)', label: null, extra: 0 });
  assert.deepEqual(sheets[2].live.map((c) => c.id).sort(), ['a', 'd']);
  assert.equal(sheets[2].project.extra, 2, '一覧の順で最初のカード (返事待ちの d) の project');
});

test('buildSheets: 片付けは帯へ。家族のだれかが盤面のどこかで生きている欄にいれば faded として live に入る', () => {
  const families = { p: { title: 'p', memberIds: ['p', 'kid', 'q'] }, lone: { title: 'lone', memberIds: ['lone', 'gone'] } };
  const b = boardFrom([
    card('p', 'cleanup', { family: { rootId: 'p' }, lastActivityAt: 5 }),
    card('kid', 'working', { project: proj('beta'), family: { rootId: 'p', parentId: 'p' } }),
    card('q', 'cleanup', { family: { rootId: 'p', parentId: 'p' }, lastActivityAt: 9 }),
    card('lone', 'cleanup', { family: { rootId: 'lone' }, lastActivityAt: 7 }),
    card('gone', 'cleanup', { family: { rootId: 'lone', parentId: 'lone' }, lastActivityAt: 7 }),
    card('x', 'cleanup', { lastActivityAt: 1 }),
  ], families);
  const alpha = buildSheets(b).find((s) => s.key === 'alpha');
  assert.ok(alpha);
  assert.deepEqual([...alpha.faded].sort(), ['p', 'q'], '子は別のプロジェクトにいても数える');
  assert.deepEqual(alpha.back.map((c) => c.id), ['gone', 'lone', 'x'], '新しい順、同じ時刻は ID の順');
  assert.equal(alpha.piles.get('p'), 'cleanup');
});

test('buildSheets: family.rootId が無くても board.families の根なら、memberIds で生きているメンバーを探す', () => {
  const b = boardFrom([card('r', 'cleanup'), card('k', 'recent', { project: proj('beta') })], { r: { title: 'r', memberIds: ['r', 'k'] } });
  assert.deepEqual([...(buildSheets(b).find((s) => s.key === 'alpha')?.faded ?? [])], ['r']);
});

test('buildSheets: 数はセッション数 (定期実行の行は runIds の数、faded は cleanup)、quiet と weight', () => {
  const b = boardFrom([
    card('n', 'needs_you'), card('r1', 'recent'), card('r2', 'recent'),
    card('k', 'cleanup', { routine: { runIds: ['k', 'k2', 'k3'] } }), card('c', 'cleanup'),
    card('z', 'recent', { project: proj('quiet') }), card('z2', 'cleanup', { project: proj('quiet') }),
  ]);
  const [alpha, quiet] = buildSheets(b);
  assert.deepEqual(alpha.counts, { needs_you: 1, trouble: 0, unread: 0, working: 0, recent: 2, cleanup: 4 });
  assert.equal(alpha.quiet, false);
  assert.equal(alpha.weight, 3 + 2 / 4);
  assert.equal(quiet.quiet, true, '最近と片付けだけ');
  assert.equal(quiet.weight, 1 + 1 / 4);
  const b2 = boardFrom([card('a', 'recent', { lastActivityAt: 5 }), card('b', 'cleanup', { lastActivityAt: 9 })]);
  assert.equal(buildSheets(b2)[0].lastAt, 9, '紙のカード (片付けも) の一番新しい lastActivityAt');
});

test('buildSheets: 同じ ID は最初の 1 枚だけ。空の盤面と null は紙 0 枚。盤面を書き換えない', () => {
  const b = deepFreeze(boardFrom([card('a', 'needs_you'), card('a', 'recent')]));
  const [s] = buildSheets(b);
  assert.equal(s.live.length, 1);
  assert.equal(s.piles.get('a'), 'needs_you');
  assert.deepEqual(buildSheets(null), []);
  assert.deepEqual(buildSheets(boardFrom([])), []);
});

// ---------- 2. orderSlots ----------

/** @param {any[]} cards @param {Record<string, any>} [families] */
const order = (cards, families = {}) => {
  const [s] = buildSheets(boardFrom(cards, families));
  return orderSlots(s.live, s.piles, s.faded);
};

test('orderSlots: 前 (返事待ち・止まったかも) → 中 (未読・作業中) → 最近 → faded。前の 3 欄は古い順、作業中と最近は新しい順', () => {
  const ids = order([
    card('rc-old', 'recent', { since: 1 }), card('rc-new', 'recent', { since: 9 }),
    card('wk-old', 'working', { since: 1 }), card('wk-new', 'working', { since: 9 }),
    card('un-new', 'unread', { since: 9 }), card('un-old', 'unread', { since: 1 }),
    card('tr', 'trouble', { since: 0 }), card('ny-new', 'needs_you', { since: 9 }), card('ny-old', 'needs_you', { since: 2 }),
  ]);
  assert.deepEqual(ids, ['ny-old', 'ny-new', 'tr', 'un-old', 'un-new', 'wk-new', 'wk-old', 'rc-new', 'rc-old']);
});

test('orderSlots: faded は最後、lastActivityAt の新しい順。同じ鍵は ID の順', () => {
  const fam = { a: { title: 'a', memberIds: ['a', 'x'] }, b: { title: 'b', memberIds: ['b', 'y'] } };
  const ids = order([
    card('a', 'cleanup', { family: { rootId: 'a' }, lastActivityAt: 1 }), card('b', 'cleanup', { family: { rootId: 'b' }, lastActivityAt: 5 }),
    card('x', 'recent', { project: proj('o'), family: { rootId: 'a', parentId: 'a' } }), card('y', 'recent', { project: proj('o'), family: { rootId: 'b', parentId: 'b' } }),
    card('m2', 'recent'), card('m1', 'recent'),
  ], fam);
  assert.deepEqual(ids, ['m1', 'm2', 'b', 'a']);
});

test('orderSlots: 親子でまとめない。作業中の子は、返事待ちの兄弟とほかの返事待ちの後ろ (急ぐ順だけ)。入力の順は結果を変えない', () => {
  const fam = { root: { title: 'root', memberIds: ['root', 'c1', 'c2'] } };
  const f = (/** @type {string} */ pid) => ({ family: { rootId: 'root', parentId: pid } });
  const cards = [
    card('lone', 'needs_you', { since: 1 }),
    card('root', 'recent', { since: 50, family: { rootId: 'root' } }),
    card('c1', 'working', { since: 30, ...f('root') }),
    card('c2', 'needs_you', { since: 5, ...f('root') }),
    card('other', 'needs_you', { since: 9 }),
  ];
  assert.deepEqual(order(cards, fam), ['lone', 'c2', 'other', 'c1', 'root']);
  assert.deepEqual(order([...cards].reverse(), fam), order(cards, fam));
});

// ---------- 3. place ----------

/** @param {ReturnType<typeof place>} r */
const cells = (r) => Object.fromEntries([...r.slots].map(([id, s]) => [id, `${s.col},${s.row}`]));

test('place: 読む順に左から右、上から下。rows は最後の行 + 1、空なら 0', () => {
  const r = place(['a', 'b', 'c', 'd', 'e'], 2);
  assert.deepEqual(cells(r), { a: '0,0', b: '1,0', c: '0,1', d: '1,1', e: '0,2' });
  assert.deepEqual([...r.slots.keys()], ['a', 'b', 'c', 'd', 'e'], 'slots は読む順');
  assert.equal(r.rows, 3);
  assert.equal(place(['a', 'b'], 2).rows, 1);
  assert.equal(place([], 3).rows, 0);
  assert.equal(place(['a', 'b'], 0).rows, 2, '列数が壊れていても 1 列');
});

// ---------- 4. geometry ----------

test('geometry: 幅は cols × SLIP_W、高さはマス + 帯 (最近か片付けがあれば「最近 N」「片付け N」の 1 行、何件でも同じ) + FOOT_H', () => {
  assert.deepEqual(geometry(false, 2, 3), { w: 2 * SLIP_W, h: 3 * SLIP_H + FOOT_H, liveH: 3 * SLIP_H });
  assert.deepEqual(geometry(true, 1, 1), { w: SLIP_W, h: SLIP_H + BACK_HEAD + FOOT_H, liveH: SLIP_H });
  assert.deepEqual(geometry(true, 1, 0), { w: SLIP_W, h: BACK_HEAD + FOOT_H, liveH: 0 }, '付箋の無い紙は帯だけ');
  const counts = (/** @type {number} */ recent, /** @type {number} */ cleanup) => ({ counts: { needs_you: 1, trouble: 0, unread: 0, working: 0, recent, cleanup } });
  assert.deepEqual([hasBand(counts(0, 0)), hasBand(counts(1, 0)), hasBand(counts(0, 500))], [false, true, true], '片付けの数で帯は伸びない (あるかないかだけ)');
  assert.equal(SLIP_W % SNAP, 0);
});

// ---------- 3b. colsFor ----------

test('colsFor: ceil(√付箋) で、それより多い列は作らない (空の列なし)。付箋の無い紙は 1 列。画面の上限 maxCols まで', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => colsFor(n)), [1, 1, 2, 2, 2, 3, 3]);
  assert.equal(colsFor(80), COLS_MAX);
  assert.equal(colsFor(9, 1), 1, '狭い画面は 1 列');
  assert.equal(colsFor(9, 2), 2);
  assert.equal(colsFor(9, Number.NaN), 3, '壊れた上限は COLS_MAX');
  assert.deepEqual([colsFor(Number.NaN), colsFor(-3)], [1, 1], '壊れた数は付箋 0');
});

// ---------- 5〜7. pack / pushDown / settle ----------

const items4 = [
  { key: 'big', w: 4 * SLIP_W, h: 900, weight: 20 }, { key: 'mid', w: 2 * SLIP_W, h: 500, weight: 6 },
  { key: 'small', w: 2 * SLIP_W, h: 200, weight: 1 }, { key: 'tie', w: 2 * SLIP_W, h: 200, weight: 1 },
];
/** @param {Map<string, {x: number, y: number}>} pos @param {typeof items4} items */
const placedOf = (pos, items) => items.map((it) => ({ ...it, ...pos.get(it.key) }));

test('pack: 重い順に左上から。重なりは無く、同じ入力なら同じ位置', () => {
  const pos = pack(items4, WIDE);
  assert.deepEqual(pos.get('big'), { x: 0, y: 0 });
  assert.deepEqual(pack([...items4].reverse(), WIDE), pos, '入力の順は関係ない');
  assertNoOverlap(placedOf(pos, items4));
  assert.ok(placedOf(pos, items4).every((p) => p.x >= 0 && p.y >= 0));
  assert.ok((pos.get('small')?.x ?? 0) <= (pos.get('tie')?.x ?? 0) || (pos.get('small')?.y ?? 0) < (pos.get('tie')?.y ?? 0), '同じ重さは key の順');
});

test('pack: 縦長の画面 (400px) は細く高く、横長 (1280px) は広く並べる。壊れた縦横比でも並ぶ', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, w: 2 * SLIP_W, h: 400, weight: 12 - i }));
  const extent = (/** @type {Map<string, any>} */ pos) => {
    const ps = placedOf(pos, many);
    return { w: Math.max(...ps.map((p) => p.x + p.w)), h: Math.max(...ps.map((p) => p.y + p.h)) };
  };
  const wide = extent(pack(many, WIDE));
  const narrow = extent(pack(many, NARROW));
  assert.ok(narrow.w < wide.w && narrow.h > wide.h, JSON.stringify({ wide, narrow }));
  for (const bad of [Number.NaN, 0, -1, Infinity]) assertNoOverlap(placedOf(pack(many, bad), many), String(bad));
});

test('pack: 急ぐ順 (rank) に左から右へ段に並べ、入らなければ次の段。読む順 (y, x) が急ぐ順のまま。rank が同じなら重い順', () => {
  const it = (/** @type {string} */ key, /** @type {number} */ w, /** @type {number} */ h, /** @type {number[]} */ rank, weight = 1) => ({ key, w, h, weight, rank });
  const items = [
    it('quiet-big', 3 * SLIP_W, 900, [1, 1, 1, 1, 0], 30), it('needs', SLIP_W, 300, [0, 1, 1, 1, 1]), it('stuck', 2 * SLIP_W, 500, [1, 0, 1, 1, 0]),
    it('work-a', SLIP_W, 200, [1, 1, 1, 0, 0], 2), it('work-b', SLIP_W, 200, [1, 1, 1, 0, 0], 5),
  ];
  const pos = pack(items, WIDE);
  const at = (/** @type {string} */ k) => /** @type {{x: number, y: number}} */ (pos.get(k));
  const order = [...items].sort((a, b) => at(a.key).y - at(b.key).y || at(a.key).x - at(b.key).x).map((x) => x.key);
  assert.deepEqual(order, ['needs', 'stuck', 'work-b', 'work-a', 'quiet-big'], '急ぐ順、同じ rank は重い順');
  assert.deepEqual(at('needs'), { x: 0, y: 0 });
  assert.deepEqual(at('stuck'), { x: SLIP_W + GAP_X, y: 0 }, '同じ段の右');
  for (const y of new Set(items.map((x) => at(x.key).y))) {
    const tallest = Math.max(...items.filter((x) => at(x.key).y === y).map((r) => r.h));
    for (const b of items.filter((x) => at(x.key).y > y)) assert.ok(at(b.key).y >= y + tallest + GAP_Y, '次の段は前の段の一番高い紙の下');
  }
  assertNoOverlap(placedOf(pos, /** @type {any} */ (items)));
  const ones = items.map((x) => ({ ...x, w: SLIP_W }));
  assert.ok([...pack(ones, 0.1).values()].every((p) => p.x === 0), '1 列の紙は縦 1 列 (狭い画面の縦横比)');
});

/** 並べた紙を全体で表示したときの大きさ (fit の縮尺に比例: min(縦横比 / 幅, 1 / 高さ))。 @param {Map<string, any>} pos @param {any[]} items @param {number} aspect @param {any} [foot] */
function fitScore(pos, items, aspect, foot = null) {
  const ps = items.map((it) => ({ ...it, ...pos.get(it.key) }));
  const w = Math.max(...ps.map((p) => p.x + p.w), foot?.w ?? 0);
  const h = Math.max(...ps.map((p) => p.y + p.h)) + (foot ? GAP_Y + foot.h : 0);
  return Math.min(aspect / w, 1 / h);
}

test('pack: 段の幅は、全体を表示したときに一番大きく見える幅 (1 段に並べるより、√面積の幅より大きいか同じ)。まとめの高さも数える', () => {
  const it = (/** @type {string} */ key, /** @type {number} */ w, /** @type {number} */ h, /** @type {number[]} */ rank) => ({ key, w, h, weight: 1, rank });
  // 審査の合成の盤面: 1 列の紙 3 枚と 2 列の紙 1 枚 (急ぐ順 A, B, C, D)
  const items = [it('a', SLIP_W, 228, [0]), it('b', SLIP_W, 228, [1]), it('c', 2 * SLIP_W, 184, [2]), it('d', SLIP_W, 228, [3])];
  const aspect = 1280 / 680;
  const pos = pack(items, aspect);
  assert.deepEqual(['a', 'b', 'c', 'd'].map((k) => [pos.get(k)?.x, pos.get(k)?.y]), [[0, 0], [SLIP_W + GAP_X, 0], [0, 228 + GAP_Y], [2 * SLIP_W + GAP_X, 228 + GAP_Y]]);
  const oneShelf = new Map(items.map((x, i) => [x.key, { x: items.slice(0, i).reduce((s, y) => s + y.w + GAP_X, 0), y: 0 }]));
  assert.ok(fitScore(pos, items, aspect) >= fitScore(oneShelf, items, aspect));
  // 紙の下のまとめが高いと、段を広く浅くする
  const foot = { w: SLIP_W, h: 2000 };
  const withFoot = pack(items, aspect, foot);
  assert.ok(fitScore(withFoot, items, aspect, foot) >= fitScore(pos, items, aspect, foot));
  assert.ok(Math.max(...[...withFoot.values()].map((p) => p.y)) <= Math.max(...[...pos.values()].map((p) => p.y)));
  // 乱数の紙でも、√面積 × 縦横比 の幅の段より小さくは見えない
  for (const seed of [11, 12, 13]) {
    const r = rng(seed);
    const many = Array.from({ length: 14 }, (_, i) => it(`k${i}`, SLIP_W * (1 + Math.floor(r() * 3)), 60 + Math.floor(r() * 700), [i]));
    const W = Math.max(...many.map((x) => x.w), Math.sqrt(many.reduce((s, x) => s + (x.w + GAP_X) * (x.h + GAP_Y), 0) * WIDE));
    const shelf = new Map();
    let [x, y, rowH] = [0, 0, 0];
    for (const m of many) {
      if (x > 0 && x + m.w > W) [x, y, rowH] = [0, y + rowH + GAP_Y, 0];
      shelf.set(m.key, { x, y });
      [x, rowH] = [x + m.w + GAP_X, Math.max(rowH, m.h)];
    }
    assert.ok(fitScore(pack(many, WIDE), many, WIDE) >= fitScore(shelf, many, WIDE) - 1e-12, `seed ${seed}`);
  }
});

test('urgencyRank: 返事待ち → 止まったかも → 未読 → 作業中 (最近は急がない)。同じなら「フォルダなし」が後、次に新しく動いた順、最後に大きい順', () => {
  const m = (/** @type {Record<string, number>} */ counts, /** @type {string|null} */ label = 'p', lastAt = 0, weight = 1) =>
    ({ label, counts: { needs_you: 0, trouble: 0, unread: 0, working: 0, recent: 0, cleanup: 0, ...counts }, lastAt, weight });
  const cmp = (/** @type {number[]} */ a, /** @type {number[]} */ b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const sorted = (/** @type {any[]} */ xs) => [...xs].sort((a, b) => cmp(urgencyRank(a), urgencyRank(b)));
  const needs = m({ needs_you: 1, recent: 9, cleanup: 30 });
  const stuck = m({ trouble: 2 });
  const other = m({ unread: 1, working: 1, recent: 9 }, null, 99, 30);
  const named = m({ unread: 1, working: 1 }, 'x');
  const recentNew = m({ recent: 1 }, 'y', 50);
  const recentOld = m({ recent: 5 }, 'z', 10, 9);
  assert.deepEqual(sorted([recentOld, other, recentNew, stuck, named, needs]), [needs, stuck, named, other, recentNew, recentOld]);
  assert.ok(cmp(urgencyRank(m({ needs_you: 1 })), urgencyRank(m({ trouble: 9, unread: 9, working: 9, recent: 9 }))) < 0, '返事待ち 1 件が何より先');
});

test('urgencyRank: 一番急ぐ欄が同じ紙は、その欄で一番長く待っている紙が先 (ほかの欄があるかでは比べない)。作業中は新しく始めた順 (一覧の向き)', () => {
  const b = boardFrom([
    card('a1', 'needs_you', { since: NOW - 2 * HOUR }),
    card('b1', 'needs_you', { since: NOW - 30 * HOUR, project: proj('beta') }),
    card('g1', 'needs_you', { since: NOW - HOUR, project: proj('gamma') }), card('g2', 'unread', { project: proj('gamma') }), card('g3', 'working', { project: proj('gamma') }),
    card('w1', 'working', { since: NOW - 5 * HOUR, project: proj('delta') }), card('w2', 'working', { since: NOW - HOUR, project: proj('eps') }),
  ]);
  const cmp = (/** @type {number[]} */ a, /** @type {number[]} */ c) => { for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) return a[i] - c[i]; return 0; };
  const order = buildSheets(b).sort((x, y) => cmp(urgencyRank(x), urgencyRank(y))).map((m) => m.key);
  assert.deepEqual(order, ['beta', 'alpha', 'gamma', 'eps', 'delta'], '30 時間待ち → 2 時間 → 1 時間 (未読と作業中もあるが後)、作業中は 1 時間前に始めたほうが先');
  assert.deepEqual(layoutBoard(b, null, { aspect: 0.1, now: NOW }).sheets.map((s) => s.key), order, '縦 1 列の初めの並びも同じ順');
});

test('layoutBoard: 行の高さはその行の付箋の測った高さの最大 (4 の倍数に切り上げ、SLIP_H_MIN〜SLIP_H_MAX)。測っていない付箋は SLIP_H', () => {
  const b = boardFrom([card('a', 'needs_you', { since: 1 }), card('b', 'needs_you', { since: 2 }), card('c', 'needs_you', { since: 3 }), card('d', 'working')]);
  const slipH = new Map([['a', 101], ['b', 130], ['c', 40], ['d', 9999]]);
  const s = layoutBoard(b, null, { aspect: WIDE, now: NOW, slipH }).sheets[0];
  assert.deepEqual(s.slips.map((x) => [x.id, x.row, x.y, x.h]), [['a', 0, 0, 132], ['b', 0, 0, 132], ['c', 1, 132, SLIP_H_MAX], ['d', 1, 132, SLIP_H_MAX]]);
  assert.equal(s.liveH, 132 + SLIP_H_MAX);
  assert.equal(s.h, s.liveH + FOOT_H);
  assert.equal(slipHeight(new Map([['x', 40]]), 'x'), SLIP_H_MIN);
  assert.equal(slipHeight(new Map([['x', Number.NaN]]), 'x'), SLIP_H);
  assert.equal(slipHeight(null, 'x'), SLIP_H);
  assert.deepEqual(geometry(true, 2, 2, [100, 120]), { w: 2 * SLIP_W, h: 220 + BACK_HEAD + FOOT_H, liveH: 220 });
  const plain = layoutBoard(b, null, { aspect: WIDE, now: NOW }).sheets[0];
  assert.ok(plain.slips.every((x) => x.h === SLIP_H), '高さが無ければ SLIP_H');
});

test('pack: 段の幅は maxW まで (開いたときの縮尺で表示枠に収まる幅)。一番広い紙より狭くはしない', () => {
  const items = [{ key: 'a', w: 2 * SLIP_W, h: 900, weight: 1, rank: [0] }, { key: 'b', w: 2 * SLIP_W, h: 900, weight: 1, rank: [1] }];
  const aspect = 768 / 700;
  assert.ok((pack(items, aspect).get('b')?.x ?? 0) > 0, '上限が無ければ横に並ぶほうが全体を大きく見せる');
  const capped = pack(items, aspect, null, (768 - 80) / CANVAS.Z_OPEN);
  assert.deepEqual([capped.get('b')?.x, capped.get('b')?.y], [0, 900 + GAP_Y], '768px: 2 枚目は下の段');
  const tiny = pack(items, WIDE, null, 10);
  assert.deepEqual([tiny.get('a')?.x, tiny.get('b')?.x], [0, 0], 'maxW が紙より狭くても一番広い紙の幅で並べる');
  const r = settle([...items, { key: 'c', w: 2 * SLIP_W, h: 100, weight: 1 }], arrange(items, aspect, NOW, null, 1110).seats, NOW, 1110);
  assert.equal(r.placed.find((p) => p.key === 'c')?.x, 0, '新しい紙も maxW の中 (右に置かず下へ)');
});

test('pushDown: 重なった紙は真下へ。横と上へは動かさない。fixedKey の紙は動かない。入力は書き換えない', () => {
  const placed = deepFreeze([
    { key: 'a', x: 0, y: 0, w: 528, h: 600 }, { key: 'b', x: 200, y: 300, w: 528, h: 200 }, { key: 'c', x: 900, y: 0, w: 528, h: 100 },
  ]);
  const out = pushDown(placed);
  assert.deepEqual(out.map((p) => p.key), ['a', 'b', 'c'], '入力と同じ順');
  assert.deepEqual(out[1], { key: 'b', x: 200, y: 600 + GAP_Y, w: 528, h: 200 });
  assert.deepEqual(out[2], placed[2], '重ならない紙はそのまま');
  const fixed = pushDown(placed, 'b');
  assert.deepEqual(fixed[1], placed[1]);
  assert.equal(fixed[0].y, 300 + 200 + GAP_Y, 'b が動かないので a が下へ');
  assertNoOverlap(fixed);
});

test('settle: 席のある紙は x・y を保ち、新しい紙だけ skyline で空いた所へ。seen は now', () => {
  const midX = 4 * SLIP_W + GAP_X;
  const seats = { v: 3, aspect: WIDE, seats: { big: { x: 0, y: 0, cols: 4, seen: NOW - DAY }, mid: { x: midX, y: 0, cols: 2, seen: NOW - DAY } } };
  const items = items4.map((it) => ({ ...it, cols: it.w / SLIP_W }));
  const r = settle(items, deepFreeze(seats), NOW);
  const at = Object.fromEntries(r.placed.map((p) => [p.key, p]));
  assert.deepEqual([at.big.x, at.big.y, at.mid.x, at.mid.y], [0, 0, midX, 0]);
  assertNoOverlap(r.placed);
  assert.deepEqual(Object.keys(r.seats.seats), ['big', 'mid', 'small', 'tie']);
  assert.ok(Object.values(r.seats.seats).every((s) => s.seen === NOW));
  assert.equal(r.seats.aspect, WIDE);
});

test('settle: 伸びた紙は下の紙を押し下げ、縮んでも上へは詰めない。伸びた高さは席の h に取っておく (同じ伸び縮みでは 2 度目から動かない)', () => {
  const seats = { v: 3, aspect: WIDE, seats: { a: { x: 0, y: 0, cols: 2, seen: NOW }, b: { x: 0, y: 500, cols: 2, seen: NOW } } };
  const grown = settle([{ key: 'a', w: 528, h: 800, weight: 1 }, { key: 'b', w: 528, h: 100, weight: 1 }], seats, NOW);
  assert.deepEqual(grown.placed.map((p) => [p.key, p.x, p.y]), [['a', 0, 0], ['b', 0, 800 + GAP_Y]]);
  assert.equal(grown.seats.seats.a.h, 800);
  const shrunk = settle([{ key: 'a', w: 528, h: 100, weight: 1 }, { key: 'b', w: 528, h: 100, weight: 1 }], grown.seats, NOW);
  assert.equal(shrunk.placed[1].y, 800 + GAP_Y, '穴は並べ直すまで残る');
  assert.equal(shrunk.seats.seats.a.h, 800, '縮んでも取っておく高さはそのまま');
  const again = settle([{ key: 'a', w: 528, h: 700, weight: 1 }, { key: 'b', w: 528, h: 100, weight: 1 }], shrunk.seats, NOW);
  assert.equal(again.placed[1].y, 800 + GAP_Y, '取っておいた高さの中で伸びても、下の紙は動かない');
});

test('layoutBoard: 最近 ⇄ 作業中の行き来で、最初に伸びたとき以外は紙もまとめも動かない (席の h)。並べ直すと h は今の高さに戻る', () => {
  const cards = [
    card('a1', 'needs_you', { project: proj('A') }), card('a2', 'recent', { project: proj('A') }), card('b1', 'trouble', { project: proj('B') }), card('b2', 'recent', { project: proj('B') }),
    card('c1', 'unread', { project: proj('C') }), card('c2', 'working', { project: proj('C') }), card('d1', 'working', { project: proj('D') }), card('d2', 'recent', { project: proj('D') }),
    card('x', 'cleanup', { project: proj('X') }),
  ];
  const turn = (/** @type {string} */ id, /** @type {string} */ pile) => cards.map((c) => (c.id === id ? { ...c, bucket: pile } : c));
  const where = (/** @type {any} */ L) => JSON.stringify([L.sheets.map((s) => [s.key, s.x, s.y]).sort(), [L.fold?.x, L.fold?.y]]);
  const L0 = layoutBoard(boardFrom(cards), null, { aspect: 1280 / 680, now: NOW, maxCols: 4 });
  const L1 = layoutBoard(boardFrom(turn('a2', 'working')), L0.seats, { now: NOW + 5000 });
  const L2 = layoutBoard(boardFrom(cards), L1.seats, { now: NOW + 10000 });
  assert.equal(where(L2), where(L1), 'もとに戻っても、ほかの紙とまとめは上へ動かない (穴は増えない)');
  const L3 = layoutBoard(boardFrom(turn('a2', 'working')), L2.seats, { now: NOW + 15000 });
  assert.equal(where(L3), where(L1), '2 度目の行き来では何も動かない');
  for (const L of [L0, L1, L2, L3]) assertNoOverlap(L.sheets);
  const fresh = layoutBoard(boardFrom(cards), null, { aspect: 1280 / 680, now: NOW });
  assert.ok(Object.entries(fresh.seats.seats).every(([k, seat]) => seat.h === fresh.sheets.find((s) => s.key === k)?.h), '並べ直すと取っておく高さは今の高さ');
});

test('settle: 盤面から消えたプロジェクトの席は 7 日残り、その場所は新しい紙に取られない。7 日を過ぎたら消える', () => {
  const seats = { v: 3, aspect: WIDE, seats: { gone: { x: 0, y: 0, cols: 2, seen: NOW - SEAT_KEEP_MS + 1 }, old: { x: 3000, y: 0, cols: 2, seen: NOW - SEAT_KEEP_MS } } };
  const r = settle([{ key: 'new', w: 528, h: 200, weight: 1 }], seats, NOW);
  assert.deepEqual(Object.keys(r.seats.seats), ['gone', 'new']);
  assert.deepEqual(r.seats.seats.gone, seats.seats.gone, '残した席は書き換えない');
  assert.ok(!overlap(r.placed[0], { x: 0, y: 0, w: 2 * SLIP_W, h: SLIP_H + FOOT_H }), '戻ってくる場所を避ける');
});

test('arrange: 席を捨てて pack し、全部の席を now で作る (取っておく高さ h は今の高さ)', () => {
  const r = arrange(items4.map((it) => ({ ...it, cols: it.w / SLIP_W })), WIDE, NOW);
  assert.deepEqual(r.placed.map((p) => p.key), items4.map((it) => it.key));
  assert.deepEqual(r.seats.seats.big, { x: 0, y: 0, cols: 4, seen: NOW, h: 900 });
  assert.equal(arrange([], NARROW, NOW).seats.aspect, NARROW);
});

// ---------- 10. layoutBoard ----------

/** 3 プロジェクトの小さな盤面 (家族と faded と帯の溢れを含む)。 */
function sample() {
  const fam = { root: { title: 'root', memberIds: ['root', 'kid', 'kid2'] } };
  // root は片付け (faded) なので付箋にならない。kid と kid2 は親子だが、紙の中は急ぐ順で、親子でまとめない
  const backs = Array.from({ length: 10 }, (_, i) => card(`old${i}`, 'cleanup', { lastActivityAt: i }));
  return boardFrom([
    card('root', 'cleanup', { family: { rootId: 'root' }, lastActivityAt: 50 }),
    card('kid', 'needs_you', { since: 3, family: { rootId: 'root', parentId: 'root' } }),
    card('kid2', 'working', { since: 8, family: { rootId: 'root', parentId: 'root' } }),
    card('u', 'unread', { since: 1 }), card('w', 'working', { since: 2 }),
    card('b1', 'trouble', { project: proj('beta') }), card('b2', 'recent', { project: proj('beta') }),
    card('o1', 'recent', { project: proj('(other)') }),
    ...backs,
  ], fam);
}

test('layoutBoard: 紙は読む順 (y, x, key)、slip と帯の座標は紙の左上から、bounds は全部を覆う', () => {
  const L = layoutBoard(deepFreeze(sample()), null, { aspect: WIDE, now: NOW });
  const alpha = L.sheets.find((s) => s.key === 'alpha');
  assert.ok(alpha);
  assert.equal(alpha.cols, 2, 'ceil(√4) = 2 (付箋は kid・kid2・u・w。faded の root は付箋にしない)');
  assert.deepEqual(alpha.slips.map((s) => [s.id, s.pile, s.col, s.row, s.x, s.y, s.h]), [
    ['kid', 'needs_you', 0, 0, 0, 0, SLIP_H], ['u', 'unread', 1, 0, SLIP_W, 0, SLIP_H],
    ['kid2', 'working', 0, 1, 0, SLIP_H, SLIP_H], ['w', 'working', 1, 1, SLIP_W, SLIP_H, SLIP_H],
  ]);
  assert.equal(alpha.rows, 2);
  assert.equal(alpha.liveH, 2 * SLIP_H);
  assert.deepEqual(alpha.back, { total: 11, recent: 0, y: 2 * SLIP_H }, '帯の片付け: 10 件と faded の root');
  assert.equal(alpha.counts.cleanup, 11);
  assert.equal(alpha.h, 2 * SLIP_H + BACK_HEAD + FOOT_H, '片付け 11 件でも帯は 1 行');
  const beta = L.sheets.find((s) => s.key === 'beta');
  assert.deepEqual(beta?.slips.map((s) => [s.id, s.y]), [['b1', 0]], '最近の b2 は付箋にしない');
  assert.deepEqual(beta?.back, { total: 0, recent: 1, y: SLIP_H });
  assert.equal(beta?.cols, 1, '付箋 1 枚の紙は 1 列 (空の列を作らない)');
  const other = L.sheets.find((s) => s.key === '(other)');
  assert.deepEqual([other?.slips.length, other?.rows, other?.liveH, other?.h, other?.cols], [0, 0, 0, BACK_HEAD + FOOT_H, 1], '最近だけの紙: 見出しと帯だけ');
  assert.deepEqual(L.sheets.map((s) => s.key), ['alpha', 'beta', '(other)'], '急ぐ順: 返事待ち → 止まったかも → 最近だけのフォルダなし');
  assert.equal(L.fold, null, '片付けだけのプロジェクトは無い');
  assert.deepEqual(L.sheets.map((s) => s.key), [...L.sheets].sort((a, b) => a.y - b.y || a.x - b.x || (a.key < b.key ? -1 : 1)).map((s) => s.key));
  for (const s of L.sheets) {
    assert.ok(L.bounds.x <= s.x && L.bounds.y <= s.y && s.x + s.w <= L.bounds.x + L.bounds.w && s.y + s.h <= L.bounds.y + L.bounds.h);
  }
  assertNoOverlap(L.sheets);
});

test('layoutBoard: 同じ入力なら同じ出力。席は JSON を通しても同じ。盤面の順を入れ替えても同じ', () => {
  const a = layoutBoard(sample(), null, { aspect: WIDE, now: NOW });
  assert.deepEqual(layoutBoard(sample(), null, { aspect: WIDE, now: NOW }), a);
  const b1 = layoutBoard(sample(), a.seats, { now: NOW });
  const b2 = layoutBoard(sample(), JSON.stringify(a.seats), { now: NOW });
  assert.deepEqual(b1, b2);
  assert.deepEqual(b1.sheets, a.sheets, '席どおり');
  const shuffled = boardFrom([...Object.values(sample().buckets).flat(), ...sample().recentGroups.flatMap((g) => g.items), ...sample().cleanupGroups[0].items].reverse(), sample().families);
  assert.deepEqual(layoutBoard(shuffled, null, { aspect: WIDE, now: NOW }), a);
});

test('layoutBoard: 席が無いか壊れていれば並べ直す。並べ直すと消えたプロジェクトの席も捨てる', () => {
  const fresh = layoutBoard(sample(), null, { aspect: WIDE, now: NOW });
  assert.deepEqual(layoutBoard(sample(), '{broken', { aspect: WIDE, now: NOW }), fresh);
  const withGhost = { ...fresh.seats, seats: { ...fresh.seats.seats, gone: { x: 9000, y: 0, cols: 2, seen: NOW } } };
  assert.ok('gone' in layoutBoard(sample(), withGhost, { now: NOW }).seats.seats, '普段は残す');
  assert.ok(!('gone' in layoutBoard(sample(), null, { aspect: WIDE, now: NOW }).seats.seats), '並べ直すと捨てる');
});

test('layoutBoard: 列数は席で決まり、増えても幅は変わらず行が増える (並べ直すまで)。maxCols は席を作るときだけ', () => {
  const small = boardFrom([card('a', 'working'), card('b', 'working')]);
  const L1 = layoutBoard(small, null, { aspect: WIDE, now: NOW });
  assert.equal(L1.sheets[0].cols, 2);
  const big = boardFrom(Array.from({ length: 20 }, (_, i) => card(`c${i}`, 'working', { since: i })));
  const L2 = layoutBoard(big, L1.seats, { now: NOW });
  assert.equal(L2.sheets[0].cols, 2);
  assert.equal(L2.sheets[0].w, L1.sheets[0].w);
  assert.equal(L2.sheets[0].rows, 10);
  assert.equal(layoutBoard(big, null, { aspect: WIDE, now: NOW }).sheets[0].cols, 5, '並べ直すと ceil(√20)');
  assert.equal(layoutBoard(big, null, { aspect: WIDE, now: NOW, maxCols: 1 }).sheets[0].cols, 1, '狭い画面は 1 列');
  assert.equal(layoutBoard(big, L1.seats, { now: NOW, maxCols: 1 }).sheets[0].cols, 2, '席のある紙は席の列数');
  assert.equal(layoutBoard(boardFrom(Array.from({ length: 80 }, (_, i) => card(`d${i}`, 'working'))), null, { now: NOW }).sheets[0].cols, COLS_MAX);
  const recent = layoutBoard(boardFrom(Array.from({ length: 9 }, (_, i) => card(`r${i}`, 'recent', { since: i }))), null, { aspect: WIDE, now: NOW }).sheets[0];
  assert.deepEqual([recent.cols, recent.slips.length, recent.back.recent, recent.h], [1, 0, 9, BACK_HEAD + FOOT_H], '最近だけの紙: 付箋は無く、帯の「最近 9」');
});

test('layoutBoard: 付箋は返事待ち・止まったかも・未読・作業中だけ。急ぐ順に並び、親子でまとめない (親は付箋の言葉で言う)', () => {
  const fam = { p: { title: 'p', memberIds: ['p', 'w1', 'w2', 'g'] } };
  const b = boardFrom([
    card('p', 'recent', { since: 1, family: { rootId: 'p' } }),
    card('w1', 'working', { since: 9, family: { rootId: 'p', parentId: 'p' } }),
    card('w2', 'needs_you', { since: 5, family: { rootId: 'p', parentId: 'p' } }),
    card('g', 'unread', { since: 3, family: { rootId: 'p', parentId: 'w1' } }),
    card('solo', 'needs_you', { since: 1 }), card('r', 'recent'), card('old', 'cleanup'),
  ], fam);
  const s = layoutBoard(b, null, { aspect: WIDE, now: NOW }).sheets[0];
  assert.deepEqual(s.slips.map((x) => x.id), ['solo', 'w2', 'g', 'w1'], '返事待ち (古い順) → 未読 → 作業中。最近の親 p は付箋でない');
  assert.ok(s.slips.every((x) => !('up' in x)) && !('links' in s), '線の情報は配置に無い');
  assert.deepEqual(s.back, { total: 1, recent: 2, y: s.liveH });
  assert.deepEqual(s.counts, { needs_you: 2, trouble: 0, unread: 1, working: 1, recent: 2, cleanup: 1 }, '帯の数は紙の全部の数 (柱と同じ)');
});

// ---------- 10b. 片付けだけのプロジェクト (fold) ----------

test('layoutBoard: 生きている付箋の無いプロジェクトは紙にせず fold にまとめる。片付けの多い順、いちばん下の紙の下、bounds に入る', () => {
  const b = boardFrom([
    card('n', 'needs_you'),
    ...['a1', 'a2'].map((id) => card(id, 'cleanup', { project: proj('arch-a') })),
    card('b1', 'cleanup', { project: proj('arch-b'), routine: { runIds: ['b1', 'b1-r1', 'b1-r2'] } }),
    card('c1', 'cleanup', { project: proj('arch-c') }),
    card('o1', 'cleanup', { project: proj('(other)') }),
  ]);
  const L = layoutBoard(b, null, { aspect: WIDE, now: NOW });
  assert.deepEqual(L.sheets.map((s) => s.key), ['alpha']);
  assert.ok(L.fold);
  assert.equal(L.fold.key, FOLD_KEY);
  assert.deepEqual(L.fold.items.map((it) => [it.key, it.n]), [['arch-b', 3], ['arch-a', 2], ['(other)', 1], ['arch-c', 1]], 'セッション数 (定期実行の回も) の多い順、同じなら key');
  assert.deepEqual(L.fold.items[2].project, { key: '(other)', label: null, extra: 0 }, 'projectLabel にそのまま渡せる');
  const alpha = L.sheets[0];
  assert.deepEqual([L.fold.x, L.fold.y, L.fold.w, L.fold.h], [alpha.x, alpha.y + alpha.h + GAP_Y, SLIP_W, 4 * FOLD_ROW + FOOT_H]);
  assert.deepEqual(L.bounds, { x: 0, y: 0, w: Math.max(alpha.w, SLIP_W), h: L.fold.y + L.fold.h });
  assert.ok(!('arch-a' in L.seats.seats), 'まとめたプロジェクトは席を持たない');
  assert.ok(!readingOrder(L).some((id) => id.startsWith('a') || id.startsWith('b') || id === 'c1'));
  // 家族のだれかが別の紙で生きていても (faded)、片付けだけのプロジェクトはまとめへ (faded は付箋にしない)
  const fam = { r: { title: 'r', memberIds: ['r', 'k'] } };
  const L2 = layoutBoard(boardFrom([card('r', 'cleanup', { project: proj('arch-a'), family: { rootId: 'r' } }), card('k', 'working', { family: { rootId: 'r', parentId: 'r' } })], fam), null, { aspect: WIDE, now: NOW });
  assert.deepEqual(L2.sheets.map((s) => s.key), ['alpha']);
  assert.deepEqual(L2.fold?.items.map((it) => [it.key, it.n]), [['arch-a', 1]]);
  // 全部が片付けだけなら紙は 0 枚、まとめは原点
  const L3 = layoutBoard(boardFrom([card('x', 'cleanup')]), null, { aspect: WIDE, now: NOW });
  assert.deepEqual([L3.sheets.length, L3.fold?.x, L3.fold?.y], [0, 0, 0]);
  assert.deepEqual(foldBlock([], []), null);
});

test('layoutBoard: 空の盤面と null は紙 0 枚、bounds は 0', () => {
  for (const b of [null, undefined, boardFrom([])]) {
    const L = layoutBoard(b, null, { aspect: WIDE, now: NOW });
    assert.deepEqual(L.sheets, []);
    assert.deepEqual(L.bounds, { x: 0, y: 0, w: 0, h: 0 });
    assert.deepEqual(L.seats, { v: 3, aspect: WIDE, seats: {} });
    assert.equal(L.fold, null);
  }
});

// ---------- 8. dropSheet ----------

test('dropSheet: SNAP に揃えて 0 以上。落とした紙は動かず、覆われた紙が真下へずれる', () => {
  const L = layoutBoard(sample(), null, { aspect: WIDE, now: NOW });
  const [first, second] = L.sheets;
  const seats = dropSheet(L.seats, L, second.key, first.x + 3, first.y - 13, NOW + 1);
  assert.deepEqual([seats.seats[second.key].x, seats.seats[second.key].y], [first.x, 0], '3 → 0、-13 → 0 (0 以上)');
  const next = layoutBoard(sample(), seats, { now: NOW + 2 });
  const at = Object.fromEntries(next.sheets.map((s) => [s.key, s]));
  assert.deepEqual([at[second.key].x, at[second.key].y], [first.x, 0]);
  assert.equal(at[first.key].x, first.x, '横へは動かない');
  assert.ok(at[first.key].y >= at[second.key].y + at[second.key].h + GAP_Y);
  assertNoOverlap(next.sheets);
  const snapped = dropSheet(null, L, first.key, 101, 205, NOW);
  assert.deepEqual([snapped.seats[first.key].x % SNAP, snapped.seats[first.key].y % SNAP], [0, 0]);
  assert.deepEqual([snapped.seats[first.key].x, snapped.seats[first.key].y], [104, 208]);
});

test('dropSheet: 落とした紙の取っておく高さは今の高さに戻る (ほかの紙は取っておく高さのまま)', () => {
  const L = layoutBoard(sample(), null, { aspect: WIDE, now: NOW });
  const [first, second] = L.sheets;
  const tall = { ...L.seats, seats: Object.fromEntries(Object.entries(L.seats.seats).map(([k, s]) => [k, { ...s, h: s.h + 1000 }])) };
  const doc = dropSheet(tall, L, second.key, second.x, second.y + 4000, NOW);
  assert.equal(doc.seats[second.key].h, second.h);
  assert.equal(doc.seats[first.key].h, first.h + 1000);
});

test('dropSheet: Shift + 矢印は NUDGE ずつ。知らない key と壊れた座標は今の席のまま', () => {
  const L = layoutBoard(sample(), null, { aspect: WIDE, now: NOW });
  const s = L.sheets[L.sheets.length - 1];
  const moved = dropSheet(L.seats, L, s.key, s.x + NUDGE, s.y, NOW);
  assert.equal(moved.seats[s.key].x, s.x + NUDGE);
  assert.deepEqual(dropSheet(L.seats, L, 'nope', 0, 0, NOW), L.seats);
  const same = dropSheet(L.seats, L, s.key, Number.NaN, Number.NaN, NOW);
  assert.deepEqual([same.seats[s.key].x, same.seats[s.key].y], [s.x, s.y]);
  assert.deepEqual(parseSeats(JSON.stringify(moved)), moved, '保存できる形');
});

// ---------- 11. readingOrder / neighbour ----------

test('readingOrder: 紙ごと、紙の中はマスの順。最近と片付け (faded も) は入らない', () => {
  const L = layoutBoard(sample(), null, { aspect: WIDE, now: NOW });
  const ids = readingOrder(L);
  assert.deepEqual(ids, L.sheets.flatMap((s) => s.slips.map((x) => x.id)));
  assert.deepEqual(ids, ['kid', 'u', 'kid2', 'w', 'b1']);
  assert.ok(!ids.some((id) => id.startsWith('old') || id === 'root' || id === 'b2' || id === 'o1'));
  assert.deepEqual(readingOrder(/** @type {any} */ (null)), []);
});

test('neighbour: 紙の中は向きの距離、次に横の距離で一番近い slip。無ければその向きの一番近い紙へ。無ければ null', () => {
  const b = boardFrom([
    ...['a', 'b', 'c', 'd', 'e'].map((id, i) => card(id, 'working', { since: 10 - i })),
    card('r1', 'working', { project: proj('zeta'), since: 9 }), card('r2', 'working', { project: proj('zeta'), since: 8 }),
  ]);
  const seats = { v: 3, aspect: WIDE, seats: { alpha: { x: 0, y: 0, cols: 3, seen: NOW }, zeta: { x: 3 * SLIP_W + GAP_X, y: 0, cols: 2, seen: NOW } } };
  const L = layoutBoard(b, seats, { now: NOW });
  // alpha: a b c / d e     zeta (右): r1 r2
  assert.equal(neighbour(L, 'a', 'right'), 'b');
  assert.equal(neighbour(L, 'a', 'down'), 'd');
  assert.equal(neighbour(L, 'e', 'up'), 'b');
  assert.equal(neighbour(L, 'e', 'right'), 'c', '同じ行に無ければ右上の近いもの');
  assert.equal(neighbour(L, 'c', 'right'), 'r1', '紙の外へ');
  assert.equal(neighbour(L, 'r1', 'left'), 'c');
  assert.equal(neighbour(L, 'a', 'left'), null);
  assert.equal(neighbour(L, 'a', 'up'), null);
  assert.equal(neighbour(L, 'a', 'right', (id) => id !== 'b'), 'e', '絞り込みに合わない slip は飛ばす (向きの距離が先: e は 1 列先、c は 2 列先)');
  assert.equal(neighbour(L, 'a', 'right', (id) => id !== 'b' && id !== 'e'), 'c');
  assert.equal(neighbour(L, 'c', 'right', (id) => !id.startsWith('r')), null, '合う slip の無い紙へは行かない');
  assert.equal(neighbour(L, 'nope', 'right'), null);
  assert.equal(neighbour(L, 'a', /** @type {any} */ ('sideways')), null);
  assert.equal(findSlip(L, 'r2')?.sheet.key, 'zeta');
  // 最近は付箋でない: 下には何も無い。付箋の無い紙 (最近だけ) へは矢印で行かない
  const b2 = boardFrom([card('w1', 'working', { since: 5 }), card('w2', 'working', { since: 4 }), card('q1', 'recent', { since: 9 }), card('q2', 'recent', { project: proj('quiet') })]);
  const L2 = layoutBoard(b2, null, { aspect: WIDE, now: NOW });
  assert.deepEqual(L2.sheets.find((s) => s.key === 'alpha')?.slips.map((x) => [x.id, x.col, x.row]), [['w1', 0, 0], ['w2', 1, 0]]);
  assert.equal(neighbour(L2, 'w1', 'down'), null);
  for (const dir of /** @type {const} */ (['left', 'right', 'up', 'down'])) assert.ok(neighbour(L2, 'w2', dir) !== 'q2', dir);
  assert.deepEqual(readingOrder(L2), ['w1', 'w2']);
});

// ---------- 12. parseSeats ----------

test('parseSeats: 正しい記録 (オブジェクトでも JSON でも) は key の順に整えて返す。取っておく高さ h は無くてもよい', () => {
  const doc = { v: 3, aspect: 1.5, seats: { b: { x: 8, y: 16, cols: 1, seen: NOW, h: 228 }, a: { x: 0, y: 0, cols: 6, seen: 0, extra: 1 } } };
  const want = { v: 3, aspect: 1.5, seats: { a: { x: 0, y: 0, cols: 6, seen: 0 }, b: { x: 8, y: 16, cols: 1, seen: NOW, h: 228 } } };
  assert.deepEqual(parseSeats(doc), want);
  assert.deepEqual(parseSeats(JSON.stringify(doc)), want);
  assert.deepEqual(parseSeats({ v: 3, aspect: 1, seats: {} }), { v: 3, aspect: 1, seats: {} });
});

test('parseSeats: 形が 1 か所でも違えば null', () => {
  const ok = { x: 0, y: 0, cols: 2, seen: 0 };
  const bad = [
    null, undefined, '', '{', '[]', 7, [], {}, { v: 2, aspect: 1, seats: {} }, { v: 3, aspect: 0, seats: {} }, { v: 3, aspect: Number.NaN, seats: {} },
    { v: 3, aspect: 100, seats: {} }, { v: 3, aspect: '1', seats: {} }, { v: 3, aspect: 1, seats: [] }, { v: 3, aspect: 1 },
    ...[{ x: -1 }, { x: Number.NaN }, { y: '0' }, { cols: COLS_MIN - 1 }, { cols: COLS_MAX + 1 }, { cols: 2.5 }, { seen: undefined }, { x: 1e12 }, { h: -1 }, { h: '9' }, { h: Number.NaN }, { h: null }]
      .map((o) => ({ v: 3, aspect: 1, seats: { a: ok, b: { ...ok, ...o } } })),
    { v: 3, aspect: 1, seats: { a: null } }, { v: 3, aspect: 1, seats: { a: [0, 0, 2, 0] } },
    // v 1 (紙が小さく、重い順に詰めていた頃) の記録は捨てて並べ直す
    { v: 1, aspect: 1, seats: { a: ok } },
  ];
  for (const b of bad) assert.equal(parseSeats(b), null, JSON.stringify(b));
});

test('parseSeats と layoutBoard: "__proto__" という key でも記録とオブジェクトが壊れない', () => {
  const doc = parseSeats('{"v":3,"aspect":1,"seats":{"__proto__":{"x":0,"y":0,"cols":2,"seen":0}}}');
  assert.ok(doc && Object.prototype.hasOwnProperty.call(doc.seats, '__proto__'));
  assert.equal(Object.getPrototypeOf(doc.seats), Object.prototype);
  const L = layoutBoard(boardFrom([card('a', 'recent', { project: proj('__proto__') })]), null, { aspect: WIDE, now: NOW });
  assert.deepEqual(L.sheets.map((s) => s.key), ['__proto__']);
  assert.ok(Object.prototype.hasOwnProperty.call(L.seats.seats, '__proto__'));
  assert.equal(/** @type {any} */ ({}).x, undefined, 'Object.prototype を汚さない');
  assert.equal(layoutBoard(boardFrom([card('b', 'recent', { project: proj('toString') })]), { v: 3, aspect: 1, seats: {} }, { now: NOW }).sheets[0].x, 0);
});

// ---------- 性質 (乱数の盤面、種は固定) ----------

/** 配置の不変条件。 @param {ReturnType<typeof layoutBoard>} L @param {ReturnType<typeof randomCards>} src @param {string} msg */
function assertInvariants(L, src, msg) {
  assertNoOverlap(L.sheets, msg);
  const board = boardFrom(src.cards, src.families);
  const front = new Set(['needs_you', 'trouble', 'unread', 'working']);
  const slipped = new Set(src.cards.filter((c) => front.has(c.bucket)).map((c) => c.id));
  const ids = readingOrder(L);
  assert.equal(new Set(ids).size, ids.length, `${msg}: slip は 1 回ずつ`);
  assert.deepEqual([...ids].sort(), [...slipped].sort(), `${msg}: 付箋は返事待ち・止まったかも・未読・作業中だけ、全部`);
  const banded = L.sheets.reduce((n, s) => n + s.back.total + s.back.recent, 0);
  const folded = new Set((L.fold?.items ?? []).map((it) => it.key));
  const inFold = src.cards.filter((c) => folded.has(c.project.key));
  assert.ok(inFold.every((c) => c.bucket === 'cleanup'), `${msg}: まとめたプロジェクトには片付けしか無い`);
  assert.equal(ids.length + banded + inFold.length, src.cards.length, `${msg}: 全カードが slip か帯の数か、片付けだけのまとめ`);
  assert.ok(L.sheets.every((s) => !folded.has(s.key) && s.counts.needs_you + s.counts.trouble + s.counts.unread + s.counts.working + s.counts.recent > 0), `${msg}: 紙には片付けでないカードがある`);
  for (const s of L.sheets) {
    assert.ok(s.x >= 0 && s.y >= 0 && s.cols >= COLS_MIN && s.cols <= COLS_MAX, msg);
    const cellsTaken = new Set(s.slips.map((x) => `${x.col},${x.row}`));
    assert.equal(cellsTaken.size, s.slips.length, `${msg}: マスが重ならない`);
    assert.ok(s.slips.every((x) => x.col < s.cols && x.row < s.rows), msg);
    assert.ok(s.slips.every((x) => front.has(x.pile) && x.h === SLIP_H && x.y + x.h <= s.liveH), msg);
    assert.equal(s.liveH, s.rows * SLIP_H, msg);
    assert.equal(s.back.y, s.liveH, msg);
    assert.equal(s.h, s.liveH + (s.counts.recent + s.counts.cleanup > 0 ? BACK_HEAD : 0) + FOOT_H, msg);
  }
  // 紙の中は急ぐ順 (鍵の小さい順) に、読む順で並ぶ
  const pileOf = new Map(src.cards.map((c) => [c.id, c.bucket]));
  const rank = { needs_you: 0, trouble: 0, unread: 1, working: 1 };
  for (const s of L.sheets) {
    const bands = s.slips.map((x) => rank[/** @type {keyof typeof rank} */ (pileOf.get(x.id))]);
    assert.deepEqual(bands, [...bands].sort((p, q) => p - q), `${msg}: 前 (返事待ち・止まったかも) が後 (未読・作業中) より先`);
  }
  assert.deepEqual(layoutBoard(board, L.seats, { now: NOW }).sheets, L.sheets, `${msg}: 同じ席なら同じ配置`);
}

test('性質: 1〜300 セッション × 1〜40 プロジェクト。重ならず、全カードが 1 回ずつ、紙の中は急ぐ順、同じ入力は同じ配置', () => {
  const sizes = [[1, 1], [2, 1], [5, 2], [12, 3], [30, 1], [40, 40], [60, 8], [120, 12], [200, 25], [300, 40], [300, 3], [300, 1], [150, 2]];
  for (const [i, [n, p]] of sizes.entries()) {
    for (const aspect of [WIDE, NARROW]) {
      const src = randomCards(1000 + i, n, p);
      const L = layoutBoard(boardFrom(src.cards, src.families), null, { aspect, now: NOW });
      assertInvariants(L, src, `n=${n} p=${p} aspect=${aspect.toFixed(2)}`);
    }
  }
});

test('性質: 200 回の欄の入れ替えでも、紙は横へ動かず幅も変わらず、重ならない (同じ席でも、毎回の席を引き継いでも)', () => {
  const src = randomCards(77, 160, 14);
  const first = layoutBoard(boardFrom(src.cards, src.families), null, { aspect: WIDE, now: NOW });
  const x0 = new Map(first.sheets.map((s) => [s.key, [s.x, s.w]]));
  let chained = first.seats;
  let cards = src.cards;
  for (let k = 0; k < 200; k++) {
    cards = flip(cards, 5000 + k);
    const board = boardFrom(cards, src.families);
    for (const seats of [first.seats, chained]) {
      const L = layoutBoard(board, seats, { now: NOW + k * 5000 });
      assertNoOverlap(L.sheets, `flip ${k}`);
      for (const s of L.sheets) assert.deepEqual([s.x, s.w], x0.get(s.key), `flip ${k}: ${s.key} が横へ動いた`);
      if (seats !== chained) continue;
      for (const s of L.sheets) assert.ok(s.y >= chained.seats[s.key].y, `flip ${k}: ${s.key} が上へ動いた`);
      chained = L.seats;
    }
  }
});

test('性質: 紙を 60 回ランダムに落としても、ほかの紙は横へも上へも動かず、落とした紙より上の紙は動かず、重ならない。空いた所ならそこに残る', () => {
  const src = randomCards(91, 120, 10);
  const board = boardFrom(src.cards, src.families);
  const r = rng(7);
  let L = layoutBoard(board, null, { aspect: WIDE, now: NOW });
  let exact = 0;
  for (let k = 0; k < 60; k++) {
    const s = L.sheets[Math.floor(r() * L.sheets.length)];
    const x = Math.floor(r() * 4000) - 200;
    const y = Math.floor(r() * 4000) - 200;
    const want = { key: s.key, x: Math.max(0, Math.round(x / SNAP) * SNAP), y: Math.max(0, Math.round(y / SNAP) * SNAP), w: s.w, h: s.h };
    const free = L.sheets.every((o) => o.key === s.key || !overlap(want, o));
    const before = new Map(L.sheets.map((o) => [o.key, o]));
    L = layoutBoard(board, dropSheet(L.seats, L, s.key, x, y, NOW), { now: NOW });
    const at = /** @type {any} */ (L.sheets.find((o) => o.key === s.key));
    if (free) {
      exact++;
      assert.deepEqual([at.x, at.y], [want.x, want.y], `drop ${k}: 空いた所ならそこ`);
    }
    for (const o of L.sheets) {
      if (o.key === s.key) continue;
      const b = /** @type {any} */ (before.get(o.key));
      assert.equal(o.x, b.x, `drop ${k}: ${o.key} が横へ動いた`);
      assert.ok(o.y >= b.y, `drop ${k}: ${o.key} が上へ動いた`);
      if (b.y < at.y) assert.equal(o.y, b.y, `drop ${k}: 落とした紙より上の ${o.key} が動いた`);
    }
    assertNoOverlap(L.sheets, `drop ${k}`);
  }
  assert.ok(exact > 0, '空いた所への落とし方も試している');
});

test('dropSheet: 隣の余白に入っただけなら、落とした紙が余白の外で止まる (隣を飛ばさない)。上から覆えば隣が下へずれる', () => {
  const W = 528;
  const H = 544;
  /** @param {Array<{key: string, x: number, y: number}>} at */
  const desk = (at) => {
    const sheets = at.map((p) => ({ ...p, w: W, h: H, cols: 2 }));
    return { sheets, seats: { v: /** @type {1} */ (1), aspect: WIDE, seats: Object.fromEntries(sheets.map((p) => [p.key, { x: p.x, y: p.y, cols: 2, seen: NOW }])) } };
  };
  const pos = (/** @type {any} */ doc, /** @type {string} */ key) => [doc.seats[key].x, doc.seats[key].y];
  // 縦: A のすぐ下 (GAP_Y ちょうど) の B を少し上へ
  const col = desk([{ key: 'a', x: 0, y: 0 }, { key: 'b', x: 0, y: H + GAP_Y }]);
  for (const y of [H + GAP_Y - SNAP, H + GAP_Y - NUDGE, H + 16]) {
    const doc = dropSheet(col.seats, col, 'b', 0, y, NOW);
    assert.deepEqual(pos(doc, 'a'), [0, 0], `y=${y}: A は動かない`);
    assert.deepEqual(pos(doc, 'b'), [0, H + GAP_Y], `y=${y}: B は余白の外で止まる`);
  }
  // 横: A の右 (GAP_X ちょうど) の B を左へ 1 回
  const row = desk([{ key: 'a', x: 0, y: 0 }, { key: 'b', x: W + GAP_X, y: 0 }]);
  const left = dropSheet(row.seats, row, 'b', W + GAP_X - NUDGE, 0, NOW);
  assert.deepEqual([pos(left, 'a'), pos(left, 'b')], [[0, 0], [W + GAP_X, 0]]);
  // 上から覆う (上端が A の上端と同じか上) と、A が下へずれる
  const over = dropSheet(col.seats, col, 'b', 0, 0, NOW);
  assert.deepEqual(pos(over, 'b'), [0, 0]);
  assert.deepEqual(pos(over, 'a'), [0, H + GAP_Y]);
  // A の途中から下に落とすと、B が A の下へ回る
  const mid = dropSheet(col.seats, col, 'b', 0, 200, NOW);
  assert.deepEqual([pos(mid, 'a'), pos(mid, 'b')], [[0, 0], [0, H + GAP_Y]]);
});

test('性質: 400px の画面と 1280px の画面。同じ盤面で、縦長は細く高く、どちらも重ならない', () => {
  for (const seed of [3, 4, 5]) {
    const src = randomCards(seed, 150, 20);
    const board = boardFrom(src.cards, src.families);
    const wide = layoutBoard(board, null, { aspect: WIDE, now: NOW });
    const narrow = layoutBoard(board, null, { aspect: NARROW, now: NOW });
    assert.ok(narrow.bounds.w < wide.bounds.w, `seed ${seed}`);
    assert.ok(narrow.bounds.h / narrow.bounds.w > wide.bounds.h / wide.bounds.w, `seed ${seed}`);
    assertNoOverlap(narrow.sheets);
    assert.equal(narrow.seats.aspect, NARROW);
    const settled = layoutBoard(board, narrow.seats, { aspect: WIDE, now: NOW });
    assert.deepEqual(settled.sheets, narrow.sheets, '席があれば今の縦横比では並べ直さない');
  }
});

test('速さ: 300 セッション・40 プロジェクトの盤面を 20 ms 未満で配置する (中央値)', () => {
  const src = randomCards(42, 300, 40);
  const board = boardFrom(src.cards, src.families);
  const seats = layoutBoard(board, null, { aspect: WIDE, now: NOW }).seats;
  const times = [];
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    layoutBoard(board, i % 2 ? seats : null, { aspect: WIDE, now: NOW });
    times.push(performance.now() - t0);
  }
  const median = times.sort((a, b) => a - b)[4];
  assert.ok(median < 20, `median ${median.toFixed(2)} ms`);
});
