// The real adapters against this repo itself (read-only): git log parses, fs reads, gh never throws.
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFsRepo } from '../src/adapter/fs-repo.mjs';
import { createGit, GitUnavailable } from '../src/adapter/git.mjs';
import { createGh, isPrView } from '../src/adapter/gh.mjs';
import { parseGitLog } from '../src/core/git-log.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('fs-repo reads text, returns null for a missing file, knows directories', () => {
  const fs = createFsRepo();
  assert.match(fs.readText(join(ROOT, 'spec', 'v1.md')), /持ち場/);
  assert.equal(fs.readText(join(ROOT, 'nope.txt')), null);
  assert.equal(fs.readText(join(ROOT, 'src')), null);
  assert.equal(fs.isDir(join(ROOT, 'src')), true);
  assert.equal(fs.isDir(join(ROOT, 'nope')), false);
});

test('git adapter output parses with the core parser', () => {
  const git = createGit();
  const text = git.log(ROOT, '2000-01-01T00:00:00');
  assert.equal(typeof text, 'string');
  for (const c of parseGitLog(text)) assert.match(c.hash, /^[0-9a-f]{40}$/);
});

test('git adapter reports a folder outside git as GitUnavailable', () => {
  const outside = resolve(ROOT, '..', '..', 'definitely-not-a-repo-mochiba');
  assert.throws(() => createGit().log(outside, '2000-01-01T00:00:00'), GitUnavailable);
});

test('gh adapter never throws (missing gh or a bad PR is a value)', async () => {
  const r = await createGh().prView(join(ROOT, 'no-such-dir'), 999999);
  assert.equal(r.ok, false);
  assert.ok(['gh 無し', 'gh 失敗'].includes(r.reason));
});

// ---------- regression: review 2026-11-24 ----------
const fakeExec = (result) => (cmd, args, opts, cb) => {
  if (result instanceof Error) cb(result, '');
  else cb(null, result);
};

test('gh adapter passes a well-formed PR view through (success path)', async () => {
  const view = { title: 'T', body: 'B', url: 'https://github.com/a/b/pull/1', statusCheckRollup: [{ conclusion: 'SUCCESS' }] };
  const r = await createGh({ execFile: fakeExec(JSON.stringify(view)) }).prView(ROOT, 1);
  assert.deepEqual(r, { ok: true, data: view });
});

test('gh adapter rejects JSON of the wrong shape before it reaches core', async () => {
  for (const bad of ['null', '[]', '"x"', '{"title": 3}', '{"body": {}}', '{"statusCheckRollup": "x"}', '{"statusCheckRollup": [null]}', 'not json']) {
    const r = await createGh({ execFile: fakeExec(bad) }).prView(ROOT, 1);
    assert.deepEqual(r, { ok: false, reason: 'gh 失敗' }, bad);
  }
  assert.equal(isPrView({}), true);
});

test('gh adapter: ENOENT means gh is missing, other errors are a failure', async () => {
  const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
  assert.equal((await createGh({ execFile: fakeExec(missing) }).prView(ROOT, 1)).reason, 'gh 無し');
  assert.equal((await createGh({ execFile: fakeExec(new Error('exit 1')) }).prView(ROOT, 1)).reason, 'gh 失敗');
});

test('git adapter topLevel finds the top of the repo a folder is in', (t) => {
  // Its own repo: this folder may sit inside a bigger repo (a tools/ folder of another project).
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'mochiba-top-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
  mkdirSync(join(dir, 'src', 'core'), { recursive: true });
  const top = createGit().topLevel(join(dir, 'src', 'core'));
  assert.equal(realpathSync.native(resolve(top)).toLowerCase(), dir.toLowerCase());
});

test('git adapter prints non-ASCII paths unquoted (core.quotePath=false)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mochiba-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const g = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
  g('init', '-q');
  writeFileSync(join(dir, '名簿.js'), 'export const a = 1;\n');
  g('add', '.');
  g('commit', '-q', '-m', 'add');
  const text = createGit().log(dir, '2000-01-01T00:00:00');
  assert.match(text, /\t名簿\.js/);
  assert.ok(!text.includes('"\\'), 'quoted path');
});

test('fs-repo listFiles walks a folder for source files; realPath resolves a missing file', () => {
  const fs = createFsRepo();
  const files = fs.listFiles(join(ROOT, 'src'), ['.mjs', '.html']);
  assert.ok(files.includes('entry/cli.mjs'));
  assert.ok(files.includes('entry/template.html'));
  assert.ok(files.every((f) => !f.includes('\\')));
  assert.deepEqual(fs.listFiles(join(ROOT, 'nope'), ['.mjs']), []);
  const missing = fs.realPath(join(ROOT, 'out', 'not-yet', 'x.html'));
  assert.equal(missing.toLowerCase(), join(ROOT, 'out', 'not-yet', 'x.html').toLowerCase());
});
