// @ts-check
// Pure local Agent Canvas graph model. Session payloads are never accepted here.

export const GRAPH_MAX_NODES = 200;
export const GRAPH_MAX_EDGES = 500;
export const GRAPH_NODE_KINDS = Object.freeze(['task', 'artifact', 'decision', 'understanding_gap', 'worktree', 'execution_profile', 'obsidian_note']);
export const GRAPH_NODE_STATES = Object.freeze(['open', 'in_progress', 'blocked', 'done', 'resolved']);
export const GRAPH_EDGE_KINDS = Object.freeze(['related', 'depends_on', 'delegates', 'evidence', 'explains']);
export const DELEGATION_STATES = Object.freeze(['planned', 'active', 'blocked', 'completed', 'cancelled', 'unknown']);
export const EXECUTION_LOCATIONS = Object.freeze(['unknown', 'local', 'wsl', 'remote']);
export const WORKSPACE_ISOLATIONS = Object.freeze(['unknown', 'sandboxed', 'not_sandboxed']);
export const NETWORK_ACCESS = Object.freeze(['unknown', 'restricted', 'available']);
export const APPROVAL_MODES = Object.freeze(['unknown', 'per_action', 'on_demand', 'automatic']);
export const EXECUTION_HARNESSES = Object.freeze(['unknown', 'claude_code', 'codex_cli', 'github_copilot', 'opencode', 'other']);
const GRAPH_ID = /^g_[0-9a-f-]{36}$/i;
const EDGE_ID = /^e_[0-9a-f-]{36}$/i;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID = /^(?:local_[0-9a-f-]{36}|codex_[0-9a-f-]{36}|copilot_[0-9a-f-]{36}|opencode_[0-9a-f-]{36})$/i;
const COORD_LIMIT = 100_000;
const text = (value, max) => typeof value === 'string' ? [...value.trim()].slice(0, max).join('') : '';
const coord = (value) => Number.isFinite(value) ? Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, Math.round(Number(value)))) : 0;
const oneOf = (value, values, fallback) => values.includes(value) ? value : fallback;

/** User-authored artifact links stay local and open only after an explicit click. */
export function safeArtifactUrl(value, kind = 'artifact') {
  if (kind !== 'artifact' || typeof value !== 'string' || value.length > 500) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password || url.search || url.hash) return '';
    return url.href;
  } catch {
    return '';
  }
}

