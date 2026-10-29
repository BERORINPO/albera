# PROTOTYPE: host-side screen capture and input for a Hyper-V VM (no guest agent).
# Runs as the calling user; this is NOT the privileged Host Broker of ADR-002.
# Reads ONE JSON request from stdin and prints ONE JSON result to stdout.
#   {"op":"capture","vm":"name","width":1024,"height":768}
#   {"op":"input","vm":"name","action":{"action":"left_click","coordinate":[10,20]}}
# Errors are reported as {"ok":false,"code":"..."} with a fixed code; messages are never printed.
$ErrorActionPreference = 'Stop'
$Ns = 'root\virtualization\v2'
$VmNameRe = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'

function Fail([string]$code) { [pscustomobject]@{ ok = $false; code = $code } | ConvertTo-Json -Compress; exit 1 }

$VK = @{
  'return'=0x0D; 'enter'=0x0D; 'escape'=0x1B; 'esc'=0x1B; 'tab'=0x09; 'backspace'=0x08; 'delete'=0x2E;
  'space'=0x20; 'up'=0x26; 'down'=0x28; 'left'=0x25; 'right'=0x27; 'home'=0x24; 'end'=0x23;
  'page_up'=0x21; 'page_down'=0x22; 'insert'=0x2D;
  'ctrl'=0x11; 'alt'=0x12; 'shift'=0x10; 'super'=0x5B
}
$Punct = @{ '-'=0xBD; '='=0xBB; ','=0xBC; '.'=0xBE; '/'=0xBF; ';'=0xBA; "'"=0xDE; '['=0xDB; ']'=0xDD; '\'=0xDC; '`'=0xC0 }

function Get-Vk([string]$k) {
  $n = $k.ToLowerInvariant()
  if ($VK.ContainsKey($n)) { return $VK[$n] }
  if ($n -match '^f([1-9]|1[0-2])$') { return 0x6F + [int]$Matches[1] }
  if ($n.Length -eq 1) {
    $c = [char]::ToUpperInvariant($n[0])
    if ($c -match '[A-Z0-9]') { return [int]$c }
    if ($Punct.ContainsKey([string]$c)) { return $Punct[[string]$c] }
  }
  throw 'desktop_input_rejected'
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

function Invoke-VmAction([object]$Vm, [object]$A) {
  $kb = Get-VmDevice $Vm 'Msvm_Keyboard'
  $mouse = Get-VmDevice $Vm 'Msvm_SyntheticMouse'
  $press = { param($c) Invoke-CimMethod -InputObject $kb -MethodName PressKey -Arguments @{ KeyCode = [uint32]$c } | Out-Null }
  $release = { param($c) Invoke-CimMethod -InputObject $kb -MethodName ReleaseKey -Arguments @{ KeyCode = [uint32]$c } | Out-Null }
  $moveTo = { param($xy) Invoke-CimMethod -InputObject $mouse -MethodName SetAbsolutePosition -Arguments @{ HorizontalPosition = [int32]$xy[0]; VerticalPosition = [int32]$xy[1] } | Out-Null }
  $button = { param($b, $down) Invoke-CimMethod -InputObject $mouse -MethodName SetButtonState -Arguments @{ ButtonIndex = [uint32]$b; IsDown = [bool]$down } | Out-Null }
  $click = {
    param($b, $times)
    if ($A.coordinate) { & $moveTo $A.coordinate; Start-Sleep -Milliseconds 80 }
    1..$times | ForEach-Object { & $button $b $true; Start-Sleep -Milliseconds 60; & $button $b $false; Start-Sleep -Milliseconds 60 }
  }
  switch ($A.action) {
    'left_click'      { & $click 1 1 }
    'right_click'     { & $click 2 1 }
    'double_click'    { & $click 1 2 }
    'mouse_move'      { & $moveTo $A.coordinate }
    'left_mouse_down' { & $button 1 $true }
    'left_mouse_up'   { & $button 1 $false }
    'type' {
      $kbd = Get-VmDevice $Vm 'Msvm_Keyboard'
      $rv = (Invoke-CimMethod -InputObject $kbd -MethodName TypeText -Arguments @{ AsciiText = [string]$A.text }).ReturnValue
      if ($rv -ne 0) { throw 'desktop_input_rejected' }
    }
    'key' {
      $parts = ([string]$A.key) -split '\+'
      $codes = @($parts | ForEach-Object { Get-Vk $_ })
      $mods = if ($codes.Count -gt 1) { $codes[0..($codes.Count - 2)] } else { @() }
      $main = $codes[-1]
      $n = if ($A.repeat) { [int]$A.repeat } else { 1 }
      1..$n | ForEach-Object {
        $mods | ForEach-Object { & $press $_ }
        try { Invoke-CimMethod -InputObject $kb -MethodName TypeKey -Arguments @{ KeyCode = [uint32]$main } | Out-Null }
        finally { $r = @($mods); [array]::Reverse($r); $r | ForEach-Object { & $release $_ } }
      }
    }
    'scroll' {
      if ($A.coordinate) { & $moveTo $A.coordinate }
      $amt = if ($A.amount) { [int]$A.amount } else { 3 }
      $delta = if ($A.direction -eq 'up') { 120 * $amt } else { -120 * $amt }
      Invoke-CimMethod -InputObject $mouse -MethodName SetScrollPosition -Arguments @{ ScrollPositionDelta = [int32]$delta } | Out-Null
    }
    'wait'            { Start-Sleep -Milliseconds ([int]$A.durationMs) }
    default           { throw 'desktop_input_rejected' }
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
    Invoke-VmAction $vm $req.action
    [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
  }
  else { Fail 'desktop_input_rejected' }
}
catch {
  $code = [string]$_.Exception.Message
  if ($code -notin @('desktop_input_rejected', 'desktop_unavailable', 'desktop_vm_not_found')) { $code = 'desktop_unavailable' }
  Fail $code
}
