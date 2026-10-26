import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWslWorktreeSource } from '../src/adapters/worktrees-wsl.mjs';

const shareRoot = '\\\\wsl.localhost\\Ubuntu\\.codex';

test('WSL worktree inventory uses only the configured distro and returns safe summaries', async () => {
  const calls = [];
  const source = createWslWorktreeSource({ shareRoot, runGit: async (args, distro) => {
    calls.push({ args, distro });
    if (args.includes('--show-toplevel')) return '/home/dev/project\n';
    if (args.includes('list')) return [
      'worktree /home/dev/project', 'HEAD abc', 'branch refs/heads/main', '',
      'worktree /home/dev/project-pigeonholes-feature', 'HEAD def', 'branch refs/heads/feature', '',
    ].join('\0');
    if (args.includes('status')) return ' M hidden.txt\0?? secret-name\0';
    return '';
  } });

  const rows = await source.listForCwd('\\\\wsl.localhost\\Ubuntu\\home\\dev\\project');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(({ branch, current, status, changed, untracked }) => ({ branch, current, status, changed, untracked })), [
    { branch: 'main', current: true, status: 'mixed', changed: 1, untracked: 1 },
    { branch: 'feature', current: false, status: 'mixed', changed: 1, untracked: 1 },
  ]);
  assert.equal(JSON.stringify(rows).includes('hidden.txt'), false);
  assert.equal(JSON.stringify(rows).includes('secret-name'), false);
  assert.ok(calls.every((call) => call.distro === 'Ubuntu'));
});

test('WSL worktree inventory fails closed outside the configured share without invoking WSL', async () => {
  let calls = 0;
  const source = createWslWorktreeSource({ shareRoot, runGit: async () => (calls++, '') });
  assert.deepEqual(await source.listForCwd('\\\\wsl.localhost\\Other\\home\\dev\\project'), []);
  assert.deepEqual(await createWslWorktreeSource({ shareRoot: '\\\\server\\share', runGit: async () => (calls++, '') }).listForCwd('\\\\server\\share\\repo'), []);
  assert.equal(calls, 0);
});
