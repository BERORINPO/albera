import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { graphCardSearchText, graphCardSignature, graphCardStatus, graphEdgeAttributes, graphEdgePresentation, graphEdgeSearchText, graphNodeHasMatchedSession, graphNodeSessionFilterMatch } from '../public/graph-render.mjs';

const node = { id: 'g_00000000-0000-4000-8000-000000000001', kind: 'understanding_gap', title: 'Gap', status: 'open' };

test('graph card reconciliation updates missing-link badges when relations change', () => {
  const missingBoth = graphCardSignature(node, ['evidence', 'explains']);
  const missingExplanation = graphCardSignature(node, ['explains']);
  const complete = graphCardSignature(node, []);
  assert.notEqual(missingBoth, missingExplanation);
  assert.notEqual(missingExplanation, complete);
  assert.equal(graphCardSignature(node, ['evidence', 'explains']), missingBoth);
});

test('resolved comprehension cards show review state while a declared relation is missing', () => {
  assert.equal(graphCardStatus({ ...node, status: 'resolved' }, ['evidence']), 'review');
  assert.equal(graphCardStatus({ ...node, status: 'done' }, ['explains']), 'review');
  assert.equal(graphCardStatus({ ...node, status: 'resolved' }, []), 'resolved');
  assert.equal(graphCardStatus({ ...node, status: 'open' }, ['evidence']), 'open');
  assert.equal(graphCardStatus({ ...node, kind: 'task', status: 'done' }, ['evidence']), 'done');
});

test('canvas card search includes its rendered review state and missing relations', () => {
  const t = (key) => ({
    'graph.kind.understanding_gap': '理解負債',
    'graph.status.review': '要確認',
    'graph.link.evidence': '根拠',
  }[key] ?? key);
  const search = graphCardSearchText({ ...node, status: 'resolved', missingEvidence: 'source doc' }, ['evidence'], t);
  assert.match(search, /要確認/);
  assert.match(search, /根拠/);
  assert.match(search, /source doc/);
  assert.doesNotMatch(search, /private/);
});

test('canvas relation search includes the relation purpose, label, and safe delegation status', () => {
  const t = (key) => ({
    'graph.edge.delegates': '委譲の記録',
    'graph.delegation.active': '進行中',
  }[key] ?? key);
  const search = graphEdgeSearchText({ kind: 'delegates', purpose: 'Review the migration summary', status: 'active' }, t);
  assert.match(search, /委譲の記録/);
  assert.match(search, /Review the migration summary/);
  assert.match(search, /進行中/);
  const unknown = graphEdgeSearchText({ kind: 'delegates', purpose: '', status: 'private-status-value' }, t);
  assert.doesNotMatch(unknown, /private-status-value/);
});

test('canvas source, state, and project filters follow direct session relations and keep unlinked cards visible', () => {
  const nodeId = 'g_00000000-0000-4000-8000-000000000001';
  const alphaId = 'claude_00000000-0000-4000-8000-000000000001';
  const betaId = 'codex_00000000-0000-4000-8000-000000000002';
  const index = new Map([
    [alphaId, { card: { source: 'claude', project: { key: 'alpha' } }, pile: 'working' }],
    [betaId, { card: { source: 'codex', project: { key: 'beta' } }, pile: 'recent' }],
  ]);
  const edges = [
    { from: `graph:${nodeId}`, to: `session:${alphaId}` },
    { from: `session:${betaId}`, to: `graph:${nodeId}` },
  ];
  assert.equal(graphNodeSessionFilterMatch(nodeId, edges, index, {}), true);
  assert.equal(graphNodeSessionFilterMatch(nodeId, edges, index, { project: 'alpha' }), true, 'one linked session in the selected project is enough');
  assert.equal(graphNodeSessionFilterMatch(nodeId, edges, index, { project: 'beta' }), true, 'relation direction does not change project membership');
  assert.equal(graphNodeSessionFilterMatch(nodeId, edges, index, { project: 'gamma' }), false);
  assert.equal(graphNodeSessionFilterMatch(nodeId, edges, index, { source: 'codex' }), true);
  assert.equal(graphNodeSessionFilterMatch(nodeId, edges, index, { state: 'working' }), true);
  assert.equal(graphNodeSessionFilterMatch(nodeId, edges, index, { source: 'codex', state: 'working' }), false, 'all selected filters must match the same linked session');
  assert.equal(graphNodeSessionFilterMatch(nodeId, edges, index, { source: 'claude', project: 'beta' }), false);
  assert.equal(graphNodeSessionFilterMatch('unlinked', edges, index, { project: 'gamma' }), true, 'unlinked cards remain board-wide when project cannot be derived');
});

