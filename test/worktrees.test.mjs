import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorktreeSource, parseWorktreeList, summarizeGitStatus } from '../src/adapters/worktrees-git.mjs';
import { rec, NOW } from './helpers/fixtures.mjs';

const fakePath = (name) => process.platform === 'win32' ? `C:\\synthetic\\${name}` : `/synthetic/${name}`;

test('worktree list porcelain parser keeps metadata only for a valid local worktree record', () => {
  const root = fakePath('repo');
  const raw = [
    `worktree ${root}`, 'HEAD 1234567890abcdef', 'branch refs/heads/feature/canvas', '',
    `worktree ${fakePath('locked')}`, 'HEAD abcdef', 'detached', 'locked private reason', 'prunable stale private path', '', '',
  ].join('\0');
  const rows = parseWorktreeList(raw);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].branch, 'feature/canvas');
  assert.equal(rows[0].detached, false);
  assert.deepEqual([rows[1].branch, rows[1].detached, rows[1].locked, rows[1].prunable], [null, true, true, true]);
  assert.ok(!JSON.stringify(rows.map(({ branch, detached, locked, prunable }) => ({ branch, detached, locked, prunable }))).includes('private'));
});

test('Git status summary counts states and discards file names', () => {
  const summary = summarizeGitStatus(' M private/source.js\0?? private/new.key\0UU private/conflict.json\0');
  assert.deepEqual(summary, { state: 'conflicted', changed: 1, untracked: 1, conflicted: 1 });
  assert.ok(!JSON.stringify(summary).includes('private'));
  assert.deepEqual(summarizeGitStatus(''), { state: 'clean', changed: 0, untracked: 0, conflicted: 0 });
  assert.deepEqual(summarizeGitStatus('?? one.txt\0'), { state: 'untracked', changed: 0, untracked: 1, conflicted: 0 });
});

test('worktree adapter calls only bounded read commands and returns no paths or lock reasons', async () => {
  const root = fakePath('repo');
  const calls = [];
  const source = createWorktreeSource({
    clock: () => NOW,
    runGit: async (args, cwd) => {
      calls.push({ args, cwd });
      if (args.includes('rev-parse')) return `${root}\n`;
      if (args.includes('worktree')) return `worktree ${root}\0HEAD 1234\0branch refs/heads/feature/canvas\0locked private secret\0\0`;
      if (args.includes('status')) return ' M private/source.js\0?? private/key.txt\0';
      throw new Error('unexpected command');
    },
  });
  const session = rec(99, { cwd: root, lastActivityAt: NOW });
  const result = await source.enrich([session]);
  assert.deepEqual(result[0].gitWorktree, {
    branch: 'feature/canvas', status: 'mixed', changed: 1, untracked: 1, conflicted: 0, locked: true, prunable: false,
  });
  assert.equal(source.stats().matched, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.args.filter((arg) => arg !== root && arg !== '-c' && !arg.startsWith('core.'))), [
    ['-C', 'rev-parse', '--show-toplevel'],
    ['-C', 'worktree', 'list', '--porcelain', '-z'],
    ['-C', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
  ]);
  assert.deepEqual(calls[2].args.slice(0, 4), ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false']);
  assert.ok(!JSON.stringify(result[0].gitWorktree).includes(root));
  assert.ok(!JSON.stringify(result[0].gitWorktree).includes('private'));
  assert.ok(!JSON.stringify(result[0].gitWorktree).includes('secret'));
});

test('worktree inventory is capped, path-free, and reports only branch/status flags', async () => {
  const root = fakePath('repo');
  const sibling = fakePath('repo-private-sibling');
  const source = createWorktreeSource({ runGit: async (args) => {
    if (args.includes('rev-parse')) return `${root}\n`;
    if (args.includes('worktree')) return [
      `worktree ${root}`, 'HEAD 1234', 'branch refs/heads/main', '',
      `worktree ${sibling}`, 'HEAD abcd', 'branch refs/heads/agent/review', 'locked private lock reason', '',
      '',
    ].join('\0');
    if (args.includes('status') && args.includes(sibling)) return '?? private.key\0';
    if (args.includes('status')) return ' M private/source.mjs\0';
    throw new Error('unexpected command');
  } });
  const result = await source.listForCwd(root);
  assert.deepEqual(result, [
    { branch: 'main', status: 'changed', changed: 1, untracked: 0, conflicted: 0, detached: false, locked: false, prunable: false, current: true },
    { branch: 'agent/review', status: 'untracked', changed: 0, untracked: 1, conflicted: 0, detached: false, locked: true, prunable: false, current: false },
  ]);
  assert.ok(!JSON.stringify(result).includes(root));
  assert.ok(!JSON.stringify(result).includes(sibling));
  assert.ok(!JSON.stringify(result).includes('private.key'));
  assert.ok(!JSON.stringify(result).includes('lock reason'));
});

test('worktree adapter ignores archived sessions and caps unique active locations', async () => {
  let calls = 0;
  const source = createWorktreeSource({ runGit: async () => (calls++, '') });
  const sessions = Array.from({ length: 23 }, (_, i) => rec(200 + i, { cwd: fakePath(`repo-${i}`), lastActivityAt: NOW - i }));
  sessions.push(rec(250, { cwd: fakePath('archived'), isArchived: true }));
  const result = await source.enrich(sessions);
  assert.equal(calls, 20, 'only 20 rev-parse calls run; failed repositories stop there');
  assert.equal(source.stats().skipped, 3);
  assert.equal(result.at(-1).gitWorktree, undefined);
});

test('network locations are skipped and unknown Git status is explicit without diagnostics', async () => {
  let calls = 0;
  const source = createWorktreeSource({ runGit: async () => (calls++, '') });
  const network = process.platform === 'win32' ? '\\\\server\\share\\repo' : '//server/share/repo';
  const result = await source.enrich([rec(260, { cwd: network })]);
  assert.equal(calls, 0);
  assert.deepEqual(result[0].gitWorktree, { branch: null, status: 'unknown', changed: 0, untracked: 0, conflicted: 0, locked: false, prunable: false });
  assert.deepEqual(source.stats(), { scanned: 1, matched: 0, unavailable: 1, skipped: 0 });
});
