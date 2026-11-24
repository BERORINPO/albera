// Story mode (紙芝居): automatic stories, the --story JSON check, and the CLI option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoStories, lineOnMap, mergeStoryFile, safeRelPath, STORY_LIMITS } from '../src/core/story.mjs';
import { InputError, validateMap } from '../src/shared/map-shape.mjs';
import { run } from '../src/entry/cli.mjs';
import { assemblePage, PAGE_SCRIPTS, TEMPLATE_PATH } from '../src/entry/render.mjs';
import { createFakeFsRepo } from '../src/adapter/fake-fs-repo.mjs';
import { createFakeGit } from '../src/adapter/fake-git.mjs';
import { createFakeGh } from '../src/adapter/fake-gh.mjs';
import { CWD, LOG_TEXT, PR_12, ROOT, repoFiles } from './fixture.mjs';

// ---------- a tiny map: entry:app -> core:roster -> shared:roster, adapter:ai -> outside:AI ----------
const box = (id, files) => ({ id, column: id.split(':')[0], label: id.split(':')[1], files: files.map((path) => ({ path })) });
const BOXES = [
  box('entry:app', ['js/app.js', 'js/intake.js']),
  box('adapter:ai', ['js/ai.js']),
  box('core:roster', ['js/roster-core.js']),
  box('shared:roster', ['js/roster-schema.js']),
  box('outside:AI', []),
];
const EDGES = [
  { id: 'e0', from: 'entry:app', to: 'core:roster', kind: 'import', count: 2, names: ['readRoster', 'saveRoster'], more: 0 },
  { id: 'e1', from: 'core:roster', to: 'shared:roster', kind: 'import', count: 1, names: ['S'], more: 0 },
  { id: 'e2', from: 'adapter:ai', to: 'outside:AI', kind: 'outside', count: 1, names: ['ai.js がやり取り'], more: 0 },
  { id: 'e3', from: 'entry:app', to: 'adapter:ai', kind: 'import', count: 1, names: ['read'], more: 0 },
];
const change = (pr, subject, files, created = []) => ({ hash: subject, short: subject.slice(0, 7), date: '2026-11-20T10:00:00+09:00', subject, pr, created,
  files: files.map(([path, added, deleted]) => ({ path, added, deleted, lines: added + deleted })) });
const CHANGES = [
  change(null, 'chore: tweak app', [['js/app.js', 1, 1]]),
  change(7, 'feat: read photos', [['js/intake.js', 60, 2], ['js/roster-core.js', 9, 4], ['js/ai.js', 3, 0]], ['js/intake.js']),
  change(7, 'fix: schema', [['js/roster-schema.js', 4, 2], ['test/x.test.mjs', 5, 0]]),
];
const PRS = { 7: { number: 7, title: 'Read photos', reason: 'Staff type less.', url: 'https://github.com/me/demo/pull/7', ci: { state: 'pass', text: 'CI 通過 2 / 2' } } };

test('autoStories: one story per PR, newest first, the no-PR commits last', () => {
  const stories = autoStories({ boxes: BOXES, edges: EDGES, changes: CHANGES, prs: PRS });
  assert.deepEqual(stories.map((s) => s.key), ['7', 'nopr']);
  assert.equal(stories[0].title, '#7 Read photos');
  assert.equal(stories[1].title, 'PR なしの変更');
  assert.ok(stories.every((s) => s.source === 'auto'));
});