test('canvas graph cards and relation lines can follow a directly matched session in either relation direction', () => {
  const nodeId = 'g_00000000-0000-4000-8000-000000000001';
  const alphaId = 'claude_00000000-0000-4000-8000-000000000001';
  const betaId = 'codex_00000000-0000-4000-8000-000000000002';
  const edges = [
    { from: `graph:${nodeId}`, to: `session:${alphaId}` },
    { from: `session:${betaId}`, to: `graph:${nodeId}` },
  ];
  assert.equal(graphNodeHasMatchedSession(nodeId, edges, new Set([alphaId])), true);
  assert.equal(graphNodeHasMatchedSession(nodeId, edges, new Set([betaId])), true);
  assert.equal(graphNodeHasMatchedSession(nodeId, edges, new Set(['other'])), false);
  assert.equal(graphNodeHasMatchedSession(nodeId, edges, null), false);
  assert.equal(graphNodeHasMatchedSession('unlinked', edges, new Set([alphaId])), false);
});

test('empty canvas gives a direct accessible action to add a card', () => {
  const renderer = fs.readFileSync(new URL('../public/graph-render.mjs', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/graph.css', import.meta.url), 'utf8');
  assert.match(renderer, /'aria-label': t\('graph\.emptyLabel'\)/);
  assert.match(renderer, /'data-action': 'graph-new'.*text: t\('graph\.emptyAction'\)/);
  assert.match(renderer, /else if \(empty\.dataset\.lang !== t\.lang\)/, 'language changes refresh the persistent empty state');
  assert.match(css, /\.graph-layer__empty\s*\{[^}]*width:\s*min\(calc\(28rem \* var\(--k\)\), calc\(90vw \* var\(--k\)\)\);/);
  assert.match(css, /\.graph-layer__empty\s*\{[^}]*font-size:\s*calc\(var\(--text-md\) \* var\(--k\)\);/);
  assert.match(css, /\.graph-layer__empty\s*\{[^}]*pointer-events:\s*auto;/);
  assert.match(css, /\.graph-layer__empty-action\s*\{[^}]*min-height:\s*calc\(var\(--hit\) \* var\(--k\)\);/);
  assert.match(css, /\.graph-layer__empty-action:focus-visible\s*\{[^}]*outline:\s*calc\(3px \* var\(--k\)\) solid var\(--color-focus\);/);
  for (const file of ['dict-ja-canvas.mjs', 'dict-en-canvas.mjs']) {
    const dict = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.match(dict, /'graph\.emptyLabel':/);
    assert.match(dict, /'graph\.emptyAction':/);
  }
});

test('canvas comprehension review uses the complete current session index', () => {
  const renderer = fs.readFileSync(new URL('../public/graph-render.mjs', import.meta.url), 'utf8');
  assert.match(renderer, /reviewUnderstandingGaps\(o\.graph, new Set\(o\.index\.keys\(\)\)\)/);
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
  const renderer = fs.readFileSync(new URL('../public/graph-render.mjs', import.meta.url), 'utf8');
  for (const status of ['planned', 'active', 'blocked', 'completed', 'cancelled']) {
    assert.match(css, new RegExp(`\\.graph-edge--delegates\\[data-status="${status}"\\]`));
  }
  assert.match(css, /\.graph-edge--delegates-unknown\s*\{/);
  assert.match(css, /\.graph-edge\s*\{[^}]*pointer-events:\s*auto;/);
  assert.match(css, /\.graph-edge::before\s*\{[^}]*inset:\s*calc\(-12px \* var\(--k\)\) 0;/);
  assert.match(css, /\.graph-edge\[title\]:hover \.graph-edge__tooltip, \.graph-edge\[title\]:focus-visible \.graph-edge__tooltip\s*\{\s*display:\s*block;/);
  assert.match(css, /\.graph-edge\[title\]:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--color-focus\);/);
  assert.match(css, /\.graph-edge__tooltip\s*\{[^}]*pointer-events:\s*none;/);
  assert.match(css, /\.graph-edge__tooltip\s*\{[^}]*font-size:\s*max\(12px,/);
  assert.match(renderer, /lineRoot\.removeAttribute\('aria-hidden'\)/);
  assert.match(renderer, /h\(attributes\.title \? 'button' : 'span'/);
  assert.match(renderer, /'data-action': 'graph-edit-edge', 'data-id': x\.edge\.id/);
  assert.match(renderer, /line\.setAttribute\('aria-label', attributes\.title\)/);
  assert.match(renderer, /else line\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(renderer, /if \(attributes\.title\) el\.setAttribute\('aria-label', attributes\.title\)/);
  assert.doesNotMatch(renderer, /el\.setAttribute\('aria-label', t\(`graph\.edge\.\$\{edge\.kind\}`\)\)/);
  assert.match(fs.readFileSync(new URL('../public/canvas-act.mjs', import.meta.url), 'utf8'), /'graph-edit-edge': \(el\) => editGraphEdge\(el\.dataset\.id \?\? ''\)/);
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
