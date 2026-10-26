// @ts-check
// 画面: CLI adapter が射影した許可済みイベントの時系列だけを表示する。

import { absoluteTime } from './format.mjs';
import { h } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */

/** @param {string} type */
const eventKey = (type) => type === 'turn_started' ? 'event.turnStarted' : type === 'turn_completed' ? 'event.turnCompleted' : type === 'turn_aborted' ? 'event.turnAborted' : '';

/** @param {T} t @param {{source?:string,events?:Array<{type:string,at:number}>}} card */
export function eventSummaryEl(t, card) {
  if (!['codex', 'copilot'].includes(card.source ?? '') || !Array.isArray(card.events)) return null;
  const event = card.events.at(-1);
  const key = event ? eventKey(event.type) : '';
  if (!event || !key || !Number.isFinite(event.at) || event.at <= 0) return null;
  return h('span', { class: 'is-ink' }, h('time', { datetime: new Date(event.at).toISOString(), text: absoluteTime(t, event.at) }), ' ', t(key));
}

/** @param {T} t @param {{source?:string,events?:Array<{type:string,at:number}>}} card */
export function eventsEl(t, card) {
  if (!['codex', 'copilot'].includes(card.source ?? '') || !Array.isArray(card.events) || card.events.length === 0) return null;
  const rows = card.events.flatMap((event) => {
    const key = eventKey(event.type);
    const iso = Number.isFinite(event.at) && event.at > 0 ? new Date(event.at).toISOString() : '';
    return key && iso ? [h('li', {}, h('time', { datetime: iso, text: absoluteTime(t, event.at) }), ' ', t(key))] : [];
  });
  return rows.length ? h('section', { class: 'detail__events' }, h('h3', { text: t('detail.events') }), h('ol', {}, ...rows)) : null;
}
