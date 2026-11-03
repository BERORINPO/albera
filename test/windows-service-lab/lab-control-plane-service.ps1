# Control Plane as a virtual-account service (ADR-002 "Process and identity contract"), GUEST side. Runs INSIDE the disposable lab VM as Administrator
# (Windows PowerShell 5.1), started by lab-vm.ps1 -ControlPlaneService over PowerShell Direct. ASCII only. NOT executed in a VM yet: expect first-run fixes.
#   lab-control-plane-service.ps1 <LabRoot> run [<NodeSource>]   install the stand-in services, run the seven measurements, print the result as ONE JSON line
#   lab-control-plane-service.ps1 <LabRoot> cleanup              delete the stand-in services, the shareholder stand-in user, the ProgramData folder and the lab root (the host calls it only with -KeepVm)
#
# The question (easy setup, stage 1): today the Control Plane runs as an ordinary user. If it ran as NT SERVICE\AlberaControlPlane (sidtype restricted, SeChangeNotifyPrivilege only),
# can it still do what it needs? Seven measurements, each as that very identity (the lab shim is the service; every probe is its child, so it carries the service's own token):
#   cp1  node.exe (C:\Program Files\nodejs) starts as the service's child and node:sqlite reads and writes a journal (WAL, like src/runtime/sqlite-operation-store.mjs)
#   cp2  the existing pipe client helper starts as the service's child (pid mode and serviceName mode) and gets as far as opening the Broker pipe (no Broker here: broker_unavailable)
#   cp3  DPAPI CurrentUser scope with entropy works; where the profile is and whether Windows loaded it (cp3_profile, MEASURED)
#   cp4  another identity (another virtual account, a plain local user, Administrator) cannot Unprotect that blob
#   cp5  the service can listen on 127.0.0.1 port 0 and another local user can connect (MEASURED: it is expected to connect; the lab only records it)
#   cp6  the service can create a file under ProgramData whose DACL is exactly: service SID Modify, a "shareholder" SID Read, nothing inherited; and the access really is that
#   cp7  outbound HTTPS (BLOCKED is the expected answer: the lab guest has no network)
# Statuses: PASS, FAIL, BLOCKED (could not be measured), MEASURED (the observation is the result). Every check carries `expected`; the host's exit code is 0 only when every status is the expected one.
param(
  [Parameter(Mandatory = $true)][string]$LabRoot,
  [Parameter(Mandatory = $true)][ValidateSet('run', 'cleanup')][string]$Phase,
  # Where node.exe came from, recorded as evidence only: 'golden' (it was in the image) or 'copied_from_host:<version>:<sha256>' (the driver copied the host's portable node.exe).
  [string]$NodeSource = 'golden'
)
$ErrorActionPreference = 'Stop'

# First statement on purpose: this script creates services and a local user. Never on a real machine.
if ($env:ALBERA_LAB_VM -ne '1' -or (Get-CimInstance Win32_ComputerSystem).Model -ne 'Virtual Machine') {
  throw 'refusing to run: this script changes services and local users, and runs only inside the disposable lab VM (ALBERA_LAB_VM=1 in a Hyper-V guest)'
}

$CpSvc = 'AlberaControlPlane'          # the name ADR-002 gives the Control Plane's virtual account
$OtherSvc = 'AlberaLabCpOther'         # another virtual account, same shape: the "somebody else" of cp4 and cp6
$HolderUser = 'AlberaLabHolder'        # the shareholder stand-in: a plain local user in BUILTIN\Users (lab-person.ps1), run as a service so a probe can carry its token
$HolderSvc = 'AlberaLabHolderSvc'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$Shim = "$LabRoot\bin\shim\albera-lab-service-shim.exe"
$Helper = "$LabRoot\bin\helper\albera-windows-broker-pipe-client.exe"
$NodeProbe = "$LabRoot\bin\cp\cp-node-probe.mjs"
$PersonTool = "$LabRoot\tools\lab-person.ps1"
$Entropy = 'albera.control-plane.lab.entropy.v1'
$BlobFile = "$LabRoot\config\cp-dpapi-blob.b64"
$ProgramDataDir = 'C:\ProgramData\AlberaLabControlPlane'
$ProgramDataFile = "$ProgramDataDir\shareholder-readable.txt"
$NoBrokerPipe = 'ALBERA_CpLab_NoBroker'
$HttpsUrl = 'https://example.com/'
$HttpsSeconds = 8
$TcpListenSeconds = 60
$TcpClientSeconds = 10
$Everything = @($CpSvc, $OtherSvc, $HolderSvc)

