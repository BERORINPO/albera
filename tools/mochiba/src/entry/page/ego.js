// "つながりだけ" arrangement: the chosen box in the middle, what uses it on the left, what it uses on the right.
// Pure (no DOM, no clock): test/ego.test.mjs evaluates this file on its own.
//
// A box with many partners used to stack them in one tall column, and the map shrank to 25-30% to fit it.
// Partners now wrap into up to EGO_MAX_COLS columns per side; the row count is the one that lets the whole
// arrangement show largest in the space given. A line to a box past the first column runs along the gap
// between two rows of the nearer columns (its "lane"), so it does not cross those boxes.

const EGO_ROW = 86;          // one row: box plus the gap a lane runs in
const EGO_COL_GAP = 70;      // between two columns on one side
const EGO_GAP_WORDS = 300;   // between the middle and the first column when lines carry words
const EGO_GAP_PLAIN = 170;   // the same, when there are too many lines for words
const EGO_MAX_COLS = 4;
const EGO_LABEL_LINES = 12;  // more lines than this: no words on them (the side panel lists them)
const EGO_LANE_PAD = 22;     // a lane starts and ends this far outside the columns it passes
const EGO_LANE_STEP = 8;     // lanes in one gap sit this far apart
const EGO_TOP = 80, EGO_LEFT = 60;
const EGO_FIT_MAX = 1.15;    // the map never zooms in past this to fit
const EGO_NAME_GROW = 1.3;   // box names grow up to this much when the arrangement is shown small
const EGO_NAME_PAD = 26;     // box padding and border either side of the name

/** Split ids into columns of `rows` (top to bottom, then the next column outward). */
function egoColumns(items, rows) {
  const cols = [];
  for (let i = 0; i < items.length; i += rows) cols.push(items.slice(i, i + rows));
  return cols;
}

const egoColWidth = (col) => Math.max(...col.map((b) => b.w));
const egoSideWidth = (cols) => cols.reduce((sum, col) => sum + egoColWidth(col), 0) + Math.max(0, cols.length - 1) * EGO_COL_GAP;

/** Width and height of the whole arrangement for a given row count. */
function egoSize(me, left, right, rows, gap) {
  const L = egoColumns(left, rows), R = egoColumns(right, rows);
  const w = (L.length ? egoSideWidth(L) + gap : 0) + me.w + (R.length ? gap + egoSideWidth(R) : 0);
  const h = Math.max(Math.min(left.length, rows), Math.min(right.length, rows), 1) * EGO_ROW;
  return { w, h };
}

/** The row count that shows the arrangement largest in `avail`; on a tie, fewer columns. */
function egoRows(me, left, right, avail, gap) {
  const n = Math.max(left.length, right.length, 1);
  let best = n, bestScale = -1;
  for (let rows = n; rows >= Math.max(1, Math.ceil(n / EGO_MAX_COLS)); rows--) {
    const { w, h } = egoSize(me, left, right, rows, gap);
    const scale = Math.min(EGO_FIT_MAX, avail.w / w, avail.h / h);
    if (scale > bestScale + 1e-9) { best = rows; bestScale = scale; }
  }
  return best;
}

/**
 * Positions for the chosen box and its partners, and a lane for each partner past the first column.
 * @param {{me:{id:string,w:number,h:number}, left:{id:string,w:number,h:number}[], right:{id:string,w:number,h:number}[],
 *   avail:{w:number,h:number}, lines:number}} input  left / right in display order; avail = room on screen (px)
 * @returns {{pos:Map<string,{x:number,y:number}>, lanes:Map<string,{y:number,near:number,far:number}>, rows:number, words:boolean}}
 *   lane.near is the end next to the middle box, lane.far the end next to the partner
 */
