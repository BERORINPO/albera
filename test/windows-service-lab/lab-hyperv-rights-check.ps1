# Hyper-V rights lab (ADR-002 host Broker, PR2), GUEST side. Runs INSIDE the disposable lab VM as Administrator (Windows PowerShell 5.1), started by
# lab-vm.ps1 -HyperV over PowerShell Direct. ASCII only. Not executed in a VM yet (written 2026-11-03).
#   lab-hyperv-rights-check.ps1 <LabRoot> install-feature   install the Hyper-V role (the host restarts the guest afterwards)
#   lab-hyperv-rights-check.ps1 <LabRoot> run               create an inner VM, run the probe as four service identities, print the results as ONE JSON line
#   lab-hyperv-rights-check.ps1 <LabRoot> cleanup           delete the lab services, group memberships and the inner VM (the host calls it only with -KeepVm)
#
# The question: can a service that looks like the Host Broker (virtual account, SeChangeNotifyPrivilege only) call the Hyper-V WMI methods for a screen
# capture and for keyboard / mouse input? The probe (albera-lab-service-shim.exe hyperv <vmGuid>, HyperVProbe.cs) does that with COM late binding, the way
# the C# Broker will. Four service identities, because the unknown is whether a RESTRICTED service SID still works:
#     r_member     sidtype restricted,    member of Hyper-V Administrators (S-1-5-32-578)
#     r_nonmember  sidtype restricted,    not a member
#     u_member     sidtype unrestricted,  member
#     u_nonmember  sidtype unrestricted,  not a member
# Verdicts (see Get-HvVerdict): non-members must be refused (PASS); unrestricted members must succeed (PASS); a restricted member is only MEASURED,
# because that is the open question and either answer is a result. A check that could not be measured is BLOCKED, never a quiet PASS.
param(
  [Parameter(Mandatory = $true)][string]$LabRoot,
  [Parameter(Mandatory = $true)][ValidateSet('install-feature', 'run', 'cleanup')][string]$Phase
)
$ErrorActionPreference = 'Stop'

# First statement on purpose: this script creates services and edits a local group. Never on a real machine.
if ($env:ALBERA_LAB_VM -ne '1' -or (Get-CimInstance Win32_ComputerSystem).Model -ne 'Virtual Machine') {
  throw 'refusing to run: this script changes services and local groups, and runs only inside the disposable lab VM (ALBERA_LAB_VM=1 in a Hyper-V guest)'
}

$HvAdminsSid = 'S-1-5-32-578'
$InnerVmName = 'AlberaLabInner'
$Shim = "$LabRoot\bin\shim\albera-lab-service-shim.exe"
$Cells = @(
  @{ Code = 'r_member';    Svc = 'AlberaLabHvRM'; SidType = 'restricted';   Member = $true },
  @{ Code = 'r_nonmember'; Svc = 'AlberaLabHvRN'; SidType = 'restricted';   Member = $false },
  @{ Code = 'u_member';    Svc = 'AlberaLabHvUM'; SidType = 'unrestricted'; Member = $true },
  @{ Code = 'u_nonmember'; Svc = 'AlberaLabHvUN'; SidType = 'unrestricted'; Member = $false }
)
# gate = a step on the way (connect, lookup); sensitive = what the Broker will call; reference = read-only, the Broker never calls it.
$Ops = @(
  @{ Id = 'wmi_connect';               Kind = 'gate';      Title = 'WMI connect to root\virtualization\v2' },
  @{ Id = 'vm_lookup';                 Kind = 'gate';      Title = 'Get Msvm_ComputerSystem by Name (VM GUID)' },
  @{ Id = 'mgmt_read';                 Kind = 'reference'; Title = 'Read Msvm_VirtualSystemManagementService (read only, not a Broker call)' },
  @{ Id = 'thumbnail';                 Kind = 'sensitive'; Title = 'GetVirtualSystemThumbnailImage 640x480' },
  @{ Id = 'keyboard_typekey';          Kind = 'sensitive'; Title = 'Msvm_Keyboard.TypeKey once' },
  @{ Id = 'mouse_setabsoluteposition'; Kind = 'sensitive'; Title = 'Msvm_SyntheticMouse.SetAbsolutePosition once' }
)

# ------------------------------------------------------------------ pure logic (the unit test loads these functions by themselves, no VM involved)

