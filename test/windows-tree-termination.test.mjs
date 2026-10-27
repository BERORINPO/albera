import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { terminateWindowsTree } from '../src/runtime/windows-tree-termination.mjs';

function fakeTaskkill(exitCode, error) {
  const child = new EventEmitter();
  queueMicrotask(() => error ? child.emit('error', error) : child.emit('close', exitCode, null));
  return child;
}

test('successful taskkill confirms tree cleanup without direct-child fallback', async () => {
  let args;
  let fallbackCalls = 0;
  const result = await terminateWindowsTree(1234, {
    systemRoot: 'C:\\Windows',
    spawnImpl: (executable, childArgs, options) => {
      assert.equal(executable, 'C:\\Windows\\System32\\taskkill.exe');
      assert.deepEqual(options, { shell: false, windowsHide: true, stdio: 'ignore' });
      args = childArgs;
      return fakeTaskkill(0);
    },
    killFallback: () => { fallbackCalls++; return true; },
  });
  assert.deepEqual(args, ['/PID', '1234', '/T', '/F']);
  assert.deepEqual(result, { treeConfirmed: true, fallbackAttempted: false, fallbackAccepted: false });
  assert.equal(fallbackCalls, 0);
});

test('non-zero taskkill exit falls back to terminating the direct child', async () => {
  let fallbackCalls = 0;
  const result = await terminateWindowsTree(2345, {
    systemRoot: 'C:\\Windows',
    spawnImpl: () => fakeTaskkill(5),
    killFallback: () => { fallbackCalls++; return true; },
  });
  assert.deepEqual(result, { treeConfirmed: false, fallbackAttempted: true, fallbackAccepted: true });
  assert.equal(fallbackCalls, 1);
});

test('taskkill spawn errors and missing SystemRoot use the direct-child fallback', async () => {
  let fallbackCalls = 0;
  const killFallback = () => { fallbackCalls++; return false; };
  const spawnFailure = await terminateWindowsTree(3456, {
    systemRoot: 'C:\\Windows', spawnImpl: () => { throw new Error('spawn_failed'); }, killFallback,
  });
  const missingRoot = await terminateWindowsTree(4567, {
    systemRoot: '', spawnImpl: () => { throw new Error('must_not_spawn'); }, killFallback,
  });
  assert.deepEqual(spawnFailure, { treeConfirmed: false, fallbackAttempted: true, fallbackAccepted: false });
  assert.deepEqual(missingRoot, { treeConfirmed: false, fallbackAttempted: true, fallbackAccepted: false });
  assert.equal(fallbackCalls, 2);
});
