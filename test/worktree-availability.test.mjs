import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { worktreeCreationAvailability } from '../public/worktree-availability.mjs';

test('worktree detail explains demo unavailability and keeps confirmed real actions available', () => {
  assert.deepEqual(worktreeCreationAvailability('local', true), { enabled: false, notice: 'demo' });
  assert.deepEqual(worktreeCreationAvailability('wsl', true), { enabled: false, notice: 'demo' });
  assert.deepEqual(worktreeCreationAvailability('local', false), { enabled: true, notice: null });
  assert.deepEqual(worktreeCreationAvailability('wsl', false), { enabled: true, notice: 'wsl' });

  const rows = fs.readFileSync(new URL('../public/rows.mjs', import.meta.url), 'utf8');
  const actions = fs.readFileSync(new URL('../public/worktree-actions.mjs', import.meta.url), 'utf8');
  const canvas = fs.readFileSync(new URL('../public/canvas-bar.mjs', import.meta.url), 'utf8');
  assert.match(rows, /\.\.\.worktreeDetailActions\(t, card, !!ctx\.board\?\.stats\?\.demo\)/);
  assert.match(actions, /worktreeCreationAvailability\(card\.detail\?\.executionLocation, demo\)/);
  assert.match(actions, /availability\.notice === 'demo' \? 'worktree\.demoUnavailable' : 'worktree\.wslUnavailable'/);
  assert.match(actions, /availability\.enabled \? h\('button'.*'data-action': 'worktree-create'/);
  assert.doesNotMatch(canvas, /'data-action': 'worktree-create'/, 'canvas detail uses the same session detail action once');
});
