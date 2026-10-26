import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GRAPH_STORAGE_KEY, loadGraph, saveGraph } from '../public/graph-store.mjs';

test('graph storage round trips only the bounded local graph schema', () => {
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
  const graph = { v: 1, nodes: [{ id: 'g_00000000-0000-4000-8000-000000000001', kind: 'task', title: 'Plan', body: 'Scope', status: 'open', x: 40, y: 60, checkedPerson: '', missingEvidence: '', neededExplanation: '', prompt: 'must not persist' }], edges: [] };
  assert.equal(saveGraph(graph), true);
  assert.deepEqual(loadGraph(), { v: 1, nodes: [{ ...graph.nodes[0], prompt: undefined }].map(({ prompt, ...node }) => node), edges: [] });
  assert.equal(values.has(GRAPH_STORAGE_KEY), true);
  assert.equal(values.get(GRAPH_STORAGE_KEY).includes('must not persist'), false);
  delete globalThis.localStorage;
});

test('graph storage safely handles denied browser storage', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
  assert.equal(saveGraph({ v: 1, nodes: [], edges: [] }), false);
  assert.deepEqual(loadGraph(), { v: 1, nodes: [], edges: [] });
  delete globalThis.localStorage;
});
