// Place boxes in columns (entry / adapter / core / shared / outside) and order them to cut crossings.
import { COLUMNS, COLUMN_NAMES } from '../shared/map-shape.mjs';

export const GEOMETRY = Object.freeze({
  boxW: 200, outsideW: 256, boxH: 58, rowH: 80, subGap: 22, colGap: 110, padX: 32, top: 72, bottom: 80,
  minRows: 4, maxRows: 14,
  // The map is drawn across the whole window (about 1520 x 860), so aim for that shape instead of a tall block.
  aspect: 1.75,
});
const SWEEPS = 6;

const byLabel = (a, b) => a.label.localeCompare(b.label, 'ja') || a.id.localeCompare(b.id);

/** Order boxes inside each column by the mean rank of their neighbours (barycentre sweeps). */
export function orderColumns(boxes, edges) {
  const cols = COLUMNS.map((c) => boxes.filter((b) => b.column === c).sort(byLabel));
  const neighbours = new Map(boxes.map((b) => [b.id, []]));
  for (const e of edges) {
    neighbours.get(e.from)?.push(e.to);
    neighbours.get(e.to)?.push(e.from);
  }
  const rankOf = new Map();
  const updateRanks = () => cols.forEach((col) => col.forEach((b, i) => rankOf.set(b.id, (i + 0.5) / col.length)));
  updateRanks();
  for (let s = 0; s < SWEEPS; s++) {
    const order = s % 2 === 0 ? cols.keys() : [...cols.keys()].reverse();
    for (const ci of order) {
      const col = cols[ci];
      const key = new Map(col.map((b) => {
        const ns = neighbours.get(b.id).filter((n) => !col.some((x) => x.id === n));
        const k = ns.length ? ns.reduce((sum, n) => sum + rankOf.get(n), 0) / ns.length : rankOf.get(b.id);
        return [b.id, k];
      }));
      cols[ci] = [...col].sort((a, b) => key.get(a.id) - key.get(b.id) || byLabel(a, b));
      updateRanks();
    }
  }
  return cols;
}

function place(cols, maxRows) {
  const g = GEOMETRY;
  const rowsUsed = Math.max(1, ...cols.map((c) => Math.min(maxRows, c.length)));
  const contentH = rowsUsed * g.rowH;
  const placed = [];
  const columns = [];
  let x = g.padX;
  cols.forEach((col, ci) => {
    if (!col.length) return;
    // Outside names are longer sentences ("お客さん側の Worker (shop-api)"), so that column is wider.
    const boxW = COLUMNS[ci] === 'outside' ? g.outsideW : g.boxW;
    const subW = boxW + g.subGap;
    const subs = Math.ceil(col.length / maxRows);
    const rows = Math.ceil(col.length / subs);
    const yOffset = g.top + (contentH - rows * g.rowH) / 2;
    col.forEach((b, i) => {
      placed.push({ ...b, x: x + Math.floor(i / rows) * subW, y: yOffset + (i % rows) * g.rowH, w: boxW, h: g.boxH });
    });
    const frameW = (subs - 1) * subW + boxW + 28;
    columns.push({
      id: COLUMNS[ci], name: COLUMN_NAMES[COLUMNS[ci]],
      x: x - 14, y: yOffset - 30, w: frameW, h: rows * g.rowH - (g.rowH - g.boxH) + 44,
    });
    x += (subs - 1) * subW + boxW + g.colGap;
  });
  const world = { w: x - g.colGap + g.padX, h: g.top + contentH + g.bottom };
  return { boxes: placed, columns, world };
}

/**
 * Give every box x / y / w / h, and build the column frames.
 * Tries each row limit and keeps the one whose overall shape is closest to the window's,
 * so the map fills the screen instead of leaving wide empty margins.
 * @returns {{ boxes: object[], columns: object[], world: {w,h} }}
 */
export function layout(boxes, edges) {
  const g = GEOMETRY;
  const cols = orderColumns(boxes, edges);
  let best = null;
  for (let rows = g.minRows; rows <= g.maxRows; rows++) {
    const r = place(cols, rows);
    const miss = Math.abs(Math.log((r.world.w / r.world.h) / g.aspect));
    if (!best || miss < best.miss - 1e-9) best = { miss, r };
  }
  return best.r;
}

