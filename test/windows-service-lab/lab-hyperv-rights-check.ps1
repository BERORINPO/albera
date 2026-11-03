# Hyper-V rights lab (ADR-002 host Broker, PR2), GUEST side. Runs INSIDE the disposable lab VM as Administrator (Windows PowerShell 5.1), started by
# lab-vm.ps1 -HyperV over PowerShell Direct. ASCII only. Not executed in a VM yet (written 2026-11-03).
#   lab-hyperv-rights-check.ps1 <LabRoot> install-feature   install the Hyper-V role (the host restarts the guest afterwards)
#   lab-hyperv-rights-check.ps1 <LabRoot> run               create an inner VM, run the probe as four service identities, then run the real Broker as a service and use its desktop pipe
#                                                           (checks bd_*, see Invoke-BrokerDesktopLab); print the results as ONE JSON line
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
# Two of the operations (adapter_capture, adapter_input) run the Broker's real adapter instead of raw WMI calls; they are judged the same way.
# Then (checks bd_*, Broker PR #164 "desktop pipe"): the REAL Broker (albera-windows-broker.exe service <config>) is installed as AlberaHostBroker in the shape the owner decided
# (sidtype unrestricted, member of Hyper-V Administrators, SeChangeNotifyPrivilege only, `computers` = the inner VM), and the lab uses its desktop pipe: the Control Plane
# (restricted, no group) opens a view session and captures a PNG of the inner VM; another caller (member, not the Control Plane) and an `act` open are refused.
# Expected values are in the README; a check that could not be measured is BLOCKED.
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
# The Broker desktop section (after the four identities above): the REAL Broker as a service of the shape ADR-002 Amendment 2026-11-03 decides, and clients of its desktop pipe.
#   AlberaHostBroker  sidtype unrestricted, member of Hyper-V Administrators, SeChangeNotifyPrivilege only; its config names the inner VM. The name is fixed: the Broker derives
#                     the per-service SID it trusts (config / journal folder owner) from it (ServicePathGuard.ServiceName), so another name would be refused with exit 73.
#   AlberaLabHvCP     the Control Plane: sidtype restricted, no group, SeChangeNotifyPrivilege only. The Broker's config names its SID; the Broker service lets it query the service status.
#   AlberaLabHvOther  "somebody else": same shape as the Broker (unrestricted, member of Hyper-V Administrators), but not the Control Plane.
$BdBrokerSvc = 'AlberaHostBroker'
$BdCpSvc = 'AlberaLabHvCP'
$BdOtherSvc = 'AlberaLabHvOther'
$BdCells = @(@{ Svc = $BdBrokerSvc }, @{ Svc = $BdCpSvc }, @{ Svc = $BdOtherSvc })
$BdPipe = 'ALBERA_HvLab_HostBroker'
$BdDesktopPipe = "${BdPipe}_desktop"   # the Broker's rule (ServiceConfig.DesktopPipeName): the claim pipe's name + "_desktop"
$BdComputerId = 'lab-room'
$BdTitles = [ordered]@{
  bd_prereq_broker  = 'The Broker build was copied into the guest'
  bd_broker_ready   = 'Broker service (unrestricted, member of Hyper-V Administrators, SeChangeNotifyPrivilege only, config names the inner VM) starts and reports RUNNING'
  bd_broker_token   = 'Broker token: unrestricted (no restricting SIDs), Hyper-V Administrators enabled, exactly SeChangeNotifyPrivilege'
  bd_cp_token       = 'Control Plane token: restricted, not in Hyper-V Administrators, exactly SeChangeNotifyPrivilege'
  bd_other_token    = 'Other caller token: unrestricted, member of Hyper-V Administrators, exactly SeChangeNotifyPrivilege (so a refusal is not for want of the group)'
  bd_desktop_pipe   = 'Desktop pipe exists: owner = Broker SID, DACL = Broker + one Control Plane ACE 0x00120083, served from the Broker process in session 0'
  bd_cp_view_open   = 'Control Plane: a view session on the inner VM is accepted'
  bd_cp_view_capture = 'Control Plane: a capture over that session returns a valid PNG (signature, IHDR of the asked size, IEND) of the inner VM screen'
  bd_other_refused  = 'A caller that is not the Control Plane (member of Hyper-V Administrators) gets no session: refused by the pipe DACL or by the peer check'
  bd_cp_act_refused = 'Control Plane: an act open is refused with the fixed denied reply (the lease is a later change)'
}
$Ops = @(
  @{ Id = 'wmi_connect';               Kind = 'gate';      Title = 'WMI connect to root\virtualization\v2' },
  @{ Id = 'vm_lookup';                 Kind = 'gate';      Title = 'Get Msvm_ComputerSystem by Name (VM GUID)' },
  @{ Id = 'mgmt_read';                 Kind = 'reference'; Title = 'Read Msvm_VirtualSystemManagementService (read only, not a Broker call)' },
  @{ Id = 'thumbnail';                 Kind = 'sensitive'; Title = 'GetVirtualSystemThumbnailImage 640x480' },
  @{ Id = 'keyboard_typekey';          Kind = 'sensitive'; Title = 'Msvm_Keyboard.TypeKey once' },
  @{ Id = 'mouse_setabsoluteposition'; Kind = 'sensitive'; Title = 'Msvm_SyntheticMouse.SetAbsolutePosition once' },
  @{ Id = 'adapter_capture';           Kind = 'sensitive'; Title = 'Broker adapter (HyperVDesktop + ComWmiConnection) Capture 640x480: a PNG with a valid signature and IHDR' },
  @{ Id = 'adapter_input';             Kind = 'sensitive'; Title = 'Broker adapter Input: move, tap Shift, mouse button 1 down and up' }
)

