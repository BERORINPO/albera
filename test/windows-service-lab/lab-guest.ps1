# Issue #23 service-identity lab, GUEST side. Runs INSIDE the disposable lab VM as Administrator (Windows PowerShell 5.1),
# started by run-lab.ps1 over PowerShell Direct. ASCII only.
#   lab-guest.ps1 <LabRoot> run        create three services + ACLs, run checks a-f, write <LabRoot>\evidence\results.json
#   lab-guest.ps1 <LabRoot> rollback   stop and delete the three services, remove <LabRoot>, compare against the pre-run snapshot
# STATUS: this script was written by an agent whose harness refused to run any PowerShell, so it has NEVER been executed or even
# parse-checked. Expect first-run fixes; the C# tool and the Broker ACE it drives are tested (npm test).
param(
  [Parameter(Mandatory = $true)][string]$LabRoot,
  [Parameter(Mandatory = $true)][ValidateSet('run', 'rollback')][string]$Phase
)
$ErrorActionPreference = 'Stop'

$B = 'AlberaHostBroker'; $C = 'AlberaControlPlane'; $O = 'AlberaLabOther'; $All = @($B, $C, $O)
$Pipe = 'ALBERA_Lab23_HostBroker'
$Shim = "$LabRoot\bin\shim\albera-lab-service-shim.exe"
$BrokerDll = "$LabRoot\bin\broker\albera-windows-broker.dll"
$Helper = "$LabRoot\bin\helper\albera-windows-broker-pipe-client.exe"
$Db1 = "$LabRoot\data\broker\journal-1.sqlite"
$Db2 = "$LabRoot\data\broker\journal-2.sqlite"

