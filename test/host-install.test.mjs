import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openRoomApproval, parseApprovalSettings } from '../src/runtime/room-approval-wiring.mjs';

// scripts/host/albera-host.ps1 installs the Host Broker and the Approval Authority on THIS PC and needs an elevated console, a real account, real services and a machine key.
// None of that runs here. What runs here, on any Windows PC without admin rights:
//   - plan / status / refusal modes of the real script (they change nothing; a before/after snapshot proves it),
//   - the PURE helpers of albera-host-lib.ps1 (validators that mirror the C# config rules, ACL plan, service checks), fed with keys made by Node,
//   - the system-touching helpers (copy with hashing, removal with its allow-list) against a TEMP folder, taken out of the real script by AST,
//   - the signing-key function in USER scope (a throw-away per-user key), verified with Node's crypto.
// The install / uninstall paths themselves (sc.exe, icacls, New-LocalUser, machine key, the Authority start-up guard) are lab-only: test/windows-service-lab/lab-host-install-check.ps1 (written, never run).
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hostDir = path.join(root, 'scripts', 'host');
const driverDir = path.join(root, 'test', 'host-install');
const labRunner = path.join(root, 'test', 'windows-service-lab', 'lab-host-install-check.ps1');
const windows = process.platform === 'win32';
const POWERSHELL = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell';
// The child is Windows PowerShell 5.1: an inherited PSModulePath (on the CI runner it names PowerShell 7's module folders first) makes 5.1 auto-load
// PowerShell 7's Microsoft.PowerShell.Security and fail ("Get-Acl ... the module could not be loaded"). Drop it unless a test sets it on purpose.
const childEnv = (env) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  return { ...base, ...env };
};
const ps = (args, { env = {}, allowFail = false } = {}) => {
  try {
    const stdout = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
      encoding: 'utf8', timeout: 180_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(env),
    });
    return { code: 0, stdout };
  } catch (error) {
    if (!allowFail) throw error;
    return { code: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
};
const host = (args, options) => ps(['-File', path.join(hostDir, 'albera-host.ps1'), ...args], options);
const lastJson = (stdout) => JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
const scratch = (t) => { const dir = mkdtempSync(path.join(os.tmpdir(), 'albera-host-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const b64url = (value) => Buffer.from(value, 'base64url').toString('base64url');

// ---- files ----

test('the host scripts and test drivers are ASCII only (Windows PowerShell 5.1 reads a file without a BOM as the ANSI code page)', () => {
  const files = [
    path.join(hostDir, 'albera-host.ps1'), path.join(hostDir, 'albera-host-lib.ps1'), labRunner,
    ...readdirSync(driverDir).filter((name) => name.endsWith('.ps1')).map((name) => path.join(driverDir, name)),
  ];
  assert.ok(files.length >= 5);
  for (const file of files) assert.equal(/[^\t\r\n -~]/u.test(readFileSync(file, 'utf8')), false, `${path.relative(root, file)} has a non-ASCII character`);
});

test('source guards: elevation is checked first and never requested; nothing from the repository is ever executed; no secret is stored; there is no password any more', () => {
  const script = readFileSync(path.join(hostDir, 'albera-host.ps1'), 'utf8');
  const lib = readFileSync(path.join(hostDir, 'albera-host-lib.ps1'), 'utf8');
  assert.match(script, /\$Mode -in @\('install', 'uninstall', 'migrate'\) -and -not \(Test-Elevated\)\) \{ Stop-Refused/u);
  assert.ok(script.indexOf('Stop-Refused "$Mode needs an elevated console') < script.indexOf('Get-HostLayout'), 'the elevation refusal comes before anything else is computed');
  // The launcher is the one place that opens a browser (Start-Process): it is a script this one WRITES for the owner's own, non-elevated session to run; it is never run here.
  const launcher = lib.slice(lib.indexOf('function Get-OpenAlberaScriptText'), lib.indexOf('# The two shortcuts.'));
  assert.ok(launcher.includes('Start-Process ('), 'the launcher opens the room with Start-Process');
  const libWithoutLauncher = lib.replace(launcher, '');
  for (const forbidden of [/-Verb\s+RunAs/iu, /\bRunAs\b(?!\s*=)/u, /Start-Process/u, /\bsudo\b/iu, /ConvertFrom-SecureString/u, /AsPlainText/u, /\bNetworkCredential\b/u, /PtrToStringAuto|PtrToStringBSTR|SecureStringToGlobalAllocUnicode/u]) {
    assert.equal(forbidden.test(script) || forbidden.test(libWithoutLauncher), false, `must not contain ${forbidden}`);
  }
  assert.doesNotMatch(script + libWithoutLauncher, /ControlPlanePassword|SecureString|Read-Host|New-LocalUser/u, 'the Control Plane has no account and no password: nothing asks for one or makes one');
  assert.match(script, /ALBERA_LAB_VM/u);
  assert.doesNotMatch(script, /-Password\s+['"]/u, 'no literal password');
  // The only programs ever started: sc.exe and icacls.exe by their full System32 path, and ONE more - `launch-check` of the INSTALLED Control Plane host, with a minimal environment. Nothing from the repository tree.
  const calls = [...script.matchAll(/Invoke-Native\s+(\S+)/gu)].map((m) => m[1]).filter((first) => !first.startsWith('('));
  assert.ok(calls.length >= 6);
  for (const first of calls) assert.ok(first === '$ScExe' || first === '$IcaclsExe' || first === '$L.ControlPlaneExe', `Invoke-Native is only called with sc.exe, icacls.exe or the installed host, saw ${first}`);
  const hostCalls = script.split('\n').filter((line) => /Invoke-Native \$L\.ControlPlaneExe/u.test(line));
  assert.equal(hostCalls.length, 1, 'one call starts the installed host');
  assert.match(hostCalls[0], /'launch-check ' \+ \(Quote-NativeArg \$L\.ControlPlaneConfig\)\) 60000 -MinimalEnvironment/u, 'and it is launch-check, with a minimal environment');
  assert.ok(script.indexOf('Invoke-Native $L.ControlPlaneExe') > script.indexOf('function Invoke-LaunchCheck') && script.indexOf('Invoke-Native $L.ControlPlaneExe') < script.indexOf('function New-ControlPlaneService'), 'only Invoke-LaunchCheck does it');
  assert.match(script, /\$psi\.EnvironmentVariables\.Clear\(\)/u, 'a minimal environment clears everything inherited first');
  // Processes are stopped by PID only, and only by the migration, and only those the legacy account owns (found by owner SID); never by image name.
  assert.doesNotMatch(script + lib, /taskkill|Stop-Process|GetProcessesByName|Get-Process\b|Process\]::GetProcesses\(|ProcessName/iu, 'no process is found or stopped by name');
  assert.equal([...script.matchAll(/\.Kill\(\)/gu)].length, 2, 'Kill appears twice: Invoke-Native\'s own timeout and the migration\'s PID stop');
  assert.match(script, /function End-ProcessById\(\[int\]\$Id\) \{\s*\n\s*\$process = \[System\.Diagnostics\.Process\]::GetProcessById\(\$Id\)\s*\n\s*\$process\.Kill\(\)/u, 'the PID stop lives in one small function');
  assert.equal([...script.matchAll(/End-ProcessById /gu)].length, 1, 'and one caller: the migration');
  assert.match(script, /\$owner\.Sid -ceq \$Sid/u, 'the PIDs come from the owner SID');
  for (const tool of ['sc.exe', 'icacls.exe']) assert.match(script, new RegExp(`Join-Path \\$SystemDirectory '${tool.replace('.', '\\.')}'`, 'u'), `${tool} is started by its full path under the system directory Windows reports`);
  for (const gone of [/service-check ['"]\s*\+/u, /Test-BuiltExe/u, /LabApproverValues/u, /\$ApproverExe/u, /Get-ApproverExePath/u, /ExpectedHashes/u, /Read-ExpectedHashes|Compare-FileHashSets|Test-PathInside/u]) assert.doesNotMatch(script + lib, gone, `removed: ${gone}`);
  // No environment variable decides a path (HKCU\Environment can set them and an elevated console inherits them); only the ALBERA_* switches are read, never as paths.
  for (const text of [script, lib]) {
    const reads = [...text.matchAll(/\$env:([A-Za-z_]+)/gu)].map((m) => m[1]);
    assert.deepEqual([...new Set(reads)].sort(), text === script ? ['ALBERA_HOST_ASSUME_NOT_ELEVATED', 'ALBERA_LAB_VM', 'PSModulePath'] : []);   // PSModulePath is only ever SET (to the system module folder), never read
    assert.doesNotMatch(text, /Get-Command|\[Environment\]::GetEnvironmentVariable|\$env:PATH|Set-Item Env:/iu);
  }
  assert.match(script, /\$SystemDirectory = \[Environment\]::SystemDirectory/u);
  assert.match(script, /GetFolderPath\('ProgramFiles'\)/u);
  assert.match(script, /GetFolderPath\('CommonApplicationData'\)/u);
  assert.match(script, /\$ScExe = Join-Path \$SystemDirectory 'sc\.exe'/u);
  assert.ok(script.indexOf('Test-FixedFolders') < script.indexOf('$L = Get-HostLayout'), 'the standard-folder refusal comes before the layout is built');
  // every command example and the header use the same start line: the full path of powershell.exe (cmd.exe prefers a powershell.exe in the current folder)
  const START = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File `;
  assert.ok(script.includes(`# Start it ALWAYS as   ${START}scripts\\host\\albera-host.ps1`));
  const doc = readFileSync(path.join(root, 'docs', 'architecture', 'host-install.md'), 'utf8');
  const examples = doc.split('\n').filter((l) => /powershell(?:\.exe)? +-(?:NoProfile|File)/u.test(l.replace(/`/gu, '')));
  assert.ok(examples.length >= 4);
  for (const line of examples) assert.ok(line.trimStart().replace(/^`/u, '').startsWith(START), `doc example without the full path: ${line.slice(0, 90)}`);   // list items indent their code blocks
  assert.equal(/^powershell\b/mu.test(doc), false);
  // the old false claim (-NoProfile keeps user modules out) is gone from the doc and the header; the true statement is there
  for (const text of [doc, script]) assert.doesNotMatch(text, /profiles and user modules (?:would otherwise )?load even in an elevated console/u);
  assert.match(doc, /`-NoProfile` skips profiles only; it does \*\*not\*\* keep user modules out/u);
  assert.match(script, /-NoProfile skips profiles ONLY/u);
  // the module guard comes first: nothing but .NET and Import-Module runs before the five system modules are imported by manifest path, and nothing is dot-sourced before that
  const guardStart = script.indexOf("$PSModuleAutoLoadingPreference = 'None'");
  const importAt = script.indexOf('Import-Module -Name $manifestPath');
  assert.ok(script.indexOf('param(') < guardStart && guardStart < script.indexOf('$env:PSModulePath = [System.IO.Path]::Combine($PSHOME') && script.indexOf('$env:PSModulePath') < importAt);
  assert.ok(importAt < script.indexOf('$ErrorActionPreference'));
  assert.ok(importAt < script.indexOf("albera-host-lib.ps1')"), 'the lib is dot-sourced only after the imports');
  const guard = script.slice(guardStart, importAt);
  assert.doesNotMatch(guard, /\b(?:Write-Host|Join-Path|Test-Path|Get-ChildItem|Split-Path|Sort-Object|Select-Object|New-Object|Get-Item|Resolve-Path|Get-Date|Write-Output)\b/u, 'only .NET before the imports');
  for (const name of ['Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security', 'CimCmdlets', 'Microsoft.PowerShell.LocalAccounts']) assert.ok(guard.includes(`'${name}'`), `${name} is imported by path`);
  assert.match(guard, /C:\\Windows\\System32\\WindowsPowerShell\\v1\.0/u);
  assert.doesNotMatch(script + lib, /Import-Module\s+(?!-Name \$manifestPath)/u, 'no other Import-Module');
  assert.doesNotMatch(script, /Invoke-Native \$Exe|& \$Exe|& \$exe|\.manifest\.json/u, 'no sidecar manifest is trusted and no build is started');
  // Every icacls that changes something acts on the link itself, never its target.
  for (const line of script.split('\n').filter((l) => /Invoke-Native \$IcaclsExe/u.test(l))) assert.match(line, /\/L'?\)?/u, `icacls without /L: ${line.trim()}`);
  assert.match(script, /New-TrustedDirectory \$L\.DataRoot/u, 'the data root is born with its ACL and read back');
  assert.equal((script.match(/^\s*New-SecuredDirectory /gmu) ?? []).length, 1, 'only New-TrustedDirectory creates a folder (create, read back, trust test)');
  assert.doesNotMatch(script, /New-Item -ItemType Directory -Path \$(?:L\.DataRoot|L\.InstallRoot|entry\.Path)/u, 'no planned folder is created with New-Item and fixed afterwards');
});

// ---- the real script: plan, status, refusals ----

/** What a change would touch: local accounts, services, the two folders (names only), and the Albera keys. */
function snapshot() {
  const script = [
    '$users = @(Get-LocalUser | ForEach-Object { $_.Name } | Sort-Object)',
    '$services = @(Get-Service | ForEach-Object { $_.Name } | Sort-Object)',
    '$pd = Test-Path -LiteralPath (Join-Path $env:ProgramData "Albera"); $pf = Test-Path -LiteralPath (Join-Path $env:ProgramFiles "Albera")',
    '[ordered]@{ users = $users; services = $services; programData = $pd; programFiles = $pf } | ConvertTo-Json -Compress -Depth 3',
  ].join('; ');
  return lastJson(ps(['-Command', script]).stdout);
}

test('plan is the default: numbered steps, every object named, nothing changed', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  const before = snapshot();
  const output = host([]).stdout;
  assert.deepEqual(snapshot(), before, 'plan changed nothing');
  assert.match(output, /PLAN ONLY/u);
  assert.match(output, /nothing was changed/iu);
  const numbered = [...output.matchAll(/^\s*(\d+)\. \[(todo|done|blocked|unknown)\] /gmu)].map((m) => Number(m[1]));
  assert.deepEqual(numbered, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], 'thirteen numbered steps, in order');
  for (const needle of [
    'AlberaHostBroker', 'AlberaApprovalAuthority', 'AlberaControlPlane', 'restricted SID', 'SeChangeNotifyPrivilege', 'start=delayed-auto', 'SERVICE_QUERY_STATUS',
    'AlberaApprovalAuthority-host-1', 'Export Policy none', 'install-manifest.json', 'albera.approval.json', 'AlberaControlPlane.service.json', '-ExpectedTreeHash', 'born with', 'tree hash', 'inheritance removed', 'no policy.json',
    '-ApproverPublicKey', 'service-check is not run', 'C:\\Program Files\\Albera', 'C:\\ProgramData\\Albera', 'launch-check', 'node.exe', 'claude.exe', 'Open ALBERA', 'HKLM', 'control-plane-config', 'secrets', 'ui',
  ]) assert.ok(output.includes(needle), `the plan names ${needle}`);
  assert.doesNotMatch(output, /albera-cp/u, 'the new layout has no local account');
  assert.match(output, /start by themselves, delayed/u, 'the plan says the services start by themselves');
  assert.match(output, /you can start them now/u, 'and that the owner may start them now');
  assert.doesNotMatch(output, /password\s*[:=]\s*\S/iu);
  assert.match(output, /\[blocked\] Check -ExpectedTreeHash/u, 'without -ExpectedTreeHash the plan says install is blocked');
});

test('plan: blocked without the tree hash typed from the CI log and without publish folders; the approver values are required; a malformed tree hash is refused with exit 2', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const empty = scratch(t);
  const noBuilds = host(['-Mode', 'plan', '-RepoRoot', empty, '-ExpectedTreeHash', 'a'.repeat(64), '-ApproverKeyId', 'hello-0123456789abcdef']).stdout;
  assert.match(noBuilds, /\[blocked\] Check -ExpectedTreeHash/u);
  assert.match(noBuilds, /broker: publish folder missing \(run npm run build:windows-broker\)/u);
  assert.match(noBuilds, /\[blocked\] Check the approver values/u);
  assert.match(noBuilds, /-ApproverKeyId, -ApproverPublicKey and -ApproverSid are all required/u);
  const noHash = host(['-Mode', 'plan', '-RepoRoot', empty]).stdout;
  assert.match(noHash, /-ExpectedTreeHash <64 hex> is required/u);
  assert.match(noHash, /CI log/u);
  for (const bad of ['abc', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}g`]) {
    const result = host(['-Mode', 'plan', '-ExpectedTreeHash', bad], { allowFail: true });
    assert.equal(result.code, 2, bad);
    assert.match(result.stdout, /64 lowercase hex/u);
  }
  assert.equal(host(['-Mode', 'plan', '-ExpectedHashes', 'C:\\x\\h.json'], { allowFail: true }).code === 0, false, 'the file parameter is gone: no file input anymore');
});

test('plan for uninstall lists the eight removal steps and says what it refuses to delete', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  const before = snapshot();
  const output = host(['-Mode', 'plan', '-PlanFor', 'uninstall']).stdout;
  assert.deepEqual(snapshot(), before);
  assert.deepEqual([...output.matchAll(/^\s*(\d+)\. \[/gmu)].map((m) => Number(m[1])), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.match(output, /only if (?:this script|it) created it|only if this script created it/u);
  assert.match(output, /refused for any folder that holds a file this script does not know/u);
});

test('status with nothing installed says so and exits 0 without touching anything', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  if (existsSync(path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Albera', 'install-manifest.json'))) return; // a real install is present on this PC: its status is not a unit-test matter
  const before = snapshot();
  const result = host(['-Mode', 'status']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not installed/u);
  assert.deepEqual(snapshot(), before);
});

test('install and uninstall refuse unless elevated (the seam can only make the script refuse more, so a test can never install for real)', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  const before = snapshot();
  for (const mode of ['install', 'uninstall']) {
    const result = host(['-Mode', mode, '-ApproverKeyId', 'hello-0123456789abcdef'], { env: { ALBERA_HOST_ASSUME_NOT_ELEVATED: '1' }, allowFail: true });
    assert.equal(result.code, 3, `${mode} exits 3`);
    assert.match(result.stdout, /REFUSED: .* needs an elevated console/u);
    assert.match(result.stdout, /never elevates itself/u);
    assert.doesNotMatch(result.stdout, /^\s*\d+\. /mu, 'no step ran');
  }
  assert.deepEqual(snapshot(), before);
});

test('bad approver values and ids are refused with exit 2 before anything is looked at; the lab password parameter is not reachable from outside', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  assert.equal(host(['-Mode', 'plan', '-ApproverKeyId', 'not valid!'], { allowFail: true }).code, 2);
  assert.equal(host(['-Mode', 'plan', '-ApproverSid', 'S-1-5-32-544'], { allowFail: true }).code, 2, 'a group SID is not an approver');
  assert.equal(host(['-Mode', 'plan', '-ApproverSid', 'S-1-5-80-1-2-3-4-5'], { allowFail: true }).code, 2, 'a service SID is not an approver');
  const badKey = host(['-Mode', 'plan', '-ApproverPublicKey', 'bm90IGEga2V5'], { allowFail: true });
  assert.equal(badKey.code, 2);
  assert.match(badKey.stdout, /not a base64 RSA-2048/u);
  assert.equal(host(['-Mode', 'plan', '-ProjectId', '../x'], { allowFail: true }).code, 2);
  assert.equal(host(['-Mode', 'bogus'], { allowFail: true }).code === 0, false);
  assert.equal(host(['-Mode', 'plan', '-LabApproverValues', '{}'], { allowFail: true }).code === 0, false, 'the old lab-only approver parameter is gone');
  assert.equal(host(['-Mode', 'plan', '-ApproverExe', 'C:\\x\\AlberaApprover.exe'], { allowFail: true }).code === 0, false, 'the script no longer takes a program to run');
});

test('-Mode hashes prints the per-file JSON and the tree hash line (for the CI run); the tree hash follows the documented format; links and missing folders are refused', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const repo = scratch(t);
  const folders = {
    broker: 'src/runtime/windows-broker/bin/Release/net10.0-windows/win-x64/publish',
    authority: 'src/runtime/windows-approval-authority/bin/Release/net10.0-windows/win-x64/publish',
    'pipe-client': 'src/runtime/windows-broker-pipe-client/bin/Release/net10.0-windows/win-x64/publish',
    'control-plane': 'src/runtime/windows-control-plane-host/bin/Release/net10.0-windows/win-x64/publish',
    approver: 'src/runtime/windows-approver/bin/Release/net10.0-windows10.0.19041.0/win-x64/publish',
  };
  assert.match(host(['-Mode', 'hashes', '-RepoRoot', repo], { allowFail: true }).stdout, /REFUSED: broker: publish folder missing/u);
  const contents = {};
  for (const [name, rel] of Object.entries(folders)) {
    mkdirSync(path.join(repo, rel, 'sub'), { recursive: true });
    contents[name] = { [`${name}.exe`]: `exe ${name}`, 'sub/data.json': `{"n":"${name}"}`, 'lib.dll': randomBytes(32).toString('hex') };
    for (const [file, text] of Object.entries(contents[name])) writeFileSync(path.join(repo, rel, file), text);
  }
  const lines = host(['-Mode', 'hashes', '-RepoRoot', repo]).stdout.trim().split(/\r?\n/u);
  assert.equal(lines.length, 2, 'one JSON line, one tree hash line');
  assert.deepEqual(Object.keys(JSON.parse(lines[0]).components), ['broker', 'authority', 'pipe-client', 'control-plane', 'approver'], 'the five components, in the order of the tree hash');
  const printed = JSON.parse(lines[0]);
  assert.equal(printed.version, 1);
  // the documented canonical listing, built here independently: <component>/<path> TAB <sha> LF, components broker, authority, pipe-client, control-plane, approver, paths ordinal-sorted
  let listing = '';
  for (const name of ['broker', 'authority', 'pipe-client', 'control-plane', 'approver']) {
    const expected = Object.fromEntries(Object.entries(contents[name]).map(([file, text]) => [file, createHash('sha256').update(text).digest('hex')]));
    assert.deepEqual(printed.components[name].files, expected, `${name}: every file, forward slashes, lowercase hex`);
    for (const rel of Object.keys(expected).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))) listing += `${name}/${rel}\t${expected[rel]}\n`;
  }
  const tree = createHash('sha256').update(listing, 'utf8').digest('hex');
  assert.equal(printed.treeHash, tree);
  assert.equal(lines[1], `ALBERA_HOST_TREE_HASH=${tree}`);
  // the printed value is exactly what -ExpectedTreeHash takes: the first plan step turns to todo; any other value stays blocked? (the copies are compared at install time, the plan only checks the format)
  assert.match(host(['-Mode', 'plan', '-RepoRoot', repo, '-ExpectedTreeHash', tree]).stdout, /\[todo\] Check -ExpectedTreeHash/u);
  // a link inside a publish folder is refused
  const target = scratch(t);
  const link = path.join(repo, folders.broker, 'link');
  const made = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0);
  assert.match(host(['-Mode', 'hashes', '-RepoRoot', repo], { allowFail: true }).stdout, /REFUSED: broker: the publish folder contains a link or junction/u);
  spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/c', 'rmdir', link], { windowsHide: true });
});

test('a fake CimCmdlets / LocalAccounts / Utility first in PSModulePath for the child process is never loaded: the script resets the module path and imports the system modules by path', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const fakes = scratch(t);
  const marker = path.join(fakes, 'marker.txt');
  const modules = path.join(fakes, 'Modules');
  const names = ['CimCmdlets', 'Microsoft.PowerShell.LocalAccounts', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security'];
  for (const name of names) {
    mkdirSync(path.join(modules, name), { recursive: true });
    writeFileSync(path.join(modules, name, `${name}.psd1`), `@{ RootModule = '${name}.psm1'; ModuleVersion = '9.9.9'; GUID = '${randomUUID()}'; FunctionsToExport = '*'; CmdletsToExport = @(); AliasesToExport = @() }\n`);
    // loading marks the file; the function a script would call returns HIJACKED
    writeFileSync(path.join(modules, name, `${name}.psm1`), `[System.IO.File]::AppendAllText($env:ALBERA_TEST_MARKER, 'loaded ${name}' + [Environment]::NewLine)\nfunction Get-CimInstance { 'HIJACKED' }\nfunction Get-LocalUser { 'HIJACKED' }\nfunction Get-Acl { 'HIJACKED' }\n`);
  }
  const env = { PSModulePath: modules, ALBERA_TEST_MARKER: marker };
  // control: an unprotected child with that PSModulePath DOES pick the fake up, so the test can fail
  const control = ps(['-Command', "Get-CimInstance Win32_OperatingSystem"], { env });
  assert.match(control.stdout, /HIJACKED/u, 'control: the fake module is found first by an ordinary session');
  assert.equal(existsSync(marker), true, 'control: the marker was written');
  rmSync(marker);
  // the real script, plan mode, same hostile environment
  const output = host([], { env }).stdout;
  assert.equal(existsSync(marker), false, 'no fake module was loaded by albera-host.ps1');
  assert.doesNotMatch(output, /HIJACKED/u);
  assert.match(output, /\[todo\] Create services AlberaHostBroker/u, 'the plan still ran, with the real CIM answers');
  assert.match(output, /PLAN ONLY: nothing was changed\./u);
  // status and uninstall plan go through the same guard
  host(['-Mode', 'status'], { env });
  host(['-Mode', 'plan', '-PlanFor', 'uninstall'], { env });
  assert.equal(existsSync(marker), false);
});

test('a PowerShell that is not the one in System32 (here the 32-bit one) is refused before anything else runs', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  const wow = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(wow)) return;
  const result = spawnSync(wow, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(hostDir, 'albera-host.ps1')], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 3);
  assert.match(result.stdout, /REFUSED: this is not the Windows PowerShell 5\.1 in C:\\Windows\\System32\\WindowsPowerShell\\v1\.0/u);
  assert.doesNotMatch(result.stdout, /PLAN ONLY/u);
});

test('the hash workflow: manual only, main only, prints the tree hash and one script hash per host script, and the doc tells the owner what to check', () => {
  const yml = readFileSync(path.join(root, '.github', 'workflows', 'host-build-hashes.yml'), 'utf8');
  assert.match(yml, /^on:\s*\n\s+workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(yml, /^\s+(?:push|pull_request|schedule):/mu, 'no automatic trigger: Windows minutes cost money');
  assert.match(yml, /^\s+if: github\.ref == 'refs\/heads\/main'\s*$/mu);
  assert.match(yml, /timeout-minutes: 30/u);
  assert.match(yml, /runs-on: windows-latest/u);
  assert.match(yml, /node-version: 24/u);
  assert.match(yml, /C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe -NoProfile -File scripts\/host\/albera-host\.ps1 -Mode hashes/u);
  assert.match(yml, /ALBERA_HOST_SCRIPT_SHA256=\$h \$f/u);
  assert.match(yml, /'albera-host\.ps1', 'albera-host-lib\.ps1'/u);
  assert.match(yml, /Write-Host "commit=\$env:GITHUB_SHA"/u);
  assert.match(yml, /Write-Host "ref=\$env:GITHUB_REF"/u);
  assert.match(yml, /upload-artifact@[0-9a-f]{40}/u);
  const doc = readFileSync(path.join(root, 'docs', 'architecture', 'host-install.md'), 'utf8');
  assert.match(doc, /branch badge under the run title says `main`/u);
  assert.match(doc, /merge commit of PR #148/u);
  assert.match(doc, /A branch can edit the workflow file it runs from/u);
  // the script is hashed and run as a COPY in an administrator-only folder, from a clean elevated cmd /d (Zaku: COR_PROFILER and cmd AutoRun act before line 1)
  assert.match(doc, /C:\\Windows\\System32\\certutil\.exe -hashfile "C:\\Program Files\\AlberaSetup\\albera-host\.ps1" SHA256/u);
  assert.match(doc, /C:\\Windows\\System32\\certutil\.exe -hashfile "C:\\Program Files\\AlberaSetup\\albera-host-lib\.ps1" SHA256/u);
  assert.match(doc, /-File "C:\\Program Files\\AlberaSetup\\albera-host\.ps1" -RepoRoot <repo> -Mode install/u);
  assert.match(doc, /type `cmd \/d`, press \*\*Ctrl\+Shift\+Enter\*\*/u);
  for (const v of ['set COR_', 'set COMPLUS_', 'set CORECLR_']) assert.ok(doc.includes(v), v);
  assert.match(doc, /reg\.exe query "HKCU\\Software\\Microsoft\\Command Processor" \/v AutoRun/u);
  assert.match(doc, /they detect nothing/u);
  assert.match(doc, /ALBERA_HOST_SCRIPT_SHA256=<hex> albera-host\.ps1/u);
  assert.match(doc, /Residual limit, stated plainly/u);
  // certutil and the workflow agree on the bytes: the repository pins LF
  assert.match(readFileSync(path.join(root, '.gitattributes'), 'utf8'), /eol=lf/u);
});

/** Every `permissions:` block of a workflow as { indent, entries }, read by indentation (no YAML parser in the repo). */
const permissionBlocks = (yml) => {
  const lines = yml.split('\n');
  const blocks = [];
  lines.forEach((line, i) => {
    const head = /^( *)permissions:(.*)$/u.exec(line);
    if (!head) return;
    const indent = head[1].length;
    const entries = {};
    if (head[2].trim()) entries['*'] = head[2].trim();   // permissions: write-all / read-all
    for (const next of lines.slice(i + 1)) {
      const entry = /^( *)([a-z-]+):\s*(\S+)\s*$/u.exec(next);
      if (!entry || entry[1].length <= indent) break;
      entries[entry[2]] = entry[3];
    }
    blocks.push({ indent, entries });
  });
  return blocks;
};

test('the hash workflow signs build provenance for the five exe files, the app tree hash list, the two host scripts, build-hashes.json and the three files of setup, with only the permissions that needs; the installer script does not consume it', () => {
  const yml = readFileSync(path.join(root, '.github', 'workflows', 'host-build-hashes.yml'), 'utf8');
  assert.deepEqual(permissionBlocks(yml), [
    { indent: 0, entries: { contents: 'read' } },
    { indent: 4, entries: { contents: 'read' } },
    { indent: 4, entries: { contents: 'read', 'id-token': 'write', attestations: 'write' } },
    { indent: 4, entries: { contents: 'read', attestations: 'read' } },
  ], 'workflow level stays read-only; only the attest job (no npm, dotnet or node, runs nothing the build made) has an OIDC token; the build job has none and the verify job (which runs gh and setup) may only read attestations (no packages, artifact-metadata, write-all ...)');
  assert.match(yml, /^\s+if: github\.ref == 'refs\/heads\/main'\s*$/mu, 'the job still refuses any branch but main');
  const uses = [...yml.matchAll(/uses:\s*(actions\/attest\S*)/gu)].map((m) => m[1]);
  assert.equal(uses.length, 1, 'one attest step');
  assert.match(uses[0], /^actions\/attest-build-provenance@[0-9a-f]{40}$/u, 'pinned to a commit SHA like every other action');
  const attest = yml.indexOf('actions/attest-build-provenance@');
  for (const before of ['npm run build:windows-broker', 'npm run build:approval-authority', 'npm run build:control-plane', 'npm run build:approver', '-Mode hashes', 'build-hashes.json", $json[0]']) assert.ok(yml.indexOf(before) > 0 && yml.indexOf(before) < attest, `the attest step runs after: ${before}`);
  assert.ok(yml.indexOf('npm run build:control-plane') < yml.indexOf('-Mode hashes') && yml.indexOf('npm run build:approver') < yml.indexOf('-Mode hashes'), 'both new components are built before they are hashed');
  assert.match(yml, /- name: Build the Control Plane host and its app tree \(build only; never installed or started\)\n        run: npm run build:control-plane\n/u);
  assert.match(yml, /- name: Build the approver app \(build only; never installed or started\)\n        run: npm run build:approver\n/u);
  assert.doesNotMatch(yml, /push-to-registry|create-storage-record|subject-digest|subject-checksums/u);
  const block = /subject-path: \|\n((?: {12}\S.*\n)+)/u.exec(yml);
  assert.ok(block, 'subject-path is a literal block of paths');
  const subjects = block[1].trim().split('\n').map((line) => line.trim());
  // The exe paths are the ones the installer copies from (Get-BuildSources in albera-host.ps1), so the two cannot drift apart.
  const script = readFileSync(path.join(hostDir, 'albera-host.ps1'), 'utf8');
  const exes = [...script.matchAll(/Dir = Join-Path \$r '([^']+)'; Exe = '([^']+)'/gu)].map((m) => `${m[1].replaceAll('\\', '/')}/${m[2]}`);
  assert.equal(exes.length, 5, 'the five build sources are found (false-safe)');
  // PR6 adds the setup program, the bundled gh.exe and the trusted root (test/runtime-windows-setup-source.test.mjs checks them against setup's own layout).
  // PR7: the host publish folder and the approver publish folder join the three; control-plane-app-hashes.json (written BESIDE the host's publish folder by build:control-plane-app) is attested as well
  assert.deepEqual(subjects, [...exes, 'src/runtime/windows-control-plane-host/bin/Release/net10.0-windows/win-x64/control-plane-app-hashes.json', 'scripts/host/albera-host.ps1', 'scripts/host/albera-host-lib.ps1', 'build-hashes.json', 'src/runtime/windows-setup/bin/Release/net10.0-windows/win-x64/publish/albera-setup.exe', 'setup-input/gh.exe', 'setup-input/trusted_root.jsonl']);
  // Provenance is an extra check for the owner, not an input of the installer (consuming it is a separate security change).
  for (const file of ['albera-host.ps1', 'albera-host-lib.ps1']) assert.doesNotMatch(readFileSync(path.join(hostDir, file), 'utf8'), /gh attestation|attest-build-provenance|sigstore/iu, file);
  const doc = readFileSync(path.join(root, 'docs', 'architecture', 'host-install.md'), 'utf8');
  assert.ok(doc.includes('gh attestation verify <file> --repo BERORINPO/albera --signer-workflow BERORINPO/albera/.github/workflows/host-build-hashes.yml'), 'the verify command pins this repository and this workflow');
  assert.match(doc, /\*\*It is not Windows code signing\.\*\*.*UAC and SmartScreen still show an unknown publisher/u);
  assert.match(doc, /\*\*It does not replace `-ExpectedTreeHash` yet\.\*\* The installer does not read attestations/u);
});

// ---- the pure helpers ----

const lib = (() => {
  let cached;
  return () => {
    if (cached) return cached;
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = ec.publicKey.export({ format: 'jwk' });
    const spki = (key) => key.export({ type: 'spki', format: 'der' }).toString('base64');
    const rsa2048 = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    const rsa3072 = generateKeyPairSync('rsa', { modulusLength: 3072 }).publicKey;
    const inputs = { ecSpki: spki(ec.publicKey), rsa2048: spki(rsa2048), rsa3072: spki(rsa3072) };
    const stdout = ps(['-File', path.join(driverDir, 'lib-checks.ps1'), '-EcX', jwk.x, '-EcY', jwk.y, '-EcSpki', inputs.ecSpki, '-Rsa2048Spki', inputs.rsa2048, '-Rsa3072Spki', inputs.rsa3072]).stdout;
    cached = { r: lastJson(stdout), inputs };
    return cached;
  };
})();
const needsWindows = { skip: !windows && 'Windows PowerShell only', timeout: 240_000 };

test('layout: every path is a plain absolute path under the two roots, the data root holds only what the install creates', needsWindows, () => {
  const { r } = lib();
  assert.equal(r.layout.BrokerExe, 'C:\\Program Files\\Albera\\bin\\broker\\albera-windows-broker.exe');
  assert.equal(r.layout.AuthorityExe, 'C:\\Program Files\\Albera\\bin\\authority\\albera-approval-authority.exe');
  assert.equal(r.layout.PipeClientExe, 'C:\\Program Files\\Albera\\bin\\pipe-client\\albera-windows-broker-pipe-client.exe');
  assert.equal(r.layout.ManifestPath, 'C:\\ProgramData\\Albera\\install-manifest.json');
  assert.equal(r.layout.ApprovalSettings, 'C:\\ProgramData\\Albera\\control-plane-config\\albera.approval.json', 'the settings moved out of the folder the service can write');
  assert.equal(r.layout.ControlPlaneConfig, 'C:\\ProgramData\\Albera\\control-plane-config\\AlberaControlPlane.service.json');
  assert.equal(r.layout.ControlPlaneJournal, 'C:\\ProgramData\\Albera\\control-plane\\operations.sqlite', 'the journal stays in the one folder the service can write');
  assert.equal(r.layout.ControlPlaneLogDir, 'C:\\ProgramData\\Albera\\control-plane\\logs');
  assert.equal(r.layout.SecretsDir, 'C:\\ProgramData\\Albera\\secrets');
  assert.equal(r.layout.UiDir, 'C:\\ProgramData\\Albera\\ui');
  assert.equal(r.layout.LegacyApprovalSettings, 'C:\\ProgramData\\Albera\\control-plane\\albera.approval.json', 'where the first layout kept it');
  assert.equal(r.layout.ControlPlaneExe, 'C:\\Program Files\\Albera\\bin\\control-plane\\albera-control-plane-host.exe');
  assert.equal(r.layout.ControlPlaneAppDir, 'C:\\Program Files\\Albera\\bin\\control-plane\\app');
  assert.equal(r.layout.ControlPlaneNodeExe, 'C:\\Program Files\\Albera\\bin\\control-plane\\node\\node.exe');
  assert.equal(r.layout.ClaudeExe, 'C:\\Program Files\\Albera\\bin\\claude\\claude.exe');
  assert.equal(r.layout.ApproverExe, 'C:\\Program Files\\Albera\\bin\\approver\\AlberaApprover.exe');
  assert.equal(r.layout.OpenScript, 'C:\\Program Files\\Albera\\bin\\launcher\\open-albera.ps1');
  assert.equal(r.layout.OpenShortcut, 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\ALBERA\\Open ALBERA.lnk');
  assert.equal(r.layout.UpdateShortcut, 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\ALBERA\\ALBERA update.lnk');
  for (const key of ['BrokerConfig', 'BrokerDb', 'AuthorityConfig', 'ControlPlaneConfig', 'ApprovalSettings', 'ControlPlaneJournal', 'ControlPlaneLogDir', 'SecretsDir', 'UiDir']) assert.ok(r.layout[key].startsWith(r.layout.DataRoot + '\\'));
  for (const key of ['ControlPlaneExe', 'ControlPlaneAppDir', 'ControlPlaneNodeExe', 'ClaudeExe', 'ApproverExe', 'OpenScript']) assert.ok(r.layout[key].startsWith(r.layout.InstallRoot + '\\bin\\'), key);
  assert.equal(r.layout.ControlPlaneNodeExe.startsWith(r.layout.ControlPlaneBinDir + '\\node\\'), true, 'the pinned node sits inside the control-plane component folder (administrator-only), in its own node\\ folder');
  // the broker database folder and config folder are different folders: the config is read-only for the service, the database folder is its own
  assert.notEqual(path.win32.dirname(r.layout.BrokerConfig), path.win32.dirname(r.layout.BrokerDb));
  assert.equal(r.constants.ControlPlaneService, 'AlberaControlPlane');
  assert.equal(r.constants.ControlPlaneUser, 'albera-cp', 'only the legacy account of the first layout keeps its name (migration and uninstall remove it)');
  // the legacy account's description (48 characters at most, New-LocalUser's limit) is what Remove-LocalUser checks before it removes anything
  const description = r.constants.ControlPlaneUserDescription;
  assert.ok(description.length > 0 && description.length <= 48, `description is ${description.length} characters`);
  assert.match(description, /^[ -~]+$/u);
  const script = readFileSync(path.join(hostDir, 'albera-host.ps1'), 'utf8');
  assert.doesNotMatch(script, /New-LocalUser|Add-LocalGroupMember -SID 'S-1-5-32-545'/u, 'nothing creates the account any more');
  assert.match(readFileSync(path.join(hostDir, 'albera-host-lib.ps1'), 'utf8'), /\$Live\.Description -cne \$c\.ControlPlaneUserDescription/u, 'uninstall compares the same constant');
});

test('derived service SIDs equal the C# derivation (the TrustedInstaller vector pinned by the C# harness)', needsWindows, () => {
  const { r } = lib();
  assert.equal(r.sidTrustedInstaller, 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');
  assert.equal(r.sidCaseInsensitive, true);
  assert.match(r.sidBroker, /^S-1-5-80(-\d+){5}$/u);
  assert.match(r.sidAuthority, /^S-1-5-80(-\d+){5}$/u);
  assert.notEqual(r.sidBroker, r.sidAuthority);
});

test('SPKI: built from a P-256 public blob it equals Node\'s own export; wrong shapes are refused; RSA-2048 is told from other sizes', needsWindows, () => {
  const { r, inputs } = lib();
  assert.equal(r.spkiBuilt, inputs.ecSpki);
  assert.equal(r.spkiMatchesNode, true);
  assert.equal(r.spkiRoundTripBlob, true);
  assert.deepEqual(r.p256Accepts, [true, true]);
  assert.deepEqual(r.p256Rejects, [false, false, false, false]);
  assert.equal(r.badBlobRefused, true);
  assert.equal(r.rsaAccepts, true);
  assert.deepEqual(r.rsaRejects, [false, false, false]);
  assert.doesNotThrow(() => createPublicKey({ key: Buffer.from(r.spkiBuilt, 'base64'), format: 'der', type: 'spki' }));
});

test('approver values (given as parameters): a different key id, a non-user or equal SID, and a non-RSA-2048 key are each refused with a reason', needsWindows, () => {
  const { r, inputs } = lib();
  assert.deepEqual({ ...r.shown }, { approverPublicKey: inputs.rsa2048, approverKeyId: 'hello-0123456789abcdef', approverSid: 'S-1-5-21-1111111111-2222222222-3333333333-1001' });
  assert.equal(r.approverOk, 0);
  assert.deepEqual(r.approverWrongId, ['approver_key_id_differs_from_expected']);
  assert.deepEqual(r.approverSameSid, ['approver_sid_equals_control_plane_sid']);
  assert.deepEqual(r.approverVirtualSid, ['approver_sid_not_a_user_sid']);
  assert.deepEqual(r.approverGroupSid, ['approver_sid_not_a_user_sid']);
  assert.deepEqual(r.approverBadKey, ['approver_public_key_not_rsa2048_spki']);
});

test('the generated configs have exactly the key sets the C# parsers accept, and they pass the script\'s mirror of the C# checks', needsWindows, () => {
  const { r } = lib();
  const csKeys = (file, name) => {
    const text = readFileSync(path.join(root, 'src', 'runtime', file), 'utf8');
    const match = text.match(new RegExp(`${name} = \\[([^\\]]+)\\]`, 'u'));
    assert.ok(match, `${file} declares ${name}`);
    return [...match[1].matchAll(/"([A-Za-z]+)"/gu)].map((m) => m[1]).sort();
  };
  const broker = JSON.parse(r.brokerJson);
  const authority = JSON.parse(r.authorityJson);
  assert.deepEqual(Object.keys(broker).sort(), csKeys('windows-broker/ServiceConfig.cs', 'string\\[\\] Keys'));
  assert.deepEqual(Object.keys(authority).sort(), csKeys('windows-approval-authority/AuthorityConfig.cs', 'string\\[\\] Keys'));
  assert.deepEqual(Object.keys(broker.authorityKeys[0]).sort(), csKeys('windows-broker/ServiceConfig.cs', 'string\\[\\] AuthorityKeyFields'));
  assert.deepEqual([r.brokerReasons, r.authorityReasons], [[], []]);
  assert.equal(r.policyVersionsEqual, true, 'the Broker and the Authority name the same policyVersion (the Broker compares it with what the Authority signs)');
  assert.equal(broker.controlPlaneSid, authority.controlPlaneSid);
  assert.notEqual(authority.controlPlaneSid, authority.approverSid);
  assert.equal(authority.signingKeyProvider, 'software');
  assert.equal(authority.audience, 'albera-host-broker', 'the Broker config audience is fixed in the Broker (BrokerAudience); the Authority must sign the same');
  assert.match(readFileSync(path.join(root, 'src', 'runtime', 'windows-broker', 'BrokerRequests.cs'), 'utf8'), /BrokerAudience = "albera-host-broker"/u);
  assert.equal(broker.authorityKeys.length, 1);
  assert.equal(broker.authorityKeys[0].kid, authority.kid, 'the receipt names its key by kid: the Broker pins the key under the kid the Authority signs');
  assert.equal(broker.database, r.layout.BrokerDb);
  assert.ok(!('attestationKeyId' in authority), 'no attestation key is pinned: tier careful, a person for every action');
  assert.ok(JSON.stringify(broker).length < 4096 && JSON.stringify(authority).length < 4096);
});

test('config checks refuse what the C# parsers refuse (extra or missing key, relative / slash path, group or ALL SERVICES SID, generation 0, non-P-256 key, one SID for both pipes ...)', needsWindows, () => {
  const { r } = lib();
  const expectations = {
    extraKey: 'config_keys', missingKey: 'config_keys', relativeDb: 'database', slashDb: 'database', groupSid: 'control_plane_sid', allServicesSid: 'control_plane_sid',
    generationZero: 'generation', rsaKey: 'authority_keys', badPipe: 'pipe_name', notJson: 'config_syntax', tooBig: 'config_too_large',
  };
  for (const [name, reason] of Object.entries(expectations)) assert.ok(r.brokerBad[name].includes(reason), `broker ${name} -> ${reason}, got ${JSON.stringify(r.brokerBad[name])}`);
  const authorityExpect = {
    sameSid: 'sids_not_distinct', approverVirtual: 'approver_sid', pipeRootLower: 'pipe_root', providerOther: 'signing_provider', audienceUpper: 'audience',
    numberValue: 'config_keys', ecApproverKey: 'approver_public_key', extraKey: 'config_keys',
  };
  for (const [name, reason] of Object.entries(authorityExpect)) assert.ok(r.authorityBad[name].includes(reason), `authority ${name} -> ${reason}, got ${JSON.stringify(r.authorityBad[name])}`);
});

test('the Control Plane settings the script writes are accepted by the Control Plane\'s own parser (no secret, no attestation key, one computer)', needsWindows, () => {
  const { r } = lib();
  const settings = parseApprovalSettings(r.settingsJson);
  assert.equal(settings.projectId, 'albera-host');
  assert.equal(settings.attestation, null, 'the parser reads the missing key as null');
  assert.equal('attestation' in JSON.parse(r.settingsJson), false, 'PR #185 hand-over: the settings carry no attestation key');
  assert.deepEqual([...settings.computers], [['albera-clone-01', { computerId: 'clone-01' }]]);
  assert.deepEqual(settings.broker, { pipeName: r.constants.BrokerPipeName, expect: { serviceName: 'AlberaHostBroker' } });
  assert.deepEqual(settings.authority, { pipeRoot: r.constants.AuthorityPipeRoot, expect: { serviceName: 'AlberaApprovalAuthority' } });
  assert.equal(settings.journal, r.layout.ControlPlaneJournal);
  assert.equal(path.win32.dirname(settings.journal), r.layout.ControlPlaneDir, 'the journal sits in the folder the Control Plane service may write');
  assert.notEqual(path.win32.dirname(settings.journal), path.win32.dirname(r.layout.ApprovalSettings), 'and the settings file is NOT in it: the service can read the settings and not rewrite the helper pin');
  assert.equal(/secret|password|token|key/iu.test(r.settingsJson.replace(/"keyFile"/gu, '')), false);
});

test('the Control Plane settings of an install WITHOUT the grant are what they were before the desktop block existed, minus the attestation key (no desktop key, even when the helper hash is empty)', needsWindows, () => {
  const { r } = lib();
  const before = {
    version: 1, projectId: 'albera-host',
    broker: { pipeName: 'ALBERA_HostBroker', expect: { serviceName: 'AlberaHostBroker' } },
    authority: { pipeRoot: 'ALBERA\\ApprovalAuthority', expect: { serviceName: 'AlberaApprovalAuthority' } },
    journal: 'C:\\ProgramData\\Albera\\control-plane\\operations.sqlite',
    computers: { 'albera-clone-01': 'clone-01' },
  };
  assert.equal(r.settingsJson, JSON.stringify(before));
  assert.deepEqual({ ...r.desktopPlainSame }, { noArgument: true, nullSha: true, emptySha: true, hasNoDesktopKey: true });
});

test('the Control Plane settings of an install WITH the grant carry the desktop block the gated room requires: the installed helper path and the helper SHA-256, after computers, nothing else changed', needsWindows, () => {
  const { r } = lib();
  const withDesktop = JSON.parse(r.desktopSettingsJson);
  assert.deepEqual(r.desktopKeys, ['version', 'projectId', 'broker', 'authority', 'journal', 'computers', 'desktop']);
  assert.deepEqual(withDesktop.desktop, { helperPath: r.layout.PipeClientExe, helperSha256: r.desktopHelperSha });
  assert.equal(r.layout.PipeClientExe, 'C:\\Program Files\\Albera\\bin\\pipe-client\\albera-windows-broker-pipe-client.exe', 'the path the room example and the doc name');
  const { desktop, ...rest } = withDesktop;
  assert.deepEqual(rest, JSON.parse(r.settingsJson), 'every other key and value is the plain settings');
  assert.equal('attestation' in withDesktop, false);
  assert.equal(/secret|password|token/iu.test(r.desktopSettingsJson), false, 'a path and a public hash only');
  for (const [name, message] of Object.entries(r.desktopBadSha)) assert.equal(message, 'helper_sha256_invalid', `${name}: only 64 lowercase hex characters`);
  assert.deepEqual({ ...r.desktopHasKey }, { plain: false, withBlock: true, nullBlock: true, notJson: false });
  assert.deepEqual({ ...r.desktopCheck }, {
    same: true, plainFile: false, otherSha: false, upperSha: false, otherPath: false, extraKey: false, missingKey: false, desktopIsString: false, shaIsNumber: false, notJson: false, empty: false,
  });
});

test('the settings the installer writes with the grant are accepted by the Control Plane\'s own parser AND by the gated room (the desktop client gets the pinned helper and a service-name expectation); without the grant the room refuses them', needsWindows, async () => {
  const { r } = lib();
  const settings = parseApprovalSettings(r.desktopSettingsJson);
  assert.deepEqual({ ...settings.desktop }, { helperPath: r.layout.PipeClientExe, helperSha256: r.desktopHelperSha });
  assert.equal(settings.attestation, null);
  assert.equal(path.win32.dirname(settings.journal), r.layout.ControlPlaneDir, 'the journal is in the folder the Control Plane service may write, and the settings file is not');
  assert.deepEqual(settings.broker.expect, { serviceName: 'AlberaHostBroker' }, 'a service name only: the room refuses a PID or an image hash');
  assert.deepEqual([...settings.computers.keys()], ['albera-clone-01']);
  // the room itself: nothing is opened (fake store, fake desktop client)
  const openRoom = (text, seen) => openRoomApproval({
    approvalFile: 'C:\\settings.json', jobs: [{ vmId: 'albera-clone-01', task: 'open the page' }],
    io: { statSync: () => ({ isFile: () => true, size: text.length }), readFileSync: () => text },
    deps: { createDesktopClient: (options) => { seen.options = options; return { close: async () => {} }; }, openStore: async () => ({ flowJournal: () => ({ begin: async () => {}, advance: async () => {}, get: async () => null }), close() {} }) },
  });
  const seen = {};
  const room = await openRoom(r.desktopSettingsJson, seen);
  room.close();
  assert.deepEqual(seen.options, { pipeName: 'ALBERA_HostBroker', expect: { serviceName: 'AlberaHostBroker' }, helperPath: r.layout.PipeClientExe, helperSha256: r.desktopHelperSha });
  await assert.rejects(openRoom(r.settingsJson, {}), /runtime_room_approval_desktop/u, 'a plain install (no grant) has no desktop block: the room refuses it');
});

test('ACL plan: inheritance is removed everywhere, each service SID can write only its own folder, the Control Plane only its own (and READ-only settings), nobody else gets write', needsWindows, () => {
  const { r } = lib();
  const sids = { broker: r.sidBroker, authority: r.sidAuthority };
  const byPath = new Map(r.aclPlan.map((entry) => [entry.path, entry.grants]));
  // the first six entries are the ones the first layout had, in the same order; the Control Plane folders follow (aclPlan2 is the new layout, below)
  assert.deepEqual([...byPath.keys()].slice(0, 6), [r.layout.InstallRoot, r.layout.DataRoot, r.layout.BrokerConfigDir, r.layout.BrokerDbDir, r.layout.AuthorityDir, r.layout.ControlPlaneDir]);
  assert.deepEqual([...byPath.keys()], [r.layout.InstallRoot, r.layout.DataRoot, r.layout.BrokerConfigDir, r.layout.BrokerDbDir, r.layout.AuthorityDir, r.layout.ControlPlaneDir, r.layout.ControlPlaneLogDir, r.layout.ControlPlaneConfigDir, r.layout.SecretsDir, r.layout.UiDir]);
  const rights = (dir) => Object.fromEntries(byPath.get(dir).map((grant) => { const m = grant.match(/^\*(S-[0-9-]+):(.+)$/u); return [m[1], m[2]]; }));
  const cp = 'S-1-5-21-1111111111-2222222222-3333333333-1500';
  for (const grants of byPath.values()) {
    const g = Object.fromEntries(grants.map((grant) => { const m = grant.match(/^\*(S-[0-9-]+):(.+)$/u); return [m[1], m[2]]; }));
    assert.equal(g['S-1-5-18'], '(OI)(CI)F');
    assert.equal(g['S-1-5-32-544'], '(OI)(CI)F');
    assert.equal(Object.keys(g).every((sid) => sid === 'S-1-5-18' || sid === 'S-1-5-32-544' || [sids.broker, sids.authority, cp].includes(sid)), true, 'only SYSTEM, Administrators and the service SIDs are named');
  }
  // BUILTIN\Users are in NO planned folder, the install folder included: they get read and execute on bin\approver, bin\launcher and bin\setup only (Grant-UsersReadExecute), so bin\claude, bin\control-plane
  // (node.exe with it) and the .partial folders are not readable or runnable by the owner's session
  for (const [dir, grants] of byPath) {
    assert.deepEqual(grants.filter((grant) => grant.includes('S-1-5-32-545')), [], dir);
  }
  for (const entry of r.aclPlan2) assert.deepEqual(entry.grants.filter((grant) => grant.includes('S-1-5-32-545')), [], entry.path);
  const writers = (dir) => Object.entries(rights(dir)).filter(([sid, right]) => ![ 'S-1-5-18', 'S-1-5-32-544'].includes(sid) && /M$|F$/u.test(right)).map(([sid]) => sid);
  assert.deepEqual(writers(r.layout.InstallRoot), [], 'the binaries are read/execute only');
  assert.deepEqual(writers(r.layout.DataRoot), []);
  assert.deepEqual(writers(r.layout.BrokerConfigDir), [], 'the Broker cannot write its own config');
  assert.deepEqual(writers(r.layout.BrokerDbDir), [sids.broker]);
  assert.deepEqual(writers(r.layout.AuthorityDir), [sids.authority], 'the Authority writes policy.json next to its config');
  assert.deepEqual(writers(r.layout.ControlPlaneDir), [cp]);
  // the Control Plane journal (assertPrivateWindowsAcl) requires full control for its own user: Modify made the first real approval-check fail with journal_unavailable (2026-11-02)
  assert.equal(rights(r.layout.ControlPlaneDir)[cp], '(OI)(CI)F');
  const aclCheck = readFileSync(path.join(root, 'src', 'runtime', 'windows-acl.mjs'), 'utf8');
  assert.match(aclCheck, /\(rule\.rights & 0x001f01ff\) === 0x001f01ff\) currentUserHasFullControl = true/u, 'the journal still demands full control; if this changes, revisit the grant');
  assert.equal(rights(r.layout.DataRoot)[cp], 'RX', 'this-folder-only read: the control plane account can reach its folder and nothing else');
  // the new layout: the Control Plane is a service SID, and the owner's SID gets Read on ui\ only
  const byPath2 = new Map(r.aclPlan2.map((entry) => [entry.path, entry]));
  const cpSvc = r.cp.sid;
  const approver = r.shown.approverSid;
  const grantMap = (dir) => Object.fromEntries(byPath2.get(dir).grants.map((grant) => { const m = grant.match(/^\*(S-[0-9-]+):(.+)$/u); return [m[1], m[2]]; }));
  assert.equal(grantMap(r.layout.ControlPlaneConfigDir)[cpSvc], '(OI)(CI)R', 'the service can only READ its settings');
  assert.deepEqual(byPath2.get(r.layout.ControlPlaneConfigDir).writers, ['S-1-5-18', 'S-1-5-32-544'], 'nobody but the administrators may write them');
  assert.equal(grantMap(r.layout.ControlPlaneDir)[cpSvc], '(OI)(CI)F');
  assert.equal(grantMap(r.layout.ControlPlaneLogDir)[cpSvc], '(OI)(CI)F', 'logDirectory: created first, full control for the service');
  assert.equal(grantMap(r.layout.SecretsDir)[cpSvc], '(OI)(CI)M', 'secrets: the service reads and writes the DPAPI blobs');
  assert.equal(Object.keys(grantMap(r.layout.SecretsDir)).includes(approver), false, 'the owner is not on secrets\\');
  assert.equal(grantMap(r.layout.UiDir)[cpSvc], '(OI)(CI)M');
  assert.equal(grantMap(r.layout.UiDir)[approver], '(OI)(CI)R', 'the owner reads ui\\room.json');
  assert.deepEqual(byPath2.get(r.layout.UiDir).writers, ['S-1-5-18', 'S-1-5-32-544', cpSvc].sort(), 'the owner cannot write ui\\');
  assert.deepEqual(r.aclPlan2NoApprover, ['*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', `*${cpSvc}:(OI)(CI)M`], 'without an approver SID the owner is simply not named');
  assert.deepEqual(r.readRules, [{ rights: 0x120089, inherit: 3 }], 'R is Read (list, read data and attributes, read permissions): no execute, no write');
  assert.equal(byPath2.get(r.layout.InstallRoot).grants.includes(`*${cpSvc}:(OI)(CI)RX`), true, 'bin\\control-plane and bin\\claude: read and execute only (administrators write)');
  assert.equal(r.aclGood, 0);
  assert.deepEqual(r.aclInherited, ['inheritance_not_removed']);
  assert.deepEqual(r.aclEveryone, ['unexpected_principal:S-1-1-0']);
  assert.ok(r.aclMissing.some((d) => d.startsWith('missing_principal:')));
  assert.ok(r.aclOwnerUser.includes('owner_untrusted'));
});

test('services: the sc.exe arguments quote the path with a space, the Broker SDDL grants the Control Plane account only LC, and the fact checks catch each deviation', needsWindows, () => {
  const { r } = lib();
  assert.equal(r.brokerCommandLine, '"C:\\Program Files\\Albera\\bin\\broker\\albera-windows-broker.exe" service "C:\\ProgramData\\Albera\\broker-config\\AlberaHostBroker.service.json"');
  assert.equal(r.scCreate, `create AlberaHostBroker binPath= "${r.brokerCommandLine.replace(/"/gu, '\\"')}" obj= "NT SERVICE\\AlberaHostBroker" start= delayed-auto type= own`);
  const cpLine = '"C:\\Program Files\\Albera\\bin\\control-plane\\albera-control-plane-host.exe" service "C:\\ProgramData\\Albera\\control-plane-config\\AlberaControlPlane.service.json"';
  assert.equal(r.scCreateCp, `create AlberaControlPlane binPath= "${cpLine.replace(/"/gu, '\\"')}" obj= "NT SERVICE\\AlberaControlPlane" start= delayed-auto type= own`, 'the host is started as `service <config>`');
  assert.equal(r.scFailure, 'failure AlberaControlPlane reset= 86400 actions= restart/5000/restart/5000//0', 'restart after 5 s, twice, then nothing');
  assert.equal(r.sddl, 'D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LC;;;S-1-5-21-1111111111-2222222222-3333333333-1500)');
  assert.equal(r.sddlOk, 0);
  assert.deepEqual(r.sddlExtraUsers, ['unexpected_principal:S-1-5-32-545']);
  assert.deepEqual(r.sddlCpMore, ['control_plane_access_not_lc']);
  assert.deepEqual(r.sddlNoCp, ['control_plane_ace_missing']);
  assert.deepEqual(r.sddlJunk, ['sddl_unreadable']);
  // the lab's SDDL, character for character, with the Control Plane's SID in place of the lab service SID
  const lab = readFileSync(path.join(root, 'test', 'windows-service-lab', 'lab-guest.ps1'), 'utf8').match(/sc\.exe sdset \$B "(D:\(A;;[^"]*)\(A;;LC;;;\$\{SidC\}\)"/u);
  assert.ok(lab, 'the lab SDDL is still where this test expects it');
  assert.equal(r.sddl, `${lab[1]}(A;;LC;;;S-1-5-21-1111111111-2222222222-3333333333-1500)`);
  assert.equal(r.factsOk, 0);
  assert.deepEqual(r.factsBad.missing, ['service_missing']);
  assert.deepEqual(r.factsBad.localSystem, ['start_name_differs']);
  assert.deepEqual(r.factsBad.otherPath, ['path_differs']);
  assert.deepEqual(r.factsBad.demand, ['start_mode_not_auto']);
  assert.deepEqual(r.factsBad.autoNotDelayed, ['start_not_delayed']);
  assert.deepEqual(r.factsBad.disabled, ['start_mode_not_auto']);
  assert.deepEqual(r.factsBad.shared, ['not_own_process']);
  assert.deepEqual(r.factsBad.unrestricted, ['sid_type_not_restricted']);
  assert.deepEqual(r.factsBad.impersonate, ['privileges_not_minimal']);
  assert.deepEqual(r.factsBad.noPrivs, ['privileges_not_minimal']);
});

test('the lab hardening is copied, not reinvented: the script uses the same sc.exe sequence as lab-guest.ps1', () => {
  const lab = readFileSync(path.join(root, 'test', 'windows-service-lab', 'lab-guest.ps1'), 'utf8');
  const lib = readFileSync(path.join(hostDir, 'albera-host-lib.ps1'), 'utf8');
  const script = readFileSync(path.join(hostDir, 'albera-host.ps1'), 'utf8');
  assert.match(lab, /obj= "NT SERVICE\\\$n" start= demand type= own/u);
  assert.match(lib, /obj= "NT SERVICE\\' \+ \$Name \+ '" start= delayed-auto type= own/u, 'the lab used start= demand; the product starts all three services by themselves, delayed (decision D5)');
  assert.match(lab, /sc\.exe sidtype \$n restricted/u);
  assert.match(script, /sidtype \$\(\$Spec\.Name\) restricted/u);
  assert.match(lab, /sc\.exe privs \$n SeChangeNotifyPrivilege/u);
  assert.match(script, /privs \$\(\$Spec\.Name\) SeChangeNotifyPrivilege/u);
  assert.match(lab, /\/inheritance:r', '\/grant:r', '\*S-1-5-18:\(OI\)\(CI\)F', '\/grant:r', '\*S-1-5-32-544:\(OI\)\(CI\)F'/u);
  assert.match(script, /\/inheritance:r/u);
  const keyTool = readFileSync(path.join(root, 'test', 'windows-service-lab', 'new-authority-key.ps1'), 'utf8');
  assert.match(keyTool, /ExportPolicy = if \(\$Variant -eq 'exportable'\) \{[^}]*\} else \{ \[System\.Security\.Cryptography\.CngExportPolicies\]::None \}/u);
  assert.match(keyTool, /\$sddl = "D:P\(A;;GA;;;SY\)\(A;;GA;;;BA\)\(A;;GA;;;\$ServiceSid\)"/u);
  assert.match(lib, /ExportPolicy = \[System\.Security\.Cryptography\.CngExportPolicies\]::None/u);
  assert.match(lib, /"D:P\(A;;GA;;;SY\)\(A;;GA;;;BA\)\(A;;GA;;;\$ServiceSid\)"/u);
});

test('signing key checks: exportable, broad ACE, another service SID and a user owner are each refused; the SDDL names only SYSTEM, Administrators and the service', needsWindows, () => {
  const { r } = lib();
  assert.equal(r.keyGood, 0);
  assert.deepEqual(r.keyExportable, ['key_exportable']);
  assert.deepEqual(r.keyEveryone, ['ace_untrusted']);
  assert.deepEqual(r.keyBrokerSid, ['ace_untrusted']);
  assert.deepEqual(r.keyOwnerUser, ['owner_untrusted']);
  assert.equal(r.keySddl, `D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;${r.sidAuthority})`);
  assert.deepEqual(r.keyNameOk, [true, false, false]);
});

test('removal safety, path rules, the lab gate and id grammar', needsWindows, () => {
  const { r } = lib();
  assert.deepEqual(r.unknownEntries, ['broker\\notes.txt', 'control-plane\\sub\\x']);
  assert.deepEqual(r.pathsOk, [true, true]);
  assert.deepEqual(r.pathsBad, [false, false, false, false, false, false, false, false]);
  assert.deepEqual(r.gate, { labSupplied: true, notLab: 'binary_source_parameter_is_lab_only', labWrongValue: 'binary_source_parameter_is_lab_only', noSource: true });
  // the folders the service fills itself are known as a whole; a look-alike name and any other unlisted file are still unknown
  assert.deepEqual(r.unknownWork, ['control-plane\\notes.txt', 'control-plane\\logsX\\a', 'control-plane-config\\extra.json']);
  assert.deepEqual(r.unknownWorkWithoutWorkFolders, ['control-plane\\logs\\host.log', 'ui\\room.json'], 'without the work-folder list nothing below logs\\ or ui\\ is known');
  assert.deepEqual(r.ids, [true, true, false, false, false]);
});

test('trust summary: a planted owner, a non-admin writer, an inherited ACL on a folder, and a service writing outside its own folder are each refused', needsWindows, () => {
  const { r } = lib();
  const attacker = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
  assert.equal(r.trustOk, 0);
  assert.deepEqual(r.trustPlantedOwner, ['owner_untrusted']);
  assert.deepEqual(r.trustUserWriter, [`writer_untrusted:${attacker}`]);
  assert.deepEqual(r.trustInherited, ['inheritance_not_removed']);
  assert.equal(r.trustInheritedFileOk, 0, 'a file inherits its ACL from a trusted folder: only owner and writers are checked');
  assert.equal(r.trustTrustedInstaller, 0, 'TrustedInstaller owns and writes Program Files: trusted, as in FileSystemChecks.cs of setup');
  assert.deepEqual(r.trustCreatorOwnerWriter, ['writer_untrusted:S-1-3-0'], 'CREATOR OWNER is no trusted writer (only its inherit-only placeholder is skipped, in Get-AclSummary)');
  assert.deepEqual(r.trustCreatorOwnerOwner, ['owner_untrusted']);
  assert.deepEqual(r.trustedSids, ['S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464']);
  assert.equal(r.trustServiceWriterOnItsOwn, 0);
  assert.deepEqual(r.trustServiceWriterElsewhere, [`writer_untrusted:${r.sidBroker}`]);
  assert.deepEqual(r.plannedWriters.dataRoot, ['S-1-5-18', 'S-1-5-32-544'], 'nobody but the administrators may write the data root');
  assert.deepEqual(r.plannedWriters.brokerConfig, ['S-1-5-18', 'S-1-5-32-544'], 'the Broker cannot write its own config');
  assert.deepEqual(r.plannedWriters.brokerDb, ['S-1-5-18', 'S-1-5-32-544', r.sidBroker].sort());
  assert.deepEqual(r.plannedWriters.controlPlane, ['S-1-5-18', 'S-1-5-21-1111111111-2222222222-3333333333-1500', 'S-1-5-32-544']);
  assert.match(r.refusalText, /cannot be trusted \(owner_untrusted\).*delete it yourself as an administrator/u);
  // the descriptor a folder is born with: Full for SYSTEM / Administrators, Modify for its own account, all inheritable, allow only
  const rights = Object.fromEntries(r.rules.map((rule) => [rule.sid, rule]));
  assert.equal(rights['S-1-5-18'].rights, 0x1f01ff);
  assert.equal(rights[r.sidBroker].rights, 0x1301bf, 'Modify');
  assert.ok(r.rules.every((rule) => rule.inherit === 3 && rule.type === 'Allow'));
  assert.equal(r.badGrant, 'grant_not_understood');
});

test('tree hash: one canonical listing for CI and install; a changed, renamed, added, dropped or moved file, or a malformed input, never gives the same value', needsWindows, () => {
  const { r } = lib();
  assert.equal(r.tree, r.treeByHand, 'the documented format (component/path TAB sha LF, SHA-256 of the UTF-8 bytes) is what the function computes');
  assert.equal(r.treeBackslashAndOrder, r.tree, 'either slash and any input order give the same value');
  const others = Object.values(r.treeOther);
  assert.equal(new Set([r.tree, ...others]).size, others.length + 1, 'every change gives a different value');
  assert.deepEqual(r.treeBad, {
    missingComponent: 'tree_hash_components', approverMissing: 'tree_hash_components', extraComponent: 'tree_hash_components', emptyComponent: 'tree_hash_empty:broker', dotdot: 'tree_hash_path:broker', absolute: 'tree_hash_path:broker',
    drive: 'tree_hash_path:broker', upperHex: 'tree_hash_value:broker', duplicate: 'tree_hash_path:broker',
  });
  assert.deepEqual(r.treeValue, [true, false, false, false, false], 'the typed value must be 64 lowercase hex');
});

test('system folders come from Windows, never from environment variables: anything but the standard places is refused, and a hostile user environment does not move the answer', needsWindows, () => {
  const { r } = lib();
  assert.deepEqual(r.fixedOk, [0, 0], 'the standard places, any case, with or without a trailing slash');
  assert.deepEqual(r.fixedBad.system, ['system_directory_not_C:\\Windows\\System32']);
  assert.deepEqual(r.fixedBad.programFiles, ['program_files_not_C:\\Program Files']);
  assert.deepEqual(r.fixedBad.programData, ['program_data_not_C:\\ProgramData']);
  assert.deepEqual(r.fixedBad.x86, ['program_files_not_C:\\Program Files'], 'a 32-bit PowerShell would see Program Files (x86)');
  assert.equal(r.fixedBad.empty.length, 3);
  assert.equal(r.fixedBad.all.length, 3);
  // SystemRoot / ProgramFiles / ProgramData / windir were set to D:\evil inside that run; Windows still answers with the real folders
  assert.match(r.hostileEnv.system, /^C:\\windows\\system32$/iu);
  assert.equal(r.hostileEnv.programFiles, 'C:\\Program Files');
  assert.equal(r.hostileEnv.programData, 'C:\\ProgramData');
  assert.equal(r.hostileEnvReasons, 0);
});

test('manifest shape and ownership: a forged manifest cannot name another account, another service, another key or an unknown entry; only the exact account install made may be removed', needsWindows, () => {
  const { r } = lib();
  assert.equal(r.shapeOk, 0);
  assert.deepEqual(r.shapeBad.userName, ['user_record'], 'created.user = Yosuke is not a manifest this script wrote');
  assert.deepEqual(r.shapeBad.userSidGroup, ['user_record']);
  assert.deepEqual(r.shapeBad.serviceName, ['service_name_not_fixed']);
  assert.deepEqual(r.shapeBad.keyName, ['key_record']);
  assert.deepEqual(r.shapeBad.binaryName, ['binary_name:evil']);
  assert.deepEqual(r.shapeBad.unknownCreated, ['created_key:folders'], 'no other folder can be listed');
  assert.deepEqual(r.shapeBad.unknownValue, ['values_key:x']);
  assert.deepEqual(r.shapeBad.badSpki, ['authority_spki']);
  for (const key of ['badState', 'notDict', 'nullManifest']) assert.deepEqual(r.shapeBad[key], ['manifest_header']);
  assert.equal(r.ownedOk, 0);
  assert.deepEqual(r.owned.forgedName, ['recorded_name_not_fixed', 'live_name_not_fixed'], 'the owner\'s own account, named in a forged manifest, is not removed (even with the installer\'s description copied)');
  assert.ok(r.owned.forgedNameLiveOwner.includes('description_differs'));
  assert.deepEqual(r.owned.otherSid, ['sid_differs']);
  assert.deepEqual(r.owned.otherDescription, ['description_differs']);
  assert.deepEqual(r.owned.caseName, ['recorded_name_not_fixed', 'live_name_not_fixed'], 'the name is compared case-sensitively');
  assert.deepEqual(r.owned.gone, ['account_missing']);
  assert.deepEqual(r.owned.unrecorded, ['not_recorded']);
});

// ---- the signing key function, in user scope ----

test('New-AuthoritySigningKey (user scope, no admin): non-exportable ECDSA P-256, read back, and the SPKI it returns verifies a signature made with the key (checked by Node)', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  const name = `AlberaHostTestKey-${randomBytes(6).toString('hex')}`;
  const message = randomBytes(48);
  const out = lastJson(ps(['-File', path.join(driverDir, 'key-check.ps1'), '-KeyName', name, '-MessageBase64', message.toString('base64')]).stdout);
  assert.equal(out.report.exportPolicy, 0, 'Export Policy none');
  assert.equal(out.report.keySize, 256);
  assert.match(out.report.algorithm, /ECDSA/u);
  assert.ok(out.report.allowSids.includes('S-1-5-18') && out.report.allowSids.includes('S-1-5-32-544') && out.report.allowSids.includes(out.serviceSid));
  assert.equal(out.readSpkiEqual, true);
  assert.equal(out.exists, true);
  const key = createPublicKey({ key: Buffer.from(out.spki, 'base64'), format: 'der', type: 'spki' });
  assert.equal(key.asymmetricKeyType, 'ec');
  assert.equal(key.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.equal(verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(out.signature, 'base64')), true, 'the SPKI is the public half of the stored key');
  assert.equal(verify('sha256', randomBytes(48), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(out.signature, 'base64')), false);
  assert.match(out.secondCreateRefused, /key_already_exists/u, 'an existing key is never touched');
  assert.match(out.machineNeedsServiceSid, /service_sid_invalid/u, 'a machine key can only be granted to a per-service SID');
  assert.equal(out.removed, true);
  assert.equal(out.existsAfter, false);
});

// ---- the system-touching helpers, against a temp folder ----

const harness = (t, kind) => lastJson(ps(['-File', path.join(driverDir, 'function-harness.ps1'), '-Case', kind, '-Work', scratch(t)]).stdout);

test('copy: the COPIES must hash to the typed tree hash; a replaced build, an extra, missing or moved file, a link in the source, a half-copied bin and a wrong or missing value are refused and leave nothing behind', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'copy');
  assert.match(r.expected, /^[0-9a-f]{64}$/u);
  assert.equal(r.firstRunError, null);
  assert.deepEqual(r.usersGrants, [r.approverBinDir], 'BUILTIN\\Users get read and execute on bin\\approver (the owner runs the tray) and on no other copy: not claude, not control-plane, not the .partial folders');
  assert.deepEqual(r.recorded, ['approver', 'authority', 'broker', 'control-plane', 'pipe-client']);
  assert.equal(r.destFiles.length, 15);
  assert.ok(r.destFiles.includes('broker\\sub\\data.json'));
  assert.equal(r.noPartialLeft, true);
  assert.equal(r.copiesTreeEqualsExpected, true, 'the installed copies hash to the typed value');
  assert.equal(r.exeShaRecorded, true);
  assert.equal(r.secondRunError, null);
  assert.equal(r.secondRunUntouched, true, 'a second run leaves the copied files alone');
  assert.match(r.tamperedError, /the installed copies hash to [0-9a-f]{64}, not to -ExpectedTreeHash/u);
  // tree hash mismatch -> refuse, and ALL copies are deleted
  for (const key of ['replacedBuildError', 'extraFileError', 'missingFileError', 'movedFileError', 'wrongHashError']) {
    assert.match(r[key], /the copies of the builds hash to [0-9a-f]{64}, not to -ExpectedTreeHash; the copies were deleted/u, key);
  }
  assert.equal(r.replacedBuildNothingLeft, true, 'neither a destination nor a .partial folder is left');
  assert.equal(r.replacedBuildNotRecorded, true);
  assert.equal(r.wrongHashNothingLeft, true);
  assert.match(r.junctionInSourceError, /contains a link or junction/u);
  assert.equal(r.junctionTargetIntact, true);
  assert.match(r.halfCopiedError, /holds only part of the builds/u);
  assert.equal(r.cleanAgainError, null, 'the reviewed build copies once the working tree is clean again');
  assert.deepEqual(r.recordedAgain, ['approver', 'authority', 'broker', 'control-plane', 'pipe-client']);
  assert.equal(r.staleGone, true);
  assert.deepEqual(r.manifestReread, ['approver', 'authority', 'broker', 'control-plane', 'pipe-client'], 'the manifest on disk round-trips');
  // the pinned node.exe is added INSIDE the control-plane folder after the hash was checked: the installed copies still hash to the typed value, and a build that ships its own node\ folder is refused
  assert.equal(r.nodeAddedStillEqual, true, 'a node\\ folder inside bin\\control-plane does not change the installed tree hash');
  assert.equal(r.nodeAddedSecondRunError, null, 'and a second run on such an install is fine');
  assert.equal(r.nodeAddedRecordedTreeSame, true, 'the recorded folder hash leaves node\\ out');
  assert.equal(r.nodeInstalledWithoutExclusionDiffers, true, 'control: with node\\ counted the hash WOULD differ');
  assert.match(r.nodeFolderInSourceError, /the control-plane build has a node\\ folder; that folder is reserved for the pinned node\.exe/u);
  assert.equal(r.nodeFolderInSourceNothingCopied, true);
  assert.match(r.noHashError, /-ExpectedTreeHash <64 hex> is required/u);
  assert.equal(r.noHashNothingCopied, true, 'without the typed value nothing is copied at all');
  assert.match(r.badFormat, /64 lowercase hex/u);
  assert.equal(r.upperCaseRefused, true);
});

test('trust: a planted manifest owned by a non-admin, a junction as the data root or a planned folder, and a planted child are refused before any ACL is changed or read through the link', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'trust');
  // the planted folder and manifest belong to the current non-admin user: exactly what an agent would leave
  assert.ok(r.plantedReasons.includes('owner_untrusted') && r.plantedReasons.includes('inheritance_not_removed'));
  assert.ok(r.plantedReasons.some((reason) => reason.startsWith('writer_untrusted:')));
  assert.ok(r.plantedManifestReasons.includes('owner_untrusted'));
  assert.match(r.plantedInstall, /^REFUSED: .*install-manifest\.json cannot be trusted \(owner_untrusted/u);
  assert.match(r.plantedInstall, /delete it yourself as an administrator/u);
  assert.match(r.plantedUninstall, /^REFUSED: .*cannot be trusted/u);
  assert.equal(r.plantedPlanError, null, 'plan / status never fail on it');
  assert.equal(r.plantedPlanManifestIgnored, true, 'but they do not use it');
  assert.match(r.plantedPlanNote, /NOT trusted or cannot be verified without admin rights \(owner_untrusted/u);
  // the data root is a junction to another vendor's service folder
  assert.equal(r.junctionRootReasons.length, 1);
  assert.match(r.junctionRootReasons[0], /^reparse_point:/u);
  assert.match(r.junctionRootInstall, /^REFUSED: .*cannot be trusted \(reparse_point:/u);
  // a planned sub-folder is a junction: the folder step stops before icacls; nothing in the target changes
  assert.match(r.junctionChildError, /control-plane cannot be trusted \(reparse_point:/u);
  assert.equal(r.vendorUntouched, true);
  assert.match(r.plantedChildError, /broker cannot be trusted \(owner_untrusted, inheritance_not_removed/u);
  assert.equal(r.missingChildError, null, 'a folder that does not exist yet is simply created');
  // a link anywhere on the way is found
  assert.deepEqual(r.parentChain, ['link-parent']);
  assert.equal(r.plainChain, r.baseChain, 'a plain folder adds no link to the chain');
});

test('a folder is born with its final descriptor (owner, protected DACL, inheritable rules); an existing path or an unknown grant creates nothing', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'secured');
  assert.equal(r.owner, true);
  assert.equal(r.protected, true, 'no inherited ACE, ever');
  assert.deepEqual(r.allow, r.expectedAllow);
  assert.equal(r.childInherits, true);
  assert.equal(r.existingRefused, 'directory_already_exists');
  assert.equal(r.badGrantRefused, 'grant_not_understood');
  assert.equal(r.badGrantCreatedNothing, true);
  // DirectoryInfo.Create succeeds silently on an existing folder: the read-back refuses it (not protected, wrong accounts), and a link
  assert.match(r.createOnExistingError, /^created_directory_not_as_requested:.*not_protected/u);
  assert.equal(r.createOnExistingKept, true, 'the foreign folder is left for the administrator to inspect');
  assert.equal(r.createOnJunctionError, 'created_directory_not_as_requested:reparse_point');
  // a folder created exactly as asked still has to pass the installer's trust test before any later step runs
  assert.match(r.trustedCreateError, /trusted cannot be trusted \(owner_untrusted\)/u);
  // CREATOR OWNER: the inherit-only placeholder of Program Files folders is listed but is no writer of that folder (the same rule as FileSystemChecks.cs in setup); Test-TrustSummary counts it elsewhere
  assert.deepEqual({ ...r.creatorOwnerPlaceholder }, { listed: true, writer: false });
  assert.equal(r.creatorOwnerPlaceholderRule, 'InheritOnly');
});

test('removal: only known files are deleted; an unknown file, a sub-folder or a junction stops the removal and nothing is deleted there', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'remove');
  assert.match(r.unknownRefused, /holds files this script did not create \(control-plane\\my-notes\.txt\); nothing was deleted there/u);
  assert.equal(r.unknownKept, true);
  assert.equal(r.knownRemoved, null);
  assert.equal(r.knownGone, true);
  assert.match(r.subfolderRefused, /authority\\extra/u);
  assert.equal(r.authorityKept, true);
  assert.equal(r.installTreeRemoved, null);
  assert.equal(r.installGone, true);
  assert.match(r.installUnknownRefused, /readme\.txt/u);
  assert.equal(r.installUnknownKept, true);
  // the folders the Control Plane service fills itself are removed as a whole; a stray file next to them is not
  assert.equal(r.workFoldersRemoved, null, 'logs, claude-run, secrets\\ and ui\\ hold files the service made: they go');
  assert.equal(r.workFoldersGone, true);
  assert.match(r.strayInControlPlaneRefused, /control-plane\\notes\.txt/u);
  assert.equal(r.strayInSecretsAllowed, null, 'a DPAPI blob and its .meta file are the service\'s own');
  assert.match(r.configUnknownRefused, /control-plane-config\\extra\.json/u, 'the settings folder is not a work folder: nothing unlisted may sit in it');
  assert.equal(r.configKnownRemoved, null);
  assert.match(r.junctionRefused, /contains a link or junction/u);
  assert.equal(r.outsideIntact, true, 'the junction target was not followed or deleted');
  assert.match(r.selfJunctionRefused, /is or contains a link or junction/u, 'a folder that is itself a junction is refused too');
  assert.equal(r.selfJunctionTargetIntact, true);
  // deletion never follows a link, even one that appears after the checks: the link goes, its target is neither entered nor touched
  assert.equal(r.noFollowError, null);
  assert.equal(r.noFollowTreeGone, true, 'a read-only file and a nested folder go too');
  assert.equal(r.noFollowTargetIntact, true, 'the junction inside the tree was removed as a link; what it pointed to is intact');
  assert.equal(r.noFollowSelfError, null);
  assert.equal(r.noFollowSelfGone, true);
  assert.equal(r.noFollowSelfTargetIntact, true);
  // the scan the migration preflight makes before anything is touched
  assert.equal(r.scanClean, 0);
  assert.equal(r.scanUnknownInData.length, 1);
  assert.match(r.scanUnknownInData[0], /\\authority holds files this script did not create \(authority\\evil\.txt\); move or delete them first$/u);
  assert.equal(r.scanLinkInData.length, 1);
  assert.match(r.scanLinkInData[0], /is or contains a link or junction$/u);
  assert.equal(r.scanUnknownInInstall.length, 1);
  assert.match(r.scanUnknownInInstall[0], /holds files this script did not create \(bin\\evil[^)]*\); move or delete them first$/u);
  assert.equal(r.scanTargetIntact, true);
});

