import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { GRAPH_STORAGE_KEY, migrateSavedProviderSessionIds } from '../public/graph-store.mjs';
import { opaqueProviderSessionId } from '../src/adapters/opaque-session-id.mjs';
import { addGraphNode, addTaskForSession, addWorktreeForSession, connectGraph, finishGraphDelegationOperation, migrateProviderSessionEndpoints, moveGraphNode, nextGraphNodePosition, normalizeGraph, obsidianOpenUri, releaseBlockedGraphDelegationOperation, removeGraphEdge, removeGraphNode, reviewUnderstandingGaps, safeArtifactUrl, safeObsidianFile, safeObsidianVault, startGraphDelegationOperation, updateGraphEdge, updateGraphNode } from '../public/graph-model.mjs';

const g1 = 'g_00000000-0000-4000-8000-000000000001';
const g2 = 'g_00000000-0000-4000-8000-000000000002';
const e1 = 'e_00000000-0000-4000-8000-000000000001';
const session = 'local_00000000-0000-4000-8000-000000000003';
const empty = () => normalizeGraph(null);
const node = (id, fields = {}) => ({ id, kind: 'task', title: id, body: '', status: 'open', x: 10, y: 20, ...fields });

test('graph model accepts only bounded user-authored fields and known node kinds', () => {
  const graph = normalizeGraph({ v: 999, nodes: [node(g1, { title: '  Task  ', x: 999999, body: 'x'.repeat(1500), secretPath: 'not-kept' }), { ...node('local_bad') }], edges: [] });
  assert.deepEqual([graph.v, graph.nodes.length, graph.nodes[0].title, graph.nodes[0].x, graph.nodes[0].body.length], [1, 1, 'Task', 100000, 1000]);
  assert.equal('secretPath' in graph.nodes[0], false);
});

