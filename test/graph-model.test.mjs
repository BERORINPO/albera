import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addGraphNode, connectGraph, moveGraphNode, normalizeGraph, removeGraphEdge, removeGraphNode, updateGraphEdge, updateGraphNode } from '../public/graph-model.mjs';

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

test('graph nodes can be added, updated, moved and removed immutably', () => {
  let graph = addGraphNode(empty(), { kind: 'understanding_gap', title: 'Explain decision', body: '', status: 'open', x: 0, y: 0, checkedPerson: 'reviewer', missingEvidence: 'source', neededExplanation: 'rationale' }, g1);
  graph = addGraphNode(graph, { kind: 'artifact', title: 'Design note', body: '', status: 'open', x: 0, y: 0, checkedPerson: '', missingEvidence: '', neededExplanation: '' }, g2);
  graph = updateGraphNode(graph, g1, { status: 'resolved', neededExplanation: 'updated rationale' });
  graph = moveGraphNode(graph, g2, 200, 400);
  assert.equal(graph.nodes[0].status, 'resolved');
  assert.equal(graph.nodes[0].neededExplanation, 'updated rationale');
  assert.deepEqual([graph.nodes[1].x, graph.nodes[1].y], [200, 400]);
  const kept = removeGraphNode(graph, g1);
  assert.equal(kept.nodes.length, 1);
  assert.equal(graph.nodes.length, 2, 'source remains unchanged');
});

test('relations connect local cards and current sessions, whitelist fields, and track delegation state without executing it', () => {
  let graph = addGraphNode(empty(), { kind: 'task', title: 'Review', body: '', status: 'open', x: 0, y: 0, checkedPerson: '', missingEvidence: '', neededExplanation: '' }, g1);
  graph = addGraphNode(graph, { kind: 'artifact', title: 'Evidence', body: '', status: 'open', x: 0, y: 0, checkedPerson: '', missingEvidence: '', neededExplanation: '' }, g2);
  const sessionIds = new Set([session]);
  graph = connectGraph(graph, { from: `graph:${g1}`, to: `session:${session}`, kind: 'delegates', purpose: 'Implement the review', status: 'active' }, e1, sessionIds);
  assert.deepEqual([graph.edges.length, graph.edges[0].purpose, graph.edges[0].status], [1, 'Implement the review', 'active']);
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
