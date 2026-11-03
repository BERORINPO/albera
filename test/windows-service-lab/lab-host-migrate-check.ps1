# Guest-side hook for the HOST migration (scripts/host/albera-host.ps1 -Mode migrate, control-plane-service.md section 9). Runs INSIDE a disposable lab VM as Administrator (Windows PowerShell 5.1), ASCII only. LAB ONLY.
#   lab-host-migrate-check.ps1 -LegacyScriptDir <old albera-host*.ps1> -LegacyRepoRoot <old publish folders> -HostScriptDir <current albera-host*.ps1> -RepoRoot <current publish folders>
# It first makes a FIRST-LAYOUT install with the OLD installer (the local account albera-cp with a lab-generated password that is never printed, the Broker's Hyper-V grant with a fixed throw-away VM GUID),
# starts a program once as albera-cp, the way the owner's old Control Plane was started (runas: Start-Process -Credential -LoadUserProfile logs the account on, creates and loads its profile, and unloads it again when the
# program ends; cmd.exe /c exit 0 stands in for the old Control Plane, whose node and room are NOT run, and it ends at once because a process started this way in a PowerShell Direct session has no desktop to run on), and then
# runs the CURRENT installer: -Mode plan -PlanFor migrate, -Mode migrate -TrustLocalBuilds, -Mode status
# and -Mode uninstall, all non-interactively. It prints one JSON evidence object and exits 1 unless every check passed. The current installer takes node.exe (the one the lab driver copied beside this hook) and a
# stand-in claude.exe through the lab-only -NodeSource / -ClaudeSource, which it accepts only because the lab driver sets ALBERA_LAB_VM=1 in the VM.
# Checked independently of the installer's own read-back (with Windows' own tools, not the installer's functions): the approver values (key id, public key, SID), the VM GUID, the computer id and the grant choice are
# the ones the old install held; albera-cp, its profile and its Win32_UserProfile entry are gone; the three services are start= delayed-auto and the Control Plane's account is NT SERVICE\AlberaControlPlane
# (restricted SID type, SeChangeNotifyPrivilege only); both configs name the Control Plane's service SID; the Broker's service SID (and nobody else) is in Hyper-V Administrators while installed; after the uninstall
# nothing is left and the group is as it was. After the migration each service is started once and stopped again: the state of the Broker and the Authority is reported, not required (the guest has no Hyper-V role), but the Control
# Plane, if it runs, must run as its service SID. No process of albera-cp is alive when the migration starts (see above), so the stop-by-PID step is NOT exercised here; test/host-install.test.mjs covers it with fakes.
# LAB ONLY, and it proves nothing about provenance: -TrustLocalBuilds hashes the copies in this guest. The old build and the new build are the two folders the driver copied.
# Refuses to run unless ALBERA_LAB_VM=1 and no Albera folder, account or profile exists yet. NOT a proof for the owner's PC: the VM GUID is a fixed one (the lookup of a real VM by name is not exercised).
param(
  [Parameter(Mandatory = $true)][string]$LegacyScriptDir,
  [Parameter(Mandatory = $true)][string]$LegacyRepoRoot,
  [Parameter(Mandatory = $true)][string]$HostScriptDir,
  [Parameter(Mandatory = $true)][string]$RepoRoot
)
$ErrorActionPreference = 'Stop'
if ($env:ALBERA_LAB_VM -ne '1') { throw 'refusing to run: this is the lab VM hook. ALBERA_LAB_VM=1 must be set by the lab driver inside the disposable VM; never run it on a real PC.' }
$legacyScript = Join-Path $LegacyScriptDir 'albera-host.ps1'
$hostScript = Join-Path $HostScriptDir 'albera-host.ps1'
foreach ($f in @($legacyScript, $hostScript)) { if (-not (Test-Path -LiteralPath $f)) { throw "$f not found" } }
$programData = Join-Path $env:ProgramData 'Albera'; $programFiles = Join-Path $env:ProgramFiles 'Albera'
$legacyProfile = 'C:\Users\albera-cp'   # the folder the installer removes, and only this exact one
foreach ($p in @($programData, $programFiles, $legacyProfile)) { if (Test-Path -LiteralPath $p) { throw "$p already exists; the lab hook needs a fresh VM" } }
if (Get-LocalUser -Name 'albera-cp' -ErrorAction SilentlyContinue) { throw 'the local user albera-cp already exists; the lab hook needs a fresh VM' }

