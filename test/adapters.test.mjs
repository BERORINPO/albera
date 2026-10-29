import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createAppSessionsSource } from '../src/adapters/app-sessions-fs.mjs';
import { buildDemo, cid, sid, synth, tails } from '../src/adapters/demo-data.mjs';
import { createFakeAppSessionsSource } from '../src/adapters/fake-app-sessions.mjs';
import { createFakeFolderHints } from '../src/adapters/fake-folder-hints.mjs';
import { createFakeTranscriptsSource } from '../src/adapters/fake-transcripts.mjs';
import { createFolderHints } from '../src/adapters/folder-hints-fs.mjs';
import { attachFolders, cutWorktreeTail, toSessionRecord } from '../src/adapters/session-record.mjs';
import { countFreshJsonl, createTranscriptsSource, newestMtimeUnder } from '../src/adapters/transcripts-fs.mjs';
import { createBoardService, withFolders } from '../src/entry/service.mjs';
import {
  ACTIVITY_KINDS,
  CAP,
  FOLDER_HINT_TTL_MS,
  FORBIDDEN_OUTPUT_KEYS,
  FORBIDDEN_WIRE_KEYS,
  QUIET_MS,
  SUBAGENT_SCAN_DEPTH,
  TAIL_BYTES,
} from '../src/shared/constants.mjs';
import { HOUR, NOW, rec } from './helpers/fixtures.mjs';

/** @type {string} */
let tmp;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'albera-test-'));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const CJK = /[\u3000-\u30ff\u3400-\u9fff\uff01-\uff60]/;

const rawOf = (/** @type {number} */ n, /** @type {Record<string, unknown>} */ f = {}) => ({
  sessionId: sid(n),
  cliSessionId: cid(n),
  title: `合成 ${n}`,
  createdAt: NOW - 2 * HOUR,
  lastActivityAt: NOW - HOUR,
  isArchived: false,
  remoteMcpServersConfig: [{ name: 'x', blob: 'y'.repeat(1000) }],
  ...f,
});

test('app-sessions-fs: 2 階層下の local_*.json と idx を読み、壊れた JSON は数えて飛ばす', async () => {
  const org = path.join(tmp, 'sessions', 'acct-1', 'org-1');
  await fs.mkdir(org, { recursive: true });
  const raws = [rawOf(1, { model: 'claude-opus-4-7[1m]', contextExceededCount: 2 }), rawOf(2, { isArchived: true }), rawOf(3)];
  for (const r of raws) await fs.writeFile(path.join(org, `${r.sessionId}.json`), JSON.stringify(r));
  await fs.writeFile(path.join(org, `${sid(4)}.json`), '{"sessionId": "local_00000000-0000-4000-8000-00000000');
  await fs.writeFile(path.join(org, `${sid(5)}.json`), JSON.stringify({ ...rawOf(5), sessionId: 'local_../evil' }));
  await fs.writeFile(path.join(org, `deleted_${sid(6).slice(6)}`), '');
  await fs.writeFile(path.join(org, 'archived-sessions.idx'), JSON.stringify({ v: 1, archived: [sid(3)] }));

  const src = createAppSessionsSource({ root: path.join(tmp, 'sessions') });
  const r = await src.load();
  assert.deepEqual(r.sessions.map((s) => s.sessionId).sort(), [sid(1), sid(2), sid(3)]);
  assert.deepEqual([...r.archivedIds], [sid(3)]);
  assert.deepEqual(r.stats, { files: 5, parsed: 3, bad: 2, stale: 0, dirs: 1 });
  for (const s of r.sessions) for (const k of FORBIDDEN_OUTPUT_KEYS) assert.equal(k in s, false, k);

  // 書き込み途中で壊れたら、前回の正常な射影を使う (stale)
  await fs.writeFile(path.join(org, `${sid(1)}.json`), '{"sessionId": "local_');
  const r2 = await src.load();
  assert.equal(r2.stats.stale, 1);
  assert.equal(r2.sessions.find((s) => s.sessionId === sid(1))?.title, '合成 1');

  // Fake と同じ射影になる
  const fake = await createFakeAppSessionsSource({ raws, archivedIds: [sid(3)] }).load();
  const byId = (/** @type {any[]} */ a) => [...a].sort((x, y) => (x.sessionId < y.sessionId ? -1 : 1));
  assert.deepEqual(byId(fake.sessions), byId(r.sessions));
});

test('session-record: model は CAP.MODEL まで (… は付けない)、contextExceededCount は 0 以上の整数だけ', () => {
  const r = (/** @type {Record<string, unknown>} */ f) => /** @type {import('../src/shared/types.mjs').SessionRecord} */ (toSessionRecord(rawOf(1, f)));
  assert.equal(r({ model: 'claude-sonnet-4-5' }).model, 'claude-sonnet-4-5');
  assert.equal(r({ model: 'claude-opus-4-7[1m]' }).model, 'claude-opus-4-7[1m]');
  const long = r({ model: 'm'.repeat(CAP.MODEL + 20) }).model;
  assert.equal(long, 'm'.repeat(CAP.MODEL), '切っても「…」は付けない (画面に出ない値)');
  for (const bad of [42, '', null, { id: 'x' }]) assert.equal(r({ model: bad }).model, undefined, String(bad));
  assert.equal(r({ contextExceededCount: 0 }).contextExceededCount, 0);
  assert.equal(r({ contextExceededCount: 3 }).contextExceededCount, 3);
  for (const bad of [-1, 1.5, '2', NaN, Infinity, null]) assert.equal(r({ contextExceededCount: bad }).contextExceededCount, undefined, String(bad));
  assert.equal(r({}).model, undefined);
});

