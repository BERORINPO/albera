import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createGitQuarantine, isAllowedPath, parseRawDiff } from '../src/runtime/git-quarantine.mjs';

// The host-side git quarantine (ADR-007 §2, §4; INT-01) against REAL git in temporary folders. The "guest" repository is an ordinary repository
// made here; what reaches the quarantine is only a bundle file of it. Synthetic: no guest VM, no network.
const gitPath = (() => {
  const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/u).find((l) => l.trim());
  return path.resolve(out.trim());
})();
const work = mkdtempSync(path.join(tmpdir(), 'albera-git-quarantine-'));
const guest = path.join(work, 'guest');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(work, 'none.gitconfig'), GIT_AUTHOR_NAME: 'g', GIT_AUTHOR_EMAIL: 'g@x.invalid', GIT_COMMITTER_NAME: 'g', GIT_COMMITTER_EMAIL: 'g@x.invalid' };
const g = (...args) => execFileSync('git', ['-C', guest, ...args], { env, encoding: 'utf8' }).trim();
const file = (rel, text) => { const p = path.join(guest, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); };
const commitAll = (msg) => { g('add', '-A'); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); };
const bundle = (name, ...refs) => { const p = path.join(work, `${name}.bundle`); g('bundle', 'create', '-q', p, ...refs); return p; };
const IDENTITY = Object.freeze({ name: 'ALBERA Integration', email: 'integration@albera.invalid', timestamp: 1_800_000_000 });

let base; let task; let other; let conflict;
before(() => {
  writeFileSync(path.join(work, 'none.gitconfig'), '');
  execFileSync('git', ['init', '-q', '-b', 'main', guest], { env });
  file('a.txt', 'one\n'); file('b.txt', 'b\n');
  base = commitAll('base');
  g('checkout', '-q', '-b', 'task'); file('a.txt', 'one\ntwo\n'); task = commitAll('task');
  g('checkout', '-q', '-b', 'other', base); file('c.txt', 'c\n'); other = commitAll('other');
  g('checkout', '-q', '-b', 'clash', base); file('a.txt', 'ONE\n'); conflict = commitAll('clash');
  g('checkout', '-q', 'main');
});
after(() => rmSync(work, { recursive: true, force: true }));

const quarantine = () => createGitQuarantine({ git: gitPath, root: path.join(work, 'q') });
async function imported(...branches) {
  const q = quarantine();
  const repo = await q.create();
  const b = bundle(`all-${branches.join('-')}`, 'main', ...branches);
  assert.deepEqual(await q.importBundle(repo, { bundlePath: b, ref: 'refs/heads/main', expectedOid: base }), { ok: true });
  for (const br of branches) assert.deepEqual(await q.importBundle(repo, { bundlePath: b, ref: `refs/heads/${br}`, expectedOid: g('rev-parse', br) }), { ok: true });
  return { q, repo };
}
// A guest branch with one extra commit on top of base, built by `build` in the guest working tree.
function branch(name, build) {
  g('checkout', '-q', '-b', name, base); build(); const oid = commitAll(name); g('checkout', '-q', 'main');
  return oid;
}

describe('path policy (pure)', () => {
  for (const p of ['a.txt', 'src/x/y.mjs', 'docs/.github/ok.md', 'a..b.txt']) it(`allows ${p}`, () => assert.equal(isAllowedPath(p), true));
  for (const p of ['.git/config', 'x/.git/hooks/post-checkout', '.gitmodules', 'x/.GIT/config', '.git./config', 'git~1/config', 'GITMOD~1', 'x/gitmod~2', '.gitmodules:x', 'a:b', 'con?x', 'a|b', '../x', 'x/../../y', '/etc/passwd', 'C:/x', 'a\\b', 'a\u0001b', '', 'x//y', './x']) {
    it(`refuses ${JSON.stringify(p)}`, () => assert.equal(isAllowedPath(p), false));
  }
  it('parses NUL-separated raw diff output, including paths with spaces and newlines', () => {
    const z = ':100644 100644 aaaa bbbb M\0with space.txt\0:000000 120000 0000 cccc A\0line\nbreak\0';
    assert.deepEqual(parseRawDiff(z).map((e) => [e.dstMode, e.status, e.path]), [['100644', 'M', 'with space.txt'], ['120000', 'A', 'line\nbreak']]);
    assert.throws(() => parseRawDiff(':garbage\0x\0'), /unparsable_diff/u);
  });
});

