// Verified-integration candidate (ADR-007 §3-§5 and §8; acceptance INT-01, INT-02). Pure: no git, no clock, no disk. The host's Integration
// Service builds the candidate commit in a quarantined repository, the verifier runs the tests, a person approves, and a promotion adapter moves
// the target ref; this module only decides, on immutable records, whether each step may happen. Every record it returns is frozen and every
// change returns a NEW candidate with `version + 1`, so an approval or a promotion that names an older version is refused (generation fencing).
//
//   freezeCandidate(input)                         -> candidate (state PREPARED, version 1)
//   observeTarget(candidate, tipOid)               -> candidate (STALE when the target branch moved; unchanged otherwise)
//   acceptEvidence(candidate, evidence, opts)      -> { ok: true } | { ok: false, code }   (INT-01)
//   verificationStatus(candidate, evidence, opts)  -> 'verified' | 'failed' | 'pending'
//   authorizePromotion(candidate, request)         -> { ok: true, update } | { ok: false, code }   (INT-02)
//   recordPromotion(candidate, outcome)            -> candidate (MERGED, UNKNOWN_PROMOTION or BLOCKED)
//   reconcilePromotion(candidate, remoteTipOid)    -> candidate (MERGED, back to APPROVED for a retry, or STALE)
//
// `update` is the only ref change the promotion adapter may make: a compare-and-swap of `ref` from `expectedOldOid` to `newOid`. There is no force
// form. An ambiguous push (timeout after send) is UNKNOWN_PROMOTION, and the only way out is reconcilePromotion with the observed remote tip: never a
// blind re-push (ADR-007 §8, "GitHub/remote times out after successful push").

export const CANDIDATE_STATES = Object.freeze(['PREPARED', 'VERIFYING', 'APPROVED', 'PROMOTING', 'MERGED', 'STALE', 'UNKNOWN_PROMOTION', 'BLOCKED']);
export const EVIDENCE_REFUSALS = Object.freeze([
  'evidence_invalid', 'evidence_agent_reported', 'evidence_untrusted_runner', 'evidence_commit_mismatch', 'evidence_tree_mismatch',
  'evidence_plan_mismatch', 'evidence_image_mismatch', 'evidence_policy_mismatch', 'evidence_gate_unknown',
]);
export const PROMOTION_REFUSALS = Object.freeze([
  'request_invalid', 'candidate_not_promotable', 'target_moved', 'not_verified', 'approval_missing', 'approval_not_human', 'approval_denied',
  'approval_stale', 'approval_mismatch', 'approval_expired', 'comprehension_required',
]);

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REF_RE = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const RISKS = Object.freeze(['low', 'medium', 'high']);
const COMPREHENSION_BASES = Object.freeze(['explanation', 'demonstration']);   // never 'ai_summary': a model's explanation is a study aid (ADR-007 §6)

const ok = Object.freeze({ ok: true });
const refuse = (code) => Object.freeze({ ok: false, code });
const isOid = (v) => typeof v === 'string' && OID_RE.test(v);
const isDigest = (v) => typeof v === 'string' && DIGEST_RE.test(v);
const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const isVersion = (v) => Number.isSafeInteger(v) && v >= 1;

function freezeSubmission(s) {
  if (s === null || typeof s !== 'object' || !isId(s.submissionId) || !isOid(s.baseCommitOid) || !isOid(s.resultCommitOid)) throw new TypeError('invalid_candidate_submission');
  return Object.freeze({ submissionId: s.submissionId, baseCommitOid: s.baseCommitOid, resultCommitOid: s.resultCommitOid });
}

