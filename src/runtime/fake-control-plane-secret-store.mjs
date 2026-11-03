import { SecretStoreError, assertSecretName, sha256Prefix, toSecretBuffer } from './control-plane-secret-store.mjs';

// Test double of control-plane-secret-store.mjs: the same four calls (save, load, erase, status), the same validation, the same fixed error codes and the same result shapes, with the
// values kept in memory. Nothing touches DPAPI, a file or a process, so it proves the behaviour of the callers (the room's credential route, the Claude Code launch), not that a value is
// protected. `now` is the clock for `savedAt`. `markUnreadable(name)` plays a blob this account cannot open (damaged, or from another account or a reinstall): status says
// `readable: false` and load rejects with `unprotect_failed`, as the real store does.

const absent = () => Object.freeze({ present: false, readable: false, sha256Prefix: null, savedAt: null });

/** @param {{ now?: () => Date }} [options] */
export function createFakeControlPlaneSecretStore({ now = () => new Date() } = {}) {
  /** @type {Map<string, { value: Buffer, savedAt: string, readable: boolean }>} */
  const entries = new Map();
  const entryOf = (name) => entries.get(assertSecretName(name));

  return Object.freeze({
    async save(name, value) {
      assertSecretName(name);
      const plaintext = toSecretBuffer(value);
      try {
        const savedAt = now().toISOString();
        entries.get(name)?.value.fill(0);
        entries.set(name, { value: Buffer.from(plaintext), savedAt, readable: true });
        return Object.freeze({ present: true, readable: true, sha256Prefix: sha256Prefix(plaintext), savedAt });
      } finally { plaintext.fill(0); }
    },

    async load(name) {
      const entry = entryOf(name);
      if (entry === undefined) throw new SecretStoreError('not_found');
      if (!entry.readable) throw new SecretStoreError('unprotect_failed');
      return Buffer.from(entry.value);
    },

    async erase(name) {
      const entry = entryOf(name);
      entry?.value.fill(0);
      return entries.delete(name);
    },

    async status(name) {
      const entry = entryOf(name);
      if (entry === undefined) return absent();
      return Object.freeze({ present: true, readable: entry.readable, sha256Prefix: entry.readable ? sha256Prefix(entry.value) : null, savedAt: entry.savedAt });
    },

    /** Test seam, not part of the store interface. */
    markUnreadable(name) {
      const entry = entryOf(name);
      if (entry === undefined) throw new SecretStoreError('not_found');
      entry.readable = false;
    },
  });
}
