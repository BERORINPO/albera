import { ActionDigestError, ID_PATTERN, PURPOSES, computeActionDigest, validateActionDto } from './broker-contract/action-digest.mjs';
import { readSignedNetworkAttestation } from './broker-contract/network-attestation.mjs';
import { ATTESTED_POLICY_BASIS_ACTIONS, isPolicyBasisAction, parseReceipt } from './broker-contract/receipt-v3.mjs';
import { FlowJournalError } from './approved-operation-journal.mjs';

// Control Plane orchestration of ONE operation through human approval (ADR-002 "Receipt v2", Proposed / NOT VERIFIED; ADR-003 intent-before-effect):
//
//   INTENT --fence--> FENCED --submit--> SUBMITTED --poll--> APPROVED --claim--> CLAIMED
//                                            |                  |  \__ post-send failure / denied __
//                                            |                  |                 v
//                                            |               CLAIMING ------> UNKNOWN --inspect--> CLAIMED
//                                            |                                   |  \__ not recorded, epoch moved: new cycle (INTENT, cycle + 1)
//                                     DENIED | EXPIRED | FAILED  (final, recorded)
//
// Nothing here talks to a pipe, a clock or a disk. The two clients (Broker and Approval Authority), the journal, the clock and the sleep are injected, so the
// same code runs against fakes in unit tests and against the real clients (the two pipe clients, each bound to a pipe and an `expect`) later.
// Not wired into any UI or API yet.
//
// Rules the code enforces:
//  - Intent is persisted before the effect: INTENT before the fence, FENCED (the challenge) before the submit, SUBMITTED (approval id, expiry) after it,
//    APPROVED (receipt, signature) before the claim, CLAIMING immediately before each claim is written. A crash leaves the record in the phase that says
//    what may have happened; `run` / `resume` on the same operationId continues from there and never starts over.
//  - A claim is never replayed with a NEW receipt. After a failure that may have happened after the frame was written (timeout, transport error, a `denied`
//    reply, a crash in CLAIMING) the flow asks the Broker (`inspect`). Only when nothing is recorded and the SAME receipt is still valid is that same
//    receipt (exact bytes) sent again; the Broker answers an exact duplicate with the recorded outcome (`replayed`).
//  - Pre-send failures (the client says nothing left the process) are retried with backoff and then reported as `retryable`; the record keeps its phase.
//  - An immediate approval needs no special path: when the Authority's tier policy needs no person for the action, submit answers `approved` and the first status poll returns a v3
//    receipt with basis "policy". The record still goes INTENT, FENCED, SUBMITTED, APPROVED, CLAIMING, CLAIMED, and no sleep happens between submit and claim. A policy receipt for an
//    action outside POLICY_BASIS_ACTIONS / ATTESTED_POLICY_BASIS_ACTIONS is never claimed (receipt_mismatch), whatever the Authority signed.
//  - Network attestation (#115 step 3b). Before it submits environment.start / environment.create (and only when the action carries an integer `expectedGeneration` arg to bind), the flow asks the
//    Broker side for an attestation through the OPTIONAL `broker.attest({ computerId, projectId, leaseId, leaseGeneration, generation })` (the lease is the one just fenced) and passes the answer to
//    the Authority as-is. Not getting one is never an error: no `attest` function, a refusal, an exception, a malformed answer or one that says anything but "none" just means the submit goes
//    without it and, at worst, a person is asked. The flow decides nothing from it: the Authority verifies it and signs without a person or queues. The digest of what was presented is recorded
//    with the approval, and a receipt that names an attestation digest is only claimed when it is that one (an attested policy receipt without a presented attestation is receipt_mismatch).
//  - Polling is bounded by the request's own expiry (the Authority's `expiresAt`) and by `maxPolls`, with exponential backoff.
//  - `human_denied`, `request_expired` and the presence errors are final and recorded. So are `request_invalid`, `queue_full`, `authority_unavailable`.
//  - A fence from a different broker epoch (or lease generation) than the one a receipt names is never mixed: the receipt is dead (the Broker wiped the
//    challenge), so after `inspect` shows no claim the flow starts a new cycle: fence again, submit again under a NEW idempotencyKey (the Authority treats
//    other content under the old key as invalid), approve again. `maxCycles` bounds this; the human is asked once per cycle.
//  - idempotencyKey = `<operationId>.c<cycle>`: stable for the life of a cycle, so every resubmit after an unknown outcome returns the first request.
// `claimed` means the Broker durably recorded the claim (its state is `UNKNOWN`: the effect is not executed here). Nothing is retried blindly after that.

