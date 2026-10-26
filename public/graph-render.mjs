// @ts-check
// Agent Canvas overlay: local task/artifact/decision/understanding cards and relation lines.

import { h, reconcile } from './view.mjs';
import { EXECUTION_HARNESSES, GRAPH_NODE_KINDS, reviewUnderstandingGaps } from './graph-model.mjs';
import { comprehensionGapSummary } from './session-relations.mjs';
import { graphSessionLabel } from './graph-session-label.mjs';
import { sessionRect } from './session-position.mjs';

/** @typedef {import('./i18n.mjs').T} T */
const CARD_W = 280;
const CARD_H = 168;

/** @param {any} node @param {string[]} missing */
export function graphCardSignature(node, missing = []) {
  return JSON.stringify([node, missing]);
}

/** @param {{kind:string,status?:string}} node @param {string[]} missing */
export function graphCardStatus(node, missing = []) {
  return node.kind === 'understanding_gap' && missing.length > 0 && ['done', 'resolved'].includes(node.status ?? '')
    ? 'review'
    : node.status ?? 'open';
}

/** @param {any} node @param {string[]} missing @param {T} t */
export function graphCardSearchText(node, missing = [], t) {
  const status = graphCardStatus(node, missing);
  return [
    node.title, node.body, node.kind, t(`graph.kind.${node.kind}`), node.status,
    status, t(`graph.status.${status}`), node.checkedPerson, node.missingEvidence,
    node.neededExplanation, ...missing.flatMap((kind) => [kind, t(`graph.link.${kind}`)]),
    ...EXECUTION_HARNESSES.includes(node.executionHarness) ? [t(`graph.executionHarness.${node.executionHarness}`)] : [],
    node.executionLocation, node.workspaceIsolation, node.networkAccess, node.approvalMode,
    ...['executionLocation', 'workspaceIsolation', 'networkAccess', 'approvalMode']
      .map((key) => node[key] ? t(`graph.${key}.${node[key]}`) : ''),
  ].filter((value) => typeof value === 'string' && value.length).join(' ');
}

/** Cards inherit active provider, state, and project filters from direct session relations. Unlinked cards stay board-wide. @param {string} nodeId @param {any[]} edges @param {Map<string,{card:any,pile:string}>} index @param {{source?:string,state?:string,project?:string}} filters */
export function graphNodeSessionFilterMatch(nodeId, edges, index, filters = {}) {
  const { source = 'all', state = 'all', project = 'all' } = filters;
  if (source === 'all' && state === 'all' && project === 'all') return true;
  const sessionIds = new Set();
  for (const edge of edges ?? []) {
    if (edge?.from === `graph:${nodeId}` && typeof edge.to === 'string' && edge.to.startsWith('session:')) sessionIds.add(edge.to.slice(8));
    if (edge?.to === `graph:${nodeId}` && typeof edge.from === 'string' && edge.from.startsWith('session:')) sessionIds.add(edge.from.slice(8));
  }
  if (!sessionIds.size) return true;
  return [...sessionIds].some((id) => {
    const entry = index.get(id);
    if (!entry) return false;
    const actualSource = entry.card.source ?? (id.startsWith('codex_') ? 'codex' : id.startsWith('copilot_') ? 'copilot' : id.startsWith('opencode_') ? 'opencode' : 'claude');
    return (source === 'all' || actualSource === source)
      && (state === 'all' || entry.pile === state)
      && (project === 'all' || entry.card.project?.key === project);
  });
}

/** A direct session relation can keep a graph card searchable when that session matches the active board query. @param {string} nodeId @param {any[]} edges @param {Set<string>|null|undefined} matched */
export function graphNodeHasMatchedSession(nodeId, edges, matched) {
  if (!matched) return false;
  return (edges ?? []).some((edge) => {
    if (edge?.from === `graph:${nodeId}` && typeof edge.to === 'string' && edge.to.startsWith('session:')) return matched.has(edge.to.slice(8));
    if (edge?.to === `graph:${nodeId}` && typeof edge.from === 'string' && edge.from.startsWith('session:')) return matched.has(edge.from.slice(8));
    return false;
  });
}