test('app-sessions-fs: フォルダが無くても例外を投げず 0 件。組織フォルダだけあれば dirs > 0 で files 0', async () => {
  const r = await createAppSessionsSource({ root: path.join(tmp, 'nope') }).load();
  assert.deepEqual([r.sessions.length, r.stats.files, r.stats.dirs], [0, 0, 0]);
  await fs.mkdir(path.join(tmp, 'empty-sessions', 'acct', 'org'), { recursive: true });
  const e = await createAppSessionsSource({ root: path.join(tmp, 'empty-sessions') }).load();
  assert.deepEqual([e.stats.files, e.stats.dirs], [0, 1], 'formatSuspect の no_session_files の材料');
});

test('transcripts-fs: ファイル名から場所を引き、末尾と mtime と subagents の新しさを返す (Fake と一致)', async () => {
  const projects = path.join(tmp, 'projects');
  const dir = path.join(projects, '-home-tester-alpha');
  await fs.mkdir(path.join(dir, cid(1), 'subagents', 'workflows'), { recursive: true });
  const tail = tails.ended();
  const file = path.join(dir, `${cid(1)}.jsonl`);
  await fs.writeFile(file, tail);
  const mainT = new Date(NOW - HOUR);
  await fs.utimes(file, mainT, mainT);
  const sub = path.join(dir, cid(1), 'subagents', 'workflows', 'agent-1.jsonl');
  await fs.writeFile(sub, synth.toolUse());
  const subT = new Date(NOW - 60 * 1000);
  await fs.utimes(sub, subT, subT);
  await fs.writeFile(path.join(dir, 'not-a-session.jsonl'), 'x');

  const src = createTranscriptsSource({ projectsDir: projects, clock: () => NOW });
  const before = (await fs.stat(file)).mtimeMs;
  const m = await src.read([cid(1), cid(2)]);
  assert.deepEqual([...m.keys()], [cid(1)]);
  const got = /** @type {any} */ (m.get(cid(1)));
  assert.equal(got.tail, tail);
  assert.equal(got.truncatedHead, false);
  assert.equal(Math.round(got.mainMtime), Math.round(mainT.getTime()));
  assert.equal(Math.round(got.subMtime), Math.round(subT.getTime()));
  assert.equal(got.subLive, 1, 'QUIET_MS 以内に書かれた subagent の *.jsonl が 1 つ');
  assert.equal((await fs.stat(file)).mtimeMs, before, '読んでも mtime は変わらない');
  assert.deepEqual(src.stats(), { dirMissing: false, indexed: 1 });

  const fake = createFakeTranscriptsSource({ [cid(1)]: got });
  assert.deepEqual((await fake.read([cid(1), cid(2)])).get(cid(1)), got);
  // subLive の無い合成データは 0 (fs 版は必ず数を返す)
  const { subLive, ...withoutLive } = got;
  assert.equal(subLive, 1);
  assert.equal(/** @type {any} */ ((await createFakeTranscriptsSource({ [cid(1)]: withoutLive }).read([cid(1)])).get(cid(1))).subLive, 0);
});

/**
 * fs.open と fs.readFile を数える (ファイルの中身を開いたかどうか)。stat と readdir は数えない。
 * @template T @param {() => Promise<T>} fn @returns {Promise<{result: T, opened: string[]}>}
 */
async function countingOpens(fn) {
  /** @type {string[]} */
  const opened = [];
  const { open, readFile } = fs;
  fs.open = /** @type {any} */ ((/** @type {any} */ p, /** @type {any[]} */ ...rest) => (opened.push(String(p)), open(p, ...rest)));
  fs.readFile = /** @type {any} */ ((/** @type {any} */ p, /** @type {any[]} */ ...rest) => (opened.push(String(p)), readFile(p, ...rest)));
  try {
    return { result: await fn(), opened };
  } finally {
    fs.open = open;
    fs.readFile = readFile;
  }
}

test('transcripts-fs: subLive は QUIET_MS 以内の *.jsonl だけを数え (meta の .json と古いもの・深すぎるものは数えない)、ファイルを開かない', async () => {
  const projects = path.join(tmp, 'projects-live');
  const dir = path.join(projects, '-home-tester-live');
  const subs = path.join(dir, cid(3), 'subagents');
  const now = Date.now();
  const put = async (/** @type {string} */ rel, /** @type {number} */ ago) => {
    const f = path.join(subs, rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, '{"type":"assistant"}\n');
    const at = new Date(now - ago);
    await fs.utimes(f, at, at);
  };
  await put('agent-a.jsonl', 30 * 1000);
  await put('agent-a.meta.json', 30 * 1000);
  await put('agent-b.jsonl', QUIET_MS + 60 * 1000); // 終わった subagent
  await put('workflows/wf_1/agent-c.jsonl', 2 * 60 * 1000);
  await put('workflows/wf_1/agent-c.meta.json', 10 * 1000);
  // SUBAGENT_SCAN_DEPTH (4) より深いものは見ない
  const deep = Array.from({ length: SUBAGENT_SCAN_DEPTH }, (_, i) => `d${i}`).join('/');
  await put(`${deep}/at-the-limit.jsonl`, 10 * 1000);
  await put(`${deep}/d9/too-deep.jsonl`, 10 * 1000);
  const main = path.join(dir, `${cid(3)}.jsonl`);
  await fs.writeFile(main, tails.ended());
  const mainAt = new Date(now - HOUR);
  await fs.utimes(main, mainAt, mainAt);

  const counted = await countingOpens(() => countFreshJsonl(subs, now - QUIET_MS));
  assert.equal(counted.result, 3, 'agent-a・agent-c・上限ちょうどの深さの 1 つ');
  assert.deepEqual(counted.opened, [], 'stat だけで数える (中身も meta の .json も開かない)');

  const src = createTranscriptsSource({ projectsDir: projects, clock: () => now });
  const read = await countingOpens(() => src.read([cid(3)]));
  const got = /** @type {any} */ (read.result.get(cid(3)));
  assert.equal(got.subLive, 3);
  assert.deepEqual(read.opened.map((p) => path.basename(p)), [`${cid(3)}.jsonl`], '開くのは本体の末尾だけ');

  // subagents の最後の書き込みが QUIET_MS より前なら数えない (stat も増やさない)
  const later = createTranscriptsSource({ projectsDir: projects, clock: () => now + QUIET_MS + 60 * 1000 });
  assert.equal(/** @type {any} */ ((await later.read([cid(3)])).get(cid(3))).subLive, 0);
});