function egoLayout({ me, left, right, avail, lines }) {
  const words = lines <= EGO_LABEL_LINES;
  const gap = words ? EGO_GAP_WORDS : EGO_GAP_PLAIN;
  const rows = egoRows(me, left, right, avail, gap);
  const tall = Math.max(Math.min(left.length, rows), Math.min(right.length, rows), 1) * EGO_ROW;
  const cy = EGO_TOP + tall / 2;
  const pos = new Map(), lanes = new Map();

  const L = egoColumns(left, rows), R = egoColumns(right, rows);
  let x = EGO_LEFT;
  const leftX = [];   // left columns, nearest first
  for (let k = L.length - 1; k >= 0; k--) { leftX[k] = x; x += egoColWidth(L[k]) + (k ? EGO_COL_GAP : gap); }
  const mx = x;
  pos.set(me.id, { x: mx, y: cy - me.h / 2 });
  x = mx + me.w + gap;
  const rightX = [];
  for (let k = 0; k < R.length; k++) { rightX[k] = x; x += egoColWidth(R[k]) + EGO_COL_GAP; }

  const place = (cols, colX, side) => {
    const multi = cols.length > 1;
    // One column: centred on the middle box. Several: one shared row grid, so lanes line up with the gaps.
    const top = cy - (multi ? rows : cols[0] ? cols[0].length : 0) * EGO_ROW / 2;
    cols.forEach((col, k) => {
      const cw = egoColWidth(col);
      const first = multi ? Math.floor((rows - col.length) / 2) : 0;
      col.forEach((b, i) => {
        const r = first + i;
        const bx = side > 0 ? colX[k] : colX[k] + cw - b.w;   // left side boxes hug the middle
        pos.set(b.id, { x: bx, y: top + r * EGO_ROW + (EGO_ROW - b.h) / 2 });
        if (k === 0) return;
        // The lane runs in the gap above row r, past every nearer column. A shorter lane sits lower (nearer the
        // row it drops into), so its drop to the box never crosses the longer lanes in the same gap.
        const y = top + r * EGO_ROW + ((cols.length - 2) / 2 - (k - 1)) * EGO_LANE_STEP;
        const nearEdge = side > 0 ? colX[0] - EGO_LANE_PAD : colX[0] + egoColWidth(cols[0]) + EGO_LANE_PAD;
        const farEdge = side > 0 ? colX[k - 1] + egoColWidth(cols[k - 1]) + EGO_LANE_PAD : colX[k - 1] - EGO_LANE_PAD;
        lanes.set(b.id, { y, near: nearEdge, far: farEdge });
      });
    });
  };
  place(L, leftX, -1);
  place(R, rightX, 1);
  return { pos, lanes, rows, words };
}

/** How much a box name may grow and still fit one line of its box. `nameWidth` is the name's width at 15px. */
function egoNameFit(boxWidth, nameWidth) {
  const room = boxWidth - EGO_NAME_PAD;
  return nameWidth > 0 ? Math.max(1, Math.min(EGO_NAME_GROW, room / nameWidth)) : EGO_NAME_GROW;
}

/**
 * SVG path for a line between the middle box and a partner that has a lane: middle -> lane -> partner,
 * or the reverse when `fromPartner` (the light runs from the side that uses).
 * @param {{x:number,y:number}} mid  the end on the middle box
 * @param {{x:number,y:number}} end  the end on the partner box
 */
function egoLanePath(mid, end, lane, fromPartner) {
  const s = end.x > mid.x ? 1 : -1;
  const k1 = Math.max(30, Math.abs(lane.near - mid.x) / 2), k2 = Math.max(14, Math.abs(end.x - lane.far) / 2);
  if (!fromPartner) {
    return `M${mid.x},${mid.y} C${mid.x + s * k1},${mid.y} ${lane.near - s * k1},${lane.y} ${lane.near},${lane.y}`
      + ` L${lane.far},${lane.y} C${lane.far + s * k2},${lane.y} ${end.x - s * k2},${end.y} ${end.x},${end.y}`;
  }
  return `M${end.x},${end.y} C${end.x - s * k2},${end.y} ${lane.far + s * k2},${lane.y} ${lane.far},${lane.y}`
    + ` L${lane.near},${lane.y} C${lane.near - s * k1},${lane.y} ${mid.x + s * k1},${mid.y} ${mid.x},${mid.y}`;
}