# Non-ASCII text from WMI error messages must not reach the evidence file (it is written as ASCII), and machine SIDs stay out of it.
function Get-AsciiText([string]$Text) {
  $t = $Text -replace 'S-1-5-21(-[0-9]+)+', 'S-1-5-21-<redacted>'
  $t -replace '[^\x20-\x7E]', '?'
}

# One probe line -> what happened: allowed | denied | not_visible | error | missing.
# A skipped line takes the outcome of the check it waited for (a refused connect refuses everything after it).
function Get-HvOutcome($Line, $ById) {
  if ($null -eq $Line) { return 'missing' }
  if ($Line.skipped) {
    $cause = $ById[[string]$Line.because]
    if ($null -eq $cause -or $cause.skipped) { return 'missing' }
    return (Get-HvOutcome $cause $ById)
  }
  if ($Line.ok -eq $true) { return 'allowed' }
  $hr = [string]$Line.hresult
  if ($hr -in @('0x80041003', '0x80070005', '0x80010005')) { return 'denied' }       # WBEM_E_ACCESS_DENIED, E_ACCESSDENIED, RPC_E_ACCESS_DENIED
  if ($null -ne $Line.returnValue -and [int64]$Line.returnValue -eq 32769) { return 'denied' }   # Hyper-V method ReturnValue 32769 = Access Denied
  if ($hr -eq '0x80041002') { return 'not_visible' }                                  # WBEM_E_NOT_FOUND: the object is hidden from this caller
  return 'error'
}

# Outcome -> verdict. Only an observation that does not answer the question (error, no output) is BLOCKED; the open question (restricted member) is MEASURED.
function Get-HvVerdict([bool]$Member, [string]$SidType, [string]$Kind, [string]$Outcome) {
  if ($Outcome -eq 'missing') { return 'BLOCKED' }
  if ($Kind -eq 'reference') { return 'MEASURED' }
  if ($SidType -eq 'restricted' -and $Member) { return 'MEASURED' }
  if (-not $Member) {
    if ($Kind -eq 'gate') { return 'MEASURED' }
    if ($Outcome -in @('denied', 'not_visible')) { return 'PASS' }
    if ($Outcome -eq 'allowed') { return 'FAIL' }
    return 'BLOCKED'
  }
  if ($Outcome -eq 'allowed') { return 'PASS' }
  if ($Outcome -in @('denied', 'not_visible')) { return 'FAIL' }
  return 'BLOCKED'
}

# Is the live service token the shape this cell claims? If not, the cell's results mean nothing. $Token is TokenReport JSON (the shim writes it).
function Test-HvTokenShape($Token, [string]$ExpectedSid, [bool]$Member, [string]$SidType) {
  $hvAdmins = 'S-1-5-32-578'
  $evidence = @(); $ok = $true
  if ($null -eq $Token) { return @{ Ok = $false; Evidence = @('no token report was written') } }
  $user = [string]$Token.user.sid
  if ($user -ne $ExpectedSid) { $ok = $false }
  $evidence += "token user $(Get-AsciiText $user) (service SID $(Get-AsciiText $ExpectedSid))"
  $group = @($Token.groups | Where-Object { $_.sid -eq $hvAdmins }) | Select-Object -First 1
  $effective = ($null -ne $group) -and (@($group.attributes) -contains 'enabled') -and (@($group.attributes) -notcontains 'deny_only')
  if ($effective -ne $Member) { $ok = $false }
  $evidence += "$hvAdmins in token: $(if ($null -eq $group) { 'absent' } else { (@($group.attributes) -join '+') }) (expected $(if ($Member) { 'enabled' } else { 'absent' }))"
  $restricting = @($Token.restrictedSids | Where-Object { $_ }).Count
  if (($restricting -gt 0) -ne ($SidType -eq 'restricted')) { $ok = $false }
  $evidence += "restricting SIDs: $restricting, hasRestrictions=$($Token.hasRestrictions) (expected $SidType)"
  $privileges = @($Token.privileges | ForEach-Object { $_.name })
  if ($privileges.Count -ne 1 -or $privileges[0] -ne 'SeChangeNotifyPrivilege') { $ok = $false }
  $evidence += "privileges: $($privileges -join ', ')"
  @{ Ok = $ok; Evidence = $evidence }
}

