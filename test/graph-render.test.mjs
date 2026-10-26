import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { graphCardAriaLabel, graphCardComprehensionSummary, graphCardSearchText, graphCardSignature, graphCardStatus, graphEdgeAttributes, graphEdgePresentation, graphEdgeSearchText, graphNodeHasMatchedSession, graphNodeSessionFilterMatch } from '../public/graph-render.mjs';
import { cancelGraphConnection, chooseGraphConnectionTarget, startGraphConnection } from '../public/graph-connect-mode.mjs';

const node = { id: 'g_00000000-0000-4000-8000-000000000001', kind: 'understanding_gap', title: 'Gap', status: 'open' };

test('canvas comprehension cards name who is being checked and mark empty evidence fields as unrecorded', () => {
  const t = (key, params = {}) => ({
    'graph.kind.understanding_gap': '理解負債',
    'graph.status.open': '未解消',
    'graph.status.review': '要確認',
    'graph.checkedPersonSummary': `確認対象: ${params.name}`,
    'graph.missingEvidence': `不足根拠: ${params.text}`,
    'graph.neededExplanation': `必要な説明: ${params.text}`,
    'graph.notRecorded': '未記録',
    'graph.cardAria': `${params.kind}: ${params.title}、${params.status}`,
  }[key] ?? key);
  const gap = { ...node, title: 'ADRを理解する', checkedPerson: '担当者', missingEvidence: '', neededExplanation: '選択理由' };
  const summary = graphCardComprehensionSummary(gap, t);
  const accessible = graphCardAriaLabel(t, gap);
  assert.deepEqual(summary, ['確認対象: 担当者', '不足根拠: 未記録', '必要な説明: 選択理由']);
  assert.ok(summary.every((line) => accessible.includes(line)));
  assert.match(accessible, /ADRを理解する/);
  assert.doesNotMatch(accessible, /理解度|score|スコア/i);
});

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

