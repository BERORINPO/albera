// @ts-check
// 画面: キャンバスのカメラの計算 (spec/ui.md §10.6、純粋)。DOM も保存も時計も触らない。
// Camera = {x, y, z}: 表示枠の左上に来る world の点と縮尺。画面の点 = (world − カメラ) × z。
// カメラの動きはいつも一瞬 (design.md §7: 動きの型を 4 つ目に増やさない)。

import { CANVAS } from '../src/shared/constants.mjs';

/** @typedef {{x: number, y: number, z: number}} Camera */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */

const EPS = 1e-6;

/**
 * 近くの段階の下限。広い表示枠は LEVEL_NEAR (100%)。狭い表示枠は開いたときの倍率 (付箋が幅いっぱい) と 100% の小さいほう:
 * 400px の欄は 87% で開くので、そこからが近く。付箋の高さもこの倍率の文字で測る (canvas-fit.mjs)。
 * @param {number} vw 表示枠の幅
 */
export const nearZ = (vw) => (isNarrow(vw) ? Math.min(CANVAS.LEVEL_NEAR, Math.max(CANVAS.Z_MIN, (vw - 2 * CANVAS.PAD_NARROW) / CANVAS.SLIP_W)) : CANVAS.LEVEL_NEAR);

/**
 * 縮尺の段階: 遠く (印だけ)・中くらい・近く (全部)。狭い表示枠 (縦 1 列、開いた倍率で読む) に中くらいは無い:
 * 付箋の高さは近くの中身で測るので、中くらいは空いたセルにタイトルだけになった。近くより小さければそのまま遠く (見渡し)。
 * @param {number} z @param {number} [vw] 表示枠の幅 (省けば広い表示枠) @returns {'far'|'mid'|'near'}
 */
export function levelOf(z, vw = Infinity) {
  const near = nearZ(vw) - EPS;
  if (isNarrow(vw)) return z >= near ? 'near' : 'far';
  if (!(z >= CANVAS.LEVEL_MID)) return 'far';
  return z < near ? 'mid' : 'near';
}

/** 縮尺を Z_MIN … Z_MAX に収める (数でなければ 100%)。 @param {number} z */
export function clampZ(z) {
  if (!Number.isFinite(z)) return 1;
  return Math.max(CANVAS.Z_MIN, Math.min(CANVAS.Z_MAX, z));
}

/**
 * 次の段階の縮尺 (Z_STEPS)。段階の間にいるときは、その向きで一番近い段階へ。端では端のまま。
 * 狭い表示枠では FIT_MIN と近くの下限 (nearZ) の間の段階を飛ばし、nearZ を段階に入れる: 中くらいが無いので、
 * その間は大きな空の付箋に印が 1 つずつ載るだけになる (近くから「−」で一気に見渡しへ)。FIT_MIN より下も無い (minZoom)。
 * @param {number} z @param {1|-1} dir @param {number} [vw] 表示枠の幅
 */
export function stepZoom(z, dir, vw = Infinity) {
  const near = nearZ(vw);
  const steps = isNarrow(vw) ? [...CANVAS.Z_STEPS.filter((s) => Math.abs(s - FIT_MIN) < EPS || s >= near - EPS), near].sort((a, b) => a - b) : CANVAS.Z_STEPS;
  const cur = clampZ(z);
  if (dir > 0) return steps.find((s) => s > cur + EPS) ?? steps[steps.length - 1];
  return [...steps].reverse().find((s) => s < cur - EPS) ?? steps[0];
}

/** 画面の点 → world の点。 @param {Camera} cam @param {number} sx @param {number} sy */
export const toWorld = (cam, sx, sy) => ({ x: cam.x + sx / cam.z, y: cam.y + sy / cam.z });

/** world の点 → 画面の点 (表示枠の左上から)。 @param {Camera} cam @param {number} wx @param {number} wy */
export const toScreen = (cam, wx, wy) => ({ x: (wx - cam.x) * cam.z, y: (wy - cam.y) * cam.z });

/**
 * いちばん小さい縮尺。狭い表示枠は FIT_MIN (30%): 縦 1 列ではそれより小さいと、用紙の間 (GAP_Y) に見出しが入らず上の用紙の罫線に重なる。
 * @param {number} [vw] 表示枠の幅
 */
export const minZoom = (vw = Infinity) => (isNarrow(vw) ? FIT_MIN : CANVAS.Z_MIN);

/**
 * 画面の点 (px, py) の下にある world の点を動かさずに、縮尺を z2 にする (zMin〜Z_MAX)。
 * @param {Camera} cam @param {number} z2 @param {number} px @param {number} py @param {number} [zMin]
 * @returns {Camera}
 */
