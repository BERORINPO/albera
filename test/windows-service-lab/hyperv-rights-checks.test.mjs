import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// ADR-002 host Broker, PR2: the nested Hyper-V rights lab (lab-vm.ps1 -HyperV, lab-hyperv-rights-check.ps1, the `hyperv` probe in HyperVProbe.cs).
// The VM run is the lead's. Here: the scripts' text, the PowerShell parse, and the verdict logic, which is loaded out of the guest script on its own
// (by syntax tree, so none of the guest-side code that creates services runs) and fed made-up probe lines.
const labDir = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(path.join(labDir, name), 'utf8');
const guest = read('lab-hyperv-rights-check.ps1');
const driver = read('lab-vm.ps1');
const probe = read('HyperVProbe.cs');
const guestPath = path.join(labDir, 'lab-hyperv-rights-check.ps1');
const powershell = (args, options = {}) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true, ...options });
const windowsOnly = { skip: process.platform !== 'win32' && 'Windows PowerShell only', timeout: 90_000 };

test('the Hyper-V lab scripts are ASCII only (Windows PowerShell 5.1 reads them without a BOM)', () => {
  for (const [name, text] of [['lab-hyperv-rights-check.ps1', guest], ['lab-vm.ps1', driver]]) assert.equal(/[^\t\r\n -~]/u.test(text), false, name);
});

test('both scripts parse', windowsOnly, () => {
  const parser = '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:ALBERA_PARSE_TARGET, [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }; exit 1 }';
  for (const name of ['lab-hyperv-rights-check.ps1', 'lab-vm.ps1']) {
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parser], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, ALBERA_PARSE_TARGET: path.join(labDir, name) } });
    assert.equal(out.status, 0, `${name}: ${out.stdout}${out.stderr}`);
  }
});

test('the guest script refuses to run outside the lab VM, before it touches anything', windowsOnly, () => {
  assert.ok(guest.indexOf("$env:ALBERA_LAB_VM -ne '1'") < guest.indexOf('$HvAdminsSid ='), 'the refusal is the first statement after the parameters');
  assert.ok(guest.indexOf("$env:ALBERA_LAB_VM -ne '1'") < guest.indexOf('& sc.exe create'));
  const env = { ...process.env }; delete env.ALBERA_LAB_VM;
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', guestPath, 'C:\\albera-hv-lab-never-created', 'cleanup'], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env });
  assert.notEqual(out.status, 0);
  assert.match(`${out.stdout}${out.stderr}`, /refusing to run/u);
});

