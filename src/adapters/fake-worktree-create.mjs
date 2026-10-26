// Synthetic demo never writes to the filesystem.
export function createFakeWorktreeCreator() {
  return { async create() { return { ok: false, reason: 'demo_disabled' }; } };
}
