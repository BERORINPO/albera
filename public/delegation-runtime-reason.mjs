// Convert the server's fixed delegation rejection codes to safe UI messages.
import { persistRejectedDelegationStart } from './delegation-outcome.mjs';
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

/** Release a matching tentative lock only for a fixed 422 response, which guarantees no child process started. @param {{status:number,reason:unknown,edgeId:string,operationId:string,loadGraph:()=>any,graphChanged:(doc:any)=>boolean,announce:(text:string)=>void,t:(key:string)=>string}} o */
export function handleDelegationStartRejection({ status, reason, edgeId, operationId, loadGraph, graphChanged, announce, t }) {
  if (status !== 422) return false;
  const key = delegationRuntimeReasonKey(reason);
  if (!key || !persistRejectedDelegationStart({ edgeId, operationId, loadGraph, graphChanged })) return false;
  announce(t(key));
  return true;
}
