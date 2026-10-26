// @ts-check
// 画面: キャンバスの DOM (spec/ui.md §10.3–§10.5)。プロジェクトごとの用紙と付箋を合わせる・貼り付く見出し・カメラの適用・席の保存。
// 配置は canvas-layout.mjs (純粋)、用紙の部品 (柱・線・帯・まとめ) は canvas-sheet.mjs、付箋 1 枚は canvas-slip.mjs、表示枠の下の帯は canvas-bar.mjs。
// 用紙は project key、付箋は session ID で使い回す。縮尺を変えても作り直さない (data-level で CSS が見せ方を変える)。

import { CANVAS, CANVAS_STORAGE_KEY } from '../src/shared/constants.mjs';
import { projectLabel } from './format.mjs';
import { headPin, levelOf } from './canvas-camera.mjs';
import { FOLD_KEY, parseSeats } from './canvas-layout.mjs';
import { backEl, colRules, foldEl, headEl, setVars } from './canvas-sheet.mjs';
import { canvasSig, slipEl, slipFlags } from './canvas-slip.mjs';
import { groupCards } from './ui-state.mjs';
import { fill, h, reconcile } from './view.mjs';
import { renderGraphLayer } from './graph-render.mjs';

export { canvasSig } from './canvas-slip.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {import('./canvas-camera.mjs').Camera} Camera */
/** @typedef {import('./canvas-layout.mjs').Layout} Layout */
/** @typedef {import('./canvas-layout.mjs').SheetLayout} SheetLayout */

const { SLIP_W, SLIP_H } = CANVAS;

// ---------- 席の保存 (この画面の localStorage だけ。読み書きは全部 try/catch) ----------
// 狭い表示枠 (Claude の横の欄) の席は別に持つ: 縦 1 列の並びと広い画面の並びが、互いを上書きしない

/** @param {boolean} narrow */
const seatsKey = (narrow) => (narrow ? `${CANVAS_STORAGE_KEY}:narrow` : CANVAS_STORAGE_KEY);

/** 保存した席の記録 (壊れていれば null = 新しく並べる)。 @param {boolean} [narrow] */
export function loadSeats(narrow = false) {
  try {
    return parseSeats(localStorage.getItem(seatsKey(narrow)));
  } catch {
    return null;
  }
}

/** @param {unknown} doc @param {boolean} [narrow] */
export function saveSeats(doc, narrow = false) {
  try {
    localStorage.setItem(seatsKey(narrow), JSON.stringify(doc));
  } catch {
    // 保存できなくても、この表示の間は今の配置のまま
  }
}

// ---------- 絞り込み ----------

/**
 * 絞り込みに合う ID (純粋)。絞り込み中でなければ null (= 全部合う)。
 * @param {any} visible ui-state の visibleModel の結果
 * @returns {Set<string>|null}
 */
export function matchedIds(visible) {
  if (!visible?.filtering) return null;
  const out = new Set();
  for (const list of Object.values(visible.buckets ?? {})) for (const c of /** @type {any[]} */ (list)) out.add(c.id);
  for (const g of visible.recentGroups ?? []) for (const c of g.items ?? []) out.add(c.id);
  for (const g of visible.cleanupGroups ?? []) for (const c of groupCards(g)) out.add(c.id);
  return out;
}

// ---------- 用紙 ----------

/** 用紙の器 (中身は syncSheet が合わせる)。 @param {SheetLayout} s */
const sheetShell = (s) =>
  h('section', { class: 'sheet', 'data-key': s.key }, zeroed(h('div', { class: 'sheet__headbox' })), h('div', { class: 'sheet__cols' }), h('ol', { class: 'sheet__slips' }), h('div', { class: 'sheet__backbox' }));

/** 見出しの箱は --x / --y を用紙の位置から継がない (貼り付けのずれの量に使う)。 @param {HTMLElement} el */
function zeroed(el) {
  el.style.setProperty('--x', '0');
  el.style.setProperty('--y', '0');
  return el;
}

