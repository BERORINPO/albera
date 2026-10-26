// Explicit, user-confirmed execution of a recorded Codex delegation.
import { delegationStatus, runDelegation, WorktreeOperationError } from './api.mjs';
import { loadGraph } from './graph-store.mjs';
import { updateGraphEdge } from './graph-model.mjs';

/** @param {string} edgeId @param {string} sourceId @param {{view:any,state:any,graphChanged:(doc:any)=>boolean,announce:(text:string)=>void}} deps */
export async function runDelegationForEdge(edgeId, sourceId, { view, state, graphChanged, announce }) {
  const graph = loadGraph();
  const edge = graph.edges.find((item) => item.id === edgeId && item.kind === 'delegates' && item.from === `session:${sourceId}`);
  if (!edge) return false;
  if (edge.status === 'active' && edge.operationId) {
    try {
      const status = await delegationStatus(edge.operationId);
      if (status === 'running') { announce(state.t('graph.delegationStarted')); return true; }
      graphChanged(updateGraphEdge(loadGraph(), edgeId, { status: status === 'completed' ? 'completed' : 'blocked' }));
      announce(state.t(status === 'completed' ? 'graph.delegationCompleted' : 'graph.delegationFailed'));
    } catch {
      graphChanged(updateGraphEdge(loadGraph(), edgeId, { status: 'blocked' }));
      announce(state.t('graph.delegationStatusLost'));
    }
    return true;
  }
  if (edge.status !== 'planned' || !edge.purpose) return false;
  const targetId = edge.to.startsWith('session:') ? edge.to.slice(8) : '';
  const target = view.index.get(targetId)?.card;
  const terminal = ['turn_completed', 'turn_aborted', 'turn_failed'].includes(target?.events?.at(-1)?.type);
  if (!targetId.startsWith('codex_') || !target || !terminal || target.detail?.executionLocation === 'wsl') {
    announce(state.t('graph.delegationUnavailable'));
    return false;
  }
  const project = target.project?.label || state.t('project.other');
  if (!window.confirm(state.t('graph.runDelegationConfirm', { project, purpose: edge.purpose }))) return false;
  const operationId = crypto.randomUUID();
  if (!graphChanged(updateGraphEdge(graph, edgeId, { status: 'active', operationId }))) return false;
  try {
    const started = await runDelegation(targetId, edge.purpose, operationId);
    if (started.operationId !== operationId || !['running', 'completed', 'failed'].includes(started.status)) throw new Error('invalid operation response');
    announce(state.t('graph.delegationStarted'));
    for (let attempt = 0; attempt < 600; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = await delegationStatus(operationId);
      if (status === 'running') continue;
      graphChanged(updateGraphEdge(loadGraph(), edgeId, { status: status === 'completed' ? 'completed' : 'blocked' }));
      announce(state.t(status === 'completed' ? 'graph.delegationCompleted' : 'graph.delegationFailed'));
      return true;
    }
    announce(state.t('graph.delegationStillRunning'));
  } catch (error) {
    if (error instanceof WorktreeOperationError && error.reason === 'cli_unavailable') {
      graphChanged(updateGraphEdge(loadGraph(), edgeId, { status: 'blocked' }));
      announce(state.t('graph.delegationCliUnavailable'));
      return false;
    }
    announce(state.t('graph.delegationStatusLost'));
  }
  return false;
}
