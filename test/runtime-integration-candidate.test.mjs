import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  acceptEvidence, authorizePromotion, beginPromotion, freezeCandidate, markApproved, observeTarget, reconcilePromotion, recordPromotion,
  startVerification, verificationStatus,
} from '../src/runtime/integration-candidate.mjs';

// INT-01 (candidate bound to the exact commit + verification) and INT-02 (no protected branch promotion without approval), on the pure contract.
// No git and no verifier run here: these are the decisions the Integration Service must take (ADR-007 §3-§5, §8).
const oid = (c) => c.repeat(40);
const digest = (c) => `sha256:${c.repeat(64)}`;
const RUNNERS = Object.freeze(['trusted-verifier-01']);
const NOW = 1_800_000_000;

const base = (over = {}) => ({
  candidateId: 'cand_7', projectId: 'proj_001', repositoryId: 'repo_001', targetRef: 'refs/heads/main', targetTipOid: oid('a'),
  candidateCommitOid: oid('c'), candidateTreeOid: oid('d'), testPlanDigest: digest('1'), imageDigest: digest('2'), policyVersion: 3, algorithmVersion: 1,
  risk: 'low', requiredGates: ['unit', 'integration'],
  submissions: [{ submissionId: 'sub_101', baseCommitOid: oid('a'), resultCommitOid: oid('b') }], ...over,
});
const evidence = (gate, over = {}) => ({
  evidenceId: `ev_${gate}`, gate, result: 'passed', provenance: 'trusted_verified', runnerId: 'trusted-verifier-01',
  subjectCommitOid: oid('c'), subjectTreeOid: oid('d'), testPlanDigest: digest('1'), imageDigest: digest('2'), policyVersion: 3, ...over,
});
const passing = () => [evidence('unit'), evidence('integration')];
const approvalFor = (cand, over = {}) => ({
  decidedBy: { kind: 'human', id: 'yosuke' }, decision: 'approve', candidateId: cand.candidateId, candidateVersion: cand.version,
  candidateCommitOid: cand.candidateCommitOid, targetRef: cand.targetRef, targetTipOid: cand.targetTipOid, policyVersion: cand.policyVersion,
  expiresAt: NOW + 300, ...over,
});
const verifying = (over) => startVerification(freezeCandidate(base(over)));
const request = (cand, over = {}) => ({ currentTipOid: cand.targetTipOid, evidence: passing(), trustedRunners: RUNNERS, approval: approvalFor(cand), now: NOW, ...over });

describe('freezeCandidate', () => {
  it('freezes the exact inputs, deeply, at version 1', () => {
    const c = freezeCandidate(base());
    assert.equal(c.state, 'PREPARED');
    assert.equal(c.version, 1);
    assert.ok(Object.isFrozen(c) && Object.isFrozen(c.submissions) && Object.isFrozen(c.submissions[0]) && Object.isFrozen(c.requiredGates));
  });
  it('copies the input, so a later change to it does not reach the candidate', () => {
    const input = base();
    const c = freezeCandidate(input);
    input.requiredGates.push('extra');
    input.submissions[0].resultCommitOid = oid('e');
    assert.deepEqual(c.requiredGates, ['unit', 'integration']);
    assert.equal(c.submissions[0].resultCommitOid, oid('b'));
  });
  for (const [field, value] of [
    ['targetTipOid', 'abc'], ['candidateCommitOid', oid('A')], ['candidateTreeOid', `${oid('d')}0`], ['testPlanDigest', 'sha256:xyz'], ['imageDigest', digest('2').toUpperCase()],
    ['policyVersion', 0], ['algorithmVersion', 1.5], ['risk', 'none'], ['requiredGates', []], ['requiredGates', ['unit', 'unit']], ['submissions', []],
    ['targetRef', 'main'], ['targetRef', 'refs/heads/a..b'], ['targetRef', 'refs/heads/x.lock'], ['targetRef', 'refs/tags/v1'], ['candidateId', '../x'],
  ]) {
    it(`refuses ${field} = ${JSON.stringify(value)}`, () => assert.throws(() => freezeCandidate(base({ [field]: value })), new RegExp(`invalid_candidate_${field}`, 'u')));
  }
  it('refuses duplicate submissions and a candidate that is the target tip itself', () => {
    const s = { submissionId: 'sub_1', baseCommitOid: oid('a'), resultCommitOid: oid('b') };
    assert.throws(() => freezeCandidate(base({ submissions: [s, s] })), /invalid_candidate_submissions/u);
    assert.throws(() => freezeCandidate(base({ candidateCommitOid: oid('a') })), /invalid_candidate_candidateCommitOid/u);
  });
  it('accepts SHA-256 object ids (64 hex)', () => {
    const c = freezeCandidate(base({ targetTipOid: 'a'.repeat(64), candidateCommitOid: 'c'.repeat(64), candidateTreeOid: 'd'.repeat(64) }));
    assert.equal(c.candidateCommitOid.length, 64);
  });
});

