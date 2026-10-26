import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createCodexDelegationRunner, resolveCodexExecutable } from '../src/adapters/codex-delegation-runner.mjs';

const sessionId = '12345678-1234-1234-1234-1234567890ab';
const operationId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

test('Codex executable resolution ignores relative PATH entries and returns only an absolute CLI binary', () => {
  const candidates = new Set(['C:\\trusted\\bin\\codex.exe']);
  const result = resolveCodexExecutable({ env: { Path: '.;C:\\trusted\\bin;repo\\tools' }, platform: 'win32', exists: (file) => candidates.has(file) });
  assert.equal(result, 'C:\\trusted\\bin\\codex.exe');
  assert.equal(resolveCodexExecutable({ env: { PATH: '.:./tools' }, platform: 'linux', exists: () => true }), null);
});

test('confirmed Codex delegation uses read-only resume, sends purpose only on stdin, and discards output', () => {
  const child = new EventEmitter();
  child.stdin = { value: '', end(value) { this.value = value; } };
  const calls = [];
  const runner = createCodexDelegationRunner({ executable: 'codex-fixture', spawn: (...args) => (calls.push(args), child) });
  const purpose = 'Please review the checked-in design decisions.';
  const started = runner.start({ sessionId, cwd: '/synthetic/workspace', purpose, confirmed: true, operationId });
  assert.equal(started.ok, true);
  assert.equal(started.operationId, operationId);
  assert.deepEqual(calls[0][1], ['exec', '--sandbox', 'read-only', 'resume', sessionId, '-']);
  assert.equal(calls[0][2].shell, false);
  assert.deepEqual(calls[0][2].stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(calls[0][2].cwd, '/synthetic/workspace');
  assert.equal(child.stdin.value, purpose);
  assert.equal(JSON.stringify(calls).includes(purpose), false);
  assert.equal(runner.status(started.operationId), 'running');
  assert.deepEqual(runner.start({ sessionId, cwd: '/synthetic/workspace', purpose, confirmed: true, operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }), { ok: false, reason: 'already_running' });
  assert.deepEqual(runner.start({ sessionId, cwd: '/synthetic/workspace', purpose, confirmed: true, operationId }), { ok: true, operationId, status: 'running' }, 'a retried request is idempotent while the operation is known');
  child.emit('close', 0, null);
  assert.equal(runner.status(started.operationId), 'completed');
  assert.deepEqual(runner.start({ sessionId, cwd: '/synthetic/workspace', purpose, confirmed: true, operationId }), { ok: true, operationId, status: 'completed' }, 'a repeated operation ID never launches a second CLI process');
  assert.equal(calls.length, 1);
});

test('refuses unconfirmed, malformed, empty, or oversized delegation without spawning', () => {
  let count = 0;
  const runner = createCodexDelegationRunner({ spawn: () => (count++, {}) });
  for (const input of [
    { sessionId, cwd: '/synthetic', purpose: 'review', confirmed: false, operationId },
    { sessionId: '../outside', cwd: '/synthetic', purpose: 'review', confirmed: true, operationId },
    { sessionId, cwd: '/synthetic', purpose: '  ', confirmed: true, operationId },
    { sessionId, cwd: '/synthetic', purpose: 'x'.repeat(2001), confirmed: true, operationId },
  ]) assert.equal(runner.start(input).ok, false);
  assert.equal(count, 0);
});

test('missing Codex CLI fails closed without searching from the target workspace', () => {
  let count = 0;
  const runner = createCodexDelegationRunner({ executable: null, spawn: () => (count++, {}) });
  assert.deepEqual(runner.start({ sessionId, cwd: '/synthetic/repo', purpose: 'review', confirmed: true, operationId }), { ok: false, reason: 'cli_unavailable' });
  assert.equal(count, 0);
});

test('stdin handoff failure terminates the child and keeps the session locked until it closes', () => {
  const child = new EventEmitter();
  let killed = false;
  child.stdin = { end() { throw new Error('synthetic closed pipe'); } };
  child.kill = () => { killed = true; return true; };
  const runner = createCodexDelegationRunner({ executable: 'codex-fixture', spawn: () => child });
  const failed = runner.start({ sessionId, cwd: '/synthetic/workspace', purpose: 'Review the design.', confirmed: true, operationId });
  assert.deepEqual(failed, { ok: true, operationId, status: 'failed' });
  assert.equal(killed, true);
  assert.deepEqual(runner.start({ sessionId, cwd: '/synthetic/workspace', purpose: 'Retry.', confirmed: true, operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }), { ok: false, reason: 'already_running' });
  child.emit('close', null, 'SIGTERM');
  assert.equal(runner.status(operationId), 'failed');
  assert.deepEqual(runner.start({ sessionId, cwd: '/synthetic/workspace', purpose: 'Retry.', confirmed: true, operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }).status, 'failed');
});

