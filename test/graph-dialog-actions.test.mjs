import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cancelGraphDialog, confirmBlockedOperationRelease, connectMissingComprehensionEdge, graphDialogFocusTarget } from '../public/graph-dialog-actions.mjs';

const blocked = { id: 'edge-1', operationId: 'op-1', kind: 'delegates', status: 'blocked' };

test('blocked operation release requires a matching eligible record', () => {
  let confirmations = 0;
  let resolutions = 0;
  const run = (edge) => confirmBlockedOperationRelease({
    edge,
    confirm: () => { confirmations += 1; return true; },
    resolve: () => { resolutions += 1; return true; },
  });

  assert.equal(run(undefined), false);
  assert.equal(run({ ...blocked, kind: 'related' }), false);
  assert.equal(run({ ...blocked, status: 'active' }), false);
  assert.equal(run({ ...blocked, operationId: '' }), false);
  assert.equal(confirmations, 0);
  assert.equal(resolutions, 0);
});

test('cancelled review leaves the blocked operation untouched', () => {
  let resolutions = 0;
  const result = confirmBlockedOperationRelease({
    edge: blocked,
    confirm: () => false,
    resolve: () => { resolutions += 1; return true; },
  });

  assert.equal(result, false);
  assert.equal(resolutions, 0);
});

test('failed graph save keeps the dialog open', () => {
  const result = confirmBlockedOperationRelease({ edge: blocked, confirm: () => true, resolve: () => false });
  assert.equal(result, false);
});

test('successful graph save permits the dialog to close', () => {
  let resolved;
  const result = confirmBlockedOperationRelease({
    edge: blocked,
    confirm: () => true,
    resolve: (id, operationId) => { resolved = [id, operationId]; return true; },
  });

  assert.equal(result, true);
  assert.deepEqual(resolved, ['edge-1', 'op-1']);
});

test('a missing comprehension link opens the relation editor with its fixed evidence kind', () => {
  for (const edgeKind of ['evidence', 'explains']) {
    const order = [];
    const connected = [];
    const result = connectMissingComprehensionEdge({
      nodeId: 'g_gap', edgeKind,
      close: () => order.push('close'),
      connect: (from, kind) => { order.push('connect'); connected.push(from, kind); },
    });
    assert.equal(result, true);
    assert.deepEqual(order, ['close', 'connect']);
    assert.deepEqual(connected, ['graph:g_gap', edgeKind]);
  }
});

test('unknown comprehension edge kinds fail closed without closing or connecting', () => {
  let actions = 0;
  assert.equal(connectMissingComprehensionEdge({ nodeId: 'g_gap', edgeKind: 'related', close: () => actions++, connect: () => actions++ }), false);
  assert.equal(connectMissingComprehensionEdge({ nodeId: '', edgeKind: 'evidence', close: () => actions++, connect: () => actions++ }), false);
  assert.equal(actions, 0);
});

test('cancel closes a graph dialog even while a new card has no node yet', () => {
  let closed = 0;
  assert.equal(cancelGraphDialog('cancel', () => { closed++; }), true);
  assert.equal(closed, 1);
  assert.equal(cancelGraphDialog('connect', () => { closed++; }), false);
  assert.equal(closed, 1);
});

test('dialog focus returns to the invoking control, then source card, then canvas viewport', () => {
  const origin = { isConnected: true };
  const graphNode = { isConnected: true };
  const viewport = { isConnected: true };
  assert.equal(graphDialogFocusTarget(origin, graphNode, viewport), origin);
  origin.isConnected = false;
  assert.equal(graphDialogFocusTarget(origin, graphNode, viewport), graphNode);
  graphNode.isConnected = false;
  assert.equal(graphDialogFocusTarget(origin, graphNode, viewport), viewport);
  viewport.isConnected = false;
  assert.equal(graphDialogFocusTarget(origin, graphNode, viewport), null);
});

test('the comprehension editor renders actions only from its current missing-link review', () => {
  const source = fs.readFileSync(new URL('../public/graph-dialog.mjs', import.meta.url), 'utf8');
  assert.match(source, /reviewUnderstandingGaps\(graph, new Set\(sessions\.map\(\(session\) => session\.id\)\)\)/);
  assert.match(source, /const missingEndpoint = \(key\) => \(\{[\s\S]*?title: t\(key\.startsWith\('session:'\) \? 'graph\.missingSession' : 'graph\.missingNode'\)/);
  assert.match(source, /options\.find\(\(x\) => x\.id === edge\.to\) \?\? missingEndpoint\(edge\.to\)/);
  assert.match(source, /review\?\.missing\.length/);
  assert.match(source, /review\.missing\.map\(\(kind\) => h\('button'/);
  assert.match(source, /graph\.resolveNeedsLinks/);
  assert.match(source, /statusInput\?\.reportValidity\(\)/);
  assert.match(source, /'data-dialog-action': 'connect-missing'/);
  assert.match(source, /'data-edge-kind': kind/);
  assert.match(source, /connectMissingComprehensionEdge\(\{ nodeId: node\.id, edgeKind: kind, close: \(\) => dialog\.close\(\), connect: o\.onConnect \}\)/);
  assert.match(source, /const returnFocus = document\.activeElement instanceof HTMLElement \? document\.activeElement : null/);
  assert.match(source, /fromKey\.startsWith\('session:'\) \? fromKey\.slice\(8\)/);
  assert.match(source, /fromKey\.startsWith\('graph:'\) \? '\.graph-node' : '\.slip__title'/);
  assert.match(source, /graphDialogFocusTarget\(returnFocus, sourceCard, viewport\)/);
  assert.match(source, /target\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /if \(cancelGraphDialog\(action, \(\) => dialog\.close\(\)\)\) return;[\s\S]*?if \(!node\) return;/);
});
