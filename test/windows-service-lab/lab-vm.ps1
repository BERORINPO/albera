# Issue #23 one-command disposable VM lab. Usage:
#   powershell -File test/windows-service-lab/lab-vm.ps1 [-Build] [-KeepVm] [-HostInstall | -HyperV | -ControlPlaneService [-HostNodeExe <path>] | -HostMigrate -LegacyRef <commit>]
# Changes nothing on the host except creating/deleting this one VM and its folder.
# The golden disk is never modified, and the guest is disconnected from the network.
param(
  [string]$VmName = ('albera-lab-' + (Get-Date -Format 'yyyyMMdd-HHmmss')),
  [string]$PasswordFile = 'U:\dev\hyperv\albera-poc-01\local-secrets\admin-password.txt',
  [string]$EvidenceDir,
  [switch]$Build,
  [switch]$KeepVm,
  # Run the HOST installer check (scripts/host/albera-host.ps1 through lab-host-install-check.ps1) in the VM instead of the service-identity lab.
  [switch]$HostInstall,
  # Run the NESTED Hyper-V rights lab (lab-hyperv-rights-check.ps1) instead: the guest gets the Hyper-V role and an inner VM, and a Broker-shaped service
  # tries the screen capture and input calls; then the real Broker runs as a service and its desktop pipe is used (view session, refusals, and the act session with the
  # lease a task.start claim makes). The outer VM gets 5 GB and nested virtualization. Needs the lab shim build and the Broker build, which includes the Control Plane
  # pipe client (-Build makes them).
  [switch]$HyperV,
  # Run the CONTROL PLANE SERVICE lab (lab-control-plane-service.ps1) instead: what a Control Plane that runs as NT SERVICE\AlberaControlPlane (restricted service SID,
  # SeChangeNotifyPrivilege only) can do -- node.exe + node:sqlite, the pipe client helper, DPAPI, loopback TCP, a ProgramData file with a protected DACL, outbound HTTPS. Needs the lab shim
  # build and the pipe client helper build (npm run build:windows-broker makes the helper; -Build makes both). Standard 4 GB VM, no Hyper-V role, no reboot.
  [switch]$ControlPlaneService,
  # Run the HOST MIGRATION lab (lab-host-migrate-check.ps1) instead: a first-layout install (the local account albera-cp) is made with the installer of -LegacyRef, the account runs once so that its profile exists, and
  # the CURRENT installer then runs -Mode plan -PlanFor migrate, -Mode migrate -TrustLocalBuilds, -Mode status and -Mode uninstall. The old Broker, Authority and pipe client are built from -LegacyRef here (a copy of that
  # commit's tree under the VM's folder, removed afterwards; nothing is downloaded); the current builds are the five the host installer needs (-Build makes them). Standard 4 GB VM, no Hyper-V role, no reboot.
  [switch]$HostMigrate,
  # Used by -HostMigrate only: the commit (hex, 7 to 40 characters) whose scripts/host installer made the first layout, for example 303ec40.
  [string]$LegacyRef,
  # Used by -ControlPlaneService only, and only when the golden image has no Node: the host's own node.exe (read, never changed) is copied into the guest at C:\Program Files\nodejs. -HostInstall and -HostMigrate
  # copy the same file beside their guest hook (what the installer pins).
  # Nothing is downloaded. It must carry a valid Authenticode signature; its version, size and SHA-256 are printed and recorded in the results.
  [string]$HostNodeExe = (Join-Path $env:ProgramFiles 'nodejs\node.exe')
)
$ErrorActionPreference = 'Stop'

