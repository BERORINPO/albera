// @ts-check
// adapter (Fake): transcripts-fs.mjs と同じ形を、メモリ上の合成データから返す。

/** @typedef {import('../shared/types.mjs').TranscriptInput} TranscriptInput */

/**
 * @param {Map<string, TranscriptInput>|Record<string, TranscriptInput>} entries cliSessionId がキー
 * @param {{dirMissing?: boolean}=} opts
 */
export function createFakeTranscriptsSource(entries, { dirMissing = false } = {}) {
  const map = entries instanceof Map ? entries : new Map(Object.entries(entries));
  return {
    /** @param {string[]} cliSessionIds @returns {Promise<Map<string, TranscriptInput>>} */
    async read(cliSessionIds) {
      /** @type {Map<string, TranscriptInput>} */
      const out = new Map();
      for (const id of cliSessionIds) {
        const e = map.get(id);
        if (e) out.set(id, { ...e });
      }
      return out;
    },
    stats() {
      return { dirMissing, indexed: map.size };
    },
  };
}
