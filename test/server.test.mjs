// entry の結合テスト: サーバーを 18950〜18989 の空きポートで起動して確かめる (デモ = 合成データ、または一時フォルダの合成ファイル)。
// このPCの実データは読まない (実データの確認は npm run smoke)。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { createAppSessionsSource } from '../src/adapters/app-sessions-fs.mjs';
import { createFakeTranscriptsSource } from '../src/adapters/fake-transcripts.mjs';
import { buildStaticFiles, createHandler, STATIC_TYPES } from '../src/entry/http.mjs';
import { parseHello } from '../src/entry/probe.mjs';
import { createBoardService } from '../src/entry/service.mjs';
import { FORBIDDEN_OUTPUT_KEYS, FORBIDDEN_WIRE_KEYS } from '../src/shared/constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'entry', 'server.mjs');
const READY_RE = /http:\/\/127\.0\.0\.1:\d+/;
// 使うポートの範囲。ほかの作業とポートを分けたいときは PIGEONHOLES_TEST_PORTS=18950-18969 のように狭められる
const [PORT_MIN, PORT_MAX] = (/^(\d+)-(\d+)$/.exec(process.env.PIGEONHOLES_TEST_PORTS ?? '') ?? [null, '18950', '18989']).slice(1).map(Number);
// 起動のしかた (clone から動かしているので node <このファイルの絶対パス>。空白を含むパスなら引用符つき)
const LAUNCH = String.raw`node ['"]?.+/src/entry/server\.mjs['"]?`;
const VERSION = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;

/** @type {Set<number>} このファイルで渡したポート (同じ番号を 2 度使わない) */
const handedOut = new Set();

/** @param {number} port @returns {Promise<boolean>} */
function canBind(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** 18950〜18989 の空きポート (始める位置はばらす)。 @returns {Promise<number>} */
async function freePort() {
  const span = PORT_MAX - PORT_MIN + 1;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = PORT_MIN + ((start + i) % span);
    if (handedOut.has(port)) continue;
    if (await canBind(port)) {
      handedOut.add(port);
      return port;
    }
  }
  throw new Error(`no free port in ${PORT_MIN}-${PORT_MAX}`);
}

/** 誤って設定の検証を通っても、既定のポート (所有者のボード) には繋がないための番号 (before で決める) */
let guardPort = PORT_MAX;

/** 走らせる人の設定や言語に結果を左右させないために、子に渡さない環境変数 (PIGEONHOLES_* と、端末の言語を決める LC_* / LANG / LANGUAGE)。 */
const DROP_ENV_RE = /^(PIGEONHOLES_|LC_|LANG$|LANGUAGE$)/;

/**
 * 呼び出し元の PIGEONHOLES_* と言語の環境変数を消した環境 (言語に頼るケースは extra で明示する)。
 * ポートは既定で guardPort (フラグか extra で上書きする)。
 * @param {Record<string, string>} extra
 */
function cleanEnv(extra = {}) {
  /** @type {Record<string, string|undefined>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP_ENV_RE.test(k)) env[k] = v;
  return { ...env, PIGEONHOLES_PORT: String(guardPort), ...extra };
}

/**
 * サーバーを起動し、起動の行 (URL) が出るか終了するまで待つ。waitExit なら終了まで待つ。
 * @param {string[]} args
 * @param {{env?: Record<string, string>, waitExit?: boolean}} [o]
 */
function start(args, { env = {}, waitExit = false } = {}) {
  const child = spawn(process.execPath, [SERVER, ...args], { env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const ready = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, out, err, timeout: true }), 10000);
    if (!waitExit) {
      child.stdout.on('data', () => {
        if (READY_RE.test(out)) {
          clearTimeout(timer);
          resolve({ code: null, out, err });
        }
      });
    }
    // exit ではなく close: 終了直前に書いた行を読み終えてから結果を返す
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
  return { child, ready: /** @type {Promise<{code: number|null, out: string, err: string, timeout?: boolean}>} */ (ready) };
}

/** 起動して終了まで待つ。 @param {string[]} args @param {Record<string, string>} [env] */
const run = (args, env = {}) => start(args, { env, waitExit: true }).ready;

/**
 * Host やパスをそのまま送れるように http.request を使う。
 * @param {number} port
 * @param {{path?: string, method?: string, headers?: Record<string, string>}} o
 * @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, body: string}>}
 */
