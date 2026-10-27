// @ts-check
// entry: フラグと環境変数を読んで検証する。不正なら直し方入りの説明で止める (fail-fast)。spec/board.md §11
// フラグは環境変数に勝つ。言語は最初に決める (ほかの誤りをその言語で出すため)。
// 外界 (env・argv・home・OS・フォルダの有無) は引数で受けるので、どの OS の規則もテストできる。

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PORT } from '../shared/constants.mjs';
import { normalizeLang } from '../shared/i18n.mjs';

/** @typedef {'en'|'ja'} Lang */

const MAX_ECHO = 40;
const MAX_ECHO_LIST = 200;
// Keep the previous release's environment names as read-only fallbacks during the rename.
const envValue = (env, key) => env[key] ?? env[key.replace(/^ALBERA_/, 'PIGEONHOLES_')];
const MSIX_PACKAGE = 'Claude_pzs8sxrjxfjjc';
const APP_DIR = 'Claude';
const SESSIONS_DIR = 'claude-code-sessions';

/** 設定の誤り。key は messages.mjs のキー、lang はその説明を出す言語。 */
export class ConfigError extends Error {
  /**
   * @param {string} key
   * @param {Record<string, unknown>} [params]
   * @param {Lang} [lang]
   */
  constructor(key, params = {}, lang = 'en') {
    super(key);
    this.name = 'ConfigError';
    this.key = key;
    this.params = params;
    this.lang = lang;
  }

  /** @param {Lang} lang */
  withLang(lang) {
    return new ConfigError(this.key, this.params, lang);
  }
}

const clip = (/** @type {string} */ s, n = MAX_ECHO) => (s.length > n ? s.slice(0, n) : s);

/** @param {string} platform */
const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

const VALUE_FLAGS = Object.freeze({ '--port': 'port', '--lang': 'lang', '--sessions-dir': 'sessionsDir', '--projects-dir': 'projectsDir' });
const BOOL_FLAGS = Object.freeze({ '--demo': 'demo', '--help': 'help', '-h': 'help', '--version': 'version', '-v': 'version' });

/**
 * @typedef {Object} Args
 * @property {string=} port
 * @property {string=} lang
 * @property {string=} sessionsDir
 * @property {string=} projectsDir
 * @property {boolean} demo
 * @property {boolean} help
 * @property {boolean} version
 */

/**
 * `--flag value` と `--flag=value` の両方を受ける。知らないフラグ・値の無いフラグは ConfigError。
 * @param {string[]} argv
 * @returns {Args}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = { demo: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (Object.hasOwn(VALUE_FLAGS, name)) {
      let v;
      if (eq > 0) v = a.slice(eq + 1);
      else {
        v = argv[i + 1];
        if (v == null || v.startsWith('--')) throw new ConfigError('term.missingValue', { flag: name });
        i++;
      }
      if (v.trim() === '') throw new ConfigError('term.missingValue', { flag: name });
      out[VALUE_FLAGS[/** @type {keyof typeof VALUE_FLAGS} */ (name)]] = v;
    } else if (Object.hasOwn(BOOL_FLAGS, name) && eq < 0) {
      out[BOOL_FLAGS[/** @type {keyof typeof BOOL_FLAGS} */ (name)]] = true;
    } else {
      throw new ConfigError('term.badFlag', { flag: clip(a) });
    }
  }
  return /** @type {Args} */ (/** @type {unknown} */ (out));
}

/**
 * --lang と ALBERA_LANG を除いた言語 (LC_ALL → LC_MESSAGES → LANG → Intl の既定 → en)。
 * 'C' と 'POSIX' で始まるものは「指定なし」として飛ばす。en / ja 以外の指定は en。
 * @param {Record<string, string|undefined>} env
 * @param {string|undefined} intlLocale
 * @returns {Lang}
 */
export function localeLang(env, intlLocale) {
  for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const raw = env[k]?.trim();
    if (!raw || /^(C|POSIX)([._@]|$)/i.test(raw)) continue;
    return normalizeLang(raw) ?? 'en';
  }
  return normalizeLang(intlLocale) ?? 'en';
}

