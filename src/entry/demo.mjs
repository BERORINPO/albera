// @ts-check
// entry: デモ (`--demo`) の adapter の組。合成データ (adapters/demo-data.mjs) を Fake に入れて返す。

import { DEMO_REBUILD_MS } from '../shared/constants.mjs';
import { buildDemo } from '../adapters/demo-data.mjs';
import { createFakeAppSessionsSource } from '../adapters/fake-app-sessions.mjs';
import { createFakeFolderHints } from '../adapters/fake-folder-hints.mjs';
import { createFakeTranscriptsSource } from '../adapters/fake-transcripts.mjs';

/**
 * デモの合成データを DEMO_REBUILD_MS ごとに今の時刻から作り直す Fake の組。
 * 起動時に 1 回だけ作ると、時間が経つにつれ作業中の行が止まったかもへ移り、経過時間もずれていく。ID は毎回同じ。
 * @param {import('../shared/types.mjs').Lang} lang
 * @param {() => number} [clock]
 */
export function liveDemoSources(lang, clock = () => Date.now()) {
  /** @type {{at: number, sessions: ReturnType<typeof createFakeAppSessionsSource>, transcripts: ReturnType<typeof createFakeTranscriptsSource>, hints: ReturnType<typeof createFakeFolderHints>}|null} */
  let built = null;
  const current = () => {
    const now = clock();
    if (!built || now - built.at >= DEMO_REBUILD_MS) {
      const demo = buildDemo(now, lang);
      built = {
        at: now,
        sessions: createFakeAppSessionsSource({ raws: demo.raws, archivedIds: demo.archivedIds }),
        transcripts: createFakeTranscriptsSource(demo.transcripts),
        hints: createFakeFolderHints(demo.folderHints),
      };
    }
    return built;
  };
  return {
    sessionsSource: { load: () => current().sessions.load() },
    transcriptsSource: { read: (/** @type {string[]} */ ids) => current().transcripts.read(ids), stats: () => current().transcripts.stats() },
    folderHints: { hintFor: (/** @type {string} */ p) => current().hints.hintFor(p) },
  };
}
