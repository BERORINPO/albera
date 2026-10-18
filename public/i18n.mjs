// @ts-check
// 画面: 言葉の引き方と言語の決め方 (純粋。DOM・storage・時計は触らない)。
// 言葉そのものは dict-en.mjs / dict-ja.mjs にだけある。差し込みと複数形は shared の i18n.mjs。

import { fill, fillParts, normalizeLang, pickForm } from '../src/shared/i18n.mjs';
import { EN } from './dict-en.mjs';
import { JA } from './dict-ja.mjs';

/** @typedef {'en'|'ja'} Lang */
/**
 * @typedef {((key: string, params?: Record<string, unknown>) => string) & {
 *   lang: Lang,
 *   has: (key: string) => boolean,
 *   parts: (key: string, params?: Record<string, unknown>) => Array<unknown>,
 * }} T
 */

/** @type {Readonly<Record<Lang, Readonly<Record<string, string | {one: string, other: string}>>>>} */
export const DICT = Object.freeze({ en: EN, ja: JA });

/**
 * 言語ごとの t を作る。項目が無ければ英語、それも無ければキーそのもの (目に見えるので気づける)。
 * t.parts は {name} に DOM のノードを差し込みたいときに使う (fillParts)。
 * @param {string} lang
 * @returns {T}
 */
export function makeT(lang) {
  const l = /** @type {Lang} */ (lang === 'ja' ? 'ja' : 'en');
  const dict = DICT[l];
  /** @param {string} key */
  const entryOf = (key) => dict[key] ?? DICT.en[key];
  /** @param {string} key @param {Record<string, unknown>} [params] */
  const t = (key, params = {}) => {
    const entry = entryOf(key);
    if (entry == null) return key;
    return fill(pickForm(l, entry, params.n), params);
  };
  t.lang = l;
  t.has = (/** @type {string} */ key) => entryOf(key) != null;
  t.parts = (/** @type {string} */ key, /** @type {Record<string, unknown>} */ params = {}) => {
    const entry = entryOf(key);
    if (entry == null) return [key];
    return fillParts(pickForm(l, entry, params.n), params);
  };
  return /** @type {T} */ (t);
}

/**
 * 画面の言語を決める: ?lang= (保存しない) > 保存した切替 > navigator.languages の最初の en / ja > en。
 * @param {{search?: string, saved?: unknown, languages?: readonly string[]}} input
 * @returns {Lang}
 */
export function detectLang({ search = '', saved, languages = [] }) {
  let fromUrl = null;
  try {
    fromUrl = normalizeLang(new URLSearchParams(search).get('lang'));
  } catch {
    fromUrl = null;
  }
  if (fromUrl) return fromUrl;
  const fromSaved = normalizeLang(saved);
  if (fromSaved) return fromSaved;
  for (const tag of languages ?? []) {
    const l = normalizeLang(tag);
    if (l) return l;
  }
  return 'en';
}

/** 反対の言語 (切替ボタンが指す先)。 @param {Lang} lang @returns {Lang} */
export const otherLang = (lang) => (lang === 'ja' ? 'en' : 'ja');