test('v1 session relations migrate to opaque provider IDs once and preserve user-authored fields', async () => {
  const oldCodex = 'codex_00000000-0000-4000-8000-000000000101';
  const oldCopilot = 'copilot_00000000-0000-4000-8000-000000000102';
  const doc = normalizeGraph({ v: 1, nodes: [node(g1)], edges: [
    { id: e1, from: `graph:${g1}`, to: `session:${oldCodex}`, kind: 'delegates', purpose: 'user purpose', status: 'active', operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    { id: 'e_00000000-0000-4000-8000-000000000002', from: `session:${oldCopilot}`, to: `session:${oldCodex}`, kind: 'evidence', purpose: 'user evidence' },
  ] });
  const calls = [];
  const migrated = await migrateProviderSessionEndpoints(doc, async (source, id) => {
    calls.push([source, id]);
    return source === 'codex' ? 'codex_11111111-1111-4111-8111-111111111111' : 'copilot_22222222-2222-4222-8222-222222222222';
  });
  assert.equal(migrated.v, 2);
  assert.deepEqual(migrated.edges.map((edge) => [edge.from, edge.to]), [
    [`graph:${g1}`, 'session:codex_11111111-1111-4111-8111-111111111111'],
    ['session:copilot_22222222-2222-4222-8222-222222222222', 'session:codex_11111111-1111-4111-8111-111111111111'],
  ]);
  assert.deepEqual(calls, [['codex', '00000000-0000-4000-8000-000000000101'], ['copilot', '00000000-0000-4000-8000-000000000102']]);
  assert.equal(migrated.edges[0].purpose, 'user purpose');
  assert.equal(migrated.edges[0].operationId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(await migrateProviderSessionEndpoints(migrated, async () => { throw new Error('already migrated'); }), migrated);
});

test('stored graph migration uses the same opaque ID as the provider adapter and is idempotent', async () => {
  const oldId = 'codex_00000000-0000-4000-8000-000000000103';
  const legacy = { v: 1, nodes: [node(g1)], edges: [{ id: e1, from: `graph:${g1}`, to: `session:${oldId}`, kind: 'delegates', purpose: 'keep this purpose', status: 'active', operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] };
  const values = new Map([[GRAPH_STORAGE_KEY, JSON.stringify(legacy)]]);
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(await migrateSavedProviderSessionIds(storage, webcrypto.subtle), true);
  const migrated = JSON.parse(values.get(GRAPH_STORAGE_KEY));
  const expected = opaqueProviderSessionId('codex', oldId.slice('codex_'.length));
  assert.equal(migrated.v, 2);
  assert.equal(migrated.edges[0].to, `session:${expected}`);
  assert.equal(migrated.edges[0].purpose, 'keep this purpose');
  assert.equal(migrated.edges[0].operationId, legacy.edges[0].operationId);
  const firstWrite = values.get(GRAPH_STORAGE_KEY);
  assert.equal(await migrateSavedProviderSessionIds(storage, webcrypto.subtle), true);
  assert.equal(values.get(GRAPH_STORAGE_KEY), firstWrite);
  assert.equal(firstWrite.includes(oldId), false);
});

test('artifact references allow only public HTTPS URLs without credentials, query, or fragment', () => {
  assert.equal(safeArtifactUrl('https://github.com/morluto/rea'), 'https://github.com/morluto/rea');
  for (const value of ['http://github.com/a/b', 'javascript:alert(1)', 'https://user:secret@example.com/report', 'https://example.com/report?token=secret', 'https://example.com/report#secret', 'https://example.com/'.repeat(30)]) {
    assert.equal(safeArtifactUrl(value), '');
  }
  assert.equal(safeArtifactUrl('https://github.com/morluto/rea', 'task'), '');
  const graph = normalizeGraph({ nodes: [node(g1, { kind: 'artifact', url: 'https://github.com/morluto/rea', auth: 'drop' }), node(g2, { kind: 'task', url: 'https://github.com/morluto/rea' })], edges: [] });
  assert.equal(graph.nodes[0].url, 'https://github.com/morluto/rea');
  assert.equal(graph.nodes[1].url, '');
  assert.equal('auth' in graph.nodes[0], false);
});

test('Obsidian note references are local, vault-relative, allowlisted, and encoded only for explicit opening', () => {
  assert.equal(safeObsidianVault('Engineering Notes'), 'Engineering Notes');
  assert.equal(safeObsidianFile('Architecture/Agent Canvas.md'), 'Architecture/Agent Canvas.md');
  assert.equal(obsidianOpenUri('Engineering Notes', 'Architecture/Agent Canvas.md'), 'obsidian://open?vault=Engineering%20Notes&file=Architecture%2FAgent%20Canvas.md');
  for (const vault of ['', '../vault', 'C:\\vault', '/home/user/vault', 'vault?path=secret', 'v\u0000ault']) assert.equal(safeObsidianVault(vault), '');
  for (const file of ['', '/home/user/vault/note.md', 'C:\\vault\\note.md', '../secret.md', 'folder/../../secret.md', 'note.md#heading', 'note.md?query=secret']) assert.equal(safeObsidianFile(file), '');
  assert.equal(obsidianOpenUri('vault', '../secret.md'), '');

  const note = normalizeGraph({ nodes: [node(g1, { kind: 'obsidian_note', knowledgeVault: 'Team Vault', knowledgeFile: 'Design/Canvas.md', body: 'Reviewed note summary', secret: 'discard' })], edges: [] }).nodes[0];
  assert.deepEqual([note.kind, note.knowledgeVault, note.knowledgeFile], ['obsidian_note', 'Team Vault', 'Design/Canvas.md']);
  assert.equal('secret' in note, false);
  const otherKind = normalizeGraph({ nodes: [node(g1, { kind: 'task', knowledgeVault: '/private', knowledgeFile: '../private.md' })], edges: [] }).nodes[0];
  assert.deepEqual([otherKind.knowledgeVault, otherKind.knowledgeFile], ['', '']);
});

test('execution profiles retain only allowlisted manual conditions and default invalid values to unknown', () => {
  const profile = node(g1, { kind: 'execution_profile', executionLocation: 'wsl', workspaceIsolation: 'sandboxed', networkAccess: 'restricted', approvalMode: 'per_action', secret: 'discard' });
  const normalized = normalizeGraph({ nodes: [profile], edges: [] }).nodes[0];
  assert.deepEqual([normalized.executionLocation, normalized.workspaceIsolation, normalized.networkAccess, normalized.approvalMode], ['wsl', 'sandboxed', 'restricted', 'per_action']);
  assert.equal('secret' in normalized, false);
  const defaults = normalizeGraph({ nodes: [node(g1, { kind: 'execution_profile' })], edges: [] }).nodes[0];
  assert.deepEqual([defaults.executionLocation, defaults.workspaceIsolation, defaults.networkAccess, defaults.approvalMode], ['unknown', 'unknown', 'unknown', 'unknown']);
  const unknowns = normalizeGraph({ nodes: [node(g1, { kind: 'execution_profile', executionLocation: '/private/path', workspaceIsolation: 'yes', networkAccess: 'maybe', approvalMode: 'automatic-ish' })], edges: [] }).nodes[0];
  assert.deepEqual([unknowns.executionLocation, unknowns.workspaceIsolation, unknowns.networkAccess, unknowns.approvalMode], ['unknown', 'unknown', 'unknown', 'unknown']);
  const otherKind = normalizeGraph({ nodes: [node(g1, { executionLocation: 'remote', workspaceIsolation: 'sandboxed', networkAccess: 'available', approvalMode: 'automatic' })], edges: [] }).nodes[0];
  assert.deepEqual([otherKind.executionLocation, otherKind.workspaceIsolation, otherKind.networkAccess, otherKind.approvalMode], ['', '', '', '']);
});

test('graph nodes can be added, updated, moved and removed immutably', () => {
  let graph = addGraphNode(empty(), { kind: 'understanding_gap', title: 'Explain decision', body: '', status: 'open', x: 0, y: 0, checkedPerson: 'reviewer', missingEvidence: 'source', neededExplanation: 'rationale' }, g1);
  graph = addGraphNode(graph, { kind: 'artifact', title: 'Design note', body: '', status: 'open', x: 0, y: 0, checkedPerson: '', missingEvidence: '', neededExplanation: '' }, g2);
  assert.equal(updateGraphNode(graph, g1, { status: 'resolved', neededExplanation: 'updated rationale' }), graph, 'a declared gap cannot be resolved before its links exist');
  graph = updateGraphNode(graph, g1, { status: 'resolved', missingEvidence: '', neededExplanation: '' });
  graph = updateGraphNode(graph, g1, { neededExplanation: 'updated rationale' });
  graph = moveGraphNode(graph, g2, 200, 400);
  assert.equal(graph.nodes[0].status, 'resolved');
  assert.equal(graph.nodes[0].neededExplanation, 'updated rationale');
  assert.deepEqual([graph.nodes[1].x, graph.nodes[1].y], [200, 400]);
  const kept = removeGraphNode(graph, g1);
  assert.equal(kept.nodes.length, 1);
  assert.equal(graph.nodes.length, 2, 'source remains unchanged');
});

test('new graph card slots do not overlap existing cards', () => {
  const size = { width: 280, height: 168 };
  const first = nextGraphNodePosition(empty(), { x: 100, y: 200 }, size);
  const withFirst = addGraphNode(empty(), { ...node(g1), x: first.x, y: first.y }, g1);
  const second = nextGraphNodePosition(withFirst, { x: 100, y: 200 }, size);
  assert.deepEqual(first, { x: 100, y: 200 });
  assert.notDeepEqual(second, first);
  assert.ok(second.x + size.width + 24 <= first.x || first.x + size.width + 24 <= second.x || second.y + size.height + 24 <= first.y || first.y + size.height + 24 <= second.y);
  const third = nextGraphNodePosition(addGraphNode(withFirst, { ...node(g2), x: second.x, y: second.y }, g2), { x: 100, y: 200 }, size);
  assert.ok([first, second].every((other) => third.x + size.width + 24 <= other.x || other.x + size.width + 24 <= third.x || third.y + size.height + 24 <= other.y || other.y + size.height + 24 <= third.y));
});

test('new graph card slots avoid both existing graph cards and session slip rectangles', () => {
  const size = { width: 280, height: 168 };
  const slip = { x: 80, y: 180, width: 432, height: 190 };
  const position = nextGraphNodePosition(empty(), { x: 100, y: 200 }, size, [slip]);
  assert.notDeepEqual(position, { x: 100, y: 200 });
  assert.ok(position.x + size.width + 24 <= slip.x || slip.x + slip.width + 24 <= position.x
    || position.y + size.height + 24 <= slip.y || slip.y + slip.height + 24 <= position.y);
});

test('a task created from session detail is linked atomically without copying session content', () => {
  const input = { kind: 'artifact', title: 'Follow up', body: 'User-authored task', status: 'open', x: 10, y: 20, checkedPerson: '', missingEvidence: '', neededExplanation: '' };
  const graph = addTaskForSession(empty(), input, g1, e1, session);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].kind, 'task');
  assert.deepEqual(graph.edges.map(({ from, to, kind, purpose, status }) => ({ from, to, kind, purpose, status })), [{ from: `graph:${g1}`, to: `session:${session}`, kind: 'related', purpose: 'Created from this session', status: '' }]);
  assert.deepEqual(addTaskForSession(empty(), input, g1, e1, 'invalid-session'), empty(), 'invalid session creates no card');
  assert.deepEqual(addTaskForSession(empty(), input, g1, 'bad-edge', session), empty(), 'invalid edge ID does not leave an unlinked task behind');
});

test('a confirmed worktree summary is saved as a local worktree card linked to its source session', () => {
  const input = { kind: 'artifact', title: 'agent/review', body: 'Base main; clean (0 changed, 0 untracked)', status: 'open', x: 30, y: 40, checkedPerson: '', missingEvidence: '', neededExplanation: '' };
  const graph = addWorktreeForSession(empty(), input, g1, e1, session);
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].kind, 'worktree');
  assert.equal(graph.nodes[0].title, 'agent/review');
  assert.deepEqual(normalizeGraph(JSON.parse(JSON.stringify(graph))), graph, 'the safe record and its edge survive browser-storage serialization');
  assert.deepEqual(graph.edges.map(({ from, to, kind, purpose, status }) => ({ from, to, kind, purpose, status })), [{ from: `graph:${g1}`, to: `session:${session}`, kind: 'related', purpose: 'Created by confirmed worktree action', status: '' }]);
  const refreshed = addWorktreeForSession(graph, { ...input, body: 'At check: changed' }, g2, 'e_00000000-0000-4000-8000-000000000002', session, 'Recorded from read-only worktree inventory');
  assert.equal(refreshed.nodes.length, 1, 'refresh updates the existing branch record instead of duplicating it');
  assert.equal(refreshed.nodes[0].id, g1);
  assert.equal(refreshed.nodes[0].body, 'At check: changed');
  assert.deepEqual([refreshed.nodes[0].x, refreshed.nodes[0].y], [30, 40], 'refresh keeps the saved canvas placement');
  assert.deepEqual(addWorktreeForSession(empty(), input, g1, e1, 'invalid-session'), empty(), 'invalid session creates no record');
  assert.deepEqual(addWorktreeForSession(empty(), input, g1, 'bad-edge', session), empty(), 'invalid edge ID does not leave an unlinked record behind');
});

