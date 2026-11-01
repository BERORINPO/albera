// Test double for git-promotion.mjs: the same two methods, no git, no disk. Each method answers from `responses` (a value, or a function of the
// request), defaulting to success, and records the call. For tests of whatever drives promotion (an Integration Service); it proves nothing about
// git itself, which test/runtime-git-promotion.test.mjs runs for real.

const DEFAULTS = Object.freeze({
  readTip: () => Object.freeze({ ok: true, oid: 'a'.repeat(40) }),
  push: () => Object.freeze({ outcome: 'updated', code: 'fast_forward' }),
});

/** @param {{ [method: string]: unknown }} responses */
export function createFakeGitPromotion(responses = {}) {
  const calls = [];
  const answer = (method) => async (...args) => {
    calls.push(Object.freeze({ method, args: structuredClone(args) }));
    const r = method in responses ? responses[method] : DEFAULTS[method];
    return typeof r === 'function' ? r(...args) : r;
  };
  return Object.freeze({ readTip: answer('readTip'), push: answer('push'), calls: () => calls.slice() });
}