# A throw-away RSA-2048 PUBLIC key (the one lab-guest.ps1 pins); the approver SID is this Administrator account (S-1-5-21-...-500), which is not the albera-cp account.
$labApproverKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3XSX1Rx6n1/sVaG+opeyv2Qj/+8woifjIQgxqheuZ1LtyB/JUeDgkP6wIc6YSAQzMKbdwZ88ipVJidmpixqr0P4tcE3Ud6VqerYfHnrVlqGKHojUU0r2kmtKib9f3bT0+ljHa54Dux9jcGSncwXpXcRrOkNFRFrWuS99+yXpFWdgYeawOK9SegknG1J4Rw7fjPZurkVWYYLl17T10PSIg0TGY0eJRgRXVw7PQhsLRh4u3ErDSd4dkE4j1aUR0jCGovRZJrrAMib7P1+GPRUOL6bviCkYY9Q2yOIP+OKWevFw80WXdYktQv/3xeloBWYctgzU6aS7J+7logyEYr0zWwIDAQAB'
$approverSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$approverParams = @{ ApproverKeyId = 'hello-lab-0001'; ApproverPublicKey = $labApproverKey; ApproverSid = $approverSid }
$labVmId = '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f'   # fixed and throw-away; the guest has no VM of this name
$hvAdminsSid = 'S-1-5-32-578'

# The two programs the current installer pins (lab-only parameters): the node.exe the driver copied beside this hook, and a stand-in for claude.exe (hashed and copied, never started).
$nodeStub = Join-Path $PSScriptRoot 'node.exe'
if (-not (Test-Path -LiteralPath $nodeStub)) { throw "node.exe not found beside the hook ($nodeStub); lab-vm.ps1 -HostMigrate copies it" }
$claudeStub = Join-Path $PSScriptRoot 'claude-stub.exe'
[System.IO.File]::WriteAllText($claudeStub, 'lab stand-in for the owner claude.exe; the installer only hashes and copies it')
$labSources = @{ NodeSource = $nodeStub; ClaudeSource = $claudeStub }

# $Params is a hashtable of the installer's parameters (a hashtable splat binds names; an array splat would pass '-Mode' as a value).
function Invoke-Installer([string]$Script, [string]$Root, [hashtable]$Params) {
  $all = @{ RepoRoot = $Root } + $Params
  $text = (& $Script @all *>&1 | Out-String)
  [pscustomobject]@{ Exit = $LASTEXITCODE; Output = $text }
}
. (Join-Path $HostScriptDir 'albera-host-lib.ps1')   # Get-HostConstants and Test-AuthoritySigningKeyExists, for the remnant check only
function Get-TreeHash([string]$Script, [string]$Root) {
  $r = Invoke-Installer $Script $Root @{ Mode = 'hashes' }
  if ($r.Exit -ne 0) { throw "could not compute the lab hashes of $Root" }
  $hash = ([regex]::Match($r.Output, '(?m)^ALBERA_HOST_TREE_HASH=([0-9a-f]{64})\s*$')).Groups[1].Value
  if (-not $hash) { throw "no tree hash line in the -Mode hashes output of $Root" }
  $hash
}
function Get-Sha256([string]$Path) { if (Test-Path -LiteralPath $Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash } else { '' } }
function Get-HvGroupText { $name = (Get-LocalGroup -SID $hvAdminsSid).Name; ((& net.exe localgroup $name 2>&1) | Out-String) }
function Get-ScText([string]$Verb, [string]$Name) { ((& sc.exe $Verb $Name 2>&1) -join ' ') -replace '\s+', ' ' }
function Get-ScPrivileges([string]$Name) { @([regex]::Matches((Get-ScText 'qprivs' $Name), 'Se[A-Za-z]+Privilege') | ForEach-Object { $_.Value }) }
function Read-Json([string]$Path) { if (Test-Path -LiteralPath $Path) { Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json } else { $null } }
function Add-Check($List, [string]$Id, [bool]$Ok, [string]$Observed) { $List.Add([ordered]@{ id = $Id; status = $(if ($Ok) { 'PASS' } else { 'FAIL' }); observed = $Observed }) }

