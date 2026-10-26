// Explicit, user-confirmed execution of a recorded Codex delegation.
import { delegationStatus, runDelegation, WorktreeOperationError } from './api.mjs';
import { loadGraph } from './graph-store.mjs';
import { finishGraphDelegationOperation, startGraphDelegationOperation } from './graph-model.mjs';
import { persistDelegationOutcome } from './delegation-outcome.mjs';
import { handleDelegationStartRejection } from './delegation-runtime-reason.mjs';
import { isCompletedLocalCodexTarget } from './events.mjs';
import { openDelegationConfirmDialog } from './delegation-confirm-dialog.mjs';

/** Build safe, separately labelled confirmation fields; the full session ID never enters the dialog. @param {(key:string, params?:Record<string,unknown>)=>string} t @param {string} project @param {string} targetId @param {string} purpose */
export function delegationConfirmationDetails(t, project, targetId, purpose) {
  return {
    target: t('graph.delegationConfirmTarget', { project, provider: 'Codex CLI', target: targetId.slice(-12) }),
    purpose,
    transfer: t('graph.delegationConfirmTransfer'),
    network: t('graph.delegationConfirmNetwork'),
    output: t('graph.delegationConfirmOutput'),
    session: t('graph.delegationConfirmSession'),
  };
}

/** @param {string} edgeId @param {string} sourceId @param {string} targetId @param {string} purpose @param {{view:any,state:any,graphChanged:(doc:any)=>boolean,announce:(text:string)=>void}} deps */
async function executeConfirmedDelegation(edgeId, sourceId, targetId, purpose, { view, state, graphChanged, announce }) {
  const graph = loadGraph();
  const edge = graph.edges.find((item) => item.id === edgeId && item.kind === 'delegates' && item.from === `session:${sourceId}` && item.to === `session:${targetId}` && item.status === 'planned' && item.purpose === purpose);
  const target = view.index.get(targetId)?.card;
  if (!edge || !target || !isCompletedLocalCodexTarget(target)) {
    announce(state.t('graph.delegationUnavailable'));
    return false;
  }
  const operationId = crypto.randomUUID();
  if (!graphChanged(startGraphDelegationOperation(graph, edgeId, operationId))) return false;
  let startAccepted = false;
  try {
    const started = await runDelegation(targetId, purpose, operationId);
    if (started.operationId !== operationId || !['running', 'completed', 'failed'].includes(started.status)) throw new Error('invalid operation response');
    startAccepted = true;
    announce(state.t('graph.delegationStarted'));
    for (let attempt = 0; attempt < 600; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = await delegationStatus(operationId);
      if (status === 'running') continue;
      const outcome = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'blocked';
      if (!persistDelegationOutcome({ edgeId, operationId, status: outcome, loadGraph, graphChanged })) return false;
      announce(state.t(status === 'completed' ? 'graph.delegationCompleted' : 'graph.delegationFailed'));
      return true;
    }
    announce(state.t('graph.delegationStillRunning'));
  } catch (error) {
    if (!startAccepted && error instanceof WorktreeOperationError && handleDelegationStartRejection({
      status: error.status, reason: error.reason, edgeId, operationId, loadGraph, graphChanged, announce, t: state.t,
    })) {
      return false;
    }
    announce(state.t('graph.delegationStatusLost'));
  }
  return false;
}

/** @param {string} edgeId @param {string} sourceId @param {{view:any,state:any,graphChanged:(doc:any)=>boolean,announce:(text:string)=>void}} deps */
export async function runDelegationForEdge(edgeId, sourceId, { view, state, graphChanged, announce }) {
  const graph = loadGraph();
  const edge = graph.edges.find((item) => item.id === edgeId && item.kind === 'delegates' && item.from === `session:${sourceId}`);
  if (!edge) return false;
  if (edge.status === 'active' && edge.operationId) {
    try {
      const status = await delegationStatus(edge.operationId);
      if (status === 'running') { announce(state.t('graph.delegationStarted')); return true; }
      const outcome = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'blocked';
      if (!persistDelegationOutcome({ edgeId, operationId: edge.operationId, status: outcome, loadGraph, graphChanged })) return false;
      announce(state.t(status === 'completed' ? 'graph.delegationCompleted' : 'graph.delegationFailed'));
    } catch {
      if (!persistDelegationOutcome({ edgeId, operationId: edge.operationId, status: 'blocked', loadGraph, graphChanged })) return false;
      announce(state.t('graph.delegationStatusLost'));
    }
    return true;
  }
  if (edge.status !== 'planned' || !edge.purpose) return false;
  const targetId = edge.to.startsWith('session:') ? edge.to.slice(8) : '';
  const target = view.index.get(targetId)?.card;
  if (!targetId.startsWith('codex_') || !target || !isCompletedLocalCodexTarget(target)) {
    announce(state.t('graph.delegationUnavailable'));
    return false;
  }
  const project = target.project?.label || state.t('project.other');
  const purpose = edge.purpose;
  openDelegationConfirmDialog(state.t, delegationConfirmationDetails(state.t, project, targetId, purpose), () => {
    void executeConfirmedDelegation(edgeId, sourceId, targetId, purpose, { view, state, graphChanged, announce });
  });
  return true;
}
