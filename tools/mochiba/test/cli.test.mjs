// End-to-end tests of the CLI with fake adapters (no git, no gh, no disk writes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInside, localDate, localIso, run } from '../src/entry/cli.mjs';
import { assemblePage, DATA_SLOT, embedJson, PAGE_SCRIPTS, renderHtml, TEMPLATE_PATH } from '../src/entry/render.mjs';
import { createFakeFsRepo } from '../src/adapter/fake-fs-repo.mjs';
import { createFakeGit } from '../src/adapter/fake-git.mjs';
import { createFakeGh } from '../src/adapter/fake-gh.mjs';
import { ARCH_MD, CWD, LOG_TEXT, PR_12, ROOT, repoFiles } from './fixture.mjs';

const TEMPLATE = assemblePage(readFileSync(TEMPLATE_PATH, 'utf8'), PAGE_SCRIPTS.map((p) => readFileSync(p, 'utf8')));
const NOW = new Date(2026, 10, 24, 9, 30, 0);

function setup({ files = repoFiles(), git, gh } = {}) {
  const out = { logs: [], errors: [] };
  const deps = {
    fs: createFakeFsRepo(files),
    git: git || createFakeGit({ logText: LOG_TEXT, lastCommit: { hash: 'a', date: '2026-11-20T10:00:00+09:00', subject: 'chore: tweak app' } }),
    gh: gh || createFakeGh({ prs: { 12: PR_12 } }),
    cwd: CWD, now: NOW, template: TEMPLATE,
    log: (m) => out.logs.push(m), error: (m) => out.errors.push(m),
  };
  return { deps, out };
}
const norm = (p) => p.replace(/\\/g, '/');
const mapIn = (html) => JSON.parse(html.match(/<script type="application\/json" id="map-data">([\s\S]*?)<\/script>/)[1]);

// ---------- --arch: the tables kept outside the target (a repo we must not add files to) ----------
const withoutSpec = () => Object.fromEntries(Object.entries(repoFiles()).filter(([p]) => !p.replace(/\\/g, '/').endsWith('spec/architecture.md')));

test('cli --arch reads the tables from outside the target; paths in them stay relative to the target', async () => {
  const files = { ...withoutSpec(), [join(CWD, 'tables', 'demo.md')]: ARCH_MD };
  const { deps, out } = setup({ files });
  assert.equal(await run(['map', ROOT, '--since', '10', '--arch', 'tables/demo.md', '--out', 'o.html'], deps), 0, out.errors.join('\n'));
  const map = mapIn(deps.fs.writes.get(norm(join(CWD, 'o.html'))));
  assert.ok(map.boxes.some((b) => b.files.some((f) => f.path === 'js/roster-core.js')));
  assert.ok(map.edges.length > 0);
  assert.equal(deps.fs.writes.size, 1, 'only the map is written');
});

test('cli without spec/architecture.md says it can be passed with --arch; a missing --arch file is named', async () => {
  const none = setup({ files: withoutSpec() });
  assert.equal(await run(['map', ROOT, '--out', 'o.html'], none.deps), 1);
  assert.match(none.out.errors[0], /--arch/);
  const missing = setup({ files: withoutSpec() });
  assert.equal(await run(['map', ROOT, '--arch', 'nope.md', '--out', 'o.html'], missing.deps), 1);
  assert.match(missing.out.errors[0], /--arch のファイルが無い: .*nope\.md/);
  const empty = setup({ files: { ...withoutSpec(), [join(CWD, 'a.md')]: '# no tables' } });
  assert.equal(await run(['map', ROOT, '--arch', 'a.md', '--out', 'o.html'], empty.deps), 1);
  assert.match(empty.out.errors[0], /a\.md に 役割対応表 が無い/);
});

test('cli --arch: a table an AI wrote on Windows (\\ separators, a lead-in line) gives the same map', async () => {
  const run1 = async (md) => {
    const { deps, out } = setup({ files: { ...withoutSpec(), [join(CWD, 'a.md')]: md } });
    assert.equal(await run(['map', ROOT, '--since', '10', '--arch', 'a.md', '--out', 'o.html'], deps), 0, out.errors.join('\n'));
    const map = mapIn(deps.fs.writes.get(norm(join(CWD, 'o.html'))));
    return JSON.stringify([map.boxes.map((b) => [b.id, b.files.map((f) => f.path)]), map.edges.map((e) => [e.from, e.to]), map.changes.length]);
  };
  const base = await run1(ARCH_MD);
  const tables = ARCH_MD.slice(ARCH_MD.indexOf('## 1.'));
  const windows = tables.replace(/\| (shared|core|adapter|entry) \|([^|]*)\|/g, (m, role, cell) => `| ${role} |${cell.replace(/\//g, '\\')}|`)
    .replace('worker/anthropic.mjs | 同じ', 'worker\\anthropic.mjs | 同じ');
  assert.match(windows, /js\\roster-core\.js/);
  assert.equal(await run1(windows), base);
  assert.equal(await run1(`ここに役割対応表と外部境界表を書きました。\n\n${tables}`), base);
});

