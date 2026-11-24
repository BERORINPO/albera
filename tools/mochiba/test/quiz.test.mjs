// Practice (説明の練習): questions made from the map, questions from a --story JSON, and the answer check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachQuestions, autoQuestions, QUIZ_LIMITS } from '../src/core/quiz.mjs';
import { validateMap } from '../src/shared/map-shape.mjs';

// ---------- a tiny map ----------
const box = (id, files) => ({ id, column: id.split(':')[0], label: id.split(':')[1], files: files.map((path) => ({ path })) });
const BOXES = [
  box('entry:app', ['js/app.js']),
  box('entry:intake', ['js/intake.js']),
  box('adapter:ai', ['js/ai.js']),
  box('core:roster', ['js/roster-core.js']),
  box('shared:roster', ['js/roster-schema.js']),
  box('outside:AI', []),
];
const edge = (id, from, to, names, more = 0, kind = 'import') => ({ id, from, to, kind, count: 1, names, more });
const EDGES = [
  edge('e0', 'entry:app', 'shared:roster', ['blank', 'S']),
  edge('e1', 'entry:intake', 'shared:roster', ['blank', 'validate']),
  edge('e2', 'core:roster', 'shared:roster', ['blank', 'validate', 'MAX']),
  edge('e3', 'adapter:ai', 'shared:roster', ['MAX', '画面で読み込む']),
  edge('e4', 'entry:intake', 'adapter:ai', ['read']),
  edge('e5', 'entry:intake', 'core:roster', ['apply']),
  edge('e6', 'adapter:ai', 'outside:AI', ['ai.js がやり取り'], 0, 'outside'),
];
const change = (pr, files) => ({ hash: 'h', short: 'h', date: 'd', subject: 's', pr, created: [], files: files.map(([path, added, deleted]) => ({ path, added, deleted, lines: added + deleted })) });
const CHANGES = [change(7, [['js/intake.js', 50, 2], ['js/roster-schema.js', 4, 2]]), change(null, [['js/app.js', 1, 1]])];
const story = (key, pr, extra = {}) => ({ key, pr, title: `#${pr}`, source: 'auto', steps: [], ...extra });

test('autoQuestions: changed boxes, a shared tool 3+ boxes use, and what the biggest changed box uses', () => {
  const changed = [BOXES[1], BOXES[4]];
  const qs = autoQuestions(changed, 7, { edges: EDGES, boxes: BOXES });
  assert.deepEqual(qs.map((q) => q.key), ['changed', 'tool:blank', 'uses:entry:intake']);
  assert.ok(qs.every((q) => q.kind === 'set' && q.source === 'auto'));
  assert.deepEqual(new Set(qs[0].boxes), new Set(['entry:intake', 'shared:roster']));
  // "blank" is used by 3 boxes, one of them changed; "validate" (2) and "MAX" (2) are not enough.
  assert.deepEqual(new Set(qs[1].boxes), new Set(['entry:app', 'entry:intake', 'core:roster']));
  assert.equal(qs[1].target, 'shared:roster');
  assert.deepEqual(qs[1].lines.map((l) => l.edge).sort(), ['e0', 'e1', 'e2']);
  assert.deepEqual(new Set(qs[2].boxes), new Set(['shared:roster', 'adapter:ai', 'core:roster']));
  // Lists name the layer, because one feature name sits in several layers.
  assert.match(qs[2].answer[0], /roster \(データの形\)/);
  assert.match(qs[0].answer[0], /intake \(入口\)/);
});

test('autoQuestions: no tool question when a cut name list could hide another user', () => {
  const edges = EDGES.map((e) => (e.id === 'e3' ? { ...e, more: 4 } : e));
  const qs = autoQuestions([BOXES[1], BOXES[4]], 7, { edges, boxes: BOXES });
  assert.ok(!qs.some((q) => q.key.startsWith('tool:')), 'adapter:ai lists only MAX but may use blank too');
});

test('autoQuestions: one changed box gives no "changed boxes" question; never more than 3', () => {
  assert.ok(!autoQuestions([BOXES[1]], 7, { edges: EDGES, boxes: BOXES }).some((q) => q.key === 'changed'));
  assert.ok(autoQuestions(BOXES.slice(0, 5), 7, { edges: EDGES, boxes: BOXES }).length <= QUIZ_LIMITS.auto);
});

const parts = { boxes: BOXES, edges: EDGES, changes: CHANGES };

