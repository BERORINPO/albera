import test from 'node:test';
import assert from 'node:assert/strict';
import { createBeroDirector, CARD_CHOICES, CHOICE_CODES } from '../src/runtime/bero-director.mjs';
import { SAY_CODES, CARD_CODES, HAND_OUTCOMES, validAct, validCard, validLedgerEntry, isCode, LEDGER_CODES } from '../src/runtime/room-contract.mjs';
import { WORDS_BERO, sayKey, cardKey, choiceKey } from '../src/runtime/room-ui/words-bero.mjs';
import { typingSchedule, eyeOffset, bubbleSide, glideMs, figureSlot, MAX_TYPING_MS, CHAR_MS } from '../src/runtime/room-ui/bero.mjs';
import { createAnswerGate, avoidRect } from '../src/runtime/room-ui/cards.mjs';

const VM = 'albera-clone-01';
const VM2 = 'albera-clone-02';
let seq = 0;
const entry = (vmId, code, params = {}, actor = 'hands') => ({ seq: ++seq, at: 1000 + seq, vmId, actor, code, params });
const ended = (vmId, outcome, claim = 'DONE: saved the file') => entry(vmId, 'hands_ended', { outcome, claim, steps: 7, usd: 0.02 });
const checkStarted = (vmId, count = 1) => entry(vmId, 'check_started', { count }, 'bero');
const checkDone = (vmId, verdict, { checks = 1, failed = 0, detail = '' } = {}) => entry(vmId, 'check_done', { verdict, checks, failed, detail }, 'bero');

/** A fake of part C: records calls, returns a valid figure (or null when told to). */
function fakeFigures({ nullFor = [] } = {}) {
  const calls = [];
  const buildFigure = (kind, entries, { vmId = null, figureId, frames = {} }) => {
    calls.push({ kind, n: entries.length, vmId, figureId, frames });
    if (nullFor.includes(kind)) return null;
    const sources = entries.slice(-4);
    if (kind === 'flow') return { figureId, kind, vmId, steps: [{ label: 'step', state: 'now', source: 1 }], sources };
    if (kind === 'who') return { figureId, kind, vmId: null, rows: [{ from: 'human', to: 'bero', code: 'human_choice', params: {}, source: 1 }], sources };
    return { figureId, kind, vmId, before: { frameId: frames.before ?? null }, after: { frameId: frames.after ?? null }, sources };
  };
  return { buildFigure, calls };
}

const running = (lastActionAt) => ({ state: 'running', step: 3, actions: 3, usd: 0.01, cursor: null, lastAction: 'left_click', outcome: null, claim: '', note: '', lastActionAt });
const make = (opts = {}) => {
  const figs = fakeFigures(opts);
  const d = createBeroDirector({ buildFigure: figs.buildFigure, stallMs: 45_000, patrolMs: 20_000, labelOf: (id) => `CAM ${id.slice(-2)}`, ...opts });
  return { d, figs };
};
const allValid = (out) => {
  for (const a of out.acts) assert.ok(validAct(a), `invalid act ${JSON.stringify(a)}`);
  for (const l of out.ledger) assert.ok(validLedgerEntry({ seq: 1, at: 1, ...l }), `invalid ledger ${JSON.stringify(l)}`);
};
const types = (out) => out.acts.map((a) => a.type);

test('say and card params carry the camera label, never the VM id', () => {
  const { d } = make({ labelOf: (id) => (id === VM ? 'Photos' : 'Tests') });
  const outs = [d.tick({ now: 1000, entries: [ended(VM, 'claimed_done')] }), d.tick({ now: 60_000, agents: { [VM2]: running(0) } })];
  for (const out of outs) {
    const say = out.acts.find((a) => a.type === 'say');
    const card = out.acts.find((a) => a.type === 'card').card;
    assert.ok(['Photos', 'Tests'].includes(say.params.cam));
    assert.equal(card.params.cam, say.params.cam);
    assert.ok(!JSON.stringify(say.params).includes('albera-clone'));
  }
});