test('autoStories: overview, then the changed boxes from entry to shared, then the evidence', () => {
  const [s] = autoStories({ boxes: BOXES, edges: EDGES, changes: CHANGES, prs: PRS });
  assert.deepEqual(s.steps.map((t) => t.kind), ['overview', 'box', 'box', 'box', 'box', 'evidence']);
  assert.deepEqual(s.steps.slice(1, 5).map((t) => t.lead), ['entry:app', 'adapter:ai', 'core:roster', 'shared:roster']);
  assert.deepEqual(new Set(s.steps[0].boxes), new Set(['entry:app', 'adapter:ai', 'core:roster', 'shared:roster']));
  // Files outside the map (test/) are not shown.
  assert.ok(s.steps[0].files.every((f) => f.path.startsWith('js/')));
  const entry = s.steps[1];
  assert.match(entry.say, /入口の「app」で 1 ファイル変わった \(うち新しいファイル 1\) \+60 −2/);
  assert.deepEqual(entry.lines.map((l) => l.edge).sort(), ['e0', 'e3']);
  assert.equal(entry.lines.find((l) => l.edge === 'e0').say, 'readRoster・saveRoster');
  assert.match(entry.note, /feat: read photos/);
  const adapter = s.steps[2];
  assert.ok(adapter.boxes.includes('outside:AI'), 'an adapter step shows its outside partner');
  const evidence = s.steps[5];
  assert.equal(evidence.say, '理由: Staff type less.');
  assert.equal(evidence.note, 'CI 通過 2 / 2');
});

test('autoStories: no evidence scene when the PR text could not be read; boxes past the limit are named', () => {
  const many = Array.from({ length: STORY_LIMITS.boxSteps + 2 }, (_, i) => box(`core:b${i}`, [`js/b${i}.js`]));
  const changes = [change(3, 'big', many.map((b, i) => [`js/b${i}.js`, i + 1, 0]))];
  const [s] = autoStories({ boxes: many, edges: [], changes, prs: { 3: { number: 3, missing: true, reason: 'gh 無し' } } });
  assert.equal(s.title, '#3');
  assert.equal(s.steps.filter((t) => t.kind === 'box').length, STORY_LIMITS.boxSteps);
  assert.ok(!s.steps.some((t) => t.kind === 'evidence'));
  assert.match(s.steps[0].note, /ほか 2 箱/);
  // The biggest boxes are kept.
  assert.ok(!s.steps.some((t) => t.lead === 'core:b0'));
});

test('lineOnMap: same direction, the reverse edge with the light running back, or no edge', () => {
  assert.deepEqual(lineOnMap(EDGES, 'entry:app', 'core:roster'), { edge: 'e0', back: false });
  assert.deepEqual(lineOnMap(EDGES, 'core:roster', 'entry:app'), { edge: 'e0', back: true });
  assert.deepEqual(lineOnMap(EDGES, 'adapter:ai', 'shared:roster'), { edge: null, back: false });
});

test('safeRelPath keeps the page inside the folder', () => {
  assert.equal(safeRelPath('js\\app.js'), 'js/app.js');
  assert.equal(safeRelPath('./js//app.js'), 'js/app.js');
  for (const bad of ['../x.js', 'js/../../x.js', '/etc/passwd', 'C:/x.js', 'c:x', 'javascript:alert(1)', 'a\u0000b', '', 7]) assert.equal(safeRelPath(bad), null, String(bad));
});

const auto = () => autoStories({ boxes: BOXES, edges: EDGES, changes: CHANGES, prs: PRS });
const parts = { boxes: BOXES, edges: EDGES, changes: CHANGES };

test('mergeStoryFile: a story for a PR replaces its automatic one; one without a PR comes first', () => {
  const raw = { stories: [
    { pr: 7, title: 'Photos', steps: [{ title: '撮る', say: '店の人が書類を撮る', boxes: ['entry:app'], lead: 'entry:app' }] },
    { title: 'Tour', steps: [{ say: '全体', boxes: ['core:roster'] }] },
  ] };
  const { stories, notices } = mergeStoryFile(raw, parts, auto());
  assert.deepEqual(stories.map((s) => [s.key, s.source]), [['7', 'file'], ['file-2', 'file'], ['nopr', 'auto']]);
  assert.equal(stories[0].title, '#7 Photos');
  assert.equal(stories[1].steps[0].title, '全体');
  assert.deepEqual(notices, []);
});

