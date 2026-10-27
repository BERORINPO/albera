// @ts-check
import { h } from './view.mjs';

/** @param {import('./i18n.mjs').T} t @param {Record<string, any>} card @param {Record<string, any>} detail */
export function sourceDetailValue(t, card, detail) {
  const source = card.source ?? 'claude';
  const label = [t(`source.${source}`), detail.executionLocation ? t(`graph.executionLocation.${detail.executionLocation}`) : ''].filter(Boolean).join(' — ');
  const provenance = source === 'copilot' || source === 'opencode' ? h('small', { class: 'detail__source-note', text: t(`detail.sourceProvenance.${source}`) }) : null;
  return h('span', {}, h('span', { text: label }), provenance);
}
