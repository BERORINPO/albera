// Bero's figures (part C): flow / who / ba drawn as SVG, stroke by stroke, with the ledger lines they came from.
// SVG through createElementNS, text through textContent. Motion lives in figure.css: `.rf-d` strokes draw
// themselves, `.rf-f` parts fade in, and `.rf-s<N>` is the step in the sequence (no inline styles: CSP).
import { clockOf, entryText, entryParams } from './ledger.mjs';

const SVG = 'http://www.w3.org/2000/svg';
export const FIG_W = 330;
export const MAX_STAGE = 15;
const LANES = ['human', 'bero', 'hands'];

/** Pure: split a label into at most two lines of `per` chars (the second ends with an ellipsis if cut). */
export function wrapLabel(label, per = 22) {
  const s = String(label ?? '');
  if (s.length <= per) return [s];
  const second = s.slice(per);
  return [s.slice(0, per), second.length > per ? `${second.slice(0, per - 1)}…` : second];
}

/** Pure: flow boxes stacked top to bottom. @param {number} n */
export function flowLayout(n) {
  const top = 8, h = 36, gap = 14;
  const boxes = Array.from({ length: n }, (_, i) => ({ x: 4, y: top + i * (h + gap), w: FIG_W - 72, h }));
  return { boxes, height: top + n * h + Math.max(0, n - 1) * gap + 8 };
}

/** Pure: the x of each lane and the y of each row of a who figure. @param {number} n */
export function whoLayout(n, width = FIG_W + 90) {
  const lane = width / LANES.length;
  const xs = Object.fromEntries(LANES.map((name, i) => [name, Math.round(lane * i + lane / 2)]));
  const ys = Array.from({ length: n }, (_, i) => 46 + i * 26);
  return { width, xs, ys, height: 46 + n * 26 };
}

/** Pure: the sequence class for step i (capped so long figures still finish). */
export const stage = (i) => `rf-s${Math.min(MAX_STAGE, Math.max(0, Math.round(i)))}`;

/**
 * @param {any} spec a FigureSpec (validFigure)
 * @param {{words: {t: Function}, frameUrl: (frameId: string) => string}} options
 * @returns {HTMLElement}
 */
export function renderFigure(spec, { words, frameUrl }) {
  const root = document.createElement('div');
  root.className = `rf-fig rf-${spec.kind}`;
  root.dataset.node = `fig:${spec.figureId}`;
  const title = document.createElement('b');
  title.className = 'rf-title';
  title.textContent = words.t(`fig_${spec.kind}`, { cam: spec.vmId ?? '' });
  const draw = DRAW[spec.kind];
  root.append(title, draw ? draw(spec, words, frameUrl) : document.createElement('div'), sourcesOf(spec, words));
  return root;
}

function sourcesOf(spec, words) {
  const box = document.createElement('div');
  box.className = 'rf-src';
  const head = document.createElement('span');
  head.className = 'rf-src-h';
  head.textContent = words.t('fig_sources', {});
  box.append(head);
  for (const e of spec.sources) {
    const line = document.createElement('span');
    line.className = 'rf-src-l';
    line.textContent = `${clockOf(e.at)} ${entryText(words, e)}`;
    box.append(line);
  }
  return box;
}

