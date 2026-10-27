// @ts-check
// Repair actions for explicitly recorded comprehension gaps.

import { reviewUnderstandingGaps } from './graph-model.mjs';
import { h } from './view.mjs';

/** @param {import('./i18n.mjs').T} t @param {any} graph @param {Array<{id:string}>} sessions @param {string} nodeId */
export function comprehensionReviewElements(t, graph, sessions, nodeId) {
  const review = reviewUnderstandingGaps(graph, new Set(sessions.map((session) => session.id))).find((item) => item.id === nodeId);
  if (!review) return [];
  const incompleteKinds = new Set(review.incomplete.map((item) => item.kind));
  const unlinked = review.missing.filter((kind) => !incompleteKinds.has(kind));
  const elements = [];
  if (unlinked.length) elements.push(
    h('p', { class: 'graph-dialog__review', text: t('graph.reviewHint', { links: unlinked.map((kind) => t(`graph.link.${kind}`)).join(', ') }) }),
    h('div', { class: 'graph-dialog__review-actions' }, ...unlinked.map((kind) => h('button', {
      class: 'textbtn', type: 'button', 'data-dialog-action': 'connect-missing', 'data-edge-kind': kind,
      text: t(`graph.resolveMissing.${kind}`),
    }))),
  );
  if (review.incomplete.length) elements.push(
    h('p', { class: 'graph-dialog__review', text: t('graph.reviewPurposeHint', { links: [...new Set(review.incomplete.map((item) => t(`graph.link.${item.kind}`)))].join(', ') }) }),
    h('div', { class: 'graph-dialog__review-actions' }, ...review.incomplete.map(({ kind, edgeId }) => h('button', {
      class: 'textbtn', type: 'button', 'data-dialog-action': 'edit-edge', 'data-edge-id': edgeId,
      text: t(`graph.resolveIncomplete.${kind}`),
    }))),
  );
  return elements;
}
