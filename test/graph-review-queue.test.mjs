import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstUnderstandingGapForReview } from '../public/graph-review-queue.mjs';
import { normalizeGraph } from '../public/graph-model.mjs';
import { comprehensionReviewElements } from '../public/graph-comprehension-review.mjs';

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

test('comprehension editor renders a repair button for the existing legacy edge ID', () => {
  const graph = normalizeGraph({ v: 1, nodes: [
    { id: first, kind: 'understanding_gap', title: 'Gap', missingEvidence: 'source', neededExplanation: '' },
    { id: second, kind: 'artifact', title: 'Source' },
  ], edges: [
    { id: 'e_00000000-0000-4000-8000-000000000001', from: `graph:${first}`, to: `graph:${second}`, kind: 'evidence', purpose: '' },
  ] });
  const previousDocument = globalThis.document;
  class ElementFixture {
    tagName; attributes = {}; children = []; textContent = '';
    constructor(tagName) { this.tagName = tagName; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(child) { this.children.push(child); }
  }
  globalThis.document = {
    createElement: (tag) => new ElementFixture(tag),
    createTextNode: (text) => ({ textContent: text }),
  };
  try {
    const t = (key, values = {}) => `${key}${values.links ? `: ${values.links}` : ''}`;
    const elements = comprehensionReviewElements(t, graph, [], first);
    const nodes = elements.flatMap((element) => element.children);
    const actions = nodes.filter((element) => element.tagName === 'button');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].attributes['data-dialog-action'], 'edit-edge');
    assert.equal(actions[0].attributes['data-edge-id'], 'e_00000000-0000-4000-8000-000000000001');
    assert.match(actions[0].textContent, /resolveIncomplete\.evidence/);
    assert.doesNotMatch(JSON.stringify(elements), /connect-missing/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
