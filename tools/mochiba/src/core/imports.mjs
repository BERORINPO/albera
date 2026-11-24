// Find relative imports in a source file and count them as edges between boxes.

const JS_PATTERNS = [
  /\bimport\s+(?:([\w*{}\s,$]+?)\s+from\s+)?['"]([^'"\n]+)['"]/g, // import x from '...' / import '...' (clause, spec)
  /\bexport\s+(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+['"]([^'"\n]+)['"]/g, // export ... from '...'
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, // import('...')
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, // require('...')
];
const SCRIPT_SRC = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

const isHtml = (path) => /\.html?$/i.test(path);

const NAME_MAX = 8;
/**
 * What one file takes from the other, in words a person can read on the map:
 * the imported names ("readRoster"), or how it is loaded when there are no names.
 */
function namesOf(re, clause) {
  if (re === SCRIPT_SRC) return ['画面で読み込む'];
  if (re === JS_PATTERNS[1]) return ['そのまま外へ渡す'];
  if (re === JS_PATTERNS[2] || re === JS_PATTERNS[3]) return ['必要な時に読み込む'];
  if (!clause) return ['丸ごと読み込む'];
  const names = [];
  const braces = clause.match(/\{([^}]*)\}/);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/)[0].trim();
      if (n) names.push(n);
    }
  }
  const star = clause.match(/\*\s+as\s+([\w$]+)/);
  if (star) names.push(`${star[1]} (全部)`);
  const def = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[\w$]+/, '').split(',')[0].trim();
  if (def) names.push(def);
  return names.length ? names : ['丸ごと読み込む'];
}

/** All import specifiers written in a file (relative or not), with what each one takes. */
export function findSpecifiers(text, path) {
  const found = [];
  const patterns = isHtml(path) ? [SCRIPT_SRC, ...JS_PATTERNS] : JS_PATTERNS;
  for (const re of patterns) {
    const withClause = re === JS_PATTERNS[0];
    for (const m of text.matchAll(re)) {
      found.push({ spec: withClause ? m[2] : m[1], fromHtml: re === SCRIPT_SRC, names: namesOf(re, withClause ? m[1] : null) });
    }
  }
  return found;
}