test('mergeStoryFile: lines ride the map edges, run back on a reverse edge, or are drawn dashed', () => {
  const raw = { pr: 7, steps: [{ say: 's', boxes: ['entry:app'], lines: [
    { from: 'entry:app', to: 'core:roster', say: '名簿を渡す' },
    { from: 'shared:roster', to: 'core:roster', say: '形' },
    { from: 'adapter:ai', to: 'shared:roster', say: '地図に無い' },
  ] }] };
  const [s] = mergeStoryFile(raw, parts, []).stories;
  assert.deepEqual(s.steps[0].lines.map((l) => [l.edge, l.back]), [['e0', false], ['e1', true], [null, false]]);
  // Boxes a line touches are lit even when the step did not list them.
  assert.deepEqual(new Set(s.steps[0].boxes), new Set(['entry:app', 'core:roster', 'shared:roster', 'adapter:ai']));
});

test('mergeStoryFile: parts that do not fit the map are dropped and named, the rest is kept', () => {
  const raw = { pr: 7, steps: [
    { say: 'ok', boxes: ['entry:app', 'entry:nope'], lead: 'entry:nope', files: ['js/app.js', '../secret', 'C:/x', 'node_modules/x.js', '.git/config', 'js/app.js'], lines: [{ from: 'entry:app', to: 'entry:ghost' }] },
    { say: 'no boxes', boxes: ['core:ghost'] },
    { boxes: ['entry:app'] },
  ] };
  const { stories, notices } = mergeStoryFile(raw, parts, auto());
  const s = stories.find((x) => x.key === '7');
  assert.equal(s.steps.length, 1);
  assert.deepEqual(s.steps[0].boxes, ['entry:app']);
  assert.equal(s.steps[0].lead, null);
  // Only a file on the map is kept, once. PR 7 did not touch js/app.js (only the no-PR commit did).
  assert.deepEqual(s.steps[0].files, [{ path: 'js/app.js', added: 0, deleted: 0, changed: false }]);
  assert.equal(notices.length, 2);
  assert.match(notices[0], /地図に無い箱 2 個/);
  assert.match(notices[1], /飛ばした 7 件/);
});

test('mergeStoryFile: file badges count only the story PR\'s commits; a story without a PR counts the period', () => {
  const step = { say: 's', boxes: ['entry:app'], files: ['js/intake.js', 'js/app.js'] };
  const { stories } = mergeStoryFile({ stories: [{ pr: 7, steps: [step] }, { steps: [step] }] }, parts, []);
  assert.deepEqual(stories[0].steps[0].files.map((f) => [f.path, f.added, f.deleted, f.changed]), [['js/intake.js', 60, 2, true], ['js/app.js', 0, 0, false]]);
  assert.deepEqual(stories[1].steps[0].files.map((f) => [f.path, f.added, f.deleted, f.changed]), [['js/intake.js', 60, 2, true], ['js/app.js', 1, 1, true]]);
});

test('mergeStoryFile: a lead left out of boxes is lit; "#7" and "7" read as PR 7; other pr values are named', () => {
  const { stories, notices } = mergeStoryFile({ stories: [
    { pr: '#7', steps: [{ say: 's', boxes: ['adapter:ai'], lead: 'entry:app' }] },
    { pr: 'seven', steps: [{ say: 's', boxes: ['adapter:ai'] }] },
  ] }, parts, auto());
  assert.equal(stories[0].key, '7');
  assert.deepEqual(stories[0].steps[0].boxes, ['adapter:ai', 'entry:app']);
  assert.equal(stories[0].steps[0].lead, 'entry:app');
  assert.equal(stories[1].pr, null);
  assert.ok(notices.some((n) => /seven/.test(n) && /PR 番号として読めない/.test(n)));
  assert.equal(mergeStoryFile({ pr: '7', steps: [{ say: 's', boxes: ['adapter:ai'] }] }, parts, []).stories[0].pr, 7);
});

