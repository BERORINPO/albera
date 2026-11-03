import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { buildServiceLab, currentUserSid, getUnavailableReason, makeTrustedTempDirectory } from '../helpers/windows-broker-harness.mjs';
import { runWithGuestFunctions } from './guest-functions.mjs';

// Easy setup, stage 1: the Control Plane moves from an ordinary user to NT SERVICE\AlberaControlPlane (restricted service SID, SeChangeNotifyPrivilege only). The lab that measures what that
// identity can do is lab-vm.ps1 -ControlPlaneService -> lab-control-plane-service.ps1 (guest) with the `cp` probes of the shim (ControlPlaneProbe.cs) and cp-node-probe.mjs. The VM run is the lead's.
// Here: the scripts' text, the PowerShell parse, the verdict logic (loaded out of the guest script on its own, fed made-up probe lines), and the probes themselves on the host, where every one of
// them is harmless (a DPAPI round trip, a loopback socket, one file in a temp folder, one HTTPS attempt at a closed local port). What this cannot show is the service identity: that is the VM.
const labDir = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(path.join(labDir, name), 'utf8');
const guest = read('lab-control-plane-service.ps1');
const driver = read('lab-vm.ps1');
const readme = read('README.md');
const guestPath = path.join(labDir, 'lab-control-plane-service.ps1');
const windowsOnly = { skip: process.platform !== 'win32' && 'Windows PowerShell only', timeout: 120_000 };

const IDS = ['cp0_token', 'cp1_node_sqlite', 'cp2_pipe_client_helper', 'cp3_dpapi_currentuser', 'cp3_profile', 'cp4_dpapi_other_identity_refused', 'cp5_tcp_loopback_other_user', 'cp6_programdata_acl', 'cp7_outbound_https'];
const EXPECTED = { cp0_token: 'PASS', cp1_node_sqlite: 'PASS', cp2_pipe_client_helper: 'PASS', cp3_dpapi_currentuser: 'PASS', cp3_profile: 'MEASURED', cp4_dpapi_other_identity_refused: 'PASS', cp5_tcp_loopback_other_user: 'MEASURED', cp6_programdata_acl: 'PASS', cp7_outbound_https: 'BLOCKED' };

test('the Control Plane service lab scripts are ASCII only (Windows PowerShell 5.1 reads them without a BOM)', () => {
  for (const [name, text] of [['lab-control-plane-service.ps1', guest], ['lab-vm.ps1', driver]]) assert.equal(/[^\t\r\n -~]/u.test(text), false, name);
});

test('both scripts parse', windowsOnly, () => {
  const parser = '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:ALBERA_PARSE_TARGET, [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }; exit 1 }';
  for (const name of ['lab-control-plane-service.ps1', 'lab-vm.ps1']) {
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parser], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, ALBERA_PARSE_TARGET: path.join(labDir, name) } });
    assert.equal(out.status, 0, `${name}: ${out.stdout}${out.stderr}`);
  }
});

test('the guest script refuses to run outside the lab VM, before it creates anything', windowsOnly, () => {
  assert.ok(guest.indexOf("$env:ALBERA_LAB_VM -ne '1'") < guest.indexOf('$CpSvc ='), 'the refusal is the first statement after the parameters');
  assert.ok(guest.indexOf("$env:ALBERA_LAB_VM -ne '1'") < guest.indexOf('& sc.exe create'));
  const env = { ...process.env }; delete env.ALBERA_LAB_VM;
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', guestPath, 'C:\\albera-cp-lab-never-created', 'cleanup'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env });
  assert.notEqual(out.status, 0);
  assert.match(`${out.stdout}${out.stderr}`, /refusing to run/u);
});