function request(port, o = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: o.path ?? '/', method: o.method ?? 'GET', headers: { Host: `127.0.0.1:${port}`, ...(o.headers ?? {}) } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** @param {string} out */
const lines = (out) => out.trim().split(/\r?\n/).filter((l) => l !== '');

/** @type {string} */
let tmp;
/** @type {number} */
let port;
/** @type {import('node:child_process').ChildProcess} */
let child;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pigeonholes-server-test-'));
  guardPort = await freePort();
  port = await freePort();
  const s = start(['--demo', '--port', String(port), '--lang', 'en']);
  child = s.child;
  const r = await s.ready;
  assert.equal(r.code, null, r.err);
  assert.equal(lines(r.out)[0], `Pigeonholes: http://127.0.0.1:${port} (demo data, read-only)`);
});
after(async () => {
  child?.kill();
  await fs.rm(tmp, { recursive: true, force: true });
});

test('/ は 200 で HTML、CSP などのヘッダーが付き、このボードの印 (meta) がある', async () => {
  const r = await request(port);
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /text\/html/);
  assert.match(String(r.headers['content-security-policy']), /default-src 'self'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  assert.match(r.body, /<meta name="pigeonholes" content="1"\s*\/?>/);
  assert.equal((await request(port, { path: '/index.html' })).body, r.body);
});

test('/api/hello はこのボードの名前とデモかどうかだけを返す (使用中のポートの確かめ用)', async () => {
  const r = await request(port, { path: '/api/hello' });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /application\/json/);
  assert.deepEqual(JSON.parse(r.body), { app: 'pigeonholes', demo: true });
  assert.equal(parseHello(r.body), 'demo');
  assert.equal(parseHello('{"app":"pigeonholes","demo":false}'), 'live');
  for (const other of ['<title>another app</title>', '{"app":"other","demo":true}', '{"app":"pigeonholes"}', '']) assert.equal(parseHello(other), null, other);
});

test('public/ 直下の画面のファイルと shared の 2 ファイルが、拡張子に合った Content-Type で配信される', async () => {
  const names = (await fs.readdir(path.join(ROOT, 'public'), { withFileTypes: true }))
    .filter((e) => e.isFile() && !e.name.startsWith('.') && Object.hasOwn(STATIC_TYPES, path.extname(e.name)))
    .map((e) => e.name);
  assert.ok(names.length >= 5, `public/ のファイル ${names.length} 件`);
  for (const n of names) {
    const r = await request(port, { path: `/${n}` });
    assert.equal(r.status, 200, n);
    assert.equal(r.headers['content-type'], STATIC_TYPES[/** @type {keyof typeof STATIC_TYPES} */ (path.extname(n))], n);
  }
  for (const p of ['/src/shared/constants.mjs', '/src/shared/i18n.mjs']) {
    const r = await request(port, { path: p });
    assert.equal(r.status, 200, p);
    assert.match(String(r.headers['content-type']), /text\/javascript/);
  }
});