// ---- -GrantHyperVToBroker (ADR-002 Amendment 2026-11-03): the Broker's service SID, and only it, in Hyper-V Administrators; the Broker unrestricted exactly then ----

const BROKER_SERVICE_SID_ARG = /\$hv\.Group -Member \$hv\.Member/u;

test('Hyper-V grant, source guards: the only code that changes the group takes group and member from Get-HyperVGrantPlan; albera-cp and the Authority have no path in; no new program is started', () => {
  const script = readFileSync(path.join(hostDir, 'albera-host.ps1'), 'utf8');
  const lib = readFileSync(path.join(hostDir, 'albera-host-lib.ps1'), 'utf8');
  const code = (text) => text.split('\n').filter((line) => !/^\s*#/u.test(line));   // comments and doc text may name anything
  const scriptCode = code(script).join('\n');
  // every group change in the script: the old Users line for albera-cp, and exactly one add and one remove for the Hyper-V group
  const codeLines = scriptCode.split('\n');
  const callsOf = (cmdlet) => codeLines.filter((line) => new RegExp(`\\b${cmdlet}\\b`, 'u').test(line.replace(/"[^"]*"/gu, '""')));   // a cmdlet named inside a message string is not a call
  const adds = callsOf('Add-LocalGroupMember');
  const removes = callsOf('Remove-LocalGroupMember');
  assert.equal(adds.length, 1, 'one Add-LocalGroupMember call: the Broker into Hyper-V Administrators (nothing makes a local account any more)');
  const hvAdds = adds.filter((line) => BROKER_SERVICE_SID_ARG.test(line));
  assert.equal(hvAdds.length, 1);
  assert.match(hvAdds[0], /Add-LocalGroupMember -SID \$hv\.Group -Member \$hv\.Member\s*\}?\s*$/u);
  assert.equal(removes.length, 1, 'one Remove-LocalGroupMember call');
  assert.match(removes[0], /Remove-LocalGroupMember -SID \$hv\.Group -Member \$hv\.Member/u);
  // $hv is only ever the answer of Get-HyperVGrantPlan for the script's SIDs
  const hvAssignments = scriptCode.split('\n').flatMap((line) => [...line.matchAll(/\$hv\s*=\s*([^;}\n]+)/gu)].map((m) => m[1].trim()));
  assert.ok(hvAssignments.length >= 3);
  for (const rhs of hvAssignments) assert.equal(rhs, 'Get-HyperVGrantPlan $script:Sids', `$hv = ${rhs}`);
  // no other way to change a local group, and no group literal passed anywhere but through the plan
  for (const forbidden of [/\bnet(?:\.exe)?\s+localgroup/iu, /\bAdd-ADGroupMember\b/u, /\bSet-LocalGroup\b/u, /\.Add\(\s*"WinNT/u, /\bNetLocalGroup/u, /-Group\s+['"$]/u]) {
    assert.doesNotMatch(scriptCode + '\n' + code(lib).join('\n'), forbidden, `must not contain ${forbidden}`);
  }
  assert.equal(scriptCode.split('\n').filter((line) => /-SID\s+'S-1-5-32-578'/u.test(line)).length, 0, 'the group SID is never passed as a literal to a cmdlet');
  assert.equal([...adds, ...removes].filter((line) => /ControlPlane|\$cp\b|\$u\b|Authority/iu.test(line) && !/'S-1-5-32-545'/u.test(line)).length, 0, 'no group change names the Control Plane or the Authority');
  // the plan function: its only member is the Broker's SID, checked against the derivation, and it refuses when that SID is also the Control Plane's or the Authority's
  const planBody = lib.slice(lib.indexOf('function Get-HyperVGrantPlan'), lib.indexOf('# The install record `created.hyperVGrant`'));
  assert.match(planBody, /Member = \$broker/u);
  assert.match(planBody, /\$broker -cne \(Get-DerivedServiceSid \$c\.BrokerService\)/u);
  assert.doesNotMatch(planBody, /Member = (?!\$broker\b)/u);
  assert.match(lib, /function Get-ExpectedSidType[\s\S]*?\$HyperVGrantRecorded -and \$ServiceName -ceq \$c\.BrokerService\) \{ return 'unrestricted' \}/u);
  // the sid type: one decision point, restricted is still the literal the old test (and the lab) look for
  assert.equal((scriptCode.match(/sidtype \$\(\$Spec\.Name\) unrestricted/gu) ?? []).length, 1);
  assert.match(scriptCode, /\(Get-ExpectedSidType \$Spec\.Name \$GrantHyperVToBroker\) -ceq 'unrestricted'\) \{ Invoke-Sc "sidtype \$\(\$Spec\.Name\) unrestricted" \| Out-Null \} else \{ Invoke-Sc "sidtype \$\(\$Spec\.Name\) restricted" \| Out-Null \}/u);
  assert.match(scriptCode, /Test-ServiceFacts [^\n]*\(Get-ExpectedSidType \$spec\.Name \$GrantHyperVToBroker\)/u, 'install verifies the type it set');
  assert.match(scriptCode, /Test-ServiceFacts [^\n]*\(Get-ExpectedSidType \$spec\.Name \$grantRecorded\)/u, 'status expects unrestricted only when the install record says the grant was made');
  // the VM is looked up read-only through CIM, which is already imported; nothing new is executed, and the lab-only parameter is gated like the password
  assert.match(scriptCode, /Get-CimInstance -Namespace 'root\\virtualization\\v2' -ClassName Msvm_ComputerSystem -Filter "ElementName='\$VmName'"/u);
  assert.match(scriptCode, /Test-LabVmIdGate \$true \$env:ALBERA_LAB_VM/u);
  assert.doesNotMatch(scriptCode, /Get-VM\b|Import-Module Hyper-V|Set-VM|Start-VM|Stop-VM|Remove-VM|Checkpoint-VM/u, 'the Hyper-V PowerShell module is not loaded and no VM is changed');
  assert.ok(scriptCode.indexOf('Stop-Refused \'-VmId is lab-only') > 0);
  // uninstall removes the SID BEFORE the service goes (a deleted service leaves its SID in the group), and the record is what decides
  assert.match(scriptCode, /if \(Test-ManifestHas 'hyperVGrant'\) \{ return @\(Get-HyperVRevokeStep\) \+ \$steps \}/u);
  assert.ok(scriptCode.indexOf("Revoke-BrokerHyperV }") > 0);
});

