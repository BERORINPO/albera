// @ts-check
// Pure local Agent Canvas graph model. Session payloads are never accepted here.

export const GRAPH_MAX_NODES = 200;
export const GRAPH_MAX_EDGES = 500;
export const GRAPH_NODE_KINDS = Object.freeze(['task', 'artifact', 'decision', 'understanding_gap']);
export const GRAPH_NODE_STATES = Object.freeze(['open', 'in_progress', 'blocked', 'done', 'resolved']);
export const GRAPH_EDGE_KINDS = Object.freeze(['related', 'depends_on', 'delegates', 'evidence', 'explains']);
export const DELEGATION_STATES = Object.freeze(['planned', 'active', 'blocked', 'completed', 'cancelled']);
const GRAPH_ID = /^g_[0-9a-f-]{36}$/i;
const EDGE_ID = /^e_[0-9a-f-]{36}$/i;
const SESSION_ID = /^(?:local_[0-9a-f-]{36}|codex_[0-9a-f-]{36})$/i;
const COORD_LIMIT = 100_000;
const text = (value, max) => typeof value === 'string' ? [...value.trim()].slice(0, max).join('') : '';
const coord = (value) => Number.isFinite(value) ? Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, Math.round(Number(value)))) : 0;
const oneOf = (value, values, fallback) => values.includes(value) ? value : fallback;

/** @typedef {{id:string,kind:string,title:string,body:string,status:string,x:number,y:number,checkedPerson:string,missingEvidence:string,neededExplanation:string}} GraphNode */
/** @typedef {{id:string,from:string,to:string,kind:string,purpose:string,status:string}} GraphEdge */
/** @typedef {{v:1,nodes:GraphNode[],edges:GraphEdge[]}} GraphDoc */

/** @param {unknown} value @returns {GraphNode|null} */
export function normalizeGraphNode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = /** @type {Record<string, unknown>} */ (value);
  if (typeof v.id !== 'string' || !GRAPH_ID.test(v.id)) return null;
  return {
    id: v.id,
    kind: oneOf(v.kind, GRAPH_NODE_KINDS, 'task'),
    title: text(v.title, 100),
    body: text(v.body, 1000),
    status: oneOf(v.status, GRAPH_NODE_STATES, 'open'),
    x: coord(v.x),
    y: coord(v.y),
    checkedPerson: text(v.checkedPerson, 100),
    missingEvidence: text(v.missingEvidence, 500),
    neededExplanation: text(v.neededExplanation, 500),
  };
}

/** @param {unknown} value @returns {GraphEdge|null} */
export function normalizeGraphEdge(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = /** @type {Record<string, unknown>} */ (value);
  if (typeof v.id !== 'string' || !EDGE_ID.test(v.id)) return null;
  const from = typeof v.from === 'string' ? v.from : '';
  const to = typeof v.to === 'string' ? v.to : '';
  if (!validEndpoint(from) || !validEndpoint(to) || from === to) return null;
  const kind = oneOf(v.kind, GRAPH_EDGE_KINDS, 'related');
  return {
    id: v.id,
    from,
    to,
    kind,
    purpose: text(v.purpose, 240),
    status: kind === 'delegates' ? oneOf(v.status, DELEGATION_STATES, 'planned') : '',
  };
}

/** @param {string} endpoint */
export function validEndpoint(endpoint) {
  if (endpoint.startsWith('graph:')) return GRAPH_ID.test(endpoint.slice(6));
  if (endpoint.startsWith('session:')) return SESSION_ID.test(endpoint.slice(8));
  return false;
}

/** @param {unknown} raw @returns {GraphDoc} */
export function normalizeGraph(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { v: 1, nodes: [], edges: [] };
  const v = /** @type {Record<string, unknown>} */ (raw);
  const nodes = (Array.isArray(v.nodes) ? v.nodes : []).map(normalizeGraphNode).filter((n) => n && n.title).slice(0, GRAPH_MAX_NODES);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(v.edges) ? v.edges : []).map(normalizeGraphEdge).filter((e) => e && endpointPresent(e.from, nodeIds) && endpointPresent(e.to, nodeIds)).slice(0, GRAPH_MAX_EDGES);
  return { v: 1, nodes, edges };
}

/** @param {string} endpoint @param {Set<string>} nodeIds */
function endpointPresent(endpoint, nodeIds) {
  return endpoint.startsWith('graph:') ? nodeIds.has(endpoint.slice(6)) : endpoint.startsWith('session:');
}

/** @param {GraphDoc} doc @param {Omit<GraphNode,'id'>} input @param {string} id @returns {GraphDoc} */
export function addGraphNode(doc, input, id) {
  if (!GRAPH_ID.test(id) || doc.nodes.length >= GRAPH_MAX_NODES || doc.nodes.some((n) => n.id === id)) return doc;
  const node = normalizeGraphNode({ ...input, id });
  if (!node || !node.title) return doc;
  return { ...doc, nodes: [...doc.nodes, node] };
}

/** Create a task and its local session relation as one immutable change.
 * @param {GraphDoc} doc @param {Omit<GraphNode,'id'>} input @param {string} id @param {string} edgeId @param {string} sessionId
 * @returns {GraphDoc}
 */
export function addTaskForSession(doc, input, id, edgeId, sessionId) {
  if (!SESSION_ID.test(sessionId)) return doc;
  const withTask = addGraphNode(doc, { ...input, kind: 'task' }, id);
  if (withTask === doc) return doc;
  const linked = connectGraph(withTask, {
    from: `graph:${id}`, to: `session:${sessionId}`, kind: 'related', purpose: 'Created from this session', status: '',
  }, edgeId, new Set([sessionId]));
  return linked.edges.length === withTask.edges.length + 1 ? linked : doc;
}