$CpTitles = [ordered]@{
  cp0_token                      = 'The live Control Plane token is the shape ADR-002 names: user = its service SID, restricted (restricting SIDs), not in Administrators or Hyper-V Administrators, exactly SeChangeNotifyPrivilege'
  cp1_node_sqlite                = 'node.exe (C:\Program Files\nodejs) starts as the service child and node:sqlite opens a WAL journal, writes a row, reopens it and reads the row back'
  cp2_pipe_client_helper         = 'The existing pipe client helper starts as the service child (pid mode and serviceName mode) and reaches the pipe open: broker_unavailable, not a start failure'
  cp3_dpapi_currentuser          = 'DPAPI CurrentUser scope with entropy: Protect then Unprotect gives the plaintext back, and the wrong entropy does not'
  cp3_profile                    = 'MEASURED: the profile the service gets (USERPROFILE, APPDATA, hive loaded, where DPAPI keeps its master key)'
  cp4_dpapi_other_identity_refused = 'The blob cannot be Unprotected by another virtual account, a plain local user or Administrator'
  cp5_tcp_loopback_other_user    = 'MEASURED: the service listens on 127.0.0.1 port 0; whether other local users can connect (expected: they can; recorded only)'
  cp6_programdata_acl            = 'The service creates a ProgramData file with a protected DACL of exactly two ACEs (service SID Modify, shareholder SID Read); the shareholder reads but cannot write, another virtual account cannot read'
  cp7_outbound_https             = 'Outbound HTTPS: BLOCKED is the expected answer in the lab (the guest has no network); FAIL only if this identity itself is refused (access denied)'
}
$CpExpected = [ordered]@{
  cp0_token = 'PASS'; cp1_node_sqlite = 'PASS'; cp2_pipe_client_helper = 'PASS'; cp3_dpapi_currentuser = 'PASS'; cp3_profile = 'MEASURED'
  cp4_dpapi_other_identity_refused = 'PASS'; cp5_tcp_loopback_other_user = 'MEASURED'; cp6_programdata_acl = 'PASS'; cp7_outbound_https = 'BLOCKED'
}

# ------------------------------------------------------------------ pure logic (the unit test loads these functions by themselves, no VM involved)

# Non-ASCII text from error messages must not reach the evidence file (it is written as ASCII), and machine SIDs stay out of it.
function Get-AsciiText([string]$Text) {
  $t = $Text -replace 'S-1-5-21(-[0-9]+)+', 'S-1-5-21-<redacted>'
  $t -replace '[^\x20-\x7E]', '?'
}

function New-CpResult([string]$Status, [string]$Observed) { @{ Status = $Status; Observed = $Observed } }

# Is the live service token what ADR-002 says the Control Plane has? $Token is TokenReport JSON (the shim writes it at every service start).
function Test-CpTokenShape($Token, [string]$ExpectedSid) {
  if ($null -eq $Token -or $Token.result) { return @{ Ok = $false; Evidence = @('no token report was written') } }
  $ok = $true; $evidence = @()
  $user = [string]$Token.user.sid
  if ($user -ne $ExpectedSid) { $ok = $false }
  $evidence += "token user $(Get-AsciiText $user) (service SID $(Get-AsciiText $ExpectedSid))"
  $restricting = @($Token.restrictedSids | Where-Object { $_ }).Count
  if ($restricting -le 0) { $ok = $false }
  $evidence += "restricting SIDs: $restricting, hasRestrictions=$($Token.hasRestrictions) (expected restricted)"
  foreach ($pair in @(@('S-1-5-32-544', 'Administrators'), @('S-1-5-32-578', 'Hyper-V Administrators'))) {
    $group = @($Token.groups | Where-Object { $_.sid -eq $pair[0] }) | Select-Object -First 1
    $effective = ($null -ne $group) -and (@($group.attributes) -contains 'enabled') -and (@($group.attributes) -notcontains 'deny_only')
    if ($effective) { $ok = $false }
    $evidence += "$($pair[1]) in token: $(if ($null -eq $group) { 'absent' } else { (@($group.attributes) -join '+') }) (expected absent or deny_only)"
  }
  $privileges = @($Token.privileges | ForEach-Object { $_.name })
  if ($privileges.Count -ne 1 -or $privileges[0] -ne 'SeChangeNotifyPrivilege') { $ok = $false }
  $evidence += "privileges: $($privileges -join ', ')"
  @{ Ok = $ok; Evidence = $evidence }
}

# cp1. $Ran: the service job could be started. A job that ran but printed no probe line (node.exe could not start, crashed) is the finding, so FAIL.
function Get-CpNodeVerdict($Line, [bool]$Ran) {
  if (-not $Ran) { return (New-CpResult 'BLOCKED' 'job_not_run') }
  if ($null -eq $Line) { return (New-CpResult 'FAIL' 'node_gave_no_answer') }
  if ($Line.ok -eq $true) { return (New-CpResult 'PASS' "sqlite_wal_ok node=$($Line.nodeVersion) sqlite=$($Line.sqliteVersion)") }
  New-CpResult 'FAIL' "failed_at_$($Line.step)$(if ($Line.error) { ':' + $Line.error.name + ':' + $Line.error.code })"
}