test('stall: a running VM with no action for stallMs gets one card, said with its chips', () => {
  const { d, figs } = make();
  assert.deepEqual(d.tick({ now: 10_000, agents: { [VM]: running(0) } }).acts, []);
  const out = d.tick({ now: 50_000, agents: { [VM]: running(0) } });
  allValid(out);
  assert.deepEqual(types(out), ['look', 'move', 'point', 'say', 'card']);
  const card = out.acts[4].card;
  assert.ok(validCard(card));
  assert.equal(card.code, 'stalled');
  assert.deepEqual(card.choices.map((c) => [c.code, c.effect]), [['close_it', 'nudge'], ['stop_it', 'stop'], ['later', 'dismiss']]);
  assert.equal(out.acts[3].cardId, card.cardId);
  assert.equal(out.acts[3].params.seconds, 50);
  assert.equal(out.acts[3].params.cam, 'CAM 01');
  assert.equal(card.figure.kind, 'ba');
  assert.deepEqual(figs.calls[0].frames, { before: null, after: null });
  assert.deepEqual(out.ledger.map((l) => l.code), ['hands_stalled', 'bero_noticed', 'bero_card']);
  assert.ok(out.ledger.every((l) => l.actor === 'bero'));
  // no second card for the same stall
  for (let now = 51_000; now < 120_000; now += 1000) {
    assert.ok(!d.tick({ now, agents: { [VM]: running(0) } }).acts.some((a) => a.type === 'card'));
  }
  assert.equal(d.openCards().length, 1);
});

test('stall card without a figure when buildFigure returns null', () => {
  const { d } = make({ nullFor: ['ba'] });
  const out = d.tick({ now: 50_000, agents: { [VM]: running(0) } });
  allValid(out);
  assert.equal(out.acts.at(-1).card.figure, null);
});

test('ended runs open the matching card; DONE stays a claim', () => {
  for (const [outcome, choices] of Object.entries(CARD_CHOICES).filter(([k]) => HAND_OUTCOMES.includes(k))) {
    const { d } = make();
    const out = d.tick({ now: 1000, entries: [ended(VM, outcome)] });
    allValid(out);
    const card = out.acts.find((a) => a.type === 'card').card;
    assert.equal(card.code, outcome);
    assert.deepEqual(card.choices.map((c) => c.code), choices.map(([c]) => c));
    assert.equal(out.acts.find((a) => a.type === 'say').code, outcome);
    assert.ok(out.ledger.some((l) => l.code === 'bero_card' && l.params.cardCode === outcome));
  }
  const { d } = make();
  const card = d.tick({ now: 1000, entries: [ended(VM, 'claimed_done')] }).acts.at(-1).card;
  assert.deepEqual(card.choices.map((c) => c.effect), ['recheck', 'accept', 'dismiss']);
  for (const outcome of ['stopped', 'refused']) {
    const m = make();
    assert.deepEqual(m.d.tick({ now: 1000, entries: [ended(VM, outcome)] }).acts, []);
  }
});

test('one story at a time: the second situation waits, one card per VM', () => {
  const { d } = make();
  const first = d.tick({ now: 1000, entries: [ended(VM, 'claimed_done'), ended(VM2, 'error')] });
  assert.equal(first.acts.filter((a) => a.type === 'card').length, 1);
  assert.equal(first.acts.at(-1).card.vmId, VM);
  assert.deepEqual(d.tick({ now: 2000 }).acts, []); // the gap between stories
  const second = d.tick({ now: 7000 });
  assert.equal(second.acts.at(-1).card.vmId, VM2);
  // a new end on VM waits until VM's card is answered
  d.tick({ now: 20_000, entries: [ended(VM, 'claimed_failed')] });
  assert.equal(d.openCards().filter((c) => c.vmId === VM).length, 1);
  const vmCard = d.openCards().find((c) => c.vmId === VM);
  assert.ok(d.decide(vmCard.cardId, vmCard.choices[1].choiceId, 21_000).ok);
  const reply = d.tick({ now: 21_500 });
  assert.deepEqual(types(reply), ['say']);
  assert.equal(reply.acts[0].code, 'thanks');
  const next = d.tick({ now: 30_000 });
  assert.equal(next.acts.at(-1).card.code, 'claimed_failed');
  assert.equal(d.openCards().filter((c) => c.vmId === VM).length, 1);
});

