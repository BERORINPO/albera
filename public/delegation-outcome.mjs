// A terminal delegation state must not be announced unless its local graph record was saved.
import { finishGraphDelegationOperation } from './graph-model.mjs';

/** @param {{edgeId:string,operationId:string,status:'completed'|'blocked',loadGraph:()=>any,graphChanged:(doc:any)=>boolean}} o */
export function persistDelegationOutcome({ edgeId, operationId, status, loadGraph, graphChanged }) {
  const graph = loadGraph();
  const next = finishGraphDelegationOperation(graph, edgeId, operationId, status);
  return next !== graph && graphChanged(next) === true;
}