/**
 * Feature rows: one row per feature name, one column per role.
 * The same feature in entry / adapter / core / shared sits on one line, so most lines run straight across.
 * Outside boxes go to the right, each as close as possible to the rows it talks to.
 * @returns {{ pos: Record<string,{x:number,y:number}>, columns: object[], rows: object[], world: {w,h} }}
 */
export function layoutByFeature(boxes, edges) {
  const g = GEOMETRY;
  const rowH = g.boxH + 26;
  const labelW = 170;
  const inner = boxes.filter((b) => b.column !== 'outside');
  const outside = boxes.filter((b) => b.column === 'outside');
  const byId = new Map(boxes.map((b) => [b.id, b]));

  // Rows: features with today's changes first, then the busiest, then by name.
  const names = [...new Set(inner.map((b) => b.label))];
  const weight = new Map(names.map((n) => [n, 0]));
  for (const e of edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (a && a.column !== 'outside') weight.set(a.label, weight.get(a.label) + e.count);
    if (b && b.column !== 'outside') weight.set(b.label, weight.get(b.label) + e.count);
  }
  const changed = new Set(inner.filter((b) => b.status).map((b) => b.label));
  names.sort((p, q) => (changed.has(q) - changed.has(p)) || weight.get(q) - weight.get(p) || p.localeCompare(q, 'ja'));
  const rowOf = new Map(names.map((n, i) => [n, i]));

  // Outside boxes: aim at the mean row of their partners, then take the nearest free slot in two sub-columns.
  const target = (o) => {
    const rows = edges.flatMap((e) => (e.to === o.id ? [e.from] : e.from === o.id ? [e.to] : []))
      .map((id) => byId.get(id)).filter((b) => b && b.column !== 'outside').map((b) => rowOf.get(b.label));
    return rows.length ? rows.reduce((s, r) => s + r, 0) / rows.length : names.length / 2;
  };
  const slotsPerSub = Math.max(names.length, Math.ceil(outside.length / 2));
  const taken = new Set();
  const outsideSlot = new Map();
  const order = outside.map((o) => ({ o, t: target(o) })).sort((p, q) => p.t - q.t || p.o.label.localeCompare(q.o.label, 'ja'));
  for (const { o, t } of order) {
    const cands = [];
    for (let s = 0; s < slotsPerSub; s++) for (const sub of [0, 1]) cands.push({ s, sub, d: Math.abs(s - t) + sub * 0.01 });
    cands.sort((p, q) => p.d - q.d);
    const pick = cands.find((c) => !taken.has(`${c.s}:${c.sub}`));
    taken.add(`${pick.s}:${pick.sub}`);
    outsideSlot.set(o.id, pick);
  }

  const rowsUsed = Math.max(names.length, outside.length ? slotsPerSub : 0);
  const pos = {};
  const columns = [];
  let x = g.padX + labelW;
  for (const col of COLUMNS) {
    const here = boxes.filter((b) => b.column === col);
    if (!here.length) continue;
    const isOut = col === 'outside';
    const boxW = isOut ? g.outsideW : g.boxW;
    const subs = isOut && outside.length > 1 ? 2 : 1;
    for (const b of here) {
      if (isOut) {
        const { s, sub } = outsideSlot.get(b.id);
        pos[b.id] = { x: x + sub * (boxW + g.subGap), y: g.top + s * rowH };
      } else {
        pos[b.id] = { x, y: g.top + rowOf.get(b.label) * rowH };
      }
    }
    const frameW = (subs - 1) * (boxW + g.subGap) + boxW + 28;
    columns.push({ id: col, name: COLUMN_NAMES[col], x: x - 14, y: g.top - 30, w: frameW, h: rowsUsed * rowH - (rowH - g.boxH) + 44 });
    x += frameW - 28 + g.colGap;
  }
  const worldW = x - g.colGap + g.padX;
  const rows = names.map((name, i) => ({ name, y: g.top + i * rowH - 13, h: rowH, changed: changed.has(name) }));
  return { pos, columns, rows, world: { w: worldW, h: g.top + rowsUsed * rowH + g.bottom } };
}
