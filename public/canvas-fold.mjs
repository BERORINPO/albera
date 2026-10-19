// @ts-check
// 画面: キャンバスの紙の急ぐ順と待ち時間の鍵・席を作るときの列数・紙の大きさと行の高さ・「片付けだけ」のまとめ (spec/ui.md §10.4 の 1〜5・10)。純粋関数。
// DOM・storage・時計は触らない。生きている付箋の無いプロジェクト (片付けのセッションだけ) は紙にせず、最後の紙の下に 1 行ずつの一覧にまとめる。
// 紙の中身とまとめ役は canvas-layout.mjs、机の上の置き場所は canvas-desk.mjs。

import { CANVAS } from '../src/shared/constants.mjs';
import { cmpStr } from './canvas-desk.mjs';

const { SLIP_W, SLIP_H, SLIP_H_MIN, SLIP_H_MAX, BACK_HEAD, FOLD_ROW, FOOT_H, GAP_Y, COLS_MIN, COLS_MAX } = CANVAS;
/** 行の高さの刻み (測った高さを切り上げる。1px の違いで用紙の高さを変えない) */
const ROW_STEP = 4;
// 一覧で長く待っている順 (since の小さい順) に並ぶ欄。作業中は新しく始めた順
const OLDEST_FIRST = new Set(['needs_you', 'trouble', 'unread']);
// 急ぐ順: この欄に 1 件でもある紙が先 (左から順に比べる)。最近は急がない (同点の紙は一番長く待っている順、次に新しく動いた順で分かれる)
const URGENT = Object.freeze(['needs_you', 'trouble', 'unread', 'working']);
/** まとめの DOM の鍵 (プロジェクトの key はフォルダの名前なので NUL は入らない) */
export const FOLD_KEY = '\u0000fold';

/** @typedef {{key: string, label: string|null, extra: number}} ProjectRef */
/** @typedef {{key: string, label: string|null, project: ProjectRef, n: number}} FoldItem  n = 片付けのセッション数 */
/** @typedef {{key: string, x: number, y: number, w: number, h: number, items: FoldItem[]}} Fold  まとめの四角 (world) と 1 行ずつの中身 */

/**
 * 席を作るときの列数: ceil(√付箋の数) を COLS_MIN〜maxCols に収める。付箋より多くはならない (空の列を作らない)。付箋の無い紙は 1 列。
 * @param {number} n 紙の付箋 (マス) の数 @param {number} [maxCols] 画面の幅で決まる上限
 */
export function colsFor(n, maxCols = COLS_MAX) {
  const cap = Math.max(COLS_MIN, Math.min(COLS_MAX, Math.floor(maxCols) || COLS_MAX));
  return Math.min(cap, Math.max(COLS_MIN, Math.ceil(Math.sqrt(Math.max(0, Number(n) || 0)))));
}

/**
 * 紙の急ぐ順の鍵 (小さいほど先)。一番急ぐ欄 (返事待ち → 止まったかも → 未読 → 作業中、無ければ最後) が先、同じなら
 * その欄で一番長く待っている順 (wait: その欄の一番前の付箋の時間の鍵。一覧のその欄の並びと同じ向き)、
 * 次に「フォルダなし」は名前のあるプロジェクトの後、次に新しく動いた順、最後に大きい順 (weight)。
 * ほかの欄があるかどうかでは比べない (未読もある紙が、もっと長く返事を待っている紙より先に来ないように)。
 * @param {{label: string|null, counts: Record<string, number>, lastAt: number, weight: number, wait?: number}} m
 * @returns {number[]}
 */
export function urgencyRank(m) {
  const top = URGENT.findIndex((p) => Number(m.counts?.[p]) > 0);
  return [top < 0 ? URGENT.length : top, Number(m.wait) || 0, m.label == null ? 1 : 0, -(Number(m.lastAt) || 0), -(Number(m.weight) || 0)];
}

/**
 * 紙の「一番長く待っている」鍵: 一番急ぐ欄 (返事待ち → 止まったかも → 未読 → 作業中) の一番前の付箋の時間の鍵 (memberKey と同じ向き)。
 * 同じ急ぎの紙どうしは、一覧のその欄で先に来るカードのある紙が先になる。急ぐ欄が無ければ 0。
 * @param {{live: Array<Record<string, any>>, faded: Set<string>, piles: Map<string, string>, counts: Record<string, number>}} s
 */
export function waitKey(s) {
  const top = URGENT.find((p) => Number(s.counts?.[p]) > 0);
  if (!top) return 0;
  const keys = s.live.filter((c) => !s.faded.has(String(c.id)) && s.piles.get(String(c.id)) === top).map((c) => (OLDEST_FIRST.has(top) ? Number(c.since) || 0 : -(Number(c.since) || 0)));
  return keys.length ? Math.min(...keys) : 0;
}

/**
 * 4. 紙の大きさ: 幅 cols × SLIP_W、高さ = マス (行の高さの和。rowH が無ければ rows × SLIP_H) + 帯 (「最近 N」「片付け N」の 1 行、何件でも同じ) + FOOT_H。
 * @param {boolean} band @param {number} cols @param {number} rows @param {number[]} [rowH] 行ごとの高さ
 */
export function geometry(band, cols, rows, rowH = undefined) {
  const liveH = rowH ? rowH.reduce((a, b) => a + b, 0) : rows * SLIP_H;
  return { w: cols * SLIP_W, h: liveH + (band ? BACK_HEAD : 0) + FOOT_H, liveH };
}

/**
 * 付箋 1 枚の高さ (画面が測った中身の高さ。world の単位)。数でなければ SLIP_H、SLIP_H_MIN〜SLIP_H_MAX に収めて ROW_STEP に切り上げる。
 * @param {Map<string, number>|null|undefined} slipH @param {string} id
 */
export function slipHeight(slipH, id) {
  const v = Number(slipH?.get(id));
  if (!Number.isFinite(v) || v <= 0) return SLIP_H;
  return Math.ceil(Math.min(SLIP_H_MAX, Math.max(SLIP_H_MIN, v)) / ROW_STEP) * ROW_STEP;
}

/**
 * 片付けだけのプロジェクトのまとめ。片付けの多い順 (同じなら key)。置き場所は紙のいちばん左、いちばん下の紙の GAP_Y 下 (席は持たない)。
 * 紙の下は机の上で取っている高さ (席の h) で測る: 紙が伸び縮みしても、まとめは上下に跳ねない。
 * @param {Array<{key: string, label: string|null, project: ProjectRef, counts: Record<string, number>}>} models 生きている付箋の無い紙
 * @param {Array<{x: number, y: number, h: number}>} sheets 机に置いた紙 (h は机の上で取る高さ)
 * @returns {Fold|null}
 */
export function foldBlock(models, sheets) {
  if (!models.length) return null;
  const items = models
    .map((m) => ({ key: m.key, label: m.label, project: m.project, n: Number(m.counts?.cleanup) || 0 }))
    .sort((a, b) => b.n - a.n || cmpStr(a.key, b.key));
  const x = sheets.length ? Math.min(...sheets.map((s) => s.x)) : 0;
  const y = sheets.length ? Math.max(...sheets.map((s) => s.y + s.h)) + GAP_Y : 0;
  return { key: FOLD_KEY, x, y, w: SLIP_W, h: items.length * FOLD_ROW + FOOT_H, items };
}
