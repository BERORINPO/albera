import test from 'node:test';
import assert from 'node:assert/strict';
import { comprehensionGapSummary, openRelatedSessionDetail, resolveRelatedSessionShortId, sessionRelationEntries } from '../public/session-relations.mjs';

const first = 'codex_00000000-0000-4000-8000-000000000001';
const second = 'local_00000000-0000-4000-8000-000000000002';
const edge = (from, to, purpose, status = 'active') => ({ id: 'edge', from: `session:${from}`, to: `session:${to}`, kind: 'delegates', purpose, status });

test('comprehension details distinguish unrecorded fields from a lack of evidence or explanation', () => {
  const copy = {
    'graph.notRecorded': 'Not recorded',
    'graph.checkedPersonSummary': 'Checked person: {name}',
    'graph.missingEvidence': 'Missing evidence: {text}',
    'graph.neededExplanation': 'Explanation needed: {text}',
  };
  const t = (key, values = {}) => Object.entries(values).reduce((result, [name, value]) => result.replace(`{${name}}`, value), copy[key]);
  assert.deepEqual(comprehensionGapSummary({ checkedPerson: '', missingEvidence: '', neededExplanation: '' }, t), [
    'Checked person: Not recorded', 'Missing evidence: Not recorded', 'Explanation needed: Not recorded',
  ]);
  assert.deepEqual(comprehensionGapSummary({ checkedPerson: 'reviewer', missingEvidence: 'decision record', neededExplanation: '' }, t), [
    'Checked person: reviewer', 'Missing evidence: decision record', 'Explanation needed: Not recorded',
  ]);
});

test('session detail projection exposes safe session-to-session delegation in both directions', () => {
  const entries = sessionRelationEntries([edge(first, second, 'Implement the documented change')], first, { nodes: [] }, [{ id: first }, { id: second }]);
  assert.deepEqual(entries, [{
    edgeId: 'edge', direction: 'out', kind: 'delegates', purpose: 'Implement the documented change', status: 'active', endpoint: 'session', sessionId: second,
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
    executionHarness: 'codex_cli', executionLocation: 'wsl', workspaceIsolation: 'sandboxed', networkAccess: 'restricted', approvalMode: 'per_action',
    body: '/private/path', url: 'https://example.com/private', secret: 'do-not-project',
  }] };
  const relation = { id: 'profile-edge', from: `graph:${profileId}`, to: `session:${first}`, kind: 'related', purpose: 'Manual association', status: '' };
  const entries = sessionRelationEntries([relation], first, graph, [{ id: first }]);
  assert.deepEqual(entries[0].node, {
    id: profileId, kind: 'execution_profile', title: 'Manual profile',
    executionHarness: 'codex_cli', executionLocation: 'wsl', workspaceIsolation: 'sandboxed', networkAccess: 'restricted', approvalMode: 'per_action',
  });
  assert.equal(entries[0].node.executionHarness, 'codex_cli');
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
    evidenceLinks: [{ endpoint: 'session', source: 'codex', shortId: '000000000001' }], explanationLinks: [],
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
  assert.deepEqual(entries[0].node.evidenceLinks, [{ endpoint: 'graph', nodeId: artifactId, kind: 'artifact', title: 'Reviewed REA summary' }]);
  assert.deepEqual(entries[0].node.explanationLinks, [{ endpoint: 'session', source: 'claude', shortId: '000000000007' }]);
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

test('opaque short session targets resolve only one matching provider session', () => {
  const sessions = [
    { id: 'codex_aaaaaaaa000000000001' },
    { id: 'local_bbbbbbbb000000000002' },
  ];
  assert.equal(resolveRelatedSessionShortId('codex', '000000000001', sessions), sessions[0].id);
  assert.equal(resolveRelatedSessionShortId('claude', '000000000002', sessions), sessions[1].id);
  assert.equal(resolveRelatedSessionShortId('codex', '000000000002', sessions), null);
  assert.equal(resolveRelatedSessionShortId('unknown', '000000000001', sessions), null);
  assert.equal(resolveRelatedSessionShortId('codex', 'aaaaaaaa000000000001', sessions), null);
});

test('Obsidian session relations expose the card title but never the vault or note path', () => {
  const noteId = 'g_00000000-0000-4000-8000-000000000008';
  const graph = { nodes: [{
    id: noteId, kind: 'obsidian_note', title: 'Architecture decision', body: 'Reviewed note summary',
    knowledgeVault: 'Private Vault', knowledgeFile: 'Private/Client/Decision.md',
  }] };
  const edges = [{ id: 'note-edge', from: `graph:${noteId}`, to: `session:${first}`, kind: 'related', purpose: '', status: '' }];
  const entries = sessionRelationEntries(edges, first, graph, [{ id: first }]);
  assert.deepEqual(entries[0].node, { id: noteId, kind: 'obsidian_note', title: 'Architecture decision' });
  const json = JSON.stringify(entries);
  assert.equal(json.includes('Private Vault'), false);
  assert.equal(json.includes('Private/Client/Decision.md'), false);
  assert.equal(json.includes('Reviewed note summary'), false);
});