const DRAW = {
  flow(spec, words) {
    const { boxes, height } = flowLayout(spec.steps.length);
    const svg = svgRoot(FIG_W, height);
    spec.steps.forEach((step, i) => {
      const b = boxes[i];
      const tone = step.state === 'now' ? 'work' : 'done';
      const s = i * 2;
      svg.append(el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 7 }, `rf-d rf-t-${tone}${step.state === 'now' ? ' rf-now' : ''} ${stage(s)}`));
      const lines = wrapLabel(step.label);
      lines.forEach((line, j) => {
        const ty = b.y + (lines.length === 1 ? 22 : 15 + j * 14);
        svg.append(text(line, { x: b.x + 10, y: ty }, `rf-f rf-label ${stage(s + 1)}`));
      });
      svg.append(text(words.t(`fig_${step.state}`, {}), { x: b.x + b.w + 8, y: b.y + 22 }, `rf-f rf-state rf-t-${tone} ${stage(s + 1)}`));
      if (i < spec.steps.length - 1) {
        const x = b.x + 24, y1 = b.y + b.h, y2 = boxes[i + 1].y;
        svg.append(el('path', { d: `M${x} ${y1} L${x} ${y2}` }, `rf-d rf-t-muted ${stage(s + 1)}`));
      }
    });
    return svg;
  },

  who(spec, words) {
    const { width, xs, ys, height } = whoLayout(spec.rows.length);
    const svg = svgRoot(width, height);
    for (const lane of LANES) {
      svg.append(text(words.t(`lane_${lane}`, {}), { x: xs[lane], y: 16, 'text-anchor': 'middle' }, `rf-f rf-lane rf-t-${lane} ${stage(0)}`));
      svg.append(el('path', { d: `M${xs[lane]} 24 L${xs[lane]} ${height}` }, `rf-d rf-lane-line ${stage(0)}`));
    }
    spec.rows.forEach((row, i) => {
      const a = xs[row.from], b = xs[row.to], y = ys[i], s = i + 1;
      const tone = row.from;
      if (a === b) {
        svg.append(el('circle', { cx: a, cy: y, r: 5 }, `rf-f rf-fill-${tone} ${stage(s)}`));
      } else {
        const dir = b > a ? -1 : 1;
        svg.append(el('path', { d: `M${a} ${y} L${b} ${y}` }, `rf-d rf-t-${tone} ${stage(s)}`));
        svg.append(el('path', { d: `M${b} ${y} l${dir * 7} -4 l0 8z` }, `rf-f rf-fill-${tone} ${stage(s)}`));
      }
      if (row.from === 'human') svg.append(el('circle', { cx: a, cy: y, r: 4 }, `rf-f rf-fill-human ${stage(s)}`));
      svg.append(text(cutShort(whoText(words, row)), { x: (a + b) / 2 + (a === b ? 40 : 0), y: y - 5, 'text-anchor': 'middle' }, `rf-f rf-label ${stage(s)}`));
    });
    return svg;
  },

  ba(spec, words, frameUrl) {
    const svg = svgRoot(FIG_W, 128);
    const w = 158, h = 96;
    [['before', 2], ['after', 170]].forEach(([side, x], i) => {
      const frameId = spec[side]?.frameId ?? null;
      svg.append(text(words.t(`fig_${side}`, {}), { x, y: 13 }, `rf-f rf-lane ${stage(i * 2)}`));
      if (frameId) {
        const img = el('image', { x, y: 20, width: w, height: h, preserveAspectRatio: 'xMidYMid meet' }, `rf-f ${stage(i * 2 + 1)}`);
        img.setAttribute('href', frameUrl(frameId));
        svg.append(img);
      } else {
        svg.append(text(words.t('fig_not_yet', {}), { x: x + w / 2, y: 20 + h / 2 + 4, 'text-anchor': 'middle' }, `rf-f rf-state rf-t-muted ${stage(i * 2 + 1)}`));
      }
      svg.append(el('rect', { x, y: 20, width: w, height: h, rx: 5 }, `rf-d ${frameId ? 'rf-t-done' : 'rf-t-muted rf-dash'} ${stage(i * 2)}`));
    });
    svg.append(el('path', { d: 'M161 68 L168 68' }, `rf-d rf-t-me ${stage(2)}`));
    return svg;
  },
};

/** The words on a who row; the job row (bero -> hands after a choice) uses who_job_<effect>. */
export function whoKey(row) {
  return row.code === 'human_choice' && row.from === 'bero' ? `who_job_${row.params?.effect}` : `who_${row.code}`;
}

function whoText(words, row) {
  return words.t(whoKey(row), entryParams(words, { vmId: null, params: row.params }));
}

const cutShort = (s, max = 14) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function svgRoot(w, h) {
  const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img' }, 'rf-svg');
  return svg;
}

/** @param {string} name @param {Record<string, string|number>} attrs @param {string} cls */
function el(name, attrs, cls) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (cls) node.setAttribute('class', cls);
  return node;
}

function text(content, attrs, cls) {
  const node = el('text', attrs, cls);
  node.textContent = content;
  return node;
}