test('an end drops a stall that was still waiting in the queue', () => {
  const m = make();
  m.d.tick({ now: 1000, entries: [ended(VM2, 'claimed_done')] });
  m.d.tick({ now: 2000, agents: { [VM]: running(-60_000) } }); // stall queued during the gap
  const out = m.d.tick({ now: 7000, entries: [ended(VM, 'claimed_done')] });
  assert.equal(out.acts.at(-1).card.code, 'claimed_done');
  assert.ok(!m.d.openCards().some((c) => c.code === 'stalled'));
});

test('decide: effect and ledger, then card_closed / card_unknown / choice_unknown', () => {
  const { d } = make();
  const card = d.tick({ now: 50_000, agents: { [VM]: running(0) } }).acts.at(-1).card;
  assert.deepEqual(d.decide(card.cardId, 'nope', 51_000), { ok: false, code: 'choice_unknown' });
  const res = d.decide(card.cardId, 'close-it', 51_000);
  assert.ok(res.ok);
  assert.deepEqual(res.effect, { effect: 'nudge', vmId: VM, cardId: card.cardId, choiceId: 'close-it' });
  assert.deepEqual(res.ledger, [{ vmId: VM, actor: 'human', code: 'human_choice', params: { cardCode: 'stalled', choiceCode: 'close_it', effect: 'nudge' } }]);
  assert.ok(validLedgerEntry({ seq: 1, at: 1, ...res.ledger[0] }));
  assert.deepEqual(d.decide(card.cardId, 'close-it', 52_000), { ok: false, code: 'card_closed' });
  assert.deepEqual(d.decide('card-999', 'close-it', 52_000), { ok: false, code: 'card_unknown' });
  assert.equal(d.openCards().length, 0);
  const reply = d.tick({ now: 52_000, agents: { [VM]: running(0) } });
  assert.equal(reply.acts[0].code, 'doing_it');
  // snoozed: the same stall is not asked again right away, but comes back after stallMs if nothing moved
  for (let now = 53_000; now < 96_000; now += 1000) assert.ok(!d.tick({ now, agents: { [VM]: running(0) } }).acts.some((a) => a.type === 'card'));
  let againAt = null;
  for (let now = 96_000; now < 130_000 && againAt === null; now += 1000) {
    if (d.tick({ now, agents: { [VM]: running(0) } }).acts.at(-1)?.card?.code === 'stalled') againAt = now;
  }
  assert.ok(againAt !== null && againAt >= 96_000);
});

test('openCards returns copies', () => {
  const { d } = make();
  d.tick({ now: 1000, entries: [ended(VM, 'claimed_done')] });
  const [c] = d.openCards();
  c.choices.length = 0;
  c.params.claim = 'changed';
  assert.equal(d.openCards()[0].choices.length, 3);
  assert.notEqual(d.openCards()[0].params.claim, 'changed');
});

test('progress: a flow figure every 8 steps, at most once a minute per VM, only with no card open', () => {
  const { d, figs } = make();
  const steps = (n) => Array.from({ length: n }, (_, i) => entry(VM, 'hands_step', { step: i + 1, usd: 0, action: 'left_click', note: 'n' }));
  assert.deepEqual(d.tick({ now: 1000, entries: steps(7) }).acts, []);
  assert.ok(!d.tick({ now: 13_000, agents: { [VM]: running(12_500) } }).acts.some((a) => a.type === 'figure')); // 7 < 8
  const out = d.tick({ now: 13_500, entries: steps(1), agents: { [VM]: running(13_400) } });
  allValid(out);
  assert.deepEqual(types(out), ['look', 'move', 'say', 'figure']);
  assert.equal(out.acts[3].figure.kind, 'flow');
  assert.deepEqual(out.acts[3].near, { vmId: VM });
  assert.deepEqual(out.ledger, [{ vmId: VM, actor: 'bero', code: 'bero_figure', params: { kind: 'flow' } }]);
  assert.equal(figs.calls.at(-1).n, 8);
  // 8 more steps right away: still not before a minute has passed
  d.tick({ now: 27_000, entries: steps(8), agents: { [VM]: running(26_900) } });
  for (let now = 28_000; now < 73_000; now += 1000) assert.ok(!d.tick({ now, agents: { [VM]: running(now - 100) } }).acts.some((a) => a.type === 'figure'));
  let at = null;
  for (let now = 73_000; now < 120_000 && at === null; now += 1000) if (d.tick({ now, agents: { [VM]: running(now - 100) } }).acts.some((a) => a.type === 'figure')) at = now;
  assert.ok(at !== null && at >= 73_500);
});