export const FLOW_PHASES = Object.freeze(['INTENT', 'FENCED', 'SUBMITTED', 'APPROVED', 'CLAIMING', 'UNKNOWN', 'CLAIMED', 'DENIED', 'EXPIRED', 'FAILED']);
/** The `status` of a result: the five final/open outcomes of one `run`. `retryable` and `unknown` are not final: run the same operationId again. */
export const FLOW_STATUSES = Object.freeze(['claimed', 'denied', 'expired', 'failed', 'retryable', 'unknown']);
export const FLOW_DEFAULTS = Object.freeze({
  pollInitialMs: 500, pollMaxMs: 5000, pollFactor: 2, maxPolls: 1000, maxStatusErrors: 5, sendAttempts: 3, sendBackoffMs: 250, reconcileAttempts: 3, maxCycles: 2,
});

const MAX_CYCLES_LIMIT = 9; // the idempotency key suffix is `.c<digit>`
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,60}$/u; // the contract id grammar minus room for `.c<n>`
const ID_RE = new RegExp(ID_PATTERN, 'u');
const REQUEST_KEYS = ['operationId', 'purpose', 'action'];
const TERMINAL_STATUS = Object.freeze({ CLAIMED: 'claimed', DENIED: 'denied', EXPIRED: 'expired', FAILED: 'failed' });
// Codes of the two injected clients. A test pins these lists to the clients' own constants (they cannot be imported here: arch rules 8a and 10a).
export const FLOW_PRESEND_CODES = Object.freeze([
  'invalid_request', 'invalid_pipe_name', 'request_too_large', 'unsupported_platform', 'broker_unavailable', 'authority_unreachable', 'access_denied',
  'server_identity_mismatch', 'server_identity_unavailable', 'helper_unavailable',
]);
export const FLOW_AUTHORITY_FINAL_CODES = Object.freeze(['human_denied', 'presence_unavailable', 'presence_mismatch', 'request_expired', 'request_invalid', 'queue_full', 'authority_unavailable']);
const PRESEND = new Set(FLOW_PRESEND_CODES);
const AUTHORITY_FINAL = new Set(FLOW_AUTHORITY_FINAL_CODES);
const AUTHORITY_DENIED = new Set(['human_denied', 'presence_unavailable', 'presence_mismatch']);
// Safe to try again without any new decision: nothing was sent, or the call is idempotent (fence, inspect, status, a resubmit under the same key).
const TRANSIENT = new Set(['broker_unavailable', 'authority_unreachable', 'timeout', 'transport_error', 'invalid_response', 'response_too_large']);
const CLAIM_PRESEND_TRANSIENT = new Set(['broker_unavailable']);

class FlowInputError extends Error {}
class JournalFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

const isCount = (value, min = 1) => Number.isSafeInteger(value) && value >= min;
const keyFor = (operationId, cycle) => `${operationId}.c${cycle}`;
const codeOf = (result) => (typeof result?.code === 'string' ? result.code : 'transport_error');

function resolveOptions(options = {}) {
  const merged = { ...FLOW_DEFAULTS, ...options };
  const ok = ['pollInitialMs', 'pollMaxMs', 'maxPolls', 'maxStatusErrors', 'sendAttempts', 'sendBackoffMs', 'reconcileAttempts'].every((name) => isCount(merged[name], name === 'reconcileAttempts' ? 0 : 1))
    && Number.isFinite(merged.pollFactor) && merged.pollFactor >= 1 && isCount(merged.maxCycles) && merged.maxCycles <= MAX_CYCLES_LIMIT
    && Object.keys(options).every((name) => name in FLOW_DEFAULTS);
  if (!ok) throw new TypeError('invalid_flow_options');
  return Object.freeze(merged);
}

function normalizeRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some((key) => !REQUEST_KEYS.includes(key))) throw new FlowInputError();
  const { operationId, purpose = 'broker.operation', action } = request;
  if (typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId) || !PURPOSES.includes(purpose)) throw new FlowInputError();
  try {
    const dto = validateActionDto(purpose, action);
    return { operationId, purpose, action: dto, requestDigest: computeActionDigest(purpose, dto) };
  } catch (error) {
    throw error instanceof ActionDigestError ? new FlowInputError() : error;
  }
}

