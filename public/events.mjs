// @ts-check
// 画面: CLI adapter が射影した許可済みイベントの時系列だけを表示する。

import { absoluteTime } from './format.mjs';
import { h } from './view.mjs';

/** @typedef {import('./i18n.mjs').T} T */

/** @param {string} type */
const eventKey = (type) => type === 'turn_started' ? 'event.turnStarted' : type === 'turn_completed' ? 'event.turnCompleted' : type === 'turn_aborted' ? 'event.turnAborted' : type === 'turn_failed' ? 'event.turnFailed' : '';
const EVENT_SOURCES = new Set(['codex', 'copilot', 'opencode']);

/** Project source events to the display allowlist again at the UI boundary. @param {{source?:string,events?:Array<{type:string,at:number}>}} card */
export function safeEventRows(card) {
  if (!EVENT_SOURCES.has(card.source ?? '') || !Array.isArray(card.events)) return null;
  return card.events.flatMap((event) => eventKey(event.type) && Number.isSafeInteger(event.at) && event.at > 0
    ? [{ type: event.type, at: event.at }]
    : []);
}

/** @param {{id?:string,source?:string,detail?:{executionLocation?:string},events?:Array<{type:string,at:number}>}} card */
export function isCompletedLocalCodexTarget(card) {
  return card.source === 'codex'
    && typeof card.id === 'string' && card.id.startsWith('codex_')
    && card.detail?.executionLocation !== 'wsl'
    && safeEventRows(card)?.at(-1)?.type === 'turn_completed';
}

/** @param {T} t @param {{source?:string,events?:Array<{type:string,at:number}>}} card */
export function eventSummaryEl(t, card) {
  const rows = safeEventRows(card);
  const event = rows?.at(-1);
  const key = event ? eventKey(event.type) : '';
  if (!event || !key) return null;
  return h('span', { class: 'is-ink' }, h('time', { datetime: new Date(event.at).toISOString(), text: absoluteTime(t, event.at) }), ' ', t(key));
}

/** @param {T} t @param {{source?:string,events?:Array<{type:string,at:number}>}} card */
export function eventsEl(t, card) {
  const safeRows = safeEventRows(card);
  if (!safeRows) return null;
  if (!safeRows.length) return h('section', { class: 'detail__events' }, h('h3', { text: t('detail.events') }), h('p', { class: 'detail__events-empty', text: t('detail.eventsUnavailable') }));
  const rows = safeRows.map((event) => {
    const iso = new Date(event.at).toISOString();
    return h('li', {}, h('time', { datetime: iso, text: absoluteTime(t, event.at) }), ' ', t(eventKey(event.type)));
  });
  return h('section', { class: 'detail__events' }, h('h3', { text: t('detail.events') }), h('ol', {}, ...rows));
}