/**
 * 端末の言語: --lang → ALBERA_LANG → localeLang。
 * --lang / ALBERA_LANG が en / ja でなければ、それを除いた順で決めた言語の ConfigError。
 * @param {Record<string, string|undefined>} env
 * @param {string|undefined} argvLang
 * @param {string|undefined} intlLocale
 * @returns {Lang}
 */
export function pickTerminalLang(env, argvLang, intlLocale) {
  const explicit = [argvLang, envValue(env, 'ALBERA_LANG')].map((v) => v?.trim()).find((v) => !!v);
  if (!explicit) return localeLang(env, intlLocale);
  const lang = normalizeLang(explicit);
  if (!lang) throw new ConfigError('term.badLang', { raw: clip(explicit) }, localeLang(env, intlLocale));
  return lang;
}

/**
 * @param {string|undefined} raw
 * @returns {number}
 */
export function parsePort(raw) {
  if (raw == null || raw.trim() === '') return DEFAULT_PORT;
  const v = raw.trim();
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < 1024 || n > 65535) throw new ConfigError('term.badPort', { raw: clip(raw) });
  return n;
}

/**
 * プロジェクト名の基準になるフォルダ。path.delimiter と ';' (どの OS でも) で分ける。全部絶対パスでなければ ConfigError。
 * @param {string|undefined} raw
 * @param {string} home
 * @param {string} [platform]
 * @returns {string[]}
 */
export function parseRoots(raw, home, platform = process.platform) {
  if (raw == null || raw.trim() === '') return [home];
  const P = pathFor(platform);
  const list = raw.split(P.delimiter === ';' ? /;/ : /[;:]/).map((s) => s.trim()).filter((s) => s !== '');
  const bad = list.filter((p) => !P.isAbsolute(p));
  if (bad.length || !list.length) {
    throw new ConfigError('term.badRoots', { sep: P.delimiter, bad: clip(bad.join(', '), MAX_ECHO_LIST) }); // bad が '' = 区切りだけ (messages が「(空)」にする)
  }
  return list;
}

/**
 * Claude デスクトップアプリのセッションフォルダの候補 (上から順に探す)。
 * @param {string} platform
 * @param {Record<string, string|undefined>} env
 * @param {string} home
 * @returns {string[]}
 */
export function sessionsDirCandidates(platform, env, home) {
  const P = pathFor(platform);
  if (platform === 'win32') {
    const roaming = env.APPDATA?.trim() || P.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA?.trim() || P.join(home, 'AppData', 'Local');
    return [
      P.join(roaming, APP_DIR, SESSIONS_DIR),
      P.join(local, 'Packages', MSIX_PACKAGE, 'LocalCache', 'Roaming', APP_DIR, SESSIONS_DIR), // Microsoft Store (MSIX) 版
    ];
  }
  if (platform === 'darwin') return [P.join(home, 'Library', 'Application Support', APP_DIR, SESSIONS_DIR)];
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const list = [...(xdg && P.isAbsolute(xdg) ? [P.join(xdg, APP_DIR, SESSIONS_DIR)] : []), P.join(home, '.config', APP_DIR, SESSIONS_DIR)];
  return [...new Set(list)];
}

/**
 * 会話ログのフォルダ: --projects-dir → ALBERA_PROJECTS_DIR → $CLAUDE_CONFIG_DIR/projects (絶対パスのとき) → ~/.claude/projects。
 * 無くても起動する (transcriptsDirMissing になる)。
 * @param {{flag?: string, env: Record<string, string|undefined>, home: string, cwd: string, platform: string}} o
 */
export function resolveProjectsDir({ flag, env, home, cwd, platform }) {
  const P = pathFor(platform);
  const explicit = flag ?? envValue(env, 'ALBERA_PROJECTS_DIR')?.trim();
  if (explicit) return P.resolve(cwd, explicit);
  const base = env.CLAUDE_CONFIG_DIR?.trim();
  return P.join(base && P.isAbsolute(base) ? base : P.join(home, '.claude'), 'projects');
}

const SAFE_ARG_RE = /^[A-Za-z0-9_./:=@%+,-]+$/;

/**
 * 端末にそのまま貼れる形の引数 (純粋)。空白や記号を含むときだけ引用する: win32 は "…" (PowerShell・cmd の両方で通る)、それ以外は '…'。
 * @param {string} arg
 * @param {string} platform
 */
