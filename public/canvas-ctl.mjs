// @ts-check
// 画面: キャンバスの操作のまとめ役 (spec/ui.md §10.1, §10.6–§10.10)。一覧 ⇄ キャンバスの切り替え、毎回の描画、
// カーソル、帯の状態、用紙を動かす、席の保存。状態とカメラは canvas-view.mjs。描くのは canvas.mjs、帯は canvas-bar.mjs、配置は canvas-layout.mjs。
// 5 秒ごとの取得ではカメラを動かさない。カメラの動きはいつも一瞬 (design.md §7)。

import { CANVAS } from '../src/shared/constants.mjs';
import { colsCap, openCamera } from './canvas-camera.mjs';
import { slipHeights } from './canvas-fit.mjs';
import { dropSheet, layoutBoard, readingOrder } from './canvas-layout.mjs';
import { renderBar } from './canvas-bar.mjs';
import { focusSlip, loadSeats, matchedIds, renderCanvas, saveSeats } from './canvas.mjs';
import { NARROW_PX, apply, cv, fitAll, fitCam, headOf, ok, pad, reveal, resized, size, viewport } from './canvas-view.mjs';
import { bucketTitle, projectLabel } from './format.mjs';
import { dueIds, handoffPlan } from './handoff.mjs';
import { jumpPile, jumpTo, render, rowEl, view } from './render.mjs';
import { isNew, now, pileLists, setView, state, takeArrival } from './state.mjs';
import { nextUp } from './ui-state.mjs';
import { announce } from './view.mjs';
import { loadGraph } from './graph-store.mjs';

/** @typedef {import('./canvas-camera.mjs').Camera} Camera */
/** @typedef {import('./canvas-layout.mjs').Layout} Layout */

// 状態とカメラの操作は canvas-view.mjs (ここからも今までどおり使える)
export {
  NARROW_PX, apply, cv, fitAll, fitCam, fitSheet, fitToggle, headOf, isCanvas, moveCam, ok, pad, quietFocus, reveal, revealEl, resized, size, viewport, world, zoomTo,
} from './canvas-view.mjs';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const HOUR_MS = 3_600_000;
/** 縦 1 列にする縦横比 (canvas-layout の下限まで細くすると、幅は一番広い用紙になる) */
const STACK_ASPECT = 0.1;

/** 席の記録の比べ方: 位置・列・取っておく高さは厳密に、seen は 1 時間単位 (5 秒ごとに書かない)。 @param {any} doc */
const seatsKey = (doc) =>
  doc ? JSON.stringify(Object.entries(doc.seats ?? {}).map(([k, s]) => [k, s.x, s.y, s.cols, s.h ?? null, Math.floor(s.seen / HOUR_MS)]).concat([[doc.aspect]])) : '';

/** カーソルを session ID で置く (欄と、その欄の中の位置も覚える。一覧へ戻ったときのため)。 @param {string} id */
export function setCanvasCursor(id) {
  const e = view.index.get(id);
  const pile = e?.pile ?? state.cursor?.pile ?? 'needs_you';
  const list = pileLists(state.board).find((l) => l.pile === pile);
  state.cursor = { id, pile, index: Math.max(0, list ? list.ids.indexOf(id) : 0) };
}

/** 新しい盤面のあとのカーソル: 同じ ID が付箋にあればそのまま。消えたら前の読む順で次の付箋。 @param {string[]} prev */
function settleCursor(prev) {
  const was = state.cursorWas ?? state.cursor;
  state.cursorWas = null;
  if (!was) return;
  const order = new Set(cv.order);
  if (order.has(was.id)) return setCanvasCursor(was.id);
  const i = prev.indexOf(was.id);
  const next = i >= 0 ? prev.slice(i + 1).find((id) => order.has(id)) : null;
  if (next) setCanvasCursor(next);
  else if (cv.order.length && i >= 0) setCanvasCursor(cv.order[cv.order.length - 1]);
}

