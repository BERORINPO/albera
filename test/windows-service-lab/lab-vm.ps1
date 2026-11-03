# Issue #23 one-command disposable VM lab. Usage:
#   powershell -File test/windows-service-lab/lab-vm.ps1 [-Build] [-KeepVm] [-HostInstall | -HyperV]
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
  [switch]$HyperV
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

$golden = 'U:\dev\hyperv\golden\ws2025-desktop-golden.vhdx'
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
$vmId = $null
$direct = $null
$exitCode = 2

try {
  if (-not (Test-Path -LiteralPath $golden -PathType Leaf)) { throw "golden VHDX is missing: $golden" }
  $goldenItem = Get-Item -LiteralPath $golden
  if (-not $goldenItem.IsReadOnly) { throw "golden VHDX must be read-only: $golden" }
  if ($HyperV -and $HostInstall) { throw '-HyperV and -HostInstall are separate labs; choose one' }
  if (Get-VM -Name $VmName -ErrorAction SilentlyContinue) { throw "VM already exists: $VmName" }
  if (-not (Test-Path -LiteralPath $PasswordFile -PathType Leaf)) { throw "password file is missing: $PasswordFile" }
  if (-not $Build) {
    # Fail before creating a VM when the binaries run-lab.ps1 copies are missing.
    $needed = @('test\windows-service-lab\bin\Release\net10.0-windows\win-x64\publish',
                'src\runtime\windows-broker\bin\Release\net10.0-windows\win-x64\publish')
    # The Hyper-V lab runs the lab shim, the real Broker and the Control Plane pipe client (it sends the claims that make a lease); the other labs also copy the Approval Authority.
    if ($HyperV) { $needed += @('src\runtime\windows-broker-pipe-client\bin\Release\net10.0-windows\win-x64\publish') }
    else { $needed += @('src\runtime\windows-approval-authority\bin\Release\net10.0-windows\win-x64\publish') }
    foreach ($p in $needed) {
      if (-not (Test-Path -LiteralPath (Join-Path $repo $p))) { throw "missing build output (run with -Build): $p" }
    }
  }

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
      if (-not $HyperV) {
        & npm run build:approval-authority
        if ($LASTEXITCODE -ne 0) { throw "build:approval-authority failed ($LASTEXITCODE)" }
      }
    }
    if (-not $HostInstall -and -not $HyperV) {
      & node scripts/windows-service-lab-inputs.mjs $inputsFile
      if ($LASTEXITCODE -ne 0) { throw "input generation failed ($LASTEXITCODE)" }
    }
  }
  finally { Pop-Location }

  if ($HyperV) {
    $hvOut = @(Invoke-HyperVRightsLab -VmName $VmName -Credential $credential -Repo $repo -OutputFile $outputFile -ResultsFile (Join-Path $EvidenceDir 'hyperv-results.json') -KeepVm:$KeepVm)
    $exitCode = [int]($hvOut | Select-Object -Last 1)
  }
  elseif ($HostInstall) {
    # The guest gets the host scripts and the three publish folders at the same relative paths under a stand-in repository root, then runs the hook
    # with ALBERA_LAB_VM=1 set in this session only (the installer accepts its lab-only parameters only then).
    $guestRepo = 'C:\albera-host-lab'
    $rels = @('src\runtime\windows-broker\bin\Release\net10.0-windows\win-x64\publish',
              'src\runtime\windows-approval-authority\bin\Release\net10.0-windows\win-x64\publish',
              'src\runtime\windows-broker-pipe-client\bin\Release\net10.0-windows\win-x64\publish')
    foreach ($rel in $rels) { if (-not (Test-Path -LiteralPath (Join-Path $repo $rel))) { throw "missing build output (run with -Build): $rel" } }
    $session = New-PSSession -VMName $VmName -Credential $credential
    try {
      Invoke-Command -Session $session -ScriptBlock { param($r, $rels) foreach ($x in @('scripts\host', 'tools') + $rels) { New-Item -ItemType Directory -Force -Path (Join-Path $r $x) | Out-Null } } -ArgumentList $guestRepo, $rels
      Copy-Item -ToSession $session -Path (Join-Path $repo 'scripts\host\*') -Destination "$guestRepo\scripts\host" -Recurse -Force
      foreach ($rel in $rels) { Copy-Item -ToSession $session -Path (Join-Path (Join-Path $repo $rel) '*') -Destination (Join-Path $guestRepo $rel) -Recurse -Force }
      Copy-Item -ToSession $session -Path (Join-Path $PSScriptRoot 'lab-host-install-check.ps1') -Destination "$guestRepo\tools\lab-host-install-check.ps1" -Force
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
