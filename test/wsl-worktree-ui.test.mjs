import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

test('WSL worktree actions use the shared detail renderer once while gating removal to adapter-approved rows', () => {
  const bar = fs.readFileSync(new URL('../public/canvas-bar.mjs', import.meta.url), 'utf8');
  const rows = fs.readFileSync(new URL('../public/rows.mjs', import.meta.url), 'utf8');
  const worktree = fs.readFileSync(new URL('../public/worktree-actions.mjs', import.meta.url), 'utf8');
  const actions = fs.readFileSync(new URL('../public/canvas-act.mjs', import.meta.url), 'utf8');
  const api = fs.readFileSync(new URL('../public/api.mjs', import.meta.url), 'utf8');
  const dictionaries = ['dict-ja-canvas.mjs', 'dict-en-canvas.mjs'].map((file) => fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
  assert.doesNotMatch(bar, /worktree\.wslUnavailable|data-action': 'worktree-list'/);
  assert.doesNotMatch(bar, /data-action': 'worktree-create'/, 'canvas detail gets the one shared worktree action row');
  assert.match(rows, /\.\.\.worktreeDetailActions\(t, card/);
  assert.match(worktree, /data-action': 'worktree-list'/);
  assert.match(worktree, /data-action': 'worktree-create'/);
  assert.match(worktree, /worktreeCreationAvailability\(card\.detail\?\.executionLocation, demo\)/);
  assert.match(actions, /requireRemovableFlag: true/);
  assert.match(api, /removable: item\?\.removable === true/);
  for (const dict of dictionaries) assert.match(dict, /'worktree\.wslUnavailable':/);
});
