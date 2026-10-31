# Issue #115 step 4: measure what a Hyper-V checkpoint before task.start would cost. Usage:
#   powershell -File test/windows-service-lab/checkpoint-cost.ps1 [-SizesMB 256,1024] [-OutFile <json>]
# Creates one disposable offline VM from the read-only golden disk, measures checkpoint create / disk growth /
# restore / discard (merge) for the Standard and Production checkpoint types, then deletes the VM.
# Changes nothing on the host except that VM and its folder. Prints no password.
param(
  [string]$VmName = ('albera-ckpt-' + (Get-Date -Format 'yyyyMMdd-HHmmss')),
  [string]$PasswordFile = 'U:\dev\hyperv\albera-poc-01\local-secrets\admin-password.txt',
  [int[]]$SizesMB = @(256, 1024),
  [string]$OutFile,
  [switch]$KeepVm
)
$ErrorActionPreference = 'Stop'

$golden = 'U:\dev\hyperv\golden\ws2025-desktop-golden.vhdx'
$labNote = 'ALBERA lab (disposable; delete after run)'
$root = Join-Path 'U:\dev\hyperv\clones' $VmName
$childVhd = Join-Path $root "$VmName.vhdx"
if ([string]::IsNullOrWhiteSpace($OutFile)) { $OutFile = Join-Path $root 'checkpoint-cost.json' }
$vmMemoryGB = 4
$hostHeadroomGB = 4
$readyTimeoutMinutes = 6
$mergeTimeoutMinutes = 10
$vmCreated = $false
$vmId = $null
$exitCode = 2

function Wait-Direct([string]$Name, [pscredential]$Credential) {
  $deadline = (Get-Date).AddMinutes($readyTimeoutMinutes)
  while ((Get-Date) -lt $deadline) {
    try { return New-PSSession -VMName $Name -Credential $Credential }
    catch { Start-Sleep -Seconds 5 }
  }
  throw "PowerShell Direct was not ready within $readyTimeoutMinutes minutes"
}

# Writes $MB of random data to one guest file and flushes it to disk, so the checkpoint's differencing disk grows.
function Write-GuestLoad($Session, [int]$MB, [string]$Path) {
  Invoke-Command -Session $Session -ArgumentList $MB, $Path -ScriptBlock {
    param($mb, $path)
    $buffer = New-Object byte[] (1MB)
    $random = New-Object System.Random
    $stream = [IO.File]::Open($path, 'Create', 'Write', 'None')
    try {
      for ($i = 0; $i -lt $mb; $i++) { $random.NextBytes($buffer); $stream.Write($buffer, 0, $buffer.Length) }
      $stream.Flush($true)
    } finally { $stream.Dispose() }
  }
}

function Get-AvhdxBytes {
  $files = @(Get-ChildItem -LiteralPath $root -Recurse -Filter '*.avhdx' -ErrorAction SilentlyContinue)
  if ($files.Count -eq 0) { return 0 }
  return ($files | Measure-Object -Property Length -Sum).Sum
}

function Get-StateBytes {
  $files = @(Get-ChildItem -LiteralPath $root -Recurse -Include '*.vmrs', '*.vsv', '*.bin' -ErrorAction SilentlyContinue)
  if ($files.Count -eq 0) { return 0 }
  return ($files | Measure-Object -Property Length -Sum).Sum
}

