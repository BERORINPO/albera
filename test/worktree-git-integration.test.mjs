import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createWorktreeCreator } from '../src/adapters/worktree-create-git.mjs';
import { createWorktreeRemover } from '../src/adapters/worktree-remove-git.mjs';
import { createWorktreeSource, managedWorktreePath } from '../src/adapters/worktrees-git.mjs';

const execFile = promisify(nodeExecFile);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' });

/** Run local Git with a fixed executable and no shell. Output is held only in this test process. @param {string[]} args @param {string} cwd */
async function git(args, cwd) {
  const { stdout } = await execFile('git', args, { cwd, env, shell: false, windowsHide: true, encoding: 'utf8' });
  return stdout;
}

test('actual local Git worktree lifecycle keeps nested managed worktrees removable and path-free', async () => {
  const tempRoot = path.resolve(os.tmpdir());
  const sandbox = path.resolve(await fs.mkdtemp(path.join(tempRoot, 'pigeonholes-git-integration-')));
  const repo = path.join(sandbox, 'repo');
  const hooks = path.join(sandbox, 'empty-hooks');
  const branch = 'agent/canvas-integration';
  const childBranch = 'agent/canvas-child';
  let createdBranches = [];
  try {
    await fs.mkdir(repo);
    await fs.mkdir(hooks);
    await git(['init', '--template', hooks, '-b', 'main'], repo);
    await git(['config', 'user.name', 'Pigeonholes Integration Fixture'], repo);
    await git(['config', 'user.email', 'fixture@example.invalid'], repo);
    await fs.writeFile(path.join(repo, 'README.md'), 'synthetic fixture\n');
    await git(['add', 'README.md'], repo);
    await git(['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgSign=false', 'commit', '-m', 'fixture'], repo);
    assert.equal((await git(['remote'], repo)).trim(), '', 'the synthetic repo has no remote');

    const creator = createWorktreeCreator();
    const result = await creator.create({ cwd: repo, branch });
    assert.deepEqual(result, { ok: true, branch, status: 'clean', changed: 0, untracked: 0, conflicted: 0 });

    const child = await creator.create({ cwd: managedWorktreePath(repo, branch), branch: childBranch });
    assert.deepEqual(child, { ok: true, branch: childBranch, status: 'clean', changed: 0, untracked: 0, conflicted: 0 });
    createdBranches = [branch, childBranch];

    const inventory = await createWorktreeSource().listForCwd(repo);
    assert.deepEqual(inventory.map(({ branch: name, status, current, removable }) => ({ branch: name, status, current, removable })), [
      { branch: 'main', status: 'clean', current: true, removable: false },
      { branch, status: 'clean', current: false, removable: true },
      { branch: childBranch, status: 'clean', current: false, removable: true },
    ]);
    for (const privateValue of [sandbox, repo, 'README.md']) assert.equal(JSON.stringify(inventory).includes(privateValue), false);

    const childRemoved = await createWorktreeRemover().remove({ cwd: repo, branch: childBranch, confirmed: true });
    assert.deepEqual(childRemoved, { ok: true, branch: childBranch });
    const removed = await createWorktreeRemover().remove({ cwd: repo, branch, confirmed: true });
    assert.deepEqual(removed, { ok: true, branch });
    createdBranches = [];
    const remaining = await createWorktreeSource().listForCwd(repo);
    assert.deepEqual(remaining.map((entry) => entry.branch), ['main']);
    assert.ok((await git(['show-ref', '--verify', `refs/heads/${branch}`], repo)).includes(branch), 'the local branch remains after removing its worktree');
  } finally {
    for (const createdBranch of createdBranches.reverse()) {
      try { await createWorktreeRemover().remove({ cwd: repo, branch: createdBranch, confirmed: true }); } catch { /* sandbox cleanup follows */ }
    }
    const tempPrefix = `${tempRoot}${path.sep}`;
    if (sandbox === tempRoot || !sandbox.startsWith(tempPrefix) || !path.basename(sandbox).startsWith('pigeonholes-git-integration-')) {
      throw new Error('Refusing to remove an unexpected integration-test path');
    }
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