/** Terminal result from a stored record. `replayed` is true when this call only reports an outcome that was recorded earlier. */
function terminalResult(record, replayed) {
  const { outcome = {} } = record;
  return Object.freeze({
    status: TERMINAL_STATUS[record.phase], operationId: record.operationId, phase: record.phase, cycle: record.cycle,
    ...(outcome.code ? { code: outcome.code } : {}),
    ...(record.approval ? { approvalId: record.approval.approvalId } : {}),
    ...(record.fence ? { brokerEpoch: record.fence.brokerEpoch } : {}),
    ...(record.phase === 'CLAIMED' ? { brokerState: outcome.brokerState, reconciled: outcome.reconciled === true } : {}),
    replayed: replayed || outcome.replayed === true,
  });
}

/** Result for a flow that stopped without a final outcome (`retryable`, `unknown`): the record keeps its phase and `run` resumes from it. */
const openResult = (record, status, code) => Object.freeze({
  status, operationId: record.operationId, phase: record.phase, cycle: record.cycle, code,
  ...(record.approval ? { approvalId: record.approval.approvalId } : {}),
  ...(record.fence ? { brokerEpoch: record.fence.brokerEpoch } : {}),
  replayed: false,
});

const next = (record) => ({ record });
const stop = (result) => ({ result });

/**
 * @param {{ broker: { fence: Function, claim: Function, inspect: Function }, authority: { submit: Function, status: Function },
 *   journal: object, now: () => number, sleep: (ms: number) => Promise<void>, options?: Partial<typeof FLOW_DEFAULTS> }} deps
 *   `broker.fence({ computerId })`, `broker.claim({ receipt, signature })`, `broker.inspect({ operationId })`, `authority.submit({ purpose, operationId, idempotencyKey,
 *   leaseId, leaseGeneration, brokerEpoch, brokerChallenge, action })` and `authority.status({ approvalId })` return the clients' result objects (`{ ok: true, ... }` or
 *   `{ ok: false, code }`) and never throw. `now()` is Unix milliseconds. `journal` is the port in approved-operation-journal.mjs.
 * @returns {{ run(request: { operationId: string, purpose?: string, action: object }): Promise<object>, resume(operationId: string): Promise<object> }}
 */