/** Freezes the exact inputs of a candidate (ADR-007 §4 step 1 and 4). Throws TypeError('invalid_candidate_<field>') on any malformed input. */
export function freezeCandidate(input = {}) {
  const c = input ?? {};
  for (const f of ['candidateId', 'projectId', 'repositoryId']) if (!isId(c[f])) throw new TypeError(`invalid_candidate_${f}`);
  if (typeof c.targetRef !== 'string' || !REF_RE.test(c.targetRef) || c.targetRef.includes('..') || c.targetRef.endsWith('/') || c.targetRef.endsWith('.lock')) throw new TypeError('invalid_candidate_targetRef');
  for (const f of ['targetTipOid', 'candidateCommitOid', 'candidateTreeOid']) if (!isOid(c[f])) throw new TypeError(`invalid_candidate_${f}`);
  for (const f of ['testPlanDigest', 'imageDigest']) if (!isDigest(c[f])) throw new TypeError(`invalid_candidate_${f}`);
  if (!isVersion(c.policyVersion)) throw new TypeError('invalid_candidate_policyVersion');
  if (!isVersion(c.algorithmVersion)) throw new TypeError('invalid_candidate_algorithmVersion');
  if (!RISKS.includes(c.risk)) throw new TypeError('invalid_candidate_risk');
  if (!Array.isArray(c.requiredGates) || c.requiredGates.length === 0 || !c.requiredGates.every(isId) || new Set(c.requiredGates).size !== c.requiredGates.length) throw new TypeError('invalid_candidate_requiredGates');
  if (!Array.isArray(c.submissions) || c.submissions.length === 0) throw new TypeError('invalid_candidate_submissions');
  const submissions = Object.freeze(c.submissions.map(freezeSubmission));
  if (new Set(submissions.map((s) => s.submissionId)).size !== submissions.length) throw new TypeError('invalid_candidate_submissions');
  if (c.candidateCommitOid === c.targetTipOid) throw new TypeError('invalid_candidate_candidateCommitOid');   // nothing to promote
  return Object.freeze({
    candidateId: c.candidateId, projectId: c.projectId, repositoryId: c.repositoryId, targetRef: c.targetRef, targetTipOid: c.targetTipOid,
    candidateCommitOid: c.candidateCommitOid, candidateTreeOid: c.candidateTreeOid, testPlanDigest: c.testPlanDigest, imageDigest: c.imageDigest,
    policyVersion: c.policyVersion, algorithmVersion: c.algorithmVersion, risk: c.risk, requiredGates: Object.freeze([...c.requiredGates]),
    submissions, state: 'PREPARED', version: 1,
  });
}

const next = (candidate, state) => Object.freeze({ ...candidate, state, version: candidate.version + 1 });
const isFinal = (state) => state === 'MERGED' || state === 'STALE' || state === 'BLOCKED';

/** The target branch tip as just observed. Any movement makes the candidate STALE (ADR-007 §4 step 8); a final state never changes. */
export function observeTarget(candidate, tipOid) {
  if (!isOid(tipOid)) throw new TypeError('invalid_target_tip');
  if (isFinal(candidate.state) || candidate.state === 'UNKNOWN_PROMOTION' || candidate.state === 'PROMOTING') return candidate;   // promotion in flight: reconcile decides
  return tipOid === candidate.targetTipOid ? candidate : next(candidate, 'STALE');
}

/** VERIFYING once the verifier starts on this exact candidate. */
export function startVerification(candidate) {
  if (candidate.state !== 'PREPARED') throw new TypeError('candidate_not_prepared');
  return next(candidate, 'VERIFYING');
}

/**
 * INT-01: may this evidence count for this candidate? Only host-generated evidence (`provenance: 'trusted_verified'`) from a runner the host
 * registered, about exactly this commit, tree, test plan, image and policy, for one of the candidate's required gates. Agent-reported results are
 * kept by the caller as claims but never count.
 * @param {{ trustedRunners: readonly string[] }} opts
 */
export function acceptEvidence(candidate, evidence, { trustedRunners } = {}) {
  const e = evidence;
  if (e === null || typeof e !== 'object' || !isId(e.evidenceId) || !isId(e.gate) || !['passed', 'failed'].includes(e.result) || !isId(e.runnerId)) return refuse('evidence_invalid');
  if (e.provenance === 'agent_reported') return refuse('evidence_agent_reported');
  if (e.provenance !== 'trusted_verified') return refuse('evidence_invalid');
  if (!Array.isArray(trustedRunners) || !trustedRunners.includes(e.runnerId)) return refuse('evidence_untrusted_runner');
  if (e.subjectCommitOid !== candidate.candidateCommitOid) return refuse('evidence_commit_mismatch');
  if (e.subjectTreeOid !== candidate.candidateTreeOid) return refuse('evidence_tree_mismatch');
  if (e.testPlanDigest !== candidate.testPlanDigest) return refuse('evidence_plan_mismatch');
  if (e.imageDigest !== candidate.imageDigest) return refuse('evidence_image_mismatch');
  if (e.policyVersion !== candidate.policyVersion) return refuse('evidence_policy_mismatch');
  if (!candidate.requiredGates.includes(e.gate)) return refuse('evidence_gate_unknown');
  return ok;
}

/** 'failed' when any accepted evidence failed, 'verified' when every required gate has accepted passing evidence, else 'pending'. */
export function verificationStatus(candidate, evidenceList, opts) {
  const accepted = (Array.isArray(evidenceList) ? evidenceList : []).filter((e) => acceptEvidence(candidate, e, opts).ok);
  if (accepted.some((e) => e.result === 'failed')) return 'failed';
  const passed = new Set(accepted.filter((e) => e.result === 'passed').map((e) => e.gate));
  return candidate.requiredGates.every((g) => passed.has(g)) ? 'verified' : 'pending';
}

