import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

test('WSL worktree actions use the shared detail renderer once while gating removal to adapter-approved rows', () => {
  const bar = fs.readFileSync(new URL('../public/canvas-bar.mjs', import.meta.url), 'utf8');
  const rows = fs.readFileSync(new URL('../public/rows.mjs', import.meta.url), 'utf8');
  const actions = fs.readFileSync(new URL('../public/canvas-act.mjs', import.meta.url), 'utf8');
  const api = fs.readFileSync(new URL('../public/api.mjs', import.meta.url), 'utf8');
  const dictionaries = ['dict-ja-canvas.mjs', 'dict-en-canvas.mjs'].map((file) => fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
  assert.doesNotMatch(bar, /worktree\.wslUnavailable|data-action': 'worktree-list'/);
  assert.match(bar, /executionLocation !== 'wsl'\) acts\.append\([^\n]*data-action': 'worktree-create'/);
  assert.match(rows, /data-action': 'worktree-list'/);
  assert.match(rows, /data-action': 'worktree-create'/);
  assert.match(actions, /requireRemovableFlag: entry\.card\.detail\?\.executionLocation === 'wsl'/);
  assert.match(api, /removable: item\?\.removable === true/);
  for (const dict of dictionaries) assert.match(dict, /'worktree\.wslUnavailable':/);
});
