// @ts-check
// 画面: キャンバスの机 (spec/ui.md §10.4 の 5〜8・12)。紙を机に並べる・ずらす・席を記録する純粋関数。
// DOM・storage・時計は触らない (node:test からも読める)。入力は書き換えず、新しいものを返す。
// 紙の中身 (マス・帯) は canvas-layout.mjs。画面はここの関数も canvas-layout.mjs から読む (同じものを再び export している)。

import { CANVAS } from '../src/shared/constants.mjs';

/**
 * h = 机の上で取っておく高さ (今まで一番高かったときの紙の高さ。並べ直すまで縮まない: 紙が伸び縮みしても下の紙が上下に跳ねない)。
 * 古い記録には無いことがある (無ければ今の高さ)。
 * @typedef {{x: number, y: number, cols: number, seen: number, h?: number}} Seat
 */
/** @typedef {{v: 3, aspect: number, seats: Record<string, Seat>}} SeatsDoc  localStorage CANVAS_STORAGE_KEY の中身 (v 1・v 2 の記録は捨てて並べ直す: 紙の大きさと並べ方が変わった) */
/** @typedef {{key: string, x: number, y: number, w: number, h: number}} Placed  h は机の上で取る高さ (取っておく高さを含む) */
/** @typedef {{key: string, w: number, h: number, weight: number, cols?: number, rank?: Array<number|string>}} Item  rank = 急ぐ順の鍵 (小さいほど先。canvas-fold.mjs の urgencyRank) */

const { SLIP_W, SLIP_H, FOOT_H, GAP_X, GAP_Y, COLS_MIN, COLS_MAX, SNAP, SEAT_KEEP_MS } = CANVAS;
// 画面の縦横比 (幅 / 高さ)。壊れた値は ASPECT_DEFAULT、極端な値は範囲に収める
const ASPECT_MIN = 0.1;
const ASPECT_MAX = 10;
export const ASPECT_DEFAULT = 1.6;
const WORLD_MAX = 10_000_000; // 席の座標の上限 (壊れた記録で巨大な world を作らない)

/** 文字列を code unit の順で比べる (localeCompare は使わない)。 @param {string} a @param {string} b */
export const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** @param {any} o @param {string} k */
export const hasOwn = (o, k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isPlain = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} a @returns {number} */
export const cleanAspect = (a) => (typeof a === 'number' && Number.isFinite(a) && a > 0 ? Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, a)) : ASPECT_DEFAULT);

/** 2 枚が重なるか (間の GAP_X・GAP_Y も含めて)。 @param {Placed} a @param {Placed} b */
const overlaps = (a, b) => a.x < b.x + b.w + GAP_X && b.x < a.x + a.w + GAP_X && a.y < b.y + b.h + GAP_Y && b.y < a.y + a.h + GAP_Y;
/** 2 枚の紙そのものが重なるか (間は含めない)。 @param {Placed} a @param {Placed} b */
const covers = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 新しい紙を skyline で置くときの幅 W = max(一番広い紙, √(Σ (w + GAP_X)(h + GAP_Y) × aspect))。 @param {Array<{w: number, h: number}>} items @param {number} aspect */
function targetWidth(items, aspect) {
  let widest = 0;
  let area = 0;
  for (const it of items) {
    widest = Math.max(widest, it.w);
    area += (it.w + GAP_X) * (it.h + GAP_Y);
  }
  return Math.max(widest, Math.sqrt(area * aspect));
}

/** skyline の 1 歩: 候補の x ごとに置ける一番上の y。一番低い y、同じなら一番左。 @param {{w: number}} item @param {Placed[]} placed @param {number} W */
function skylineSpot(item, placed, W) {
  const xs = [...new Set([0, ...placed.map((p) => p.x + p.w + GAP_X)])].sort((a, b) => a - b);
  let best = { x: 0, y: Number.POSITIVE_INFINITY };
  for (const x of xs) {
    if (x > 0 && x + item.w > W) continue;
    let y = 0;
    for (const p of placed) if (x < p.x + p.w + GAP_X && p.x < x + item.w + GAP_X) y = Math.max(y, p.y + p.h + GAP_Y);
    if (y < best.y || (y === best.y && x < best.x)) best = { x, y };
  }
  return best;
}

