// Unit tests for src/core (pure functions, fixtures only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputError, validateMap } from '../src/shared/map-shape.mjs';
import { firstFileIn, isUnsafePath, parseArchitecture, tableAfter } from '../src/core/arch-tables.mjs';
import { buildBoxes, groupOf, normaliseLabels, outsideName } from '../src/core/grouping.mjs';
import { countImportEdges, findSpecifiers, normalisePath, resolveSpecifier } from '../src/core/imports.mjs';
import { assignPrs, minusDays, parseGitLog, prNumberOf, resolveSince } from '../src/core/git-log.mjs';
import { ciOf, reasonOf, summarisePr } from '../src/core/pr-info.mjs';
import { GEOMETRY, layout } from '../src/core/layout.mjs';
import { buildMap, collectChanges, collectPrs, mappedFiles } from '../src/core/build-map.mjs';
import { ARCH_MD, LOG_TEXT, PR_12, SOURCES } from './fixture.mjs';

// ---------- arch tables ----------
test('parseArchitecture reads both tables', () => {
  const arch = parseArchitecture(ARCH_MD);
  assert.deepEqual(arch.roles.shared, ['js/roster-schema.js']);
  assert.equal(arch.roles.entry.length, 5);
  assert.deepEqual(arch.boundaries.map((b) => b.file), ['worker/anthropic.mjs', 'worker/roster-db.mjs', 'worker/index.mjs']);
});

test('parseArchitecture without the role table is an input error', () => {
  assert.throws(() => parseArchitecture('# x\n\n## 2. 外部境界表\n| a | b |\n|---|---|\n'), (err) => err instanceof InputError && /役割対応表 が無い/.test(err.message));
  assert.throws(() => parseArchitecture('## 役割対応表\n| 役割 | パス |\n|---|---|\n| other | x.js |\n'), InputError);
});

test('tableAfter stops at the next heading and ignores the separator row', () => {
  assert.equal(tableAfter('## 役割対応表\ntext\n## next\n| a | b |\n|---|---|\n| c | d |', '役割対応表'), null);
  assert.deepEqual(tableAfter('## t\n| a | b |\n|---|---|\n| c | d |', 't'), [['c', 'd']]);
});

test('firstFileIn takes the first .mjs/.js/.html path, ignoring backticks and json', () => {
  assert.equal(firstFileIn('Email Routing → worker/index.mjs の `email()`'), 'worker/index.mjs');
  assert.equal(firstFileIn('`POST /api/v1/bookings` → shop-api（worker/public-handler.mjs の intake）'), 'worker/public-handler.mjs');
  assert.equal(firstFileIn('worker/backup.mjs（KV `BACKUP`）'), 'worker/backup.mjs');
  assert.equal(firstFileIn('wrangler.jsonc only'), null);
});

// ---------- grouping ----------
test('groupOf uses the first word of the file name', () => {
  assert.equal(groupOf('js/roster-core.js'), 'roster');
  assert.equal(groupOf('js/reply-page.js'), 'reply');
  assert.equal(groupOf('index.html'), 'index');
  assert.equal(groupOf('worker/ask.mjs'), 'ask');
});

test('outsideName shortens the partner cell', () => {
  assert.equal(outsideName('同じ場所の Worker `/api/read`・`/api/guest-ai`（お客さま画面の AI）→ Claude API（Haiku）'), 'Claude API');
  assert.equal(outsideName('Cloudflare D1（`DB`、表 daily_counts）'), 'Cloudflare D1');
  assert.equal(outsideName('shop-api の `/api/ask` と `/api/walkin`'), 'shop-api');
  assert.equal(outsideName('`inbox@example.com` に届いた予約メール（Email Routing の rule → お店の Worker）'), 'inbox@example.com に届いた予約メール');
  assert.equal(outsideName('`* * * * *`（wrangler.jsonc）'), '* * * * *');
});

test('normaliseLabels rejects bad shapes', () => {
  assert.deepEqual(normaliseLabels(null), { groups: Object.create(null), outside: Object.create(null) });
  assert.throws(() => normaliseLabels([]), InputError);
  assert.throws(() => normaliseLabels({ groups: { a: 3 } }), InputError);
  assert.throws(() => normaliseLabels({ outside: 'x' }), InputError);
});

