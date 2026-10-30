import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FIXED_VARIABLES, INHERITED_VARIABLES, NUGET_CONFIG, buildArguments, printBuildIdentity, resolveTrustedDotnet, restoreArguments, sanitisedEnvironment,
} from '../scripts/dotnet-build-env.mjs';

// Issue #102: the helper's decisions are pure functions of the environment and a file-system view, so none of this runs dotnet.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOTNET = 'C:\\Program Files\\dotnet\\dotnet.exe';
const goodFs = { lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }), realpath: (p) => p };
const winEnv = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\WINDOWS' };

test('dotnet is resolved to <ProgramFiles>\\dotnet\\dotnet.exe, never through PATH', () => {
  assert.equal(resolveTrustedDotnet({ env: { ...winEnv, PATH: 'D:\\evil' }, platform: 'win32', ...goodFs }), DOTNET);
  assert.equal(resolveTrustedDotnet({ env: { programw6432: 'C:\\Program Files' }, platform: 'win32', ...goodFs }), DOTNET, 'variable names are case-insensitive, like Windows');
});

test('an untrusted dotnet is refused with a one-line error', () => {
  const refuse = (options, pattern) => assert.throws(() => resolveTrustedDotnet({ platform: 'win32', ...goodFs, ...options }), (error) => pattern.test(error.message) && !error.message.includes('\n'));
  refuse({ env: { ProgramFiles: 'D:\\tools\\evil' } }, /^untrusted_dotnet: ProgramFiles is "D:\\tools\\evil"/u);
  refuse({ env: {} }, /^untrusted_dotnet: ProgramFiles is ""/u);
  refuse({ env: winEnv, lstat: () => { throw new Error('ENOENT'); } }, /^untrusted_dotnet: .*does not exist.*PATH is refused/u);
  refuse({ env: winEnv, lstat: () => ({ isFile: () => true, isSymbolicLink: () => true }) }, /not a regular file/u);
  refuse({ env: winEnv, lstat: () => ({ isFile: () => false, isSymbolicLink: () => false }) }, /not a regular file/u);
  refuse({ env: winEnv, realpath: () => 'D:\\elsewhere\\dotnet.exe' }, /resolves to D:\\elsewhere/u);
  refuse({ env: winEnv, platform: 'linux' }, /only build on Windows/u);
});