test('Hyper-V grant, command line: the option only applies to install (and its plan); -VmId is lab-only and needs the option; install still needs elevation', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  const before = snapshot();
  const VM = '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f';
  for (const mode of [['-Mode', 'status'], ['-Mode', 'hashes'], ['-Mode', 'plan', '-PlanFor', 'uninstall']]) {
    const result = host([...mode, '-GrantHyperVToBroker'], { allowFail: true });
    assert.equal(result.code, 2, mode.join(' '));
    assert.match(result.stdout, /-GrantHyperVToBroker only applies to -Mode install/u);
  }
  const notLab = host(['-Mode', 'plan', '-GrantHyperVToBroker', '-VmId', VM], { allowFail: true, env: { ALBERA_LAB_VM: '' } });
  assert.equal(notLab.code, 2);
  assert.match(notLab.stdout, /-VmId is lab-only/u);
  const noOption = host(['-Mode', 'plan', '-VmId', VM], { allowFail: true, env: { ALBERA_LAB_VM: '1' } });
  assert.equal(noOption.code, 2);
  assert.match(noOption.stdout, /-VmId only applies together with -GrantHyperVToBroker/u);
  for (const bad of ['not-a-guid', VM.toUpperCase()]) {
    const result = host(['-Mode', 'plan', '-GrantHyperVToBroker', '-VmId', bad], { allowFail: true, env: { ALBERA_LAB_VM: '1' } });
    assert.equal(result.code, 2, bad);
    assert.match(result.stdout, /-VmId is not a lowercase GUID/u);
  }
  for (const bad of ['bad name!', '../x', "a'b"]) assert.equal(host(['-Mode', 'plan', '-GrantHyperVToBroker', '-VmName', bad], { allowFail: true }).code, 2, `-VmName ${bad}`);
  // install with the option is refused like install without it when the console is not elevated, before any step
  const install = host(['-Mode', 'install', '-GrantHyperVToBroker', '-VmName', 'albera-clone-01'], { env: { ALBERA_HOST_ASSUME_NOT_ELEVATED: '1' }, allowFail: true });
  assert.equal(install.code, 3);
  assert.match(install.stdout, /REFUSED: install needs an elevated console/u);
  assert.doesNotMatch(install.stdout, /^\s*\d+\. /mu);
  assert.deepEqual(snapshot(), before);
});

