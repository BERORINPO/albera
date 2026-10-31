# PROTOTYPE: host-side Hyper-V lifecycle for differencing-disk clones of a golden image.
# Runs as the calling user; this is NOT the privileged Host Broker of ADR-002.
# Reads ONE JSON request from stdin and prints ONE JSON result to stdout.
#   {"method":"inspect","vmName":"albera-x"}
#   {"method":"create","vmName":..,"cloneRoot":..,"vmDir":..,"parentPath":..,"childPath":..,"vcpu":2,"memoryMiB":2048,"notes":".."}
#   {"method":"network","vmName":"albera-x"}   (read-only: inspect's fields plus the adapter facts the Broker classifies, in one read; see broker-contract/network-attestation.mjs)
#   {"method":"start"|"stop"|"remove","vmName":..,"expect":{"computerId":..,"generation":1}, ...}
#   {"method":"annotate","vmName":..,"expect":{..},"notes":"..","incarnationId":".."}   (rewrites Notes of an owned VM; used to write the retirement identity)
# "expect" may also carry vmId (the Hyper-V VM GUID), projectId and incarnationId: when present they must equal the VM's own id / Notes values.
# "expect.identity" makes them mandatory: "vm" = vmId must be given, "full" = vmId, projectId and incarnationId must all be given.
# The Node side sets it on every path that has a retirement record, so a request that leaves the identity out is refused here, not trusted.
# Every path comes from the trusted Node-side configuration, never from an operation.
# Errors are reported as {"ok":false,"code":"...","notApplied":bool} with a fixed code; messages are never printed.
$ErrorActionPreference = 'Stop'
$VmNameRe = '^albera-[A-Za-z0-9][A-Za-z0-9-]{0,56}$'
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
    # isolated-none: keep the NIC but leave it unconnected to any switch
    Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter
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

function Invoke-Start($Req) {
  $vm = Require-Vm $Req.vmName $Req.expect
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
