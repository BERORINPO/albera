// Convert the server's fixed delegation rejection codes to safe UI messages.
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