test('Hyper-V grant, pure helpers: the plan names the Broker SID only; the Broker is unrestricted exactly when the record says so; the config gets `computers` only then; a forged record names nobody else', needsWindows, () => {
  const { r } = lib();
  const tooMany = 'hyperv_grant_member_not_the_broker_service_sid';
  assert.equal(r.hvConstant, 'S-1-5-32-578');
  assert.deepEqual({ ...r.hvPlan }, { group: 'S-1-5-32-578', member: r.sidBroker, memberIsBroker: true });
  assert.equal(r.hvPlanNoCpYet, r.sidBroker, 'before albera-cp exists the plan is the same');
  for (const [name, message] of Object.entries(r.hvPlanRefused)) assert.equal(message, tooMany, `${name}: Control Plane, Authority, another service, Administrators or nothing can never be the member`);
  assert.equal(Object.keys(r.hvPlanRefused).length, 7);
  // status: the Broker must be in, albera-cp and the Authority out
  assert.equal(r.hvMembers.ok, 0);
  assert.deepEqual(r.hvMembers.brokerMissing, ['broker_not_a_member']);
  assert.deepEqual(r.hvMembers.controlPlaneIn, ['control_plane_is_a_member']);
  assert.deepEqual(r.hvMembers.authorityIn, ['authority_is_a_member']);
  assert.deepEqual(r.hvMembers.empty, ['broker_not_a_member']);
  // and without a record the group is still checked: albera-cp and the Authority never, the Broker not
  assert.equal(r.hvMembers.noRecordClean, 0);
  assert.equal(r.hvMembers.noRecordEmpty, 0);
  assert.deepEqual(r.hvMembers.noRecordBroker, ['broker_is_a_member_without_a_record']);
  assert.deepEqual(r.hvMembers.noRecordControlPlane, ['control_plane_is_a_member']);
  assert.deepEqual(r.hvMembers.noRecordAuthority, ['authority_is_a_member']);
  // GUIDs and the name lookup
  assert.deepEqual(r.vmGuid, [true, false, false, false, false, false, false, false], 'lowercase 8-4-4-4-12 only: no upper case, braces, trailing newline, zero GUID or id');
  const GUID = '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f';
  assert.deepEqual({ ...r.vmPick.one }, { Ok: true, VmId: GUID, Reason: '' }, 'the Hyper-V GUID (upper case in WMI) comes back lowercase');
  assert.equal(r.vmPick.caseInsensitiveName.Ok, true);
  for (const name of ['none', 'otherName', 'hostIsNoVm']) assert.deepEqual({ ...r.vmPick[name] }, { Ok: false, VmId: null, Reason: 'vm_not_found' }, name);
  assert.deepEqual({ ...r.vmPick.twoWithTheName }, { Ok: false, VmId: null, Reason: 'vm_name_ambiguous' }, 'a name two VMs share is refused, never guessed');
  assert.equal(r.vmPick.hostAndOne.VmId, GUID, 'the host computer system (its Name is the computer name) is skipped');
  assert.equal(r.vmPick.nullEntry.VmId, GUID);
  assert.deepEqual({ ...r.vmIdGate }, { lab: true, notLab: 'vm_id_parameter_is_lab_only', wrongValue: 'vm_id_parameter_is_lab_only', notSupplied: true });
  // the Broker config: unchanged without the option; with it the one optional key, last, in the shape ServiceConfig.cs reads
  assert.deepEqual(r.hvPlainSame, { noArgument: true, nullComputers: true, emptyComputers: true, hasNoComputersKey: true });
  assert.deepEqual(r.hvComputers, [{ computerId: 'clone-01', vmId: GUID }]);
  assert.deepEqual(r.hvGrantKeys, ['pipeName', 'database', 'authorityKeys', 'controlPlaneSid', 'generation', 'leaseId', 'policyVersion', 'computers']);
  assert.deepEqual(r.hvGrantReasons, []);
  const grant = JSON.parse(r.hvGrantJson);
  assert.deepEqual(grant.computers, [{ computerId: 'clone-01', vmId: GUID }]);
  assert.ok(Buffer.byteLength(r.hvGrantJson) < 4096);
  assert.deepEqual(r.hvGrantComputersMatch, { same: true, otherVm: false, otherId: false, plain: false, junk: false });
  const csSource = readFileSync(path.join(root, 'src', 'runtime', 'windows-broker', 'ServiceConfig.cs'), 'utf8');
  assert.match(csSource, /private static readonly string\[\] ComputerFields = \["computerId", "vmId"\];/u);
  assert.match(csSource, /private const string ComputersKey = "computers";/u);
  assert.match(csSource, /private const int MaxComputers = 8;/u);
  for (const name of ['upperGuid', 'wrongShape', 'zeroGuid', 'extraField', 'missingField', 'notAnArray', 'isNull', 'duplicateVm', 'duplicateId', 'badId', 'nineEntries']) assert.deepEqual(r.hvGrantBad[name], ['computers'], `computers: ${name} is refused like ServiceConfig.ReadComputers refuses it`);
  assert.deepEqual(r.hvGrantBad.eightEntries, [], 'eight entries is the limit');
  assert.deepEqual({ ...r.hvComputersBad }, { id: 'computer_id_invalid', vm: 'vm_id_invalid' });
  // the SID type
  assert.deepEqual({ ...r.sidTypeExpected }, { brokerPlain: 'restricted', brokerGranted: 'unrestricted', authorityPlain: 'restricted', authorityGranted: 'restricted', unknownServiceGranted: 'restricted' });
  assert.equal(r.sidTypeFacts.grantedOk, 0);
  assert.deepEqual(r.sidTypeFacts.grantedButRestricted, ['sid_type_not_unrestricted']);
  assert.deepEqual(r.sidTypeFacts.grantedButNone, ['sid_type_not_unrestricted']);
  assert.deepEqual(r.sidTypeFacts.plainButUnrestricted, ['sid_type_not_restricted'], 'without the record, unrestricted is still drift (the old check, unchanged)');
  assert.deepEqual(r.sidTypeFacts.plainButUnrestrictedExplicit, ['sid_type_not_restricted']);
  assert.equal(r.sidTypeFacts.plainOk, 0);
  assert.deepEqual(r.sidTypeFacts.grantedStillMinimalPrivileges, ['privileges_not_minimal'], 'SeChangeNotifyPrivilege only, with or without the grant');
  assert.match(r.sidTypeFacts.badExpectation, /ValidateSet|none/u);
  // a member without an objectSid (a service's virtual account) is read from its WinNT path
  assert.deepEqual({ ...r.winNtPaths.sid }, { Sid: 'S-1-5-80-1-2-3-4-5', Account: null });
  assert.deepEqual({ ...r.winNtPaths.service }, { Sid: null, Account: 'NT SERVICE\\AlberaHostBroker' });
  assert.deepEqual({ ...r.winNtPaths.local }, { Sid: null, Account: '.\\albera-cp' });
  assert.deepEqual({ ...r.winNtPaths.withMachine }, { Sid: null, Account: 'NT SERVICE\\AlberaHostBroker' });
  for (const name of ['junk', 'nothing', 'badSid']) assert.equal(r.winNtPaths[name], null, name);
  // the install record
  assert.equal(r.hvRecord.ok, 0);
  assert.equal(r.hvRecord.noRecordStillOk, 0, 'an install without the option has no record and is a valid manifest as before');
  for (const name of ['controlPlaneSid', 'authoritySid', 'otherGroup', 'badVm', 'badComputer', 'extraKey', 'missingKey', 'notADictionary']) assert.deepEqual(r.hvRecord[name], ['hyperv_grant_record'], name);
});

