// The map page: boxes, lines, pan/zoom, selection and the side panel. Joined with the other page/*.js
// into the one <script> of template.html by render.mjs (same scope, in the order of PAGE_SCRIPTS).
// ---------- helpers (DOM only; data is never parsed as HTML) ----------
const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
function svgEl(tag, attrs) { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; }

let D;
try { D = JSON.parse($('map-data').textContent); } catch (err) { D = null; }
if (!D || !Array.isArray(D.boxes)) {
  document.body.replaceChildren(h('div', { class: 'broken', text: '地図のデータが読めない。node src/entry/cli.mjs map <フォルダ> で書き出し直す' }));
  throw new Error('map data missing');
}

const COLUMN_NAMES = Object.fromEntries((D.columns || []).map((c) => [c.id, c.name]));
const BOX = new Map(D.boxes.map((b) => [b.id, b]));
const EDGE = D.edges;
const STATUS_TEXT = { new: '新', changed: '変更' };
const fmtDay = (d) => (d && d.length >= 10 ? `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日` : '');
const fmtWhen = (iso) => (iso ? `${iso.slice(5, 10).replace('-', '/')} ${iso.slice(11, 16)}` : '');
const isWin = /^[A-Za-z]:\//.test(D.root);
const absPath = (rel) => `${D.root}/${rel}`;
const osPath = (rel) => (isWin ? absPath(rel).replace(/\//g, '\\') : absPath(rel));
// Encode each path segment ("#" and "?" in a file name must not end the path); keep the drive "C:" as is.
const encodeSegment = (s) => (/^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s));
const vscodeHref = (rel) => `vscode://file/${absPath(rel).replace(/^\//, '').split('/').map(encodeSegment).join('/')}`;
const changedFiles = (b) => b.files.filter((f) => f.status);
const changesOf = (b) => { const set = new Set(b.files.map((f) => f.path)); return D.changes.filter((c) => c.files.some((f) => set.has(f.path))); };

// ---------- header and today band ----------
$('proj').textContent = D.title;
const lit = D.boxes.filter((b) => b.status).sort((a, b) => b.lines - a.lines || a.label.localeCompare(b.label, 'ja'));
$('summary').textContent = `${fmtDay(D.since)} から ・ 変わった箱 ${lit.length} ・ commit ${D.changes.length}`;
$('gitline').textContent = D.lastCommit ? `最後の commit ${fmtWhen(D.lastCommit.date)} ・ ${D.lastCommit.subject}` : 'commit なし';
$('gitline').title = $('gitline').textContent;
if (D.today.length) {
  D.today.forEach((id, i) => {
    const b = BOX.get(id);
    $('today').append(h('button', { class: 'look', type: 'button', dataset: { look: id }, onclick: () => select(id) },
      h('span', { class: 'look__n', text: String(i + 1) }),
      h('span', { class: 'look__what', text: `${b.label}` }),
      h('span', { class: 'look__why', text: `${COLUMN_NAMES[b.column] || ''} ・ ${STATUS_TEXT[b.status]} ・ ${b.lines} 行 ・ ${changedFiles(b).length} ファイル` })));
  });
} else {
  $('today').append(h('span', { class: 'muted', text: 'この期間に変わった箱は無い' }));
}

// ---------- map ----------
const vp = $('vp'), world = $('world'), svg = $('edges');
const frameLayer = h('div', { class: 'frames' });
world.insertBefore(frameLayer, svg);
const nodeEl = new Map();
for (const b of D.boxes) {
  const sameAsLabel = b.groups.length === 1 && b.groups[0] === b.label;
  // An outside box whose partner names are already inside its label gets the whole height for the label.
  const solo = b.column === 'outside' && !sameAsLabel && b.groups.every((g) => b.label.includes(g));
  // Keep a trailing "(...)" in one piece so "(web-api)" wraps as a whole, not at its hyphen.
  const paren = solo ? b.label.match(/^(.*\S)\s+(\([^()]+\))$/) : null;
  const labelEl = paren ? h('b', {}, `${paren[1]} `, h('span', { class: 'nb', text: paren[2] })) : h('b', { text: b.label });
  const sub = b.column === 'outside'
    ? (sameAsLabel ? '外の相手' : b.groups.join('・'))
    : `${b.files.length} ファイル${sameAsLabel ? '' : ` ・ ${b.groups.join('・')}`}`;
  const el = h('div', {
    class: `node${b.status ? ' chg' : ''}${b.column === 'outside' ? ' outside' : ''}${solo ? ' solo' : ''}`,
    role: 'button', tabindex: '0', dataset: { id: b.id }, title: solo ? b.label : `${b.label}
${sub}`,
    'aria-label': `${b.label}${b.status ? ` (${STATUS_TEXT[b.status]})` : ''}`,
    style: `width:${b.w}px;height:${b.h}px`,
  }, labelEl, solo ? null : h('span', { class: 'sub', text: sub }), h('span', { class: 'layer', text: COLUMN_NAMES[b.column] || '' }), b.status ? h('i', { class: 'badge', text: STATUS_TEXT[b.status] }) : null);
  world.append(el);
  nodeEl.set(b.id, el);
}
const labelSvg = svgEl('svg', { class: 'edges labels', 'aria-hidden': 'true' });
world.append(labelSvg);
// Each box spreads its line ends along its edge, ordered by where the other end sits,
// so a box with many lines shows a fan instead of one knot.
const PORT_SPREAD = 0.7;
function portOffsets() {
  const groups = new Map();
  const add = (key, edgeId, box, otherY) => { if (!groups.has(key)) groups.set(key, { box, items: [] }); groups.get(key).items.push({ edgeId, otherY }); };
  for (const e of EDGE) {
    const a = BOX.get(e.from), b = BOX.get(e.to);
    add(`out:${e.from}`, e.id, a, aimY(b));
    add(`in:${e.to}`, e.id, b, aimY(a));
  }
  const off = new Map();
  for (const [key, { box, items }] of groups) {
    const side = key.startsWith('out:') ? 'from' : 'to';
    items.sort((p, q) => p.otherY - q.otherY);
    const span = box.h * PORT_SPREAD, n = items.length;
    items.forEach((it, i) => {
      const o = n === 1 ? 0 : -span / 2 + (span * i) / (n - 1);
      off.set(`${side}:${it.edgeId}`, o);
    });
  }
  return off;
}
// In "つながりだけ" a partner past the first column is reached along a lane between rows (see ego.js).
let egoLanes = new Map();
const aimY = (b) => (egoLanes.has(b.id) ? egoLanes.get(b.id).y : b.y + b.h / 2);
function edgePath(a, b, oa = 0, ob = 0) {
  const lane = egoLanes.get(b.id) || egoLanes.get(a.id);
  if (lane) {
    const [m, p, om, op] = egoLanes.has(b.id) ? [a, b, oa, ob] : [b, a, ob, oa];
    const right = p.x > m.x;
    return egoLanePath({ x: right ? m.x + m.w : m.x, y: m.y + m.h / 2 + om }, { x: right ? p.x : p.x + p.w, y: p.y + p.h / 2 + op }, lane, p === a);
  }
  const ya = a.y + a.h / 2 + oa, yb = b.y + b.h / 2 + ob;
  if (b.x > a.x + a.w) { const x1 = a.x + a.w, x2 = b.x, k = Math.max(30, (x2 - x1) / 2); return `M${x1},${ya} C${x1 + k},${ya} ${x2 - k},${yb} ${x2},${yb}`; }
  if (b.x + b.w < a.x) { const x1 = a.x, x2 = b.x + b.w, k = Math.max(30, (x1 - x2) / 2); return `M${x1},${ya} C${x1 - k},${ya} ${x2 + k},${yb} ${x2},${yb}`; }
  const x1 = a.x + a.w, x2 = b.x + b.w, bend = 34 + Math.min(60, Math.abs(yb - ya) / 6);
  return `M${x1},${ya} C${x1 + bend},${ya} ${x2 + bend},${yb} ${x2},${yb}`;
}
const edgeEl = new Map();
for (const e of EDGE) {
  const sameLayer = e.kind !== 'outside' && BOX.get(e.from).column === BOX.get(e.to).column;
  const p = svgEl('path', { class: `edge${e.kind === 'outside' ? ' out' : ''}${sameLayer ? ' same' : ''}` });
  p.style.setProperty('--w', `${(1.3 + Math.min(4, Math.log2(e.count)) * 0.9).toFixed(2)}px`);
  svg.append(p);
  edgeEl.set(e.id, p);
}
function drawEdges() {
  const port = portOffsets();
  for (const e of EDGE) edgeEl.get(e.id).setAttribute('d', edgePath(BOX.get(e.from), BOX.get(e.to), port.get(`from:${e.id}`), port.get(`to:${e.id}`)));
  drawLabels();
}
// While a box is chosen, each of its lines says what it carries ("readRoster・saveRoster"), halfway along.
const LABEL_MAX = 26;
const LABEL_MIN_LINE = 90;
const LABEL_MAX_LINES = 6;
let labelIds = [];
let litIds = [];
// Set by the story mode: lines whose light runs against the arrow of the import, words to write on a line
// instead of the imported names, and lines a scene draws that the map does not have (dashed).
let backIds = new Set();
let bothIds = new Set();   // lines a scene uses in both directions: light runs both ways
let labelText = new Map();
let virtLines = [];
const pulseOn = (base, i, rev) => {
  const p = svgEl('path', { d: base.getAttribute('d'), class: `pulse${base.classList.contains('same') ? ' same' : ''}${rev ? ' rev' : ''}` });
  p.style.setProperty('--w', base.style.getPropertyValue('--w'));
  // Offset each wire so the pulses do not march in step.
  p.style.animationDelay = `${-((i * 0.37) % 1.15).toFixed(2)}s`;
  svg.append(p);
};
function drawVirt() {
  svg.querySelectorAll('.virt').forEach((t) => t.remove());
  return virtLines.map((v) => {
    const same = BOX.get(v.from).column === BOX.get(v.to).column;
    const p = svgEl('path', { class: `edge on virt${same ? ' same' : ''}`, d: edgePath(BOX.get(v.from), BOX.get(v.to)) });
    p.style.setProperty('--w', '2px');
    svg.append(p);
    return { p, say: v.say };
  });
}
function drawPulses(virt) {
  svg.querySelectorAll('.pulse').forEach((t) => t.remove());
  litIds.forEach((id, i) => {
    const base = edgeEl.get(id);
    if (!base) return;
    pulseOn(base, i, backIds.has(id));
    if (bothIds.has(id)) pulseOn(base, i + 0.5, true);
  });
  virt.forEach(({ p }, i) => pulseOn(p, litIds.length + i, false));
}
// Words on lines sit in their own layer above the boxes, on a backing, so a faded box cannot hide them.
// A spot is first sought clear of every shown box, then clear of the lit boxes only; with no spot, no label.
const LABEL_AT = [0.5, 0.38, 0.62, 0.28, 0.72, 0.2, 0.8];
const LABEL_DY = [-6, -22, 12, -38, 28];
const hitsAny = (r, list, pad) => list.some((q) => r.x < q.x + q.width + pad && q.x < r.x + r.width + pad && r.y < q.y + q.height + pad && q.y < r.y + r.height + pad);
const boxRects = (pick) => D.boxes.filter((b) => !nodeEl.get(b.id).classList.contains('gone') && pick(b)).map((b) => ({ x: b.x, y: b.y, width: b.w, height: b.h }));
function placeLabel(p, raw, placed, avoid) {
  const text = raw.length > LABEL_MAX ? `${raw.slice(0, LABEL_MAX - 1)}…` : raw;
  const len = p.getTotalLength();
  if (!text || len < LABEL_MIN_LINE) return;
  const same = p.classList.contains('same') ? ' same' : '';
  const t = svgEl('text', { class: `elabel${same}`, 'text-anchor': 'middle' });
  t.textContent = text;
  labelSvg.append(t);
  for (const boxes of avoid) {
    for (const dy of LABEL_DY) {
      for (const at of LABEL_AT) {
        const pt = p.getPointAtLength(len * at);
        t.setAttribute('x', pt.x); t.setAttribute('y', pt.y + dy);
        const b = t.getBBox(), r = { x: b.x - 5, y: b.y - 2, width: b.width + 10, height: b.height + 4 };
        if (hitsAny(r, placed, 2) || hitsAny(r, boxes, 3)) continue;
        placed.push(r);
        labelSvg.insertBefore(svgEl('rect', { class: `elabel-bg${same}`, x: r.x, y: r.y, width: r.width, height: r.height, rx: 4 }), t);
        return;
      }
    }
  }
  t.remove();
}
function drawLabels() {
  const virt = drawVirt();
  drawPulses(virt);
  labelSvg.replaceChildren();
  const placed = [];
  const lit = (b) => nodeEl.get(b.id).classList.contains('inpath') || nodeEl.get(b.id).classList.contains('sel');
  const avoid = [boxRects(() => true), boxRects(lit)];
  for (const id of labelIds) {
    const e = EDGE.find((x) => x.id === id), p = edgeEl.get(id);
    if (!e || !p) continue;
    placeLabel(p, labelText.has(id) ? labelText.get(id) : (e.names || []).join('・') + (e.more ? ` ほか ${e.more}` : ''), placed, avoid);
  }
  for (const v of virt) if (v.say) placeLabel(v.p, v.say, placed, avoid);
}
const placeNode = (b) => { const el = nodeEl.get(b.id); el.style.left = `${b.x}px`; el.style.top = `${b.y}px`; };

// ---------- two arrangements + boxes you moved by hand (kept in this browser) ----------
const LAYOUTS = D.layouts || { role: { pos: Object.fromEntries(D.boxes.map((b) => [b.id, { x: b.x, y: b.y }])), columns: D.columns, rows: [], world: D.world } };
const MODE_NAMES = { feature: '機能ごと', role: '役割ごと' };
const storeKey = (m) => `mochiba:${D.root}:${m}`;
const loadMoved = (m) => { try { const v = JSON.parse(localStorage.getItem(storeKey(m)) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (err) { return {}; } };
const saveMoved = (m, v) => { try { localStorage.setItem(storeKey(m), JSON.stringify(v)); } catch (err) { /* private mode: moves just are not kept */ } };
let mode = LAYOUTS.feature ? 'feature' : 'role';
try { const m = localStorage.getItem('mochiba:mode'); if (m && LAYOUTS[m]) mode = m; } catch (err) { /* ignore */ }
let handMoved = {};
let worldSize = { w: 0, h: 0 };
function relayout() {
  const L = LAYOUTS[mode];
  handMoved = loadMoved(mode);
  worldSize = { ...L.world };
  for (const b of D.boxes) {
    const p = handMoved[b.id] || L.pos[b.id];
    b.x = p.x; b.y = p.y;
    placeNode(b);
    worldSize.w = Math.max(worldSize.w, b.x + b.w + 40); worldSize.h = Math.max(worldSize.h, b.y + b.h + 60);
  }
  world.style.width = `${worldSize.w}px`; world.style.height = `${worldSize.h}px`;
  for (const layer of [svg, labelSvg]) { layer.setAttribute('width', worldSize.w); layer.setAttribute('height', worldSize.h); }
  const frames = [];
  for (const r of L.rows || []) {
    frames.push(h('div', { class: `band${r.changed ? ' band--chg' : ''}`, style: `top:${r.y}px;height:${r.h}px;width:${worldSize.w}px` },
      h('span', { class: 'band__name', text: r.name })));
  }
  for (const c of L.columns) {
    frames.push(h('section', { class: `frame${L.rows && L.rows.length ? ' frame--thin' : ''}`, style: `left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px` },
      h('div', { class: 'frame__name' }, c.name, h('span', { text: c.id === 'outside' ? '' : c.id }))));
  }
  frameLayer.replaceChildren(...frames);
  drawEdges();
  document.querySelectorAll('.mode button[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('reset').hidden = !Object.keys(handMoved).length;
}

// ---------- pan / zoom ----------
const view = { s: 1, x: 0, y: 0 };
const ZMIN = 0.25, ZMAX = 2;
// Words on lines grow when the map is small, so they stay readable; after a zoom they are placed again.
let lastScale = 0, relabel = 0;
function apply(anim) {
  world.classList.toggle('anim', !!anim);
  world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.s})`;
  world.classList.toggle('far', view.s < 0.7);
  world.style.setProperty('--inv', String(1 / view.s));
  $('zval').textContent = `${Math.round(view.s * 100)}%`;
  if (view.s !== lastScale) {
    lastScale = view.s;
    clearTimeout(relabel);
    if (labelIds.length || virtLines.length) relabel = setTimeout(drawLabels, 160);
  }
}
function zoomAt(f, cx, cy, anim) {
  const s = Math.min(ZMAX, Math.max(ZMIN, view.s * f));
  view.x = cx - (cx - view.x) * (s / view.s); view.y = cy - (cy - view.y) * (s / view.s); view.s = s;
  apply(anim);
}
function fitAll(anim) {
  const r = vp.getBoundingClientRect();
  view.s = Math.max(ZMIN, Math.min(1.15, (r.width - 30) / worldSize.w, (r.height - 60) / worldSize.h));
  view.x = (r.width - worldSize.w * view.s) / 2; view.y = Math.max(8, (r.height - 50 - worldSize.h * view.s) / 2);
  apply(anim);
}
function focusBoxes(ids) {
  const r = vp.getBoundingClientRect();
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const id of ids) { const b = BOX.get(id); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  const fits = (x1 - x0) * view.s < r.width - 60 && (y1 - y0) * view.s < r.height - 150;
  if (!fits) view.s = Math.max(ZMIN, Math.min(1.15, (r.width - 60) / (x1 - x0), (r.height - 150) / (y1 - y0)));
  const vx0 = -view.x / view.s, vy0 = -view.y / view.s, vx1 = vx0 + r.width / view.s, vy1 = vy0 + (r.height - 50) / view.s;
  if (!fits || x0 < vx0 || y0 < vy0 || x1 > vx1 || y1 > vy1) {
    view.x = r.width / 2 - ((x0 + x1) / 2) * view.s; view.y = (r.height - 80) / 2 - ((y0 + y1) / 2) * view.s;
  }
  apply(true);
}
vp.addEventListener('wheel', (e) => { e.preventDefault(); const r = vp.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
// Dragging empty space moves the whole map; dragging a box moves that box (and its lines follow).
let drag = null, moved = false;
vp.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button, a, .card')) return;
  const n = e.target.closest('.node');
  drag = n
    ? { box: BOX.get(n.dataset.id), x: e.clientX, y: e.clientY, bx: BOX.get(n.dataset.id).x, by: BOX.get(n.dataset.id).y }
    : { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  moved = false;
});
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!moved && Math.hypot(dx, dy) < 5) return;
  moved = true;
  if (drag.box) {
    const b = drag.box;
    b.x = Math.round(drag.bx + dx / view.s); b.y = Math.round(drag.by + dy / view.s);
    nodeEl.get(b.id).classList.add('lifted');
    egoLanes = new Map();  // a moved box leaves the row grid: plain curves from here
    placeNode(b); drawEdges();
  } else {
    vp.classList.add('dragging'); view.x = drag.vx + dx; view.y = drag.vy + dy; apply();
  }
});
window.addEventListener('pointerup', () => {
  if (drag && drag.box && moved && egoActive) nodeEl.get(drag.box.id).classList.remove('lifted');
  else if (drag && drag.box && moved) {
    const b = drag.box;
    nodeEl.get(b.id).classList.remove('lifted');
    handMoved = { ...handMoved, [b.id]: { x: b.x, y: b.y } };
    saveMoved(mode, handMoved);
    $('reset').hidden = false;
  }
  drag = null; vp.classList.remove('dragging');
});
const center = () => { const r = vp.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
$('zin').onclick = () => zoomAt(1.2, ...center(), true);
$('zout').onclick = () => zoomAt(1 / 1.2, ...center(), true);
$('zfit').onclick = () => fitAll(true);

// ---------- selection: only the box's own lines (what uses it, what it uses) ----------
// Deeper roads were tried (3 steps back) but lit up a third of the map and read as another tangle.
function roadsTo(id) {
  const on = new Set(), nodes = new Set([id]);
  for (const e of EDGE) {
    if (e.from === id) { on.add(e.id); nodes.add(e.to); }
    else if (e.to === id) { on.add(e.id); nodes.add(e.from); }
  }
  return { on, nodes };
}
// Draw lit lines last so they sit on top of the quiet ones.
const raise = (ids) => { for (const k of ids) svg.append(edgeEl.get(k)); };
// Hovering a box previews its lines without choosing it.
let peekId = null;
function peek(id) {
  if (id === peekId) return;
  peekId = id;
  const lit = id ? roadsTo(id).on : new Set();
  vp.classList.toggle('peeking', !!id && !sel);
  for (const [k, p] of edgeEl) p.classList.toggle('peek', lit.has(k));
  raise(lit);
  if (sel) raise(roadsTo(sel).on);
}
world.addEventListener('pointerover', (e) => { if (drag || storyOn || quizOn) return; const n = e.target.closest('.node'); peek(n ? n.dataset.id : null); });
world.addEventListener('pointerleave', () => peek(null));
let sel = null;
const seen = new Set();
// The side panel takes 430px, so it only shows while a box is chosen or the list is asked for.
// The rest of the time the map gets the whole width.
let listOpen = false;
const stage = document.querySelector('.stage');
const showPanel = () => stage.classList.toggle('open', !!sel || listOpen || storyOn || quizOn);
function openList(open) {
  if (storyOn) closeStory();
  if (quizOn) closeQuiz();
  listOpen = open;
  if (open && sel) { select(null); return; }
  showPanel(); renderPanel(); fitAll(true);
}
// "つながりだけ": the chosen box in the middle, what uses it on the left, what it uses on the right,
// everything else hidden. Positions here are temporary and never saved.
let egoOn = true;
try { egoOn = localStorage.getItem('mochiba:ego') !== 'off'; } catch (err) { /* ignore */ }
let egoActive = false;
let egoWords = true;
function egoPositions(id) {
  const users = [], used = [];
  let lines = 0;
  for (const e of EDGE) {
    if (e.to === id) { lines++; if (!users.includes(e.from)) users.push(e.from); }
    if (e.from === id) { lines++; if (!used.includes(e.to)) used.push(e.to); }
  }
  const left = users.filter((u) => !used.includes(u));  // both-way partners go right, once
  const byName = (a, b) => BOX.get(a).label.localeCompare(BOX.get(b).label, 'ja');
  left.sort(byName); used.sort(byName);
  const r = vp.getBoundingClientRect();
  const box = (k) => ({ id: k, w: BOX.get(k).w, h: BOX.get(k).h });
  // The room focusBoxes() fits the boxes into.
  const out = egoLayout({ me: box(id), left: left.map(box), right: used.map(box), avail: { w: r.width - 60, h: r.height - 150 }, lines });
  egoLanes = out.lanes; egoWords = out.words;
  return out.pos;
}
// Each name may grow only as far as it still fits one line of its box (measured once, at 15px).
const nameFit = new Map();
let measure = null;
function setNameFit(pos) {
  for (const id of pos.keys()) {
    if (nameFit.has(id)) continue;
    const el = nodeEl.get(id), b = BOX.get(id);
    if (!measure) {
      measure = document.createElement('canvas').getContext('2d');
      measure.font = `700 15px ${getComputedStyle(el.querySelector('b')).fontFamily}`;
    }
    nameFit.set(id, egoNameFit(b.w, measure.measureText(b.label).width));
    el.style.setProperty('--fit', nameFit.get(id).toFixed(3));
  }
}
function enterEgo(id) {
  if (egoActive) { egoLanes = new Map(); relayout(); }  // start from the real map each time
  const pos = egoPositions(id);
  let w = worldSize.w, ht = worldSize.h;
  for (const b of D.boxes) {
    const p = pos.get(b.id);
    nodeEl.get(b.id).classList.toggle('gone', !p);
    if (p) { b.x = p.x; b.y = p.y; placeNode(b); w = Math.max(w, b.x + b.w + 40); ht = Math.max(ht, b.y + b.h + 60); }
  }
  setNameFit(pos);
  // Several columns can reach past the real map: the line layers must cover them.
  for (const layer of [svg, labelSvg]) { layer.setAttribute('width', w); layer.setAttribute('height', ht); }
  world.classList.add('ego');
  egoActive = true;
  drawEdges();
}
function leaveEgo() {
  if (!egoActive) return;
  egoActive = false;
  egoLanes = new Map();
  world.classList.remove('ego');
  for (const el of nodeEl.values()) el.classList.remove('gone');
  relayout();
}
function setEgo(on) {
  egoOn = on;
  try { localStorage.setItem('mochiba:ego', on ? 'on' : 'off'); } catch (err) { /* ignore */ }
  select(sel);
}
function select(id) {
  if (storyOn) closeStory();
  if (quizOn) closeQuiz();
  sel = id && BOX.has(id) ? id : null;
  if (sel) listOpen = false;
  backIds = new Set(); bothIds = new Set(); labelText = new Map(); virtLines = [];
  showPanel();
  if (sel && egoOn) enterEgo(sel); else leaveEgo();
  $('hint').style.display = 'none';
  const road = sel ? roadsTo(sel) : { on: new Set(), nodes: new Set() };
  vp.classList.toggle('dim', !!sel);
  for (const [k, el] of nodeEl) { el.classList.toggle('sel', k === sel); el.classList.toggle('inpath', road.nodes.has(k)); }
  for (const [k, p] of edgeEl) p.classList.toggle('on', road.on.has(k));
  raise(road.on);
  // Names on the lines only help while there are few of them; past that they pile up and the panel says it better.
  litIds = [...road.on];
  labelIds = (egoActive ? egoWords : road.on.size <= LABEL_MAX_LINES) ? [...road.on] : [];
  drawLabels();
  vp.classList.toggle('peeking', false);
  if (sel) seen.add(sel);
  document.querySelectorAll('.look').forEach((b) => { b.classList.toggle('seen', seen.has(b.dataset.look) && b.dataset.look !== sel); b.classList.toggle('current', b.dataset.look === sel); });
  renderPanel();
  if (sel) focusBoxes([...road.nodes]); else fitAll(true);
}
world.addEventListener('click', (e) => { if (moved) return; const n = e.target.closest('.node'); if (n && quizOn) quizPick(n.dataset.id); else if (n) select(n.dataset.id); else if (!storyOn && !quizOn && (sel || listOpen)) { listOpen = false; select(null); } });
{
  const lb = $('listbtn');
  if (D.notices.length) { lb.classList.add('has-warn'); lb.textContent = `一覧 ・ 注意 ${D.notices.length}`; }
  lb.onclick = () => openList(!(listOpen && !sel));
}
world.addEventListener('keydown', (e) => { const n = e.target.closest('.node'); if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (quizOn) quizPick(n.dataset.id); else select(n.dataset.id); } });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { listOpen = false; select(null); }
  const t = e.target instanceof Element ? e.target : document.body;
  if ((e.key === 'f' || e.key === 'F') && sel && !t.closest('input, textarea')) setEgo(!egoOn);
});

// ---------- side panel ----------
const panel = $('panel'), opensEl = $('opens');
let tt = 0;
function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2400); }
async function copyText(text, done) {
  const shown = text.length > 120 ? `${text.slice(0, 119)}…` : text;
  try { await navigator.clipboard.writeText(text); toast(`${done}: ${shown}`); return; } catch (err) { /* fall back below */ }
  const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;left:-9999px' }); ta.value = text; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
  ta.remove();
  toast(ok ? `${done}: ${shown}` : `コピーできなかった: ${shown}`);
}
const copyPath = (rel) => copyText(osPath(rel), '場所をコピーした');
const openLink = (rel, label, cls) => h('a', { class: `btn${cls ? ` ${cls}` : ''}`, href: vscodeHref(rel), title: `VS Code で開く: ${osPath(rel)}`, text: label });
const copyBtn = (rel, label) => h('button', { type: 'button', title: osPath(rel), onclick: () => copyPath(rel), text: label });
const goBtn = (id, extra) => { const b = BOX.get(id); return h('button', { type: 'button', class: b.status ? 'is-chg' : null, onclick: () => select(id) }, b.label, h('span', { class: 'col', text: COLUMN_NAMES[b.column] }), extra ? h('span', { class: 'cnt', text: extra }) : null); };
const sec = (label, ...kids) => h('div', { class: 'sec' }, h('div', { class: 'sec__label', text: label }), ...kids);
function setOpens(...kids) { opensEl.replaceChildren(...kids.filter(Boolean)); opensEl.hidden = !opensEl.childElementCount; }

function overviewPanel() {
  setOpens();
  const kids = [
    h('div', { class: 'backs' }, h('span'), h('button', { type: 'button', class: 'back', onclick: () => openList(false), text: '閉じる ×' })),
    h('div', { class: 'kicker', text: `${D.title} ・ ${fmtDay(D.since)} から` }),
    h('h2', { text: 'この期間に変わった所' }),
    h('div', { class: 'muted', text: '押すと、中のファイル・commit と PR・つながる箱が出る' }),
    ...D.notices.map((n) => h('div', { class: 'warn', text: n })),
  ];
  if (lit.length) {
    kids.push(h('div', { class: 'list' }, lit.map((b) => {
      const latest = changesOf(b)[0];
      return h('button', { type: 'button', class: 'item', onclick: () => select(b.id) },
        h('b', {}, h('i', { class: 'dotc' }), b.label, h('small', { text: COLUMN_NAMES[b.column] })),
        h('span', { text: `${STATUS_TEXT[b.status]} ・ ${b.lines} 行 ・ ${changedFiles(b).length} ファイル${latest ? ` ・ ${latest.subject}` : ''}` }));
    })));
  } else {
    kids.push(h('p', { class: 'muted', text: `${fmtDay(D.since)} から後に変わった箱は無い。--since を広げると前の変更も光る` }));
  }
  kids.push(h('div', { class: 'tag note', text: '箱と線は spec/architecture.md の表と import から作った。AI は使っていない' }));
  kids.push(h('div', { class: 'muted note', text: `書き出した日時 ${fmtWhen(D.generatedAt)} ・ 箱 ${D.boxes.length} ・ 線 ${D.edges.length}` }));
  panel.replaceChildren(...kids);
}

function filesSection(b) {
  const files = [...b.files].sort((x, y) => (y.status ? 1 : 0) - (x.status ? 1 : 0) || y.lines - x.lines || x.path.localeCompare(y.path));
  return sec(`中のファイル (${files.length})`, h('ul', { class: 'files' }, files.map((f) => h('li', { class: f.status ? 'is-chg' : null },
    h('span', { class: 'name' },
      f.status ? h('span', { class: 'mark', text: `● ${STATUS_TEXT[f.status]}${f.lines ? ` ・ ${f.lines} 行` : ''}` }) : null,
      h('span', { class: 'path', text: f.path })),
    h('span', { class: 'acts' }, openLink(f.path, '開く'), copyBtn(f.path, '場所をコピー'))))));
}

function prCard(n, commits) {
  const pr = D.prs[n];
  const list = h('ul', { class: 'commits' }, commits.map((c) => h('li', {}, h('span', { class: 'when', text: `${fmtWhen(c.date)} ` }), c.subject, h('span', { class: 'hash', text: ` ${c.short}` }))));
  const story = storyByPr(n);
  const go = story ? h('button', { type: 'button', class: 'storygo', onclick: () => openStory(story.key, 0), text: `紙芝居で見る (${story.steps.length} コマ)` }) : null;
  if (n === null) return h('div', { class: 'pr' }, h('div', { class: 'pr__title', text: 'PR を通っていない commit' }), go, list);
  if (!pr || pr.missing) {
    return h('div', { class: 'pr' }, h('div', { class: 'pr__title', text: `#${n}` }), go, h('div', { class: 'pr__why muted', text: `PR の説明は取れなかった (${pr ? pr.reason : 'gh 失敗'})` }), list);
  }
  const title = pr.url ? h('a', { href: pr.url, target: '_blank', rel: 'noopener noreferrer', text: `#${n} ${pr.title}` }) : `#${n} ${pr.title}`;
  return h('div', { class: 'pr' }, h('div', { class: 'pr__title' }, title), go,
    pr.reason ? h('div', { class: 'pr__why', text: `理由: ${pr.reason}` }) : h('div', { class: 'pr__why muted', text: '理由: PR の本文が空' }),
    h('span', { class: `ci ci--${pr.ci.state}`, text: pr.ci.text }), list);
}

function changesSection(b) {
  const commits = changesOf(b);
  if (!commits.length) return sec('この期間の commit と PR', h('div', { class: 'muted', text: 'この期間の commit は無い' }));
  const groups = new Map();
  for (const c of commits) groups.set(c.pr, [...(groups.get(c.pr) || []), c]);
  return sec(`この期間の commit と PR (${commits.length})`, [...groups].map(([n, cs]) => prCard(n, cs)));
}

// One line per connection, written as a sentence: "<this> が <that> の readRoster・saveRoster を使う".
const whatOf = (e) => `${(e.names || []).join('・')}${e.more ? ` ほか ${e.more}` : ''}`;
function linkRow(e, outward) {
  const other = BOX.get(outward ? e.to : e.from);
  const what = whatOf(e);
  const sentence = e.kind === 'outside'
    ? `${what || 'やり取り'}`
    : outward ? `使う: ${what || '中身'}` : `向こうが使う: ${what || '中身'}`;
  return h('li', { class: `link${e.kind === 'outside' ? ' link--out' : ''}` },
    h('span', { class: 'link__arrow', text: outward ? '→' : '←' }),
    h('span', { class: 'link__body' }, goBtn(other.id), h('span', { class: 'link__what', text: sentence })));
}
function linksSection(b) {
  const out = EDGE.filter((e) => e.from === b.id), inn = EDGE.filter((e) => e.to === b.id);
  return [
    sec(`この箱が使う物 → (${out.length})`, out.length ? h('ul', { class: 'links' }, out.map((e) => linkRow(e, true))) : h('p', { class: 'muted', text: '無し' })),
    sec(`← この箱を使う物 (${inn.length})`, inn.length ? h('ul', { class: 'links' }, inn.map((e) => linkRow(e, false))) : h('p', { class: 'muted', text: '無し' })),
  ];
}

function boxPanel(b) {
  const kicker = b.status
    ? `${COLUMN_NAMES[b.column]} ・ ${b.status === 'new' ? '新しいファイルが増えた' : '変わった'} ・ ${b.lines} 行`
    : `${COLUMN_NAMES[b.column]} ・ この期間は変わっていない`;
  const kids = [
    h('div', { class: 'backs' },
      h('button', { type: 'button', class: 'back', onclick: () => openList(true), text: '← 変わった所の一覧へ' }),
      h('button', { type: 'button', class: 'back', onclick: () => { listOpen = false; select(null); }, text: '閉じる ×' })),
    h('button', { type: 'button', class: 'egobtn', 'aria-pressed': String(egoOn), title: 'F キーでも切り替わる', onclick: () => setEgo(!egoOn),
      text: egoOn ? 'つながりだけ表示中 (押すと地図全体に戻る)' : '地図全体で表示中 (押すとつながりだけにする)' }),
    h('div', { class: `kicker${b.status ? ' chg' : ''}`, text: kicker }),
    h('h2', { text: b.label }),
    h('div', { class: 'file', text: b.groups.join(' ・ ') }),
  ];
  if (b.column === 'outside') {
    kids.push(sec('相手 (spec/architecture.md の外部境界表)', h('ul', { class: 'commits' }, b.partners.map((p) => h('li', { text: p })))));
    kids.push(...linksSection(b));
    setOpens();
  } else {
    kids.push(changesSection(b), ...linksSection(b), filesSection(b));
    const top = [...b.files].sort((x, y) => y.lines - x.lines)[0];
    setOpens(openLink(top.path, `開く: ${top.path.split('/').pop()}`, 'primary'), copyBtn(top.path, '場所をコピー'));
  }
  panel.replaceChildren(...kids);
}
function renderPanel() { if (quizOn) quizPanel(); else if (storyOn) storyPanel(); else if (!sel) overviewPanel(); else boxPanel(BOX.get(sel)); panel.scrollTop = 0; }

