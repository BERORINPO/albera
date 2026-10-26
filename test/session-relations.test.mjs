import test from 'node:test';
import assert from 'node:assert/strict';
import { openRelatedSessionDetail, sessionRelationEntries } from '../public/session-relations.mjs';

const first = 'codex_00000000-0000-4000-8000-000000000001';
const second = 'local_00000000-0000-4000-8000-000000000002';
const edge = (from, to, purpose, status = 'active') => ({ id: 'edge', from: `session:${from}`, to: `session:${to}`, kind: 'delegates', purpose, status });

test('session detail projection exposes safe session-to-session delegation in both directions', () => {
  const entries = sessionRelationEntries([edge(first, second, 'Implement the documented change')], first, { nodes: [] }, [{ id: first }, { id: second }]);
  assert.deepEqual(entries, [{
    direction: 'out', kind: 'delegates', purpose: 'Implement the documented change', status: 'active', endpoint: 'session', sessionId: second,
  }]);
  assert.equal(JSON.stringify(entries).includes('title'), false);

  const inbound = sessionRelationEntries([edge(first, second, 'Review the result')], second, { nodes: [] }, [{ id: first }, { id: second }]);
  assert.deepEqual(inbound.map(({ direction, sessionId }) => ({ direction, sessionId })), [{ direction: 'in', sessionId: first }]);
});

test('session detail projection ignores dangling session endpoints', () => {
  const entries = sessionRelationEntries([edge(first, second, 'This target is not on the board')], first, { nodes: [] }, [{ id: first }]);
  assert.deepEqual(entries, []);
});

test('following a related session opens the internal detail bar', () => {
  const calls = [];
  const opened = openRelatedSessionDetail(second, (...args) => { calls.push(args); return true; });
  assert.equal(opened, true);
  assert.deepEqual(calls, [['detail', second]]);
});
