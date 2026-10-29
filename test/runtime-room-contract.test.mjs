import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText, cleanParams, validLedgerEntry, validFigure, validCard, validAct, validEvent,
} from '../src/runtime/room-contract.mjs';
import { createAgentStatusBoard } from '../src/runtime/agent-status-board.mjs';

const entry = (over = {}) => ({ seq: 1, at: 1000, vmId: 'albera-clone-01', actor: 'hands', code: 'hands_step', params: { step: 1 }, ...over });

test('untrusted text loses control characters and is cut', () => {
  assert.equal(cleanText('a\u0007b\nc'), 'a b c');
  assert.equal(cleanText('x'.repeat(300)).length, 200);
  assert.equal(cleanText(42), '');
  assert.deepEqual(cleanParams({ ok: 'v\u0000', n: 2, bad: { a: 1 }, 'no-dash': 1, nan: Number.NaN }), { ok: 'v', n: 2 });
});

test('ledger entries need a known actor and code', () => {
  assert.ok(validLedgerEntry(entry()));
  assert.ok(validLedgerEntry(entry({ vmId: null, actor: 'human', code: 'human_choice' })));
  assert.ok(!validLedgerEntry(entry({ actor: 'robot' })));
  assert.ok(!validLedgerEntry(entry({ code: 'made_up' })));
  assert.ok(!validLedgerEntry(entry({ seq: 0 })));
});

test('figures carry their sources and stay small', () => {
  const flow = { figureId: 'f1', kind: 'flow', vmId: 'albera-clone-01', steps: [{ label: 'open notepad', state: 'done', source: 1 }, { label: 'type', state: 'now', source: 2 }], sources: [entry()] };
  assert.ok(validFigure(flow));
  assert.ok(!validFigure({ ...flow, sources: [entry(), entry(), entry(), entry(), entry()] }));
  assert.ok(!validFigure({ ...flow, steps: [{ label: 'x'.repeat(41), state: 'now', source: 1 }] }));
  assert.ok(validFigure({ figureId: 'f2', kind: 'who', vmId: null, rows: [{ from: 'human', to: 'bero', code: 'human_choice', params: {}, source: 3 }], sources: [] }));
  assert.ok(validFigure({ figureId: 'f3', kind: 'ba', vmId: 'albera-clone-01', before: { frameId: 'fr1' }, after: { frameId: null }, sources: [] }));
  assert.ok(!validFigure({ figureId: 'f3', kind: 'ba', vmId: null, before: { frameId: 'fr1' }, after: { frameId: null }, sources: [] }));
});

test('cards offer at most three known effects', () => {
  const card = { cardId: 'c1', vmId: 'albera-clone-01', code: 'claimed_done', params: { claim: 'DONE' }, figure: null, openedAt: 5,
    choices: [{ choiceId: 'a', code: 'check_again', effect: 'recheck' }, { choiceId: 'b', code: 'mark_done', effect: 'accept' }] };
  assert.ok(validCard(card));
  assert.ok(!validCard({ ...card, choices: [{ choiceId: 'a', code: 'run_anything', effect: 'type_text' }] }));
  assert.ok(!validCard({ ...card, choices: [...card.choices, ...card.choices] }));
  assert.ok(validAct({ type: 'card', card }));
});

test('acts and events are checked by type', () => {
  assert.ok(validAct({ type: 'look', at: 'all' }));
  assert.ok(validAct({ type: 'move', to: { vmId: 'albera-clone-01' } }));
  assert.ok(validAct({ type: 'move', to: 'home' }));
  assert.ok(validAct({ type: 'say', code: 'stalled', params: { cam: 'CAM 03', seconds: 240 }, cardId: null }));
  assert.ok(!validAct({ type: 'say', code: 'free_text', params: {}, cardId: null }));
  assert.ok(!validAct({ type: 'teleport' }));
  assert.ok(validEvent({ seq: 1, kind: 'ledger', entry: entry() }));
  assert.ok(validEvent({ seq: 2, kind: 'card_closed', cardId: 'c1', choiceId: null }));
  assert.ok(!validEvent({ seq: 3, kind: 'bero', act: { type: 'nope' } }));
});

test('status board keeps the AI note and when it last acted', () => {
  let t = 100;
  const board = createAgentStatusBoard({ now: () => t });
  board.record('albera-clone-01', { type: 'step', step: 1, usd: 0.001, note: 'Opening\u0007Notepad' });
  t = 250;
  board.record('albera-clone-01', { type: 'action', action: 'left_click', cursor: [10, 20] });
  const e = board.snapshot()['albera-clone-01'];
  assert.equal(e.note, 'Opening Notepad');
  assert.equal(e.lastActionAt, 250);
});

test('checks: only fixed read-only kinds on plain local paths', async () => {
  const { validCheck, validCheckReport, isGuestPath } = await import('../src/runtime/room-contract.mjs');
  const r = String.raw;
  assert.ok(validCheck({ kind: 'file_exists', path: r`C:\Users\Administrator\Desktop\room1.txt` }));
  assert.ok(validCheck({ kind: 'file_text', path: r`C:\x\a.txt`, text: 'control room clone 01' }));
  assert.ok(validCheck({ kind: 'dir_has', path: r`C:\Users\Administrator\Desktop\room-two`, name: 'notes.txt' }));
  for (const bad of [r`C:\x\..\y`, r`\\server\share\a`, r`C:\x\*.txt`, r`relative\a.txt`, 'C:/x/a.txt']) assert.ok(!isGuestPath(bad), bad);
  assert.ok(!validCheck({ kind: 'run_script', path: r`C:\x` }));
  assert.ok(!validCheck({ kind: 'file_exists', path: r`C:\x\a`, extra: 1 }));
  assert.ok(!validCheck({ kind: 'dir_has', path: r`C:\x`, name: '..' }));
  const results = [{ kind: 'file_exists', path: r`C:\x\a`, finding: 'ok' }];
  assert.ok(validCheckReport({ verdict: 'passed', results }, 1));
  assert.ok(!validCheckReport({ verdict: 'passed', results: [{ ...results[0], finding: 'missing' }] }, 1));
  assert.ok(validCheckReport({ verdict: 'unavailable', results: [], code: 'guest_unreachable' }, 1));
});