/** 配列の鍵を左から比べる (数は大小、文字列は code unit の順)。 @param {Array<number|string>} a @param {Array<number|string>} b */
export function cmpKey(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined || b[i] === undefined) return a[i] === undefined ? -1 : 1;
    return typeof a[i] === 'string' ? cmpStr(String(a[i]), String(b[i])) : Number(a[i]) - Number(b[i]);
  }
  return 0;
}

/** 並べる順: 急ぐ順 (rank)、同じなら重い順 (weight の大きい順)、最後に key。 @template {Item} I @param {I[]} items @returns {I[]} */
const packOrder = (items) => [...items].sort((a, b) => cmpKey(a.rank ?? [], b.rank ?? []) || b.weight - a.weight || cmpStr(a.key, b.key));

/** @param {number} aspect @param {Array<[string, Seat]>} entries @returns {SeatsDoc} 席は key の順 */
const seatsDoc = (aspect, entries) => ({ v: 3, aspect, seats: Object.fromEntries([...entries].sort((a, b) => cmpStr(a[0], b[0]))) });

/** @param {Item} it */
const colsOf = (it) => it.cols ?? Math.min(COLS_MAX, Math.max(COLS_MIN, Math.round(it.w / SLIP_W)));

/** @param {Item[]} items @param {Placed[]} placed @param {number} now @returns {Array<[string, Seat]>} 取っておく高さ h は placed の h */
function seatsOf(items, placed, now) {
  const cols = new Map(items.map((it) => [it.key, colsOf(it)]));
  return placed.map((p) => [p.key, { x: p.x, y: p.y, cols: cols.get(p.key) ?? COLS_MIN, seen: now, h: p.h }]);
}

/** 席の取っておく高さと今の高さの大きいほう (机の上で取る高さ)。 @param {Seat|null} s @param {number} h */
const keptH = (s, h) => Math.max(h, Number.isFinite(s?.h) ? Number(s?.h) : 0);

/** 席の記録から 1 つ (自分の項目だけ。"__proto__" のような key でも安全)。 @param {SeatsDoc|null} doc @param {string} key @returns {Seat|null} */
export const seatOf = (doc, key) => (doc && hasOwn(doc.seats, key) ? doc.seats[key] : null);

/** 盤面に無いが SEAT_KEEP_MS 以内に見た席 (戻ってきたら同じ場所)。 @param {SeatsDoc|null} doc @param {Set<string>} present @param {number} now */
const keptSeats = (doc, present, now) => Object.entries(doc?.seats ?? {}).filter(([k, s]) => !present.has(k) && now - s.seen < SEAT_KEEP_MS);

/** 段 (棚) に並べる: 左から右へ、幅 W に入らなければ次の段 (段の高さは一番高い紙)。 @param {Item[]} order @param {number} W */
function shelves(order, W) {
  const pos = new Map();
  let [x, y, rowH, w] = [0, 0, 0, 0];
  for (const it of order) {
    if (x > 0 && x + it.w > W) [x, y, rowH] = [0, y + rowH + GAP_Y, 0];
    pos.set(it.key, { x, y });
    w = Math.max(w, x + it.w);
    x += it.w + GAP_X;
    rowH = Math.max(rowH, it.h);
  }
  return { pos, w, h: order.length ? y + rowH : 0 };
}

