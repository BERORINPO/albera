// entry の設定 (純粋関数): フラグ・環境変数・言語・セッションフォルダの候補・ポートの案内。
// 外界は引数で渡すので、どの OS の規則もこの PC で確かめられる。パスはすべて合成。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  argsWithoutPort,
  ConfigError,
  loadConfig,
  localeLang,
  parseArgs,
  parsePort,
  parseRoots,
  pickTerminalLang,
  portHint,
  resolveProjectsDir,
  sessionsDirCandidates,
  shellQuote,
} from '../src/entry/config.mjs';
import { DEFAULT_PORT } from '../src/shared/constants.mjs';

const WIN_HOME = 'C:\\Users\\tester';
const NIX_HOME = '/home/tester';
const MAC_HOME = '/Users/tester';

/** @param {() => unknown} fn @param {string} key @param {Record<string, unknown>} [params] */
function throwsConfig(fn, key, params) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ConfigError, String(e));
    assert.equal(e.key, key);
    if (params) for (const [k, v] of Object.entries(params)) assert.deepEqual(e.params[k], v, k);
    return e;
  }
  assert.fail(`${key} が投げられない`);
}

test('parseArgs: --flag value と --flag=value、真偽のフラグ、後の指定が勝つ', () => {
  assert.deepEqual(parseArgs([]), { demo: false, help: false, version: false });
  assert.deepEqual(parseArgs(['--port', '9001', '--demo', '--lang=ja', '--sessions-dir', 'C:\\x y', '--projects-dir=/p']), {
    demo: true,
    help: false,
    version: false,
    port: '9001',
    lang: 'ja',
    sessionsDir: 'C:\\x y',
    projectsDir: '/p',
  });
  assert.equal(parseArgs(['--port=1', '--port=2']).port, '2');
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--version']).version, true);
  assert.equal(parseArgs(['--port', '-1']).port, '-1', '負の数は値 (parsePort が弾く)');
});

test('parseArgs: 知らないフラグ・位置引数・値の無いフラグは ConfigError', () => {
  throwsConfig(() => parseArgs(['--nope']), 'term.badFlag', { flag: '--nope' });
  throwsConfig(() => parseArgs(['serve']), 'term.badFlag', { flag: 'serve' });
  throwsConfig(() => parseArgs(['--demo=1']), 'term.badFlag');
  throwsConfig(() => parseArgs(['--' + 'x'.repeat(100)]), 'term.badFlag', { flag: '--' + 'x'.repeat(38) });
  throwsConfig(() => parseArgs(['--port']), 'term.missingValue', { flag: '--port' });
  throwsConfig(() => parseArgs(['--port', '--demo']), 'term.missingValue', { flag: '--port' });
  throwsConfig(() => parseArgs(['--lang=']), 'term.missingValue', { flag: '--lang' });
});

