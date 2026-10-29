// @ts-check
// entry: 端末に出す言葉 (en・ja・zh)。画面の言葉は public/dict-*.mjs。spec/board.md §11
// placeholder は {name}。どちらの言語も同じキーと同じ placeholder を持つ (test/messages.test.mjs)。

import { fill } from '../shared/i18n.mjs';

/** @typedef {'en'|'ja'|'zh'} Lang */

const HELP_EN = [
  'ALBERA {version}: one read-only page for all your Claude desktop app sessions (the Code tab).',
  '',
  'Usage: {cmd} [options]',
  '  --port <n>             port on 127.0.0.1 (default {port}; env ALBERA_PORT)',
  '  --lang en|ja|zh        language of these messages and the demo (env ALBERA_LANG)',
  '  --demo                 show synthetic demo data instead of your sessions (env ALBERA_DEMO=1)',
  "  --sessions-dir <path>  the app's claude-code-sessions folder (env ALBERA_SESSIONS_DIR)",
  "  --projects-dir <path>  Claude Code's projects folder with transcripts (env ALBERA_PROJECTS_DIR)",
  '  --help, --version',
  'ALBERA_ROOTS: folders, separated by "{sep}", whose direct subfolders are projects (default: your home).',
  'It only reads files. Nothing leaves this computer.',
].join('\n');

const HELP_JA = [
  'ALBERA {version}: Claude デスクトップアプリ (Code タブ) のセッションを 1 ページで見渡す、読み取り専用の道具です。',
  '',
  '使い方: {cmd} [オプション]',
  '  --port <n>             127.0.0.1 で待ち受けるポート (既定 {port}。環境変数 ALBERA_PORT)',
  '  --lang en|ja|zh        このメッセージとデモの言語 (環境変数 ALBERA_LANG)',
  '  --demo                 自分のセッションの代わりに合成のデモデータを出す (環境変数 ALBERA_DEMO=1)',
  '  --sessions-dir <path>  アプリの claude-code-sessions フォルダ (環境変数 ALBERA_SESSIONS_DIR)',
  '  --projects-dir <path>  会話ログのある Claude Code の projects フォルダ (環境変数 ALBERA_PROJECTS_DIR)',
  '  --help, --version',
  'ALBERA_ROOTS: 直下のフォルダをプロジェクトとみなすフォルダ。「{sep}」区切り (既定: ホームフォルダ)。',
  'ファイルを読むだけです。このパソコンの外へは何も送りません。',
].join('\n');

const HELP_ZH = [
  'ALBERA {version}: 在一个页面上查看 Claude 桌面应用 (Code 标签页) 全部会话的只读工具。',
  '',
  '用法: {cmd} [选项]',
  '  --port <n>             在 127.0.0.1 上监听的端口 (默认 {port}; 环境变量 ALBERA_PORT)',
  '  --lang en|ja|zh        这些提示和演示数据所用的语言 (环境变量 ALBERA_LANG)',
  '  --demo                 显示合成的演示数据,而不是你自己的会话 (环境变量 ALBERA_DEMO=1)',
  '  --sessions-dir <path>  应用的 claude-code-sessions 文件夹 (环境变量 ALBERA_SESSIONS_DIR)',
  '  --projects-dir <path>  Claude Code 存放对话记录的 projects 文件夹 (环境变量 ALBERA_PROJECTS_DIR)',
  '  --help, --version',
  'ALBERA_ROOTS: 其直接子文件夹被视为项目的文件夹,以“{sep}”分隔 (默认: 你的主目录)。',
  '只读取文件,不会向这台电脑之外发送任何内容。',
].join('\n');

