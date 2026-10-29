# Executes one computer_toolset action against the VM and prints a JSON result.
# Usage: pwsh -File vm-act.ps1 -Vm albera-poc-01 -ActionJson '{"name":"left_click","input":{...}}' -ShotPath out.png
param(
  [Parameter(Mandatory)] [string] $Vm,
  [Parameter(Mandatory)] [string] $ActionJson,
  [string] $ShotPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'vm-io.ps1')

$VK = @{
  'return'=0x0D; 'enter'=0x0D; 'escape'=0x1B; 'esc'=0x1B; 'tab'=0x09; 'backspace'=0x08; 'delete'=0x2E;
  'space'=0x20; 'up'=0x26; 'down'=0x28; 'left'=0x25; 'right'=0x27; 'home'=0x24; 'end'=0x23;
  'page_up'=0x21; 'prior'=0x21; 'page_down'=0x22; 'next'=0x22; 'insert'=0x2D;
  'ctrl'=0x11; 'control'=0x11; 'alt'=0x12; 'shift'=0x10; 'super'=0x5B; 'win'=0x5B; 'cmd'=0x5B; 'meta'=0x5B
}
function Get-Vk([string]$k) {
  $n = $k.ToLowerInvariant() -replace '^(kp_)', ''
  if ($VK.ContainsKey($n)) { return $VK[$n] }
  if ($n -match '^f([1-9]|1[0-2])$') { return 0x6F + [int]$Matches[1] }
  if ($n.Length -eq 1) {
    $c = [char]::ToUpperInvariant($n[0])
    if ($c -match '[A-Z0-9]') { return [int]$c }
    $map = @{ '-'=0xBD; '='=0xBB; ','=0xBC; '.'=0xBE; '/'=0xBF; ';'=0xBA; "'"=0xDE; '['=0xDB; ']'=0xDD; '\'=0xDC; '`'=0xC0 }
    if ($map.ContainsKey([string]$c)) { return $map[[string]$c] }
  }
  throw "unsupported key: $k"
}

$kb = Get-AlberaVmDevice $Vm 'Msvm_Keyboard'
$mouse = Get-AlberaVmDevice $Vm 'Msvm_SyntheticMouse'
function Press([int]$code) { Invoke-CimMethod -InputObject $kb -MethodName PressKey -Arguments @{ KeyCode = [uint32]$code } | Out-Null }
function Release([int]$code) { Invoke-CimMethod -InputObject $kb -MethodName ReleaseKey -Arguments @{ KeyCode = [uint32]$code } | Out-Null }
function Tap([int]$code) { Invoke-CimMethod -InputObject $kb -MethodName TypeKey -Arguments @{ KeyCode = [uint32]$code } | Out-Null }
function MouseTo([int[]]$xy) { Invoke-CimMethod -InputObject $mouse -MethodName SetAbsolutePosition -Arguments @{ HorizontalPosition = [int32]$xy[0]; VerticalPosition = [int32]$xy[1] } | Out-Null }
function Button([int]$b, [bool]$down) { Invoke-CimMethod -InputObject $mouse -MethodName SetButtonState -Arguments @{ ButtonIndex = [uint32]$b; IsDown = $down } | Out-Null }
function Click([int]$b, [int]$times) { 1..$times | ForEach-Object { Button $b $true; Start-Sleep -Milliseconds 60; Button $b $false; Start-Sleep -Milliseconds 60 } }
function WithMods([string]$mods, [scriptblock]$body) {
  $codes = @(); if ($mods) { $codes = $mods -split '\+' | Where-Object { $_ } | ForEach-Object { Get-Vk $_ } }
  $codes | ForEach-Object { Press $_ }
  try { & $body } finally { [array]::Reverse($codes); $codes | ForEach-Object { Release $_ } }
}
function Combo([string]$spec) {
  $parts = $spec -split '\+'
  $main = Get-Vk $parts[-1]
  $mods = if ($parts.Count -gt 1) { $parts[0..($parts.Count - 2)] -join '+' } else { '' }
  WithMods $mods { Tap $main }
}

$a = $ActionJson | ConvertFrom-Json
$in = $a.input
$state = Join-Path $PSScriptRoot '.cursor.json'
$cursor = if (Test-Path $state) { Get-Content $state -Raw | ConvertFrom-Json } else { [pscustomobject]@{ x = 0; y = 0 } }
function SaveCursor([int[]]$xy) { [pscustomobject]@{ x = $xy[0]; y = $xy[1] } | ConvertTo-Json -Compress | Set-Content $state; $script:cursor = [pscustomobject]@{ x = $xy[0]; y = $xy[1] } }
function ClickAt($inp, [int]$b, [int]$times) {
  if ($inp.coordinate) { MouseTo $inp.coordinate; SaveCursor $inp.coordinate; Start-Sleep -Milliseconds 80 }
  WithMods $inp.text { Click $b $times }
}

$text = 'OK'
switch ($a.name) {
  'screenshot'      { Save-AlberaVmScreenshot $Vm $ShotPath 3>$null | Out-Null; $text = 'SHOT' }
  'left_click'      { ClickAt $in 1 1 }
  'right_click'     { ClickAt $in 2 1 }
  'middle_click'    { ClickAt $in 3 1 }
  'double_click'    { ClickAt $in 1 2 }
  'triple_click'    { ClickAt $in 1 3 }
  'mouse_move'      { MouseTo $in.coordinate; SaveCursor $in.coordinate }
  'left_mouse_down' { Button 1 $true }
  'left_mouse_up'   { Button 1 $false }
  'left_click_drag' { MouseTo $in.start_coordinate; Start-Sleep -Milliseconds 80; Button 1 $true; Start-Sleep -Milliseconds 120; MouseTo $in.coordinate; Start-Sleep -Milliseconds 120; Button 1 $false; SaveCursor $in.coordinate }
  'cursor_position' { $text = "X=$($cursor.x), Y=$($cursor.y)" }
  'type'            { $r = Send-AlberaVmText $Vm $in.text; if ($r -ne 0) { throw "TypeText rv=$r (non-ASCII text is not supported)" } }
  'key'             { $n = if ($in.repeat) { [int]$in.repeat } else { 1 }; 1..$n | ForEach-Object { Combo $in.text } }
  'hold_key'        { $code = Get-Vk $in.text; Press $code; Start-Sleep -Seconds ([double]$in.duration); Release $code }
  'wait'            { Start-Sleep -Seconds ([double]$in.duration) }
  'scroll'          {
    if ($in.coordinate) { MouseTo $in.coordinate; SaveCursor $in.coordinate }
    $amt = if ($in.scroll_amount) { [int]$in.scroll_amount } else { 3 }
    $delta = switch ($in.scroll_direction) { 'up' { 120 * $amt } 'down' { -120 * $amt } default { throw "horizontal scroll is not supported" } }
    WithMods $in.text { Invoke-CimMethod -InputObject $mouse -MethodName SetScrollPosition -Arguments @{ ScrollPositionDelta = [int32]$delta } | Out-Null }
  }
  default           { throw "unsupported action: $($a.name)" }
}
[pscustomobject]@{ ok = $true; text = $text } | ConvertTo-Json -Compress
