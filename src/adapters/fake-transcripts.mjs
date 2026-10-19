// @ts-check
// adapter (Fake): transcripts-fs.mjs と同じ形を、メモリ上の合成データから返す。
// subLive (いま書かれている subagent の数) が無い合成データは 0 にそろえる (fs 版は必ず数を返すため)。

/** @typedef {import('../shared/types.mjs').TranscriptInput} TranscriptInput */
/** @typedef {Omit<TranscriptInput, 'subLive'> & {subLive?: number}} FakeTranscript */

/**
 * @param {Map<string, FakeTranscript>|Record<string, FakeTranscript>} entries cliSessionId がキー
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
        if (e) out.set(id, { ...e, subLive: e.subLive ?? 0 });
      }
      return out;
    },
    stats() {
      return { dirMissing, indexed: map.size };
    },
  };
}