export function zoomAt(cam, z2, px, py, zMin = CANVAS.Z_MIN) {
  const z = Math.max(zMin, clampZ(z2));
  const w = toWorld(cam, px, py);
  return { x: w.x - px / z, y: w.y - py / z, z };
}

/** 狭い表示枠 (Claude の横の欄)。ここでは「収める」は幅だけ (縦は動かして読む)。 @param {number} vw */
export const isNarrow = (vw) => !(vw >= CANVAS.NARROW_PX);

/** 「全体を表示」の高さの下限: 高さに合わせても、これより小さくしない (遠くの段階で用紙の名前と印が読める見渡し。それより長い机は上をそろえ、残りは動かして読む) */
export const FIT_MIN = 0.3;

/**
 * 四角 (world) が表示枠に収まる縮尺 (100% まで)。高さに合わせても minH より小さくしない (幅にはいつも合わせる)。
 * @param {Rect} rect @param {number} vw @param {number} vh @param {number} pad @param {number} [minH] Infinity なら幅だけで決める
 */
function fitZ(rect, vw, vh, pad, minH = 0) {
  const availW = Math.max(1, vw - 2 * pad);
  const availH = Math.max(1, vh - 2 * pad - CANVAS.HEAD_ROOM);
  const w = Math.max(1, Number(rect?.w) || 0);
  const h = Math.max(1, Number(rect?.h) || 0);
  return Math.min(1, availW / w, Math.max(minH, availH / h));
}

/**
 * 全体を表示: rect (world) が表示枠に収まる縮尺 (100% まで)。上に HEAD_ROOM (柱の見出しの分、画面の px) を空け、横は真ん中。
 * 高さに合わせても FIT_MIN より小さくしない (どの幅でも。それより長い机は上をそろえ、残りは動かして読む)。
 * @param {Rect} rect @param {number} vw @param {number} vh @param {number} pad
 * @returns {Camera}
 */
export function fitRect(rect, vw, vh, pad) {
  const w = Math.max(1, Number(rect?.w) || 0);
  const z = clampZ(fitZ(rect, vw, vh, pad, FIT_MIN));
  const left = (vw - w * z) / 2;
  return { x: (Number(rect?.x) || 0) - left / z, y: (Number(rect?.y) || 0) - (pad + CANVAS.HEAD_ROOM) / z, z };
}

/** 席を作るときの列数の上限: 開いたときの縮尺 (Z_OPEN) で紙 1 枚が表示枠の幅に収まる列数。狭い表示枠は 1 列。 @param {number} vw */
export function colsCap(vw) {
  if (isNarrow(vw)) return 1;
  return Math.max(1, Math.min(CANVAS.COLS_MAX, Math.floor((vw - 2 * CANVAS.PAD_WIDE) / (CANVAS.SLIP_W * CANVAS.Z_OPEN))));
}