test('mergeStoryFile: a second story for the same PR is named in the notices', () => {
  const one = { say: 's', boxes: ['entry:app'] };
  const { stories, notices } = mergeStoryFile({ stories: [{ pr: 7, title: 'a', steps: [one] }, { pr: 7, title: 'b', steps: [one, one] }] }, parts, []);
  assert.deepEqual(stories.map((s) => s.title), ['#7 a']);
  assert.ok(notices.some((n) => /#7 が 2 本以上/.test(n)));
});

test('mergeStoryFile: long text and long lists are cut to the limits', () => {
  const step = { say: 'あ'.repeat(500), title: 'い'.repeat(100), boxes: ['entry:app'], names: Array.from({ length: 40 }, (_, i) => `n${i}`), note: 'う'.repeat(500) };
  const raw = { pr: 9, steps: Array.from({ length: STORY_LIMITS.steps + 5 }, () => step) };
  const { stories, notices } = mergeStoryFile(raw, parts, []);
  const s = stories[0];
  assert.equal(s.steps.length, STORY_LIMITS.steps);
  assert.equal(s.steps[0].say.length, STORY_LIMITS.say);
  assert.equal(s.steps[0].title.length, STORY_LIMITS.title);
  assert.equal(s.steps[0].note.length, STORY_LIMITS.note);
  assert.equal(s.steps[0].names.length, STORY_LIMITS.names);
  assert.match(notices[0], /最初の 30 コマ/);
});

test('mergeStoryFile: a wrong overall shape is an input error with the shape to use', () => {
  for (const bad of [[], 'x', { steps: [] }, { stories: [] }, { stories: [{ title: 'no steps' }] }, { pr: 1 }]) {
    assert.throws(() => mergeStoryFile(bad, parts, []), (err) => err instanceof InputError && /steps/.test(err.message), JSON.stringify(bad));
  }
  assert.deepEqual(mergeStoryFile(null, parts, ['a']), { stories: ['a'], notices: [] });
});

test('mergeStoryFile: a story whose every scene was dropped is skipped with a notice', () => {
  const { stories, notices } = mergeStoryFile({ pr: 7, steps: [{ say: 'x', boxes: ['core:ghost'] }] }, parts, auto());
  assert.equal(stories.find((s) => s.key === '7').source, 'auto');
  assert.ok(notices.some((n) => /使えるコマが無い/.test(n)));
});

// ---------- the map validator guards the page ----------
const baseMap = (stories) => ({ version: 1, title: 't', root: '/r', since: '2026-11-01', generatedAt: 'x', boxes: BOXES.map((b) => ({ ...b, x: 0, y: 0, w: 1, h: 1, lines: 0, status: null })),
  edges: EDGES, changes: [], notices: [], today: [], prs: {}, stories });

test('validateMap refuses stories that point outside the map', () => {
  const good = auto().map((s) => ({ ...s, questions: [] }));
  assert.deepEqual(validateMap(baseMap(good)), []);
  const step = good[0].steps[1];
  const broken = (patch) => [{ ...good[0], steps: [{ ...step, ...patch }] }];
  assert.ok(validateMap(baseMap(broken({ boxes: ['core:ghost'] }))).some((e) => /missing box/.test(e)));
  assert.ok(validateMap(baseMap(broken({ lead: 'core:ghost' }))).some((e) => /lead/.test(e)));
  assert.ok(validateMap(baseMap(broken({ lines: [{ from: 'entry:app', to: 'core:roster', say: '', edge: 'e99', back: false }] }))).some((e) => /bad line/.test(e)));
  assert.ok(validateMap(baseMap(broken({ files: [{ path: '../x' }] }))).some((e) => /bad file/.test(e)));
  assert.ok(validateMap(baseMap([good[0], good[0]])).some((e) => /duplicate story/.test(e)));
  assert.ok(validateMap(baseMap(undefined)).some((e) => /stories must be an array/.test(e)));
});

// ---------- CLI ----------
const TEMPLATE = assemblePage(readFileSync(TEMPLATE_PATH, 'utf8'), PAGE_SCRIPTS.map((p) => readFileSync(p, 'utf8')));
const NOW = new Date(2026, 10, 24, 9, 30, 0);
function cli(extra = {}) {
  const out = { logs: [], errors: [] };
  const deps = {
    fs: createFakeFsRepo(repoFiles(extra)),
    git: createFakeGit({ logText: LOG_TEXT, lastCommit: { hash: 'a', date: '2026-11-20T10:00:00+09:00', subject: 'x' } }),
    gh: createFakeGh({ prs: { 12: PR_12 } }),
    cwd: CWD, now: NOW, template: TEMPLATE, log: (m) => out.logs.push(m), error: (m) => out.errors.push(m),
  };
  return { deps, out };
}
const mapOf = (deps) => {
  const html = deps.fs.writes.get(join(CWD, 'o.html').replace(/\\/g, '/'));
  return JSON.parse(html.match(/<script type="application\/json" id="map-data">([\s\S]*?)<\/script>/)[1]);
};

test('cli: without --story the map carries the automatic stories', async () => {
  const { deps, out } = cli();
  assert.equal(await run(['map', ROOT, '--since', '10', '--out', 'o.html'], deps), 0, out.errors.join('\n'));
  const map = mapOf(deps);
  assert.deepEqual(map.stories.map((s) => s.key), ['12', 'nopr']);
  assert.match(out.logs[1], /紙芝居 2/);
});

test('cli: --story replaces the PR story; a BOM is fine; notices reach the map', async () => {
  const file = join(CWD, 'story.json');
  const story = { pr: 12, title: '日の表', steps: [{ say: '今日の名簿を出す', boxes: ['core:roster', 'core:nope'] }] };
  const { deps, out } = cli({ [file]: `\uFEFF${JSON.stringify(story)}` });
  assert.equal(await run(['map', ROOT, '--since', '10', '--story', 'story.json', '--out', 'o.html'], deps), 0, out.errors.join('\n'));
  const map = mapOf(deps);
  assert.equal(map.stories[0].source, 'file');
  assert.equal(map.stories[0].title, '#12 日の表');
  assert.ok(map.notices.some((n) => /core:nope/.test(n)));
});

test('cli: --story questions reach the map; a question with a box the map lacks is dropped and named', async () => {
  const file = join(CWD, 'q.json');
  const story = { pr: 12, steps: [{ say: 's', boxes: ['core:roster'] }], questions: [
    { ask: '道は？', path: ['entry:app', 'core:roster', 'shared:roster'], says: ['a', 'b'], answer: ['x'] },
    { ask: '壊れた', set: ['core:nope'] },
  ] };
  const { deps, out } = cli({ [file]: JSON.stringify(story) });
  assert.equal(await run(['map', ROOT, '--since', '10', '--story', 'q.json', '--out', 'o.html'], deps), 0, out.errors.join('\n'));
  const map = mapOf(deps);
  const q = map.stories[0].questions[0];
  assert.deepEqual([q.source, q.kind, q.boxes.length], ['file', 'path', 3]);
  assert.ok(map.notices.some((n) => /問いの一部を捨てた 1 件/.test(n) && /core:nope/.test(n)));
});

test('cli: a missing or unreadable --story is exit 1 with one line', async () => {
  const missing = cli();
  assert.equal(await run(['map', ROOT, '--story', 'none.json', '--out', 'o.html'], missing.deps), 1);
  assert.match(missing.out.errors[0], /--story のファイルが無い/);
  const broken = cli({ [join(CWD, 's.json')]: '{ nope' });
  assert.equal(await run(['map', ROOT, '--story', 's.json', '--out', 'o.html'], broken.deps), 1);
  assert.match(broken.out.errors[0], /--story の JSON が読めない/);
  const shape = cli({ [join(CWD, 's.json')]: '{"title":"x"}' });
  assert.equal(await run(['map', ROOT, '--story', 's.json', '--out', 'o.html'], shape.deps), 1);
  assert.match(shape.out.errors[0], /--story の JSON の形が違う/);
  assert.equal(shape.deps.fs.writes.size, 0);
});

test('page: the story scripts are in the one HTML and draw with DOM APIs only', () => {
  assert.match(TEMPLATE, /function openStory\(/);
  assert.match(TEMPLATE, /function storyPrompt\(/);
  assert.match(TEMPLATE, /function gradePicks\(/);
  assert.match(TEMPLATE, /function openQuiz\(/);
  assert.match(TEMPLATE, /id="qcard"/);
  assert.doesNotMatch(TEMPLATE, /\/\*MOCHIBA_PAGE_JS\*\//);
  assert.throws(() => assemblePage('<script>/*MOCHIBA_PAGE_JS*/</script>', ['x = "</script>"']), /must not contain/);
});