/** Obsidian note references stay local and contain only a user-entered vault and relative note path. */
export function safeObsidianVault(value) {
  if (typeof value !== 'string' || value.length > 100) return '';
  const vault = value.trim();
  if (!vault || /[\\/:?#\u0000-\u001f\u007f]/u.test(vault)) return '';
  return vault;
}

/** Only vault-relative note paths are accepted; absolute paths and dot segments are rejected. */
export function safeObsidianFile(value) {
  if (typeof value !== 'string' || value.length > 240) return '';
  const file = value.trim();
  if (!file || file.startsWith('/') || file.endsWith('/') || /[\\:?#\u0000-\u001f\u007f]/u.test(file)) return '';
  const segments = file.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return '';
  return file;
}

/** Build an Obsidian open URI only from safe user-entered vault-relative references. */
export function obsidianOpenUri(vaultValue, fileValue) {
  const vault = safeObsidianVault(vaultValue);
  const file = safeObsidianFile(fileValue);
  if (!vault || !file) return '';
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
}

/** @typedef {{id:string,kind:string,title:string,body:string,url:string,status:string,x:number,y:number,checkedPerson:string,missingEvidence:string,neededExplanation:string,executionHarness:string,executionLocation:string,workspaceIsolation:string,networkAccess:string,approvalMode:string}} GraphNode */
/** @typedef {{id:string,from:string,to:string,kind:string,purpose:string,status:string,operationId?:string}} GraphEdge */
/** @typedef {{v:1|2,nodes:GraphNode[],edges:GraphEdge[]}} GraphDoc v2 uses opaque provider session IDs in session endpoints. */

/** @param {unknown} value @returns {GraphNode|null} */
export function normalizeGraphNode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = /** @type {Record<string, unknown>} */ (value);
  if (typeof v.id !== 'string' || !GRAPH_ID.test(v.id)) return null;
  const kind = oneOf(v.kind, GRAPH_NODE_KINDS, 'task');
  return {
    id: v.id,
    kind,
    title: text(v.title, 100),
    body: text(v.body, 1000),
    url: safeArtifactUrl(v.url, kind),
    status: oneOf(v.status, GRAPH_NODE_STATES, 'open'),
    x: coord(v.x),
    y: coord(v.y),
    checkedPerson: text(v.checkedPerson, 100),
    missingEvidence: text(v.missingEvidence, 500),
    neededExplanation: text(v.neededExplanation, 500),
    executionHarness: kind === 'execution_profile' ? oneOf(v.executionHarness, EXECUTION_HARNESSES, 'unknown') : '',
    executionLocation: kind === 'execution_profile' ? oneOf(v.executionLocation, EXECUTION_LOCATIONS, 'unknown') : '',
    workspaceIsolation: kind === 'execution_profile' ? oneOf(v.workspaceIsolation, WORKSPACE_ISOLATIONS, 'unknown') : '',
    networkAccess: kind === 'execution_profile' ? oneOf(v.networkAccess, NETWORK_ACCESS, 'unknown') : '',
    approvalMode: kind === 'execution_profile' ? oneOf(v.approvalMode, APPROVAL_MODES, 'unknown') : '',
    knowledgeVault: kind === 'obsidian_note' ? safeObsidianVault(v.knowledgeVault) : '',
    knowledgeFile: kind === 'obsidian_note' ? safeObsidianFile(v.knowledgeFile) : '',
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
    status: kind === 'delegates' ? oneOf(v.status, DELEGATION_STATES, 'unknown') : '',
    ...(kind === 'delegates' && typeof v.operationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.operationId) ? { operationId: v.operationId } : {}),
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
  return { v: v.v === 2 ? 2 : 1, nodes, edges };
}

/** Migrate v1 provider session endpoints to opaque IDs while preserving user-authored graph data.
 * @param {GraphDoc} doc @param {(source:'codex'|'copilot', providerId:string)=>Promise<string>} opaqueId
 * @returns {Promise<GraphDoc>}
 */
export async function migrateProviderSessionEndpoints(doc, opaqueId) {
  if (doc.v === 2) return doc;
  /** @type {Map<string,string>} */
  const replacements = new Map();
  const oldId = /^(codex|copilot)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  const endpoint = async (value) => {
    if (!value.startsWith('session:')) return value;
    const id = value.slice(8);
    const match = oldId.exec(id);
    if (!match) return value;
    if (!replacements.has(id)) replacements.set(id, await opaqueId(/** @type {'codex'|'copilot'} */ (match[1].toLowerCase()), match[2].toLowerCase()));
    return `session:${replacements.get(id)}`;
  };
  const edges = [];
  for (const edge of doc.edges) edges.push({ ...edge, from: await endpoint(edge.from), to: await endpoint(edge.to) });
  return normalizeGraph({ v: 2, nodes: doc.nodes, edges });
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
  if (node.kind === 'understanding_gap' && ['done', 'resolved'].includes(node.status)) {
    if (!node.checkedPerson.trim()) return doc;
    const candidate = { ...doc, nodes: [...doc.nodes, node] };
    if (reviewUnderstandingGaps(candidate).some((item) => item.id === id && item.missing.length > 0)) return doc;
  }
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

/** Persist or refresh a safe worktree summary on the canvas and relate it to its source session in one graph update.
 * @param {GraphDoc} doc @param {Omit<GraphNode,'id'>} input @param {string} id @param {string} edgeId @param {string} sessionId
 * @param {string} [purpose]
 * @returns {GraphDoc}
 */
export function addWorktreeForSession(doc, input, id, edgeId, sessionId, purpose = 'Created by confirmed worktree action') {
  if (!SESSION_ID.test(sessionId)) return doc;
  const existing = doc.nodes.find((node) => node.kind === 'worktree' && node.title === input.title
    && doc.edges.some((edge) => edge.from === `graph:${node.id}` && edge.to === `session:${sessionId}`));
  if (existing) return updateGraphNode(doc, existing.id, { ...input, x: existing.x, y: existing.y });
  const withWorktree = addGraphNode(doc, { ...input, kind: 'worktree' }, id);
  if (withWorktree === doc) return doc;
  const linked = connectGraph(withWorktree, {
    from: `graph:${id}`, to: `session:${sessionId}`, kind: 'related', purpose, status: '',
  }, edgeId, new Set([sessionId]));
  return linked.edges.length === withWorktree.edges.length + 1 ? linked : doc;
}

/**
 * Find the first non-overlapping card slot around the current view center.
 * New cards otherwise stack exactly under the pointer and hide one another.
 * @param {GraphDoc} doc @param {{x:number,y:number}} center @param {{width:number,height:number}} size
 * @param {Array<{x:number,y:number,width:number,height:number}>} [obstacles] Existing board slips or other rectangles to avoid.
 * @returns {{x:number,y:number}}
 */
export function nextGraphNodePosition(doc, center, size, obstacles = []) {
  const gap = 24;
  const stepX = Math.max(1, size.width + gap);
  const stepY = Math.max(1, size.height + gap);
  const overlaps = (x, y) => doc.nodes.some((node) =>
    x < node.x + size.width + gap && x + size.width + gap > node.x
    && y < node.y + size.height + gap && y + size.height + gap > node.y)
    || obstacles.some((rect) => x < rect.x + rect.width + gap && x + size.width + gap > rect.x
      && y < rect.y + rect.height + gap && y + size.height + gap > rect.y);
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
  // Dense boards can exceed the bounded spiral (many project sheets may cover
  // the viewport). Never return the occupied center; spill just beyond the
  // nearest side of the complete graph/obstacle bounds.
  const bounds = [
    ...doc.nodes.map((node) => ({ x: node.x, y: node.y, width: size.width, height: size.height })),
    ...obstacles.filter((rect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)),
  ];
  if (!bounds.length) return { x: coord(center.x), y: coord(center.y) };
  const left = Math.min(...bounds.map((rect) => rect.x));
  const top = Math.min(...bounds.map((rect) => rect.y));
  const right = Math.max(...bounds.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...bounds.map((rect) => rect.y + rect.height));
  const spill = [
    { x: coord(right + gap), y: coord(center.y) },
    { x: coord(left - size.width - gap), y: coord(center.y) },
    { x: coord(center.x), y: coord(bottom + gap) },
    { x: coord(center.x), y: coord(top - size.height - gap) },
  ].filter((point) => !overlaps(point.x, point.y));
  spill.sort((a, b) => (Math.abs(a.x - center.x) + Math.abs(a.y - center.y)) - (Math.abs(b.x - center.x) + Math.abs(b.y - center.y)));
  return spill[0] ?? { x: coord(center.x), y: coord(center.y) };
}

/** Use full sheet and archive-fold bounds so cards cannot cover headings, slips, or counts. @param {any} layout */
export function graphPlacementObstacles(layout) {
  const boxes = (layout?.sheets ?? []).map((sheet) => ({ x: sheet.x, y: sheet.y, width: sheet.w, height: sheet.h }));
  if (layout?.fold) boxes.push({ x: layout.fold.x, y: layout.fold.y, width: layout.fold.w, height: layout.fold.h });
  return boxes;
}

/** @param {GraphDoc} doc @param {string} id @param {Partial<Omit<GraphNode,'id'>>} patch @param {Set<string>} [sessionIds] @returns {GraphDoc} */
export function updateGraphNode(doc, id, patch, sessionIds = new Set()) {
  const current = doc.nodes.find((node) => node.id === id);
  if (!current) return doc;
  const changed = normalizeGraphNode({ ...current, ...patch, id }) ?? current;
  const terminalGapChanged = changed.kind === 'understanding_gap'
    && ['done', 'resolved'].includes(changed.status)
    && (current.kind !== changed.kind || current.status !== changed.status || current.checkedPerson !== changed.checkedPerson);
  if (terminalGapChanged) {
    if (!changed.checkedPerson.trim()) return doc;
    const candidate = { ...doc, nodes: doc.nodes.map((node) => node.id === id ? changed : node) };
    if (reviewUnderstandingGaps(candidate, sessionIds).some((item) => item.id === id && item.missing.length > 0)) return doc;
  }
  const nodes = doc.nodes.map((node) => node.id === id ? changed : node);
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
  if (doc.edges.some((edge) => edge.operationId && edge.status !== 'completed' && (edge.from === endpoint || edge.to === endpoint))) return doc;
  return { ...doc, nodes: doc.nodes.filter((n) => n.id !== id), edges: doc.edges.filter((e) => e.from !== endpoint && e.to !== endpoint) };
}

/** @param {GraphDoc} doc @param {Omit<GraphEdge,'id'>} input @param {string} id @param {Set<string>} sessionIds @returns {GraphDoc} */
export function connectGraph(doc, input, id, sessionIds = new Set()) {
  if (!EDGE_ID.test(id) || doc.edges.length >= GRAPH_MAX_EDGES || doc.edges.some((e) => e.id === id)) return doc;
  const edge = normalizeGraphEdge({ ...input, id });
  if (!edge || (['delegates', 'evidence', 'explains'].includes(edge.kind) && !edge.purpose)
    || !endpointExists(doc, edge.from, sessionIds) || !endpointExists(doc, edge.to, sessionIds)) return doc;
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
  if (previous.operationId) return doc;
  const changed = normalizeGraphEdge({ ...previous, ...patch, id: previous.id, from: previous.from, to: previous.to });
  if (!changed || doc.edges.some((edge) => edge.id !== id && edge.from === changed.from && edge.to === changed.to && edge.kind === changed.kind)) return doc;
  if (['delegates', 'evidence', 'explains'].includes(changed.kind) && !changed.purpose) return doc;
  if (changed.kind === previous.kind && changed.purpose === previous.purpose && changed.status === previous.status && changed.operationId === previous.operationId) return doc;
  const edges = doc.edges.map((edge) => edge.id === id ? changed : edge);
  return edges.some((edge, i) => edge !== doc.edges[i]) ? { ...doc, edges } : doc;
}

/** @param {GraphDoc} doc @param {string} id @param {string} operationId */
export function startGraphDelegationOperation(doc, id, operationId) {
  const edge = doc.edges.find((item) => item.id === id);
  if (!edge || edge.kind !== 'delegates' || edge.status !== 'planned' || edge.operationId || !edge.purpose || !OPERATION_ID.test(operationId ?? '')) return doc;
  const changed = { ...edge, status: 'active', operationId };
  return { ...doc, edges: doc.edges.map((item) => item.id === id ? changed : item) };
}

/** A fixed server rejection means no child process was started; clear the tentative operation and keep the user-authored plan retryable. @param {GraphDoc} doc @param {string} id @param {string} operationId */
export function rejectGraphDelegationOperation(doc, id, operationId) {
  const edge = doc.edges.find((item) => item.id === id);
  if (!edge || edge.kind !== 'delegates' || edge.status !== 'active' || edge.operationId !== operationId) return doc;
  const { operationId: _discarded, ...rest } = edge;
  const changed = { ...rest, status: 'planned' };
  return { ...doc, edges: doc.edges.map((item) => item.id === id ? changed : item) };
}

/** @param {GraphDoc} doc @param {string} id @param {string} operationId @param {'completed'|'blocked'} status */
export function finishGraphDelegationOperation(doc, id, operationId, status) {
  const edge = doc.edges.find((item) => item.id === id);
  if (!edge || edge.kind !== 'delegates' || edge.status !== 'active' || edge.operationId !== operationId || !['completed', 'blocked'].includes(status)) return doc;
  const changed = { ...edge, status };
  return { ...doc, edges: doc.edges.map((item) => item.id === id ? changed : item) };
}

/** @param {GraphDoc} doc @param {string} id @param {string} operationId @param {boolean} confirmed */
export function releaseBlockedGraphDelegationOperation(doc, id, operationId, confirmed) {
  const edge = doc.edges.find((item) => item.id === id);
  if (confirmed !== true || !edge || edge.kind !== 'delegates' || edge.status !== 'blocked' || edge.operationId !== operationId) return doc;
  const { operationId: _discarded, ...changed } = edge;
  return { ...doc, edges: doc.edges.map((item) => item.id === id ? changed : item) };
}

/** @param {GraphDoc} doc @param {string} id */
export function removeGraphEdge(doc, id) {
  const target = doc.edges.find((edge) => edge.id === id);
  if (target?.operationId && target.status !== 'completed') return doc;
  const edges = doc.edges.filter((edge) => edge.id !== id);
  return edges.length === doc.edges.length ? doc : { ...doc, edges };
}

/**
 * Graph-only review hints for open comprehension gaps. These indicate missing
 * evidence/explanation links in the user's graph, never a person's inferred
 * understanding or comprehension score.
 * @param {GraphDoc} doc
 * @param {Set<string>} [sessionIds] Current read-only session IDs; dangling session links do not satisfy a gap.
 * @returns {Array<{id:string,missing:Array<'evidence'|'explains'>,incomplete:Array<{kind:'evidence'|'explains',edgeId:string}>}>}
 */
export function reviewUnderstandingGaps(doc, sessionIds = new Set()) {
  return doc.nodes
    .filter((node) => node.kind === 'understanding_gap')
    .map((node) => {
      const endpoint = `graph:${node.id}`;
      const linkedEdges = doc.edges
        .filter((edge) => edge.from === endpoint || edge.to === endpoint)
        .filter((edge) => {
          const other = edge.from === endpoint ? edge.to : edge.from;
          if (other.startsWith('graph:')) return doc.nodes.some((item) => `graph:${item.id}` === other);
          return other.startsWith('session:') && sessionIds.has(other.slice(8));
        });
      const connected = new Set(doc.edges
        .filter((edge) => linkedEdges.includes(edge))
        .filter((edge) => edge.purpose.trim())
        .map((edge) => edge.kind));
      const missing = [];
      if (node.missingEvidence && !connected.has('evidence')) missing.push('evidence');
      if (node.neededExplanation && !connected.has('explains')) missing.push('explains');
      const incomplete = /** @type {Array<{kind:'evidence'|'explains',edgeId:string}>} */ ([]);
      for (const kind of /** @type {Array<'evidence'|'explains'>} */ (missing)) {
        const edge = linkedEdges.find((item) => item.kind === kind && !item.purpose.trim());
        if (edge) incomplete.push({ kind, edgeId: edge.id });
      }
      return { id: node.id, missing: /** @type {Array<'evidence'|'explains'>} */ (missing), incomplete };
    })
    .filter((item) => item.missing.length > 0);
}