test('progress waits while any card is open', () => {
  const { d } = make();
  d.tick({ now: 1000, entries: [ended(VM2, 'claimed_done'), ...Array.from({ length: 9 }, (_, i) => entry(VM, 'hands_step', { step: i + 1 }))] });
  for (let now = 2000; now < 100_000; now += 1000) assert.ok(!d.tick({ now, agents: { [VM]: running(now - 100) } }).acts.some((a) => a.type === 'figure'));
});

test('progress is skipped when buildFigure returns null', () => {
  const { d } = make({ nullFor: ['flow'] });
  const steps = Array.from({ length: 9 }, (_, i) => entry(VM, 'hands_step', { step: i + 1 }));
  d.tick({ now: 1000, entries: steps });
  const out = d.tick({ now: 13_000, agents: { [VM]: running(12_900) } });
  assert.ok(!out.acts.some((a) => a.type === 'say' || a.type === 'figure'));
});

test('summary: after human choices, a who figure counts them', () => {
  const { d, figs } = make();
  const card = d.tick({ now: 1000, entries: [ended(VM, 'claimed_done')] }).acts.at(-1).card;
  const res = d.decide(card.cardId, 'check-again', 2000);
  assert.equal(res.effect.effect, 'recheck');
  d.tick({ now: 2500, entries: [entry(VM, 'human_choice', res.ledger[0].params, 'human')] });
  assert.ok(!d.tick({ now: 9000 }).acts.some((a) => a.type === 'figure'));
  const out = d.tick({ now: 15_000 });
  allValid(out);
  assert.deepEqual(types(out), ['hush', 'look', 'figure', 'move', 'say']);
  assert.equal(out.acts[2].figure.kind, 'who');
  assert.deepEqual(out.acts[3].to, { figureId: out.acts[2].figure.figureId });
  assert.deepEqual(out.acts[4].params, { count: 1 });
  assert.equal(figs.calls.at(-1).kind, 'who');
  assert.ok(!d.tick({ now: 60_000 }).acts.some((a) => a.type === 'figure')); // told once
});

test('patrol: look / point only, every patrolMs when idle', () => {
  const { d } = make();
  const agents = { [VM]: running(0), [VM2]: { ...running(0), state: 'done' } };
  const fired = [];
  for (let now = 0; now <= 60_000; now += 1000) {
    const out = d.tick({ now, agents: { [VM]: { ...agents[VM], lastActionAt: now }, [VM2]: agents[VM2] } });
    allValid(out);
    if (out.acts.length) fired.push([now, out]);
  }
  assert.deepEqual(fired.map(([now]) => now), [20_000, 40_000, 60_000]);
  for (const [, out] of fired) {
    assert.ok(out.acts.every((a) => ['hush', 'look', 'point'].includes(a.type)));
    assert.deepEqual(out.acts.filter((a) => a.type === 'point').map((a) => a.vmId), [VM, VM2]);
    assert.deepEqual(out.ledger, []);
  }
  assert.deepEqual(d.tick({ now: 100 }).acts, []); // no VMs, no patrol
});