test('buildBoxes groups by role x label and merges groups that share a label', () => {
  const arch = parseArchitecture(ARCH_MD);
  const plain = buildBoxes(arch.roles, arch.boundaries, normaliseLabels(null));
  assert.ok(plain.boxes.find((b) => b.id === 'core:roster').files.includes('js/roster-day.js'));
  assert.ok(plain.boxes.some((b) => b.id === 'core:ask'));
  assert.equal(plain.boxes.find((b) => b.id === 'entry:index').files.length, 2); // index.html + worker/index.mjs
  assert.deepEqual(plain.outsideEdges.map((e) => `${e.from}>${e.to}`).sort(), ['adapter:anthropic>outside:Claude API', 'adapter:roster>outside:Cloudflare D1', 'entry:index>outside:* * * * *']);

  const merged = buildBoxes(arch.roles, arch.boundaries, normaliseLabels({ groups: { roster: '名簿', ask: '名簿' }, outside: { Cron: '毎分の時計', 'Cloudflare D1': 'データベース' } }));
  const core = merged.boxes.filter((b) => b.column === 'core');
  assert.deepEqual(core.map((b) => b.label), ['名簿']);
  assert.deepEqual(core[0].groups, ['roster', 'ask']);
  assert.ok(merged.boxes.some((b) => b.id === 'outside:毎分の時計'), 'label key found in the adapter cell');
  assert.ok(merged.boxes.some((b) => b.id === 'outside:データベース'));
});

test('buildBoxes notes boundary files missing from table 1', () => {
  const out = buildBoxes({ entry: ['a.js'], core: [], adapter: [], shared: [] }, [{ file: 'b.mjs', partnerCell: 'X', adapterCell: 'b.mjs' }], normaliseLabels(null));
  assert.equal(out.outsideEdges.length, 0);
  assert.match(out.notices[0], /b\.mjs/);
});

// ---------- imports ----------
test('findSpecifiers sees import, export from, dynamic import, require and script src', () => {
  const js = "import a from './a.js';\nimport {\n b,\n c } from \"../b.mjs\";\nimport './side.js';\nexport * from './x.js';\nconst m = await import('./lazy.js');\nconst r = require('./r.js');";
  assert.deepEqual(findSpecifiers(js, 'js/f.js').map((s) => s.spec).sort(), ['../b.mjs', './a.js', './lazy.js', './r.js', './side.js', './x.js']);
  assert.deepEqual(findSpecifiers('<script type="module" src="js/app.js?v=2"></script>', 'index.html').map((s) => s.spec), ['js/app.js?v=2']);
});

test('resolveSpecifier only resolves relative paths', () => {
  assert.equal(resolveSpecifier('js/app.js', './roster-core.js', false), 'js/roster-core.js');
  assert.equal(resolveSpecifier('worker/ask.mjs', '../js/x.js', false), 'js/x.js');
  assert.equal(resolveSpecifier('index.html', 'js/app.js?v=1', true), 'js/app.js');
  assert.equal(resolveSpecifier('js/app.js', 'some-package', false), null);
  assert.equal(resolveSpecifier('index.html', 'https://cdn.example/x.js', true), null);
  assert.equal(resolveSpecifier('index.html', '/abs.js', true), null);
  assert.equal(normalisePath('../../x'), null);
});

test('countImportEdges sums imports between different boxes', () => {
  const arch = parseArchitecture(ARCH_MD);
  const { fileToBox } = buildBoxes(arch.roles, arch.boundaries, normaliseLabels(null));
  const edges = countImportEdges(new Map(Object.entries(SOURCES)), fileToBox);
  const key = (e) => `${e.from}>${e.to}:${e.count}`;
  assert.deepEqual(edges.map(key).sort(), [
    'adapter:roster>shared:roster:1',
    'core:ask>core:roster:1',
    'core:roster>shared:roster:1',
    'entry:app>core:roster:2',
    'entry:ask>adapter:anthropic:1',
    'entry:ask>core:ask:1',
    'entry:index>entry:app:1',
    'entry:index>entry:ask:1',
    'entry:index>shared:roster:1',
  ]);
});

