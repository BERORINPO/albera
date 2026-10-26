// @ts-check
// entry: 端末に出す言葉 (en と ja)。画面の言葉は public/dict-*.mjs。spec/board.md §11
// placeholder は {name}。どちらの言語も同じキーと同じ placeholder を持つ (test/messages.test.mjs)。

import { fill } from '../shared/i18n.mjs';

/** @typedef {'en'|'ja'} Lang */

const HELP_EN = [
  'Pigeonholes {version}: a local session board with session files kept read-only and Git worktrees created only on confirmation.',
  '',
  'Usage: {cmd} [options]',
  '  --port <n>             port on 127.0.0.1 (default {port}; env PIGEONHOLES_PORT)',
  '  --lang en|ja           language of these messages and the demo (env PIGEONHOLES_LANG)',
  '  --demo                 show synthetic demo data instead of your sessions (env PIGEONHOLES_DEMO=1)',
  "  --sessions-dir <path>  the app's claude-code-sessions folder (env PIGEONHOLES_SESSIONS_DIR)",
  "  --projects-dir <path>  Claude Code's projects folder with transcripts (env PIGEONHOLES_PROJECTS_DIR)",
  '  --help, --version',
  'PIGEONHOLES_ROOTS: folders, separated by "{sep}", whose direct subfolders are projects (default: your home).',
  'Session files are read-only. Worktree creation writes only to the selected local repository after confirmation. Pigeonholes sends no remote requests.',
].join('\n');

const HELP_JA = [
  'Pigeonholes {version}: セッションファイルを読み取り専用で扱い、明示確認後にGit worktreeを作成するローカル盤面です。',
  '',
  '使い方: {cmd} [オプション]',
  '  --port <n>             127.0.0.1 で待ち受けるポート (既定 {port}。環境変数 PIGEONHOLES_PORT)',
  '  --lang en|ja           このメッセージとデモの言語 (環境変数 PIGEONHOLES_LANG)',
  '  --demo                 自分のセッションの代わりに合成のデモデータを出す (環境変数 PIGEONHOLES_DEMO=1)',
  '  --sessions-dir <path>  アプリの claude-code-sessions フォルダ (環境変数 PIGEONHOLES_SESSIONS_DIR)',
  '  --projects-dir <path>  会話ログのある Claude Code の projects フォルダ (環境変数 PIGEONHOLES_PROJECTS_DIR)',
  '  --help, --version',
  'PIGEONHOLES_ROOTS: 直下のフォルダをプロジェクトとみなすフォルダ。「{sep}」区切り (既定: ホームフォルダ)。',
  'セッションファイルは読み取り専用です。確認後のworktree作成だけが選択したローカルリポジトリへ書き込みます。Pigeonholesは外部へリクエストを送りません。',
].join('\n');

