// @ts-check

/**
 * Release a blocked operation lock only after an explicit review and a saved
 * local graph update. Returns true only when the caller may close the dialog.
 * @param {{edge?:any,confirm:()=>boolean,resolve:(id:string,operationId:string)=>boolean}} options
 */
export function confirmBlockedOperationRelease({ edge, confirm, resolve }) {
  if (!edge || edge.kind !== 'delegates' || edge.status !== 'blocked' || typeof edge.id !== 'string' || !edge.id || typeof edge.operationId !== 'string' || !edge.operationId) return false;
  if (!confirm()) return false;
  return resolve(edge.id, edge.operationId) === true;
}

/** Remove a graph relation only after confirmation and a successful local save.
 * Completed operation records are removable; pending/blocked operation records stay locked.
 * @param {{edge?:any,confirm:()=>boolean,remove:(id:string)=>boolean}} options
 */
export function confirmGraphRelationRemoval({ edge, confirm, remove }) {
  if (!edge || typeof edge.id !== 'string' || !edge.id || (edge.operationId && edge.status !== 'completed')) return false;
  if (!confirm()) return false;
  return remove(edge.id) === true;
}

/** Open relation editing for one explicitly missing comprehension link kind.
 * @param {{nodeId:string,edgeKind:string,close:()=>void,connect:(from:string,kind:string)=>void}} options
 */
export function connectMissingComprehensionEdge({ nodeId, edgeKind, close, connect }) {
  if (typeof nodeId !== 'string' || !nodeId || (edgeKind !== 'evidence' && edgeKind !== 'explains')) return false;
  close();
  connect(`graph:${nodeId}`, edgeKind);
  return true;
}

/** Cancel either a new-card or existing-card dialog before requiring a node. */
export function cancelGraphDialog(action, close) {
  if (action !== 'cancel') return false;
  close();
  return true;
}

/** Keep a dialog open when local persistence fails; announce success only after save.
 * @param {{save:()=>boolean|void,announce:()=>void,close:()=>void}} options
 */
export function completeGraphDialogSave({ save, announce, close }) {
  if (save() === false) return false;
  announce();
  close();
  return true;
}

/** Resolve an in-document focus target after a native dialog is removed.
 * @param {HTMLElement|null} origin @param {HTMLElement|null} sourceCard @param {HTMLElement|null} viewport
 */
export function graphDialogFocusTarget(origin, sourceCard, viewport) {
  if (origin?.isConnected) return origin;
  if (sourceCard?.isConnected) return sourceCard;
  if (viewport?.isConnected) return viewport;
  return null;
}