# ------------------------------------------------------------------ guest helpers
function Emit-Json($Value) { Write-Output (ConvertTo-Json -InputObject $Value -Compress -Depth 8) }
function Get-Svc([string]$Name) { Get-CimInstance Win32_Service -Filter "Name='$Name'" }
function Get-Sid([string]$Account) { (New-Object System.Security.Principal.NTAccount($Account)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
function Wait-Until([scriptblock]$Condition, [int]$Seconds, [string]$What) {
  $end = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $end) { if (& $Condition) { return }; Start-Sleep -Milliseconds 500 }
  throw "timeout waiting for $What"
}
function Get-HvAdminsGroupName { (Get-LocalGroup -SID $HvAdminsSid).Name }
function Stop-LabService([string]$Name) {
  $svc = Get-Svc $Name
  if ($svc -and $svc.State -ne 'Stopped') {
    & sc.exe stop $Name | Out-Null
    Wait-Until { (Get-Svc $Name).State -eq 'Stopped' } 30 "$Name stopped"
  }
}
# Removes everything one cell created: membership first (the name stops resolving once the service is gone), then the service. Never throws.
function Remove-HvCell($Cell) {
  $svc = $Cell.Svc
  try { & net.exe localgroup (Get-HvAdminsGroupName) "NT SERVICE\$svc" /delete 2>$null | Out-Null } catch { }
  try { if (Get-Svc $svc) { Stop-LabService $svc; & sc.exe delete $svc | Out-Null } } catch { }
}
function Remove-InnerVm {
  try {
    if (Get-VM -Name $InnerVmName -ErrorAction SilentlyContinue) {
      Stop-VM -Name $InnerVmName -TurnOff -Force -ErrorAction SilentlyContinue
      Remove-VM -Name $InnerVmName -Force
    }
  } catch { }
}

if ($Phase -eq 'install-feature') {
  $feature = Get-WindowsFeature -Name Hyper-V
  if ($feature.Installed) { Emit-Json @{ alreadyInstalled = $true; success = $true; restartNeeded = $false }; return }
  $r = Install-WindowsFeature -Name Hyper-V -IncludeManagementTools
  Emit-Json @{ alreadyInstalled = $false; success = [bool]$r.Success; restartNeeded = ([string]$r.RestartNeeded -ne 'No'); exitCode = [string]$r.ExitCode }
  return
}

if ($Phase -eq 'cleanup') {
  foreach ($c in $Cells) { Remove-HvCell $c }
  Remove-InnerVm
  Emit-Json @{ cleaned = $true; servicesLeft = @($Cells | Where-Object { Get-Svc $_.Svc } | ForEach-Object { $_.Svc }) }
  return
}

# ------------------------------------------------------------------ run phase
$checks = New-Object System.Collections.ArrayList
$cellReports = New-Object System.Collections.ArrayList
$matrix = [ordered]@{}
foreach ($op in $Ops) { $matrix[$op.Id] = [ordered]@{ op = $op.Id } }

function Add-Check([string]$Id, [string]$Title, [string]$Status, [string]$Observed, [string[]]$Evidence) {
  [void]$checks.Add([ordered]@{ id = $Id; title = $Title; status = $Status; observed = $Observed; evidence = @($Evidence | ForEach-Object { Get-AsciiText $_ }) })
  Write-Host ("  {0,-8} {1}  {2}" -f $Status, $Id, $Observed)
}
function Read-ResultLines([string]$Path) { if (Test-Path -LiteralPath $Path) { @(Get-Content -LiteralPath $Path) } else { @() } }
function Grant-Path([string]$Path, [string]$Sid, [string]$Rights) {
  & icacls.exe $Path /grant "*${Sid}:(OI)(CI)$Rights" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed for $Path" }
}
function New-LockedDir([string]$Path) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed for $Path" }
}
function Compact-Line($Line) {
  if ($null -eq $Line) { return 'no line' }
  $parts = @()
  foreach ($name in @('ok', 'skipped', 'because', 'exception', 'hresult', 'returnValue', 'bytes', 'enabledState', 'enumeration', 'message')) {
    if ($null -ne $Line.$name) { $parts += "$name=$($Line.$name)" }
  }
  $parts -join ' '
}

