# Host-side screen capture and input for a Hyper-V VM (no guest agent).
# Dot-source:  . (Join-Path $PSScriptRoot 'vm-io.ps1')
$ErrorActionPreference = 'Stop'
$script:Ns = 'root\virtualization\v2'

function Get-AlberaVmCs([string]$Name) {
  $vm = Get-CimInstance -Namespace $script:Ns -ClassName Msvm_ComputerSystem -Filter "ElementName='$Name'"
  if (-not $vm) { throw "VM not found: $Name" }
  $vm
}

function Save-AlberaVmScreenshot([string]$Name, [string]$Path, [int]$Width = 1024, [int]$Height = 768) {
  $vm = Get-AlberaVmCs $Name
  $svc = Get-CimInstance -Namespace $script:Ns -ClassName Msvm_VirtualSystemManagementService
  $settings = Get-CimAssociatedInstance -InputObject $vm -ResultClassName Msvm_VirtualSystemSettingData |
    Where-Object { $_.VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized' } | Select-Object -First 1
  $r = Invoke-CimMethod -InputObject $svc -MethodName GetVirtualSystemThumbnailImage -Arguments @{
    TargetSystem = $settings; WidthPixels = [uint16]$Width; HeightPixels = [uint16]$Height }
  if ($r.ReturnValue -ne 0 -or -not $r.ImageData) { throw "thumbnail failed: rv=$($r.ReturnValue)" }
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
  $rect = New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bmp.PixelFormat)
  [byte[]]$bytes = $r.ImageData
  $capacity = $data.Stride * $Height
  if ($bytes.Length -ne $Width * $Height * 2) { Write-Warning "thumbnail bytes=$($bytes.Length) expected=$($Width * $Height * 2)" }
  [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, [Math]::Min($bytes.Length, $capacity))
  $bmp.UnlockBits($data)
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Get-Item $Path
}

function Get-AlberaVmDevice([string]$Name, [string]$Class) {
  $vm = Get-AlberaVmCs $Name
  $dev = Get-CimAssociatedInstance -InputObject $vm -ResultClassName $Class | Select-Object -First 1
  if (-not $dev) { throw "$Class not available on $Name" }
  $dev
}

function Send-AlberaVmKey([string]$Name, [int]$VirtualKey) {
  $kb = Get-AlberaVmDevice $Name 'Msvm_Keyboard'
  (Invoke-CimMethod -InputObject $kb -MethodName TypeKey -Arguments @{ KeyCode = [uint32]$VirtualKey }).ReturnValue
}

function Send-AlberaVmText([string]$Name, [string]$Text) {
  $kb = Get-AlberaVmDevice $Name 'Msvm_Keyboard'
  (Invoke-CimMethod -InputObject $kb -MethodName TypeText -Arguments @{ AsciiText = $Text }).ReturnValue
}

function Move-AlberaVmMouse([string]$Name, [int]$X, [int]$Y) {
  $m = Get-AlberaVmDevice $Name 'Msvm_SyntheticMouse'
  (Invoke-CimMethod -InputObject $m -MethodName SetAbsolutePosition -Arguments @{ HorizontalPosition = [int32]$X; VerticalPosition = [int32]$Y }).ReturnValue
}

function Click-AlberaVmMouse([string]$Name, [int]$Button = 1) {
  $m = Get-AlberaVmDevice $Name 'Msvm_SyntheticMouse'
  (Invoke-CimMethod -InputObject $m -MethodName ClickButton -Arguments @{ ButtonIndex = [uint32]$Button }).ReturnValue
}
