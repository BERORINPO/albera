// Pure UI policy for which recorded delegation edges can be executed or checked.

/** @typedef {{kind:string,direction:string,endpoint:string,sessionId?:string,status:string,purpose?:string}} DelegationEntry */

/**
 * Explain unavailable delegation actions without projecting provider records or paths.
 * `completedLocalCodex` is computed at the UI boundary by the existing event allowlist.
 * @param {{entry:DelegationEntry,demo:boolean,target?:{executionLocation?:string,completedLocalCodex:boolean},hasOperationId:boolean}} input
 */
export function delegationAvailability({ entry, demo, target, hasOperationId }) {
  if (entry.kind !== 'delegates' || entry.direction !== 'out' || !['planned', 'active'].includes(entry.status)) {
    return { action: null, reason: null };
  }
  if (demo) return { action: null, reason: 'graph.delegationUnavailableDemo' };
  if (entry.endpoint !== 'session') return { action: null, reason: 'graph.delegationUnavailableTargetType' };
  if (!entry.sessionId?.startsWith('codex_')) return { action: null, reason: 'graph.delegationUnavailableProvider' };
  if (entry.status === 'active') {
    return hasOperationId
      ? { action: 'check', reason: null }
      : { action: null, reason: 'graph.delegationUnavailableOperation' };
  }
  if (!entry.purpose?.trim()) return { action: null, reason: 'graph.delegationUnavailablePurpose' };
  if (target?.executionLocation === 'wsl') return { action: null, reason: 'graph.delegationUnavailableWsl' };
  if (!target?.completedLocalCodex) return { action: null, reason: 'graph.delegationUnavailable' };
  return { action: 'run', reason: null };
}