/** 毎回の描画 (render.mjs から)。配置 → 描く → 席を保存 → カメラ → 帯。 @param {number} at */
export function drawCanvas(at) {
  const board = state.board;
  const sz0 = size();
  // Claude の横の欄ほど狭いときは、1 列の用紙を縦 1 列に並べる (縦に読むだけで済むように)。狭いときの席は別に持ち、
  // 幅がその境を越えたら、その幅の席を読み直して開いたときのカメラにする (広い画面の並びを狭い欄で上書きしない)
  const narrow = sz0.w < NARROW_PX;
  if (cv.seats === undefined || cv.narrow !== narrow) {
    if (cv.seats !== undefined) cv.fresh = true;
    cv.seats = loadSeats(narrow);
    cv.narrow = narrow;
  }
  const aspect = narrow ? STACK_ASPECT : sz0.w / Math.max(1, sz0.h);
  const nextId = board ? nextUp(board)?.card.id ?? null : null;
  const demo = !!board?.stats?.demo;
  // 行の高さは付箋の中身に合わせる (見えない箱で測る)。段の幅は、開いたときの縮尺で表示枠に収まる幅まで
  viewport()?.classList.toggle('is-narrow', narrow);
  const slipH = board ? slipHeights($('cv-measure'), state.t, view.index, { nextId, now: at, handoff: state.prefs.handoff, demo }, sz0.w) : null;
  const maxW = (sz0.w - 2 * pad()) / CANVAS.Z_OPEN;
  const layout = layoutBoard(board, cv.repack ? null : cv.seats, { aspect, now: at, maxCols: colsCap(sz0.w), maxW, slipH });
  // 盤面がまだ無い (読み込み中・繋がらない) 間は席を作らない (空の記録を保存すると、最初の盤面が並べ直しにならない)
  if (board) {
    cv.repack = false;
    if (seatsKey(layout.seats) !== seatsKey(cv.seats)) saveSeats(layout.seats, narrow);
    cv.seats = layout.seats;
  }
  const prev = cv.order;
  cv.matched = matchedIds(view.visible);
  cv.layout = layout;
  cv.order = readingOrder(layout);
  if (board) settleCursor(prev);
  renderCanvas($('canvas'), {
    t: state.t, board, layout, index: view.index, matched: cv.matched, cursorId: state.cursor?.id ?? null, nextId, now: at,
    demo, handoff: state.prefs.handoff, isNew: (p, id) => isNew(p, id, at), takeArrival, drag: cv.drag,
    graph: loadGraph(), graphDrag: cv.graphDrag ?? null, graphFilter: state.filter,
    sessionFilters: { source: state.sourceFilter, state: state.stateFilter, project: state.projectFilter },
  });
  // 表示枠の説明: 1 文字キーを止めているときは矢印だけ (+ − f は効かない)
  const keys = $('cv-keys');
  if (keys) keys.textContent = state.t(state.prefs.keys === false ? 'canvas.keysOff' : 'canvas.keys');
  drawBar(at);
  // 帯の高さが変わると表示枠の大きさも変わる: ここで合わせる (ResizeObserver が後からずらさないように)
  // 帯を開いて表示枠が縮んだら、カーソルの付箋を見せ直す (真ん中を保つだけだと固定の見出しや帯の下に隠れる)
  if (resized(size()) && cv.bar && state.cursor && cv.order.includes(state.cursor.id)) reveal(state.cursor.id, false);
  if (cv.fresh && board) {
    cv.fresh = false;
    // 開き直したら z で戻る先は無い (前に開いたときのカメラは、今の配置では別の場所を指す)
    cv.before = null;
    cv.cam = cv.fitOnOpen ? fitCam() : openCamera(layout, nextId, cv.size.w, cv.size.h, pad());
    cv.atFit = cv.fitOnOpen;
    cv.untouched = !cv.fitOnOpen;
    cv.fitOnOpen = false;
    if (state.cursor && cv.order.includes(state.cursor.id)) reveal(state.cursor.id, false);
  }
  apply(true);
}

