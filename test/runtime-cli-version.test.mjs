import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import process from 'node:process';
import test from 'node:test';
import { probeCliVersion } from '../src/runtime/cli-version.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

test('CLI version probe uses fixed argv, a temporary cwd, and a minimized environment', async () => {
  const child = fakeChild();
  let invocation;
  const result = probeCliVersion('C:\\tools\\claude.exe', {
    platform: 'win32',
    spawnImpl: (executable, args, options) => {
      invocation = { executable, args, options };
      queueMicrotask(() => { child.stdout.emit('data', 'Claude Code v2.1.259'); child.emit('close', 0); });
      return child;
    },
  });
  assert.equal(await result, '2.1.259');
  assert.equal(invocation.executable, 'C:\\tools\\claude.exe');
  assert.deepEqual(invocation.args, ['--version']);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.cwd, os.tmpdir());
  assert.equal('ANTHROPIC_API_KEY' in invocation.options.env, false);
  assert.equal('HOME' in invocation.options.env, false);
});

test('CLI version probe rejects bad, missing, overflowing, and timed out output', async (t) => {
  const bad = fakeChild();
  const badResult = probeCliVersion('fixture', { spawnImpl: () => { queueMicrotask(() => { bad.stdout.emit('data', 'not a version'); bad.emit('close', 0); }); return bad; } });
  await assert.rejects(badResult, /cli_version_unrecognized/);

  const failed = fakeChild();
  const failedResult = probeCliVersion('fixture', { spawnImpl: () => { queueMicrotask(() => failed.emit('close', 1)); return failed; } });
  await assert.rejects(failedResult, /cli_version_probe_failed/);

  const overflow = fakeChild();
  const overflowResult = probeCliVersion('fixture', { spawnImpl: () => { queueMicrotask(() => overflow.stdout.emit('data', 'x'.repeat(5000))); return overflow; } });
  await assert.rejects(overflowResult, /cli_version_probe_output_too_large/);
  assert.equal(overflow.killed, true);

  const stalled = fakeChild();
  const timeoutResult = probeCliVersion('fixture', { timeoutMs: 100, spawnImpl: () => stalled });
  await assert.rejects(timeoutResult, /cli_version_probe_timeout/);
  assert.equal(stalled.killed, true);
});