/**
 * 5. 机に並べる (初回と並べ直し)。急ぐ順に、左から右へ段 (棚) に並べる。段の幅は、全体を表示したときに一番大きく見える幅
 * (候補: 続いて並ぶ紙の幅の合計 (段の切れ目が変わる幅) と √(面積 × 縦横比)。fit = min(縦横比 / 幅, 1 / 高さ) の大きいもの、同じなら狭いほう)。
 * 穴を後ろの紙で埋めないので、読む順 (y, x) が急ぐ順のまま。重なりは無く、段の最初の紙を除いて W の内側。
 * 縦横比が下限 (狭い表示枠の縦 1 列) なら一番広い紙の幅 (縦 1 列)。foot = 紙の下に置く「片付けだけ」のまとめの大きさ (高さに足す)。
 * maxW = 段の幅の上限 (開いたときの縮尺 Z_OPEN で表示枠に収まる幅。768px で 2 枚目の紙が右で切れないように)。一番広い紙より狭くはしない。
 * @param {Item[]} items @param {number} aspect 画面の幅 / 高さ @param {{w: number, h: number}|null} [foot] @param {number} [maxW]
 * @returns {Map<string, {x: number, y: number}>}
 */
export function pack(items, aspect, foot = null, maxW = Infinity) {
  const a = cleanAspect(aspect);
  const order = packOrder(items);
  const widest = order.reduce((m, it) => Math.max(m, it.w), 0);
  if (a <= ASPECT_MIN) return shelves(order, widest).pos;
  const cap = Math.max(widest, Number(maxW) > 0 ? Number(maxW) : Infinity);
  const cands = new Set([targetWidth(items, a)]);
  for (let i = 0; i < order.length; i++) {
    let run = -GAP_X;
    for (let j = i; j < order.length; j++) cands.add((run += GAP_X + order[j].w));
  }
  let best = { pos: new Map(), score: -1, W: Infinity };
  for (const W of [...cands].filter((c) => c >= widest && c <= cap).sort((p, q) => p - q)) {
    const r = shelves(order, W);
    const h = r.h + (foot ? (r.h ? GAP_Y : 0) + foot.h : 0);
    const w = Math.max(r.w, foot?.w ?? 0);
    const score = Math.min(a / Math.max(1, w), 1 / Math.max(1, h));
    if (score > best.score * (1 + 1e-9)) best = { pos: r.pos, score, W };
  }
  return best.pos;
}

/**
 * 並べ直し (と初回): 前の席は全部捨てて pack し、新しい席の記録を作る。
 * @param {Item[]} items @param {number} aspect @param {number} now @param {{w: number, h: number}|null} [foot] pack の foot @param {number} [maxW] pack の maxW
 * @returns {{placed: Placed[], seats: SeatsDoc}}
 */
export function arrange(items, aspect, now, foot = null, maxW = Infinity) {
  const a = cleanAspect(aspect);
  const pos = pack(items, a, foot, maxW);
  const placed = items.map((it) => ({ key: it.key, ...(/** @type {{x: number, y: number}} */ (pos.get(it.key))), w: it.w, h: it.h }));
  return { placed, seats: seatsDoc(a, seatsOf(items, placed, now)) };
}

/**
 * 7. 重なりを真下へずらす ((y, x, key) の順。fixedKey の紙が最初で動かない)。横と上へは動かさない。
 * @param {Placed[]} placed @param {string} [fixedKey]
 * @returns {Placed[]} 入力と同じ順の新しい配列
 */
export function pushDown(placed, fixedKey) {
  const order = placed
    .map((p, i) => ({ key: p.key, x: p.x, y: p.y, w: p.w, h: p.h, i }))
    .sort((a, b) => Number(b.key === fixedKey) - Number(a.key === fixedKey) || a.y - b.y || a.x - b.x || cmpStr(a.key, b.key));
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    for (let moved = true; moved; ) {
      moved = false;
      for (let j = 0; j < i; j++) {
        if (!overlaps(a, order[j])) continue;
        a.y = order[j].y + order[j].h + GAP_Y;
        moved = true;
      }
    }
  }
  return order.sort((a, b) => a.i - b.i).map(({ key, x, y, w, h }) => ({ key, x, y, w, h }));
}

