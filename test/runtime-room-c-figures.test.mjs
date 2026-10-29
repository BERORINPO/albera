import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomJournal } from '../src/runtime/room-journal.mjs';
import { buildFigure, cutLabel, whoRows } from '../src/runtime/room-figures.mjs';
import { validFigure, validLedgerEntry, LEDGER_CODES, FIGURE_KINDS, HAND_OUTCOMES, EFFECTS, CARD_CODES, CHECK_VERDICTS, CHECK_FINDINGS } from '../src/runtime/room-contract.mjs';
import { wrapLabel, flowLayout, whoLayout, whoKey, stage, MAX_STAGE } from '../src/runtime/room-ui/figure.mjs';
import { nextRows, entryText, clockOf, checkMark, detailText, LEDGER_ROWS } from '../src/runtime/room-ui/ledger.mjs';
import { FIGURE_WORDS } from '../src/runtime/room-ui/words-figure.mjs';

const VM = 'albera-clone-01';
const clock = () => { let t = 1_000; return () => (t += 1_000); };
const fakeWords = (lang = 'en') => ({ t: (code, params = {}) => String(FIGURE_WORDS[lang][code] ?? code).replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? '')) });

test('journal maps step and end events, remembering the last action', () => {
  const j = createRoomJournal({ now: clock() });
  assert.equal(j.recordFleetEvent(VM, { type: 'action', step: 1, action: 'left_click', ok: true }), null);
  const step = j.recordFleetEvent(VM, { type: 'step', step: 1, usd: 0.01, ms: 5, note: 'Opening Notepad' });
  assert.equal(step.code, 'hands_step');
  assert.deepEqual(step.params, { step: 1, usd: 0.01, action: 'left_click', note: 'Opening Notepad' });
  const end = j.recordFleetEvent(VM, { type: 'end', outcome: 'claimed_done', claim: 'DONE saved', steps: 3, usd: 0.04, reason: 'x', ms: 9 });
  assert.equal(end.code, 'hands_ended');
  assert.deepEqual(end.params, { outcome: 'claimed_done', claim: 'DONE saved', steps: 3, usd: 0.04 });
  assert.equal(j.recordFleetEvent(VM, { type: 'step', step: 1, usd: 0, note: '' }).params.action, '', 'end forgets the action');
  assert.equal(j.recordFleetEvent(VM, { type: 'end', outcome: 'pass', claim: '', steps: 1, usd: 0 }).params.outcome, 'error');
  assert.equal(j.recordFleetEvent(VM, { type: 'other' }), null);
  assert.ok(j.all().every(validLedgerEntry));
  assert.deepEqual(j.all().map((e) => e.seq), [1, 2, 3, 4]);
});

test('journal keeps no typed text, key names or screen data', () => {
  const j = createRoomJournal({ now: clock() });
  j.recordFleetEvent(VM, { type: 'action', action: 'type', text: 'hunter2', key: 'ctrl+s', textLength: 7 });
  const e = j.recordFleetEvent(VM, { type: 'step', step: 1, usd: 0, note: 'ok', text: 'hunter2', key: 'Return', png: 'AAAA', screen: { a: 1 } });
  assert.deepEqual(Object.keys(e.params).sort(), ['action', 'note', 'step', 'usd']);
  assert.ok(!JSON.stringify(j.all()).includes('hunter2'));
  const rec = j.record({ vmId: VM, actor: 'human', code: 'human_choice', params: { effect: 'stop', nested: { text: 'x' }, list: [1] } });
  assert.deepEqual(rec.params, { effect: 'stop' });
});

test('journal is a ring buffer and since() reads after a seq', () => {
  const j = createRoomJournal({ max: 3, now: clock() });
  for (let i = 1; i <= 5; i++) j.record({ vmId: VM, actor: 'hands', code: 'hands_step', params: { step: i } });
  assert.deepEqual(j.all().map((e) => e.seq), [3, 4, 5]);
  assert.deepEqual(j.since(3).map((e) => e.seq), [4, 5]);
  assert.equal(j.lastSeq(), 5);
  assert.throws(() => j.record({ vmId: VM, actor: 'robot', code: 'hands_step' }));
  assert.throws(() => createRoomJournal({ max: 0 }));
  assert.equal(j.lastSeq(), 5, 'a refused entry takes no seq');
});

