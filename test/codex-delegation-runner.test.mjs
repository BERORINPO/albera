import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createCodexDelegationRunner } from '../src/adapters/codex-delegation-runner.mjs';

const sessionId = '12345678-1234-1234-1234-1234567890ab';

test('confirmed Codex delegation uses read-only resume, sends purpose only on stdin, and discards output', () => {
  const child = new EventEmitter();
  child.stdin = { value: '', end(value) { this.value = value; } };
  const calls = [];
  const runner = createCodexDelegationRunner({ executable: 'codex-fixture', spawn: (...args) => (calls.push(args), child) });
  const purpose = 'Please review the checked-in design decisions.';
  const started = runner.start({ sessionId, cwd: '/synthetic/workspace', purpose, confirmed: true });
  assert.equal(started.ok, true);
  assert.deepEqual(calls[0][1], ['exec', '--sandbox', 'read-only', 'resume', sessionId, '-']);
  assert.equal(calls[0][2].shell, false);
  assert.deepEqual(calls[0][2].stdio, ['pipe', 'ignore', 'ignore']);
  assert.equal(calls[0][2].cwd, '/synthetic/workspace');
  assert.equal(child.stdin.value, purpose);
  assert.equal(JSON.stringify(calls).includes(purpose), false);
  assert.equal(runner.status(started.operationId), 'running');
  assert.deepEqual(runner.start({ sessionId, cwd: '/synthetic/workspace', purpose, confirmed: true }), { ok: false, reason: 'already_running' });
  child.emit('close', 0, null);
  assert.equal(runner.status(started.operationId), 'completed');
});

test('refuses unconfirmed, malformed, empty, or oversized delegation without spawning', () => {
  let count = 0;
  const runner = createCodexDelegationRunner({ spawn: () => (count++, {}) });
  for (const input of [
    { sessionId, cwd: '/synthetic', purpose: 'review', confirmed: false },
    { sessionId: '../outside', cwd: '/synthetic', purpose: 'review', confirmed: true },
    { sessionId, cwd: '/synthetic', purpose: '  ', confirmed: true },
    { sessionId, cwd: '/synthetic', purpose: 'x'.repeat(2001), confirmed: true },
  ]) assert.equal(runner.start(input).ok, false);
  assert.equal(count, 0);
});

