// @ts-check
// REA findings use a user-reviewed short summary; no REA content is fetched.

import { h } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */

/** @param {T} t @param {string} value */
export function artifactReferenceField(t, value) {
  return h('label', { class: 'graph-dialog__field', 'data-artifact-reference': '' },
    h('span', { text: t('graph.referenceUrl') }),
    h('input', { name: 'referenceUrl', type: 'url', maxlength: '500', autocomplete: 'off', placeholder: 'https://…', value }),
    h('span', { class: 'graph-dialog__hint', text: t('graph.referencePrivacy') }));
}

/** @param {T} t */
export function createArtifactSummaryGuidance(t) {
  const reviewedInput = /** @type {HTMLInputElement} */ (h('input', { name: 'reaSummaryReviewed', type: 'checkbox', required: true }));
  const element = h('div', { 'data-artifact-summary-hint': '' },
    h('p', { class: 'graph-dialog__hint', text: t('graph.artifactSummaryManual') }),
    h('label', { class: 'check' }, reviewedInput, h('span', { text: t('graph.artifactSummaryAttest') })),
    h('a', { class: 'graph-dialog__reference-link', href: 'https://github.com/morluto/rea', target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer', text: t('graph.openReaProject') }),
  );
  return { element, reviewedInput };
}

/** @param {string} kind @param {HTMLElement|null} referenceField @param {ReturnType<typeof createArtifactSummaryGuidance>} guidance */
export function syncArtifactSummaryGuidance(kind, referenceField, guidance) {
  const artifact = kind === 'artifact';
  if (referenceField) referenceField.hidden = !artifact;
  guidance.element.hidden = !artifact;
  guidance.reviewedInput.disabled = !artifact;
  guidance.reviewedInput.required = artifact;
  if (!artifact) guidance.reviewedInput.checked = false;
  guidance.reviewedInput.setCustomValidity('');
}
