import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { computeActionDigest } from '../../src/runtime/broker-contract/action-digest.mjs';
import { validateReceiptV2 } from '../../src/runtime/broker-contract/receipt-v2.mjs';
import { runWithGuestFunctions } from './guest-functions.mjs';

// The Broker desktop section of the nested Hyper-V lab (lab-vm.ps1 -HyperV, checks bd_* in lab-hyperv-rights-check.ps1; Broker PR #164 "desktop pipe", #166 "act session and lease"). The VM run is
// the lead's. Here: what the guest script installs and asks (its text), and the verdict logic, loaded out of the guest script on its own (by syntax tree, so none of the code that creates
// services runs) and fed made-up client lines; the receipt the lab signs is checked against the contract (digest, signature, validator). The client itself is tested in desktop-client.test.mjs,
// which also sends the lab's receipt to the real Broker.
const labDir = path.dirname(fileURLToPath(import.meta.url));
const guest = readFileSync(path.join(labDir, 'lab-hyperv-rights-check.ps1'), 'utf8');
const driver = readFileSync(path.join(labDir, 'lab-vm.ps1'), 'utf8');
const guestPath = path.join(labDir, 'lab-hyperv-rights-check.ps1');
const windowsOnly = { skip: process.platform !== 'win32' && 'Windows PowerShell only', timeout: 90_000 };

const CHECKS = [
  'bd_prereq_broker', 'bd_broker_ready', 'bd_broker_token', 'bd_cp_token', 'bd_other_token', 'bd_desktop_pipe', 'bd_cp_view_open', 'bd_cp_view_capture',
  'bd_cp_act_before_claim_refused', 'bd_other_refused', 'bd_cp_task_start_claim', 'bd_cp_act_open', 'bd_cp_act_input', 'bd_cp_act_input_mouse',
  'bd_cp_act_wrong_generation_refused', 'bd_cp_act_revoked_by_new_claim', 'bd_broker_restart_drops_lease',
  // through the real pipe client helper in desktop mode (PR #168), driven by the shim's `desktop-helper` probe
  'bh_cp_image_readable', 'bh_view_open', 'bh_view_capture', 'bh_view_service_only', 'bh_wrong_image_refused', 'bh_act_open', 'bh_act_input', 'bh_act_service_only',
  'bh_squatter_broker_stopped', 'bh_squatter_owner_mismatch',
];
const section = (name) => guest.slice(guest.indexOf(`function ${name}`), guest.indexOf('\n}\n', guest.indexOf(`function ${name}`)));

test('the section names exactly the twenty-seven checks, and every one of them is emitted by the script', () => {
  const titles = guest.slice(guest.indexOf('$BdTitles = [ordered]@{'), guest.indexOf('$Ops = @('));
  assert.deepEqual([...titles.matchAll(/^\s+(b[dh]_[a-z_]+)\s*=/gmu)].map((m) => m[1]), CHECKS);
  const fromBroker = guest.slice(guest.indexOf('function Invoke-BrokerDesktopLab')), fromHelperChecks = guest.slice(guest.indexOf('# ---- the helper-driven checks (bh_*). The Control'));
  for (const id of CHECKS) assert.ok(new RegExp(`'${id}'`, 'u').test(id.startsWith('bh_') ? fromHelperChecks : fromBroker), `${id} is emitted`);
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
  assert.match(section('Invoke-BrokerDesktopLab'), /\$authority = New-LabAuthority \$BdAuthorityKid/u, 'the key the Broker pins is the one the lab signs with');
  assert.match(section('Invoke-BrokerDesktopLab'), /Write-BdBrokerConfig \$brokerConfig "\$LabRoot\\data\\broker\\journal\.sqlite" \$cpSid \$VmId \$authority/u);
  assert.ok(guest.indexOf('foreach ($c in $Cells) { Invoke-HvCell $c $innerId }') < guest.indexOf('Invoke-BrokerDesktopLab $innerId'), 'after the four measurements');
  assert.match(guest, /foreach \(\$c in \(\$Cells \+ \$BdCells\)\) \{ Remove-HvCell \$c \}/u, 'the new services are removed with the old ones, also on failure');
});

test('what each check asks of the client: view = open + capture as the Control Plane (service identity), the act open before any claim, the other caller by PID and owner', () => {
  const body = section('Invoke-BrokerDesktopLab');
  assert.match(body, /Invoke-HvShimJob \$BdCpSvc 'view' @\('desktop', \$BdDesktopPipe, "service:\$BdBrokerSvc", "open:view:\$BdComputerId", 'capture:640x480', "save=\$pngPath"\) 'desktop'/u);
  assert.match(body, /Invoke-HvShimJob \$BdCpSvc 'act-before' @\('desktop', \$BdDesktopPipe, "service:\$BdBrokerSvc", "open:act:\$\{BdComputerId\}:\$\{BdOp1\}:1"\) 'desktop'/u);
  assert.match(body, /Invoke-HvShimJob \$BdOtherSvc 'view' @\('desktop', \$BdDesktopPipe, "pid:\$\{brokerPid\}:\$\{brokerSid\}", "open:view:\$BdComputerId", 'capture:640x480'\) 'desktop'/u);
  assert.match(body, /Add-BdStepCheck 'bd_cp_view_open' \$viewJob 'open' 'allowed' @\(\) \$cpShape/u);
  assert.match(body, /Add-BdStepCheck 'bd_cp_view_capture' \$viewJob 'capture' 'allowed' @\(\) \$cpShape/u);
  assert.match(body, /Add-BdStepCheck 'bd_cp_act_before_claim_refused' \$beforeJob 'open' 'refused' @\('refused_reply'\) \$cpShape/u, 'a refusal must be the Broker\'s reply, not a closed pipe');
  assert.match(body, /Add-BdStepCheck 'bd_other_refused' \$otherJob 'open' 'refused' @\('refused_pipe', 'refused_reply'\) \$otherShape/u);
  assert.match(body, /Add-BdTokenCheck 'bd_broker_token' \$brokerToken \$brokerSid \$true 'unrestricted' 'FAIL'/u);
  assert.match(body, /Add-BdTokenCheck 'bd_cp_token' [^\n]+ \$cpSid \$false 'restricted' 'FAIL'/u);
  assert.match(body, /Add-BdTokenCheck 'bd_other_token' [^\n]+ \$otherSid \$true 'unrestricted' 'BLOCKED'/u);
  assert.ok(body.indexOf("'bd_cp_act_before_claim_refused'") < body.indexOf('Invoke-BdActChecks $authority $cpShape'), 'the refusal is measured before the lab makes a claim');
});

