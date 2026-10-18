// @ts-check
// adapter (Fake): app-sessions-fs.mjs と同じ形を、メモリ上の合成データから返す。
// テストと `npm run demo` で使う。実際のセッションの中身は入れない。

import { toSessionRecord } from './session-record.mjs';

/** @typedef {import('../shared/types.mjs').SessionRecord} SessionRecord */

/**
 * @param {{raws?: unknown[], archivedIds?: Iterable<string>, corrupt?: number}} opts
 *   raws: アプリの JSON と同じ形の合成オブジェクト / corrupt: 壊れたファイルの件数 (bad に数える)
 */
export function createFakeAppSessionsSource({ raws = [], archivedIds = [], corrupt = 0 } = {}) {
  return {
    /** @returns {Promise<{sessions: SessionRecord[], archivedIds: Set<string>, stats: {files: number, parsed: number, bad: number, stale: number, dirs: number}}>} */
    async load() {
      const records = raws.map((r) => toSessionRecord(JSON.parse(JSON.stringify(r))));
      const sessions = /** @type {SessionRecord[]} */ (records.filter(Boolean));
      const bad = records.length - sessions.length + corrupt;
      return {
        sessions,
        archivedIds: new Set(archivedIds),
        stats: { files: raws.length + corrupt, parsed: sessions.length, bad, stale: 0, dirs: 1 },
      };
    },
  };
}
