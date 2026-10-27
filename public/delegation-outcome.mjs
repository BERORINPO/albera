// A terminal delegation state must not be announced unless its local graph record was saved.
import { finishGraphDelegationOperation, rejectGraphDelegationOperation } from './graph-model.mjs';

/** @param {{edgeId:string,operationId:string,status:'completed'|'failed'|'blocked',loadGraph:()=>any,graphChanged:(doc:any)=>boolean}} o */
export function persistDelegationOutcome({ edgeId, operationId, status, loadGraph, graphChanged }) {
  const graph = loadGraph();
  const next = finishGraphDelegationOperation(graph, edgeId, operationId, status);
  return next !== graph && graphChanged(next) === true;
}

/** A fixed HTTP rejection proves no process started; release only its matching tentative lock. @param {{edgeId:string,operationId:string,loadGraph:()=>any,graphChanged:(doc:any)=>boolean}} o */
export function persistRejectedDelegationStart({ edgeId, operationId, loadGraph, graphChanged }) {
  const graph = loadGraph();
  const next = rejectGraphDelegationOperation(graph, edgeId, operationId);
  return next !== graph && graphChanged(next) === true;
}