test('the act part: one claim by the helper as the Control Plane, then an act session on it (open, keyboard, mouse), a wrong generation, a second claim from the open session, a restart', () => {
  const acts = section('Invoke-BdActChecks');
  assert.match(guest, /\$BdOp1 = 'lab-bd-act-1'/u);
  assert.match(guest, /\$BdOp2 = 'lab-bd-act-2'/u);
  assert.match(acts, /Add-BdClaimCheck 'claim1' \$BdOp1 \$Authority \$CpShape/u);
  assert.match(acts, /Invoke-HvShimJob \$BdCpSvc 'act-input' @\('desktop', \$BdDesktopPipe, "service:\$BdBrokerSvc", "open:act:\$\{BdComputerId\}:\$\{BdOp1\}:1", "input:tap=\$BdShiftVk", 'input:move=100,100\+down=1\+up=1'\) 'desktop'/u);
  assert.match(guest, /\$BdShiftVk = 16/u, 'VK_SHIFT');
  assert.match(acts, /Add-BdStepCheck 'bd_cp_act_open' \$actJob 'open' 'allowed' @\(\) \$CpShape/u);
  assert.match(acts, /Add-BdStepCheck 'bd_cp_act_input' \$actJob 'input' 'allowed' @\(\) \$CpShape/u, 'the keyboard request alone decides the PASS');
  assert.match(acts, /Add-BdStepCheck 'bd_cp_act_input_mouse' \$actJob 'input_2' 'measured' @\(\) \$CpShape/u, 'the mouse request is only recorded');
  assert.match(acts, /Invoke-HvShimJob \$BdCpSvc 'act-wrong-generation' @\('desktop', \$BdDesktopPipe, "service:\$BdBrokerSvc", "open:act:\$\{BdComputerId\}:\$\{BdOp1\}:2"\) 'desktop'/u);
  assert.match(acts, /Add-BdStepCheck 'bd_cp_act_wrong_generation_refused' \$wrongJob 'open' 'refused' @\('refused_reply'\) \$CpShape/u);
  // Everything that needs a lease is blocked, never FAILed, when no claim was recorded.
  assert.match(acts, /\$dependents = @\(\$BdTitles\.Keys \| Where-Object \{ \$_ -in @\('bd_cp_act_open', 'bd_cp_act_input', 'bd_cp_act_input_mouse', 'bd_cp_act_wrong_generation_refused', 'bd_cp_act_revoked_by_new_claim', 'bd_broker_restart_drops_lease', 'bh_act_open', 'bh_act_input', 'bh_act_service_only'\) \}\)/u);
  assert.equal([...acts.matchAll(/Add-BdBlocked \$dependents/gu)].length, 2, 'no helper, and no recorded claim');
  const claim = section('Add-BdClaimCheck');
  assert.match(claim, /Invoke-HvJob \$BdCpSvc \$Name \$BdHelper @\(\) \(New-BdHelperInput "\$BdCpSvc\.\$Name" \$signed\.Claim\) \$null/u, 'the claim is sent by the helper, as the Control Plane service');
  assert.match(claim, /Add-BdJobCheck 'bd_cp_task_start_claim' \$claimJob \$outcome \(Get-BdVerdict 'allowed' @\(\) \$outcome\) \$Shape/u);
  const ends = section('Invoke-BdLeaseEndChecks');
  assert.match(ends, /New-BdSignedClaim 'claim2' \$BdOp2 \$Authority/u);
  assert.match(ends, /Invoke-HvShimJob \$BdCpSvc 'act-revoke' @\('desktop', \$BdDesktopPipe, "service:\$BdBrokerSvc", "open:act:\$\{BdComputerId\}:\$\{BdOp1\}:1", 'claim', "end:\$BdRevokeWaitMs", "claim-exe=\$BdHelper", "claim-stdin=\$claimInput"\) 'desktop'/u,
    'the first session is open while the second claim is made by the same process');
  assert.match(ends, /Add-BdJobCheck 'bd_cp_act_revoked_by_new_claim' \$revokeJob \(Get-BdOutcome \$byId 'end'\) \(Get-BdRevokeVerdict \$byId\) \$CpShape/u);
  assert.match(ends, /"open:act:\$\{BdComputerId\}:\$\{BdOp2\}:2"/u, 'the second lease is generation 2');
  assert.match(ends, /\$restartedPid = Restart-BdBroker/u);
  assert.match(ends, /Add-BdJobCheck 'bd_broker_restart_drops_lease' \$afterJob \$after \(Get-BdRestartVerdict \$before \$after\) \$CpShape/u);
  assert.ok(ends.indexOf("'lease2-before'") < ends.indexOf('Restart-BdBroker') && ends.indexOf('Restart-BdBroker') < ends.indexOf("'lease2-after'"), 'accepted before the restart, refused after it');
  const restart = section('Restart-BdBroker');
  assert.match(restart, /Stop-LabService \$BdBrokerSvc/u);
  assert.match(restart, /& sc\.exe start \$BdBrokerSvc/u);
});

test('the claim is the lab authority\'s receipt for the lab project and room, in the shape the Broker\'s three-key claim takes; the helper is told to find the Broker service by name', () => {
  const signed = section('New-BdSignedClaim');
  assert.match(signed, /Invoke-HvJob \$BdCpSvc "\$Name-fence" \$BdHelper @\(\) \(New-BdHelperInput "\$BdCpSvc\.\$Name-fence" \$null\) \$null/u);
  assert.match(signed, /New-LabTaskStartReceipt \$Authority \$fence \$OperationId \$BdProjectId \$BdComputerId \$BdTask \$BdLeaseId \$BdPolicyVersion/u);
  const input = section('New-BdHelperInput');
  assert.match(input, /\$body\.receipt = \$Claim\.receipt; \$body\.signature = \$Claim\.signature; \$body\.action = \$Claim\.action/u);
  assert.match(input, /\$body\.expect = \[ordered\]@\{ serviceName = \$BdBrokerSvc \}/u);
  assert.match(input, /\$body\.fence = \$BdComputerId/u);
  assert.match(input, /pipeName = \$BdPipe/u, 'the claim pipe, not the desktop pipe');
  const config = section('Write-BdBrokerConfig');
  assert.match(config, /authorityKeys = @\(\[ordered\]@\{ kid = \$Authority\.Kid; spki = \$Authority\.Spki \}\)/u);
  assert.match(config, /leaseId = \$BdLeaseId; policyVersion = \$BdPolicyVersion/u, 'the receipts carry the same two values');
  assert.doesNotMatch(guest, /privateBlob|ExportPkcs8|CngKeyBlobFormat\]::(Ecc|Pkcs8)Private/u, 'the authority\'s private key is never exported');
});

