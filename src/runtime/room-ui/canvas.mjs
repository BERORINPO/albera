// The room canvas (spec/room.md §5, part A): a dotted desk that pans and zooms, nodes placed in world px,
// a smooth look-at, wires that draw themselves, and a free-spot finder that never lands on a camera.
// The math at the top is pure (no DOM) so it can be tested in Node; createCanvas() is the only DOM part.

export const DOT_GAP = 22;
export const LOOK_MS = 1600;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2.5;
export const SPOT_GAP = 28;
export const TONES = Object.freeze(['me', 'work', 'wait', 'done']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const DRAG_SLOP = 3;

export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number.isFinite(z) ? z : 1));

/** The world transform that puts world point (x, y) in the middle of a viewport of size vw x vh at zoom z. */
export function lookTransform({ x, y, zoom = 1 }, vw, vh) {
  const z = clampZoom(zoom);
  return { tx: vw / 2 - x * z, ty: vh / 2 - y * z, z };
}

/** Zoom around a screen point (sx, sy) so the world point under it stays put. */
export function zoomAround(view, sx, sy, nextZoom) {
  const z = clampZoom(nextZoom);
  const wx = (sx - view.tx) / view.z;
  const wy = (sy - view.ty) / view.z;
  return { tx: sx - wx * z, ty: sy - wy * z, z };
}

