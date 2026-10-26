// Graph relation and card editing actions stay outside the session canvas controller.
import { connectGraph, releaseBlockedGraphDelegationOperation, removeGraphEdge, removeGraphNode, updateGraphEdge, updateGraphNode } from './graph-model.mjs';
import { openGraphNodeDialog, openGraphRelationDialog } from './graph-dialog.mjs';
import { chooseGraphConnectionTarget, startGraphConnection } from './graph-connect-mode.mjs';

/** @param {{cv:any,loadGraph:()=>any,graphChanged:(doc:any)=>boolean,graphSessions:()=>any[],render:()=>void,announce:(text:string)=>void,t:(key:string)=>string,world:()=>HTMLElement,sessionIds:()=>Set<string>}} o */
export function createGraphActions(o) {
  const connectEndpoint = (from, initialKind, initialTo) => {
    const graph = o.loadGraph();
    return openGraphRelationDialog({ t: o.t, from, initialKind, initialTo, graph, sessions: o.graphSessions(), onConnect: (input) => {
      o.graphChanged(connectGraph(graph, input, 'e_' + crypto.randomUUID(), o.sessionIds()));
    } });
  };
  const editEdge = (id) => {
    const graph = o.loadGraph();
    const edge = graph.edges.find((item) => item.id === id);
    if (!edge) return false;
    return openGraphRelationDialog({
      t: o.t, from: edge.from, edge, graph, sessions: o.graphSessions(),
      onConnect: (input) => o.graphChanged(updateGraphEdge(o.loadGraph(), edge.id, input)),
      onDeleteEdge: (key) => o.graphChanged(removeGraphEdge(o.loadGraph(), key)),
      onResolveOperation: (key, operationId) => o.graphChanged(releaseBlockedGraphDelegationOperation(o.loadGraph(), key, operationId, true)),
    });
  };
  const editNode = (id) => {
    const graph = o.loadGraph();
    const node = graph.nodes.find((item) => item.id === id);
    if (!node) return;
    openGraphNodeDialog({
      t: o.t, graph, node, sessions: o.graphSessions(),
      onSave: (input, sessionIds) => o.graphChanged(updateGraphNode(graph, id, input, sessionIds)),
      onDelete: (key) => o.graphChanged(removeGraphNode(graph, key)),
      onEditEdge: (edge) => editEdge(edge.id),
      onConnect: (from, kind) => connectEndpoint(from, kind),
    });
  };
  const connectMode = {
    start: (id) => o.cv.graphConnectFrom
      ? chooseGraphConnectionTarget({ cv: o.cv, render: o.render, connect: (from, to) => connectEndpoint('graph:' + from, undefined, 'graph:' + to) }, id)
      : startGraphConnection({
        cv: o.cv, loadGraph: o.loadGraph, render: o.render, announce: (text) => o.announce(text), t: o.t,
        focusTarget: (sourceId) => /** @type {HTMLElement|null} */ (o.world().querySelector('.graph-connect-handle[data-id]:not([data-id="' + CSS.escape(sourceId) + '"])'))?.focus({ preventScroll: true }),
      }, id),
    target: (id) => chooseGraphConnectionTarget({ cv: o.cv, render: o.render, connect: (from, to) => connectEndpoint('graph:' + from, undefined, 'graph:' + to) }, id),
  };
  return {
    connectSession: (id) => connectEndpoint('session:' + id),
    editEdge,
    openNode: (id) => connectMode.target(id) ?? editNode(id),
    startConnect: connectMode.start,
  };
}
