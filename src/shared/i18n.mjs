// @ts-check
// shared: 言葉の差し込みと複数形の選び方 (純粋関数)。何も import しない。言葉そのものは持たない。
// 画面 (public/i18n.mjs) と端末 (src/entry/messages.mjs) の両方が使う。ブラウザにも /src/shared/i18n.mjs として配信する。

/** @typedef {'en'|'ja'} Lang */

export const SUPPORTED_LANGS = Object.freeze(/** @type {const} */ (['en', 'ja']));

const PH = /\{(\w+)\}/g;
const hasOwn = (/** @type {object} */ o, /** @type {string} */ k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * 言語タグを en / ja に寄せる。どちらでもなければ null。
 * 'ja' 'ja-JP' 'ja_JP.UTF-8' 'Japanese_Japan.932' → 'ja'、'en-US' → 'en'、'C.UTF-8' 'zh-CN' 'fr' → null。
 * @param {unknown} tag
 * @returns {Lang|null}
 */
export function normalizeLang(tag) {
  if (typeof tag !== 'string') return null;
  const lead = tag.trim().toLowerCase().match(/^[a-z]+/)?.[0] ?? '';
  if (lead.startsWith('ja')) return 'ja';
  if (lead.startsWith('en')) return 'en';
  return null;
}

/**
 * テンプレートの {name} を params の値で置き換える。1 回だけ通すので、値の中の "{n}" は展開しない。
 * params に無い placeholder はそのまま残す (目に見えるので気づける)。
 * @param {string} template
 * @param {Record<string, unknown>=} params
 * @returns {string}
 */
export function fill(template, params = {}) {
  const p = params ?? {};
  return String(template ?? '').replace(PH, (m, k) => (hasOwn(p, k) ? String(p[k]) : m));
}

/**
 * fill と同じ規則で、文字列と params の値 (DOM のノードなど) を交互に並べた配列を返す。
 * 例: fillParts('Run {cmd} in a terminal.', {cmd: node}) → ['Run ', node, ' in a terminal.']。
 * 空の文字列の部分は入れない。params に無い placeholder は文字列のまま残す。
 * @template T
 * @param {string} template
 * @param {Record<string, T>=} params
 * @returns {Array<string|T>}
 */
export function fillParts(template, params = {}) {
  const p = params ?? {};
  const tpl = String(template ?? '');
  /** @type {Array<string|T>} */
  const out = [];
  let text = '';
  let last = 0;
  for (const m of tpl.matchAll(PH)) {
    const at = /** @type {number} */ (m.index);
    text += tpl.slice(last, at);
    last = at + m[0].length;
    if (!hasOwn(p, m[1])) {
      text += m[0];
      continue;
    }
    if (text !== '') out.push(text);
    text = '';
    out.push(p[m[1]]);
  }
  text += tpl.slice(last);
  if (text !== '') out.push(text);
  return out;
}

/** @type {Map<string, Intl.PluralRules>} */
const rulesCache = new Map();

/** @param {string} lang */
function pluralRules(lang) {
  let r = rulesCache.get(lang);
  if (!r) {
    try {
      r = new Intl.PluralRules(lang);
    } catch {
      r = new Intl.PluralRules('en');
    }
    rulesCache.set(lang, r);
  }
  return r;
}

/**
 * 辞書の項目から、数 n に合う形を選ぶ。項目が文字列ならそのまま (ja はいつも文字列)。
 * 項目が {one, other, ...} なら Intl.PluralRules で分類を決め、無ければ other。
 * @param {string} lang
 * @param {string|Record<string, string>} entry
 * @param {unknown=} n
 * @returns {string}
 */
export function pickForm(lang, entry, n) {
  if (typeof entry === 'string') return entry;
  if (entry == null || typeof entry !== 'object') return String(entry ?? '');
  const cat = pluralRules(String(lang)).select(Number(n ?? 0));
  return entry[cat] ?? entry.other ?? '';
}
