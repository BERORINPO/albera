// Test double for git-promotion.mjs: the same three methods, no git, no disk. Each method answers from `responses` (a value, or a function of the
// request), defaulting to success, and records the call. For tests of whatever drives promotion (an Integration Service); it proves nothing about
// git itself, which test/runtime-git-promotion.test.mjs runs for real.

const DEFAULTS = Object.freeze({
  readTip: () => Object.freeze({ ok: true, oid: 'a'.repeat(40) }),
  push: () => Object.freeze({ outcome: 'updated', code: 'fast_forward' }),
});

/** @param {{ [method: string]: unknown }} responses */
export function createFakeGitPromotion(responses = {}) {
  const calls = [];
  const respond = (method, args) => {
    const r = method in responses ? responses[method] : DEFAULTS[method];
    return typeof r === 'function' ? r(...args) : r;
  };
  const answer = (method) => async (...args) => {
    calls.push(Object.freeze({ method, args: structuredClone(args) }));
    return respond(method, args);
  };
  // Unless told otherwise, a fetch of the tip brings what readTip names: the same answer, a missing ref being `target_missing` (as the real adapter says).
  const fetchTip = async (repo, request) => {
    calls.push(Object.freeze({ method: 'fetchTip', args: structuredClone([repo, request]) }));
    if ('fetchTip' in responses) return typeof responses.fetchTip === 'function' ? responses.fetchTip(repo, request) : responses.fetchTip;
    const tip = await respond('readTip', [request]);
    return tip?.ok === true && tip.oid === null ? Object.freeze({ ok: false, code: 'target_missing' }) : tip;
  };
  return Object.freeze({ readTip: answer('readTip'), fetchTip, push: answer('push'), calls: () => calls.slice() });
}