test('attachQuestions: JSON questions first, then the ones from the map; path lines ride map edges', () => {
  const raw = [
    { ask: '写真はどこを通る？', path: ['entry:intake', 'adapter:ai', 'outside:AI'], says: ['read', 'ask'], side: ['shared:roster', 'core:ghost'], answer: ['a', 'b', 'c'], files: ['js/ai.js', 'nope.js'] },
    { ask: 'blank を使うのは？', set: ['entry:app', 'core:roster'] },
  ];
  const { stories, notices } = attachQuestions([story('7', 7, { source: 'file', rawQuestions: raw })], parts);
  const qs = stories[0].questions;
  assert.equal(stories[0].rawQuestions, undefined, 'raw questions are not left in the map');
  assert.deepEqual(qs.slice(0, 2).map((q) => [q.key, q.kind, q.source]), [['f:path:entry:intake>adapter:ai>outside:AI', 'path', 'file'], ['f:set:entry:app>core:roster', 'set', 'file']]);
  assert.ok(qs.slice(2).every((q) => q.source === 'auto'));
  const p = qs[0];
  assert.deepEqual(p.lines.map((l) => [l.from, l.to, l.edge, l.say]), [['entry:intake', 'adapter:ai', 'e4', 'read'], ['adapter:ai', 'outside:AI', 'e6', 'ask']]);
  assert.deepEqual(p.side, ['shared:roster']);
  assert.equal(p.answer.length, QUIZ_LIMITS.answerLines);
  assert.deepEqual(p.files, [{ path: 'js/ai.js', added: 0, deleted: 0, changed: false }]);
  assert.equal(qs[1].how, '順番は自由 ・ 答えは 2 箱');
  // nope.js is not on the map; core:ghost is not a box (the side trip is dropped, the question kept).
  assert.match(notices[0], /捨てた 2 件/);
  assert.match(notices[0], /寄り道 \(地図に無い箱: core:ghost\)/);
});

test('attachQuestions: a question naming a box the map lacks, or a box twice, is dropped whole', () => {
  const raw = [
    { ask: 'x', path: ['entry:intake', 'core:ghost'] },
    { ask: 'y', path: ['entry:intake', 'adapter:ai', 'entry:intake'] },
    { ask: 'z', set: ['entry:app'], path: ['entry:app', 'adapter:ai'] },
    { ask: 'w', path: ['entry:app'] },
    { path: ['entry:app', 'adapter:ai'] },
    { ask: 'ok', set: ['entry:app'] },
  ];
  const { stories, notices } = attachQuestions([story('file-1', null, { source: 'file', rawQuestions: raw })], parts);
  assert.deepEqual(stories[0].questions.map((q) => q.ask), ['ok']);
  assert.match(notices[0], /捨てた 5 件/);
  assert.match(notices[0], /core:ghost/);
});

test('attachQuestions: automatic stories get questions from their own PR; the no-PR story from commits outside PRs', () => {
  const { stories } = attachQuestions([story('7', 7), story('nopr', null)], parts);
  assert.deepEqual(new Set(stories[0].questions.find((q) => q.key === 'changed').boxes), new Set(['entry:intake', 'shared:roster']));
  assert.ok(!stories[1].questions.some((q) => q.key === 'changed'), 'only one box changed outside PRs');
  // entry:app uses a single box, so no 'what does it use' question either.
  assert.deepEqual(stories[1].questions, []);
});

test('attachQuestions: at most 8 questions a story', () => {
  const ids = BOXES.map((b) => b.id);
  const pairs = ids.flatMap((a) => ids.filter((b) => b !== a).map((b) => [a, b]));
  // Two broken questions first: the 8 kept are counted after the check, not before it.
  const raw = [{ ask: 'bad', set: ['core:ghost'] }, { ask: 'bad2' }, ...pairs.slice(0, 12).map((p, i) => ({ ask: `q${i}`, path: p }))];
  const { stories, notices } = attachQuestions([story('7', 7, { rawQuestions: raw })], parts);
  assert.equal(stories[0].questions.length, QUIZ_LIMITS.perStory);
  assert.deepEqual(stories[0].questions.map((q) => q.ask), ['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7']);
  assert.ok(notices.some((n) => /問いは 12 個あり、最初の 8 個だけ使った/.test(n)));
});

test('attachQuestions: says keep their positions; the same answer twice keeps the first question', () => {
  const raw = [
    { ask: 'a', path: ['entry:intake', 'adapter:ai', 'outside:AI'], says: ['', 'second gap'] },
    { ask: 'b', path: ['entry:intake', 'adapter:ai', 'outside:AI'], says: [null, 'x'] },
  ];
  const { stories, notices } = attachQuestions([story('7', 7, { rawQuestions: raw })], parts);
  const fileQs = stories[0].questions.filter((q) => q.source === 'file');
  assert.deepEqual(fileQs.map((q) => q.ask), ['a']);
  assert.deepEqual(fileQs[0].lines.map((l) => l.say), ['', 'second gap']);
  assert.match(notices[0], /同じ答えの問いが前にある/);
});