test('nothing here elevates, touches the host, or prints the guest password; the driver copies the Broker build and the pipe client and brings the picture back', () => {
  assert.doesNotMatch(guest, /Password|SecureString|PSCredential|-Verb\s+RunAs|\bRunAs\b/iu);
  assert.match(driver, /\$brokerPublish = Join-Path \$Repo 'src\\runtime\\windows-broker\\bin\\Release\\net10\.0-windows\\win-x64\\publish'/u);
  assert.match(driver, /Copy-Item -ToSession \$session -Path \(Join-Path \$brokerPublish '\*'\) -Destination "\$guestRoot\\bin\\broker" -Recurse -Force/u);
  assert.match(driver, /\$helperPublish = Join-Path \$Repo 'src\\runtime\\windows-broker-pipe-client\\bin\\Release\\net10\.0-windows\\win-x64\\publish'/u);
  assert.match(driver, /Copy-Item -ToSession \$session -Path \(Join-Path \$helperPublish '\*'\) -Destination "\$guestRoot\\bin\\helper" -Recurse -Force/u);
  assert.match(guest, /\$BdHelper = "\$LabRoot\\bin\\helper\\albera-windows-broker-pipe-client\.exe"/u);
  assert.match(driver, /if \(\$HyperV\) \{ \$needed \+= @\('src\\runtime\\windows-broker-pipe-client\\bin\\Release\\net10\.0-windows\\win-x64\\publish'\) \}/u, 'checked before a VM is created');
  assert.match(driver, /Copy-Item -FromSession \$session -Path \$picture -Destination \(Join-Path \(Split-Path -Parent \$ResultsFile\) 'bd-view-capture\.png'\)/u);
});

test('the helper-driven checks: the Control Plane runs the shim\'s desktop-helper probe with the production identity (service name + the Broker file\'s SHA-256), and again without the pin as a control', () => {
  const job = section('Invoke-BhJob');
  assert.match(job, /\$probeArgs = @\('desktop-helper', \$BdHelper, \$BdDesktopPipe, \$Identity\) \+ \$Steps/u, 'the helper file, the DESKTOP pipe (the helper refuses any other name) and the identity');
  assert.match(job, /if \(\$Image\) \{ \$probeArgs \+= "image=\$Image" \}/u, 'no pin unless one is given');
  assert.match(job, /Invoke-HvShimJob \$BdCpSvc \$Tag \$probeArgs 'desktop-helper'/u, 'always as the Control Plane service, never as the Broker or the other caller');
  const view = section('Invoke-BhViewChecks');
  assert.match(view, /\$identity = "service:\$BdBrokerSvc"/u, 'serviceName mode: the SCM PID and NT SERVICE owner, session 0');
  assert.match(view, /Invoke-BhJob 'bh-view' \$identity @\(\$open, 'capture:640x480'\) \$BhBrokerSha/u);
  assert.match(view, /Add-BhStepCheck 'bh_view_open' \$pinned 'open' 'allowed' @\(\) \$CpShape/u);
  assert.match(view, /Add-BhStepCheck 'bh_view_capture' \$pinned 'capture' 'allowed' @\(\) \$CpShape/u);
  assert.match(view, /Invoke-BhJob 'bh-view-plain' \$identity @\(\$open, 'capture:640x480'\) ''/u, 'the control has no pin');
  assert.match(view, /Add-BhStepCheck 'bh_view_service_only' \$plain 'capture' 'allowed' @\(\) \$CpShape/u);
  assert.match(view, /Invoke-BhJob 'bh-view-wrong' \$identity @\(\$open\) \$BhWrongSha/u);
  assert.match(view, /Add-BhStepCheck 'bh_wrong_image_refused' \$wrong 'open' 'refused' @\('identity_mismatch'\) \$CpShape/u, 'only a comparison that happened counts: an unreadable image is BLOCKED, not a pass');
  assert.match(view, /Invoke-HvShimJob \$BdCpSvc 'bh-openproc' @\('openproc', "\$BrokerPid"\) 'openproc'/u, 'the cause of a failed pin, measured as the same identity');
  assert.match(section('Invoke-BrokerDesktopLab'), /\$script:BhWrongSha = if \(Test-Path -LiteralPath \$BdHelper\) \{ \(Get-FileHash -Algorithm SHA256 -LiteralPath \$BdHelper\)\.Hash\.ToLowerInvariant\(\) \} else \{ '' \}/u, 'a real hash that is not the Broker one');
  assert.match(section('Invoke-BrokerDesktopLab'), /\$script:BhBrokerSha = \(Get-FileHash -Algorithm SHA256 -LiteralPath \$brokerExe\)\.Hash\.ToLowerInvariant\(\)/u, 'the pin is the hash of the file the service runs, taken in the guest');
  const act = section('Invoke-BhActChecks');
  assert.match(act, /\$steps = @\("open:act:\$\{BdComputerId\}:\$\{BdOp1\}:1", "input:tap=\$BdShiftVk"\)/u, 'the lease the first claim made, then the keyboard only (the mouse is the lab\'s bd check)');
  assert.match(act, /Invoke-BhJob 'bh-act' \$identity \$steps \$BhBrokerSha/u);
  assert.match(act, /Add-BhStepCheck 'bh_act_open' \$pinned 'open' 'allowed' @\(\) \$CpShape/u);
  assert.match(act, /Add-BhStepCheck 'bh_act_input' \$pinned 'input' 'allowed' @\(\) \$CpShape/u);
  assert.match(act, /Invoke-BhJob 'bh-act-plain' \$identity \$steps ''/u);
  assert.match(act, /Add-BhStepCheck 'bh_act_service_only' \$plain 'input' 'allowed' @\(\) \$CpShape/u);
  // Where they run: the view checks need no lease and come before the act part; the act checks run on the lease of the first claim and before it is replaced; the squatters stop the Broker, so they are last.
  const lab = section('Invoke-BrokerDesktopLab');
  assert.ok(lab.indexOf('Invoke-BhViewChecks $cpShape $brokerPid') > lab.indexOf("'bd_other_refused'") && lab.indexOf('Invoke-BhViewChecks $cpShape $brokerPid') < lab.indexOf('Invoke-BdActChecks $authority $cpShape'));
  assert.ok(lab.indexOf('Invoke-BdActChecks $authority $cpShape') < lab.indexOf('Invoke-BhSquatChecks $cpShape $brokerSid $brokerPid'), 'the squatters run after the lease checks');
  const acts = section('Invoke-BdActChecks');
  assert.ok(acts.indexOf("'bd_cp_act_wrong_generation_refused'") < acts.indexOf('Invoke-BhActChecks $CpShape') && acts.indexOf('Invoke-BhActChecks $CpShape') < acts.indexOf('Invoke-BdLeaseEndChecks'), 'on the lease, before the second claim replaces it');
});