/**
 * 6. 毎回の盤面: 席のある紙は x・y・cols を保ち、新しい紙は (急ぐ順に) 保存した縦横比の W で skyline 1 歩、最後に pushDown。
 * 席のある紙が机の上で取る高さは、今の高さと席の h (今まで一番高かったとき) の大きいほう: 付箋が欄を行き来して紙が伸び縮みしても、
 * 一度伸びた分は並べ直すまで取っておくので、下の紙は 2 度目からは動かない (縮んでも上へは詰めず、穴も増えない)。
 * 盤面にある紙の seen は now、盤面に無い席は SEAT_KEEP_MS まで残す。新しい紙の W は maxW (pack と同じ上限) を超えない。
 * @param {Item[]} items @param {SeatsDoc|null} doc @param {number} now @param {number} [maxW]
 * @returns {{placed: Placed[], seats: SeatsDoc}} placed の h は机の上で取る高さ
 */
export function settle(items, doc, now, maxW = Infinity) {
  const aspect = cleanAspect(doc?.aspect);
  const kept = keptSeats(doc, new Set(items.map((it) => it.key)), now);
  // 戻ってくる紙の場所は、新しい紙に取られないよう 1 行分の紙として避ける (pushDown には入れない)
  const ghosts = kept.map(([key, s]) => ({ key, x: s.x, y: s.y, w: s.cols * SLIP_W, h: SLIP_H + FOOT_H }));
  /** @type {Placed[]} */
  const placed = [];
  const fresh = [];
  for (const it of items) {
    const s = seatOf(doc, it.key);
    if (s) placed.push({ key: it.key, x: s.x, y: s.y, w: it.w, h: keptH(s, it.h) });
    else fresh.push(it);
  }
  const widest = items.reduce((m, it) => Math.max(m, it.w), 0);
  const W = Math.max(widest, Math.min(targetWidth(items, aspect), Number(maxW) > 0 ? Number(maxW) : Infinity));
  for (const it of packOrder(fresh)) {
    const at = skylineSpot(it, [...placed, ...ghosts], W);
    placed.push({ key: it.key, x: at.x, y: at.y, w: it.w, h: it.h });
  }
  const settled = pushDown(placed);
  return { placed: settled, seats: seatsDoc(aspect, [...kept, ...seatsOf(items, settled, now)]) };
}

/**
 * 落とした紙 d が、ほかの紙 a に譲る位置 (純粋)。d が a を上から覆う (紙そのものが重なり、d の上端が a の上端より上か同じ) なら譲らず null
 * (a が pushDown で下へずれる)。それ以外 (余白に入っただけ・a の途中から下に落とした) は、d を a の余白の外へ、動く量の一番少ない向きに出す
 * (右・左・下・上。0 より前へは出さない)。どこへも出せなければ下。
 * @param {Placed} d @param {Placed} a
 * @returns {{x: number, y: number}|null}
 */
function yieldSpot(d, a) {
  if (covers(d, a) && d.y <= a.y) return null;
  const opts = [];
  if (d.x + d.w / 2 >= a.x + a.w / 2) opts.push({ x: a.x + a.w + GAP_X, y: d.y });
  else if (a.x - GAP_X - d.w >= 0) opts.push({ x: a.x - GAP_X - d.w, y: d.y });
  if (d.y > a.y) opts.push({ x: d.x, y: a.y + a.h + GAP_Y });
  else if (a.y - GAP_Y - d.h >= 0) opts.push({ x: d.x, y: a.y - GAP_Y - d.h });
  if (!opts.length) return { x: d.x, y: a.y + a.h + GAP_Y };
  const cost = (/** @type {{x: number, y: number}} */ p) => Math.abs(p.x - d.x) + Math.abs(p.y - d.y);
  return opts.reduce((best, p) => (cost(p) < cost(best) ? p : best));
}

/**
 * 落とした紙を、譲る紙 (yieldSpot) があればその余白の外へ動かす。譲った先でまた別の紙に譲ることもある。
 * 回数の上限を超えたら、そこから先は真下へだけ (必ず止まる)。覆った紙は残す (pushDown が下へずらす)。
 * @param {Placed[]} placed @param {string} key
 * @returns {Placed[]} 入力と同じ順の新しい配列
 */
