import { isSafeText } from './broker-contract/action-digest.mjs';
import { cleanText, isCode } from './room-contract.mjs';
import { TASK_START_MAX_BYTES, TASK_START_REFUSALS } from './task-start-gate.mjs';

// How the control room starts a job on a VM for a card effect (nudge, recheck). Two modes (#115 follow-up, step A2):
//  - no gate (the local demo, as before): stop the running loop if there is one, wait until it is idle, start the job, answer 'started' or the fleet's code.
//  - with a gate (task-start-gate.mjs): ask for approval of exactly this task on this VM first. The answer is slow (a person may be asked), so `start` returns
//    'pending_approval' at once and the outcome arrives later as a ledger entry: `start_approved` (then the loop is stopped and the job started) or
//    `start_refused` with a fixed code. Nothing is stopped and nothing is started unless the gate said ok. At most one approval per VM is pending.
//    A human `stop` on that VM while its approval is pending cancels it: a later ok does not start anything (`start_cancelled`). The host closing does too,
//    including while the old loop is being stopped.

export const STOP_WAIT_MS = 5_000;
const GATED_NUDGE = 'A dialog or message box may be blocking the screen. Close or answer it in the safest way (delete or discard nothing), '
  + 'then reply with one line starting with DONE, or FAILED and the reason.';
const GATED_RECHECK_HEAD = 'Change nothing. Look at the screen and decide whether this task is done: "';
const GATED_RECHECK_TAIL = '". Reply with one line starting with DONE, or FAILED and what is missing.';
const encoder = new TextEncoder();
const byteLength = (text) => encoder.encode(text).length;

/** The nudge text that fits a task.start action (256 UTF-8 bytes). Same meaning as NUDGE_TASK. */
export const GATED_NUDGE_TASK = GATED_NUDGE;

/** The recheck text that fits a task.start action: the VM's own task is cleaned of unsafe characters and cut so the whole text stays within 256 bytes. */
export function gatedRecheckTask(task) {
  let room = TASK_START_MAX_BYTES - byteLength(GATED_RECHECK_HEAD) - byteLength(GATED_RECHECK_TAIL);
  let kept = '';
  for (const ch of cleanText(task, 2000)) {
    if (!isSafeText(ch)) continue;
    const size = byteLength(ch);
    if (size > room) break;
    kept += ch;
    room -= size;
  }
  return `${GATED_RECHECK_HEAD}${kept}${GATED_RECHECK_TAIL}`;
}

/**
 * @param {{ fleet: { startJob: Function, stopVm: Function, idle?: Function }, gate?: { startApproved: Function }|null, journal: { record: Function }, isClosed: () => boolean, stopWaitMs?: number }} deps
 * @returns {{ gated: boolean, start(vmId: string, task: string): Promise<string> }}
 */
export function createStartRunner({ fleet, gate = null, journal, isClosed, stopWaitMs = STOP_WAIT_MS }) {
  if (gate !== null && typeof gate?.startApproved !== 'function') throw new TypeError('room host requires a start gate with startApproved()');
  const pending = new Map(); // vmId -> { cancelled } for an approval in flight

  const note = (vmId, code, params = {}) => {
    try { journal.record({ vmId, actor: 'bero', code, params }); } catch { /* a journal failure must not stop the room */ }
  };

  async function startNow(vmId, task, ticket = null) {
    if (fleet.stopVm(vmId) && typeof fleet.idle === 'function') {
      await Promise.race([fleet.idle(vmId), new Promise((resolve) => { setTimeout(resolve, stopWaitMs).unref?.(); })]);
    }
    // Checked again after the wait: the host may have closed, or a person may have chosen stop, while the old loop was stopping.
    if (ticket && (isClosed() || ticket.cancelled)) return 'start_cancelled';
    const started = fleet.startJob(vmId, task);
    return started?.ok ? 'started' : (typeof started?.code === 'string' && isCode(started.code) ? started.code : 'not_started');
  }

  async function approveThenStart(vmId, task, ticket) {
    try {
      const approval = await gate.startApproved({ vmId, task });
      if (isClosed()) return;
      if (approval?.ok !== true) { note(vmId, 'start_refused', { code: isCode(approval?.code, TASK_START_REFUSALS) ? approval.code : 'start_error' }); return; }
      if (ticket.cancelled) { note(vmId, 'start_refused', { code: 'start_cancelled' }); return; }
      note(vmId, 'start_approved');
      const result = await startNow(vmId, task, ticket);
      if (result !== 'started') note(vmId, 'start_refused', { code: result });
    } catch { note(vmId, 'start_refused', { code: 'start_error' }); } finally { pending.delete(vmId); }
  }

  function start(vmId, task) {
    if (!gate) return startNow(vmId, task);
    if (pending.has(vmId)) return Promise.resolve('approval_in_progress');
    const ticket = { cancelled: false };
    pending.set(vmId, ticket);
    void approveThenStart(vmId, task, ticket);
    return Promise.resolve('pending_approval');
  }

  /** A person chose stop on this VM: an approval still in flight must not start a job afterwards. */
  function cancel(vmId) {
    const ticket = pending.get(vmId);
    if (ticket) ticket.cancelled = true;
  }

  return Object.freeze({ gated: gate !== null, start, cancel });
}