# What the install holds, read from its files: the Hello public values, the VM GUID, the computer id, the grant record and the Control Plane SID both configs name.
function Get-InstallFacts([string]$SettingsPath) {
  $broker = Read-Json (Join-Path $programData 'broker-config\AlberaHostBroker.service.json')
  $authority = Read-Json (Join-Path $programData 'authority\AlberaApprovalAuthority.service.json')
  $settings = Read-Json $SettingsPath
  $manifest = Read-Json (Join-Path $programData 'install-manifest.json')
  $computer = @($broker.computers) | Select-Object -First 1
  $grant = if ($manifest -and $manifest.created) { $manifest.created.hyperVGrant } else { $null }
  [ordered]@{
    approverKeyId = [string]$authority.approverKeyId; approverPublicKey = [string]$authority.approverPublicKey; approverSid = [string]$authority.approverSid
    authorityControlPlaneSid = [string]$authority.controlPlaneSid; brokerControlPlaneSid = [string]$broker.controlPlaneSid
    brokerAuthorityKeys = (ConvertTo-Json -InputObject $broker.authorityKeys -Compress)
    computerId = [string]$computer.computerId; vmId = [string]$computer.vmId
    projectId = [string]$settings.projectId; settingsComputers = (ConvertTo-Json -InputObject $settings.computers -Compress)
    grantRecorded = ($null -ne $grant); grantVmId = $(if ($grant) { [string]$grant.vmId } else { '' })
    recordHasUser = ($null -ne $manifest -and $null -ne $manifest.created.user); recordHasControlPlane = ($null -ne $manifest -and $null -ne $manifest.created.controlPlane)
  }
}
function Get-Remnants {
  $sid = $script:LegacySid
  [ordered]@{
    services = @(@('AlberaHostBroker', 'AlberaApprovalAuthority', 'AlberaControlPlane') | Where-Object { Get-CimInstance Win32_Service -Filter "Name='$_'" })
    user = [bool](Get-LocalUser -Name 'albera-cp' -ErrorAction SilentlyContinue)
    profileFolder = Test-Path -LiteralPath $legacyProfile
    profileEntry = [bool]($sid -and (Get-CimInstance Win32_UserProfile -Filter "SID='$sid'"))
    startMenu = Test-Path -LiteralPath (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\ALBERA')
    runValue = ($null -ne (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name 'AlberaApprover' -ErrorAction SilentlyContinue))
    key = [bool](Test-AuthoritySigningKeyExists (Get-HostConstants).SigningKeyName)
    programData = Test-Path -LiteralPath $programData
    programFiles = Test-Path -LiteralPath $programFiles
    alberaRegistryKey = Test-Path -LiteralPath 'HKLM:\SOFTWARE\Albera'
    brokerInHyperVAdmins = ((Get-HvGroupText) -match 'AlberaHostBroker')
  }
}
function Test-NothingLeft($Remnants) {
  (-not $Remnants.user) -and (-not $Remnants.profileFolder) -and (-not $Remnants.profileEntry) -and (-not $Remnants.startMenu) -and (-not $Remnants.runValue) -and (-not $Remnants.key) -and
  (-not $Remnants.programData) -and (-not $Remnants.programFiles) -and (-not $Remnants.alberaRegistryKey) -and (-not $Remnants.brokerInHyperVAdmins) -and @($Remnants.services).Count -eq 0
}

# Starts `cmd.exe /c exit 0` once as albera-cp through the secondary logon service (what runas does): the account is logged on, its profile folder is made and loaded, and both are let go when the program ends. A scheduled task or a
# service would also make the profile, but Windows keeps such a profile loaded after the task or service has ended (found by this lab, 2026-11-04), and a loaded profile cannot be deleted. Waits until the profile is unloaded.
# The working directory is set because the default (the caller's profile) is not readable for the new account ("The directory name is invalid").
function Start-LegacyAccountOnce([securestring]$Password, [string]$Sid) {
  $report = [ordered]@{ how = 'cmd.exe /c exit 0 as albera-cp (Start-Process -Credential -LoadUserProfile, the way runas starts it); the old Control Plane itself (node, the room) was not run'; startError = $null; profileFolderAppeared = $false; profileLoaded = $null }
  $credential = New-Object System.Management.Automation.PSCredential('.\albera-cp', $Password)
  try {
    $process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList '/c exit 0' -Credential $credential -LoadUserProfile -WorkingDirectory (Join-Path $env:SystemRoot 'System32') -WindowStyle Hidden -PassThru
    [void]$process.WaitForExit(30000)
  }
  catch { $report.startError = $_.Exception.Message }
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $legacyProfile)) { Start-Sleep -Seconds 2 }
  $report.profileFolderAppeared = Test-Path -LiteralPath $legacyProfile
  do {
    $entry = Get-CimInstance Win32_UserProfile -Filter "SID='$Sid'"
    $report.profileLoaded = $(if ($entry) { [bool]$entry.Loaded } else { $null })
    if ($report.profileLoaded -eq $false) { break }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  $report
}

