import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runWithGuestFunctions } from './guest-functions.mjs';

// The Broker desktop section of the nested Hyper-V lab (lab-vm.ps1 -HyperV, checks bd_* in lab-hyperv-rights-check.ps1; Broker PR #164 "desktop pipe"). The VM run is the lead's. Here: what the
// guest script installs and asks (its text), and the verdict logic, loaded out of the guest script on its own (by syntax tree, so none of the code that creates services runs) and fed
// made-up client lines. The client itself is tested in desktop-client.test.mjs.
const labDir = path.dirname(fileURLToPath(import.meta.url));
const guest = readFileSync(path.join(labDir, 'lab-hyperv-rights-check.ps1'), 'utf8');
const driver = readFileSync(path.join(labDir, 'lab-vm.ps1'), 'utf8');
const guestPath = path.join(labDir, 'lab-hyperv-rights-check.ps1');
const windowsOnly = { skip: process.platform !== 'win32' && 'Windows PowerShell only', timeout: 90_000 };

const CHECKS = ['bd_prereq_broker', 'bd_broker_ready', 'bd_broker_token', 'bd_cp_token', 'bd_other_token', 'bd_desktop_pipe', 'bd_cp_view_open', 'bd_cp_view_capture', 'bd_other_refused', 'bd_cp_act_refused'];
const section = (name) => guest.slice(guest.indexOf(`function ${name}`), guest.indexOf('\n}\n', guest.indexOf(`function ${name}`)));

test('the section names exactly the ten checks, and every one of them is emitted by the script', () => {
  const titles = guest.slice(guest.indexOf('$BdTitles = [ordered]@{'), guest.indexOf('$Ops = @('));
  assert.deepEqual([...titles.matchAll(/^\s+(bd_[a-z_]+)\s*=/gmu)].map((m) => m[1]), CHECKS);
  for (const id of CHECKS) assert.ok(new RegExp(`'${id}'`, 'u').test(guest.slice(guest.indexOf('function Invoke-BrokerDesktopLab'))), `${id} is emitted`);
});

