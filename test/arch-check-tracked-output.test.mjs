import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Arch rule 12e (scripts/arch-check.mjs): a tracked file under bin/ or obj/ is a violation, and a check that could not look (no git) fails instead of passing.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('arch rule 12e fails when git cannot be run, and passes with git', () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'albera-arch-nogit-'));
  try {
    // PATH names an empty folder, so `git` is not found; node itself is started by its absolute path.
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'arch-check.mjs')], { cwd: root, encoding: 'utf8', env: { SystemRoot: process.env.SystemRoot, PATH: empty, Path: empty } });
    assert.equal(result.status, 1, 'the arch check fails');
    assert.match(result.stderr, /\[12e tracked build output\] git ls-files -z could not run \(.+\): the check did not run \(false-safe\)/u);
  } finally { rmSync(empty, { recursive: true, force: true }); }
  const normal = spawnSync(process.execPath, [path.join(root, 'scripts', 'arch-check.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(normal.stdout, /12e no tracked file under bin\/ or obj\/: 0 found/u);
});
