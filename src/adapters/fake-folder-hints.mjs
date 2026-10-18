// @ts-check
// adapter (Fake): folder-hints-fs.mjs と同じ形 ({hintFor}) を、合成の表から返す。
// テストと `npm run demo` で使う。表のキーはパス (末尾の区切りは無視)。worktree の切り落としは fs 版と同じ関数。

import { cutWorktreeTail } from './session-record.mjs';

/** @typedef {import('../shared/types.mjs').FolderHint} FolderHint */

const keyOf = (/** @type {string} */ p) => p.trim().replace(/[\\/]+$/, '');

/**
 * @param {Record<string, FolderHint>|Map<string, FolderHint>} [table]
 */
export function createFakeFolderHints(table = {}) {
  const entries = table instanceof Map ? [...table] : Object.entries(table);
  /** @type {Map<string, FolderHint>} */
  const map = new Map(entries.map(([k, v]) => [keyOf(k), v]));
  return {
    /** @param {string} raw @returns {Promise<FolderHint|undefined>} */
    async hintFor(raw) {
      if (typeof raw !== 'string') return undefined;
      const hit = map.get(keyOf(cutWorktreeTail(raw.trim())));
      return hit ? { ...hit } : undefined;
    },
    size() {
      return map.size;
    },
  };
}