test('the squatters: the Broker is stopped, the OTHER service holds the desktop pipe name with the squat probe, and the helper is asked twice (service identity, then the Broker\'s old PID and owner)', () => {
  const squat = section('Invoke-BhSquatChecks');
  assert.ok(squat.indexOf('Stop-LabService $BdBrokerSvc') < squat.indexOf("Start-HvJob $BdOtherSvc 'bh-squat' $Shim @('squat', $BdDesktopPipe,"), 'the pipe name is free before the squatter takes it');
  assert.match(squat, /Wait-Until \{[^\n]*"state":"ready"[^\n]*\} 20 'the squatter to be ready'/u);
  assert.ok(squat.indexOf("Invoke-BhJob 'bh-squat-service'") > squat.indexOf('Wait-Until') && squat.indexOf("Invoke-BhJob 'bh-squat-owner'") > squat.indexOf("Invoke-BhJob 'bh-squat-service'"), 'the helper runs while the squatter is in place; the identity that never connects goes first');
  assert.match(squat, /Invoke-BhJob 'bh-squat-service' "service:\$BdBrokerSvc" @\("open:view:\$BdComputerId"\) \$BhBrokerSha/u);
  assert.match(squat, /Invoke-BhJob 'bh-squat-owner' "pid:\$\{BrokerPid\}:\$\{BrokerSid\}" @\("open:view:\$BdComputerId"\) ''/u);
  assert.match(squat, /\$squat = Complete-HvJob \$squat 'squat'/u, 'the squatter\'s own count of bytes is read at the end');
  assert.match(squat, /Add-BdJobCheck 'bh_squatter_broker_stopped' \$byService \$outcome \(Get-BhSquatVerdict \$outcome @\('identity_unavailable', 'identity_mismatch'\) \$ready \$done \$false\) \$CpShape/u);
  assert.match(squat, /Add-BdJobCheck 'bh_squatter_owner_mismatch' \$byOwner \$outcome \(Get-BhSquatVerdict \$outcome @\('identity_mismatch'\) \$ready \$done \$true\) \$CpShape/u, 'the owner check is only proven when the helper did connect');
  assert.match(guest, /\$BhSquatSeconds = 40/u);
});

// ---- the verdict logic, loaded by itself out of the guest script
const functions = [
  'ConvertTo-BdById', 'Get-BdOutcome', 'Get-BdVerdict', 'Get-BdClaimOutcome', 'Get-BdRevokeVerdict', 'Get-BdRestartVerdict', 'Test-BdPipeAcl',
];
const logicBody = `
$out = [ordered]@{}
$out.outcomes = @($cases.outcomes | ForEach-Object { Get-BdOutcome (ConvertTo-BdById @($_.lines)) ([string]$_.step) })
$out.verdicts = @($cases.verdicts | ForEach-Object { Get-BdVerdict ([string]$_.expect) ([string[]]@($_.refusals)) ([string]$_.outcome) })
$out.acls = @($cases.acls | ForEach-Object { [bool](Test-BdPipeAcl $_.open ([string]$_.brokerSid) ([string]$_.cpSid) $_.pid).Ok })
$out.claims = @($cases.claims | ForEach-Object { Get-BdClaimOutcome $_.line 'task.start' })
$out.revokes = @($cases.revokes | ForEach-Object { Get-BdRevokeVerdict (ConvertTo-BdById @($_.lines)) })
$out.restarts = @($cases.restarts | ForEach-Object { Get-BdRestartVerdict ([string]$_.before) ([string]$_.after) })
ConvertTo-Json -InputObject $out -Compress -Depth 6
`;

