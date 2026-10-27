// @ts-check
// adapter (Fake): safe synthetic GitHub Copilot records for tests/demo.

/** @param {{sessions?:any[]}} [options] */
export function createFakeCopilotSessionsSource({ sessions = [] } = {}) {
  return {
    async load() {
      return { sessions: sessions.map((session) => ({ ...session, events: session.events?.map((event) => ({ ...event })) ?? [] })), archivedIds: new Set(), stats: { files: sessions.length, parsed: sessions.length, bad: 0, stale: 0, dirs: sessions.length } };
    },
  };
}
