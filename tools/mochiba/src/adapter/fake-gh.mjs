// Stand-in for gh.mjs. `prs` maps a PR number to the JSON gh would print; `missing: true` acts as if gh is not installed.
export function createFakeGh({ prs = {}, missing = false } = {}) {
  const calls = [];
  return {
    calls,
    async prView(dir, number) {
      calls.push([dir, number]);
      if (missing) return { ok: false, reason: 'gh 無し' };
      return Object.hasOwn(prs, number) ? { ok: true, data: prs[number] } : { ok: false, reason: 'gh 失敗' };
    },
  };
}