/** 帯を描く。 @param {number} at */
function drawBar(at) {
  const bar = cv.bar;
  const entry = bar && bar.kind !== 'sheet' ? view.index.get(bar.id) ?? null : null;
  const s = bar?.kind === 'sheet' ? cv.layout?.sheets.find((x) => x.key === bar.id) : null;
  const sheet = s ? { key: s.key, name: projectLabel(state.t, s.project) } : null;
  const rowCtx = { t: state.t, now: at, board: state.board, index: view.index, handoff: state.prefs.handoff };
  const due = state.board ? dueIds(state.board).length : 0;
  cv.bar = renderBar($('cv-bar'), { t: state.t, bar, entry, sheet, z: cv.cam.z, due, keysOn: state.prefs.keys !== false, now: at, demo: !!state.board?.stats?.demo, rowCtx, graph: loadGraph() });
}

/** カーソルを付箋へ (描き直し、追い、題名へフォーカス)。 @param {string} id @param {boolean} [focus] */
export function moveCanvasCursor(id, focus = true) {
  setCanvasCursor(id);
  render();
  reveal(id);
  if (focus) focusSlip(id);
}

/** 並べ直す: 席を捨てて並べ直し、全体を表示して読み上げる。z で戻る先は無くす (前のカメラは、もう無い配置を指す)。 */
export function rearrange() {
  cv.repack = true;
  render();
  fitAll();
  cv.before = null;
  announce(state.t('canvas.arrangeDone', { n: cv.layout?.sheets.length ?? 0 }));
}

/**
 * 用紙を (x, y) へ落とす: 覆った用紙は下へずれ、隣の余白に入っただけなら落とした用紙が余白の外で止まる。保存して読み上げる
 * (動けなかったときは canvas.blocked)。
 * @param {string} key @param {number} x @param {number} y
 */
export function placeSheet(key, x, y) {
  if (!cv.layout) return;
  const was = cv.layout.sheets.find((s) => s.key === key);
  cv.seats = dropSheet(cv.seats, cv.layout, key, x, y, now());
  saveSeats(cv.seats, cv.narrow);
  render();
  const s = cv.layout.sheets.find((x2) => x2.key === key);
  if (!s) return;
  const stuck = !!was && was.x === s.x && was.y === s.y;
  announce(state.t(stuck ? 'canvas.blocked' : 'canvas.moved', { project: projectLabel(state.t, s.project) }));
}

/**
 * 帯の「用紙を動かす」を開く (柱を押した・柱で Enter / Space)。もう開いていれば閉じる。キーで開いたときは最初のボタンへフォーカス。
 * @param {string} key @param {boolean} [byKey]
 */
export function openSheetBar(key, byKey = true) {
  if (!cv.layout?.sheets.some((s) => s.key === key)) return false;
  if (cv.bar?.kind === 'sheet' && cv.bar.id === key) return closeBar(byKey);
  cv.bar = { kind: 'sheet', id: key };
  render();
  if (byKey) /** @type {HTMLElement|null} */ ($('cv-bar').querySelector('[data-action="canvas-move"]'))?.focus({ preventScroll: true });
  return true;
}

/** 帯の詳しく・引き継ぎを開く。キーで開いたときは帯の主の部品へフォーカスする。 @param {'detail'|'handoff'} kind @param {string} id @param {boolean} [byKey] */
export function openBar(kind, id, byKey = true) {
  const e = view.index.get(id);
  if (!e) return false;
  // 案内が無ければ理由も読み上げる (帯にも理由を見出しにして出す)
  const plan = kind === 'handoff' ? handoffPlan(e.card, state.prefs.handoff[id], now()) : null;
  if (plan && !plan.guide) announce(state.t('live.handoffNo', { why: state.t(plan.why ?? 'handoff.whyUnknown') }));
  setCanvasCursor(id);
  cv.bar = { kind, id };
  render();
  if (!byKey) return true;
  const bar = $('cv-bar');
  const main = /** @type {HTMLElement|null} */ (bar.querySelector('[data-action="handoff-copy-open"], [data-action="handoff-rescue"], [data-action="handoff-close"]'));
  if (kind === 'handoff' && main) main.focus({ preventScroll: true });
  else {
    bar.tabIndex = -1;
    bar.focus({ preventScroll: true });
  }
  return true;
}