/** 部品の箱: 署名が変わったときだけ中身を作り直す。 @param {Element} box @param {string} sig @param {() => (Node|null)[]} build */
function part(box, sig, build) {
  const el = /** @type {HTMLElement} */ (box);
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  fill(el, ...build());
}

/**
 * @typedef {Object} CanvasCtx
 * @property {T} t
 * @property {any} board
 * @property {Layout} layout
 * @property {Map<string, {card: any, pile: string}>} index
 * @property {Set<string>|null} matched  null = 絞り込みなし
 * @property {string|null} cursorId
 * @property {string|null} nextId
 * @property {number} now
 * @property {boolean} demo
 * @property {any} [graph]
 * @property {{id:string,x:number,y:number}|null} [graphDrag]
 * @property {Record<string, any>} handoff  prefs.handoff
 * @property {(pile: string, id: string) => boolean} isNew
 * @property {(pile: string, id: string) => boolean} takeArrival
 * @property {{key: string, x: number, y: number}|null} [drag]  ドラッグ中の用紙の位置 (描き直しても席へ戻さない)
 */

/** @param {HTMLElement} el @param {SheetLayout} s @param {CanvasCtx} o */
function syncSheet(el, s, o) {
  const t = o.t;
  const [headBox, cols, ol, backBox] = /** @type {HTMLElement[]} */ ([...el.children]);
  const at0 = o.drag && o.drag.key === s.key ? o.drag : s;
  setVars(el, { '--x': at0.x, '--y': at0.y, '--w': s.w, '--h': s.h });
  setVars(ol, { '--h': s.liveH });
  el.classList.toggle('is-quiet', s.quiet);
  el.classList.toggle('is-empty', !s.slips.length);
  part(headBox, `${t.lang}|${s.label}|${s.project?.extra}|${JSON.stringify(s.counts)}`, () => [headEl(t, s)]);
  part(cols, `${s.cols}|${s.liveH}`, () => colRules(s));
  ol.setAttribute('aria-label', projectLabel(t, s.project));
  const slips = s.slips.filter((sl) => o.index.has(sl.id));
  reconcile(
    ol,
    slips,
    (sl) => sl.id,
    (sl) => canvasSig(t.lang, o.index.get(sl.id)?.card, slipFlags(o.index.get(sl.id)?.card, sl, o)),
    (sl) => slipEl(t, o.index.get(sl.id)?.card, sl, o),
  );
  const at = new Map(slips.map((sl) => [sl.id, sl]));
  /** @type {HTMLElement|null} */
  let first = null;
  /** @type {HTMLElement|null} */
  let cur = null;
  for (const li of /** @type {HTMLElement[]} */ ([...ol.children])) {
    const sl = at.get(li.dataset.key ?? '');
    if (!sl) continue;
    setVars(li, { '--x': sl.x, '--y': sl.y, '--w': SLIP_W, '--h': sl.h });
    const ok = !o.matched || o.matched.has(sl.id);
    li.classList.toggle('is-top', sl.row === 0);
    li.classList.toggle('is-cursor', sl.id === o.cursorId);
    li.classList.toggle('is-dim', !ok);
    const btn = /** @type {HTMLElement} */ (li.querySelector('.slip__title'));
    btn.tabIndex = -1;
    // 絞り込みに合わない付箋: 見た目だけでなく名前にも「絞り込み外」を足す (読み上げでも合うものと分かる)
    const off = btn.querySelector('.slip__nomatch');
    if (!ok && !off) btn.append(h('span', { class: 'vh slip__nomatch', text: `${t('sep.list')}${t('canvas.noMatch')}` }));
    else if (ok && off) off.remove();
    if (!ok) continue;
    first ??= btn;
    if (sl.id === o.cursorId) cur = btn;
  }
  // 用紙ごとに tab の止まる付箋は 1 つ (カーソルの付箋、無ければ最初の合う付箋)。合わない付箋は tab の順から外す
  const stop = cur ?? first;
  if (stop) stop.tabIndex = 0;
  el.classList.toggle('is-nomatch', !!o.matched && !first);
  part(backBox, `${t.lang}|${s.h}|${s.liveH}|${s.counts.recent}|${s.counts.cleanup}`, () => [backEl(t, s)]);
}

