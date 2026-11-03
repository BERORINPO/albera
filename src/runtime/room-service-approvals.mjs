import { REFUSAL_BY_STATUS, createTaskStartGate } from './task-start-gate.mjs';

// The `approvals` port of the room's job screen (room-job-routes.mjs) over the approved-operation flow (docs/architecture/control-plane-service.md section 4; PR4d).
// The job screen needs the approval id and the 4-digit match code AT ONCE, while a person is still being asked; the flow only answers when the operation is decided. So the authority port
// of the wiring reports every accepted submit (`watch.onSubmitted`, room-approval-wiring.mjs `authority.onSubmitted`) and this module hands the job screen
//   { ok: true, approvalId, purpose, action, decided }   `purpose` and `action` are the DTO the flow SUBMITTED (taken from the submit itself, never rebuilt), `decided` is the flow's outcome
//   { ok: false, code }                                  the operation was decided before any request reached the Authority (a fence that failed, a task the contract refuses)
// A start is the same task.start the card path asks for: it goes through createTaskStartGate (one gate per request, so the operation id is known), which owns what "approved" means
// (a claimed, fresh operation) and the refusal codes. The approval test is one fixed `broker.operation` / `synthetic.noop` that the Broker only records.
// Nothing here reads a clock, a pipe or a file.

const refuse = (code) => Object.freeze({ ok: false, code });

/** Learns the approval id of an operation from the authority port's accepted submits. One waiter per operation id; a submit nobody waits for (a card's start) is ignored. */
export function createSubmitWatch() {
  const waiting = new Map(); // operationId -> resolve
  return Object.freeze({
    onSubmitted(fields, reply) {
      const resolve = waiting.get(fields?.operationId);
      if (!resolve) return;
      waiting.delete(fields.operationId);
      resolve(Object.freeze({ approvalId: reply.approvalId, purpose: fields.purpose, action: fields.action }));
    },
    expect(operationId) { return new Promise((resolve) => { waiting.set(operationId, resolve); }); },
    forget(operationId) { waiting.delete(operationId); },
  });
}

/**
 * @param {{ flow: { run: Function }, projectId: string, computerIds: string[], watch: ReturnType<typeof createSubmitWatch>, newOperationId: () => string }} deps
 *   `computerIds` = the computers of the settings (the approval test names the first one).
 * @returns {{ startTask: Function, noop: Function }}
 */
export function createRoomJobApprovals({ flow, projectId, computerIds, watch, newOperationId } = {}) {
  if (typeof flow?.run !== 'function' || typeof watch?.expect !== 'function' || typeof newOperationId !== 'function' || !Array.isArray(computerIds) || computerIds.length < 1) {
    throw new TypeError('invalid_room_service_approvals_dependencies');
  }

  /** The submitted request, or (when the operation is decided before any submit) the refusal. `decided` never rejects. */
  async function answer(operationId, submitted, decided) {
    const first = await Promise.race([submitted.then((s) => ({ s })), decided.then((d) => ({ d }))]);
    if (first.s) return Object.freeze({ ok: true, ...first.s, decided });
    watch.forget(operationId);
    return first.d.ok === true ? refuse('submit_failed') : first.d;
  }

  return Object.freeze({
    startTask({ computerId, task }) {
      const operationId = newOperationId();
      const submitted = watch.expect(operationId);
      const gate = createTaskStartGate({ flow, projectId, computerIdFor: () => computerId, newOperationId: () => operationId });
      return answer(operationId, submitted, gate.startApproved({ vmId: computerId, task }));
    },
    noop() {
      const operationId = newOperationId();
      const submitted = watch.expect(operationId);
      const action = { action: 'synthetic.noop', projectId, computerId: computerIds[0], args: {} };
      const decided = Promise.resolve().then(() => flow.run({ operationId, purpose: 'broker.operation', action })).then(
        (result) => (result?.status === 'claimed' && result.operationId === operationId && result.replayed === false
          ? Object.freeze({ ok: true, operationId }) : refuse(REFUSAL_BY_STATUS[result?.status] ?? 'start_error')),
        () => refuse('start_error'),
      );
      return answer(operationId, submitted, decided);
    },
  });
}
