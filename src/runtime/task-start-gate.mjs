import { ID_PATTERN, MAX_ARG_STRING_BYTES, isSafeText, validateActionDto } from './broker-contract/action-digest.mjs';

// Control Plane gate for starting a hand (#115 follow-up, step A2): a desktop agent loop may start a task on a VM only after the approval flow says
// the guest.command / task.start operation was CLAIMED. The flow, the project id, the VM -> computer mapping and the operation ids are injected; this module
// touches no pipe, no clock and no disk, so it runs against a fake flow in unit tests and against the real flow (createApprovedOperationFlow) later.
//
//   startApproved({ vmId, task }) -> { ok: true } | { ok: false, code }
//
// `ok` means exactly one thing: the flow returned status `claimed` for a fresh operation whose action is { task.start, projectId, computerId(vmId), args: { task } }.
// The caller starts the job with the SAME vmId and the SAME task string (the approved args.task); the gate does not start anything itself.
// Everything else is a refusal with a fixed code: denied, expired, failed, retryable and unknown flow statuses (an unknown outcome never starts a job),
// a flow that throws, a claimed result that only replays an earlier operation (each start needs its own approval), and a task the contract could not carry.
// A task that is empty, longer than 256 UTF-8 bytes or has an unsafe character is refused BEFORE the flow runs: no approval is requested for it.

export const TASK_START_MAX_BYTES = MAX_ARG_STRING_BYTES;
export const TASK_START_REFUSALS = Object.freeze([
  'task_invalid', 'vm_unknown', 'start_denied', 'start_expired', 'start_failed', 'start_retryable', 'start_unknown', 'start_replayed', 'start_error',
]);
const REFUSAL_BY_STATUS = Object.freeze({
  denied: 'start_denied', expired: 'start_expired', failed: 'start_failed', retryable: 'start_retryable', unknown: 'start_unknown',
});
const ID_RE = new RegExp(ID_PATTERN, 'u');
const OK = Object.freeze({ ok: true });
const refuse = (code) => Object.freeze({ ok: false, code });
const encoder = new TextEncoder();

/** True when `task` can be the `args.task` of a task.start action: not empty, safe text, at most 256 UTF-8 bytes. */
export function isStartableTask(task) {
  return typeof task === 'string' && task.length > 0 && isSafeText(task) && encoder.encode(task).length <= TASK_START_MAX_BYTES;
}

/**
 * @param {{ flow: { run: Function }, projectId: string, computerIdFor: (vmId: string) => string|undefined, newOperationId: () => string }} deps
 *   `computerIdFor(vmId)` is the host's own mapping (a VM it does not know gives undefined). `newOperationId()` must give a new id every call.
 */
export function createTaskStartGate({ flow, projectId, computerIdFor, newOperationId } = {}) {
  if (typeof flow?.run !== 'function' || typeof computerIdFor !== 'function' || typeof newOperationId !== 'function') throw new TypeError('invalid_task_start_gate_dependencies');
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) throw new TypeError('invalid_task_start_gate_project');

  /** The DTO for this VM and task, or null when the host has no valid computer for the VM. */
  function dtoFor(vmId, task) {
    let computerId;
    try { computerId = computerIdFor(vmId); } catch { return null; }
    try { return validateActionDto('guest.command', { action: 'task.start', projectId, computerId, args: { task } }); } catch { return null; }
  }

  async function startApproved({ vmId, task } = {}) {
    if (!isStartableTask(task)) return refuse('task_invalid');
    const action = typeof vmId === 'string' ? dtoFor(vmId, task) : null;
    if (!action) return refuse('vm_unknown');
    let result;
    let operationId;
    try {
      operationId = newOperationId();
      result = await flow.run({ operationId, purpose: 'guest.command', action });
    } catch { return refuse('start_error'); }
    if (result?.status !== 'claimed') return refuse(REFUSAL_BY_STATUS[result?.status] ?? 'start_error');
    // A claim that only reports an older operation is not an approval of this start.
    if (result.operationId !== operationId) return refuse('start_error');
    return result.replayed === false ? OK : refuse('start_replayed');
  }

  return Object.freeze({ startApproved });
}