test('the Broker is installed as the owner decided: AlberaHostBroker, unrestricted, member of Hyper-V Administrators, only SeChangeNotifyPrivilege; the Control Plane restricted, no group', () => {
  const body = section('Invoke-BrokerDesktopLab');
  assert.match(guest, /\$BdBrokerSvc = 'AlberaHostBroker'/u, 'the name the Broker derives its trusted service SID from (ServicePathGuard.ServiceName)');
  assert.match(readFileSync(path.join(labDir, '../../src/runtime/windows-broker/ServicePathGuard.cs'), 'utf8'), /ServiceName = "AlberaHostBroker"/u);
  assert.match(body, /Install-HvService \$BdBrokerSvc "\$brokerExe service \$brokerConfig" 'unrestricted' \$true/u);
  assert.match(body, /Install-HvService \$BdCpSvc "\$Shim service [^"]+" 'restricted' \$false/u, 'the Control Plane is never in the group');
  assert.match(body, /Install-HvService \$BdOtherSvc "\$Shim service [^"]+" 'unrestricted' \$true/u, 'the other caller has the Broker\'s shape, so a refusal is not for want of the group');
  const install = section('Install-HvService');
  assert.match(install, /& sc\.exe privs \$svc SeChangeNotifyPrivilege/u);
  assert.match(install, /& sc\.exe sidtype \$svc \$sidType/u);
  assert.match(install, /obj= "NT SERVICE\\\$svc"/u);
  assert.match(install, /if \(\$member\) \{\s+& net\.exe localgroup \(Get-HvAdminsGroupName\) "NT SERVICE\\\$svc" \/add/u);
  // The four earlier cells use the same helper (one place builds a lab service), and nothing else creates a service.
  assert.match(section('Invoke-HvCell'), /Install-HvService \$svc "\$Shim service \$LabRoot\\config\\\$svc\.json" \$Cell\.SidType \$Cell\.Member/u);
  assert.equal([...guest.matchAll(/& sc\.exe create/gu)].length, 1);
});

test('the Broker config names the inner VM and the Control Plane SID; the Control Plane alone may query the Broker service; the sections run after the four identities', () => {
  const config = section('Write-BdBrokerConfig');
  for (const key of ['pipeName', 'database', 'authorityKeys', 'controlPlaneSid', 'generation', 'leaseId', 'policyVersion', 'computers']) assert.match(config, new RegExp(`\\b${key} =`, 'u'), key);
  assert.match(config, /computers = @\(\[ordered\]@\{ computerId = \$BdComputerId; vmId = \$VmId\.ToLowerInvariant\(\) \}\)/u);
  assert.match(guest, /\$BdDesktopPipe = "\$\{BdPipe\}_desktop"/u, 'the Broker\'s rule: the claim pipe name + _desktop');
  assert.match(section('Invoke-BrokerDesktopLab'), /sc\.exe sdset \$BdBrokerSvc "D:\(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY\)\(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA\)\(A;;LC;;;\$\{cpSid\}\)"/u);
  assert.match(section('Invoke-BrokerDesktopLab'), /Write-BdBrokerConfig \$brokerConfig "\$LabRoot\\data\\broker\\journal\.sqlite" \$cpSid \$VmId/u);
  assert.ok(guest.indexOf('foreach ($c in $Cells) { Invoke-HvCell $c $innerId }') < guest.indexOf('Invoke-BrokerDesktopLab $innerId'), 'after the four measurements');
  assert.match(guest, /foreach \(\$c in \(\$Cells \+ \$BdCells\)\) \{ Remove-HvCell \$c \}/u, 'the new services are removed with the old ones, also on failure');
});

test('what each check asks of the client: view = open + capture as the Control Plane (service identity), act = open only, the other caller by PID and owner', () => {
  const body = section('Invoke-BrokerDesktopLab');
  assert.match(body, /Invoke-HvShimJob \$BdCpSvc 'view' @\('desktop', \$BdDesktopPipe, "service:\$BdBrokerSvc", "open:view:\$BdComputerId", 'capture:640x480', "save=\$pngPath"\) 'desktop'/u);
  assert.match(body, /Invoke-HvShimJob \$BdCpSvc 'act' @\('desktop', \$BdDesktopPipe, "service:\$BdBrokerSvc", "open:act:\$BdComputerId"\) 'desktop'/u);
  assert.match(body, /Invoke-HvShimJob \$BdOtherSvc 'view' @\('desktop', \$BdDesktopPipe, "pid:\$\{brokerPid\}:\$\{brokerSid\}", "open:view:\$BdComputerId", 'capture:640x480'\) 'desktop'/u);
  assert.match(body, /Add-BdStepCheck 'bd_cp_view_open' \$viewJob 'open' 'allowed' @\(\) \$cpShape/u);
  assert.match(body, /Add-BdStepCheck 'bd_cp_view_capture' \$viewJob 'capture' 'allowed' @\(\) \$cpShape/u);
  assert.match(body, /Add-BdStepCheck 'bd_cp_act_refused' \$actJob 'open' 'refused' @\('refused_reply'\) \$cpShape/u, 'an act refusal must be the Broker\'s reply, not a closed pipe');
  assert.match(body, /Add-BdStepCheck 'bd_other_refused' \$otherJob 'open' 'refused' @\('refused_pipe', 'refused_reply'\) \$otherShape/u);
  assert.match(body, /Add-BdTokenCheck 'bd_broker_token' \$brokerToken \$brokerSid \$true 'unrestricted' 'FAIL'/u);
  assert.match(body, /Add-BdTokenCheck 'bd_cp_token' [^\n]+ \$cpSid \$false 'restricted' 'FAIL'/u);
  assert.match(body, /Add-BdTokenCheck 'bd_other_token' [^\n]+ \$otherSid \$true 'unrestricted' 'BLOCKED'/u);
});

test('nothing here elevates, touches the host, or prints the guest password; the driver copies the Broker build and brings the picture back', () => {
  assert.doesNotMatch(guest, /Password|SecureString|PSCredential|-Verb\s+RunAs|\bRunAs\b/iu);
  assert.match(driver, /\$brokerPublish = Join-Path \$Repo 'src\\runtime\\windows-broker\\bin\\Release\\net10\.0-windows\\win-x64\\publish'/u);
  assert.match(driver, /Copy-Item -ToSession \$session -Path \(Join-Path \$brokerPublish '\*'\) -Destination "\$guestRoot\\bin\\broker" -Recurse -Force/u);
  assert.match(driver, /Copy-Item -FromSession \$session -Path \$picture -Destination \(Join-Path \(Split-Path -Parent \$ResultsFile\) 'bd-view-capture\.png'\)/u);
});

// ---- the verdict logic, loaded by itself out of the guest script
const functions = ['ConvertTo-BdById', 'Get-BdOutcome', 'Get-BdVerdict', 'Test-BdPipeAcl', 'New-LabSpki'];
const logicBody = `
$out = [ordered]@{}
$out.outcomes = @($cases.outcomes | ForEach-Object { Get-BdOutcome (ConvertTo-BdById @($_.lines)) ([string]$_.step) })
$out.verdicts = @($cases.verdicts | ForEach-Object { Get-BdVerdict ([string]$_.expect) ([string[]]@($_.refusals)) ([string]$_.outcome) })
$out.acls = @($cases.acls | ForEach-Object { [bool](Test-BdPipeAcl $_.open ([string]$_.brokerSid) ([string]$_.cpSid) $_.pid).Ok })
$out.spki = New-LabSpki
$out.spki2 = New-LabSpki
ConvertTo-Json -InputObject $out -Compress -Depth 6
`;

const line = (id, extra = {}) => ({ probe: 'desktop', id, ...extra });
const connected = line('connect', { ok: true, result: 'connected' });
const BROKER = 'S-1-5-80-1000000000-1000000000-1000000000-1000000000-1000000001';
const CP = 'S-1-5-80-2000000000-2000000000-2000000000-2000000000-2000000002';
const pipeOpen = (extra = {}) => ({
  probe: 'pipe-open', result: 'opened', owner: BROKER, serverPid: 4242, serverSession: 0,
  sddl: `O:${BROKER}D:(A;;FA;;;${BROKER})(A;;0x120083;;;${CP})`, ...extra,
});

test('the verdict logic: what each client line means, and what each check does with it', windowsOnly, () => {
  const outcomes = [
    // [lines, step, expected]
    [[connected, line('open', { ok: true, reply: 'accepted' })], 'open', 'allowed'],
    [[connected, line('open', { ok: false, reply: 'denied' })], 'open', 'refused_reply'],
    [[line('connect', { ok: false, result: 'denied' }), line('open', { ok: false, skipped: true, because: 'connect' })], 'open', 'refused_pipe'],
    [[line('connect', { ok: false, result: 'server_identity_mismatch' }), line('open', { ok: false, skipped: true, because: 'connect' })], 'open', 'error'],
    [[line('connect', { ok: false, result: 'broker_unavailable' }), line('open', { ok: false, skipped: true, because: 'connect' })], 'open', 'error'],
    [[line('connect', { ok: false, result: 'server_identity_unavailable' })], 'open', 'error'],
    [[], 'open', 'missing'],
    [[connected], 'open', 'missing'],
    [[connected, line('open', { ok: false, reply: 'closed' })], 'open', 'error'],
    [[connected, line('open', { ok: false, reply: 'invalid' })], 'open', 'error'],
    [[connected, line('open', { ok: true, reply: 'accepted' }), line('capture', { ok: true, reply: 'png', pngCheck: 'signature_ihdr_iend_ok' })], 'capture', 'allowed'],
    [[connected, line('open', { ok: false, reply: 'denied' }), line('capture', { ok: false, skipped: true, because: 'open' })], 'capture', 'refused_reply'],
    [[connected, line('open', { ok: true, reply: 'accepted' }), line('capture', { ok: false, reply: 'denied' })], 'capture', 'refused_reply'],
    [[connected, line('open', { ok: true, reply: 'accepted' }), line('capture', { ok: false, reply: 'png_invalid', pngCheck: 'bad_iend' })], 'capture', 'bad_result'],
    [[connected, line('open', { ok: true, reply: 'accepted' }), line('capture', { ok: false, reply: 'closed' })], 'capture', 'error'],
    [[connected, line('open', { ok: true, reply: 'accepted' }), line('capture', { ok: false, reply: 'invalid' })], 'capture', 'error'],
  ].map(([lines, step, expect]) => ({ lines, step, expect }));

  const view = [], refusedAct = ['refused_reply'], refusedAny = ['refused_pipe', 'refused_reply'];
  const verdicts = [
    // [expect, refusals, outcome, expected]
    ['allowed', view, 'allowed', 'PASS'], ['allowed', view, 'refused_pipe', 'FAIL'], ['allowed', view, 'refused_reply', 'FAIL'], ['allowed', view, 'bad_result', 'FAIL'],
    ['allowed', view, 'error', 'BLOCKED'], ['allowed', view, 'missing', 'BLOCKED'],
    ['refused', refusedAct, 'refused_reply', 'PASS'], ['refused', refusedAct, 'refused_pipe', 'BLOCKED'], ['refused', refusedAct, 'allowed', 'FAIL'],
    ['refused', refusedAct, 'bad_result', 'FAIL'], ['refused', refusedAct, 'error', 'BLOCKED'], ['refused', refusedAct, 'missing', 'BLOCKED'],
    ['refused', refusedAny, 'refused_pipe', 'PASS'], ['refused', refusedAny, 'refused_reply', 'PASS'], ['refused', refusedAny, 'allowed', 'FAIL'], ['refused', refusedAny, 'error', 'BLOCKED'],
  ].map(([expect, refusals, outcome, expected]) => ({ expect, refusals, outcome, expected }));

  const acls = [
    // [open, expected]
    [pipeOpen(), true],
    [pipeOpen({ sddl: `O:${BROKER}D:(A;;FA;;;SY)(A;;FA;;;${BROKER})(A;;0x120083;;;${CP})` }), true],
    [pipeOpen({ sddl: `O:${BROKER}D:(A;;FA;;;${BROKER})(A;;0x120083;;;${CP})(A;;0x120083;;;WD)` }), false],
    [pipeOpen({ sddl: `O:${BROKER}D:(A;;FA;;;${BROKER})(A;;0x12019f;;;${CP})` }), false],
    [pipeOpen({ sddl: `O:${BROKER}D:(A;;FA;;;${BROKER})` }), false],
    [pipeOpen({ sddl: `O:${BROKER}D:(A;;FA;;;${BROKER})(D;;0x120083;;;${CP})` }), false],
    [pipeOpen({ owner: CP }), false],
    [pipeOpen({ serverPid: 1 }), false],
    [pipeOpen({ serverSession: 1 }), false],
    [pipeOpen({ result: 'denied' }), false],
    [null, false],
  ].map(([open, expected]) => ({ open, expected, brokerSid: BROKER, cpSid: CP, pid: 4242 }));

  const result = runWithGuestFunctions(guestPath, functions, logicBody, { outcomes, verdicts, acls });
  assert.deepEqual(result.outcomes, outcomes.map((o) => o.expect));
  assert.deepEqual(result.verdicts, verdicts.map((v) => v.expected));
  assert.deepEqual(result.acls, acls.map((a) => a.expected));
  // The throwaway authority key is a well-formed P-256 SubjectPublicKeyInfo (what ServiceConfig.DecodePublicKey accepts), and every call makes a new one.
  for (const text of [result.spki, result.spki2]) {
    const key = createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' });
    assert.deepEqual([key.asymmetricKeyType, key.asymmetricKeyDetails.namedCurve], ['ec', 'prime256v1']);
    assert.equal(Buffer.from(text, 'base64').length, 91);
  }
  assert.notEqual(result.spki, result.spki2);
});
