import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createWorktreeCreator } from '../src/adapters/worktree-create-git.mjs';

const root = path.join(path.parse(process.cwd()).root, 'agent-canvas-fixture', 'repo');
const cwd = path.join(root, 'nested');

function fakeFs(existing = new Set()) {
  const created = new Set();
  return {
    created,
    lstat: async (target) => {
      if (existing.has(target) || created.has(target)) return { isDirectory: () => true, isSymbolicLink: () => false };
      const error = new Error('private file detail');
      error.code = 'ENOENT';
      throw error;
    },
    mkdtemp: async (prefix) => `${prefix}fixture`,
    rm: async (target) => { created.delete(target); },
  };
}

test('explicit worktree creation uses a resolved local repo and returns only safe metadata', async () => {
  const calls = [];
  const fs = fakeFs();
  const creator = createWorktreeCreator({ fs, tmpdir: () => path.parse(process.cwd()).root, runGit: async (args, at, timeout) => {
    calls.push({ args, at, timeout });
    if (args.includes('--show-toplevel')) return `${root}\n`;
    if (args.includes('--porcelain=v1')) return `?? ${path.join(root, 'private-name.txt')}\0`;
    return '';
  } });
  const result = await creator.create({ cwd, branch: 'agent/review-canvas' });
  assert.deepEqual(result, { ok: true, branch: 'agent/review-canvas', status: 'untracked', changed: 0, untracked: 1, conflicted: 0 });
  const add = calls.find(({ args }) => args.includes('add'));
  assert.ok(add);
  assert.deepEqual(add.args.slice(-3, -1), ['-b', 'agent/review-canvas']);
  assert.ok(add.args.some((arg) => arg.startsWith('core.hooksPath=')));
  assert.equal(add.timeout, 60_000);
  assert.ok(!JSON.stringify(result).includes(root));
  assert.ok(!JSON.stringify(result).includes('private-name.txt'));
  assert.equal(fs.created.size, 0, 'the temporary hook directory is removed and no parent directory is created by the adapter');
});

test('invalid branches, network targets, occupied destinations, and Git failures do not expose diagnostics', async () => {
  let calls = 0;
  const creator = createWorktreeCreator({ fs: fakeFs(), tmpdir: () => path.parse(process.cwd()).root, runGit: async (args) => {
    calls++;
    if (args.includes('--show-toplevel')) return `${root}\n`;
    if (args.includes('worktree') && args.includes('add')) throw new Error('private command diagnostic');
    return '';
  } });
  assert.deepEqual(await creator.create({ cwd: '\\\\server\\share\\repo', branch: 'agent/review' }), { ok: false, reason: 'invalid_target' });
  assert.deepEqual(await creator.create({ cwd, branch: '' }), { ok: false, reason: 'invalid_branch' });
  assert.deepEqual(await creator.create({ cwd, branch: '../outside' }), { ok: false, reason: 'invalid_branch' });
  const failed = await creator.create({ cwd, branch: 'agent/review' });
  assert.deepEqual(failed, { ok: false, reason: 'creation_failed' });
  assert.ok(!JSON.stringify(failed).includes('private command diagnostic'));
  assert.equal(calls, 3, 'bad targets and branches fail before invoking Git');
});

test('an existing generated target is rejected before worktree add', async () => {
  const existing = new Set();
  const fs = fakeFs(existing);
  const calls = [];
  const creator = createWorktreeCreator({ fs, tmpdir: () => path.parse(process.cwd()).root, runGit: async (args) => {
    calls.push(args);
    if (args.includes('--show-toplevel')) return `${root}\n`;
    return '';
  } });
  const first = await creator.create({ cwd, branch: 'agent/existing' });
  assert.equal(first.ok, true);
  const add = calls.find((args) => args.includes('add'));
  const target = add.at(-1);
  existing.add(target);
  calls.length = 0;
  assert.deepEqual(await creator.create({ cwd, branch: 'agent/existing' }), { ok: false, reason: 'target_exists' });
  assert.equal(calls.some((args) => args.includes('add')), false);
});
