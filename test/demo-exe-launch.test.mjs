import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const LAUNCH = fileURLToPath(new URL('../scripts/demo-exe/launch.mjs', import.meta.url));

function root(t, entryText) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'albera-demo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'src', 'runtime'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'runtime', 'entry.mjs'), entryText);
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [LAUNCH, dir, '48760'], { encoding: 'utf8', env: { ...process.env, ALBERA_DEMO_NOBROWSER: '1' } });

test('the launcher starts the demo room and never prints the one-time code', (t) => {
  const dir = root(t, "console.log(process.argv.slice(2).join(' ')); console.log('One-time UI bootstrap code: abc_DEF-123');\n");
  const result = run(dir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /page is open/u);
  assert.doesNotMatch(result.stdout, /abc_DEF-123/u);
});

test('the launcher passes on the exit code of a room that fails', (t) => {
  const result = run(root(t, 'process.exit(3);\n'));
  assert.equal(result.status, 3);
  assert.doesNotMatch(result.stdout, /page is open/u);
});
