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

test('execution-profile relations expose only their fixed user-declared fields', () => {
  const profileId = 'g_00000000-0000-4000-8000-000000000003';
  const graph = { nodes: [{
    id: profileId, kind: 'execution_profile', title: 'Manual profile',
    executionLocation: 'wsl', workspaceIsolation: 'sandboxed', networkAccess: 'restricted', approvalMode: 'per_action',
    body: '/private/path', url: 'https://example.com/private', secret: 'do-not-project',
  }] };
  const relation = { id: 'profile-edge', from: `graph:${profileId}`, to: `session:${first}`, kind: 'related', purpose: 'Manual association', status: '' };
  const entries = sessionRelationEntries([relation], first, graph, [{ id: first }]);
  assert.deepEqual(entries[0].node, {
    id: profileId, kind: 'execution_profile', title: 'Manual profile',
    executionLocation: 'wsl', workspaceIsolation: 'sandboxed', networkAccess: 'restricted', approvalMode: 'per_action',
  });
  assert.equal(JSON.stringify(entries).includes('/private/path'), false);
  assert.equal(JSON.stringify(entries).includes('do-not-project'), false);
});

test('comprehension-gap relations expose only the user-authored check and evidence fields', () => {
  const gapId = 'g_00000000-0000-4000-8000-000000000004';
  const graph = { nodes: [{
    id: gapId, kind: 'understanding_gap', title: 'Explain the decision', status: 'open',
    checkedPerson: 'reviewer', missingEvidence: 'source record', neededExplanation: 'rationale',
    body: '/private/path', url: 'https://example.com/private', secret: 'do-not-project',
  }] };
  const relation = { id: 'gap-edge', from: `graph:${gapId}`, to: `session:${first}`, kind: 'evidence', purpose: '', status: '' };
  const entries = sessionRelationEntries([relation], first, graph, [{ id: first }]);
  assert.deepEqual(entries[0].node, {
    id: gapId, kind: 'understanding_gap', title: 'Explain the decision', status: 'open',
    checkedPerson: 'reviewer', missingEvidence: 'source record', neededExplanation: 'rationale',
    evidenceLinks: [{ endpoint: 'session', source: 'codex', shortId: '00000001' }], explanationLinks: [],
  });
  assert.equal(JSON.stringify(entries).includes('/private/path'), false);
  assert.equal(JSON.stringify(entries).includes('do-not-project'), false);
});

test('comprehension summaries list linked evidence and explanations without session titles or file paths', () => {
  const gapId = 'g_00000000-0000-4000-8000-000000000005';
  const artifactId = 'g_00000000-0000-4000-8000-000000000006';
  const otherSession = 'local_00000000-0000-4000-8000-000000000007';
  const graph = { nodes: [
    { id: gapId, kind: 'understanding_gap', title: 'Check rationale', status: 'open', checkedPerson: '', missingEvidence: 'trace', neededExplanation: 'decision', body: '', url: '' },
    { id: artifactId, kind: 'artifact', title: 'Reviewed REA summary', body: '/private/path', url: 'https://example.com/private' },
  ] };
  const edges = [
    { id: 'related-edge', from: `graph:${gapId}`, to: `session:${first}`, kind: 'related', purpose: '', status: '' },
    { id: 'evidence-edge', from: `graph:${gapId}`, to: `graph:${artifactId}`, kind: 'evidence', purpose: '', status: '' },
    { id: 'explains-edge', from: `session:${otherSession}`, to: `graph:${gapId}`, kind: 'explains', purpose: '', status: '' },
  ];
  const entries = sessionRelationEntries(edges, first, { ...graph, edges }, [{ id: first }, { id: otherSession }]);
  assert.deepEqual(entries[0].node.evidenceLinks, [{ endpoint: 'graph', kind: 'artifact', title: 'Reviewed REA summary' }]);
  assert.deepEqual(entries[0].node.explanationLinks, [{ endpoint: 'session', source: 'claude', shortId: '00000007' }]);
  assert.equal(JSON.stringify(entries).includes('/private/path'), false);
  assert.equal(JSON.stringify(entries).includes('https://example.com/private'), false);
  assert.equal(JSON.stringify(entries).includes(otherSession), false);
});

test('following a related session opens the internal detail bar', () => {
  const calls = [];
  const opened = openRelatedSessionDetail(second, (...args) => { calls.push(args); return true; });
  assert.equal(opened, true);
  assert.deepEqual(calls, [['detail', second]]);
});
