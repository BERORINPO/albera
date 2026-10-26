// @ts-check
// 画面: キャンバスの状態 (cv) とカメラの操作 (spec/ui.md §10.6)。動かす・拡大縮小・全体・追う・表示枠の大きさの変化・
// フォーカスを戻すときにカメラを動かさない印。計算は canvas-camera.mjs (純粋)、world への適用は canvas.mjs の applyCamera。
// canvas-ctl.mjs が全部を再び export する (400 行の上限のため分けた)。カメラの動きはいつも一瞬 (design.md §7)。

import { CANVAS } from '../src/shared/constants.mjs';
import { fitRect, keepCentre, minZoom, openCamera, revealRect, toScreen, zoomAt } from './canvas-camera.mjs';
import { applyCamera, slipRect } from './canvas.mjs';
import { view } from './render.mjs';
import { state } from './state.mjs';
import { nextUp } from './ui-state.mjs';
import { loadGraph } from './graph-store.mjs';
import { loadCameraView, saveCameraView } from './canvas-camera-store.mjs';
import { sessionRect } from './session-position.mjs';

/** @typedef {import('./canvas-camera.mjs').Camera} Camera */
/** @typedef {import('./canvas-layout.mjs').Layout} Layout */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** これより狭い表示枠 (Claude の横の欄) では、用紙を 1 列にして縦 1 列に並べ、カメラの余白を狭くし、「全体」は幅に合わせる */
export const NARROW_PX = CANVAS.NARROW_PX;

/** キャンバスの状態 (席と視点はlocalStorage。視点は数値だけ)。 */
export const cv = {
  /** @type {Camera} */ cam: { x: 0, y: 0, z: CANVAS.Z_OPEN },
  /** @type {Camera|null} z で戻る先 (全体を表示する前のカメラ) */ before: null,
  /** 今のカメラが「全体を表示」のままか (動かしたら false。表示枠の大きさが変わっただけなら保つ) */ atFit: false,
  /** 開いたときのカメラのまま (まだ動かしていない) */ untouched: false,
  /** @type {Layout|null} */ layout: null,
  /** @type {any} */ seats: undefined,
  /** 今の席が狭い表示枠のものか (幅が NARROW_PX を越えたら、その幅の席を読み直す) */ narrow: false,
  /** @type {import('./canvas-bar.mjs').BarState|null} */ bar: null,
  /** 次に描くとき、開いたときのカメラにする */ fresh: true,
  /** 初回カメラ復元後にだけ永続化を許可する (起動時のfocusinが保存値を消さないようにする) */ cameraReady: false,
  /** 開くときに全体を表示する (一覧の z) */ fitOnOpen: false,
  /** 次に描くとき、席を捨てて並べ直す */ repack: false,
  /** @type {string[]} */ order: [],
  /** @type {Set<string>|null} 絞り込みに合う ID (null = 絞り込みなし。描くたびに作り直す) */ matched: null,
  /** @type {{key: string, x: number, y: number}|null} ドラッグ中の用紙と今の位置 (描き直しても席へ戻さない) */ drag: null,
  /** @type {{id:string,x:number,y:number}|null} ドラッグ中のユーザー作成カード */ graphDrag: null,
  /** @type {Record<string,{x:number,y:number}>|undefined} ブラウザー内のセッションカード配置 */ sessionPositions: undefined,
  /** @type {{id:string,x:number,y:number,startX:number,startY:number}|null} ドラッグ中のセッションカード */ sessionDrag: null,
  /** relation picker source while the user chooses a graph-card target */ graphConnectFrom: null,
  /** 描き直しのあとにプログラムがフォーカスを戻している間 (focusin でカメラもカーソルも動かさない) */ quiet: false,
  size: { w: 0, h: 0 },
};

