// @ts-check
// 画面: キャンバスの配置 (spec/ui.md §10.4)。純粋関数。DOM・storage・時計は触らない (node:test からも読める)。
// 同じ入力 → 同じ出力。座標は world の単位 (100% の CSS px)。絞り込みは配置を変えない (画面が薄くするだけ)。
// ここは紙の中身 (どの紙に・どの順で・どのマスに) と全体のまとめ。机の上の置き場所と席の記録は canvas-desk.mjs、
// 紙の急ぐ順・待ち時間の鍵・席を作るときの列数・紙の大きさ・行の高さ・「片付けだけ」のまとめは canvas-fold.mjs。

import { BUCKETS, CANVAS, OTHER_PROJECT } from '../src/shared/constants.mjs';
import { ASPECT_DEFAULT, arrange, cmpKey, cmpStr, hasOwn, parseSeats, seatOf, settle } from './canvas-desk.mjs';
import { colsFor, foldBlock, geometry, slipHeight, urgencyRank, waitKey } from './canvas-fold.mjs';
import { allCards, rowIds } from './ui-state.mjs';

// 机とまとめの関数もここから使えるようにする (画面は canvas-layout.mjs だけを import すればよい)
export { arrange, dropSheet, pack, parseSeats, pushDown, settle } from './canvas-desk.mjs';
export { colsFor, FOLD_KEY, foldBlock, geometry, slipHeight, urgencyRank } from './canvas-fold.mjs';

/** @typedef {Record<string, any>} Card */
/** @typedef {'needs_you'|'trouble'|'unread'|'working'|'recent'|'cleanup'} Pile */
/** @typedef {Record<Pile, number>} Counts  紙の上のセッション数 (片付けの定期実行の行は runIds の数。faded は cleanup) */
/** @typedef {{key: string, label: string|null, extra: number}} ProjectRef  projectLabel(t, project) にそのまま渡せる */
/** @typedef {import('./canvas-desk.mjs').Seat} Seat */
/** @typedef {import('./canvas-desk.mjs').SeatsDoc} SeatsDoc */
/**
 * @typedef {Object} SheetModel  プロジェクト 1 つ分の紙 (位置はまだ無い)
 * @property {string} key
 * @property {string|null} label        null = フォルダなし
 * @property {ProjectRef} project
 * @property {Card[]} live              生きている欄のカードと faded (並びは orderSlots)
 * @property {Set<string>} faded        片付けにいるが、家族のだれかが生きている欄にいるカード
 * @property {Map<string, Pile>} piles  live の ID → 欄 (faded は cleanup)
 * @property {Card[]} back              片付けの帯 (lastActivityAt の新しい順)
 * @property {Counts} counts
 * @property {boolean} quiet            返事待ち・止まったかも・未読・作業中が 0
 * @property {number} weight            live + back / 4
 * @property {number} lastAt            紙のカードの一番新しい lastActivityAt (急ぐ順の同点を分ける)
 * @property {number} wait              一番急ぐ欄の一番前の付箋の時間の鍵 (返事待ち・止まったかも・未読は since、作業中は −since。小さいほど先)
 */
/** 付箋 1 枚 (SLIP_W × その行の高さ h)。 @typedef {{id: string, pile: Pile, col: number, row: number, x: number, y: number, h: number}} SlipLayout */
/**
 * 紙 1 枚の配置。x・y・w・h は world、slips・back の座標は紙の左上からの相対。slips はマスの順 (行の左から右、上から下)。
 * 行の高さはその行の付箋の中身の高さの最大 (slipH。無ければ SLIP_H)。liveH = マスの部分の高さ (行の高さの和)。
 * back = 帯 (「最近 N」「片付け N」の 1 行): y = 上端、total = 付箋にしていない片付け、
 * recent = 付箋にしていない最近 (どちらも帯の数に入っている)。帯の数は counts (セッションの数)。
 * @typedef {{key: string, label: string|null, project: ProjectRef, quiet: boolean, x: number, y: number, w: number, h: number, cols: number,
 *   rows: number, liveH: number, counts: Counts, slips: SlipLayout[], back: {total: number, recent: number, y: number}}} SheetLayout
 */