test('relations connect local cards and current sessions, whitelist fields, and track delegation state without executing it', () => {
  let graph = addGraphNode(empty(), { kind: 'task', title: 'Review', body: '', status: 'open', x: 0, y: 0, checkedPerson: '', missingEvidence: '', neededExplanation: '' }, g1);
  graph = addGraphNode(graph, { kind: 'artifact', title: 'Evidence', body: '', status: 'open', x: 0, y: 0, checkedPerson: '', missingEvidence: '', neededExplanation: '' }, g2);
  const sessionIds = new Set([session]);
  graph = connectGraph(graph, { from: `graph:${g1}`, to: `session:${session}`, kind: 'delegates', purpose: 'Implement the review', status: 'active' }, e1, sessionIds);
  assert.deepEqual([graph.edges.length, graph.edges[0].purpose, graph.edges[0].status], [1, 'Implement the review', 'active']);
  assert.equal(connectGraph(graph, { from: `graph:${g1}`, to: `session:${session}`, kind: 'delegates', purpose: '  ', status: 'planned' }, 'e_00000000-0000-4000-8000-000000000003', sessionIds), graph, 'delegation without a purpose is rejected');
  assert.equal(connectGraph(graph, { from: `graph:${g1}`, to: 'session:local_bad', kind: 'related', purpose: '', status: '' }, 'e_00000000-0000-4000-8000-000000000002', sessionIds).edges.length, 1);
  assert.equal(connectGraph(graph, { from: `graph:${g1}`, to: `graph:${g2}`, kind: 'related', purpose: '', status: '' }, e1, sessionIds).edges.length, 1, 'duplicate edge id is rejected');
  assert.equal(removeGraphNode(graph, g1).edges.length, 0, 'orphaned edges are removed');
});

