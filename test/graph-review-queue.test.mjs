import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstUnderstandingGapForReview } from '../public/graph-review-queue.mjs';
import { normalizeGraph } from '../public/graph-model.mjs';

const first = 'g_00000000-0000-4000-8000-000000000001';
const second = 'g_00000000-0000-4000-8000-000000000002';

test('review queue picks first declared gap missing a live evidence or explanation relation', () => {
  const graph = normalizeGraph({ v: 1, nodes: [
    { id: first, kind: 'understanding_gap', title: 'Complete', status: 'open', checkedPerson: 'reviewer', missingEvidence: '', neededExplanation: '' },
    { id: second, kind: 'understanding_gap', title: 'Needs review', status: 'resolved', checkedPerson: 'reviewer', missingEvidence: 'decision', neededExplanation: 'rationale' },
  ], edges: [] });
  assert.deepEqual(firstUnderstandingGapForReview(graph, new Set()), { id: second, missing: ['evidence', 'explains'], incomplete: [] });
  assert.equal(firstUnderstandingGapForReview(normalizeGraph(null), new Set()), null);
});

test('review queue does not treat dangling session links as evidence', () => {
  const graph = normalizeGraph({ v: 2, nodes: [
    { id: first, kind: 'understanding_gap', title: 'Gap', status: 'open', checkedPerson: 'reviewer', missingEvidence: 'source', neededExplanation: '' },
  ], edges: [
    { id: 'e_00000000-0000-4000-8000-000000000001', from: `graph:${first}`, to: 'session:codex_00000000-0000-4000-8000-000000000003', kind: 'evidence' },
  ] });
  assert.deepEqual(firstUnderstandingGapForReview(graph, new Set()), { id: first, missing: ['evidence'], incomplete: [] });
});

test('review queue distinguishes an existing blank legacy relation from a missing relation', () => {
  const graph = normalizeGraph({ v: 1, nodes: [
    { id: first, kind: 'understanding_gap', title: 'Gap', status: 'open', checkedPerson: 'reviewer', missingEvidence: 'source', neededExplanation: '' },
    { id: second, kind: 'artifact', title: 'Source' },
  ], edges: [
    { id: 'e_00000000-0000-4000-8000-000000000001', from: `graph:${first}`, to: `graph:${second}`, kind: 'evidence', purpose: '' },
  ] });
  assert.deepEqual(firstUnderstandingGapForReview(graph, new Set()), {
    id: first, missing: ['evidence'], incomplete: [{ kind: 'evidence', edgeId: 'e_00000000-0000-4000-8000-000000000001' }],
  });
});