test('canvas graph cards offer a keyboard-usable connect mode with a preselected target and Escape cancel', () => {
  const renderer = fs.readFileSync(new URL('../public/graph-render.mjs', import.meta.url), 'utf8');
  const actions = fs.readFileSync(new URL('../public/canvas-act.mjs', import.meta.url), 'utf8');
  const dialog = fs.readFileSync(new URL('../public/graph-dialog.mjs', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/graph.css', import.meta.url), 'utf8');
  assert.match(renderer, /'data-action': 'graph-connect-node'/);
  assert.match(renderer, /'aria-label', t\('graph\.connectCard'/);
  assert.match(renderer, /'aria-pressed', o\.connectFrom === node\.id/);
  const graphActions = fs.readFileSync(new URL('../public/graph-actions.mjs', import.meta.url), 'utf8');
  assert.match(graphActions, /startGraphConnection/);
  assert.match(graphActions, /chooseGraphConnectionTarget/);
  assert.match(graphActions, /initialTo, graph, sessions/);
  assert.match(actions, /if \(cancelGraphConnection\(cv, render\)\)[\s\S]*graph\.connectCancelled/);
  assert.match(dialog, /endpointSelect\(t, options, 'to', o\.initialTo \?\? ''/);
  assert.match(css, /\.graph-connect-handle:focus-visible/);
  assert.match(css, /\.graph-node\.is-connect-target/);
  for (const file of ['dict-ja-canvas.mjs', 'dict-en-canvas.mjs']) {
    const dict = fs.readFileSync(new URL('../public/' + file, import.meta.url), 'utf8');
    assert.match(dict, /'graph\.connectCard':/);
    assert.match(dict, /'graph\.connectPickTarget':/);
    assert.match(dict, /'graph\.connectCancelled':/);
  }
});

test('canvas pointer connection handles both graph cards and session slips as endpoints', () => {
  const session = fs.readFileSync(new URL('../public/canvas-slip.mjs', import.meta.url), 'utf8');
  const input = fs.readFileSync(new URL('../public/canvas-input.mjs', import.meta.url), 'utf8');
  const actions = fs.readFileSync(new URL('../public/canvas-act.mjs', import.meta.url), 'utf8');
  const graphActions = fs.readFileSync(new URL('../public/graph-actions.mjs', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/canvas.css', import.meta.url), 'utf8');
  assert.match(session, /class: 'canvas-connect-handle'.*'data-endpoint': 'session'/);
  assert.match(input, /\.graph-node\[data-id\], \.slip:\s*not\(\.is-faded\)\[data-id\]/);
  assert.match(input, /graphConnectionDrop\(d\.key, targetId, d\.endpointKind, targetKind\)/);
  assert.match(actions, /'graph-connect-session-handle': \(el\) => graphActions\.connectSession/);
  assert.match(graphActions, /connectCanvasEndpoints: \(sourceKind, sourceId, targetKind, targetId\)/);
  assert.match(css, /\.slip\.is-connect-target\s*\{/);
});

test('graph connection mode selects a different target, keeps self-selection active, and cancels cleanly', () => {
  const cv = { graphConnectFrom: null };
  const calls = [];
  const deps = {
    cv,
    loadGraph: () => ({ nodes: [{ id: 'source' }, { id: 'target' }] }),
    render: () => calls.push('render'),
    announce: (text) => calls.push(['announce', text]),
    t: (key) => key,
    focusTarget: (id) => calls.push(['focus', id]),
  };
  assert.equal(startGraphConnection(deps, 'missing'), false);
  assert.equal(startGraphConnection(deps, 'source'), true);
  assert.equal(cv.graphConnectFrom, 'source');
  assert.deepEqual(calls, ['render', ['announce', 'graph.connectPickTarget'], ['focus', 'source']]);
  assert.equal(chooseGraphConnectionTarget({ cv, render: deps.render, connect: () => calls.push('connect') }, 'source'), false);
  assert.equal(cv.graphConnectFrom, 'source', 'choosing the source again does not silently cancel');
  const edges = [];
  assert.equal(chooseGraphConnectionTarget({ cv, render: deps.render, connect: (from, to) => edges.push([from, to]) }, 'target'), 1);
  assert.deepEqual(edges, [['source', 'target']]);
  assert.equal(cv.graphConnectFrom, null);
  assert.equal(chooseGraphConnectionTarget({ cv, render: deps.render, connect: () => false }, 'target'), null);
  cv.graphConnectFrom = 'source';
  assert.equal(cancelGraphConnection(cv, deps.render), true);
  assert.equal(cv.graphConnectFrom, null);
  assert.equal(cancelGraphConnection(cv, deps.render), false);
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
  for (const kind of ['related', 'depends_on', 'evidence', 'explains']) {
    assert.deepEqual(graphEdgePresentation({ kind, status: 'active' }, t), { className: `graph-edge graph-edge--${kind}`, status: undefined, title: `graph.edge.${kind}` });
  }
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
  assert.match(renderer, /h\('button', \{[\s\S]*?'data-action': 'graph-edit-edge'/);
  assert.match(renderer, /'data-action': 'graph-edit-edge', 'data-id': x\.edge\.id/);
  assert.match(renderer, /'aria-label': attributes\.title/);
  assert.doesNotMatch(renderer, /line\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(renderer, /line\.setAttribute\('title', attributes\.title\)/);
  assert.doesNotMatch(renderer, /el\.setAttribute\('aria-label', t\(`graph\.edge\.\$\{edge\.kind\}`\)\)/);
  assert.match(fs.readFileSync(new URL('../public/canvas-act.mjs', import.meta.url), 'utf8'), /'graph-edit-edge': \(el\) => graphActions\.editEdge\(el\.dataset\.id \?\? ''\)/);
});

test('delegation edge attributes expose only the fixed status tooltip, including unknown status', () => {
  const attrs = graphEdgeAttributes({ kind: 'delegates', status: 'future', purpose: 'private purpose' }, (key) => key);
  assert.deepEqual(attrs, {
    className: 'graph-edge graph-edge--delegates graph-edge--delegates-unknown',
    title: 'graph.edge.delegates: graph.delegation.unknown',
  });
  assert.equal(JSON.stringify(attrs).includes('private purpose'), false);
  assert.equal('status' in attrs, false);
  assert.deepEqual(graphEdgeAttributes({ kind: 'related', status: 'active' }, (key) => key), { className: 'graph-edge graph-edge--related', title: 'graph.edge.related' });
});