test('graph relations can update purpose and delegation state or be removed', () => {
  let graph = addGraphNode(empty(), { kind: 'task', title: 'Review', body: '', status: 'open', x: 0, y: 0, checkedPerson: '', missingEvidence: '', neededExplanation: '' }, g1);
  graph = connectGraph(graph, { from: `graph:${g1}`, to: `session:${session}`, kind: 'delegates', purpose: 'Initial scope', status: 'planned' }, e1, new Set([session]));
  graph = updateGraphEdge(graph, e1, { purpose: 'Confirmed scope', status: 'active' });
  assert.deepEqual([graph.edges[0].purpose, graph.edges[0].status, graph.edges[0].from, graph.edges[0].to], ['Confirmed scope', 'active', `graph:${g1}`, `session:${session}`]);
  graph = connectGraph(graph, { from: `graph:${g1}`, to: `session:${session}`, kind: 'related', purpose: '', status: '' }, 'e_00000000-0000-4000-8000-000000000002', new Set([session]));
  assert.equal(updateGraphEdge(graph, e1, { kind: 'related' }).edges[0].kind, 'delegates', 'editing cannot create duplicate edges');
  const remaining = removeGraphEdge(graph, e1).edges;
  assert.equal(remaining.length, 1);
  assert.notEqual(remaining[0].id, e1);
});