const steps = (n, vmId = VM, note = (i) => `note ${i}`) => {
  const j = createRoomJournal({ now: clock() });
  for (let i = 1; i <= n; i++) {
    j.recordFleetEvent(vmId, { type: 'action', action: `act${i}` });
    j.recordFleetEvent(vmId, { type: 'step', step: i, usd: i / 100, note: note(i) });
  }
  return j;
};

test('flow: the last five steps of the VM, the newest is now', () => {
  const j = steps(7);
  j.recordFleetEvent('other-vm', { type: 'step', step: 1, usd: 0, note: 'elsewhere' });
  const f = buildFigure('flow', j.all(), { vmId: VM, figureId: 'fig1' });
  assert.ok(validFigure(f));
  assert.deepEqual(f.steps.map((s) => s.label), ['note 3', 'note 4', 'note 5', 'note 6', 'note 7']);
  assert.deepEqual(f.steps.map((s) => s.state), ['done', 'done', 'done', 'done', 'now']);
  assert.equal(f.sources.length, 4);
  assert.deepEqual(f.sources.map((e) => e.seq), f.steps.slice(1).map((s) => s.source));
});

test('flow labels: cut to 40 chars, fallback to the action name, then the step number', () => {
  const long = 'x'.repeat(100);
  const f = buildFigure('flow', steps(3, VM, (i) => (i === 1 ? long : i === 2 ? '' : '  a\nb  ')).all(), { vmId: VM, figureId: 'fig2' });
  assert.ok(validFigure(f));
  assert.equal(f.steps[0].label.length, 40);
  assert.ok(f.steps[0].label.endsWith('\u2026'));
  assert.equal(f.steps[1].label, 'act2');
  assert.equal(f.steps[2].label, 'a b');
  const j = createRoomJournal({ now: clock() });
  j.recordFleetEvent(VM, { type: 'step', step: 4, usd: 0, note: '' });
  assert.equal(buildFigure('flow', j.all(), { vmId: VM, figureId: 'fig3' }).steps[0].label, '#4');
  assert.equal(cutLabel('abc', 40), 'abc');
});

const whoJournal = () => {
  const j = createRoomJournal({ now: clock() });
  j.record({ vmId: VM, actor: 'hands', code: 'hands_step', params: { step: 1 } });
  j.record({ vmId: VM, actor: 'bero', code: 'hands_stalled', params: { seconds: 60 } });
  j.record({ vmId: VM, actor: 'bero', code: 'bero_card', params: { cardCode: 'stalled' } });
  j.record({ vmId: VM, actor: 'human', code: 'human_choice', params: { cardCode: 'stalled', choiceCode: 'close_it', effect: 'nudge' } });
  j.record({ vmId: VM, actor: 'hands', code: 'hands_ended', params: { outcome: 'claimed_done', claim: 'DONE', steps: 2, usd: 0 } });
  j.record({ vmId: VM, actor: 'human', code: 'human_choice', params: { effect: 'accept' } });
  return j;
};

test('who: rows in ledger order, the chosen job goes bero -> hands', () => {
  const f = buildFigure('who', whoJournal().all(), { vmId: VM, figureId: 'w1' });
  assert.ok(validFigure(f));
  assert.deepEqual(f.rows.map((r) => `${r.from}>${r.to}:${r.code}`), [
    'hands>bero:hands_stalled', 'bero>human:bero_card', 'human>bero:human_choice', 'bero>hands:human_choice',
    'hands>bero:hands_ended', 'human>bero:human_choice',
  ]);
  assert.deepEqual(f.sources.map((e) => e.seq), [3, 4, 5, 6], 'the last four entries used');
  assert.equal(whoKey(f.rows[3]), 'who_job_nudge');
  assert.equal(whoKey(f.rows[2]), 'who_human_choice');
});

