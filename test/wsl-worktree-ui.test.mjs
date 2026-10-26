import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

test('WSL detail offers read-only worktree inventory without create or remove controls', () => {
  const bar = fs.readFileSync(new URL('../public/canvas-bar.mjs', import.meta.url), 'utf8');
  const rows = fs.readFileSync(new URL('../public/rows.mjs', import.meta.url), 'utf8');
  const actions = fs.readFileSync(new URL('../public/canvas-act.mjs', import.meta.url), 'utf8');
  const dictionaries = ['dict-ja-canvas.mjs', 'dict-en-canvas.mjs'].map((file) => fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'));
  assert.match(bar, /executionLocation === 'wsl'[\s\S]*?data-action': 'worktree-list'/);
  assert.match(bar, /data-action': 'worktree-create'/);
  assert.match(rows, /data-action': 'worktree-list'/);
  assert.match(actions, /remove: entry\.card\.detail\?\.executionLocation === 'wsl' \? undefined/);
  for (const dict of dictionaries) assert.match(dict, /'worktree\.wslUnavailable':/);
});
