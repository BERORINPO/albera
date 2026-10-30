# Issue #23 service-identity lab, GUEST side. Runs INSIDE the disposable lab VM as Administrator (Windows PowerShell 5.1),
# started by run-lab.ps1 over PowerShell Direct. ASCII only.
#   lab-guest.ps1 <LabRoot> run        create three services + ACLs, run checks a-f, write <LabRoot>\evidence\results.json
#   lab-guest.ps1 <LabRoot> rollback   stop and delete the three services, remove <LabRoot>, compare against the pre-run snapshot
# STATUS: run 3 of 3 (2026-10-30) used the lab shim as the Broker's service host (the Broker assembly loaded in-process); the broker-service-host
# revision ran the REAL Broker as the service (`albera-windows-broker.exe service <config>`) and passed 15 of 16 checks (1 BLOCKED).
# This revision (broker-receipt-v2) moves every request to receipt v2: the Control Plane helper asks the Broker for a challenge (`fence`), this script signs a
# receipt that names it with the lab authority key from lab-inputs.json (ECDsaCng, an ECCPRIVATE blob), and the helper sends it. It has NOT been executed
# yet: the signing and receipt functions were run once on the host under Windows PowerShell 5.1 and checked with the Node contract validator, but no step
# below has run in the VM. Expect first-run fixes; the C# tools, config validation and the serve loop are host-tested (npm test).
# The shim still hosts the Control Plane and the third account, and the Broker service object briefly (check d2, which needs a RUNNING
# Broker service that owns no pipe).
param(
  [Parameter(Mandatory = $true)][string]$LabRoot,
  [Parameter(Mandatory = $true)][ValidateSet('run', 'rollback')][string]$Phase
)
$ErrorActionPreference = 'Stop'