/** 帯を閉じて、付箋の題名 (用紙を動かす帯なら、その柱) へフォーカスを戻す。 @param {boolean} [focus] */
export function closeBar(focus = true) {
  const bar = cv.bar;
  const id = bar?.kind === 'sheet' ? null : bar?.id ?? state.cursor?.id;
  cv.bar = null;
  render();
  if (!focus) return true;
  const head = bar?.kind === 'sheet' ? headOf(bar.id) : null;
  if (head) head.focus({ preventScroll: true });
  else if (!(id && focusSlip(id))) viewport().focus({ preventScroll: true });
  return true;
}

/** 付箋の題名を押した: カーソルと帯の詳しく (同じ付箋をもう一度押すと閉じる)。 @param {string} id */
export function slipClick(id) {
  if (cv.bar?.kind === 'detail' && cv.bar.id === id) return closeBar(false);
  openBar('detail', id, false);
}

/** 一覧の「詳しく」の木・通知・引き継ぎどきから: その付箋へ。付箋で無い (片付けの帯の) ものは一覧で見せる。 @param {string} id */
export function canvasJumpTo(id) {
  if (!cv.order.includes(id)) {
    switchView('list', { save: false });
    return jumpTo(id);
  }
  if (!ok(id)) {
    state.filter = '';
    /** @type {HTMLInputElement} */ ($('filter')).value = '';
    state.family = null;
  }
  moveCanvasCursor(id);
}

/**
 * 台帳とキー 1〜6: その欄の (一覧の順で) 最初の付箋へ。最近と片付けは一覧のその欄へ (キャンバスでは用紙の下の帯の数で、付箋にしない)。
 * @param {string} pile
 */
export function canvasJumpPile(pile) {
  if (pile === 'cleanup' || pile === 'recent') {
    switchView('list', { save: false });
    return jumpPile(pile);
  }
  const ids = pileLists(view.visible?.filtering ? view.visible : state.board).find((l) => l.pile === pile)?.ids ?? [];
  const id = ids.find((x) => cv.order.includes(x) && ok(x));
  if (!id) return announce(state.t('bucket.none', { pile: bucketTitle(state.t, pile) }));
  moveCanvasCursor(id);
}

/**
 * 一覧 ⇄ キャンバス。キーとボタンからは好みに保存して URL の ?view= を外す。フォーカスはカーソルの付箋 (無ければ表示枠) か、
 * カーソルの行の題名 (無ければ切り替えのボタン) へ。
 * @param {'list'|'canvas'} target @param {{fit?: boolean, save?: boolean}} [o]
 */
export function switchView(target, o = {}) {
  if (o.save !== false) {
    setView(target);
    try {
      const url = new URL(location.href);
      if (url.searchParams.has('view')) {
        url.searchParams.delete('view');
        history.replaceState(null, '', url);
      }
    } catch {
      // URL を書き換えられなくても切り替えはできる
    }
  }
  if (state.view === target && !o.fit) return;
  if (target === 'canvas' && state.view !== 'canvas') {
    cv.fresh = true;
    cv.fitOnOpen = !!o.fit;
  } else if (target === 'canvas' && o.fit) return fitAll();
  state.view = target;
  render();
  const id = state.cursor?.id;
  if (target === 'canvas') {
    if (!(id && focusSlip(id))) viewport().focus({ preventScroll: true });
    return;
  }
  const title = /** @type {HTMLElement|null} */ ((id ? rowEl(id) : null)?.querySelector('[data-action="toggle"]') ?? null);
  if (title && !title.closest('[hidden], [inert]')) title.focus({ preventScroll: true });
  else $('view-toggle').focus({ preventScroll: true });
}

/** 描き直しでフォーカスのあった部品が消えたとき: カーソルの付箋、無ければ表示枠。カメラは動かさない (取得はカメラを動かさない)。 */
export function canvasFocusFallback() {
  cv.quiet = true;
  try {
    if (!(state.cursor && focusSlip(state.cursor.id))) viewport().focus({ preventScroll: true });
  } finally {
    cv.quiet = false;
  }
}
