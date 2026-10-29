# PROTOTYPE: host-side screen capture and input for a Hyper-V VM (no guest agent).
# Runs as the calling user; this is NOT the privileged Host Broker of ADR-002.
# Reads ONE JSON request from stdin and prints ONE JSON result to stdout.
#   {"op":"capture","vm":"name","width":1024,"height":768}
#   {"op":"input","vm":"name","steps":[{"op":"move","x":10,"y":20},{"op":"down","button":1},{"op":"up","button":1}]}
# Errors are reported as {"ok":false,"code":"..."} with a fixed code; messages are never printed.
$ErrorActionPreference = 'Stop'
$Ns = 'root\virtualization\v2'
$VmNameRe = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'

function Fail([string]$code) { [pscustomobject]@{ ok = $false; code = $code } | ConvertTo-Json -Compress; exit 1 }

# Input arrives as primitive steps already planned and bounded by desktop-control.mjs (planDesktopInput).
# They are checked again here: fixed op names, integers in range, printable ASCII text, bounded totals.
$MaxSteps = 256
$MaxSleepMs = 12000
$MaxTextLength = 512

function Get-IntField([object]$Step, [string]$Name, [int]$Min, [int]$Max) {
  $v = $Step.$Name
  if ($v -isnot [int] -and $v -isnot [long]) { throw 'desktop_input_rejected' }
  if ($v -lt $Min -or $v -gt $Max) { throw 'desktop_input_rejected' }
  [int]$v
}

# Returns the steps as fixed-shape records, or throws before anything is sent to the VM.
function Get-CheckedSteps([object]$Steps) {
  if ($Steps -isnot [array] -or $Steps.Count -lt 1 -or $Steps.Count -gt $MaxSteps) { throw 'desktop_input_rejected' }
  $sleepTotal = 0
  foreach ($s in $Steps) {
    if ($s -isnot [pscustomobject]) { throw 'desktop_input_rejected' }
    $rec = switch ([string]$s.op) {
      'move'    { @{ op = 'move'; x = (Get-IntField $s 'x' 0 4095); y = (Get-IntField $s 'y' 0 4095) } }
      'down'    { @{ op = 'down'; button = (Get-IntField $s 'button' 1 3) } }
      'up'      { @{ op = 'up'; button = (Get-IntField $s 'button' 1 3) } }
      'press'   { @{ op = 'press'; vk = (Get-IntField $s 'vk' 1 254) } }
      'release' { @{ op = 'release'; vk = (Get-IntField $s 'vk' 1 254) } }
      'tap'     { @{ op = 'tap'; vk = (Get-IntField $s 'vk' 1 254) } }
      'wheel'   { @{ op = 'wheel'; delta = (Get-IntField $s 'delta' -1200 1200) } }
      'sleep'   { $ms = Get-IntField $s 'ms' 0 10000; $sleepTotal += $ms; @{ op = 'sleep'; ms = $ms } }
      'text' {
        $t = $s.text
        if ($t -isnot [string] -or $t.Length -lt 1 -or $t.Length -gt $MaxTextLength -or $t -notmatch '^[ -~]+$') { throw 'desktop_input_rejected' }
        @{ op = 'text'; text = $t }
      }
      default { throw 'desktop_input_rejected' }
    }
    $rec
  }
  if ($sleepTotal -gt $MaxSleepMs) { throw 'desktop_input_rejected' }
}

function Get-VmDevice([object]$Vm, [string]$Class) {
  $dev = Get-CimAssociatedInstance -InputObject $Vm -ResultClassName $Class | Select-Object -First 1
  if (-not $dev) { throw 'desktop_unavailable' }
  $dev
}

function Get-VmComputerSystem([string]$Name) {
  $vm = Get-CimInstance -Namespace $Ns -ClassName Msvm_ComputerSystem -Filter "ElementName='$Name'"
  if (-not $vm) { throw 'desktop_vm_not_found' }
  $vm
}