test('bad input is ignored, time is required', () => {
  const { d } = make();
  assert.throws(() => d.tick({}), TypeError);
  assert.throws(() => createBeroDirector({}), TypeError);
  assert.deepEqual(d.tick({ now: 1, entries: [{ seq: 0, code: 'hands_ended' }, null], agents: { [VM]: null } }).acts, []);
});

test('words: every say, card and choice code has en and ja, and none calls a claim verified', () => {
  for (const lang of ['en', 'ja']) {
    const dict = WORDS_BERO[lang];
    for (const c of SAY_CODES) assert.ok(dict[sayKey(c)], `${lang} ${sayKey(c)}`);
    for (const c of CARD_CODES) assert.ok(dict[cardKey(c)], `${lang} ${cardKey(c)}`);
    for (const c of CHOICE_CODES) assert.ok(dict[choiceKey(c)], `${lang} ${choiceKey(c)}`);
    for (const k of ['bero.ui.name', 'bero.ui.for', 'bero.ui.claim_note']) assert.ok(dict[k]);
    for (const k of [sayKey('claimed_done'), cardKey('claimed_done')]) assert.ok(!/verified|confirmed|確認済|検証済/i.test(dict[k]));
    // only `verified` (after a passed check) may say it was confirmed, and it names how many checks passed
    for (const c of ['checking', 'check_failed', 'check_unavailable']) {
      for (const k of [sayKey(c), cardKey(c)]) if (dict[k]) assert.ok(!/verified|confirmed|確かめたので|確認済|検証済/i.test(dict[k]), k);
    }
    assert.ok(dict[sayKey('verified')].includes('{checks}'));
    assert.ok(dict[sayKey('check_failed')].includes('{detail}'));
    for (const k of ['bero.ui.finding', 'bero.ui.ai_claim']) assert.ok(dict[k]);
  }
  assert.deepEqual(Object.keys(WORDS_BERO.en).sort(), Object.keys(WORDS_BERO.ja).sort());
  for (const c of CHOICE_CODES) assert.ok(isCode(c));
  assert.ok(LEDGER_CODES.includes('human_choice'));
});

test('ui helpers: typing schedule, eyes, bubble side, glide', () => {
  const plain = typingSchedule('abc');
  assert.deepEqual(plain, [CHAR_MS, CHAR_MS, CHAR_MS]);
  const ja = typingSchedule('止まっています。閉じますか?');
  assert.ok(ja[7] > ja[0]); // waits after 。
  const long = typingSchedule('x'.repeat(500));
  assert.ok(long.reduce((a, b) => a + b, 0) <= MAX_TYPING_MS + long.length);
  assert.ok(typingSchedule('abc', { reduced: true }).every((ms) => ms === 0));
  assert.deepEqual(eyeOffset({ x: 0, y: 0 }, { x: 100, y: 0 }), { dx: 3, dy: 0 });
  assert.deepEqual(eyeOffset({ x: 0, y: 0 }, { x: 0, y: 0 }), { dx: 0, dy: 0 });
  assert.deepEqual(eyeOffset(null, { x: 1, y: 1 }), { dx: 0, dy: 0 });
  assert.equal(bubbleSide({ x: 100, y: 0 }, { worldW: 1700 }), 'right');
  assert.equal(bubbleSide({ x: 1600, y: 0 }, { worldW: 1700 }), 'left');
  assert.equal(bubbleSide({ x: 10, y: 0 }, { worldW: 200 }), 'right'); // no room on either side: keep right
  assert.equal(glideMs({ x: 0, y: 0 }, { x: 10, y: 0 }), 600);
  assert.equal(glideMs({ x: 0, y: 0 }, { x: 5000, y: 0 }), 1400);
  assert.equal(glideMs({ x: 0, y: 0 }, { x: 5000, y: 0 }, { reduced: true }), 0);
  assert.equal(figureSlot({ vmId: VM }, { vmId: VM }), VM);
  assert.equal(figureSlot({ vmId: null }, null), 'all');
});

