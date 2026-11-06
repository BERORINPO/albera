import { ID_PATTERN, computeActionDigest } from './broker-contract/action-digest.mjs';
import { computeMatchCode } from './broker-contract/match-code.mjs';
import { cleanText } from './room-contract.mjs';
import { TASK_START_REFUSALS, isStartableTask } from './task-start-gate.mjs';

// The room's job screen (docs/architecture/control-plane-service.md section 4, "Routes added to the room"; Proposed / NOT VERIFIED). Routes for room-host.mjs `apiRoutes`: the host checks Origin,
// Sec-Fetch-Site, the content type, the session cookie and the body limit before any handler here runs. Nothing here touches a pipe, a process, a clock or a disk: the approval flow and the hands
// are injected (PR4d wires the real ones; the tests use Fakes).
//
//   GET  /api/jobs                  -> { ok, targets: [{ computerId, label }], jobs: [Job] }
//   GET  /api/jobs/results          -> { ok, results: [Result] }                        what WSL2 jobs handed over (room-service-wsl2-run.mjs): agent_reported, untrusted text
//   POST /api/jobs                  { computerId, task } -> 202 { ok, job: Job }       asks for approval of one task.start; the job carries `approvalId`, `actionDigest` and the 4-digit `matchCode`
//   POST /api/jobs/stop-all         {} -> { ok, cancelled, stopped }                    cancels every job still waiting for approval and stops the hands
//   POST /api/jobs/approval-test    {} -> 202 { ok, job: Job }                          one fixed synthetic.noop (the CP identity cannot run `approval-check` by hand); starts nothing
//
// Injected ports (all may reject; a rejection is a fixed code, never the error's text):
//   approvals.startTask({ computerId, task }) -> { ok: true, approvalId, purpose, action, decided } | { ok: false, code }
//   approvals.noop()                          -> the same, for broker.operation / synthetic.noop
//     Resolves when the Authority has the request. `purpose` + `action` are the DTO that was SUBMITTED (the room computes the action digest from it itself and sends nothing it did not compute);
//     the wiring submits with the digest check on (`includeDigest`), so the Authority recomputes it too. `decided` is a promise of the outcome: `{ ok: true, operationId }` once the Broker CLAIMED
//     the operation (task-start-gate.mjs `startApproved` shape), or `{ ok: false, code }` with one of TASK_START_REFUSALS.
//   hands.start({ computerId, task, operationId, vmId?, expectedGeneration? }) -> { ok: true } | { ok: false, code }   called only after `decided` said ok; `task` is the approved args.task, byte for byte; vmId / expectedGeneration are the approved action args when it had them (the hands must check they run on that VM)
//   hands.stopAll() -> number                                                                  stop every running hands process (by its recorded PID) and return how many
//   targets() -> [{ computerId, label }]                                                       the computers a job may name
//
// Rules this file enforces:
//  - The task is validated like the gate does (isStartableTask: 1 to 256 UTF-8 bytes, safe text) BEFORE anything is asked. The body's other fields are refused, not ignored.
//  - The task given to the hands is the one in the SUBMITTED action (`action.args.task`), and only when it is exactly the string the owner typed and the action names the same computer and
//    `task.start`. A port that echoes anything else is refused (`submit_mismatch`) and nothing is started. Text reaches the hands only after `decided` says ok, and never from a request body.
//  - One approval at a time per computer (and one test at a time); at most 8 waiting in all. A job counts from the moment the Authority is asked (state `submitting`), not from its answer, so concurrent requests and a stop all in flight are seen.
//  - Stop all marks every waiting or starting job cancelled first, then stops the hands; a later approval of a cancelled job starts nothing. A request already in front of the person cannot be
//    withdrawn from the Authority: the owner denies it in the approval window (the page says so).

export const JOB_MAX_BODY_BYTES = 2048;
export const MAX_WAITING_JOBS = 8;
export const MAX_KEPT_JOBS = 16;
export const MAX_LABEL = 64;
const ID_RE = new RegExp(ID_PATTERN, 'u'); // computer ids and operation ids share the contract's id grammar
const REFUSALS = new Set(TASK_START_REFUSALS);
const SUBMIT_CODES = new Set([...TASK_START_REFUSALS, 'queue_full', 'authority_unavailable', 'broker_unavailable', 'request_invalid']);
const TASK_START_ARGS = Object.freeze(['task', 'vmId', 'expectedGeneration', 'isolation', 'repositoryId', 'baseOid']); // what task-start-gate.mjs puts in args: the task, and (for the attestation) the VM and its generation
const START_CODES = new Set(['not_started', 'start_error', 'busy', 'already_running', 'vm_unknown', 'start_cancelled']);
const fail = (status, error) => ({ status, body: { error } });
const hasExactly = (value, keys) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {{ approvals: { startTask: Function, noop: Function }, hands: { start: Function, stopAll: Function }, targets: () => {computerId: string, label?: string}[], newJobId?: () => string }} deps
 * @returns {readonly object[]} routes for createRoomHost({ apiRoutes })
 */