export function createApprovedOperationFlow({ broker, authority, journal, now, sleep, options } = {}) {
  const functionsOk = [broker?.fence, broker?.claim, broker?.inspect, authority?.submit, authority?.status, journal?.begin, journal?.advance, journal?.get, now, sleep]
    .every((fn) => typeof fn === 'function');
  if (!functionsOk) throw new TypeError('invalid_flow_dependencies');
  const opt = resolveOptions(options);
  const inflight = new Map();
  const backoff = (attempt) => Math.min(opt.sendBackoffMs * 2 ** attempt, opt.pollMaxMs);
  const receiptExpired = (record) => now() >= record.receipt.exp * 1000;

  /** Every journal call goes through here: a failure is "not persisted", and the flow stops before the next side effect. */
  const guard = async (call) => {
    try { return await call(); } catch (error) { throw new JournalFailure(error instanceof FlowJournalError && error.code === 'conflict' ? 'journal_conflict' : 'journal_error'); }
  };
  const advance = (record, from, patch) => guard(() => journal.advance(record.operationId, record.revision, from, { ...patch, updatedAt: now() }));
  const finalize = async (record, from, phase, code, extra = {}) => terminalResult(await advance(record, from, { phase, outcome: { ...(code ? { code } : {}), ...extra } }), false);

  /** Retry an idempotent client call on transient codes only; the last result is returned as is. */
  async function withRetry(call) {
    let result;
    for (let attempt = 0; attempt < opt.sendAttempts; attempt += 1) {
      result = await call();
      if (result?.ok === true || !TRANSIENT.has(codeOf(result))) return result;
      if (attempt < opt.sendAttempts - 1) await sleep(backoff(attempt));
    }
    return result;
  }

  async function fenceStep(record) {
    const result = await withRetry(() => broker.fence({ computerId: record.action.computerId }));
    if (result?.ok === true) {
      const { brokerEpoch, leaseGeneration, leaseId, brokerChallenge } = result;
      return next(await advance(record, ['INTENT'], { phase: 'FENCED', fence: { brokerEpoch, leaseGeneration, leaseId, brokerChallenge } }));
    }
    return stop(codeOf(result) === 'denied' ? await finalize(record, ['INTENT'], 'FAILED', 'fence_denied') : openResult(record, 'retryable', codeOf(result)));
  }

  /** The Broker's network attestation for this environment, or null. Never throws and never fails the flow: whatever goes wrong here means "no attestation". */
  async function attestationFor(record) {
    const { action } = record;
    const generation = action.args?.expectedGeneration;
    if (typeof broker.attest !== 'function' || !ATTESTED_POLICY_BASIS_ACTIONS.includes(action.action) || !isCount(generation)) return null;
    try {
      const reply = await broker.attest({ computerId: action.computerId, projectId: action.projectId, leaseId: record.fence.leaseId, leaseGeneration: record.fence.leaseGeneration, generation });
      if (reply?.ok !== true) return null;
      const read = readSignedNetworkAttestation(reply.attestation);
      return read.attestation.network === 'none' ? { envelope: reply.attestation, digest: read.digest } : null;
    } catch { return null; }
  }

  async function submitStep(record) {
    const { fence } = record;
    const fields = {
      purpose: record.purpose, operationId: record.operationId, idempotencyKey: record.idempotencyKey, leaseId: fence.leaseId,
      leaseGeneration: fence.leaseGeneration, brokerEpoch: fence.brokerEpoch, brokerChallenge: fence.brokerChallenge, action: record.action,
    };
    let attestation = await attestationFor(record);
    let result = await withRetry(() => authority.submit(attestation ? { ...fields, attestation: attestation.envelope } : fields));
    if (attestation && codeOf(result) === 'request_too_large') { // the request does not fit one frame with it: ask without
      attestation = null;
      result = await withRetry(() => authority.submit(fields));
    }
    if (result?.ok === true) {
      const approval = { approvalId: result.approvalId, expiresAt: result.expiresAt, ...(attestation ? { attestationDigest: attestation.digest } : {}) };
      return next(await advance(record, ['FENCED'], { phase: 'SUBMITTED', approval }));
    }
    return stop(await authorityFailure(record, ['FENCED'], codeOf(result)));
  }

  /** A code from the Authority: final ones are recorded, anything else leaves the record where it is. */
  async function authorityFailure(record, from, code) {
    if (!AUTHORITY_FINAL.has(code)) return openResult(record, 'retryable', code);
    const phase = AUTHORITY_DENIED.has(code) ? 'DENIED' : code === 'request_expired' ? 'EXPIRED' : 'FAILED';
    return finalize(record, from, phase, code);
  }

  /** The receipt must name exactly what this record fenced and submitted: the same ids, fence, purpose, action (name, project, computer) and the action digest recomputed here
 * from the submitted DTO (args are bound by the digest). Anything else is never claimed. */
  function receiptMatches(record, receipt) {
    const parsed = parseReceipt(Buffer.from(receipt, 'base64'));
    if (!parsed.ok) return null;
    const r = parsed.receipt;
    if (r.basis === 'policy' && !isPolicyBasisAction(r.action)) return null;
    // A receipt names an attestation digest exactly when it is a no-person receipt for an attested action, and then it must be the attestation this flow presented.
    const presented = record.approval.attestationDigest;
    const attestedPolicy = r.basis === 'policy' && ATTESTED_POLICY_BASIS_ACTIONS.includes(r.action);
    if (attestedPolicy ? presented === undefined || r.attestationDigest !== presented : r.attestationDigest !== undefined) return null;
    const { fence } = record;
    const same = r.approvalId === record.approval.approvalId && r.operationId === record.operationId && r.idempotencyKey === record.idempotencyKey
      && r.purpose === record.purpose && r.action === record.action.action && r.projectId === record.action.projectId && r.computerId === record.action.computerId
      && r.actionDigest === computeActionDigest(record.purpose, record.action)
      && r.brokerEpoch === fence.brokerEpoch && r.brokerChallenge === fence.brokerChallenge && r.leaseGeneration === fence.leaseGeneration && r.leaseId === fence.leaseId;
    return same ? r : null;
  }

  async function pollStep(record) {
    const { approvalId, expiresAt } = record.approval;
    const deadline = expiresAt * 1000;
    let delay = opt.pollInitialMs;
    let errors = 0;
    for (let polls = 0; polls < opt.maxPolls; polls += 1) {
      const status = await authority.status({ approvalId });
      if (status?.ok === true && status.state === 'approved') return approvedStep(record, status);
      if (status?.ok === true) errors = 0;
      else if (AUTHORITY_FINAL.has(codeOf(status))) return stop(await authorityFailure(record, ['SUBMITTED'], codeOf(status)));
      else {
        errors += 1;
        if (!TRANSIENT.has(codeOf(status)) || errors >= opt.maxStatusErrors) return stop(openResult(record, 'retryable', codeOf(status)));
      }
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await sleep(Math.min(delay, remaining)); // the last poll lands on the deadline
      delay = Math.min(delay * opt.pollFactor, opt.pollMaxMs);
    }
    return stop(await finalize(record, ['SUBMITTED'], 'EXPIRED', 'approval_timeout'));
  }

  async function approvedStep(record, status) {
    const receipt = receiptMatches(record, status.receipt);
    if (!receipt) return stop(await finalize(record, ['SUBMITTED'], 'FAILED', 'receipt_mismatch'));
    return next(await advance(record, ['SUBMITTED'], { phase: 'APPROVED', receipt: { receipt: status.receipt, signature: status.signature, exp: receipt.exp } }));
  }

  /**
   * Write one claim. The intent (CLAIMING) is persisted first. Returns { kind, record | result }: `ok` (final), `unsent` (nothing left the process; the record is back
   * where it was), `denied` or `sent_unknown` (the record is UNKNOWN: the Broker may have recorded the claim).
   */
  async function sendClaim(record, from) {
    const attempts = (record.claim?.attempts ?? 0) + 1;
    const claiming = await advance(record, [from], { phase: 'CLAIMING', claim: { ...record.claim, attempts } });
    const reply = await broker.claim({ receipt: record.receipt.receipt, signature: record.receipt.signature });
    if (reply?.ok === true) {
      return { kind: 'ok', result: await finalize(claiming, ['CLAIMING'], 'CLAIMED', undefined, { brokerState: reply.state, replayed: reply.replayed === true, reconciled: false }) };
    }
    const code = codeOf(reply);
    if (PRESEND.has(code)) {
      const back = await advance(claiming, ['CLAIMING'], { phase: from, claim: { ...record.claim, attempts, lastCode: code } });
      return { kind: 'unsent', code, record: back };
    }
    const lastOutcome = code === 'denied' ? 'denied' : 'transport';
    const unknown = await advance(claiming, ['CLAIMING'], { phase: 'UNKNOWN', claim: { attempts, lastOutcome, lastCode: code } });
    return { kind: lastOutcome === 'denied' ? 'denied' : 'sent_unknown', record: unknown };
  }

  async function claimStep(record) {
    let current = record;
    for (let attempt = 0; attempt < opt.sendAttempts; attempt += 1) {
      if (receiptExpired(current)) return stop(await finalize(current, ['APPROVED'], 'EXPIRED', 'receipt_expired')); // nothing was ever sent
      const sent = await sendClaim(current, 'APPROVED');
      if (sent.kind === 'ok') return stop(sent.result);
      if (sent.kind !== 'unsent') return next(sent.record);
      current = sent.record;
      if (!CLAIM_PRESEND_TRANSIENT.has(sent.code)) return stop(openResult(current, 'retryable', sent.code));
      if (attempt < opt.sendAttempts - 1) await sleep(backoff(attempt));
    }
    return stop(openResult(current, 'retryable', current.claim.lastCode));
  }

  /** CLAIMING (a crash mid-send) or UNKNOWN (a failure after the frame was written): ask the Broker what it recorded before doing anything else. */
  async function settleStep(record) {
    let current = record;
    let last = record.phase === 'UNKNOWN' ? (record.claim?.lastOutcome ?? 'transport') : 'transport';
    for (let attempt = 0; attempt <= opt.reconcileAttempts; attempt += 1) {
      if (attempt > 0) await sleep(backoff(attempt - 1));
      const inspected = await broker.inspect({ operationId: current.operationId });
      if (inspected?.ok === true) return stop(await finalize(current, ['CLAIMING', 'UNKNOWN'], 'CLAIMED', undefined, { brokerState: inspected.state, replayed: false, reconciled: true }));
      if (codeOf(inspected) !== 'denied') continue; // the answer itself was lost: nothing can be concluded, ask again
      if (last === 'denied' || receiptExpired(current)) return diagnose(current);
      const sent = await sendClaim(current, current.phase); // not recorded and the same receipt is still valid: the exact same bytes, never a new receipt
      if (sent.kind === 'ok') return stop(sent.result);
      current = sent.record;
      last = sent.kind === 'denied' ? 'denied' : 'transport';
    }
    return stop(openResult(current, 'unknown', current.claim?.lastCode ?? 'claim_unconfirmed'));
  }

  /** The Broker has no claim for this receipt and will not take it: find out whether its epoch moved (new cycle) or it simply refused. */
  async function diagnose(record) {
    const fence = await withRetry(() => broker.fence({ computerId: record.action.computerId }));
    if (fence?.ok !== true) return stop(openResult(record, 'retryable', codeOf(fence)));
    const moved = fence.brokerEpoch !== record.fence.brokerEpoch || fence.leaseGeneration !== record.fence.leaseGeneration;
    if (moved && record.cycle < opt.maxCycles) return next(await startNextCycle(record));
    if (moved) return stop(await finalize(record, ['CLAIMING', 'UNKNOWN'], 'FAILED', 'epoch_changed'));
    return stop(receiptExpired(record) ? await finalize(record, ['CLAIMING', 'UNKNOWN'], 'EXPIRED', 'receipt_expired') : await finalize(record, ['CLAIMING', 'UNKNOWN'], 'FAILED', 'broker_denied'));
  }

  function startNextCycle(record) {
    const cycle = record.cycle + 1;
    const superseded = { cycle: record.cycle, brokerEpoch: record.fence.brokerEpoch, leaseGeneration: record.fence.leaseGeneration, reason: 'epoch_changed' };
    return advance(record, ['CLAIMING', 'UNKNOWN'], {
      phase: 'INTENT', cycle, idempotencyKey: keyFor(record.operationId, cycle), fence: null, approval: null, receipt: null, claim: null,
      superseded: [...(record.superseded ?? []), superseded],
    });
  }

  const STEPS = { INTENT: fenceStep, FENCED: submitStep, SUBMITTED: pollStep, APPROVED: claimStep, CLAIMING: settleStep, UNKNOWN: settleStep };

  async function drive(start) {
    let record = start;
    for (;;) {
      const step = STEPS[record.phase];
      if (!step && !TERMINAL_STATUS[record.phase]) return Object.freeze({ status: 'failed', operationId: record.operationId, code: 'journal_corrupt', replayed: false });
      if (!step) return terminalResult(record, true); // already final: report the recorded outcome, do nothing
      const out = await step(record);
      if (out.result) return out.result;
      record = out.record;
    }
  }

  async function execute(input) {
    const { operationId, purpose, action, requestDigest } = input;
    const fresh = { operationId, purpose, action, requestDigest, phase: 'INTENT', cycle: 1, idempotencyKey: keyFor(operationId, 1), createdAt: now(), updatedAt: now() };
    const { record } = await guard(() => journal.begin(fresh));
    if (record.requestDigest !== requestDigest) return Object.freeze({ status: 'failed', operationId, phase: record.phase, cycle: record.cycle, code: 'operation_conflict', replayed: false });
    return drive(record);
  }

  /** Run the whole flow, or continue it from the stored phase. Concurrent calls for one operationId share one run. Never throws for operational failures. */
  function track(operationId, start) {
    const running = inflight.get(operationId);
    if (running) return running;
    const promise = start()
      .catch((error) => {
        if (error instanceof JournalFailure) return Object.freeze({ status: 'retryable', operationId, code: error.code, replayed: false });
        throw error;
      })
      .finally(() => inflight.delete(operationId));
    inflight.set(operationId, promise);
    return promise;
  }

  return Object.freeze({
    run(request) {
      let input;
      try { input = normalizeRequest(request); } catch (error) {
        if (error instanceof FlowInputError) return Promise.resolve(Object.freeze({ status: 'failed', code: 'invalid_request', replayed: false }));
        throw error;
      }
      return track(input.operationId, () => execute(input));
    },
    resume(operationId) {
      if (typeof operationId !== 'string' || !ID_RE.test(operationId)) return Promise.resolve(Object.freeze({ status: 'failed', code: 'invalid_request', replayed: false }));
      return track(operationId, async () => {
        const record = await guard(() => journal.get(operationId));
        return record ? drive(record) : Object.freeze({ status: 'failed', operationId, code: 'unknown_operation', replayed: false });
      });
    },
  });
}