# cp2. Both helper lines must be {ok:false, code:broker_unavailable}: the helper started as the service's child, read its input, resolved the expectation under this token and found no pipe.
function Get-CpHelperVerdict($PidLine, $ServiceLine, [bool]$Ran) {
  if (-not $Ran) { return (New-CpResult 'BLOCKED' 'job_not_run') }
  $a = if ($null -eq $PidLine) { 'no_answer' } else { [string]$PidLine.code }
  $b = if ($null -eq $ServiceLine) { 'no_answer' } else { [string]$ServiceLine.code }
  $text = "pid_mode=$a service_mode=$b"
  if ($a -eq 'broker_unavailable' -and $b -eq 'broker_unavailable') { return (New-CpResult 'PASS' $text) }
  New-CpResult 'FAIL' $text
}

# cp3. The `dpapi-protect` line.
function Get-CpDpapiVerdict($Line, [bool]$Ran) {
  if (-not $Ran) { return (New-CpResult 'BLOCKED' 'job_not_run') }
  if ($null -eq $Line) { return (New-CpResult 'FAIL' 'probe_gave_no_answer') }
  if ($Line.ok -ne $true) { return (New-CpResult 'FAIL' "protect_failed_win32_$($Line.win32)") }
  if ($Line.roundTrip -ne $true) { return (New-CpResult 'FAIL' 'unprotect_did_not_return_the_plaintext') }
  if ($Line.wrongEntropyRefused -ne $true) { return (New-CpResult 'FAIL' 'wrong_entropy_was_accepted') }
  New-CpResult 'PASS' 'protect_unprotect_with_entropy_ok'
}

# cp3_profile: always MEASURED when there is a line; the observation is the result.
function Get-CpProfileObservation($Line) {
  if ($null -eq $Line -or $null -eq $Line.profile) { return (New-CpResult 'BLOCKED' 'no_profile_report') }
  $p = $Line.profile
  New-CpResult 'MEASURED' ("userProfile=$($p.userProfileEnv) appData=$($p.appDataEnv) profileFolderExists=$($p.userProfileFolderExists) hiveLoaded=$($p.registryHiveLoaded) " +
    "profileList=$($p.profileListPath) masterKeyFolder=$($p.masterKeyFolderExists)/files=$($p.masterKeyFileCount)")
}

# cp4. $Results: @{ Name; Line } for each identity that tried to Unprotect (Line is the `dpapi-unprotect` line, $null when none). The virtual account and Administrator must both have been measured.
function Get-CpOtherIdentityVerdict($Results) {
  $byName = @{}
  foreach ($r in @($Results)) { $byName[[string]$r.Name] = $r.Line }
  $missing = @(@('other_virtual_account', 'administrator') | Where-Object { $null -eq $byName[$_] })
  if ($missing.Count -gt 0) { return (New-CpResult 'BLOCKED' "not_measured: $($missing -join ', ')") }
  $parts = @(); $opened = @(); $unclear = @()
  foreach ($name in @($byName.Keys | Sort-Object)) {
    $line = $byName[$name]
    if ($null -eq $line) { continue }
    if ($line.setupError) { $unclear += $name; $parts += "$name=setup_error_$($line.setupError)"; continue }
    if ($line.ok -eq $true) { $opened += $name; $parts += "$name=opened(matches=$($line.matches))"; continue }
    $parts += "$name=refused_win32_$($line.win32)"
  }
  $text = $parts -join ' '
  if ($opened.Count -gt 0) { return (New-CpResult 'FAIL' $text) }
  if ($unclear.Count -gt 0) { return (New-CpResult 'BLOCKED' $text) }
  New-CpResult 'PASS' $text
}

# cp5. $Ready: the listener's `ready` line (or its error line); $Clients: @{ Name; Line } of the tcp-connect probes. Always MEASURED once it was measured at all.
function Get-CpTcpVerdict($Ready, $Clients) {
  if ($null -eq $Ready) { return (New-CpResult 'BLOCKED' 'listener_gave_no_answer') }
  if ([string]$Ready.state -ne 'ready') { return (New-CpResult 'MEASURED' "listen_failed:$($Ready.socketError)") }
  $parts = @("listening=$($Ready.address)")
  $measured = 0
  foreach ($c in @($Clients)) {
    if ($null -eq $c.Line) { $parts += "$($c.Name)=not_measured"; continue }
    $measured++
    if ($c.Line.ok -eq $true) { $parts += "$($c.Name)=connected" } else { $parts += "$($c.Name)=refused($($c.Line.socketError))" }
  }
  if ($measured -eq 0) { return (New-CpResult 'BLOCKED' ($parts -join ' ')) }
  New-CpResult 'MEASURED' ($parts -join ' ')
}

function ConvertTo-CpRights([string]$Text) { [Convert]::ToInt64(($Text -replace '^0x', ''), 16) }