test('cards keep off Bero', () => {
  const size = { w: 300, h: 220 };
  assert.deepEqual(avoidRect({ x: 0, y: 0 }, size, null), { x: 0, y: 0 });
  assert.deepEqual(avoidRect({ x: 0, y: 0 }, size, { x: 500, y: 0, w: 100, h: 100 }), { x: 0, y: 0 });
  assert.deepEqual(avoidRect({ x: 0, y: 0 }, size, { x: 50, y: 10, w: 360, h: 150 }), { x: 0, y: 172 });
});

test('cards answer once', () => {
  const gate = createAnswerGate();
  const card = { cardId: 'card-1', choices: [{ choiceId: 'close-it' }, { choiceId: 'later' }] };
  assert.equal(gate.take(card, 'nope'), false);
  assert.equal(gate.take(card, 'close-it'), true);
  assert.equal(gate.take(card, 'later'), false);
  assert.ok(gate.answered('card-1'));
  gate.release('card-1');
  assert.equal(gate.take(card, 'later'), true);
  assert.equal(gate.take(null, 'later'), false);
});

// ---- automatic checks (spec/room.md §7) ----

test('checks: check_started -> hands_ended says checking (no card), then passed says verified with the counts', () => {
  const { d } = make({ labelOf: () => 'Booking' });
  const first = d.tick({ now: 1000, entries: [checkStarted(VM, 2), ended(VM, 'claimed_done')] });
  allValid(first);
  assert.deepEqual(types(first), ['look', 'move', 'point', 'say']);
  assert.equal(first.acts[3].code, 'checking');
  assert.deepEqual(first.acts[3].params, { cam: 'Booking' });
  assert.equal(first.acts[3].cardId, null);
  assert.deepEqual(first.ledger, []);
  assert.equal(d.openCards().length, 0);
  assert.deepEqual(d.tick({ now: 3000, entries: [checkDone(VM, 'passed', { checks: 2 })] }).acts, []); // the gap
  const second = d.tick({ now: 8000 });
  allValid(second);
  assert.deepEqual(types(second), ['look', 'move', 'point', 'say']);
  assert.equal(second.acts[3].code, 'verified');
  assert.deepEqual(second.acts[3].params, { cam: 'Booking', checks: 2, failed: 0 });
  assert.deepEqual(second.ledger, []);
  assert.equal(d.openCards().length, 0);
  for (let now = 9000; now < 60_000; now += 1000) assert.ok(!d.tick({ now }).acts.some((a) => a.type === 'card'));
});

test('checks: a verdict that arrives before checking was said replaces it', () => {
  const { d } = make();
  d.tick({ now: 1000, entries: [ended(VM2, 'error')] }); // VM2's card takes the first story
  d.tick({ now: 2000, entries: [checkStarted(VM), ended(VM, 'claimed_done'), checkDone(VM, 'passed')] });
  const next = d.tick({ now: 8000 });
  assert.equal(next.acts.at(-1).code, 'verified');
  assert.deepEqual(d.tick({ now: 20_000 }).acts.filter((a) => a.type === 'say'), []);
});

test('checks: failed opens a check_failed card with the finding, said with its chips', () => {
  const { d } = make({ labelOf: () => 'Tests' });
  d.tick({ now: 1000, entries: [checkStarted(VM, 3), ended(VM, 'claimed_done', 'DONE: all tests pass')] });
  const detail = 'C:\\work\\report.txt: missing';
  const out = d.tick({ now: 8000, entries: [checkDone(VM, 'failed', { checks: 3, failed: 1, detail })] });
  allValid(out);
  assert.deepEqual(types(out), ['look', 'move', 'point', 'say', 'card']);
  const card = out.acts[4].card;
  assert.ok(validCard(card));
  assert.equal(card.code, 'check_failed');
  assert.deepEqual(card.params, { cam: 'Tests', detail, claim: 'DONE: all tests pass' });
  assert.deepEqual(card.choices.map((c) => [c.code, c.effect]), [['check_again', 'recheck'], ['mark_done', 'accept'], ['later', 'dismiss']]);
  const say = out.acts[3];
  assert.equal(say.code, 'check_failed');
  assert.equal(say.cardId, card.cardId);
  assert.deepEqual(say.params, { cam: 'Tests', checks: 3, failed: 1, detail });
  assert.deepEqual(out.ledger.map((l) => [l.code, l.params]), [['bero_noticed', { what: 'check_failed' }], ['bero_card', { cardCode: 'check_failed' }]]);
  assert.equal(d.openCards().length, 1);
});