# One identity: create the service, run the probe through it, judge, remove it again.
function Invoke-HvCell($Cell, [string]$VmId) {
  $svc = $Cell.Svc; $code = $Cell.Code
  $report = [ordered]@{ code = $code; service = $svc; sidtype = $Cell.SidType; member = $Cell.Member }
  $resultFile = "$LabRoot\results\$svc\probe.txt"; $tokenFile = "$LabRoot\results\$svc\probe.token.json"
  try {
    & sc.exe create $svc binPath= "$Shim service $LabRoot\config\$svc.json" obj= "NT SERVICE\$svc" start= demand type= own | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc create $svc failed ($LASTEXITCODE)" }
    & sc.exe sidtype $svc $Cell.SidType | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc sidtype $svc failed ($LASTEXITCODE)" }
    & sc.exe privs $svc SeChangeNotifyPrivilege | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc privs $svc failed ($LASTEXITCODE)" }
    $sid = Get-Sid "NT SERVICE\$svc"
    if ($Cell.Member) {
      & net.exe localgroup (Get-HvAdminsGroupName) "NT SERVICE\$svc" /add 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "adding $svc to Hyper-V Administrators failed ($LASTEXITCODE)" }
    }
    Grant-Path "$LabRoot\bin" $sid 'RX'
    Grant-Path "$LabRoot\config" $sid 'RX'
    New-LockedDir "$LabRoot\results\$svc"
    Grant-Path "$LabRoot\results\$svc" $sid 'M'
    & icacls.exe $LabRoot /grant "*${sid}:RX" | Out-Null
    $config = @{ mode = 'child'; program = $Shim; args = @('hyperv', $VmId); resultFile = $resultFile; tokenFile = $tokenFile; timeoutSeconds = 100 }
    (ConvertTo-Json -InputObject $config -Depth 4) | Set-Content -Encoding Ascii -Path "$LabRoot\config\$svc.json"
    & sc.exe start $svc | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc start $svc failed ($LASTEXITCODE)" }
    Wait-Until { (Get-Svc $svc).State -eq 'Stopped' } 150 "$svc finished"
    $exit = Get-Svc $svc
    $report.serviceExit = "win32=$($exit.ExitCode) specific=$($exit.ServiceSpecificExitCode)"
  }
  catch { $report.setupError = Get-AsciiText $_.Exception.Message }
  finally { Remove-HvCell $Cell }

  $lines = @(Read-ResultLines $resultFile)
  $byId = @{}
  foreach ($text in ($lines | Where-Object { $_ -like '{*' })) {
    try { $obj = $text | ConvertFrom-Json } catch { continue }
    if ($obj.probe -eq 'hyperv' -and $obj.id) { $byId[[string]$obj.id] = $obj }
  }
  $stderr = @($lines | Where-Object { $_ -like '[[]stderr]*' } | Select-Object -First 3 | ForEach-Object { Get-AsciiText $_ })
  $token = $null
  if (Test-Path -LiteralPath $tokenFile) { try { $token = Get-Content -Raw -LiteralPath $tokenFile | ConvertFrom-Json } catch { } }
  $shape = Test-HvTokenShape $token $sid $Cell.Member $Cell.SidType
  $report.tokenOk = $shape.Ok
  $report.probeLines = @($byId.Values | ForEach-Object { Compact-Line $_ })
  if ($stderr.Count -gt 0) { $report.stderr = $stderr }
  $shapeNote = "$($Cell.SidType), $(if ($Cell.Member) { 'member of' } else { 'not in' }) Hyper-V Administrators"
  Add-Check "hv_${code}_token" "Service token has the shape of this cell ($shapeNote)" $(if ($shape.Ok) { 'PASS' } else { 'BLOCKED' }) $(if ($shape.Ok) { 'as_intended' } else { 'shape_mismatch' }) $shape.Evidence

  foreach ($op in $Ops) {
    $line = $byId[$op.Id]
    $outcome = Get-HvOutcome $line $byId
    $verdict = Get-HvVerdict $Cell.Member $Cell.SidType $op.Kind $outcome
    $note = @("$($op.Id): $(Compact-Line $line)")
    if ($report.setupError) { $note += "setup error: $($report.setupError)" }
    if ($line -and $line.skipped) { $note += "not attempted: $($line.because) came first" }
    if (-not $shape.Ok) { $verdict = 'BLOCKED'; $note += "token shape is not the cell's (hv_${code}_token), so this result is not used" }
    if ($verdict -eq 'BLOCKED' -and $stderr.Count -gt 0) { $note += $stderr }
    $matrix[$op.Id][$code] = $(if ($shape.Ok) { $outcome } else { 'blocked' })
    Add-Check "hv_${code}_$($op.Id)" "$shapeNote : $($op.Title)" $verdict $outcome $note
  }
  [void]$cellReports.Add($report)
}