/** The smallest rect that holds every rect, or null for none. */
export function boundsOf(rects) {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

/** Where to look so every rect fits in the viewport with some padding (zoom never above 1). */
export function fitAll(rects, vw, vh, pad = 60) {
  const b = boundsOf(rects);
  if (!b) return { x: vw / 2, y: vh / 2, zoom: 1 };
  const zoom = clampZoom(Math.min(1, (vw - pad * 2) / Math.max(1, b.w), (vh - pad * 2) / Math.max(1, b.h)));
  return { x: b.x + b.w / 2, y: b.y + b.h / 2, zoom };
}

export const overlaps = (a, b, gap = 0) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/**
 * An empty place for a w x h box beside `near`: right, below, left, above, then rings further out.
 * Never over any rect in `blocked` (cameras); also avoids `soft` rects (other nodes) when it can.
 */
export function findFreeSpot(near, { w, h }, blocked, soft = [], gap = SPOT_GAP) {
  const base = near ?? boundsOf(blocked) ?? { x: 0, y: 0, w: 0, h: 0 };
  const candidates = [];
  for (let ring = 0; ring < 12; ring++) {
    const d = gap + ring * (gap + Math.max(w, h) / 2);
    candidates.push(
      { x: base.x + base.w + d, y: base.y },
      { x: base.x, y: base.y + base.h + d },
      { x: base.x - w - d, y: base.y },
      { x: base.x, y: base.y - h - d },
      { x: base.x + base.w + d, y: base.y + base.h + d },
      { x: base.x - w - d, y: base.y + base.h + d },
    );
  }
  const fits = (c, list) => list.every((r) => !overlaps({ ...c, w, h }, r, gap / 2));
  const clean = candidates.find((c) => fits(c, [...blocked, ...soft]));
  if (clean) return clean;
  const hard = candidates.find((c) => fits(c, blocked));
  if (hard) return hard;
  const all = boundsOf(blocked) ?? base; // last resort: to the right of everything
  return { x: all.x + all.w + gap, y: all.y };
}

/** A soft S-curve from the edge of rect a that faces b to the edge of b that faces a. */
export function wirePath(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  if (Math.abs(bc.x - ac.x) >= Math.abs(bc.y - ac.y)) {
    const dir = bc.x >= ac.x ? 1 : -1;
    const p = { x: ac.x + (dir * a.w) / 2, y: ac.y };
    const q = { x: bc.x - (dir * b.w) / 2, y: bc.y };
    const mx = (p.x + q.x) / 2;
    return `M${p.x} ${p.y} C${mx} ${p.y}, ${mx} ${q.y}, ${q.x} ${q.y}`;
  }
  const dir = bc.y >= ac.y ? 1 : -1;
  const p = { x: ac.x, y: ac.y + (dir * a.h) / 2 };
  const q = { x: bc.x, y: bc.y - (dir * b.h) / 2 };
  const my = (p.y + q.y) / 2;
  return `M${p.x} ${p.y} C${p.x} ${my}, ${q.x} ${my}, ${q.x} ${q.y}`;
}

const isCamera = (nodeId) => nodeId.startsWith('cam:');

/** The canvas. viewportEl is the clipping box; the world inside it pans / zooms. */
export function createCanvas(viewportEl) {
  const doc = viewportEl.ownerDocument;
  const world = doc.createElement('div');
  world.className = 'world';
  const wires = doc.createElementNS(SVG_NS, 'svg');
  wires.setAttribute('class', 'wires');
  wires.setAttribute('aria-hidden', 'true');
  world.append(wires);
  viewportEl.classList.add('desk');
  viewportEl.append(world);

  const nodes = new Map(); // nodeId -> { el, x, y }
  const lines = new Set(); // { from, to, path, remove }
  let view = { tx: 0, ty: 0, z: 1 };
  let settleTimer;

  function apply(smooth) {
    viewportEl.classList.toggle('gliding', smooth);
    world.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.z})`;
    viewportEl.style.backgroundSize = `${DOT_GAP * view.z}px ${DOT_GAP * view.z}px`;
    viewportEl.style.backgroundPosition = `${view.tx}px ${view.ty}px`;
    clearTimeout(settleTimer);
    if (smooth) settleTimer = setTimeout(() => viewportEl.classList.remove('gliding'), LOOK_MS);
  }

  function rectOf(nodeId) {
    const n = nodes.get(nodeId);
    if (!n) return null;
    return { x: n.x, y: n.y, w: n.el.offsetWidth, h: n.el.offsetHeight };
  }

  function route(line) {
    const a = rectOf(line.from);
    const b = rectOf(line.to);
    if (a && b) line.path.setAttribute('d', wirePath(a, b));
  }

  function place(nodeId, el, { x, y }) {
    const prev = nodes.get(nodeId);
    if (prev && prev.el !== el) prev.el.remove();
    el.classList.add('node');
    el.dataset.node = nodeId;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (el.parentNode !== world) world.append(el);
    nodes.set(nodeId, { el, x, y });
    for (const line of lines) if (line.from === nodeId || line.to === nodeId) route(line);
  }

  function remove(nodeId) {
    const n = nodes.get(nodeId);
    if (!n) return;
    n.el.remove();
    nodes.delete(nodeId);
    for (const line of [...lines]) if (line.from === nodeId || line.to === nodeId) line.remove();
  }

  function lookAt({ x, y, zoom = 1 }) {
    view = lookTransform({ x, y, zoom }, viewportEl.clientWidth, viewportEl.clientHeight);
    apply(true);
  }

  function lookAll() {
    const rects = [...nodes.keys()].map(rectOf).filter(Boolean);
    lookAt(fitAll(rects, viewportEl.clientWidth, viewportEl.clientHeight));
  }

  function wire(fromNodeId, toNodeId, { dashed = false, tone = 'me' } = {}) {
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', `wire tone-${TONES.includes(tone) ? tone : 'me'}`);
    wires.append(path);
    const line = { from: fromNodeId, to: toNodeId, path, remove() { lines.delete(line); path.remove(); } };
    lines.add(line);
    route(line);
    // Draw itself: hide the whole stroke behind its own dash, then slide the dash in.
    const length = path.getAttribute('d') ? path.getTotalLength() : 0;
    path.style.strokeDasharray = `${length}`;
    path.style.strokeDashoffset = `${length}`;
    requestAnimationFrame(() => requestAnimationFrame(() => { path.style.strokeDashoffset = '0'; }));
    if (dashed) path.addEventListener('transitionend', () => { path.style.strokeDasharray = '6 6'; }, { once: true });
    return { remove: line.remove };
  }

  function freeSpot(nearNodeId, { w, h }) {
    const ids = [...nodes.keys()];
    const blocked = ids.filter(isCamera).map(rectOf);
    const soft = ids.filter((id) => !isCamera(id) && id !== 'bero').map(rectOf);
    return findFreeSpot(rectOf(nearNodeId), { w, h }, blocked, soft);
  }

  // Pan: drag on empty desk (not on a node). Wheel: zoom around the pointer (pinch arrives as ctrl+wheel).
  let drag = null;
  viewportEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('.node')) return;
    drag = { id: event.pointerId, sx: event.clientX, sy: event.clientY, tx: view.tx, ty: view.ty, moved: false };
  });
  viewportEl.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.sx;
    const dy = event.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    if (!drag.moved) {
      drag.moved = true;
      viewportEl.setPointerCapture(drag.id);
      viewportEl.classList.add('panning');
    }
    view = { ...view, tx: drag.tx + dx, ty: drag.ty + dy };
    apply(false);
  });
  const endDrag = () => { drag = null; viewportEl.classList.remove('panning'); };
  viewportEl.addEventListener('pointerup', endDrag);
  viewportEl.addEventListener('pointercancel', endDrag);
  viewportEl.addEventListener('wheel', (event) => {
    event.preventDefault();
    const box = viewportEl.getBoundingClientRect();
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
    view = zoomAround(view, event.clientX - box.left, event.clientY - box.top, view.z * factor);
    apply(false);
  }, { passive: false });

  apply(false);
  return { world, place, remove, rectOf, lookAt, lookAll, wire, freeSpot };
}
