// "つながりだけ" arrangement (src/entry/page/ego.js, the same code the page runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../src/entry/page/ego.js', import.meta.url)), 'utf8');
const { egoLayout, egoLanePath, egoNameFit, EGO_MAX_COLS, EGO_LABEL_LINES } = new Function(`${src}\nreturn { egoLayout, egoLanePath, egoNameFit, EGO_MAX_COLS, EGO_LABEL_LINES };`)();

const boxes = (prefix, n, w = 200) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, w, h: 58 }));
const ME = { id: 'me', w: 200, h: 58 };
const WIDE = { w: 1030, h: 660 };  // the map area beside the side panel on a 1520 x 960 window
const rect = (pos, b) => ({ x0: pos.get(b.id).x, y0: pos.get(b.id).y, x1: pos.get(b.id).x + b.w, y1: pos.get(b.id).y + b.h });
const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const fitScale = (pos, all, avail) => {
  const rs = all.map((b) => rect(pos, b));
  const w = Math.max(...rs.map((r) => r.x1)) - Math.min(...rs.map((r) => r.x0));
  const h = Math.max(...rs.map((r) => r.y1)) - Math.min(...rs.map((r) => r.y0));
  return Math.min(1.15, avail.w / w, avail.h / h);
};

test('ego: a few partners stay in one column per side, centred on the chosen box, with words on the lines', () => {
  const left = boxes('u', 3), right = boxes('d', 4);
  const out = egoLayout({ me: ME, left, right, avail: WIDE, lines: 7 });
  assert.equal(out.lanes.size, 0);
  assert.equal(out.words, true);
  assert.equal(new Set(left.map((b) => out.pos.get(b.id).x)).size, 1);
  assert.equal(new Set(right.map((b) => out.pos.get(b.id).x)).size, 1);
  const me = out.pos.get('me');
  for (const b of left) assert.ok(out.pos.get(b.id).x + b.w < me.x, 'users sit left of the chosen box');
  for (const b of right) assert.ok(out.pos.get(b.id).x > me.x + ME.w, 'what it uses sits right');
  const mid = (ids) => { const ys = ids.map((b) => out.pos.get(b.id).y + 29); return (Math.min(...ys) + Math.max(...ys)) / 2; };
  assert.equal(mid(left), me.y + 29);
  assert.equal(mid(right), me.y + 29);
});

test('ego: 23 partners wrap into columns and show at least twice as large as one tall column', () => {
  const right = boxes('d', 23);
  const out = egoLayout({ me: ME, left: [], right, avail: WIDE, lines: 23 });
  assert.ok(out.rows < 23 && out.rows >= Math.ceil(23 / EGO_MAX_COLS), `rows ${out.rows}`);
  assert.equal(out.words, false, 'too many lines for words');
  const all = [ME, ...right];
  const scale = fitScale(out.pos, all, WIDE);
  const oneColumn = Math.min(1.15, WIDE.w / 1200, WIDE.h / (23 * 86));
  assert.ok(scale >= oneColumn * 2, `scale ${scale.toFixed(2)} vs one column ${oneColumn.toFixed(2)}`);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(!overlaps(rect(out.pos, all[i]), rect(out.pos, all[j])), `${all[i].id} / ${all[j].id}`);
});

test('ego: a lane runs in a gap between rows, clear of every box it passes', () => {
  const right = boxes('d', 32);
  const out = egoLayout({ me: ME, left: [], right, avail: WIDE, lines: 32 });
  const cols = new Set(right.map((b) => out.pos.get(b.id).x)).size;
  assert.ok(cols >= 2 && cols <= EGO_MAX_COLS, `columns ${cols}`);
  const firstX = Math.min(...right.map((b) => out.pos.get(b.id).x));
  const lanes = right.filter((b) => out.lanes.has(b.id));
  assert.equal(lanes.length, right.filter((b) => out.pos.get(b.id).x > firstX).length, 'every box past the first column has a lane');
  for (const b of lanes) {
    const lane = out.lanes.get(b.id);
    assert.ok(lane.near < firstX && lane.far < out.pos.get(b.id).x, 'lane starts before the first column and ends before its box');
    for (const o of right) {
      const r = rect(out.pos, o);
      if (r.x1 < lane.near || r.x0 > lane.far) continue;  // not passed by this lane
      assert.ok(lane.y < r.y0 || lane.y > r.y1, `${b.id}'s lane at ${lane.y} crosses ${o.id}`);
    }
  }
});

