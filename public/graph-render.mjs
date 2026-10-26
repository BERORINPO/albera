// @ts-check
// Agent Canvas overlay: local task/artifact/decision/understanding cards and relation lines.

import { CANVAS } from '../src/shared/constants.mjs';
import { h, reconcile } from './view.mjs';
import { reviewUnderstandingGaps } from './graph-model.mjs';

/** @typedef {import('./i18n.mjs').T} T */
const CARD_W = 280;
const CARD_H = 168;
const { SLIP_W, SLIP_H } = CANVAS;

/** @param {any} node @param {string[]} missing */
export function graphCardSignature(node, missing = []) {
  return JSON.stringify([node, missing]);
}

/** @param {{kind:string,status?:string}} edge @param {T} t */
export function graphEdgePresentation(edge, t) {
  const status = edge.kind === 'delegates' && ['planned', 'active', 'blocked', 'completed', 'cancelled'].includes(edge.status ?? '')
    ? edge.status
    : undefined;
  return {
    className: `graph-edge graph-edge--${edge.kind}${edge.kind === 'delegates' && !status ? ' graph-edge--delegates-unknown' : ''}`,
    status,
    title: edge.kind === 'delegates' ? `${t('graph.edge.delegates')}: ${t(`graph.delegation.${status ?? 'unknown'}`)}` : undefined,
  };
}

/** @param {{kind:string,status?:string}} edge @param {T} t */
export function graphEdgeAttributes(edge, t) {
  const presentation = graphEdgePresentation(edge, t);
  return {
    className: presentation.className,
    ...(presentation.status ? { status: presentation.status } : {}),
    ...(presentation.title ? { title: presentation.title } : {}),
  };
}

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

/** @param {T} t @param {any} node @param {string[]} missing */
function graphCard(t, node, missing = []) {
  const ariaLabel = t('graph.cardAria', { kind: t(`graph.kind.${node.kind}`), title: node.title, status: t(`graph.status.${node.status}`) });
  const reviewLabel = missing.length ? t('graph.missingLinks', { links: missing.map((kind) => t(`graph.link.${kind}`)).join(', ') }) : '';
  return h(
    'button',
    {
      class: `graph-node graph-node--${node.kind}`,
      type: 'button',
      'data-key': node.id,
      'data-action': 'graph-open',
      'data-id': node.id,
      'aria-label': `${ariaLabel}${reviewLabel ? ` ${reviewLabel}` : ''}`,
    },
    h('span', { class: 'graph-node__meta' }, t(`graph.kind.${node.kind}`), ' ', h('span', { class: 'graph-node__status', text: t(`graph.status.${node.status}`) })),
    h('span', { class: 'graph-node__title', text: node.title }),
    node.body ? h('span', { class: 'graph-node__body', text: node.body }) : null,
    node.kind === 'understanding_gap' && (node.missingEvidence || node.neededExplanation)
      ? h('span', { class: 'graph-node__body', text: [node.missingEvidence && t('graph.missingEvidence', { text: node.missingEvidence }), node.neededExplanation && t('graph.neededExplanation', { text: node.neededExplanation })].filter(Boolean).join('; ') })
      : null,
    node.kind === 'execution_profile'
      ? h('span', { class: 'graph-node__body', text: [
        t(`graph.executionLocation.${node.executionLocation}`),
        t(`graph.workspaceIsolation.${node.workspaceIsolation}`),
        t(`graph.networkAccess.${node.networkAccess}`),
        t(`graph.approvalMode.${node.approvalMode}`),
      ].join(' / ') })
      : null,
    reviewLabel ? h('span', { class: 'graph-node__review', text: reviewLabel }) : null,
  );
}

/**
 * @param {HTMLElement} layer
 * @param {{t:T,graph:any,index:Map<string,{card:any,pile:string}>,layout:any,filter:string,matched?:Set<string>|null,boardReady?:boolean,drag?:{id:string,x:number,y:number}|null}} o
 */