$innerId = $null
$innerState = $null
try {
  # ---- preconditions: the role works, and an inner VM that is running
  $feature = Get-WindowsFeature -Name Hyper-V
  $hypervisor = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent
  $vmmsOk = $true
  try { Wait-Until { (Get-Service vmms -ErrorAction SilentlyContinue).Status -eq 'Running' } 180 'vmms running' } catch { $vmmsOk = $false }
  $moduleOk = [bool](Get-Command New-VM -ErrorAction SilentlyContinue)
  $roleOk = $feature.Installed -and $hypervisor -and $vmmsOk -and $moduleOk
  Add-Check 'hv_prereq_role' 'Hyper-V role works in the lab guest (installed, hypervisor present, vmms running, Hyper-V module)' $(if ($roleOk) { 'PASS' } else { 'BLOCKED' }) $(if ($roleOk) { 'ready' } else { 'not_ready' }) @(
    "installed=$($feature.Installed) hypervisorPresent=$hypervisor vmms=$vmmsOk module=$moduleOk")

  if ($roleOk) {
    # Gen2, 512 MB fixed, no disk, no network: it stops at the UEFI screen and stays Running, which is all a capture and an input need.
    Remove-InnerVm
    $null = New-VM -Name $InnerVmName -Generation 2 -MemoryStartupBytes 512MB -NoVHD -Path "$LabRoot\innervm"
    Set-VM -Name $InnerVmName -CheckpointType Disabled -Notes 'ALBERA lab inner VM (disposable)'
    Set-VMMemory -VMName $InnerVmName -DynamicMemoryEnabled $false
    Get-VMNetworkAdapter -VMName $InnerVmName | Remove-VMNetworkAdapter
    Start-VM -Name $InnerVmName
    Wait-Until { (Get-VM -Name $InnerVmName).State -eq 'Running' } 90 'inner VM running'
    Start-Sleep -Seconds 20   # let the firmware draw its first screen
    $inner = Get-VM -Name $InnerVmName
    $innerId = [string]$inner.Id; $innerState = [string]$inner.State
    Add-Check 'hv_prereq_inner_vm' 'Inner VM (Gen2, 512 MB fixed, no disk, no network) is Running' $(if ($innerState -eq 'Running') { 'PASS' } else { 'BLOCKED' }) $innerState @(
      "state=$innerState memoryStartupMB=$([int]($inner.MemoryStartup / 1MB)) generation=$($inner.Generation)")

    if ($innerState -eq 'Running') {
      New-LockedDir "$LabRoot\config"
      New-LockedDir "$LabRoot\results"
      foreach ($c in $Cells) { if (Get-Svc $c.Svc) { throw "service $($c.Svc) already exists; refusing to touch it" } }
      foreach ($c in $Cells) { Invoke-HvCell $c $innerId }
    }
  }
}
catch {
  Add-Check 'hv_script_error' 'The lab script itself failed' 'BLOCKED' 'exception' @($_.Exception.Message)
}
finally {
  Remove-InnerVm
  foreach ($c in $Cells) { Remove-HvCell $c }
}

$os = Get-CimInstance Win32_OperatingSystem
$ubr = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').UBR
$summary = [ordered]@{}
foreach ($s in @('PASS', 'FAIL', 'BLOCKED', 'MEASURED')) { $summary[$s] = @($checks | Where-Object { $_.status -eq $s }).Count }
$results = [ordered]@{
  lab = 'hyperv-rights'
  generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  guest = [ordered]@{ caption = $os.Caption; build = "$($os.BuildNumber).$ubr" }
  innerVm = [ordered]@{ generation = 2; memoryMB = 512; state = $innerState }
  summary = $summary
  matrix = @($matrix.Values | ForEach-Object { [pscustomobject]$_ })
  cells = $cellReports.ToArray()
  checks = $checks.ToArray()
}
New-Item -ItemType Directory -Force -Path "$LabRoot\evidence" | Out-Null
ConvertTo-Json -InputObject $results -Depth 8 | Set-Content -Encoding Ascii -Path "$LabRoot\evidence\hyperv-results.json"
Write-Output (ConvertTo-Json -InputObject $results -Depth 8 -Compress)
