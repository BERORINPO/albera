// @ts-check
// 画面: Codex の件数診断を安全な集計値だけで説明する (パス・ID・イベント内容は受け取らない)。

/** @typedef {import('./i18n.mjs').T} T */

const FIELDS = /** @type {const} */ ([
  'files', 'detected', 'working', 'trouble', 'recent', 'active', 'completed', 'interrupted', 'failed', 'unknown', 'rejected',
]);

/** @param {unknown} value */
const count = (value) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;

/** @param {T} t @param {Record<string, unknown>} input @returns {string[]} */
export function codexStatusMessages(t, input) {
  /** @type {Record<(typeof FIELDS)[number], number>} */
  const stats = /** @type {Record<(typeof FIELDS)[number], number>} */ (
    Object.fromEntries(FIELDS.map((key) => [key, count(input[key])]))
  );
  const messages = [t('foot.codexSummary', stats)];
  if (stats.files === 0) messages.push(t('foot.codexNoFiles'));
  else if (stats.detected === 0) messages.push(t('foot.codexNoDetected'));
  else if (stats.working === 0) messages.push(t('foot.codexNoWorking'));
  return messages;
}

/** @param {T} t @param {Record<string, unknown>} input @returns {string[]} */
export function openCodeStatusMessages(t, input) {
  const stats = /** @type {Record<(typeof FIELDS)[number], number>} */ (
    Object.fromEntries(FIELDS.map((key) => [key, count(input[key])]))
  );
  const messages = [t('foot.opencodeSummary', stats)];
  if (input.unsupportedRuntime === true) messages.push(t('foot.opencodeRuntime'));
  else if (input.legacySchema === true) messages.push(t('foot.opencodeLegacy'));
  else if (stats.files === 0) messages.push(t('foot.opencodeNoFiles'));
  else if (stats.detected === 0) messages.push(t('foot.opencodeNoDetected'));
  else if (stats.working === 0) messages.push(t('foot.opencodeNoWorking'));
  return messages;
}

/** @param {T} t @param {Record<string, unknown>} input @returns {string[]} */
export function copilotStatusMessages(t, input) {
  /** @type {Record<(typeof FIELDS)[number], number>} */
  const stats = /** @type {Record<(typeof FIELDS)[number], number>} */ (
    Object.fromEntries(FIELDS.map((key) => [key, count(input[key])]))
  );
  const messages = [t('foot.copilotSummary', stats)];
  if (stats.files === 0) messages.push(t('foot.copilotNoFiles'));
  else if (stats.detected === 0) messages.push(t('foot.copilotNoDetected'));
  else if (stats.working === 0) messages.push(t('foot.copilotNoWorking'));
  return messages;
}