const line = (id, extra = {}) => ({ probe: 'desktop', id, ...extra });
const connected = line('connect', { ok: true, result: 'connected' });
const accepted = (id) => line(id, { ok: true, reply: 'accepted' });
const denied = (id) => line(id, { ok: false, reply: 'denied' });
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
    // input steps: the keyboard request, and the mouse request that comes second (id input_2) and is skipped when the first is refused
    [[connected, accepted('open'), accepted('input'), denied('input_2')], 'input', 'allowed'],
    [[connected, accepted('open'), accepted('input'), denied('input_2')], 'input_2', 'refused_reply'],
    [[connected, accepted('open'), denied('input'), line('input_2', { ok: false, skipped: true, because: 'input' })], 'input_2', 'refused_reply'],
    [[connected, accepted('open'), line('input', { ok: false, reply: 'closed' })], 'input', 'error'],
    // end: the Broker ended the session by itself (denied), or did not within the time given
    [[connected, accepted('open'), line('claim', { ok: true, reply: 'claimed' }), denied('end')], 'end', 'refused_reply'],
    [[connected, accepted('open'), line('claim', { ok: true, reply: 'claimed' }), line('end', { ok: false, reply: 'timeout' })], 'end', 'still_open'],
    [[connected, accepted('open'), line('claim', { ok: true, reply: 'claimed' }), line('end', { ok: false, reply: 'closed' })], 'end', 'error'],
  ].map(([lines, step, expect]) => ({ lines, step, expect }));

  const view = [], refusedAct = ['refused_reply'], refusedAny = ['refused_pipe', 'refused_reply'];
  const verdicts = [
    // [expect, refusals, outcome, expected]
    ['allowed', view, 'allowed', 'PASS'], ['allowed', view, 'refused_pipe', 'FAIL'], ['allowed', view, 'refused_reply', 'FAIL'], ['allowed', view, 'bad_result', 'FAIL'],
    ['allowed', view, 'error', 'BLOCKED'], ['allowed', view, 'missing', 'BLOCKED'], ['allowed', view, 'still_open', 'FAIL'],
    ['refused', refusedAct, 'refused_reply', 'PASS'], ['refused', refusedAct, 'refused_pipe', 'BLOCKED'], ['refused', refusedAct, 'allowed', 'FAIL'],
    ['refused', refusedAct, 'bad_result', 'FAIL'], ['refused', refusedAct, 'error', 'BLOCKED'], ['refused', refusedAct, 'missing', 'BLOCKED'], ['refused', refusedAct, 'still_open', 'FAIL'],
    ['refused', refusedAny, 'refused_pipe', 'PASS'], ['refused', refusedAny, 'refused_reply', 'PASS'], ['refused', refusedAny, 'allowed', 'FAIL'], ['refused', refusedAny, 'error', 'BLOCKED'],
    // measured: whatever happened is the result; only a step that gave no answer is BLOCKED
    ['measured', view, 'refused_reply', 'MEASURED'], ['measured', view, 'allowed', 'MEASURED'], ['measured', view, 'bad_result', 'MEASURED'], ['measured', view, 'error', 'BLOCKED'], ['measured', view, 'missing', 'BLOCKED'],
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

  // The helper's last line for a claim. The claim is only 'allowed' when it is a first claim of task.start recorded as UNKNOWN: a replay, another action or another state is not what was asked.
  const claims = [
    [{ ok: true, state: 'UNKNOWN', action: 'task.start' }, 'allowed'],
    [{ ok: true, state: 'UNKNOWN', action: 'task.start', replayed: true }, 'bad_result'],
    [{ ok: true, state: 'UNKNOWN', action: 'synthetic.noop' }, 'bad_result'],
    [{ ok: true, state: 'EXECUTED', action: 'task.start' }, 'bad_result'],
    [{ ok: false, code: 'denied' }, 'refused_reply'],
    [{ ok: false, code: 'server_identity_mismatch' }, 'error'],
    [{ ok: false, code: 'broker_unavailable' }, 'error'],
    [{ ok: false, code: 'timeout' }, 'error'],
    [{ ok: false, code: 'invalid_response' }, 'error'],
    [null, 'missing'],
  ].map(([claim, expected]) => ({ line: claim, expected }));

  // The revocation job (steps open, claim, end): PASS only when all three went as intended; no session or no claim says nothing about revocation, so it is BLOCKED; a session still open is a FAIL.
  const claimed = line('claim', { ok: true, reply: 'claimed', state: 'UNKNOWN', action: 'task.start' });
  const claimRefused = line('claim', { ok: false, reply: 'denied' });
  const revokes = [
    [[connected, accepted('open'), claimed, denied('end')], 'PASS'],
    [[connected, accepted('open'), claimed, line('end', { ok: false, reply: 'timeout' })], 'FAIL'],
    [[connected, accepted('open'), claimed, line('end', { ok: false, reply: 'closed' })], 'BLOCKED'],
    [[connected, accepted('open'), claimed, accepted('end')], 'FAIL'],
    [[connected, accepted('open'), claimRefused, line('end', { ok: false, reply: 'timeout' })], 'BLOCKED'],
    [[connected, accepted('open'), claimRefused, denied('end')], 'BLOCKED'],
    [[connected, denied('open'), line('claim', { ok: false, skipped: true, because: 'open' }), line('end', { ok: false, skipped: true, because: 'open' })], 'BLOCKED'],
    [[line('connect', { ok: false, result: 'denied' }), line('open', { ok: false, skipped: true, because: 'connect' })], 'BLOCKED'],
    [[connected, accepted('open')], 'BLOCKED'],
    [[], 'BLOCKED'],
  ].map(([lines, expected]) => ({ lines, expected }));

  const restarts = [
    ['allowed', 'refused_reply', 'PASS'], ['allowed', 'allowed', 'FAIL'], ['allowed', 'bad_result', 'FAIL'], ['allowed', 'error', 'BLOCKED'], ['allowed', 'missing', 'BLOCKED'],
    ['refused_reply', 'refused_reply', 'BLOCKED'], ['error', 'refused_reply', 'BLOCKED'], ['missing', 'refused_reply', 'BLOCKED'], ['refused_pipe', 'refused_reply', 'BLOCKED'],
  ].map(([before, after, expected]) => ({ before, after, expected }));

  const result = runWithGuestFunctions(guestPath, functions, logicBody, { outcomes, verdicts, acls, claims, revokes, restarts });
  assert.deepEqual(result.outcomes, outcomes.map((o) => o.expect));
  assert.deepEqual(result.verdicts, verdicts.map((v) => v.expected));
  assert.deepEqual(result.acls, acls.map((a) => a.expected));
  assert.deepEqual(result.claims, claims.map((c) => c.expected));
  assert.deepEqual(result.revokes, revokes.map((r) => r.expected));
  assert.deepEqual(result.restarts, restarts.map((r) => r.expected));
});

