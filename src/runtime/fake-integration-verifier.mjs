// Test double for the verifier port of integration-service.mjs: `start({ runId, subject })` and `collect({ runId })`. No VM, no tests are run; it answers from
// `responses` (a value, a function of (request, subject), or for `collect` an array of those consumed one per call, the last one repeating) and records each call.
// Defaults: start -> { ok: true }; collect -> done, with passing evidence from the registered runner for every required gate of the subject it was started with.
// Like the real port it is idempotent per runId: a second start with the same runId changes nothing. Synthetic: a pass here says nothing about a real verifier.

/** Host-generated passing evidence for each required gate of `subject` (override any field per item). */
export function fakeVerifierEvidence(subject, over = {}) {
  return subject.requiredGates.map((gate) => ({
    evidenceId: `ev_${gate}`, gate, result: 'passed', provenance: 'trusted_verified', runnerId: 'trusted-verifier-01', subjectCommitOid: subject.candidateCommitOid,
    subjectTreeOid: subject.candidateTreeOid, testPlanDigest: subject.testPlanDigest, imageDigest: subject.imageDigest, lockfileDigest: subject.lockfileDigest,
    policyVersion: subject.policyVersion, ...over,
  }));
}

/** @param {{ start?: unknown, collect?: unknown }} responses */
export function createFakeIntegrationVerifier(responses = {}) {
  const calls = [];
  const subjects = new Map();
  const queued = Array.isArray(responses.collect) ? responses.collect.slice() : null;
  const answer = (response, request, subject) => (typeof response === 'function' ? response(request, subject) : response);
  return Object.freeze({
    async start(request) {
      calls.push(Object.freeze({ method: 'start', args: structuredClone([request]) }));
      if (!subjects.has(request.runId)) subjects.set(request.runId, structuredClone(request.subject));
      return 'start' in responses ? answer(responses.start, request, request.subject) : Object.freeze({ ok: true });
    },
    async collect(request) {
      calls.push(Object.freeze({ method: 'collect', args: structuredClone([request]) }));
      const subject = subjects.get(request.runId);
      if (queued) return answer(queued.length > 1 ? queued.shift() : queued[0], request, subject);
      if ('collect' in responses) return answer(responses.collect, request, subject);
      return Object.freeze({ state: 'done', evidence: subject ? fakeVerifierEvidence(subject) : [] });
    },
    calls: () => calls.slice(),
  });
}