test('namespaces: found from how the code makes or aliases them, under any name', async () => {
  const { namespaces, globalUses } = await import('../src/core/imports.mjs');
  const made = new Map([
    ['a.js', 'window.SHOP = window.SHOP || {}; SHOP.cart = {};'],
    ['b.js', 'self.Tools = { x: 1 };'],
    ['c.js', 'const S = globalThis.STORE;'],
    ['d.js', 'const f = globalThis.fetch; const lower = globalThis.myThing;'],
  ]);
  assert.deepEqual([...namespaces(made)].sort(), ['SHOP', 'STORE', 'Tools']);
  assert.deepEqual(globalUses(new Map([['a.js', 'const R = globalThis.X; R.y = 1;']])), [], 'no namespace without a maker or an ALL-CAPS alias');
  // An alias reaches the namespace only in the file that declares it.
  const sources = new Map([
    ['own.js', 'globalThis.APP = globalThis.APP || {}; APP.cart = { add() {} };'],
    ['alias.js', 'const A = globalThis.APP; A.cart.add();'],
    ['bare.js', 'window.APP.cart.add(); APP.cart.size;'],
    ['stray.js', 'A.cart.remove();'],
  ]);
  const by = Object.fromEntries(globalUses(sources).map((u) => [u.user, u.names]));
  assert.deepEqual(by, { 'alias.js': ['add'], 'bare.js': ['add', 'size'] });
});

test('countImportEdges marks lines whose names may not list everything taken (partial)', async () => {
  const { countImportEdges: count } = await import('../src/core/imports.mjs');
  const fileToBox = new Map([['a.js', 'core:a'], ['b.js', 'core:b'], ['c.js', 'core:c'], ['s.js', 'shared:s'], ['g.js', 'shared:g']]);
  const sources = new Map([
    ['s.js', 'export const blank = 1;'],
    ['g.js', 'const R = globalThis.APP; R.roster = {};'],
    ['a.js', "import { blank } from './s.js';\nconst R = globalThis.APP; R.roster.fromModel();"],
    ['b.js', "import * as S from './s.js'; S.blank;\nconst R = globalThis.APP; const T = R.roster; T.x;"],
    ['c.js', "import('./s.js');"],
  ]);
  const by = Object.fromEntries(count(sources, fileToBox).map((e) => [`${e.from}>${e.to}`, e.partial]));
  assert.deepEqual(by, { 'core:a>shared:s': false, 'core:a>shared:g': false, 'core:b>shared:s': true, 'core:b>shared:g': true, 'core:c>shared:s': true });
});

// ---------- git log ----------
test('parseGitLog reads numstat, binary files and created files', () => {
  const commits = parseGitLog(LOG_TEXT);
  assert.equal(commits.length, 5);
  assert.deepEqual(commits[1].parents.length, 2);
  assert.deepEqual(commits[2].created, ['js/roster-day.js']);
  assert.deepEqual(commits[3].files.find((f) => f.path === 'img/logo.png'), { path: 'img/logo.png', added: 0, deleted: 0 });
});

test('prNumberOf reads merge and squash subjects', () => {
  assert.equal(prNumberOf('Merge pull request #183 from a/b', true), 183);
  assert.equal(prNumberOf('feat: thing (#42)', false), 42);
  assert.equal(prNumberOf('feat: fix #42 later', false), null);
});

test('assignPrs gives branch commits the PR of their merge', () => {
  const prOf = assignPrs(parseGitLog(LOG_TEXT));
  const h = (c) => c.repeat(40);
  assert.equal(prOf.get(h('3')), 12);
  assert.equal(prOf.get(h('2')), 12);
  assert.equal(prOf.get(h('4')), 12);
  assert.equal(prOf.get(h('1')), 11);
  assert.equal(prOf.has(h('5')), false);
});

test('resolveSince: default, days, date, bad input', () => {
  assert.equal(minusDays('2026-03-01', 1), '2026-02-28');
  assert.equal(resolveSince(undefined, '2026-11-24', '2026-11-16T20:44:56+09:00'), '2026-11-15');
  assert.equal(resolveSince(undefined, '2026-11-24', null), '2026-11-23');
  assert.equal(resolveSince('10', '2026-11-24', null), '2026-11-14');
  assert.equal(resolveSince('2026-11-01', '2026-11-24', null), '2026-11-01');
  assert.throws(() => resolveSince('2026-02-30', '2026-11-24', null), InputError);
  assert.throws(() => resolveSince('last week', '2026-11-24', null), InputError);
});

// ---------- PR info ----------
test('reasonOf keeps the first prose paragraph', () => {
  assert.equal(reasonOf(PR_12.body), 'Staff could not see today at a glance. This adds the day view.');
  assert.equal(reasonOf(''), '');
  assert.ok(reasonOf('x'.repeat(500)).length <= 280);
});

test('ciOf summarises checks', () => {
  assert.equal(ciOf([]).state, 'none');
  assert.equal(ciOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]).state, 'pass');
  assert.equal(ciOf([{ status: 'IN_PROGRESS', conclusion: '' }]).state, 'running');
  assert.equal(ciOf([{ name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }]).text, 'CI 失敗 1 / 2 (lint)');
  assert.equal(ciOf([{ context: 'ci/x', state: 'PENDING' }]).state, 'running');
});