$B = 'AlberaHostBroker'; $C = 'AlberaControlPlane'; $O = 'AlberaLabOther'; $All = @($B, $C, $O)
$Pipe = 'ALBERA_Lab23_HostBroker'
$Shim = "$LabRoot\bin\shim\albera-lab-service-shim.exe"
$BrokerDll = "$LabRoot\bin\broker\albera-windows-broker.dll"
$BrokerExe = "$LabRoot\bin\broker\albera-windows-broker.exe"
$BrokerConfig = "$LabRoot\config\$B.service.json"   # read by the real Broker service (JSON keys: pipeName, database, authorityKeys [{kid, spki}], controlPlaneSid, generation)
$BinPathBroker = "$BrokerExe service $BrokerConfig"
$BinPathShim = "$Shim service $LabRoot\config\$B.json"
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
# $request is a claim (an object with receipt and signature) or a fence ({ fence = <computerId> }); the helper takes exactly one of the two.
function New-HelperInput([string]$tag, $request, [hashtable]$expect) {
  $path = "$LabRoot\inputs\$tag.stdin.json"
  $body = [ordered]@{ pipeName = $Pipe }
  if ($request.fence) { $body.fence = [string]$request.fence } else { $body.receipt = $request.receipt; $body.signature = $request.signature }
  $body.timeoutMs = 10000; $body.expect = $expect
  ($body | ConvertTo-Json -Depth 4 -Compress) | Set-Content -Encoding Ascii -Path $path
  $path
}
function Invoke-HelperAs([string]$svc, [string]$tag, $request, [hashtable]$expect) {
  Invoke-LabJob $svc $tag @{ mode = 'child'; program = $Helper; stdinFile = (New-HelperInput $tag $request $expect) }
  Get-LastJson $svc $tag
}
function Invoke-HelperAdmin([string]$tag, $request, [hashtable]$expect) {
  (Get-Content -Raw (New-HelperInput $tag $request $expect) | & $Helper) | ConvertFrom-Json
}
# Which program the Broker service object runs: the REAL Broker (service host) or, for check d2 only, the shim.
function Set-BrokerServiceHost([string]$which) {
  Stop-LabService $B
  $bin = if ($which -eq 'broker') { $BinPathBroker } else { $BinPathShim }
  & sc.exe config $B binPath= $bin | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc config $B failed ($LASTEXITCODE)" }
}
function Write-BrokerConfig([string]$db, [string]$controlPlaneSid) {
  $keys = @([ordered]@{ kid = $Authority.kid; spki = $Authority.spki })
  $cfg = [ordered]@{ pipeName = $Pipe; database = $db; authorityKeys = $keys; controlPlaneSid = $controlPlaneSid; generation = 7 }
  ($cfg | ConvertTo-Json -Compress -Depth 4) | Set-Content -Encoding Ascii -Path $BrokerConfig
}
function Get-ServiceExit([string]$name) { $s = Get-Svc $name; "state=$($s.State) win32=$($s.ExitCode) specific=$($s.ServiceSpecificExitCode)" }
# The Broker IS the service process (it calls StartServiceCtrlDispatcher itself), so the PID SCM reports is the PID that creates the pipe.
# The service reports RUNNING only after its pipe exists: waiting for RUNNING is the BROKER_READY wait.
function Start-LabBroker([string]$tag, [string]$db) {
  Set-BrokerServiceHost 'broker'
  Write-BrokerConfig $db $script:SidC
  & sc.exe start $B | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc start $B ($tag) failed ($LASTEXITCODE): $(Get-ServiceExit $B)" }
  try { Wait-Until { (Get-Svc $B).State -eq 'Running' } 30 "$B running ($tag)" }
  catch { throw "$($_.Exception.Message): $(Get-ServiceExit $B)" }
  [int](Get-Svc $B).ProcessId
}
# Start the Broker service expecting it to FAIL: returns what SCM recorded (the fatal exit code is the service-specific exit code).
function Start-LabBrokerExpectingFailure([string]$db, [string]$controlPlaneSid) {
  Set-BrokerServiceHost 'broker'
  Write-BrokerConfig $db $controlPlaneSid
  & sc.exe start $B | Out-Null
  Wait-Until { (Get-Svc $B).State -eq 'Stopped' } 30 "$B stopped after a failed start"
  Get-Svc $B
}
# ---- receipt v2 (fence -> sign -> send). The guest signs because a receipt must name a challenge the RUNNING Broker issued, and lives at most 300 seconds.
function New-LabNonce {
  $b = New-Object byte[] 16
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($b); $rng.Dispose()
  ([Convert]::ToBase64String($b)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
# The authority's private key as a CNG ECCPRIVATE blob (BCRYPT_ECDSA_PRIVATE_P256_MAGIC, 32-byte X, Y, d): .NET Framework in Windows PowerShell 5.1 cannot import PKCS#8.
# ECDsaCng.SignData returns the IEEE P1363 pair (r then s, 64 bytes) the Broker verifies.
function Get-LabSigner {
  $key = [System.Security.Cryptography.CngKey]::Import([Convert]::FromBase64String($Authority.privateBlob), [System.Security.Cryptography.CngKeyBlobFormat]::EccPrivateBlob)
  $signer = New-Object System.Security.Cryptography.ECDsaCng($key)
  $signer.HashAlgorithm = [System.Security.Cryptography.CngAlgorithm]::Sha256
  $signer
}
# One signed receipt that names the challenge in $fence (the helper's fence reply). $override replaces fields (a wrong issuer, a reused challenge).
function New-LabReceipt([string]$name, $fence, [hashtable]$override = @{}) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $fields = [ordered]@{
    v = 2; kid = $Authority.kid; issuer = $Authority.issuer; audience = 'albera-host-broker'; purpose = 'broker.operation'
    approvalId = [guid]::NewGuid().ToString(); receiptId = [guid]::NewGuid().ToString(); nonce = (New-LabNonce)
    operationId = "$name-op"; idempotencyKey = "idem-$name"; action = 'synthetic.noop'; actionDigest = $Authority.actionDigest
    projectId = $Authority.projectId; computerId = $Authority.computerId; leaseId = 'test-lease'
    leaseGeneration = [int64]$fence.leaseGeneration; brokerEpoch = [int64]$fence.brokerEpoch; brokerChallenge = [string]$fence.brokerChallenge
    policyVersion = 'test-policy-v1'; approverKeyId = 'lab-approver-1'; iat = [int64]$now; exp = [int64]($now + 240)
  }
  foreach ($k in $override.Keys) { $fields[$k] = $override[$k] }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($fields | ConvertTo-Json -Compress))
  @{ receipt = [Convert]::ToBase64String($bytes); signature = [Convert]::ToBase64String($script:Signer.SignData($bytes)) }
}
# The v2 flow as the Control Plane account: fence, sign, send (three helper jobs). Returns fence (the fence reply), request (what was sent) and result (the claim
# reply, or the fence reply when the fence itself failed, e.g. the helper refused the server before sending anything).
function Invoke-FencedClaim([string]$svc, [string]$tag, [string]$name, [hashtable]$expect, [hashtable]$override = @{}) {
  $fence = Invoke-HelperAs $svc "$tag-fence" @{ fence = $Authority.computerId } $expect
  if ($fence.ok -ne $true) { return @{ fence = $fence; request = $null; result = $fence } }
  $request = New-LabReceipt $name $fence $override
  @{ fence = $fence; request = $request; result = (Invoke-HelperAs $svc $tag $request $expect) }
}
# Claims in a journal, read with the `inspect` verb as the interactive Administrator (the data folder's ACL lets Administrators read it).
function Get-ClaimCount([string]$db) { [int]((& $BrokerExe inspect $db) | Select-Object -First 1) }
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
# The Broker service now refuses (exit 73) a config file or database folder that anyone but SYSTEM / Administrators / its own service SID owns or can
# write, or that sits behind a reparse point (ServicePathGuard.cs). This helper already produces such folders (inheritance removed, SYSTEM and
# Administrators full, the Broker SID Modify on data\broker only, everyone else read-only), and the config file is created by this script as an
# Administrator, so no step needs changing. NOT re-run in the VM since the hardening: a first run should confirm that the real service still starts,
# and an extra check (grant Users write on data\broker, expect 1066 / 73) is the natural next addition.
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
$Authority = $inputs.authority
$script:Signer = Get-LabSigner
$hashes = [ordered]@{
  shimExe = (Get-FileHash $Shim -Algorithm SHA256).Hash.ToLower(); brokerDll = (Get-FileHash $BrokerDll -Algorithm SHA256).Hash.ToLower()
  brokerExe = (Get-FileHash "$LabRoot\bin\broker\albera-windows-broker.exe" -Algorithm SHA256).Hash.ToLower(); helperExe = (Get-FileHash $Helper -Algorithm SHA256).Hash.ToLower()
}

