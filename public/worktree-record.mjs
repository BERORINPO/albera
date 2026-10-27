// @ts-check
// A canvas worktree record uses the existing safe project label, never a repository path.

/** @param {(key:string, values?:Record<string,unknown>)=>string} t @param {string|null|undefined} project @param {string} base @param {{status:string,changed:number,untracked:number,conflicted:number}} result */
export function worktreeRecordBody(t, project, base, result) {
  const label = typeof project === 'string' ? project.trim() : '';
  return t('worktree.recordBody', {
    project: label && !/[\\/:]/u.test(label) ? label : t('project.other'),
    base,
    state: t(`worktree.status.${result.status}`),
    changed: result.changed,
    untracked: result.untracked,
    conflicted: result.conflicted,
  });
}