test('summarisePr drops non-https urls', () => {
  assert.equal(summarisePr(1, { title: 't', url: 'javascript:alert(1)' }).url, '');
  assert.equal(summarisePr(12, PR_12).url, PR_12.url);
});

test('collectPrs: gh missing gives one notice; other failures list the numbers', () => {
  const missing = collectPrs([3, 4], new Map([[3, { ok: false, reason: 'gh 無し' }], [4, { ok: false, reason: 'gh 無し' }]]));
  assert.deepEqual(missing.notices, ['PR の説明は取れなかった (gh 無し)']);
  assert.equal(missing.prs[3].missing, true);
  const mixed = collectPrs([3, 4], new Map([[3, { ok: true, data: PR_12 }], [4, { ok: false, reason: 'gh 失敗' }]]));
  assert.deepEqual(mixed.notices, ['PR の説明は取れなかった (gh 失敗): #4']);
  assert.equal(mixed.prs[3].title, PR_12.title);
});

// ---------- layout ----------
test('layout keeps column order, does not overlap boxes and splits tall columns', () => {
  const boxes = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `entry:e${i}`, column: 'entry', label: `e${i}` })),
    { id: 'core:c', column: 'core', label: 'c' },
    { id: 'outside:o', column: 'outside', label: 'o' },
  ];
  const edges = [{ from: 'entry:e3', to: 'core:c' }, { from: 'core:c', to: 'outside:o' }];
  const out = layout(boxes, edges);
  const x = (id) => out.boxes.find((b) => b.id === id).x;
  assert.ok(x('core:c') > Math.max(...out.boxes.filter((b) => b.column === 'entry').map((b) => b.x)));
  assert.ok(x('outside:o') > x('core:c'));
  for (const a of out.boxes) {
    for (const b of out.boxes) {
      if (a === b) continue;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
    }
  }
  const entryRows = new Set(out.boxes.filter((b) => b.column === 'entry').map((b) => b.y));
  assert.ok(entryRows.size <= GEOMETRY.maxRows);
  assert.ok(out.world.w >= Math.max(...out.boxes.map((b) => b.x + b.w)));
  assert.ok(out.world.h >= Math.max(...out.boxes.map((b) => b.y + b.h)));
  assert.equal(out.columns.length, 3);
});

test('layout is deterministic', () => {
  const arch = parseArchitecture(ARCH_MD);
  const g = buildBoxes(arch.roles, arch.boundaries, normaliseLabels(null));
  assert.deepEqual(layout(g.boxes, g.outsideEdges), layout(g.boxes, g.outsideEdges));
});

// ---------- whole map ----------
function demoMap(prResults = new Map([[12, { ok: true, data: PR_12 }]])) {
  const arch = parseArchitecture(ARCH_MD);
  const files = mappedFiles(arch);
  const sources = new Map(Object.entries(SOURCES));
  const changeSet = collectChanges(LOG_TEXT, new Set(files));
  return buildMap({
    title: 'demo', root: 'C:/work/demo', since: '2026-11-14', generatedAt: '2026-11-24T09:00:00+09:00',
    arch, sources, missing: files.filter((p) => !sources.has(p)), changeSet, prResults, labels: null,
    lastCommit: { hash: 'x', date: '2026-11-20T10:00:00+09:00', subject: 'chore: tweak app' },
  });
}

test('collectChanges keeps only commits that touch mapped files', () => {
  const arch = parseArchitecture(ARCH_MD);
  const cs = collectChanges(LOG_TEXT, new Set(mappedFiles(arch)));
  assert.deepEqual(cs.changes.map((c) => c.subject), ['chore: tweak app', 'feat: add day view', 'fix: core']);
  assert.deepEqual(cs.prNumbers, [12]);
  assert.deepEqual(cs.changes[2].files.map((f) => f.path), ['js/roster-core.js']);
});

