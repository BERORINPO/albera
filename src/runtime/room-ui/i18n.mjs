// Words for the room (spec/room.md §5, part A). Every part owns a dictionary { en: {code: 'text {param}'}, ja: {...} };
// makeWords merges them. Language: ?lang= > navigator languages > en. Missing words fall back to en, then to the code.

export const DEFAULT_LANG = 'en';

/** Pick a language from the ?lang= search string and the browser's list, among the supported ones. */
export function pickLang(search, languages, supported) {
  const asked = new URLSearchParams(search || '').get('lang');
  if (asked && supported.includes(asked)) return asked;
  for (const tag of languages || []) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (supported.includes(base)) return base;
  }
  return DEFAULT_LANG;
}

/** Fill {param} slots. Unknown slots stay as they are so a missing param is visible. */
export function fill(text, params = {}) {
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (slot, key) =>
    Object.hasOwn(params, key) && params[key] !== null && params[key] !== undefined ? String(params[key]) : slot);
}

export function makeWords(...dicts) {
  const merged = {};
  for (const dict of dicts) {
    if (!dict || typeof dict !== 'object') continue;
    for (const [lang, table] of Object.entries(dict)) {
      if (table && typeof table === 'object') merged[lang] = { ...(merged[lang] ?? {}), ...table };
    }
  }
  const supported = Object.keys(merged).length ? Object.keys(merged) : [DEFAULT_LANG];
  const lang = pickLang(globalThis.location?.search, globalThis.navigator?.languages, supported);
  const own = merged[lang] ?? {};
  const base = merged[DEFAULT_LANG] ?? {};
  return {
    lang,
    t(code, params) {
      const text = Object.hasOwn(own, code) ? own[code] : Object.hasOwn(base, code) ? base[code] : code;
      return fill(String(text), params);
    },
  };
}