/** Normalise a posix path ("a/./b/../c" -> "a/c"). Returns null when it climbs above the root. */
export function normalisePath(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

/**
 * Resolve a specifier against the importing file. Only relative specifiers resolve:
 * "./x" and "../x" in JS, and also bare "js/x.js" in an HTML <script src>. Others give null.
 */
export function resolveSpecifier(fromPath, spec, fromHtml) {
  const clean = spec.split(/[?#]/)[0];
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//') || clean.startsWith('/')) return null;
  const relative = clean.startsWith('./') || clean.startsWith('../');
  if (!relative && !fromHtml) return null; // bare package name
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  return normalisePath(dir ? `${dir}/${clean}` : clean);
}

/**
 * Count imports between boxes.
 * @param {Map<string,string>} sources path -> file text (files that could not be read are absent)
 * @param {Map<string,string>} fileToBox path -> box id
 * @returns {{from,to,count,kind,names,more,partial}[]} edges between different boxes. count = number of import lines,
 *   names = what the "from" side takes from the "to" side (up to NAME_MAX), more = how many names were left out,
 *   partial = the names may not list everything taken (a namespace or dynamic import, a re-export, a whole file
 *   loaded with no global use found, or a global place used without a name)
 */
export function countImportEdges(sources, fileToBox) {
  const counts = new Map();
  const taken = new Map();
  const loose = new Set(), wholeFile = new Set(), viaGlobal = new Set();
  for (const [path, text] of sources) {
    const from = fileToBox.get(path);
    if (!from) continue;
    for (const { spec, fromHtml, names } of findSpecifiers(text, path)) {
      const target = resolveSpecifier(path, spec, fromHtml);
      const to = target && fileToBox.get(target);
      if (!to || to === from) continue;
      const key = `${from}\u0000${to}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      const list = taken.get(key) || [];
      for (const n of names) if (!list.includes(n)) list.push(n);
      taken.set(key, list);
      if (names.some((n) => NAMELESS.has(n) || n.endsWith(' (全部)'))) loose.add(key);
      if (names.some((n) => n === WHOLE_FILE || n === ON_PAGE)) wholeFile.add(key);
    }
  }
  // Files that share through an app-wide global object (globalThis.APP and the like): the import line only says
  // "load the whole file"; what is really used shows up later as R.<place>.<name>.
  for (const use of globalUses(sources)) {
    const from = fileToBox.get(use.user), to = fileToBox.get(use.owner);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    if (!counts.has(key)) counts.set(key, 1);
    viaGlobal.add(key);
    if (use.placeOnly) loose.add(key);
    const list = (taken.get(key) || []).filter((n) => n !== WHOLE_FILE);
    for (const n of use.names) if (!list.includes(n)) list.push(n);
    taken.set(key, list);
  }
  return [...counts].map(([key, count]) => {
    const [from, to] = key.split('\u0000');
    const all = taken.get(key) || [];
    const partial = loose.has(key) || (wholeFile.has(key) && !viaGlobal.has(key));
    return { from, to, count, kind: 'import', names: all.slice(0, NAME_MAX), more: Math.max(0, all.length - NAME_MAX), partial };
  });
}

const WHOLE_FILE = '丸ごと読み込む';
const ON_PAGE = '画面で読み込む';
// Ways of loading that never say which names are taken.
const NAMELESS = new Set(['そのまま外へ渡す', '必要な時に読み込む']);
// An app-wide global object ("namespace") is found from the code itself, not from a fixed name:
//   globalThis.APP = globalThis.APP || {}   (also window. / self., or = { ... })  -> APP is one
//   const A = globalThis.APP                 with an ALL-CAPS name                  -> APP is one, A reaches it in that file
// In a file it is reached as globalThis.APP / window.APP / self.APP / APP / an alias declared in that file.
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const HOST = String.raw`(?:globalThis|window|self)`;
const NS_MADE_RE = new RegExp(String.raw`${HOST}\.(${IDENT})\s*=\s*(?:${HOST}\.\1\s*\|\|\s*)?\{`, 'g');
const NS_ALIASED_RE = new RegExp(String.raw`(?:const|let|var)\s+${IDENT}\s*=\s*\(?\s*${HOST}\.([A-Z][A-Z0-9_$]*)\b`, 'g');
const escapeRe = (s) => s.replace(/[$]/g, '\\$&');

/** Names of app-wide global objects the sources create or alias. */
export function namespaces(sources) {
  const found = new Set();
  for (const text of sources.values()) {
    for (const m of text.matchAll(NS_MADE_RE)) found.add(m[1]);
    for (const m of text.matchAll(NS_ALIASED_RE)) found.add(m[1]);
  }
  return found;
}

/** The regex source that reaches a namespace in one file (host forms, the bare name, aliases declared there). */
function rootIn(text, names) {
  const list = [...names].map(escapeRe).join('|');
  const aliases = new Set();
  const aliasRe = new RegExp(String.raw`(?:const|let|var)\s+(${IDENT})\s*=\s*\(?\s*${HOST}\.(?:${list})\b`, 'g');
  for (const m of text.matchAll(aliasRe)) aliases.add(escapeRe(m[1]));
  return String.raw`(?:${HOST}\.(?:${list})|${list}${aliases.size ? `|${[...aliases].join('|')}` : ''})`;
}

/**
 * Which file puts each place on the global object, and which names other files take from it.
 * A place written by more than one file is skipped: we cannot tell whose it is.
 * @param {Map<string,string>} sources path -> text
 * @returns {{user:string, owner:string, names:string[], placeOnly:boolean}[]} placeOnly = the place itself was used
 *   at least once without a name after it (e.g. `const S = R.roster`), so the names may be incomplete
 */
export function globalUses(sources) {
  const names = namespaces(sources);
  if (!names.size) return [];
  const roots = new Map([...sources].map(([path, text]) => [path, rootIn(text, names)]));
  const defineRe = (root) => new RegExp(String.raw`(?<![\w$.])${root}\.(${IDENT})\s*=(?!=)`, 'g');
  const useRe = (root) => new RegExp(String.raw`(?<![\w$.])${root}\.(${IDENT})(?:\.(${IDENT}))?`, 'g');
  const writers = new Map();
  for (const [path, text] of sources) {
    for (const m of text.matchAll(defineRe(roots.get(path)))) {
      const set = writers.get(m[1]) || new Set();
      set.add(path);
      writers.set(m[1], set);
    }
  }
  const owner = new Map([...writers].filter(([, set]) => set.size === 1).map(([place, set]) => [place, [...set][0]]));
  const uses = new Map();
  const placeOnly = new Set();
  for (const [path, text] of sources) {
    for (const m of text.matchAll(useRe(roots.get(path)))) {
      const place = m[1], file = owner.get(place);
      if (!file || file === path) continue;
      const key = `${path}\u0000${file}`;
      const names = uses.get(key) || [];
      const name = m[2] || place;
      if (!names.includes(name)) names.push(name);
      uses.set(key, names);
      if (!m[2]) placeOnly.add(key);
    }
  }
  return [...uses].map(([key, names]) => { const [user, ownerFile] = key.split('\u0000'); return { user, owner: ownerFile, names, placeOnly: placeOnly.has(key) }; });
}
