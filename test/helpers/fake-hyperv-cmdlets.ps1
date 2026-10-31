# SYNTHETIC stand-ins for the few Hyper-V cmdlets that env-io.ps1 uses in its `checkpoint` and `restore` ops. Dot-sourced by run-env-io-with-fakes.ps1 BEFORE env-io.ps1 runs, so these
# functions shadow the real cmdlets (a function wins over a cmdlet of the same name): no VM, no host change. They prove the script's own logic (which checkpoints it removes, which one it
# restores, what it refuses), NOT how Hyper-V behaves; the real-host checks (scripts/*-real.mjs) do that. State lives in the JSON file named by $env:ALBERA_FAKE_HV_STATE:
#   { "vms": [ { "Id", "Name", "Notes", "State", "CheckpointType" } ],
#     "snapshots": [ { "Id", "VMId", "Name", "State", "Ticks", "SavedNotes" } ],
#     "flags": { "failList", "failRemoveNames": [], "failRestore", "failSetNotes", "failCheckpoint", "snapshotState" },
#     "log": [ "Remove <name>", "Restore <name>", ... ], "nextTicks": <int> }
# ASCII only.


function Read-FakeState { Get-Content -LiteralPath $env:ALBERA_FAKE_HV_STATE -Raw | ConvertFrom-Json }
function Save-FakeState($State) { $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $env:ALBERA_FAKE_HV_STATE -Encoding ascii }
function ConvertTo-FakeVm($Raw) { [pscustomobject]@{ Id = [string]$Raw.Id; Name = [string]$Raw.Name; Notes = [string]$Raw.Notes; State = [string]$Raw.State; CheckpointType = [string]$Raw.CheckpointType } }
function ConvertTo-FakeSnapshot($Raw) {
  [pscustomobject]@{ Id = [string]$Raw.Id; VMId = [string]$Raw.VMId; Name = [string]$Raw.Name; State = [string]$Raw.State; CreationTime = [datetime]::new([int64]$Raw.Ticks); SavedNotes = [string]$Raw.SavedNotes }
}

function Import-Module { [CmdletBinding()] param([Parameter(Position = 0)][string]$Name) }

function Get-VM {
  [CmdletBinding()] param([string]$Name, [string]$Id)
  $found = @((Read-FakeState).vms | Where-Object { ($Name -and $_.Name -ceq $Name) -or ($Id -and ([string]$_.Id) -ieq $Id) })
  if ($found.Count -eq 0) { Write-Error 'no such VM'; return }
  foreach ($v in $found) { ConvertTo-FakeVm $v }
}

function Set-VM {
  [CmdletBinding()] param($VM, [string]$CheckpointType, [string]$Notes)
  $state = Read-FakeState
  if ($PSBoundParameters.ContainsKey('Notes') -and $state.flags.failSetNotes) { throw 'fake: Set-VM -Notes failed' }
  foreach ($v in $state.vms) {
    if ([string]$v.Id -ine [string]$VM.Id) { continue }
    if ($PSBoundParameters.ContainsKey('CheckpointType')) { $v.CheckpointType = $CheckpointType }
    if ($PSBoundParameters.ContainsKey('Notes')) { $v.Notes = $Notes }
  }
  Save-FakeState $state
}

function Checkpoint-VM {
  [CmdletBinding()] param($VM, [string]$SnapshotName, [switch]$Passthru)
  $state = Read-FakeState
  if ($state.flags.failCheckpoint) { throw 'fake: Checkpoint-VM failed' }
  $v = @($state.vms | Where-Object { [string]$_.Id -ieq [string]$VM.Id })[0]
  $snapshotState = if ($state.flags.snapshotState) { [string]$state.flags.snapshotState } elseif ($v.CheckpointType -eq 'ProductionOnly') { 'Off' } else { 'Saved' }
  $state.nextTicks = [int64]$state.nextTicks + 10000000
  $raw = [pscustomobject]@{ Id = [guid]::NewGuid().ToString(); VMId = [string]$v.Id; Name = $SnapshotName; State = $snapshotState; Ticks = [int64]$state.nextTicks; SavedNotes = [string]$v.Notes }
  $state.snapshots = @($state.snapshots) + $raw
  Save-FakeState $state
  if ($Passthru) { ConvertTo-FakeSnapshot $raw }
}

function Get-VMSnapshot {
  [CmdletBinding()] param($VM)
  $state = Read-FakeState
  if ($state.flags.failList) { throw 'fake: Get-VMSnapshot failed' }
  foreach ($s in @($state.snapshots | Where-Object { [string]$_.VMId -ieq [string]$VM.Id })) { ConvertTo-FakeSnapshot $s }
}

function Remove-VMSnapshot {
  [CmdletBinding()] param($VMSnapshot)
  $state = Read-FakeState
  if (@($state.flags.failRemoveNames) -contains [string]$VMSnapshot.Name) { throw 'fake: Remove-VMSnapshot failed' }
  $state.snapshots = @($state.snapshots | Where-Object { [string]$_.Id -ine [string]$VMSnapshot.Id })
  $state.log = @($state.log) + ('Remove ' + [string]$VMSnapshot.Name)
  Save-FakeState $state
}

function Restore-VMSnapshot {
  [CmdletBinding()] param($VMSnapshot, [switch]$Confirm)
  $state = Read-FakeState
  if ($state.flags.failRestore) { throw 'fake: Restore-VMSnapshot failed' }
  foreach ($v in $state.vms) {
    if ([string]$v.Id -ine [string]$VMSnapshot.VMId) { continue }
    $v.Notes = [string]$VMSnapshot.SavedNotes
    $v.State = 'Off'
  }
  $state.log = @($state.log) + ('Restore ' + [string]$VMSnapshot.Name)
  Save-FakeState $state
}