/** @type {Readonly<Record<Lang, Readonly<Record<string, string>>>>} */
export const TERM = Object.freeze({
  en: Object.freeze({
    'term.started': 'Pigeonholes: http://127.0.0.1:{port} ({mode})',
    'term.modeReadOnly': 'session files read-only; worktrees on confirmation',
    'term.modeDemo': 'demo data; worktree creation disabled',
    'term.alreadyRunning': 'Already running: open http://127.0.0.1:{port}',
    'term.alreadyRunningCheck': "(If you didn't start a board on that port, something else is answering like one. Start on another port: {cmd})",
    'term.runningDemo': 'Port {port} has the demo board, not your sessions. Stop it with Ctrl+C in its terminal, or start on another port: {cmd}',
    'term.runningLive': 'Port {port} has a board with your real sessions, not the demo. Start the demo on another port: {cmd}',
    'term.portBusy': 'Port {port} is used by another app. Start on another port: {cmd}',
    'term.cantStart': "Can't start the server: {code}",
    'term.badPort': 'The port must be a number from 1024 to 65535 (got: {raw}). Use --port <n> or PIGEONHOLES_PORT.',
    'term.badRoots': 'PIGEONHOLES_ROOTS must be absolute paths separated by "{sep}" (invalid: {bad})',
    'term.empty': '(empty)',
    'term.badLang': '--lang and PIGEONHOLES_LANG must be en or ja (got: {raw})',
    'term.badFlag': 'Unknown option: {flag}. See: {cmd} --help',
    'term.missingValue': '{flag} needs a value. See: {cmd} --help',
    'term.noSessionsDir': "Can't find the Claude desktop app's session folder. Looked in:",
    'term.noSessionsDirHint': 'Start a session once in the Code tab of the Claude desktop app, or pass --sessions-dir <path> (or set PIGEONHOLES_SESSIONS_DIR).',
    'term.boardFailed': 'Failed to build the board: {name}',
    'term.worktreeFailed': 'A worktree operation failed.',
    'term.version': 'pigeonholes {version}',
    'term.help': HELP_EN,
  }),
  ja: Object.freeze({
    'term.started': 'Pigeonholes: http://127.0.0.1:{port} ({mode})',
    'term.modeReadOnly': 'セッション読み取り専用・worktreeは確認後',
    'term.modeDemo': 'デモデータ・worktree作成無効',
    'term.alreadyRunning': 'もう起動しています: http://127.0.0.1:{port} を開いてください',
    'term.alreadyRunningCheck': '(そのポートで自分でボードを起動していないなら、別のものがボードのように応答しています。別の番号で起動してください: {cmd})',
    'term.runningDemo': 'ポート {port} で動いているのはデモのボードで、あなたのセッションではありません。そのターミナルで Ctrl+C で止めるか、別の番号で起動してください: {cmd}',
    'term.runningLive': 'ポート {port} で動いているのはあなたのセッションのボードで、デモではありません。デモは別の番号で起動してください: {cmd}',
    'term.portBusy': 'ポート {port} は別のアプリが使っています。別の番号で起動してください: {cmd}',
    'term.cantStart': 'サーバーを起動できません: {code}',
    'term.badPort': 'ポートは 1024〜65535 の数字にしてください (今: {raw})。--port <n> か PIGEONHOLES_PORT で指定します',
    'term.badRoots': 'PIGEONHOLES_ROOTS は絶対パスを「{sep}」区切りで書いてください (不正: {bad})',
    'term.empty': '(空)',
    'term.badLang': '--lang と PIGEONHOLES_LANG は en か ja にしてください (今: {raw})',
    'term.badFlag': '知らないオプションです: {flag}。{cmd} --help を見てください',
    'term.missingValue': '{flag} には値が必要です。{cmd} --help を見てください',
    'term.noSessionsDir': 'Claude デスクトップアプリのセッションフォルダが見つかりません。探した場所:',
    'term.noSessionsDirHint': 'Claude デスクトップアプリの Code タブで一度セッションを始めるか、--sessions-dir <path> (または PIGEONHOLES_SESSIONS_DIR) で場所を指定してください',
    'term.boardFailed': '盤面の計算に失敗しました: {name}',
    'term.worktreeFailed': 'worktree 操作に失敗しました。',
    'term.version': 'pigeonholes {version}',
    'term.help': HELP_JA,
  }),
});

/**
 * 端末の 1 文を作る。知らない言語は en、知らないキーはキーそのもの (テストで気づける)。
 * @param {string} lang
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 */
export function msg(lang, key, params = {}) {
  const dict = lang === 'ja' ? TERM.ja : TERM.en;
  const tpl = dict[key] ?? TERM.en[key];
  return tpl == null ? key : fill(tpl, params);
}

/**
 * 設定の誤り (config.mjs の ConfigError) を、端末に出す行の配列にする。params.cmd は案内に出す起動のしかた (無ければ bin 名)。
 * セッションフォルダが無いときだけ複数行: 説明・探した場所 (1 行に 1 つ)・直し方。
 * @param {string} lang
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 * @returns {string[]}
 */
export function errorLines(lang, key, params = {}) {
  const p = { cmd: 'pigeonholes', ...params };
  if (key === 'term.noSessionsDir') {
    const tried = Array.isArray(p.tried) ? p.tried.map(String) : [];
    return [msg(lang, key), ...tried.map((dir) => `  ${dir}`), msg(lang, 'term.noSessionsDirHint')];
  }
  if (key === 'term.badRoots' && !p.bad) return [msg(lang, key, { ...p, bad: msg(lang, 'term.empty') })];
  return [msg(lang, key, p)];
}
