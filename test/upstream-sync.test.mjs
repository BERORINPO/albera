// scripts/upstream-sync.mjs: real git repositories in a temp folder (upstream, the copy's remote, the copy's checkout)
// and a fake `gh` that records what it was asked. Nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changelogAdditions, fenced, runCommand, syncPullRequest, syncSettings, upstreamSync } from '../scripts/upstream-sync.mjs';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
const git = (cwd, ...args) => {
  const r = runCommand('git', [...ID, ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (dir, file, text, message) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
};

/** upstream (a work repo), origin.git (the copy on the server, bare), copy (the workflow's checkout). */
function world(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'albera-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, 'upstream'), origin = path.join(root, 'origin.git'), copy = path.join(root, 'copy');
  mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  commit(upstream, 'CHANGELOG.md', '# Changelog\n\n## Unreleased\n', 'first');
  git(root, 'clone', '-q', '--bare', upstream, origin);
  git(root, 'clone', '-q', origin, copy);
  return { root, upstream, origin, copy };
}

/** A runner where `gh` is fake: it records calls and answers from `prs` (open pull request numbers). */
function fakeGh(prs = []) {
  const calls = [];
  const run = (cmd, args, opts) => {
    if (cmd !== 'gh') return runCommand(cmd, args, opts);
    calls.push(args);
    if (args[0] === 'repo' && args[1] === 'view') return { code: 0, stdout: 'main\n', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'list') return { code: 0, stdout: prs.length ? `${prs[0]}\n` : '', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'create') return { code: 0, stdout: 'https://github.com/acme/albera/pull/7\n', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'edit') return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected gh call' };
  };
  return { run, calls };
}
const envFor = (w, extra = {}) => ({ ALBERA_UPSTREAM: w.upstream, ALBERA_UPSTREAM_REF: 'main', BASE_BRANCH: 'main', ...extra });
const arg = (args, name) => args[args.indexOf(name) + 1];

test('upstream-sync: nothing new upstream -> up to date, no push and no gh call', (t) => {
  const w = world(t);
  const gh = fakeGh();
  const r = upstreamSync({ cwd: w.copy, env: envFor(w), run: gh.run });
  assert.equal(r.status, 'up_to_date');
  assert.equal(r.exitCode, 0);
  assert.deepEqual(gh.calls, []);
  assert.notEqual(runCommand('git', ['rev-parse', '--verify', 'refs/heads/albera-update'], { cwd: w.origin }).code, 0, 'no update branch pushed');
});

test('upstream-sync: new upstream commits -> pushes albera-update and opens one pull request with the CHANGELOG lines', (t) => {
  const w = world(t);
  commit(w.upstream, 'CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n- Added the explain map.\n', 'feat: explain map');
  const tip = commit(w.upstream, 'src/a.mjs', 'export const a = 1;\n', 'fix: a');
  const gh = fakeGh();
  const r = upstreamSync({ cwd: w.copy, env: envFor(w), run: gh.run });
  assert.equal(r.status, 'opened', r.message);
  assert.equal(r.pr, 7);
  assert.equal(git(w.origin, 'rev-parse', 'refs/heads/albera-update'), tip, 'the update branch is the upstream tip');
  const create = gh.calls.find((a) => a[1] === 'create');
  assert.ok(create);
  assert.equal(arg(create, '--base'), 'main');
  assert.equal(arg(create, '--head'), 'albera-update');
  assert.equal(arg(create, '--title'), `ALBERA update: 2 new commits (${tip.slice(0, 7)})`);
  const body = arg(create, '--body');
  assert.match(body, /- Added the explain map\./);
  assert.match(body, /fix: a/);
  assert.match(body, /feat: explain map/);
  assert.doesNotMatch(body, /Workflow files changed/);
});

test('upstream-sync: an open update pull request is refreshed, not opened twice; the branch moves forward', (t) => {
  const w = world(t);
  commit(w.upstream, 'a.txt', '1\n', 'one');
  upstreamSync({ cwd: w.copy, env: envFor(w), run: fakeGh().run });
  git(w.copy, 'fetch', '-q', 'origin');
  const tip = commit(w.upstream, 'a.txt', '2\n', 'two');
  const gh = fakeGh([7]);
  const r = upstreamSync({ cwd: w.copy, env: envFor(w), run: gh.run });
  assert.equal(r.status, 'updated', r.message);
  assert.ok(gh.calls.some((a) => a[1] === 'edit' && a[2] === '7'));
  assert.ok(!gh.calls.some((a) => a[1] === 'create'));
  assert.equal(git(w.origin, 'rev-parse', 'refs/heads/albera-update'), tip);
});

test('upstream-sync: the copy\'s own changes are kept out of the update branch and the body', (t) => {
  const w = world(t);
  commit(w.copy, 'company-only.txt', 'internal\n', 'chore: our own change');
  git(w.copy, 'push', '-q', 'origin', 'main');
  commit(w.upstream, 'b.txt', 'b\n', 'feat: b');
  const gh = fakeGh();
  const r = upstreamSync({ cwd: w.copy, env: envFor(w), run: gh.run });
  assert.equal(r.status, 'opened', r.message);
  const body = arg(gh.calls.find((a) => a[1] === 'create'), '--body');
  assert.match(body, /1 commit behind/);
  assert.doesNotMatch(body, /chore: our own change|company-only/);
});

test("upstream-sync: without BASE_BRANCH the copy's default branch is asked from GitHub", (t) => {
  const w = world(t);
  commit(w.upstream, 'e.txt', 'e\n', 'e');
  const gh = fakeGh();
  const r = upstreamSync({ cwd: w.copy, env: { ALBERA_UPSTREAM: w.upstream }, run: gh.run });
  assert.equal(r.status, 'opened', r.message);
  assert.deepEqual(gh.calls[0].slice(0, 2), ['repo', 'view']);
  assert.equal(arg(gh.calls.find((a) => a[1] === 'create'), '--base'), 'main');
});

test('upstream-sync: changed workflow files are named in the body', (t) => {
  const w = world(t);
  commit(w.upstream, '.github/workflows/test.yml', 'name: x\n', 'ci: x');
  const gh = fakeGh();
  upstreamSync({ cwd: w.copy, env: envFor(w), run: gh.run });
  const body = arg(gh.calls.find((a) => a[1] === 'create'), '--body');
  assert.match(body, /## Workflow files changed upstream/);
  assert.match(body, /\.github\/workflows\/test\.yml/);
});

test('upstream-sync: a copy with no shared history says so and exits 1', (t) => {
  const w = world(t);
  const lone = path.join(w.root, 'lone'), loneOrigin = path.join(w.root, 'lone.git');
  mkdirSync(lone);
  git(lone, 'init', '-q', '-b', 'main');
  commit(lone, 'x.txt', 'x\n', 'imported without history');
  git(w.root, 'clone', '-q', '--bare', lone, loneOrigin);
  const checkout = path.join(w.root, 'lone-checkout');
  git(w.root, 'clone', '-q', loneOrigin, checkout);
  commit(w.upstream, 'c.txt', 'c\n', 'c');
  const gh = fakeGh();
  const r = upstreamSync({ cwd: checkout, env: envFor(w), run: gh.run });
  assert.equal(r.status, 'no_shared_history');
  assert.equal(r.exitCode, 1);
  assert.deepEqual(gh.calls, []);
});

test('upstream-sync: GitHub refusing Actions-made pull requests names the setting to turn on', (t) => {
  const w = world(t);
  commit(w.upstream, 'd.txt', 'd\n', 'd');
  const base = fakeGh();
  const run = (cmd, args, opts) => (cmd === 'gh' && args[1] === 'create'
    ? { code: 1, stdout: '', stderr: 'pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)' }
    : base.run(cmd, args, opts));
  const r = upstreamSync({ cwd: w.copy, env: envFor(w), run });
  assert.equal(r.status, 'pr_failed');
  assert.match(r.message, /Allow GitHub Actions to create and approve pull requests/);
});

test('syncPullRequest: upstream text cannot break out of its fenced block, mention people or grow without end', () => {
  const commits = Array.from({ length: 45 }, (_, i) => ({ sha: `${i}`.padStart(40, 'a'), subject: i === 0 ? 'ping @owner ```` and ![x](http://e.invalid/x.png)' : `c${i}` }));
  const { title, body } = syncPullRequest({ upstream: 'u', ref: 'main', tip: 'f'.repeat(40), commits, changelog: ['- a'], workflows: [] });
  assert.equal(title, 'ALBERA update: 45 new commits (fffffff)');
  assert.match(body, /… and 15 more/);
  const commitsBlock = body.slice(body.indexOf('## Commits'));
  assert.match(commitsBlock, /^`{5}text$/m, 'the commits fence is longer than the 4 backticks in a subject');
  assert.ok(body.indexOf('@owner') > body.indexOf('`````text'), 'the mention sits inside a fence');
  assert.equal(fenced(['x'.repeat(400)]).split('\n')[1].length, 300);
});

test('changelogAdditions keeps added lines only, without runs of blank lines', () => {
  const diff = 'diff --git a/CHANGELOG.md b/CHANGELOG.md\n--- a/CHANGELOG.md\n+++ b/CHANGELOG.md\n@@ -1,2 +1,6 @@\n # Changelog\n+\n+\n+- One.\n-- Old.\n+\n+- Two.\n';
  assert.deepEqual(changelogAdditions(diff), ['- One.', '', '- Two.']);
});

test('syncSettings: defaults, and refusals for refs or an upstream that could act as an option', () => {
  assert.deepEqual(syncSettings({}), { upstream: 'https://github.com/BERORINPO/albera.git', ref: 'main', base: '', branch: 'albera-update' });
  assert.throws(() => syncSettings({ ALBERA_UPSTREAM_REF: 'main..x' }), /ref_invalid/);
  assert.throws(() => syncSettings({ BASE_BRANCH: 'a b' }), /base_invalid/);
  assert.throws(() => syncSettings({ ALBERA_UPSTREAM: '--upload-pack=x' }), /upstream_invalid/);
  assert.throws(() => syncSettings({ BASE_BRANCH: 'albera-update' }), /base_is_the_update_branch/);
});