function settleDropped(placed, key) {
  const others = placed.filter((p) => p.key !== key);
  const d0 = placed.find((p) => p.key === key);
  if (!d0) return placed;
  let d = { ...d0 };
  const limit = 2 * others.length + 2;
  for (let n = 0; ; n++) {
    const hit = others.find((a) => overlaps(d, a) && yieldSpot(d, a) !== null);
    if (!hit) break;
    const spot = n < limit ? /** @type {{x: number, y: number}} */ (yieldSpot(d, hit)) : { x: d.x, y: hit.y + hit.h + GAP_Y };
    d = { ...d, x: spot.x, y: spot.y };
    if (n > limit + others.length) break;
  }
  return placed.map((p) => (p.key === key ? d : p));
}

/**
 * 8. 紙を落とした (ドラッグか Shift + 矢印の NUDGE)。x・y は SNAP に揃えて 0 以上。落とした紙が上から覆った紙は下へずれる (pushDown)。
 * 隣の余白 (GAP_X・GAP_Y: 柱の置き場) に入っただけなら、落とした紙のほうが余白の外で止まる (隣を飛ばさない。近づけるのは余白まで)。
 * ほかの紙の途中から下に落としたときも、落とした紙がその下へ回る。layout に無い key なら席はそのまま。
 * @param {SeatsDoc|string|null} seats 今の記録 (null なら layout.seats)
 * @param {{sheets: Array<Placed & {cols: number}>, seats: SeatsDoc}} layout layoutBoard の結果
 * @param {string} key @param {number} x @param {number} y @param {number} now
 * @returns {SeatsDoc}
 */
export function dropSheet(seats, layout, key, x, y, now) {
  const base = parseSeats(seats) ?? layout.seats;
  if (!layout.sheets.some((s) => s.key === key)) return seatsDoc(base.aspect, Object.entries(base.seats));
  const snap = (/** @type {number} */ v, /** @type {number} */ was) => (Number.isFinite(v) ? Math.min(WORLD_MAX, Math.max(0, Math.round(v / SNAP) * SNAP)) : was);
  // 落とした紙は今の高さから取り直す (置き直した紙の下に、見えない取っておきの高さを残さない)。ほかの紙は取っておく高さのまま
  const placed = layout.sheets.map((s) => (s.key === key ? { key, x: snap(x, s.x), y: snap(y, s.y), w: s.w, h: s.h } : { key: s.key, x: s.x, y: s.y, w: s.w, h: keptH(seatOf(base, s.key), s.h) }));
  const items = layout.sheets.map((s) => ({ key: s.key, w: s.w, h: s.h, weight: 0, cols: s.cols }));
  const t = Number.isFinite(now) ? now : 0;
  const kept = keptSeats(base, new Set(items.map((it) => it.key)), t);
  return seatsDoc(base.aspect, [...kept, ...seatsOf(items, pushDown(settleDropped(placed, key), key), t)]);
}

/** @param {unknown} s */
function validSeat(s) {
  if (!isPlain(s)) return false;
  const { x, y, cols, seen, h } = /** @type {any} */ (s);
  const coord = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= WORLD_MAX;
  return coord(x) && coord(y) && Number.isInteger(cols) && cols >= COLS_MIN && cols <= COLS_MAX && typeof seen === 'number' && Number.isFinite(seen) && (h === undefined || coord(h));
}

/**
 * 12. 保存した席の記録 (JSON の文字列でもオブジェクトでもよい)。形が 1 か所でも違えば null (新しく pack する)。
 * @param {unknown} raw
 * @returns {SeatsDoc|null}
 */
export function parseSeats(raw) {
  let v = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isPlain(v)) return null;
  const doc = /** @type {any} */ (v);
  if (doc.v !== 3 || typeof doc.aspect !== 'number' || !(doc.aspect >= ASPECT_MIN && doc.aspect <= ASPECT_MAX) || !isPlain(doc.seats)) return null;
  const entries = Object.entries(doc.seats);
  if (!entries.every(([, s]) => validSeat(s))) return null;
  return seatsDoc(doc.aspect, entries.map(([k, s]) => [k, s.h === undefined ? { x: s.x, y: s.y, cols: s.cols, seen: s.seen } : { x: s.x, y: s.y, cols: s.cols, seen: s.seen, h: s.h }]));
}