test('buildMap marks new and changed boxes and picks today by lines', () => {
  const map = demoMap();
  assert.deepEqual(validateMap(map), []);
  const box = (id) => map.boxes.find((b) => b.id === id);
  assert.equal(box('core:roster').status, 'new');
  assert.equal(box('core:roster').lines, 16);
  assert.equal(box('core:roster').files.find((f) => f.path === 'js/roster-day.js').status, 'new');
  assert.equal(box('entry:app').status, 'changed');
  assert.equal(box('shared:roster').status, null);
  assert.deepEqual(map.today, ['core:roster', 'entry:app']);
  assert.equal(map.prs[12].ci.state, 'pass');
  assert.match(map.notices.join('\n'), /見つからないファイル 1 件: js\/gone\.js/);
  assert.ok(map.edges.every((e) => /^e\d+$/.test(e.id)));
  assert.equal(map.edges.filter((e) => e.kind === 'outside').length, 3);
});

test('buildMap without gh still builds and says so', () => {
  const map = demoMap(new Map([[12, { ok: false, reason: 'gh 無し' }]]));
  assert.deepEqual(validateMap(map), []);
  assert.ok(map.notices.includes('PR の説明は取れなかった (gh 無し)'));
  assert.equal(map.prs[12].missing, true);
});

test('validateMap catches broken maps', () => {
  assert.deepEqual(validateMap(null), ['map is not an object']);
  const map = demoMap();
  const broken = { ...map, edges: [...map.edges, { from: 'nope', to: 'core:roster', count: 1, kind: 'import' }], today: ['ghost'] };
  const errors = validateMap(broken);
  assert.ok(errors.some((e) => /missing box/.test(e)));
  assert.ok(errors.some((e) => /ghost/.test(e)));
});

// ---------- regression: review 2026-11-24 ----------
test('isUnsafePath flags paths that can leave the folder', () => {
  for (const p of ['../x.js', 'a/../../x.js', 'a\\..\\x.js', '/etc/x.js', '\\x.js', 'C:/x.js', 'c:x.js', '..']) assert.equal(isUnsafePath(p), true, p);
  for (const p of ['js/app.js', 'src/core/', '..cache/x.js', 'a..b.js']) assert.equal(isUnsafePath(p), false, p);
});

test('parseArchitecture drops unsafe paths from both tables and says so', () => {
  const md = '## 1. 役割対応表\n| 役割 | パス |\n|---|---|\n| core | js/a.js ../../x.js C:/w/y.js |\n\n## 2. 外部境界表\n| adapter | 相手 |\n|---|---|\n| ../out.mjs | X API |\n| js/a.js | Y API |\n';
  const arch = parseArchitecture(md);
  assert.deepEqual(arch.roles.core, ['js/a.js']);
  assert.deepEqual(arch.boundaries.map((b) => b.file), ['js/a.js']);
  assert.equal(arch.notices.length, 1);
  assert.match(arch.notices[0], /フォルダの外を指すパス.*3 件/);
});

test('parseArchitecture with only unsafe paths is an input error', () => {
  assert.throws(() => parseArchitecture('## 役割対応表\n| 役割 | パス |\n|---|---|\n| core | ../x.js |\n'), InputError);
});

test('buildBoxes does not take labels from Object.prototype', () => {
  const g = buildBoxes({ shared: [], core: ['js/constructor.js', 'js/toString-x.js', 'js/hasOwnProperty.js'], adapter: [], entry: [] }, [], normaliseLabels(null));
  assert.deepEqual(g.boxes.map((b) => b.label).sort(), ['constructor', 'hasownproperty', 'tostring']);
  const withLabels = normaliseLabels(JSON.parse('{"groups":{"__proto__":"x","roster":"名簿"}}'));
  assert.equal(Object.getPrototypeOf(withLabels.groups), null);
  assert.equal(withLabels.groups.roster, '名簿');
});

test('globalUses finds names taken from a place another file puts on an app-wide global object', async () => {
  const { globalUses } = await import('../src/core/imports.mjs');
  const sources = new Map([
    ['js/roster-schema.js', "(() => { const R = (globalThis.APP = globalThis.APP || {}); R.roster = { fromModel() {}, MAX_TEXT: 9 }; })();"],
    ['js/lang-a.js', 'const R = globalThis.APP; R.lang = "ja";'],
    ['js/lang-b.js', 'const R = globalThis.APP; R.lang = R.lang || "en";'],
    ['worker/read-core.mjs', "import '../js/roster-schema.js';\nconst R = globalThis.APP;\nR.roster.fromModel(x); if (n > R.roster.MAX_TEXT) {} R.lang; a.R.roster.nope;"],
  ]);
  const uses = globalUses(sources);
  assert.deepEqual(uses, [{ user: 'worker/read-core.mjs', owner: 'js/roster-schema.js', names: ['fromModel', 'MAX_TEXT'], placeOnly: false }]);
});
