# Guest-side hook for the HOST installer (scripts/host/albera-host.ps1). Runs INSIDE a disposable lab VM as Administrator (Windows PowerShell 5.1), ASCII only. LAB ONLY.
#   lab-host-install-check.ps1 -HostScriptDir <folder with albera-host.ps1 + albera-host-lib.ps1> -RepoRoot <folder holding src\runtime\...\publish build outputs> [-KeepInstalled]
# It runs install (with -StartCheck: each service is started once and stopped again), status, a second install (must change nothing; an OLDER -SetupRunId must be refused), uninstall and a final status, all
# NON-interactively, and prints one JSON evidence object. There is no account and no password any more: the Control Plane is the service NT SERVICE\AlberaControlPlane. The lab guest has no Node and no Claude
# Code of the owner's, so node.exe is the one the lab driver copies beside this hook (what the installer pins) and claude.exe is a stand-in file (pinned, never run); both come in through the lab-only
# -NodeSource / -ClaudeSource, which the installer accepts only because the lab driver sets ALBERA_LAB_VM=1 in the VM. The Hello key is replaced by a throw-away public key passed as the normal parameters (no private
# half exists): the lab has no Windows Hello, and no check here asks for an approval. The Control Plane service's own start is reported (state, exit code), not required: whether `room-service` stays up under the
# service identity is a lab MEASUREMENT (control-plane-service.md M4), and the host's own log (control-plane\logs\host.log) is the evidence for it.
# The default pass also checks, independently of the installer's own read-back: the Control Plane service is delayed-auto, restricted, SeChangeNotifyPrivilege only, restarts twice on failure; the Broker's
# service ACL names its SERVICE SID with LC only; the service has READ only on control-plane-config; albera-cp does not exist; the shortcuts, the launcher and the HKLM Run value exist; the record has the pins and the run id.
# LAB ONLY, and it proves nothing about provenance: the -ExpectedTreeHash is computed HERE from the very folders that were copied into the guest (`albera-host.ps1 -Mode hashes`, its ALBERA_HOST_TREE_HASH= line).
# On the owner's PC that value must be typed from the CI log of the reviewed commit (workflow host-build-hashes); this hook only exercises the code path (copy, hash the copies, compare, record).
# A second pass then repeats install / status / reinstall / uninstall WITH -GrantHyperVToBroker (ADR-002 Amendment 2026-11-03) and checks, independently of the installer's own read-back:
# the Broker's service SID (and nobody else: not albera-cp, not the Authority) is in Hyper-V Administrators (S-1-5-32-578) while installed and gone after uninstall with the group otherwise unchanged,
# the Broker is sidtype UNRESTRICTED and the Authority RESTRICTED, both keep SeChangeNotifyPrivilege only, the Broker config holds the one `computers` entry, the Control Plane settings hold the `desktop` block (helper path + SHA-256, written by install; the default pass must leave it out), and the install record names the grant.
# The VM's GUID comes in through the lab-only -VmId (a fixed throw-away GUID: this guest has no VM of that name, so the name-to-GUID lookup is NOT exercised here and the evidence says so).
# The pass is BLOCKED, not passed, when the guest has no Hyper-V Administrators group or when -KeepInstalled left the default install in place; a FAIL in it fails the whole check.
# Refuses to run unless ALBERA_LAB_VM=1 and the two Albera folders do not exist yet. NOT executed yet (the lab VM run is the lead's): expect first-run fixes.
param(
  [Parameter(Mandatory = $true)][string]$HostScriptDir,
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [switch]$KeepInstalled
)
$ErrorActionPreference = 'Stop'
if ($env:ALBERA_LAB_VM -ne '1') { throw 'refusing to run: this is the lab VM hook. ALBERA_LAB_VM=1 must be set by the lab driver inside the disposable VM; never run it on a real PC.' }
$hostScript = Join-Path $HostScriptDir 'albera-host.ps1'
if (-not (Test-Path -LiteralPath $hostScript)) { throw 'albera-host.ps1 not found in -HostScriptDir' }
$programData = Join-Path $env:ProgramData 'Albera'; $programFiles = Join-Path $env:ProgramFiles 'Albera'
foreach ($p in @($programData, $programFiles)) { if (Test-Path -LiteralPath $p) { throw "$p already exists; the lab hook needs a fresh VM" } }