test('delegation operation IDs persist locally only on delegate edges and fail closed when malformed', () => {
  const opId = '12345678-1234-4234-8234-1234567890ab';
  const invalid = 'C:\\private\\session';
  const edge = { id: 'e_00000000-0000-4000-8000-000000000002', from: 'session:local_00000000-0000-4000-8000-000000000001', to: 'session:codex_00000000-0000-4000-8000-000000000002', kind: 'delegates', purpose: 'Review', status: 'active', operationId: opId };
  assert.equal(normalizeGraph({ v: 1, nodes: [], edges: [edge] }).edges[0].operationId, opId);
  assert.equal(normalizeGraph({ v: 1, nodes: [], edges: [{ ...edge, operationId: invalid }] }).edges[0].operationId, undefined);
  assert.equal(normalizeGraph({ v: 1, nodes: [], edges: [{ ...edge, kind: 'related' }] }).edges[0].operationId, undefined);
});

test('operation-managed delegation purpose, type and state cannot be edited or removed before completion', () => {
  const operationId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
  let graph = addGraphNode(empty(), { kind: 'task', title: 'Review', body: '', status: 'open', x: 0, y: 0, checkedPerson: '', missingEvidence: '', neededExplanation: '' }, g1);
  graph = connectGraph(graph, { from: `graph:${g1}`, to: `session:${session}`, kind: 'delegates', purpose: 'Confirmed scope', status: 'planned' }, e1, new Set([session]));
  const active = startGraphDelegationOperation(graph, e1, operationId);
  assert.deepEqual([active.edges[0].status, active.edges[0].operationId], ['active', operationId]);
  assert.equal(startGraphDelegationOperation(active, e1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), active, 'an operation cannot be replaced');
  assert.equal(updateGraphEdge(active, e1, { status: 'cancelled' }), active, 'a running operation cannot be manually marked cancelled');
  assert.equal(updateGraphEdge(active, e1, { purpose: 'different purpose', kind: 'related' }), active, 'operation metadata is immutable');
  assert.equal(removeGraphEdge(active, e1), active, 'an in-flight operation cannot lose its relation');
  assert.equal(removeGraphNode(active, g1), active, 'an in-flight operation cannot be orphaned by deleting a graph endpoint');
  assert.equal(finishGraphDelegationOperation(active, e1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'completed'), active, 'only the stored operation ID may finish the edge');
  const completed = finishGraphDelegationOperation(active, e1, operationId, 'completed');
  assert.equal(completed.edges[0].status, 'completed');
  assert.equal(removeGraphEdge(completed, e1).edges.length, 0, 'a terminal completed relation can be removed');
  const blocked = finishGraphDelegationOperation(active, e1, operationId, 'blocked');
  assert.equal(removeGraphEdge(blocked, e1), blocked, 'a blocked operation stays locked until human review');
  assert.equal(releaseBlockedGraphDelegationOperation(blocked, e1, operationId, false), blocked, 'the user must explicitly attest that it is no longer running');
  assert.equal(releaseBlockedGraphDelegationOperation(blocked, e1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true), blocked, 'the attestation must match the stored operation ID');
  const reviewed = releaseBlockedGraphDelegationOperation(blocked, e1, operationId, true);
  assert.equal(reviewed.edges[0].operationId, undefined);
  assert.equal(reviewed.edges[0].status, 'blocked', 'human review releases the lock without inventing an outcome');
  assert.equal(updateGraphEdge(reviewed, e1, { status: 'planned' }).edges[0].status, 'planned', 'after attesting, the user can decide the next relation state');
});

