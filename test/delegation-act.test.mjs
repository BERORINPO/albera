import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { makeT } from '../public/i18n.mjs';
import { delegationConfirmationDetails } from '../public/delegation-act.mjs';
import { persistDelegationOutcome } from '../public/delegation-outcome.mjs';
import { delegationRuntimeReasonKey } from '../public/delegation-runtime-reason.mjs';

const sessionId = 'codex_12345678-1234-1234-1234-1234567890ab';
const activeGraph = () => ({ nodes: [], edges: [{ id: 'e_00000000-0000-4000-8000-000000000001', kind: 'delegates', status: 'active', operationId: 'op-1' }] });

test('delegation confirmation identifies the selected project and opaque session suffix in both languages', () => {
  for (const lang of ['ja', 'en']) {
    const details = delegationConfirmationDetails(makeT(lang), 'demo-app', sessionId, 'Review this synthetic task');
    const text = Object.values(details).join('\n');
    assert.match(details.target, /demo-app/);
    assert.match(details.target, /Codex CLI/);
    assert.match(details.target, /1234567890ab/);
    assert.equal(details.purpose, 'Review this synthetic task');
    assert.match(details.transfer, /localhost/);
    assert.match(details.network, /network|ネットワーク/i);
    assert.match(details.network, /usage|利用量/i);
    assert.match(details.output, /discarded|破棄/);
    assert.match(details.session, /session|セッション/i);
    assert.doesNotMatch(text, /12345678-1234-1234-1234-1234567890ab|\{\w+\}/);
  }
});

test('delegation execution uses an explicit in-app form and has no native confirmation call', () => {
  const act = fs.readFileSync(new URL('../public/delegation-act.mjs', import.meta.url), 'utf8');
  const dialog = fs.readFileSync(new URL('../public/delegation-confirm-dialog.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(act, /window\.confirm/);
  assert.match(act, /executeConfirmedDelegation\(edgeId, sourceId, targetId, purpose/);
  assert.match(dialog, /type: 'button'.*data-delegation-cancel/);
  assert.match(dialog, /type: 'submit'.*graph\.delegationConfirmRun/);
  assert.match(dialog, /cancel\.addEventListener\('click', \(\) => dialog\.close\(\)\)/);
  assert.match(dialog, /dialog\.close\(\);\s*onConfirm\(\)/);
  assert.match(dialog, /'aria-describedby': descriptionIds/);
  for (const part of ['target', 'purpose', 'transfer', 'network', 'output', 'session']) {
    assert.match(dialog, new RegExp(`delegation-confirm-${part}`));
  }
});

test('terminal delegation outcome is announced as persistable only after the graph save succeeds', () => {
  let saved;
  const graph = activeGraph();
  const options = {
    edgeId: graph.edges[0].id,
    operationId: 'op-1',
    status: 'completed',
    loadGraph: () => graph,
    graphChanged: (next) => { saved = next; return true; },
  };
  assert.equal(persistDelegationOutcome(options), true);
  assert.equal(saved.edges[0].status, 'completed');

  let attempted = 0;
  assert.equal(persistDelegationOutcome({ ...options, graphChanged: () => (attempted++, false) }), false);
  assert.equal(attempted, 1, 'a failed browser storage save does not count as a persisted terminal outcome');
  assert.equal(persistDelegationOutcome({ ...options, operationId: 'wrong-id', graphChanged: () => (attempted++, true) }), false);
  assert.equal(attempted, 1, 'a stale operation ID cannot be announced as saved');
});

test('delegation start rejections map only fixed safe reasons to localized guidance', () => {
  const reasons = ['invalid_target', 'unsupported_location', 'session_active', 'session_unknown', 'already_running', 'operation_limit', 'cli_unavailable'];
  for (const reason of reasons) {
    const key = delegationRuntimeReasonKey(reason);
    assert.equal(typeof key, 'string', `known rejection ${reason} is mapped`);
    assert.notEqual(makeT('ja')(key), key);
    assert.notEqual(makeT('en')(key), key);
  }
  for (const reason of ['failed', 'delegation_failed', 'EACCES', '/private/path', null, { reason: 'cli_unavailable' }]) {
    assert.equal(delegationRuntimeReasonKey(reason), null);
  }
});

test('only a rejection before start is eligible for terminal-blocked guidance', () => {
  const act = fs.readFileSync(new URL('../public/delegation-act.mjs', import.meta.url), 'utf8');
  assert.match(act, /let startAccepted = false/);
  assert.match(act, /!startAccepted && error instanceof WorktreeOperationError/);
  assert.match(act, /persistDelegationOutcome\(\{ edgeId, operationId, status: 'blocked'/);
});
