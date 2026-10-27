// @ts-check
// UI: report product capabilities that are explicitly out of service until their policy is defined.

/** @typedef {import('./i18n.mjs').T} T */

const UNAVAILABLE = /** @type {const} */ ([
  'foot.claudeExecutionUnavailable',
  'foot.enterpriseAuthUnavailable',
]);

/** @param {T} t @returns {string[]} */
export function productLimitMessages(t) {
  return UNAVAILABLE.map((key) => t(key));
}
