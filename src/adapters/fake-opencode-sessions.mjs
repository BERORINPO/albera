// @ts-check
// adapter (Fake): synthetic OpenCode sessions for tests/demo.

/** @param {{sessions?:any[]}} [options] */
export function createFakeOpenCodeSessionsSource({ sessions = [] } = {}) {
  return {
    async load() {
      return {
        sessions: sessions.map((session) => ({ ...session, events: session.events?.map((event) => ({ ...event })) ?? [] })),
        archivedIds: new Set(),
        stats: { files: sessions.length ? 1 : 0, parsed: sessions.length, bad: 0, stale: 0, dirs: sessions.length },
      };
    },
  };
}