test('/api/board は 200 の v2 JSON (デモの印つき) で、2 回目は If-None-Match で 304', async () => {
  const r = await request(port, { path: '/api/board' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(String(r.headers['content-type']), /application\/json/);
  const data = JSON.parse(r.body);
  assert.equal(data.v, 2);
  assert.equal(data.stats.demo, true);
  const c = data.counts;
  assert.equal(c.needs_you + c.trouble + c.unread + c.working + c.recent + c.cleanup, c.active);
  for (const k of ['needs_you', 'trouble', 'unread', 'working']) assert.ok(c[k] > 0, `デモには ${k} が 1 件以上ある`);
  for (const k of FORBIDDEN_OUTPUT_KEYS) assert.ok(!r.body.includes(`"${k}"`), k);
  // v0.2: model・command・入力・usage などは JSON に出ない (デモの値は合成なので文字列で調べられる)
  for (const k of FORBIDDEN_WIRE_KEYS) assert.ok(!r.body.includes(`"${k}"`), k);
  assert.ok(!r.body.includes('"reasonText"'), 'v2 は理由の文を送らない');
  // していることとコンテキストは省略可能な追加 (v は 2 のまま)
  const cards = [...Object.values(data.buckets).flat(), ...data.recentGroups.flatMap((/** @type {any} */ g) => g.items)];
  assert.ok(cards.some((/** @type {any} */ c) => c.activity) && cards.some((/** @type {any} */ c) => c.context));
  for (const k of ['contextSeen', 'activitySeen']) assert.ok(Number.isInteger(data.stats[k]) && data.stats[k] > 0, k);
  assert.equal(data.stats.contextSuspect, false);
  const etag = String(r.headers.etag);
  const again = await request(port, { path: '/api/board', headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.body, '');
});

test('別の Host は 403 (DNS rebinding 対策)。localhost は通る', async () => {
  const r = await request(port, { path: '/api/board', headers: { Host: `evil.example:${port}` } });
  assert.equal(r.status, 403);
  assert.equal((await request(port, { headers: { Host: `127.0.0.1:${port + 1}` } })).status, 403);
  const ok = await request(port, { headers: { Host: `localhost:${port}` } });
  assert.equal(ok.status, 200);
});

test('表に無いパス・パストラバーサル・dotfile は 404', async () => {
  const paths = ['/../x', '/..%2f..%2fpackage.json', '/%2e%2e/package.json', '/src/entry/server.mjs', '/src/shared/types.mjs', '/package.json', '/public/index.html', '//etc/passwd', '/.hidden', '/.git/config', '/APP.MJS', '/app.mjs/'];
  for (const p of paths) {
    const r = await request(port, { path: p });
    assert.equal(r.status, 404, p);
  }
});

test('GET 以外は 405 (HEAD も)', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    const r = await request(port, { path: '/api/board', method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, 'GET', method);
  }
});

test('不正なポート・言語・ROOTS・フラグは exit 1 と 1 行の説明', async () => {
  const cases = [
    { args: ['--demo', '--lang', 'en'], env: { PIGEONHOLES_PORT: 'abc' }, re: /^The port must be a number from 1024 to 65535 \(got: abc\)\. Use --port <n> or PIGEONHOLES_PORT\.$/ },
    { args: ['--demo', '--lang', 'ja', '--port', '80'], env: {}, re: /^ポートは 1024〜65535 の数字にしてください \(今: 80\)/ },
    { args: ['--demo', '--lang', 'fr'], env: { LANG: 'ja_JP.UTF-8' }, re: /^--lang と PIGEONHOLES_LANG は en か ja にしてください \(今: fr\)$/ },
    { args: ['--demo'], env: { PIGEONHOLES_LANG: 'xx', LANG: 'en_US.UTF-8' }, re: /^--lang and PIGEONHOLES_LANG must be en or ja \(got: xx\)$/ },
    { args: ['--demo', '--lang', 'en'], env: { PIGEONHOLES_ROOTS: 'relative-dir' }, re: /^PIGEONHOLES_ROOTS must be absolute paths separated by ".+" \(invalid: relative-dir\)$/ },
    { args: ['--demo', '--lang', 'en', '--bogus'], env: {}, re: new RegExp(`^Unknown option: --bogus\\. See: ${LAUNCH} --help$`) },
    { args: ['--lang', 'en', '--port'], env: {}, re: new RegExp(`^--port needs a value\\. See: ${LAUNCH} --help$`) },
    { args: ['--demo'], env: { LC_ALL: 'ja_JP.UTF-8', PIGEONHOLES_PORT: 'abc' }, re: /^ポートは 1024〜65535 の数字にしてください/ },
  ];
  for (const c of cases) {
    const r = await run(c.args, c.env);
    assert.equal(r.code, 1, c.args.join(' '));
    assert.equal(r.out, '', c.args.join(' '));
    assert.equal(lines(r.err).length, 1, r.err);
    assert.match(lines(r.err)[0], c.re);
  }
});

test('セッションフォルダが無ければ exit 1。説明・探した場所・直し方を出す', async () => {
  const missing = path.join(tmp, 'no-such-sessions');
  const r = await run(['--lang', 'en', '--port', String(await freePort()), '--sessions-dir', missing]);
  assert.equal(r.code, 1);
  assert.deepEqual(lines(r.err), [
    "Can't find the Claude desktop app's session folder. Looked in:",
    `  ${missing}`,
    'Start a session once in the Code tab of the Claude desktop app, or pass --sessions-dir <path> (or set PIGEONHOLES_SESSIONS_DIR).',
  ]);
  const env = await run(['--lang', 'ja'], { PIGEONHOLES_SESSIONS_DIR: missing });
  assert.equal(env.code, 1);
  assert.match(lines(env.err)[0], /^Claude デスクトップアプリのセッションフォルダが見つかりません。探した場所:$/);
  assert.equal(lines(env.err)[1], `  ${missing}`);
});

test('フラグは環境変数に勝つ (ポート・言語・デモ)', async () => {
  const p = await freePort();
  const s = start(['--demo', '--port', String(p), '--lang', 'ja'], { env: { PIGEONHOLES_PORT: 'abc', PIGEONHOLES_LANG: 'xx' } });
  try {
    const r = await s.ready;
    assert.equal(r.code, null, r.err);
    assert.equal(lines(r.out)[0], `Pigeonholes: http://127.0.0.1:${p} (デモデータ・読み取り専用)`);
    assert.equal((await request(p, { path: '/api/board' })).status, 200);
  } finally {
    s.child.kill();
  }
});

test('--help と --version は exit 0', async () => {
  const help = await run(['--help', '--lang', 'en']);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, new RegExp(`^Pigeonholes ${VERSION.replaceAll('.', '\\.')}: `));
  assert.match(help.out, new RegExp(`Usage: ${LAUNCH} \\[options\\]`));
  const ja = await run(['-h', '--lang', 'ja']);
  assert.match(ja.out, new RegExp(`使い方: ${LAUNCH} \\[オプション\\]`));
  const v = await run(['--version']);
  assert.equal(v.code, 0);
  assert.equal(v.out.trim(), `pigeonholes ${VERSION}`);
});

test('ポートで同じ種類のボード (ここではデモ) がもう動いていれば、URL と「自分で起動していなければ」の 1 行を出して exit 0', async () => {
  const again = await run(['--demo', '--port', String(port), '--lang', 'en']);
  assert.equal(again.code, 0, again.err);
  const [first, second] = lines(again.out);
  assert.equal(first, `Already running: open http://127.0.0.1:${port}`);
  assert.match(second, new RegExp(`^\\(If you didn't start a board on that port, .+ Start on another port: ${LAUNCH} --demo --lang en --port ${port + 1}\\)$`));
  const ja = await run(['--demo', '--port', String(port), '--lang', 'ja']);
  assert.equal(lines(ja.out)[0], `もう起動しています: http://127.0.0.1:${port} を開いてください`);
});

test('ポートで動いているのがデモなのに実データで起動した (またはその逆) なら、そう言って exit 1 (別の番号の起動例はフラグつき)', async () => {
  const sessions = path.join(tmp, 'sessions-for-mode');
  await fs.mkdir(path.join(sessions, 'acct', 'org'), { recursive: true });
  const live = await run(['--port', String(port), '--lang', 'en', '--sessions-dir', sessions]);
  assert.equal(live.code, 1, live.out);
  assert.equal(live.out, '');
  assert.match(lines(live.err)[0], new RegExp(`^Port ${port} has the demo board, not your sessions\\. .+: ${LAUNCH} --lang en --sessions-dir ['"]?.+sessions-for-mode['"]? --port ${port + 1}$`));

  const p = await freePort();
  const s = start(['--port', String(p), '--lang', 'en', '--sessions-dir', sessions, '--projects-dir', path.join(tmp, 'no-projects')]);
  try {
    assert.equal((await s.ready).code, null);
    const demo = await run(['--demo', '--port', String(p), '--lang', 'en']);
    assert.equal(demo.code, 1, demo.out);
    assert.match(lines(demo.err)[0], new RegExp(`^Port ${p} has a board with your real sessions, not the demo\\. Start the demo on another port: ${LAUNCH} --demo --lang en --port ${p + 1}$`));
  } finally {
    s.child.kill();
  }
});

test('ポートを別のアプリが使っていれば、付けていたフラグのまま次の番号で起動する例を出して exit 1', async () => {
  const other = http.createServer((_req, res) => res.end('<title>another app</title>'));
  const otherPort = await freePort();
  await new Promise((resolve) => other.listen(otherPort, '127.0.0.1', () => resolve(undefined)));
  try {
    const busy = await run(['--demo', '--port', String(otherPort), '--lang', 'en']);
    assert.equal(busy.code, 1);
    assert.deepEqual(lines(busy.err).length, 1, busy.err);
    assert.match(lines(busy.err)[0], new RegExp(`^Port ${otherPort} is used by another app\\. Start on another port: ${LAUNCH} --demo --lang en --port ${otherPort + 1}$`));
  } finally {
    other.close();
  }
});

test('配信表は起動時に public/ から作る: 決まった拡張子の直下のファイルだけ (サブフォルダ・dotfile・他の拡張子は 404)', async () => {
  const pub = path.join(tmp, 'public');
  const shared = path.join(tmp, 'shared');
  await fs.mkdir(path.join(pub, 'sub'), { recursive: true });
  await fs.mkdir(shared, { recursive: true });
  for (const [name, body] of [
    ['index.html', '<meta name="pigeonholes" content="1">'],
    ['new-panel.mjs', 'export {};'],
    ['logo.svg', '<svg/>'],
    ['icon.png', 'png'],
    ['notes.txt', 'no'],
    ['.hidden.css', 'no'],
    ['a b.css', 'no'],
    ['sub/inner.mjs', 'no'],
  ]) {
    await fs.writeFile(path.join(pub, name), body);
  }
  await fs.writeFile(path.join(shared, 'constants.mjs'), 'export {};');
  const table = buildStaticFiles({ publicDir: pub, sharedDir: shared });
  assert.deepEqual([...table.keys()].sort(), ['/', '/icon.png', '/index.html', '/logo.svg', '/new-panel.mjs', '/src/shared/constants.mjs']);

  /** @type {Array<[string, Record<string, unknown>|undefined]>} */
  const logged = [];
  const p = await freePort();
  const handler = createHandler({
    port: p,
    staticFiles: table,
    getBoard: async () => {
      throw new TypeError('synthetic failure: the title must not be logged');
    },
    log: (key, params) => logged.push([key, params]),
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(p, '127.0.0.1', () => resolve(undefined)));
  try {
    const ok = await request(p, { path: '/new-panel.mjs' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await request(p, { path: '/logo.svg' })).headers['content-type'], 'image/svg+xml');
    for (const miss of ['/notes.txt', '/.hidden.css', '/sub/inner.mjs', '/a%20b.css', '/src/shared/i18n.mjs']) assert.equal((await request(p, { path: miss })).status, 404, miss);
    const fail = await request(p, { path: '/api/board' });
    assert.equal(fail.status, 500);
    assert.deepEqual(JSON.parse(fail.body), { error: 'board_failed' });
    assert.deepEqual(logged, [['term.boardFailed', { name: 'TypeError' }]], 'ログはエラーの名前だけ');
  } finally {
    server.close();
  }
});

test('実データの形 (一時フォルダの合成ファイル) を読む: フォルダの .git でプロジェクト名が決まり、folders は出ない', async () => {
  const sessions = path.join(tmp, 'sessions');
  const org = path.join(sessions, 'acct-1', 'org-1');
  const repo = path.join(tmp, 'work', 'my-repo');
  await fs.mkdir(org, { recursive: true });
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main'); // HEAD の無い .git は repo と見なさない
  await fs.mkdir(path.join(repo, 'packages', 'core'), { recursive: true });
  const now = Date.now();
  const id = 'local_00000000-0000-4000-8000-000000000001';
  await fs.writeFile(
    path.join(org, `${id}.json`),
    JSON.stringify({ sessionId: id, title: 'synthetic', cwd: path.join(repo, 'packages', 'core'), originCwd: path.join(repo, 'packages', 'core'), createdAt: now - 7200000, lastActivityAt: now - 3600000, isArchived: false }),
  );
  const p = await freePort();
  const s = start(['--port', String(p), '--lang', 'en', '--sessions-dir', sessions, '--projects-dir', path.join(tmp, 'no-projects')]);
  try {
    const r = await s.ready;
    assert.equal(r.code, null, r.err);
    assert.equal(lines(r.out)[0], `Pigeonholes: http://127.0.0.1:${p} (read-only)`);
    const res = await request(p, { path: '/api/board' });
    assert.equal(res.status, 200);
    const b = JSON.parse(res.body);
    assert.equal(b.v, 2);
    assert.equal(b.stats.demo, false);
    assert.equal(b.stats.transcriptsDirMissing, true);
    assert.equal(b.counts.active, 1);
    const card = [...Object.values(b.buckets).flat(), ...b.recentGroups.flatMap((/** @type {any} */ g) => g.items)][0];
    assert.equal(card.project.label, 'my-repo', 'folder hint (repo) の名前');
    assert.ok(!res.body.includes('"folders"'));
  } finally {
    s.child.kill();
  }
});

test('service: 組織フォルダはあるのにセッションのファイルが 0 件なら formatSuspect = no_session_files', async () => {
  const sessions = path.join(tmp, 'sessions-empty');
  await fs.mkdir(path.join(sessions, 'acct', 'org'), { recursive: true });
  const service = createBoardService({
    sessionsSource: createAppSessionsSource({ root: sessions }),
    transcriptsSource: createFakeTranscriptsSource({}),
    roots: [tmp],
  });
  const b = JSON.parse((await service.get()).body);
  assert.equal(b.stats.formatSuspect, 'no_session_files');
  assert.equal(b.stats.demo, false);
});
