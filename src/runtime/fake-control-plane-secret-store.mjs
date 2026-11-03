import { SecretStoreError, assertSecretName, sha256Prefix, toSecretBuffer } from './control-plane-secret-store.mjs';

// Test double of control-plane-secret-store.mjs: the same five calls (save, load, erase, status, verify), the same frozen names, the same validation, the same fixed error codes and the same
// result shapes, with the values kept in memory. Nothing touches DPAPI, a file or a process, so it proves the behaviour of the callers (the room's credential route, the Claude Code launch),
// not that a value is protected. As in the real store, status() reads only what save() recorded (the hash prefix and the date) and verify() is the call that checks the value.
// `now` is the clock for `savedAt`. `markUnreadable(name)` plays a blob this account cannot open (damaged, or from another account or a reinstall): verify says `readable: false` and
// load rejects with `unprotect_failed`, as the real store does; status still shows what was saved.

const NO_META = Object.freeze({ sha256Prefix: null, savedAt: null });

/** @param {{ now?: () => Date }} [options] */
export function createFakeControlPlaneSecretStore({ now = () => new Date() } = {}) {
  /** @type {Map<string, { value: Buffer, meta: { sha256Prefix: string, savedAt: string }, readable: boolean }>} */
  const entries = new Map();
  const entryOf = (name) => entries.get(assertSecretName(name));

  return Object.freeze({
    async save(name, value) {
      assertSecretName(name);
      const plaintext = toSecretBuffer(value);
      try {
        const meta = Object.freeze({ sha256Prefix: sha256Prefix(plaintext), savedAt: now().toISOString() });
        entries.get(name)?.value.fill(0);
        entries.set(name, { value: Buffer.from(plaintext), meta, readable: true });
        return Object.freeze({ present: true, ...meta });
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
      return entry === undefined ? Object.freeze({ present: false, ...NO_META }) : Object.freeze({ present: true, ...entry.meta });
    },

    async verify(name) {
      const entry = entryOf(name);
      if (entry === undefined) return Object.freeze({ present: false, readable: false, ...NO_META });
      return Object.freeze({ present: true, readable: entry.readable, sha256Prefix: entry.readable ? sha256Prefix(entry.value) : null, savedAt: entry.meta.savedAt });
    },

    /** Test seam, not part of the store interface. */
    markUnreadable(name) {
      const entry = entryOf(name);
      if (entry === undefined) throw new SecretStoreError('not_found');
      entry.readable = false;
    },
  });
}
