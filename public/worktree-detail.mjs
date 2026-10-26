// @ts-check
// Pure, localized text for the safe Git summary in a session detail panel.

/** @param {(key:string, values?:Record<string,unknown>)=>string} t @param {any} git */
export function worktreeDetailText(t, git) {
  if (!git) return { status: null, flags: null };
  const status = t(`detail.gitState.${git.status}`, { changed: git.changed, untracked: git.untracked, conflicted: git.conflicted });
  const flags = [git.locked ? t('detail.gitLocked') : '', git.prunable ? t('detail.gitPrunable') : ''].filter(Boolean).join(t('sep.list'));
  return { status, flags: flags || null };
}
