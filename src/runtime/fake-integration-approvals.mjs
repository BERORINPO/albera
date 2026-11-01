// Test double for the approvals port of integration-service.mjs: `request({ requestId, subject })` and `status({ requestId })`. No person, no UI, no signature: a
// "human" decision here is a plain object, which is exactly why the service never trusts it without authorizePromotion. Answers come from `responses` (a value, a
// function of (request, subject), or for `status` an array of those consumed one per call, the last one repeating); each call is recorded.
// Defaults: request -> { ok: true }; status -> { ok: false, code: 'unknown_request' } until the request was made, then decided with a human approval of exactly
// the candidate in the subject. Idempotent per requestId, like the real port. Synthetic: nobody approved anything.

const FAR_FUTURE = 4_102_444_800;   // 2100-01-01 in Unix seconds, so the default approval never expires inside a test

/** A person's approval of exactly the candidate in `subject` (override any field). */
export function fakeHumanApproval(subject, over = {}) {
  const c = subject.candidate;
  return {
    decidedBy: { kind: 'human', id: 'yosuke' }, decision: 'approve', candidateId: c.candidateId, candidateVersion: c.version, candidateCommitOid: c.candidateCommitOid,
    targetRef: c.targetRef, targetTipOid: c.targetTipOid, policyVersion: c.policyVersion, expiresAt: FAR_FUTURE, ...over,
  };
}

/** @param {{ request?: unknown, status?: unknown }} responses */
export function createFakeIntegrationApprovals(responses = {}) {
  const calls = [];
  const subjects = new Map();
  const queued = Array.isArray(responses.status) ? responses.status.slice() : null;
  const answer = (response, request, subject) => (typeof response === 'function' ? response(request, subject) : response);
  return Object.freeze({
    async request(request) {
      calls.push(Object.freeze({ method: 'request', args: structuredClone([request]) }));
      const reply = 'request' in responses ? answer(responses.request, request, request.subject) : Object.freeze({ ok: true });
      if (reply?.ok === true && !subjects.has(request.requestId)) subjects.set(request.requestId, structuredClone(request.subject));
      return reply;
    },
    async status(request) {
      calls.push(Object.freeze({ method: 'status', args: structuredClone([request]) }));
      const subject = subjects.get(request.requestId);
      if (!subject) return Object.freeze({ ok: false, code: 'unknown_request' });
      if (queued) return answer(queued.length > 1 ? queued.shift() : queued[0], request, subject);
      if ('status' in responses) return answer(responses.status, request, subject);
      return Object.freeze({ ok: true, state: 'decided', approval: fakeHumanApproval(subject) });
    },
    calls: () => calls.slice(),
  });
}