// ---- the helper-driven checks (bh_*): the shim's `desktop-helper` lines
const helperFunctions = ['ConvertTo-BdById', 'Get-BdVerdict', 'Get-BhOutcome', 'Get-BhImageOutcome', 'Get-BhImageVerdict', 'Get-BhSquatVerdict'];
const helperLogicBody = `
$out = [ordered]@{}
$out.outcomes = @($cases.outcomes | ForEach-Object { Get-BhOutcome (ConvertTo-BdById @($_.lines)) ([string]$_.step) })
$out.verdicts = @($cases.verdicts | ForEach-Object { Get-BdVerdict ([string]$_.expect) ([string[]]@($_.refusals)) (Get-BhOutcome (ConvertTo-BdById @($_.lines)) ([string]$_.step)) })
$out.images = @($cases.images | ForEach-Object { Get-BhImageOutcome $_.line ([string]$_.sha) })
$out.imageVerdicts = @($cases.imageVerdicts | ForEach-Object { Get-BhImageVerdict ([string]$_.outcome) })
$out.squats = @($cases.squats | ForEach-Object { Get-BhSquatVerdict ([string]$_.outcome) ([string[]]@($_.refusals)) $_.ready $_.done ([bool]$_.mustConnect) })
ConvertTo-Json -InputObject $out -Compress -Depth 6
`;

test('the helper-driven verdict logic: the helper\'s words, the image pin, and the squatter that must receive nothing', windowsOnly, () => {
  const helper = (extra = {}) => ({ probe: 'desktop-helper', id: 'helper', ok: true, result: 'verified', ...extra });
  const step = (id, extra = {}) => ({ probe: 'desktop-helper', id, ...extra });
  const accepted = (id) => step(id, { ok: true, reply: 'accepted' });
  const said = (id, reply) => step(id, { ok: false, reply });
  const skipped = (id, because) => step(id, { ok: false, skipped: true, because });

  const outcomes = [
    // [lines, step, expected]
    [[helper(), accepted('open')], 'open', 'allowed'],
    [[helper(), accepted('open'), step('capture', { ok: true, reply: 'png' })], 'capture', 'allowed'],
    [[helper(), accepted('open'), accepted('input')], 'input', 'allowed'],
    [[helper(), said('open', 'denied')], 'open', 'refused_reply'],
    [[helper(), said('open', 'access_denied')], 'open', 'refused_pipe'],
    [[helper(), said('open', 'server_identity_mismatch')], 'open', 'identity_mismatch'],
    [[helper(), said('open', 'server_identity_unavailable')], 'open', 'identity_unavailable'],
    [[helper(), accepted('open'), said('capture', 'png_invalid')], 'capture', 'bad_result'],
    [[helper(), accepted('open'), said('capture', 'denied')], 'capture', 'refused_reply'],
    // a step that did not run takes the outcome of the step it waited for
    [[helper(), said('open', 'server_identity_mismatch'), skipped('capture', 'open')], 'capture', 'identity_mismatch'],
    [[helper(), said('open', 'denied'), skipped('input', 'open')], 'input', 'refused_reply'],
    // anything else is an error, never a refusal: the helper could not be started, no pipe, a timeout, a broken stream, a frame that is not one of its replies
    [[helper({ ok: false, result: 'helper_unavailable' }), skipped('open', 'helper')], 'open', 'error'],
    [[helper({ ok: false, result: 'helper_unavailable' })], 'open', 'error'],
    ...['broker_unavailable', 'timeout', 'transport_error', 'invalid_response', 'response_too_large', 'invalid_request', 'closed', 'invalid'].map((reply) => [[helper(), said('open', reply)], 'open', 'error']),
    [[helper(), accepted('open'), said('input', 'transport_error')], 'input', 'error'],
    // nothing to judge
    [[], 'open', 'missing'],
    [[helper()], 'open', 'missing'],
    [[helper(), accepted('open')], 'capture', 'missing'],
  ].map(([lines, stepId, expect]) => ({ lines, step: stepId, expect }));

  // The verdicts the checks give those outcomes (Get-BdVerdict, shared with the lab's own client): a pinned open that ends in server_identity_unavailable is a FAIL (the pin cannot be used),
  // a wrong pin is PASS only when the helper compared and refused (mismatch); when it could not read the image it did not compare, so the check is BLOCKED.
  const mismatch = [helper(), said('open', 'server_identity_mismatch')], unavailable = [helper(), said('open', 'server_identity_unavailable')];
  const verdicts = [
    // [lines, step, expect, refusals, expected]
    [[helper(), accepted('open')], 'open', 'allowed', [], 'PASS'],
    [unavailable, 'open', 'allowed', [], 'FAIL'], [mismatch, 'open', 'allowed', [], 'FAIL'], [[helper(), said('open', 'denied')], 'open', 'allowed', [], 'FAIL'],
    [[helper(), accepted('open'), said('capture', 'png_invalid')], 'capture', 'allowed', [], 'FAIL'],
    [[helper(), said('open', 'broker_unavailable')], 'open', 'allowed', [], 'BLOCKED'], [[], 'open', 'allowed', [], 'BLOCKED'],
    [mismatch, 'open', 'refused', ['identity_mismatch'], 'PASS'], [unavailable, 'open', 'refused', ['identity_mismatch'], 'BLOCKED'],
    [[helper(), accepted('open')], 'open', 'refused', ['identity_mismatch'], 'FAIL'], [[helper(), said('open', 'denied')], 'open', 'refused', ['identity_mismatch'], 'BLOCKED'],
    [[helper({ ok: false, result: 'helper_unavailable' }), skipped('open', 'helper')], 'open', 'refused', ['identity_mismatch'], 'BLOCKED'],
  ].map(([lines, stepId, expect, refusals, expected]) => ({ lines, step: stepId, expect, refusals, expected }));

  const sha = 'a'.repeat(64);
  const openproc = (opened, extra = {}) => ({ probe: 'openproc', pid: 4242, openProcess: { PROCESS_QUERY_LIMITED_INFORMATION: opened, PROCESS_ALL_ACCESS: 'denied' }, imageSha256: sha, ...extra });
  const images = [
    [openproc('opened'), 'readable'], [openproc('opened', { imageSha256: 'b'.repeat(64) }), 'wrong_hash'], [openproc('opened', { imageSha256: 'unavailable_read_IOException' }), 'wrong_hash'],
    [openproc('denied', { imageSha256: 'unavailable_open_5' }), 'denied'], [openproc('error_87'), 'error'], [null, 'missing'],
  ].map(([line, expected]) => ({ line, sha, expected }));
  const imageVerdicts = [['readable', 'MEASURED'], ['denied', 'MEASURED'], ['wrong_hash', 'FAIL'], ['error', 'BLOCKED'], ['missing', 'BLOCKED']].map(([outcome, expected]) => ({ outcome, expected }));

  // The squatter: its `ready` and `done` lines. A byte at the squatter is a FAIL whatever the helper said; a squatter that was never in place proves nothing.
  const ready = { probe: 'squat', state: 'ready', owner: 'S-1-5-80-1', pid: 99 };
  const done = (bytesReceived, connected = true) => ({ probe: 'squat', state: 'done', connected, bytesReceived });
  const refusals = ['identity_unavailable', 'identity_mismatch'], ownerRefusals = ['identity_mismatch'];
  const squats = [
    // [outcome, refusals, ready, done, mustConnect, expected]
    ['identity_unavailable', refusals, ready, null, false, 'PASS'], ['identity_unavailable', refusals, ready, done(0, false), false, 'PASS'], ['identity_mismatch', refusals, ready, done(0), false, 'PASS'],
    ['identity_mismatch', ownerRefusals, ready, done(0), true, 'PASS'],
    ['identity_mismatch', ownerRefusals, ready, null, true, 'BLOCKED'], ['identity_mismatch', ownerRefusals, ready, done(0, false), true, 'BLOCKED'],
    ['identity_unavailable', ownerRefusals, ready, done(0), true, 'BLOCKED'],
    ['identity_mismatch', ownerRefusals, ready, done(7), true, 'FAIL'], ['identity_unavailable', refusals, ready, done(1, false), false, 'FAIL'], ['error', refusals, ready, done(3), false, 'FAIL'],
    ['allowed', ownerRefusals, ready, done(0), true, 'FAIL'], ['bad_result', ownerRefusals, ready, done(0), true, 'FAIL'],
    ['refused_reply', ownerRefusals, ready, done(0), true, 'BLOCKED'], ['error', refusals, ready, null, false, 'BLOCKED'], ['missing', refusals, ready, null, false, 'BLOCKED'],
    ['identity_mismatch', ownerRefusals, null, done(0), true, 'BLOCKED'], ['identity_unavailable', refusals, null, null, false, 'BLOCKED'],
  ].map(([outcome, refused, readyLine, doneLine, mustConnect, expected]) => ({ outcome, refusals: refused, ready: readyLine, done: doneLine, mustConnect, expected }));

  const result = runWithGuestFunctions(guestPath, helperFunctions, helperLogicBody, { outcomes, verdicts, images, imageVerdicts, squats });
  assert.deepEqual(result.outcomes, outcomes.map((o) => o.expect));
  assert.deepEqual(result.verdicts, verdicts.map((v) => v.expected));
  assert.deepEqual(result.images, images.map((i) => i.expected));
  assert.deepEqual(result.imageVerdicts, imageVerdicts.map((i) => i.expected));
  assert.deepEqual(result.squats, squats.map((q) => q.expected));
});

