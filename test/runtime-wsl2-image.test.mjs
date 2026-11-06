import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The image build (ADR-012). The whole build needs root, chroot and a download, so it is measured in a throwaway distribution. These cover its
// refusals, which stop before any of that.

const SCRIPT = path.resolve('src/runtime/wsl2-guest/build-image.sh');
const LAUNCHER = path.resolve('src/runtime/wsl2-guest/launcher.c');
const linux = process.platform === 'linux' ? false : 'needs bash on Linux';
const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });

test('the build stops on the wrong number of arguments', { skip: linux }, () => {
  assert.equal(run('one').status, 80);
});

test('the build refuses a base that is not the pinned file', { skip: linux }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'albera-image-'));
  try {
    const base = path.join(dir, 'base.tar.gz');
    writeFileSync(base, 'not the pinned file');
    const result = run(base, path.join(dir, 'out.tar'));
    assert.equal(result.status, 82, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the base is pinned by SHA-256', () => {
  assert.match(readFileSync(SCRIPT, 'utf8'), /^BASE_SHA256=[0-9a-f]{64} /mu);
});

test('the image compiles its own programs, with no flag that makes a test build', () => {
  const lines = readFileSync(SCRIPT, 'utf8').split('\n').filter((line) => line.startsWith('gcc '));
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(line, /^gcc -O2 -static -Wall -Wextra -Werror -o /u);
    assert.doesNotMatch(line, /-D/u);
  }
});

test('the image keeps no file capabilities', () => {
  assert.doesNotMatch(readFileSync(SCRIPT, 'utf8'), /^tar .*--xattrs/mu);
});

test('a run names its cgroup so that a run in another distribution cannot collide with it', () => {
  const enter = readFileSync(path.resolve('src/runtime/wsl2-guest/enter.sh'), 'utf8');
  assert.match(enter, /^GROUP="\/sys\/fs\/cgroup\/albera-run-\$\(cat \/proc\/sys\/kernel\/random\/uuid\)"$/mu);
});

test('every build of the launcher that must not ship carries the marker', () => {
  assert.match(readFileSync(LAUNCHER, 'utf8'), /#if ALBERA_BROKEN != 0 \|\| defined\(ALBERA_TEST_BUILD\)\n.*ALBERA-NOT-FOR-SHIPPING/u);
});

test('no call may change the core limit: it is off the allowlist and has its own rule', () => {
  const source = readFileSync(LAUNCHER, 'utf8');
  const allowed = source.slice(source.indexOf('static const int ALLOWED[]'), source.indexOf('};', source.indexOf('static const int ALLOWED[]')));
  assert.doesNotMatch(allowed, /SYS_setrlimit|SYS_prlimit64/u);
  assert.match(source, /core_limit_rule\(\);/u);
});