test('Hyper-V grant, step list and plan (fakes for the machine): two more steps with the option, the thirteen install and eight removal steps without; the VM is looked up before anything is created and the SID leaves before the service goes', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'hyperv');
  const thirteen = ['sources', 'approver', 'dataroot', 'services', 'folders', 'binaries', 'key', 'node', 'claude', 'configs', 'cpservice', 'shortcuts', 'finish'];
  assert.deepEqual(r.defaultInstallIds, thirteen, 'without the option: the steps of the Control Plane install (no local account any more)');
  assert.deepEqual(r.defaultUninstallIds, ['runentry', 'shortcuts', 'services', 'key', 'installroot', 'data', 'user', 'manifest'], 'without a record: the removal steps (the legacy user step stays for first-layout installs)');
  assert.deepEqual(r.grantInstallIds, ['sources', 'approver', 'vm', 'dataroot', 'services', 'hyperv', 'folders', 'binaries', 'key', 'node', 'claude', 'configs', 'cpservice', 'shortcuts', 'finish']);
  assert.ok(r.grantInstallIds.indexOf('hyperv') < r.grantInstallIds.indexOf('cpservice'), 'the Control Plane service is registered after the group change');
  assert.ok(r.defaultInstallIds.indexOf('node') > r.defaultInstallIds.indexOf('binaries') && r.defaultInstallIds.indexOf('claude') > r.defaultInstallIds.indexOf('binaries'), 'the pins are copied into folders the binaries step made');
  assert.ok(r.defaultInstallIds.indexOf('configs') > r.defaultInstallIds.indexOf('claude') && r.defaultInstallIds.indexOf('cpservice') > r.defaultInstallIds.indexOf('configs'), 'the service config names the pins\' hashes, and launch-check needs the config');
  assert.ok(r.grantInstallIds.indexOf('vm') < r.grantInstallIds.indexOf('dataroot'), 'a missing or ambiguous VM stops the run before anything is created');
  assert.ok(r.grantInstallIds.indexOf('services') < r.grantInstallIds.indexOf('hyperv'));
  assert.doesNotMatch(r.defaultServicesTitle, /UNRESTRICTED|Hyper-V/u, 'the default plan text is unchanged');
  assert.match(r.defaultServicesTitle, /restricted SID, SeChangeNotifyPrivilege only, start=delayed-auto/u);
  assert.equal(r.defaultConfigsDetail, 6);
  assert.match(r.grantServicesTitle, /Broker's SID type is UNRESTRICTED instead \(Hyper-V refuses a restricted token\), the Authority stays restricted/u);
  assert.equal(r.grantConfigsDetail.length, 8);
  assert.match(r.grantConfigsDetail[6], /computers: clone-01 -> <GUID of the VM albera-clone-01>/u);
  assert.match(r.grantConfigsDetail[7], /^The approval settings also get desktop: \{ helperPath .*\\bin\\pipe-client\\albera-windows-broker-pipe-client\.exe, helperSha256 <SHA-256 of that installed exe> \}, which the gated room requires$/u);
  assert.match(r.grantTitles[1], /Add ONLY the Broker's service SID \(S-1-5-80(-\d+){5}\) to BUILTIN\\Hyper-V Administrators \(S-1-5-32-578\)/u);
  assert.doesNotMatch(r.grantTitles.join('\n'), /albera-cp/u);
  // what the owner reads in a plan
  assert.deepEqual([...r.planDefault.matchAll(/^\s*(\d+)\. \[/gmu)].map((m) => Number(m[1])), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.doesNotMatch(r.planDefault, /Hyper-V|GrantHyperV|UNRESTRICTED/u, 'the default plan does not mention the option at all');
  const grantPlan = [...r.planGrant.matchAll(/^\s*(\d+)\. \[(\w+)\] (.*)$/gmu)].map((m) => [Number(m[1]), m[2], m[3]]);
  assert.deepEqual(grantPlan.map((row) => row[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.match(grantPlan[2][2], /^Look up the GUID of the virtual machine albera-clone-01/u);
  assert.equal(grantPlan[2][1], 'todo', 'the fake VM list has the VM');
  assert.match(grantPlan[5][2], /^Add ONLY the Broker's service SID/u);
  assert.match(r.planGrant, /its GUID goes into the Broker config as computers: clone-01 -> <guid>; the Broker queries by GUID and never by name/u);
  assert.match(r.planGrant, /uninstall removes the SID from the group first, before the service is deleted/u);
  // lookup
  assert.deepEqual({ ...r.lookupFound }, { kind: 'ok', id: '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f', test: 'todo', filter: "cim ElementName='albera-clone-01'" });
  assert.equal(r.lookupNone.kind, 'refused');
  assert.match(r.lookupNone.test, /^blocked:no virtual machine is named albera-clone-01/u);
  assert.equal(r.lookupHostOnly, 'refused');
  assert.equal(r.lookupTwo.kind, 'refused');
  assert.match(r.lookupTwo.test, /^blocked:more than one virtual machine is named albera-clone-01/u);
  assert.equal(r.lookupUnreadable.kind, 'unreadable');
  assert.match(r.lookupUnreadable.test, /^unknown:the Hyper-V virtual machine list could not be read \(needs an elevated console and the Hyper-V role\): Access denied \(fake\)/u, 'a plan without admin rights says unknown, not blocked');
  assert.deepEqual({ ...r.labVmId }, { kind: 'ok', id: '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f', cimCalls: 0 }, '-VmId (lab) replaces the lookup');
});

test('Hyper-V grant, the group change (fakes for the machine): only the Broker SID goes in, the record is written first, a second run adds nothing, uninstall removes only that SID and stops if it will not leave', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'hyperv');
  const BROKER = r.grantMembers[0];
  assert.match(BROKER, /^S-1-5-80(-\d+){5}$/u);
  const CP = 'S-1-5-21-1111111111-2222222222-3333333333-1500';
  const GUID = '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f';
  assert.equal(r.grantTestBefore, 'todo');
  assert.equal(r.grantError, null);
  assert.deepEqual(r.grantCalls, [`add S-1-5-32-578 ${BROKER}`], 'exactly one change: the Broker service SID into Hyper-V Administrators');
  assert.deepEqual(r.grantMembers, [BROKER]);
  assert.ok(!r.grantMembers.includes(CP));
  assert.deepEqual({ ...r.grantRecord }, { group: 'S-1-5-32-578', sid: BROKER, computerId: 'clone-01', vmId: GUID });
  assert.deepEqual({ ...r.grantRecordOnDisk }, { group: 'S-1-5-32-578', sid: BROKER, computerId: 'clone-01', vmId: GUID }, 'the record is saved to the manifest');
  assert.equal(r.grantTestAfter, 'done');
  assert.deepEqual(r.grantUninstallIds, ['hyperv', 'runentry', 'shortcuts', 'services', 'key', 'installroot', 'data', 'user', 'manifest'], 'with a record the SID leaves first, before the service is deleted');
  assert.match(r.planUninstall, /^\s*1\. \[todo\] Remove the Broker's service SID from Hyper-V Administrators \(the install record says -GrantHyperVToBroker added it\), BEFORE the service is deleted/mu);
  assert.deepEqual(r.grantAgainCalls, [], 'a second run changes nothing');
  assert.equal(r.grantAgainError, null);
  // undo
  assert.equal(r.revokeTestBefore, 'todo');   // (the removal is asked for without reading the member list first, so a failed read cannot leave the right in place)
  assert.equal(r.revokeError, null);
  assert.deepEqual(r.revokeCalls, [`remove S-1-5-32-578 ${BROKER}`], 'exactly one change, and it is the Broker SID');
  assert.deepEqual(r.revokeMembers, ['S-1-5-21-1111111111-2222222222-3333333333-1234'], 'another member of the group is left alone');
  assert.equal(r.revokeRecordGone, true);
  assert.equal(r.revokeTestAfter, 'done');
  assert.deepEqual(r.revokeUninstallIds, ['runentry', 'shortcuts', 'services', 'key', 'installroot', 'data', 'user', 'manifest']);
  // refusals change nothing
  assert.match(r.noVmError, /no virtual machine is named albera-clone-01/u);
  assert.deepEqual({ ...r.noVmChanged }, { calls: 0, record: false });
  assert.match(r.noGroupError, /Hyper-V Administrators\) does not exist on this PC; nothing was added/u);
  assert.deepEqual({ ...r.noGroupChanged }, { calls: 0, record: false });
  assert.match(r.cpMemberError, /Hyper-V Administrators is not as intended after the change: control_plane_is_a_member/u, 'albera-cp in the group makes the grant fail loudly');
  assert.deepEqual(r.cpMemberCalls, [`add S-1-5-32-578 ${BROKER}`], 'and still only the Broker was ever added');
  assert.match(r.cpEqualsBrokerError, /hyperv_grant_member_not_the_broker_service_sid/u);
  assert.equal(r.cpEqualsBrokerCalls, 0);
  assert.match(r.stuckError, /still in Hyper-V Administrators; the services were NOT deleted/u);
  assert.equal(r.stuckRecordKept, true, 'the record stays, so a re-run tries again');
  assert.equal(r.noGroupUndoError, null);
  assert.equal(r.noGroupUndoCalls, 0);
  assert.equal(r.noGroupUndoRecordGone, true);
  assert.match(r.forgedRecordError, /the grant record does not name the Broker service SID; refusing to remove anything/u);
  assert.equal(r.forgedRecordCalls, 0);
});

test('Hyper-V grant, the group is read every time and an undo never guesses (fakes for the machine): albera-cp and the Authority are never allowed in, the Broker only with a record, a lookup failure is not "no group"', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'hyperv');
  // finding 3: a failed lookup is thrown, the record stays, nothing is removed
  assert.match(r.lookupFailUndoError, /the group lookup failed \(fake\)/u, 'a failure that is not "no such group" stops the undo');
  assert.equal(r.lookupFailUndoRecordKept, true);
  assert.equal(r.lookupFailUndoManifestOnDisk, true);
  assert.equal(r.lookupFailUndoCalls, 0, 'no Remove-LocalGroupMember was issued');
  // finding 2, no record: every run looks at the group
  assert.deepEqual({ ...r.noRecord }, {
    empty: [], other: [], controlPlane: ['control_plane_is_a_member'], authority: ['authority_is_a_member'], broker: ['broker_is_a_member_without_a_record'],
    all: ['broker_is_a_member_without_a_record', 'control_plane_is_a_member', 'authority_is_a_member'],
  });
  assert.deepEqual(r.noRecordNoGroup, [], 'no group and no record: nothing to report');
  assert.deepEqual(r.statusNoRecord.clean, [], 'a clean group of an install without the grant adds no status line');
  assert.deepEqual(r.statusNoRecord.controlPlane, ['FAIL Hyper-V Administrators: control_plane_is_a_member']);
  assert.deepEqual(r.statusNoRecord.authority, ['FAIL Hyper-V Administrators: authority_is_a_member']);
  assert.deepEqual(r.statusNoRecord.broker, ['FAIL Hyper-V Administrators: broker_is_a_member_without_a_record']);
  assert.equal(r.statusLookupFails.hv.length, 1);
  assert.match(r.statusLookupFails.hv[0], /^unknown Hyper-V Administrators: the member list could not be read: the group lookup failed \(fake\)/u);
  assert.equal(r.statusLookupFails.laterLineStillThere, true, 'the rest of the status is still checked');
  // with a record
  assert.deepEqual({ ...r.recorded }, { ok: [], brokerGone: ['broker_not_a_member'], controlPlane: ['control_plane_is_a_member'], noGroup: ['group_missing'] });
  assert.deepEqual(r.statusRecorded.ok, ['ok Hyper-V Administrators: the Broker service SID is a member; albera-cp and the Authority are not'], 'a first-layout record: the legacy account is named; a new-layout record names AlberaControlPlane');
  assert.deepEqual(r.statusRecorded.controlPlane, ['FAIL Hyper-V Administrators: control_plane_is_a_member']);
  // the install step is done only when the record is there AND nothing is wrong
  assert.equal(r.stepClean, 'done');
  assert.equal(r.stepControlPlane, 'todo');
  assert.equal(r.stepAuthority, 'todo');
  assert.equal(r.stepBrokerGone, 'todo');
  assert.match(r.afterThrowGrantError, /control_plane_is_a_member/u);
  assert.equal(r.afterThrowStep, 'todo', 'a grant that threw after adding the Broker is not "done" on the next run');
  assert.equal(r.afterThrowFixedStep, 'done', 'done once albera-cp is out of the group');
  // the status also compares the Control Plane settings' desktop block with the helper hash the install recorded, but only for an install that has the grant record
  const desktopLine = (state, text) => [`${state} Control Plane settings desktop: ${text}`];
  assert.deepEqual(r.statusDesktop.asRecorded, desktopLine('ok', 'the installed pipe client helper and its recorded SHA-256, as written by install'));
  for (const name of ['otherHash', 'noBlock', 'noHelperRecord']) assert.deepEqual(r.statusDesktop[name], desktopLine('FAIL', 'not the helper path and SHA-256 the install recorded'), name);
  assert.deepEqual(r.statusDesktop.installWithoutGrant, [], 'an install without the grant has no such line: its status is unchanged');
  assert.deepEqual(r.statusDesktop.desktopWithoutGrantRecord, ['FAIL Control Plane settings desktop: a desktop block is present but the install record has no Hyper-V grant (install without -GrantHyperVToBroker writes none)'], 'a desktop block without a grant record was not written by this install');
});

test('Hyper-V grant, Control Plane settings (fakes for the machine): install with the option writes the desktop block from the installed helper and nothing else changes; without it the settings are the plain ones; a helper that is not the recorded one writes nothing', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'desktop');
  // the helper hash is the exe's own, recorded when the build was copied; Node hashes the same bytes the fixture wrote
  const exeSha = createHash('sha256').update('exe bytes of albera-windows-broker-pipe-client.exe').digest('hex');
  assert.equal(r.helperRecorded, exeSha);
  assert.equal(r.helperLive, exeSha);
  assert.match(r.helperPath, /\\Albera\\bin\\pipe-client\\albera-windows-broker-pipe-client\.exe$/u);
  // 1. without the option
  assert.equal(r.plainError, null);
  assert.deepEqual(r.plainWritten, ['AlberaHostBroker.service.json', 'AlberaApprovalAuthority.service.json', 'AlberaControlPlane.service.json', 'albera.approval.json']);
  const plain = JSON.parse(r.plainSettings);
  assert.deepEqual(Object.keys(plain), ['version', 'projectId', 'broker', 'authority', 'journal', 'computers'], 'no desktop key without the option, and no attestation key at all');
  assert.deepEqual(plain.computers, { 'albera-clone-01': 'clone-01' });
  assert.equal(r.plainBrokerHasComputers, false);
  assert.equal(r.plainTest, 'done', 'unchanged: existing files are enough without the option');
  // 2. with the option, over plain files
  assert.equal(r.grantTestOverPlain, 'todo', 'files written before the option have no desktop block yet');
  assert.equal(r.grantError, null);
  const grant = JSON.parse(r.grantSettings);
  assert.deepEqual(Object.keys(grant), ['version', 'projectId', 'broker', 'authority', 'journal', 'computers', 'desktop']);
  assert.deepEqual(grant.desktop, { helperPath: r.helperPath, helperSha256: exeSha });
  const { desktop, ...rest } = grant;
  assert.deepEqual(rest, plain, 'everything but the desktop block is the plain settings');
  assert.deepEqual(r.grantBrokerComputers, [{ computerId: 'clone-01', vmId: '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f' }], 'the Broker config still gets the VM GUID, as before');
  assert.equal(r.grantTestAfter, 'done');
  // 3. a file whose desktop block is not the installed helper's is rewritten, never trusted
  assert.equal(r.testOtherHash, 'todo');
  assert.equal(r.testOtherKey, 'todo');
  assert.equal(r.testRestored, 'done');
  // 4. the helper on disk is not the recorded one: refused, nothing written, the existing files stay
  assert.equal(r.replacedTest, 'todo');
  assert.match(r.replacedError, /the installed pipe client helper differs from the install record/u);
  assert.equal(r.replacedWritten, 0);
  assert.equal(r.replacedSettingsUntouched, true);
  // 5. no record, or no file
  assert.match(r.noRecordError, /the install record has no pipe client helper hash/u);
  assert.equal(r.noRecordWritten, 0);
  assert.match(r.noFileError, /the pipe client helper is not installed at /u);
  assert.equal(r.noFileWritten, 0);
  assert.equal(r.noFileTest, 'todo');
});

