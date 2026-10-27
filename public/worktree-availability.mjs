// Pure decision for worktree controls shown in session details.

/** @param {string|undefined} executionLocation @param {boolean} demo */
export function worktreeCreationAvailability(executionLocation, demo) {
  if (demo) return { enabled: false, notice: 'demo' };
  return executionLocation === 'wsl'
    ? { enabled: true, notice: 'wsl' }
    : { enabled: true, notice: null };
}