function Get-GuestBootTime($Session) {
  Invoke-Command -Session $Session -ScriptBlock { (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime() }
}
# Reconnects PowerShell Direct until it answers. With $NotBootedBefore (a UTC DateTime read before a restart) it also waits until the guest has booted again.
function New-DirectSession([string]$Name, [pscredential]$Credential, [int]$Minutes, $NotBootedBefore) {
  $deadline = (Get-Date).AddMinutes($Minutes)
  while ((Get-Date) -lt $deadline) {
    $s = $null
    try {
      $s = New-PSSession -VMName $Name -Credential $Credential -ErrorAction Stop
      $boot = Get-GuestBootTime $s
      if ($null -eq $NotBootedBefore -or ($boot - $NotBootedBefore).TotalSeconds -gt 60) { return $s }
    }
    catch { }
    if ($s) { Remove-PSSession $s -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 10
  }
  throw "PowerShell Direct was not ready within $Minutes minutes"
}

# The -HyperV lab: install the Hyper-V role, restart, copy the shim, run lab-hyperv-rights-check.ps1 (inner VM + four service identities), print the result.
# Returns the exit code last (0 = nothing failed and nothing was left unmeasured, 1 = a FAIL or a BLOCKED check).
function Invoke-HyperVRightsLab([string]$VmName, [pscredential]$Credential, [string]$Repo, [string]$OutputFile, [string]$ResultsFile, [switch]$KeepVm) {
  $guestRoot = 'C:\albera-hv-lab'
  $guestScript = Join-Path $PSScriptRoot 'lab-hyperv-rights-check.ps1'
  $shimPublish = Join-Path $Repo 'test\windows-service-lab\bin\Release\net10.0-windows\win-x64\publish'
  $brokerPublish = Join-Path $Repo 'src\runtime\windows-broker\bin\Release\net10.0-windows\win-x64\publish'
  $helperPublish = Join-Path $Repo 'src\runtime\windows-broker-pipe-client\bin\Release\net10.0-windows\win-x64\publish'
  $session = New-DirectSession $VmName $Credential 6 $null
  try {
    # The guest script refuses to run unless this is set (it edits services and a local group).
    Invoke-Command -Session $session -ScriptBlock { $env:ALBERA_LAB_VM = '1' }
    Write-Host 'installing the Hyper-V role in the guest (several minutes)'
    $install = Invoke-Command -Session $session -FilePath $guestScript -ArgumentList $guestRoot, 'install-feature' | Select-Object -Last 1 | ConvertFrom-Json
    if (-not $install.success) { throw 'Install-WindowsFeature Hyper-V did not report success' }
    if (-not $install.alreadyInstalled) {
      $bootBefore = Get-GuestBootTime $session
      Write-Host 'restarting the guest to finish the Hyper-V role (up to 20 minutes)'
      try { Invoke-Command -Session $session -ScriptBlock { & shutdown.exe /r /t 3 /f } } catch { }   # the session ends with the restart
      Remove-PSSession $session -ErrorAction SilentlyContinue
      $session = $null
      $session = New-DirectSession $VmName $Credential 20 $bootBefore
      Invoke-Command -Session $session -ScriptBlock { $env:ALBERA_LAB_VM = '1' }
    }
    Invoke-Command -Session $session -ScriptBlock { param($r) New-Item -ItemType Directory -Force -Path "$r\bin\shim", "$r\bin\broker", "$r\bin\helper" | Out-Null } -ArgumentList $guestRoot
    Copy-Item -ToSession $session -Path (Join-Path $shimPublish '*') -Destination "$guestRoot\bin\shim" -Recurse -Force
    Copy-Item -ToSession $session -Path (Join-Path $brokerPublish '*') -Destination "$guestRoot\bin\broker" -Recurse -Force
    Copy-Item -ToSession $session -Path (Join-Path $helperPublish '*') -Destination "$guestRoot\bin\helper" -Recurse -Force   # the Control Plane's pipe client: it sends the lab's task.start claims
    Write-Host 'running the rights probe as four service identities, then the real Broker service and its desktop pipe'
    $raw = Invoke-Command -Session $session -FilePath $guestScript -ArgumentList $guestRoot, 'run'
    $json = @($raw | Where-Object { $_ -is [string] -and $_ -like '{*' }) | Select-Object -Last 1
    if (-not $json) { throw 'the guest script returned no results' }
    $results = $json | ConvertFrom-Json
    $results | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath $ResultsFile
    # The picture the Control Plane's capture returned (check bd_cp_view_capture), for a person to look at. Absent when the capture did not work.
    $picture = Invoke-Command -Session $session -ScriptBlock { param($r) if (Test-Path -LiteralPath "$r\evidence\bd-view-capture.png") { "$r\evidence\bd-view-capture.png" } } -ArgumentList $guestRoot
    if ($picture) { Copy-Item -FromSession $session -Path $picture -Destination (Join-Path (Split-Path -Parent $ResultsFile) 'bd-view-capture.png') -Force }
  }
  finally {
    if ($session) {
      if ($KeepVm) { try { Invoke-Command -Session $session -FilePath $guestScript -ArgumentList $guestRoot, 'cleanup' | Out-Null } catch { } }   # otherwise the VM is deleted anyway
      Remove-PSSession $session -ErrorAction SilentlyContinue
    }
  }

  $checks = @($results.checks)
  $text = (($checks | Select-Object id, status, observed | Format-Table -AutoSize | Out-String) +
    "Observed per identity (rows: operation; columns: restricted/unrestricted service SID x member of Hyper-V Administrators or not):`r`n" +
    (@($results.matrix) | Select-Object op, r_member, r_nonmember, u_member, u_nonmember | Format-Table -AutoSize | Out-String))
  $count = @{}
  foreach ($status in @('PASS', 'FAIL', 'BLOCKED', 'MEASURED')) { $count[$status] = @($checks | Where-Object { $_.status -eq $status }).Count }
  $text += "PASS: $($count.PASS)  FAIL: $($count.FAIL)  BLOCKED: $($count.BLOCKED)  MEASURED: $($count.MEASURED)`r`n"
  $text | Set-Content -Encoding UTF8 -LiteralPath $OutputFile
  $text | Out-Host
  if ($count.FAIL -gt 0 -or $count.BLOCKED -gt 0) { return 1 }
  return 0
}

# Makes sure the guest has node.exe at the path a real install uses. The golden image may already have it (then nothing is copied). If not, the HOST's node.exe is copied in -- a read of one
# host file, no download -- after it is checked: it exists, has a valid Authenticode signature and a Node version that has node:sqlite (22.13 or newer). After the copy the guest's SHA-256 must match the host's.
# Returns the text recorded as evidence: 'golden', or 'copied_from_host:<version>:<sha256>:<bytes>'.
function Install-GuestNode($Session, [string]$HostNode, [string]$GuestNode) {
  $present = Invoke-Command -Session $Session -ScriptBlock { param($p) Test-Path -LiteralPath $p -PathType Leaf } -ArgumentList $GuestNode
  if ($present) { Write-Host "node.exe is already in the guest image: $GuestNode"; return 'golden' }
  if (-not (Test-Path -LiteralPath $HostNode -PathType Leaf)) { throw "the guest has no Node and the host node.exe is missing: $HostNode (pass -HostNodeExe)" }
  $version = (& $HostNode --version).Trim()
  if ($version -notmatch '^v(\d+)\.(\d+)\.' -or ([int]$Matches[1] -lt 22) -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -lt 13)) { throw "host node.exe is $version; node:sqlite needs 22.13 or newer" }
  $signature = Get-AuthenticodeSignature -LiteralPath $HostNode
  if ($signature.Status -ne 'Valid') { throw "host node.exe has no valid Authenticode signature ($($signature.Status)); not copying it into the guest" }
  $hash = (Get-FileHash -LiteralPath $HostNode -Algorithm SHA256).Hash.ToLowerInvariant()
  $bytes = (Get-Item -LiteralPath $HostNode).Length
  Write-Host ("the guest image has no Node: copying the host's node.exe ({0}, {1:N1} MB, sha256 {2}, signed by {3})" -f $version, ($bytes / 1MB), $hash, $signature.SignerCertificate.Subject)
  Invoke-Command -Session $Session -ScriptBlock { param($p) New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null } -ArgumentList $GuestNode
  Copy-Item -ToSession $Session -Path $HostNode -Destination $GuestNode -Force
  $guestHash = Invoke-Command -Session $Session -ScriptBlock { param($p) (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() } -ArgumentList $GuestNode
  if ($guestHash -ne $hash) { throw 'node.exe in the guest does not match the host file after the copy' }
  return "copied_from_host:${version}:${hash}:${bytes}"
}

# The -ControlPlaneService lab: copy the shim, the pipe client helper, the Node probe and the person tool, make sure node.exe is there, run lab-control-plane-service.ps1, print the result.
# Returns the exit code last: 0 when every check came out as the script expects (cp7 BLOCKED is the expected answer: the guest has no network), 1 otherwise.
function Invoke-ControlPlaneServiceLab([string]$VmName, [pscredential]$Credential, [string]$Repo, [string]$HostNode, [string]$OutputFile, [string]$ResultsFile, [switch]$KeepVm) {
  $guestRoot = 'C:\albera-cp-lab'
  $guestNode = 'C:\Program Files\nodejs\node.exe'
  $guestScript = Join-Path $PSScriptRoot 'lab-control-plane-service.ps1'
  $shimPublish = Join-Path $Repo 'test\windows-service-lab\bin\Release\net10.0-windows\win-x64\publish'
  $helperPublish = Join-Path $Repo 'src\runtime\windows-broker-pipe-client\bin\Release\net10.0-windows\win-x64\publish'
  $session = New-DirectSession $VmName $Credential 6 $null
  try {
    Invoke-Command -Session $session -ScriptBlock { $env:ALBERA_LAB_VM = '1' }   # the guest script refuses to run unless this is set (it creates services and a local user)
    Invoke-Command -Session $session -ScriptBlock { param($r) New-Item -ItemType Directory -Force -Path "$r\bin\shim", "$r\bin\helper", "$r\bin\cp", "$r\tools" | Out-Null } -ArgumentList $guestRoot
    Copy-Item -ToSession $session -Path (Join-Path $shimPublish '*') -Destination "$guestRoot\bin\shim" -Recurse -Force
    Copy-Item -ToSession $session -Path (Join-Path $helperPublish '*') -Destination "$guestRoot\bin\helper" -Recurse -Force
    Copy-Item -ToSession $session -Path (Join-Path $PSScriptRoot 'cp-node-probe.mjs') -Destination "$guestRoot\bin\cp\cp-node-probe.mjs" -Force
    Copy-Item -ToSession $session -Path (Join-Path $PSScriptRoot 'lab-person.ps1') -Destination "$guestRoot\tools\lab-person.ps1" -Force
    $nodeSource = Install-GuestNode $session $HostNode $guestNode
    Write-Host 'running the seven measurements as NT SERVICE\AlberaControlPlane (restricted service SID, SeChangeNotifyPrivilege only)'
    $raw = Invoke-Command -Session $session -FilePath $guestScript -ArgumentList $guestRoot, 'run', $nodeSource
    $json = @($raw | Where-Object { $_ -is [string] -and $_ -like '{*' }) | Select-Object -Last 1
    if (-not $json) { throw 'the guest script returned no results' }
    $results = $json | ConvertFrom-Json
    $results | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath $ResultsFile
  }
  finally {
    if ($session) {
      if ($KeepVm) { try { Invoke-Command -Session $session -FilePath $guestScript -ArgumentList $guestRoot, 'cleanup' | Out-Null } catch { } }   # otherwise the VM is deleted anyway
      Remove-PSSession $session -ErrorAction SilentlyContinue
    }
  }

  $checks = @($results.checks)
  $text = ($checks | Select-Object id, expected, status, observed | Format-Table -AutoSize -Wrap | Out-String)
  $count = @{}
  foreach ($status in @('PASS', 'FAIL', 'BLOCKED', 'MEASURED')) { $count[$status] = @($checks | Where-Object { $_.status -eq $status }).Count }
  $text += "PASS: $($count.PASS)  FAIL: $($count.FAIL)  BLOCKED: $($count.BLOCKED)  MEASURED: $($count.MEASURED)  node: $($results.nodeSource)`r`n"
  $unexpected = @($results.unexpected | Where-Object { $_ })
  if ($unexpected.Count -gt 0) { $text += "Not as expected:`r`n  " + ($unexpected -join "`r`n  ") + "`r`n" }
  $text | Set-Content -Encoding UTF8 -LiteralPath $OutputFile
  $text | Out-Host
  if ($results.setupError -or $unexpected.Count -gt 0 -or $checks.Count -eq 0) { return 1 }
  return 0
}

# The -HostMigrate lab, host side. Puts the tree of one commit (git archive, no .git) under $Dest and builds the three programs its installer pins (Broker, pipe client, Approval Authority) there with that
# commit's own build scripts: locked restore from the NuGet cache, nothing downloaded. Returns the full commit id.
function Build-LegacyHostTree([string]$Repo, [string]$Ref, [string]$Dest) {
  if ($Ref -notmatch '^[0-9a-f]{7,40}$') { throw "-LegacyRef must be a lowercase hex commit id of 7 to 40 characters, not '$Ref'" }
  $commit = ((& git -C $Repo rev-parse --verify "$Ref^{commit}" 2>&1) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw "-LegacyRef $Ref is not a commit of this repository: $commit" }
  if (Test-Path -LiteralPath $Dest) { throw "legacy build folder already exists: $Dest" }
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  $archive = Join-Path $Dest 'legacy-tree.tar'
  & git -C $Repo archive --format=tar -o $archive $commit
  if ($LASTEXITCODE -ne 0) { throw "git archive $commit failed ($LASTEXITCODE)" }
  & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $archive -C $Dest
  if ($LASTEXITCODE -ne 0) { throw "extracting the legacy tree failed ($LASTEXITCODE)" }
  Remove-Item -LiteralPath $archive -Force
  Push-Location $Dest
  try {
    foreach ($script in @('build:windows-broker', 'build:approval-authority')) {
      & npm run $script | Out-Host   # to the console, not into this function's return value
      if ($LASTEXITCODE -ne 0) { throw "legacy $script failed ($LASTEXITCODE)" }
    }
  }
  finally { Pop-Location }
  $commit
}

# Copies scripts\host and the given publish folders (relative to $Repo) into $GuestRepo in the guest, at the same relative paths. A missing build output is named, with the command that makes it.
function Copy-HostTreeToGuest($Session, [string]$Repo, [string]$GuestRepo, [string[]]$Rels) {
  foreach ($rel in $Rels) { if (-not (Test-Path -LiteralPath (Join-Path $Repo $rel))) { throw "missing build output (run with -Build): $rel" } }
  Invoke-Command -Session $Session -ScriptBlock { param($r, $dirs) foreach ($x in $dirs) { New-Item -ItemType Directory -Force -Path (Join-Path $r $x) | Out-Null } } -ArgumentList $GuestRepo, (@('scripts\host', 'tools') + $Rels)
  Copy-Item -ToSession $Session -Path (Join-Path $Repo 'scripts\host\*') -Destination "$GuestRepo\scripts\host" -Recurse -Force
  foreach ($rel in $Rels) { Copy-Item -ToSession $Session -Path (Join-Path (Join-Path $Repo $rel) '*') -Destination (Join-Path $GuestRepo $rel) -Recurse -Force }
}

# The -HostMigrate lab: the old tree (built from -LegacyRef) and the current one go into the guest, lab-host-migrate-check.ps1 runs the first-layout install, the migration and the uninstall, and prints one JSON object.
# Returns the exit code last (0 = every check passed, 1 = a check failed or the hook was blocked).
function Invoke-HostMigrateLab([string]$VmName, [pscredential]$Credential, [string]$Repo, [string]$LegacyRepo, [string]$LegacyCommit, [string]$HostNode, [string]$OutputFile, [string]$ResultsFile) {
  $legacyGuest = 'C:\albera-legacy-lab'
  $guestRepo = 'C:\albera-host-lab'
  $legacyRels = @('src\runtime\windows-broker\bin\Release\net10.0-windows\win-x64\publish',
                  'src\runtime\windows-approval-authority\bin\Release\net10.0-windows\win-x64\publish',
                  'src\runtime\windows-broker-pipe-client\bin\Release\net10.0-windows\win-x64\publish')
  $rels = $legacyRels + @('src\runtime\windows-control-plane-host\bin\Release\net10.0-windows\win-x64\publish',
                          'src\runtime\windows-approver\bin\Release\net10.0-windows10.0.19041.0\win-x64\publish')
  if (-not (Test-Path -LiteralPath $HostNode -PathType Leaf)) { throw "the host node.exe is missing: $HostNode (pass -HostNodeExe); the guest copy of it is what the installer pins" }
  $session = New-PSSession -VMName $VmName -Credential $Credential
  try {
    Copy-HostTreeToGuest $session $LegacyRepo $legacyGuest $legacyRels
    Copy-HostTreeToGuest $session $Repo $guestRepo $rels
    Copy-Item -ToSession $session -Path (Join-Path $PSScriptRoot 'lab-host-migrate-check.ps1') -Destination "$guestRepo\tools\lab-host-migrate-check.ps1" -Force
    Copy-Item -ToSession $session -Path $HostNode -Destination "$guestRepo\tools\node.exe" -Force   # what the hook hands the new installer as -NodeSource (the lab guest has no Node of its own)
    Write-Host "running the first-layout install ($LegacyCommit), the migration and the uninstall in the guest"
    $hookOutput = Invoke-Command -Session $session -ScriptBlock {
      param($legacy, $r)
      $env:ALBERA_LAB_VM = '1'
      $text = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$r\tools\lab-host-migrate-check.ps1" -LegacyScriptDir "$legacy\scripts\host" -LegacyRepoRoot $legacy -HostScriptDir "$r\scripts\host" -RepoRoot $r 2>&1 | Out-String)
      [pscustomobject]@{ Exit = $LASTEXITCODE; Text = $text }
    } -ArgumentList $legacyGuest, $guestRepo
  }
  finally { Remove-PSSession $session }
  $hookOutput.Text | Set-Content -Encoding UTF8 -LiteralPath $OutputFile
  $json = $hookOutput.Text.Substring([Math]::Max(0, $hookOutput.Text.IndexOf('{')))
  $results = $null
  try { $results = $json | ConvertFrom-Json } catch { }
  if ($results) {
    $results | Add-Member -NotePropertyName legacyRef -NotePropertyValue $LegacyCommit -Force
    $results | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath $ResultsFile
    @($results.checks) | Select-Object id, status, observed | Format-Table -AutoSize -Wrap | Out-Host
    $failed = @(@($results.checks) | Where-Object { $_.status -eq 'FAIL' }).Count
    Write-Host "host-migrate checks: $(@($results.checks).Count)  FAIL: $failed  pass: $($results.pass)  results: $ResultsFile"
  }
  else { $hookOutput.Text | Out-Host }
  Write-Host "host-migrate hook exit: $($hookOutput.Exit)"
  if ($hookOutput.Exit -eq 0 -and $results -and $results.pass) { return 0 }
  return 1
}

$golden ='U:\dev\hyperv\golden\ws2025-desktop-golden.vhdx'
$labNote = 'ALBERA lab (disposable; delete after run)'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$root = Join-Path 'U:\dev\hyperv\clones' $VmName
$childVhd = Join-Path $root "$VmName.vhdx"
if ([string]::IsNullOrWhiteSpace($EvidenceDir)) { $EvidenceDir = Join-Path $root 'evidence' }
if (-not [IO.Path]::IsPathRooted($EvidenceDir)) {
  $EvidenceDir = [IO.Path]::GetFullPath((Join-Path (Get-Location) $EvidenceDir))
}
$inputsFile = Join-Path $EvidenceDir 'inputs.json'
$runDir = Join-Path $EvidenceDir 'run'
$outputFile = Join-Path $EvidenceDir 'lab-output.txt'
$vmCreated = $false
$legacyDir = Join-Path $root 'legacy-src'
$legacyCommit = $null
$vmId = $null
$direct = $null
$exitCode = 2

try {
  if (-not (Test-Path -LiteralPath $golden -PathType Leaf)) { throw "golden VHDX is missing: $golden" }
  $goldenItem = Get-Item -LiteralPath $golden
  if (-not $goldenItem.IsReadOnly) { throw "golden VHDX must be read-only: $golden" }
  if ($HyperV -and $HostInstall) { throw '-HyperV and -HostInstall are separate labs; choose one' }
  if ($ControlPlaneService -and ($HyperV -or $HostInstall)) { throw '-ControlPlaneService is a separate lab from -HyperV and -HostInstall; choose one' }
  if ($HostMigrate -and ($HyperV -or $HostInstall -or $ControlPlaneService)) { throw '-HostMigrate is a separate lab from -HyperV, -HostInstall and -ControlPlaneService; choose one' }
  if ($HostMigrate -and [string]::IsNullOrWhiteSpace($LegacyRef)) { throw '-HostMigrate needs -LegacyRef <commit of the installer that made the first layout>' }
  if ($LegacyRef -and -not $HostMigrate) { throw '-LegacyRef is only for -HostMigrate' }
  if (Get-VM -Name $VmName -ErrorAction SilentlyContinue) { throw "VM already exists: $VmName" }
  if (-not (Test-Path -LiteralPath $PasswordFile -PathType Leaf)) { throw "password file is missing: $PasswordFile" }
  if (-not $Build -and -not $HostMigrate) {
    # Fail before creating a VM when the binaries run-lab.ps1 copies are missing. (-HostMigrate names its own in Invoke-HostMigrateLab.)
    $needed = @('test\windows-service-lab\bin\Release\net10.0-windows\win-x64\publish',
                'src\runtime\windows-broker\bin\Release\net10.0-windows\win-x64\publish')
    # The Hyper-V lab runs the lab shim, the real Broker and the Control Plane pipe client (it sends the claims that make a lease), and so does the Control Plane service lab (shim + client); the other labs also copy the Approval Authority.
    if ($HyperV -or $ControlPlaneService) { $needed += @('src\runtime\windows-broker-pipe-client\bin\Release\net10.0-windows\win-x64\publish') }
    else { $needed += @('src\runtime\windows-approval-authority\bin\Release\net10.0-windows\win-x64\publish') }
    foreach ($p in $needed) {
      if (-not (Test-Path -LiteralPath (Join-Path $repo $p))) { throw "missing build output (run with -Build): $p" }
    }
  }

  if ($HostMigrate) { $legacyCommit = Build-LegacyHostTree $repo $LegacyRef $legacyDir }   # before the VM exists: a wrong ref or a failed build costs no VM

  # Refuse to start when the host is short on memory: a 4 GB VM on a full host froze the PC (2026-10-31).
  $vmMemoryGB = if ($HyperV) { 5 } else { 4 }   # -HyperV: the guest also runs the Hyper-V role and a 512 MB inner VM
  $hostHeadroomGB = 4
  $freeGB = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB
  if ($freeGB -lt ($vmMemoryGB + $hostHeadroomGB)) {
    throw ("host has {0:N1} GB free; need {1} GB ({2} GB VM + {3} GB headroom). Stop other VMs and retry." -f $freeGB, ($vmMemoryGB + $hostHeadroomGB), $vmMemoryGB, $hostHeadroomGB)
  }

  New-Item -ItemType Directory -Force -Path $root, $EvidenceDir | Out-Null
  New-VHD -Differencing -ParentPath $golden -Path $childVhd | Out-Null
  $vm = New-VM -Name $VmName -Generation 2 -MemoryStartupBytes ($vmMemoryGB * 1GB) -VHDPath $childVhd -Path $root
  $vmCreated = $true
  $vmId = $vm.Id
  Set-VM -VM $vm -Notes $labNote
  Set-VMMemory -VMName $VmName -DynamicMemoryEnabled $false
  Set-VMProcessor -VMName $VmName -Count 2
  if ($HyperV) {
    # Nested virtualization can only be switched on while the VM is off; the Hyper-V role inside the guest needs it.
    Set-VMProcessor -VMName $VmName -ExposeVirtualizationExtensions $true
    if (-not (Get-VMProcessor -VMName $VmName).ExposeVirtualizationExtensions) { throw 'could not expose virtualization extensions to the lab VM' }
  }
  Get-VMNetworkAdapter -VMName $VmName | Disconnect-VMNetworkAdapter
  Set-VM -VM $vm -Notes $labNote -CheckpointType Disabled
  Start-VM -VM $vm | Out-Null

  $secure = (Get-Content -LiteralPath $PasswordFile -Raw).Trim() | ConvertTo-SecureString -AsPlainText -Force
  $credential = New-Object System.Management.Automation.PSCredential('Administrator', $secure)
  $deadline = (Get-Date).AddMinutes(6)
  while (-not $direct -and (Get-Date) -lt $deadline) {
    try { $direct = New-PSSession -VMName $VmName -Credential $credential }
    catch {
      if ((Get-Date) -ge $deadline) { break }
      Start-Sleep -Seconds 10
    }
  }
  if (-not $direct) { throw 'PowerShell Direct was not ready within 6 minutes' }

  # Golden-image guests start hours off and a round trip can take many seconds, so measure the offset at the midpoint
  # of a round trip and shift the guest clock by it (Set-Date -Adjust), up to three times.
  $skew = $null
  for ($i = 0; $i -lt 3; $i++) {
    $before = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $guestMs = Invoke-Command -Session $direct -ScriptBlock { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    $after = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $skewMs = [int64]$guestMs - [int64](($before + $after) / 2)
    $skew = [Math]::Round($skewMs / 1000.0, 1)
    if ([Math]::Abs($skewMs) -le 2000) { break }
    Invoke-Command -Session $direct -ScriptBlock { param($ms) Set-Date -Adjust ([TimeSpan]::FromMilliseconds(-$ms)) | Out-Null } -ArgumentList $skewMs
  }
  Write-Host "guest clock skew after sync: $skew s"
  if ([Math]::Abs($skew) -gt 5) { throw "guest clock skew is $skew seconds" }
  Remove-PSSession $direct
  $direct = $null

  Push-Location $repo
  try {
    if ($Build) {
      & npm run build:windows-broker
      if ($LASTEXITCODE -ne 0) { throw "build:windows-broker failed ($LASTEXITCODE)" }
      & npm run build:windows-service-lab
      if ($LASTEXITCODE -ne 0) { throw "build:windows-service-lab failed ($LASTEXITCODE)" }
      if (-not $HyperV -and -not $ControlPlaneService) {
        & npm run build:approval-authority
        if ($LASTEXITCODE -ne 0) { throw "build:approval-authority failed ($LASTEXITCODE)" }
      }
      if ($HostInstall -or $HostMigrate) {
        # the host installer now installs the Control Plane service host with its app tree and the approver app as well (PR7)
        & npm run build:control-plane
        if ($LASTEXITCODE -ne 0) { throw "build:control-plane failed ($LASTEXITCODE)" }
        & npm run build:approver
        if ($LASTEXITCODE -ne 0) { throw "build:approver failed ($LASTEXITCODE)" }
      }
    }
    if (-not $HostInstall -and -not $HostMigrate -and -not $HyperV -and -not $ControlPlaneService) {
      & node scripts/windows-service-lab-inputs.mjs $inputsFile
      if ($LASTEXITCODE -ne 0) { throw "input generation failed ($LASTEXITCODE)" }
    }
  }
  finally { Pop-Location }

  if ($ControlPlaneService) {
    $cpOut = @(Invoke-ControlPlaneServiceLab -VmName $VmName -Credential $credential -Repo $repo -HostNode $HostNodeExe -OutputFile $outputFile -ResultsFile (Join-Path $EvidenceDir 'control-plane-service-results.json') -KeepVm:$KeepVm)
    $exitCode = [int]($cpOut | Select-Object -Last 1)
  }
  elseif ($HyperV) {
    $hvOut = @(Invoke-HyperVRightsLab -VmName $VmName -Credential $credential -Repo $repo -OutputFile $outputFile -ResultsFile (Join-Path $EvidenceDir 'hyperv-results.json') -KeepVm:$KeepVm)
    $exitCode = [int]($hvOut | Select-Object -Last 1)
  }
  elseif ($HostMigrate) {
    $hmOut = @(Invoke-HostMigrateLab -VmName $VmName -Credential $credential -Repo $repo -LegacyRepo $legacyDir -LegacyCommit $legacyCommit -HostNode $HostNodeExe -OutputFile $outputFile -ResultsFile (Join-Path $EvidenceDir 'host-migrate-results.json'))
    $exitCode = [int]($hmOut | Select-Object -Last 1)
  }
  elseif ($HostInstall) {
    # The guest gets the host scripts and the five publish folders at the same relative paths under a stand-in repository root, then runs the hook
    # with ALBERA_LAB_VM=1 set in this session only (the installer accepts its lab-only parameters only then).
    $guestRepo = 'C:\albera-host-lab'
    $rels = @('src\runtime\windows-broker\bin\Release\net10.0-windows\win-x64\publish',
              'src\runtime\windows-approval-authority\bin\Release\net10.0-windows\win-x64\publish',
              'src\runtime\windows-broker-pipe-client\bin\Release\net10.0-windows\win-x64\publish',
              'src\runtime\windows-control-plane-host\bin\Release\net10.0-windows\win-x64\publish',
              'src\runtime\windows-approver\bin\Release\net10.0-windows10.0.19041.0\win-x64\publish')
    foreach ($rel in $rels) { if (-not (Test-Path -LiteralPath (Join-Path $repo $rel))) { throw "missing build output (run with -Build): $rel" } }
    if (-not (Test-Path -LiteralPath $HostNodeExe -PathType Leaf)) { throw "the host node.exe is missing: $HostNodeExe (pass -HostNodeExe); the guest copy of it is what the installer pins" }
    $session = New-PSSession -VMName $VmName -Credential $credential
    try {
      Invoke-Command -Session $session -ScriptBlock { param($r, $rels) foreach ($x in @('scripts\host', 'tools') + $rels) { New-Item -ItemType Directory -Force -Path (Join-Path $r $x) | Out-Null } } -ArgumentList $guestRepo, $rels
      Copy-Item -ToSession $session -Path (Join-Path $repo 'scripts\host\*') -Destination "$guestRepo\scripts\host" -Recurse -Force
      foreach ($rel in $rels) { Copy-Item -ToSession $session -Path (Join-Path (Join-Path $repo $rel) '*') -Destination (Join-Path $guestRepo $rel) -Recurse -Force }
      Copy-Item -ToSession $session -Path (Join-Path $PSScriptRoot 'lab-host-install-check.ps1') -Destination "$guestRepo\tools\lab-host-install-check.ps1" -Force
      Copy-Item -ToSession $session -Path $HostNodeExe -Destination "$guestRepo\tools\node.exe" -Force   # what the hook hands the installer as -NodeSource (the lab guest has no Node of its own)
      $hookOutput = Invoke-Command -Session $session -ScriptBlock {
        param($r)
        $env:ALBERA_LAB_VM = '1'
        $text = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$r\tools\lab-host-install-check.ps1" -HostScriptDir "$r\scripts\host" -RepoRoot $r *>&1 | Out-String)
        [pscustomobject]@{ Exit = $LASTEXITCODE; Text = $text }
      } -ArgumentList $guestRepo
    }
    finally { Remove-PSSession $session }
    $hookOutput.Text | Set-Content -Encoding UTF8 -LiteralPath $outputFile
    $hookOutput.Text | Out-Host
    Write-Host "host-install hook exit: $($hookOutput.Exit)"
    $exitCode = if ($hookOutput.Exit -eq 0) { 0 } else { 1 }
  }
  else {
  & (Join-Path $PSScriptRoot 'run-lab.ps1') -VmName $VmName -PasswordFile $PasswordFile `
    -InputsFile $inputsFile -EvidenceDir $runDir *>&1 | Tee-Object -FilePath $outputFile

  $resultsPath = Join-Path $runDir 'evidence\results.json'
  $rollbackPath = Join-Path $runDir 'guest-rollback.json'
  $results = Get-Content -LiteralPath $resultsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $checks = @($results.checks)
  $checks | Select-Object id, status | Format-Table -AutoSize | Out-Host
  $passCount = @($checks | Where-Object { $_.status -eq 'PASS' }).Count
  $failCount = @($checks | Where-Object { $_.status -eq 'FAIL' }).Count
  $blockedCount = @($checks | Where-Object { $_.status -eq 'BLOCKED' }).Count
  Write-Host "PASS: $passCount  FAIL: $failCount  BLOCKED: $blockedCount"
  $rollback = Get-Content -LiteralPath $rollbackPath -Raw | ConvertFrom-Json
  Write-Host ('Rollback: ' + ($rollback | ConvertTo-Json -Depth 4 -Compress))
  $exitCode = if ($failCount -gt 0) { 1 } else { 0 }
  }
}
catch {
  Write-Error "setup error: $($_.Exception.Message)" -ErrorAction Continue
  $exitCode = 2
}
finally {
  if ($direct) { Remove-PSSession $direct -ErrorAction SilentlyContinue }
  if ($HostMigrate -and (Test-Path -LiteralPath $legacyDir)) {
    # the copy of the old tree is this lab's own (made by Build-LegacyHostTree, directly under this VM's folder); it is removed unless it has turned into a link
    if (-not ((Get-Item -LiteralPath $legacyDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { Remove-Item -LiteralPath $legacyDir -Recurse -Force -ErrorAction SilentlyContinue }
    # a run that stopped before the VM was made (wrong ref, failed build, short memory) leaves nothing behind: the VM's folder, empty, goes too (no -Recurse: a folder with anything in it stays)
    if (-not $vmCreated -and (Test-Path -LiteralPath $root) -and -not (Get-ChildItem -LiteralPath $root -Force)) { Remove-Item -LiteralPath $root -ErrorAction SilentlyContinue }
  }
  if ($vmCreated -and -not $KeepVm) {
    try {
      $ownedVm = Get-VM -Id $vmId
      if ($ownedVm.Name -ne $VmName -or $ownedVm.Notes -notlike '*disposable*') {
        throw 'VM identity or disposable note verification failed; refusing cleanup'
      }
      $parent = (Get-VHD -Path $childVhd).ParentPath
      if ([IO.Path]::GetFullPath($parent) -ne [IO.Path]::GetFullPath($golden)) {
        throw 'child VHD parent verification failed; refusing cleanup'
      }
      Stop-VM -VM $ownedVm -TurnOff -Force
      Remove-VM -VM $ownedVm -Force
      Remove-Item -LiteralPath $childVhd -Force
      $stillReadOnly = (Get-Item -LiteralPath $golden).IsReadOnly
      Write-Host "vm deleted; golden read-only: $stillReadOnly"
    }
    catch {
      Write-Error "VM cleanup failed: $($_.Exception.Message)" -ErrorAction Continue
      $exitCode = 2
    }
  }
  elseif ($vmCreated) { Write-Host "vm kept: $VmName" }
}
exit $exitCode