test('cli --arch: a UTF-16 file and paths that find nothing name the --arch file, not spec/architecture.md', async () => {
  const utf16 = setup({ files: { ...withoutSpec(), [join(CWD, 'a.md')]: ARCH_MD.split('').join('\u0000') } });
  assert.equal(await run(['map', ROOT, '--arch', 'a.md', '--out', 'o.html'], utf16.deps), 1);
  assert.match(utf16.out.errors[0], /a\.md が UTF-8 でない/);
  const wrong = setup({ files: { ...withoutSpec(), [join(CWD, 'a.md')]: ARCH_MD.replace(/js\//g, 'demo/js/').replace(/worker\//g, 'demo/worker/').replace(' index.html ', ' demo/index.html ') } });
  assert.equal(await run(['map', ROOT, '--arch', 'a.md', '--out', 'o.html'], wrong.deps), 1);
  assert.match(wrong.out.errors[0], /a\.md の役割対応表のパスにファイルが 1 つも無い/);
  assert.doesNotMatch(wrong.out.errors[0], /spec\/architecture\.md/);
});

test('cli writes the map to out/<folder>-map.html by default', async () => {
  const { deps, out } = setup();
  const code = await run(['map', ROOT, '--since', '10'], deps);
  assert.equal(code, 0, out.errors.join('\n'));
  const target = norm(join(CWD, 'out', 'demo-map.html'));
  assert.ok(deps.fs.writes.has(target), [...deps.fs.writes.keys()].join(','));
  const map = mapIn(deps.fs.writes.get(target));
  assert.equal(map.since, '2026-11-14');
  assert.equal(map.title, 'demo');
  assert.equal(map.root, norm(ROOT));
  assert.equal(map.generatedAt, localIso(NOW));
  assert.deepEqual(map.today, ['core:roster', 'entry:app']);
  assert.equal(map.prs[12].reason, 'Staff could not see today at a glance. This adds the day view.');
  assert.deepEqual(deps.git.calls.find((c) => c[0] === 'log'), ['log', ROOT, '2026-11-14T00:00:00']);
  assert.deepEqual(deps.gh.calls, [[ROOT, 12]]);
  assert.match(out.logs[0], /^書いた: /);
  assert.equal(deps.fs.writes.size, 1);
});

test('cli default --since is the day before the last commit in the folder', async () => {
  const { deps } = setup();
  assert.equal(await run(['map', ROOT, '--out', join(CWD, 'x.html')], deps), 0);
  assert.equal(mapIn(deps.fs.writes.get(norm(join(CWD, 'x.html')))).since, '2026-11-19');
});

test('cli applies --labels and merges same-name groups', async () => {
  const labels = join(CWD, 'labels.json');
  const { deps } = setup({ files: repoFiles({ [labels]: JSON.stringify({ groups: { roster: '名簿', ask: '名簿' }, outside: { 'Claude API': 'AI (Claude)' } }) }) });
  assert.equal(await run(['map', ROOT, '--labels', 'labels.json', '--out', 'o.html'], deps), 0);
  const map = mapIn(deps.fs.writes.get(norm(join(CWD, 'o.html'))));
  assert.deepEqual(map.boxes.filter((b) => b.column === 'core').map((b) => b.label), ['名簿']);
  assert.ok(map.boxes.some((b) => b.id === 'outside:AI (Claude)'));
});

test('cli without gh still writes the map and says the PR notes are missing', async () => {
  const { deps, out } = setup({ gh: createFakeGh({ missing: true }) });
  assert.equal(await run(['map', ROOT, '--since', '10', '--out', 'o.html'], deps), 0);
  const map = mapIn(deps.fs.writes.get(norm(join(CWD, 'o.html'))));
  assert.ok(map.notices.includes('PR の説明は取れなかった (gh 無し)'));
  assert.ok(out.logs.some((l) => l.includes('gh 無し')));
});

test('cli input errors exit 1 with one line and write nothing', async () => {
  const cases = [
    [[], /使い方/],
    [['map'], /使い方/],
    [['draw', ROOT], /使い方/],
    [['map', ROOT, '--bogus'], /使い方/],
    [['map', join(ROOT, 'nope')], /対象フォルダが無い/],
    [['map', ROOT, '--since', 'yesterday'], /--since は日数/],
    [['map', ROOT, '--labels', 'missing.json'], /--labels のファイルが無い/],
    [['map', ROOT, '--out', join(ROOT, 'out.html')], /対象の repo の中/],
  ];
  for (const [argv, re] of cases) {
    const { deps, out } = setup();
    assert.equal(await run(argv, deps), 1, `argv ${argv.join(' ')}`);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0], re);
    assert.ok(!out.errors[0].includes('\n'), 'one line');
    assert.equal(deps.fs.writes.size, 0);
  }
});

test('cli: no architecture.md, no role table, bad labels JSON, not a git repo -> exit 1', async () => {
  const noArch = repoFiles();
  delete noArch[join(ROOT, 'spec', 'architecture.md')];
  let s = setup({ files: { ...noArch, [join(ROOT, 'js', 'x.js')]: '' } });
  assert.equal(await run(['map', ROOT], s.deps), 1);
  assert.match(s.out.errors[0], /spec\/architecture\.md が無い/);

  s = setup({ files: repoFiles({ [join(ROOT, 'spec', 'architecture.md')]: '# none\n' }) });
  assert.equal(await run(['map', ROOT], s.deps), 1);
  assert.match(s.out.errors[0], /役割対応表 が無い/);

  s = setup({ files: repoFiles({ [join(CWD, 'bad.json')]: '{ nope' }) });
  assert.equal(await run(['map', ROOT, '--labels', 'bad.json'], s.deps), 1);
  assert.match(s.out.errors[0], /JSON が読めない/);

  s = setup({ files: repoFiles({ [join(CWD, 'shape.json')]: '{"groups": []}' }) });
  assert.equal(await run(['map', ROOT, '--labels', 'shape.json'], s.deps), 1);
  assert.match(s.out.errors[0], /形が違う/);

  s = setup({ git: createFakeGit({ fail: 'git が読めない: not a git repository (対象は git の repo の中のフォルダにする)' }) });
  assert.equal(await run(['map', ROOT], s.deps), 1);
  assert.match(s.out.errors[0], /git の repo/);
});

test('cli: an unexpected failure exits 2', async () => {
  const { deps, out } = setup();
  deps.fs.writeText = () => { throw new Error('disk full'); };
  assert.equal(await run(['map', ROOT, '--out', 'o.html'], deps), 2);
  assert.match(out.errors[0], /予期しない失敗/);
});

test('localDate / localIso use local time', () => {
  assert.equal(localDate(NOW), '2026-11-24');
  assert.match(localIso(NOW), /^2026-11-24T09:30:00[+-]\d{2}:\d{2}$/);
});

// ---------- render ----------
test('embedJson cannot close the script element', () => {
  const s = embedJson({ t: '</script><script>alert(1)</script><!-- &  ' });
  assert.ok(!s.includes('<'));
  assert.ok(!s.includes('>'));
  assert.deepEqual(JSON.parse(s), { t: '</script><script>alert(1)</script><!-- &  ' });
});

test('renderHtml fills the one data slot and refuses invalid maps', async () => {
  const { deps } = setup();
  await run(['map', ROOT, '--out', 'o.html'], deps);
  const html = deps.fs.writes.get(norm(join(CWD, 'o.html')));
  assert.ok(!html.includes(DATA_SLOT));
  assert.equal((html.match(/id="map-data"/g) || []).length, 1);
  assert.throws(() => renderHtml(TEMPLATE, { version: 1 }), /not valid/);
  assert.throws(() => renderHtml('<p>no slot</p>', mapIn(html)), /exactly once/);
});

test('the page script is strict as a whole (the directive is its first statement)', () => {
  // Only whitespace may come before the directive (a CRLF checkout puts a carriage return there).
  assert.match(TEMPLATE, /<script>\s*'use strict';/);
});

// The words to keep out of the page live in .private-words.txt (one per line, not tracked by git),
// so this public test does not itself name them. Where the file is absent the check is skipped.
const PRIVATE_WORDS = join(resolve(fileURLToPath(new URL('..', import.meta.url))), '.private-words.txt');
test('the written page carries none of the words in .private-words.txt (it is shown at work)', (t) => {
  if (!existsSync(PRIVATE_WORDS)) { t.skip('no .private-words.txt here'); return; }
  const words = readFileSync(PRIVATE_WORDS, 'utf8').split(/\r?\n/).map((w) => w.trim()).filter(Boolean);
  assert.ok(words.length > 0, '.private-words.txt has no words');
  const page = TEMPLATE.toLowerCase();
  for (const w of words) assert.ok(!page.includes(w.toLowerCase()), `the page contains a private word (line ${words.indexOf(w) + 1} of .private-words.txt)`);
});

test('the one outside link is the fixed ALBERA issue form, opened by a click, carrying nothing from the map', () => {
  const links = [...TEMPLATE.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
  const outside = links.filter((a) => /href="https?:/.test(a));
  assert.equal(outside.length, 1);
  assert.ok(outside[0].includes('href="https://github.com/BERORINPO/albera/issues/new?template=from-a-copy.yml"'), outside[0]);
  assert.match(outside[0], /target="_blank"/);
  assert.match(outside[0], /rel="noopener noreferrer"/);
  // The page scripts never point a link outside: only vscode:// for opening files.
  assert.doesNotMatch(PAGE_SCRIPTS.map((p) => readFileSync(p, 'utf8')).join('\n'), /\.href\s*=|href:\s*`?https?:/);
});

test('template draws with DOM APIs and loads nothing from outside', () => {
  assert.ok(TEMPLATE.includes(DATA_SLOT));
  assert.doesNotMatch(TEMPLATE, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(TEMPLATE, /<(?:script|link|img)[^>]+(?:src|href)=["']https?:/i);
  assert.match(TEMPLATE, /default-src 'none'/);
  assert.match(TEMPLATE, /BIZ UDPGothic/);
  assert.match(TEMPLATE, /<html lang="ja" data-theme="light">/);
  assert.match(TEMPLATE, /\[data-theme="dark"\]/);
  // No glow: the chart look keeps lines and boxes free of blurred halos and breathing outlines.
  assert.doesNotMatch(TEMPLATE, /drop-shadow|@keyframes breathe|radial-gradient/);
});

// ---------- regression: review 2026-11-24 ----------
const REPO_TOP = resolve(ROOT, '..');

test('cli refuses --out inside the target repo but outside the target folder', async () => {
  const { deps, out } = setup({ git: createFakeGit({ logText: LOG_TEXT, top: REPO_TOP }) });
  assert.equal(await run(['map', ROOT, '--out', join(REPO_TOP, 'x.html')], deps), 1);
  assert.match(out.errors[0], /対象の repo の中/);
  assert.equal(deps.fs.writes.size, 0);
});

test('cli refuses the default out/ when cwd is inside the target repo', async () => {
  const { deps, out } = setup({ git: createFakeGit({ logText: LOG_TEXT, top: REPO_TOP }) });
  assert.equal(await run(['map', ROOT], { ...deps, cwd: join(REPO_TOP, 'tools') }), 1);
  assert.match(out.errors[0], /対象の repo の中/);
  assert.equal(deps.fs.writes.size, 0);
});

test('cli refuses --out that reaches the repo through a junction', async () => {
  const link = resolve('/work/shortcut');
  const files = repoFiles();
  const fs = createFakeFsRepo(files, { links: { [link]: REPO_TOP } });
  const { deps, out } = setup({ git: createFakeGit({ logText: LOG_TEXT, top: REPO_TOP }) });
  assert.equal(await run(['map', ROOT, '--out', join(link, 'x.html')], { ...deps, fs }), 1);
  assert.match(out.errors[0], /対象の repo の中/);
  assert.equal(fs.writes.size, 0);
});

test('isInside treats a "..name" folder as inside and ".." as outside', () => {
  assert.equal(isInside(ROOT, join(ROOT, '..cache', 'x.html')), true);
  assert.equal(isInside(ROOT, join(ROOT, '..', 'x.html')), false);
  assert.equal(isInside(ROOT, ROOT), true);
});

test('cli expands folder rows of table 1 into the source files under them', async () => {
  const arch = '## 1. 役割対応表\n| 役割 | パス |\n|---|---|\n| shared | src/shared/ |\n| core | src/core |\n| adapter | src/adapter/ |\n| entry | src/entry/ |\n';
  const files = {
    [join(ROOT, 'spec', 'architecture.md')]: arch,
    [join(ROOT, 'src', 'shared', 'shape.mjs')]: 'export const S = 1;',
    [join(ROOT, 'src', 'core', 'build.mjs')]: "import { S } from '../shared/shape.mjs';",
    [join(ROOT, 'src', 'core', 'notes.md')]: '# not source',
    [join(ROOT, 'src', 'adapter', 'git.mjs')]: "import { b } from '../core/build.mjs';",
    [join(ROOT, 'src', 'entry', 'cli.mjs')]: "import { g } from '../adapter/git.mjs';",
    [join(ROOT, 'src', 'entry', 'template.html')]: '<p></p>',
  };
  const { deps, out } = setup({ files });
  assert.equal(await run(['map', ROOT, '--out', 'o.html'], deps), 0, out.errors.join('\n'));
  const map = mapIn(deps.fs.writes.get(norm(join(CWD, 'o.html'))));
  const allFiles = map.boxes.flatMap((b) => b.files.map((f) => f.path)).sort();
  assert.deepEqual(allFiles, ['src/adapter/git.mjs', 'src/core/build.mjs', 'src/entry/cli.mjs', 'src/entry/template.html', 'src/shared/shape.mjs']);
  assert.ok(map.edges.length >= 3, `edges ${map.edges.length}`);
  assert.ok(map.boxes.every((b) => b.label), 'no empty label');
});

test('cli: a table that names no existing file exits 1 instead of writing an empty map', async () => {
  const arch = '## 1. 役割対応表\n| 役割 | パス |\n|---|---|\n| core | src/core/ lib/none.js |\n';
  const files = { [join(ROOT, 'spec', 'architecture.md')]: arch, [join(ROOT, 'src', 'core', 'readme.md')]: 'x' };
  const { deps, out } = setup({ files });
  assert.equal(await run(['map', ROOT, '--out', 'o.html'], deps), 1);
  assert.match(out.errors[0], /ファイルが 1 つも無い/);
  assert.equal(deps.fs.writes.size, 0);
});

test('cli never reads table paths that leave the folder', async () => {
  const outsideFile = join(REPO_TOP, 'secret.js');
  const arch = ARCH_MD.replace('| shared | js/roster-schema.js |', '| shared | js/roster-schema.js ../secret.js C:/x/y.js /etc/z.js |');
  const files = repoFiles({ [join(ROOT, 'spec', 'architecture.md')]: arch, [outsideFile]: 'export const leaked = 1;' });
  const { deps, out } = setup({ files });
  const reads = [];
  const readText = deps.fs.readText;
  deps.fs.readText = (abs) => { reads.push(norm(abs)); return readText(abs); };
  assert.equal(await run(['map', ROOT, '--since', '10', '--out', 'o.html'], deps), 0, out.errors.join('\n'));
  assert.ok(!reads.includes(norm(outsideFile)), 'read a file outside the folder');
  const map = mapIn(deps.fs.writes.get(norm(join(CWD, 'o.html'))));
  assert.ok(!JSON.stringify(map.boxes).includes('secret'), 'outside path became a box');
  assert.ok(map.notices.some((n) => /フォルダの外/.test(n)), map.notices.join(' / '));
});

test('cli: a file named constructor.js does not crash the map', async () => {
  const arch = ARCH_MD.replace('| shared | js/roster-schema.js |', '| shared | js/roster-schema.js js/constructor.js js/__proto__.js |');
  const files = repoFiles({ [join(ROOT, 'spec', 'architecture.md')]: arch, [join(ROOT, 'js', 'constructor.js')]: '', [join(ROOT, 'js', '__proto__.js')]: '' });
  const { deps, out } = setup({ files });
  assert.equal(await run(['map', ROOT, '--since', '10', '--out', 'o.html'], deps), 0, out.errors.join('\n'));
  const map = mapIn(deps.fs.writes.get(norm(join(CWD, 'o.html'))));
  assert.ok(map.boxes.some((b) => b.label === 'constructor'));
  assert.ok(map.boxes.some((b) => b.files.some((f) => f.path === 'js/__proto__.js')));
});

test('template: open links encode each path segment and a broken #sel= is caught', () => {
  assert.doesNotMatch(TEMPLATE, /encodeURI\(/);
  assert.match(TEMPLATE, /encodeURIComponent/);
  assert.match(TEMPLATE, /try \{ return decodeURIComponent\(/);
});
