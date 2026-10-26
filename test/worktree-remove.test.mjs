import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createWorktreeRemover } from '../src/adapters/worktree-remove-git.mjs';

const root = path.join(path.parse(process.cwd()).root, 'agent-canvas-fixture', 'repo');
const sibling = path.join(path.dirname(root), 'repo-other');
const cwd = path.join(root, 'nested');
const list = (targetFlags = '') => [
  `worktree ${root}`, 'HEAD 1234', 'branch refs/heads/main', '',
  `worktree ${sibling}`, 'HEAD abcd', 'branch refs/heads/agent/review', targetFlags, '', '',
].filter(Boolean).join('\0');

test('explicit worktree removal requires confirmation and exact clean non-current branch, never force', async () => {
  const calls = [];
  const remover = createWorktreeRemover({ runGit: async (args, at) => {
    calls.push({ args, at });
    if (args.includes('--show-toplevel')) return `${root}\n`;
    if (args.includes('list')) return list();
    return '';
  } });
  const result = await remover.remove({ cwd, branch: 'agent/review', confirmed: true });
  assert.deepEqual(result, { ok: true, branch: 'agent/review' });
  const remove = calls.find(({ args }) => args.includes('remove'));
  assert.deepEqual(remove.args.slice(-3), ['worktree', 'remove', sibling]);
  assert.ok(!remove.args.includes('--force'));
  assert.ok(!JSON.stringify(result).includes(root));
});

test('refuses current, locked, prunable, dirty, missing, and unconfirmed worktrees without removing them', async () => {
  for (const [branch, response, expected] of [
    ['main', list(), 'current'],
    ['agent/review', list('locked private reason'), 'locked'],
    ['agent/review', list('prunable private reason'), 'prunable'],
    ['agent/review', list(), 'not_clean'],
    ['missing', list(), 'not_found'],
  ]) {
    const calls = [];
    const remover = createWorktreeRemover({ runGit: async (args) => {
      calls.push(args);
      if (args.includes('--show-toplevel')) return `${root}\n`;
      if (args.includes('list')) return response;
      if (args.includes('status')) return expected === 'not_clean' ? ' M private.txt\0' : '';
      return '';
    } });
    assert.deepEqual(await remover.remove({ cwd, branch, confirmed: true }), { ok: false, reason: expected });
    assert.equal(calls.some((args) => args.includes('remove')), false, expected);
    assert.ok(!JSON.stringify(calls).includes('private reason'));
  }
  let invoked = 0;
  const noConfirm = createWorktreeRemover({ runGit: async () => (invoked++, `${root}\n`) });
  assert.deepEqual(await noConfirm.remove({ cwd, branch: 'agent/review', confirmed: false }), { ok: false, reason: 'invalid_target' });
  assert.equal(invoked, 0);
});

test('rejects invalid and network targets before Git and hides command failures', async () => {
  let invoked = 0;
  const remover = createWorktreeRemover({ runGit: async () => { invoked++; throw new Error('private Git diagnostic'); } });
  assert.deepEqual(await remover.remove({ cwd: '\\\\server\\share\\repo', branch: 'agent/review', confirmed: true }), { ok: false, reason: 'invalid_target' });
  assert.deepEqual(await remover.remove({ cwd, branch: '../outside', confirmed: true }), { ok: false, reason: 'invalid_branch' });
  assert.equal(invoked, 0);
  assert.deepEqual(await remover.remove({ cwd, branch: 'agent/review', confirmed: true }), { ok: false, reason: 'not_repo' });
});