# Starts one service once (the way the owner would: Start-Service in the console the installer tells about), reports what became of it and the owner SID of its process, and stops it again.
function Measure-ServiceStart([string]$Name) {
  $row = [ordered]@{ name = $Name; startOutput = ''; state = ''; exitCode = $null; specificExitCode = $null; processOwnerSid = $null }
  $row.startOutput = (((& sc.exe start $Name 2>&1) | Out-String) -replace '\s+', ' ').Trim()
  $deadline = (Get-Date).AddSeconds(40)
  do { Start-Sleep -Seconds 2; $s = Get-CimInstance Win32_Service -Filter "Name='$Name'" } while ((Get-Date) -lt $deadline -and $s.State -eq 'Start Pending')
  $row.state = [string]$s.State; $row.exitCode = [int]$s.ExitCode; $row.specificExitCode = [int]$s.ServiceSpecificExitCode
  if ($s.State -eq 'Running' -and $s.ProcessId) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($s.ProcessId)"
    $owner = if ($process) { Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction SilentlyContinue } else { $null }
    if ($owner -and $owner.ReturnValue -eq 0) { $row.processOwnerSid = [string]$owner.Sid }
    & sc.exe stop $Name 2>&1 | Out-Null
    $stopDeadline = (Get-Date).AddSeconds(30)
    do { Start-Sleep -Seconds 1; $s = Get-CimInstance Win32_Service -Filter "Name='$Name'" } while ((Get-Date) -lt $stopDeadline -and $s.State -ne 'Stopped')
  }
  $row
}

$evidence = [ordered]@{ approverSid = $approverSid; labVmId = $labVmId; guidSource = 'a fixed lab GUID through the old installer''s lab-only -VmId; the lookup of a real VM by name is NOT exercised here' }
$checks = New-Object 'System.Collections.Generic.List[object]'
$groupBefore = $null
$hvNamespace = $false
try { Get-CimInstance -Namespace 'root\virtualization\v2' -ClassName Msvm_VirtualSystemManagementService -ErrorAction Stop | Out-Null; $hvNamespace = $true } catch { }
$evidence.hyperVWmiNamespaceInGuest = $hvNamespace
$script:LegacySid = $null

if (-not (Get-LocalGroup -SID $hvAdminsSid -ErrorAction SilentlyContinue)) {
  $evidence.status = 'BLOCKED'; $evidence.reason = 'this guest has no local group S-1-5-32-578 (Hyper-V Administrators); the grant path cannot be shown'; $evidence.pass = $false
  $evidence | ConvertTo-Json -Depth 6
  exit 1
}
$groupBefore = Get-HvGroupText

