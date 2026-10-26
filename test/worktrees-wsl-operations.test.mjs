import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { createWslWorktreeSource } from '../src/adapters/worktrees-wsl.mjs';

const shareRoot = '\\\\wsl.localhost\\Ubuntu\\.codex';
const cwd = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\project';
const root = '/home/dev/project';

test('WSL worktree creation requires confirmation, checks a share-local target, disables hooks, and returns summaries only', async () => {
  const calls = [];
  let checkedPath = '';
  const source = createWslWorktreeSource({ shareRoot, fs: { lstat: async (value) => { checkedPath = value; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }, runGit: async (args, distro, timeout) => {
    calls.push({ args, distro, timeout });
    if (args.includes('--show-toplevel')) return `${root}\n`;
    if (args.includes('status')) return '?? private-name\0';
    return '';
  } });
  assert.deepEqual(await source.create({ cwd, branch: 'feature/test', confirmed: false }), { ok: false, reason: 'invalid_target' });
  assert.equal(calls.length, 0);
  const result = await source.create({ cwd, branch: 'feature/test', confirmed: true });
  assert.equal(result.ok, true);
  assert.equal(result.branch, 'feature/test');
  assert.equal(result.status, 'untracked');
  assert.ok(checkedPath.startsWith('\\\\wsl.localhost\\Ubuntu\\'));
  const add = calls.find((call) => call.args.includes('add'));
  assert.equal(add.distro, 'Ubuntu');
  assert.ok(add.args.includes('core.hooksPath=/dev/null'));
  assert.equal(add.args.includes('--force'), false);
  assert.equal(JSON.stringify(result).includes('private-name'), false);
});

test('WSL removal requires confirmation and rechecks a clean managed non-current branch worktree', async () => {
  const calls = [];
  const repoHash = crypto.createHash('sha256').update(`ubuntu\0${root}`).digest('hex').slice(0, 12);
  const branchHash = crypto.createHash('sha256').update('feature').digest('hex').slice(0, 8);
  const managedPath = `${root}-pigeonholes-${repoHash}-feature-${branchHash}`;
  const source = createWslWorktreeSource({ shareRoot, runGit: async (args, distro, timeout) => {
    calls.push({ args, distro, timeout });
    if (args.includes('--show-toplevel')) return `${root}\n`;
    if (args.includes('list')) return [
      `worktree ${root}`, 'HEAD abc', 'branch refs/heads/main', '',
      `worktree ${managedPath}`, 'HEAD def', 'branch refs/heads/feature', '',
    ].join('\0');
    return '';
  } });
  assert.deepEqual(await source.remove({ cwd, branch: 'feature', confirmed: false }), { ok: false, reason: 'invalid_target' });
  assert.equal(calls.length, 0);
  const result = await source.remove({ cwd, branch: 'feature', confirmed: true });
  assert.deepEqual(result, { ok: true, branch: 'feature' });
  const removal = calls.find((call) => call.args.includes('remove'));
  assert.deepEqual(removal.args.slice(-2), ['remove', managedPath]);
  assert.equal(removal.args.includes('--force'), false);
});

test('WSL removal refuses an untracked arbitrary worktree path', async () => {
  const source = createWslWorktreeSource({ shareRoot, runGit: async (args) => {
    if (args.includes('--show-toplevel')) return `${root}\n`;
    if (args.includes('list')) return [`worktree ${root}-elsewhere`, 'HEAD def', 'branch refs/heads/feature', ''].join('\0');
    return '';
  } });
  assert.deepEqual(await source.remove({ cwd, branch: 'feature', confirmed: true }), { ok: false, reason: 'invalid_target' });
});
