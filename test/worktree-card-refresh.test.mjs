import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { linkedWorktreeSessionId, worktreeRefreshState } from '../public/graph-actions.mjs';
import { canRecordWorktreeItem } from '../public/worktree-list-dialog.mjs';

const sessionId = 'codex_00000000-0000-4000-8000-000000000001';
const node = { id: 'g_worktree', kind: 'worktree', title: 'feature/review', status: 'open' };
const edge = { from: 'graph:g_worktree', to: `session:${sessionId}`, kind: 'related' };

test('worktree card refresh can use only its live related source session', () => {
  assert.equal(linkedWorktreeSessionId(node, { edges: [edge] }, new Set([sessionId])), sessionId);
  assert.equal(linkedWorktreeSessionId(node, { edges: [{ ...edge, kind: 'depends_on' }] }, new Set([sessionId])), '');
  assert.equal(linkedWorktreeSessionId(node, { edges: [{ ...edge, from: 'graph:another' }] }, new Set([sessionId])), '');
  assert.equal(linkedWorktreeSessionId(node, { edges: [edge] }, new Set()), '');
  assert.equal(linkedWorktreeSessionId({ ...node, status: 'done' }, { edges: [edge] }, new Set([sessionId])), '');
});

test('worktree refresh explains missing source without exposing ids or paths', () => {
  assert.deepEqual(worktreeRefreshState(node, { edges: [] }, new Set()), { status: 'unlinked' });
  assert.deepEqual(worktreeRefreshState(node, { edges: [edge] }, new Set()), { status: 'source_missing' });
  const live = 'codex_00000000-0000-4000-8000-000000000002';
  assert.deepEqual(worktreeRefreshState(node, { edges: [edge, { ...edge, to: `session:${live}` }] }, new Set([live])), { status: 'available', sessionId: live });
  assert.deepEqual(worktreeRefreshState({ ...node, status: 'done' }, { edges: [] }, new Set()), { status: 'not_applicable' });
});

test('a card refresh can record only its target branch from the live inventory', () => {
  assert.equal(canRecordWorktreeItem({ branch: 'feature/review' }, 'feature/review'), true);
  assert.equal(canRecordWorktreeItem({ branch: 'main' }, 'feature/review'), false);
  assert.equal(canRecordWorktreeItem({ branch: null }, 'feature/review'), false);
  assert.equal(canRecordWorktreeItem({ branch: 'main' }), true, 'the general inventory still allows recording any listed branch');
});

test('canvas worktree refresh is wired through the card dialog into the bounded inventory flow', () => {
  const dialog = fs.readFileSync(new URL('../public/graph-dialog.mjs', import.meta.url), 'utf8');
  const canvas = fs.readFileSync(new URL('../public/canvas-act.mjs', import.meta.url), 'utf8');
  const inventory = fs.readFileSync(new URL('../public/worktree-list-dialog.mjs', import.meta.url), 'utf8');
  assert.match(dialog, /node\?\.kind === 'worktree' && o\.onRefreshWorktree/);
  assert.match(dialog, /worktreeRefreshUnavailable/);
  assert.match(dialog, /o\.onRefreshWorktree\(\(\) => \{ if \(dialog\.open\) dialog\.close\(\); \}\)/);
  assert.match(canvas, /refreshWorktree: \(sessionId, branch, afterClose\) => listWorktreesForSession\(sessionId, branch, afterClose\)/);
  assert.match(canvas, /recordBranch,/);
  assert.match(canvas, /remove: recordBranch \|\| state\.board\?\.stats\?\.demo/);
  assert.match(inventory, /if \(!canRecordWorktreeItem\(currentItems\[index\], options\.recordBranch\)\) return/);
});
