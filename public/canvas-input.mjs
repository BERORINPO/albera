// @ts-check
// 画面: キャンバスのキー・ポインタ・ホイール・タッチ (spec/ui.md §10.7, §10.8)。canvasKeyAction と canvasEscapeStep は純粋関数。
// 一覧と同じ決まり: 日本語入力中・修飾キー・入力欄・dialog の中では何もしない。1 文字キーは help の切替で止まる (WCAG 2.1.4)。

import { CANVAS } from '../src/shared/constants.mjs';

/** @typedef {'viewport'|'slip'|'graph'|'head'|'bar'|'filter'|'field'|'dialog'|'control'|'none'} CanvasTarget */
/** @typedef {{key: string, keyCode?: number, isComposing?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean, repeat?: boolean}} KeyLike */

const ARROWS = Object.freeze({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' });
/** 押しっぱなしで繰り返さないキー (開く・切り替える・全体表示)。 */
const NO_REPEAT = new Set(['h', 'v', 'z', 'f', '0', 'o']);

/** A graph connection drop is valid only for two distinct, non-empty card IDs. */
export function graphConnectionDrop(sourceId, targetId, sourceKind = 'graph', targetKind = 'graph') {
  const validKind = (kind) => kind === 'graph' || kind === 'session';
  return typeof sourceId === 'string' && sourceId.length > 0 && typeof targetId === 'string' && targetId.length > 0
    && validKind(sourceKind) && validKind(targetKind) && (sourceKind !== targetKind || sourceId !== targetId)
    ? { sourceId, targetId, sourceKind, targetKind }
    : null;
}

/**
 * キャンバスのキーから動作の名前を決める (純粋)。null ならブラウザの普段の動きのまま。
 * @param {KeyLike} ev
 * @param {{keysOn: boolean, target: CanvasTarget}} ctx
 * @returns {string|null}
 */
export function canvasKeyAction(ev, ctx) {
  if (ev.isComposing || ev.keyCode === 229) return null;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  const { key } = ev;
  const { target, keysOn } = ctx;
  if (target === 'dialog' || target === 'field') return null;
  if (target === 'filter') return key === 'Escape' ? 'escape' : null;
  if (key === 'Escape') return 'escape';
  const dir = /** @type {Record<string, string>} */ (ARROWS)[key];
  if (dir) {
    // 矢印は 1 文字キーではないので、切替で止めても効く
    if (target === 'head') return ev.shiftKey ? `nudge-${dir}` : null;
    if (target === 'graph') return `graph-move-${dir}`;
    if (target === 'slip') return ev.shiftKey ? null : `move-${dir}`;
    if (target === 'viewport' || target === 'none') return `pan-${dir}${ev.shiftKey ? '-big' : ''}`;
    return null;
  }
  // Shift で意味の変わる名前つきのキーは Shift を無視する。1 文字のキーは ev.key がもう配列どおりの文字
  if (ev.shiftKey && (key.length !== 1 || key === ' ')) return null;
  // 柱の Enter と Space: 帯に「用紙を動かす」のボタンを出す (柱をボタンとして働かせる。ドラッグの代わりの道)
  if (key === 'Enter') return target === 'slip' || target === 'viewport' || target === 'none' ? 'open' : target === 'head' ? 'sheet' : null;
  if (key === ' ') return target === 'slip' ? 'peek' : target === 'head' ? 'sheet' : null;
  if (!keysOn || key.length !== 1) return null;
  if (ev.repeat && NO_REPEAT.has(key)) return null;
  switch (key) {
    case 'j':
      return 'next';
    case 'k':
      return 'prev';
    case 'o':
      return 'open';
    case 'h':
      return 'handoff';
    case '+':
    case '=':
      return 'zoom-in';
    case '-':
    case '−':
      return 'zoom-out';
    case '0':
      return 'zoom-reset';
    case 'f':
      return 'fit';
    case 'z':
      return 'fit-toggle';
    case 'v':
      return 'view';
    case '/':
      return 'filter';
    case '?':
      return 'help';
    default:
      return /^[1-6]$/.test(key) ? `jump-${key}` : null;
  }
}

/**
 * キャンバスの Esc で閉じるものを、上から最初に当てはまる 1 つだけ選ぶ (純粋)。選択と batch は決して消さない。
 * dialog は閉じる前にブラウザが受ける (ここへは来ない)。
 * @param {{inFilter: boolean, filterValue: string, bar: null|'detail'|'handoff', onSlipOrHead: boolean, family: string|null, q: string}} ctx
 * @returns {'filter-clear'|'filter-blur'|'bar-close'|'to-viewport'|'family-clear'|'query-clear'|null}
 */
export function canvasEscapeStep(ctx) {
  if (ctx.inFilter) return ctx.filterValue ? 'filter-clear' : 'filter-blur';
  if (ctx.bar) return 'bar-close';
  if (ctx.onSlipOrHead) return 'to-viewport';
  if (ctx.family) return 'family-clear';
  if (ctx.q) return 'query-clear';
  return null;
}

/**
 * キャンバスでのキーの受け手の種類 (DOM を見る)。
 * @param {EventTarget|null} el
 * @returns {CanvasTarget}
 */
export function canvasTarget(el) {
  if (!(el instanceof Element)) return 'none';
  if (el.closest('dialog[open]')) return 'dialog';
  if (el.id === 'filter') return 'filter';
  if (el.matches('input[type="checkbox"], input[type="radio"]')) return 'control';
  if (el.matches('input, textarea, select, [contenteditable], [contenteditable] *')) return 'field';
  if (el.matches('.slip__title')) return 'slip';
  if (el.closest('.graph-node')) return 'graph';
  if (el.matches('.sheet__head')) return 'head';
  if (el.id === 'cv-view') return 'viewport';
  if (el.closest('#cv-bar')) return 'bar';
  if (el.matches('button, a[href], summary, [tabindex]')) return 'control';
  return 'none';
}

/**
 * @typedef {Object} CanvasHandlers
 * @property {(dx: number, dy: number) => void} pan 画面の px で動かす
 * @property {(factor: number, px: number, py: number) => void} zoomBy 表示枠の中の点 (px, py) を中心に factor 倍
 * @property {(key: string, dx: number, dy: number) => void} dragSheet 見出しをつかんで動かしている間 (画面の px、つかんだ所から)
 * @property {(key: string, dx: number, dy: number) => void} dropSheet 離したとき
 * @property {(id:string,dx:number,dy:number)=>void} dragGraph
 * @property {(id:string,dx:number,dy:number)=>void} dropGraph
 * @property {(id:string)=>void} openGraph
 * @property {(sourceKind:'graph'|'session',sourceId:string,targetKind:'graph'|'session',targetId:string)=>void} connectGraph
 * @property {(sourceKind:'graph'|'session',sourceId:string,targetKind:'graph'|'session'|null,targetId:string|null)=>void} graphConnectHover
 * @property {(head: HTMLElement) => void} focusHead 動かさずに押しただけのとき
 */

/** ドラッグを始めない部品 (押せるもの)。見出しは別に扱う。 */
const CONTROLS = 'button:not(.sheet__head):not(.graph-node), a, input, summary, select, textarea, label';

/**
 * 表示枠にポインタ・ホイール・タッチを付ける。机か用紙の空いた所をドラッグ → 動かす、見出しのドラッグ → 用紙を動かす、
 * Ctrl/⌘ + ホイール・トラックパッドのピンチ → その点で拡大縮小、2 本指 → ピンチ。
 * @param {HTMLElement} viewport
 * @param {CanvasHandlers} handlers
 */
export function bindCanvas(viewport, handlers) {
  /** @type {Map<number, {x: number, y: number}>} */
  const pts = new Map();
  /** @type {null|{kind: 'pan'|'head'|'graph'|'connect', id: number, x: number, y: number, head?: HTMLElement, key?: string, endpointKind?: 'graph'|'session', moved: boolean}} */
  let drag = null;
  let suppressConnectClick = false;
  /** @type {null|{dist: number}} */
  let pinch = null;
  const local = (/** @type {{clientX: number, clientY: number}} */ ev) => {
    const r = viewport.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const pair = () => {
    const [a, b] = [...pts.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };
  viewport.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    const el = ev.target instanceof Element ? ev.target : null;
    pts.set(ev.pointerId, local(ev));
    if (pts.size === 2) {
      // 2 本目の指: ドラッグをやめてピンチにする
      drag = null;
      pinch = { dist: pair().dist };
      return;
    }
    const connectHandle = /** @type {HTMLElement|null} */ (el?.closest('.graph-connect-handle[data-id], .canvas-connect-handle[data-id]') ?? null);
    const head = /** @type {HTMLElement|null} */ (el?.closest('.sheet__head') ?? null);
    const graph = /** @type {HTMLElement|null} */ (el?.closest('.graph-node') ?? null);
    if (!connectHandle && !head && el?.closest(CONTROLS)) return;
    drag = { kind: connectHandle ? 'connect' : head ? 'head' : graph ? 'graph' : 'pan', id: ev.pointerId, x: ev.clientX, y: ev.clientY, head: head ?? undefined, key: connectHandle?.dataset.id ?? head?.dataset.key ?? graph?.dataset.id, endpointKind: connectHandle ? (connectHandle.dataset.endpoint === 'session' ? 'session' : 'graph') : undefined, moved: false };
    viewport.setPointerCapture?.(ev.pointerId);
    if (!head) viewport.classList.add('is-panning');
  });
  viewport.addEventListener('pointermove', (ev) => {
    if (!pts.has(ev.pointerId)) return;
    const prev = /** @type {{x: number, y: number}} */ (pts.get(ev.pointerId));
    const now = local(ev);
    pts.set(ev.pointerId, now);
    if (pinch && pts.size === 2) {
      const p = pair();
      if (pinch.dist > 0 && p.dist > 0) handlers.zoomBy(p.dist / pinch.dist, p.mid.x, p.mid.y);
      pinch.dist = p.dist;
      return;
    }
    if (!drag || drag.id !== ev.pointerId) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) <= CANVAS.DRAG_SLOP) return;
    drag.moved = true;
    if (drag.kind === 'pan') handlers.pan(now.x - prev.x, now.y - prev.y);
    else if (drag.kind === 'head' && drag.key) handlers.dragSheet(drag.key, dx, dy);
    else if (drag.kind === 'graph' && drag.key) handlers.dragGraph(drag.key, dx, dy);
    else if (drag.kind === 'connect' && drag.key) {
      viewport.classList.add('is-connecting');
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = under instanceof Element ? under.closest('.graph-node[data-id], .slip:not(.is-faded)[data-id]') : null;
      const targetId = target instanceof HTMLElement ? target.dataset.id ?? null : null;
      const targetKind = target?.matches('.slip') ? 'session' : targetId ? 'graph' : null;
      handlers.graphConnectHover(drag.endpointKind ?? 'graph', drag.key, targetKind, targetId);
    }
  });
  const end = (/** @type {PointerEvent} */ ev) => {
    pts.delete(ev.pointerId);
    if (pts.size < 2) pinch = null;
    if (!drag || drag.id !== ev.pointerId) return;
    const d = drag;
    drag = null;
    viewport.classList.remove('is-panning');
    viewport.classList.remove('is-connecting');
    if (d.kind === 'connect' && d.key) {
      handlers.graphConnectHover(d.endpointKind ?? 'graph', d.key, null, null);
      if (d.moved && ev.type === 'pointerup') {
        suppressConnectClick = true;
        setTimeout(() => { suppressConnectClick = false; }, 0);
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const target = under instanceof Element ? under.closest('.graph-node[data-id], .slip:not(.is-faded)[data-id]') : null;
        const targetId = target instanceof HTMLElement ? target.dataset.id ?? null : null;
        const targetKind = target?.matches('.slip') ? 'session' : targetId ? 'graph' : null;
        const connection = graphConnectionDrop(d.key, targetId, d.endpointKind, targetKind);
        if (connection) handlers.connectGraph(connection.sourceKind, connection.sourceId, connection.targetKind, connection.targetId);
      }
      return;
    }
    if (d.kind === 'graph' && d.key) {
      if (d.moved) handlers.dropGraph(d.key, ev.clientX - d.x, ev.clientY - d.y);
      else handlers.openGraph(d.key);
      return;
    }
    if (d.kind !== 'head' || !d.key || !d.head) return;
    if (d.moved && ev.type === 'pointerup') handlers.dropSheet(d.key, ev.clientX - d.x, ev.clientY - d.y);
    else if (d.moved) handlers.dropSheet(d.key, 0, 0);
    else handlers.focusHead(d.head);
  };
  viewport.addEventListener('pointerup', end);
  viewport.addEventListener('pointercancel', end);
  viewport.addEventListener('click', (ev) => {
    if (!suppressConnectClick) return;
    suppressConnectClick = false;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
  viewport.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const p = local(ev);
      // 行単位・ページ単位のホイールを px にそろえる
      const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? viewport.clientHeight : 1;
      if (ev.ctrlKey || ev.metaKey) return handlers.zoomBy(Math.exp((-ev.deltaY * unit) / 300), p.x, p.y);
      if (ev.shiftKey && !ev.deltaX) return handlers.pan(-ev.deltaY * unit, 0);
      handlers.pan(-ev.deltaX * unit, -ev.deltaY * unit);
    },
    { passive: false },
  );
}
