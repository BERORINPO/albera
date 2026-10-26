// adapter (Fake): demo mode never performs Git worktree removal.

export function createFakeWorktreeRemover() {
  return { async remove() { return { ok: false, reason: 'demo_disabled' }; } };
}