describe('importBundle: the guest\'s word is checked against the bundle', () => {
  it('imports exactly the named ref when its tip is the expected commit', async () => { await imported('task'); });
  it('refuses another expected commit, a ref the bundle does not carry, a corrupt bundle and malformed requests', async () => {
    const q = quarantine(); const repo = await q.create();
    const b = bundle('task-only', 'main', 'task');
    assert.deepEqual(await q.importBundle(repo, { bundlePath: b, ref: 'refs/heads/task', expectedOid: other }), { ok: false, code: 'oid_mismatch' });
    assert.deepEqual(await q.importBundle(repo, { bundlePath: b, ref: 'refs/heads/nope', expectedOid: task }), { ok: false, code: 'ref_missing' });
    assert.deepEqual(await q.importBundle(repo, { bundlePath: guest, ref: 'refs/heads/task', expectedOid: task }), { ok: false, code: 'bundle_invalid' }, 'a repository folder is never fetched from');
    const junk = path.join(work, 'junk.bundle'); writeFileSync(junk, '# v2 git bundle\nnot really\n');
    assert.deepEqual(await q.importBundle(repo, { bundlePath: junk, ref: 'refs/heads/task', expectedOid: task }), { ok: false, code: 'bundle_invalid' });
    for (const bad of [{ bundlePath: 'rel.bundle', ref: 'refs/heads/task', expectedOid: task }, { bundlePath: b, ref: 'task', expectedOid: task }, { bundlePath: b, ref: 'refs/heads/task', expectedOid: 'HEAD' }]) {
      assert.deepEqual(await q.importBundle(repo, bad), { ok: false, code: 'request_invalid' });
    }
  });
  it('an incremental bundle needs its prerequisite already in the quarantine (seeded from the host\'s own bundle of the target)', async () => {
    const q = quarantine(); const repo = await q.create();
    const inc = bundle('incremental', `${base}..task`);
    assert.equal((await q.importBundle(repo, { bundlePath: inc, ref: 'refs/heads/task', expectedOid: task })).code, 'bundle_invalid');
    assert.equal((await q.importBundle(repo, { bundlePath: bundle('seed', 'main'), ref: 'refs/heads/main', expectedOid: base })).ok, true);
    assert.equal((await q.importBundle(repo, { bundlePath: inc, ref: 'refs/heads/task', expectedOid: task })).ok, true);
  });
  it('nothing of the guest repository runs: its hooks and config are not in the bundle and the quarantine has no hooks at all', async () => {
    const marker = path.join(work, 'hook-ran');
    const hooks = path.join(guest, '.git', 'hooks');
    writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\necho ran > "${marker.replace(/\\/gu, '/')}"\n`, { mode: 0o755 });
    const { q, repo } = await imported('task');
    assert.equal(existsSync(path.join(repo, 'hooks')), false, 'init --template= copies no sample hooks');
    assert.ok((await q.buildCandidate(repo, { targetOid: base, submissions: [{ baseOid: base, resultOid: task }], identity: IDENTITY })).ok);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(readdirSync(repo).filter((n) => n === 'index'), [], 'bare: no index, no working tree');
  });
});

describe('inspect: what the submission adds or changes', () => {
  it('a normal change passes and reports its size', async () => {
    const { q, repo } = await imported('task');
    assert.deepEqual(await q.inspect(repo, { baseOid: base, resultOid: task }), { ok: true, changed: 1, commits: 1 });
  });
  it('refuses a result that does not descend from the base', async () => {
    const { q, repo } = await imported('task', 'other');
    assert.deepEqual(await q.inspect(repo, { baseOid: task, resultOid: other }), { ok: false, code: 'not_descendant' });
  });
  // Hostile trees are written with plumbing (mktree / commit-tree): git's own index refuses to stage most of them, a hostile guest does not care.
  const blob = (text) => execFileSync('git', ['-C', guest, 'hash-object', '-w', '--stdin'], { input: text, env, encoding: 'utf8' }).trim();
  const mktree = (lines) => execFileSync('git', ['-C', guest, 'mktree', '--missing'], { input: `${lines.join('\n')}\n`, env, encoding: 'utf8' }).trim();
  const hostile = (name, extra) => {
    const baseLines = g('ls-tree', base).split('\n');
    const commit = execFileSync('git', ['-C', guest, 'commit-tree', mktree([...baseLines, ...extra()]), '-p', base, '-m', name], { env, encoding: 'utf8' }).trim();
    g('update-ref', `refs/heads/${name}`, commit);
    return commit;
  };
  for (const [label, name, extra, codes] of [
    ['a symlink', 'h-symlink', () => [`120000 blob ${blob('a.txt')}\tlink`], ['symlink']],
    ['a submodule (gitlink)', 'h-gitlink', () => [`160000 commit ${base}\tvendor`], ['submodule']],
    ['a nested .git folder', 'h-dotgit', () => [`040000 tree ${mktree([`040000 tree ${mktree([`100644 blob ${blob('[core]\n')}\tconfig`])}\t.git`])}\tx`], ['path_forbidden', 'bundle_invalid']],
    ['a .GIT folder in another case', 'h-dotgit-case', () => [`040000 tree ${mktree([`100644 blob ${blob('x')}\thooks`])}\t.GIT`], ['path_forbidden', 'bundle_invalid']],
  ]) {
    it(`refuses ${label} (${codes.join(' or ')})`, async () => {
      const oid = hostile(name, extra);
      const q = quarantine(); const repo = await q.create();
      assert.equal((await q.importBundle(repo, { bundlePath: bundle(`seed-${name}`, 'main'), ref: 'refs/heads/main', expectedOid: base })).ok, true);
      const b = bundle(name, name);
      const imp = await q.importBundle(repo, { bundlePath: b, ref: `refs/heads/${name}`, expectedOid: oid });
      const result = imp.ok ? await q.inspect(repo, { baseOid: base, resultOid: oid }) : imp;   // fsck on the way in may already refuse it
      assert.equal(result.ok, false);
      assert.ok(codes.includes(result.code), `${result.code} is one of ${codes}`);
    });
  }
  it('refuses a .gitmodules file (path_forbidden)', async () => {
    const oid = branch('bad-gitmodules', () => file('.gitmodules', '[submodule "x"]\n'));
    const { q, repo } = await imported('bad-gitmodules');
    assert.deepEqual(await q.inspect(repo, { baseOid: base, resultOid: oid }), { ok: false, code: 'path_forbidden' });
  });
  it('a forbidden path in an EARLIER commit is refused even when the last commit removes it (every commit lands in the history)', async () => {
    g('checkout', '-q', '-b', 'hide', base);
    file('.gitmodules', '[submodule "x"]\n\turl = https://example.invalid/x\n'); commitAll('add');
    g('rm', '-q', '.gitmodules'); const hidden = commitAll('remove');
    g('checkout', '-q', 'main');
    const { q, repo } = await imported('hide');
    assert.deepEqual(await q.inspect(repo, { baseOid: base, resultOid: hidden }), { ok: false, code: 'path_forbidden' });
  });
  it('an oversized blob in an earlier commit is refused, and too many commits is refused', async () => {
    g('checkout', '-q', '-b', 'bigthenshrink', base);
    file('big.txt', 'x'.repeat(5000)); commitAll('big'); file('big.txt', 'x'); const shrunk = commitAll('shrink');
    g('checkout', '-q', 'main');
    const { q, repo } = await imported('bigthenshrink');
    assert.deepEqual(await q.inspect(repo, { baseOid: base, resultOid: shrunk, limits: { maxBlobBytes: 1000, maxChangedPaths: 100, maxCommits: 10 } }), { ok: false, code: 'blob_too_large' });
    assert.deepEqual(await q.inspect(repo, { baseOid: base, resultOid: shrunk, limits: { maxBlobBytes: 10_000, maxChangedPaths: 100, maxCommits: 1 } }), { ok: false, code: 'too_many_commits' });
  });
  it('refuses a blob over the size limit and too many changed paths', async () => {
    const { q, repo } = await imported('task');
    assert.deepEqual(await q.inspect(repo, { baseOid: base, resultOid: task, limits: { maxBlobBytes: 4, maxChangedPaths: 10, maxCommits: 10 } }), { ok: false, code: 'blob_too_large' });
    assert.deepEqual(await q.inspect(repo, { baseOid: base, resultOid: task, limits: { maxBlobBytes: 1000, maxChangedPaths: 0, maxCommits: 10 } }), { ok: false, code: 'too_many_paths' });
  });
});

describe('buildCandidate: merge-tree without a working tree, deterministic', () => {
  it('merges two clean submissions into a commit whose parents are the target then each result', async () => {
    const { q, repo } = await imported('task', 'other');
    const one = await q.buildCandidate(repo, { targetOid: base, submissions: [{ baseOid: base, resultOid: task }, { baseOid: base, resultOid: other }], identity: IDENTITY });
    assert.equal(one.ok, true);
    const again = await q.buildCandidate(repo, { targetOid: base, submissions: [{ baseOid: base, resultOid: task }, { baseOid: base, resultOid: other }], identity: IDENTITY });
    assert.deepEqual(again, one, 'same inputs, same candidate commit');
    const show = execFileSync(gitPath, ['--git-dir', repo, 'cat-file', '-p', one.candidateCommitOid], { encoding: 'utf8' });
    const parents = [...show.matchAll(/^parent ([0-9a-f]+)$/gmu)].map((m) => m[1]);
    assert.equal(parents.length, 2);
    assert.equal(parents[1], other);
    assert.match(show, new RegExp(`^tree ${one.candidateTreeOid}$`, 'mu'));
    const files = execFileSync(gitPath, ['--git-dir', repo, 'ls-tree', '--name-only', one.candidateTreeOid], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(files, ['a.txt', 'b.txt', 'c.txt']);
  });
  it('refuses a submission whose inspected base is not the merge base with the target (else the merge would use a base nobody inspected)', async () => {
    // The host target has moved on to `newer`; the guest built on `newer` but names the older `base` as its base.
    g('checkout', '-q', '-b', 'newer', base); file('n.txt', 'n\n'); const newer = commitAll('newer host commit');
    g('checkout', '-q', '-b', 'on-newer'); file('a.txt', 'one\nguest\n'); const onNewer = commitAll('guest work on newer');
    g('checkout', '-q', 'main');
    const { q, repo } = await imported('newer', 'on-newer');
    assert.deepEqual(await q.buildCandidate(repo, { targetOid: newer, submissions: [{ baseOid: base, resultOid: onNewer }], identity: IDENTITY }), { ok: false, code: 'base_mismatch' });
    assert.equal((await q.buildCandidate(repo, { targetOid: newer, submissions: [{ baseOid: newer, resultOid: onNewer }], identity: IDENTITY })).ok, true, 'the true base is accepted');
  });
  it('a conflicting submission is CONFLICTED and no candidate is written', async () => {
    const { q, repo } = await imported('task', 'clash');
    assert.deepEqual(await q.buildCandidate(repo, { targetOid: base, submissions: [{ baseOid: base, resultOid: task }, { baseOid: base, resultOid: conflict }], identity: IDENTITY }), { ok: false, code: 'conflicted' });
  });
  it('refuses a malformed identity or object id', async () => {
    const { q, repo } = await imported('task');
    for (const req of [{ targetOid: base, submissions: [{ baseOid: base, resultOid: task }], identity: { ...IDENTITY, email: 'x' } }, { targetOid: base, submissions: [], identity: IDENTITY }, { targetOid: 'main', submissions: [{ baseOid: base, resultOid: task }], identity: IDENTITY }]) {
      assert.deepEqual(await q.buildCandidate(repo, req), { ok: false, code: 'request_invalid' });
    }
  });
});

describe('construction', () => {
  it('needs an absolute git path and an absolute root (no PATH lookup)', () => {
    assert.throws(() => createGitQuarantine({ git: 'git', root: work }), /invalid_git_quarantine_dependencies/u);
    assert.throws(() => createGitQuarantine({ git: gitPath, root: 'rel' }), /invalid_git_quarantine_dependencies/u);
  });
  it('every git call carries the hardening and a fixed environment', async () => {
    const calls = [];
    const q = createGitQuarantine({ git: gitPath, root: path.join(work, 'shape'), run: async (file, args, opts) => { calls.push({ file, args, opts }); return { code: 0, stdout: '', stderr: '' }; } });
    await q.create().catch(() => {});
    for (const c of calls) {
      assert.equal(c.file, gitPath);
      for (const flag of ['core.fsmonitor=false', 'protocol.allow=never', 'protocol.file.allow=always', 'transfer.fsckObjects=true', 'credential.helper=']) assert.ok(c.args.includes(flag), flag);
      assert.equal(c.args.filter((a) => /^protocol\.[a-z]+\.allow=always$/u.test(a)).length, 1, 'file is the only transport');
      assert.ok(c.args.some((a) => a.startsWith('core.hooksPath=')));
      assert.equal(c.opts.env.GIT_CONFIG_NOSYSTEM, '1');
      assert.equal(c.opts.env.GIT_TERMINAL_PROMPT, '0');
      assert.equal(c.opts.env.PATH, undefined, 'no PATH: git finds nothing of the user');
    }
  });
});

describe('fake pair', () => {
  it('answers the same four methods, defaults to success and records calls', async () => {
    const { createFakeGitQuarantine } = await import('../src/runtime/fake-git-quarantine.mjs');
    const real = Object.keys(createGitQuarantine({ git: gitPath, root: work })).sort();
    const fake = createFakeGitQuarantine({ inspect: { ok: false, code: 'symlink' } });
    assert.deepEqual(Object.keys(fake).filter((k) => k !== 'calls').sort(), real);
    assert.deepEqual(await fake.importBundle('/r', { ref: 'refs/heads/x' }), { ok: true });
    assert.deepEqual(await fake.inspect('/r', {}), { ok: false, code: 'symlink' });
    assert.deepEqual(fake.calls().map((c) => c.method), ['importBundle', 'inspect']);
  });
});
