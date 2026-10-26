import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphCardSignature } from '../public/graph-render.mjs';

const node = { id: 'g_00000000-0000-4000-8000-000000000001', kind: 'understanding_gap', title: 'Gap', status: 'open' };

test('graph card reconciliation updates missing-link badges when relations change', () => {
  const missingBoth = graphCardSignature(node, ['evidence', 'explains']);
  const missingExplanation = graphCardSignature(node, ['explains']);
  const complete = graphCardSignature(node, []);
  assert.notEqual(missingBoth, missingExplanation);
  assert.notEqual(missingExplanation, complete);
  assert.equal(graphCardSignature(node, ['evidence', 'explains']), missingBoth);
});