# cp6. $Acl: the `acl-file` line. $HolderRead / $HolderWrite / $OtherRead: the `file-access` outcomes ('opened', 'denied', ...) or $null.
# Modify = 0x1301BF, Read with Synchronize = 0x120089 (FILE_GENERIC_READ): the two ACEs the service writes, and nothing inherited.
function Get-CpAclVerdict($Acl, [string]$CpSid, [string]$HolderSid, $HolderRead, $HolderWrite, $OtherRead, [bool]$Ran) {
  if (-not $Ran) { return (New-CpResult 'BLOCKED' 'job_not_run') }
  if ($null -eq $Acl) { return (New-CpResult 'FAIL' 'probe_gave_no_answer') }
  if ($Acl.ok -ne $true) { return (New-CpResult 'FAIL' "failed_at_$($Acl.failedStep):$($Acl.exception)") }
  $aces = @($Acl.finalAces)
  $problems = @()
  if ($aces.Count -ne 2) { $problems += "ace_count_$($aces.Count)" }
  if (@($aces | Where-Object { $_.inherited -eq $true }).Count -gt 0) { $problems += 'inherited_ace_left' }
  if ($Acl.protected -ne $true) { $problems += 'dacl_not_protected' }
  $cp = @($aces | Where-Object { $_.sid -eq $CpSid }) | Select-Object -First 1
  $holder = @($aces | Where-Object { $_.sid -eq $HolderSid }) | Select-Object -First 1
  if ($null -eq $cp -or $cp.type -ne 'Allow' -or (ConvertTo-CpRights $cp.rights) -ne 0x1301BF) { $problems += 'service_sid_not_modify' }
  if ($null -eq $holder -or $holder.type -ne 'Allow' -or (ConvertTo-CpRights $holder.rights) -ne 0x120089) { $problems += 'shareholder_sid_not_read' }
  $inheritedBefore = @($Acl.inheritedAces | Where-Object { $_ }).Count
  $text = "aces=$($aces.Count) protected=$($Acl.protected) inheritedBefore=$inheritedBefore holder_read=$HolderRead holder_write=$HolderWrite other_read=$OtherRead"
  if ($problems.Count -gt 0) { return (New-CpResult 'FAIL' "$text problems=$($problems -join ',')") }
  if ($null -eq $HolderRead -or $null -eq $HolderWrite -or $null -eq $OtherRead) { return (New-CpResult 'BLOCKED' "$text access_not_measured") }
  if ($HolderRead -ne 'opened') { $problems += 'shareholder_cannot_read' }
  if ($HolderWrite -ne 'denied') { $problems += 'shareholder_can_write' }
  if ($OtherRead -ne 'denied') { $problems += 'other_account_can_read' }
  if ($problems.Count -gt 0) { return (New-CpResult 'FAIL' "$text problems=$($problems -join ',')") }
  New-CpResult 'PASS' $text
}

# cp7. Reaching the internet is PASS; BLOCKED (no network, expected in the lab) is the usual answer; an access-denied socket error means THIS identity may not connect out: FAIL.
function Get-CpHttpsVerdict($Line, [bool]$Ran) {
  if (-not $Ran) { return (New-CpResult 'BLOCKED' 'job_not_run') }
  if ($null -eq $Line) { return (New-CpResult 'BLOCKED' 'probe_gave_no_answer') }
  if ($Line.ok -eq $true) { return (New-CpResult 'PASS' "reached_status_$($Line.status)") }
  if ([string]$Line.kind -eq 'access_denied') { return (New-CpResult 'FAIL' "identity_refused_socket_$($Line.socketError)") }
  New-CpResult 'BLOCKED' "no_network_$($Line.kind)_$($Line.socketError)"
}

# Did every check come out as expected? (The host uses the same rule for its exit code; the unit test pins it.)
function Get-CpUnexpected($Checks) {
  @($Checks | Where-Object { $_.status -ne $_.expected } | ForEach-Object { "$($_.id): $($_.status) (expected $($_.expected))" })
}

# ------------------------------------------------------------------ guest helpers
function Emit-Json($Value) { Write-Output (ConvertTo-Json -InputObject $Value -Compress -Depth 8) }
function Get-Svc([string]$Name) { Get-CimInstance Win32_Service -Filter "Name='$Name'" }
function Get-Sid([string]$Account) { (New-Object System.Security.Principal.NTAccount($Account)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
function Wait-Until([scriptblock]$Condition, [int]$Seconds, [string]$What) {
  $end = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $end) { if (& $Condition) { return }; Start-Sleep -Milliseconds 300 }
  throw "timeout waiting for $What"
}
function Stop-LabService([string]$Name) {
  $svc = Get-Svc $Name
  if ($svc -and $svc.State -ne 'Stopped') {
    & sc.exe stop $Name | Out-Null
    Wait-Until { (Get-Svc $Name).State -eq 'Stopped' } 30 "$Name stopped"
  }
}
function Grant-Path([string]$Path, [string]$Sid, [string]$Rights) {
  & icacls.exe $Path /grant "*${Sid}:(OI)(CI)$Rights" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed for $Path" }
}
function New-LockedDir([string]$Path) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed for $Path" }
}

