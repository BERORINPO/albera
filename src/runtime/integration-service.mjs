import {
  acceptEvidence, authorizePromotion, beginPromotion, freezeCandidate, markApproved, observeTarget, reconcilePromotion, recordPromotion, startVerification,
  verificationStatus,
} from './integration-candidate.mjs';

// Integration Service (ADR-007 §3-§5 and §8; acceptance INT-01 / INT-02): drives ONE integration from a request to a merged, stale or refused outcome by
// calling, in order, the git quarantine, the verifier, the approvals and the promotion, and writing its intent to a durable journal BEFORE every step with
// an effect outside this process. Pure: git, the verifier, the approvals, the journal, the clock and the sleep are all injected (arch 5e), so the same
// code runs against fakes in tests and against real adapters later. Not wired into any entry yet; the real verifier and approvals are not built.
//
//   const s = createIntegrationService({ quarantine, promotion, verifier, approvals, journal, now, sleep, trustedRunners, identity, options })
//   await s.submit(request)        -> result   (starts, or continues, the integration `request.integrationId`; same id + same content is the same integration)
//   await s.resume(integrationId)  -> result   (continues it from the recorded phase after a restart; a final integration only reports its outcome)
//
// Phases (the journal record's `phase`; terminal ones in capitals on the right):
//   SUBMITTED -> VALIDATING -> PREPARED -> VERIFYING -> REVIEW_REQUIRED -> PROMOTING -> MERGED
//                                                                              \-> UNKNOWN_PROMOTION -> MERGED | STALE | back to VERIFYING (new approval)
//   terminal: MERGED STALE BLOCKED REJECTED CONFLICTED VERIFY_FAILED DENIED EXPIRED FAILED.   APPROVED is never recorded alone: the authorization
//   and the candidate's PROMOTING state are written in ONE advance, before the push.
//
// Rules this code enforces:
//  - Resume. SUBMITTED / VALIDATING restart in a NEW quarantine repository (the old path is kept in `abandoned`); the candidate is rebuilt from the stored
//    `identityTimestamp`, so the same inputs give the same commit. VERIFYING calls `verifier.start` again with the SAME runId (the port is idempotent per
//    runId) and collects. REVIEW_REQUIRED asks the approvals for the SAME requestId and only requests when they do not know it.
//  - A resumed PROMOTING NEVER pushes. A push may be in flight from the process that died: wait `settleMs`, record UNKNOWN_PROMOTION, read the target tip back and
//    let reconcilePromotion decide. A tip that is the candidate commit is MERGED; an old tip goes back to VERIFYING and needs a NEW approval (the old one names
//    the previous candidate version: approval_stale). A tip that cannot be read keeps the integration UNKNOWN_PROMOTION; nothing is sent.
//  - Evidence counts only through acceptEvidence with the host's `trustedRunners`. `agent_reported` results are kept as `claims` and never count.
//    What an approvals port returns is untrusted: it always goes through authorizePromotion against a tip read just before.
//  - Time: `now()` is Unix milliseconds; integration-candidate takes seconds.
//  - The quarantine repository is created BEFORE its path can be recorded, so a crash right there leaves an unrecorded repository on disk (a later GC concern).
//    Quarantine, verifier, approvals and promotion calls that THROW are a crash of this process: the record keeps the phase that says what may have happened.