/** @typedef {import('./canvas-fold.mjs').Fold} Fold */
/** @typedef {{sheets: SheetLayout[], seats: SeatsDoc, bounds: {x: number, y: number, w: number, h: number}, fold: Fold|null}} Layout  fold = 片付けだけのプロジェクト */

const { SLIP_W, FOLD_ROW, FOOT_H, COLS_MAX } = CANVAS;
const PILE_INDEX = Object.freeze(Object.fromEntries(BUCKETS.map((b, i) => [b.key, i])));
// 帯: 0 = 前 (返事待ち・止まったかも)、1 = 中 (未読・作業中)、2 = 最近、3 = faded
const BAND = Object.freeze({ needs_you: 0, trouble: 0, unread: 1, working: 1, recent: 2, cleanup: 3 });
const OLDEST_FIRST = new Set(['needs_you', 'trouble', 'unread']);
const ACTION_PILES = Object.freeze(['needs_you', 'trouble', 'unread', 'working']);
const UNKNOWN_PILE = 'recent'; // 欄の分からないカード (壊れた入力) は最近として並べる

const num = (/** @type {unknown} */ v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** @returns {Counts} */
const zeroCounts = () => ({ needs_you: 0, trouble: 0, unread: 0, working: 0, recent: 0, cleanup: 0 });

/** 家族の鍵: family.rootId、無ければ board.families の根としての自分。 @param {Card} card @param {any} families */
function familyKey(card, families) {
  const r = card.family?.rootId;
  if (typeof r === 'string' && r) return r;
  return hasOwn(families, String(card.id)) ? String(card.id) : null;
}

/** 盤面の全カード (同じ ID は最初の 1 枚だけ)。 @param {any} board @returns {Array<{card: Card, pile: string}>} */
function uniqueEntries(board) {
  const seen = new Set();
  const out = [];
  for (const e of allCards(board)) {
    const id = e.card?.id;
    if (id == null || seen.has(String(id))) continue;
    seen.add(String(id));
    out.push(e);
  }
  return out;
}

/**
 * 1. プロジェクトごとの紙 (key の順)。片付けのカードは、家族のだれかが盤面のどこかの生きている欄にいれば faded として live に入る。
 * @param {any} board
 * @returns {SheetModel[]}
 */
export function buildSheets(board) {
  const entries = uniqueEntries(board);
  const families = board?.families ?? {};
  const liveIds = new Set();
  const liveRoots = new Set();
  for (const { card, pile } of entries) {
    if (pile === 'cleanup') continue;
    liveIds.add(String(card.id));
    const root = familyKey(card, families);
    if (root) liveRoots.add(root);
  }
  /** @param {Card} card */
  const familyIsLive = (card) => {
    const root = familyKey(card, families);
    const members = root && hasOwn(families, root) ? families[root]?.memberIds : null;
    return !!root && (liveRoots.has(root) || (Array.isArray(members) && members.some((id) => liveIds.has(String(id)))));
  };
  /** @type {Map<string, Omit<SheetModel, 'quiet'|'weight'>>} */
  const sheets = new Map();
  for (const { card, pile } of entries) {
    const key = String(card.project?.key ?? OTHER_PROJECT.key);
    let s = sheets.get(key);
    if (!s) {
      const label = card.project?.label == null ? null : String(card.project.label);
      s = { key, label, project: { key, label, extra: num(card.project?.extra) }, live: [], faded: new Set(), piles: new Map(), back: [], counts: zeroCounts() };
      sheets.set(key, s);
    }
    const id = String(card.id);
    if (pile !== 'cleanup') {
      const p = /** @type {Pile} */ (hasOwn(BAND, pile) ? pile : UNKNOWN_PILE);
      s.live.push(card);
      s.piles.set(id, p);
      s.counts[p]++;
      continue;
    }
    s.counts.cleanup += rowIds(card).length;
    if (!familyIsLive(card)) s.back.push(card);
    else {
      s.live.push(card);
      s.faded.add(id);
      s.piles.set(id, 'cleanup');
    }
  }
  const newestFirst = (/** @type {Card} */ a, /** @type {Card} */ b) => num(b.lastActivityAt) - num(a.lastActivityAt) || cmpStr(String(a.id), String(b.id));
  const lastAt = (/** @type {Card[]} */ cards) => cards.reduce((t, c) => Math.max(t, num(c.lastActivityAt)), 0);
  return [...sheets.values()]
    .sort((a, b) => cmpStr(a.key, b.key))
    .map((s) => ({
      ...s, back: [...s.back].sort(newestFirst), quiet: !ACTION_PILES.some((p) => s.counts[/** @type {Pile} */ (p)] > 0), weight: s.live.length + s.back.length / 4, lastAt: lastAt([...s.live, ...s.back]), wait: waitKey(s),
    }));
}

/** カード 1 枚の鍵 [帯, 欄の順, 時間, ID]。 @param {Card} card @param {Pile} pile @param {boolean} faded */
function memberKey(card, pile, faded) {
  const time = faded ? -num(card.lastActivityAt) : OLDEST_FIRST.has(pile) ? num(card.since) : -num(card.since);
  return [BAND[pile] ?? BAND[UNKNOWN_PILE], PILE_INDEX[pile] ?? PILE_INDEX[UNKNOWN_PILE], time, String(card.id)];
}

/**
 * 2. 紙の中の順 (前 → 後ろ)。鍵 [帯, 欄の順, 時間, ID] の小さい順: 返事待ち・止まったかも → 未読・作業中 → 最近 → faded。
 * 返事待ち・止まったかも・未読は長く待っている順、作業中と最近は新しい順 (一覧と同じ)。親子でまとめない (親は付箋の言葉で言う):
 * まとめると、返事待ちの間に作業中の兄弟が割り込んだ。
 * @param {Card[]} cards @param {Map<string, Pile>} [piles] ID → 欄。無ければ card.bucket @param {Set<string>} [faded]
 * @returns {string[]}
 */
export function orderSlots(cards, piles = undefined, faded = new Set()) {
  /** @param {Card} c @returns {Pile} */
  const pileOf = (c) => (faded.has(String(c.id)) ? 'cleanup' : piles?.get(String(c.id)) ?? (hasOwn(BAND, c.bucket) ? c.bucket : UNKNOWN_PILE));
  return cards
    .map((c) => ({ id: String(c.id), key: memberKey(c, pileOf(c), faded.has(String(c.id))) }))
    .sort((a, b) => cmpKey(a.key, b.key))
    .map((x) => x.id);
}

/**
 * 3. マスに置く (読む順に、行の左から右、上から下)。
 * @param {string[]} ids @param {number} cols
 * @returns {{slots: Map<string, {col: number, row: number}>, rows: number}}  slots は読む順
 */
export function place(ids, cols) {
  const width = Math.max(1, Math.floor(cols) || 1);
  const slots = new Map(ids.map((id, i) => [id, { col: i % width, row: Math.floor(i / width) }]));
  return { slots, rows: Math.ceil(ids.length / width) };
}

/** 帯があるか: 最近か片付けのセッションが 1 つでもある。 @param {{counts: Counts}} m */
export const hasBand = (m) => m.counts.recent + m.counts.cleanup > 0;

/** 付箋のマスに置く欄 (返事待ち・止まったかも・未読・作業中)。faded は片付け。 @param {SheetModel} m @param {string} id */
const isFront = (m, id) => !m.faded.has(id) && (BAND[/** @type {Pile} */ (m.piles.get(id))] ?? BAND.recent) <= BAND.working;
/** 紙にするか: 片付けではない (faded でもない) カードが 1 枚でもある。無ければ「片付けだけ」のまとめへ。 @param {SheetModel} m */
const hasLive = (m) => m.live.some((c) => !m.faded.has(String(c.id)));

/**
 * 紙 1 枚の中身 (列・マス・大きさ・帯)。位置は 0。付箋にするのは返事待ち・止まったかも・未読・作業中だけ (急ぐ順)。
 * 最近と片付け (faded も) は付箋にせず帯の数に入る (一覧の最近が閉じているのと同じ。帯を押すと一覧のその欄)。
 * 行の高さはその行の付箋の高さ (slipHeight) の最大: 中身の短い付箋の下に空白を残さない。
 * @param {SheetModel} m @param {Seat|null} seat @param {number} maxCols @param {Map<string, number>|null} slipH
 */
function shapeSheet(m, seat, maxCols, slipH) {
  const grid = orderSlots(m.live.filter((c) => isFront(m, String(c.id))), m.piles, m.faded);
  const n = grid.length;
  const cols = seat ? seat.cols : colsFor(n, maxCols);
  const a = place(grid, cols);
  /** @type {number[]} */
  const rowH = Array.from({ length: a.rows }, () => 0);
  for (const [id, { row }] of a.slots) rowH[row] = Math.max(rowH[row], slipHeight(slipH, id));
  const rowY = rowH.map((_, r) => rowH.slice(0, r).reduce((sum, v) => sum + v, 0));
  const g = geometry(hasBand(m), cols, a.rows, rowH);
  return {
    sheet: { key: m.key, label: m.label, project: m.project, quiet: m.quiet, x: 0, y: 0, w: g.w, h: g.h, cols, rows: a.rows, liveH: g.liveH, counts: m.counts },
    slips: [...a.slots].map(([id, { col, row }]) => ({ id, pile: /** @type {Pile} */ (m.piles.get(id)), col, row, x: col * SLIP_W, y: rowY[row], h: rowH[row] })),
    back: { total: m.back.length + m.faded.size, recent: m.live.length - m.faded.size - n, y: g.liveH },
    weight: m.weight,
    rank: urgencyRank(m),
  };
}

/** @param {Array<{x: number, y: number, w: number, h: number}>} sheets */
function boundsOf(sheets) {
  if (!sheets.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...sheets.map((s) => s.x));
  const y = Math.min(...sheets.map((s) => s.y));
  return { x, y, w: Math.max(...sheets.map((s) => s.x + s.w)) - x, h: Math.max(...sheets.map((s) => s.y + s.h)) - y };
}

/**
 * 10. 盤面全体の配置。席の記録が null (または壊れている) なら席を捨てて並べ直す (初回と「並べ直す」)、あれば settle。
 * 紙は読む順 (y, x, key)。生きている付箋の無いプロジェクト (片付けだけ) は紙にせず fold にまとめる。bounds は紙と fold を覆う。
 * @param {any} board
 * @param {SeatsDoc|string|null} seats  parseSeats を通す
 * @param {{aspect?: number, now?: number, maxCols?: number, maxW?: number, slipH?: Map<string, number>|null}} [o]  aspect は並べ直すときだけ使う
 *   (settle は記録の縦横比)。maxCols は席を作るときの列数の上限 (画面の幅で決まる。席のある紙は席の列数のまま)。maxW は段の幅の上限
 *   (開いたときの縮尺で表示枠に収まる幅、pack と settle)。slipH は付箋ごとの中身の高さ (画面が測る。無ければ SLIP_H)
 * @returns {Layout}
 */
export function layoutBoard(board, seats, { aspect = ASPECT_DEFAULT, now = 0, maxCols = COLS_MAX, maxW = Infinity, slipH = null } = {}) {
  const doc = parseSeats(seats);
  const t = num(now);
  const models = buildSheets(board);
  const shaped = models.filter(hasLive).map((m) => shapeSheet(m, seatOf(doc, m.key), maxCols, slipH));
  const items = shaped.map(({ sheet, weight, rank }) => ({ key: sheet.key, w: sheet.w, h: sheet.h, weight, rank, cols: sheet.cols }));
  const folded = models.filter((m) => !hasLive(m));
  const r = doc ? settle(items, doc, t, maxW) : arrange(items, aspect, t, folded.length ? { w: SLIP_W, h: folded.length * FOLD_ROW + FOOT_H } : null, maxW);
  const pos = new Map(r.placed.map((p) => [p.key, p]));
  /** @type {SheetLayout[]} */
  const sheets = shaped
    .map(({ sheet, slips, back }) => ({ ...sheet, x: pos.get(sheet.key)?.x ?? 0, y: pos.get(sheet.key)?.y ?? 0, slips, back }))
    .sort((a, b) => a.y - b.y || a.x - b.x || cmpStr(a.key, b.key));
  const fold = foldBlock(folded, r.placed);
  return { sheets, seats: r.seats, bounds: boundsOf(fold ? [...sheets, fold] : sheets), fold };
}

/** 11. 読む順の slip ID (紙ごと、紙の中はマスの順。最近と片付けは付箋ではないので入らない)。 @param {Layout} layout @returns {string[]} */
export const readingOrder = (layout) => (layout?.sheets ?? []).flatMap((s) => s.slips.map((sl) => sl.id));

/** slip とその紙。 @param {Layout} layout @param {string} id @returns {{sheet: SheetLayout, slip: SlipLayout}|null} */
export function findSlip(layout, id) {
  for (const sheet of layout?.sheets ?? []) {
    const slip = sheet.slips.find((s) => s.id === id);
    if (slip) return { sheet, slip };
  }
  return null;
}

const DIRS = Object.freeze({ left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] });
/** 点から四角までの距離の 2 乗。 @param {number} px @param {number} py @param {{x: number, y: number, w: number, h: number}} r */
const dist2 = (px, py, r) => Math.max(r.x - px, 0, px - (r.x + r.w)) ** 2 + Math.max(r.y - py, 0, py - (r.y + r.h)) ** 2;

