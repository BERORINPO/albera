# Issue #23 one-command disposable VM lab. Usage:
#   powershell -File test/windows-service-lab/lab-vm.ps1 [-Build] [-KeepVm]
# Changes nothing on the host except creating/deleting this one VM and its folder.
# The golden disk is never modified, and the guest is disconnected from the network.
param(
  [string]$VmName = ('albera-lab-' + (Get-Date -Format 'yyyyMMdd-HHmmss')),
  [string]$PasswordFile = 'U:\dev\hyperv\albera-poc-01\local-secrets\admin-password.txt',
  [string]$EvidenceDir,
  [switch]$Build,
  [switch]$KeepVm
)
$ErrorActionPreference = 'Stop'

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
  if (Get-VM -Name $VmName -ErrorAction SilentlyContinue) { throw "VM already exists: $VmName" }
  if (-not (Test-Path -LiteralPath $PasswordFile -PathType Leaf)) { throw "password file is missing: $PasswordFile" }
  if (-not $Build) {
    # Fail before creating a VM when the binaries run-lab.ps1 copies are missing.
    foreach ($p in @('test\windows-service-lab\bin\Release\net10.0-windows\win-x64\publish',
                     'src\runtime\windows-broker\bin\Release\net10.0-windows\win-x64\publish',
                     'src\runtime\windows-approval-authority\bin\Release\net10.0-windows\win-x64\publish')) {
      if (-not (Test-Path -LiteralPath (Join-Path $repo $p))) { throw "missing build output (run with -Build): $p" }
    }
  }

  # Refuse to start when the host is short on memory: a 4 GB VM on a full host froze the PC (2026-10-31).
  $vmMemoryGB = 4
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
      & npm run build:approval-authority
      if ($LASTEXITCODE -ne 0) { throw "build:approval-authority failed ($LASTEXITCODE)" }
    }
    & node scripts/windows-service-lab-inputs.mjs $inputsFile
    if ($LASTEXITCODE -ne 0) { throw "input generation failed ($LASTEXITCODE)" }
  }
  finally { Pop-Location }

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