test('who: at most 8 rows (the newest), other VMs left out', () => {
  const j = createRoomJournal({ now: clock() });
  for (let i = 0; i < 6; i++) j.record({ vmId: VM, actor: 'human', code: 'human_choice', params: { effect: 'stop' } });
  j.record({ vmId: 'other-vm', actor: 'bero', code: 'bero_card', params: {} });
  const f = buildFigure('who', j.all(), { vmId: VM, figureId: 'w2' });
  assert.ok(validFigure(f));
  assert.equal(f.rows.length, 8);
  assert.equal(f.rows.at(-1).source, 6);
  const all = buildFigure('who', j.all(), { figureId: 'w3' });
  assert.equal(all.rows.at(-1).code, 'bero_card');
  assert.deepEqual(whoRows({ seq: 1, code: 'hands_step', params: {} }), []);
});

test('ba: needs the VM and a before frame; after may be missing', () => {
  const entries = whoJournal().all();
  const f = buildFigure('ba', entries, { vmId: VM, figureId: 'b1', frames: { before: 'frame-1', after: null } });
  assert.ok(validFigure(f));
  assert.deepEqual(f.after, { frameId: null });
  assert.ok(f.sources.length <= 4 && f.sources.every((e) => e.vmId === VM));
  assert.ok(validFigure(buildFigure('ba', [], { vmId: VM, figureId: 'b2', frames: { before: 'frame-1', after: 'frame-2' } })));
});

test('null when there is not enough to draw', () => {
  assert.equal(buildFigure('flow', [], { vmId: VM, figureId: 'n1' }), null);
  assert.equal(buildFigure('flow', steps(2).all(), { vmId: null, figureId: 'n2' }), null);
  assert.equal(buildFigure('who', steps(2).all(), { vmId: VM, figureId: 'n3' }), null);
  assert.equal(buildFigure('ba', [], { vmId: VM, figureId: 'n4', frames: {} }), null);
  assert.equal(buildFigure('ba', [], { vmId: null, figureId: 'n5', frames: { before: 'f' } }), null);
  assert.equal(buildFigure('pie', steps(2).all(), { vmId: VM, figureId: 'n6' }), null);
  assert.equal(buildFigure('flow', steps(2).all(), { vmId: VM, figureId: 'bad id!' }), null, 'invalid specs are not returned');
});

test('figure layout helpers', () => {
  assert.deepEqual(wrapLabel('short'), ['short']);
  assert.deepEqual(wrapLabel('Moving photo 9 into its date folder', 22), ['Moving photo 9 into', 'its date folder'], 'breaks at spaces, never mid-word');
  assert.deepEqual(wrapLabel('one two three four five six seven eight nine', 12), ['one two', 'three four\u2026']);
  const two = wrapLabel('a'.repeat(30), 22);
  assert.deepEqual(two.map((s) => s.length), [22, 8], 'text without spaces is split by chars');
  const cut = wrapLabel('a'.repeat(60), 22);
  assert.equal(cut[1].length, 22);
  assert.ok(cut[1].endsWith('\u2026'));
  for (const s of [...wrapLabel('x'.repeat(40) + ' y'), ...wrapLabel('ab cd '.repeat(20), 10)]) assert.ok(s.length <= 22);
  const { boxes, height } = flowLayout(3);
  assert.equal(boxes.length, 3);
  for (let i = 1; i < 3; i++) assert.ok(boxes[i].y >= boxes[i - 1].y + boxes[i - 1].h, 'boxes do not overlap');
  assert.ok(height >= boxes[2].y + boxes[2].h);
  const who = whoLayout(4);
  assert.ok(who.xs.human < who.xs.bero && who.xs.bero < who.xs.hands);
  assert.equal(who.ys.length, 4);
  assert.ok(who.height > who.ys[3]);
  assert.equal(stage(99), `rf-s${MAX_STAGE}`);
  assert.equal(stage(-1), 'rf-s0');
});

