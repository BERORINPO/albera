import test from 'node:test';
import assert from 'node:assert/strict';
import { terminatePosixTree } from '../src/runtime/posix-tree-termination.mjs';

test('confirms a process group after successful TERM and KILL escalation', async () => {
  const signals = [];
  const result = await terminatePosixTree(42, 'SIGTERM', {
    killImpl: (pid, signal) => signals.push([pid, signal]),
    delayImpl: async () => {},
  });

  assert.deepEqual(signals, [[-42, 'SIGTERM'], [-42, 'SIGKILL']]);
  assert.deepEqual(result, {
    treeConfirmed: true,
    confirmed: true,
    fallbackAttempted: false,
    fallbackAccepted: false,
  });
});

test('treats an already absent process group as confirmed', async () => {
  const error = Object.assign(new Error('no such process'), { code: 'ESRCH' });
  const result = await terminatePosixTree(42, 'SIGKILL', {
    killImpl: () => { throw error; },
  });

  assert.equal(result.treeConfirmed, true);
  assert.equal(result.fallbackAttempted, false);
});

test('does not confirm descendants when group signaling fails and direct child fallback succeeds', async () => {
  const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  let fallbackCalls = 0;
  const result = await terminatePosixTree(42, 'SIGKILL', {
    killImpl: () => { throw error; },
    fallbackImpl: () => { fallbackCalls += 1; return true; },
  });

  assert.equal(fallbackCalls, 1);
  assert.deepEqual(result, {
    treeConfirmed: false,
    confirmed: false,
    fallbackAttempted: true,
    fallbackAccepted: true,
  });
});

test('does not confirm cleanup when escalation cannot signal the process group', async () => {
  const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  let callCount = 0;
  let fallbackCalls = 0;
  const result = await terminatePosixTree(42, 'SIGTERM', {
    killImpl: () => {
      callCount += 1;
      if (callCount === 2) throw error;
    },
    fallbackImpl: () => { fallbackCalls += 1; return true; },
    delayImpl: async () => {},
  });

  assert.equal(callCount, 2);
  assert.equal(fallbackCalls, 1);
  assert.equal(result.treeConfirmed, false);
  assert.equal(result.fallbackAttempted, true);
});

test('tries SIGKILL escalation even when the initial group signal fails', async () => {
  const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  const signals = [];
  let fallbackCalls = 0;
  const result = await terminatePosixTree(42, 'SIGTERM', {
    killImpl: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === 'SIGTERM') throw error;
    },
    fallbackImpl: () => { fallbackCalls += 1; return true; },
    delayImpl: async () => {},
  });

  assert.deepEqual(signals, [[-42, 'SIGTERM'], [-42, 'SIGKILL']]);
  assert.equal(fallbackCalls, 1);
  assert.equal(result.treeConfirmed, true);
  assert.equal(result.fallbackAttempted, true);
});
