import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// lab-vm.ps1 -HostMigrate and its guest hook lab-host-migrate-check.ps1: a first-layout install (the local account albera-cp) made by the installer of an OLD commit, then the CURRENT installer's
// -Mode plan -PlanFor migrate, -Mode migrate -TrustLocalBuilds, -Mode status and -Mode uninstall. The VM run is the lead's; here the scripts' text is checked and the hook's refusal outside the lab is run.
const labDir = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(path.join(labDir, name), 'utf8');
const hook = read('lab-host-migrate-check.ps1');
const driver = read('lab-vm.ps1');
const windows = process.platform === 'win32';
const POWERSHELL = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell';
// The migration part of the driver: from its helper functions up to the start of the existing labs' shared setup.
const migrateDriver = driver.slice(driver.indexOf('function Build-LegacyHostTree'), driver.indexOf("$golden ='"));

test('the hook is ASCII only (Windows PowerShell 5.1 reads a file without a BOM as the ANSI code page)', () => {
  assert.equal(/[^\t\r\n -~]/u.test(hook), false);
});

test('the hook refuses to run outside the lab VM', { skip: !windows && 'Windows PowerShell only', timeout: 120_000 }, () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(labDir, 'lab-host-migrate-check.ps1'),
    '-LegacyScriptDir', labDir, '-LegacyRepoRoot', labDir, '-HostScriptDir', labDir, '-RepoRoot', labDir], { encoding: 'utf8', env: { ...env, ALBERA_LAB_VM: '' }, windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /ALBERA_LAB_VM/u);
});

test('the hook runs the old installer first, then plan, migrate, status and uninstall of the current one, in that order', () => {
  const at = (needle) => { const i = hook.indexOf(needle); assert.ok(i >= 0, `the hook has ${needle}`); return i; };
  const order = [
    at("Invoke-Installer $legacyScript $LegacyRepoRoot (@{ Mode = 'install'"),
    at('Start-LegacyAccountOnce $password'),
    at("Mode = 'plan'; PlanFor = 'migrate'; TrustLocalBuilds = $true"),
    at("Mode = 'migrate'; TrustLocalBuilds = $true"),
    at("Invoke-Installer $hostScript $RepoRoot @{ Mode = 'status' }"),
    at("Invoke-Installer $hostScript $RepoRoot @{ Mode = 'uninstall' }"),
  ];
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(hook, /GrantHyperVToBroker = \$true; VmId = \$labVmId/u, 'the OLD install makes the grant, with the fixed lab GUID through its lab-only -VmId');
  assert.match(hook, /ControlPlanePassword = \$password/u, 'the old account gets a password only the old installer\'s lab-only parameter takes');
  assert.doesNotMatch(hook, /Mode = 'migrate'[^}]*(ApproverKeyId|ApproverPublicKey|ApproverSid|ExpectedTreeHash|GrantHyperVToBroker|VmId)/u, 'migrate carries the values over; it is given none of them');
  assert.match(hook, /\$labSources = @\{ NodeSource = \$nodeStub; ClaudeSource = \$claudeStub \}/u);
});

