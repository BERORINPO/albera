// @ts-check
// Safe labels for session selectors and graph relation summaries.

const SESSION_SOURCES = Object.freeze([
  ['codex_', 'codex'],
  ['copilot_', 'copilot'],
  ['opencode_', 'opencode'],
  ['local_', 'claude'],
]);

/** @param {{id?:unknown}} session @param {(key:string)=>string} t */
export function graphSessionLabel(session, t) {
  const id = typeof session?.id === 'string' ? session.id : '';
  const source = SESSION_SOURCES.find(([prefix]) => id.startsWith(prefix))?.[1];
  const suffix = id.slice(-12).toLowerCase();
  if (!source || !/^[a-f0-9]{12}$/.test(suffix)) return t('graph.unknownSession');
  return `${t('graph.session')}: ${t(`source.${source}`)} (${suffix})`;
}