if ($Phase -eq 'cleanup') {
  foreach ($n in $Everything) { try { if (Get-Svc $n) { Stop-LabService $n; & sc.exe delete $n | Out-Null } } catch { } }
  $person = $null
  try { if (Test-Path -LiteralPath $PersonTool) { $person = (& $PersonTool -Remove -UserName $HolderUser) | ConvertFrom-Json } } catch { }
  try {
    if (Test-Path -LiteralPath $ProgramDataDir) {
      # The file's DACL has no Administrators ACE (that is the point), so take ownership before deleting.
      & takeown.exe /F $ProgramDataDir /R /D Y | Out-Null
      & icacls.exe $ProgramDataDir /grant '*S-1-5-32-544:(OI)(CI)F' /T | Out-Null
      Remove-Item -Recurse -Force -LiteralPath $ProgramDataDir
    }
  } catch { }
  try { Remove-Item -Recurse -Force -LiteralPath $LabRoot } catch { }
  Emit-Json @{ cleaned = $true; servicesLeft = @($Everything | Where-Object { Get-Svc $_ }); programDataGone = (-not (Test-Path -LiteralPath $ProgramDataDir)); person = $person }
  return
}

# ------------------------------------------------------------------ run phase
$checks = New-Object System.Collections.ArrayList
function Add-Check([string]$Id, $Result, [string[]]$Evidence) {
  [void]$checks.Add([ordered]@{ id = $Id; title = $CpTitles[$Id]; expected = $CpExpected[$Id]; status = $Result.Status; observed = $Result.Observed; evidence = @($Evidence | ForEach-Object { Get-AsciiText $_ }) })
  Write-Host ("  {0,-8} {1}  {2}" -f $Result.Status, $Id, (Get-AsciiText $Result.Observed))
}
# A check body that throws is BLOCKED (the lab broke, nothing was measured), never a quiet pass.
function Step([string]$Id, [scriptblock]$Body) {
  try { $r = & $Body; Add-Check $Id $r.Result $r.Evidence }
  catch { Add-Check $Id (New-CpResult 'BLOCKED' 'lab_exception') @("exception: $($_.Exception.Message)") }
}
function Read-ResultLines([string]$Path) { if (Test-Path -LiteralPath $Path) { @(Get-Content -LiteralPath $Path) } else { @() } }

# Creates a stand-in service in the Control Plane's shape (virtual account, sidtype restricted, SeChangeNotifyPrivilege only) and gives it what it needs to start:
# read access to bin and config, its own results folder. Returns its service SID.
function Install-CpService([string]$svc) {
  & sc.exe create $svc binPath= "$Shim service $LabRoot\config\$svc.json" obj= "NT SERVICE\$svc" start= demand type= own | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc create $svc failed ($LASTEXITCODE)" }
  & sc.exe sidtype $svc restricted | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc sidtype $svc failed ($LASTEXITCODE)" }
  & sc.exe privs $svc SeChangeNotifyPrivilege | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc privs $svc failed ($LASTEXITCODE)" }
  $sid = Get-Sid "NT SERVICE\$svc"
  Grant-Path "$LabRoot\bin" $sid 'RX'
  Grant-Path "$LabRoot\config" $sid 'RX'
  New-LockedDir "$LabRoot\results\$svc"
  Grant-Path "$LabRoot\results\$svc" $sid 'M'
  & icacls.exe $LabRoot /grant "*${sid}:RX" | Out-Null
  $sid
}

# One job = one service start. The shim runs `$program $jobArgs` as the service's child (stdin from $stdinFile when given); its stdout and stderr go to the result file.
function Start-CpJob([string]$svc, [string]$tag, [string]$program, [string[]]$jobArgs, [string]$stdinFile) {
  $resultFile = "$LabRoot\results\$svc\$tag.txt"; $tokenFile = "$LabRoot\results\$svc\$tag.token.json"
  $job = @{ Svc = $svc; ResultFile = $resultFile; TokenFile = $tokenFile; Objects = @(); Token = $null; Stderr = @(); ShimLines = @(); Error = $null }
  try {
    $config = @{ mode = 'child'; program = $program; args = $jobArgs; resultFile = $resultFile; tokenFile = $tokenFile; timeoutSeconds = 100 }
    if ($stdinFile) { $config.stdinFile = $stdinFile }
    (ConvertTo-Json -InputObject $config -Depth 4) | Set-Content -Encoding Ascii -Path "$LabRoot\config\$svc.json"
    & sc.exe start $svc | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc start $svc failed ($LASTEXITCODE)" }
  }
  catch { $job.Error = Get-AsciiText $_.Exception.Message }
  $job
}

