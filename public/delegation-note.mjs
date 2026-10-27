// @ts-check
// Localized explanation shown when a recorded delegation cannot be run.

import { h } from './view.mjs';

/** @param {import('./i18n.mjs').T} t @param {string|null} reason */
export function delegationUnavailableNote(t, reason) {
  return reason ? h('small', { class: 'graph-dialog__hint', text: t(reason) }) : null;
}