# A throw-away RSA-2048 PUBLIC key (the one lab-guest.ps1 pins); the approver SID is this Administrator account (S-1-5-21-...-500), which is not the new albera-cp account.
$labApproverKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3XSX1Rx6n1/sVaG+opeyv2Qj/+8woifjIQgxqheuZ1LtyB/JUeDgkP6wIc6YSAQzMKbdwZ88ipVJidmpixqr0P4tcE3Ud6VqerYfHnrVlqGKHojUU0r2kmtKib9f3bT0+ljHa54Dux9jcGSncwXpXcRrOkNFRFrWuS99+yXpFWdgYeawOK9SegknG1J4Rw7fjPZurkVWYYLl17T10PSIg0TGY0eJRgRXVw7PQhsLRh4u3ErDSd4dkE4j1aUR0jCGovRZJrrAMib7P1+GPRUOL6bviCkYY9Q2yOIP+OKWevFw80WXdYktQv/3xeloBWYctgzU6aS7J+7logyEYr0zWwIDAQAB'
$approverSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$approverParams = @{ ApproverKeyId = 'hello-lab-0001'; ApproverPublicKey = $labApproverKey; ApproverSid = $approverSid }

# The two programs the installer pins (lab-only parameters): the node.exe the driver copied beside this hook, and a stand-in for claude.exe (hashed and copied, never started).
$nodeStub = Join-Path $PSScriptRoot 'node.exe'
if (-not (Test-Path -LiteralPath $nodeStub)) { throw "node.exe not found beside the hook ($nodeStub); lab-vm.ps1 -HostInstall copies it" }
$claudeStub = Join-Path $PSScriptRoot 'claude-stub.exe'
[System.IO.File]::WriteAllText($claudeStub, 'lab stand-in for the owner claude.exe; the installer only hashes and copies it')
$labSources = @{ NodeSource = $nodeStub; ClaudeSource = $claudeStub }
$setupRunId = '1000'