export const isCanvas = () => state.view === 'canvas';
/** 用紙の柱 (見出しのボタン)。 @param {string} key */
export const headOf = (key) => /** @type {HTMLElement|null} */ (document.querySelector(`#cv-world .sheet__head[data-key="${CSS.escape(key)}"]`));
export const viewport = () => $('cv-view');
export const world = () => $('cv-world');
export const size = () => ({ w: viewport().clientWidth || window.innerWidth, h: viewport().clientHeight || window.innerHeight });
export const pad = () => (size().w < NARROW_PX ? CANVAS.PAD_NARROW : CANVAS.PAD_WIDE);
/** 絞り込みに合うか。 @param {string} id */
export const ok = (id) => !cv.matched || cv.matched.has(id);

let raf = 0;
/** カメラを当てる (ポインタの動きは 1 フレームに 1 回)。 @param {boolean} [now] */
export function apply(now = false) {
  const run = () => {
    raf = 0;
    applyCamera(world(), viewport(), cv.cam);
    const pct = $('cv-zoom');
    if (pct) pct.textContent = state.t('canvas.zoom', { n: Math.round(cv.cam.z * 100) });
  };
  if (now || typeof requestAnimationFrame === 'undefined') {
    if (raf) cancelAnimationFrame(raf);
    return run();
  }
  if (!raf) raf = requestAnimationFrame(run);
}

/** 手でカメラを動かした (全体表示でも、開いたままでもなくなる)。 @param {Camera} cam */
export function moveCam(cam) {
  cv.cam = cam;
  cv.atFit = false;
  cv.untouched = false;
  if (cv.cameraReady) saveCameraView(false, cam, cv.narrow);
}

/**
 * 表示枠の大きさが変わった: 全体を表示中なら表示し直し、開いたままのカメラなら開き直し、動かした後なら真ん中を保つ。
 * 高さだけが変わったとき (下の帯の行が増えた・減った: 狭い画面の遠くの凡例など) は、動かした後のカメラはそのまま
 * (上をそろえたまま、下が隠れる・現れるだけ。用紙が上下に跳ねない)。
 * @param {{w: number, h: number}} sz
 */
export function resized(sz) {
  const was = cv.size;
  cv.size = sz;
  if (!was.w || !sz.w || (was.w === sz.w && was.h === sz.h) || !cv.layout) return false;
  const crossingWidthClass = (sz.w < NARROW_PX) !== cv.narrow;
  if (cv.atFit) cv.cam = fitCam();
  else if (cv.untouched) cv.cam = openCamera(cv.layout, nextUp(state.board)?.card.id ?? null, sz.w, sz.h, pad());
  else if (was.w !== sz.w) cv.cam = keepCentre(cv.cam, was.w, was.h, sz.w, sz.h);
  if (cv.cameraReady && !cv.untouched && !crossingWidthClass) saveCameraView(cv.atFit, cv.cam, cv.narrow);
  return true;
}

/** 付箋が見えるように少しだけ動かす (縮尺はそのまま)。 @param {string} id @param {boolean} [applyNow] */
export function reveal(id, applyNow = true) {
  const r = slipRect(cv.layout, id);
  if (!r) return;
  const { w, h } = size();
  const next = revealRect(cv.cam, r, w, h, CANVAS.REVEAL_MARGIN);
  if (next === cv.cam) return;
  moveCam(next);
  if (applyNow) apply(true);
}

/**
 * 部品 (柱・片付けの帯の見出し) が表示枠に収まっていなければ、収まるだけ動かす (縮尺はそのまま)。
 * 上と左にあるとブラウザのスクロールでは見えないので、ここで動かす (WCAG 2.4.7 / 2.4.11)。
 * @param {Element|null} el
 */
export function revealEl(el) {
  if (!el) return;
  const vp = viewport().getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return;
  if (r.left >= vp.left && r.top >= vp.top && r.right <= vp.right && r.bottom <= vp.bottom) return;
  const z = cv.cam.z;
  const rect = { x: cv.cam.x + (r.left - vp.left) / z, y: cv.cam.y + (r.top - vp.top) / z, w: r.width / z, h: r.height / z };
  const next = revealRect(cv.cam, rect, vp.width, vp.height, CANVAS.REVEAL_MARGIN);
  if (next === cv.cam) return;
  moveCam(next);
  apply(true);
}