/**
 * キャンバスを描く (world の中の用紙と付箋)。DOM の順 = 読む順 (用紙ごと)。
 * @param {HTMLElement} root #canvas @param {CanvasCtx} o
 */
export function renderCanvas(root, o) {
  const world = /** @type {HTMLElement} */ (root.querySelector('#cv-world'));
  const fold = o.layout.fold;
  // まとめは最後 (DOM の順 = tab の順: 用紙のあと、帯の前)。署名が変わったときだけ作り直す
  const items = fold ? [...o.layout.sheets, fold] : [...o.layout.sheets];
  items.push({ key: 'graph-layer' });
  const foldSig = fold ? `${o.t.lang}|${JSON.stringify(fold.items)}` : '';
  reconcile(world, items, (s) => s.key, (s) => (s === fold ? foldSig : s.key), (s) => (s === fold ? foldEl(o.t, fold) : s.key === 'graph-layer' ? h('div', { class: 'graph-layer', 'data-key': 'graph-layer' }) : sheetShell(/** @type {SheetLayout} */ (s))));
  const byKey = new Map(o.layout.sheets.map((s) => [s.key, s]));
  for (const el of /** @type {HTMLElement[]} */ ([...world.children])) {
    const s = byKey.get(el.dataset.key ?? '');
    if (s) syncSheet(el, s, o);
    else if (fold && el.dataset.key === FOLD_KEY) setVars(el, { '--x': fold.x, '--y': fold.y, '--w': fold.w, '--h': fold.h });
    else if (el.dataset.key === 'graph-layer') renderGraphLayer(el, { t: o.t, graph: o.graph ?? { nodes: [], edges: [] }, index: o.index, layout: o.layout, filter: o.graphFilter ?? '', matched: o.matched, boardReady: !!o.board, drag: o.graphDrag ?? null });
  }
  heads = null;
}


// ---------- カメラ ----------

/** @type {null|Array<{el: HTMLElement, x: number, y: number, w: number, h: number, head: number, headW: number}>} 貼り付く見出しの計算用 (描くたびに測り直す) */
let heads = null;
let headsLevel = '';

/** 見出しの高さ (world の単位) を測る。文字は --k で逆に拡大されるので、段階が変わったら測り直す。 @param {HTMLElement} world @param {string} level */
function measureHeads(world, level) {
  // 貼り付いた見出しは上の余白と下の罫線のぶん高い。貼り付けを外して測る (測る値が貼り付けで変わり、次の描画で見出しが跳ねないように)
  // 片付けだけのまとめの見出しも同じ (表示枠の上で切れた行や見出しの切れ端を見せない)
  const sheets = [...world.children].filter((el) => el.classList.contains('sheet') || el.classList.contains('fold'));
  for (const el of sheets) el.firstElementChild?.classList.remove('is-pinned');
  heads = sheets.map((el) => {
    const sec = /** @type {HTMLElement} */ (el);
    const box = /** @type {HTMLElement|null} */ (sec.firstElementChild);
    const btn = /** @type {HTMLElement|null} */ (box?.querySelector('.sheet__head, .fold__head') ?? null);
    const v = (/** @type {string} */ k) => Number(sec.style.getPropertyValue(k)) || 0;
    return { el: sec, x: v('--x'), y: v('--y'), w: v('--w'), h: v('--h'), head: box?.offsetHeight ?? 0, headW: btn?.offsetWidth ?? 0 };
  });
  headsLevel = level;
}

