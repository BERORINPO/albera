// @ts-check
// 画面: 時間と日付の言葉 (純粋関数。DOM・storage・時計は触らない。node:test からも読める)。format.mjs がそのまま再び export する。
// 言葉を返す関数は全部 t を最初に受け取る (public/i18n.mjs の makeT)。Intl の出力は使わない。

import { DAY, HOUR, MIN, SEC } from '../src/shared/constants.mjs';

/** @typedef {import('./i18n.mjs').T} T */
/** @typedef {Record<string, any>} Card */

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');

/**
 * 経過時間を分・時間・日に切り捨てて言葉にする。1 分未満は '' (呼び出し側が _now の形を使う)。
 * @param {T} t
 * @param {number} ms
 * @param {'short'|'long'} [style] 行のセルは short、文は long
 */
export function durationText(t, ms, style = 'short') {
  const d = Math.max(0, Number(ms) || 0);
  if (d < MIN) return '';
  const set = style === 'long' ? 'unit' : 'short';
  if (d < HOUR) return t(`time.${set}.minute`, { n: Math.floor(d / MIN) });
  if (d < DAY) return t(`time.${set}.hour`, { n: Math.floor(d / HOUR) });
  return t(`time.${set}.day`, { n: Math.floor(d / DAY) });
}

/**
 * 「N 前」。1 分未満は秒で数える (古い内容の知らせだけが秒を見せる)。
 * @param {T} t
 * @param {number} ms
 */
export function agoText(t, ms) {
  const d = Math.max(0, Number(ms) || 0);
  const dur = d < MIN ? t('time.short.second', { n: Math.floor(d / SEC) }) : durationText(t, d, 'short');
  return t('time.agoPhrase', { dur });
}

/**
 * 時刻のセルの文言 (状態の言葉つき)。知らない kind は time.ago。
 * @param {T} t
 * @param {string} kind waiting | stopped | stalled | ended | updated | running | latest | moved | ago
 * @param {number} since
 * @param {number} now
 * @param {'short'|'long'} [style]
 */
export function timeText(t, kind, since, now, style = 'short') {
  const k = t.has(`time.${kind}`) ? kind : 'ago';
  const d = now - since;
  if (!(d >= MIN)) return t(`time.${k}_now`);
  const dur = durationText(t, d, style);
  return t(`time.${k}`, { dur, ago: t('time.agoPhrase', { dur }) });
}

/**
 * 行の時刻セルに使う種類と起点。作業中で startedAt があれば「N 分経過」。
 * @param {Card} card
 * @returns {{kind: string, since: number}}
 */
export function cardTime(card) {
  if (card.bucket === 'working' && Number.isFinite(card.startedAt)) return { kind: 'running', since: card.startedAt };
  return { kind: String(card.timeKind ?? 'ago'), since: Number(card.since) || 0 };
}

/** ローカル時刻の HH:mm。 @param {number} ms */
export function hm(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ローカルの日付のキー YYYY-MM-DD (今日の件数などに使う)。 @param {number} ms */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 見出しの日付「Sun 18 Oct, as of 14:52」。 @param {T} t @param {number} ms */
export function dateline(t, ms) {
  const d = new Date(ms);
  return t('date.asOf', { wd: t(`date.wd.${d.getDay()}`), d: d.getDate(), mon: t(`date.mon.${d.getMonth()}`), hm: hm(ms) });
}

/** 絶対時刻 (ローカル) YYYY-MM-DD HH:mm。 @param {number|null|undefined} ms */
export function absoluteTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  return `${dayKey(ms)} ${hm(ms)}`;
}

/** 作成日時: 今日なら「今日 HH:mm」、それ以外は絶対時刻。 @param {T} t @param {number|null|undefined} ms @param {number} now */
export function createdText(t, ms, now) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  return dayKey(ms) === dayKey(now) ? t('date.today', { hm: hm(ms) }) : absoluteTime(ms);
}