/**
 * 11. 矢印の先の slip。紙の中で中心がその向きにある一番近いもの (向きの距離、次に横の距離)。無ければ、その向きにある
 * 一番近い紙 (中心から紙の四角までの距離) の中で、中心が一番近いもの。無ければ null。
 * @param {Layout} layout @param {string} id @param {'left'|'right'|'up'|'down'} dir
 * @param {(id: string) => boolean} [ok] 飛ばさない slip (絞り込みに合うもの)。省けば全部
 * @returns {string|null}
 */
export function neighbour(layout, id, dir, ok = () => true) {
  const d = hasOwn(DIRS, dir) ? DIRS[dir] : null;
  const at = findSlip(layout, id);
  if (!d || !at) return null;
  let best = { id: /** @type {string|null} */ (null), p: Infinity, s: Infinity };
  for (const sl of at.sheet.slips) {
    if (sl.id === id || !ok(sl.id)) continue;
    const p = (sl.x - at.slip.x) * d[0] + (sl.y - at.slip.y) * d[1];
    const s = d[0] ? Math.abs(sl.y - at.slip.y) : Math.abs(sl.x - at.slip.x);
    if (p > 0 && (p < best.p || (p === best.p && s < best.s))) best = { id: sl.id, p, s };
  }
  if (best.id) return best.id;
  const cur = at.sheet;
  const cx = cur.x + at.slip.x + SLIP_W / 2;
  const cy = cur.y + at.slip.y + at.slip.h / 2;
  /** @param {SheetLayout} o */
  const way = (o) => (dir === 'right' ? o.x >= cur.x + cur.w : dir === 'left' ? o.x + o.w <= cur.x : dir === 'down' ? o.y >= cur.y + cur.h : o.y + o.h <= cur.y);
  let near = { sheet: /** @type {SheetLayout|null} */ (null), d: Infinity };
  for (const o of layout.sheets) {
    if (o === cur || !way(o) || !o.slips.some((sl) => ok(sl.id))) continue;
    const dd = dist2(cx, cy, o);
    if (dd < near.d) near = { sheet: o, d: dd };
  }
  const o = near.sheet;
  if (!o) return null;
  let pick = { id: /** @type {string|null} */ (null), d: Infinity };
  for (const sl of o.slips) {
    const dd = (o.x + sl.x + SLIP_W / 2 - cx) ** 2 + (o.y + sl.y + sl.h / 2 - cy) ** 2;
    if (ok(sl.id) && dd < pick.d) pick = { id: sl.id, d: dd };
  }
  return pick.id;
}
