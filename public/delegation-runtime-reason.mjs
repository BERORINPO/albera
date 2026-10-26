// Convert the server's fixed delegation rejection codes to safe UI messages.
import { persistDelegationOutcome } from './delegation-outcome.mjs';
const REASONS = Object.freeze({
  invalid_target: 'graph.delegationRejectedTarget',
  unsupported_location: 'graph.delegationRejectedLocation',
  session_active: 'graph.delegationRejectedActive',
  session_unknown: 'graph.delegationRejectedMissing',
  already_running: 'graph.delegationRejectedRunning',
  operation_limit: 'graph.delegationRejectedLimit',
  cli_unavailable: 'graph.delegationCliUnavailable',
});

/** Map only allowlisted server reason codes; never expose diagnostics. @param {unknown} reason */
export function delegationRuntimeReasonKey(reason) {
  return typeof reason === 'string' && Object.hasOwn(REASONS, reason) ? REASONS[reason] : null;
}

/** Persist an explicitly rejected start as blocked before announcing its safe reason. @param {{reason:unknown,edgeId:string,operationId:string,loadGraph:()=>any,graphChanged:(doc:any)=>boolean,announce:(text:string)=>void,t:(key:string)=>string}} o */
export function handleDelegationStartRejection({ reason, edgeId, operationId, loadGraph, graphChanged, announce, t }) {
  const key = delegationRuntimeReasonKey(reason);
  if (!key || !persistDelegationOutcome({ edgeId, operationId, status: 'blocked', loadGraph, graphChanged })) return false;
  announce(t(key));
  return true;
}
