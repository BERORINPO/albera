import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

test('WSL detail exposes confirmed create and list actions while gating removal to adapter-approved rows', () => {
  const bar = fs.readFileSync(new URL('../public/canvas-bar.mjs', import.meta.url), 'utf8');
  const rows = fs.readFileSync(new URL('../public/rows.mjs', import.meta.url), 'utf8');
  const actions = fs.readFileSync(new URL('../public/canvas-act.mjs', import.meta.url), 'utf8');
  const api = fs.readFileSync(new URL('../public/api.mjs', import.meta.url), 'utf8');
  const dictionaries = ['dict-ja-canvas.mjs', 'dict-en-canvas.mjs'].map((file) => fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
  assert.match(bar, /executionLocation === 'wsl'[\s\S]*?data-action': 'worktree-create'[\s\S]*?data-action': 'worktree-list'/);
  assert.match(rows, /data-action': 'worktree-list'/);
  assert.match(actions, /requireRemovableFlag: entry\.card\.detail\?\.executionLocation === 'wsl'/);
  assert.match(api, /removable: item\?\.removable === true/);
  for (const dict of dictionaries) assert.match(dict, /'worktree\.wslUnavailable':/);
});