# Waits for the job's service to stop, then reads what it wrote: the JSON objects (only those whose "probe" is $probe when given), stderr, the shim's own error lines and the token report.
function Complete-CpJob($job, [string]$probe) {
  try { if (-not $job.Error) { Wait-Until { (Get-Svc $job.Svc).State -eq 'Stopped' } 150 "$($job.Svc) finished" } }
  catch { $job.Error = Get-AsciiText $_.Exception.Message }
  $lines = @(Read-ResultLines $job.ResultFile)
  foreach ($text in ($lines | Where-Object { $_ -like '{*' })) {
    try { $obj = $text | ConvertFrom-Json } catch { continue }
    if (-not $probe -or $obj.probe -eq $probe) { $job.Objects += $obj }
  }
  $job.Stderr = @($lines | Where-Object { $_ -like '[[]stderr]*' } | Select-Object -First 3 | ForEach-Object { Get-AsciiText $_ })
  $job.ShimLines = @($lines | Where-Object { $_ -like '[[]shim]*' } | Select-Object -First 6 | ForEach-Object { Get-AsciiText $_ })
  if (Test-Path -LiteralPath $job.TokenFile) { try { $job.Token = Get-Content -Raw -LiteralPath $job.TokenFile | ConvertFrom-Json } catch { } }
  $job
}
function Invoke-CpJob([string]$svc, [string]$tag, [string]$program, [string[]]$jobArgs, [string]$stdinFile, [string]$probe) {
  Complete-CpJob (Start-CpJob $svc $tag $program $jobArgs $stdinFile) $probe
}
function Get-LastObject($Job, [string]$Id) {
  @($Job.Objects | Where-Object { -not $Id -or $_.id -eq $Id }) | Select-Object -Last 1
}
function ConvertTo-JobEvidence($Job, [string[]]$Note = @()) {
  $e = @($Job.Objects | ForEach-Object { ConvertTo-Json -InputObject $_ -Compress -Depth 5 }) + $Note
  if ($Job.Error) { $e += "job error: $($Job.Error)" }
  if ($Job.Objects.Count -eq 0) { $e += $Job.ShimLines }
  if ($Job.Stderr.Count -gt 0) { $e += $Job.Stderr }
  $e
}
# The same shim, run directly in this session: that is Administrator (PowerShell Direct).
function Invoke-ProbeAdmin([string[]]$probeArgs) {
  $text = @(& $Shim @probeArgs | ForEach-Object { "$_" } | Where-Object { $_ -like '{*' }) | Select-Object -Last 1
  if ($text) { $text | ConvertFrom-Json }
}
function New-HelperInput([string]$Name, $Expect) {
  $body = [ordered]@{ pipeName = $NoBrokerPipe; fence = 'lab-room'; timeoutMs = 3000; expect = $Expect }
  $path = "$LabRoot\config\$Name.stdin.json"
  (ConvertTo-Json -InputObject $body -Compress -Depth 4) | Set-Content -Encoding Ascii -Path $path
  $path
}

Write-Host "Control Plane service lab: node source = $NodeSource"
New-Item -ItemType Directory -Force -Path "$LabRoot\config", "$LabRoot\results", "$LabRoot\evidence" | Out-Null
$setupError = $null
$cpSid = $null; $otherSid = $null; $holderSid = $null
try {
  foreach ($p in @($Shim, $Helper, $NodeProbe, $PersonTool)) { if (-not (Test-Path -LiteralPath $p)) { throw "missing in the guest: $p" } }
  foreach ($n in $Everything) { if (Get-Svc $n) { throw "service $n already exists; refusing to touch it" } }
  $cpSid = Install-CpService $CpSvc
  $otherSid = Install-CpService $OtherSvc
  $holder = (& $PersonTool -Create -UserName $HolderUser -ServiceName $HolderSvc -BinPath "$Shim service $LabRoot\config\$HolderSvc.json") | ConvertFrom-Json
  $holderSid = [string]$holder.userSid
  Grant-Path "$LabRoot\bin" $holderSid 'RX'
  Grant-Path "$LabRoot\config" $holderSid 'RX'
  New-LockedDir "$LabRoot\results\$HolderSvc"
  Grant-Path "$LabRoot\results\$HolderSvc" $holderSid 'M'
  & icacls.exe $LabRoot /grant "*${holderSid}:RX" | Out-Null
}
catch { $setupError = Get-AsciiText $_.Exception.Message }

# What one check hands to a later one (a Step body cannot assign to the script's own variables: it runs in a child scope, so a plain assignment would only shadow them).
$State = @{ ProtectLine = $null }
$cpToken = $null