test('the child environment keeps only allowlisted variables and drops every override', () => {
  const dirty = {
    SystemRoot: 'C:\\WINDOWS', Temp: 'C:\\Temp', USERPROFILE: 'C:\\Users\\x', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', Path: 'D:\\evil;C:\\WINDOWS',
    MSBUILDENABLEALLPROPERTYFUNCTIONS: '1', MSBuildSDKsPath: 'D:\\evil', MSBUILD_EXE_PATH: 'D:\\evil\\msbuild.dll', NUGET_PACKAGES: 'D:\\evil', NuGetPackageRoot: 'D:\\evil',
    NUGET_HTTP_CACHE_PATH: 'D:\\evil', DOTNET_ROOT: 'D:\\evil', DOTNET_CLI_HOME: 'D:\\evil', DOTNET_MSBUILD_SDK_RESOLVER_SDKS_DIR: 'D:\\evil', DOTNET_NOLOGO: '0',
    DefineConstants: 'ALBERA_BROKER_TEST_FAULTS', AlberaApproverTestFaults: 'true', ALBERA_ANYTHING: '1', Configuration: 'Debug', Platform: 'x86', RuntimeIdentifier: 'win-arm64',
  };
  const clean = sanitisedEnvironment(dirty, DOTNET);
  assert.deepEqual(Object.keys(clean).sort(), ['DOTNET_CLI_TELEMETRY_OPTOUT', 'DOTNET_NOLOGO', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE', 'PATH', 'SystemRoot', 'USERPROFILE', 'LOCALAPPDATA', 'TEMP'].sort());
  assert.equal(clean.TEMP, 'C:\\Temp', 'allowlisted names come back in the canonical spelling');
  assert.deepEqual(Object.fromEntries(Object.entries(clean).filter(([key]) => key.startsWith('DOTNET_'))), FIXED_VARIABLES, 'DOTNET_* is exactly our fixed set (caller DOTNET_NOLOGO=0 is overridden)');
  assert.equal(clean.PATH, 'C:\\WINDOWS\\System32;C:\\Program Files\\dotnet', 'PATH is System32 + the dotnet folder only');
  assert.equal(Object.keys(clean).some((key) => /^(?:msbuild|nuget|albera|defineconstants)/iu.test(key)), false);
});

test('the allowlist itself names no MSBuild, NuGet, DOTNET or Albera variable', () => {
  assert.equal(INHERITED_VARIABLES.some((name) => /^(?:msbuild|nuget|dotnet|albera|defineconstants)/iu.test(name)), false);
  assert.throws(() => sanitisedEnvironment({}, DOTNET), /SystemRoot is not set/u);
});

const locked = { lockFileExists: () => true };

test('restore is locked, uses the repo NuGet config and never reads auto-response files', () => {
  const args = restoreArguments({ project: 'C:\\r\\p\\a.csproj', runtime: 'win-x64', properties: ['-p:X=1'], ...locked });
  assert.deepEqual(args.slice(0, 2), ['restore', 'C:\\r\\p\\a.csproj']);
  for (const required of ['-noAutoResponse', '-nologo', '--locked-mode', '-p:X=1']) assert.ok(args.includes(required), required);
  assert.equal(args[args.indexOf('--configfile') + 1], NUGET_CONFIG);
  assert.equal(args[args.indexOf('--runtime') + 1], 'win-x64');
  assert.equal(restoreArguments({ project: 'p.csproj', ...locked }).includes('--runtime'), false, 'runtime is optional');
});

test('restore of a project without packages.lock.json is refused', () => {
  assert.throws(() => restoreArguments({ project: path.join(root, 'test', 'nonexistent', 'a.csproj'), runtime: 'win-x64' }), (error) => error.message.startsWith('missing_lock_file:'));
});

test('publish and build never restore on their own and carry -noAutoResponse', () => {
  const publish = buildArguments({ verb: 'publish', project: 'p.csproj', args: ['--output', 'o'], properties: ['-p:X=1'] });
  assert.deepEqual(publish.slice(0, 3), ['publish', 'p.csproj', '--no-restore']);
  for (const required of ['-noAutoResponse', '-nologo', '--output', '-p:X=1']) assert.ok(publish.includes(required), required);
  assert.equal(publish.includes('--configfile'), false);
  assert.ok(buildArguments({ verb: 'build', project: 'p.csproj' }).includes('-noAutoResponse'));
  assert.throws(() => buildArguments({ verb: 'pack', project: 'p.csproj' }), /unsupported_verb/u);
});

test('the repo NuGet config clears every inherited source and allows only nuget.org over https', () => {
  assert.equal(path.basename(NUGET_CONFIG), 'nuget.publish.config', 'not named nuget.config: nothing may pick it up by itself');
  const text = fs.readFileSync(NUGET_CONFIG, 'utf8').replace(/<!--[\s\S]*?-->/gu, '');
  assert.match(text, /<packageSources>\s*<clear \/>/u);
  assert.deepEqual([...text.matchAll(/<add key="([^"]+)" value="([^"]+)"/gu)].map((m) => [m[1], m[2]]), [['nuget.org', 'https://api.nuget.org/v3/index.json']]);
  assert.match(text, /<fallbackPackageFolders>\s*<clear \/>/u);
});

test('the identity lines are one for the SDK and one for the output hash', () => {
  const lines = [];
  printBuildIdentity({ sdk: '10.0.302', root: 'C:\\r', file: 'C:\\r\\out\\a.exe', sha256: 'ab'.repeat(32), log: (line) => lines.push(line) });
  assert.deepEqual(lines, ['dotnet sdk 10.0.302', `sha256 ${'ab'.repeat(32)} out/a.exe`]);
});

test('every publish script goes through the helper and none calls dotnet itself', () => {
  const scripts = fs.readdirSync(path.join(root, 'scripts')).filter((name) => /^publish-.*\.mjs$/u.test(name));
  assert.ok(scripts.length >= 5, 'the five publish scripts are found (false-safe)');
  for (const name of scripts) {
    const source = fs.readFileSync(path.join(root, 'scripts', name), 'utf8');
    assert.match(source, /from '\.\/dotnet-build-env\.mjs'/u, name);
    assert.equal(/spawn(?:Sync)?\(|execFile(?:Sync)?\(|child_process/u.test(source), false, `${name} must not spawn anything itself`);
  }
});

test('every project a publish script builds has a packages.lock.json (locked restore needs one)', () => {
  for (const project of ['src/runtime/windows-job-guardian', 'test/windows-job-probe', 'src/runtime/windows-broker', 'src/runtime/windows-broker-pipe-client', 'src/runtime/windows-approval-authority', 'src/runtime/windows-approver', 'test/windows-service-lab']) {
    assert.ok(fs.existsSync(path.join(root, project, 'packages.lock.json')), project);
  }
});