function checkApproval(candidate, approval, now) {
  const a = approval;
  if (a === null || typeof a !== 'object') return 'approval_missing';
  if (a.decidedBy?.kind !== 'human' || !isId(a.decidedBy?.id)) return 'approval_not_human';   // ORC-01: an AI never approves its own promotion
  if (a.decision !== 'approve') return 'approval_denied';
  if (a.candidateId !== candidate.candidateId) return 'approval_mismatch';
  if (a.candidateVersion !== candidate.version) return 'approval_stale';
  for (const f of ['candidateCommitOid', 'targetRef', 'targetTipOid', 'policyVersion']) if (a[f] !== candidate[f]) return 'approval_mismatch';
  if (!Number.isSafeInteger(a.expiresAt) || !Number.isSafeInteger(now) || now >= a.expiresAt) return 'approval_expired';
  if (candidate.risk !== 'low') {
    const u = a.comprehension;
    const grounded = u && u.reviewerId === a.decidedBy.id && COMPREHENSION_BASES.includes(u.basis) && u.candidateCommitOid === candidate.candidateCommitOid;
    if (!grounded) return 'comprehension_required';
  }
  return null;
}

/**
 * INT-02: may the target ref move to this candidate now? Needs: the candidate is VERIFYING or APPROVED (not stale, not final), the target tip
 * observed right now equals the frozen one, every required gate verified on this exact commit, and a person's approval bound to this candidate's
 * id, version, commit, ref, tip and policy, unexpired at `now` (host clock, injected). Medium and high risk also need that person's comprehension
 * record grounded in an explanation or a demonstration of this commit (CMPH-01), not an AI summary.
 * @param {{ currentTipOid: string, evidence: object[], trustedRunners: readonly string[], approval: object, now: number }} request
 */
export function authorizePromotion(candidate, request = {}) {
  const r = request ?? {};
  if (!isOid(r.currentTipOid)) return refuse('request_invalid');
  if (candidate.state !== 'VERIFYING' && candidate.state !== 'APPROVED') return refuse('candidate_not_promotable');
  if (r.currentTipOid !== candidate.targetTipOid) return refuse('target_moved');
  if (verificationStatus(candidate, r.evidence, { trustedRunners: r.trustedRunners }) !== 'verified') return refuse('not_verified');
  const problem = checkApproval(candidate, r.approval, r.now);
  if (problem) return refuse(problem);
  return Object.freeze({ ok: true, update: Object.freeze({ ref: candidate.targetRef, expectedOldOid: candidate.targetTipOid, newOid: candidate.candidateCommitOid }) });
}

/** APPROVED after authorizePromotion said yes for this version (the caller then calls beginPromotion right before the adapter runs). */
export function markApproved(candidate) {
  if (candidate.state !== 'VERIFYING' && candidate.state !== 'APPROVED') throw new TypeError('candidate_not_promotable');
  return next(candidate, 'APPROVED');
}

/** PROMOTING: recorded BEFORE the adapter touches the remote (intent before effect). */
export function beginPromotion(candidate) {
  if (candidate.state !== 'APPROVED') throw new TypeError('candidate_not_approved');
  return next(candidate, 'PROMOTING');
}

/** The adapter's outcome: 'updated' (the CAS succeeded), 'rejected' (the remote refused the CAS: the tip moved) or 'unknown' (sent, no answer). */
export function recordPromotion(candidate, outcome) {
  if (candidate.state !== 'PROMOTING') throw new TypeError('candidate_not_promoting');
  if (outcome === 'updated') return next(candidate, 'MERGED');
  if (outcome === 'rejected') return next(candidate, 'STALE');
  if (outcome === 'unknown') return next(candidate, 'UNKNOWN_PROMOTION');
  return next(candidate, 'BLOCKED');
}

/**
 * The only exit from UNKNOWN_PROMOTION: the remote tip as read back. Equal to the candidate commit -> MERGED (the push did land); equal to the old
 * tip -> APPROVED again (it did not; a retry needs a fresh authorizePromotion against the new version); anything else -> STALE (someone moved it).
 */
export function reconcilePromotion(candidate, remoteTipOid) {
  if (candidate.state !== 'UNKNOWN_PROMOTION') throw new TypeError('candidate_not_unknown');
  if (!isOid(remoteTipOid)) throw new TypeError('invalid_target_tip');
  if (remoteTipOid === candidate.candidateCommitOid) return next(candidate, 'MERGED');
  if (remoteTipOid === candidate.targetTipOid) return next(candidate, 'APPROVED');
  return next(candidate, 'STALE');
}