test('transcripts-fs: 末尾 200KB に完全な行が無ければ 2MB で 1 回だけ読み直す', async () => {
  const projects = path.join(tmp, 'projects-big');
  const dir = path.join(projects, '-home-tester-beta');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${cid(9)}.jsonl`);
  await fs.writeFile(file, [synth.prompt('始めて'), synth.text('y'.repeat(300 * 1024)), ''].join('\n'));
  const m = await createTranscriptsSource({ projectsDir: projects }).read([cid(9)]);
  const got = /** @type {any} */ (m.get(cid(9)));
  assert.equal(got.truncatedHead, false, 'ファイル全体 (2MB 以下) を読み直している');
  assert.ok(got.tail.length > 300 * 1024);
});

test('transcripts-fs: 末尾 200KB に行はあるが実際の usage 行が無ければ、{path,size,mtimeMs} ごとに 1 回だけ 2MB で読み直す', async () => {
  const projects = path.join(tmp, 'projects-usage');
  const dir = path.join(projects, '-home-tester-gamma');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${cid(10)}.jsonl`);
  const usageLine = JSON.stringify({ type: 'assistant', message: { id: 'msg_x', role: 'assistant', model: 'claude-opus-4-7', stop_reason: 'tool_use',
    usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 40000, output_tokens: 10 },
    content: [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: { file_path: '/synthetic/a.txt' } }] } });
  // usage の後に大きなツール結果が続き、最後の usage 行が末尾 200KB の外に出る (該当行は 200KB の中にもある)
  const result = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'r'.repeat(10 * 1024) }] } });
  await fs.writeFile(file, [synth.prompt('go'), usageLine, ...Array.from({ length: 30 }, () => result), ''].join('\n'));
  assert.ok((await fs.stat(file)).size > TAIL_BYTES + 50 * 1024);
  const src = createTranscriptsSource({ projectsDir: projects });
  const first = await countingOpens(() => src.read([cid(10)]));
  const got = /** @type {any} */ (first.result.get(cid(10)));
  assert.equal(got.truncatedHead, false, 'ファイル全体 (2MB 以下) を読み直した');
  assert.ok(got.tail.includes('"usage"'));
  assert.equal(first.opened.length, 2, '200KB と 2MB の 2 回');
  const again = await countingOpens(() => src.read([cid(10)]));
  assert.deepEqual(again.opened, [], '同じ {path,size,mtimeMs} はキャッシュ (毎回 2MB を読まない)');
  assert.equal(/** @type {any} */ (again.result.get(cid(10))).tail, got.tail);
  await fs.appendFile(file, result + '\n');
  const changed = await countingOpens(() => src.read([cid(10)]));
  assert.equal(changed.opened.length, 2, 'ファイルが変われば、また 1 回だけ読み直す');

  // usage 行が末尾 200KB の中にあれば読み直さない
  const fileOk = path.join(dir, `${cid(11)}.jsonl`);
  await fs.writeFile(fileOk, [synth.prompt('go'), ...Array.from({ length: 30 }, () => result), usageLine, ''].join('\n'));
  const ok = await countingOpens(() => createTranscriptsSource({ projectsDir: projects }).read([cid(11)]));
  assert.equal(/** @type {any} */ (ok.result.get(cid(11))).truncatedHead, true);
  assert.equal(ok.opened.length, 1);
});

test('transcripts-fs: subagents は新しいフォルダから見るので、件数の上限に達しても動いているワークフローを見落とさない', async () => {
  const sub = path.join(tmp, 'subcap', 'subagents');
  const wf = path.join(sub, 'workflows');
  const old = new Date(Date.now() - 3 * HOUR);
  // 名前順では後ろに来る、終わった古いワークフロー 60 個 (35 ファイルずつ = 上限 2000 を超える)
  for (let w = 0; w < 60; w++) {
    const d = path.join(wf, 'wf_b' + String(w).padStart(3, '0'));
    await fs.mkdir(d, { recursive: true });
    await Promise.all(
      Array.from({ length: 35 }, async (_, i) => {
        const f = path.join(d, `agent-${i}.jsonl`);
        await fs.writeFile(f, '{}');
        await fs.utimes(f, old, old);
      }),
    );
    await fs.utimes(d, old, old);
  }
  // 名前順では先頭に来る、いま書いているワークフロー
  await fs.mkdir(path.join(wf, 'wf_a000'));
  await fs.writeFile(path.join(wf, 'wf_a000', 'agent-live.jsonl'), '{}');
  const m = await newestMtimeUnder(sub);
  assert.ok(Date.now() - m < 60 * 1000, `いまのファイルを拾う (${Math.round((Date.now() - m) / 60000)} 分前を返した)`);
  assert.equal(await countFreshJsonl(sub, Date.now() - QUIET_MS), 1, 'subLive も件数の上限の中で、いま書いているものを数える');
  // stopAbove より新しいファイルが見つかれば打ち切ってよい (結果はそれ以上新しい)
  const stop = Date.now() - 10 * 60 * 1000;
  assert.ok((await newestMtimeUnder(sub, stop)) > stop);
});