function Get-Sid([string]$account) { (New-Object System.Security.Principal.NTAccount($account)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
function Get-Svc([string]$name) { Get-CimInstance Win32_Service -Filter "Name='$name'" }
function Wait-Until([scriptblock]$condition, [int]$seconds, [string]$what) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { if (& $condition) { return }; Start-Sleep -Milliseconds 200 }
  throw "timeout waiting for $what"
}
function Stop-LabService([string]$name) {
  $svc = Get-Svc $name
  if ($svc -and $svc.State -ne 'Stopped') {
    & sc.exe stop $name | Out-Null
    Wait-Until { (Get-Svc $name).State -eq 'Stopped' } 30 "$name stopped"
  }
}

if ($Phase -eq 'rollback') {
  $report = [ordered]@{ servicesDeleted = @(); servicesAbsent = $true; labRootRemoved = $false; unexpectedDelta = @() }
  foreach ($n in $All) {
    if (Get-Svc $n) { Stop-LabService $n; & sc.exe delete $n | Out-Null; $report.servicesDeleted += $n }
  }
  Start-Sleep -Seconds 2
  foreach ($n in $All) { if (Get-Svc $n) { $report.servicesAbsent = $false } }
  $snapshot = "$LabRoot\evidence\preflight-services.txt"
  if (Test-Path $snapshot) {
    $before = @(Get-Content $snapshot); $after = @(Get-Service | ForEach-Object { $_.Name })
    $report.unexpectedDelta = @(Compare-Object $before $after | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" })
  }
  Remove-Item -Recurse -Force -Path $LabRoot -ErrorAction Continue
  $report.labRootRemoved = -not (Test-Path $LabRoot)
  $report | ConvertTo-Json
  return
}

# ------------------------------------------------------------------ run phase
$checks = New-Object System.Collections.ArrayList
function Add-Check([string]$id, [string]$title, [string]$status, [string[]]$evidence) {
  [void]$checks.Add([ordered]@{ id = $id; title = $title; status = $status; evidence = @($evidence) })
}
function Verdict([bool]$ok, [string[]]$evidence) { @{ Status = $(if ($ok) { 'PASS' } else { 'FAIL' }); Evidence = $evidence } }
function Step([string]$id, [string]$title, [scriptblock]$body) {
  try { $r = & $body; Add-Check $id $title $r.Status $r.Evidence }
  catch { Add-Check $id $title 'FAIL' @("exception: $($_.Exception.Message)") }
}
function Names($list) { (@($list | ForEach-Object { if ($_.name) { $_.name } else { $_.sid } }) -join ', ') }

function Get-ResultPath([string]$svc, [string]$tag) { "$LabRoot\results\$svc\$tag.txt" }
function Read-Result([string]$svc, [string]$tag) { $p = Get-ResultPath $svc $tag; if (Test-Path $p) { @(Get-Content $p) } else { @() } }
function Wait-Line([string]$svc, [string]$tag, [string]$pattern, [int]$seconds = 30) {
  Wait-Until { @(Read-Result $svc $tag | Where-Object { $_ -match $pattern }).Count -gt 0 } $seconds "$svc/$tag /$pattern/"
}
function Get-Json([string[]]$lines) { @($lines | Where-Object { $_ -like '{*' } | ForEach-Object { $_ | ConvertFrom-Json }) }
function Get-LastJson([string]$svc, [string]$tag) { Get-Json (Read-Result $svc $tag) | Select-Object -Last 1 }

# One job per service start: write the config the shim reads, `sc start`, optionally wait for STOPPED.
function Invoke-LabJob([string]$svc, [string]$tag, [hashtable]$job, [switch]$NoWait) {
  Stop-LabService $svc
  $cfg = @{ resultFile = (Get-ResultPath $svc $tag); tokenFile = "$LabRoot\results\$svc\$tag.token.json" }
  foreach ($k in $job.Keys) { $cfg[$k] = $job[$k] }
  ($cfg | ConvertTo-Json -Depth 5) | Set-Content -Encoding Ascii -Path "$LabRoot\config\$svc.json"
  & sc.exe start $svc | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc start $svc failed ($LASTEXITCODE)" }
  if (-not $NoWait) { Wait-Until { (Get-Svc $svc).State -eq 'Stopped' } 90 "$svc/$tag finished" }
}
function Invoke-ProbeAs([string]$svc, [string]$tag, [string[]]$probeArgs) {
  Invoke-LabJob $svc $tag @{ mode = 'child'; program = $Shim; args = $probeArgs }
  Get-LastJson $svc $tag
}
function Invoke-ProbeAdmin([string[]]$probeArgs) { (& $Shim @probeArgs) | ConvertFrom-Json }
function New-HelperInput([string]$tag, $signed, [hashtable]$expect) {
  $path = "$LabRoot\inputs\$tag.stdin.json"
  (@{ pipeName = $Pipe; receipt = $signed.receipt; signature = $signed.signature; timeoutMs = 10000; expect = $expect } | ConvertTo-Json -Depth 4 -Compress) | Set-Content -Encoding Ascii -Path $path
  $path
}
function Invoke-HelperAs([string]$svc, [string]$tag, $signed, [hashtable]$expect) {
  Invoke-LabJob $svc $tag @{ mode = 'child'; program = $Helper; stdinFile = (New-HelperInput $tag $signed $expect) }
  Get-LastJson $svc $tag
}
function Invoke-HelperAdmin([string]$tag, $signed, [hashtable]$expect) {
  (Get-Content -Raw (New-HelperInput $tag $signed $expect) | & $Helper) | ConvertFrom-Json
}
# The Broker runs IN the shim process (mode inproc), so the PID SCM reports is the PID that creates the pipe.
function Start-LabBroker([string]$tag, [string]$db, $signed) {
  Invoke-LabJob $B $tag @{ mode = 'inproc'; program = $BrokerDll; args = @('serve', $Pipe, $db, $signed.publicKey, $script:SidC, '7', 'normal') } -NoWait
  Wait-Line $B $tag '^BROKER_READY$' 30
  [int](Get-Svc $B).ProcessId
}
function Get-ClaimCount([string]$db, [string]$tag) {
  Invoke-LabJob $B $tag @{ mode = 'inproc'; program = $BrokerDll; args = @('inspect', $db) }
  [int](@(Read-Result $B $tag | Where-Object { $_ -match '^\d+$' })[0])
}
function Start-AdminSquatter([string]$tag) {
  $out = "$LabRoot\evidence\$tag.squat.txt"
  $p = Start-Process -FilePath $Shim -ArgumentList @('squat', $Pipe, '60') -RedirectStandardOutput $out -NoNewWindow -PassThru
  Wait-Until { (Test-Path $out) -and ((Get-Content $out -Raw) -match '"ready"') } 20 'administrator squatter ready'
  @{ Process = $p; Out = $out }
}
function Stop-AdminSquatter($squatter) {
  if (-not $squatter.Process.WaitForExit(15000)) { $squatter.Process.Kill() }
  Get-Json (Get-Content $squatter.Out) | Select-Object -Last 1
}
function Set-LabAcl([string]$path, [string[]]$grants) {
  New-Item -ItemType Directory -Force -Path $path | Out-Null
  $a = @($path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '/grant:r', '*S-1-5-32-544:(OI)(CI)F')
  foreach ($g in $grants) { $a += @('/grant:r', $g) }
  & icacls.exe @a | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed for $path" }
}

# ---- preflight: new names, new roots, snapshot of what exists now (compared again by the rollback phase)
foreach ($n in $All) { if (Get-Svc $n) { throw "service $n already exists; refusing to touch it" } }
if (Test-Path "$LabRoot\config") { throw 'lab root already prepared; refusing to reuse it' }
New-Item -ItemType Directory -Force -Path "$LabRoot\evidence" | Out-Null
@(Get-Service | ForEach-Object { $_.Name }) | Set-Content -Encoding Ascii "$LabRoot\evidence\preflight-services.txt"
$os = Get-CimInstance Win32_OperatingSystem
$ubr = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').UBR
$adminSession = (Get-Process -Id $PID).SessionId
$inputs = Get-Content -Raw "$LabRoot\inputs\lab-inputs.json" | ConvertFrom-Json
$hashes = [ordered]@{
  shimExe = (Get-FileHash $Shim -Algorithm SHA256).Hash.ToLower(); brokerDll = (Get-FileHash $BrokerDll -Algorithm SHA256).Hash.ToLower()
  brokerExe = (Get-FileHash "$LabRoot\bin\broker\albera-windows-broker.exe" -Algorithm SHA256).Hash.ToLower(); helperExe = (Get-FileHash $Helper -Algorithm SHA256).Hash.ToLower()
}

# ---- services: own process, virtual accounts, restricted service SID; the Broker service object grants the Control Plane exactly SERVICE_QUERY_STATUS
foreach ($n in $All) {
  & sc.exe create $n binPath= "$Shim service $LabRoot\config\$n.json" obj= "NT SERVICE\$n" start= demand type= own | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc create $n failed ($LASTEXITCODE)" }
  & sc.exe sidtype $n restricted | Out-Null
}
$SidB = Get-Sid "NT SERVICE\$B"; $SidC = Get-Sid "NT SERVICE\$C"; $SidO = Get-Sid "NT SERVICE\$O"
& sc.exe sdset $B "D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LC;;;${SidC})" | Out-Null
$svcSids = @("*${SidB}", "*${SidC}", "*${SidO}")
Set-LabAcl $LabRoot ($svcSids | ForEach-Object { "${_}:RX" })
Set-LabAcl "$LabRoot\bin" ($svcSids | ForEach-Object { "${_}:(OI)(CI)RX" })
Set-LabAcl "$LabRoot\config" ($svcSids | ForEach-Object { "${_}:(OI)(CI)RX" })
Set-LabAcl "$LabRoot\inputs" @("*${SidC}:(OI)(CI)RX", "*${SidO}:(OI)(CI)RX")
Set-LabAcl "$LabRoot\results" ($svcSids | ForEach-Object { "${_}:RX" })
Set-LabAcl "$LabRoot\data" ($svcSids | ForEach-Object { "${_}:RX" })
Set-LabAcl "$LabRoot\data\broker" @("*${SidB}:(OI)(CI)M")
Set-LabAcl "$LabRoot\data\cp" @("*${SidC}:(OI)(CI)M")
Set-LabAcl "$LabRoot\evidence" @()
foreach ($pair in @(@($B, $SidB), @($C, $SidC), @($O, $SidO))) { Set-LabAcl "$LabRoot\results\$($pair[0])" @("*$($pair[1]):(OI)(CI)M") }

Step 'setup_services' 'Own-process services under virtual accounts with restricted service SID' {
  $ev = @(); $ok = $true
  foreach ($n in $All) {
    $s = Get-Svc $n
    $sid = (& sc.exe qsidtype $n) -join ' '
    $ev += "$n StartName=$($s.StartName) ServiceType=$($s.ServiceType) sidtype: $(($sid -replace '\s+', ' ').Trim())"
    if ($s.StartName -ne "NT SERVICE\$n" -or $sid -notmatch 'RESTRICTED') { $ok = $false }
  }
  $ev += 'Broker service SDDL: ' + (((& sc.exe sdshow $B) -join '').Trim())
  Verdict $ok $ev
}

$R1 = $inputs.r1; $R2 = $inputs.r2; $R3 = $inputs.r3

# ---- Broker run 1: an unconsumed pipe. Everything that must NOT connect goes first; the single allowed open (it uses the Broker's one connection) goes last.
$script:Pid1 = $null
Step 'run1_broker_ready' 'Broker service starts, creates its pipe and prints BROKER_READY' {
  $script:Pid1 = Start-LabBroker 'run1' $Db1 $R1
  Verdict ($script:Pid1 -gt 0) @("service pid=$($script:Pid1)", ((Read-Result $B 'run1') -join ' | '))
}
Step 'c_other_principals_denied' 'Other principals cannot use the Broker pipe (DACL) or the helper in service mode' {
  $adm = Invoke-ProbeAdmin @('pipe-open', $Pipe, '00120083')
  $oth = Invoke-ProbeAs $O 'other-open' @('pipe-open', $Pipe, '00120083')
  $hAdm = Invoke-HelperAdmin 'helper-admin' $R2 @{ serviceName = $B }
  $hOth = Invoke-HelperAs $O 'helper-other' $R2 @{ serviceName = $B }
  $ok = ($adm.result -eq 'denied') -and ($oth.result -eq 'denied') -and ($hAdm.code -eq 'access_denied') -and ($hOth.code -in @('server_identity_unavailable', 'access_denied'))
  Verdict $ok @("interactive Administrator open 0x00120083: $($adm.result)", "third virtual account open 0x00120083: $($oth.result)",
    "helper as Administrator (service mode): $($hAdm | ConvertTo-Json -Compress)", "helper as third account (service mode): $($hOth | ConvertTo-Json -Compress)")
}
Step 'a_pipe_acl' 'Live Broker pipe: owner = Broker SID, DACL = Broker + one Control Plane ACE 0x00120083, session 0' {
  $open = Invoke-ProbeAs $C 'cp-open' @('pipe-open', $Pipe, '00120083') # uses up Broker run 1
  $aces = @([regex]::Matches([string]$open.sddl, '\(A;;([^;]+);;;(S-1-[0-9-]+)\)') | ForEach-Object { @{ Mask = $_.Groups[1].Value; Sid = $_.Groups[2].Value } })
  $cpAce = @($aces | Where-Object { $_.Sid -eq $SidC })
  $ok = ($open.result -eq 'opened') -and ($open.owner -eq $SidB) -and ($aces.Count -eq 2) -and (@($aces | Where-Object { $_.Sid -eq $SidB }).Count -eq 1) `
    -and ($cpAce.Count -eq 1) -and ($cpAce[0].Mask -ieq '0x120083') -and ($open.serverSession -eq 0) -and ($open.serverPid -eq $script:Pid1)
  Verdict $ok @("open as Control Plane: $($open.result)", "owner=$($open.owner) (Broker SID $SidB)", "sddl=$($open.sddl)", "serverPid=$($open.serverPid) servicePid=$($script:Pid1) serverSession=$($open.serverSession)")
}
Step 'a_effective_access' 'Control Plane account: 0x00120083 may open, GENERIC_WRITE and FILE_APPEND_DATA may not (fresh Broker run per probe)' {
  $r = @{}
  foreach ($p in @(@($C, 'cp-denied-write', '40000000'), @($C, 'cp-denied-append', '00000004'), @($O, 'other-append', '00000004'), @($C, 'cp-readctl-append', '00020004'))) {
    $null = Start-LabBroker ('eff-' + $p[1]) $Db2 $R3
    $r[$p[1]] = Invoke-ProbeAs $p[0] $p[1] @('pipe-open', $Pipe, $p[2])
    Stop-LabService $B
  }
  # Observed on Windows Server 2025 (2026-10-30): NPFS does not deny FILE_APPEND_DATA (0x4) on a CLIENT open even though the DACL grants it to
  # nobody but the Broker; a principal without any ACE is still denied. A client handle cannot create a server instance (that is CreateNamedPipe,
  # refused by max instances = 1 + FILE_FLAG_FIRST_PIPE_INSTANCE, see d3). So the check is GENERIC_WRITE denied + no-ACE principal denied; 0x4 is evidence.
  Verdict (($r['cp-denied-write'].result -eq 'denied') -and ($r['other-append'].result -eq 'denied')) @(
    "GENERIC_WRITE (0x40000000) as CP: $($r['cp-denied-write'].result)", "FILE_APPEND_DATA (0x4) as CP: $($r['cp-denied-append'].result)",
    "FILE_APPEND_DATA (0x4) as third account (no ACE): $($r['other-append'].result)", "READ_CONTROL|FILE_APPEND_DATA as CP: $($r['cp-readctl-append'].result) sddl=$($r['cp-readctl-append'].sddl)")
}
Step 'a_token' 'Service process tokens: virtual-account user, restricting SIDs, no admin group, session 0' {
  $ev = @(); $ok = $true
  foreach ($t in @(@('Broker', "$LabRoot\results\$B\run1.token.json", $SidB), @('ControlPlane', "$LabRoot\results\$C\cp-open.token.json", $SidC))) {
    $tok = Get-Content -Raw $t[1] | ConvertFrom-Json
    $restricted = @($tok.restrictedSids | ForEach-Object { $_.sid })
    $enabled = @($tok.groups | Where-Object { $_.attributes -contains 'enabled' })
    $ev += "$($t[0]) user=$($tok.user.name) session=$($tok.sessionId) integrity=$($tok.integrity) hasRestrictions=$($tok.hasRestrictions) elevated=$($tok.elevated)"
    $ev += "$($t[0]) restrictedSids=$(Names $tok.restrictedSids)"
    $ev += "$($t[0]) enabledGroups=$(Names $enabled)"
    $ev += "$($t[0]) enabledPrivileges=$((@($tok.privileges | Where-Object { $_.enabled } | ForEach-Object { $_.name })) -join ', ')"
    if ($tok.user.sid -ne $t[2] -or $tok.sessionId -ne 0 -or $restricted -notcontains $t[2] -or $restricted -notcontains 'S-1-1-0' -or ($enabled | Where-Object { $_.sid -eq 'S-1-5-32-544' })) { $ok = $false }
  }
  Verdict $ok $ev
}

# ---- Broker run 2: the positive path (b) on journal 1
$script:Pid2 = $null
Step 'b_positive' 'Control Plane helper in service mode: ok, exactly one journal claim' {
  $script:Pid2 = Start-LabBroker 'run2' $Db1 $R1
  $res = Invoke-HelperAs $C 'helper-cp-ok' $R1 @{ serviceName = $B }
  Wait-Until { (Get-Svc $B).State -eq 'Stopped' } 30 'broker run 2 ends'
  $claims = Get-ClaimCount $Db1 'inspect1'
  $log = Read-Result $B 'run2'
  $ok = ($res.ok -eq $true) -and ($res.state -eq 'UNKNOWN') -and ($claims -eq 1) -and ($log -contains 'PEER=authenticated') -and ($log -contains 'CLAIM=PERSISTED_UNKNOWN')
  Verdict $ok @("helper result: $($res | ConvertTo-Json -Compress)", "journal claims=$claims", "broker log: $($log -join ' | ')")
}

# ---- Broker run 3: SCM query rights, OpenProcess across accounts and the image-hash variant (e) on journal 2
Step 'e_scm_query_status' 'SCM PID lookup needs only SC_MANAGER_CONNECT + SERVICE_QUERY_STATUS, and nothing more is granted' {
  $script:Pid3 = Start-LabBroker 'run3' $Db2 $R3
  $scmC = Invoke-ProbeAs $C 'cp-scm' @('scm', $B)
  $scmO = Invoke-ProbeAs $O 'other-scm' @('scm', $B)
  $masks = $scmC.openService
  $ok = ($scmC.SC_MANAGER_CONNECT -eq 'opened') -and ($masks.SERVICE_QUERY_STATUS -eq 'opened') -and ($scmC.state -eq 'RUNNING') -and ($scmC.pid -eq $script:Pid3) `
    -and ($masks.SERVICE_START -eq 'denied') -and ($masks.SERVICE_STOP -eq 'denied') -and ($masks.SERVICE_CHANGE_CONFIG -eq 'denied') -and ($masks.DELETE -eq 'denied') -and ($masks.SERVICE_ALL_ACCESS -eq 'denied') `
    -and ($scmO.openService.SERVICE_QUERY_STATUS -eq 'denied')
  Verdict $ok @("Control Plane: connect=$($scmC.SC_MANAGER_CONNECT) state=$($scmC.state) pid=$($scmC.pid) (service pid $($script:Pid3))", "Control Plane OpenService masks: $($masks | ConvertTo-Json -Compress)",
    "third account QUERY_STATUS: $($scmO.openService.SERVICE_QUERY_STATUS) (the helper then fails closed with server_identity_unavailable)")
}
Step 'e_openprocess_image_hash' 'Cross-account OpenProcess for the image hash: record allowed or denied, and that the helper follows it' {
  $opC = Invoke-ProbeAs $C 'cp-openproc' @('openproc', "$($script:Pid3)")
  $allowed = $opC.openProcess.PROCESS_QUERY_LIMITED_INFORMATION -eq 'opened'
  $res = Invoke-HelperAs $C 'helper-cp-hash' $R3 @{ serviceName = $B; imageSha256 = $hashes.shimExe } # the SCM process image is the shim (Broker hosted in process)
  $consistent = if ($allowed) { $res.ok -eq $true } else { $res.code -eq 'server_identity_unavailable' }
  Stop-LabService $B
  Verdict $consistent @("Control Plane OpenProcess masks on the Broker service process: $($opC.openProcess | ConvertTo-Json -Compress)", "image sha256 readable by Control Plane: $(if ($allowed) { 'yes' } else { 'no' })",
    "helper with imageSha256: $($res | ConvertTo-Json -Compress)")
}
Step 'e_session0' 'Broker pipe server runs in session 0; an interactive-session lookalike cannot be built to reach that check' {
  @{ Status = 'BLOCKED'; Evidence = @("Broker token session and pipe server session are recorded in a_token / a_pipe_acl (both expected 0). A lookalike must first match the owner SID and the SCM PID, which the owner check already refuses (d2); the session-0 branch is reachable only with a forged owner and PID, so no honest negative test exists.", "PowerShell Direct session id of the Administrator probes: $adminSession") }
}

# ---- Broker run 4: restart and replay (f)
Step 'f_restart_replay' 'Restarted Broker service: the same receipt is denied, still one journal claim' {
  $pid4 = Start-LabBroker 'run4' $Db1 $R1
  $res = Invoke-HelperAs $C 'helper-cp-replay' $R1 @{ serviceName = $B }
  Wait-Until { (Get-Svc $B).State -eq 'Stopped' } 30 'broker run 4 ends'
  $claims = Get-ClaimCount $Db1 'inspect2'
  $log = Read-Result $B 'run4'
  $ok = ($res.ok -eq $false) -and ($res.code -eq 'denied') -and ($log -contains 'DENY=duplicate') -and ($claims -eq 1) -and ($pid4 -ne $script:Pid2)
  Verdict $ok @("helper result: $($res | ConvertTo-Json -Compress)", "broker log: $($log -join ' | ')", "journal claims=$claims", "service pid run 2=$($script:Pid2) run 4=$pid4")
}

# ---- squatters (d)
Step 'd1_squatter_broker_stopped' 'Broker service stopped, administrator squats the pipe name: helper refuses before sending' {
  Stop-LabService $B
  $s = Start-AdminSquatter 'd1'
  $res = Invoke-HelperAs $C 'helper-d1' $R2 @{ serviceName = $B }
  $sq = Stop-AdminSquatter $s
  # The helper stops at the SCM lookup before connecting, so the squatter may never report a connection: absent = 0 bytes.
  $ok = ($res.code -in @('server_identity_mismatch', 'server_identity_unavailable')) -and (-not $sq.bytesReceived)
  Verdict $ok @("helper: $($res | ConvertTo-Json -Compress) (the plan expected server_identity_mismatch; with the service not RUNNING the SCM lookup fails first, so the code is server_identity_unavailable, still pre-send)", "squatter: $($sq | ConvertTo-Json -Compress)")
}
Invoke-LabJob $B 'd2' @{ mode = 'inproc'; program = $BrokerDll; args = @('inspect', $Db1); linger = $true } -NoWait # service stays RUNNING, but owns no pipe
Wait-Line $B 'd2' 'staying RUNNING'
Step 'd2_squatter_administrator' 'Service RUNNING, administrator squats the name: server_identity_mismatch, squatter receives 0 bytes' {
  $s = Start-AdminSquatter 'd2'
  $res = Invoke-HelperAs $C 'helper-d2' $R2 @{ serviceName = $B }
  $sq = Stop-AdminSquatter $s
  Verdict (($res.code -eq 'server_identity_mismatch') -and ($sq.bytesReceived -eq 0)) @("helper: $($res | ConvertTo-Json -Compress)", "squatter (interactive Administrator): $($sq | ConvertTo-Json -Compress)")
}
Step 'd3_squatter_service_account' 'Service RUNNING, a third service account squats the name: server_identity_mismatch, squatter receives 0 bytes' {
  Invoke-LabJob $O 'd3-squat' @{ mode = 'child'; program = $Shim; args = @('squat', $Pipe, '60') } -NoWait
  Wait-Line $O 'd3-squat' '"ready"' 20
  $res = Invoke-HelperAs $C 'helper-d3' $R2 @{ serviceName = $B }
  Wait-Until { (Get-Svc $O).State -eq 'Stopped' } 30 'third-account squatter ends'
  $sq = Get-Json (Read-Result $O 'd3-squat') | Where-Object { $_.state -eq 'done' } | Select-Object -Last 1
  Verdict (($res.code -eq 'server_identity_mismatch') -and ($sq.bytesReceived -eq 0)) @("helper: $($res | ConvertTo-Json -Compress)", "squatter (third virtual account): $($sq | ConvertTo-Json -Compress)")
}
Stop-LabService $B

$result = [ordered]@{
  schema = 'albera-issue-23-service-lab/1'
  guest = [ordered]@{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; ubr = $ubr }
  artifacts = $hashes
  checks = $checks
}
$result | ConvertTo-Json -Depth 8 | Set-Content -Encoding Ascii -Path "$LabRoot\evidence\results.json"
$checks | ForEach-Object { "{0,-34} {1}" -f $_.id, $_.status }
