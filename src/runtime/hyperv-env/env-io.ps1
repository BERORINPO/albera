# PROTOTYPE: host-side Hyper-V lifecycle for differencing-disk clones of a golden image.
# Runs as the calling user; this is NOT the privileged Host Broker of ADR-002.
# Reads ONE JSON request from stdin and prints ONE JSON result to stdout.
#   {"method":"inspect","vmName":"albera-x"}
#   {"method":"create","vmName":..,"cloneRoot":..,"vmDir":..,"parentPath":..,"childPath":..,"vcpu":2,"memoryMiB":2048,"notes":".."}
#   {"method":"network","vmName":"albera-x"}   (read-only: inspect's fields plus the adapter facts the Broker classifies, in one read; see broker-contract/network-attestation.mjs)
#   {"method":"checkpoint","vmName":..,"expect":{"computerId":..,"generation":1,"vmId":..,"identity":"vm"},"checkpointName":"albera-task-<24 hex>"}   (task.start, #115 step 4; see Invoke-Checkpoint)
#   {"method":"restore","vmName":..,"expect":{"computerId":..,"generation":1,"vmId":..,"identity":"vm"},"notes":".."}   (environment.restore_checkpoint, #133; "notes" = the VM's Notes at generation + 1; see Invoke-Restore)
#   {"method":"start"|"stop"|"remove","vmName":..,"expect":{"computerId":..,"generation":1}, ...}   (start may add "requireNoAdapters":true, see Invoke-Start)
#   {"method":"annotate","vmName":..,"expect":{..},"notes":"..","incarnationId":".."}   (rewrites Notes of an owned VM; used to write the retirement identity)
# "expect" may also carry vmId (the Hyper-V VM GUID), projectId and incarnationId: when present they must equal the VM's own id / Notes values.
# "expect.identity" makes them mandatory: "vm" = vmId must be given, "full" = vmId, projectId and incarnationId must all be given.
# The Node side sets it on every path that has a retirement record, so a request that leaves the identity out is refused here, not trusted.
# Every path comes from the trusted Node-side configuration, never from an operation.
# Errors are reported as {"ok":false,"code":"...","notApplied":bool} with a fixed code; messages are never printed.
$ErrorActionPreference = 'Stop'
$VmNameRe = '^albera-[A-Za-z0-9][A-Za-z0-9-]{0,56}$'
$CheckpointNameRe = '^albera-task-[0-9a-f]{24}$'
$GuidRe = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$SafeCodes = @('invalid_provider_state', 'operation_conflict', 'provider_timeout', 'provider_unavailable', 'provider_state_unknown')

function Emit($obj) { $obj | ConvertTo-Json -Compress -Depth 4 }
# A thrown "code|na" means nothing was changed; "code|unk" means the outcome is unknown.
function Reject([string]$code) { throw "$code|na" }
function Abort([string]$code) { throw "$code|unk" }