test('legacy delegation with missing purpose remains readable and can be repaired', () => {
  const legacy = normalizeGraph({
    v: 1,
    nodes: [{ id: g1, kind: 'task', title: 'Review', x: 0, y: 0 }],
    edges: [{ id: e1, from: `graph:${g1}`, to: `session:${session}`, kind: 'delegates', purpose: '', status: 'active' }],
  });
  assert.equal(legacy.edges[0].purpose, '', 'loading old local state does not discard its edge');
  assert.equal(updateGraphEdge(legacy, e1, { status: 'completed' }), legacy, 'an incomplete legacy delegation cannot change state before purpose is repaired');
  const updated = updateGraphEdge(legacy, e1, { purpose: 'Review the implementation' });
  assert.equal(updated.edges[0].purpose, 'Review the implementation');
  assert.equal(updateGraphEdge(legacy, e1, { purpose: '' }).edges[0].purpose, '', 'a legacy record is retained until a repair is supplied');
});

test('comprehension review reports only explicitly missing graph links, never a person score', () => {
  let graph = addGraphNode(empty(), { kind: 'understanding_gap', title: 'Explain decision', body: '', status: 'open', x: 0, y: 0, checkedPerson: 'reviewer', missingEvidence: 'decision record', neededExplanation: 'why it was chosen' }, g1);
  assert.equal(addGraphNode(empty(), { kind: 'understanding_gap', title: 'Already resolved', body: '', status: 'resolved', x: 0, y: 0, checkedPerson: 'reviewer', missingEvidence: 'source', neededExplanation: '' }, g2).nodes.length, 0, 'a new gap cannot skip its declared evidence link');
  assert.equal(updateGraphNode(graph, g1, { status: 'done' }), graph, 'done cannot hide missing evidence or explanation links');
  assert.deepEqual(reviewUnderstandingGaps(graph), [{ id: g1, missing: ['evidence', 'explains'] }]);
  graph = connectGraph(graph, { from: `graph:${g1}`, to: `session:${session}`, kind: 'evidence', purpose: 'Read-only source session', status: '' }, e1, new Set([session]));
  assert.deepEqual(reviewUnderstandingGaps(graph, new Set([session])), [{ id: g1, missing: ['explains'] }]);
  assert.equal(updateGraphNode(graph, g1, { status: 'resolved' }), graph, 'a session link counts only when the current session exists');
  graph = connectGraph(graph, { from: `graph:${g1}`, to: `session:${session}`, kind: 'explains', purpose: 'User-authored rationale', status: '' }, 'e_00000000-0000-4000-8000-000000000002', new Set([session]));
  assert.deepEqual(reviewUnderstandingGaps(graph, new Set([session])), []);
  graph = updateGraphNode(graph, g1, { status: 'resolved' }, new Set([session]));
  assert.deepEqual(reviewUnderstandingGaps(graph, new Set([session])), [], 'linked declared gaps may be resolved');
  graph = { ...graph, edges: graph.edges.filter((edge) => edge.kind !== 'evidence') };
  assert.deepEqual(reviewUnderstandingGaps(graph, new Set([session])), [{ id: g1, missing: ['evidence'] }], 'removing a required relation returns a resolved gap to review');

  const unspecified = addGraphNode(empty(), { kind: 'understanding_gap', title: 'Unspecified', body: '', status: 'open', x: 0, y: 0, checkedPerson: 'reviewer', missingEvidence: '', neededExplanation: '' }, g2);
  assert.deepEqual(reviewUnderstandingGaps(unspecified), [], 'blank fields do not imply missing evidence or lack of understanding');
});