export const INTEGRATION_PHASES = Object.freeze([
  'SUBMITTED', 'VALIDATING', 'PREPARED', 'VERIFYING', 'REVIEW_REQUIRED', 'PROMOTING', 'UNKNOWN_PROMOTION',
  'MERGED', 'STALE', 'BLOCKED', 'REJECTED', 'CONFLICTED', 'VERIFY_FAILED', 'DENIED', 'EXPIRED', 'FAILED',
]);
const TERMINAL = Object.freeze(INTEGRATION_PHASES.slice(7));
/** `status` of a result. Open ones (`pending`, `retryable`, `unknown`) are not final: call `resume` with the same id. */
export const INTEGRATION_STATUSES = Object.freeze([...TERMINAL.map((p) => p.toLowerCase()), 'pending', 'retryable', 'unknown']);
export const INTEGRATION_DEFAULTS = Object.freeze({
  pollInitialMs: 500, pollMaxMs: 5000, pollFactor: 2, maxPolls: 1000, maxVerifierReruns: 1, maxApprovalRounds: 2, maxEvidence: 64,
  maxApprovalLifetimeMs: 15 * 60 * 1000,   // an approval that stays valid longer than this from now is refused (ADR-007 sets no limit; integration-candidate only needs it unexpired)
  settleMs: 65_000,   // git-process TIMEOUT_MS (60 s) + 5 s; test/runtime-integration-service.test.mjs pins it (this module may not import the process runner)
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PLACEHOLDER = 'a'.repeat(40);
const REQUEST_KEYS = ['integrationId', 'projectId', 'repositoryId', 'targetRef', 'submissions', 'testPlanDigest', 'imageDigest', 'lockfileDigest', 'policyVersion', 'algorithmVersion', 'risk', 'requiredGates'];
const SUBMISSION_KEYS = ['submissionId', 'bundlePath', 'ref', 'baseCommitOid', 'resultCommitOid'];
const EVIDENCE_FIELDS = ['evidenceId', 'gate', 'result', 'provenance', 'runnerId', 'subjectCommitOid', 'subjectTreeOid', 'testPlanDigest', 'imageDigest', 'lockfileDigest', 'policyVersion', 'capturedAt', 'outputArtifactDigest'];
const APPROVAL_FIELDS = ['decision', 'candidateId', 'candidateVersion', 'candidateCommitOid', 'targetRef', 'targetTipOid', 'policyVersion', 'expiresAt'];
const COMPREHENSION_FIELDS = ['reviewerId', 'basis', 'candidateCommitOid'];
const PERMANENT_TIP_CODES = new Set(['request_invalid', 'remote_unknown', 'ref_not_promotable', 'target_missing']);   // configuration, not a passing outage
const REFUSAL_PHASE = Object.freeze({ approval_denied: 'DENIED', approval_expired: 'EXPIRED' });
const CANDIDATE_FIELDS = ['candidateId', 'projectId', 'repositoryId', 'targetRef', 'targetTipOid', 'candidateCommitOid', 'candidateTreeOid', 'testPlanDigest', 'imageDigest', 'lockfileDigest',
  'policyVersion', 'algorithmVersion', 'risk', 'requiredGates'];
// The candidate state integration-candidate holds in each recorded phase (REVIEW_REQUIRED is a VERIFYING candidate waiting for a person).
const CANDIDATE_STATE_OF = Object.freeze({ PREPARED: 'PREPARED', VERIFYING: 'VERIFYING', REVIEW_REQUIRED: 'VERIFYING', PROMOTING: 'PROMOTING', UNKNOWN_PROMOTION: 'UNKNOWN_PROMOTION' });
const MAX_TIPS = 16;
const OPERATION_PREFIX = 'integration/';   // '/' is outside the approved-operation-flow id grammar, so the two kinds of record cannot collide in one journal

class RequestError extends Error {}
class JournalFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}

const isOid = (v) => typeof v === 'string' && OID_RE.test(v);
const isCount = (v, min = 1) => Number.isSafeInteger(v) && v >= min;
const safeCode = (code, fallback) => (typeof code === 'string' && CODE_RE.test(code) ? code : fallback);
const scalar = (v) => (typeof v === 'string' ? v.slice(0, 256) : typeof v === 'number' || typeof v === 'boolean' ? v : undefined);
const pickScalars = (o, fields) => Object.fromEntries(fields.flatMap((f) => (scalar(o?.[f]) === undefined ? [] : [[f, scalar(o[f])]])));
const noApproval = { requestId: null, rounds: 0, expiresAt: null, decision: null };

function resolveOptions(options = {}) {
  const merged = { ...INTEGRATION_DEFAULTS, ...options };
  const ok = ['pollInitialMs', 'pollMaxMs', 'maxPolls', 'maxApprovalRounds', 'maxEvidence', 'settleMs', 'maxApprovalLifetimeMs'].every((n) => isCount(merged[n])) && isCount(merged.maxVerifierReruns, 0)
    && Number.isFinite(merged.pollFactor) && merged.pollFactor >= 1 && Object.keys(options).every((n) => n in INTEGRATION_DEFAULTS);
  if (!ok) throw new TypeError('invalid_integration_options');
  return Object.freeze(merged);
}

/** A copy with exactly the known keys, or throws RequestError. The shape of the candidate's own fields is checked by freezeCandidate with placeholder oids. */
function normalizeRequest(request) {
  const r = request;
  const known = (o, keys) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));
  if (!known(r, REQUEST_KEYS) || typeof r.integrationId !== 'string' || !ID_RE.test(r.integrationId) || !Array.isArray(r.submissions) || r.submissions.length > 32) throw new RequestError();
  if (!r.submissions.every((s) => known(s, SUBMISSION_KEYS) && [s.bundlePath, s.ref].every((x) => typeof x === 'string' && x.length > 0 && x.length <= 4096))) throw new RequestError();
  const out = {
    integrationId: r.integrationId, projectId: r.projectId, repositoryId: r.repositoryId, targetRef: r.targetRef,
    submissions: r.submissions.map((s) => ({ submissionId: s.submissionId, bundlePath: s.bundlePath, ref: s.ref, baseCommitOid: s.baseCommitOid, resultCommitOid: s.resultCommitOid })),
    testPlanDigest: r.testPlanDigest, imageDigest: r.imageDigest, lockfileDigest: r.lockfileDigest, policyVersion: r.policyVersion, algorithmVersion: r.algorithmVersion,
    risk: r.risk, requiredGates: Array.isArray(r.requiredGates) ? [...r.requiredGates] : r.requiredGates,
  };
  try {
    freezeCandidate({ ...out, candidateId: out.integrationId, targetTipOid: PLACEHOLDER, candidateCommitOid: 'b'.repeat(40), candidateTreeOid: 'c'.repeat(40) });
  } catch { throw new RequestError(); }
  return out;
}