function Get-ScreenPngBase64([object]$Vm, [int]$Width, [int]$Height) {
  $svc = Get-CimInstance -Namespace $Ns -ClassName Msvm_VirtualSystemManagementService
  $settings = Get-CimAssociatedInstance -InputObject $Vm -ResultClassName Msvm_VirtualSystemSettingData |
    Where-Object { $_.VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized' } | Select-Object -First 1
  $r = Invoke-CimMethod -InputObject $svc -MethodName GetVirtualSystemThumbnailImage -Arguments @{
    TargetSystem = $settings; WidthPixels = [uint16]$Width; HeightPixels = [uint16]$Height }
  if ($r.ReturnValue -ne 0 -or -not $r.ImageData) { throw 'desktop_unavailable' }
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
  try {
    $rect = New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bmp.PixelFormat)
    [byte[]]$bytes = $r.ImageData
    [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, [Math]::Min($bytes.Length, $data.Stride * $Height))
    $bmp.UnlockBits($data)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    [Convert]::ToBase64String($ms.ToArray())
  }
  finally { $bmp.Dispose() }
}

# Runs checked steps. Every key and button pressed here is released if any step fails.
function Invoke-Plan([object]$Vm, [object[]]$Steps) {
  $kb = Get-VmDevice $Vm 'Msvm_Keyboard'
  $mouse = Get-VmDevice $Vm 'Msvm_SyntheticMouse'
  $heldKeys = [System.Collections.Generic.List[int]]::new()
  $heldButtons = [System.Collections.Generic.List[int]]::new()
  $call = {
    param($dev, $method, $arguments)
    $rv = (Invoke-CimMethod -InputObject $dev -MethodName $method -Arguments $arguments).ReturnValue
    if ($rv -ne 0) { throw 'desktop_input_rejected' }
  }
  try {
    foreach ($s in $Steps) {
      switch ($s.op) {
        'move'    { & $call $mouse 'SetAbsolutePosition' @{ HorizontalPosition = [int32]$s.x; VerticalPosition = [int32]$s.y } }
        'down'    { & $call $mouse 'SetButtonState' @{ ButtonIndex = [uint32]$s.button; IsDown = $true }; $heldButtons.Add($s.button) }
        'up'      { & $call $mouse 'SetButtonState' @{ ButtonIndex = [uint32]$s.button; IsDown = $false }; [void]$heldButtons.Remove($s.button) }
        'press'   { & $call $kb 'PressKey' @{ KeyCode = [uint32]$s.vk }; $heldKeys.Add($s.vk) }
        'release' { & $call $kb 'ReleaseKey' @{ KeyCode = [uint32]$s.vk }; [void]$heldKeys.Remove($s.vk) }
        'tap'     { & $call $kb 'TypeKey' @{ KeyCode = [uint32]$s.vk } }
        'text'    { & $call $kb 'TypeText' @{ AsciiText = [string]$s.text } }
        'wheel'   { & $call $mouse 'SetScrollPosition' @{ ScrollPositionDelta = [int32]$s.delta } }
        'sleep'   { if ($s.ms -gt 0) { Start-Sleep -Milliseconds $s.ms } }
      }
    }
  }
  catch {
    for ($i = $heldButtons.Count - 1; $i -ge 0; $i--) {
      try { Invoke-CimMethod -InputObject $mouse -MethodName SetButtonState -Arguments @{ ButtonIndex = [uint32]$heldButtons[$i]; IsDown = $false } | Out-Null } catch {}
    }
    for ($i = $heldKeys.Count - 1; $i -ge 0; $i--) {
      try { Invoke-CimMethod -InputObject $kb -MethodName ReleaseKey -Arguments @{ KeyCode = [uint32]$heldKeys[$i] } | Out-Null } catch {}
    }
    throw
  }
}

try {
  $req = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($req.vm -isnot [string] -or $req.vm -notmatch $VmNameRe) { Fail 'desktop_vm_not_found' }
  $vm = Get-VmComputerSystem $req.vm
  if ($req.op -eq 'capture') {
    $png = Get-ScreenPngBase64 $vm ([int]$req.width) ([int]$req.height)
    [pscustomobject]@{ ok = $true; png = $png } | ConvertTo-Json -Compress
  }
  elseif ($req.op -eq 'input') {
    $steps = @(Get-CheckedSteps $req.steps)
    Invoke-Plan $vm $steps
    [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
  }
  else { Fail 'desktop_input_rejected' }
}
catch {
  $code = [string]$_.Exception.Message
  if ($code -notin @('desktop_input_rejected', 'desktop_unavailable', 'desktop_vm_not_found')) { $code = 'desktop_unavailable' }
  Fail $code
}