# $Params is a hashtable of the host script's parameters (a hashtable splat binds names; an array splat would pass '-Mode' as a value).
function Invoke-Host([hashtable]$Params) {
  $all = @{ RepoRoot = $RepoRoot } + $Params
  $text = (& $hostScript @all *>&1 | Out-String)
  [pscustomobject]@{ Exit = $LASTEXITCODE; Output = $text }
}
. (Join-Path $HostScriptDir 'albera-host-lib.ps1')
function Get-Remnants {
  [ordered]@{
    services = @(@('AlberaHostBroker', 'AlberaApprovalAuthority', 'AlberaControlPlane') | Where-Object { Get-CimInstance Win32_Service -Filter "Name='$_'" })
    user = [bool](Get-LocalUser -Name 'albera-cp' -ErrorAction SilentlyContinue)   # the legacy account: nothing makes it any more, so it must never be there
    startMenu = Test-Path -LiteralPath (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\ALBERA')
    runValue = ($null -ne (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name 'AlberaApprover' -ErrorAction SilentlyContinue))
    key = [bool](Test-AuthoritySigningKeyExists (Get-HostConstants).SigningKeyName)
    programData = Test-Path -LiteralPath $programData
    programFiles = Test-Path -LiteralPath $programFiles
  }
}

$evidence = [ordered]@{ approverSid = $approverSid }
# Lab-only tree hash of the copied publish folders (the installer takes it as a parameter, not a file).
$hashes = Invoke-Host @{ Mode = 'hashes' }
if ($hashes.Exit -ne 0) { throw 'could not compute the lab hashes' }
$treeHash = ([regex]::Match($hashes.Output, '(?m)^ALBERA_HOST_TREE_HASH=([0-9a-f]{64})\s*$')).Groups[1].Value
if (-not $treeHash) { throw 'no tree hash line in the -Mode hashes output' }
$evidence.treeHash = [ordered]@{ computedInGuest = $true; value = $treeHash }
$install = Invoke-Host (@{ Mode = 'install'; ExpectedTreeHash = $treeHash; StartCheck = $true; SetupRunId = $setupRunId } + $labSources + $approverParams)
$evidence.install = [ordered]@{ exit = $install.Exit; output = $install.Output }
$status = Invoke-Host @{ Mode = 'status' }
$evidence.status = [ordered]@{ exit = $status.Exit; output = $status.Output }
# an install WITHOUT the grant leaves the Control Plane settings as they always were: no desktop block
$evidence.defaultSettingsHasNoDesktop = $false
$defaultSettingsFile = Join-Path $programData 'control-plane-config\albera.approval.json'
if (Test-Path -LiteralPath $defaultSettingsFile) { $evidence.defaultSettingsHasNoDesktop = ($null -eq (Get-Content -Raw -LiteralPath $defaultSettingsFile | ConvertFrom-Json).PSObject.Properties['desktop']) }
$manifest = Join-Path $programData 'install-manifest.json'
$hashBefore = if (Test-Path -LiteralPath $manifest) { (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash } else { '' }
$again = Invoke-Host (@{ Mode = 'install'; ExpectedTreeHash = $treeHash; SetupRunId = $setupRunId } + $labSources + $approverParams)
$hashAfter = if (Test-Path -LiteralPath $manifest) { (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash } else { '' }
$evidence.reinstall = [ordered]@{ exit = $again.Exit; manifestUnchanged = ($hashBefore -ne '' -and $hashBefore -eq $hashAfter); saysAlreadyComplete = ($again.Output -match 'already complete') }
# anti-rollback: an OLDER attested run id is refused (exit 3), and the record does not change (and, below, after the uninstall: the floor in the registry still refuses it)
$older = Invoke-Host (@{ Mode = 'install'; ExpectedTreeHash = $treeHash; SetupRunId = '999' } + $labSources + $approverParams)
$hashOlder = if (Test-Path -LiteralPath $manifest) { (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash } else { '' }
$evidence.rollback = [ordered]@{ exit = $older.Exit; refused = ($older.Exit -eq 3 -and $older.Output -match 'setup_run_id_older_than_installed'); manifestUnchanged = ($hashBefore -eq $hashOlder) }
# the Control Plane service and its files, read back here with the tools Windows ships (not through the installer's own read-back)
function New-CpCheck([string]$Id, [bool]$Ok, [string]$Observed) { [ordered]@{ id = $Id; status = $(if ($Ok) { 'PASS' } else { 'FAIL' }); observed = $Observed } }
$cpChecks = New-Object 'System.Collections.Generic.List[object]'
if (Get-CimInstance Win32_Service -Filter "Name='AlberaControlPlane'") {
  $cpSvc = Get-CimInstance Win32_Service -Filter "Name='AlberaControlPlane'"
  $cpSid = (New-Object System.Security.Principal.NTAccount('NT SERVICE\AlberaControlPlane')).Translate([System.Security.Principal.SecurityIdentifier]).Value
  foreach ($n in @('AlberaHostBroker', 'AlberaApprovalAuthority', 'AlberaControlPlane')) {
    $s = Get-CimInstance Win32_Service -Filter "Name='$n'"
    $cpChecks.Add((New-CpCheck ('delayed_auto_' + $n) (($s.StartMode -eq 'Auto') -and ($s.DelayedAutoStart -eq $true)) ("StartMode " + $s.StartMode + ", DelayedAutoStart " + $s.DelayedAutoStart)))
  }
  $cpStartName = $cpSvc.StartName
  $cpChecks.Add((New-CpCheck 'cp_runs_as_its_virtual_account' ($cpStartName -eq 'NT SERVICE\AlberaControlPlane') $cpStartName))
  $cpType = ((& sc.exe qsidtype AlberaControlPlane 2>&1) -join ' ')
  $cpChecks.Add((New-CpCheck 'cp_sidtype_restricted' (($cpType -cmatch '(?<![A-Za-z])RESTRICTED') -and ($cpType -cnotmatch 'UNRESTRICTED')) $cpType))
  $cpPrivs = @([regex]::Matches(((& sc.exe qprivs AlberaControlPlane 2>&1) -join ' '), 'Se[A-Za-z]+Privilege') | ForEach-Object { $_.Value })
  $cpChecks.Add((New-CpCheck 'cp_privileges_minimal' (($cpPrivs -join ',') -eq 'SeChangeNotifyPrivilege') ($cpPrivs -join ',')))
  # the stored failure actions (REG_BINARY FailureActions: reset, two offsets, cActions @12, array offset @16, then {type, delay ms} per action), read here on its own: `sc qfailure` prints localized text
  $failKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Services\AlberaControlPlane')
  $failBytes = $null; if ($failKey) { try { $failBytes = $failKey.GetValue('FailureActions', $null) } finally { $failKey.Dispose() } }
  $restarts = @(); $otherActions = 0
  if ($failBytes -is [byte[]] -and $failBytes.Length -ge 20) {
    $actionCount = [BitConverter]::ToUInt32($failBytes, 12); $actionOffset = [BitConverter]::ToUInt32($failBytes, 16)
    for ($i = 0; $i -lt $actionCount -and ($actionOffset + 8 * ($i + 1)) -le $failBytes.Length; $i++) {
      $actionType = [BitConverter]::ToUInt32($failBytes, [int]($actionOffset + 8 * $i)); $actionDelay = [BitConverter]::ToUInt32($failBytes, [int]($actionOffset + 8 * $i + 4))
      if ($actionType -eq 1) { $restarts += [int]$actionDelay } elseif ($actionType -ne 0) { $otherActions++ }
    }
  }
  $cpChecks.Add((New-CpCheck 'cp_restarts_twice_after_5s' (($restarts.Count -eq 2) -and (@($restarts | Where-Object { $_ -ne 5000 }).Count -eq 0) -and ($otherActions -eq 0)) ($restarts -join ',')))
  $brokerSd = ((& sc.exe sdshow AlberaHostBroker 2>&1) -join '')
  $cpChecks.Add((New-CpCheck 'broker_service_acl_names_the_cp_service_sid_with_lc_only' (($brokerSd -like "*(A;;LC;;;$cpSid)*") -and ($brokerSd -notmatch 'S-1-5-21')) $brokerSd))
  $cfgDir = Join-Path $programData 'control-plane-config'
  $cpRules = @((Get-Acl -LiteralPath $cfgDir).Access | Where-Object { $_.IdentityReference.Value -eq 'NT SERVICE\AlberaControlPlane' })
  $writeBits = [int]([System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership)
  $cpChecks.Add((New-CpCheck 'cp_has_read_only_on_control_plane_config' ($cpRules.Count -ge 1 -and (@($cpRules | Where-Object { ([int]$_.FileSystemRights -band $writeBits) -ne 0 }).Count -eq 0)) (($cpRules | ForEach-Object { [string]$_.FileSystemRights }) -join ';')))
  $cpChecks.Add((New-CpCheck 'no_local_account_albera_cp' (-not (Get-LocalUser -Name 'albera-cp' -ErrorAction SilentlyContinue)) 'Get-LocalUser albera-cp'))
  $recordJson = Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json
  $cpChecks.Add((New-CpCheck 'record_has_pins_and_run_id' (($null -ne $recordJson.created.controlPlane) -and ($null -ne $recordJson.created.claude) -and ($recordJson.setupRunId -eq $setupRunId)) ('setupRunId ' + $recordJson.setupRunId)))
  $nodePinned = Join-Path $programFiles 'bin\control-plane\node\node.exe'
  $cpChecks.Add((New-CpCheck 'node_pin_matches_record' ((Test-Path -LiteralPath $nodePinned) -and ((Get-FileHash -LiteralPath $nodePinned -Algorithm SHA256).Hash.ToLowerInvariant() -eq $recordJson.created.controlPlane.nodeSha256)) 'node.exe in bin\control-plane\node'))
  $serviceCfg = Get-Content -Raw -LiteralPath (Join-Path $cfgDir 'AlberaControlPlane.service.json') | ConvertFrom-Json
  $cpChecks.Add((New-CpCheck 'service_config_blocks' ((@($serviceCfg.PSObject.Properties | ForEach-Object { $_.Name }) -join ',') -ceq 'host,claude,ui') ((@($serviceCfg.PSObject.Properties | ForEach-Object { $_.Name }) -join ','))))
  $startMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\ALBERA'
  $cpChecks.Add((New-CpCheck 'open_albera_shortcut_exists' (Test-Path -LiteralPath (Join-Path $startMenu 'Open ALBERA.lnk')) 'Open ALBERA.lnk'))
  $cpChecks.Add((New-CpCheck 'launcher_exists' (Test-Path -LiteralPath (Join-Path $programFiles 'bin\launcher\open-albera.ps1')) 'bin\launcher\open-albera.ps1'))
  $runValue = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name 'AlberaApprover' -ErrorAction SilentlyContinue).AlberaApprover
  $cpChecks.Add((New-CpCheck 'hklm_run_value_is_the_tray' ($runValue -ceq ('"' + (Join-Path $programFiles 'bin\approver\AlberaApprover.exe') + '" --tray')) ([string]$runValue)))
  $evidence.controlPlaneStartCheckLine = (@($install.Output -split "`r?`n" | Where-Object { $_ -match 'AlberaControlPlane: state' }) -join ' | ')
}
else { $cpChecks.Add((New-CpCheck 'service_exists' $false 'AlberaControlPlane is not registered after install')) }
$evidence.controlPlane = [ordered]@{ checks = $cpChecks.ToArray(); status = $(if (@($cpChecks | Where-Object { $_.status -eq 'FAIL' }).Count -gt 0) { 'FAIL' } else { 'PASS' }) }
$evidence.afterInstall = Get-Remnants
if (-not $KeepInstalled) {
  $un = Invoke-Host @{ Mode = 'uninstall' }
  $evidence.uninstall = [ordered]@{ exit = $un.Exit; output = $un.Output }
  $evidence.remnants = Get-Remnants
  $final = Invoke-Host @{ Mode = 'status' }
  $evidence.finalStatus = [ordered]@{ exit = $final.Exit; saysNotInstalled = ($final.Output -match 'not installed') }
  # the install record is gone, but the floor (HKLM\SOFTWARE\Albera\SetupRunIdFloor) is not: an OLDER, validly attested build is refused after an uninstall too, and nothing is installed by that attempt
  $floorValue = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Albera' -Name 'SetupRunIdFloor' -ErrorAction SilentlyContinue
  $olderAfter = Invoke-Host (@{ Mode = 'install'; ExpectedTreeHash = $treeHash; SetupRunId = '999' } + $labSources + $approverParams)
  $afterOlder = Get-Remnants
  $evidence.rollbackAfterUninstall = [ordered]@{
    floor = $(if ($floorValue) { [string]$floorValue.SetupRunIdFloor } else { $null }); exit = $olderAfter.Exit
    refused = ($olderAfter.Exit -eq 3 -and $olderAfter.Output -match 'setup_run_id_older_than_floor'); nothingInstalled = (-not $afterOlder.programData -and -not $afterOlder.programFiles -and @($afterOlder.services).Count -eq 0)
  }
}
# ---- second pass: the same install WITH -GrantHyperVToBroker
$hvAdminsSid = 'S-1-5-32-578'
$labVmId = '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f'   # fixed and throw-away; the guest has no VM of this name
function Add-GrantCheck($List, [string]$Id, [bool]$Ok, [string]$Observed) { $List.Add([ordered]@{ id = $Id; status = $(if ($Ok) { 'PASS' } else { 'FAIL' }); observed = $Observed }) }
function Get-HvGroupText { $name = (Get-LocalGroup -SID $hvAdminsSid).Name; ((& net.exe localgroup $name 2>&1) | Out-String) }
function Get-ScText([string]$Verb, [string]$Name) { ((& sc.exe $Verb $Name 2>&1) -join ' ') -replace '\s+', ' ' }
function Get-ScPrivileges([string]$Name) { @([regex]::Matches((Get-ScText 'qprivs' $Name), 'Se[A-Za-z]+Privilege') | ForEach-Object { $_.Value }) }
$grant = [ordered]@{
  status = 'BLOCKED'; reason = ''
  guidSource = 'a fixed lab GUID through the lab-only -VmId; the lookup of a real VM by name is NOT exercised here'
  hyperVWmiNamespaceInGuest = $false; checks = @()
}
$hvNamespace = $false
try { Get-CimInstance -Namespace 'root\virtualization\v2' -ClassName Msvm_VirtualSystemManagementService -ErrorAction Stop | Out-Null; $hvNamespace = $true } catch { }
$grant.hyperVWmiNamespaceInGuest = $hvNamespace
$leftBehind = Get-Remnants
if ($KeepInstalled) { $grant.reason = 'skipped: -KeepInstalled leaves the default install in place' }
elseif (-not (Get-LocalGroup -SID $hvAdminsSid -ErrorAction SilentlyContinue)) { $grant.reason = 'this guest has no local group S-1-5-32-578 (Hyper-V Administrators); the grant path was not run' }
elseif ($leftBehind.user -or $leftBehind.startMenu -or $leftBehind.runValue -or $leftBehind.key -or $leftBehind.programData -or $leftBehind.programFiles -or @($leftBehind.services).Count -gt 0) { $grant.reason = 'the default pass left an install behind; the grant pass needs a clean guest' }
else {
  $checks = New-Object 'System.Collections.Generic.List[object]'
  $groupBefore = Get-HvGroupText
  $ranInstall = $false
  try {
    $gInstall = Invoke-Host (@{ Mode = 'install'; ExpectedTreeHash = $treeHash; StartCheck = $hvNamespace; GrantHyperVToBroker = $true; VmId = $labVmId } + $labSources + $approverParams)
    $ranInstall = $true
    Add-GrantCheck $checks 'grant_install_exit_0' ($gInstall.Exit -eq 0) ("exit " + $gInstall.Exit)
    $grant.install = [ordered]@{ exit = $gInstall.Exit; output = $gInstall.Output; startCheckRun = $hvNamespace }
    $brokerSid = (New-Object System.Security.Principal.NTAccount('NT SERVICE\AlberaHostBroker')).Translate([System.Security.Principal.SecurityIdentifier]).Value
    $groupDuring = Get-HvGroupText
    Add-GrantCheck $checks 'broker_is_member' ($groupDuring -match 'NT SERVICE\\AlberaHostBroker') 'net localgroup lists NT SERVICE\AlberaHostBroker'
    Add-GrantCheck $checks 'control_plane_not_member' (($groupDuring -notmatch 'albera-cp') -and ($groupDuring -notmatch 'AlberaControlPlane')) 'neither albera-cp nor AlberaControlPlane is in the group'
    Add-GrantCheck $checks 'authority_not_member' ($groupDuring -notmatch 'AlberaApprovalAuthority') 'AlberaApprovalAuthority is not in the group'
    $brokerType = Get-ScText 'qsidtype' 'AlberaHostBroker'; $authorityType = Get-ScText 'qsidtype' 'AlberaApprovalAuthority'
    Add-GrantCheck $checks 'broker_sidtype_unrestricted' ($brokerType -cmatch '(?<![A-Za-z])UNRESTRICTED') $brokerType
    Add-GrantCheck $checks 'authority_sidtype_restricted' (($authorityType -cmatch '(?<![A-Za-z])RESTRICTED') -and ($authorityType -cnotmatch 'UNRESTRICTED')) $authorityType
    $brokerPrivs = Get-ScPrivileges 'AlberaHostBroker'; $authorityPrivs = Get-ScPrivileges 'AlberaApprovalAuthority'
    Add-GrantCheck $checks 'privileges_minimal' (($brokerPrivs -join ',') -eq 'SeChangeNotifyPrivilege' -and ($authorityPrivs -join ',') -eq 'SeChangeNotifyPrivilege') ("broker: " + ($brokerPrivs -join ',') + "; authority: " + ($authorityPrivs -join ','))
    $brokerConfig = Get-Content -Raw -LiteralPath (Join-Path $programData 'broker-config\AlberaHostBroker.service.json') | ConvertFrom-Json
    $authorityConfig = Get-Content -Raw -LiteralPath (Join-Path $programData 'authority\AlberaApprovalAuthority.service.json') | ConvertFrom-Json
    $computers = @($brokerConfig.computers)
    Add-GrantCheck $checks 'broker_config_computers' ($computers.Count -eq 1 -and $computers[0].computerId -ceq 'clone-01' -and $computers[0].vmId -ceq $labVmId) ((ConvertTo-Json -InputObject $brokerConfig.computers -Compress))
    Add-GrantCheck $checks 'authority_config_has_no_computers' ($null -eq $authorityConfig.PSObject.Properties['computers']) 'the Authority config is unchanged'
    $record = (Get-Content -Raw -LiteralPath (Join-Path $programData 'install-manifest.json') | ConvertFrom-Json).created.hyperVGrant
    Add-GrantCheck $checks 'install_record_names_the_grant' ($null -ne $record -and $record.group -ceq $hvAdminsSid -and $record.sid -ceq $brokerSid -and $record.vmId -ceq $labVmId) ((ConvertTo-Json -InputObject $record -Compress))
    # the Control Plane settings: the desktop block the gated room requires, written by install (no hand edit), with the helper path and the SHA-256 of the exe as it sits in Program Files (hashed here with Get-FileHash, not by the installer)
    $cpSettings = Get-Content -Raw -LiteralPath (Join-Path $programData 'control-plane-config\albera.approval.json') | ConvertFrom-Json
    $helperExe = Join-Path $programFiles 'bin\pipe-client\albera-windows-broker-pipe-client.exe'
    $helperHash = (Get-FileHash -LiteralPath $helperExe -Algorithm SHA256).Hash.ToLowerInvariant()
    $cpKeys = @($cpSettings.PSObject.Properties | ForEach-Object { $_.Name }) -join ','
    $desktopKeys = if ($null -ne $cpSettings.PSObject.Properties['desktop']) { @($cpSettings.desktop.PSObject.Properties | ForEach-Object { $_.Name }) -join ',' } else { '' }
    Add-GrantCheck $checks 'control_plane_settings_desktop_block' (($cpKeys -ceq 'version,projectId,broker,authority,journal,computers,desktop') -and ($desktopKeys -ceq 'helperPath,helperSha256') -and ($cpSettings.desktop.helperPath -ceq $helperExe) -and ($cpSettings.desktop.helperSha256 -ceq $helperHash) -and ($null -eq $cpSettings.PSObject.Properties['attestation']) -and ($cpSettings.computers.'albera-clone-01' -ceq 'clone-01')) ("keys " + $cpKeys + "; desktop " + (ConvertTo-Json -InputObject $cpSettings.desktop -Compress))
    $gStatus = Invoke-Host @{ Mode = 'status' }
    Add-GrantCheck $checks 'status_ok_and_names_the_group' ($gStatus.Exit -eq 0 -and $gStatus.Output -match 'Hyper-V Administrators: the Broker service SID is a member') ("exit " + $gStatus.Exit)
    $grant.status_output = $gStatus.Output
    $hashBeforeGrant = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash
    $gAgain = Invoke-Host (@{ Mode = 'install'; ExpectedTreeHash = $treeHash; GrantHyperVToBroker = $true; VmId = $labVmId } + $labSources + $approverParams)
    Add-GrantCheck $checks 'reinstall_changes_nothing' ($gAgain.Exit -eq 0 -and $gAgain.Output -match 'already complete' -and (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash -eq $hashBeforeGrant -and (Get-HvGroupText) -eq $groupDuring) ("exit " + $gAgain.Exit)
  }
  catch { Add-GrantCheck $checks 'grant_pass_no_exception' $false ($_.Exception.Message) }
  if ($ranInstall -or (Test-Path -LiteralPath $programData)) {
    $gUninstall = Invoke-Host @{ Mode = 'uninstall' }
    $grant.uninstall = [ordered]@{ exit = $gUninstall.Exit; output = $gUninstall.Output }
    Add-GrantCheck $checks 'uninstall_exit_0' ($gUninstall.Exit -eq 0) ("exit " + $gUninstall.Exit)
    $groupAfter = Get-HvGroupText
    Add-GrantCheck $checks 'broker_removed_from_group' ($groupAfter -notmatch 'AlberaHostBroker') 'the Broker SID is out of the group again'
    Add-GrantCheck $checks 'group_otherwise_unchanged' ($groupAfter -eq $groupBefore) 'groupBefore equals groupAfter'
    $gRemnants = Get-Remnants
    Add-GrantCheck $checks 'nothing_left_behind' (-not $gRemnants.user -and -not $gRemnants.startMenu -and -not $gRemnants.runValue -and -not $gRemnants.key -and -not $gRemnants.programData -and -not $gRemnants.programFiles -and @($gRemnants.services).Count -eq 0) ((ConvertTo-Json -InputObject $gRemnants -Compress))
    $gFinal = Invoke-Host @{ Mode = 'status' }
    Add-GrantCheck $checks 'final_status_not_installed' ($gFinal.Output -match 'not installed') ("exit " + $gFinal.Exit)
  }
  $grant.checks = $checks.ToArray()
  $grant.status = if (@($checks | Where-Object { $_.status -eq 'FAIL' }).Count -gt 0) { 'FAIL' } else { 'PASS' }
}
$evidence.grant = $grant
$evidence.pass = ($evidence.grant.status -ne 'FAIL') -and ($evidence.controlPlane.status -eq 'PASS') -and $evidence.rollback.refused -and $evidence.rollback.manifestUnchanged -and ($KeepInstalled -or ($evidence.rollbackAfterUninstall.refused -and $evidence.rollbackAfterUninstall.nothingInstalled -and ($evidence.rollbackAfterUninstall.floor -eq $setupRunId))) -and $evidence.defaultSettingsHasNoDesktop -and ($install.Exit -eq 0) -and ($status.Exit -eq 0) -and ($again.Exit -eq 0) -and $evidence.reinstall.manifestUnchanged -and $evidence.reinstall.saysAlreadyComplete -and
  ($KeepInstalled -or (($evidence.uninstall.exit -eq 0) -and -not $evidence.remnants.user -and -not $evidence.remnants.startMenu -and -not $evidence.remnants.runValue -and -not $evidence.remnants.key -and -not $evidence.remnants.programData -and -not $evidence.remnants.programFiles -and @($evidence.remnants.services).Count -eq 0 -and $evidence.finalStatus.saysNotInstalled))
$evidence | ConvertTo-Json -Depth 6
if (-not $evidence.pass) { exit 1 }
