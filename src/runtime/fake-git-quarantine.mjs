// Test double for git-quarantine.mjs: the same four methods, no git, no disk. Each method answers from `responses` (a value, or a function of the
// request), defaulting to success, and records the call. For tests of whatever drives the quarantine (an Integration Service); it proves nothing
// about git itself, which test/runtime-git-quarantine.test.mjs runs for real.

const DEFAULTS = Object.freeze({
  create: () => '/fake/quarantine/q-1',
  importBundle: () => Object.freeze({ ok: true }),
  inspect: () => Object.freeze({ ok: true, changed: 1 }),
  buildCandidate: () => Object.freeze({ ok: true, candidateCommitOid: 'c'.repeat(40), candidateTreeOid: 'd'.repeat(40) }),
});

/** @param {{ [method: string]: unknown }} responses */
export function createFakeGitQuarantine(responses = {}) {
  const calls = [];
  const answer = (method) => async (...args) => {
    calls.push(Object.freeze({ method, args: structuredClone(args) }));
    const r = method in responses ? responses[method] : DEFAULTS[method];
    return typeof r === 'function' ? r(...args) : r;
  };
  return Object.freeze({
    create: answer('create'), importBundle: answer('importBundle'), inspect: answer('inspect'), buildCandidate: answer('buildCandidate'),
    calls: () => calls.slice(),
  });
}
