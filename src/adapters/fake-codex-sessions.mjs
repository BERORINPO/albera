// @ts-check
// adapter: Codex の合成レコード用 Fake。実ファイルには触れない。

/** @param {{sessions?: any[]}} [opts] */
export function createFakeCodexSessionsSource({ sessions = [] } = {}) {
  return {
    async load() {
      return { sessions: sessions.map((session) => ({ ...session })), archivedIds: new Set(), stats: { files: sessions.length, parsed: sessions.length, bad: 0, stale: 0, dirs: 0 } };
    },
  };
}