test('autoQuestions: a line that does not say what it takes (namespace import, global place) makes the tool uncertain', () => {
  for (const loose of [{ more: 0, partial: true }, { more: 2, partial: false }]) {
    const edges = EDGES.map((e) => (e.id === 'e3' ? { ...e, ...loose } : e));
    const qs = autoQuestions([BOXES[1], BOXES[4]], 7, { edges, boxes: BOXES });
    assert.ok(!qs.some((q) => q.key.startsWith('tool:')), JSON.stringify(loose));
  }
});

// ---------- the answer check (src/entry/page/grade.js, the same code the page runs) ----------
const gradeSrc = readFileSync(fileURLToPath(new URL('../src/entry/page/grade.js', import.meta.url)), 'utf8');
const { gradePicks } = new Function(`${gradeSrc}\nreturn { gradePicks };`)();
const obj = (m) => Object.fromEntries(m);

test('gradePicks: a path counts the picks that follow the answer order', () => {
  const q = { kind: 'path', boxes: ['a', 'b', 'c', 'd'], side: ['s'] };
  assert.deepEqual(obj(gradePicks(q, ['a', 'b', 'c', 'd'])), { a: 'ok', b: 'ok', c: 'ok', d: 'ok' });
  const swapped = obj(gradePicks(q, ['a', 'c', 'b', 'd']));
  assert.deepEqual([swapped.a, swapped.d], ['ok', 'ok']);
  assert.deepEqual([swapped.b, swapped.c].sort(), ['ok', 'order'], 'one of the swapped pair is out of order');
  assert.deepEqual(obj(gradePicks(q, ['a', 's', 'x', 'd'])), { a: 'ok', s: 'side', x: 'off', d: 'ok', b: 'miss', c: 'miss' });
  assert.deepEqual(obj(gradePicks(q, [])), { a: 'miss', b: 'miss', c: 'miss', d: 'miss' });
  const reversed = Object.values(obj(gradePicks(q, ['d', 'c', 'b', 'a']))).sort();
  assert.deepEqual(reversed, ['ok', 'order', 'order', 'order'], 'backwards: only one box can be in order');
});

test('gradePicks: a set ignores the order', () => {
  const q = { kind: 'set', boxes: ['a', 'b'], side: [] };
  assert.deepEqual(obj(gradePicks(q, ['b', 'a'])), { b: 'ok', a: 'ok' });
  assert.deepEqual(obj(gradePicks(q, ['b', 'z'])), { b: 'ok', z: 'off', a: 'miss' });
});

// ---------- the validator guards the page ----------
test('validateMap refuses questions that point outside the map', () => {
  const { stories } = attachQuestions([story('7', 7)], parts);
  const map = (s) => ({ version: 1, title: 't', root: '/r', since: 'x', generatedAt: 'x', boxes: BOXES.map((b) => ({ ...b, x: 0, y: 0, w: 1, h: 1, lines: 0, status: null })),
    edges: EDGES, changes: [], notices: [], today: [], prs: {}, stories: s });
  const good = stories.map((s) => ({ ...s, steps: [{ kind: 'overview', title: 't', say: 's', boxes: ['entry:app'], lead: null, lines: [], names: [], files: [], note: null }] }));
  assert.deepEqual(validateMap(map(good)), []);
  const q = good[0].questions[0];
  const broken = (patch) => [{ ...good[0], questions: [{ ...q, ...patch }] }];
  assert.ok(validateMap(map(broken({ boxes: ['core:ghost'] }))).some((e) => /answer boxes/.test(e)));
  assert.ok(validateMap(map(broken({ boxes: ['entry:app', 'entry:app'] }))).some((e) => /answer boxes/.test(e)));
  assert.ok(validateMap(map(broken({ kind: 'path', boxes: ['entry:app'] }))).some((e) => /path needs 2/.test(e)));
  assert.ok(validateMap(map(broken({ target: 'core:ghost' }))).some((e) => /target/.test(e)));
  assert.ok(validateMap(map(broken({ lines: [{ from: 'entry:app', to: 'core:ghost', say: '', edge: null, back: false }] }))).some((e) => /bad line/.test(e)));
  assert.ok(validateMap(map([{ ...good[0], questions: [q, q] }])).some((e) => /duplicate key/.test(e)));
  assert.ok(validateMap(map([{ ...good[0], questions: undefined }])).some((e) => /questions must be an array/.test(e)));
});