# Discarding a checkpoint merges its differencing disk back; done when the VM's disk is the child VHDX again.
function Wait-Merge {
  $deadline = (Get-Date).AddMinutes($mergeTimeoutMinutes)
  while ((Get-Date) -lt $deadline) {
    $path = (Get-VMHardDiskDrive -VMName $VmName | Select-Object -First 1).Path
    if ([IO.Path]::GetFullPath($path) -eq [IO.Path]::GetFullPath($childVhd) -and (Get-AvhdxBytes) -eq 0) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "merge did not finish within $mergeTimeoutMinutes minutes"
}

function Measure-Seconds([scriptblock]$Block) { [Math]::Round((Measure-Command $Block).TotalSeconds, 2) }

# One sample: checkpoint, dirty the disk, restore, discard. Returns the measured numbers.
function Measure-Sample([string]$Type, [int]$MB, [pscredential]$Credential, [ref]$Session) {
  Set-VM -Name $VmName -CheckpointType $Type
  $name = "ckpt-$Type-$MB"
  # A running VM already has state files about the size of its memory; count only what the checkpoint adds.
  $stateBefore = Get-StateBytes
  $createS = Measure-Seconds { Checkpoint-VM -Name $VmName -SnapshotName $name }
  $stateBytes = (Get-StateBytes) - $stateBefore
  # A Production checkpoint freezes the guest through VSS and leaves the PowerShell Direct session Broken (2026-10-31).
  Remove-PSSession $Session.Value -ErrorAction SilentlyContinue
  $Session.Value = Wait-Direct $VmName $Credential
  $writeS = Measure-Seconds { Write-GuestLoad $Session.Value $MB 'C:\albera-ckpt-load.bin' }
  $avhdxBytes = Get-AvhdxBytes
  Remove-PSSession $Session.Value
  $restoreS = Measure-Seconds { Restore-VMSnapshot -VMName $VmName -Name $name -Confirm:$false }
  # A Production checkpoint restores to Off; a Standard one restores the running state.
  $readyS = Measure-Seconds {
    if ((Get-VM -Name $VmName).State -ne 'Running') { Start-VM -Name $VmName | Out-Null }
    $Session.Value = Wait-Direct $VmName $Credential
  }
  $loadGone = -not (Invoke-Command -Session $Session.Value -ScriptBlock { Test-Path 'C:\albera-ckpt-load.bin' })
  $discardS = Measure-Seconds { Remove-VMSnapshot -VMName $VmName -Name $name; Wait-Merge }
  [ordered]@{
    type = $Type; writtenMB = $MB; createS = $createS; guestWriteS = $writeS
    differencingDiskMB = [Math]::Round($avhdxBytes / 1MB); savedStateMB = [Math]::Round($stateBytes / 1MB)
    restoreS = $restoreS; readyAfterRestoreS = $readyS; restoreUndidWrite = $loadGone; discardMergeS = $discardS
  }
}

$session = $null
try {
  if (-not (Test-Path -LiteralPath $golden -PathType Leaf)) { throw "golden VHDX is missing: $golden" }
  if (-not (Get-Item -LiteralPath $golden).IsReadOnly) { throw "golden VHDX must be read-only: $golden" }
  if (Get-VM -Name $VmName -ErrorAction SilentlyContinue) { throw "VM already exists: $VmName" }
  if (-not (Test-Path -LiteralPath $PasswordFile -PathType Leaf)) { throw "password file is missing: $PasswordFile" }
  # Same memory guard as lab-vm.ps1: a 4 GB VM on a full host froze the PC (2026-10-31).
  $freeGB = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB
  if ($freeGB -lt ($vmMemoryGB + $hostHeadroomGB)) {
    throw ("host has {0:N1} GB free; need {1} GB. Stop other VMs and retry." -f $freeGB, ($vmMemoryGB + $hostHeadroomGB))
  }

  New-Item -ItemType Directory -Force -Path $root | Out-Null
  New-VHD -Differencing -ParentPath $golden -Path $childVhd | Out-Null
  $vm = New-VM -Name $VmName -Generation 2 -MemoryStartupBytes ($vmMemoryGB * 1GB) -VHDPath $childVhd -Path $root
  $vmCreated = $true
  $vmId = $vm.Id
  Set-VM -VM $vm -Notes $labNote -AutomaticCheckpointsEnabled $false
  Set-VMMemory -VMName $VmName -DynamicMemoryEnabled $false
  Set-VMProcessor -VMName $VmName -Count 2
  Get-VMNetworkAdapter -VMName $VmName | Disconnect-VMNetworkAdapter
  Start-VM -VM $vm | Out-Null

  $secure = (Get-Content -LiteralPath $PasswordFile -Raw).Trim() | ConvertTo-SecureString -AsPlainText -Force
  $credential = New-Object System.Management.Automation.PSCredential('Administrator', $secure)
  $session = Wait-Direct $VmName $credential

  $samples = @()
  foreach ($type in 'Production', 'Standard') {
    foreach ($mb in $SizesMB) {
      # A failed checkpoint is a result too (a Standard one timed out saving RAM, 2026-10-31): record it and go on.
      try { $sample = Measure-Sample $type $mb $credential ([ref]$session) }
      catch {
        $sample = [ordered]@{ type = $type; writtenMB = $mb; failed = $_.Exception.Message.Split("`n")[0].Trim() }
        Get-VMSnapshot -VMName $VmName | Remove-VMSnapshot
        Wait-Merge
        if ((Get-VM -Name $VmName).State -ne 'Running') { Start-VM -Name $VmName | Out-Null }
        if ($session) { Remove-PSSession $session -ErrorAction SilentlyContinue }
        $session = Wait-Direct $VmName $credential
      }
      $samples += $sample
      Write-Host ($sample | ConvertTo-Json -Compress)
    }
  }
  $os = Get-CimInstance Win32_OperatingSystem
  $report = [ordered]@{
    measuredAt = (Get-Date).ToUniversalTime().ToString('o')
    host = [ordered]@{ os = $os.Version; memoryGB = [Math]::Round($os.TotalVisibleMemorySize / 1MB) }
    vm = [ordered]@{ memoryGB = $vmMemoryGB; cpus = 2; disk = 'differencing child of the golden WS2025 image'; network = 'none' }
    samples = $samples
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $OutFile -Parent) | Out-Null
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutFile -Encoding UTF8
  Write-Host "report: $OutFile"
  $exitCode = 0
}
catch {
  Write-Error "setup error: $($_.Exception.Message)" -ErrorAction Continue
  $exitCode = 2
}
finally {
  if ($session) { Remove-PSSession $session -ErrorAction SilentlyContinue }
  if ($vmCreated -and -not $KeepVm) {
    try {
      $ownedVm = Get-VM -Id $vmId
      if ($ownedVm.Name -ne $VmName -or $ownedVm.Notes -notlike '*disposable*') {
        throw 'VM identity or disposable note verification failed; refusing cleanup'
      }
      Stop-VM -VM $ownedVm -TurnOff -Force
      Get-VMSnapshot -VM $ownedVm | Remove-VMSnapshot
      Remove-VM -VM $ownedVm -Force
      Get-ChildItem -LiteralPath $root -Recurse -Include '*.vhdx', '*.avhdx' | Remove-Item -Force
      Write-Host "vm deleted; golden read-only: $((Get-Item -LiteralPath $golden).IsReadOnly)"
    }
    catch {
      Write-Error "VM cleanup failed: $($_.Exception.Message)" -ErrorAction Continue
      $exitCode = 2
    }
  }
  elseif ($vmCreated) { Write-Host "vm kept: $VmName" }
}
exit $exitCode
