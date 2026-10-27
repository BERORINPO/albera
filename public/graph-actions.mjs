// Graph relation and card editing actions stay outside the session canvas controller.
import { connectGraph, releaseBlockedGraphDelegationOperation, removeGraphEdge, removeGraphNode, updateGraphEdge, updateGraphNode } from './graph-model.mjs';
import { openGraphNodeDialog, openGraphRelationDialog } from './graph-dialog.mjs';
import { chooseGraphConnectionTarget, startGraphConnection } from './graph-connect-mode.mjs';
import { firstUnderstandingGapForReview } from './graph-review-queue.mjs';

/** @param {any} node @param {any} graph @param {Set<string>} sessionIds */
export function linkedWorktreeSessionId(node, graph, sessionIds) {
  return worktreeRefreshState(node, graph, sessionIds).sessionId ?? '';
}

/** @param {any} node @param {any} graph @param {Set<string>} sessionIds */
export function worktreeRefreshState(node, graph, sessionIds) {
  if (node?.kind !== 'worktree' || node.status === 'done') return { status: 'not_applicable' };
  const relatedIds = graph.edges
    .filter((item) => item.from === `graph:${node.id}` && item.kind === 'related' && item.to.startsWith('session:'))
    .map((item) => item.to.slice('session:'.length));
  if (!relatedIds.length) return { status: 'unlinked' };
  const sessionId = relatedIds.find((id) => sessionIds.has(id));
  return sessionId ? { status: 'available', sessionId } : { status: 'source_missing' };
}

/** @param {{cv:any,loadGraph:()=>any,graphChanged:(doc:any)=>boolean,graphSessions:()=>any[],render:()=>void,announce:(text:string)=>void,getT:()=>import('./i18n.mjs').T,world:()=>HTMLElement,sessionIds:()=>Set<string>,refreshWorktree?:(sessionId:string,branch:string,afterClose:()=>void)=>void}} o */
export function createGraphActions(o) {
  const t = () => o.getT();
  const connectEndpoint = (from, initialKind, initialTo) => {
    const graph = o.loadGraph();
    return openGraphRelationDialog({ t: t(), announce: o.announce, from, initialKind, initialTo, graph, sessions: o.graphSessions(), onConnect: (input) => {
      return o.graphChanged(connectGraph(graph, input, 'e_' + crypto.randomUUID(), o.sessionIds()));
    } });
  };
  const editEdge = (id) => {
    const graph = o.loadGraph();
    const edge = graph.edges.find((item) => item.id === id);
    if (!edge) return false;
    return openGraphRelationDialog({
      t: t(), announce: o.announce, from: edge.from, edge, graph, sessions: o.graphSessions(),
      onConnect: (input) => o.graphChanged(updateGraphEdge(o.loadGraph(), edge.id, input)),
      onDeleteEdge: (key) => o.graphChanged(removeGraphEdge(o.loadGraph(), key)),
      onResolveOperation: (key, operationId) => o.graphChanged(releaseBlockedGraphDelegationOperation(o.loadGraph(), key, operationId, true)),
    });
  };
  const editNode = (id) => {
    const graph = o.loadGraph();
    const node = graph.nodes.find((item) => item.id === id);
    if (!node) return;
    const refreshState = worktreeRefreshState(node, graph, o.sessionIds());
    openGraphNodeDialog({
      t: t(), announce: o.announce, graph, node, sessions: o.graphSessions(),
      onSave: (input, sessionIds) => o.graphChanged(updateGraphNode(graph, id, input, sessionIds)),
      onDelete: (key) => o.graphChanged(removeGraphNode(graph, key)),
      onEditEdge: (edge) => editEdge(edge.id),
      onConnect: (from, kind) => connectEndpoint(from, kind),
      ...(refreshState.status === 'available' && o.refreshWorktree ? { onRefreshWorktree: (afterClose) => o.refreshWorktree?.(refreshState.sessionId, node.title, afterClose) } : {}),
      ...(refreshState.status === 'unlinked' || refreshState.status === 'source_missing' ? { worktreeRefreshUnavailable: refreshState.status } : {}),
    });
  };
  const connectMode = {
    start: (id) => o.cv.graphConnectFrom
      ? chooseGraphConnectionTarget({ cv: o.cv, render: o.render, connect: (from, to) => connectEndpoint('graph:' + from, undefined, 'graph:' + to) }, id)
      : startGraphConnection({
        cv: o.cv, loadGraph: o.loadGraph, render: o.render, announce: (text) => o.announce(text), t: t(),
        focusTarget: (sourceId) => /** @type {HTMLElement|null} */ (o.world().querySelector('.graph-connect-handle[data-id]:not([data-id="' + CSS.escape(sourceId) + '"])'))?.focus({ preventScroll: true }),
      }, id),
    target: (id) => chooseGraphConnectionTarget({ cv: o.cv, render: o.render, connect: (from, to) => connectEndpoint('graph:' + from, undefined, 'graph:' + to) }, id),
  };
  return {
    connectSession: (id) => connectEndpoint('session:' + id),
    connectNodes: (sourceId, targetId) => {
      if (!sourceId || !targetId || sourceId === targetId) return false;
      return connectEndpoint('graph:' + sourceId, undefined, 'graph:' + targetId);
    },
    connectCanvasEndpoints: (sourceKind, sourceId, targetKind, targetId) => {
      if (!['graph', 'session'].includes(sourceKind) || !['graph', 'session'].includes(targetKind) || !sourceId || !targetId || (sourceKind === targetKind && sourceId === targetId)) return false;
      return connectEndpoint(`${sourceKind === 'graph' ? 'graph' : 'session'}:${sourceId}`, undefined, `${targetKind === 'graph' ? 'graph' : 'session'}:${targetId}`);
    },
    editEdge,
    reviewFirstGap: () => {
      const first = firstUnderstandingGapForReview(o.loadGraph(), o.sessionIds());
      return first ? editNode(first.id) : false;
    },
    openNode: (id) => connectMode.target(id) ?? editNode(id),
    startConnect: connectMode.start,
  };
}