/** @type {Readonly<Record<Lang, Readonly<Record<string, string>>>>} */
export const TERM = Object.freeze({
  en: Object.freeze({
    'term.started': 'ALBERA: http://127.0.0.1:{port} ({mode})',
    'term.modeReadOnly': 'read-only',
    'term.modeDemo': 'demo data, read-only',
    'term.alreadyRunning': 'Already running: open http://127.0.0.1:{port}',
    'term.alreadyRunningCheck': "(If you didn't start a board on that port, something else is answering like one. Start on another port: {cmd})",
    'term.runningDemo': 'Port {port} has the demo board, not your sessions. Stop it with Ctrl+C in its terminal, or start on another port: {cmd}',
    'term.runningLive': 'Port {port} has a board with your real sessions, not the demo. Start the demo on another port: {cmd}',
    'term.portBusy': 'Port {port} is used by another app. Start on another port: {cmd}',
    'term.cantStart': "Can't start the server: {code}",
    'term.badPort': 'The port must be a number from 1024 to 65535 (got: {raw}). Use --port <n> or ALBERA_PORT.',
    'term.badRoots': 'ALBERA_ROOTS must be absolute paths separated by "{sep}" (invalid: {bad})',
    'term.empty': '(empty)',
    'term.badLang': '--lang and ALBERA_LANG must be en, ja or zh (got: {raw})',
    'term.badFlag': 'Unknown option: {flag}. See: {cmd} --help',
    'term.missingValue': '{flag} needs a value. See: {cmd} --help',
    'term.noSessionsDir': "Can't find the Claude desktop app's session folder. Looked in:",
    'term.noSessionsDirHint': 'Start a session once in the Code tab of the Claude desktop app, or pass --sessions-dir <path> (or set ALBERA_SESSIONS_DIR).',
    'term.boardFailed': 'Failed to build the board: {name}',
    'term.version': 'albera {version}',
    'term.help': HELP_EN,
  }),
  ja: Object.freeze({
    'term.started': 'ALBERA: http://127.0.0.1:{port} ({mode})',
    'term.modeReadOnly': '読み取り専用',
    'term.modeDemo': 'デモデータ・読み取り専用',
    'term.alreadyRunning': 'もう起動しています: http://127.0.0.1:{port} を開いてください',
    'term.alreadyRunningCheck': '(そのポートで自分でボードを起動していないなら、別のものがボードのように応答しています。別の番号で起動してください: {cmd})',
    'term.runningDemo': 'ポート {port} で動いているのはデモのボードで、あなたのセッションではありません。そのターミナルで Ctrl+C で止めるか、別の番号で起動してください: {cmd}',
    'term.runningLive': 'ポート {port} で動いているのはあなたのセッションのボードで、デモではありません。デモは別の番号で起動してください: {cmd}',
    'term.portBusy': 'ポート {port} は別のアプリが使っています。別の番号で起動してください: {cmd}',
    'term.cantStart': 'サーバーを起動できません: {code}',
    'term.badPort': 'ポートは 1024〜65535 の数字にしてください (今: {raw})。--port <n> か ALBERA_PORT で指定します',
    'term.badRoots': 'ALBERA_ROOTS は絶対パスを「{sep}」区切りで書いてください (不正: {bad})',
    'term.empty': '(空)',
    'term.badLang': '--lang と ALBERA_LANG は en・ja・zh のどれかにしてください (今: {raw})',
    'term.badFlag': '知らないオプションです: {flag}。{cmd} --help を見てください',
    'term.missingValue': '{flag} には値が必要です。{cmd} --help を見てください',
    'term.noSessionsDir': 'Claude デスクトップアプリのセッションフォルダが見つかりません。探した場所:',
    'term.noSessionsDirHint': 'Claude デスクトップアプリの Code タブで一度セッションを始めるか、--sessions-dir <path> (または ALBERA_SESSIONS_DIR) で場所を指定してください',
    'term.boardFailed': '盤面の計算に失敗しました: {name}',
    'term.version': 'albera {version}',
    'term.help': HELP_JA,
  }),
  zh: Object.freeze({
    'term.started': 'ALBERA: http://127.0.0.1:{port} ({mode})',
    'term.modeReadOnly': '只读',
    'term.modeDemo': '演示数据,只读',
    'term.alreadyRunning': '已在运行: 请打开 http://127.0.0.1:{port}',
    'term.alreadyRunningCheck': '(如果你没有在该端口启动过看板,说明有别的程序在冒充看板响应。请换一个端口启动: {cmd})',
    'term.runningDemo': '端口 {port} 上运行的是演示看板,不是你的会话。请在它所在的终端按 Ctrl+C 停止,或换一个端口启动: {cmd}',
    'term.runningLive': '端口 {port} 上运行的是你的真实会话看板,不是演示。请换一个端口启动演示: {cmd}',
    'term.portBusy': '端口 {port} 已被其他应用占用。请换一个端口启动: {cmd}',
    'term.cantStart': '无法启动服务器: {code}',
    'term.badPort': '端口必须是 1024 到 65535 之间的数字 (当前: {raw})。请用 --port <n> 或 ALBERA_PORT 指定',
    'term.badRoots': 'ALBERA_ROOTS 必须是绝对路径,以“{sep}”分隔 (无效: {bad})',
    'term.empty': '(空)',
    'term.badLang': '--lang 和 ALBERA_LANG 必须是 en、ja 或 zh (当前: {raw})',
    'term.badFlag': '未知选项: {flag}。请查看: {cmd} --help',
    'term.missingValue': '{flag} 需要一个值。请查看: {cmd} --help',
    'term.noSessionsDir': '找不到 Claude 桌面应用的会话文件夹。已查找:',
    'term.noSessionsDirHint': '请先在 Claude 桌面应用的 Code 标签页里开始一次会话,或用 --sessions-dir <path> (或设置 ALBERA_SESSIONS_DIR) 指定位置',
    'term.boardFailed': '生成看板失败: {name}',
    'term.version': 'albera {version}',
    'term.help': HELP_ZH,
  }),
});

/**
 * 端末の 1 文を作る。知らない言語は en、知らないキーはキーそのもの (テストで気づける)。
 * @param {string} lang
 * @param {string} key
 * @param {Record<string, unknown>} [params]
 */
export function msg(lang, key, params = {}) {
  const dict = lang === 'ja' || lang === 'zh' ? TERM[lang] : TERM.en;
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
  const p = { cmd: 'albera', ...params };
  if (key === 'term.noSessionsDir') {
    const tried = Array.isArray(p.tried) ? p.tried.map(String) : [];
    return [msg(lang, key), ...tried.map((dir) => `  ${dir}`), msg(lang, 'term.noSessionsDirHint')];
  }
  if (key === 'term.badRoots' && !p.bad) return [msg(lang, key, { ...p, bad: msg(lang, 'term.empty') })];
  return [msg(lang, key, p)];
}