test('a comprehension gap cannot be marked done or resolved until the checked person is recorded', () => {
  const emptyPerson = addGraphNode(empty(), {
    kind: 'understanding_gap', title: 'Review decision understanding', body: '', status: 'open', x: 0, y: 0,
    checkedPerson: '', missingEvidence: '', neededExplanation: '',
  }, g1);
  assert.equal(addGraphNode(empty(), {
    kind: 'understanding_gap', title: 'Already resolved', body: '', status: 'resolved', x: 0, y: 0,
    checkedPerson: '', missingEvidence: '', neededExplanation: '',
  }, g2).nodes.length, 0);
  assert.equal(updateGraphNode(emptyPerson, g1, { status: 'done' }), emptyPerson);
  assert.equal(updateGraphNode(emptyPerson, g1, { status: 'resolved' }), emptyPerson);
  const identified = updateGraphNode(emptyPerson, g1, { checkedPerson: 'reviewer' });
  assert.equal(updateGraphNode(identified, g1, { status: 'resolved' }).nodes[0].status, 'resolved');
  const completedTask = addGraphNode(empty(), {
    kind: 'task', title: 'Completed task', body: '', status: 'done', x: 0, y: 0,
  }, g2);
  assert.equal(updateGraphNode(completedTask, g2, { kind: 'understanding_gap' }), completedTask, 'converting an already done task cannot bypass the person requirement');
  const resolved = updateGraphNode(identified, g1, { status: 'resolved' });
  assert.equal(updateGraphNode(resolved, g1, { checkedPerson: '' }), resolved, 'a resolved gap cannot lose its checked person');
});

test('comprehension review treats relations to unavailable sessions as missing', () => {
  const graph = addGraphNode(empty(), {
    kind: 'understanding_gap', title: 'Review source availability', body: '', status: 'open', x: 0, y: 0,
    checkedPerson: 'reviewer', missingEvidence: 'source session', neededExplanation: 'decision context',
  }, g1);
  const linked = connectGraph(graph, { from: `graph:${g1}`, to: `session:${session}`, kind: 'evidence', purpose: '', status: '' }, e1, new Set([session]));
  assert.deepEqual(reviewUnderstandingGaps(linked, new Set([session])), [{ id: g1, missing: ['explains'] }]);
  assert.deepEqual(reviewUnderstandingGaps(linked), [{ id: g1, missing: ['evidence', 'explains'] }]);
});