# ------------------------------------------------------------------ pure logic (the unit test loads these functions by themselves, no VM involved)

# Non-ASCII text from WMI error messages must not reach the evidence file (it is written as ASCII), and machine SIDs stay out of it.
function Get-AsciiText([string]$Text) {
  $t = $Text -replace 'S-1-5-21(-[0-9]+)+', 'S-1-5-21-<redacted>'
  $t -replace '[^\x20-\x7E]', '?'
}

# One probe line -> what happened: allowed | denied | not_visible | error | missing.
# A skipped line takes the outcome of the check it waited for (a refused connect refuses everything after it).
# An adapter line (adapter_capture, adapter_input) carries only a DesktopReason word: the Broker's adapter hides why it failed. When it says it could not reach or
# drive the VM, the cause is read from the raw check(s) of the same operation, in the same process and token: refused there = refused here. Anything else is 'error'.
function Get-HvOutcome($Line, $ById) {
  if ($null -eq $Line) { return 'missing' }
  if ($Line.skipped) {
    $cause = $ById[[string]$Line.because]
    if ($null -eq $cause -or $cause.skipped) { return 'missing' }
    return (Get-HvOutcome $cause $ById)
  }
  if ($Line.ok -eq $true) { return 'allowed' }
  $partners = @{ adapter_capture = @('thumbnail'); adapter_input = @('keyboard_typekey', 'mouse_setabsoluteposition') }
  if ($partners.ContainsKey([string]$Line.id)) {
    if ([string]$Line.reason -notin @('desktop_unavailable', 'capture_failed', 'input_failed')) { return 'error' }
    $raw = @($partners[[string]$Line.id] | ForEach-Object { Get-HvOutcome $ById[$_] $ById })
    if ($raw -contains 'denied') { return 'denied' }
    if ($raw -contains 'not_visible') { return 'not_visible' }
    return 'error'
  }
  # The probe's own wording for "the WMI object did not show up for this caller" (management_service_not_found, realized_settings_not_found, VirtualSystemType
  # lookups): a caller that may not see the object is refused in effect.
  if ([string]$Line.exception -eq 'InvalidOperationException' -and [string]$Line.message -like '*_not_found') { return 'not_visible' }
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

# ---- the Broker desktop section (pure logic, loaded by the unit test on its own)

# The desktop client's lines (albera-lab-service-shim.exe desktop ...) by step id: connect, open, capture, ...
function ConvertTo-BdById($Objects) {
  $byId = @{}
  foreach ($o in @($Objects)) { if ($o.id) { $byId[[string]$o.id] = $o } }
  $byId
}

# One step -> what happened: allowed | refused_pipe | refused_reply | bad_result | error | missing.
#   refused_pipe   the pipe's DACL refused the open (access denied), so no byte was sent
#   refused_reply  the Broker answered with the fixed denied frame (the only refusal it ever sends)
#   bad_result     it answered, but with something that is not what the step asks for (a capture that is not a PNG of the asked size)
#   error          anything else: no connection, the server was not the expected one, the connection ended without a frame, an unknown reply
# A step that did not run takes the outcome of the step it waited for.
function Get-BdOutcome($ById, [string]$Step) {
  $connect = $ById['connect']
  if ($null -eq $connect) { return 'missing' }
  if ($connect.ok -ne $true) { if ([string]$connect.result -eq 'denied') { return 'refused_pipe' } else { return 'error' } }
  $line = $ById[$Step]
  if ($null -eq $line) { return 'missing' }
  if ($line.skipped) {
    if ([string]$line.because -eq 'connect') { return 'error' }
    return (Get-BdOutcome $ById ([string]$line.because))
  }
  if ($line.ok -eq $true) { return 'allowed' }
  switch ([string]$line.reply) {
    'denied' { return 'refused_reply' }
    'png_invalid' { return 'bad_result' }
    default { return 'error' }
  }
}

# Outcome -> verdict. $Expect is 'allowed' or 'refused'; $Refusals are the refusal outcomes this check can judge (an act open must reach the Broker, so a refused pipe does not count).
# What could not be measured (error, no output, a refusal at a layer this check does not cover) is BLOCKED, never a quiet PASS.
function Get-BdVerdict([string]$Expect, [string[]]$Refusals, [string]$Outcome) {
  if ($Outcome -in @('missing', 'error')) { return 'BLOCKED' }
  if ($Expect -eq 'allowed') { if ($Outcome -eq 'allowed') { return 'PASS' } else { return 'FAIL' } }
  if ($Outcome -in $Refusals) { return 'PASS' }
  if ($Outcome -in @('allowed', 'bad_result')) { return 'FAIL' }
  return 'BLOCKED'
}

# The desktop pipe, seen by the Control Plane (pipe-open with 0x00120083): owner, DACL, server process and session. $Open is the shim's pipe-open line.
function Test-BdPipeAcl($Open, [string]$BrokerSid, [string]$CpSid, $BrokerPid) {
  if ($null -eq $Open -or [string]$Open.result -ne 'opened') { return @{ Ok = $false; Evidence = @("open as Control Plane: $(if ($null -eq $Open) { 'no line' } else { $Open.result })") } }
  $sddl = [string]$Open.sddl
  $aces = @([regex]::Matches($sddl, '\(([A-Z]+);[^;]*;([^;]+);[^;]*;[^;]*;([^)]+)\)') | ForEach-Object { @{ Type = $_.Groups[1].Value; Mask = $_.Groups[2].Value; Sid = $_.Groups[3].Value } })
  $cpAces = @($aces | Where-Object { $_.Sid -eq $CpSid })
  $brokerAces = @($aces | Where-Object { $_.Sid -eq $BrokerSid })
  $strangers = @($aces | Where-Object { $_.Sid -notin @($BrokerSid, $CpSid, 'SY', 'S-1-5-18') })   # SYSTEM may be written as SY
  $ok = ([string]$Open.owner -eq $BrokerSid) -and $cpAces.Count -eq 1 -and $cpAces[0].Type -eq 'A' -and $cpAces[0].Mask -ieq '0x120083' -and $brokerAces.Count -ge 1 -and $strangers.Count -eq 0 `
    -and ([string]$Open.serverSession -eq '0') -and ([string]$Open.serverPid -eq [string]$BrokerPid)
  @{ Ok = $ok; Evidence = @("open as Control Plane: $($Open.result)", "owner=$($Open.owner) (Broker SID $BrokerSid)", "sddl=$sddl", "serverPid=$($Open.serverPid) servicePid=$BrokerPid serverSession=$($Open.serverSession) (expected 0)") }
}

# A throwaway ECDSA P-256 public key as base64 SubjectPublicKeyInfo, for the Broker's `authorityKeys`: the Broker only needs a well-formed pinned key to start (this lab sends no receipt).
# The private half lives in this process's memory for this call and is dropped.
function New-LabSpki {
  $key = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256)
  try {
    $blob = $key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)   # BCRYPT_ECCKEY_BLOB: magic (4), cbKey (4), X (32), Y (32)
    if ($blob.Length -ne 72) { throw "unexpected public key blob length $($blob.Length)" }
    $prefix = [byte[]](0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01, 0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04)
    $spki = New-Object byte[] ($prefix.Length + 64)
    [Array]::Copy($prefix, 0, $spki, 0, $prefix.Length)
    [Array]::Copy($blob, 8, $spki, $prefix.Length, 64)
    [Convert]::ToBase64String($spki)
  }
  finally { $key.Dispose() }
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
  foreach ($c in ($Cells + $BdCells)) { Remove-HvCell $c }
  Remove-InnerVm
  Emit-Json @{ cleaned = $true; servicesLeft = @(($Cells + $BdCells) | Where-Object { Get-Svc $_.Svc } | ForEach-Object { $_.Svc }) }
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
  foreach ($name in @('ok', 'skipped', 'because', 'reason', 'pngCheck', 'exception', 'hresult', 'returnValue', 'bytes', 'steps', 'enabledState', 'enumeration', 'message')) {
    if ($null -ne $Line.$name) { $parts += "$name=$($Line.$name)" }
  }
  $parts -join ' '
}

# Creates one lab service under its virtual account and gives it what it needs to start: the service SID type, SeChangeNotifyPrivilege as its only privilege (the ADR-002
# shape), optionally membership of Hyper-V Administrators, read access to bin and config, and its own results folder. Returns the service SID.
function Install-HvService([string]$svc, [string]$binPath, [string]$sidType, [bool]$member) {
  & sc.exe create $svc binPath= $binPath obj= "NT SERVICE\$svc" start= demand type= own | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc create $svc failed ($LASTEXITCODE)" }
  & sc.exe sidtype $svc $sidType | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc sidtype $svc failed ($LASTEXITCODE)" }
  & sc.exe privs $svc SeChangeNotifyPrivilege | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc privs $svc failed ($LASTEXITCODE)" }
  $sid = Get-Sid "NT SERVICE\$svc"
  if ($member) {
    & net.exe localgroup (Get-HvAdminsGroupName) "NT SERVICE\$svc" /add 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "adding $svc to Hyper-V Administrators failed ($LASTEXITCODE)" }
  }
  Grant-Path "$LabRoot\bin" $sid 'RX'
  Grant-Path "$LabRoot\config" $sid 'RX'
  New-LockedDir "$LabRoot\results\$svc"
  Grant-Path "$LabRoot\results\$svc" $sid 'M'
  & icacls.exe $LabRoot /grant "*${sid}:RX" | Out-Null
  $sid
}

# One identity: create the service, run the probe through it, judge, remove it again.
function Invoke-HvCell($Cell, [string]$VmId) {
  $svc = $Cell.Svc; $code = $Cell.Code
  $report = [ordered]@{ code = $code; service = $svc; sidtype = $Cell.SidType; member = $Cell.Member }
  $resultFile = "$LabRoot\results\$svc\probe.txt"; $tokenFile = "$LabRoot\results\$svc\probe.token.json"
  try {
    $sid = Install-HvService $svc "$Shim service $LabRoot\config\$svc.json" $Cell.SidType $Cell.Member
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

# ---- the Broker desktop section

$bdOutcomes = [ordered]@{}

# Runs `albera-lab-service-shim.exe <probeArgs>` as the installed lab service $svc (child mode, so the probe has the service's own token) and waits for it to finish.
# Returns the probe's JSON lines (only those whose "probe" is $probe), the token report the shim wrote, stderr, and an error text when the service could not be run.
function Invoke-HvShimJob([string]$svc, [string]$tag, [string[]]$probeArgs, [string]$probe) {
  $resultFile = "$LabRoot\results\$svc\$tag.txt"; $tokenFile = "$LabRoot\results\$svc\$tag.token.json"
  $job = @{ Objects = @(); Token = $null; Stderr = @(); Error = $null }
  try {
    $config = @{ mode = 'child'; program = $Shim; args = $probeArgs; resultFile = $resultFile; tokenFile = $tokenFile; timeoutSeconds = 100 }
    (ConvertTo-Json -InputObject $config -Depth 4) | Set-Content -Encoding Ascii -Path "$LabRoot\config\$svc.json"
    & sc.exe start $svc | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc start $svc failed ($LASTEXITCODE)" }
    Wait-Until { (Get-Svc $svc).State -eq 'Stopped' } 150 "$svc finished"
  }
  catch { $job.Error = Get-AsciiText $_.Exception.Message }
  $lines = @(Read-ResultLines $resultFile)
  foreach ($text in ($lines | Where-Object { $_ -like '{*' })) {
    try { $obj = $text | ConvertFrom-Json } catch { continue }
    if ($obj.probe -eq $probe) { $job.Objects += $obj }
  }
  $job.Stderr = @($lines | Where-Object { $_ -like '[[]stderr]*' } | Select-Object -First 3 | ForEach-Object { Get-AsciiText $_ })
  if (Test-Path -LiteralPath $tokenFile) { try { $job.Token = Get-Content -Raw -LiteralPath $tokenFile | ConvertFrom-Json } catch { } }
  $job
}

# A token-shape check. A wrong shape is the finding for the Broker and the Control Plane (the shapes the owner decided), so it is a FAIL; for the stand-in caller it only
# means the lab built the wrong thing, so the result is BLOCKED. A token that could not be read is BLOCKED.
function Add-BdTokenCheck([string]$Id, $Token, [string]$ExpectedSid, [bool]$Member, [string]$SidType, [string]$OnMismatch, [string]$Source) {
  if ($null -eq $Token -or $Token.result) {
    Add-Check $Id $BdTitles[$Id] 'BLOCKED' 'unreadable' @("token not available ($Source)$(if ($Token.result) { ': ' + $Token.result })")
    return @{ Ok = $false }
  }
  $shape = Test-HvTokenShape $Token $ExpectedSid $Member $SidType
  Add-Check $Id $BdTitles[$Id] $(if ($shape.Ok) { 'PASS' } else { $OnMismatch }) $(if ($shape.Ok) { 'as_intended' } else { 'shape_mismatch' }) (@($shape.Evidence) + "token read from: $Source")
  $shape
}

# One step of a desktop-client job -> one check.
function Add-BdStepCheck([string]$Id, $Job, [string]$Step, [string]$Expect, [string[]]$Refusals, $Shape) {
  $outcome = Get-BdOutcome (ConvertTo-BdById $Job.Objects) $Step
  $verdict = Get-BdVerdict $Expect $Refusals $outcome
  $note = @($Job.Objects | ForEach-Object { ConvertTo-Json -InputObject $_ -Compress -Depth 3 })
  if ($Job.Error) { $note += "job error: $($Job.Error)" }
  if (-not $Shape.Ok) { $verdict = 'BLOCKED'; $note += 'the caller token is not the shape this check names (see its _token check), so this result is not used' }
  if ($verdict -eq 'BLOCKED' -and $Job.Stderr.Count -gt 0) { $note += $Job.Stderr }
  $bdOutcomes[$Id] = $outcome
  Add-Check $Id $BdTitles[$Id] $verdict $outcome $note
}

function Add-BdBlocked([string[]]$Ids, [string]$Why) {
  foreach ($id in $Ids) { Add-Check $id $BdTitles[$id] 'BLOCKED' 'not_measured' @($Why) }
}

# The Broker's service configuration (ServiceConfig.cs): one pinned authority key (throwaway, see New-LabSpki), the Control Plane's SID, and the inner VM as the one computer.
function Write-BdBrokerConfig([string]$Path, [string]$Database, [string]$ControlPlaneSid, [string]$VmId) {
  $config = [ordered]@{
    pipeName = $BdPipe; database = $Database
    authorityKeys = @([ordered]@{ kid = 'lab-hv-authority-1'; spki = (New-LabSpki) })
    controlPlaneSid = $ControlPlaneSid; generation = 1; leaseId = 'lab-hv-lease-1'; policyVersion = 'lab-hv-policy-1'
    computers = @([ordered]@{ computerId = $BdComputerId; vmId = $VmId.ToLowerInvariant() })
  }
  (ConvertTo-Json -InputObject $config -Compress -Depth 5) | Set-Content -Encoding Ascii -Path $Path
}

# The real Broker as AlberaHostBroker, a Control Plane caller and another caller; then the Broker desktop pipe is exercised as each. Called with the inner VM running.
# What a later act session adds (PR5): an `act` open that carries a lease, and `input` steps, in the same Invoke-HvShimJob / Add-BdStepCheck frame.
function Invoke-BrokerDesktopLab([string]$VmId) {
  $brokerExe = "$LabRoot\bin\broker\albera-windows-broker.exe"
  if (-not (Test-Path -LiteralPath $brokerExe)) {
    Add-Check 'bd_prereq_broker' $BdTitles.bd_prereq_broker 'BLOCKED' 'missing' @("not found: $brokerExe (lab-vm.ps1 copies the Broker publish folder)")
    Add-BdBlocked @($BdTitles.Keys | Where-Object { $_ -ne 'bd_prereq_broker' }) 'the Broker build is not in the guest'
    return
  }
  Add-Check 'bd_prereq_broker' $BdTitles.bd_prereq_broker 'PASS' 'present' @("found: $brokerExe")
  foreach ($c in $BdCells) { if (Get-Svc $c.Svc) { throw "service $($c.Svc) already exists; refusing to touch it" } }

  # The callers first: the Broker's config names the Control Plane's SID.
  $cpSid = Install-HvService $BdCpSvc "$Shim service $LabRoot\config\$BdCpSvc.json" 'restricted' $false
  $otherSid = Install-HvService $BdOtherSvc "$Shim service $LabRoot\config\$BdOtherSvc.json" 'unrestricted' $true
  $brokerConfig = "$LabRoot\config\$BdBrokerSvc.service.json"
  $brokerSid = Install-HvService $BdBrokerSvc "$brokerExe service $brokerConfig" 'unrestricted' $true
  # As in the service lab: the Control Plane may ask the SCM about the Broker service (status only), which is how it finds the server PID.
  & sc.exe sdset $BdBrokerSvc "D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LC;;;${cpSid})" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc sdset $BdBrokerSvc failed ($LASTEXITCODE)" }
  New-LockedDir "$LabRoot\data"
  Grant-Path "$LabRoot\data" $brokerSid 'RX'
  New-LockedDir "$LabRoot\data\broker"
  Grant-Path "$LabRoot\data\broker" $brokerSid 'M'
  New-Item -ItemType Directory -Force -Path "$LabRoot\evidence" | Out-Null
  Write-BdBrokerConfig $brokerConfig "$LabRoot\data\broker\journal.sqlite" $cpSid $VmId

  & sc.exe start $BdBrokerSvc | Out-Null
  $startCode = $LASTEXITCODE
  try { Wait-Until { (Get-Svc $BdBrokerSvc).State -in @('Running', 'Stopped') } 40 "$BdBrokerSvc running or stopped" } catch { }   # a start that is refused (exit 73, 76...) ends Stopped
  $svcInfo = Get-Svc $BdBrokerSvc
  $brokerPid = [int]$svcInfo.ProcessId
  $running = ($svcInfo.State -eq 'Running') -and $brokerPid -gt 0
  Add-Check 'bd_broker_ready' $BdTitles.bd_broker_ready $(if ($running) { 'PASS' } else { 'FAIL' }) $(if ($running) { 'running' } else { 'not_running' }) @(
    "sc start exit=$startCode state=$($svcInfo.State) pid=$brokerPid win32=$($svcInfo.ExitCode) specific=$($svcInfo.ServiceSpecificExitCode)",
    "binPath: $($svcInfo.PathName)", "sidtype: $(((& sc.exe qsidtype $BdBrokerSvc) -join ' ' -replace '\s+', ' ').Trim())", "privileges: $(((& sc.exe qprivs $BdBrokerSvc) -join ' ' -replace '\s+', ' ').Trim())",
    "config computers: $BdComputerId -> $VmId", "desktop pipe name: $BdDesktopPipe")
  if (-not $running) {
    Add-BdBlocked @($BdTitles.Keys | Where-Object { $_ -notin @('bd_prereq_broker', 'bd_broker_ready') }) 'the Broker service is not running (bd_broker_ready)'
    return
  }

  # The Broker's token, read off the running service process as the interactive Administrator (the way check a_token of the service lab does it).
  $brokerToken = (& $Shim token-of "$brokerPid") | ConvertFrom-Json
  [void](Add-BdTokenCheck 'bd_broker_token' $brokerToken $brokerSid $true 'unrestricted' 'FAIL' 'token-of <Broker pid> as Administrator')

  # Control Plane: the pipe's shape, a view session with a capture, an act open.
  $pipeJob = Invoke-HvShimJob $BdCpSvc 'pipe' @('pipe-open', $BdDesktopPipe, '00120083') 'pipe-open'
  $cpShape = Add-BdTokenCheck 'bd_cp_token' $pipeJob.Token $cpSid $false 'restricted' 'FAIL' 'the shim report of the Control Plane service'
  $openLine = $pipeJob.Objects | Select-Object -Last 1   # null when the probe printed nothing
  $acl = Test-BdPipeAcl $openLine $brokerSid $cpSid $brokerPid
  $aclNote = @($acl.Evidence); if ($pipeJob.Error) { $aclNote += "job error: $($pipeJob.Error)" }
  Add-Check 'bd_desktop_pipe' $BdTitles.bd_desktop_pipe $(if ($acl.Ok) { 'PASS' } else { 'FAIL' }) $(if ($acl.Ok) { 'as_intended' } else { 'unexpected' }) $aclNote

  $pngPath = "$LabRoot\results\$BdCpSvc\view.png"
  $viewJob = Invoke-HvShimJob $BdCpSvc 'view' @('desktop', $BdDesktopPipe, "service:$BdBrokerSvc", "open:view:$BdComputerId", 'capture:640x480', "save=$pngPath") 'desktop'
  Add-BdStepCheck 'bd_cp_view_open' $viewJob 'open' 'allowed' @() $cpShape
  Add-BdStepCheck 'bd_cp_view_capture' $viewJob 'capture' 'allowed' @() $cpShape
  if (Test-Path -LiteralPath $pngPath) { Copy-Item -LiteralPath $pngPath -Destination "$LabRoot\evidence\bd-view-capture.png" -Force }

  $actJob = Invoke-HvShimJob $BdCpSvc 'act' @('desktop', $BdDesktopPipe, "service:$BdBrokerSvc", "open:act:$BdComputerId") 'desktop'
  Add-BdStepCheck 'bd_cp_act_refused' $actJob 'open' 'refused' @('refused_reply') $cpShape

  # Another caller with the Broker's own shape: it may not query the service, so it is told the server's PID and owner (what the Control Plane would learn from the SCM).
  $otherJob = Invoke-HvShimJob $BdOtherSvc 'view' @('desktop', $BdDesktopPipe, "pid:${brokerPid}:${brokerSid}", "open:view:$BdComputerId", 'capture:640x480') 'desktop'
  $otherShape = Add-BdTokenCheck 'bd_other_token' $otherJob.Token $otherSid $true 'unrestricted' 'BLOCKED' 'the shim report of the other caller service'
  Add-BdStepCheck 'bd_other_refused' $otherJob 'open' 'refused' @('refused_pipe', 'refused_reply') $otherShape
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
      # After the four measurements: the real Broker as a service, and its desktop pipe.
      try { Invoke-BrokerDesktopLab $innerId }
      catch { Add-Check 'bd_script_error' 'The Broker desktop section of the lab script failed' 'BLOCKED' 'exception' @(Get-AsciiText $_.Exception.Message) }
    }
  }
}
catch {
  Add-Check 'hv_script_error' 'The lab script itself failed' 'BLOCKED' 'exception' @($_.Exception.Message)
}
finally {
  Remove-InnerVm
  foreach ($c in ($Cells + $BdCells)) { Remove-HvCell $c }
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
  brokerDesktop = [ordered]@{ pipe = $BdDesktopPipe; computerId = $BdComputerId; outcomes = [pscustomobject]$bdOutcomes }
  checks = $checks.ToArray()
}
New-Item -ItemType Directory -Force -Path "$LabRoot\evidence" | Out-Null
ConvertTo-Json -InputObject $results -Depth 8 | Set-Content -Encoding Ascii -Path "$LabRoot\evidence\hyperv-results.json"
Write-Output (ConvertTo-Json -InputObject $results -Depth 8 -Compress)