test('Hyper-V grant, the services step: the Broker SID type has to match this run\'s option in both directions; an unrestricted Broker without the option is put back to restricted and read back', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'hyperv');
  // begun WITH the option (unrestricted), run again WITHOUT it
  assert.equal(r.svcNoOptionWasUnrestricted.test, 'todo', 'before: this was "done" and the install completed with an unrestricted Broker and no grant');
  assert.equal(r.svcNoOptionWasUnrestricted.doError, null);
  assert.deepEqual(r.svcNoOptionWasUnrestricted.sidCalls, ['sidtype AlberaHostBroker restricted', 'sidtype AlberaApprovalAuthority restricted']);
  assert.equal(r.svcNoOptionWasUnrestricted.broker, 'restricted');
  assert.equal(r.svcNoOptionWasUnrestricted.authority, 'restricted');
  assert.equal(r.svcNoOptionWasUnrestricted.testAfter, 'done');
  // what did not change
  assert.deepEqual({ ...r.svcNoOptionRestricted }, { test: 'done', sidCalls: 0 }, 'no option and restricted: done, nothing issued (the result of an install without the option is as before)');
  assert.equal(r.svcOptionRestricted.test, 'todo');
  assert.equal(r.svcOptionRestricted.doError, null);
  assert.equal(r.svcOptionRestricted.broker, 'unrestricted');
  assert.equal(r.svcOptionRestricted.authority, 'restricted', 'the Authority stays restricted');
  assert.equal(r.svcOptionRestricted.testAfter, 'done');
  assert.equal(r.svcOptionUnrestricted, 'done');
});

test('uninstall runs to the end when the services were never started (empty data folders), with and without the grant (fakes for the machine; lab run 1 stopped at removing broker\\)', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'hyperv');
  const CP = 'S-1-5-21-1111111111-2222222222-3333333333-1500';
  assert.equal(r.emptyKnownFolderError, null, 'an empty known folder is removed, not "You cannot call a method on a null-valued expression"');
  const common = { error: null, services: [], keyGone: true, userRemoved: [CP], dataRootGone: true, installRootGone: true, members: [] };
  assert.deepEqual({ ...r.uninstallWithGrant }, { ...common, ran: ['hyperv', 'services', 'key', 'installroot', 'data', 'user', 'manifest'], removeCalls: [`remove S-1-5-32-578 ${r.grantMembers[0]}`] });
  assert.deepEqual({ ...r.uninstallWithoutGrant }, { ...common, ran: ['services', 'key', 'installroot', 'data', 'user', 'manifest'], removeCalls: [] }, 'runentry and shortcuts are skipped: the record has neither');
});

test('Hyper-V grant, Test-LocalGroupExists (real, read only): true for a group, false only for a SID that maps to nothing, anything else is thrown', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'group');
  assert.equal(r.administrators, true);
  assert.equal(r.unmapped, false);
  assert.ok(r.malformed, 'a malformed SID is an error, not "no group"');
});