export function renderGraphLayer(layer, o) {
  const t = o.t;
  const edges = o.graph.edges.map((edge) => ({ edge, line: clippedLine(point(edge.from, o.graph, o.index, o.layout), point(edge.to, o.graph, o.index, o.layout)) })).filter((x) => x.line);
  const lineRoot = layer.querySelector('.graph-layer__edges') ?? h('div', { class: 'graph-layer__edges' });
  lineRoot.removeAttribute('aria-hidden');
  const cardRoot = layer.querySelector('.graph-layer__cards') ?? h('div', { class: 'graph-layer__cards' });
  layer.append(lineRoot, cardRoot);
  let empty = layer.querySelector('.graph-layer__empty');
  if (o.boardReady && !o.index.size && !o.graph.nodes.length && !o.graph.edges.length) {
    if (!empty) {
      empty = h('section', { class: 'graph-layer__empty', 'aria-label': t('graph.emptyLabel') },
        h('p', { class: 'graph-layer__empty-copy', text: t('graph.empty') }),
        h('button', { class: 'btn btn--line graph-layer__empty-action', type: 'button', 'data-action': 'graph-new', text: t('graph.emptyAction') }),
      );
    } else if (empty.dataset.lang !== t.lang) {
      empty.setAttribute('aria-label', t('graph.emptyLabel'));
      empty.replaceChildren(
        h('p', { class: 'graph-layer__empty-copy', text: t('graph.empty') }),
        h('button', { class: 'btn btn--line graph-layer__empty-action', type: 'button', 'data-action': 'graph-new', text: t('graph.emptyAction') }),
      );
    }
    empty.dataset.lang = t.lang;
    layer.append(empty);
  } else empty?.remove();
  reconcile(
    lineRoot,
    edges,
    (x) => x.edge.id,
    (x) => `${x.edge.from}|${x.edge.to}|${x.edge.kind}|${x.edge.status}|${x.edge.purpose}|${x.line?.x1}|${x.line?.y1}|${x.line?.x2}|${x.line?.y2}`,
    (x) => {
      const attributes = graphEdgeAttributes(x.edge, t);
      const line = h(attributes.title ? 'button' : 'span', {
        ...(attributes.title ? { type: 'button', 'data-action': 'graph-edit-edge', 'data-id': x.edge.id } : {}),
        class: attributes.className,
      }, attributes.title
        ? h('span', { class: 'graph-edge__tooltip', 'aria-hidden': 'true', text: attributes.title })
        : null);
      if (attributes.title) {
        line.setAttribute('aria-label', attributes.title);
      } else line.setAttribute('aria-hidden', 'true');
      if (attributes.status) line.setAttribute('data-status', attributes.status);
      if (attributes.title) line.setAttribute('title', attributes.title);
      if (x.line) placeLine(line, x.line.x1, x.line.y1, x.line.x2, x.line.y2);
      return line;
    },
  );
  const query = o.filter.trim().toLocaleLowerCase();
  const reviewById = new Map(reviewUnderstandingGaps(o.graph, new Set(o.index.keys())).map((item) => [item.id, item.missing]));
  reconcile(
    cardRoot,
    o.graph.nodes,
    (n) => n.id,
    (n) => graphCardSignature(n, reviewById.get(n.id) ?? []),
    (n) => graphCard(t, n, reviewById.get(n.id) ?? []),
  );
  for (const el of [...cardRoot.querySelectorAll('.graph-node')]) {
    const id = el.getAttribute('data-id') ?? '';
    const node = o.graph.nodes.find((n) => n.id === id);
    if (!node) continue;
    const at = o.drag?.id === id ? o.drag : node;
    el.style.setProperty('--x', String(at.x));
    el.style.setProperty('--y', String(at.y));
    const hay = [node.title, node.body, node.kind, node.status, node.checkedPerson, node.missingEvidence, node.neededExplanation, node.executionLocation, node.workspaceIsolation, node.networkAccess, node.approvalMode].join(' ').toLocaleLowerCase();
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
    const filteredSession = [edge.from, edge.to].some((endpoint) => endpoint.startsWith('session:') && o.matched != null && !o.matched.has(endpoint.slice(8)));
    el.classList.toggle('is-dim', (!!query && !touchesMatch) || filteredSession);
    const attributes = graphEdgeAttributes(edge, t);
    if (attributes.title) el.setAttribute('aria-label', attributes.title);
    else el.removeAttribute('aria-label');
  }
}

export const GRAPH_CARD_SIZE = Object.freeze({ width: CARD_W, height: CARD_H });