function Test-Under([string]$Child, [string]$Root) {
  $c = [System.IO.Path]::GetFullPath($Child).TrimEnd('\')
  $r = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  $c.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-OneVm([string]$Name) {
  $vms = @(Get-VM -Name $Name -ErrorAction SilentlyContinue)
  if ($vms.Count -gt 1) { Reject 'invalid_provider_state' }
  if ($vms.Count -eq 1) { return $vms[0] }
  $null
}

# Touch only a VM whose Notes carry the ALBERA identity of this computer and generation.
function Assert-Owned($Vm, $Expect) {
  try { $n = $Vm.Notes | ConvertFrom-Json } catch { Reject 'invalid_provider_state' }
  if ($n.albera -ne 1 -or $n.computerId -cne [string]$Expect.computerId -or $n.generation -ne [int]$Expect.generation) {
    Reject 'invalid_provider_state'
  }
  # Retirement identity. The VM's own id cannot be edited or copied the way Notes can, so it is the anchor.
  $level = [string]$Expect.identity
  if ($level -ne '' -and $level -ne 'vm' -and $level -ne 'full') { Reject 'invalid_provider_state' }
  if ($level -ne '' -and $null -eq $Expect.vmId) { Reject 'invalid_provider_state' }
  if ($level -eq 'full' -and ($null -eq $Expect.projectId -or $null -eq $Expect.incarnationId)) { Reject 'invalid_provider_state' }
  if ($null -ne $Expect.vmId -and ([string]$Vm.Id) -ine [string]$Expect.vmId) { Reject 'invalid_provider_state' }
  if ($null -ne $Expect.projectId -and $n.projectId -cne [string]$Expect.projectId) { Reject 'invalid_provider_state' }
  if ($null -ne $Expect.incarnationId -and $n.incarnationId -cne [string]$Expect.incarnationId) { Reject 'invalid_provider_state' }
}

function Require-Vm([string]$Name, $Expect) {
  $vm = Get-OneVm $Name
  if (-not $vm) { Reject 'invalid_provider_state' }
  Assert-Owned $vm $Expect
  $vm
}

function Invoke-Inspect($Req) {
  $vm = Get-OneVm $Req.vmName
  if (-not $vm) { return @{ ok = $true; exists = $false } }
  @{ ok = $true; exists = $true; state = [string]$vm.State; notes = [string]$vm.Notes; vmId = [string]$vm.Id }
}

# The facts only, never a verdict: one entry per VM network adapter. A connected adapter carries its switch type, a disconnected one carries null.
# If the adapters cannot be read, "adapters" is null (the Node side classifies that as "unknown"), never an empty list (which would mean "none").
function Invoke-Network($Req) {
  $vm = Get-OneVm $Req.vmName
  if (-not $vm) { return @{ ok = $true; exists = $false } }
  try {
    $facts = @()
    foreach ($a in @(Get-VMNetworkAdapter -VM $vm)) {
      $connected = ([bool]$a.Connected) -or (-not [string]::IsNullOrEmpty([string]$a.SwitchName))
      $type = $null
      if ($connected) {
        $type = 'unknown'
        try {
          $switches = @(Get-VMSwitch -Name ([string]$a.SwitchName) -ErrorAction Stop)
          if ($switches.Count -eq 1 -and @('External', 'Internal', 'Private') -ccontains [string]$switches[0].SwitchType) { $type = [string]$switches[0].SwitchType }
        } catch { $type = 'unknown' }
      }
      $facts += @{ connected = $connected; switchType = $type }
    }
    $adapters = $facts
  } catch { $adapters = $null }
  @{ ok = $true; exists = $true; state = [string]$vm.State; notes = [string]$vm.Notes; vmId = [string]$vm.Id; adapters = $adapters }
}

function Invoke-Create($Req) {
  $vmDir = [string]$Req.vmDir
  $childPath = [string]$Req.childPath
  $cloneRoot = [string]$Req.cloneRoot
  if (-not (Test-Under $vmDir $cloneRoot) -or -not (Test-Under $childPath $vmDir)) { Reject 'invalid_provider_state' }
  if ((Split-Path -Parent ([System.IO.Path]::GetFullPath($vmDir))).TrimEnd('\') -ine ([System.IO.Path]::GetFullPath($cloneRoot)).TrimEnd('\')) { Reject 'invalid_provider_state' }
  if (-not (Test-Path -LiteralPath $Req.parentPath -PathType Leaf)) { Reject 'invalid_provider_state' }
  if ((Get-OneVm $Req.vmName) -or (Test-Path -LiteralPath $vmDir)) { Reject 'operation_conflict' }
  $made = $false
  try {
    New-Item -ItemType Directory -Path $vmDir | Out-Null
    $made = $true
    New-VHD -Differencing -ParentPath $Req.parentPath -Path $childPath | Out-Null
    $vm = New-VM -Name $Req.vmName -Generation 2 -MemoryStartupBytes ([int64]$Req.memoryMiB * 1MB) -VHDPath $childPath -Path $cloneRoot
    # isolated-none: remove every network adapter (a Gen 2 VM runs without one; PowerShell Direct and VMBus need none), so the VM attests "none".
    # An adapter that is only disconnected could be reconnected. Re-read afterwards: if any adapter remains the create fails and the catch below rolls it back.
    Get-VMNetworkAdapter -VM $vm | Remove-VMNetworkAdapter
    if (@(Get-VMNetworkAdapter -VM (Get-VM -Name $Req.vmName)).Count -ne 0) { throw 'network adapter remains' }
    Set-VMProcessor -VM $vm -Count ([int]$Req.vcpu)
    Set-VM -VM $vm -Notes ([string]$Req.notes) -AutomaticCheckpointsEnabled $false
    @{ ok = $true; state = [string](Get-VM -Name $Req.vmName).State }
  }
  catch {
    # Roll back only what this call created (the directory did not exist before).
    $left = Get-OneVm $Req.vmName
    if ($left) { Remove-VM -VM $left -Force -ErrorAction SilentlyContinue }
    if ($made -and (Test-Path -LiteralPath $vmDir)) { Remove-Item -LiteralPath $vmDir -Recurse -Force -ErrorAction SilentlyContinue }
    Abort 'provider_unavailable'
  }
}

# Task-start checkpoint (#115 step 4): ONE checkpoint of an owned VM, nothing else. The name is the fixed shape the Node side derives from a validated operationId (anything else is refused here
# too), and the VM id is mandatory, so the checkpoint is taken of exactly the VM the approval names. ProductionOnly (not Production): a Production checkpoint falls back to a Standard one when the
# guest cannot freeze its disk (VSS), and a Standard checkpoint saves the guest's memory, which may hold secrets, to the host disk; ProductionOnly fails instead, and a failure means no attestation.
# Reports the new snapshot's id (a lowercase GUID), the VM's own id and the prune result.
# PRUNE (#133): once the new checkpoint is verified (one snapshot, State Off, GUID id), the OTHER checkpoints of this very VM whose name has the fixed shape are removed, so a VM keeps one ALBERA
# task checkpoint (the one before the latest task) and the host disk does not grow with every task. Never any other checkpoint (a name outside the shape is not touched), never the new one (by id),
# and never -IncludeAllChildSnapshots (the new checkpoint is a child of the old one). Each removal is a snapshot object read from this VM, not a name typed in. A prune that fails or cannot list
# only costs disk, so it does NOT block the attestation (the checkpoint is real and verified): the reply says "pruned" (removed) and "pruneFailed" (a failed list counts 1, each failed removal 1).
# WHAT IS OBSERVED (#133): the snapshot's SnapshotType is NOT used: the listing cmdlet reports SnapshotType Standard for a ProductionOnly checkpoint (real host, 2026-10-31), so
# that field proves nothing. What is used is the VM state the snapshot recorded: with the VM running, a Standard checkpoint (guest memory saved) records snapshot State Saved and a
# ProductionOnly one records State Off (real host, 2026-11-01, control taken on a disposable VM). So the op attests only when the new snapshot's State is Off, on top of setting
# ProductionOnly and reading the VM's setting back before the checkpoint; anything else is an unknown outcome, i.e. no attestation.
# The VM's own CheckpointType is borrowed for this one call and put back in finally, so this op leaves no lasting change to the VM's configuration. If the put-back itself fails the
# VM stays ProductionOnly (the safe direction: no later checkpoint can silently save the guest's memory) and the op reports an unknown outcome, i.e. no attestation.
function Invoke-Checkpoint($Req) {
  if ($Req.checkpointName -isnot [string] -or $Req.checkpointName -cnotmatch $CheckpointNameRe) { Reject 'invalid_provider_state' }
  if ([string]$Req.expect.identity -ne 'vm' -or $null -eq $Req.expect.vmId) { Reject 'invalid_provider_state' }
  $vm = Require-Vm $Req.vmName $Req.expect
  $previousType = [string]$vm.CheckpointType
  $changedType = $false
  $restoreFailed = $false
  $typeNotSet = $false
  $snapshots = @()
  try {
    if ($previousType -ne 'ProductionOnly') { Set-VM -VM $vm -CheckpointType ProductionOnly -ErrorAction Stop; $changedType = $true }
    # Read back, not assumed: the checkpoint below is taken only while the VM is observed to be ProductionOnly.
    if ([string](Get-VM -Id $vm.Id -ErrorAction Stop).CheckpointType -ne 'ProductionOnly') { $typeNotSet = $true }
    else { $snapshots = @(Checkpoint-VM -VM $vm -SnapshotName $Req.checkpointName -Passthru -ErrorAction Stop) }
  } catch { Abort 'provider_unavailable' }
  finally {
    if ($changedType) { try { Set-VM -VM $vm -CheckpointType $previousType -ErrorAction Stop } catch { $restoreFailed = $true } }
  }
  if ($typeNotSet) { Abort 'provider_unavailable' }
  if ($restoreFailed) { Abort 'provider_state_unknown' }
  if ($snapshots.Count -ne 1) { Abort 'provider_state_unknown' }
  if ([string]$snapshots[0].State -ne 'Off') { Abort 'provider_state_unknown' }
  $checkpointId = ([string]$snapshots[0].Id).ToLowerInvariant()
  if ($checkpointId -cnotmatch $GuidRe) { Abort 'provider_state_unknown' }
  $after = Get-VM -Name $Req.vmName -ErrorAction Stop
  $pruned = 0
  $pruneFailed = 0
  try {
    $old = @(Get-VMSnapshot -VM $after -ErrorAction Stop | Where-Object { $_.Name -cmatch $CheckpointNameRe -and ([string]$_.Id).ToLowerInvariant() -ne $checkpointId })
    foreach ($s in $old) {
      try { Remove-VMSnapshot -VMSnapshot $s -ErrorAction Stop; $pruned++ } catch { $pruneFailed++ }
    }
  } catch { $pruneFailed++ }
  @{ ok = $true; checkpointId = $checkpointId; vmId = ([string]$after.Id).ToLowerInvariant(); state = [string]$after.State; pruned = $pruned; pruneFailed = $pruneFailed }
}

# Restore (#133, environment.restore_checkpoint; undo): put an owned VM back to its NEWEST ALBERA task checkpoint, the one taken before the latest task. The task's work is thrown away, which is
# why this is a separate action that a person always approves (docs/architecture/approval-tiers.md); nothing here decides that. The VM id is mandatory (the checkpoint is restored on exactly the VM
# the approval names), and only a checkpoint with the fixed name shape and a recorded State of Off (no saved memory, see the checkpoint op above) is ever applied, so the VM ends Off, never Running with
# the old guest memory. No ALBERA checkpoint, or two newest with the same creation time, is a refusal and changes nothing. A restore brings back the Notes of the moment of the checkpoint, so the
# NEW generation is written afterwards from the request ("notes": the Notes of the VM as it is NOW, with generation + 1, built by the Node side from the VM's own Notes), never derived from the
# restored ones, and read back: until that is done the outcome is unknown. Old-generation operations, attestations and receipts then fail the generation check of the Broker (stale_generation).
# Nothing outside the VM is undone (pushes, API calls): that is the caller's rule. No checkpoint is removed here, and the VM is not started.
function Invoke-Restore($Req) {
  if ([string]$Req.expect.identity -ne 'vm' -or $null -eq $Req.expect.vmId) { Reject 'invalid_provider_state' }
  if ($Req.notes -isnot [string]) { Reject 'invalid_provider_state' }
  $vm = Require-Vm $Req.vmName $Req.expect
  try { $have = $vm.Notes | ConvertFrom-Json; $want = $Req.notes | ConvertFrom-Json } catch { Reject 'invalid_provider_state' }
  if ($null -ne $have.incarnationId -or $null -ne $want.incarnationId) { Reject 'invalid_provider_state' }
  if ($want.albera -ne 1 -or $want.computerId -cne [string]$Req.expect.computerId -or ($want.generation -isnot [int] -and $want.generation -isnot [long]) -or $want.generation -ne ([int]$Req.expect.generation + 1)) { Reject 'invalid_provider_state' }
  if (@($want.PSObject.Properties).Count -ne 5) { Reject 'invalid_provider_state' }
  if ([string]$want.imageDigest -cne [string]$have.imageDigest -or [string]$want.projectId -cne [string]$have.projectId) { Reject 'invalid_provider_state' }
  try { $found = @(Get-VMSnapshot -VM $vm -ErrorAction Stop | Where-Object { $_.Name -cmatch $CheckpointNameRe } | Sort-Object -Property CreationTime -Descending) } catch { Reject 'provider_unavailable' }
  if ($found.Count -eq 0) { Reject 'invalid_provider_state' }
  if ($found.Count -gt 1 -and $found[0].CreationTime -eq $found[1].CreationTime) { Reject 'invalid_provider_state' }
  $newest = $found[0]
  if ([string]$newest.State -ne 'Off') { Reject 'invalid_provider_state' }
  $checkpointId = ([string]$newest.Id).ToLowerInvariant()
  if ($checkpointId -cnotmatch $GuidRe) { Reject 'invalid_provider_state' }
  try {
    Restore-VMSnapshot -VMSnapshot $newest -Confirm:$false -ErrorAction Stop
    Set-VM -VM (Get-VM -Id $vm.Id -ErrorAction Stop) -Notes $Req.notes -ErrorAction Stop
  } catch { Abort 'provider_state_unknown' }
  $after = Get-VM -Id $vm.Id -ErrorAction Stop
  try { $now = $after.Notes | ConvertFrom-Json } catch { Abort 'provider_state_unknown' }
  if ([string]$after.State -ne 'Off' -or $now.generation -ne $want.generation -or $now.computerId -cne $want.computerId) { Abort 'provider_state_unknown' }
  @{ ok = $true; checkpointId = $checkpointId; vmId = ([string]$after.Id).ToLowerInvariant(); state = [string]$after.State; generation = [int]$now.generation }
}

# "requireNoAdapters": true (an attested-policy start, #128): the VM must have no network adapter at all, read here, in the same call, right before it starts.
# The Node side has already refused any adapter; this closes most of the gap between that read and the start (an adapter added after this line still remains a host-admin race).
function Invoke-Start($Req) {
  $vm = Require-Vm $Req.vmName $Req.expect
  if ($Req.requireNoAdapters -eq $true -and @(Get-VMNetworkAdapter -VM $vm).Count -ne 0) { Reject 'invalid_provider_state' }
  if ($vm.State -eq 'Paused') { Resume-VM -VM $vm }
  elseif ($vm.State -ne 'Running') { Start-VM -VM $vm }
  @{ ok = $true; state = [string](Get-VM -Name $Req.vmName).State }
}

function Invoke-Stop($Req) {
  $vm = Require-Vm $Req.vmName $Req.expect
  if ($vm.State -ne 'Off') {
    # Graceful guest shutdown only (no -TurnOff); bounded by waitSeconds.
    $job = Stop-VM -VM $vm -AsJob
    if (-not (Wait-Job -Job $job -Timeout ([int]$Req.waitSeconds))) {
      Stop-Job -Job $job
      Remove-Job -Job $job -Force
      Abort 'provider_timeout'
    }
    Receive-Job -Job $job | Out-Null
    Remove-Job -Job $job -Force
  }
  @{ ok = $true; state = [string](Get-VM -Name $Req.vmName).State }
}

function Invoke-Annotate($Req) {
  $vm = Require-Vm $Req.vmName $Req.expect
  # Only a blank retirement identity, or the very one being written, may be overwritten.
  try { $have = ($vm.Notes | ConvertFrom-Json).incarnationId } catch { Reject 'invalid_provider_state' }
  if ($null -ne $have -and $have -cne [string]$Req.incarnationId) { Reject 'invalid_provider_state' }
  Set-VM -VM $vm -Notes ([string]$Req.notes)
  @{ ok = $true; state = [string](Get-VM -Name $Req.vmName).State }
}

function Invoke-Remove($Req) {
  $vmDir = [string]$Req.vmDir
  $cloneRoot = [string]$Req.cloneRoot
  if (-not (Test-Under $vmDir $cloneRoot)) { Reject 'invalid_provider_state' }
  $vm = Get-OneVm $Req.vmName
  if (-not $vm) { return @{ ok = $true; state = 'Missing' } }
  Assert-Owned $vm $Req.expect
  $disks = @($vm.HardDrives | ForEach-Object { $_.Path })
  if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
  Remove-VM -VM $vm -Force
  # Delete only disks inside this VM's own folder; the golden parent is never inside it.
  foreach ($d in $disks) {
    if ($d -and (Test-Under $d $vmDir) -and (Test-Path -LiteralPath $d)) { Remove-Item -LiteralPath $d -Force }
  }
  if (Test-Path -LiteralPath $vmDir) {
    $item = Get-Item -LiteralPath $vmDir -Force
    # Never follow a junction or symlink out of the clone root.
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { Abort 'invalid_provider_state' }
    Remove-Item -LiteralPath $vmDir -Recurse -Force
  }
  @{ ok = $true; state = 'Missing' }
}

try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($req.vmName -isnot [string] -or $req.vmName -cnotmatch $VmNameRe) { Reject 'invalid_provider_state' }
  try { Import-Module Hyper-V -ErrorAction Stop } catch { Reject 'provider_unavailable' }
  $result = switch ($req.method) {
    'inspect' { Invoke-Inspect $req }
    'network' { Invoke-Network $req }
    'create'  { Invoke-Create $req }
    'checkpoint' { Invoke-Checkpoint $req }
    'restore' { Invoke-Restore $req }
    'start'   { Invoke-Start $req }
    'stop'    { Invoke-Stop $req }
    'annotate' { Invoke-Annotate $req }
    'remove'  { Invoke-Remove $req }
    default   { Reject 'invalid_provider_state' }
  }
  Emit $result
}
catch {
  $code = 'provider_unavailable'
  $notApplied = $false
  $parts = ([string]$_.Exception.Message) -split '\|'
  if ($parts.Count -eq 2 -and $SafeCodes -contains $parts[0]) {
    $code = $parts[0]
    $notApplied = ($parts[1] -eq 'na')
  }
  Emit @{ ok = $false; code = $code; notApplied = $notApplied }
  exit 1
}
