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