test('the hook never prints or unwraps the account password; albera-cp runs one program through the secondary logon service, and the hook ends no process itself', () => {
  assert.doesNotMatch(hook, /Write-Host|Write-Output|ConvertFrom-SecureString|SecureStringToBSTR|GetNetworkCredential/u);
  assert.equal([...hook.matchAll(/-AsPlainText/gu)].length, 1, 'plain text exists only where the random password is turned into a SecureString');
  assert.match(hook, /\$password = \$null/u);
  assert.match(hook, /Start-Process -FilePath \(Join-Path \$env:SystemRoot 'System32\\cmd\.exe'\) -ArgumentList '\/c exit 0' -Credential \$credential -LoadUserProfile -WorkingDirectory/u, 'what runas does: the profile is made, loaded and let go again');
  assert.match(hook, /\$credential = New-Object System\.Management\.Automation\.PSCredential\('\.\\albera-cp', \$Password\)/u, 'the SecureString goes straight into the credential');
  assert.doesNotMatch(hook, /Register-ScheduledTask|New-Service|LsaAddAccountRights/u, 'a task or a service would leave the profile loaded, and a loaded profile cannot be deleted');
  assert.doesNotMatch(hook, /Stop-Process|taskkill|Get-Process|Terminate|\.Kill\(/u, 'the hook ends no process');
  assert.match(hook, /Add-Check \$checks 'legacy_profile_not_loaded_before_migrate'/u, 'a profile this lab left loaded is named as the lab\'s fault, not the installer\'s');
});

test('the hook checks every item the migration must show, with the names the evidence uses', () => {
  const ids = [...hook.matchAll(/Add-Check \$checks '([a-z0-9_]+)'/gu)].map((m) => m[1]);
  for (const id of [
    'approver_values_carried', 'vm_guid_carried', 'computer_id_and_project_carried', 'grant_choice_carried', 'record_is_the_new_layout',
    'albera_cp_account_gone', 'albera_cp_profile_gone', 'legacy_profile_exists_before_migrate', 'legacy_account_ran_once', 'legacy_profile_not_loaded_before_migrate',
    'cp_runs_as_its_service_identity', 'cp_sidtype_restricted', 'cp_privileges_minimal', 'configs_name_the_cp_service_sid',
    'broker_sid_in_hyperv_admins', 'only_the_broker_in_hyperv_admins', 'broker_unrestricted_authority_restricted',
    'nothing_left_behind', 'group_otherwise_unchanged', 'final_status_not_installed', 'plan_changed_nothing',
  ]) assert.ok(ids.includes(id), `check ${id}`);
  assert.match(hook, /Add-Check \$checks \('delayed_auto_' \+ \$n\) \(\$null -ne \$s -and \$s\.StartMode -eq 'Auto' -and \$s\.DelayedAutoStart -eq \$true\)/u, 'all three services, read from Win32_Service');
  assert.match(hook, /foreach \(\$n in @\('AlberaHostBroker', 'AlberaApprovalAuthority', 'AlberaControlPlane'\)\)/u);
  // the profile is read both as a folder and as the WMI entry; the whole-lab verdict fails on any FAIL or on an empty list
  assert.match(hook, /\$legacyProfile = 'C:\\Users\\albera-cp'/u);
  assert.match(hook, /Get-CimInstance Win32_UserProfile -Filter "SID='\$sid'"/u);
  assert.match(hook, /\$evidence\.pass = \(@\(\$checks \| Where-Object \{ \$_\.status -eq 'FAIL' \}\)\.Count -eq 0\) -and \$checks\.Count -gt 0/u);
  assert.match(hook, /if \(-not \$evidence\.pass\) \{ exit 1 \}/u);
  // a guest without Hyper-V Administrators cannot show the grant: BLOCKED and a non-zero exit, never a pass
  assert.match(hook, /\$evidence\.status = 'BLOCKED'[^\n]*\$evidence\.pass = \$false/u);
  // a Control Plane that does run must run as its service SID; one that does not is reported, not failed
  assert.match(hook, /'cp_process_owner_is_its_service_sid'/u);
  assert.match(hook, /Reported, not required/u);
});

test('the driver takes -HostMigrate with a validated -LegacyRef, builds the old tree before any VM exists and removes it afterwards', () => {
  assert.match(driver, /\[switch\]\$HostMigrate,\r?\n/u);
  assert.match(driver, /\[string\]\$LegacyRef,\r?\n/u);
  assert.match(migrateDriver, /\$Ref -notmatch '\^\[0-9a-f\]\{7,40\}\$'/u, 'only a hex commit id reaches a command line');
  assert.match(migrateDriver, /git -C \$Repo rev-parse --verify "\$Ref\^\{commit\}"/u);
  assert.match(migrateDriver, /git -C \$Repo archive --format=tar -o \$archive \$commit/u, 'the tree of the commit, not the working tree');
  assert.match(driver, /-HostMigrate is a separate lab from -HyperV, -HostInstall and -ControlPlaneService/u);
  assert.match(driver, /-HostMigrate needs -LegacyRef/u);
  assert.match(driver, /-LegacyRef is only for -HostMigrate/u);
  // the old build is made before the memory check and before New-VM, so a wrong ref or a failed build costs no VM
  const build = driver.indexOf('$legacyCommit = Build-LegacyHostTree $repo $LegacyRef $legacyDir');
  assert.ok(build > 0 && build < driver.indexOf('# Refuse to start when the host is short on memory') && build < driver.indexOf('New-VM -Name'));
  // the copy of the old tree is removed in finally, and only the folder under this VM's own folder; that folder goes too when the run stopped before the VM was made and it is empty (no -Recurse)
  assert.match(driver, /\$legacyDir = Join-Path \$root 'legacy-src'/u);
  assert.match(driver, /Attributes -band \[IO\.FileAttributes\]::ReparsePoint\)\) \{ Remove-Item -LiteralPath \$legacyDir -Recurse -Force/u);
  assert.match(driver, /if \(-not \$vmCreated -and \(Test-Path -LiteralPath \$root\) -and -not \(Get-ChildItem -LiteralPath \$root -Force\)\) \{ Remove-Item -LiteralPath \$root -ErrorAction SilentlyContinue \}/u);
  assert.match(driver, /if \(\$HostInstall -or \$HostMigrate\) \{\r?\n\s*# the host installer now installs/u, '-Build also makes the Control Plane host and the approver for the migration');
  assert.match(driver, /elseif \(\$HostMigrate\) \{\r?\n\s*\$hmOut = @\(Invoke-HostMigrateLab/u);
});

test('the driver copies the old and the current tree into separate guest roots, sets ALBERA_LAB_VM only inside the guest process, and downloads nothing', () => {
  assert.match(migrateDriver, /\$legacyGuest = 'C:\\albera-legacy-lab'/u);
  assert.match(migrateDriver, /\$guestRepo = 'C:\\albera-host-lab'/u);
  const published = [...migrateDriver.matchAll(/'src\\runtime\\([a-z-]+)\\bin\\Release/gu)].map((m) => m[1]);
  assert.deepEqual(published, ['windows-broker', 'windows-approval-authority', 'windows-broker-pipe-client', 'windows-control-plane-host', 'windows-approver'], 'the three of the old installer, plus the two the new one adds');
  assert.match(migrateDriver, /\$env:ALBERA_LAB_VM = '1'/u);
  assert.match(migrateDriver, /-LegacyScriptDir "\$legacy\\scripts\\host" -LegacyRepoRoot \$legacy -HostScriptDir "\$r\\scripts\\host" -RepoRoot \$r/u);
  assert.doesNotMatch(migrateDriver, /Invoke-WebRequest|Invoke-RestMethod|curl|wget|npm (install|ci)|winget|Stop-Process|taskkill/u);
  assert.match(migrateDriver, /Write-Host "host-migrate checks:/u);
  assert.match(migrateDriver, /if \(\$hookOutput\.Exit -eq 0 -and \$results -and \$results\.pass\) \{ return 0 \}/u, 'exit 0 needs both the hook exit and the evidence verdict');
});
