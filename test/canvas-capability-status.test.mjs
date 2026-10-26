import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('canvas exposes an action that opens the session and product capability status panel', () => {
  const bar = fs.readFileSync(new URL('../public/canvas-bar.mjs', import.meta.url), 'utf8');
  const actions = fs.readFileSync(new URL('../public/canvas-act.mjs', import.meta.url), 'utf8');
  assert.match(bar, /'data-action': 'graph-show-diagnostics', text: t\('canvas\.status'\)/);
  assert.match(actions, /'graph-show-diagnostics': \(\) => \{[\s\S]*?switchView\('list'\)[\s\S]*?details\.open = true/);
});