export function createRoomJobRoutes({ approvals, hands, targets, newJobId } = {}) {
  if (typeof approvals?.startTask !== 'function' || typeof approvals?.noop !== 'function' || typeof hands?.start !== 'function' || typeof hands?.stopAll !== 'function' || typeof targets !== 'function') {
    throw new TypeError('invalid_room_job_dependencies');
  }
  if (newJobId !== undefined && typeof newJobId !== 'function') throw new TypeError('invalid_room_job_dependencies');
  let counter = 0;
  const nextJobId = newJobId ?? (() => `job-${++counter}`);
  const jobs = []; // oldest first; each is a mutable record owned by this closure, and clients only ever see views
  const busyStates = new Set(['submitting', 'awaiting_approval', 'starting']); // 'submitting' = asked, the Authority has not answered yet: it already counts as waiting

  const view = (job) => ({
    jobId: job.jobId, kind: job.kind, computerId: job.computerId, ...(job.kind === 'task' ? { task: job.task } : {}),
    ...(job.approvalId ? { approvalId: job.approvalId, actionDigest: job.actionDigest, matchCode: job.matchCode } : {}), state: job.state, ...(job.code ? { code: job.code } : {}),
  });

  function targetList() {
    let list;
    try { list = targets(); } catch { list = []; }
    return (Array.isArray(list) ? list : []).filter((t) => typeof t?.computerId === 'string' && ID_RE.test(t.computerId))
      .map((t) => ({ computerId: t.computerId, label: cleanText(typeof t.label === 'string' ? t.label : t.computerId, MAX_LABEL) || t.computerId, ...(t.level === 'wsl2' ? { level: 'wsl2' } : {}) }));
  }

  const waiting = () => jobs.filter((job) => busyStates.has(job.state));

  function remember(job) {
    jobs.push(job);
    while (jobs.length > MAX_KEPT_JOBS) {
      const done = jobs.findIndex((j) => !busyStates.has(j.state));
      if (done < 0) break;
      jobs.splice(done, 1);
    }
  }

  const finish = (job, state, code) => { job.state = state; if (code) job.code = code; else delete job.code; };

  /** The fields a pending job gets from the submitted request, or a response that refuses it. Digest and match code are computed here from the submitted DTO. */
  function openJob(kind, computerId, task, submitted) {
    let vm = {};
    if (submitted?.ok !== true) return { refusal: fail(502, SUBMIT_CODES.has(submitted?.code) ? submitted.code : 'submit_failed') };
    const { approvalId, purpose, action } = submitted;
    const expected = kind === 'task' ? ['guest.command', 'task.start'] : ['broker.operation', 'synthetic.noop'];
    if (purpose !== expected[0] || action?.action !== expected[1]) return { refusal: fail(502, 'submit_mismatch') };
    // The hands may get only this exact string, for this computer: anything else the port echoes back is not what the owner asked for.
    if (kind === 'task') {
      const args = action.args;
      if (action.computerId !== computerId || args?.task !== task || !Object.keys(args).every((key) => TASK_START_ARGS.includes(key))) return { refusal: fail(502, 'submit_mismatch') };
      // The VM the Authority was asked about travels to the hands, which must check it is the one they run on (PR4d acceptance condition).
      if (args.vmId !== undefined && (typeof args.vmId !== 'string' || !ID_RE.test(args.vmId))) return { refusal: fail(502, 'submit_mismatch') };
      if (args.expectedGeneration !== undefined && !Number.isSafeInteger(args.expectedGeneration)) return { refusal: fail(502, 'submit_mismatch') };
      // A wsl2 computer's target travels the same way (ADR-012, decision 4). The hands compare it with their settings.
      for (const key of ['isolation', 'repositoryId', 'baseOid']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !ID_RE.test(args[key]))) return { refusal: fail(502, 'submit_mismatch') };
      vm = Object.fromEntries(['vmId', 'expectedGeneration', 'isolation', 'repositoryId', 'baseOid'].filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
    }
    if (typeof submitted.decided?.then !== 'function') return { refusal: fail(502, 'submit_invalid') };
    let actionDigest;
    let matchCode;
    try { actionDigest = computeActionDigest(purpose, action); matchCode = computeMatchCode(approvalId, actionDigest); } catch { return { refusal: fail(502, 'submit_invalid') }; }
    return { fields: { computerId: kind === 'task' ? computerId : action.computerId, approvalId, actionDigest, matchCode, ...vm } };
  }

  async function settle(job, decided) {
    let result = null;
    try { result = await decided; } catch { /* a rejected promise is a refusal below */ }
    if (job.state !== 'awaiting_approval') return; // stopped while the person was deciding
    if (result?.ok !== true) { finish(job, 'refused', REFUSALS.has(result?.code) ? result.code : 'start_error'); return; }
    if (job.kind === 'test') { finish(job, 'approved'); return; }
    if (typeof result.operationId !== 'string' || !ID_RE.test(result.operationId)) { finish(job, 'refused', 'start_error'); return; }
    finish(job, 'starting');
    let started = null;
    try { started = await hands.start({ computerId: job.computerId, task: job.task, operationId: result.operationId, ...Object.fromEntries(['vmId', 'expectedGeneration', 'isolation', 'repositoryId', 'baseOid'].filter((key) => job[key] !== undefined).map((key) => [key, job[key]])) }); } catch { /* start_error below */ }
    if (job.state === 'cancelled') { // stop all arrived while the hands were being started: stop them again, they may have come up after the first stop
      try { await hands.stopAll(); } catch { /* stop all already reported its own failure */ }
      return;
    }
    if (started?.ok === true) finish(job, 'started');
    else finish(job, 'start_failed', START_CODES.has(started?.code) ? started.code : 'start_error');
  }

  async function submit(kind, computerId, task, ask) {
    // The job exists BEFORE the Authority is asked, so a stop all and the one-per-computer and cap checks see it while the request is in flight.
    const job = { jobId: nextJobId(), kind, computerId: kind === 'task' ? computerId : null, task, state: 'submitting' };
    remember(job);
    let submitted = null;
    try { submitted = await ask(); } catch { submitted = null; }
    if (job.state === 'cancelled') return fail(409, 'stopped'); // stop all came while asking: whatever the Authority holds is denied in its window, and nothing is shown or started
    const { fields, refusal } = openJob(kind, computerId, task, submitted);
    if (refusal) { jobs.splice(jobs.indexOf(job), 1); return refusal; }
    Object.assign(job, fields);
    finish(job, 'awaiting_approval');
    void settle(job, Promise.resolve(submitted.decided)); // the outcome is read through GET /api/jobs
    return { status: 202, body: { ok: true, job: view(job) } };
  }

  function list() {
    return { status: 200, body: { ok: true, targets: targetList(), jobs: jobs.map(view) } };
  }

  /** What WSL2 jobs handed over: the job's claim, never verified. The page shows it as text. */
  function results() {
    let list = [];
    try { list = hands.results?.() ?? []; } catch { /* no results to show */ }
    return { status: 200, body: { ok: true, results: list } };
  }

  async function startJob({ body }) {
    if (!hasExactly(body, ['computerId', 'task'])) return fail(400, 'invalid_request');
    if (typeof body.computerId !== 'string' || typeof body.task !== 'string') return fail(400, 'invalid_request');
    if (!isStartableTask(body.task)) return fail(400, 'task_invalid');
    if (!targetList().some((t) => t.computerId === body.computerId)) return fail(404, 'computer_unknown');
    if (waiting().some((job) => job.kind === 'task' && job.computerId === body.computerId)) return fail(409, 'approval_in_progress');
    if (waiting().length >= MAX_WAITING_JOBS) return fail(429, 'too_many_waiting');
    const { computerId, task } = body;
    return submit('task', computerId, task, () => approvals.startTask({ computerId, task }));
  }

  async function approvalTest({ body }) {
    if (!isPlain(body) || Object.keys(body).length !== 0) return fail(400, 'invalid_request');
    if (waiting().some((job) => job.kind === 'test')) return fail(409, 'approval_in_progress');
    if (waiting().length >= MAX_WAITING_JOBS) return fail(429, 'too_many_waiting');
    return submit('test', null, null, () => approvals.noop());
  }

  async function stopAll({ body }) {
    if (!isPlain(body) || Object.keys(body).length !== 0) return fail(400, 'invalid_request');
    const cancelled = waiting();
    for (const job of cancelled) finish(job, 'cancelled', 'stopped'); // first: a decision that arrives from now on starts nothing
    let stopped;
    try { stopped = await hands.stopAll(); } catch { return { status: 500, body: { error: 'stop_failed', cancelled: cancelled.length } }; }
    return { status: 200, body: { ok: true, cancelled: cancelled.length, stopped: Number.isSafeInteger(stopped) && stopped >= 0 ? stopped : null } };
  }

  return Object.freeze([
    Object.freeze({ method: 'GET', path: '/api/jobs', handle: list }),
    Object.freeze({ method: 'GET', path: '/api/jobs/results', handle: results }),
    Object.freeze({ method: 'POST', path: '/api/jobs', maxBody: JOB_MAX_BODY_BYTES, handle: startJob }),
    Object.freeze({ method: 'POST', path: '/api/jobs/stop-all', maxBody: 64, handle: stopAll }),
    Object.freeze({ method: 'POST', path: '/api/jobs/approval-test', maxBody: 64, handle: approvalTest }),
  ]);
}