# ---- services: own process, virtual accounts, restricted service SID; the Broker service object grants the Control Plane exactly SERVICE_QUERY_STATUS
foreach ($n in $All) {
  # The Broker service runs the real Broker (`service <config>`); the Control Plane and the third account run the shim.
  $bin = if ($n -eq $B) { $BinPathBroker } else { "$Shim service $LabRoot\config\$n.json" }
  & sc.exe create $n binPath= $bin obj= "NT SERVICE\$n" start= demand type= own | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc create $n failed ($LASTEXITCODE)" }
  & sc.exe sidtype $n restricted | Out-Null
  # ADR-002 accept condition C1 (least privilege): the Broker and the Control Plane need ONLY SeChangeNotifyPrivilege. Without `sc privs` the SCM gives a
  # virtual-account service SeImpersonatePrivilege and SeCreateGlobalPrivilege as well (potato-class escalation risk at high integrity). The Broker's peer
  # check opens the client at SECURITY_IDENTIFICATION, which needs no SeImpersonatePrivilege; check a_token asserts the result and every request check
  # (b, g) proves the service still works without it. The third account (AlberaLabOther) stays as created: it is only a lab stand-in.
  if ($n -ne $O) {
    & sc.exe privs $n SeChangeNotifyPrivilege | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc privs $n failed ($LASTEXITCODE)" }
  }
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

$R2 = $inputs.r2   # never sent to a Broker that could accept it (the pre-send refusals)
$Db3 = "$LabRoot\data\broker\journal-3.sqlite"
$Db4 = "$LabRoot\data\broker\journal-4.sqlite"
$Db5 = "$LabRoot\data\broker\journal-5.sqlite"

# ---- Broker run 1: the real Broker service, started once; the probes below connect to its pipe without sending a request (the service keeps serving).
$script:Pid1 = $null
Step 'run1_broker_ready' 'Real Broker service starts, creates its pipe and only then reports RUNNING' {
  $script:Pid1 = Start-LabBroker 'run1' $Db1
  $svc = Get-Svc $B
  Verdict (($script:Pid1 -gt 0) -and ($svc.State -eq 'Running') -and ($svc.PathName -like "*albera-windows-broker.exe*service*")) @("service pid=$($script:Pid1) state=$($svc.State)", "binPath: $($svc.PathName)")
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
  $open = Invoke-ProbeAs $C 'cp-open' @('pipe-open', $Pipe, '00120083') # connects and leaves without a request; the service drops it and serves on
  $aces = @([regex]::Matches([string]$open.sddl, '\(A;;([^;]+);;;(S-1-[0-9-]+)\)') | ForEach-Object { @{ Mask = $_.Groups[1].Value; Sid = $_.Groups[2].Value } })
  $cpAce = @($aces | Where-Object { $_.Sid -eq $SidC })
  $ok = ($open.result -eq 'opened') -and ($open.owner -eq $SidB) -and ($aces.Count -eq 2) -and (@($aces | Where-Object { $_.Sid -eq $SidB }).Count -eq 1) `
    -and ($cpAce.Count -eq 1) -and ($cpAce[0].Mask -ieq '0x120083') -and ($open.serverSession -eq 0) -and ($open.serverPid -eq $script:Pid1)
  Verdict $ok @("open as Control Plane: $($open.result)", "owner=$($open.owner) (Broker SID $SidB)", "sddl=$($open.sddl)", "serverPid=$($open.serverPid) servicePid=$($script:Pid1) serverSession=$($open.serverSession)")
}
Step 'a_effective_access' 'Control Plane account: 0x00120083 may open, GENERIC_WRITE and FILE_APPEND_DATA may not (same running service)' {
  $r = @{}
  foreach ($p in @(@($C, 'cp-denied-write', '40000000'), @($C, 'cp-denied-append', '00000004'), @($O, 'other-append', '00000004'), @($C, 'cp-readctl-append', '00020004'))) {
    $r[$p[1]] = Invoke-ProbeAs $p[0] $p[1] @('pipe-open', $Pipe, $p[2])
  }
  # Observed on Windows Server 2025 (2026-10-30): NPFS does not deny FILE_APPEND_DATA (0x4) on a CLIENT open even though the DACL grants it to
  # nobody but the Broker; a principal without any ACE is still denied. A client handle cannot create a server instance (that is CreateNamedPipe,
  # refused by max instances = 1 + FILE_FLAG_FIRST_PIPE_INSTANCE, see d3). So the check is GENERIC_WRITE denied + no-ACE principal denied; 0x4 is evidence.
  Verdict (($r['cp-denied-write'].result -eq 'denied') -and ($r['other-append'].result -eq 'denied')) @(
    "GENERIC_WRITE (0x40000000) as CP: $($r['cp-denied-write'].result)", "FILE_APPEND_DATA (0x4) as CP: $($r['cp-denied-append'].result)",
    "FILE_APPEND_DATA (0x4) as third account (no ACE): $($r['other-append'].result)", "READ_CONTROL|FILE_APPEND_DATA as CP: $($r['cp-readctl-append'].result) sddl=$($r['cp-readctl-append'].sddl)")
}
Step 'a_token' 'Service process tokens: virtual-account user, restricting SIDs, no admin group, session 0, only SeChangeNotifyPrivilege' {
  $ev = @(); $ok = $true; $brokerTokenBlocked = $false
  # The Broker token is read off the real Broker service process (token-of, as the interactive Administrator); the Control Plane token comes from the shim's report.
  $brokerToken = Invoke-ProbeAdmin @('token-of', "$($script:Pid1)")
  foreach ($t in @(@('Broker', $brokerToken, $SidB, $B), @('ControlPlane', (Get-Content -Raw "$LabRoot\results\$C\cp-open.token.json" | ConvertFrom-Json), $SidC, $C))) {
    $tok = $t[1]
    if ($tok.result) { $ev += "$($t[0]) token not readable as Administrator: $($tok.result)"; $brokerTokenBlocked = $true; continue }
    $restricted = @($tok.restrictedSids | ForEach-Object { $_.sid })
    $enabled = @($tok.groups | Where-Object { $_.attributes -contains 'enabled' })
    $ev += "$($t[0]) user=$($tok.user.name) session=$($tok.sessionId) integrity=$($tok.integrity) hasRestrictions=$($tok.hasRestrictions) elevated=$($tok.elevated)"
    $ev += "$($t[0]) restrictedSids=$(Names $tok.restrictedSids)"
    $ev += "$($t[0]) enabledGroups=$(Names $enabled)"
    $privNames = @($tok.privileges | ForEach-Object { $_.name })
    $ev += "$($t[0]) enabledPrivileges=$((@($tok.privileges | Where-Object { $_.enabled } | ForEach-Object { $_.name })) -join ', ')"
    $ev += "$($t[0]) allPrivileges=$($privNames -join ', ') (C1: expected exactly SeChangeNotifyPrivilege)"
    $ev += "$($t[0]) sc qprivs: $((& sc.exe qprivs $t[3]) -join ' ')"
    if ($tok.user.sid -ne $t[2] -or $tok.sessionId -ne 0 -or $restricted -notcontains $t[2] -or $restricted -notcontains 'S-1-1-0' -or ($enabled | Where-Object { $_.sid -eq 'S-1-5-32-544' })) { $ok = $false }
    # C1: no SeImpersonatePrivilege, no SeCreateGlobalPrivilege, nothing but SeChangeNotifyPrivilege (any attribute state; -ne is case-insensitive).
    if ($privNames.Count -ne 1 -or $privNames[0] -ne 'SeChangeNotifyPrivilege') { $ok = $false }
  }
  if ($ok -and $brokerTokenBlocked) { @{ Status = 'BLOCKED'; Evidence = $ev } } else { Verdict $ok $ev }
}

# ---- Broker run 2: the positive path (b) on journal 1
$script:Pid2 = $null
Step 'b_positive' 'Control Plane helper in service mode: fence, signed v2 receipt, ok, exactly one journal claim, no replayed key' {
  $script:Pid2 = Start-LabBroker 'run2' $Db1
  $flow = Invoke-FencedClaim $C 'helper-cp-ok' 'lab23-b' @{ serviceName = $B }
  $res = $flow.result
  $stillRunning = (Get-Svc $B).State -eq 'Running' # the real service keeps serving after a request
  Stop-LabService $B
  $claims = Get-ClaimCount $Db1
  $ok = ($flow.fence.ok -eq $true) -and ($flow.fence.brokerEpoch -ge 1) -and ($flow.fence.leaseGeneration -eq 7) -and ($res.ok -eq $true) -and ($res.state -eq 'UNKNOWN') -and ($res.action -eq 'synthetic.noop') -and (-not $res.replayed) -and ($claims -eq 1) -and $stillRunning
  Verdict $ok @("fence: $($flow.fence | ConvertTo-Json -Compress)", "helper result: $($res | ConvertTo-Json -Compress)", "journal claims=$claims", "service still RUNNING after the request: $stillRunning")
}

# ---- Broker run 3: SCM query rights, OpenProcess across accounts and the image-hash variant (e) on journal 2
Step 'e_scm_query_status' 'SCM PID lookup needs only SC_MANAGER_CONNECT + SERVICE_QUERY_STATUS, and nothing more is granted' {
  $script:Pid3 = Start-LabBroker 'run3' $Db2
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
  $res = (Invoke-FencedClaim $C 'helper-cp-hash' 'lab23-e' @{ serviceName = $B; imageSha256 = $hashes.brokerExe }).result # the SCM process image is the Broker executable itself
  $consistent = if ($allowed) { $res.ok -eq $true } else { $res.code -eq 'server_identity_unavailable' }
  Stop-LabService $B
  Verdict $consistent @("Control Plane OpenProcess masks on the Broker service process: $($opC.openProcess | ConvertTo-Json -Compress)", "image sha256 readable by Control Plane: $(if ($allowed) { 'yes' } else { 'no' })",
    "helper with imageSha256: $($res | ConvertTo-Json -Compress)")
}
Step 'e_session0' 'Broker pipe server runs in session 0; an interactive-session lookalike cannot be built to reach that check' {
  @{ Status = 'BLOCKED'; Evidence = @("Broker token session and pipe server session are recorded in a_token / a_pipe_acl (both expected 0). A lookalike must first match the owner SID and the SCM PID, which the owner check already refuses (d2); the session-0 branch is reachable only with a forged owner and PID, so no honest negative test exists.", "PowerShell Direct session id of the Administrator probes: $adminSession") }
}

# ---- Broker runs 4 and 4b: restart and replay (f). A receipt lives at most 300 seconds, so the claim and its replay happen in this one step, on a journal of its own.
Step 'f_restart_replay' 'Restarted Broker service: a new epoch, the old challenge is dead, and the same receipt still returns the recorded outcome (UNKNOWN, replayed), one journal claim' {
  $pid4 = Start-LabBroker 'run4' $Db4
  $first = Invoke-FencedClaim $C 'helper-cp-claim' 'lab23-f' @{ serviceName = $B }
  $pending = Invoke-HelperAs $C 'helper-cp-fence2' @{ fence = $Authority.computerId } @{ serviceName = $B }   # a second challenge, never used
  Stop-LabService $B
  $pid4b = Start-LabBroker 'run4b' $Db4
  $res = Invoke-HelperAs $C 'helper-cp-replay' $first.request @{ serviceName = $B }
  $dead = Invoke-HelperAs $C 'helper-cp-deadchallenge' (New-LabReceipt 'lab23-f-late' $pending) @{ serviceName = $B }   # names a challenge of the previous epoch
  $after = Invoke-HelperAs $C 'helper-cp-fence3' @{ fence = $Authority.computerId } @{ serviceName = $B }
  Stop-LabService $B
  $claims = Get-ClaimCount $Db4
  $ok = ($first.result.ok -eq $true) -and ($res.ok -eq $true) -and ($res.state -eq 'UNKNOWN') -and ($res.action -eq 'synthetic.noop') -and ($res.replayed -eq $true) `
    -and ($dead.ok -eq $false) -and ($dead.code -eq 'denied') -and ($after.brokerEpoch -eq ($first.fence.brokerEpoch + 1)) -and ($claims -eq 1) -and ($pid4b -ne $pid4)
  Verdict $ok @("first claim: $($first.result | ConvertTo-Json -Compress) in epoch $($first.fence.brokerEpoch)", "replay after restart: $($res | ConvertTo-Json -Compress) (ok + replayed = the stored outcome of the exact duplicate, no second claim)",
    "receipt naming a challenge of the previous epoch: $($dead | ConvertTo-Json -Compress)", "fence after restart: epoch $($after.brokerEpoch) (expected $($first.fence.brokerEpoch + 1))", "journal claims=$claims", "service pid run 4=$pid4 run 4b=$pid4b")
}

# ---- the real service host: two requests to one running service, STOP, and the fatal exit codes SCM records (g)
Step 'g_two_requests_one_service_then_stop' 'Real service host: Control Plane helper (service mode) ok against two consecutive requests to the same RUNNING service (PID unchanged); SERVICE_CONTROL_STOP ends it cleanly' {
  $pidG = Start-LabBroker 'run5' $Db3
  $flow1 = Invoke-FencedClaim $C 'helper-g1' 'lab23-g1' @{ serviceName = $B }
  $res1 = $flow1.result
  $svc1 = Get-Svc $B
  $res2 = (Invoke-FencedClaim $C 'helper-g2' 'lab23-g2' @{ serviceName = $B }).result
  $svc2 = Get-Svc $B
  $res3 = Invoke-HelperAs $C 'helper-g3' $flow1.request @{ serviceName = $B }   # replay of the first receipt: still the same process, the journal returns the recorded outcome
  $svc3 = Get-Svc $B
  $claims = Get-ClaimCount $Db3
  $stopWatch = [System.Diagnostics.Stopwatch]::StartNew()
  & sc.exe stop $B | Out-Null                                          # SERVICE_CONTROL_STOP
  Wait-Until { (Get-Svc $B).State -eq 'Stopped' } 30 'broker service stopped by STOP'
  $stopWatch.Stop()
  $after = Get-Svc $B
  Wait-Until { -not (Get-Process -Id $pidG -ErrorAction SilentlyContinue) } 10 'broker process exited'
  $pipeGone = (Invoke-ProbeAdmin @('pipe-open', $Pipe, '00120083')).result
  $samePid = ($svc1.ProcessId -eq $pidG) -and ($svc2.ProcessId -eq $pidG) -and ($svc3.ProcessId -eq $pidG)
  $ok = ($res1.ok -eq $true) -and ($res2.ok -eq $true) -and ($res3.ok -eq $true) -and ($res3.state -eq 'UNKNOWN') -and ($res3.replayed -eq $true) -and $samePid -and ($svc3.State -eq 'Running') -and ($claims -eq 2) `
    -and ($after.State -eq 'Stopped') -and ($after.ExitCode -eq 0) -and ($after.ServiceSpecificExitCode -eq 0) -and ($stopWatch.ElapsedMilliseconds -lt 10000) -and ($pipeGone -eq 'error_2')
  Verdict $ok @("request 1: $($res1 | ConvertTo-Json -Compress)", "request 2: $($res2 | ConvertTo-Json -Compress)", "request 3 (replay of 1): $($res3 | ConvertTo-Json -Compress)",
    "service pid after each request: $($svc1.ProcessId), $($svc2.ProcessId), $($svc3.ProcessId) (started as $pidG); state $($svc3.State)", "journal claims=$claims",
    "after STOP: $(Get-ServiceExit $B) in $($stopWatch.ElapsedMilliseconds) ms; process gone; pipe open now: $pipeGone")
}
Step 'g_fatal_exit_codes' 'Real service host: a squatted pipe name and a rejected config end the service with 1066 and the fixed service-specific exit code (70, 73)' {
  $squatter = Start-AdminSquatter 'g-fatal'
  $squat = Start-LabBrokerExpectingFailure $Db3 $script:SidC
  $null = Stop-AdminSquatter $squatter
  $bad = Start-LabBrokerExpectingFailure $Db3 'S-1-1-0'          # a broad Control Plane SID is refused
  $ok = ($squat.ExitCode -eq 1066) -and ($squat.ServiceSpecificExitCode -eq 70) -and ($bad.ExitCode -eq 1066) -and ($bad.ServiceSpecificExitCode -eq 73)
  Verdict $ok @("pipe name already held by an Administrator process: win32=$($squat.ExitCode) specific=$($squat.ServiceSpecificExitCode) (expected 1066 / 70)",
    "config with Control Plane SID S-1-1-0: win32=$($bad.ExitCode) specific=$($bad.ServiceSpecificExitCode) (expected 1066 / 73)")
}

Step 'g_untrusted_db_folder' 'Real service host refuses to start when ordinary users can write the journal folder (1066 / 73)' {
  & icacls.exe "$LabRoot\data\broker" /grant '*S-1-5-32-545:(OI)(CI)W' | Out-Null
  try { $untrusted = Start-LabBrokerExpectingFailure $Db3 $script:SidC }
  finally { & icacls.exe "$LabRoot\data\broker" /remove:g '*S-1-5-32-545' | Out-Null }
  $ok = ($untrusted.ExitCode -eq 1066) -and ($untrusted.ServiceSpecificExitCode -eq 73)
  Verdict $ok @("journal folder writable by BUILTIN\Users: win32=$($untrusted.ExitCode) specific=$($untrusted.ServiceSpecificExitCode) (expected 1066 / 73)")
}

# ---- receipt v2 refusals through the real service (h): what only the running Broker can show. Each denial is the one fixed reply; the reason words are on the
# service's stdout, which the SCM discards, so the evidence is the reply plus the journal.
Step 'h_v2_refusals' 'Real service: a test issuer, a spent challenge and a challenge from before a restart are denied; a fresh challenge is accepted; one claim in the journal' {
  $null = Start-LabBroker 'run6' $Db5
  $expect = @{ serviceName = $B }
  $f1 = Invoke-HelperAs $C 'helper-h-fence1' @{ fence = $Authority.computerId } $expect
  $testIssuer = Invoke-HelperAs $C 'helper-h-testissuer' (New-LabReceipt 'lab23-h1' $f1 @{ issuer = 'albera-test-approval-authority' }) $expect   # production Broker: issuer_test
  $good = New-LabReceipt 'lab23-h2' $f1
  $accepted = Invoke-HelperAs $C 'helper-h-accepted' $good $expect                                                                              # the challenge was not spent by the refusal
  $spent = Invoke-HelperAs $C 'helper-h-spent' (New-LabReceipt 'lab23-h3' $f1) $expect                                                           # challenge_consumed
  $stale = Invoke-HelperAs $C 'helper-h-stale' (New-LabReceipt 'lab23-h4' $f1 @{ leaseGeneration = 6 }) $expect                                   # not claimed either way
  $f2 = Invoke-HelperAs $C 'helper-h-fence2' @{ fence = $Authority.computerId } $expect
  $ahead = Invoke-HelperAs $C 'helper-h-ttl' (New-LabReceipt 'lab23-h5' $f2 @{ exp = ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 1000) }) $expect   # ttl_exceeded
  Stop-LabService $B
  $claims = Get-ClaimCount $Db5
  $ok = ($f1.ok -eq $true) -and ($testIssuer.code -eq 'denied') -and ($accepted.ok -eq $true) -and ($spent.code -eq 'denied') -and ($stale.code -eq 'denied') -and ($f2.ok -eq $true) -and ($ahead.code -eq 'denied') -and ($claims -eq 1)
  Verdict $ok @("test issuer on the production Broker: $($testIssuer | ConvertTo-Json -Compress)", "production issuer, same challenge: $($accepted | ConvertTo-Json -Compress)", "the same challenge again: $($spent | ConvertTo-Json -Compress)",
    "stale lease generation: $($stale | ConvertTo-Json -Compress)", "TTL above 300 s: $($ahead | ConvertTo-Json -Compress)", "journal claims=$claims (expected 1)")
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
# d2 needs a Broker service object that is RUNNING but owns no pipe, which the real Broker cannot be: point the object at the shim for this one check.
Set-BrokerServiceHost 'shim'
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