test('ego: in one gap a shorter lane sits lower, so its drop to its box crosses no longer lane', () => {
  for (const side of ['left', 'right']) {
    const many = boxes(side === 'left' ? 'u' : 'd', 32);
    const out = egoLayout({ me: ME, left: side === 'left' ? many : [], right: side === 'right' ? many : [], avail: WIDE, lines: 32 });
    const lanes = [...out.lanes.entries()];
    let pairs = 0;
    for (const [a, la] of lanes) {
      for (const [b, lb] of lanes) {
        const sameGap = Math.abs(la.y - lb.y) < 20 && a !== b;
        const longer = Math.abs(lb.far - lb.near) > Math.abs(la.far - la.near);
        if (!sameGap || !longer) continue;
        pairs++;
        assert.ok(lb.y < la.y, `${side}: ${b}'s longer lane (y ${lb.y}) must sit above ${a}'s (y ${la.y})`);
        assert.ok(out.pos.get(a).y > la.y, 'the box is below its lane');
      }
    }
    assert.ok(pairs > 0, `${side}: some gap holds more than one lane`);
  }
});

test('ego: a box name grows only as far as it fits one line', () => {
  assert.equal(egoNameFit(200, 60), 1.3, 'a short name grows the full amount');
  assert.ok(Math.abs(egoNameFit(200, 160) * 160 - (200 - 26)) < 1e-9, 'a longer name stops where the box ends');
  assert.equal(egoNameFit(200, 400), 1, 'a name already too long does not shrink below its size');
  assert.equal(egoNameFit(256, 0), 1.3);
});

test('ego: users wrap leftward the same way, lanes mirrored', () => {
  const left = boxes('u', 15);
  const out = egoLayout({ me: ME, left, right: boxes('d', 2), avail: WIDE, lines: 17 });
  const me = out.pos.get('me');
  for (const b of left) assert.ok(out.pos.get(b.id).x + b.w < me.x);
  assert.ok(out.lanes.size > 0);
  for (const [id, lane] of out.lanes) {
    assert.ok(id.startsWith('u'));
    assert.ok(lane.near > lane.far, 'on the left the near end is the right end');
    assert.ok(lane.far > out.pos.get(id).x + 200, 'the lane ends right of its box');
  }
});

test('ego: a tall narrow window still fits one column; never more than the column cap', () => {
  const out = egoLayout({ me: ME, left: [], right: boxes('d', 6), avail: { w: 1030, h: 900 }, lines: 6 });
  assert.equal(out.lanes.size, 0);
  const many = egoLayout({ me: ME, left: [], right: boxes('d', 80), avail: { w: 3000, h: 200 }, lines: 80 });
  assert.equal(new Set(boxes('d', 80).map((b) => many.pos.get(b.id).x)).size, EGO_MAX_COLS);
});

test('ego: words on the lines only up to the line limit', () => {
  assert.equal(egoLayout({ me: ME, left: [], right: boxes('d', 3), avail: WIDE, lines: EGO_LABEL_LINES }).words, true);
  assert.equal(egoLayout({ me: ME, left: [], right: boxes('d', 3), avail: WIDE, lines: EGO_LABEL_LINES + 1 }).words, false);
});

test('ego: a lane path runs middle -> lane -> partner, and the other way when the partner is the user', () => {
  const lane = { y: 100, near: 400, far: 700 };
  const fwd = egoLanePath({ x: 300, y: 200 }, { x: 760, y: 130 }, lane, false);
  assert.match(fwd, /^M300,200 C.* 400,100 L700,100 C.* 760,130$/);
  const back = egoLanePath({ x: 300, y: 200 }, { x: 760, y: 130 }, lane, true);
  assert.match(back, /^M760,130 C.* 700,100 L400,100 C.* 300,200$/);
  const left = egoLanePath({ x: 500, y: 200 }, { x: 40, y: 130 }, { y: 100, near: 280, far: 120 }, true);
  const [, firstCtrl] = left.match(/^M40,130 C(\d+),130 /) || [];
  assert.ok(Number(firstCtrl) > 40, `a left partner's line starts rightward: ${left}`);
  assert.match(left, / L280,100 C.* 500,200$/);
});