/** @param {{kind:string,purpose?:string,status?:string}} edge @param {T} t */
export function graphEdgeSearchText(edge, t) {
  const status = graphEdgePresentation(edge, t).status;
  return [
    edge.kind,
    t(`graph.edge.${edge.kind}`),
    edge.purpose,
    status ? t(`graph.delegation.${status}`) : '',
  ].filter((value) => typeof value === 'string' && value.length).join(' ');
}

/** @param {{kind:string,status?:string}} edge @param {T} t */
export function graphEdgePresentation(edge, t) {
  const kind = ['related', 'depends_on', 'delegates', 'evidence', 'explains'].includes(edge.kind) ? edge.kind : 'related';
  const status = edge.kind === 'delegates' && ['planned', 'active', 'blocked', 'completed', 'cancelled'].includes(edge.status ?? '')
    ? edge.status
    : undefined;
  return {
    className: `graph-edge graph-edge--${kind}${edge.kind === 'delegates' && !status ? ' graph-edge--delegates-unknown' : ''}`,
    status,
    title: kind === 'delegates' ? `${t('graph.edge.delegates')}: ${t(`graph.delegation.${status ?? 'unknown'}`)}` : t(`graph.edge.${kind}`),
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

/** Relation names use safe provider/kind labels and opaque ID suffixes, never card titles or edge metadata. @param {{from:string,to:string,kind:string,status?:string}} edge @param {any} graph @param {Map<string,{card:any,pile:string}>} index @param {T} t */
export function graphEdgeAccessibleLabel(edge, graph, index, t) {
  const endpointLabel = (endpoint) => {
    if (typeof endpoint !== 'string') return t('graph.missingEndpoint');
    if (endpoint.startsWith('graph:')) {
      const id = endpoint.slice(6);
      const node = graph.nodes.find((item) => item.id === id);
      if (!node) return t('graph.missingNode');
      const kind = GRAPH_NODE_KINDS.includes(node.kind) ? node.kind : 'unknown';
      const suffix = id.slice(-12).toLowerCase();
      return /^[a-f0-9]{12}$/.test(suffix) ? `${t(`graph.kind.${kind}`)} (${suffix})` : t('graph.unknownEndpoint');
    }
    if (endpoint.startsWith('session:')) {
      const id = endpoint.slice(8);
      return index.has(id) ? graphSessionLabel({ id }, t) : t('graph.missingSession');
    }
    return t('graph.unknownEndpoint');
  };
  const relation = graphEdgePresentation(edge, t).title;
  return t('graph.edgeAccessible', { from: endpointLabel(edge.from), to: endpointLabel(edge.to), relation });
}

/** @param {string} endpoint @param {any} graph @param {Map<string,{card:any,pile:string}>} index @param {any} layout */
function point(endpoint, graph, index, layout, positions = {}, drag = null) {
  if (endpoint.startsWith('graph:')) {
    const n = graph.nodes.find((x) => x.id === endpoint.slice(6));
    return n ? { x: n.x + CARD_W / 2, y: n.y + CARD_H / 2, rx: CARD_W / 2, ry: CARD_H / 2 } : null;
  }
  const id = endpoint.slice(8);
  if (!index.has(id)) return null;
  const rect = sessionRect(layout, id, positions, drag);
  return rect ? { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, rx: rect.w / 2, ry: rect.h / 2 } : null;
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

/** Keep the person being checked and every unrecorded field visible on the canvas card. @param {any} node @param {T} t */
export function graphCardComprehensionSummary(node, t) {
  return node.kind === 'understanding_gap' ? comprehensionGapSummary(node, t) : [];
}

/** @param {T} t @param {any} node @param {string[]} missing */
export function graphCardAriaLabel(t, node, missing = []) {
  const ariaLabel = t('graph.cardAria', { kind: t(`graph.kind.${node.kind}`), title: node.title, status: t(`graph.status.${graphCardStatus(node, missing)}`) });
  const reviewLabel = missing.length ? t('graph.missingLinks', { links: missing.map((kind) => t(`graph.link.${kind}`)).join(', ') }) : '';
  const comprehension = graphCardComprehensionSummary(node, t);
  return [ariaLabel, ...comprehension, reviewLabel].filter(Boolean).join(' ');
}

/** @param {T} t @param {any} node @param {string[]} missing */
function graphCard(t, node, missing = []) {
  const status = graphCardStatus(node, missing);
  const statusLabel = t(`graph.status.${status}`);
  const ariaLabel = graphCardAriaLabel(t, node, missing);
  const reviewLabel = missing.length ? t('graph.missingLinks', { links: missing.map((kind) => t(`graph.link.${kind}`)).join(', ') }) : '';
  return h(
    'button',
    {
      class: `graph-node graph-node--${node.kind}`,
      type: 'button',
      'data-key': node.id,
      'data-action': 'graph-open',
      'data-id': node.id,
      'aria-label': ariaLabel,
    },
    h('span', { class: 'graph-node__meta' }, t(`graph.kind.${node.kind}`), ' ', h('span', { class: 'graph-node__status', text: statusLabel })),
    h('span', { class: 'graph-node__title', text: node.title }),
    node.body ? h('span', { class: 'graph-node__body', text: node.body }) : null,
    ...graphCardComprehensionSummary(node, t).map((text) => h('span', { class: 'graph-node__body', text })),
    node.kind === 'execution_profile'
      ? h('span', { class: 'graph-node__body', text: [
        t(`graph.executionHarness.${node.executionHarness}`),
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
 * @param {{t:T,graph:any,index:Map<string,{card:any,pile:string}>,layout:any,filter:string,sessionFilters?:{source?:string,state?:string,project?:string},matched?:Set<string>|null,boardReady?:boolean,drag?:{id:string,x:number,y:number}|null,connectFrom?:string|null}} o
 */
export function renderGraphLayer(layer, o) {
  const t = o.t;
  const edges = o.graph.edges.map((edge) => ({ edge, line: clippedLine(point(edge.from, o.graph, o.index, o.layout, o.sessionPositions, o.sessionDrag), point(edge.to, o.graph, o.index, o.layout, o.sessionPositions, o.sessionDrag)) })).filter((x) => x.line);
  const lineRoot = layer.querySelector('.graph-layer__edges') ?? h('div', { class: 'graph-layer__edges' });
  lineRoot.removeAttribute('aria-hidden');
  const cardRoot = layer.querySelector('.graph-layer__cards') ?? h('div', { class: 'graph-layer__cards' });
  const connectRoot = layer.querySelector('.graph-layer__connect') ?? h('div', { class: 'graph-layer__connect' });
  layer.append(lineRoot, cardRoot, connectRoot);
  let empty = layer.querySelector('.graph-layer__empty');
  if (o.boardReady && !o.index.size && !o.graph.nodes.length && !o.graph.edges.length) {
    if (!empty) {
      empty = h('section', { class: 'graph-layer__empty', 'aria-label': t('graph.emptyLabel') },
        h('p', { class: 'graph-layer__empty-copy', text: t('graph.empty') }),
        h('button', { class: 'btn btn--line graph-layer__empty-action', type: 'button', 'data-action': 'graph-new', text: t('graph.emptyAction') }),
        h('button', { class: 'textbtn graph-layer__empty-status', type: 'button', 'data-action': 'graph-show-diagnostics', text: t('graph.emptyStatus') }),
      );
    } else if (empty.dataset.lang !== t.lang) {
      empty.setAttribute('aria-label', t('graph.emptyLabel'));
      empty.replaceChildren(
        h('p', { class: 'graph-layer__empty-copy', text: t('graph.empty') }),
        h('button', { class: 'btn btn--line graph-layer__empty-action', type: 'button', 'data-action': 'graph-new', text: t('graph.emptyAction') }),
        h('button', { class: 'textbtn graph-layer__empty-status', type: 'button', 'data-action': 'graph-show-diagnostics', text: t('graph.emptyStatus') }),
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
      const accessibleLabel = graphEdgeAccessibleLabel(x.edge, o.graph, o.index, t);
      const line = h('button', {
        type: 'button', 'data-action': 'graph-edit-edge', 'data-id': x.edge.id,
        'aria-label': accessibleLabel,
        class: attributes.className,
      }, attributes.title
        ? h('span', { class: 'graph-edge__tooltip', 'aria-hidden': 'true', text: attributes.title })
        : null);
      if (attributes.status) line.setAttribute('data-status', attributes.status);
      line.setAttribute('title', attributes.title);
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
    const missing = reviewById.get(id) ?? [];
    const hay = graphCardSearchText(node, missing, t).toLocaleLowerCase();
    const textMatches = !query || hay.includes(query) || graphNodeHasMatchedSession(id, o.graph.edges, o.matched);
    const dim = !textMatches || !graphNodeSessionFilterMatch(id, o.graph.edges, o.index, o.sessionFilters);
    el.classList.toggle('is-dim', dim);
    el.classList.toggle('is-connect-target', !!o.connectFrom && o.connectFrom !== id);
    el.setAttribute('aria-label', `${graphCardAriaLabel(t, node, missing)}${dim ? ` ${t('canvas.noMatch')}` : ''}`);
  }
  reconcile(
    connectRoot,
    o.graph.nodes,
    (node) => node.id,
    (node) => [node.x, node.y, node.title, o.connectFrom === node.id, o.drag?.id === node.id].join('|'),
    (node) => h('button', { class: 'graph-connect-handle', type: 'button', 'data-endpoint': 'graph', 'data-action': 'graph-connect-node', 'data-id': node.id, text: '↗' }),
  );
  for (const button of [...connectRoot.querySelectorAll('.graph-connect-handle')]) {
    const node = o.graph.nodes.find((item) => item.id === button.dataset.key);
    if (!node) continue;
    const at = o.drag?.id === node.id ? o.drag : node;
    button.style.setProperty('--x', String(at.x + CARD_W - 48));
    button.style.setProperty('--y', String(at.y + 8));
    button.setAttribute('aria-label', t('graph.connectCard', { title: node.title }));
    button.setAttribute('aria-pressed', o.connectFrom === node.id ? 'true' : 'false');
    button.classList.toggle('is-connect-source', o.connectFrom === node.id);
  }
  for (const el of [...lineRoot.children]) {
    const rendered = edges.find((x) => x.edge.id === el.getAttribute('data-key'));
    const edge = rendered?.edge;
    if (!edge) continue;
    const from = edge.from.startsWith('graph:') ? o.graph.nodes.find((n) => n.id === edge.from.slice(6)) : null;
    const to = edge.to.startsWith('graph:') ? o.graph.nodes.find((n) => n.id === edge.to.slice(6)) : null;
    const relationHay = graphEdgeSearchText(edge, t).toLocaleLowerCase();
    const relationMatches = !!query && relationHay.includes(query);
    const touchesSessionMatch = [edge.from, edge.to].some((endpoint) => endpoint.startsWith('session:') && o.matched?.has(endpoint.slice(8)));
    const touchesMatch = !query || relationMatches || touchesSessionMatch || [from, to].filter(Boolean).some((n) => {
      const hay = graphCardSearchText(n, reviewById.get(n.id) ?? [], t).toLocaleLowerCase();
      return hay.includes(query);
    });
    const filteredSession = [edge.from, edge.to].some((endpoint) => endpoint.startsWith('session:') && o.matched != null && !o.matched.has(endpoint.slice(8)));
    el.classList.toggle('is-dim', (!!query && !touchesMatch) || (filteredSession && !relationMatches));
    const accessibleLabel = graphEdgeAccessibleLabel(edge, o.graph, o.index, t);
    if (accessibleLabel) el.setAttribute('aria-label', accessibleLabel);
    else el.removeAttribute('aria-label');
  }
}

export const GRAPH_CARD_SIZE = Object.freeze({ width: CARD_W, height: CARD_H });