/** @param {Rect[]} rects @returns {Rect} */
function union(rects) {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

/**
 * 開いたときのカメラ: 急ぐ用紙 (返事待ち・止まったかも・未読・作業中のある紙) を収める縮尺を Z_OPEN〜100% に収め、その左上 (見出し込み) を
 * 余白の位置に (横も縦も上と左にそろえる。急ぐ順に並べた机の左上から読む)。lede のセッションが外にあれば、見えるだけ動かす。
 * 急ぐ用紙が無ければ全体を表示。
 * @param {{sheets: Array<Rect & {quiet?: boolean, slips: Array<{id: string, x: number, y: number, h?: number}>}>, bounds: Rect}} layout
 * @param {string|null} nextId @param {number} vw @param {number} vh @param {number} pad
 * @returns {Camera}
 */
export function openCamera(layout, nextId, vw, vh, pad) {
  const sheets = layout?.sheets ?? [];
  const act = sheets.filter((s) => !s.quiet);
  if (!act.length) return sheets.length || (layout?.bounds?.w ?? 0) > 0 ? fitRect(layout.bounds, vw, vh, pad) : { x: 0, y: 0, z: 1 };
  const r = union(act);
  // 狭い表示枠は幅だけで決める (縦は動かして読む)
  const z = clampZ(Math.max(CANVAS.Z_OPEN, fitZ(r, vw, vh, pad, isNarrow(vw) ? Infinity : 0)));
  const cam = { x: r.x - pad / z, y: r.y - (pad + CANVAS.HEAD_ROOM) / z, z };
  const s = nextId ? act.find((x) => x.slips.some((sl) => sl.id === nextId)) : null;
  const sl = s?.slips.find((x) => x.id === nextId);
  if (!s || !sl) return cam;
  return revealRect(cam, { x: s.x + sl.x, y: s.y + sl.y, w: CANVAS.SLIP_W, h: sl.h ?? CANVAS.SLIP_H }, vw, vh, CANVAS.REVEAL_MARGIN);
}

/**
 * rect (world) が見えるように、いちばん少なく動かす (縮尺はそのまま)。上は貼り付いた見出しの分 (HEAD_ROOM) も空ける。
 * もう見えていれば同じカメラを返す。表示枠より大きければ左上をそろえる。
 * @param {Camera} cam @param {Rect} rect @param {number} vw @param {number} vh @param {number} margin
 * @returns {Camera}
 */
export function revealRect(cam, rect, vw, vh, margin) {
  const z = cam.z;
  const s = toScreen(cam, rect.x, rect.y);
  const w = rect.w * z;
  const h = rect.h * z;
  const top = margin + CANVAS.HEAD_ROOM;
  /** @param {number} start @param {number} size @param {number} lo @param {number} hi 画面の px で動かす量 */
  const shift = (start, size, lo, hi) => {
    if (size > hi - lo || start < lo) return lo - start;
    if (start + size > hi) return hi - (start + size);
    return 0;
  };
  const dx = shift(s.x, w, margin, vw - margin);
  const dy = shift(s.y, h, top, vh - margin);
  if (dx === 0 && dy === 0) return cam;
  return { x: cam.x - dx / z, y: cam.y - dy / z, z };
}

// 見出しの箱の CSS (canvas.css) と同じ値: 用紙の上の罫線との間 (bottom: calc(100% + 2px * --k)) と、貼り付いたときに増える高さ
// (padding-top 4px と下の罫線 1px、どちらも × --k)。高さは貼り付けを外して測るので、貼り付けの位置はここで足す
const HEAD_LIFT = 2;
const PIN_EXTRA = 5;
const PIN_OVER = 2;
/** 貼り付いた見出しの下に用紙がこれ (画面の px) より少ししか残らなくなったら、用紙ごと見せない (下の二重線や帯の切れ端を出さない) */
export const LEAVE_PX = 20;

/**
 * 柱 (用紙の見出し) を表示枠の上に貼り付ける量 (純粋)。見出しが表示枠の上で切れる (用紙の上の罫線が見出しの高さより上に来た) ときから、
 * 用紙がまだ見えている間だけ貼り付く (罫線が表示枠の中でも、見出しが切れるなら貼り付ける: 見出しの無い用紙や、見出しの下の端の切れ端を見せない。
 * 貼り付いた見出しは下に罫線を持つので、その下に隠れる付箋は「下へ流れた」と読める)。貼り付いた見出しはいつも全部見える (上へ半分抜けない)。
 * 見出しの下に用紙が LEAVE_PX より少ししか残らなくなったら leaving: 用紙ごと見せない (見出しの切れ端も、用紙の下の切れ端も出さない)。
 * @param {number} top 用紙の上の罫線の画面の y (px、表示枠の上から)
 * @param {number} h 用紙の高さ (world) @param {number} head 見出しの箱の高さ (world、貼り付けを外して測った値) @param {number} z
 * @returns {{pinY: number, leaving: boolean}} pinY = 箱を下へずらす量 (world、0 = 貼り付けない)
 */
export function headPin(top, h, head, z) {
  const k = 1 / Math.min(z, 1);
  const bottom = top + h * z;
  if (!(top < (head + HEAD_LIFT * k) * z && bottom > 0)) return { pinY: 0, leaving: false };
  const box = (head + PIN_EXTRA * k) * z;
  if (bottom - box < LEAVE_PX) return { pinY: 0, leaving: true };
  // 箱の上端は表示枠の上端より PIN_OVER px 上 (測った高さは整数に丸められる: 下の付箋や罫線が 1px のぞかない)
  return { pinY: Math.max(0, (box - top) / z + HEAD_LIFT * k - PIN_OVER / z), leaving: false };
}

/** 画面の px で動かす (ドラッグ・ホイール・矢印)。 @param {Camera} cam @param {number} dx @param {number} dy @returns {Camera} */
export const panBy = (cam, dx, dy) => ({ x: cam.x - dx / cam.z, y: cam.y - dy / cam.z, z: cam.z });

/**
 * 表示枠の大きさが変わったとき: 真ん中にあった world の点を真ん中に保つ。
 * @param {Camera} cam @param {number} w0 @param {number} h0 @param {number} w1 @param {number} h1
 * @returns {Camera}
 */
export function keepCentre(cam, w0, h0, w1, h1) {
  const c = toWorld(cam, w0 / 2, h0 / 2);
  return { x: c.x - w1 / 2 / cam.z, y: c.y - h1 / 2 / cam.z, z: cam.z };
}
