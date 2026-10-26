// @ts-check
// Agent Canvas overlay: local task/artifact/decision/understanding cards and relation lines.

import { CANVAS } from '../src/shared/constants.mjs';
import { h, reconcile } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */
const CARD_W = 280;
const CARD_H = 168;
const { SLIP_W, SLIP_H } = CANVAS;

/** @param {string} endpoint @param {any} graph @param {Map<string,{card:any,pile:string}>} index @param {any} layout */
function point(endpoint, graph, index, layout) {
  if (endpoint.startsWith('graph:')) {
    const n = graph.nodes.find((x) => x.id === endpoint.slice(6));
    return n ? { x: n.x + CARD_W / 2, y: n.y + CARD_H / 2, rx: CARD_W / 2, ry: CARD_H / 2 } : null;
  }
  const id = endpoint.slice(8);
  if (!index.has(id)) return null;
  for (const sheet of layout?.sheets ?? []) {
    const slip = sheet.slips.find((x) => x.id === id);
    if (slip) return { x: sheet.x + slip.x + SLIP_W / 2, y: sheet.y + slip.y + (slip.h ?? SLIP_H) / 2, rx: SLIP_W / 2, ry: (slip.h ?? SLIP_H) / 2 };
  }
  return null;
}

/** @param {{x:number,y:number,rx:number,ry:number}|null} a @param {{x:number,y:number,rx:number,ry:number}|null} b */
function clippedLine(a, b) {
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  const ux = dx / distance;
  const uy = dy / distance;
  const start = Math.min(ux ? a.rx / Math.abs(ux) : Infinity, uy ? a.ry / Math.abs(uy) : Infinity);
  const end = Math.min(ux ? b.rx / Math.abs(ux) : Infinity, uy ? b.ry / Math.abs(uy) : Infinity);
  return { x1: a.x + ux * start, y1: a.y + uy * start, x2: b.x - ux * end, y2: b.y - uy * end };
}

/** @param {HTMLElement} line @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 */
function placeLine(line, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  line.style.setProperty('--x', String(x1));
  line.style.setProperty('--y', String(y1));
  line.style.setProperty('--len', String(Math.hypot(dx, dy)));
  line.style.setProperty('--angle', `${Math.atan2(dy, dx)}rad`);
}

/** @param {T} t @param {any} node */
function graphCard(t, node) {
  return h(
    'button',
    {
      class: `graph-node graph-node--${node.kind}`,
      type: 'button',
      'data-key': node.id,
      'data-action': 'graph-open',
      'data-id': node.id,
      'aria-label': t('graph.cardAria', { kind: t(`graph.kind.${node.kind}`), title: node.title, status: t(`graph.status.${node.status}`) }),
    },
    h('span', { class: 'graph-node__meta' }, t(`graph.kind.${node.kind}`), ' ', h('span', { class: 'graph-node__status', text: t(`graph.status.${node.status}`) })),
    h('span', { class: 'graph-node__title', text: node.title }),
    node.body ? h('span', { class: 'graph-node__body', text: node.body }) : null,
    node.kind === 'understanding_gap' && (node.missingEvidence || node.neededExplanation)
      ? h('span', { class: 'graph-node__body', text: [node.missingEvidence && t('graph.missingEvidence', { text: node.missingEvidence }), node.neededExplanation && t('graph.neededExplanation', { text: node.neededExplanation })].filter(Boolean).join('; ') })
      : null,
  );
}

/**
 * @param {HTMLElement} layer
 * @param {{t:T,graph:any,index:Map<string,{card:any,pile:string}>,layout:any,filter:string,boardReady?:boolean,drag?:{id:string,x:number,y:number}|null}} o
 */
export function renderGraphLayer(layer, o) {
  const t = o.t;
  const edges = o.graph.edges.map((edge) => ({ edge, line: clippedLine(point(edge.from, o.graph, o.index, o.layout), point(edge.to, o.graph, o.index, o.layout)) })).filter((x) => x.line);
  const lineRoot = layer.querySelector('.graph-layer__edges') ?? h('div', { class: 'graph-layer__edges', 'aria-hidden': 'true' });
  const cardRoot = layer.querySelector('.graph-layer__cards') ?? h('div', { class: 'graph-layer__cards' });
  layer.append(lineRoot, cardRoot);
  let empty = layer.querySelector('.graph-layer__empty');
  if (o.boardReady && !o.index.size && !o.graph.nodes.length && !o.graph.edges.length) {
    empty ??= h('p', { class: 'graph-layer__empty', text: t('graph.empty') });
    layer.append(empty);
  } else empty?.remove();
  reconcile(
    lineRoot,
    edges,
    (x) => x.edge.id,
    (x) => `${x.edge.from}|${x.edge.to}|${x.edge.kind}|${x.edge.status}|${x.edge.purpose}|${x.line?.x1}|${x.line?.y1}|${x.line?.x2}|${x.line?.y2}`,
    (x) => {
      const line = h('span', { class: `graph-edge graph-edge--${x.edge.kind}` });
      if (x.line) placeLine(line, x.line.x1, x.line.y1, x.line.x2, x.line.y2);
      return line;
    },
  );
  const query = o.filter.trim().toLocaleLowerCase();
  reconcile(
    cardRoot,
    o.graph.nodes,
    (n) => n.id,
    (n) => JSON.stringify(n),
    (n) => graphCard(t, n),
  );
  for (const el of [...cardRoot.querySelectorAll('.graph-node')]) {
    const id = el.getAttribute('data-id') ?? '';
    const node = o.graph.nodes.find((n) => n.id === id);
    if (!node) continue;
    const at = o.drag?.id === id ? o.drag : node;
    el.style.setProperty('--x', String(at.x));
    el.style.setProperty('--y', String(at.y));
    const hay = [node.title, node.body, node.kind, node.status, node.checkedPerson, node.missingEvidence, node.neededExplanation].join(' ').toLocaleLowerCase();
    el.classList.toggle('is-dim', !!query && !hay.includes(query));
  }
  for (const el of [...lineRoot.children]) {
    const edge = edges.find((x) => x.edge.id === el.getAttribute('data-key'))?.edge;
    if (!edge) continue;
    const from = edge.from.startsWith('graph:') ? o.graph.nodes.find((n) => n.id === edge.from.slice(6)) : null;
    const to = edge.to.startsWith('graph:') ? o.graph.nodes.find((n) => n.id === edge.to.slice(6)) : null;
    const touchesMatch = [from, to].filter(Boolean).some((n) => {
      const hay = [n.title, n.body, n.kind, n.status].join(' ').toLocaleLowerCase();
      return !query || hay.includes(query);
    });
    el.classList.toggle('is-dim', !!query && !touchesMatch);
    el.setAttribute('aria-label', t(`graph.edge.${edge.kind}`));
  }
}

export const GRAPH_CARD_SIZE = Object.freeze({ width: CARD_W, height: CARD_H });