test('端末の言語: --lang → ALBERA_LANG → LC_ALL → LC_MESSAGES → LANG → Intl → en', () => {
  assert.equal(pickTerminalLang({}, 'ja', 'en-US'), 'ja');
  assert.equal(pickTerminalLang({ ALBERA_LANG: 'ja' }, 'en', 'ja-JP'), 'en', 'フラグが勝つ');
  assert.equal(pickTerminalLang({ ALBERA_LANG: 'ja-JP' }, undefined, 'en-US'), 'ja');
  assert.equal(pickTerminalLang({ LC_ALL: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' }, undefined, 'en-US'), 'ja');
  assert.equal(pickTerminalLang({ LC_MESSAGES: 'en_US.UTF-8', LANG: 'ja_JP.UTF-8' }, undefined, 'ja-JP'), 'en');
  assert.equal(pickTerminalLang({ LANG: 'C.UTF-8' }, undefined, 'ja-JP'), 'ja', 'C は指定なし扱いで Intl へ');
  assert.equal(pickTerminalLang({ LC_ALL: 'POSIX' }, undefined, 'en-GB'), 'en');
  assert.equal(pickTerminalLang({ LANG: 'fr_FR.UTF-8' }, undefined, 'ja-JP'), 'en', 'en / ja 以外の LANG は en');
  assert.equal(pickTerminalLang({}, undefined, 'Japanese_Japan.932'), 'ja');
  assert.equal(pickTerminalLang({}, undefined, 'zh-CN'), 'en');
  assert.equal(pickTerminalLang({}, undefined, undefined), 'en');
  assert.equal(localeLang({ LANG: 'ja_JP.UTF-8' }, 'en'), 'ja');
});

test('環境変数の名称変更: ALBERA_* を優先し、未設定なら旧 PIGEONHOLES_* を引き継ぐ', () => {
  assert.equal(pickTerminalLang({ PIGEONHOLES_LANG: 'ja' }, undefined, 'en-US'), 'ja');
  assert.equal(pickTerminalLang({ ALBERA_LANG: 'en', PIGEONHOLES_LANG: 'ja' }, undefined, 'ja-JP'), 'en');
  assert.equal(pickTerminalLang({ ALBERA_LANG: ' ', PIGEONHOLES_LANG: 'ja' }, undefined, 'en-US'), 'ja', '空の新変数は旧値へフォールバック');
  const config = loadConfig({ home: NIX_HOME, cwd: '/cwd', platform: 'linux', argv: ['--demo'], env: { PIGEONHOLES_PORT: '9201', PIGEONHOLES_ROOTS: '/legacy' } });
  assert.equal(config.port, 9201);
  assert.deepEqual(config.roots, ['/legacy']);
  const preferred = loadConfig({ home: NIX_HOME, cwd: '/cwd', platform: 'linux', argv: ['--demo'], env: { ALBERA_PORT: '9202', PIGEONHOLES_PORT: '9201', ALBERA_ROOTS: '/new', PIGEONHOLES_ROOTS: '/legacy' } });
  assert.equal(preferred.port, 9202, '新しい設定が旧設定に勝つ');
  assert.deepEqual(preferred.roots, ['/new']);
  const blankFallback = loadConfig({ home: NIX_HOME, cwd: '/cwd', platform: 'linux', argv: ['--demo'], env: { ALBERA_PORT: '', PIGEONHOLES_PORT: '9201' } });
  assert.equal(blankFallback.port, 9201);
  throwsConfig(() => loadConfig({ home: NIX_HOME, cwd: '/cwd', platform: 'linux', argv: ['--demo'], env: { ALBERA_PORT: 'bad', PIGEONHOLES_PORT: '9201' } }), 'term.badPort', { raw: 'bad' });
  const projectDir = resolveProjectsDir({ flag: undefined, env: { PIGEONHOLES_PROJECTS_DIR: '/legacy-projects' }, home: NIX_HOME, cwd: '/cwd', platform: 'linux' });
  assert.equal(projectDir, '/legacy-projects');
  const sessionConfig = loadConfig({ home: NIX_HOME, cwd: '/cwd', platform: 'linux', argv: [], env: { PIGEONHOLES_SESSIONS_DIR: '/legacy-sessions', PIGEONHOLES_PROJECTS_DIR: '/legacy-projects' }, isDir: (p) => p === '/legacy-sessions' });
  assert.equal(sessionConfig.sessionsRoot, '/legacy-sessions');
  assert.equal(sessionConfig.projectsDir, '/legacy-projects');
  const legacyDemo = loadConfig({ home: NIX_HOME, cwd: '/cwd', platform: 'linux', argv: [], env: { PIGEONHOLES_DEMO: 'true' } });
  assert.equal(legacyDemo.demo, true);
});

test('端末の言語: --lang / ALBERA_LANG が不正なら、それを除いた順で決めた言語で ConfigError', () => {
  const e = throwsConfig(() => pickTerminalLang({ LANG: 'ja_JP.UTF-8' }, 'fr', 'en-US'), 'term.badLang', { raw: 'fr' });
  assert.equal(e.lang, 'ja');
  const e2 = throwsConfig(() => pickTerminalLang({ ALBERA_LANG: 'klingon' }, undefined, 'en-US'), 'term.badLang', { raw: 'klingon' });
  assert.equal(e2.lang, 'en');
  assert.equal(pickTerminalLang({ ALBERA_LANG: 'xx' }, 'ja', 'en'), 'ja', 'フラグがあれば環境変数は見ない');
});

test('parsePort: 空なら既定、1024〜65535 の整数でなければ ConfigError (今の値は 40 字まで)', () => {
  assert.equal(parsePort(undefined), DEFAULT_PORT);
  assert.equal(parsePort('  '), DEFAULT_PORT);
  assert.equal(parsePort(' 9000 '), 9000);
  assert.equal(parsePort('1024'), 1024);
  assert.equal(parsePort('65535'), 65535);
  for (const bad of ['abc', '80', '1023', '65536', '9000.5', '-9000', '0x2000', '9 000']) throwsConfig(() => parsePort(bad), 'term.badPort', { raw: bad });
  throwsConfig(() => parsePort('9'.repeat(60)), 'term.badPort', { raw: '9'.repeat(40) });
});

test('parseRoots: 既定は [home]。path.delimiter と ; で分け、絶対パスでなければ ConfigError', () => {
  assert.deepEqual(parseRoots(undefined, WIN_HOME, 'win32'), [WIN_HOME]);
  assert.deepEqual(parseRoots('', NIX_HOME, 'linux'), [NIX_HOME]);
  assert.deepEqual(parseRoots('C:\\work; D:\\code ;', WIN_HOME, 'win32'), ['C:\\work', 'D:\\code']);
  assert.deepEqual(parseRoots('/srv/a:/srv/b;/srv/c', NIX_HOME, 'linux'), ['/srv/a', '/srv/b', '/srv/c']);
  assert.deepEqual(parseRoots('/srv/a', MAC_HOME, 'darwin'), ['/srv/a']);
  throwsConfig(() => parseRoots('C:\\work;relative\\dir', WIN_HOME, 'win32'), 'term.badRoots', { bad: 'relative\\dir', sep: ';' });
  throwsConfig(() => parseRoots('/ok:rel', NIX_HOME, 'linux'), 'term.badRoots', { bad: 'rel', sep: ':' });
  throwsConfig(() => parseRoots(';;', WIN_HOME, 'win32'), 'term.badRoots', { bad: '' });
});

test('セッションフォルダの候補: win32 は APPDATA → MSIX 版、darwin は Application Support、linux は XDG → ~/.config', () => {
  assert.deepEqual(sessionsDirCandidates('win32', { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }, WIN_HOME), [
    'C:\\Users\\tester\\AppData\\Roaming\\Claude\\claude-code-sessions',
    'C:\\Users\\tester\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude-code-sessions',
  ]);
  assert.deepEqual(sessionsDirCandidates('win32', {}, WIN_HOME), [
    'C:\\Users\\tester\\AppData\\Roaming\\Claude\\claude-code-sessions',
    'C:\\Users\\tester\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude-code-sessions',
  ], 'APPDATA が無くても home から');
  assert.deepEqual(sessionsDirCandidates('darwin', {}, MAC_HOME), ['/Users/tester/Library/Application Support/Claude/claude-code-sessions']);
  assert.deepEqual(sessionsDirCandidates('linux', { XDG_CONFIG_HOME: '/xdg' }, NIX_HOME), ['/xdg/Claude/claude-code-sessions', '/home/tester/.config/Claude/claude-code-sessions']);
  assert.deepEqual(sessionsDirCandidates('linux', { XDG_CONFIG_HOME: 'relative' }, NIX_HOME), ['/home/tester/.config/Claude/claude-code-sessions']);
  assert.deepEqual(sessionsDirCandidates('linux', { XDG_CONFIG_HOME: '/home/tester/.config' }, NIX_HOME), ['/home/tester/.config/Claude/claude-code-sessions']);
});

test('会話ログのフォルダ: フラグ → ALBERA_PROJECTS_DIR → CLAUDE_CONFIG_DIR (絶対パスのとき) → ~/.claude/projects', () => {
  const base = { home: NIX_HOME, cwd: '/cwd', platform: 'linux' };
  assert.equal(resolveProjectsDir({ ...base, env: {} }), '/home/tester/.claude/projects');
  assert.equal(resolveProjectsDir({ ...base, env: { CLAUDE_CONFIG_DIR: '/cfg' } }), '/cfg/projects');
  assert.equal(resolveProjectsDir({ ...base, env: { CLAUDE_CONFIG_DIR: 'rel' } }), '/home/tester/.claude/projects');
  assert.equal(resolveProjectsDir({ ...base, env: { ALBERA_PROJECTS_DIR: 'logs', CLAUDE_CONFIG_DIR: '/cfg' } }), '/cwd/logs');
  assert.equal(resolveProjectsDir({ ...base, flag: '/flag', env: { ALBERA_PROJECTS_DIR: '/env' } }), '/flag');
  assert.equal(resolveProjectsDir({ home: WIN_HOME, cwd: 'C:\\cwd', platform: 'win32', env: {} }), 'C:\\Users\\tester\\.claude\\projects');
});

/** @param {string[]} existing @returns {(p: string) => boolean} */
const dirs = (existing) => (p) => existing.includes(p);

test('loadConfig: 候補のうち最初に存在したフォルダ。フラグか環境変数があればそれだけを見る (相対パスは今のフォルダから)', () => {
  const env = { APPDATA: 'C:\\R', LOCALAPPDATA: 'C:\\L' };
  const msix = 'C:\\L\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude-code-sessions';
  const base = { argv: [], home: WIN_HOME, cwd: 'C:\\cwd', platform: 'win32', intlLocale: 'en-US' };
  const both = loadConfig({ ...base, env, isDir: dirs(['C:\\R\\Claude\\claude-code-sessions', msix]) });
  assert.equal(both.action === 'run' && both.sessionsRoot, 'C:\\R\\Claude\\claude-code-sessions');
  const store = loadConfig({ ...base, env, isDir: dirs([msix]) });
  assert.equal(store.action === 'run' && store.sessionsRoot, msix, 'Microsoft Store 版');
  const flag = loadConfig({ ...base, argv: ['--sessions-dir', 'mine'], env: { ...env, ALBERA_SESSIONS_DIR: 'C:\\envdir' }, isDir: dirs(['C:\\cwd\\mine', msix]) });
  assert.equal(flag.action === 'run' && flag.sessionsRoot, 'C:\\cwd\\mine');
  const e = throwsConfig(() => loadConfig({ ...base, env: { ...env, ALBERA_SESSIONS_DIR: 'C:\\envdir' }, isDir: dirs([msix]) }), 'term.noSessionsDir', { tried: ['C:\\envdir'] });
  assert.equal(e.lang, 'en');
  throwsConfig(() => loadConfig({ ...base, env, isDir: dirs([]) }), 'term.noSessionsDir', { tried: ['C:\\R\\Claude\\claude-code-sessions', msix] });
});

test('loadConfig: フラグは環境変数に勝つ。デモはセッションフォルダが無くても起動する', () => {
  const base = { home: NIX_HOME, cwd: '/cwd', platform: 'linux', intlLocale: 'en-US', isDir: dirs([]) };
  const c = loadConfig({ ...base, argv: ['--port', '9100', '--demo', '--lang', 'ja', '--projects-dir', '/flag'], env: { ALBERA_PORT: 'abc', ALBERA_LANG: 'xx', ALBERA_PROJECTS_DIR: '/env' } });
  assert.deepEqual(c, { action: 'run', lang: 'ja', demo: true, port: 9100, roots: [NIX_HOME], sessionsRoot: '', projectsDir: '/flag', home: NIX_HOME });
  const env = loadConfig({ ...base, argv: [], env: { ALBERA_PORT: '9200', ALBERA_DEMO: '1', ALBERA_ROOTS: '/a:/b' } });
  assert.equal(env.action === 'run' && env.port, 9200);
  assert.equal(env.action === 'run' && env.demo, true);
  assert.deepEqual(env.action === 'run' && env.roots, ['/a', '/b']);
  assert.equal(loadConfig({ ...base, argv: [], env: { ALBERA_DEMO: 'true' } }).action, 'run');
  throwsConfig(() => loadConfig({ ...base, argv: [], env: { ALBERA_DEMO: '0' } }), 'term.noSessionsDir');
  // ALBERA と PIGEONHOLES 以外の環境変数名は読まない
  const old = loadConfig({ ...base, argv: ['--demo'], env: { SESSION_BOARD_PORT: '9300' } });
  assert.equal(old.action === 'run' && old.port, DEFAULT_PORT);
});

test('loadConfig: --help / --version は他の値を確かめずに返す。誤りは決めた言語で出す', () => {
  const base = { home: NIX_HOME, cwd: '/cwd', platform: 'linux', intlLocale: 'en-US', isDir: dirs([]) };
  assert.deepEqual(loadConfig({ ...base, argv: ['--help'], env: { ALBERA_PORT: 'abc' } }), { action: 'help', lang: 'en' });
  assert.deepEqual(loadConfig({ ...base, argv: ['--version', '--lang', 'ja'], env: {} }), { action: 'version', lang: 'ja' });
  assert.equal(throwsConfig(() => loadConfig({ ...base, argv: ['--demo'], env: { ALBERA_PORT: '80', LANG: 'ja_JP.UTF-8' } }), 'term.badPort').lang, 'ja');
  assert.equal(throwsConfig(() => loadConfig({ ...base, argv: ['--nope', '--lang', 'ja'], env: {} }), 'term.badFlag').lang, 'ja', 'フラグの誤りも --lang の言語で');
  assert.equal(throwsConfig(() => loadConfig({ ...base, argv: ['--nope', '--lang', 'fr'], env: { LANG: 'ja_JP.UTF-8' } }), 'term.badFlag').lang, 'ja');
  assert.equal(throwsConfig(() => loadConfig({ ...base, argv: ['--demo'], env: { ALBERA_ROOTS: 'rel', ALBERA_LANG: 'ja' } }), 'term.badRoots').lang, 'ja');
});

test('portHint: 次の番号での起動例。付けていたフラグは残し、空白や記号のある値は OS に合わせて引用する', () => {
  assert.deepEqual(portHint('win32', 8797), { port: 8798, cmd: 'npx albera --port 8798' });
  assert.deepEqual(portHint('linux', 8797), { port: 8798, cmd: 'npx albera --port 8798' });
  assert.deepEqual(portHint('darwin', 65535, 'node /opt/p/server.mjs'), { port: 65534, cmd: 'node /opt/p/server.mjs --port 65534' });
  const args = argsWithoutPort(['--demo', '--port', '8797', '--lang=ja', '--port=1', '--sessions-dir', '/data/my sessions']);
  assert.deepEqual(args, ['--demo', '--lang=ja', '--sessions-dir', '/data/my sessions'], '--port とその値だけ除く');
  assert.equal(portHint('linux', 8797, 'npx albera', args).cmd, "npx albera --demo --lang=ja --sessions-dir '/data/my sessions' --port 8798", '--demo を落とさない');
  assert.equal(portHint('win32', 8797, 'npx albera', ['--sessions-dir', 'D:\\My Sessions']).cmd, 'npx albera --sessions-dir "D:\\My Sessions" --port 8798');
});

test('shellQuote: 記号の無い値はそのまま、ほかは POSIX なら \'…\'、win32 なら "…"', () => {
  assert.equal(shellQuote('--lang=en', 'linux'), '--lang=en');
  assert.equal(shellQuote('C:/work/p/server.mjs', 'win32'), 'C:/work/p/server.mjs');
  assert.equal(shellQuote('/home/t/My Projects/p', 'linux'), "'/home/t/My Projects/p'");
  assert.equal(shellQuote("/home/t/it's(1)", 'darwin'), "'/home/t/it'\\''s(1)'");
  assert.equal(shellQuote('/home/t/a&b;$x', 'linux'), "'/home/t/a&b;$x'");
  assert.equal(shellQuote('C:/Users/First Last/p', 'win32'), '"C:/Users/First Last/p"');
});
