// @ts-check
// adapter (Fake): path-keyed synthetic summaries for tests and demo only.

const keyOf = (value) => value.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();

/** @param {Record<string,import('../shared/types.mjs').GitWorktreeSummary>|Map<string,import('../shared/types.mjs').GitWorktreeSummary>} [table] */
export function createFakeWorktreeSource(table = {}) {
  const entries = table instanceof Map ? [...table] : Object.entries(table);
  const map = new Map(entries.map(([cwd, summary]) => [keyOf(cwd), summary]));
  let current = { scanned: 0, matched: 0, unavailable: 0, skipped: 0 };
  return {
    /** @param {import('../shared/types.mjs').SessionRecord[]} sessions */
    async enrich(sessions) {
      const active = sessions.filter((s) => !s.isArchived && s.cwd);
      const out = sessions.map((session) => {
        const summary = session.cwd ? map.get(keyOf(session.cwd)) : undefined;
        return summary ? { ...session, gitWorktree: { ...summary } } : session;
      });
      const matched = active.filter((s) => s.cwd && map.has(keyOf(s.cwd))).length;
      current = { scanned: active.length, matched, unavailable: active.length - matched, skipped: 0 };
      return out;
    },
    async listForCwd(cwd) {
      const summary = map.get(keyOf(cwd));
      return summary ? [
        {
          branch: summary.branch, status: summary.status, changed: summary.changed, untracked: summary.untracked,
          conflicted: summary.conflicted, locked: summary.locked, prunable: summary.prunable,
          detached: summary.branch === null, current: true,
        },
        { branch: 'demo/clean-side', status: 'clean', changed: 0, untracked: 0, conflicted: 0, locked: false, prunable: false, detached: false, current: false },
      ] : [];
    },
    stats: () => ({ ...current }),
  };
}