describe('INT-01: evidence counts only for the exact candidate', () => {
  const cand = verifying();
  it('host evidence about this commit, tree, plan, image and policy from a registered runner counts', () => {
    assert.deepEqual(acceptEvidence(cand, evidence('unit'), { trustedRunners: RUNNERS }), { ok: true });
    assert.equal(verificationStatus(cand, passing(), { trustedRunners: RUNNERS }), 'verified');
  });
  for (const [label, over, code] of [
    ['an agent-reported pass (the guest says tests passed)', { provenance: 'agent_reported' }, 'evidence_agent_reported'],
    ['an unknown provenance', { provenance: 'self' }, 'evidence_invalid'],
    ['a runner the host did not register', { runnerId: 'agent-vm-3' }, 'evidence_untrusted_runner'],
    ['evidence about a commit that changed during verification', { subjectCommitOid: oid('e') }, 'evidence_commit_mismatch'],
    ['the same commit id with another tree', { subjectTreeOid: oid('f') }, 'evidence_tree_mismatch'],
    ['another test plan', { testPlanDigest: digest('9') }, 'evidence_plan_mismatch'],
    ['another verification image', { imageDigest: digest('8') }, 'evidence_image_mismatch'],
    ['another policy version', { policyVersion: 2 }, 'evidence_policy_mismatch'],
    ['a gate the plan does not require', { gate: 'lint' }, 'evidence_gate_unknown'],
    ['a malformed result', { result: 'ok' }, 'evidence_invalid'],
  ]) {
    it(`refuses ${label} (${code})`, () => assert.deepEqual(acceptEvidence(cand, evidence('unit', over), { trustedRunners: RUNNERS }), { ok: false, code }));
  }
  it('without the registered runner list nothing counts', () => {
    assert.equal(acceptEvidence(cand, evidence('unit'), {}).code, 'evidence_untrusted_runner');
    assert.equal(verificationStatus(cand, passing(), {}), 'pending');
  });
  it('a refused pass never fills a gate: verification stays pending', () => {
    const list = [evidence('unit'), evidence('integration', { provenance: 'agent_reported' })];
    assert.equal(verificationStatus(cand, list, { trustedRunners: RUNNERS }), 'pending');
  });
  it('one accepted failure makes the candidate failed, even next to passes', () => {
    const list = [...passing(), evidence('integration', { evidenceId: 'ev_retry', result: 'failed' })];
    assert.equal(verificationStatus(cand, list, { trustedRunners: RUNNERS }), 'failed');
  });
  it('a failure that does not count (another commit) does not fail this candidate', () => {
    const list = [...passing(), evidence('unit', { evidenceId: 'ev_old', result: 'failed', subjectCommitOid: oid('e') })];
    assert.equal(verificationStatus(cand, list, { trustedRunners: RUNNERS }), 'verified');
  });
});

describe('INT-01: the target branch moving makes the candidate stale', () => {
  it('another tip during verification -> STALE with a new version; the same tip changes nothing', () => {
    const cand = verifying();
    assert.equal(observeTarget(cand, oid('a')), cand);
    const stale = observeTarget(cand, oid('9'));
    assert.equal(stale.state, 'STALE');
    assert.equal(stale.version, cand.version + 1);
    assert.equal(observeTarget(stale, oid('a')), stale, 'STALE is final');
  });
  it('a stale candidate cannot be promoted even with passing evidence and an approval for its version', () => {
    const stale = observeTarget(verifying(), oid('9'));
    assert.equal(authorizePromotion(stale, request(stale)).code, 'candidate_not_promotable');
  });
});