export function shellQuote(arg, platform) {
  const s = String(arg);
  if (SAFE_ARG_RE.test(s)) return s;
  if (platform === 'win32') return `"${s.replaceAll('"', '\\"')}"`;
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** 起動の引数から --port とその値を除いたもの (起動例で付け直すため)。 @param {string[]} argv */
export function argsWithoutPort(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--port') {
      i++;
      continue;
    }
    if (a.startsWith('--port=')) continue;
    out.push(a);
  }
  return out;
}

/**
 * ポートが使用中のときの起動例 (純粋)。suggest = 使用中の番号 + 1 (65535 なら - 1)。
 * 付けていたほかのフラグ (--demo・--lang・--sessions-dir など) はそのまま残す (貼ったらデモでなく実データが開く、を防ぐ)。
 * 環境変数での書き方はシェルごとに違うので出さない (--port はどのシェルでも同じ)。
 * @param {string} platform
 * @param {number} busyPort
 * @param {string} [launcher] 起動のしかた (npx で入れたなら 'npx albera'、clone なら 'node <path>')
 * @param {string[]} [args] 起動の引数 (--port は除く。argsWithoutPort)
 * @returns {{port: number, cmd: string}}
 */
export function portHint(platform, busyPort, launcher = 'npx albera', args = []) {
  const port = busyPort < 65535 ? busyPort + 1 : busyPort - 1;
  return { port, cmd: [launcher, ...args.map((a) => shellQuote(a, platform)), '--port', String(port)].join(' ') };
}

/** @param {string} p */
function isDirSync(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** フラグの解析に失敗したときの言語。--lang の値だけを寛容に拾う。 @param {string[]} argv */
function scanLangArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a.startsWith('--lang=')) return a.slice('--lang='.length);
    if (a === '--lang') return argv[i + 1];
  }
  return undefined;
}

/**
 * @typedef {Object} RunConfig
 * @property {'run'} action
 * @property {Lang} lang
 * @property {boolean} demo
 * @property {number} port
 * @property {string[]} roots
 * @property {string} sessionsRoot  デモでは ''
 * @property {string} projectsDir
 * @property {string} home
 */

/**
 * @param {{env: Record<string, string|undefined>, argv: string[], home: string, cwd?: string, platform?: string,
 *   intlLocale?: string, isDir?: (p: string) => boolean}} input
 * @returns {RunConfig | {action: 'help'|'version', lang: Lang}}
 */
export function loadConfig({ env, argv, home, cwd = process.cwd(), platform = process.platform, intlLocale, isDir = isDirSync }) {
  /** @type {Args} */
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    let lang = localeLang(env, intlLocale);
    try {
      lang = pickTerminalLang(env, scanLangArg(argv), intlLocale);
    } catch {
      // 言語の指定も不正: localeLang のまま
    }
    throw e.withLang(lang);
  }
  const lang = pickTerminalLang(env, args.lang, intlLocale);
  if (args.help) return { action: 'help', lang };
  if (args.version) return { action: 'version', lang };
  try {
    const P = pathFor(platform);
    const port = parsePort(args.port ?? envValue(env, 'ALBERA_PORT'));
    const roots = parseRoots(envValue(env, 'ALBERA_ROOTS'), home, platform);
    const demo = args.demo || /^(1|true|yes)$/i.test(envValue(env, 'ALBERA_DEMO')?.trim() ?? '');
    const projectsDir = resolveProjectsDir({ flag: args.projectsDir, env, home, cwd, platform });
    let sessionsRoot = '';
    if (!demo) {
      const explicit = args.sessionsDir ?? envValue(env, 'ALBERA_SESSIONS_DIR')?.trim();
      const tried = explicit ? [P.resolve(cwd, explicit)] : sessionsDirCandidates(platform, env, home);
      const found = tried.find((p) => isDir(p));
      if (!found) throw new ConfigError('term.noSessionsDir', { tried });
      sessionsRoot = found;
    }
    return { action: 'run', lang, demo, port, roots, sessionsRoot, projectsDir, home };
  } catch (e) {
    throw e instanceof ConfigError ? e.withLang(lang) : e;
  }
}