test('a job\'s result file is read as before the job was split in start and complete: only the probe\'s JSON lines (all of them without a probe), stderr apart, the token report; a job that did not start is not waited for', windowsOnly, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'albera-hvjob-'));
  try {
    const resultFile = path.join(dir, 'job.txt'), tokenFile = path.join(dir, 'job.token.json');
    writeFileSync(resultFile, [
      '[shim] start pid=1 mode=child', '{"probe":"desktop-helper","id":"helper","ok":true}', '{"probe":"squat","state":"ready"}', 'not json {', '[stderr] one', '[stderr] two', '{"probe":"desktop-helper","id":"open","ok":false}', '[shim] exit=0',
    ].join('\r\n'));
    writeFileSync(tokenFile, JSON.stringify({ user: { sid: 'S-1-5-80-1' } }));
    const result = runWithGuestFunctions(guestPath, ['Complete-HvJob', 'Read-ResultLines', 'Wait-Until', 'Get-AsciiText'], `
$LabRoot = $cases.dir
function Get-Svc([string]$Name) { if ($cases.neverWait) { throw 'must not wait' }; [pscustomobject]@{ State = 'Stopped' } }
function New-Job([string]$error) { @{ Svc = 'AlberaLabHvCP'; ResultFile = $cases.resultFile; TokenFile = $cases.tokenFile; Objects = @(); Token = $null; Stderr = @(); Error = $(if ($error) { $error } else { $null }) } }
$filtered = Complete-HvJob (New-Job '') 'desktop-helper'
$all = Complete-HvJob (New-Job '') ''
$cases.neverWait = $true
$notStarted = Complete-HvJob (New-Job 'sc start failed') 'desktop-helper'
ConvertTo-Json -Compress -Depth 6 -InputObject ([ordered]@{
  filtered = @($filtered.Objects | ForEach-Object { $_.id }); stderr = @($filtered.Stderr); token = $filtered.Token.user.sid; error = $filtered.Error
  all = @($all.Objects | ForEach-Object { if ($_.id) { $_.id } else { $_.state } })
  notStarted = @($notStarted.Objects | ForEach-Object { $_.id }); notStartedError = $notStarted.Error
})`, { dir, resultFile, tokenFile, neverWait: false });
    assert.deepEqual(result, {
      filtered: ['helper', 'open'], stderr: ['[stderr] one', '[stderr] two'], token: 'S-1-5-80-1', error: null,
      all: ['helper', 'ready', 'open'], notStarted: ['helper', 'open'], notStartedError: 'sc start failed',
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.match(section('Invoke-HvJob'), /Complete-HvJob \(Start-HvJob \$svc \$tag \$program \$jobArgs \$stdinFile\) \$probe/u, 'one place starts a job and one place reads it');
});

// ---- the throwaway authority and the receipt it signs, against the contract
const authorityBody = `
$out = [ordered]@{}
$a = New-LabAuthority $cases.kid
$b = New-LabAuthority $cases.kid
$out.kid = $a.Kid
$out.spki = $a.Spki
$out.spki2 = $b.Spki
$out.claim = New-LabTaskStartReceipt $a $cases.fence $cases.operationId $cases.projectId $cases.computerId $cases.task $cases.leaseId $cases.policyVersion
$out.claim2 = New-LabTaskStartReceipt $a $cases.fence $cases.operationId2 $cases.projectId $cases.computerId $cases.task $cases.leaseId $cases.policyVersion
$out.digests = @($cases.dtos | ForEach-Object {
  $dtoArgs = @{}; foreach ($p in $_.args.PSObject.Properties) { $dtoArgs[$p.Name] = [string]$p.Value }
  Get-LabActionDigest ([string]$_.purpose) @{ action = [string]$_.action; projectId = [string]$_.projectId; computerId = [string]$_.computerId; args = $dtoArgs }
})
$out.nonces = @(1..40 | ForEach-Object { New-LabNonce })
ConvertTo-Json -InputObject $out -Compress -Depth 6
`;
const authorityFunctions = ['New-LabAuthority', 'Write-LabBigEndian', 'Write-LabDigestString', 'Write-LabDigestMap', 'Get-LabActionDigest', 'New-LabNonce', 'New-LabTaskStartReceipt'];

test('the lab authority and its task.start receipt: the key is a P-256 SPKI the Broker can pin, the signature verifies, and the contract accepts the receipt, DTO and digest', windowsOnly, () => {
  const fence = { ok: true, brokerEpoch: 3, leaseGeneration: 1, leaseId: 'lab-hv-lease-1', brokerChallenge: 'AAAAAAAAAAAAAAAAAAAAAA' };
  const common = { projectId: 'lab-project', computerId: 'lab-room', leaseId: 'lab-hv-lease-1', policyVersion: 'lab-hv-policy-1', task: 'Lab check: tap the Shift key once' };
  const dtos = [
    { purpose: 'guest.command', action: 'task.start', projectId: 'lab-project', computerId: 'lab-room', args: { task: 'Lab check: tap the Shift key once' } },
    { purpose: 'guest.command', action: 'task.start', projectId: 'p', computerId: 'c', args: { zeta: 'z', task: 't', alpha: 'a', aZ: 'x', ab: 'y' } },   // keys sort by ordinal value: aZ before ab (an ignore-case sort puts ab first)
    { purpose: 'broker.operation', action: 'synthetic.noop', projectId: 'proj-alpha', computerId: 'pc-01', args: {} },
    { purpose: 'guest.command', action: 'task.start', projectId: 'p', computerId: 'c', args: { task: 'a'.repeat(256) } },
  ];
  const result = runWithGuestFunctions(guestPath, authorityFunctions, authorityBody, { fence, kid: 'lab-hv-authority-1', operationId: 'lab-bd-act-1', operationId2: 'lab-bd-act-2', dtos, ...common });

  // The key: what ServiceConfig.DecodePublicKey takes, new on every call.
  const publicKey = createPublicKey({ key: Buffer.from(result.spki, 'base64'), format: 'der', type: 'spki' });
  assert.deepEqual([publicKey.asymmetricKeyType, publicKey.asymmetricKeyDetails.namedCurve], ['ec', 'prime256v1']);
  assert.equal(Buffer.from(result.spki, 'base64').length, 91);
  assert.notEqual(result.spki, result.spki2);
  assert.equal(result.kid, 'lab-hv-authority-1');

  // The digest is the contract's, byte for byte, including the ordinal key order.
  assert.deepEqual(result.digests, dtos.map(({ purpose, ...dto }) => computeActionDigest(purpose, dto)));

  // The nonce is 128 bits in the canonical form the receipt grammar wants (22 base64url characters, the last one among A Q g w), and they differ.
  for (const nonce of result.nonces) assert.match(nonce, /^[A-Za-z0-9_-]{21}[AQgw]$/u);
  assert.equal(new Set(result.nonces).size, result.nonces.length);

  for (const [claim, operationId] of [[result.claim, 'lab-bd-act-1'], [result.claim2, 'lab-bd-act-2']]) {
    const receiptBytes = Buffer.from(claim.receipt, 'base64');
    // Signed with the key that was pinned: SHA-256, IEEE P1363 (r||s, 64 bytes) over the exact receipt bytes.
    const signature = Buffer.from(claim.signature, 'base64');
    assert.equal(signature.length, 64);
    assert.equal(verify('sha256', receiptBytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature), true, 'the signature verifies under the pinned key');
    assert.equal(verify('sha256', Buffer.concat([receiptBytes, Buffer.from(' ')]), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature), false, 'and under no other bytes');

    // The action DTO that rides along is the one the digest was made from.
    const dto = JSON.parse(Buffer.from(claim.action, 'base64').toString('utf8'));
    assert.deepEqual(dto, { action: 'task.start', projectId: 'lab-project', computerId: 'lab-room', args: { task: common.task } });

    // The contract's own validator accepts it against the state the Broker would hold: the lease and policy of the config, the fence's epoch, generation and challenge.
    const now = Math.floor(Date.now() / 1000);
    const verdict = validateReceiptV2(receiptBytes, {
      clock: () => now, environment: 'production', action: dto,
      expected: {
        audience: 'albera-host-broker', purpose: 'guest.command', operationId, idempotencyKey: `idem-${operationId}`, leaseId: common.leaseId,
        leaseGeneration: fence.leaseGeneration, brokerEpoch: fence.brokerEpoch, brokerChallenge: fence.brokerChallenge, policyVersion: common.policyVersion,
      },
    });
    assert.deepEqual([verdict.ok, verdict.ok ? verdict.receipt.action : verdict], [true, 'task.start']);
    assert.equal(verdict.receipt.kid, 'lab-hv-authority-1');
    assert.ok(verdict.receipt.exp - verdict.receipt.iat <= 300, 'within the contract\'s TTL bound');
    assert.ok(receiptBytes.length <= 1280, 'within the receipt size bound');
    // The three-key claim (receipt, signature, action) fits the Broker's 4 KiB request bound and the helper's input bound.
    assert.ok(Buffer.byteLength(JSON.stringify({ receipt: claim.receipt, signature: claim.signature, action: claim.action })) < 4096);
  }
  // A claim for the other operation shares nothing that must be unique: ids, nonce and digest-independent fields differ.
  const [one, two] = [result.claim, result.claim2].map((claim) => JSON.parse(Buffer.from(claim.receipt, 'base64').toString('utf8')));
  assert.notEqual(one.receiptId, two.receiptId);
  assert.notEqual(one.approvalId, two.approvalId);
  assert.notEqual(one.nonce, two.nonce);
  assert.equal(one.actionDigest, two.actionDigest);
  assert.match(one.receiptId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});