try {
  # ---- 1. the first-layout install, made by the OLD installer
  $legacyTree = Get-TreeHash $legacyScript $LegacyRepoRoot
  $bytes = New-Object byte[] 12; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose()
  $password = ConvertTo-SecureString ('Lab-' + ([BitConverter]::ToString($bytes) -replace '-', '') + '-a1!') -AsPlainText -Force
  $old = Invoke-Installer $legacyScript $LegacyRepoRoot (@{ Mode = 'install'; ExpectedTreeHash = $legacyTree; StartCheck = $hvNamespace; ControlPlanePassword = $password; GrantHyperVToBroker = $true; VmId = $labVmId } + $approverParams)
  $evidence.legacyInstall = [ordered]@{ exit = $old.Exit; treeHash = $legacyTree; startCheckRun = $hvNamespace; output = $old.Output }
  Add-Check $checks 'legacy_install_exit_0' ($old.Exit -eq 0) ('exit ' + $old.Exit)
  if ($old.Exit -ne 0) { throw 'the old installer did not finish; nothing to migrate' }
  $legacyUser = Get-LocalUser -Name 'albera-cp' -ErrorAction SilentlyContinue
  Add-Check $checks 'legacy_account_exists' ($null -ne $legacyUser) 'Get-LocalUser albera-cp'
  $script:LegacySid = $legacyUser.SID.Value
  $legacyFacts = Get-InstallFacts (Join-Path $programData 'control-plane\albera.approval.json')
  $evidence.legacyFacts = $legacyFacts
  Add-Check $checks 'legacy_install_is_first_layout' ($legacyFacts.recordHasUser -and -not $legacyFacts.recordHasControlPlane -and $legacyFacts.grantRecorded -and $legacyFacts.grantVmId -ceq $labVmId) ('user in record ' + $legacyFacts.recordHasUser + '; grant ' + $legacyFacts.grantRecorded)
  Add-Check $checks 'legacy_broker_in_hyperv_admins' ((Get-HvGroupText) -match 'NT SERVICE\\AlberaHostBroker') 'net localgroup lists NT SERVICE\AlberaHostBroker'

  # ---- 2. the old Control Plane's account runs a program once, so that its profile exists before the migration
  $evidence.legacyAccountStart = Start-LegacyAccountOnce $password $script:LegacySid
  Add-Check $checks 'legacy_account_ran_once' ($null -eq $evidence.legacyAccountStart.startError) $(if ($evidence.legacyAccountStart.startError) { $evidence.legacyAccountStart.startError } else { 'Start-Process -Credential -LoadUserProfile as albera-cp' })
  $legacyProfileEntry = Get-CimInstance Win32_UserProfile -Filter "SID='$($script:LegacySid)'"
  Add-Check $checks 'legacy_profile_not_loaded_before_migrate' ($null -ne $legacyProfileEntry -and $evidence.legacyAccountStart.profileLoaded -eq $false) ('Win32_UserProfile Loaded: ' + $evidence.legacyAccountStart.profileLoaded + ' (a loaded profile cannot be deleted by anyone; that would be this lab, not the installer)')
  Add-Check $checks 'legacy_profile_exists_before_migrate' ((Test-Path -LiteralPath $legacyProfile) -and $null -ne $legacyProfileEntry) ("folder $legacyProfile; Win32_UserProfile LocalPath " + $(if ($legacyProfileEntry) { $legacyProfileEntry.LocalPath } else { 'none' }))
  $password = $null

  # ---- 3. the plan: changes nothing
  $manifest = Join-Path $programData 'install-manifest.json'
  $manifestBeforePlan = Get-Sha256 $manifest
  $plan = Invoke-Installer $hostScript $RepoRoot (@{ Mode = 'plan'; PlanFor = 'migrate'; TrustLocalBuilds = $true } + $labSources)
  $evidence.plan = [ordered]@{ exit = $plan.Exit; output = $plan.Output }
  Add-Check $checks 'plan_exit_0_and_nothing_blocked' ($plan.Exit -eq 0 -and $plan.Output -match 'PLAN ONLY' -and $plan.Output -notmatch '\[blocked\]') ('exit ' + $plan.Exit)
  Add-Check $checks 'plan_changed_nothing' ((Get-Sha256 $manifest) -eq $manifestBeforePlan -and [bool](Get-LocalUser -Name 'albera-cp' -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $legacyProfile) -and ((Get-HvGroupText) -match 'AlberaHostBroker')) 'manifest, account, profile and group membership are as before'

  # ---- 4. the migration
  $migrate = Invoke-Installer $hostScript $RepoRoot (@{ Mode = 'migrate'; TrustLocalBuilds = $true; StartCheck = $hvNamespace } + $labSources)
  $evidence.migrate = [ordered]@{ exit = $migrate.Exit; startCheckRun = $hvNamespace; output = $migrate.Output }
  Add-Check $checks 'migrate_exit_0' ($migrate.Exit -eq 0 -and $migrate.Output -match 'Migrated\.') ('exit ' + $migrate.Exit)
  $newFacts = Get-InstallFacts (Join-Path $programData 'control-plane-config\albera.approval.json')
  $evidence.newFacts = $newFacts
  # carried over
  Add-Check $checks 'approver_values_carried' ($newFacts.approverKeyId -ceq $legacyFacts.approverKeyId -and $newFacts.approverPublicKey -ceq $legacyFacts.approverPublicKey -and $newFacts.approverSid -ceq $legacyFacts.approverSid -and $newFacts.approverKeyId -ceq 'hello-lab-0001' -and $newFacts.approverSid -ceq $approverSid) ("key id $($newFacts.approverKeyId); SID $($newFacts.approverSid); SPKI equal " + ($newFacts.approverPublicKey -ceq $legacyFacts.approverPublicKey))
  Add-Check $checks 'vm_guid_carried' ($newFacts.vmId -ceq $legacyFacts.vmId -and $newFacts.vmId -ceq $labVmId -and $newFacts.grantVmId -ceq $labVmId) ("broker config vmId $($newFacts.vmId); grant record $($newFacts.grantVmId)")
  Add-Check $checks 'computer_id_and_project_carried' ($newFacts.computerId -ceq $legacyFacts.computerId -and $newFacts.projectId -ceq $legacyFacts.projectId -and $newFacts.settingsComputers -ceq $legacyFacts.settingsComputers) ("computerId $($newFacts.computerId); projectId $($newFacts.projectId); settings computers $($newFacts.settingsComputers)")
  Add-Check $checks 'grant_choice_carried' ($newFacts.grantRecorded -and ((Get-HvGroupText) -match 'NT SERVICE\\AlberaHostBroker')) ('hyperVGrant recorded ' + $newFacts.grantRecorded + '; the Broker SID is in the group')
  Add-Check $checks 'record_is_the_new_layout' ((-not $newFacts.recordHasUser) -and $newFacts.recordHasControlPlane) ('user in record ' + $newFacts.recordHasUser + '; controlPlane in record ' + $newFacts.recordHasControlPlane)
  # the Authority's signing key was made again (lost by design) and its public half is in the Broker config
  Add-Check $checks 'authority_key_made_again' ($newFacts.brokerAuthorityKeys -cne $legacyFacts.brokerAuthorityKeys -and $newFacts.brokerAuthorityKeys -match '"spki"') 'the Broker config authorityKeys differ from the old install'
  # the old account and its profile
  $afterMigrate = Get-Remnants
  Add-Check $checks 'albera_cp_account_gone' (-not $afterMigrate.user) 'Get-LocalUser albera-cp'
  Add-Check $checks 'albera_cp_profile_gone' ((-not $afterMigrate.profileFolder) -and (-not $afterMigrate.profileEntry)) ("folder $legacyProfile exists: " + $afterMigrate.profileFolder + '; Win32_UserProfile entry: ' + $afterMigrate.profileEntry)
  # the three services and the Control Plane's identity, read with the tools Windows ships
  $cpSid = $null
  try { $cpSid = (New-Object System.Security.Principal.NTAccount('NT SERVICE\AlberaControlPlane')).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { }
  foreach ($n in @('AlberaHostBroker', 'AlberaApprovalAuthority', 'AlberaControlPlane')) {
    $s = Get-CimInstance Win32_Service -Filter "Name='$n'"
    Add-Check $checks ('delayed_auto_' + $n) ($null -ne $s -and $s.StartMode -eq 'Auto' -and $s.DelayedAutoStart -eq $true) $(if ($s) { 'StartMode ' + $s.StartMode + ', DelayedAutoStart ' + $s.DelayedAutoStart + ', state ' + $s.State + ', exit ' + $s.ExitCode } else { 'service missing' })
  }
  $cp = Get-CimInstance Win32_Service -Filter "Name='AlberaControlPlane'"
  Add-Check $checks 'cp_runs_as_its_service_identity' ($null -ne $cp -and $cp.StartName -eq 'NT SERVICE\AlberaControlPlane' -and $cpSid -match '^S-1-5-80-') $(if ($cp) { $cp.StartName + ' (' + $cpSid + ')' } else { 'service missing' })
  $cpType = Get-ScText 'qsidtype' 'AlberaControlPlane'
  Add-Check $checks 'cp_sidtype_restricted' (($cpType -cmatch '(?<![A-Za-z])RESTRICTED') -and ($cpType -cnotmatch 'UNRESTRICTED')) $cpType
  $cpPrivs = Get-ScPrivileges 'AlberaControlPlane'
  Add-Check $checks 'cp_privileges_minimal' (($cpPrivs -join ',') -eq 'SeChangeNotifyPrivilege') ($cpPrivs -join ',')
  Add-Check $checks 'configs_name_the_cp_service_sid' ($cpSid -and $newFacts.authorityControlPlaneSid -ceq $cpSid -and $newFacts.brokerControlPlaneSid -ceq $cpSid -and $newFacts.authorityControlPlaneSid -cne $script:LegacySid) ("authority $($newFacts.authorityControlPlaneSid); broker $($newFacts.brokerControlPlaneSid); old account SID $($script:LegacySid)")
  # Hyper-V Administrators: the Broker's service SID, and nobody else
  $groupDuring = Get-HvGroupText
  Add-Check $checks 'broker_sid_in_hyperv_admins' ($groupDuring -match 'NT SERVICE\\AlberaHostBroker') 'net localgroup lists NT SERVICE\AlberaHostBroker'
  Add-Check $checks 'only_the_broker_in_hyperv_admins' (($groupDuring -notmatch 'albera-cp') -and ($groupDuring -notmatch 'AlberaControlPlane') -and ($groupDuring -notmatch 'AlberaApprovalAuthority')) 'neither albera-cp, the Control Plane nor the Authority is in the group'
  $brokerType = Get-ScText 'qsidtype' 'AlberaHostBroker'; $authorityType = Get-ScText 'qsidtype' 'AlberaApprovalAuthority'
  Add-Check $checks 'broker_unrestricted_authority_restricted' (($brokerType -cmatch '(?<![A-Za-z])UNRESTRICTED') -and ($authorityType -cmatch '(?<![A-Za-z])RESTRICTED') -and ($authorityType -cnotmatch 'UNRESTRICTED')) ("broker: $brokerType; authority: $authorityType")
  # whether the services run: each is started once and stopped again. Reported, not required (no Hyper-V role in this guest); but a Control Plane that DOES run must run as its service SID.
  $measured = @(@('AlberaHostBroker', 'AlberaApprovalAuthority', 'AlberaControlPlane') | ForEach-Object { Measure-ServiceStart $_ })
  $evidence.serviceStarts = $measured
  $cpRun = $measured | Where-Object { $_.name -eq 'AlberaControlPlane' }
  if ($cpRun.state -eq 'Running' -or $cpRun.processOwnerSid) { Add-Check $checks 'cp_process_owner_is_its_service_sid' ($cpRun.processOwnerSid -ceq $cpSid) ("process owner $($cpRun.processOwnerSid); service SID $cpSid") }

  # ---- 5. status
  $status = Invoke-Installer $hostScript $RepoRoot @{ Mode = 'status' }
  $evidence.status = [ordered]@{ exit = $status.Exit; output = $status.Output }
  Add-Check $checks 'status_exit_0' ($status.Exit -eq 0) ('exit ' + $status.Exit)

  # ---- 6. uninstall: nothing is left, the group is as before
  $un = Invoke-Installer $hostScript $RepoRoot @{ Mode = 'uninstall' }
  $evidence.uninstall = [ordered]@{ exit = $un.Exit; output = $un.Output }
  Add-Check $checks 'uninstall_exit_0' ($un.Exit -eq 0) ('exit ' + $un.Exit)
  $remnants = Get-Remnants
  $evidence.remnants = $remnants
  Add-Check $checks 'nothing_left_behind' (Test-NothingLeft $remnants) ((ConvertTo-Json -InputObject $remnants -Compress))
  Add-Check $checks 'group_otherwise_unchanged' ((Get-HvGroupText) -eq $groupBefore) 'groupBefore equals groupAfter'
  $final = Invoke-Installer $hostScript $RepoRoot @{ Mode = 'status' }
  Add-Check $checks 'final_status_not_installed' ($final.Output -match 'not installed') ('exit ' + $final.Exit)
}
catch { Add-Check $checks 'lab_hook_no_exception' $false ($_.Exception.Message) }
$evidence.checks = $checks.ToArray()
$evidence.pass = (@($checks | Where-Object { $_.status -eq 'FAIL' }).Count -eq 0) -and $checks.Count -gt 0
$evidence | ConvertTo-Json -Depth 6
if (-not $evidence.pass) { exit 1 }