test('ledger rows: newest at the bottom, max 6, steps collapse per VM', () => {
  let rows = [];
  const e = (seq, code, vmId = VM) => ({ seq, at: 0, vmId, actor: 'hands', code, params: {} });
  rows = nextRows(rows, e(1, 'hands_step')).rows;
  const r2 = nextRows(rows, e(2, 'hands_step'));
  assert.equal(r2.replaced, `step:${VM}`);
  assert.equal(r2.rows.length, 1);
  assert.equal(r2.rows[0].entry.seq, 2);
  rows = r2.rows;
  rows = nextRows(rows, e(3, 'hands_step', 'other-vm')).rows;
  for (let s = 4; s <= 10; s++) rows = nextRows(rows, e(s, 'human_choice')).rows;
  assert.equal(rows.length, LEDGER_ROWS);
  assert.equal(rows.at(-1).entry.seq, 10);
});

test('words: every ledger code, outcome, effect, card and figure title in en and ja', () => {
  for (const lang of ['en', 'ja']) {
    const d = FIGURE_WORDS[lang];
    const need = [
      ...LEDGER_CODES.map((c) => `led_${c}`), ...HAND_OUTCOMES.map((c) => `outcome_${c}`), ...EFFECTS.map((c) => `effect_${c}`),
      ...CARD_CODES.map((c) => `what_${c}`), ...FIGURE_KINDS.map((k) => `fig_${k}`), ...FIGURE_KINDS.map((k) => `fig_${k}_kind`),
      ...CHECK_VERDICTS.map((v) => `verdict_${v}`), ...CHECK_VERDICTS.map((v) => `mark_${v}`), ...CHECK_FINDINGS.map((f) => `finding_${f}`),
      'mark_checking', 'who_job_stop', 'who_job_nudge', 'who_job_recheck', 'fig_sources', 'ledger_title', 'fig_done', 'fig_now',
    ];
    for (const key of need) assert.ok(typeof d[key] === 'string' && d[key].length > 0, `${lang}.${key}`);
  }
  assert.deepEqual(Object.keys(FIGURE_WORDS.en).sort(), Object.keys(FIGURE_WORDS.ja).sort());
  const words = fakeWords('ja');
  const line = entryText(words, { seq: 1, at: 0, vmId: VM, actor: 'hands', code: 'hands_ended', params: { outcome: 'claimed_done' } });
  assert.ok(line.includes('未確認'), 'a DONE claim stays a claim');
  assert.equal(entryText(words, { seq: 1, at: 0, vmId: VM, actor: 'human', code: 'human_choice', params: { effect: 'stop' } }), '止めて');
  const stalled = { seq: 2, at: 0, vmId: 'demo-photos', actor: 'bero', code: 'hands_stalled', params: { seconds: 30 } };
  assert.equal(entryText(words, stalled, (id) => (id === 'demo-photos' ? 'Photos' : '')), 'Photos 30 秒 動きなし', 'labelOf gives the camera label');
  assert.equal(entryText(words, stalled, () => ''), 'demo-photos 30 秒 動きなし', 'falls back to the VM id');
  assert.equal(entryText(words, stalled), 'demo-photos 30 秒 動きなし');
  assert.match(clockOf(0), /^\d\d:\d\d$/);
  assert.equal(clockOf(Number.NaN), '--:--');
});

const check = (seq, code, params, vmId = VM) => ({ seq, at: 0, vmId, actor: 'bero', code, params });

test('check words: started, passed, failed, unavailable in ja and en', () => {
  const ja = fakeWords('ja');
  const label = () => 'clone-01';
  assert.equal(entryText(ja, check(1, 'check_started', { count: 1 }), label), 'clone-01 を自動で確かめている (1 件)');
  const passed = entryText(ja, check(2, 'check_done', { verdict: 'passed', checks: 1, failed: 0, detail: '' }), label);
  assert.equal(passed, 'clone-01 を自動で確かめた: 1 件中 1 件 OK (確認済)');
  const failed = check(3, 'check_done', { verdict: 'failed', checks: 2, failed: 1, detail: 'C:\\Users\\a\\Desktop\\room1.txt: differs' });
  assert.equal(entryText(ja, failed, label), 'clone-01 を確かめた: 1 件が違う (room1.txt: 中身が違う)');
  assert.equal(entryText(ja, check(4, 'check_done', { verdict: 'unavailable', checks: 1, failed: 0, detail: '' }), label), 'clone-01 は確かめられなかった');
  const en = fakeWords('en');
  assert.equal(entryText(en, failed, label), 'clone-01 checked: 1 not as expected (room1.txt: text differs)');
  assert.ok(entryText(en, check(5, 'check_done', { verdict: 'passed', checks: 3, failed: 0 }), label).includes('3 of 3 OK'));
});

