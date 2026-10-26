import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { graphCardSignature, graphEdgeAttributes, graphEdgePresentation } from '../public/graph-render.mjs';

const node = { id: 'g_00000000-0000-4000-8000-000000000001', kind: 'understanding_gap', title: 'Gap', status: 'open' };

test('graph card reconciliation updates missing-link badges when relations change', () => {
  const missingBoth = graphCardSignature(node, ['evidence', 'explains']);
  const missingExplanation = graphCardSignature(node, ['explains']);
  const complete = graphCardSignature(node, []);
  assert.notEqual(missingBoth, missingExplanation);
  assert.notEqual(missingExplanation, complete);
  assert.equal(graphCardSignature(node, ['evidence', 'explains']), missingBoth);
});

test('delegation edge presentation preserves only allowlisted status values for canvas styling', () => {
  const t = (key) => key;
  for (const status of ['planned', 'active', 'blocked', 'completed', 'cancelled']) {
    assert.deepEqual(graphEdgePresentation({ kind: 'delegates', status, purpose: 'private purpose' }, t), {
      className: 'graph-edge graph-edge--delegates',
      status,
      title: `graph.edge.delegates: graph.delegation.${status}`,
    });
  }
  assert.deepEqual(graphEdgePresentation({ kind: 'delegates', status: 'future' }, t), {
    className: 'graph-edge graph-edge--delegates graph-edge--delegates-unknown',
    status: undefined,
    title: 'graph.edge.delegates: graph.delegation.unknown',
  });
  assert.deepEqual(graphEdgePresentation({ kind: 'related', status: 'active' }, t), { className: 'graph-edge graph-edge--related', status: undefined, title: undefined });
});

test('each persisted delegation status has a canvas style and unknown status stays neutral', () => {
  const css = fs.readFileSync(new URL('../public/graph.css', import.meta.url), 'utf8');
  for (const status of ['planned', 'active', 'blocked', 'completed', 'cancelled']) {
    assert.match(css, new RegExp(`\\.graph-edge--delegates\\[data-status="${status}"\\]`));
  }
  assert.match(css, /\.graph-edge--delegates-unknown\s*\{/);
  assert.match(css, /\.graph-edge\s*\{[^}]*pointer-events:\s*auto;/);
  assert.match(css, /\.graph-edge::before\s*\{[^}]*inset:\s*-7px 0;/);
});

test('delegation edge attributes expose only the fixed status tooltip, including unknown status', () => {
  const attrs = graphEdgeAttributes({ kind: 'delegates', status: 'future', purpose: 'private purpose' }, (key) => key);
  assert.deepEqual(attrs, {
    className: 'graph-edge graph-edge--delegates graph-edge--delegates-unknown',
    title: 'graph.edge.delegates: graph.delegation.unknown',
  });
  assert.equal(JSON.stringify(attrs).includes('private purpose'), false);
  assert.equal('status' in attrs, false);
  assert.deepEqual(graphEdgeAttributes({ kind: 'related', status: 'active' }, (key) => key), { className: 'graph-edge graph-edge--related' });
});