test('checks: unavailable opens a check_unavailable card, mark done first', () => {
  const { d } = make();
  d.tick({ now: 1000, entries: [checkStarted(VM), ended(VM, 'claimed_done')] });
  const out = d.tick({ now: 8000, entries: [checkDone(VM, 'unavailable', { checks: 1, failed: 0 })] });
  allValid(out);
  const card = out.acts.at(-1).card;
  assert.equal(card.code, 'check_unavailable');
  assert.deepEqual(card.choices.map((c) => [c.code, c.effect]), [['mark_done', 'accept'], ['check_again', 'recheck'], ['later', 'dismiss']]);
  assert.equal(out.acts.find((a) => a.type === 'say').code, 'check_unavailable');
});

test('checks: a VM without checks keeps the claimed_done card next to a checked one', () => {
  const { d } = make();
  const first = d.tick({ now: 1000, entries: [ended(VM2, 'claimed_done'), checkStarted(VM), ended(VM, 'claimed_done')] });
  assert.equal(first.acts.at(-1).card.code, 'claimed_done');
  assert.equal(first.acts.at(-1).card.vmId, VM2);
  const second = d.tick({ now: 8000 });
  assert.equal(second.acts.at(-1).code, 'checking');
  assert.equal(second.acts.at(-1).params.cam, 'CAM 01');
  assert.deepEqual(d.openCards().map((c) => [c.vmId, c.code]), [[VM2, 'claimed_done']]);
});

test('checks: a passed check closes a claimed_done card still open for that VM', () => {
  const { d } = make();
  const card = d.tick({ now: 1000, entries: [ended(VM, 'claimed_done'), checkStarted(VM)] }).acts.at(-1).card;
  assert.equal(card.code, 'claimed_done');
  const out = d.tick({ now: 8000, entries: [checkDone(VM, 'passed')] });
  assert.equal(out.acts.at(-1).code, 'verified');
  assert.equal(d.openCards().length, 0);
  assert.deepEqual(d.decide(card.cardId, 'mark-done', 9000), { ok: false, code: 'card_closed' });
});

test('checks: recheck after a failure, then the new DONE is checked and passes', () => {
  const { d } = make();
  d.tick({ now: 1000, entries: [checkStarted(VM), ended(VM, 'claimed_done')] });
  const card = d.tick({ now: 8000, entries: [checkDone(VM, 'failed', { failed: 1, detail: 'C:\\a.txt: differs' })] }).acts.at(-1).card;
  const res = d.decide(card.cardId, 'check-again', 9000);
  assert.ok(res.ok);
  assert.equal(res.effect.effect, 'recheck');
  assert.equal(d.tick({ now: 9500 }).acts[0].code, 'doing_it');
  const again = d.tick({ now: 20_000, entries: [entry(VM, 'hands_started', { task: 'recheck' }), checkStarted(VM), ended(VM, 'claimed_done')] });
  assert.equal(again.acts.at(-1).code, 'checking');
  const passed = d.tick({ now: 30_000, entries: [checkDone(VM, 'passed')] });
  assert.equal(passed.acts.at(-1).code, 'verified');
  assert.equal(d.openCards().length, 0);
});

test('checks: a bad verdict is ignored, a stall card does not hold the checking line back', () => {
  const { d } = make();
  d.tick({ now: 50_000, agents: { [VM]: running(0) } }); // stall card on VM
  const out = d.tick({ now: 60_000, entries: [checkStarted(VM), ended(VM, 'claimed_done'), checkDone(VM, 'maybe')] });
  assert.equal(out.acts.at(-1).code, 'checking');
  assert.deepEqual(d.tick({ now: 70_000 }).acts.filter((a) => a.type === 'say' || a.type === 'card'), []);
});