test('seven measurements, nine checks: ids, titles and expected statuses agree with each other and with the README', () => {
  const block = (name) => guest.slice(guest.indexOf(`$${name} = [ordered]@{`), guest.indexOf('\n}\n', guest.indexOf(`$${name} = [ordered]@{`)));
  assert.deepEqual([...block('CpTitles').matchAll(/^ {2}(cp\w+)\s+= '/gmu)].map((m) => m[1]), IDS);
  assert.deepEqual(Object.fromEntries([...block('CpExpected').matchAll(/(cp\w+) = '([A-Z]+)'/gu)].map((m) => [m[1], m[2]])), EXPECTED);
  for (const id of IDS) {
    assert.ok(readme.includes(`\`${id}\``), `README names ${id}`);
    assert.match(guest, new RegExp(`(Step|Add-Check) '${id}'`, 'u'), `${id} is produced`);
  }
  // The statuses the task asks for, and nothing else.
  assert.deepEqual([...guest.matchAll(/New-CpResult '([A-Z]+)'/gu)].map((m) => m[1]).filter((s, i, a) => a.indexOf(s) === i).sort(), ['BLOCKED', 'FAIL', 'MEASURED', 'PASS']);
});

test('the stand-in services are virtual accounts in the Control Plane shape; no Hyper-V group, no elevation, no downloads, no password', () => {
  assert.match(guest, /\$CpSvc = 'AlberaControlPlane'/u, 'the name ADR-002 gives the Control Plane');
  assert.match(guest, /& sc\.exe sidtype \$svc restricted/u);
  assert.match(guest, /& sc\.exe privs \$svc SeChangeNotifyPrivilege/u, 'only SeChangeNotifyPrivilege');
  assert.match(guest, /obj= "NT SERVICE\\\$svc"/u, 'a virtual account');
  assert.doesNotMatch(guest, /localgroup[^\n]*\/add|Add-LocalGroupMember/iu, 'no service joins any group');
  assert.doesNotMatch(guest, /-Verb\s+RunAs|\bRunAs\b/iu);
  // A process is only ever stopped by the PID this lab started; a bulk stop by name (taskkill /IM, Stop-Process -Name, killall) once took down every node on a shared PC.
  for (const text of [guest, driver, read('cp-node-probe.mjs'), read('ControlPlaneProbe.cs')]) assert.doesNotMatch(text, /taskkill|Stop-Process|killall|pkill|Get-Process\b[^\n]*\|[^\n]*Stop/iu);
  assert.doesNotMatch(guest, /Invoke-WebRequest|Invoke-RestMethod|Install-Module|Start-BitsTransfer|\bcurl\b|\bwget\b/iu, 'no downloads');
  assert.doesNotMatch(guest, /PSCredential|SecureString|ConvertTo-SecureString/iu, 'the guest script never sees a password (lab-person.ps1 keeps its own)');
  assert.match(guest, /lab-person\.ps1/u, 'the shareholder stand-in comes from the existing person tool');
  assert.match(guest, /node\.exe/u);
  assert.match(guest, /\$NodeExe = 'C:\\Program Files\\nodejs\\node\.exe'/u);
});

test('node:sqlite is exercised as the service child, through the shim, not from the guest session', () => {
  assert.match(guest, /Invoke-CpJob \$CpSvc 'node' \$NodeExe @\(\$NodeProbe, "\$LabRoot\\results\\\$CpSvc\\journal"\)/u);
  const probe = read('cp-node-probe.mjs');
  for (const pragma of ['PRAGMA foreign_keys = ON', 'PRAGMA busy_timeout = 5000', 'PRAGMA journal_mode = WAL', 'PRAGMA synchronous = FULL', 'PRAGMA quick_check(1)']) assert.ok(probe.includes(pragma), pragma);
  const store = readFileSync(path.join(labDir, '..', '..', 'src', 'runtime', 'sqlite-operation-store.mjs'), 'utf8');
  for (const pragma of ['PRAGMA foreign_keys = ON', 'PRAGMA busy_timeout = 5000', 'PRAGMA journal_mode = WAL', 'PRAGMA synchronous = FULL', 'PRAGMA quick_check(1)']) assert.ok(store.includes(pragma), `the real store still uses ${pragma}`);
});

test('lab-vm.ps1 -ControlPlaneService: its own lab, the standard 4 GB VM, no Authority build, Node from the golden image or the host (signed, hash-checked, never downloaded)', () => {
  assert.match(driver, /\[switch\]\$ControlPlaneService/u);
  assert.match(driver, /\[string\]\$HostNodeExe = \(Join-Path \$env:ProgramFiles 'nodejs\\node\.exe'\)/u);
  assert.match(driver, /if \(\$ControlPlaneService -and \(\$HyperV -or \$HostInstall\)\) \{ throw/u);
  assert.match(driver, /\$vmMemoryGB = if \(\$HyperV\) \{ 5 \} else \{ 4 \}/u, 'no nested virtualization, no extra memory');
  assert.match(driver, /if \(\$ControlPlaneService\) \{\s+\$cpOut = @\(Invoke-ControlPlaneServiceLab[\s\S]*?\}\s+elseif \(\$HyperV\) \{/u);
  const nodeFunction = driver.slice(driver.indexOf('function Install-GuestNode'), driver.indexOf('function Invoke-ControlPlaneServiceLab'));
  assert.match(nodeFunction, /if \(\$present\) \{[^}]*return 'golden' \}/u, 'nothing is copied when the image has Node');
  assert.match(nodeFunction, /Get-AuthenticodeSignature/u);
  assert.match(nodeFunction, /\$signature\.Status -ne 'Valid'\) \{ throw/u);
  assert.match(nodeFunction, /22\b[\s\S]*13/u, 'node:sqlite needs 22.13');
  assert.match(nodeFunction, /\$guestHash -ne \$hash\) \{ throw/u, 'the guest copy is compared with the host file');
  assert.match(nodeFunction, /Copy-Item -ToSession \$Session -Path \$HostNode -Destination \$GuestNode/u);
  assert.doesNotMatch(driver, /Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|\bcurl\b|\bwget\b|DownloadFile/iu, 'nothing is downloaded');
  const lab = driver.slice(driver.indexOf('function Invoke-ControlPlaneServiceLab'), driver.indexOf('$golden = '));
  assert.match(lab, /\$env:ALBERA_LAB_VM = '1'/u);
  assert.match(lab, /cp-node-probe\.mjs/u);
  assert.match(lab, /lab-person\.ps1/u);
  assert.match(lab, /-ArgumentList \$guestRoot, 'run', \$nodeSource/u);
  assert.match(lab, /if \(\$KeepVm\) \{ try \{ Invoke-Command -Session \$session -FilePath \$guestScript -ArgumentList \$guestRoot, 'cleanup'/u, 'guest cleanup only with -KeepVm; otherwise the VM is deleted');
  assert.match(lab, /if \(\$results\.setupError -or \$unexpected\.Count -gt 0 -or \$checks\.Count -eq 0\) \{ return 1 \}/u, 'exit 1 unless every check is the expected status');
  assert.match(driver, /-not \$HyperV -and -not \$ControlPlaneService\) \{\s+& npm run build:approval-authority/u);
  assert.match(driver, /-not \$HostInstall -and -not \$HostMigrate -and -not \$HyperV -and -not \$ControlPlaneService\) \{\s+& node scripts\/windows-service-lab-inputs\.mjs/u);
});

test('the shim routes `cp` to the probe, which is BCL only and writes nothing but the one file it is told to create', () => {
  assert.match(read('Probes.cs'), /case \["cp", \.\. var rest\]: return ControlPlaneProbe\.Run\(rest\);/u);
  const project = read('AlberaLabServiceShim.csproj');
  assert.doesNotMatch(project, /PackageReference|Reference Include/u, 'still BCL only (ProtectedData is a package, so DPAPI goes through crypt32)');
  const code = read('ControlPlaneProbe.cs').replace(/\/\/[^\n]*/gu, '');
  assert.doesNotMatch(code, /Process\.Start|File\.Delete|Directory\.Delete|File\.WriteAllText|SetAccessControl\((?!wanted)|Registry\.\w+\.(Create|Set|Delete)/u);
  assert.match(code, /CryptProtectData\(ref input, IntPtr\.Zero, ref extra, IntPtr\.Zero, IntPtr\.Zero, CryptUiForbidden, out output\)/u, 'CurrentUser scope: no LOCAL_MACHINE flag, with entropy');
  assert.doesNotMatch(code, /LocalMachine\s*=|0x4\b.*CryptProtect/u);
  assert.match(code, /new TcpListener\(IPAddress\.Loopback, 0\)|TcpListener listener = new\(IPAddress\.Loopback, 0\)/u, 'loopback only, port 0');
  assert.match(code, /FileSystemRights\.Modify[\s\S]*FileSystemRights\.Read \| FileSystemRights\.Synchronize/u);
  assert.match(code, /SetAccessRuleProtection\(true, false\)/u, 'a protected DACL: nothing inherited, nothing copied');
});

// ---- the verdict logic, loaded by itself out of the guest script
const PURE = ['Get-AsciiText', 'New-CpResult', 'Test-CpTokenShape', 'Get-CpNodeVerdict', 'Get-CpHelperVerdict', 'Get-CpDpapiVerdict', 'Get-CpProfileObservation',
  'Get-CpOtherIdentityVerdict', 'Get-CpTcpVerdict', 'ConvertTo-CpRights', 'Get-CpAclVerdict', 'Get-CpHttpsVerdict', 'Get-CpUnexpected'];
const CP_SID = 'S-1-5-80-111-222-333-444-555';
const HOLDER_SID = 'S-1-5-21-1-2-3-1001';
const goodAcl = () => ({ ok: true, protected: true, inheritedAces: [{ sid: 'S-1-5-32-545', inherited: true }, { sid: 'S-1-5-18', inherited: true }],
  finalAces: [{ sid: CP_SID, type: 'Allow', rights: '0x001301BF', inherited: false }, { sid: HOLDER_SID, type: 'Allow', rights: '0x00120089', inherited: false }] });
const goodToken = (over = {}) => ({ user: { sid: CP_SID }, groups: [{ sid: 'S-1-1-0', attributes: ['mandatory', 'enabled'] }, { sid: 'S-1-5-32-544', attributes: ['deny_only'] }],
  restrictedSids: [{ sid: CP_SID }, { sid: 'S-1-1-0' }], hasRestrictions: true, privileges: [{ name: 'SeChangeNotifyPrivilege', enabled: true }], ...over });

const cases = {
  items: [
    // cp1
    { name: 'node-not-run', fn: 'node', line: null, ran: false },
    { name: 'node-silent', fn: 'node', line: null, ran: true },
    { name: 'node-ok', fn: 'node', line: { ok: true, nodeVersion: 'v24.13.0', sqliteVersion: '3.50.4' }, ran: true },
    { name: 'node-fail', fn: 'node', line: { ok: false, step: 'open', error: { name: 'Error', code: 'ERR_SQLITE_ERROR' } }, ran: true },
    // cp2
    { name: 'helper-ok', fn: 'helper', a: { ok: false, code: 'broker_unavailable' }, b: { ok: false, code: 'broker_unavailable' }, ran: true },
    { name: 'helper-service-mode-cannot-resolve', fn: 'helper', a: { ok: false, code: 'broker_unavailable' }, b: { ok: false, code: 'server_identity_unavailable' }, ran: true },
    { name: 'helper-silent', fn: 'helper', a: null, b: null, ran: true },
    { name: 'helper-not-run', fn: 'helper', a: null, b: null, ran: false },
    // cp3
    { name: 'dpapi-ok', fn: 'dpapi', line: { ok: true, roundTrip: true, wrongEntropyRefused: true }, ran: true },
    { name: 'dpapi-no-roundtrip', fn: 'dpapi', line: { ok: true, roundTrip: false, wrongEntropyRefused: true }, ran: true },
    { name: 'dpapi-entropy-ignored', fn: 'dpapi', line: { ok: true, roundTrip: true, wrongEntropyRefused: false }, ran: true },
    { name: 'dpapi-protect-failed', fn: 'dpapi', line: { ok: false, win32: 5 }, ran: true },
    { name: 'dpapi-silent', fn: 'dpapi', line: null, ran: true },
    { name: 'dpapi-not-run', fn: 'dpapi', line: null, ran: false },
    { name: 'profile-seen', fn: 'profile', line: { profile: { userProfileEnv: 'C:\\Windows\\ServiceProfiles\\X', appDataEnv: 'C:\\A', userProfileFolderExists: true, registryHiveLoaded: true, profileListPath: 'C:\\P', masterKeyFolderExists: true, masterKeyFileCount: 2 } } },
    { name: 'profile-none', fn: 'profile', line: null },
    // cp4
    { name: 'other-all-refused', fn: 'other', results: [{ Name: 'other_virtual_account', Line: { ok: false, win32: 13 } }, { Name: 'local_user', Line: { ok: false, win32: 13 } }, { Name: 'administrator', Line: { ok: false, win32: 13 } }] },
    { name: 'other-admin-opened', fn: 'other', results: [{ Name: 'other_virtual_account', Line: { ok: false, win32: 13 } }, { Name: 'administrator', Line: { ok: true, matches: true } }] },
    { name: 'other-admin-not-measured', fn: 'other', results: [{ Name: 'other_virtual_account', Line: { ok: false, win32: 13 } }, { Name: 'administrator', Line: null }] },
    { name: 'other-blob-unreadable', fn: 'other', results: [{ Name: 'other_virtual_account', Line: { ok: false, setupError: 'UnauthorizedAccessException' } }, { Name: 'administrator', Line: { ok: false, win32: 13 } }] },
    // cp5
    { name: 'tcp-connected', fn: 'tcp', ready: { state: 'ready', address: '127.0.0.1', port: 5 }, clients: [{ Name: 'local_user', Line: { ok: true } }, { Name: 'administrator', Line: { ok: true } }] },
    { name: 'tcp-refused', fn: 'tcp', ready: { state: 'ready', address: '127.0.0.1', port: 5 }, clients: [{ Name: 'local_user', Line: { ok: false, socketError: 'ConnectionRefused' } }, { Name: 'administrator', Line: { ok: true } }] },
    { name: 'tcp-listen-failed', fn: 'tcp', ready: { state: 'error', socketError: 'AccessDenied' }, clients: [] },
    { name: 'tcp-no-listener', fn: 'tcp', ready: null, clients: [] },
    { name: 'tcp-no-client-line', fn: 'tcp', ready: { state: 'ready', address: '127.0.0.1', port: 5 }, clients: [{ Name: 'local_user', Line: null }] },
    // cp6
    { name: 'acl-ok', fn: 'acl', acl: goodAcl(), hr: 'opened', hw: 'denied', or: 'denied', ran: true },
    { name: 'acl-third-ace', fn: 'acl', acl: { ...goodAcl(), finalAces: [...goodAcl().finalAces, { sid: 'S-1-5-32-545', type: 'Allow', rights: '0x00120089', inherited: false }] }, hr: 'opened', hw: 'denied', or: 'denied', ran: true },
    { name: 'acl-inherited-left', fn: 'acl', acl: { ...goodAcl(), finalAces: goodAcl().finalAces.map((a, i) => ({ ...a, inherited: i === 0 })) }, hr: 'opened', hw: 'denied', or: 'denied', ran: true },
    { name: 'acl-not-protected', fn: 'acl', acl: { ...goodAcl(), protected: false }, hr: 'opened', hw: 'denied', or: 'denied', ran: true },
    { name: 'acl-service-sid-full', fn: 'acl', acl: { ...goodAcl(), finalAces: [{ sid: CP_SID, type: 'Allow', rights: '0x001F01FF', inherited: false }, goodAcl().finalAces[1]] }, hr: 'opened', hw: 'denied', or: 'denied', ran: true },
    { name: 'acl-holder-write', fn: 'acl', acl: goodAcl(), hr: 'opened', hw: 'opened', or: 'denied', ran: true },
    { name: 'acl-holder-cannot-read', fn: 'acl', acl: goodAcl(), hr: 'denied', hw: 'denied', or: 'denied', ran: true },
    { name: 'acl-other-reads', fn: 'acl', acl: goodAcl(), hr: 'opened', hw: 'denied', or: 'opened', ran: true },
    { name: 'acl-access-not-measured', fn: 'acl', acl: goodAcl(), hr: null, hw: null, or: null, ran: true },
    { name: 'acl-create-failed', fn: 'acl', acl: { ok: false, failedStep: 'set_protected_dacl', exception: 'UnauthorizedAccessException' }, hr: null, hw: null, or: null, ran: true },
    { name: 'acl-silent', fn: 'acl', acl: null, hr: null, hw: null, or: null, ran: true },
    { name: 'acl-not-run', fn: 'acl', acl: null, hr: null, hw: null, or: null, ran: false },
    // cp7
    { name: 'https-reached', fn: 'https', line: { ok: true, status: 200 }, ran: true },
    { name: 'https-no-network', fn: 'https', line: { ok: false, kind: 'unreachable', socketError: 'NetworkUnreachable' }, ran: true },
    { name: 'https-name-resolution', fn: 'https', line: { ok: false, kind: 'name_resolution', socketError: 'HostNotFound' }, ran: true },
    { name: 'https-identity-refused', fn: 'https', line: { ok: false, kind: 'access_denied', socketError: 'AccessDenied' }, ran: true },
    { name: 'https-silent', fn: 'https', line: null, ran: true },
    { name: 'https-not-run', fn: 'https', line: null, ran: false },
  ],
};

const body = `
$out = @($cases.items | ForEach-Object {
  $c = $_
  switch ($c.fn) {
    'node' { $r = Get-CpNodeVerdict $c.line ([bool]$c.ran) }
    'helper' { $r = Get-CpHelperVerdict $c.a $c.b ([bool]$c.ran) }
    'dpapi' { $r = Get-CpDpapiVerdict $c.line ([bool]$c.ran) }
    'profile' { $r = Get-CpProfileObservation $c.line }
    'other' { $r = Get-CpOtherIdentityVerdict $c.results }
    'tcp' { $r = Get-CpTcpVerdict $c.ready $c.clients }
    'acl' { $r = Get-CpAclVerdict $c.acl '${CP_SID}' '${HOLDER_SID}' $c.hr $c.hw $c.or ([bool]$c.ran) }
    'https' { $r = Get-CpHttpsVerdict $c.line ([bool]$c.ran) }
  }
  [pscustomobject]@{ name = $c.name; status = $r.Status; observed = $r.Observed }
})
Write-Output (ConvertTo-Json -InputObject @($out) -Compress -Depth 5)
`;

describe('verdict logic (guest functions run on their own, no VM)', windowsOnly, () => {
  let verdicts;
  before(() => { verdicts = Object.fromEntries(runWithGuestFunctions(guestPath, PURE, body, cases).map((v) => [v.name, v])); });
  const expectStatus = (name, status, observedPattern) => {
    assert.equal(verdicts[name]?.status, status, `${name}: ${JSON.stringify(verdicts[name])}`);
    if (observedPattern) assert.match(verdicts[name].observed, observedPattern, name);
  };

  test('cp1 node:sqlite: a job that did not run is BLOCKED; a node that gave no answer or failed is the finding (FAIL)', () => {
    expectStatus('node-not-run', 'BLOCKED', /job_not_run/u);
    expectStatus('node-silent', 'FAIL', /node_gave_no_answer/u);
    expectStatus('node-ok', 'PASS', /node=v24\.13\.0 sqlite=3\.50\.4/u);
    expectStatus('node-fail', 'FAIL', /failed_at_open:Error:ERR_SQLITE_ERROR/u);
  });

  test('cp2 helper: PASS only when both identity modes reach the pipe open (broker_unavailable)', () => {
    expectStatus('helper-ok', 'PASS', /pid_mode=broker_unavailable service_mode=broker_unavailable/u);
    expectStatus('helper-service-mode-cannot-resolve', 'FAIL', /service_mode=server_identity_unavailable/u);
    expectStatus('helper-silent', 'FAIL', /no_answer/u);
    expectStatus('helper-not-run', 'BLOCKED');
  });

  test('cp3 DPAPI: round trip and entropy both required; the profile is only MEASURED', () => {
    expectStatus('dpapi-ok', 'PASS');
    expectStatus('dpapi-no-roundtrip', 'FAIL', /plaintext/u);
    expectStatus('dpapi-entropy-ignored', 'FAIL', /entropy/u);
    expectStatus('dpapi-protect-failed', 'FAIL', /win32_5/u);
    expectStatus('dpapi-silent', 'FAIL');
    expectStatus('dpapi-not-run', 'BLOCKED');
    expectStatus('profile-seen', 'MEASURED', /userProfile=C:\\Windows\\ServiceProfiles\\X .*hiveLoaded=True .*masterKeyFolder=True\/files=2/u);
    expectStatus('profile-none', 'BLOCKED');
  });

  test('cp4 other identities: the virtual account and Administrator must both have been measured and refused', () => {
    expectStatus('other-all-refused', 'PASS', /administrator=refused_win32_13 .*other_virtual_account=refused_win32_13/u);
    expectStatus('other-admin-opened', 'FAIL', /administrator=opened\(matches=True\)/u);
    expectStatus('other-admin-not-measured', 'BLOCKED', /administrator/u);
    expectStatus('other-blob-unreadable', 'BLOCKED', /setup_error_UnauthorizedAccessException/u);
  });

  test('cp5 loopback TCP: always MEASURED (recorded, not judged) once measured; BLOCKED when nothing was', () => {
    expectStatus('tcp-connected', 'MEASURED', /listening=127\.0\.0\.1 local_user=connected administrator=connected/u);
    expectStatus('tcp-refused', 'MEASURED', /local_user=refused\(ConnectionRefused\)/u);
    expectStatus('tcp-listen-failed', 'MEASURED', /listen_failed:AccessDenied/u);
    expectStatus('tcp-no-listener', 'BLOCKED');
    expectStatus('tcp-no-client-line', 'BLOCKED', /local_user=not_measured/u);
  });

  test('cp6 ProgramData ACL: exactly two protected ACEs (service SID Modify, shareholder SID Read) and the access really follows', () => {
    expectStatus('acl-ok', 'PASS', /aces=2 protected=True inheritedBefore=2 holder_read=opened holder_write=denied other_read=denied/u);
    expectStatus('acl-third-ace', 'FAIL', /ace_count_3/u);
    expectStatus('acl-inherited-left', 'FAIL', /inherited_ace_left/u);
    expectStatus('acl-not-protected', 'FAIL', /dacl_not_protected/u);
    expectStatus('acl-service-sid-full', 'FAIL', /service_sid_not_modify/u);
    expectStatus('acl-holder-write', 'FAIL', /shareholder_can_write/u);
    expectStatus('acl-holder-cannot-read', 'FAIL', /shareholder_cannot_read/u);
    expectStatus('acl-other-reads', 'FAIL', /other_account_can_read/u);
    expectStatus('acl-access-not-measured', 'BLOCKED', /access_not_measured/u);
    expectStatus('acl-create-failed', 'FAIL', /failed_at_set_protected_dacl:UnauthorizedAccessException/u);
    expectStatus('acl-silent', 'FAIL');
    expectStatus('acl-not-run', 'BLOCKED');
  });

  test('cp7 outbound HTTPS: no network is BLOCKED (the expected answer); only this identity being refused is a FAIL', () => {
    expectStatus('https-reached', 'PASS', /reached_status_200/u);
    expectStatus('https-no-network', 'BLOCKED', /no_network_unreachable_NetworkUnreachable/u);
    expectStatus('https-name-resolution', 'BLOCKED', /no_network_name_resolution/u);
    expectStatus('https-identity-refused', 'FAIL', /identity_refused/u);
    expectStatus('https-silent', 'BLOCKED');
    expectStatus('https-not-run', 'BLOCKED');
  });

  test('cp0 token shape: restricted, no Administrators / Hyper-V Administrators, exactly SeChangeNotifyPrivilege; and the exit rule (every status as expected)', () => {
    const tokenCases = {
      tokens: [
        { name: 'good', token: goodToken() },
        { name: 'wrong-user', token: goodToken({ user: { sid: 'S-1-5-80-9' } }) },
        { name: 'unrestricted', token: goodToken({ restrictedSids: [] }) },
        { name: 'administrators-enabled', token: goodToken({ groups: [{ sid: 'S-1-5-32-544', attributes: ['mandatory', 'enabled'] }] }) },
        { name: 'hyperv-admins-enabled', token: goodToken({ groups: [{ sid: 'S-1-5-32-578', attributes: ['enabled'] }] }) },
        { name: 'extra-privilege', token: goodToken({ privileges: [{ name: 'SeChangeNotifyPrivilege' }, { name: 'SeImpersonatePrivilege' }] }) },
        { name: 'no-privilege', token: goodToken({ privileges: [] }) },
        { name: 'no-report', token: null },
      ],
      checks: [
        { id: 'cp1', status: 'PASS', expected: 'PASS' }, { id: 'cp7', status: 'BLOCKED', expected: 'BLOCKED' }, { id: 'cp5', status: 'MEASURED', expected: 'MEASURED' },
        { id: 'cp2', status: 'FAIL', expected: 'PASS' }, { id: 'cp8', status: 'PASS', expected: 'BLOCKED' }, { id: 'cp6', status: 'BLOCKED', expected: 'PASS' },
      ],
    };
    const result = runWithGuestFunctions(guestPath, PURE, `
      $tokens = @($cases.tokens | ForEach-Object { $r = Test-CpTokenShape $_.token '${CP_SID}'; [pscustomobject]@{ name = $_.name; ok = [bool]$r.Ok } })
      $unexpected = @(Get-CpUnexpected $cases.checks)
      Write-Output (ConvertTo-Json -InputObject ([ordered]@{ tokens = @($tokens); unexpected = @($unexpected) }) -Compress -Depth 5)`, tokenCases);
    assert.deepEqual(Object.fromEntries(result.tokens.map((t) => [t.name, t.ok])), {
      good: true, 'wrong-user': false, unrestricted: false, 'administrators-enabled': false, 'hyperv-admins-enabled': false, 'extra-privilege': false, 'no-privilege': false, 'no-report': false });
    assert.deepEqual(result.unexpected, ['cp2: FAIL (expected PASS)', 'cp8: PASS (expected BLOCKED)', 'cp6: BLOCKED (expected PASS)']);
  });
});

// ---- the node probe, on the host
describe('cp-node-probe.mjs (the journal check cp1 runs as the service child)', { timeout: 60_000 }, () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(labDir, 'cp-node-probe.mjs'), ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const lastLine = (result) => JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));

  test('opens a WAL journal, writes, reopens and reads the row back, and says which files SQLite left', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'albera-cp-node-'));
    try {
      const out = run(path.join(dir, 'nested', 'journal'));
      assert.equal(out.status, 0, out.stderr);
      const line = lastLine(out);
      assert.equal(out.stdout.trim().split(/\r?\n/u).length, 1, 'ONE JSON line on stdout');
      assert.equal(line.ok, true, JSON.stringify(line));
      assert.deepEqual([line.probe, line.id, line.step, line.journalMode, line.quickCheck, line.reopenedRow], ['cp', 'node-sqlite', 'done', 'wal', 'ok', 'UNKNOWN']);
      assert.equal(line.nodeVersion, process.version);
      assert.ok(line.files.some((f) => f.name === 'cp-journal.sqlite' && f.bytes > 0), JSON.stringify(line.files));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a failure names the step and never throws: no argument, and a folder that cannot be made', () => {
    const none = lastLine(run());
    assert.equal(none.ok, false);
    assert.match(none.error.message, /usage/u);
    const dir = mkdtempSync(path.join(tmpdir(), 'albera-cp-node-'));
    try {
      const blocker = path.join(dir, 'a-file');
      writeFileSync(blocker, 'x');
      const blocked = lastLine(run(path.join(blocker, 'journal')));
      assert.equal(blocked.ok, false);
      assert.equal(blocked.step, 'make_folder');
      assert.ok(blocked.error.code, 'the error code is reported');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---- the shim's `cp` probes, on the host (harmless there; the service identity is what the VM adds)
describe('the shim `cp` probes', { skip: getUnavailableReason(), timeout: 600_000 }, () => {
  let root, shim;
  before(() => { root = makeTrustedTempDirectory('albera-cp-probe-'); shim = buildServiceLab(path.join(root, 'shim')); });
  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  const lines = (...args) => execFileSync(shim, ['cp', ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).trim().split(/\r?\n/u).map((x) => JSON.parse(x));
  const one = (...args) => { const out = lines(...args); assert.equal(out.length, 1, 'ONE JSON line'); return out[0]; };

  test('DPAPI: CurrentUser scope with entropy round-trips, refuses the wrong entropy, and never prints the plaintext', () => {
    const protectedLine = one('dpapi-protect', 'lab.entropy.a');
    assert.deepEqual([protectedLine.ok, protectedLine.roundTrip, protectedLine.wrongEntropyRefused], [true, true, true]);
    assert.match(protectedLine.plaintextSha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(Object.keys(protectedLine).filter((k) => /plain/iu.test(k) && k !== 'plaintextSha256'), [], 'only the hash of the plaintext is printed');
    assert.ok(protectedLine.profile.userSid && 'registryHiveLoaded' in protectedLine.profile && 'masterKeyFolderExists' in protectedLine.profile, 'the profile report names where DPAPI keeps its key');
    const blob = path.join(root, 'blob.b64');
    writeFileSync(blob, protectedLine.blobBase64);
    const opened = one('dpapi-unprotect', blob, 'lab.entropy.a', protectedLine.plaintextSha256);
    assert.deepEqual([opened.ok, opened.matches], [true, true]);
    assert.equal(one('dpapi-unprotect', blob, 'lab.entropy.a', 'f'.repeat(64)).matches, false, 'a different hash does not match');
    const wrong = one('dpapi-unprotect', blob, 'lab.entropy.b', protectedLine.plaintextSha256);
    assert.equal(wrong.ok, false);
    assert.ok(wrong.win32 > 0, 'the Win32 error is reported');
    assert.equal(one('dpapi-unprotect', path.join(root, 'no-such-blob'), 'lab.entropy.a', protectedLine.plaintextSha256).setupError, 'FileNotFoundException');
  });

  test('loopback TCP: the listener binds 127.0.0.1 only, on a port the system picks, and answers a client', async () => {
    const listener = spawn(shim, ['cp', 'tcp-listen', '20', '1'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    const seen = [];
    let buffer = '';
    const closed = new Promise((resolve) => listener.once('close', resolve));
    const ready = new Promise((resolve) => listener.stdout.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/u);
      buffer = parts.pop();
      for (const part of parts) { const line = JSON.parse(part); seen.push(line); if (line.state === 'ready') resolve(line); }
    }));
    try {
      const first = await ready;
      assert.equal(first.address, '127.0.0.1');
      assert.ok(first.port > 0 && first.port < 65536);
      const client = one('tcp-connect', String(first.port), 'a-label', '5');
      assert.deepEqual([client.ok, client.reply, client.label], [true, 'pong', 'a-label']);
      await closed;
      assert.deepEqual(seen.map((l) => l.state), ['ready', 'accepted', 'done']);
      assert.equal(seen[1].hello, 'hello:a-label');
      assert.equal(seen[2].accepted, 1);
    } finally { listener.kill(); }
    const refused = one('tcp-connect', '1', 'nobody', '5');
    assert.equal(refused.ok, false);
    assert.equal(refused.socketError, 'ConnectionRefused');
  });

  test('ACL file: created, its inherited ACEs reported, then a PROTECTED DACL of exactly two ACEs; a second run refuses to overwrite', () => {
    const dir = mkdtempSync(path.join(root, 'acl-'));
    const file = path.join(dir, 'shareholder-readable.txt');
    const usersSid = 'S-1-5-32-545';
    const line = one('acl-file', file, currentUserSid(), usersSid);
    assert.equal(line.ok, true, JSON.stringify(line));
    assert.ok(line.inheritedAces.length > 0 && line.inheritedAces.every((a) => a.inherited === true), 'what the folder handed down is reported');
    assert.equal(line.protected, true);
    const byRights = Object.fromEntries(line.finalAces.map((a) => [a.sid, a.rights]));
    assert.deepEqual(byRights, { [currentUserSid()]: '0x001301BF', [usersSid]: '0x00120089' }, 'service SID Modify, shareholder SID Read (with Synchronize), nothing else');
    assert.equal(line.appendedAfterSet, true);
    assert.equal(readFileSync(file, 'utf8').split('\n').length, 3, 'the file holds the line written at creation and the one appended after the DACL was replaced');
    const again = one('acl-file', file, currentUserSid(), usersSid);
    assert.deepEqual([again.ok, again.failedStep], [false, 'create']);
    assert.deepEqual([one('file-access', file, 'read').outcome, one('file-access', file, 'read').firstByteRead], ['opened', true]);
    assert.equal(one('file-access', path.join(dir, 'missing.txt'), 'read').outcome, 'missing');
  });

  test('HTTPS: a refused connection is `unreachable`, not `access_denied`, so the lab can tell no network from an identity that may not connect out', () => {
    const line = one('https', 'https://127.0.0.1:1/', '5');
    assert.equal(line.ok, false);
    assert.equal(line.kind, 'unreachable');
    assert.equal(line.socketError, 'ConnectionRefused');
  });

  test('unknown probes are a usage error (64), not a crash', () => {
    const out = spawnSync(shim, ['cp', 'nope'], { encoding: 'utf8', windowsHide: true });
    assert.equal(out.status, 64);
    assert.ok(existsSync(shim));
  });
});