test('Hyper-V grant, source guards for the group reads: no SilentlyContinue lookup of the group; the status reads the group whether or not there is a record', () => {
  const script = readFileSync(path.join(hostDir, 'albera-host.ps1'), 'utf8');
  assert.doesNotMatch(script, /Get-LocalGroup\b[^\n]*SilentlyContinue/u, 'a failed lookup must not read as "no group"');
  assert.match(script, /function Test-LocalGroupExists[\s\S]*?IdentityNotMappedException[\s\S]*?return \$false[\s\S]*?\bthrow\b/u);
  assert.match(script, /try \{ \$hvBad = Get-HyperVMemberProblems \}/u, 'status asks for the problems every time');
  assert.match(script, /\$hvRead -and \(\$grantRecorded -or \$hvBad\.Count -gt 0\)/u);
  assert.doesNotMatch(script, /if \(\$grantRecorded\) \{\s*\n\s*\$hvBad/u, 'the group check is not gated on the record any more');
  const lib = readFileSync(path.join(hostDir, 'albera-host-lib.ps1'), 'utf8');
  assert.match(lib, /\$BrokerRecorded -and -not \$brokerIn\) \{ \$reasons\.Add\('broker_not_a_member'\)/u);
  assert.match(lib, /-not \$BrokerRecorded -and \$brokerIn\) \{ \$reasons\.Add\('broker_is_a_member_without_a_record'\)/u);
});

test('Hyper-V grant, docs: the option, the owner decision, the undo and what is not verified are written down in host-install.md', () => {
  const doc = readFileSync(path.join(root, 'docs', 'architecture', 'host-install.md'), 'utf8');
  assert.match(doc, /^## Giving the Broker Hyper-V \(`-GrantHyperVToBroker`, optional\)$/mu);
  const section = doc.slice(doc.indexOf('## Giving the Broker Hyper-V'), doc.indexOf('## First approval'));
  assert.ok(section.length > 500);
  for (const needle of ['S-1-5-32-578', 'unrestricted', 'albera-cp', '-VmName', '-ComputerId', 'computers', 'install record', 'Remove-LocalGroupMember', 'Not verified', 'uninstall', 'ADR-002', 'sid_type_not_restricted']) assert.ok(section.includes(needle), `the section names ${needle}`);
  assert.match(section, /Without the option nothing changes/u);
  assert.match(section, /restricted token/u);
  assert.match(section, /never added|never gets/u);
  // the Control Plane settings are written by install, not edited by hand
  assert.match(section, /five extra things/u);
  assert.match(section, /\*\*Writes the gated room's `desktop` block into the Control Plane settings\*\*.*so nobody edits that file by hand/u);
  for (const needle of ['helperPath', 'helperSha256', 'albera-windows-broker-pipe-client.exe', 'between `computers` and `attestation`', 'no `desktop` key']) assert.ok(section.includes(needle), `the section names ${needle}`);
  assert.ok(!/edit it as an administrator/u.test(doc), 'no step tells the owner to edit the settings by hand');
  assert.match(doc, /\*\*An install with `-GrantHyperVToBroker` writes this block itself\*\*/u, 'the gated room section says the installer writes the block');
  assert.match(section, /\*\*Known limit of the `desktop` pin\.\*\*.*not against a hijacked `albera-cp`.*no Broker lease/u);
  assert.match(readFileSync(path.join(root, 'docs', 'architecture', 'adr-002-host-broker-trust-contract.md'), 'utf8'), /### Known limit: the helper pin in the Control Plane settings.*2026-11-03\+cp-settings-pin-scope/u);
  const adr = readFileSync(path.join(root, 'docs', 'architecture', 'adr-002-host-broker-trust-contract.md'), 'utf8');
  assert.match(adr, /Owner decision \(2026-11-03\): option A, the Broker as a whole runs with an unrestricted service SID/u);
});

test('Hyper-V grant, lab hook: a second pass installs WITH the option and checks group, sid type, privileges, config and the undo; it is BLOCKED (not passed) when the guest has no Hyper-V Administrators group', () => {
  const hook = readFileSync(labRunner, 'utf8');
  assert.match(hook, /GrantHyperVToBroker/u);
  assert.match(hook, /\$hvAdminsSid = 'S-1-5-32-578'/u);
  assert.match(hook, /Get-LocalGroup -SID \$hvAdminsSid/u);
  assert.match(hook, /'BLOCKED'/u);
  assert.match(hook, /VmId = \$labVmId/u, 'the fixed GUID goes in through the lab-only -VmId');
  for (const needle of ['UNRESTRICTED', 'SeChangeNotifyPrivilege', 'computers', 'albera-cp', 'NT SERVICE\\AlberaHostBroker', 'net.exe', 'groupBefore', 'groupAfter']) assert.ok(hook.includes(needle), `the hook checks ${needle}`);
  // the Control Plane settings: the grant pass checks the desktop block against a hash it computes itself; the default pass checks there is none
  assert.match(hook, /Add-GrantCheck \$checks 'control_plane_settings_desktop_block'/u);
  assert.match(hook, /\$helperHash = \(Get-FileHash -LiteralPath \$helperExe -Algorithm SHA256\)\.Hash\.ToLowerInvariant\(\)/u, 'the hash is taken by Get-FileHash, not read back from the installer');
  assert.match(hook, /'version,projectId,broker,authority,journal,computers,desktop'\)/u, 'no attestation key any more');
  assert.match(hook, /\$evidence\.defaultSettingsHasNoDesktop/u);
  assert.match(hook, /-and \$evidence\.defaultSettingsHasNoDesktop -and/u, 'a default install that wrote a desktop block fails the lab');
  assert.match(hook, /\$evidence\.grant = /u);
  assert.match(hook, /\(\$evidence\.grant\.status -ne 'FAIL'\)/u, 'a FAIL in the grant pass fails the lab; BLOCKED is reported, never counted as passed');
});

// ---- PR7: the Control Plane service install (control-plane-service.md sections 3, 8 and 9; PR #185 and #183 hand-over items) ----

test('Control Plane service: AlberaControlPlane has a derived service SID, no local account; the service config is exactly the host block, the claude block and the ui block the two programs read', needsWindows, () => {
  const { r } = lib();
  assert.equal(r.cp.service, 'AlberaControlPlane');
  assert.match(r.cp.sid, /^S-1-5-80(-\d+){5}$/u);
  assert.equal(r.cp.differsFromOthers, true);
  assert.equal(r.cp.sidShape, true);
  const config = JSON.parse(r.cfg.json);
  assert.deepEqual(r.cfg.top, ['host', 'claude', 'ui'], 'PR #185: nothing else at top level (the host reads `host`, room-service reads `claude` and `ui`)');
  // the nine keys HostConfig.cs reads, taken from its source
  const hostSource = readFileSync(path.join(root, 'src', 'runtime', 'windows-control-plane-host', 'HostConfig.cs'), 'utf8');
  const keysLine = /private static readonly string\[\] Keys = \[([^\]]+)\]/u.exec(hostSource)[1];
  assert.deepEqual([...r.cfg.host].sort(), [...keysLine.matchAll(/"([A-Za-z0-9]+)"/gu)].map((m) => m[1]).sort(), 'exactly the keys the host accepts');
  assert.deepEqual(r.cfg.claude, ['executable', 'executableSha256', 'maxMinutes', 'maxToolCalls'], 'PR #185 handover: claude = { executable, executableSha256, maxMinutes, maxToolCalls } (model is optional and left out)');
  assert.deepEqual(r.cfg.ui, ['controlPlaneSid', 'approverSid']);
  assert.deepEqual(config.host, {
    nodePath: 'C:\\Program Files\\Albera\\bin\\control-plane\\node\\node.exe', nodeSha256: 'ab'.repeat(32), appPath: 'C:\\Program Files\\Albera\\bin\\control-plane\\app',
    dataRoot: 'C:\\ProgramData\\Albera', logDirectory: 'C:\\ProgramData\\Albera\\control-plane\\logs', logMaxBytes: 1048576, maxRestarts: 5, restartDelayMs: 5000, stableRunMs: 60000,
  });
  assert.deepEqual(config.claude, { executable: 'C:\\Program Files\\Albera\\bin\\claude\\claude.exe', executableSha256: 'cd'.repeat(32), maxMinutes: 15, maxToolCalls: 120 }, 'the section 6.6 defaults');
  assert.deepEqual(config.ui, { controlPlaneSid: r.cp.sid, approverSid: r.shown.approverSid });
  // the values the host's parser bounds (HostConfig.cs): logMaxBytes 8 KiB..64 MiB, maxRestarts 0..20, restartDelayMs 100..10000, stableRunMs 500..3600000
  assert.ok(config.host.logMaxBytes >= 8 * 1024 && config.host.logMaxBytes <= 64 * 1024 * 1024);
  assert.ok(config.host.maxRestarts <= 20 && config.host.restartDelayMs >= 100 && config.host.restartDelayMs <= 10_000 && config.host.stableRunMs >= 500 && config.host.stableRunMs <= 3_600_000);
  assert.ok(config.claude.maxMinutes >= 1 && config.claude.maxMinutes <= 55 && config.claude.maxToolCalls >= 1 && config.claude.maxToolCalls <= 400, 'inside the room-service ceilings (PR #185)');
  for (const p of [config.host.nodePath, config.host.appPath, config.host.dataRoot, config.host.logDirectory, config.claude.executable]) assert.ok(/^[A-Za-z]:\\[^"*?:/]*$/u.test(p) && !p.includes('..'), `a plain absolute path: ${p}`);
  assert.ok(Buffer.byteLength(r.cfg.json) < 16 * 1024, 'inside the host\'s 16 KiB limit');
  assert.deepEqual(r.cfg.reasons, [], 'the script\'s own check accepts exactly what it writes');
  const expectBad = {
    otherNode: 'host_nodeSha256', otherClaude: 'claude_executableSha256', extraTopKey: 'config_keys', extraHostKey: 'host_keys', missingHostKey: 'host_keys', noClaude: 'config_keys', otherUiSid: 'ui_approverSid',
    cpSidIsAccount: 'ui_controlPlaneSid', portableNode: 'host_nodePath', maxMinutesString: 'claude_maxMinutes', notJson: 'config_syntax', tooBig: 'config_too_large',
  };
  for (const [name, reason] of Object.entries(expectBad)) assert.deepEqual(r.cfgBad[name], [reason], name);
  assert.deepEqual({ ...r.cfgInputsRefused }, { shortNode: 'node_sha256_invalid', accountAsCp: 'control_plane_sid_invalid', serviceAsApprover: 'approver_sid_invalid' });
});

test('services: all three start delayed; the Control Plane restarts twice after 5 s and then stays stopped; the failure actions are read from the registry bytes, not from localized sc.exe text; the Broker ACL names the Control Plane SERVICE SID', needsWindows, () => {
  const { r } = lib();
  assert.deepEqual({ ...r.failureBytes }, {
    ok: 0, okWithThirdNone: 0,
    none: ['failure_actions_not_two_restarts'], one: ['failure_actions_not_two_restarts'], three: ['failure_action_not_restart'],
    otherDelay: ['failure_restart_delay_differs'], reboot: ['failure_action_not_restart'], rebootSecond: ['failure_actions_not_two_restarts', 'failure_action_not_restart'], runCommand: ['failure_action_not_restart'],
    otherReset: ['failure_reset_period_differs'],
    noBytes: ['failure_actions_unreadable'], tooShort: ['failure_actions_unreadable'], countTooBig: ['failure_actions_unreadable'], arrayPastTheEnd: ['failure_actions_unreadable'],
    realSpooler: ['failure_reset_period_differs'],
  });
  const lib_ = readFileSync(path.join(hostDir, 'albera-host-lib.ps1'), 'utf8');
  const hostScript = readFileSync(path.join(hostDir, 'albera-host.ps1'), 'utf8');
  assert.equal(/qfailure/u.test(lib_.replace(/#.*$/gmu, '')) || /qfailure/u.test(hostScript.replace(/#.*$/gmu, '')), false, 'no English or localized text of sc qfailure is parsed');
  assert.match(hostScript, /OpenSubKey\('SYSTEM\\CurrentControlSet\\Services\\' \+ \$Name\)/u, 'the failure actions are read from the service key');
  assert.equal(r.cpFacts.ok, 0);
  assert.deepEqual(r.cpFacts.noFailureActions, ['failure_actions_not_two_restarts'], 'the Control Plane\'s own facts check the failure actions');
  assert.equal(r.cpFacts.brokerNeedsNoFailureActions, 0, 'the Broker and the Authority are not asked for any');
  assert.equal(r.sddlCpService.ok, 0, 'SYSTEM, Administrators and the Control Plane service SID with exactly LC');
  assert.match(r.sddlCpService.sddl, new RegExp(`\\(A;;LC;;;${r.cp.sid}\\)$`, 'u'));
  assert.deepEqual(r.sddlCpService.accountSidFails, [`unexpected_principal:${r.cp.sid}`, 'control_plane_ace_missing'], 'an account SID is not what the Broker config names now');
  const script = readFileSync(path.join(hostDir, 'albera-host.ps1'), 'utf8');
  assert.match(script, /Invoke-Sc "config \$\(\$Spec\.Name\) start= delayed-auto"/u, 'a service of an older run (start=demand) is brought to delayed-auto');
  assert.match(script, /if \(\$Spec\.RestartOnFailure\) \{ Invoke-Sc \(Get-ScFailureArguments \$Spec\.Name\) \| Out-Null \}/u);
  assert.match(script, /\$facts\.StartMode -ne 'Auto' -or \$facts\.DelayedAutoStart -ne \$true\) \{ return 'todo' \}/u, 'the services step is todo for a service that is still start=demand');
});

test('the Control Plane files: the settings the service can only read sit in control-plane-config, the journal in control-plane; manifest records name only fixed values', needsWindows, () => {
  const { r } = lib();
  assert.equal(r.cpShapeOk, 0, 'a new-layout record with the pins, launcher, shortcuts, run entry and run id is a valid manifest');
  const expected = {
    otherServiceSid: 'control_plane_record', badNodeHash: 'control_plane_record', extraCpKey: 'control_plane_record', badClaudeHash: 'claude_record', longVersion: 'claude_record', badLauncher: 'launcher_record',
    shortcutName: 'shortcut_name_not_fixed', runName: 'run_entry_record', runNotDictionary: 'run_entry_record', topLevelKey: 'manifest_key:owner', runIdText: 'setup_run_id', runIdNegative: 'setup_run_id',
    runIdTooBig: 'setup_run_id', unknownService: 'service_name_not_fixed',
  };
  for (const [name, reason] of Object.entries(expected)) assert.deepEqual(r.cpShapeBad[name], [reason], name);
});

test('anti-rollback in the script: the run id is an unsigned 64-bit number compared as a number; an older run is refused, the same one is fine, nothing supplied bounds nothing', needsWindows, () => {
  const { r } = lib();
  assert.deepEqual(r.runId.parse, ['1234567', '0', '18446744073709551615', null, null, null, null, null, null, null, null, '12', null, '1234567'],
    'decimal digits only: no sign, no exponent, no space, nothing past 2^64-1; a leading zero is read as the number');
  assert.deepEqual({ ...r.runId.refusal }, {
    nothingSupplied: null, emptySupplied: null, noRecord: null, older: 'setup_run_id_older_than_installed', same: null, newer: null, numericNotText: 'setup_run_id_older_than_installed',
    textOrderWouldSayNewer: null, biggest: 'setup_run_id_older_than_installed', biggestSame: null, suppliedJunk: 'setup_run_id_invalid', recordedJunk: 'recorded_setup_run_id_invalid',
  });
  // the floor in the registry (kept by uninstall) is compared as well: the larger of it and the record decides, and a floor that is there but is not a decimal number refuses
  assert.deepEqual({ ...r.runId.floor }, {
    older: 'setup_run_id_older_than_floor', same: null, newer: null, floorBeatsRecord: 'setup_run_id_older_than_floor', recordBeatsFloor: 'setup_run_id_older_than_installed',
    numericNotText: 'setup_run_id_older_than_floor', biggest: 'setup_run_id_older_than_floor', noFloor: null, nothingSupplied: null,
    junk: 'setup_run_id_floor_invalid', empty: 'setup_run_id_floor_invalid', notAString: 'setup_run_id_floor_invalid', negative: 'setup_run_id_floor_invalid', tooBig: 'setup_run_id_floor_invalid',
  });
});

test('the pins and the launcher: claude.exe comes from the approver\'s own profile and only when the approver is the elevated account; the launcher script is ASCII, parses and does what the contract says (run against fakes)', needsWindows, () => {
  const { r } = lib();
  assert.equal(r.pins.node, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(r.pins.claude, 'C:\\Users\\Yosuke\\.local\\bin\\claude.exe');
  assert.equal(r.pins.claudeNoProfile, null, 'a profile path with .. is no path');
  assert.equal(r.pins.claudeRelative, null);
  assert.equal(r.pins.refusalSame, null);
  assert.equal(r.pins.refusalOtherAdmin, 'elevated_account_is_not_the_approver');
  assert.equal(r.pins.refusalSystem, 'elevated_sid_is_not_a_user_account');
  assert.equal(r.pins.refusalNoApprover, 'elevated_account_is_not_the_approver');
  assert.deepEqual({ ...r.pins.labGate }, { lab: true, notLab: 'binary_source_parameter_is_lab_only', none: true });
  assert.deepEqual({ ...r.open }, { ascii: true, parseErrors: 0, crlf: true, hasService: true, hasRoomFile: true, noPlaceholder: true });
  const runs = r.openRuns;
  assert.deepEqual(runs.good, { exited: false, started: ['http://127.0.0.1:51234/room/#b=AbCdEfGhIjKlMnOpQrStUv_-12'], said: '' }, 'the fragment form of section 4: the code never goes to the server');
  for (const name of ['serviceStopped', 'noFile', 'notJson', 'codeWithSpace', 'codeShort', 'portLow', 'portText', 'pidText', 'otherProcessHoldsThePort', 'nobodyHoldsThePort']) {
    assert.equal(runs[name].exited, true, `${name}: the launcher stops`);
    assert.deepEqual(runs[name].started, [], `${name}: and opens nothing`);
    assert.match(runs[name].said, /ALBERA: /u, `${name}: and says why`);
  }
  assert.match(runs.serviceStopped.said, /AlberaControlPlane is Stopped/u);
  assert.match(runs.otherProcessHoldsThePort.said, /not held by the ALBERA process/u, 'the PID that owns the port is the one room.json names (section 4, port squatting)');
});

test('shortcuts and the Run entry: the contract\'s names, the full path of powershell.exe, the approver tray under HKLM Run', needsWindows, () => {
  const { r } = lib();
  assert.deepEqual(r.shortcuts.specs, [
    { path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\ALBERA\\Open ALBERA.lnk', target: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      arguments: '-NoProfile -ExecutionPolicy Bypass -File "C:\\Program Files\\Albera\\bin\\launcher\\open-albera.ps1"', workingDirectory: 'C:\\Program Files\\Albera\\bin\\launcher' },
    { path: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\ALBERA\\ALBERA update.lnk', target: 'C:\\Program Files\\Albera\\bin\\setup\\albera-setup.exe', arguments: '', workingDirectory: 'C:\\Program Files\\Albera\\bin\\setup' },
  ]);
  assert.deepEqual(r.shortcuts.withoutSetup, ['Open ALBERA.lnk'], 'the update shortcut only where albera-setup.exe is installed');
  assert.equal(r.shortcuts.matchSame, 0);
  assert.equal(r.shortcuts.matchCaseOfPath, 0, 'paths are compared the Windows way');
  assert.deepEqual(r.shortcuts.otherTarget, ['shortcut_target_differs']);
  assert.deepEqual(r.shortcuts.otherArguments, ['shortcut_arguments_differ']);
  assert.deepEqual(r.shortcuts.otherArgumentsCase, ['shortcut_arguments_differ'], 'arguments exactly');
  assert.deepEqual(r.shortcuts.missing, ['shortcut_missing']);
  assert.deepEqual({ ...r.run }, { keyPath: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'AlberaApprover', command: '"C:\\Program Files\\Albera\\bin\\approver\\AlberaApprover.exe" --tray' });
});

test('migration helpers (pure): what the first layout holds is carried over, and a record or config that does not agree is refused with a reason', needsWindows, () => {
  const { r, inputs } = lib();
  const ok = (x) => ({ approverKeyId: x.values.ApproverKeyId, approverSid: x.values.ApproverSid, vmName: x.values.VmName, computerId: x.values.ComputerId, projectId: x.values.ProjectId });
  assert.equal(r.legacy.noGrant.ok, true);
  assert.deepEqual(ok(r.legacy.noGrant), { approverKeyId: 'hello-0123456789abcdef', approverSid: 'S-1-5-21-1111111111-2222222222-3333333333-1001', vmName: 'albera-clone-01', computerId: 'clone-01', projectId: 'albera-host' });
  assert.equal(r.legacy.noGrant.values.ApproverPublicKey, inputs.rsa2048, 'the Hello public key is carried over byte for byte');
  assert.equal(r.legacy.noGrant.values.Grant, null);
  assert.equal(r.legacy.noGrant.values.LegacySid, 'S-1-5-21-1111111111-2222222222-3333333333-1500');
  assert.deepEqual({ ...r.legacy.grant.values.Grant }, { ComputerId: 'clone-01', VmId: '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f' }, 'the VM GUID of the record, no lookup by name');
  const refused = {
    partial: 'legacy_install_not_complete', newLayout: 'legacy_install_not_complete', badAuthority: 'authority_config:audience', badBroker: 'broker_config:config_syntax',
    grantButBrokerWithoutComputers: 'broker_config_disagrees_with_grant_record', grantComputerDiffers: 'grant_computer_differs_from_settings', twoComputers: 'settings_not_one_computer',
    settingsNotJson: 'settings_syntax', badVmName: 'settings_computer_invalid', badProject: 'settings_not_one_computer',
  };
  for (const [name, reason] of Object.entries(refused)) { assert.equal(r.legacy[name].ok, false, name); assert.deepEqual(r.legacy[name].reasons, [reason], name); assert.equal(r.legacy[name].values, null); }
});

test('Control Plane install steps against a temp layout (fakes for the machine): the pins, the service order, the launcher and shortcuts, adopting the install root, anti-rollback', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, (t) => {
  const r = harness(t, 'cp');
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const CP = 'S-1-5-80';
  // 1. node.exe
  assert.equal(r.nodeBefore, 'todo');
  assert.equal(r.nodeError, null);
  assert.equal(r.nodeShaOfCopy, sha('fake node bytes'));
  assert.equal(r.nodeShaOfCopy, r.nodeShaOfSource, 'the hash of the COPY is what is recorded');
  assert.deepEqual(Object.keys(r.nodeRecord).sort(), ['nodeSha256', 'nodeSource', 'serviceSid']);
  assert.equal(r.nodeRecord.nodeSha256, r.nodeShaOfCopy);
  assert.ok(r.nodeRecord.serviceSid.startsWith(CP));
  assert.deepEqual(r.nodeRecordOnDisk, r.nodeRecord, 'saved to the manifest');
  assert.equal(r.nodePartialLeft, false);
  assert.equal(r.nodeAfter, 'done');
  assert.match(r.nodeTampered, /^blocked:.*node\.exe exists but is not the copy the install record describes/u);
  assert.match(r.nodeSourceMissing, /^blocked:node\.exe not found at /u);
  assert.match(r.nodeSourceLink, /^blocked:node\.exe is reached through a link/u);
  // 2. claude.exe
  assert.equal(r.claudeBefore, 'todo');
  assert.equal(r.claudeError, null);
  assert.equal(r.claudeShaOfCopy, sha('fake claude bytes'));
  assert.equal(r.claudeShaOfCopy, r.claudeShaOfSource);
  assert.deepEqual(Object.keys(r.claudeRecord).sort(), ['fileVersion', 'sha256', 'source']);
  assert.equal(r.claudeRecord.sha256, r.claudeShaOfCopy);
  assert.equal(r.claudeRecord.fileVersion, '', 'read from the file\'s version resource (a text file has none); the program is never run');
  assert.match(r.claudeRecord.source, /\\profile\\\.local\\bin\\claude\.exe$/u, 'found from the approver SID\'s profile');
  assert.equal(r.claudeAfter, 'done');
  assert.match(r.claudeOtherAdmin, /^blocked:elevated_account_is_not_the_approver/u);
  assert.match(r.claudeOtherAdminDoError, /^elevated_account_is_not_the_approver/u);
  assert.equal(r.claudeOtherAdminNothingCopied, true);
  assert.match(r.claudeSystem, /^blocked:elevated_sid_is_not_a_user_account/u);
  assert.equal(r.claudeNoProfile, 'blocked:claude.exe cannot be located');
  assert.match(r.claudeNotInstalled, /^blocked:claude\.exe not found at .*empty-profile\\\.local\\bin\\claude\.exe$/u);
  assert.equal(r.claudeLabSource, 'todo', 'the lab-only source replaces the lookup');
  assert.match(r.claudeLabSourceOtherAdmin, /^blocked:elevated_account_is_not_the_approver/u, 'but not the account rule');
  assert.equal(r.claudeDoAgainError, null);
  // 3. the service
  assert.equal(r.cpBefore, 'todo');
  assert.match(r.cpRefusedError, /launch-check of the installed Control Plane host answered 78, so the service was NOT registered/u);
  assert.deepEqual(r.cpRefusedOrder, ['launch-check'], 'a host that refuses: no sc.exe call at all');
  assert.equal(r.cpRefusedRegistered, false);
  assert.equal(r.cpRefusedRecorded, false);
  assert.equal(r.cpError, null);
  const verbs = r.cpOrder.map((line) => line.replace(/^sc (\w+) .*$/u, 'sc $1'));
  assert.deepEqual(verbs, ['launch-check', 'sc create', 'sc config', 'sc sidtype', 'sc privs', 'sc failure'], 'launch-check first; then create, delayed start, SID type, privileges, failure actions');
  assert.match(r.cpOrder[1], /start= delayed-auto type= own$/u);
  assert.match(r.cpOrder[1], /albera-control-plane-host\.exe\\" service \\".*control-plane-config\\AlberaControlPlane\.service\.json\\""/u, '`service <config>`');
  assert.equal(r.cpOrder[2], 'sc config AlberaControlPlane start= delayed-auto');
  assert.equal(r.cpOrder[3], 'sc sidtype AlberaControlPlane restricted');
  assert.equal(r.cpOrder[4], 'sc privs AlberaControlPlane SeChangeNotifyPrivilege');
  assert.equal(r.cpOrder[5], 'sc failure AlberaControlPlane reset= 86400 actions= restart/5000/restart/5000//0');
  assert.equal(r.cpRecorded, true);
  assert.equal(r.cpRecordedOnDisk, true);
  assert.equal(r.cpAfter, 'done');
  // what the SCM stores for `sc failure ... actions= restart/5000/restart/5000//0` (REG_BINARY FailureActions: reset 86400, 3 actions at offset 20: restart 5000, restart 5000, none)
  const le = (...numbers) => numbers.flatMap((n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
  assert.deepEqual({ ...r.cpState }, { auto: true, delayed: true, sid: 'restricted', privs: 'SeChangeNotifyPrivilege', failure: le(86400, 0, 0, 3, 20, 1, 5000, 1, 5000, 0, 0) });
  assert.match(r.cpForeign, /^blocked:service AlberaControlPlane already exists and was not created by this script/u);
  assert.equal(r.cpNotDelayed, 'todo'); assert.equal(r.cpNoFailureActions, 'todo'); assert.equal(r.cpExtraPrivilege, 'todo');
  assert.equal(r.cpDriftFixed, 'done');
  // 4. launcher, shortcuts, Run entry
  assert.equal(r.shBefore, 'todo');
  assert.equal(r.shError, null);
  assert.equal(r.shLauncherIsShipped, true, 'the launcher on disk is the text the script makes, nothing else');
  assert.deepEqual(r.shLauncherRecord, { sha256: r.shLauncherSha });
  assert.deepEqual(r.shShortcutsRecord, ['Open ALBERA.lnk'], 'no setup installed: no update shortcut');
  assert.deepEqual(r.shLinks, ['Open ALBERA.lnk']);
  assert.deepEqual({ ...r.shRunRecord }, { name: 'AlberaApprover', command: r.shRunValue });
  assert.match(r.shRunValue, /\\bin\\approver\\AlberaApprover\.exe" --tray$/u);
  assert.deepEqual(r.shUsersGrants, [r.launcherDir], 'BUILTIN\\Users get read and execute on bin\\launcher (the owner\'s session runs it)');
  assert.equal(r.shTrustedDirs.length, 1);
  assert.match(r.shTrustedDirs[0], /\\Start Menu\\Programs\\ALBERA \| \*S-1-5-18:\(OI\)\(CI\)F \*S-1-5-32-544:\(OI\)\(CI\)F \*S-1-5-32-545:\(OI\)\(CI\)RX$/u, 'the shortcut folder is born with its final ACL: everyone reads, administrators write');
  assert.equal(r.shAfter, 'done');
  assert.deepEqual({ ...r.shOnDisk }, { launcher: true, shortcuts: ['Open ALBERA.lnk'], run: true });
  assert.equal(r.shWithSetupBefore, 'todo', 'setup appeared: the update shortcut is missing');
  assert.equal(r.shWithSetupError, null);
  assert.deepEqual(r.shWithSetupRecord, ['Open ALBERA.lnk', 'ALBERA update.lnk']);
  assert.equal(r.shWithSetupAfter, 'done');
  // the update shortcut starts setup.exe elevated: only a file and folder that pass the trust test, and - when setup left the copy it verified - exactly that copy
  assert.match(r.setupFileUntrusted.problem, /^albera-setup\.exe cannot be trusted: .*albera-setup\.exe cannot be trusted \(owner_untrusted\)/u);
  assert.deepEqual(r.setupFileUntrusted.links, ['Open ALBERA.lnk']);
  assert.match(r.setupFolderUntrusted.problem, /^albera-setup\.exe cannot be trusted: .*bin\\setup cannot be trusted \(writer_untrusted:S-1-5-32-545\)/u);
  assert.deepEqual(r.setupFolderUntrusted.links, ['Open ALBERA.lnk']);
  assert.match(r.setupNotTheVerifiedCopy.problem, /is not the copy setup verified in this update \(the SHA-256 differs\)/u);
  assert.deepEqual(r.setupNotTheVerifiedCopy.links, ['Open ALBERA.lnk']);
  assert.equal(r.setupIsTheVerifiedCopy.problem, null);
  assert.deepEqual(r.setupIsTheVerifiedCopy.links, ['Open ALBERA.lnk', 'ALBERA update.lnk']);
  assert.deepEqual(r.setupLinksNow, ['Open ALBERA.lnk', 'ALBERA update.lnk']);
  assert.equal(r.shRunChanged, 'todo'); assert.equal(r.shLauncherChanged, 'todo'); assert.equal(r.shLinkChanged, 'todo');
  assert.equal(r.shRestoredError, null); assert.equal(r.shRestored, 'done');
  assert.match(r.shReadBackWrongError, /is not as intended: shortcut_target_differs/u, 'a shortcut that reads back wrong is an error');
  // 5. adopting the install root
  assert.equal(r.adoptAbsent, 0);
  assert.equal(r.adoptSetupOnly, 0, 'only albera-setup.exe\'s own folders: adoptable');
  assert.equal(r.adoptFoldersTest, 'todo');
  assert.deepEqual(r.adoptReadme, ['unknown_entry:readme.txt']);
  assert.match(r.adoptReadmeFoldersTest, /^blocked:.* exists but was not created by this script and is not only albera-setup\.exe's own folders \(unknown_entry:readme\.txt\)/u);
  assert.deepEqual(r.adoptOurFolder, ['unknown_entry:bin\\broker', 'unknown_entry:bin\\broker\\x.exe'], 'a leftover of ours that the record does not know is not adopted');
  assert.deepEqual(r.adoptJunction, ['link_or_junction_inside']);
  // everything below bin\setup and setup-work is read, files included: owner SYSTEM / Administrators / TrustedInstaller and no other writer
  assert.deepEqual(r.adoptSetupExeUserOwned, ['bin\\setup\\albera-setup.exe:owner_untrusted', 'bin\\setup\\albera-setup.exe:writer_untrusted:S-1-5-21-1111111111-2222222222-3333333333-1001']);
  assert.deepEqual(r.adoptDeepFileUsersWrite, ['setup-work\\abc123\\copy\\repo\\x.txt:writer_untrusted:S-1-5-32-545'], 'a file deep inside setup-work that Users can write');
  assert.deepEqual(r.adoptDeepFolderUserOwned, ['setup-work\\abc123\\copy\\repo:owner_untrusted', 'setup-work\\abc123\\copy\\repo:writer_untrusted:S-1-5-21-1111111111-2222222222-3333333333-1001'], 'a sub-folder owned by the owner\'s account');
  assert.deepEqual(r.adoptCreatorOwnerOnTheFolder, ['bin:writer_untrusted:S-1-3-0'], 'CREATOR OWNER that applies to the folder itself is a writer');
  assert.deepEqual(r.adoptUnreadable, ['bin\\setup\\albera-setup.exe:acl_unreadable'], 'an ACL that cannot be read refuses');
  assert.equal(r.adoptTrustedInstaller, 0, 'TrustedInstaller as owner and writer is accepted (the same set as FileSystemChecks.cs)');
  assert.deepEqual(r.adoptUntrusted, ['owner_untrusted']);
  assert.match(r.adoptUntrustedFoldersTest, /^blocked:/u);
  assert.equal(r.adoptDoError, null);
  assert.equal(r.adoptRecorded, true);
  assert.equal(r.adoptRecordedOnDisk, true);
  assert.ok(r.adoptUsersGrants.includes(r.setupBinDir), 'the setup folder gets its Users read-and-execute rule back after the root lost the inherited one');
  assert.deepEqual(r.adoptUsersGrants.filter((p) => p !== r.setupBinDir), [], 'and no other folder of the install gets one here');
  assert.match(r.adoptAclFirst, /^acl .*\\pf\\Albera$/u, 'the adopted root gets the plan\'s ACL like any other folder');
  assert.equal(r.adoptSetupKept, true);
  assert.match(r.foreignRootDoError, /exists but was not created by this script and is not only albera-setup\.exe's own folders \(unknown_entry:someone-elses\.txt\)/u);
  // 6. anti-rollback and the first-layout guard
  assert.deepEqual(JSON.parse(JSON.stringify(r.rollback)), {
    id99: { refusal: 'setup_run_id_older_than_installed', blocked: true }, id100: { refusal: null, blocked: false }, id101: { refusal: null, blocked: false },
    id18446744073709551615: { refusal: null, blocked: false }, id: { refusal: null, blocked: false }, none: { refusal: null },
  });
  assert.match(r.rollbackMessage, /^blocked:setup_run_id_older_than_installed: this run is 99; the install record holds setupRunId 100 and the floor of this PC \(HKLM\\SOFTWARE\\Albera\\SetupRunIdFloor\) is none\. An older \(validly attested\) build is never installed over a newer one$/u);
  assert.deepEqual({ ...r.ratchetUp }, { memory: '101', disk: '101' });
  assert.deepEqual({ ...r.ratchetNotDown }, { memory: '101', disk: '101' }, 'the recorded run id never goes down');
  assert.equal(r.ratchetMax, '18446744073709551615');
  assert.equal(r.ratchetFirst, '7');
  assert.match(r.legacyGuard, /^blocked:the install record is from the first layout \(the local account albera-cp\)\. Run -Mode migrate/u);
  assert.deepEqual({ legacy: r.legacyLayout.legacy, cp: r.legacyLayout.sids.cp, flag: r.legacyLayout.sids.legacyFlag }, { legacy: true, cp: 'S-1-5-21-1111111111-2222222222-3333333333-1500', flag: true }, 'a first-layout record keeps its account SID as the Control Plane for uninstall and migrate');
  assert.deepEqual({ ...r.newLayout }, { legacy: false, cpIsServiceSid: true, approver: 'S-1-5-21-1111111111-2222222222-3333333333-1001' });
  // 7. the floor: the install record goes away with uninstall, the floor in the registry does not
  assert.deepEqual({ ...r.floorRefusal }, {
    floorOlder: 'setup_run_id_older_than_floor', recordOlder: 'setup_run_id_older_than_installed', floorOnlyOlder: 'setup_run_id_older_than_floor', floorOnlySame: null, floorOnlyNewer: null,
    noFloorNoRecord: null, junk: 'setup_run_id_floor_invalid', empty: 'setup_run_id_floor_invalid', notAString: 'setup_run_id_floor_invalid', biggest: 'setup_run_id_older_than_floor',
  }, 'the LARGER of the record and the floor decides; a floor that is there and is not a decimal number is a refusal, never "no floor"');
  assert.equal(r.floorRatchet.nothingSupplied, null, 'a run without -SetupRunId writes nothing');
  assert.deepEqual(r.floorRatchet.steps, ['150', '150', '200', '200', '18446744073709551615', '18446744073709551615'], 'the floor only ever goes up');
  assert.match(r.floorJunkNotOverwritten.error, /is not a decimal number; an administrator must correct or delete that one value\. It was not changed/u);
  assert.equal(r.floorJunkNotOverwritten.value, 'abc', 'a floor that cannot be read is never overwritten by the script');
  assert.equal(r.floorWithoutManifest, '300', 'it is written even when there is no install record (yet)');
  assert.equal(r.floorDoError, null);
  assert.equal(r.floorAfterInstall, '500', 'the sources step of an install with run 500 raises the floor to 500');
  assert.ok(r.floorUninstallIds.includes('manifest'));
  assert.equal(r.floorUninstallError, null);
  assert.equal(r.floorRecordGone, true, 'uninstall removed the install record and the data root');
  assert.equal(r.floorAfterUninstall, '500', 'and left the floor');
  assert.equal(r.floorOlderAfterUninstall.refusal, 'setup_run_id_older_than_floor', 'an older, validly attested build is refused after uninstall');
  assert.match(r.floorOlderAfterUninstall.test, /^blocked:setup_run_id_older_than_floor: this run is 400; the install record holds setupRunId none and the floor of this PC .* is 500\./u);
  assert.equal(r.floorSameAfterUninstall, null);
  assert.equal(r.floorNewerAfterUninstall, null);
  // 8. the real Grant-UsersReadExecute and Get-UsersAceProblems
  assert.equal(r.usersGrantError, null);
  assert.deepEqual(r.usersNativeCalls, [`C:\\fake\\icacls.exe | "${r.usersDir}" /grant:r *S-1-5-32-545:(OI)(CI)RX /L`], 'one icacls call, this folder only (/L, no /T): read and execute, inherited by what is inside');
  assert.match(r.usersReadBackMissing, /is not as intended after the change: users_ace_missing/u);
  assert.match(r.usersReadBackWrite, /is not as intended after the change: users_can_write/u);
  assert.match(r.usersIcaclsFails, /^icacls failed for /u);
  assert.match(r.usersLinkError, /is reached through a link; refusing to change its ACL/u);
  assert.equal(r.usersLinkNativeCalls, 0, 'no icacls call for a path behind a link');
  assert.deepEqual(JSON.parse(JSON.stringify(r.usersProblems)), {
    rx: { shouldHave: [], shouldNot: ['users_ace_unexpected'] },
    none: { shouldHave: ['users_ace_missing'], shouldNot: [] },
    write: { shouldHave: ['users_can_write'], shouldNot: ['users_ace_unexpected'] },
  });
});

test('-Mode migrate against a temp layout (fakes for the machine): nothing is removed unless the new install can be made; the account\'s processes stop by PID first; the Hello values, VM GUID and grant come back; setup\'s own folders stay', { skip: !windows && 'Windows PowerShell only', timeout: 480_000 }, (t) => {
  const r = harness(t, 'migrate');
  // A. refusals leave everything where it was
  assert.match(r.preflight.error, /^REFUSED: claude\.exe not found at /u);
  assert.equal(r.preflight.orderIsEmpty, true, 'not one sc.exe call, process stop, key or account change happened');
  assert.equal(r.preflight.same, true);
  assert.equal(r.preflight.journalKept, true);
  assert.deepEqual(r.preflight.pidsKept, [4101, 4102]);
  assert.match(r.preflightNoBuild.error, /^REFUSED: approver: publish folder missing \(run npm run build:approver\)/u);
  assert.equal(r.preflightNoBuild.orderIsEmpty, true);
  assert.match(r.preflightNoHash.error, /-ExpectedTreeHash <64 hex> is required/u, 'without -TrustLocalBuilds or a typed hash there is nothing to compare the copies with');
  assert.equal(r.preflightNoHash.orderIsEmpty, true);
  assert.match(r.partial.error, /^REFUSED: legacy_install_not_complete/u);
  assert.equal(r.partial.orderIsEmpty, true);
  assert.deepEqual({ ...r.notLegacy }, { exit: 0, orderIsEmpty: true });
  assert.deepEqual({ ...r.noRecord }, { exit: 0, orderIsEmpty: true });
  assert.match(r.badConfig.error, /^REFUSED: authority_config:audience/u);
  assert.equal(r.badConfig.orderIsEmpty, true);
  // B. without the grant
  assert.deepEqual(r.leadIds, ['legacy', 'preflight', 'disable', 'stop']);
  assert.deepEqual(r.planBefore, ['todo', 'todo', 'todo', 'todo']);
  assert.equal(r.runError, null);
  assert.equal(r.exit, 0);
  assert.deepEqual({ ...r.after }, {
    layoutLegacy: false, state: 'complete', services: ['AlberaApprovalAuthority', 'AlberaControlPlane', 'AlberaHostBroker'], user: false, profile: false, key: true, pids: [], members: [],
    binaries: ['approver', 'authority', 'broker', 'control-plane', 'pipe-client'], createdKeys: ['binaries', 'claude', 'controlPlane', 'dataRoot', 'installRoot', 'key', 'launcher', 'runEntry', 'services', 'shortcuts'],
  });
  const verb = (line) => line.replace(/^(sc \w+|stop pid \d+|group (?:add|remove)|Disable-LocalUser|Remove-LocalUser|remove profile|delete key|create key|launch-check).*$/u, '$1');
  const steps = r.order.map(verb);
  const at = (what) => steps.indexOf(what);
  assert.equal(r.stopBeforeUninstall, true, 'the account\'s processes stop first, by PID');
  assert.deepEqual(steps.slice(0, 8), ['Disable-LocalUser', 'stop pid 4101', 'stop pid 4102', 'sc delete', 'sc delete', 'delete key', 'Remove-LocalUser', 'remove profile'], 'the account is disabled first, then its processes stop (by PID), then services (the Control Plane\'s client last), key, then the account and its profile');
  assert.match(r.order[0], /^Disable-LocalUser S-1-5-21-1111111111-2222222222-3333333333-1500$/u, 'disabled by SID');
  assert.deepEqual([...new Set(r.order.filter((line) => line.startsWith('users-rx ')))].sort(), ['users-rx approver', 'users-rx launcher', 'users-rx setup'], 'BUILTIN\\Users get read and execute on three folders of the new install and no other');
  assert.ok(at('remove profile') < at('sc create'), 'the new install comes after the removal');
  assert.ok(at('create key') > at('sc create') && at('launch-check') > at('create key'), 'a new Authority key; the Control Plane service last, after launch-check');
  assert.equal(r.order.filter((line) => /taskkill|Stop-Process|\/IM/iu.test(line)).length, 0);
  assert.equal(r.carried.authority.approverKeyId, 'hello-0123456789abcdef');
  assert.equal(r.carried.authority.approverSid, 'S-1-5-21-1111111111-2222222222-3333333333-1001');
  assert.equal(r.carried.authority.approverPublicKey.length, 392, 'the Hello public key came over unchanged');
  assert.match(r.carried.authority.controlPlaneSid, /^S-1-5-80(-\d+){5}$/u, 'the Authority now trusts the Control Plane SERVICE SID, not an account (closes the ADR-002 known gap)');
  assert.equal(r.carried.brokerCp, r.carried.authorityCp);
  assert.equal(r.carried.service.ui.controlPlaneSid, r.carried.authorityCp);
  assert.equal(r.carried.service.ui.approverSid, 'S-1-5-21-1111111111-2222222222-3333333333-1001');
  assert.equal(r.carried.settings.projectId, 'legacy-project', 'the old project id and VM name');
  assert.deepEqual({ ...r.carried.settings.computers }, { 'legacy-vm-name': 'clone-01' });
  assert.equal('desktop' in r.carried.settings, false, 'no grant, no desktop block');
  assert.equal('attestation' in r.carried.settings, false);
  assert.equal(r.carried.brokerHasComputers, false);
  assert.deepEqual({ ...r.gone }, { legacySettings: true, oldDll: true, journal: true, oldBrokerDb: true }, 'lost by design: the journals');
  assert.deepEqual({ ...r.kept }, { setupExe: true, setupWork: true, manifestOnDisk: true }, 'what albera-setup.exe keeps in the install folder stays');
  assert.deepEqual({ ...r.newFiles }, { node: true, claude: true, open: true, config: true, secrets: true, ui: true, logs: true });
  assert.deepEqual(r.record.services, ['AlberaHostBroker', 'AlberaApprovalAuthority', 'AlberaControlPlane']);
  assert.equal(r.record.hasGrant, false);
  assert.equal(r.record.approverSid, 'S-1-5-21-1111111111-2222222222-3333333333-1001');
  assert.equal(r.record.approverKeyId, 'hello-0123456789abcdef');
  assert.deepEqual(r.statusAfter, [], 'the status of the migrated install is all ok');
  assert.deepEqual({ ...r.migrateAgain }, { exit: 0 }, 'a second run says there is nothing to migrate');
  // C. with the grant
  assert.equal(r.grantRunError, null);
  assert.equal(r.grantExit, 0);
  assert.equal(r.grant.removeBeforeDelete, true, 'the Broker\'s SID leaves Hyper-V Administrators before its service is deleted');
  assert.equal(r.grant.addedBack, true, 'and goes back in once the new service exists');
  assert.deepEqual(r.grant.broker, [{ computerId: 'clone-01', vmId: '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f' }], 'the recorded VM GUID, no lookup');
  assert.deepEqual(r.grant.desktop.helperPath.endsWith('\\bin\\pipe-client\\albera-windows-broker-pipe-client.exe'), true);
  assert.match(r.grant.desktop.helperSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual({ ...r.grant.settingsComputers }, { 'legacy-vm-name': 'clone-01' });
  assert.deepEqual([r.grant.sidTypeBroker, r.grant.sidTypeAuthority, r.grant.sidTypeCp], ['unrestricted', 'restricted', 'restricted']);
  assert.equal(r.grant.members.length, 1, 'only the Broker is in the group');
  assert.equal(r.grant.recordGrant.vmId, '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f');
  assert.ok(r.grantAfter.createdKeys.includes('hyperVGrant'));
  // a process that cannot be stopped stops the run before anything is uninstalled
  assert.match(r.stuck.error, /processes of albera-cp are still running \(PID 4101, 4102\); nothing was uninstalled/u);
  assert.equal(r.stuck.removedNothing, true);
  assert.deepEqual(r.stuck.pids, [4101, 4102]);
  // D. the account is checked once more and disabled BEFORE any process is stopped; a failure leaves everything as it was (nothing stopped, nothing removed)
  assert.match(r.disableRefusals.sidDiffers.error, /is not the one the old install made \(sid_differs\); nothing was changed/u);
  assert.match(r.disableRefusals.descriptionDiffers.error, /is not the one the old install made \(description_differs\); nothing was changed/u);
  assert.match(r.disableRefusals.nameDiffers.error, /is not the one the old install made \(live_name_not_fixed\); nothing was changed/u);
  assert.match(r.disableRefusals.stillEnabled.error, /is still enabled after Disable-LocalUser; no process was stopped/u);
  for (const [name, refusal] of Object.entries(r.disableRefusals)) {
    assert.equal(refusal.stopped, false, `${name}: no process was stopped`);
    assert.equal(refusal.sc, false, `${name}: no service was touched`);
    assert.equal(refusal.userKept, true, `${name}: the account was not removed`);
    assert.deepEqual(refusal.pids, [4101, 4102], `${name}: both processes still run`);
    assert.equal(refusal.disableCalled, name === 'stillEnabled', `${name}: Disable-LocalUser is only called after the second ownership check passed`);
  }
  // E. unknown files, links and unknown install entries are found by the preflight, before the account is touched
  assert.match(r.preflightUnknown.dataFile.error, /holds files this script did not create \(authority\\my-notes\.txt\); move or delete them first/u);
  assert.match(r.preflightUnknown.dataLink.error, /is or contains a link or junction/u);
  assert.match(r.preflightUnknown.installEntry.error, /holds files this script did not create \(bin\\evil[^)]*\); move or delete them first/u);
  for (const [name, refusal] of Object.entries(r.preflightUnknown)) {
    assert.equal(refusal.orderIsEmpty, true, `${name}: not one sc.exe call, process stop, key or account change happened`);
    assert.equal(refusal.userEnabled, true, `${name}: the account was not disabled`);
    assert.deepEqual(refusal.pidsKept, [4101, 4102], `${name}: the processes were not stopped`);
    assert.equal(refusal.targetIntact, true, `${name}: a link target was never touched`);
  }
});

test('migrate and install: the command line (the new parameters are validated, the lab ones are gated, migrate takes no approver values and accepts a typed hash or the explicit local-builds switch, never both)', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  const before = snapshot();
  const code = (args, env) => host(args, { allowFail: true, env });
  // "accepted": past the argument checks (exit 2 and a REFUSED line are the checks). What a plan does after that needs the PC's own ProgramData, which this test does not control.
  const accepted = (result) => result.code !== 2 && !/REFUSED/u.test(result.stdout);
  assert.equal(code(['-Mode', 'plan', '-SetupRunId', 'abc']).code, 2);
  assert.match(code(['-Mode', 'plan', '-SetupRunId', '12x']).stdout, /-SetupRunId must be a decimal number/u);
  assert.equal(code(['-Mode', 'plan', '-SetupRunId', '18446744073709551616']).code, 2, 'larger than an unsigned 64-bit number');
  assert.equal(code(['-Mode', 'status', '-SetupRunId', '5']).code, 2);
  assert.match(code(['-Mode', 'status', '-SetupRunId', '5']).stdout, /-SetupRunId only applies to install and migrate/u);
  assert.equal(accepted(code(['-Mode', 'plan', '-SetupRunId', '5', '-ExpectedTreeHash', 'a'.repeat(64)])), true, 'a valid run id with an install plan');
  assert.match(code(['-Mode', 'plan', '-NodeSource', 'C:\\x\\node.exe'], { ALBERA_LAB_VM: '' }).stdout, /-NodeSource and -ClaudeSource are lab-only/u);
  assert.match(code(['-Mode', 'plan', '-ClaudeSource', 'C:\\x\\claude.exe'], { ALBERA_LAB_VM: '' }).stdout, /lab-only/u);
  assert.equal(code(['-Mode', 'plan', '-ClaudeSource', 'relative\\claude.exe'], { ALBERA_LAB_VM: '1' }).code, 2);
  assert.equal(code(['-Mode', 'status', '-NodeSource', 'C:\\x\\node.exe'], { ALBERA_LAB_VM: '1' }).code, 2, 'only install and migrate take them');
  assert.equal(accepted(code(['-Mode', 'plan', '-NodeSource', 'C:\\x\\node.exe'], { ALBERA_LAB_VM: '1' })), true, 'in the lab VM with ALBERA_LAB_VM=1 they are accepted');
  assert.match(code(['-Mode', 'plan', '-TrustLocalBuilds']).stdout, /-TrustLocalBuilds only applies to -Mode migrate/u);
  assert.match(code(['-Mode', 'migrate', '-TrustLocalBuilds', '-ExpectedTreeHash', 'a'.repeat(64)], { ALBERA_HOST_ASSUME_NOT_ELEVATED: '' }).stdout, /exclude each other|needs an elevated console/u);
  const notElevated = host(['-Mode', 'migrate', '-TrustLocalBuilds'], { env: { ALBERA_HOST_ASSUME_NOT_ELEVATED: '1' }, allowFail: true });
  assert.equal(notElevated.code, 3);
  assert.match(notElevated.stdout, /REFUSED: migrate needs an elevated console/u);
  assert.doesNotMatch(notElevated.stdout, /^\s*\d+\. /mu, 'no step ran');
  assert.equal(accepted(code(['-Mode', 'plan', '-PlanFor', 'migrate', '-ApproverKeyId', 'hello-0123456789abcdef'])), true, 'a plan only reads');
  const migrateWithApprover = host(['-Mode', 'migrate', '-ApproverKeyId', 'hello-0123456789abcdef'], { env: { ALBERA_HOST_ASSUME_NOT_ELEVATED: '1' }, allowFail: true });
  assert.equal(migrateWithApprover.code, 3, 'not elevated is checked first');
  assert.match(code(['-Mode', 'plan', '-GrantHyperVToBroker', '-PlanFor', 'migrate']).stdout, /-GrantHyperVToBroker only applies to -Mode install/u, 'migrate follows what the old record says');
  assert.deepEqual(snapshot(), before);
});

test('the Control Plane install, source guards: no repository file is executed, the three services are delayed, the service is registered only after launch-check, the setup run id is compared as a number, nothing is signed or published here', () => {
  const script = readFileSync(path.join(hostDir, 'albera-host.ps1'), 'utf8');
  const lib = readFileSync(path.join(hostDir, 'albera-host-lib.ps1'), 'utf8');
  const code = (text) => text.split('\n').filter((line) => !/^\s*#/u.test(line)).join('\n');
  const scriptCode = code(script);
  // the order inside New-ControlPlaneService: launch-check, then the service
  const body = scriptCode.slice(scriptCode.indexOf('function New-ControlPlaneService'), scriptCode.indexOf('# ----', scriptCode.indexOf('function New-ControlPlaneService')));
  assert.ok(body.indexOf('Invoke-LaunchCheck') > 0 && body.indexOf('Invoke-LaunchCheck') < body.indexOf('New-OneService'), 'launch-check first');
  assert.match(body, /if \(\$check\.Exit -ne 0\) \{ throw /u, 'a host that does not answer 0 stops the run');
  // the install steps: the configs step comes after the pins and before the service
  const ids = [...scriptCode.matchAll(/\[pscustomobject\]@\{ Id = '(\w+)'; Title = /gu)].map((m) => m[1]);
  assert.deepEqual(ids.slice(0, 13), ['sources', 'approver', 'dataroot', 'services', 'folders', 'binaries', 'key', 'node', 'claude', 'configs', 'cpservice', 'shortcuts', 'finish']);
  // the pins are made by one copy function: open the source ONCE (nobody else may write it meanwhile), check the final path of that handle, copy from the handle, hash the COPY, rename, trust-check
  assert.match(scriptCode, /function Copy-PinnedFile[\s\S]*?New-Object System\.IO\.FileStream\(\$Source, \[System\.IO\.FileMode\]::Open, \[System\.IO\.FileAccess\]::Read, \[System\.IO\.FileShare\]::Read\)[\s\S]*?Get-FinalPathOfStream \$in[\s\S]*?\[string\]::Equals\(\$final, \$expected, \[System\.StringComparison\]::OrdinalIgnoreCase\)[\s\S]*?\$in\.CopyTo\(\$out\)[\s\S]*?\$sha = Get-Sha256File \$partial[\s\S]*?Move-Item -LiteralPath \$partial -Destination \$Destination/u);
  const pinnedBody = scriptCode.slice(scriptCode.indexOf('function Copy-PinnedFile'), scriptCode.indexOf('function ', scriptCode.indexOf('function Copy-PinnedFile') + 10));
  assert.equal(/\[System\.IO\.File\]::Copy\(|Copy-Item/u.test(pinnedBody), false, 'the pins are not copied by path (a link swapped in after the check would be followed)');
  assert.match(scriptCode, /DefinePInvokeMethod\('GetFinalPathNameByHandleW'/u, 'GetFinalPathNameByHandle through System.Reflection.Emit');
  assert.equal(/Add-Type(?! -AssemblyName System\.Web\.Extensions)/u.test(scriptCode), false, 'no Add-Type (it would start the C# compiler from an elevated session)');
  // node.exe (file and folder) passes the trust test before it is copied; claude.exe lives in the owner's own profile and has no such test by design
  assert.match(scriptCode, /function Get-NodePinProblem \{[\s\S]*?Get-PathTrustReasons \$p \(Get-AdminSids\) \$false/u);
  // M1: BUILTIN\Users get read and execute on exactly three folders of the install; nothing else under it
  assert.deepEqual([...new Set([...scriptCode.matchAll(/Grant-UsersReadExecute \$L\.(\w+)/gu)].map((m) => m[1]))].sort(), ['ApproverBinDir', 'LauncherDir', 'SetupBinDir']);
  assert.equal(code(lib).includes('S-1-5-32-545'), false, 'the ACL plan of the install folder names no BUILTIN\\Users');
  // H1: the floor is written and read in the 64-bit registry view, and nothing ever removes it (the one registry delete is the Run entry)
  assert.match(scriptCode, /OpenBaseKey\(\[Microsoft\.Win32\.RegistryHive\]::LocalMachine, \[Microsoft\.Win32\.RegistryView\]::Registry64\)/u);
  assert.deepEqual([...scriptCode.matchAll(/DeleteValue|DeleteSubKey\w*|Remove-ItemProperty|Remove-Item\s+(?:-Path\s+)?'?(?:HKLM|Registry)/gu)].map((m) => m[0]), ['DeleteValue'], 'one registry delete in the whole script');
  const runDelete = scriptCode.slice(scriptCode.indexOf('function Remove-RunEntryValue'), scriptCode.indexOf('function ', scriptCode.indexOf('function Remove-RunEntryValue') + 10));
  assert.match(runDelete, /DeleteValue\(\$e\.Name, \$false\)/u);
  const floorLines = [...(scriptCode + code(lib)).matchAll(/^.*(?:Remove|Delete)[^\n]*SetupRunIdFloor.*$/gmu)].map((m) => m[0].trim());
  assert.equal(floorLines.length, 1, 'only the manifest step\'s own text names the floor next to the word Remove');
  assert.match(floorLines[0], /^\[pscustomobject\]@\{ Id = 'manifest'; .*SetupRunIdFloor is NOT removed/u, 'and it says the floor is NOT removed');
  // deleting a tree never follows a link: Remove-TreeNoFollow is the only deleter of a folder tree
  assert.equal(/Remove-Item[^\n]*-Recurse/u.test(scriptCode), false, 'no recursive Remove-Item');
  // the failure actions are read from the service key (REG_BINARY), not from localized sc.exe text
  assert.equal(/qfailure/u.test(scriptCode + code(lib)), false);
  assert.doesNotMatch(scriptCode, /Invoke-Native[^\n]*\$(?:NodeSource|ClaudeSource|nodeSource|claudeSource)|& \$(?:NodeSource|ClaudeSource)/u, 'neither pinned program is ever started');
  assert.match(scriptCode, /FileVersionInfo\]::GetVersionInfo\(\$L\.ClaudeExe\)\.FileVersion/u, 'the version comes from the file\'s resource');
  assert.doesNotMatch(scriptCode + code(lib), /claude(?:\.exe)? --version|--version/u, 'claude --version is never run while elevated');
  // the profile is found from the registry's profile list by SID, not from an environment variable
  assert.match(scriptCode, /ProfileList\\' \+ \$Sid/u);
  assert.doesNotMatch(scriptCode + code(lib), /\$env:(?:USERPROFILE|HOME|APPDATA|LOCALAPPDATA|ProgramFiles|ProgramData|TEMP|TMP|PATH)\b/iu);
  // the Run key is HKLM, written with .NET; the shortcuts through the shell link object, read back
  assert.match(scriptCode, /\[Microsoft\.Win32\.Registry\]::LocalMachine\.CreateSubKey\(\$e\.KeyPath\)/u);
  assert.doesNotMatch(scriptCode, /HKCU|CurrentUser/u, 'nothing is written into a user hive');
  assert.match(scriptCode, /New-Object -ComObject WScript\.Shell/u);
  assert.match(scriptCode, /\$bad = Test-ShortcutMatches \$spec \(Read-ShellLink \$spec\.Path\)/u, 'every shortcut is read back');
  // anti-rollback: the number is compared as a number, in the library; the script only asks
  assert.match(lib, /\$s -lt \$r\) \{ return 'setup_run_id_older_than_installed' \}/u);
  assert.match(lib, /\$s -lt \$f\) \{ return 'setup_run_id_older_than_floor' \}/u);
  assert.match(lib, /\[uint64\]::TryParse\(\$text, \[System\.Globalization\.NumberStyles\]::None/u);
  // the migration removes processes by PID of an owner SID and the profile only when it is C:\Users\albera-cp exactly
  assert.match(scriptCode, /\$expected = Join-Path 'C:\\Users' \$K\.ControlPlaneUser/u);
  // nothing here signs, publishes, downloads or reaches the network
  assert.doesNotMatch(scriptCode + code(lib), /Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|DownloadFile|System\.Net\.|gh attestation|curl |wget /iu);
  // the docs the owner reads: the header names migrate and the contract's section
  assert.match(script, /-Mode migrate \(-ExpectedTreeHash <64 hex> \| -TrustLocalBuilds\)/u);
});

test('the lab runner refuses to run outside the lab VM', { skip: !windows && 'Windows PowerShell only', timeout: 240_000 }, () => {
  const result = ps(['-File', labRunner, '-HostScriptDir', hostDir, '-RepoRoot', root],{ allowFail: true, env: { ALBERA_LAB_VM: '' } });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + (result.stderr ?? ''), /lab VM|ALBERA_LAB_VM/u);
});