test('the guest script measures the four identities and the eight operations, with the ADR-002 service shape', () => {
  assert.deepEqual([...guest.matchAll(/Code = '([a-z_]+)';\s+Svc = '([A-Za-z]+)'; SidType = '([a-z]+)';\s+Member = \$(true|false)/gu)].map((m) => m.slice(1, 5).join(' ')), [
    'r_member AlberaLabHvRM restricted true', 'r_nonmember AlberaLabHvRN restricted false', 'u_member AlberaLabHvUM unrestricted true', 'u_nonmember AlberaLabHvUN unrestricted false']);
  assert.deepEqual([...guest.matchAll(/@\{ Id = '([a-z_]+)';\s+Kind = '([a-z]+)'/gu)].map((m) => `${m[1]}:${m[2]}`), [
    'wmi_connect:gate', 'vm_lookup:gate', 'mgmt_read:reference', 'thumbnail:sensitive', 'keyboard_typekey:sensitive', 'mouse_setabsoluteposition:sensitive',
    'adapter_capture:sensitive', 'adapter_input:sensitive']);
  assert.match(guest, /& sc\.exe privs \$svc SeChangeNotifyPrivilege/u, 'only SeChangeNotifyPrivilege, as the Broker will have');
  assert.match(guest, /obj= "NT SERVICE\\\$svc"/u, 'a virtual account');
  assert.match(guest, /Hyper-V Administrators|S-1-5-32-578/u);
  assert.match(guest, /Add-Check "hv_\$\{code\}_\$\(\$op\.Id\)"/u, 'check ids are hv_<identity>_<operation>');
  for (const id of ['hv_prereq_role', 'hv_prereq_inner_vm', 'hv_${code}_token']) assert.ok(guest.includes(id), id);
  // The inner VM is the one the issue names: Gen2, 512 MB fixed, no disk, no network.
  assert.match(guest, /New-VM -Name \$InnerVmName -Generation 2 -MemoryStartupBytes 512MB -NoVHD/u);
  assert.match(guest, /DynamicMemoryEnabled \$false/u);
  assert.match(guest, /Remove-VMNetworkAdapter/u);
});

test('nothing here elevates, reads the guest password, or reaches outside the lab', () => {
  for (const text of [guest, driver]) assert.doesNotMatch(text, /-Verb\s+RunAs|\bRunAs\b|Start-Process[^\n]*-Verb/iu);
  assert.doesNotMatch(guest, /Password|SecureString|PSCredential/iu, 'the guest script never sees the lab password');
  assert.doesNotMatch(guest, /Invoke-WebRequest|Invoke-RestMethod|Install-Module|Install-PackageProvider|Add-Type\s+-AssemblyName/iu, 'no downloads, no extra modules');
});

test('lab-vm.ps1 -HyperV: nested virtualization, 5 GB with the same memory guard, a shim-only build, and the other modes untouched', () => {
  assert.match(driver, /\[switch\]\$HyperV/u);
  assert.match(driver, /\$vmMemoryGB = if \(\$HyperV\) \{ 5 \} else \{ 4 \}/u);
  assert.match(driver, /if \(\$freeGB -lt \(\$vmMemoryGB \+ \$hostHeadroomGB\)\)/u, 'the free-memory guard still uses the VM size');
  const expose = driver.indexOf('-ExposeVirtualizationExtensions $true');
  assert.ok(expose > 0 && expose < driver.indexOf('Start-VM -VM $vm'), 'nested virtualization is set while the VM is still off');
  assert.match(driver, /if \(\$HyperV -and \$HostInstall\) \{ throw/u);
  assert.match(driver, /\$needed = @\('test\\windows-service-lab\\bin\\Release\\net10\.0-windows\\win-x64\\publish'\)\s+# The Hyper-V lab runs only the lab shim[^\n]*\n\s+if \(-not \$HyperV\) \{\s+\$needed \+= @\('src\\runtime\\windows-broker/u);
  assert.match(driver, /if \(-not \$HyperV\) \{\s+& npm run build:windows-broker/u);
  assert.match(driver, /if \(-not \$HyperV\) \{\s+& npm run build:approval-authority/u);
  assert.match(driver, /if \(-not \$HostInstall -and -not \$HyperV\) \{\s+& node scripts\/windows-service-lab-inputs\.mjs/u);
  assert.match(driver, /if \(\$HyperV\) \{\s+\$hvOut = @\(Invoke-HyperVRightsLab[\s\S]*?\}\s+elseif \(\$HostInstall\) \{/u);
  // The default lab and -HostInstall still call exactly what they called.
  assert.match(driver, /& \(Join-Path \$PSScriptRoot 'run-lab\.ps1'\) -VmName \$VmName -PasswordFile \$PasswordFile `/u);
  assert.match(driver, /lab-host-install-check\.ps1/u);
  // Guest cleanup runs only with -KeepVm; otherwise the outer VM and its child disk are deleted as before.
  assert.match(driver, /if \(\$KeepVm\) \{ try \{ Invoke-Command -Session \$session -FilePath \$guestScript -ArgumentList \$guestRoot, 'cleanup'/u);
  assert.match(driver, /Stop-VM -VM \$ownedVm -TurnOff -Force\s+Remove-VM -VM \$ownedVm -Force/u);
});

test('the probe calls WMI by COM late binding, in process, and sends only a Shift key, a mouse move and a button 1 press', () => {
  assert.match(probe, /Type\.GetTypeFromProgID\("WbemScripting\.SWbemLocator"\)/u);
  assert.match(probe, /root\\virtualization\\v2/u);
  const code = probe.replace(/\/\/[^\n]*/gu, '');
  assert.doesNotMatch(code, /System\.Management|PowerShell|Get-CimInstance|Process\.Start/u);
  const methods = [...probe.matchAll(/(?:DeviceCall\(wmi, vmPath, "[A-Za-z_]+", "|Call\(service, ")([A-Za-z]+)"/gu)].map((m) => m[1]);
  assert.deepEqual(methods, ['TypeKey', 'SetAbsolutePosition', 'GetVirtualSystemThumbnailImage']);
  assert.match(read('Probes.cs'), /case \["hyperv", var vm\]: return HyperVProbe\.Run\(vm\);/u);
});

test('the probe reads every WMI result through Properties_.Item, never by property name (a by-name read breaks every later call in the process with E_FAIL)', () => {
  const code = probe.replace(/\/\/[^\n]*/gu, '');
  assert.match(code, /\(\(dynamic\)wmiObject\)\.Properties_\.Item\(name\)\.Value/u);
  assert.doesNotMatch(code, /\.(ReturnValue|ImageData|EnabledState|VirtualSystemType)\b/u, 'no WMI property is read by its own name');
  for (const name of ['ReturnValue', 'ImageData', 'EnabledState', 'VirtualSystemType']) assert.match(code, new RegExp(`Property\\([^\\n]*"${name}"\\)`, 'u'), name);
});

test('the probe runs the Broker adapter itself: the shim compiles HyperVDesktop.cs and PngEncoder.cs by source include, and adapter_capture / adapter_input use only the adapter', () => {
  const project = read('AlberaLabServiceShim.csproj');
  assert.deepEqual([...project.matchAll(/<Compile Include="([^"]+)"/gu)].map((m) => m[1]), ['../../src/runtime/windows-broker/HyperVDesktop.cs', '../../src/runtime/windows-broker/PngEncoder.cs']);
  assert.doesNotMatch(project, /PackageReference|Reference Include/u, 'still BCL only');
  const code = probe.replace(/\/\/[^\n]*/gu, '');
  assert.match(code, /new\(\[new ComputerBinding\(AdapterComputerId, vmId\.ToString\("D"\)\.ToLowerInvariant\(\)\)\], ComWmiConnection\.TryConnect\)/u, 'the production connection, one configured VM, a lowercase GUID');
  assert.match(code, /Check\("adapter_capture", \(\) => AdapterCapture\(desktop\)\)/u);
  assert.match(code, /Check\("adapter_input", \(\) => AdapterInput\(desktop\)\)/u);
  assert.match(code, /desktop\.Capture\(AdapterComputerId, ThumbnailWidth, ThumbnailHeight\)/u);
  // One move, one tap of Shift (0x10), one press and release of button 1: the step kinds, in this order, nothing more.
  const steps = code.slice(code.indexOf('DesktopStep[] steps'), code.indexOf('DesktopResult result = desktop.Input'));
  assert.deepEqual([...steps.matchAll(/new\("([a-z]+)"/gu)].map((m) => m[1]), ['move', 'tap', 'down', 'up']);
  assert.match(code, /ShiftKeyCode = 0x10/u);
  // The capture must be a PNG: signature, IHDR of the asked size, 8-bit truecolour, IEND.
  assert.match(code, /0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A/u);
  assert.match(code, /"IHDR"u8/u);
  // When the connection is refused the adapter checks are skipped with the others.
  assert.match(code, /"mouse_setabsoluteposition", "adapter_capture", "adapter_input"\]\) Skipped\(id, "wmi_connect"\)/u);
});

// ---- the verdict logic, loaded by itself out of the guest script
const driverScript = `
param([string]$Target, [string]$CasesFile)
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Target, [ref]$null, [ref]$null)
$wanted = @('Get-AsciiText', 'Get-HvOutcome', 'Get-HvVerdict', 'Test-HvTokenShape')
$found = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and @('Get-AsciiText', 'Get-HvOutcome', 'Get-HvVerdict', 'Test-HvTokenShape') -contains $n.Name }, $true))
if ($found.Count -ne $wanted.Count) { throw 'pure functions missing from the guest script' }
foreach ($f in $found) { . ([scriptblock]::Create($f.Extent.Text)) }
$cases = Get-Content -Raw $CasesFile | ConvertFrom-Json
$out = [ordered]@{}
$out.outcomes = @($cases.outcomes | ForEach-Object {
  $byId = @{}
  foreach ($l in @($_.lines)) { $byId[[string]$l.id] = $l }
  Get-HvOutcome $byId[[string]$_.target] $byId
})
$out.verdicts = @($cases.verdicts | ForEach-Object { Get-HvVerdict ([bool]$_.member) ([string]$_.sidtype) ([string]$_.kind) ([string]$_.outcome) })
$out.tokens = @($cases.tokens | ForEach-Object { $r = Test-HvTokenShape $_.token ([string]$_.sid) ([bool]$_.member) ([string]$_.sidtype); [bool]$r.Ok })
$out.ascii = Get-AsciiText ([string]$cases.text)
ConvertTo-Json -InputObject $out -Compress -Depth 6
`;

const line = (id, extra = {}) => ({ probe: 'hyperv', id, ...extra });
const denied = { ok: false, exception: 'COMException', hresult: '0x80041003' };
const token = ({ member, restricted, privileges = ['SeChangeNotifyPrivilege'], sid = 'S-1-5-80-1' }) => ({
  user: { sid }, hasRestrictions: restricted,
  groups: [{ sid: 'S-1-1-0', attributes: ['mandatory', 'enabled'] }, ...(member ? [{ sid: 'S-1-5-32-578', attributes: ['mandatory', 'enabled'] }] : [])],
  restrictedSids: restricted ? [{ sid: sid }, { sid: 'S-1-1-0' }] : [],
  privileges: privileges.map((name) => ({ name, enabled: true })),
});

test('the verdict logic: refusals pass for non-members, success passes for unrestricted members, a restricted member is only measured', windowsOnly, () => {
  const outcomes = [
    { lines: [line('wmi_connect', { ok: true })], target: 'wmi_connect', expect: 'allowed' },
    { lines: [line('wmi_connect', denied)], target: 'wmi_connect', expect: 'denied' },
    { lines: [line('wmi_connect', { ok: false, hresult: '0x80070005' })], target: 'wmi_connect', expect: 'denied' },
    { lines: [line('thumbnail', { ok: false, returnValue: 32769 })], target: 'thumbnail', expect: 'denied' },
    { lines: [line('vm_lookup', { ok: false, hresult: '0x80041002' })], target: 'vm_lookup', expect: 'not_visible' },
    { lines: [line('thumbnail', { ok: false, returnValue: 32768 })], target: 'thumbnail', expect: 'error' },
    { lines: [line('keyboard_typekey', { ok: false, hresult: '0x800706BA' })], target: 'keyboard_typekey', expect: 'error' },
    { lines: [line('wmi_connect', denied), line('thumbnail', { ok: false, skipped: true, because: 'wmi_connect' })], target: 'thumbnail', expect: 'denied' },
    { lines: [line('thumbnail', { ok: false, skipped: true, because: 'wmi_connect' })], target: 'thumbnail', expect: 'missing' },
    { lines: [], target: 'mouse_setabsoluteposition', expect: 'missing' },
    // the Broker adapter lines carry a reason word only; a failure reads as refused when the raw check of the same operation was refused
    { lines: [line('adapter_capture', { ok: true, bytes: 900, pngCheck: 'signature_ihdr_iend_ok' })], target: 'adapter_capture', expect: 'allowed' },
    { lines: [line('thumbnail', denied), line('adapter_capture', { ok: false, reason: 'capture_failed' })], target: 'adapter_capture', expect: 'denied' },
    { lines: [line('thumbnail', { ok: false, hresult: '0x80041002' }), line('adapter_capture', { ok: false, reason: 'desktop_unavailable' })], target: 'adapter_capture', expect: 'not_visible' },
    { lines: [line('thumbnail', { ok: true, returnValue: 0 }), line('adapter_capture', { ok: false, reason: 'capture_failed' })], target: 'adapter_capture', expect: 'error' },
    { lines: [line('adapter_capture', { ok: false, reason: 'capture_failed' })], target: 'adapter_capture', expect: 'error' },
    { lines: [line('thumbnail', denied), line('adapter_capture', { ok: false, reason: 'png_invalid', pngCheck: 'bad_size' })], target: 'adapter_capture', expect: 'error' },
    { lines: [line('thumbnail', denied), line('adapter_capture', { ok: false, reason: 'allowlist' })], target: 'adapter_capture', expect: 'error' },
    { lines: [line('keyboard_typekey', { ok: true, returnValue: 0 }), line('mouse_setabsoluteposition', denied), line('adapter_input', { ok: false, reason: 'input_failed' })], target: 'adapter_input', expect: 'denied' },
    { lines: [line('keyboard_typekey', { ok: false, hresult: '0x80004005' }), line('mouse_setabsoluteposition', { ok: false, hresult: '0x80004005' }), line('adapter_input', { ok: false, reason: 'input_failed' })], target: 'adapter_input', expect: 'error' },
    { lines: [line('wmi_connect', denied), line('adapter_input', { ok: false, skipped: true, because: 'wmi_connect' })], target: 'adapter_input', expect: 'denied' },
    // the probe's own "not found" wording (the object is hidden from this caller) is a refusal in effect
    { lines: [line('thumbnail', { ok: false, exception: 'InvalidOperationException', hresult: '0x80131509', message: 'management_service_not_found' })], target: 'thumbnail', expect: 'not_visible' },
    { lines: [line('thumbnail', { ok: false, exception: 'InvalidOperationException', hresult: '0x80131509', message: 'something else broke' })], target: 'thumbnail', expect: 'error' },
  ];
  const verdicts = [
    // [member, sidtype, kind, outcome, expected]
    [false, 'restricted', 'sensitive', 'denied', 'PASS'], [false, 'unrestricted', 'sensitive', 'not_visible', 'PASS'],
    [false, 'unrestricted', 'sensitive', 'allowed', 'FAIL'], [false, 'restricted', 'sensitive', 'error', 'BLOCKED'],
    [false, 'restricted', 'gate', 'allowed', 'MEASURED'], [false, 'unrestricted', 'gate', 'denied', 'MEASURED'],
    [true, 'unrestricted', 'sensitive', 'allowed', 'PASS'], [true, 'unrestricted', 'gate', 'allowed', 'PASS'],
    [true, 'unrestricted', 'sensitive', 'denied', 'FAIL'], [true, 'unrestricted', 'sensitive', 'error', 'BLOCKED'],
    [true, 'restricted', 'sensitive', 'allowed', 'MEASURED'], [true, 'restricted', 'sensitive', 'denied', 'MEASURED'],
    [true, 'restricted', 'gate', 'denied', 'MEASURED'], [true, 'restricted', 'sensitive', 'error', 'MEASURED'],
    [true, 'unrestricted', 'reference', 'allowed', 'MEASURED'], [false, 'restricted', 'reference', 'denied', 'MEASURED'],
    [true, 'restricted', 'sensitive', 'missing', 'BLOCKED'], [false, 'unrestricted', 'reference', 'missing', 'BLOCKED'],
  ];
  const tokens = [
    { token: token({ member: true, restricted: true }), sid: 'S-1-5-80-1', member: true, sidtype: 'restricted', expect: true },
    { token: token({ member: false, restricted: false }), sid: 'S-1-5-80-1', member: false, sidtype: 'unrestricted', expect: true },
    { token: token({ member: false, restricted: true }), sid: 'S-1-5-80-1', member: true, sidtype: 'restricted', expect: false },        // membership did not reach the token
    { token: token({ member: true, restricted: false }), sid: 'S-1-5-80-1', member: false, sidtype: 'unrestricted', expect: false },      // joined by mistake
    { token: token({ member: true, restricted: false }), sid: 'S-1-5-80-1', member: true, sidtype: 'restricted', expect: false },        // not restricted
    { token: token({ member: true, restricted: true }), sid: 'S-1-5-80-1', member: true, sidtype: 'unrestricted', expect: false },        // restricted by mistake
    { token: token({ member: true, restricted: true, privileges: ['SeChangeNotifyPrivilege', 'SeImpersonatePrivilege'] }), sid: 'S-1-5-80-1', member: true, sidtype: 'restricted', expect: false },
    { token: token({ member: true, restricted: true, sid: 'S-1-5-80-2' }), sid: 'S-1-5-80-1', member: true, sidtype: 'restricted', expect: false },
    { token: null, sid: 'S-1-5-80-1', member: true, sidtype: 'restricted', expect: false },
  ];
  const text = 'access denied \u898b\u3064 S-1-5-21-111-222-333-1001 end';
  const dir = mkdtempSync(path.join(tmpdir(), 'albera-hv-logic-'));
  try {
    const script = path.join(dir, 'drive.ps1'); const cases = path.join(dir, 'cases.json');
    writeFileSync(script, driverScript);
    // Escaped to ASCII: Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page.
    writeFileSync(cases, JSON.stringify({
      outcomes, text, tokens,
      verdicts: verdicts.map(([member, sidtype, kind, outcome]) => ({ member, sidtype, kind, outcome })),
    }).replace(/[^\x00-\x7f]/gu, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
    const result = JSON.parse(powershell(['-File', script, guestPath, cases]).trim().split(/\r?\n/u).at(-1));
    assert.deepEqual(result.outcomes, outcomes.map((o) => o.expect));
    assert.deepEqual(result.verdicts, verdicts.map((v) => v[4]));
    assert.deepEqual(result.tokens, tokens.map((t) => t.expect));
    assert.equal(result.ascii, 'access denied ?? S-1-5-21-<redacted> end');
  }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
