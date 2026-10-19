// キャンバスの純粋な部分 (spec/ui.md §10.5–§10.8): カメラの計算・キー・Esc の順・付箋の署名・席の保存・表示の切り替えの状態 (合成データ)。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANVAS, CANVAS_STORAGE_KEY, HOUR, UI_STORAGE_KEY } from '../src/shared/constants.mjs';
import { clampZ, colsCap, fitRect, headPin, isNarrow, keepCentre, LEAVE_PX, levelOf, FIT_MIN, minZoom, openCamera, panBy, revealRect, stepZoom, toScreen, toWorld, zoomAt } from '../public/canvas-camera.mjs';
import { layoutBoard, readingOrder } from '../public/canvas-layout.mjs';
import { canvasEscapeStep, canvasKeyAction } from '../public/canvas-input.mjs';
import { canvasSig, loadSeats, matchedIds, saveSeats } from '../public/canvas.mjs';
import { slipFlags } from '../public/canvas-slip.mjs';
import { keyAction } from '../public/keys.mjs';
import { loadPrefs, savePrefs, setView, state } from '../public/state.mjs';

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const ID = 'local_00000000-0000-4000-8000-0000000000c1';
/** @param {string} key @param {Record<string, any>} [o] */
const k = (key, o = {}) => ({ key, ...o });
/** @param {any} target @param {boolean} [keysOn] */
const at = (target, keysOn = true) => ({ keysOn, target });
const near = (/** @type {number} */ a, /** @type {number} */ b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

/** 保存の入れ替え (ブラウザの localStorage の代わり)。 @param {any} store @param {() => void} fn */
function withStorage(store, fn) {
  const g = /** @type {any} */ (globalThis);
  const before = g.localStorage;
  g.localStorage = store;
  try {
    fn();
  } finally {
    if (before === undefined) delete g.localStorage;
    else g.localStorage = before;
  }
}
const memStore = () => {
  /** @type {Record<string, string>} */
  const data = {};
  return { data, getItem: (/** @type {string} */ key) => data[key] ?? null, setItem: (/** @type {string} */ key, /** @type {string} */ v) => void (data[key] = String(v)) };
};
const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

// ---------- カメラ ----------

test('levelOf: 0.6 未満は遠く、1 未満は中くらい、1 (100%) から近く', () => {
  assert.equal(levelOf(0.59), 'far');
  assert.equal(levelOf(0.6), 'mid');
  assert.equal(levelOf(0.62), 'mid');
  assert.equal(levelOf(0.99), 'mid');
  assert.equal(levelOf(1), 'near');
  assert.deepEqual([levelOf(0.99, 490), levelOf(0.62, 490), levelOf(1, 490)], ['far', 'far', 'near'], '狭い表示枠に中くらいは無い');
  const z400 = (400 - 2 * CANVAS.PAD_NARROW) / CANVAS.SLIP_W;
  assert.deepEqual([levelOf(z400, 400), levelOf(z400 - 0.01, 400)], ['near', 'far'], '400px の欄は開いた倍率 (約 87%) から近く');
  assert.equal(levelOf(0.8, 1280), 'mid');
  assert.equal(levelOf(Number.NaN), 'far');
});

test('clampZ: Z_MIN … Z_MAX に収め、数でなければ 100%', () => {
  assert.equal(clampZ(0.01), CANVAS.Z_MIN);
  assert.equal(clampZ(9), CANVAS.Z_MAX);
  assert.equal(clampZ(0.7), 0.7);
  assert.equal(clampZ(Number.NaN), 1);
});

test('stepZoom: 段階の上で 1 つずつ、段階の間からはその向きの一番近い段階、端では端のまま。狭い表示枠は近くから見渡しへ一気に', () => {
  assert.equal(stepZoom(0.62, 1), 0.8);
  assert.equal(stepZoom(0.62, -1), 0.45);
  assert.equal(stepZoom(0.7, 1), 0.8, '段階の間から上へ');
  assert.equal(stepZoom(0.7, -1), 0.62, '段階の間から下へ');
  assert.equal(stepZoom(0.351, -1), 0.3);
  assert.equal(stepZoom(CANVAS.Z_MAX, 1), CANVAS.Z_MAX);
  assert.equal(stepZoom(CANVAS.Z_MIN, -1), CANVAS.Z_MIN);
  assert.equal(stepZoom(9, -1), 1.25, '範囲の外は収めてから');
  // 狭い表示枠: 近く (開いた倍率) と 30% の間は飛ばす (中くらいが無いので、間は空の付箋に印だけ)
  assert.deepEqual([stepZoom(1, -1, 490), stepZoom(0.3, 1, 490), stepZoom(1, 1, 490), stepZoom(0.3, -1, 490)], [0.3, 1, 1.25, 0.3], '30% より下も無い');
  assert.deepEqual([minZoom(490), minZoom(1280), minZoom()], [FIT_MIN, CANVAS.Z_MIN, CANVAS.Z_MIN]);
  assert.equal(zoomAt({ x: 0, y: 0, z: 0.3 }, 0.1, 0, 0, minZoom(490)).z, FIT_MIN, 'ホイールとピンチも狭い表示枠は 30% まで');
  const z400 = (400 - 2 * CANVAS.PAD_NARROW) / CANVAS.SLIP_W;
  assert.deepEqual([stepZoom(z400, -1, 400), stepZoom(0.3, 1, 400), stepZoom(z400, 1, 400)], [0.3, z400, 1]);
});

test('toWorld と toScreen は逆。panBy は画面の px で動かす', () => {
  const cam = { x: 100, y: -40, z: 0.5 };
  const w = toWorld(cam, 30, 60);
  assert.deepEqual(toScreen(cam, w.x, w.y), { x: 30, y: 60 });
  const moved = panBy(cam, 50, -20);
  assert.deepEqual(toScreen(moved, w.x, w.y), { x: 80, y: 40 }, '中身が右へ 50、上へ 20 動く');
  assert.equal(moved.z, 0.5);
});

test('zoomAt: ポインタの下の world の点は動かない (縮尺は範囲に収める)', () => {
  const cam = { x: 120, y: 80, z: 0.62 };
  for (const z2 of [0.15, 0.45, 1, 1.5, 4]) {
    const before = toWorld(cam, 333, 211);
    const next = zoomAt(cam, z2, 333, 211);
    const after = toWorld(next, 333, 211);
    near(after.x, before.x);
    near(after.y, before.y);
    assert.equal(next.z, clampZ(z2));
  }
});

test('fitRect: 全体が収まり、100% を超えない。上に HEAD_ROOM を空け、横は真ん中', () => {
  const big = fitRect({ x: 0, y: 0, w: 4000, h: 1500 }, 1280, 700, 40);
  assert.ok(big.z < 1);
  const tl = toScreen(big, 0, 0);
  const br = toScreen(big, 4000, 1500);
  assert.ok(tl.x >= 40 - 1e-6 && br.x <= 1280 - 40 + 1e-6, '横に収まる');
  near(tl.y, 40 + CANVAS.HEAD_ROOM);
  assert.ok(br.y <= 700 - 40 + 1e-6, '縦に収まる');
  const small = fitRect({ x: 50, y: 50, w: 200, h: 100 }, 1280, 700, 40);
  assert.equal(small.z, 1, '小さくても 100% まで');
  near(toScreen(small, 50, 0).x + toScreen(small, 250, 0).x, 1280, 1e-6);
  const tiny = fitRect({ x: 0, y: 0, w: 1e7, h: 1e7 }, 320, 400, 12);
  assert.equal(tiny.z, CANVAS.Z_MIN, '大きすぎても Z_MIN より下げない');
});

test('fitRect: 高さにも合わせるが FIT_MIN より小さくしない (どの幅でも。長い机は上をそろえて動かして読む)。幅にはいつも合わせ、横は真ん中', () => {
  assert.equal(isNarrow(CANVAS.NARROW_PX - 1), true);
  assert.equal(isNarrow(CANVAS.NARROW_PX), false);
  const tall = { x: 0, y: 0, w: CANVAS.SLIP_W, h: 6000 };
  const cam = fitRect(tall, 490, 672, CANVAS.PAD_NARROW);
  assert.equal(cam.z, FIT_MIN, '長い並びは下限まで (Z_MIN までは縮めない)');
  near(toScreen(cam, 0, 0).y, CANVAS.PAD_NARROW + CANVAS.HEAD_ROOM);
  near(toScreen(cam, 0, 0).x + toScreen(cam, CANVAS.SLIP_W, 0).x, 490, 1e-6);
  assert.equal(fitRect({ x: 0, y: 0, w: CANVAS.SLIP_W, h: 500 }, 490, 672, CANVAS.PAD_NARROW).z, 1, '短い並びは 100% (幅 432 は 466px に収まる)');
  near(fitRect({ x: 0, y: 0, w: CANVAS.SLIP_W, h: 1500 }, 490, 672, CANVAS.PAD_NARROW).z, (672 - 24 - CANVAS.HEAD_ROOM) / 1500);
  const wide = fitRect(tall, 1280, 672, CANVAS.PAD_WIDE);
  assert.equal(wide.z, FIT_MIN, '広い表示枠でも長い机は下限まで');
  near(toScreen(wide, 0, 0).y, CANVAS.PAD_WIDE + CANVAS.HEAD_ROOM);
  near(fitRect({ x: 0, y: 0, w: 2000, h: 300 }, 400, 650, 12).z, (400 - 24) / 2000, 1e-9);
});

test('colsCap: 開いたときの縮尺で紙 1 枚が表示枠の幅に収まる列数。狭い表示枠は 1 列', () => {
  assert.equal(colsCap(490), 1);
  assert.equal(colsCap(639), 1);
  assert.equal(colsCap(768), 2);
  assert.equal(colsCap(1280), 4);
  assert.equal(colsCap(4000), CANVAS.COLS_MAX);
  for (const w of [640, 768, 1024, 1280, 1600]) assert.ok(colsCap(w) * CANVAS.SLIP_W * CANVAS.Z_OPEN <= w - 2 * CANVAS.PAD_WIDE, String(w));
});

/** @param {Array<{key: string, x: number, y: number, w: number, h: number, ids: string[], quiet?: boolean}>} sheets */
const layoutOf = (sheets) => ({
  sheets: sheets.map((s) => ({ quiet: false, ...s, slips: s.ids.map((id, i) => ({ id, x: i * CANVAS.SLIP_W, y: 0, h: CANVAS.SLIP_H })) })),
  bounds: { x: 0, y: 0, w: Math.max(...sheets.map((s) => s.x + s.w)), h: Math.max(...sheets.map((s) => s.y + s.h)) },
});

test('openCamera: 急ぐ用紙 (静かな紙は除く) を収める縮尺を 62%〜100% に収め、その左上 (見出し込み) を余白の位置に。lede が外なら見えるだけ動かす', () => {
  const W = CANVAS.SLIP_W;
  const layout = layoutOf([
    { key: 'a', x: 0, y: 0, w: W, h: 400, ids: ['a1'] },
    { key: 'b', x: W + 96, y: 0, w: 2 * W, h: 600, ids: ['b1', 'b2'] },
    { key: 'q', x: 0, y: 5000, w: 3 * W, h: 3000, ids: ['q1'], quiet: true },
  ]);
  const cam = openCamera(layout, 'a1', 1280, 700, 40);
  near(cam.z, Math.min((1280 - 80) / (3 * W + 96), (700 - 80 - CANVAS.HEAD_ROOM) / 600));
  assert.ok(cam.z >= CANVAS.Z_OPEN && cam.z <= 1);
  near(toScreen(cam, 0, 0).x, 40);
  near(toScreen(cam, 0, 0).y, 40 + CANVAS.HEAD_ROOM, 1e-6);
  // 急ぐ用紙が大きくても 62% より小さくしない (題名が読める)。左上から
  const big = layoutOf([{ key: 'a', x: 0, y: 0, w: 6 * W, h: 4000, ids: ['a1'] }, { key: 'b', x: 0, y: 4152, w: W, h: 400, ids: ['b1'] }]);
  const c2 = openCamera(big, null, 1280, 700, 40);
  assert.equal(c2.z, CANVAS.Z_OPEN);
  near(toScreen(c2, 0, 0).y, 40 + CANVAS.HEAD_ROOM);
  // lede の付箋が外にあれば、縮尺はそのままで見えるだけ動かす
  const c3 = openCamera(big, 'b1', 1280, 700, 40);
  assert.equal(c3.z, CANVAS.Z_OPEN);
  const p = toScreen(c3, 0, 4152);
  assert.ok(p.y >= CANVAS.REVEAL_MARGIN + CANVAS.HEAD_ROOM - 1e-6 && p.y + CANVAS.SLIP_H * c3.z <= 700 - CANVAS.REVEAL_MARGIN + 1e-6, JSON.stringify(p));
  // 狭い表示枠は幅だけで決める (縦は動かして読む)
  const n = openCamera(layoutOf([{ key: 'a', x: 0, y: 0, w: W, h: 9000, ids: ['a1'] }]), null, 490, 672, 12);
  assert.equal(n.z, 1);
  // 急ぐ用紙が無ければ全体を表示、何も無ければ原点の 100%
  const calm = layoutOf([{ key: 'q', x: 0, y: 0, w: W, h: 300, ids: ['q1'], quiet: true }]);
  assert.deepEqual(openCamera(calm, null, 1280, 700, 40), fitRect(calm.bounds, 1280, 700, 40));
  assert.deepEqual(openCamera({ sheets: [], bounds: { x: 0, y: 0, w: 0, h: 0 } }, null, 1280, 700, 40), { x: 0, y: 0, z: 1 });
  const foldOnly = { sheets: [], bounds: { x: 0, y: 0, w: W, h: 200 } };
  assert.deepEqual(openCamera(foldOnly, null, 1280, 700, 40), fitRect(foldOnly.bounds, 1280, 700, 40), '片付けだけのまとめしか無い');
});

test('headPin: 見出しが表示枠の上で切れない間は貼り付けない。切れるときから見出しを全部貼り付け、用紙の残りが見出し + LEAVE_PX を切ったら用紙ごと見せない', () => {
  const z = 0.62;
  const head = 90; // world
  const h = 1000; // world
  const k = 1 / z;
  const whole = (head + 2 * k) * z; // 見出し (と罫線との間) が表示枠の中に収まる罫線の位置 (画面の px)
  for (const top of [whole, whole + 1, 300]) assert.deepEqual(headPin(top, h, head, z), { pinY: 0, leaving: false }, `top ${top}`);
  const cut = headPin(whole - 1, h, head, z);
  assert.ok(cut.pinY > 0 && !cut.leaving, '罫線が表示枠の中でも、見出しが切れるなら貼り付く (見出しの無い用紙や下の端の切れ端を出さない)');
  // 貼り付いた箱 (上の余白 4k と下の罫線 1k を足した高さ) の上端が表示枠の上端の 2px 上: 箱の下端 (pinY − 2k) − (head + 5k) = (−2 − top) / z
  for (const top of [-10, 20]) near(headPin(top, h, head, z).pinY - 2 * k - (head + 5 * k), (-2 - top) / z, 1e-9);
  // 用紙の残り (画面の px) が箱 + LEAVE_PX を切ると、用紙ごと見せない (見出しは上へ半分抜けない)
  const box = (head + 5 * k) * z;
  const edge = box + LEAVE_PX - h * z;
  assert.deepEqual(headPin(edge - 0.5, h, head, z), { pinY: 0, leaving: true });
  const last = headPin(edge + 0.5, h, head, z);
  assert.ok(last.pinY > 0 && !last.leaving, 'その手前まで、見出しは全部見えて貼り付いたまま');
  assert.deepEqual(headPin(-(h * z) - 1, h, head, z), { pinY: 0, leaving: false }, '用紙が全部上に抜けた');
  // 低い用紙 (帯だけ): 罫線が上に出たら、すぐに見せない (見出しの下に用紙がほとんど残らない)
  assert.deepEqual(headPin(-1, 52, head, z), { pinY: 0, leaving: true });
});

test('revealRect: 見えていればそのまま (同じカメラ)。はみ出した分だけ動かし、縮尺は変えない。上は貼り付く見出しの分も空ける', () => {
  const cam = { x: 0, y: 0, z: 1 };
  assert.equal(revealRect(cam, { x: 100, y: 200, w: 264, h: 192 }, 1280, 700, 24), cam);
  const right = revealRect(cam, { x: 1200, y: 200, w: 264, h: 192 }, 1280, 700, 24);
  near(toScreen(right, 1200 + 264, 0).x, 1280 - 24);
  assert.equal(right.y, 0, '縦は動かさない');
  assert.equal(right.z, 1);
  const up = revealRect(cam, { x: 100, y: 10, w: 264, h: 192 }, 1280, 700, 24);
  near(toScreen(up, 0, 10).y, 24 + CANVAS.HEAD_ROOM);
  const down = revealRect({ x: 0, y: 0, z: 0.5 }, { x: 100, y: 1600, w: 264, h: 192 }, 1280, 700, 24);
  near(toScreen(down, 0, 1600 + 192).y, 700 - 24);
  const huge = revealRect(cam, { x: 5000, y: 0, w: 4000, h: 192 }, 1280, 700, 24);
  near(toScreen(huge, 5000, 0).x, 24, 1e-6);
});

test('keepCentre: 表示枠の大きさが変わっても、真ん中にあった world の点は真ん中のまま', () => {
  const cam = { x: 300, y: 100, z: 0.62 };
  const c = toWorld(cam, 640, 350);
  const next = keepCentre(cam, 1280, 700, 400, 500);
  const c2 = toWorld(next, 200, 250);
  near(c2.x, c.x);
  near(c2.y, c.y);
});

// ---------- 実際の盤面に近い合成の盤面 (デモでは出ない形: 片付けだけの紙が多い、lede が 1 枚の紙、最近の多い紙、長い題名) ----------

/**
 * 14 プロジェクト: 急ぐ紙 7 枚 (返事待ち 2・止まったかも 2・未読 2・作業中 2、どれも最近や片付けを抱える) と片付けだけ 7 つ。
 * 題名は 30〜40 code point の日本語と英語の混ざったもの (合成)。
 */
function stressBoard() {
  const T0 = NOW - 10 * HOUR;
  let n = 0;
  const title = (/** @type {number} */ i) => `合成の作業 ${i}: preview の差し替えと review 待ちの確認をする件`.slice(0, 30 + (i % 11));
  /** @param {string} key @param {string} pile @param {Record<string, any>} [o] */
  const c = (key, pile, o = {}) => {
    n++;
    return { id: `s${n}`, bucket: pile, title: title(n), body: '', since: T0 + n * 60_000, lastActivityAt: T0 + n * 60_000, createdAt: T0, project: key === '(other)' ? { key, label: null, extra: 0 } : { key, label: key, extra: 0 }, ...o };
  };
  const rep = (/** @type {number} */ k, /** @type {() => any} */ f) => Array.from({ length: k }, f);
  const cards = [
    c('lede-one', 'needs_you', { since: T0 - 20 * HOUR }), c('lede-one', 'cleanup'),
    c('needs-two', 'needs_you'), c('needs-two', 'recent'),
    ...rep(2, () => c('stuck', 'trouble')),
    c('mixed', 'trouble'), c('mixed', 'unread'), ...rep(6, () => c('mixed', 'recent')), ...rep(9, () => c('mixed', 'cleanup')),
    c('(other)', 'unread'), c('(other)', 'working'), ...rep(9, () => c('(other)', 'recent')), ...rep(20, () => c('(other)', 'cleanup')),
    c('work-a', 'working'), ...rep(2, () => c('work-a', 'recent')), ...rep(5, () => c('work-a', 'cleanup')),
    c('work-b', 'working'), c('work-b', 'recent'), ...rep(2, () => c('work-b', 'cleanup')),
    ...[6, 4, 4, 1, 1, 1, 1].flatMap((k, i) => rep(k, () => c(`archive-${i}`, 'cleanup'))),
  ];
  /** @type {Record<string, any[]>} */
  const buckets = { needs_you: [], trouble: [], unread: [], working: [] };
  const recent = new Map();
  const cleanup = [];
  for (const x of cards) {
    if (x.bucket in buckets) buckets[x.bucket].push(x);
    else if (x.bucket === 'recent') recent.set(x.project.key, [...(recent.get(x.project.key) ?? []), x]);
    else cleanup.push(x);
  }
  return { v: 2, counts: {}, buckets, recentGroups: [...recent].map(([key, items]) => ({ key, items })), cleanupGroups: [{ reason: 'idle_7d', count: cleanup.length, items: cleanup }], families: {}, stats: {} };
}

/** 付箋の題名が 16px で 2 行に収まるか (日本語 1em、ASCII 0.55em の見積もり)。 @param {string} t @param {number} boxPx */
const fitsTwoLines = (t, boxPx) => [...t].reduce((w, ch) => w + (ch.charCodeAt(0) < 0x2e80 ? 0.55 : 1), 0) * 16 <= 2 * boxPx;

test('合成の盤面: 片付けだけの 7 つはまとめに、紙は急ぐ順。1280 で開くと 62% 以上で急ぐ付箋の大半と lede が見え、題名は 2 行に収まり、空の列も見出しの切れも無い', () => {
  const board = stressBoard();
  const [vw, vh, pad] = [1280, 680, CANVAS.PAD_WIDE];
  const L = layoutBoard(board, null, { aspect: vw / vh, now: NOW, maxCols: colsCap(vw) });
  assert.equal(L.sheets.length, 7);
  assert.deepEqual(L.fold?.items.map((it) => it.n), [6, 4, 4, 1, 1, 1, 1]);
  assert.deepEqual(L.sheets.slice(0, 2).map((s) => s.counts.needs_you > 0), [true, true], '返事待ちの紙が先 (左上)');
  assert.equal(L.sheets[L.sheets.length - 1].counts.needs_you + L.sheets[L.sheets.length - 1].counts.trouble, 0);
  const lede = board.buckets.needs_you[0].id;
  const cam = openCamera(L, lede, vw, vh, pad);
  assert.ok(cam.z >= CANVAS.Z_OPEN && cam.z <= 1, `z ${cam.z}`);
  const onScreen = (/** @type {any} */ s, /** @type {any} */ sl) => {
    const a = toScreen(cam, s.x + sl.x, s.y + sl.y);
    return a.x >= 0 && a.y >= 0 && a.x + CANVAS.SLIP_W * cam.z <= vw && a.y + sl.h * cam.z <= vh;
  };
  const action = L.sheets.flatMap((s) => s.slips.map((sl) => ({ s, sl })));
  const seen = action.filter(({ s, sl }) => onScreen(s, sl));
  assert.ok(seen.length / action.length >= 0.75, `急ぐ付箋 ${seen.length}/${action.length}`);
  assert.ok(seen.some(({ sl }) => sl.id === lede), 'lede の付箋が見える');
  // 題名の箱: 付箋の幅 − 余白 (左 10 + 右 12 world) − 印の列 16px − 間 4px
  const box = (CANVAS.SLIP_W - 22) * cam.z - 20;
  const titles = action.map(({ sl }) => board.buckets[sl.pile]?.find((/** @type {any} */ x) => x.id === sl.id)?.title ?? '');
  assert.ok(titles.filter((t) => fitsTwoLines(t, box)).length / titles.length >= 0.9, `box ${box.toFixed(0)}px`);
  for (const s of L.sheets) {
    const top = (s.y - cam.y) * cam.z;
    assert.ok(!(top >= 0 && top < CANVAS.HEAD_ROOM), `${s.key}: 罫線が表示枠の上から見出しの高さの中 (${top.toFixed(1)}px) で見出しが切れる`);
    const area = s.slips.filter((sl) => sl.row === 0);
    if (s.slips.length >= s.cols) assert.equal(area.length, s.cols, `${s.key}: 空の列`);
    assert.ok(s.slips.every((sl) => ['needs_you', 'trouble', 'unread', 'working'].includes(sl.pile)), `${s.key}: 最近と片付けは帯の数 (付箋にしない)`);
  }
});

test('合成の盤面: 768px で開くと、見える紙は右で切れない (段の幅は開いたときの縮尺で表示枠に収まる幅まで)', () => {
  const board = stressBoard();
  const [vw, vh, pad] = [768, 680, CANVAS.PAD_WIDE];
  const L = layoutBoard(board, null, { aspect: vw / vh, now: NOW, maxCols: colsCap(vw), maxW: (vw - 2 * pad) / CANVAS.Z_OPEN });
  const cam = openCamera(L, board.buckets.needs_you[0].id, vw, vh, pad);
  let shown = 0;
  for (const s of L.sheets) {
    const a = toScreen(cam, s.x, s.y);
    if (!(a.x < vw && a.y < vh && a.y + s.h * cam.z > 0)) continue;
    shown++;
    assert.ok(a.x >= 0 && a.x + s.w * cam.z <= vw - pad + 1e-6, `${s.key}: 右で切れる (${(a.x + s.w * cam.z).toFixed(0)}px)`);
  }
  assert.ok(shown >= 1);
});

test('合成の盤面: 490px (Claude の横の欄) は 1 列の紙を縦 1 列に、100% で開き、最初の紙は返事待ち。「全体」は 30% までの見渡し', () => {
  const board = stressBoard();
  const L = layoutBoard(board, null, { aspect: 0.1, now: NOW, maxCols: colsCap(490) });
  assert.ok(L.sheets.every((s) => s.cols === 1 && s.x === 0));
  assert.ok(L.sheets[0].counts.needs_you > 0);
  const cam = openCamera(L, board.buckets.needs_you[0].id, 490, 672, CANVAS.PAD_NARROW);
  assert.equal(cam.z, 1);
  const fit = fitRect(L.bounds, 490, 672, CANVAS.PAD_NARROW).z;
  assert.ok(fit >= FIT_MIN && fit < 1, `全体は見渡し (${fit})、Z_MIN までは縮めない`);
  assert.deepEqual(readingOrder(L).slice(0, 1), [L.sheets[0].slips[0].id]);
});

// ---------- キー ----------

test('canvasKeyAction: 日本語入力中・修飾キー・入力欄・dialog では何もしない。絞り込み欄では Esc だけ', () => {
  assert.equal(canvasKeyAction(k('j', { isComposing: true }), at('none')), null);
  assert.equal(canvasKeyAction(k('j', { keyCode: 229 }), at('none')), null);
  for (const m of ['ctrlKey', 'metaKey', 'altKey']) assert.equal(canvasKeyAction(k('+', { [m]: true }), at('none')), null, m);
  assert.equal(canvasKeyAction(k('j'), at('field')), null);
  assert.equal(canvasKeyAction(k('Escape'), at('field')), null);
  assert.equal(canvasKeyAction(k('Escape'), at('dialog')), null, 'dialog の Esc はブラウザに任せる');
  assert.equal(canvasKeyAction(k('j'), at('filter')), null);
  assert.equal(canvasKeyAction(k('Escape'), at('filter')), 'escape');
});

test('canvasKeyAction: 矢印は表示枠で動かす (Shift で大きく)、付箋で隣へ、見出しで Shift つきなら用紙を動かす', () => {
  for (const [key, dir] of [['ArrowLeft', 'left'], ['ArrowRight', 'right'], ['ArrowUp', 'up'], ['ArrowDown', 'down']]) {
    assert.equal(canvasKeyAction(k(key), at('viewport')), `pan-${dir}`);
    assert.equal(canvasKeyAction(k(key, { shiftKey: true }), at('viewport')), `pan-${dir}-big`);
    assert.equal(canvasKeyAction(k(key), at('none')), `pan-${dir}`);
    assert.equal(canvasKeyAction(k(key), at('slip')), `move-${dir}`);
    assert.equal(canvasKeyAction(k(key, { shiftKey: true }), at('slip')), null);
    assert.equal(canvasKeyAction(k(key, { shiftKey: true }), at('head')), `nudge-${dir}`);
    assert.equal(canvasKeyAction(k(key), at('head')), null);
    assert.equal(canvasKeyAction(k(key), at('bar')), null, '帯のボタンの矢印はブラウザのまま');
    assert.equal(canvasKeyAction(k(key), at('slip', false)), `move-${dir}`, '矢印は 1 文字キーを止めても効く');
  }
});

test('canvasKeyAction: §10.8 の表のキー', () => {
  const table = {
    j: 'next', k: 'prev', o: 'open', h: 'handoff', '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out', '0': 'zoom-reset',
    f: 'fit', z: 'fit-toggle', v: 'view', '/': 'filter', '?': 'help', 1: 'jump-1', 6: 'jump-6',
  };
  for (const [key, action] of Object.entries(table)) {
    for (const target of ['none', 'viewport', 'slip', 'head', 'bar', 'control']) assert.equal(canvasKeyAction(k(key), at(target)), action, `${key} on ${target}`);
  }
  assert.equal(canvasKeyAction(k('+', { shiftKey: true }), at('none')), 'zoom-in', 'Shift の要る + もそのまま');
  assert.equal(canvasKeyAction(k('7'), at('none')), null);
  for (const key of ['x', 'a', 'c']) assert.equal(canvasKeyAction(k(key), at('slip')), null, `${key} は一覧だけ`);
  assert.equal(canvasKeyAction(k('Enter'), at('slip')), 'open');
  assert.equal(canvasKeyAction(k('Enter'), at('none')), 'open');
  assert.equal(canvasKeyAction(k('Enter'), at('control')), null, 'ほかのボタンの Enter はブラウザのまま');
  assert.equal(canvasKeyAction(k(' '), at('slip')), 'peek');
  assert.equal(canvasKeyAction(k(' '), at('viewport')), null);
  // 柱の Enter と Space は、帯の「用紙を動かす」(柱がボタンとして働く。1 文字キーを止めても効く)
  assert.equal(canvasKeyAction(k('Enter'), at('head')), 'sheet');
  assert.equal(canvasKeyAction(k(' '), at('head')), 'sheet');
  assert.equal(canvasKeyAction(k('Enter'), at('head', false)), 'sheet');
  assert.equal(canvasKeyAction(k('Enter', { shiftKey: true }), at('slip')), null);
  assert.equal(canvasKeyAction(k('Escape'), at('slip')), 'escape');
  assert.equal(canvasKeyAction(k('Tab'), at('slip')), null);
});

test('canvasKeyAction: 1 文字キーを止めると v h f z + = − 0 j k o 1–6 / ? が効かない。Enter・Space・Esc・矢印は効く', () => {
  for (const key of ['v', 'h', 'f', 'z', '+', '=', '-', '0', 'j', 'k', 'o', '1', '6', '/', '?']) assert.equal(canvasKeyAction(k(key), at('slip', false)), null, key);
  assert.equal(canvasKeyAction(k('Enter'), at('slip', false)), 'open');
  assert.equal(canvasKeyAction(k(' '), at('slip', false)), 'peek');
  assert.equal(canvasKeyAction(k('Escape'), at('slip', false)), 'escape');
  assert.equal(canvasKeyAction(k('ArrowUp', { shiftKey: true }), at('head', false)), 'nudge-up');
});

test('canvasKeyAction: v h z f 0 o の押しっぱなしは 1 回だけ。+ − と j k は繰り返す', () => {
  for (const key of ['v', 'h', 'z', 'f', '0', 'o']) assert.equal(canvasKeyAction(k(key, { repeat: true }), at('none')), null, key);
  assert.equal(canvasKeyAction(k('+', { repeat: true }), at('none')), 'zoom-in');
  assert.equal(canvasKeyAction(k('j', { repeat: true }), at('none')), 'next');
});

test('keyAction: 一覧の v はキャンバスへ、z はキャンバスの全体表示へ。キャンバスの間は cv: を付けて渡す', () => {
  assert.equal(keyAction(k('v'), { keysOn: true, target: 'none' }), 'view');
  assert.equal(keyAction(k('z'), { keysOn: true, target: 'none' }), 'canvas-fit');
  assert.equal(keyAction(k('v', { repeat: true }), { keysOn: true, target: 'none' }), null);
  assert.equal(keyAction(k('f'), { keysOn: true, target: 'none', view: 'canvas', canvasTarget: 'viewport' }), 'cv:fit');
  assert.equal(keyAction(k('j'), { keysOn: false, target: 'none', view: 'canvas', canvasTarget: 'slip' }), null);
});

test('canvasEscapeStep: 絞り込み欄 → 帯 → 付箋・見出しから表示枠へ → 親子 → 文字。選択は消さない', () => {
  const base = { inFilter: false, filterValue: '', bar: null, onSlipOrHead: false, family: null, q: '' };
  assert.equal(canvasEscapeStep({ ...base, inFilter: true, filterValue: 'x', q: 'x' }), 'filter-clear');
  assert.equal(canvasEscapeStep({ ...base, inFilter: true }), 'filter-blur');
  assert.equal(canvasEscapeStep({ ...base, bar: 'detail', onSlipOrHead: true, family: 'r' }), 'bar-close');
  assert.equal(canvasEscapeStep({ ...base, bar: 'handoff' }), 'bar-close');
  assert.equal(canvasEscapeStep({ ...base, onSlipOrHead: true, family: 'r', q: 'x' }), 'to-viewport');
  assert.equal(canvasEscapeStep({ ...base, family: 'r', q: 'x' }), 'family-clear');
  assert.equal(canvasEscapeStep({ ...base, q: 'x' }), 'query-clear');
  assert.equal(canvasEscapeStep(base), null);
});

// ---------- 付箋の署名・絞り込み ----------

test('canvasSig: 時刻 (now) では変わらない。言語・カード・欄・印が変われば変わる', () => {
  const card = { id: ID, bucket: 'unread', title: 'Demo', since: NOW - HOUR, lastActivityAt: NOW - HOUR, context: { pct: 84, level: 'due', used: 168000, window: 200000, compactAt: 167000 } };
  const o = { nextId: null, demo: true, handoff: {}, isNew: () => false };
  const sigAt = (/** @type {number} */ now) => canvasSig('en', card, slipFlags(card, { pile: 'unread', faded: false }, { ...o, now }));
  assert.equal(sigAt(NOW), sigAt(NOW + 5 * 60_000), '5 分たっても同じ');
  const base = slipFlags(card, { pile: 'unread', faded: false }, { ...o, now: NOW });
  assert.notEqual(canvasSig('ja', card, base), canvasSig('en', card, base));
  assert.notEqual(canvasSig('en', { ...card, title: 'Other' }, base), canvasSig('en', card, base));
  assert.notEqual(canvasSig('en', card, { ...base, next: true }), canvasSig('en', card, base));
  assert.notEqual(canvasSig('en', card, { ...base, pile: 'recent' }), canvasSig('en', card, base));
  // 引き継ぎの指示文をコピーしたら印が変わる (ボタン → コピー済み)
  const copied = slipFlags(card, { pile: 'unread', faded: false }, { ...o, now: NOW, handoff: { [ID]: { at: NOW - 60_000, pct: 84 } } });
  assert.equal(base.handoff, 'button');
  assert.equal(copied.handoff, 'copied');
  assert.notEqual(canvasSig('en', card, copied), canvasSig('en', card, base));
});

test('matchedIds: 絞り込み中でなければ null。中なら全部の欄・最近・片付けの合う ID', () => {
  assert.equal(matchedIds(null), null);
  assert.equal(matchedIds({ filtering: false, buckets: {} }), null);
  const v = {
    filtering: true,
    buckets: { needs_you: [{ id: 'n1' }], trouble: [], unread: [], working: [{ id: 'w1' }] },
    recentGroups: [{ items: [{ id: 'r1' }] }],
    cleanupGroups: [{ items: [{ id: 'c1' }] }, { projects: [{ items: [{ id: 'c2' }] }] }],
  };
  assert.deepEqual([...(matchedIds(v) ?? [])].sort(), ['c1', 'c2', 'n1', 'r1', 'w1']);
});

// ---------- 席の保存 ----------

test('loadSeats / saveSeats: 保存したものを読み戻す。狭い表示枠の席は別の key。壊れた記録・v 1 の記録・使えない保存は null、例外は外へ出さない', () => {
  const doc = { v: 3, aspect: 1.6, seats: { 'demo-app': { x: 0, y: 0, cols: 4, seen: NOW } } };
  const stack = { v: 3, aspect: 0.1, seats: { 'demo-app': { x: 0, y: 0, cols: 1, seen: NOW } } };
  const mem = memStore();
  withStorage(mem, () => {
    assert.equal(loadSeats(), null, 'まだ何も無い');
    saveSeats(doc);
    saveSeats(stack, true);
    assert.deepEqual(JSON.parse(mem.data[CANVAS_STORAGE_KEY]), doc);
    assert.deepEqual(JSON.parse(mem.data[`${CANVAS_STORAGE_KEY}:narrow`]), stack);
    assert.deepEqual(loadSeats(), doc);
    assert.deepEqual(loadSeats(true), stack, '広い画面と狭い欄の並びは互いを上書きしない');
    mem.data[CANVAS_STORAGE_KEY] = '{not json';
    assert.equal(loadSeats(), null);
    mem.data[CANVAS_STORAGE_KEY] = JSON.stringify({ ...doc, v: 1 });
    assert.equal(loadSeats(), null, 'v 1 の記録は並べ直す');
  });
  withStorage(blocked, () => {
    assert.equal(loadSeats(), null);
    assert.doesNotThrow(() => saveSeats(doc));
  });
});

// ---------- 表示の状態 ----------

test('表示: prefs.view を覚える (既定は list)。v0.1 の全体 (Overview) の好みは読み込むときに落とす', () => {
  const mem = memStore();
  withStorage(mem, () => {
    mem.data[UI_STORAGE_KEY] = JSON.stringify({ view: 'canvas', overview: true, overviewQuiet: true, keys: false });
    loadPrefs();
    assert.equal(state.prefs.view, 'canvas');
    assert.equal(state.prefs.keys, false);
    assert.equal('overview' in state.prefs, false);
    assert.equal('overviewQuiet' in state.prefs, false);
    setView('list');
    const saved = JSON.parse(mem.data[UI_STORAGE_KEY]);
    assert.equal(saved.view, 'list');
    assert.equal('overview' in saved, false);
    mem.data[UI_STORAGE_KEY] = JSON.stringify({ view: 'sideways' });
    loadPrefs();
    assert.equal(state.prefs.view, 'list', '知らない値は一覧');
    savePrefs();
  });
  withStorage(blocked, () => {
    loadPrefs();
    assert.equal(state.prefs.view, 'list');
    assert.doesNotThrow(() => setView('canvas'));
    assert.equal(state.prefs.view, 'canvas', '保存できなくても、この表示の間は覚えている');
  });
});
