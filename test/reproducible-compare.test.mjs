import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TARGETS } from '../scripts/check-reproducible-build.mjs';
import { EXPECTED_EXCLUSIONS, compareSnapshots, formatReport, hashTree, isReproducible } from '../scripts/reproducible-compare.mjs';
import { buildArguments, reproducibilityProperties } from '../scripts/dotnet-build-env.mjs';

// Issue #108: the hash comparison and report are pure, so none of this runs dotnet. The builds themselves are checked by `npm run check:reproducible`.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = (entries) => new Map(Object.entries(entries));

test('identical snapshots are reproducible and the report says so', () => {
  const result = compareSnapshots(snapshot({ 'a.exe': '1', 'a.dll': '2' }), snapshot({ 'a.dll': '2', 'a.exe': '1' }));
  assert.deepEqual(result, { identical: ['a.exe', 'a.dll'], different: [], excluded: [], onlyInFirst: [], onlyInSecond: [] });
  assert.equal(isReproducible(result), true);
  assert.deepEqual(formatReport('x', result), ['IDENTICAL x: 2 identical, 0 different, 0 expected exclusion(s), 0 missing on one side']);
});

test('a differing hash, and a file present on one side only, each fail the comparison and are named', () => {
  const result = compareSnapshots(snapshot({ 'a.exe': '1', 'only-first': '3' }), snapshot({ 'a.exe': '9', 'only-second': '4' }));
  assert.deepEqual([result.different, result.onlyInFirst, result.onlyInSecond], [['a.exe'], ['only-first'], ['only-second']]);
  assert.equal(isReproducible(result), false);
  assert.deepEqual(formatReport('x', result), [
    'DIFFERENT x: 0 identical, 1 different, 0 expected exclusion(s), 2 missing on one side',
    '  DIFFERENT a.exe', '  ONLY IN FIRST only-first', '  ONLY IN SECOND only-second',
  ]);
});

test('an excluded file that differs is reported with its reason and does not fail; an excluded file that is missing still fails', () => {
  const exclusions = [{ file: 'a.exe', reason: 'signature field' }, { file: 'gone.dll', reason: 'whatever' }];
  const differs = compareSnapshots(snapshot({ 'a.exe': '1', 'b.dll': '2' }), snapshot({ 'a.exe': '9', 'b.dll': '2' }), exclusions);
  assert.equal(isReproducible(differs), true);
  assert.deepEqual(differs.excluded, [{ file: 'a.exe', reason: 'signature field' }]);
  assert.ok(formatReport('x', differs).includes('  EXPECTED EXCLUSION a.exe: signature field'));
  const missing = compareSnapshots(snapshot({ 'gone.dll': '1' }), snapshot({}), exclusions);
  assert.equal(isReproducible(missing), false, 'an exclusion covers a different hash, not a missing output');
  const otherFile = compareSnapshots(snapshot({ 'c.dll': '1' }), snapshot({ 'c.dll': '2' }), exclusions);
  assert.deepEqual(otherFile.different, ['c.dll'], 'only the listed file is excused');
});

test('hashTree hashes every file recursively with forward-slash sorted names, and refuses a missing or empty folder', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'albera-hashtree-test-'));
  try {
    fs.mkdirSync(path.join(folder, 'sub'));
    fs.writeFileSync(path.join(folder, 'b.txt'), 'b');
    fs.writeFileSync(path.join(folder, 'sub', 'a.txt'), 'a');
    const hashes = hashTree(folder);
    assert.deepEqual([...hashes.keys()], ['b.txt', 'sub/a.txt']);
    assert.equal(hashes.get('b.txt'), '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d');
    fs.mkdirSync(path.join(folder, 'empty'));
    assert.throws(() => hashTree(path.join(folder, 'empty')), /^Error: empty_output:/u);
    assert.throws(() => hashTree(path.join(folder, 'nope')), /^Error: missing_output:/u);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('every publish / build command carries the reproducibility properties, with the repository folder mapped away', () => {
  const properties = reproducibilityProperties('C:\\dev\\albera\\');
  assert.deepEqual(properties, [
    '-p:Deterministic=true', '-p:ContinuousIntegrationBuild=true', '-p:EnableSourceControlManagerQueries=false', '-p:EnableSourceLink=false', '-p:IncludeSourceRevisionInInformationalVersion=false',
    '-p:PathMap=C:\\dev\\albera\\=/_/',
  ]);
  for (const verb of ['publish', 'build']) {
    const args = buildArguments({ verb, project: 'p.csproj', root: 'C:\\dev\\albera', properties: ['-p:X=1'] });
    for (const property of reproducibilityProperties('C:\\dev\\albera')) assert.ok(args.includes(property), `${verb} lacks ${property}`);
    assert.ok(args.indexOf('-p:X=1') < args.indexOf('-p:Deterministic=true'), 'ours come last, so a caller cannot weaken them');
  }
  for (const bad of [undefined, 'albera', 'C:\\a;b', 'C:\\a,b', 'C:\\a"b']) {
    assert.throws(() => reproducibilityProperties(bad), (error) => error.message.startsWith('unsupported_root:'), String(bad));
  }
});

test('the check covers exactly the projects the publish scripts build, and the exclusions list is well-formed', () => {
  const scripts = fs.readdirSync(path.join(root, 'scripts')).filter((name) => /^publish-.*\.mjs$/u.test(name)).sort();
  assert.deepEqual(TARGETS.map((target) => target.script).sort(), scripts, 'a publish script without a check target would be unchecked (false-safe)');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['check:reproducible'], 'node scripts/check-reproducible-build.mjs');
  assert.equal(pkg.scripts.test, 'node --test', 'the slow check stays out of npm test');
  for (const target of TARGETS) {
    const source = fs.readFileSync(path.join(root, 'scripts', target.script), 'utf8');
    for (const project of target.projects) assert.ok(fs.existsSync(path.join(root, project)), project);
    for (const output of target.outputs) assert.ok(target.projects.some((project) => output.startsWith(`${project}/bin/Release/`)), `${output} is under a wiped project`);
    assert.ok(target.outputs.length > 0 && source.includes('restoreAndBuild'), target.id);
  }
  for (const entry of EXPECTED_EXCLUSIONS) {
    assert.ok(TARGETS.some((target) => target.id === entry.target), `exclusion for an unknown target ${entry.target}`);
    assert.ok(entry.file && entry.reason, 'an exclusion needs a file and a reason');
  }
});
