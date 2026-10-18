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
import { createTranscriptsSource, newestMtimeUnder } from '../src/adapters/transcripts-fs.mjs';
import { createBoardService, withFolders } from '../src/entry/service.mjs';
import { FOLDER_HINT_TTL_MS, FORBIDDEN_OUTPUT_KEYS } from '../src/shared/constants.mjs';
import { HOUR, NOW, rec } from './helpers/fixtures.mjs';

/** @type {string} */
let tmp;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pigeonholes-test-'));
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
  const raws = [rawOf(1), rawOf(2, { isArchived: true }), rawOf(3)];
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
  assert.equal((await fs.stat(file)).mtimeMs, before, '読んでも mtime は変わらない');
  assert.deepEqual(src.stats(), { dirMissing: false, indexed: 1 });

  const fake = createFakeTranscriptsSource({ [cid(1)]: got });
  assert.deepEqual((await fake.read([cid(1), cid(2)])).get(cid(1)), got);
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
    assert.deepEqual(b.counts, { needs_you: 4, trouble: 3, unread: 3, working: 4, recent: 7, cleanup: 35, recommended: 28, active: 56, archived: 3 }, lang);
    assert.equal(b.stats.demo, true);
    assert.equal(b.stats.formatSuspect, null);
    for (const k of FORBIDDEN_OUTPUT_KEYS) assert.ok(!body.includes(`"${k}"`), k);
    const reasons = (/** @type {string} */ k) => b.buckets[k].map((/** @type {any} */ c) => c.reason).sort();
    assert.deepEqual(reasons('needs_you'), ['asking', 'asking', 'asks', 'asks']);
    assert.deepEqual(b.buckets.needs_you.map((/** @type {any} */ c) => c.reasonParams?.ask).filter(Boolean).sort(), ['plan', 'question']);
    assert.deepEqual(reasons('trouble'), ['git_startup', 'limit', 'stalled']);
    assert.deepEqual(reasons('working'), ['background', 'turn', 'turn', 'turn']);
    const running = b.buckets.working.filter((/** @type {any} */ c) => c.startedAt).map((/** @type {any} */ c) => Math.round((NOW - c.startedAt) / 60000));
    assert.deepEqual(running.sort((/** @type {number} */ x, /** @type {number} */ y) => x - y), [2, 6, 23]);
    assert.ok(b.buckets.unread.some((/** @type {any} */ c) => c.prs.length > 0) && b.buckets.unread.some((/** @type {any} */ c) => c.routine));
    assert.deepEqual(b.recentGroups.map((/** @type {any} */ g) => g.label).sort(), ['demo-app', 'notes', 'site', null].sort());
    assert.deepEqual(b.cleanupGroups.map((/** @type {any} */ g) => g.count), [1, 4, 1, 1, 1, 25, 2]);
    assert.ok(Object.values(b.families).some((/** @type {any} */ f) => f.memberIds.length === 4));
  }
});