describe('INT-02: promotion needs a verified candidate and a person approving exactly it', () => {
  it('everything bound -> a compare-and-swap of the target ref, never anything else', () => {
    const cand = verifying();
    const r = authorizePromotion(cand, request(cand));
    assert.deepEqual(r, { ok: true, update: { ref: 'refs/heads/main', expectedOldOid: oid('a'), newOid: oid('c') } });
    assert.deepEqual(Object.keys(r.update).sort(), ['expectedOldOid', 'newOid', 'ref'], 'no force flag exists');
  });
  for (const [label, over, code] of [
    ['no approval', { approval: undefined }, 'approval_missing'],
    ['an approval decided by the AI', { approval: (c) => approvalFor(c, { decidedBy: { kind: 'ai', id: 'bero' } }) }, 'approval_not_human'],
    ['a denial', { approval: (c) => approvalFor(c, { decision: 'deny' }) }, 'approval_denied'],
    ['an approval for another candidate', { approval: (c) => approvalFor(c, { candidateId: 'cand_8' }) }, 'approval_mismatch'],
    ['an approval for an older version (two approvals racing)', { approval: (c) => approvalFor(c, { candidateVersion: c.version - 1 }) }, 'approval_stale'],
    ['an approval for another commit', { approval: (c) => approvalFor(c, { candidateCommitOid: oid('e') }) }, 'approval_mismatch'],
    ['an approval for another branch', { approval: (c) => approvalFor(c, { targetRef: 'refs/heads/release' }) }, 'approval_mismatch'],
    ['an approval for another target tip', { approval: (c) => approvalFor(c, { targetTipOid: oid('9') }) }, 'approval_mismatch'],
    ['an approval under another policy', { approval: (c) => approvalFor(c, { policyVersion: 4 }) }, 'approval_mismatch'],
    ['an expired approval', { approval: (c) => approvalFor(c, { expiresAt: NOW }) }, 'approval_expired'],
    ['the target moved since the candidate was frozen', { currentTipOid: oid('9') }, 'target_moved'],
    ['missing verification', { evidence: [evidence('unit')] }, 'not_verified'],
    ['agent-reported verification only', { evidence: passing().map((e) => ({ ...e, provenance: 'agent_reported' })) }, 'not_verified'],
    ['a malformed current tip', { currentTipOid: 'HEAD' }, 'request_invalid'],
  ]) {
    it(`refuses ${label} (${code})`, () => {
      const cand = verifying();
      const r = request(cand, over);
      if (typeof over.approval === 'function') r.approval = over.approval(cand);
      assert.deepEqual(authorizePromotion(cand, r), { ok: false, code });
    });
  }
  it('a candidate that was never verified (still PREPARED) is not promotable', () => {
    const cand = freezeCandidate(base());
    assert.equal(authorizePromotion(cand, request(cand)).code, 'candidate_not_promotable');
  });
  it('medium and high risk need the approver\'s own comprehension of this commit, not an AI summary (CMPH-01)', () => {
    for (const risk of ['medium', 'high']) {
      const cand = verifying({ risk });
      assert.equal(authorizePromotion(cand, request(cand)).code, 'comprehension_required');
      const summary = approvalFor(cand, { comprehension: { reviewerId: 'yosuke', basis: 'ai_summary', candidateCommitOid: oid('c') } });
      assert.equal(authorizePromotion(cand, request(cand, { approval: summary })).code, 'comprehension_required');
      const someoneElse = approvalFor(cand, { comprehension: { reviewerId: 'other', basis: 'explanation', candidateCommitOid: oid('c') } });
      assert.equal(authorizePromotion(cand, request(cand, { approval: someoneElse })).code, 'comprehension_required');
      const oldCommit = approvalFor(cand, { comprehension: { reviewerId: 'yosuke', basis: 'demonstration', candidateCommitOid: oid('e') } });
      assert.equal(authorizePromotion(cand, request(cand, { approval: oldCommit })).code, 'comprehension_required');
      const grounded = approvalFor(cand, { comprehension: { reviewerId: 'yosuke', basis: 'explanation', candidateCommitOid: oid('c') } });
      assert.equal(authorizePromotion(cand, request(cand, { approval: grounded })).ok, true);
    }
  });
});

describe('promotion: intent before effect, and an ambiguous push is reconciled, never re-pushed blindly', () => {
  const promoting = () => {
    const cand = verifying();
    assert.equal(authorizePromotion(cand, request(cand)).ok, true);
    return beginPromotion(markApproved(cand));
  };
  it('the CAS landed -> MERGED; the remote refused the CAS -> STALE; anything unexpected -> BLOCKED', () => {
    assert.equal(recordPromotion(promoting(), 'updated').state, 'MERGED');
    assert.equal(recordPromotion(promoting(), 'rejected').state, 'STALE');
    assert.equal(recordPromotion(promoting(), 'weird').state, 'BLOCKED');
  });
  it('unknown -> UNKNOWN_PROMOTION, then the read-back tip decides', () => {
    const unknown = recordPromotion(promoting(), 'unknown');
    assert.equal(unknown.state, 'UNKNOWN_PROMOTION');
    assert.equal(observeTarget(unknown, oid('9')), unknown, 'observing does not resolve an unknown promotion');
    assert.equal(reconcilePromotion(unknown, oid('c')).state, 'MERGED');
    assert.equal(reconcilePromotion(unknown, oid('9')).state, 'STALE');
    const back = reconcilePromotion(unknown, oid('a'));
    assert.equal(back.state, 'APPROVED');
    assert.equal(authorizePromotion(back, request(back, { approval: approvalFor(unknown) })).code, 'approval_stale', 'the earlier approval does not cover the retry');
    assert.equal(authorizePromotion(back, request(back)).ok, true, 'a fresh approval for the new version does');
  });
  it('the steps only happen in order', () => {
    const cand = verifying();
    assert.throws(() => beginPromotion(cand), /candidate_not_approved/u);
    assert.throws(() => recordPromotion(cand, 'updated'), /candidate_not_promoting/u);
    assert.throws(() => reconcilePromotion(cand, oid('c')), /candidate_not_unknown/u);
    assert.throws(() => startVerification(cand), /candidate_not_prepared/u);
    assert.throws(() => markApproved(freezeCandidate(base())), /candidate_not_promotable/u);
  });
  it('every change is a new frozen record; the old one is untouched', () => {
    const cand = verifying();
    const approved = markApproved(cand);
    assert.equal(cand.state, 'VERIFYING');
    assert.equal(approved.version, cand.version + 1);
    assert.ok(Object.isFrozen(approved));
  });
});