/** プログラムがフォーカスを戻す (描き直しで作り直した・動かした部品へ)。カメラもカーソルも動かさない。 @param {HTMLElement} el */
export function quietFocus(el) {
  cv.quiet = true;
  try {
    el.focus({ preventScroll: true });
  } finally {
    cv.quiet = false;
  }
}

/** 全体を表示するカメラ (絞り込み中は合う付箋のある用紙だけ。そうでなければ片付けだけのまとめも)。 */
export function fitCam() {
  const { w, h } = size();
  const filtering = !!view.visible?.filtering;
  const sheets = (cv.layout?.sheets ?? []).filter((s) => !filtering || s.slips.some((sl) => ok(sl.id)));
  /** @type {Array<{x: number, y: number, w: number, h: number}>} */
  const list = [...(sheets.length ? sheets : cv.layout?.sheets ?? [])];
  if (!filtering && cv.layout?.fold) list.push(cv.layout.fold);
  const query = state.filter.trim().toLocaleLowerCase();
  for (const node of loadGraph().nodes) {
    const text = [node.title, node.body, node.kind, node.status, node.checkedPerson, node.missingEvidence, node.neededExplanation].join(' ').toLocaleLowerCase();
    if (!filtering || text.includes(query)) list.push({ x: node.x, y: node.y, w: 280, h: 168 });
  }
  for (const [id, pos] of Object.entries(cv.sessionPositions ?? {})) {
    const rect = sessionRect(cv.layout, id, { [id]: pos });
    if (rect && (!filtering || ok(id))) list.push(rect);
  }
  if (!list.length) return { x: 0, y: 0, z: 1 };
  const x = Math.min(...list.map((s) => s.x));
  const y = Math.min(...list.map((s) => s.y));
  const rect = { x, y, w: Math.max(...list.map((s) => s.x + s.w)) - x, h: Math.max(...list.map((s) => s.y + s.h)) - y };
  return fitRect(rect, w, h, pad());
}

export function fitAll() {
  cv.before = cv.cam;
  cv.cam = fitCam();
  cv.atFit = true;
  cv.untouched = false;
  if (cv.cameraReady) saveCameraView(true, cv.cam, cv.narrow);
  apply(true);
}

/** z: 全体 ⇄ その前のカメラ。 */
export function fitToggle() {
  if (!cv.atFit) return fitAll();
  cv.atFit = false;
  cv.untouched = false;
  const { w, h } = size();
  cv.cam = cv.before ?? openCamera(/** @type {Layout} */ (cv.layout), nextUp(state.board)?.card.id ?? null, w, h, pad());
  if (cv.cameraReady) saveCameraView(false, cv.cam, cv.narrow);
  apply(true);
}

/** 拡大縮小の中心: カーソルの付箋が画面にあればその真ん中 (id 付き)、無ければ表示枠の真ん中。 @returns {{x: number, y: number, id?: string}} */
function anchor() {
  const { w, h } = size();
  const r = state.cursor ? slipRect(cv.layout, state.cursor.id) : null;
  if (r && state.cursor) {
    const p = toScreen(cv.cam, r.x + r.w / 2, r.y + r.h / 2);
    if (p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h) return { ...p, id: state.cursor.id };
  }
  return { x: w / 2, y: h / 2 };
}

/** カーソルの付箋の周りで拡大縮小し、その付箋が表示枠の端で切れたら全部見えるだけ動かす (拡大すると付箋が端から出る)。 @param {number} z */
export function zoomTo(z) {
  const a = anchor();
  moveCam(zoomAt(cv.cam, z, a.x, a.y, minZoom(size().w)));
  if (a.id) reveal(a.id, false);
  apply(true);
}

/** 用紙 1 枚が収まるカメラにする (z で前のカメラへ戻れる)。 @param {string} key */
export function fitSheet(key) {
  const s = cv.layout?.sheets.find((x) => x.key === key);
  if (!s) return;
  const { w, h } = size();
  const cam = cv.cam;
  moveCam(fitRect({ x: s.x, y: s.y, w: s.w, h: s.h }, w, h, pad()));
  cv.before = cam;
  apply(true);
}