test('transcripts-fs: 表を作ったあとに始まったセッションも、TTL を待たずに見つける', async () => {
  const projects = path.join(tmp, 'projects-new');
  const dir = path.join(projects, '-home-tester');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${cid(1)}.jsonl`), tails.ended());
  let t = NOW;
  const src = createTranscriptsSource({ projectsDir: projects, clock: () => t });
  await src.read([cid(1)]);
  await fs.writeFile(path.join(dir, `${cid(2)}.jsonl`), tails.tool());
  t = NOW + 1000; // 1 秒後は作り直さない (毎回の作り直しを防ぐ)
  assert.equal((await src.read([cid(1), cid(2)])).has(cid(2)), false);
  t = NOW + 5000; // 数秒たてば作り直す (TTL の 30 秒は待たない)
  assert.equal((await src.read([cid(1), cid(2)])).has(cid(2)), true);
});

test('transcripts-fs: projects フォルダが無ければ dirMissing', async () => {
  const src = createTranscriptsSource({ projectsDir: path.join(tmp, 'missing') });
  assert.equal((await src.read([cid(1)])).size, 0);
  assert.equal(src.stats().dirMissing, true);
});

// --- folder hints ---------------------------------------------------------------------------

/**
 * 一時フォルダに合成の home を作る (home = 一時フォルダ自体。上へたどるのは home で止まるので、外の実フォルダは見ない)。
 * @returns {Promise<string>}
 */
async function makeHome() {
  const home = path.join(tmp, 'home');
  const mk = (/** @type {string} */ ...p) => fs.mkdir(path.join(home, ...p), { recursive: true });
  const file = (/** @type {string} */ p, body = 'gitdir: elsewhere') => fs.writeFile(path.join(home, p), body);
  // 本物の repo の .git フォルダには HEAD がある
  const repoAt = async (/** @type {string} */ ...p) => {
    await mk(...p, '.git');
    await fs.writeFile(path.join(home, ...p, '.git', 'HEAD'), 'ref: refs/heads/main');
  };
  await repoAt(); // dotfiles の repo が home にあっても、home は repo にしない
  await repoAt('projects', 'demo-app');
  await mk('projects', 'demo-app', 'src', 'deep');
  await mk('projects', 'demo-app', '.claude', 'worktrees', 'fix-login');
  await file('projects/demo-app/.claude/worktrees/fix-login/.git'); // worktree の .git はファイル
  await mk('projects', 'site');
  await file('projects/site/.git');
  await mk('projects', 'notes');
  await mk('Desktop');
  await repoAt('work', 'one');
  await mk('work', 'plain');
  await repoAt('work', 'two', 'a');
  await repoAt('work', 'two', 'b');
  await repoAt('work', 'dots', '.x'); // dotfile の子は数えない
  await repoAt('work', 'dots', '.y');
  // HEAD の無い壊れた .git が残ったまとめフォルダ (直下に本物の repo が 2 つ)
  await mk('dev', '.git', 'info');
  await repoAt('dev', 'alpha');
  await repoAt('dev', 'beta');
  await mk('dev', 'loose');
  await mk('projects', 'demo-app', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i');
  return home;
}

test('folder-hints-fs: .git を上へ探して repo、まとめフォルダは container、それ以外と消えたパスは手掛かりなし', async () => {
  const home = await makeHome();
  const hints = createFolderHints({ home });
  const at = (/** @type {string} */ ...p) => path.join(home, ...p);
  const repo = (/** @type {string} */ name) => ({ kind: 'repo', name });
  const container = { kind: 'container' };

  assert.deepEqual(await hints.hintFor(at('projects', 'demo-app')), repo('demo-app'));
  assert.deepEqual(await hints.hintFor(at('projects', 'demo-app', 'src', 'deep')), repo('demo-app'), '上へたどる');
  assert.deepEqual(await hints.hintFor(at('projects', 'site')), repo('site'), '.git がファイルでもよい');
  // worktree の中の .git ではなく、本体の repo の名前 (区切りは \ でも / でも)
  const wt = at('projects', 'demo-app', '.claude', 'worktrees', 'fix-login');
  assert.deepEqual(await hints.hintFor(wt), repo('demo-app'));
  assert.deepEqual(await hints.hintFor(wt.replaceAll('\\', '/') + '/'), repo('demo-app'));
  assert.deepEqual(await hints.hintFor(path.join(wt, 'sub')), repo('demo-app'));
  // 上へは FOLDER_WALK_MAX (8) 階層まで
  assert.deepEqual(await hints.hintFor(at('projects', 'demo-app', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')), repo('demo-app'), 'ちょうど 8 階層上');
  assert.equal(await hints.hintFor(at('projects', 'demo-app', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i')), undefined, '9 階層上は見ない');

  assert.deepEqual(await hints.hintFor(home), container, 'home そのもの (home の .git では repo にしない)');
  assert.deepEqual(await hints.hintFor(at('projects')), container, '直下に repo が 2 つ');
  assert.deepEqual(await hints.hintFor(at('work', 'two')), container);
  assert.equal(await hints.hintFor(at('work')), undefined, '直下の repo が 1 つだけ');
  assert.deepEqual(await hints.hintFor(at('dev')), container, 'HEAD の無い .git は repo と見なさない');
  assert.equal(await hints.hintFor(at('dev', 'loose')), undefined, '壊れた .git を上にたどって拾わない');
  assert.deepEqual(await hints.hintFor(at('dev', 'alpha')), repo('alpha'));
  assert.equal(await hints.hintFor(at('work', 'dots')), undefined, 'dotfile の子は数えない');
  assert.equal(await hints.hintFor(at('projects', 'notes')), undefined, 'home で止まるので home の .git は拾わない');
  assert.equal(await hints.hintFor(at('Desktop')), undefined);
  assert.equal(await hints.hintFor(at('gone')), undefined, 'もう無いパス');
  assert.equal(await hints.hintFor(path.join(at('projects', 'site'), '.git')), undefined, 'フォルダでないパス');
  assert.equal(await hints.hintFor('relative/path'), undefined);
  assert.equal(await hints.hintFor(''), undefined);
  assert.equal(await hints.hintFor(/** @type {any} */ (undefined)), undefined);
});

test('folder-hints-fs: パスごとに TTL だけキャッシュし、件数の上限を超えたら古いものから捨てる', async () => {
  const home = path.join(tmp, 'home-cache');
  await fs.mkdir(path.join(home, 'later'), { recursive: true });
  await fs.mkdir(path.join(home, 'x'), { recursive: true });
  await fs.mkdir(path.join(home, 'y'), { recursive: true });
  let now = NOW;
  const hints = createFolderHints({ home, clock: () => now, maxEntries: 2 });
  const later = path.join(home, 'later');
  assert.equal(await hints.hintFor(later), undefined);
  await fs.mkdir(path.join(later, '.git'));
  await fs.writeFile(path.join(later, '.git', 'HEAD'), 'ref: refs/heads/main');
  now += FOLDER_HINT_TTL_MS - 1;
  assert.equal(await hints.hintFor(later), undefined, 'TTL の間は前の結果');
  now += 2;
  assert.deepEqual(await hints.hintFor(later), { kind: 'repo', name: 'later' }, 'TTL が過ぎたら見直す');
  await hints.hintFor(path.join(home, 'x'));
  await hints.hintFor(path.join(home, 'y'));
  assert.equal(hints.size(), 2);
});

test('folder-hints-fs: ネットワークのパスは見ない (SMB の接続を作らない)。判定は待ち時間で打ち切る', async () => {
  const home = path.join(tmp, 'home-network');
  await fs.mkdir(home, { recursive: true });
  const hints = createFolderHints({ home });
  for (const p of ['\\\\192.0.2.1\\share\\proj', '//192.0.2.1/share/proj', '\\\\?\\UNC\\192.0.2.1\\share']) {
    assert.equal(await hints.hintFor(p), undefined, p);
  }
  assert.equal(hints.size(), 0, 'ネットワークのパスは判定もキャッシュもしない');
  // 待ち時間がすぐ終わる設定: fs の結果を待たずに手掛かりなし
  await fs.mkdir(path.join(home, 'repo', '.git'), { recursive: true });
  await fs.writeFile(path.join(home, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main');
  const quick = createFolderHints({ home, wait: async () => undefined });
  assert.equal(await quick.hintFor(path.join(home, 'repo')), undefined, '待ち時間で打ち切る');
  assert.deepEqual(await hints.hintFor(path.join(home, 'repo')), { kind: 'repo', name: 'repo' }, 'ふだんは結果を待つ');
});

test('withFolders: アーカイブしていないセッションのフォルダだけを見る', async () => {
  /** @type {string[]} */
  const asked = [];
  const hints = { hintFor: async (/** @type {string} */ p) => (asked.push(p), { kind: /** @type {const} */ ('repo'), name: 'app' }) };
  const sessions = [rec(1, { cwd: '/w/live', originCwd: '/w/live' }), rec(2, { cwd: '/w/archived', originCwd: '/w/archived', isArchived: true }), rec(3, { cwd: '/w/idx', originCwd: '/w/idx' })];
  const out = await withFolders({ sessions, archivedIds: new Set([sessions[2].sessionId]) }, hints);
  assert.deepEqual(asked, ['/w/live']);
  assert.deepEqual(out.map((s) => s.sessionId), sessions.map((s) => s.sessionId), '順と件数はそのまま');
  assert.deepEqual(out[0].folders, { origin: { kind: 'repo', name: 'app' }, cwd: { kind: 'repo', name: 'app' } });
  assert.equal('folders' in out[1], false);
});

test('fake-folder-hints: 合成の表を引く。worktree の切り落としと末尾の区切りは fs 版と同じ', async () => {
  const fake = createFakeFolderHints({ '~/projects/demo-app': { kind: 'repo', name: 'demo-app' }, '~': { kind: 'container' } });
  assert.deepEqual(await fake.hintFor('~/projects/demo-app/.claude/worktrees/fix-login'), { kind: 'repo', name: 'demo-app' });
  assert.deepEqual(await fake.hintFor('~/projects/demo-app/'), { kind: 'repo', name: 'demo-app' });
  assert.deepEqual(await fake.hintFor('~'), { kind: 'container' });
  assert.equal(await fake.hintFor('~/elsewhere'), undefined);
  assert.equal(cutWorktreeTail('C:\\work\\app\\.claude\\worktrees\\x'), 'C:\\work\\app');
  assert.equal(cutWorktreeTail('/home/t/app/.claude/worktrees/x/sub'), '/home/t/app');
  assert.equal(cutWorktreeTail('/home/t/app'), '/home/t/app');
});

test('attachFolders: 同じパスは 1 回だけ引き、新しいレコードに folders を付ける (元は変えない。例外は手掛かりなし)', async () => {
  const recs = [
    toSessionRecord(rawOf(1, { originCwd: '/w/app', cwd: '/w/app/.claude/worktrees/x' })),
    toSessionRecord(rawOf(2, { originCwd: '/w/app', cwd: '/w/app' })),
    toSessionRecord(rawOf(3, { originCwd: '/w/boom', cwd: '' })),
    toSessionRecord(rawOf(4)),
  ].map((r) => /** @type {import('../src/shared/types.mjs').SessionRecord} */ (r));
  const snapshot = JSON.stringify(recs);
  /** @type {string[]} */
  const asked = [];
  const fake = createFakeFolderHints({ '/w/app': { kind: 'repo', name: 'app' } });
  const out = await attachFolders(recs, async (p) => {
    asked.push(p);
    if (p === '/w/boom') throw new Error('boom');
    return fake.hintFor(p);
  });
  assert.deepEqual(asked.sort(), ['/w/app', '/w/app/.claude/worktrees/x', '/w/boom']);
  assert.equal(JSON.stringify(recs), snapshot, '元のレコードは変えない');
  assert.deepEqual(out[0].folders, { origin: { kind: 'repo', name: 'app' }, cwd: { kind: 'repo', name: 'app' } });
  assert.deepEqual(out[1].folders, { origin: { kind: 'repo', name: 'app' }, cwd: { kind: 'repo', name: 'app' } });
  assert.equal('folders' in out[2], false, '引けなかったパスは手掛かりなし');
  assert.equal(out[3], recs[3], 'パスの無いレコードはそのまま');
});

// --- demo data ------------------------------------------------------------------------------

test('demo-data: zh も en と同じ形で、中身は中国語 (仮名を含まない)', () => {
  const en = buildDemo(NOW, 'en');
  const zh = buildDemo(NOW, 'zh');
  assert.deepEqual(zh.raws.map((r) => r.sessionId), en.raws.map((r) => r.sessionId));
  assert.deepEqual([...zh.transcripts.keys()], [...en.transcripts.keys()]);
  assert.deepEqual(zh.archivedIds, en.archivedIds);
  assert.notDeepEqual(zh.raws, en.raws);
  for (const r of zh.raws) if (typeof r.title === 'string') assert.doesNotMatch(r.title, /[぀-ヿ]/, `zh の題名に仮名: ${r.title}`);
  assert.ok(zh.raws.every((r) => /[一-鿿]/.test(String(r.title))), 'zh の題名はすべて漢字を含む');
});

test('demo-data: en と ja は同じ形で、パスは POSIX の ~ 形式、en の中身に日本語は無い', () => {
  const en = buildDemo(NOW, 'en');
  const ja = buildDemo(NOW, 'ja');
  assert.deepEqual(en.raws.map((r) => r.sessionId), ja.raws.map((r) => r.sessionId));
  assert.deepEqual([...en.transcripts.keys()], [...ja.transcripts.keys()]);
  assert.deepEqual(en.archivedIds, ja.archivedIds);
  assert.deepEqual(buildDemo(NOW, 'fr').raws, en.raws, '知らない言語は en');
  for (const r of en.raws) {
    for (const k of ['cwd', 'originCwd']) {
      const p = /** @type {string} */ (r[k]);
      assert.ok(p === '' || /^~(\/[a-z0-9.-]+)*$/.test(p), `${k}: ${p}`);
    }
    for (const [k, v] of Object.entries(r)) if (typeof v === 'string') assert.doesNotMatch(v, CJK, `en の ${k}`);
    assert.doesNotMatch(JSON.stringify(r.postTurnSummary ?? {}) + JSON.stringify(r.turnWrapUp ?? {}), CJK);
  }
  assert.ok(ja.raws.filter((r) => CJK.test(String(r.title))).length > 40, 'ja の題名は日本語');
  for (const k of Object.keys(en.folderHints)) assert.match(k, /^~(\/[a-z0-9.-]+)*$/);
  const tailsText = [...en.transcripts.values()].map((v) => v.tail).join('\n');
  assert.match(tailsText, /"name":"ExitPlanMode"/);
  assert.match(tailsText, /"name":"AskUserQuestion"/);
  assert.doesNotMatch(tailsText, CJK, 'en の会話ログに日本語は無い');
  assert.match([...ja.transcripts.values()].map((v) => v.tail).join('\n'), CJK, 'ja の会話ログ (指示・説明・計画) は日本語');
  // 指示の行には timestamp がある (startedAt の材料)
  const prompts = tailsText.split('\n').filter((l) => l.startsWith('{"type":"user"') && /"content":"[^<]/.test(l));
  assert.ok(prompts.length > 10);
  for (const l of prompts) assert.ok(Number.isFinite(Date.parse(JSON.parse(l).timestamp)), l.slice(0, 80));
});

test('synth / tails: 時刻を渡したときだけ timestamp を付ける (既定の出力は変えない)', () => {
  assert.equal(synth.prompt('go'), '{"type":"user","message":{"role":"user","content":"go"}}');
  assert.equal(JSON.parse(synth.prompt('go', NOW)).timestamp, new Date(NOW).toISOString());
  const lines = tails.toolResult({ start: NOW - HOUR, end: NOW }).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.timestamp), [new Date(NOW - HOUR).toISOString(), new Date(NOW).toISOString(), new Date(NOW).toISOString()]);
  assert.doesNotMatch(tails.ended(), /timestamp/);
});

test('demo-data: 盤面にすると各欄の件数と、作業中の startedAt・家族・プロジェクトがそろう', async () => {
  for (const lang of ['en', 'ja']) {
    const demo = buildDemo(NOW, lang);
    const service = createBoardService({
      sessionsSource: createFakeAppSessionsSource({ raws: demo.raws, archivedIds: demo.archivedIds }),
      transcriptsSource: createFakeTranscriptsSource(demo.transcripts),
      folderHints: createFakeFolderHints(demo.folderHints),
      roots: ['/home/tester'],
      demo: true,
      clock: () => NOW,
    });
    const { body } = await service.get();
    const b = JSON.parse(body);
    assert.deepEqual(b.counts, { needs_you: 4, trouble: 3, unread: 3, working: 5, recent: 7, cleanup: 35, recommended: 28, active: 57, archived: 3 }, lang);
    assert.equal(b.stats.demo, true);
    assert.equal(b.stats.formatSuspect, null);
    for (const k of FORBIDDEN_OUTPUT_KEYS) assert.ok(!body.includes(`"${k}"`), k);
    const reasons = (/** @type {string} */ k) => b.buckets[k].map((/** @type {any} */ c) => c.reason).sort();
    assert.deepEqual(reasons('needs_you'), ['asking', 'asking', 'asks', 'asks']);
    assert.deepEqual(b.buckets.needs_you.map((/** @type {any} */ c) => c.reasonParams?.ask).filter(Boolean).sort(), ['plan', 'question']);
    assert.deepEqual(reasons('trouble'), ['git_startup', 'limit', 'stalled']);
    assert.deepEqual(reasons('working'), ['background', 'turn', 'turn', 'turn', 'turn']);
    const running = b.buckets.working.filter((/** @type {any} */ c) => c.startedAt).map((/** @type {any} */ c) => Math.round((NOW - c.startedAt) / 60000));
    assert.deepEqual(running.sort((/** @type {number} */ x, /** @type {number} */ y) => x - y), [0, 2, 6, 23]);
    assert.ok(b.buckets.unread.some((/** @type {any} */ c) => c.prs.length > 0) && b.buckets.unread.some((/** @type {any} */ c) => c.routine));
    assert.deepEqual(b.recentGroups.map((/** @type {any} */ g) => g.label).sort(), ['demo-app', 'notes', 'site', null].sort());
    assert.deepEqual(b.cleanupGroups.map((/** @type {any} */ g) => g.count), [1, 4, 1, 1, 1, 25, 2]);
    assert.ok(Object.values(b.families).some((/** @type {any} */ f) => f.memberIds.length === 4));
  }
});

/** すべてのカード (片付け候補を含む)。 @param {any} b @returns {any[]} */
const allCards = (b) => [
  ...Object.values(b.buckets).flat(),
  ...b.recentGroups.flatMap((/** @type {any} */ g) => g.items),
  ...b.cleanupGroups.flatMap((/** @type {any} */ g) => [...(g.items ?? []), ...(g.projects ?? []).flatMap((/** @type {any} */ p) => p.items)]),
];

/** JSON の木のすべてのキーと、prs[] の要素の外にある 'state' の数。 @param {unknown} root */
function wireKeys(root) {
  /** @type {Set<string>} */
  const keys = new Set();
  let stateOutside = 0;
  /** @param {unknown} v @param {boolean} inPr */
  const walk = (v, inPr) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, false));
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      keys.add(k);
      if (k === 'state' && !inPr) stateOutside++;
      if (k === 'prs' && Array.isArray(x)) x.forEach((pr) => walk(pr, true));
      else walk(x, false);
    }
  };
  walk(root, false);
  return { keys, stateOutside };
}

test('demo-data (v0.2): していることの 15 種類・コンテキストの段階・要約の直後・200K の窓・Claude の短い言葉が全部出る', async () => {
  for (const lang of ['en', 'ja']) {
    const demo = buildDemo(NOW, lang);
    const models = demo.raws.map((r) => String(r.model));
    assert.ok(models.some((m) => m.endsWith('[1m]')) && models.some((m) => !m.endsWith('[1m]')), 'model は [1m] 付きと無し');
    const service = createBoardService({
      sessionsSource: createFakeAppSessionsSource({ raws: demo.raws, archivedIds: demo.archivedIds }),
      transcriptsSource: createFakeTranscriptsSource(demo.transcripts),
      folderHints: createFakeFolderHints(demo.folderHints),
      roots: ['/home/tester'],
      demo: true,
      clock: () => NOW,
    });
    const { body } = await service.get();
    const b = JSON.parse(body);
    const wire = wireKeys(b);
    for (const k of [...FORBIDDEN_WIRE_KEYS, ...FORBIDDEN_OUTPUT_KEYS]) assert.equal(wire.keys.has(k), false, `${lang}: ${k}`);
    assert.equal(wire.stateOutside, 0, `${lang}: state は prs[] の中だけ`);
    // 会話ログのパス・コマンドの全体・URL・ID は JSON に出ない (basename・commandHead・ホストだけ)
    for (const raw of ['src/search-box.mjs', 'reports/weekly.csv', '--oneline', 'weekly-report', '~/projects/notes/inbox.md', 'toolu_', 'msg_demo']) {
      assert.ok(!body.includes(raw), `${lang}: ${raw}`);
    }
    assert.equal(b.stats.contextSuspect, false);
    assert.equal(b.stats.contextSeen, b.stats.recentWithTranscript, 'usage 行の無い最近の会話ログは無い');
    assert.ok(b.stats.activitySeen > 15);

    const cards = allCards(b);
    const by = (/** @type {number} */ n) => cards.find((c) => c.id === sid(n));
    const acts = cards.filter((c) => c.activity);
    assert.deepEqual([...new Set(acts.map((c) => c.activity.kind))].sort(), [...ACTIVITY_KINDS].sort(), `${lang}: 15 種類が全部出る`);
    const working = b.buckets.working;
    assert.equal(new Set(working.map((/** @type {any} */ c) => c.activity?.kind)).size, working.length, '作業中はそれぞれ違う種類');
    for (const k of ['edit', 'test', 'git', 'agents', 'think']) assert.ok(working.some((/** @type {any} */ c) => c.activity?.kind === k), `作業中に ${k}`);
    assert.ok(working.every((/** @type {any} */ c) => c.activity.live === true));
    assert.equal(by(9).activity.n, 2, 'バックグラウンドの subagent 2 件');
    const tested = by(71).activity;
    assert.equal(tested.target, 'npm test');
    assert.equal(tested.note, lang === 'ja' ? '単体テストを実行' : 'Run the unit tests', 'Bash の説明 (Claude 自身の言葉)');
    assert.equal(tested.step, lang === 'ja' ? 'パーサーのテストを書く' : 'Write tests for the parser', '計画の手順 (items → advance)');
    assert.equal(by(10).activity.kind, 'plan');
    assert.ok(by(10).activity.step, 'TodoWrite の進行中の項目');
    assert.ok(!by(15).activity.note.includes('~/'), '説明の中の絶対パスは basename になる');
    // 止まったかもの古い tool_use (「時点」の表示の材料)
    const stalled = by(3);
    assert.equal(stalled.bucket, 'trouble');
    assert.equal(stalled.activity.live, false);
    assert.ok(NOW - stalled.activity.at >= 3 * HOUR, '3 時間前のツール');
    assert.equal(stalled.detail.contextExceeded, 1);
    assert.ok(b.buckets.needs_you.every((/** @type {any} */ c) => !c.activity), '返事待ちには付かない');
    assert.ok(cards.filter((c) => c.bucket === 'cleanup').every((c) => !c.activity && !c.context && c.detail.contextExceeded == null), '片付けには付かない');

    // コンテキスト: 段階 (notice・due・soon)、窓 (1M・200K、推定と確定)、要約の直後、tail から学んだ要約点
    const ctx = (/** @type {number} */ n) => by(n).context;
    assert.equal(ctx(8).level, 'notice', '作業中に notice');
    assert.deepEqual([ctx(9).level, by(9).bucket], ['due', 'working'], '作業中に due (終わってから引き継ぐ)');
    assert.deepEqual([ctx(6).pct, ctx(6).level, by(6).bucket], [82, 'due', 'unread'], '未読に due (約 82%)');
    assert.deepEqual([ctx(4).pct, ctx(4).level], [85, 'due']);
    assert.deepEqual([ctx(10).pct, ctx(10).level, by(10).bucket], [92, 'soon', 'recent'], '最近に soon');
    assert.deepEqual([ctx(15).window, ctx(15).inferred], [200_000, true], '200K の窓 (推定)');
    assert.deepEqual([ctx(6).window, ctx(6).inferred], [1_000_000, false], '[1m] 付きは 1M (確定)');
    assert.deepEqual([ctx(71).window, ctx(71).inferred], [1_000_000, true], '系列の表で 1M (推定)');
    const just = ctx(72);
    assert.deepEqual([just.used, just.level, just.compacted?.trigger], [38_000, undefined, 'manual'], '要約の直後: 量は要約の後の数、段階なし');
    assert.ok(NOW - just.compacted.at < HOUR);
    assert.equal(by(72).activity.kind, 'think');
    assert.deepEqual([ctx(14).compactAt, ctx(14).compacted?.trigger], [965_000, 'auto'], '自動要約の preTokens から要約点を学ぶ');
    const levels = new Set(cards.map((c) => c.context?.level).filter(Boolean));
    assert.deepEqual([...levels].sort(), ['due', 'notice', 'soon']);
    // キャンバスで密度の違いが見えるように、名前のあるプロジェクトが 4 つ以上
    const projects = new Set(cards.map((c) => c.project.label).filter(Boolean));
    assert.ok(projects.size >= 4, [...projects].join());
  }
});

test('transcripts-fs: subLive は本体の最後の書き込みより後の subagent だけ (結果を返し終えた subagent は数えない)', async () => {
  const projects = path.join(tmp, 'projects-done-helpers');
  const dir = path.join(projects, '-home-tester-done');
  const subs = path.join(dir, cid(4), 'subagents');
  const now = Date.now();
  const touch = async (/** @type {string} */ f, /** @type {number} */ ago, body = '{"type":"assistant"}\n') => {
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, body);
    const at = new Date(now - ago);
    await fs.utimes(f, at, at);
  };
  await touch(path.join(subs, 'agent-a.jsonl'), 10 * 60 * 1000);
  await touch(path.join(subs, 'agent-b.jsonl'), 10 * 60 * 1000);
  const main = path.join(dir, `${cid(4)}.jsonl`);
  // 本体: subagent の結果を受け取ったあと、30 秒前にも書いている (次の作業へ進んだ)
  await touch(main, 30 * 1000, tails.ended());
  const src = createTranscriptsSource({ projectsDir: projects, clock: () => now });
  assert.equal(/** @type {any} */ ((await src.read([cid(4)])).get(cid(4))).subLive, 0);
  // 本体が subagent を待っている (最後の書き込みが 12 分前) なら 2 つとも数える
  await touch(main, 12 * 60 * 1000, tails.ended());
  const waiting = createTranscriptsSource({ projectsDir: projects, clock: () => now });
  assert.equal(/** @type {any} */ ((await waiting.read([cid(4)])).get(cid(4))).subLive, 2);
});