test('check words: only a passed check says verified; odd verdicts count as unavailable', () => {
  for (const lang of ['en', 'ja']) {
    const d = FIGURE_WORDS[lang];
    const verified = lang === 'en' ? /verified/i : /確認済/;
    const others = Object.entries(d).filter(([key]) => key !== 'verdict_passed' && key !== 'mark_passed');
    for (const [key, text] of others) assert.doesNotMatch(text, verified, `${lang}.${key} must not call anything verified`);
    assert.match(d.verdict_passed, verified);
  }
  const words = fakeWords('ja');
  const odd = check(1, 'check_done', { verdict: 'pass', checks: 1, failed: 0 });
  assert.equal(entryText(words, odd), `${VM} は確かめられなかった`);
  assert.equal(checkMark(odd), 'unavailable');
  assert.equal(checkMark(check(2, 'check_done', {})), 'unavailable');
});

test('check detail: "path: finding" turns into the file name and the finding in words', () => {
  const words = fakeWords('ja');
  assert.equal(detailText(words, 'C:\\work\\out: missing'), 'out: ない');
  assert.equal(detailText(words, 'C:\\work\\photos\\: error'), 'photos: 読めなかった');
  assert.equal(detailText(words, 'something else'), 'something else', 'an unknown detail is shown as it came');
  assert.equal(detailText(words, 'C:\\a.txt: exploded'), 'C:\\a.txt: exploded');
  assert.equal(detailText(words, undefined), '');
});

test('check marks: pass / fail / unavailable / checking, nothing for other rows', () => {
  assert.equal(checkMark(check(1, 'check_started', { count: 2 })), 'checking');
  for (const verdict of CHECK_VERDICTS) assert.equal(checkMark(check(2, 'check_done', { verdict })), verdict);
  assert.equal(checkMark({ seq: 3, code: 'hands_ended', params: { outcome: 'claimed_done' } }), null);
  for (const lang of ['en', 'ja']) {
    const marks = ['passed', 'failed', 'unavailable', 'checking'].map((m) => FIGURE_WORDS[lang][`mark_${m}`]);
    assert.equal(new Set(marks).size, 4, `${lang}: each mark has its own words, not only a colour`);
  }
});

test('ledger rows: check_started folds into the check_done of the same VM', () => {
  let rows = [];
  rows = nextRows(rows, check(1, 'check_started', { count: 1 })).rows;
  rows = nextRows(rows, check(2, 'check_started', { count: 2 }, 'other-vm')).rows;
  rows = nextRows(rows, { seq: 3, at: 0, vmId: VM, actor: 'hands', code: 'hands_ended', params: { outcome: 'claimed_done' } }).rows;
  const done = nextRows(rows, check(4, 'check_done', { verdict: 'passed', checks: 1, failed: 0 }));
  assert.equal(done.added, 'seq:4');
  assert.equal(done.replaced, null);
  assert.deepEqual(done.rows.map((r) => r.entry.seq), [2, 3, 4], 'the started row of this VM is gone, the result is at the bottom');
  const again = nextRows(done.rows, check(5, 'check_started', { count: 1 })).rows;
  const second = nextRows(again, check(6, 'check_done', { verdict: 'failed', checks: 1, failed: 1, detail: 'C:\\x.txt: missing' })).rows;
  assert.deepEqual(second.map((r) => r.entry.seq), [2, 3, 4, 6], 'a recheck folds its own start, the first result stays');
  const lone = nextRows([], check(7, 'check_done', { verdict: 'unavailable' }));
  assert.deepEqual(lone.rows.map((r) => r.entry.seq), [7], 'a result without a start row is simply added');
});