/**
 * カメラを world に当てる (CSSOM の変数だけ。--tx --ty は継承しない登録済みの変数なので、動かしても中身の計算はやり直さない)。
 * 用紙の上の罫線が表示枠の上より上にある間、その見出しを (下の罫線ごと) 表示枠の上に貼り付ける。用紙の残りが見出しとほぼ同じ高さに
 * なったら、用紙ごと見せない (is-leaving: 見出しの半分や、下の二重線の切れ端が表示枠の上にのぞかない)。罫線が表示枠の中にあれば
 * 貼り付けない (見出しが 1 行目の付箋を隠さない)。左端が表示枠の左より左にある間は、名前を左端に寄せる (見出しの箱の --x / --y は用紙の中でずらす量)。
 * @param {HTMLElement} world @param {HTMLElement} viewport @param {Camera} cam
 */
export function applyCamera(world, viewport, cam) {
  const z = cam.z;
  const level = levelOf(z, viewport.clientWidth);
  world.style.setProperty('--tx', `${Math.round(-cam.x * z * 100) / 100}px`);
  world.style.setProperty('--ty', `${Math.round(-cam.y * z * 100) / 100}px`);
  if (world.style.getPropertyValue('--z') !== String(z)) {
    world.style.setProperty('--z', String(z));
    world.style.setProperty('--k', String(1 / Math.min(z, 1)));
  }
  if (viewport.dataset.level !== level) viewport.dataset.level = level;
  if (!heads || headsLevel !== level) measureHeads(world, level);
  for (const s of /** @type {NonNullable<typeof heads>} */ (heads)) {
    const top = (s.y - cam.y) * z;
    const left = (s.x - cam.x) * z;
    // 貼り付ける量 (canvas-camera.mjs の headPin)。用紙の残りが見出しの高さほどになったら、用紙ごと見せない
    const { pinY, leaving } = headPin(top, s.h, s.head, z);
    s.el.classList.toggle('is-leaving', leaving);
    // sideways: keep the name PAD_NARROW px inside the viewport's left edge (clear of its focus ring)
    const padX = CANVAS.PAD_NARROW;
    const pinX = left < padX && left + s.w * z > padX ? Math.max(0, Math.min((padX - left) / z, s.w - s.headW)) : 0;
    const head = /** @type {HTMLElement|null} */ (s.el.firstElementChild);
    if (!head) continue;
    const vy = String(Math.round(pinY * 10) / 10);
    const vx = String(Math.round(pinX * 10) / 10);
    if (head.style.getPropertyValue('--y') !== vy) head.style.setProperty('--y', vy);
    if (head.style.getPropertyValue('--x') !== vx) head.style.setProperty('--x', vx);
    head.classList.toggle('is-pinned', pinY > 0);
  }
}

/** 付箋の world の四角 (無ければ null)。 @param {Layout|null} layout @param {string} id */
export function slipRect(layout, id) {
  for (const s of layout?.sheets ?? []) {
    const sl = s.slips.find((x) => x.id === id);
    if (sl) return { x: s.x + sl.x, y: s.y + sl.y, w: SLIP_W, h: sl.h ?? SLIP_H };
  }
  return null;
}

/** 付箋の題名へフォーカスする (画面は動かさない。カメラは呼び出し側が合わせる)。用紙の tab の止まる付箋もこれにする。 @param {string} id */
export function focusSlip(id) {
  const btn = /** @type {HTMLElement|null} */ (document.querySelector(`#cv-world .slip[data-id="${CSS.escape(id)}"] .slip__title`));
  if (!btn) return false;
  const ol = btn.closest('ol');
  for (const b of /** @type {HTMLElement[]} */ ([...(ol?.querySelectorAll('.slip__title') ?? [])])) b.tabIndex = b === btn ? 0 : -1;
  btn.focus({ preventScroll: true });
  return true;
}