/**
 * @param {{ quarantine: object, promotion: object, verifier: object, approvals: object, journal: object, now: () => number, sleep: (ms: number) => Promise<void>,
 *   trustedRunners: readonly string[], identity: { name: string, email: string }, options?: Partial<typeof INTEGRATION_DEFAULTS> }} deps
 *   quarantine: create / importBundle / inspect / buildCandidate (git-quarantine.mjs); promotion: readTip / fetchTip / push (git-promotion.mjs); verifier:
 *   `start({ runId, subject })` -> { ok } and `collect({ runId })` -> { state: 'running' | 'done' | 'lost', evidence }; approvals: `request({ requestId, subject })` -> { ok } and
 *   `status({ requestId })` -> { ok: true, state: 'pending' | 'decided' | 'expired', approval } or { ok: false, code: 'unknown_request' }; journal: the flow journal port
 *   (approved-operation-journal.mjs). Both ports are idempotent per id. `trustedRunners` and `identity` come from host configuration.
 */
export function createIntegrationService({ quarantine, promotion, verifier, approvals, journal, now, sleep, trustedRunners, identity, options } = {}) {
  const portsOk = [quarantine?.create, quarantine?.importBundle, quarantine?.inspect, quarantine?.buildCandidate, promotion?.readTip, promotion?.fetchTip, promotion?.push, verifier?.start, verifier?.collect,
    approvals?.request, approvals?.status, journal?.begin, journal?.advance, journal?.get, now, sleep].every((fn) => typeof fn === 'function');
  if (!portsOk || !Array.isArray(trustedRunners) || trustedRunners.length === 0 || identity === null || typeof identity !== 'object') throw new TypeError('invalid_integration_dependencies');
  const opt = resolveOptions(options);
  const trust = Object.freeze({ trustedRunners: Object.freeze([...trustedRunners]) });
  const inflight = new Map();
  const nowSec = () => Math.floor(now() / 1000);
  const backoff = (n) => Math.min(opt.pollInitialMs * opt.pollFactor ** n, opt.pollMaxMs);

  /** Every journal call goes through here: a failure is "not persisted", and the service stops before the next side effect. */
  const guard = async (call) => {
    try { return await call(); } catch (error) { throw new JournalFailure(error?.code === 'conflict' ? 'journal_conflict' : 'journal_error'); }
  };
  const advance = (record, from, patch) => guard(() => journal.advance(record.operationId, record.revision, from, { ...patch, updatedAt: now() }));

  const terminalResult = (record, replayed) => Object.freeze({
    status: record.phase.toLowerCase(), integrationId: record.request?.integrationId, phase: record.phase, ...(record.outcome?.code ? { code: record.outcome.code } : {}),
    ...(record.candidate ? { candidateCommitOid: record.candidate.candidateCommitOid, candidateVersion: record.candidate.version } : {}), replayed,
  });
  const openResult = (record, status, code) => Object.freeze({ status, integrationId: record.request.integrationId, phase: record.phase, code, replayed: false });
  const finalize = async (record, from, phase, code, patch = {}) => terminalResult(await advance(record, from, { ...patch, phase, outcome: { code } }), false);
  const next = (record) => ({ record });
  const stop = (result) => ({ result });
  const ids = (record) => `${record.request.integrationId}.v${record.candidate.version}`;

  /** The target tip as read now: { oid } or { code } (`target_missing` when the ref does not exist). */
  async function tipOf(record) {
    const tip = await promotion.readTip({ repositoryId: record.request.repositoryId, ref: record.request.targetRef });
    if (tip?.ok === true && isOid(tip.oid)) return { oid: tip.oid };
    if (tip?.ok === true && tip.oid === null) return { code: 'target_missing' };
    return { code: safeCode(tip?.code, 'tip_unreadable') };
  }
  /** The target tip fetched into the quarantine repository `repo`: { oid } (its objects are there now) or { code }. The port's oid is only taken in the shape of an oid. */
  async function fetchedTip(record, repo) {
    const fetched = await promotion.fetchTip(repo, { repositoryId: record.request.repositoryId, ref: record.request.targetRef });
    if (fetched?.ok === true && isOid(fetched.oid)) return { oid: fetched.oid };
    return { code: safeCode(fetched?.code, 'tip_unreadable') };
  }
  /** A tip that could not be read: a configuration problem is final, anything else leaves the record where it is. */
  async function tipFailure(record, from, code) {
    return PERMANENT_TIP_CODES.has(code) ? finalize(record, from, 'FAILED', code) : openResult(record, 'retryable', code);
  }

  /**
   * The journal is not trusted on load. null when the record is what this service would have written for its own request; otherwise 'request' (the request is not a
   * valid request, or not this record's) or 'record' (the candidate is not the one this request freezes, is in a state the phase cannot have, or the authorization is
   * not exactly the candidate's own compare-and-swap). Commit, tree and tip are taken from the record (they come from git and cannot be re-derived here); everything
   * the request decides (risk, gates, digests, policy, submissions) is rebuilt with freezeCandidate and must be equal.
   */
  function recordProblem(record) {
    let request;
    try { request = normalizeRequest(record.request); } catch { return 'request'; }
    if (JSON.stringify(request) !== JSON.stringify(record.request) || record.operationId !== `${OPERATION_PREFIX}${request.integrationId}`) return 'request';
    if (record.phase === 'SUBMITTED' || record.phase === 'VALIDATING') return null;   // no candidate yet
    const c = record.candidate;
    try {
      const shape = (x) => JSON.stringify([CANDIDATE_FIELDS.map((f) => x[f]), x.submissions.map((m) => [m.submissionId, m.baseCommitOid, m.resultCommitOid])]);
      const expected = freezeCandidate({ ...request, candidateId: request.integrationId, targetTipOid: c.targetTipOid, candidateCommitOid: c.candidateCommitOid, candidateTreeOid: c.candidateTreeOid });
      if (shape(expected) !== shape(c) || c.state !== CANDIDATE_STATE_OF[record.phase] || !Number.isSafeInteger(c.version) || c.version < 1) return 'record';
    } catch { return 'record'; }
    if (record.phase !== 'PREPARED' && typeof record.quarantine?.repo !== 'string') return 'record';
    if (record.phase === 'PROMOTING' || record.phase === 'UNKNOWN_PROMOTION') {
      const u = record.authorization?.update;
      if (u?.ref !== c.targetRef || u.expectedOldOid !== c.targetTipOid || u.newOid !== c.candidateCommitOid) return 'record';
    }
    return null;
  }

  /** Stored evidence is data, not a verdict: only items acceptEvidence takes for THIS candidate and the CURRENT trusted runners count. */
  const countedEvidence = (record) => (Array.isArray(record.verification?.evidence) ? record.verification.evidence : []).filter((e) => acceptEvidence(record.candidate, e, trust).ok);

  // SUBMITTED / VALIDATING: a new quarantine repository every time, fetch the target tip into it, import + inspect each submission, build and freeze the candidate on that tip.
// A crash anywhere here repeats all of it in a new repository (the fetched oid is only recorded with the candidate); a target that moves later is STALE as usual.
  async function validateStep(record) {
    const repo = await quarantine.create();
    if (typeof repo !== 'string' || repo.length === 0) return stop(openResult(record, 'retryable', 'quarantine_unavailable'));
    const abandoned = record.quarantine.repo ? [...record.quarantine.abandoned, record.quarantine.repo] : record.quarantine.abandoned;
    const current = await advance(record, ['SUBMITTED', 'VALIDATING'], { phase: 'VALIDATING', quarantine: { repo, abandoned } });
    // The target tip's objects come from the registered remote, never from a bundle, and BEFORE the bundles: a guest bundle carries only its own commits on top of its
    // base (the base is a prerequisite that has to exist here). The tip frozen into the candidate is the one fetched; it is recorded with the candidate (PREPARED).
    const tip = await fetchedTip(current, repo);
    if (tip.code) return stop(await tipFailure(current, ['VALIDATING'], tip.code));
    for (const s of current.request.submissions) {
      const imported = await quarantine.importBundle(repo, { bundlePath: s.bundlePath, ref: s.ref, expectedOid: s.resultCommitOid });
      if (imported?.ok !== true) return stop(await quarantineFailure(current, imported));
      const inspected = await quarantine.inspect(repo, { baseOid: s.baseCommitOid, resultOid: s.resultCommitOid });
      if (inspected?.ok !== true) return stop(await quarantineFailure(current, inspected));
    }
    const built = await quarantine.buildCandidate(repo, {
      targetOid: tip.oid, submissions: current.request.submissions.map((s) => ({ baseOid: s.baseCommitOid, resultOid: s.resultCommitOid })),
      identity: { ...identity, timestamp: current.identityTimestamp },
    });
    if (built?.ok !== true) return stop(await quarantineFailure(current, built));
    let candidate;
    try {
      candidate = freezeCandidate({ ...current.request, candidateId: current.request.integrationId, targetTipOid: tip.oid, candidateCommitOid: built.candidateCommitOid, candidateTreeOid: built.candidateTreeOid });
    } catch (error) {
      return stop(await finalize(current, ['VALIDATING'], 'FAILED', safeCode(error?.message, 'candidate_invalid')));
    }
    return next(await advance(current, ['VALIDATING'], { phase: 'PREPARED', candidate }));
  }

  /** The quarantine said no: git trouble is retried later, a malformed request is a bug, a conflict is CONFLICTED and anything else a refusal of the submission. */
  async function quarantineFailure(record, reply) {
    const code = safeCode(reply?.code, 'quarantine_refused');
    if (code === 'git_failed') return openResult(record, 'retryable', code);
    if (code === 'request_invalid') return finalize(record, ['VALIDATING'], 'FAILED', 'quarantine_request_invalid');
    return finalize(record, ['VALIDATING'], code === 'conflicted' ? 'CONFLICTED' : 'REJECTED', code);
  }

  async function prepareStep(record) {
    const candidate = startVerification(record.candidate);
    const verification = { runId: `${ids({ ...record, candidate })}.r1`, runs: 1, evidence: [], claims: [] };
    return next(await advance(record, ['PREPARED'], { phase: 'VERIFYING', candidate, verification }));
  }

  // VERIFYING: evidence already recorded as verified (the loop above came back from a failed promotion) goes straight to review; otherwise run and collect.
  async function verifyStep(record) {
    const { candidate, verification } = record;
    if (verificationStatus(candidate, countedEvidence(record), trust) === 'verified') return enterReview(record);
    const subject = { integrationId: record.request.integrationId, repositoryId: record.request.repositoryId, sourceRepo: record.quarantine.repo, ...pickCandidate(candidate) };
    const started = await verifier.start({ runId: verification.runId, subject });
    if (started?.ok !== true) return stop(openResult(record, 'retryable', safeCode(started?.code, 'verifier_unavailable')));
    for (let polls = 0; ; polls += 1) {
      const reply = await verifier.collect({ runId: verification.runId });
      if (reply?.state === 'done') return collected(record, reply.evidence);
      if (reply?.state === 'lost') return lostRun(record);
      if (reply?.state !== 'running') return stop(openResult(record, 'retryable', 'verifier_unavailable'));
      if (polls + 1 >= opt.maxPolls) return stop(openResult(record, 'pending', 'verification_running'));
      await sleep(backoff(polls));
    }
  }

  function pickCandidate(c) {
    return { candidateId: c.candidateId, candidateCommitOid: c.candidateCommitOid, candidateTreeOid: c.candidateTreeOid, testPlanDigest: c.testPlanDigest, imageDigest: c.imageDigest,
      lockfileDigest: c.lockfileDigest, policyVersion: c.policyVersion, requiredGates: c.requiredGates };
  }

  async function lostRun(record) {
    const { verification } = record;
    if (verification.runs > opt.maxVerifierReruns) return stop(await finalize(record, ['VERIFYING'], 'FAILED', 'verifier_lost'));
    const runs = verification.runs + 1;
    return next(await advance(record, ['VERIFYING'], { verification: { ...verification, runId: `${ids(record)}.r${runs}`, runs } }));
  }

  /** INT-01: the verifier's answer is untrusted data. Agent-reported results become claims; everything else is judged by acceptEvidence. */
  async function collected(record, raw) {
    if (!Array.isArray(raw) || raw.length > opt.maxEvidence) return stop(await finalize(record, ['VERIFYING'], 'FAILED', 'verifier_response_invalid'));
    const list = raw.map((e) => pickScalars(e, EVIDENCE_FIELDS));
    const verification = { ...record.verification, evidence: list.filter((e) => e.provenance !== 'agent_reported'), claims: list.filter((e) => e.provenance === 'agent_reported') };
    const status = verificationStatus(record.candidate, verification.evidence, trust);
    if (status === 'verified') return next(await advance(record, ['VERIFYING'], { verification }));
    const refusal = verification.evidence.map((e) => acceptEvidence(record.candidate, e, trust)).find((r) => !r.ok);
    return stop(await finalize(record, ['VERIFYING'], 'VERIFY_FAILED', status === 'failed' ? 'verification_failed' : refusal?.code ?? 'evidence_missing', { verification }));
  }

  /** Verified: read the tip once more. A moved target is STALE before anybody is asked; otherwise record the request id, then ask. */
  async function enterReview(record) {
    const tip = await tipOf(record);
    if (tip.code) return stop(await tipFailure(record, ['VERIFYING'], tip.code));
    const observed = observeTarget(record.candidate, tip.oid);
    if (observed.state === 'STALE') return stop(await finalize(record, ['VERIFYING'], 'STALE', 'target_moved', { candidate: observed, promotion: withTip(record.promotion, tip.oid) }));
    const approval = { ...noApproval, ...record.approval, requestId: `${ids(record)}.a1`, rounds: 1 };
    return next(await advance(record, ['VERIFYING'], { phase: 'REVIEW_REQUIRED', approval, promotion: withTip(record.promotion, tip.oid) }));
  }

  const withTip = (promo, oid) => ({ ...promo, tips: [...promo.tips, oid].slice(-MAX_TIPS) });

  // REVIEW_REQUIRED: the request id is recorded. Ask the approvals what they know of it; only when they know nothing, request.
  async function reviewStep(record) {
    const { requestId } = record.approval;
    let reply = await approvals.status({ requestId });
    if (reply?.ok === false && reply.code === 'unknown_request') {
      const sent = await approvals.request({ requestId, subject: { integrationId: record.request.integrationId, candidate: record.candidate, evidence: countedEvidence(record), claims: record.verification.claims, requestedAt: nowSec() } });
      if (sent?.ok !== true) return stop(openResult(record, 'retryable', safeCode(sent?.code, 'approvals_unavailable')));
      reply = await approvals.status({ requestId });
    }
    for (let polls = 0; ; polls += 1) {
      if (reply?.ok === true && reply.state === 'decided') return decideStep(record, reply.approval);
      if (reply?.ok === true && reply.state === 'expired') return expiredRound(record);
      if (reply?.ok !== true || reply.state !== 'pending') return stop(openResult(record, 'retryable', 'approvals_unavailable'));
      if (polls + 1 >= opt.maxPolls) return stop(openResult(record, 'pending', 'approval_pending'));
      await sleep(backoff(polls));
      reply = await approvals.status({ requestId });
    }
  }

  async function expiredRound(record) {
    const { approval } = record;
    if (approval.rounds >= opt.maxApprovalRounds) return stop(await finalize(record, ['REVIEW_REQUIRED'], 'EXPIRED', 'approval_expired'));
    const rounds = approval.rounds + 1;
    return next(await advance(record, ['REVIEW_REQUIRED'], { approval: { ...approval, requestId: `${ids(record)}.a${rounds}`, rounds } }));
  }

  /** INT-02: the approval is untrusted. Authorize against a tip read now; on success write the authorization and PROMOTING in ONE advance, then push. */
  async function decideStep(record, raw) {
    const approval = raw !== null && typeof raw === 'object'
      ? { ...pickScalars(raw, APPROVAL_FIELDS), decidedBy: pickScalars(raw.decidedBy, ['kind', 'id']), ...(raw.comprehension && typeof raw.comprehension === 'object' ? { comprehension: pickScalars(raw.comprehension, COMPREHENSION_FIELDS) } : {}) }
      : null;
    const decided = { ...record.approval, expiresAt: approval?.expiresAt ?? null, decision: approval };
    const tip = await tipOf(record);
    if (tip.code) return stop(await tipFailure(record, ['REVIEW_REQUIRED'], tip.code));
    const at = nowSec();
    if (Number.isSafeInteger(approval?.expiresAt) && approval.expiresAt > at + Math.floor(opt.maxApprovalLifetimeMs / 1000)) {
      return stop(await finalize(record, ['REVIEW_REQUIRED'], 'FAILED', 'approval_lifetime_exceeded', { approval: decided }));   // a person's approval is short-lived; the port does not get to choose
    }
    const auth = authorizePromotion(record.candidate, { currentTipOid: tip.oid, evidence: countedEvidence(record), trustedRunners: trust.trustedRunners, approval, now: at });
    if (!auth.ok && auth.code === 'target_moved') {
      return stop(await finalize(record, ['REVIEW_REQUIRED'], 'STALE', 'target_moved', { candidate: observeTarget(record.candidate, tip.oid), approval: decided, promotion: withTip(record.promotion, tip.oid) }));
    }
    if (!auth.ok) return stop(await finalize(record, ['REVIEW_REQUIRED'], REFUSAL_PHASE[auth.code] ?? 'FAILED', auth.code, { approval: decided }));
    const candidate = beginPromotion(markApproved(record.candidate, auth), at);
    const promoting = await advance(record, ['REVIEW_REQUIRED'], {
      phase: 'PROMOTING', candidate, approval: decided, authorization: { update: auth.update, approvedUntil: auth.approvedUntil },
      promotion: { ...withTip(record.promotion, tip.oid), sentAt: now(), attempts: record.promotion.attempts + 1, rawOutcome: null, code: null },
    });
    return pushStep(promoting);
  }

  /** The only place that pushes: reached straight from the PROMOTING advance above, never from a resume. */
  async function pushStep(record) {
    const sent = await promotion.push(record.quarantine.repo, { repositoryId: record.request.repositoryId, ...record.authorization.update });
    const code = safeCode(sent?.code, 'no_code');
    switch (sent?.outcome) {
      case 'updated': return stop(await settle(record, 'updated', code));
      case 'blocked': return stop(await settle(record, 'blocked', code));
      case null: return stop(await settle(record, 'blocked', code, 'refused'));   // the adapter refused before sending anything: the same push is never retried
      case 'rejected': {
        const tip = await tipOf(record);   // the CAS lost, unless the candidate is already there
        if (tip.oid === record.candidate.candidateCommitOid) return stop(await settle(record, 'updated', 'found_on_remote', 'rejected'));
        if (tip.oid) return stop(await settle(record, 'rejected', code));
        return toUnknown(record, 'rejected', code);
      }
      default: return toUnknown(record, safeCode(sent?.outcome, 'unrecognized'), code);
    }
  }

  async function settle(record, outcome, code, rawOutcome = outcome) {
    const candidate = recordPromotion(record.candidate, outcome);
    return finalize(record, ['PROMOTING'], candidate.state, code, { candidate, promotion: { ...record.promotion, rawOutcome, code } });
  }

  async function toUnknown(record, rawOutcome, code) {
    const candidate = recordPromotion(record.candidate, 'unknown');
    return next(await advance(record, ['PROMOTING'], { phase: 'UNKNOWN_PROMOTION', candidate, promotion: { ...record.promotion, rawOutcome, code } }));
  }

  /** PROMOTING found by a resume: the push may still be in flight from the dead process. Never push; give it time to end, then go and look. */
  async function settleStep(record) {
    await sleep(opt.settleMs);
    return toUnknown(record, 'unknown', 'resumed_without_answer');
  }

  /** UNKNOWN_PROMOTION: the remote tip decides (ADR-007 §8). No push happens here, whatever it reads. */
  async function reconcileStep(record) {
    const tip = await tipOf(record);
    if (tip.code) return stop(openResult(record, 'unknown', tip.code));
    const candidate = reconcilePromotion(record.candidate, tip.oid);
    const promo = withTip(record.promotion, tip.oid);
    if (candidate.state === 'MERGED') return stop(await finalize(record, ['UNKNOWN_PROMOTION'], 'MERGED', 'found_on_remote', { candidate, promotion: promo }));
    if (candidate.state === 'STALE') return stop(await finalize(record, ['UNKNOWN_PROMOTION'], 'STALE', 'target_moved', { candidate, promotion: promo }));
    const superseded = [...(record.approval.superseded ?? []), record.approval.requestId];
    return next(await advance(record, ['UNKNOWN_PROMOTION'], { phase: 'VERIFYING', candidate, promotion: promo, authorization: null, approval: { ...noApproval, superseded } }));
  }

  const STEPS = { SUBMITTED: validateStep, VALIDATING: validateStep, PREPARED: prepareStep, VERIFYING: verifyStep, REVIEW_REQUIRED: reviewStep, PROMOTING: settleStep, UNKNOWN_PROMOTION: reconcileStep };

  async function drive(start) {
    let record = start;
    for (;;) {
      if (record.kind !== 'integration') return Object.freeze({ status: 'failed', code: 'journal_corrupt', replayed: false });
      const step = STEPS[record.phase];
      if (!step && !TERMINAL.includes(record.phase)) return Object.freeze({ status: 'failed', integrationId: record.request?.integrationId, code: 'journal_corrupt', replayed: false });
      if (!step) return terminalResult(record, true);   // already final: report the recorded outcome, do nothing
      const problem = recordProblem(record);
      if (problem === 'request') return Object.freeze({ status: 'failed', code: 'record_mismatch', replayed: false });   // not even a valid request: nothing to record against
      if (problem) return finalize(record, [record.phase], 'FAILED', 'record_mismatch');
      const out = await step(record);
      if (out.result) return out.result;
      record = out.record;
    }
  }

  async function execute(request, key) {
    const fresh = {
      operationId: `${OPERATION_PREFIX}${request.integrationId}`, kind: 'integration', recordVersion: 1, phase: 'SUBMITTED', request, identityTimestamp: nowSec(),
      quarantine: { repo: null, abandoned: [] }, candidate: null, verification: { runId: null, runs: 0, evidence: [], claims: [] }, approval: { ...noApproval }, authorization: null,
      promotion: { sentAt: null, attempts: 0, rawOutcome: null, code: null, tips: [] }, outcome: null, createdAt: now(), updatedAt: now(),
    };
    const { record } = await guard(() => journal.begin(fresh));
    if (JSON.stringify(record.request) !== key) return Object.freeze({ status: 'failed', integrationId: request.integrationId, phase: record.phase, code: 'integration_conflict', replayed: false });
    return drive(record);
  }

  /** Concurrent calls for one id share one run; a submit with other content waits for the run to end and then meets the stored request (integration_conflict). */
  function track(id, key, start) {
    const running = inflight.get(id);
    if (running && (key === null || running.key === key)) return running.promise;
    const go = () => {
      const promise = start()
        .catch((error) => {
          if (error instanceof JournalFailure) return Object.freeze({ status: 'retryable', integrationId: id, code: error.code, replayed: false });
          throw error;
        })
        .finally(() => { if (inflight.get(id)?.promise === promise) inflight.delete(id); });
      inflight.set(id, { key, promise });
      return promise;
    };
    return running ? running.promise.then(go, go) : go();
  }

  return Object.freeze({
    /** Never throws for an operational failure; a port that throws is a crash and rejects (the record says where `resume` continues). */
    submit(request) {
      let input;
      try { input = normalizeRequest(request); } catch (error) {
        if (error instanceof RequestError) return Promise.resolve(Object.freeze({ status: 'failed', code: 'invalid_request', replayed: false }));
        throw error;
      }
      const key = JSON.stringify(input);
      return track(input.integrationId, key, () => execute(input, key));
    },
    resume(integrationId) {
      if (typeof integrationId !== 'string' || !ID_RE.test(integrationId)) return Promise.resolve(Object.freeze({ status: 'failed', code: 'invalid_request', replayed: false }));
      return track(integrationId, null, async () => {
        const record = await guard(() => journal.get(`${OPERATION_PREFIX}${integrationId}`));
        return record ? drive(record) : Object.freeze({ status: 'failed', integrationId, code: 'unknown_integration', replayed: false });
      });
    },
  });
}
