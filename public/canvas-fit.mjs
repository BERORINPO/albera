// @ts-check
// 画面: 付箋の中身の高さを測る (spec/ui.md §10.4 の 4)。配置 (canvas-layout.mjs) は純粋なので、測った高さを入力 (slipH) として渡す。
// 測るのは表示枠の外の見えない箱 (#cv-measure) の中。近く (LEVEL_NEAR の縮尺の文字) と中くらい (LEVEL_MID の縮尺の文字) の両方で測り、大きいほう。
// 付箋はどの縮尺でも同じ高さなので、文字が一番大きく見える (逆拡大の --k が一番大きい) 縮尺で収まればよい。
// 時刻で行数が変わらないよう、足と操作は 1 行、作業中の長い行は 1 行 (canvas.css)、止まったかもの長い行は 2 行分を取る (この箱の CSS)。
// 狭い表示枠 (Claude の横の欄) に中くらいの段階は無い (levelOf): 近く (開いた倍率から) だけで測る。中くらいの行のために付箋の下を空けない。

import { CANVAS } from '../src/shared/constants.mjs';
import { isNarrow, nearZ } from './canvas-camera.mjs';
import { canvasSig, slipEl, slipFlags } from './canvas-slip.mjs';

/** @typedef {import('./i18n.mjs').T} T */

/** 付箋にする欄 (最近と片付けは帯の数だけ) */
const SLIP_PILES = new Set(['needs_you', 'trouble', 'unread', 'working']);
/** 中身の下の余白 (world の単位): 最後の行の下を空けて、次の行の罫線に付けない */
const BOTTOM = 8;
const MID = Object.freeze(['mid', 1 / CANVAS.LEVEL_MID]);

/** @type {Map<string, {sig: string, h: number}>} ID → 署名と測った高さ (署名と幅の種類が同じなら測り直さない) */
const cache = new Map();

/**
 * 付箋になるセッションの中身の高さ (world の単位)。署名 (canvasSig) が変わったものだけ測り直す。
 * @param {HTMLElement|null} box #cv-measure
 * @param {T} t
 * @param {Map<string, {card: any, pile: string}>} index
 * @param {{nextId: string|null, now: number, handoff?: Record<string, any>, demo: boolean}} o
 * @param {number} vw 表示枠の幅 (狭い表示枠は中くらいが無く、近くは開いた倍率から)
 * @returns {Map<string, number>|null} 測れないとき (箱が無い) は null (配置は SLIP_H)
 */
export function slipHeights(box, t, index, o, vw) {
  if (!box) return null;
  const near = /** @type {[string, number]} */ (['near', 1 / nearZ(vw)]);
  const levels = isNarrow(vw) ? [near] : [near, MID];
  const tag = `${Math.round(near[1] * 1000)}|${levels.length}`;
  const ctx = { ...o, isNew: () => false, takeArrival: () => false };
  /** @type {Array<{id: string, sig: string, el: HTMLElement}>} */
  const todo = [];
  const out = new Map();
  for (const [id, e] of index) {
    if (!SLIP_PILES.has(e.pile) || !e.card) continue;
    const slip = { pile: e.pile };
    const sig = `${tag}|${canvasSig(t.lang, e.card, slipFlags(e.card, slip, ctx))}`;
    const hit = cache.get(id);
    if (hit && hit.sig === sig) out.set(id, hit.h);
    else todo.push({ id, sig, el: slipEl(t, e.card, slip, ctx) });
  }
  for (const id of cache.keys()) if (!index.has(id)) cache.delete(id);
  if (!todo.length) return out;
  box.style.setProperty('--w', String(CANVAS.SLIP_W));
  box.replaceChildren(...todo.map((x) => x.el));
  const hs = todo.map(() => 0);
  for (const [level, k] of levels) {
    box.dataset.level = level;
    box.style.setProperty('--k', String(k));
    todo.forEach((x, i) => {
      hs[i] = Math.max(hs[i], x.el.offsetHeight + BOTTOM);
    });
  }
  box.replaceChildren();
  todo.forEach((x, i) => {
    cache.set(x.id, { sig: x.sig, h: hs[i] });
    out.set(x.id, hs[i]);
  });
  return out;
}