if ($setupError) {
  foreach ($id in $CpTitles.Keys) { Add-Check $id (New-CpResult 'BLOCKED' 'lab_setup_failed') @("setup error: $setupError") }
}
else {
  # ---- cp1: node.exe + node:sqlite. The token report of this first job is also what cp0 judges.
  $nodeJob = $null
  if (Test-Path -LiteralPath $NodeExe) { $nodeJob = Invoke-CpJob $CpSvc 'node' $NodeExe @($NodeProbe, "$LabRoot\results\$CpSvc\journal") $null 'cp' }
  $cpToken = if ($nodeJob) { $nodeJob.Token } else { $null }
  if (-not $cpToken) {
    $tokenJob = Invoke-CpJob $CpSvc 'token' $Shim @('token') $null $null
    $cpToken = $tokenJob.Token
  }
  $shape = Test-CpTokenShape $cpToken $cpSid
  Add-Check 'cp0_token' (New-CpResult $(if ($shape.Ok) { 'PASS' } else { 'FAIL' }) $(if ($shape.Ok) { 'as_intended' } else { 'shape_mismatch' })) $shape.Evidence

  # The lab's own proof that the service is the identity it claims comes first; with another shape nothing below says anything about ADR-002's Control Plane.
  Step 'cp1_node_sqlite' {
    if (-not $shape.Ok) { return @{ Result = (New-CpResult 'BLOCKED' 'token_shape_not_as_intended'); Evidence = @('see cp0_token') } }
    if (-not $nodeJob) { return @{ Result = (New-CpResult 'BLOCKED' 'node_exe_not_in_guest'); Evidence = @("$NodeExe is missing; node source: $NodeSource") } }
    @{ Result = (Get-CpNodeVerdict (Get-LastObject $nodeJob 'node-sqlite') (-not $nodeJob.Error)); Evidence = (ConvertTo-JobEvidence $nodeJob @("node source: $NodeSource")) }
  }

  # ---- cp2: the pipe client helper as the service's child, in both identity modes. No Broker exists, so the right answer is broker_unavailable.
  Step 'cp2_pipe_client_helper' {
    if (-not $shape.Ok) { return @{ Result = (New-CpResult 'BLOCKED' 'token_shape_not_as_intended'); Evidence = @('see cp0_token') } }
    $a = Invoke-CpJob $CpSvc 'helper-pid' $Helper @() (New-HelperInput 'helper-pid' ([ordered]@{ ownerSid = 'S-1-5-18'; pid = 4 })) $null
    $b = Invoke-CpJob $CpSvc 'helper-service' $Helper @() (New-HelperInput 'helper-service' ([ordered]@{ serviceName = $CpSvc })) $null
    @{ Result = (Get-CpHelperVerdict (Get-LastObject $a '') (Get-LastObject $b '') ((-not $a.Error) -and (-not $b.Error))); Evidence = ((ConvertTo-JobEvidence $a) + (ConvertTo-JobEvidence $b)) }
  }

  # ---- cp3 and cp4: DPAPI. The blob goes through the admin (config\ is readable by every lab account), so the other identities can try it.
  Step 'cp3_dpapi_currentuser' {
    if (-not $shape.Ok) { return @{ Result = (New-CpResult 'BLOCKED' 'token_shape_not_as_intended'); Evidence = @('see cp0_token') } }
    $job = Invoke-CpJob $CpSvc 'dpapi' $Shim @('cp', 'dpapi-protect', $Entropy) $null 'cp'
    $State.ProtectLine = Get-LastObject $job 'dpapi-protect'
    $evidence = ConvertTo-JobEvidence $job
    @{ Result = (Get-CpDpapiVerdict $State.ProtectLine (-not $job.Error)); Evidence = ($evidence | ForEach-Object { $_ -replace '"blobBase64":"[^"]*"', '"blobBase64":"<omitted>"' }) }
  }
  Step 'cp3_profile' { @{ Result = (Get-CpProfileObservation $State.ProtectLine); Evidence = @(($State.ProtectLine.profile | ConvertTo-Json -Compress -Depth 4)) } }

  Step 'cp4_dpapi_other_identity_refused' {
    $protectLine = $State.ProtectLine
    if ($null -eq $protectLine -or $protectLine.ok -ne $true) { return @{ Result = (New-CpResult 'BLOCKED' 'no_blob_to_try'); Evidence = @('cp3_dpapi_currentuser made no blob') } }
    $protectLine.blobBase64 | Set-Content -Encoding Ascii -Path $BlobFile
    $tryArgs = @('cp', 'dpapi-unprotect', $BlobFile, $Entropy, [string]$protectLine.plaintextSha256)
    $other = Invoke-CpJob $OtherSvc 'dpapi' $Shim $tryArgs $null 'cp'
    $person = Invoke-CpJob $HolderSvc 'dpapi' $Shim $tryArgs $null 'cp'
    $admin = Invoke-ProbeAdmin $tryArgs
    $results = @(@{ Name = 'other_virtual_account'; Line = (Get-LastObject $other 'dpapi-unprotect') }, @{ Name = 'local_user'; Line = (Get-LastObject $person 'dpapi-unprotect') }, @{ Name = 'administrator'; Line = $admin })
    @{ Result = (Get-CpOtherIdentityVerdict $results); Evidence = ((ConvertTo-JobEvidence $other @('--- other virtual account')) + (ConvertTo-JobEvidence $person @('--- plain local user')) + @('--- administrator', ($admin | ConvertTo-Json -Compress))) }
  }

  # ---- cp5: loopback TCP. The service listens (job stays up); the shareholder stand-in (a service of its own) and Administrator connect.
  Step 'cp5_tcp_loopback_other_user' {
    if (-not $shape.Ok) { return @{ Result = (New-CpResult 'BLOCKED' 'token_shape_not_as_intended'); Evidence = @('see cp0_token') } }
    $listen = Start-CpJob $CpSvc 'tcp' $Shim @('cp', 'tcp-listen', "$TcpListenSeconds", '2') $null
    $ready = $null
    if (-not $listen.Error) {
      try { Wait-Until { @(Read-ResultLines $listen.ResultFile | Where-Object { $_ -like '*"id":"tcp-listen"*' -and ($_ -like '*"state":"ready"*' -or $_ -like '*"state":"error"*') }).Count -gt 0 } 30 'the listener' } catch { $listen.Error = Get-AsciiText $_.Exception.Message }
      $ready = @(Read-ResultLines $listen.ResultFile | Where-Object { $_ -like '{*"state":"ready"*' -or $_ -like '{*"state":"error"*' } | Select-Object -First 1 | ForEach-Object { $_ | ConvertFrom-Json }) | Select-Object -First 1
    }
    $clients = @()
    if ($ready -and [string]$ready.state -eq 'ready') {
      $connect = @('cp', 'tcp-connect', [string]$ready.port)
      $person = Invoke-CpJob $HolderSvc 'tcp' $Shim ($connect + @('local_user', "$TcpClientSeconds")) $null 'cp'
      $admin = Invoke-ProbeAdmin ($connect + @('administrator', "$TcpClientSeconds"))
      $clients = @(@{ Name = 'local_user'; Line = (Get-LastObject $person 'tcp-connect') }, @{ Name = 'administrator'; Line = $admin })
    }
    $done = Complete-CpJob $listen 'cp'
    @{ Result = (Get-CpTcpVerdict $ready $clients); Evidence = ((ConvertTo-JobEvidence $done) + @($clients | ForEach-Object { "$($_.Name): " + ($_.Line | ConvertTo-Json -Compress) })) }
  }

  # ---- cp6: a ProgramData file with a protected DACL. The folder is made by the admin like an installer would (inherits ProgramData's ACL, then the service SID gets Modify).
  Step 'cp6_programdata_acl' {
    if (-not $shape.Ok) { return @{ Result = (New-CpResult 'BLOCKED' 'token_shape_not_as_intended'); Evidence = @('see cp0_token') } }
    New-Item -ItemType Directory -Force -Path $ProgramDataDir | Out-Null
    Grant-Path $ProgramDataDir $cpSid 'M'
    $create = Invoke-CpJob $CpSvc 'acl' $Shim @('cp', 'acl-file', $ProgramDataFile, $cpSid, $holderSid) $null 'cp'
    $acl = Get-LastObject $create 'acl-file'
    $holderRead = $null; $holderWrite = $null; $otherRead = $null
    $evidence = ConvertTo-JobEvidence $create
    if ($acl -and $acl.ok -eq $true) {
      $r = Invoke-CpJob $HolderSvc 'read' $Shim @('cp', 'file-access', $ProgramDataFile, 'read') $null 'cp'
      $w = Invoke-CpJob $HolderSvc 'write' $Shim @('cp', 'file-access', $ProgramDataFile, 'write') $null 'cp'
      $o = Invoke-CpJob $OtherSvc 'read' $Shim @('cp', 'file-access', $ProgramDataFile, 'read') $null 'cp'
      $holderRead = (Get-LastObject $r 'file-access').outcome; $holderWrite = (Get-LastObject $w 'file-access').outcome; $otherRead = (Get-LastObject $o 'file-access').outcome
      $evidence += (ConvertTo-JobEvidence $r @('--- shareholder read')) + (ConvertTo-JobEvidence $w @('--- shareholder write')) + (ConvertTo-JobEvidence $o @('--- other virtual account read'))
    }
    @{ Result = (Get-CpAclVerdict $acl $cpSid $holderSid $holderRead $holderWrite $otherRead (-not $create.Error)); Evidence = $evidence }
  }

  # ---- cp7: outbound HTTPS
  Step 'cp7_outbound_https' {
    if (-not $shape.Ok) { return @{ Result = (New-CpResult 'BLOCKED' 'token_shape_not_as_intended'); Evidence = @('see cp0_token') } }
    $job = Invoke-CpJob $CpSvc 'https' $Shim @('cp', 'https', $HttpsUrl, "$HttpsSeconds") $null 'cp'
    @{ Result = (Get-CpHttpsVerdict (Get-LastObject $job 'https') (-not $job.Error)); Evidence = (ConvertTo-JobEvidence $job) }
  }
}

# Lab cleanup inside the run: the stand-in services stop here so a host that keeps the VM sees none running. The user, the ProgramData folder and the lab root go with `cleanup` (or with the VM).
foreach ($n in $Everything) { try { Stop-LabService $n } catch { } }

$unexpected = @(Get-CpUnexpected $checks)
Emit-Json ([ordered]@{ nodeSource = (Get-AsciiText $NodeSource); setupError = $setupError; unexpected = $unexpected; checks = @($checks) })