/**
 * Find the first non-overlapping card slot around the current view center.
 * New cards otherwise stack exactly under the pointer and hide one another.
 * @param {GraphDoc} doc @param {{x:number,y:number}} center @param {{width:number,height:number}} size
 * @returns {{x:number,y:number}}
 */
export function nextGraphNodePosition(doc, center, size) {
  const gap = 24;
  const stepX = Math.max(1, size.width + gap);
  const stepY = Math.max(1, size.height + gap);
  const overlaps = (x, y) => doc.nodes.some((node) =>
    x < node.x + size.width + gap && x + size.width + gap > node.x
    && y < node.y + size.height + gap && y + size.height + gap > node.y);
  for (let ring = 0; ring <= GRAPH_MAX_NODES; ring++) {
    const points = [];
    if (ring === 0) points.push([0, 0]);
    else {
      for (let x = -ring; x <= ring; x++) points.push([x, -ring], [x, ring]);
      for (let y = -ring + 1; y < ring; y++) points.push([-ring, y], [ring, y]);
    }
    for (const [dx, dy] of points) {
      const x = coord(center.x + /** @type {number} */ (dx) * stepX);
      const y = coord(center.y + /** @type {number} */ (dy) * stepY);
      if (!overlaps(x, y)) return { x, y };
    }
  }
  return { x: coord(center.x), y: coord(center.y) };
}

/** @param {GraphDoc} doc @param {string} id @param {Partial<Omit<GraphNode,'id'>>} patch @returns {GraphDoc} */
export function updateGraphNode(doc, id, patch) {
  const nodes = doc.nodes.map((node) => node.id === id ? normalizeGraphNode({ ...node, ...patch, id }) ?? node : node);
  return nodes.some((n, i) => n !== doc.nodes[i]) ? { ...doc, nodes } : doc;
}

/** @param {GraphDoc} doc @param {string} id @param {number} x @param {number} y @returns {GraphDoc} */
export function moveGraphNode(doc, id, x, y) {
  const node = doc.nodes.find((n) => n.id === id);
  return node ? updateGraphNode(doc, id, { x: coord(x), y: coord(y) }) : doc;
}

/** @param {GraphDoc} doc @param {string} id @returns {GraphDoc} */
export function removeGraphNode(doc, id) {
  if (!doc.nodes.some((n) => n.id === id)) return doc;
  const endpoint = `graph:${id}`;
  return { ...doc, nodes: doc.nodes.filter((n) => n.id !== id), edges: doc.edges.filter((e) => e.from !== endpoint && e.to !== endpoint) };
}

/** @param {GraphDoc} doc @param {Omit<GraphEdge,'id'>} input @param {string} id @param {Set<string>} sessionIds @returns {GraphDoc} */
export function connectGraph(doc, input, id, sessionIds = new Set()) {
  if (!EDGE_ID.test(id) || doc.edges.length >= GRAPH_MAX_EDGES || doc.edges.some((e) => e.id === id)) return doc;
  const edge = normalizeGraphEdge({ ...input, id });
  if (!edge || !endpointExists(doc, edge.from, sessionIds) || !endpointExists(doc, edge.to, sessionIds)) return doc;
  if (doc.edges.some((e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind)) return doc;
  return { ...doc, edges: [...doc.edges, edge] };
}

/** @param {GraphDoc} doc @param {string} id @param {Set<string>} sessionIds */
function endpointExists(doc, endpoint, sessionIds) {
  return endpoint.startsWith('graph:') ? doc.nodes.some((n) => n.id === endpoint.slice(6)) : sessionIds.has(endpoint.slice(8));
}

/** @param {GraphDoc} doc @param {string} id @param {Partial<Omit<GraphEdge,'id'|'from'|'to'>>} patch */
export function updateGraphEdge(doc, id, patch) {
  const previous = doc.edges.find((edge) => edge.id === id);
  if (!previous) return doc;
  const changed = normalizeGraphEdge({ ...previous, ...patch, id: previous.id, from: previous.from, to: previous.to });
  if (!changed || doc.edges.some((edge) => edge.id !== id && edge.from === changed.from && edge.to === changed.to && edge.kind === changed.kind)) return doc;
  const edges = doc.edges.map((edge) => edge.id === id ? changed : edge);
  return edges.some((edge, i) => edge !== doc.edges[i]) ? { ...doc, edges } : doc;
}

/** @param {GraphDoc} doc @param {string} id */
export function removeGraphEdge(doc, id) {
  const edges = doc.edges.filter((edge) => edge.id !== id);
  return edges.length === doc.edges.length ? doc : { ...doc, edges };
}

/**
 * Graph-only review hints for open comprehension gaps. These indicate missing
 * evidence/explanation links in the user's graph, never a person's inferred
 * understanding or comprehension score.
 * @param {GraphDoc} doc
 * @returns {Array<{id:string,missing:Array<'evidence'|'explains'>}>}
 */
export function reviewUnderstandingGaps(doc) {
  return doc.nodes
    .filter((node) => node.kind === 'understanding_gap' && node.status !== 'resolved' && node.status !== 'done')
    .map((node) => {
      const connected = new Set(doc.edges.filter((edge) => edge.from === `graph:${node.id}` || edge.to === `graph:${node.id}`).map((edge) => edge.kind));
      const missing = [];
      if (node.missingEvidence && !connected.has('evidence')) missing.push('evidence');
      if (node.neededExplanation && !connected.has('explains')) missing.push('explains');
      return { id: node.id, missing: /** @type {Array<'evidence'|'explains'>} */ (missing) };
    })
    .filter((item) => item.missing.length > 0);
}
