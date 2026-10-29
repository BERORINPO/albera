# PROTOTYPE: the host side of the OPT-IN guest screen helper (screen-helper.ps1), over PowerShell Direct.
# Runs as the calling user (needs "Hyper-V Administrators"); this is NOT the privileged Host Broker of ADR-002.
# Requests are JSON lines on stdin; every answer is ONE JSON line on stdout with a fixed code on failure.
#   install / remove (one request, then exit):
#     in:  {"op":"install","vmName":"name","user":"Administrator","password":"..."}     out: {"ok":true}
#   serve (the first line opens one PowerShell Direct session; each later line reads the newest frame; EOF ends it):
#     in:  {"op":"serve","vmName":"name","user":"Administrator","password":"..."}       out: {"ok":true}
#     in:  {"op":"read","width":1024,"height":768}   out: {"ok":true,"realWidth":1920,"realHeight":1080,"png":"<base64>"}
# The password only becomes a SecureString / PSCredential in memory: it is never printed, put on a command line or
# passed to a cmdlet. The request is parsed with System.Text.Json and the SecureString is built one character at a time.
# Exception messages are never printed (they may hold host paths or user names).
# The frame comes from inside the guest and is untrusted: the guest scales it to the asked size, the host Driver
# checks the PNG signature, IHDR and size, and nothing on the host decodes the image.
$ErrorActionPreference = 'Stop'
$VmNameRe = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
$UserRe = '^(?:\.\\)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
$MaxLineChars = 4096
$MaxFrameAgeMs = 5000
$HelperPath = Join-Path $PSScriptRoot 'screen-helper.ps1'

function Write-Line([string]$json) { [Console]::Out.WriteLine($json); [Console]::Out.Flush() }
function Fail([string]$code) { Write-Line ('{"ok":false,"code":"' + $code + '"}'); exit 1 }

# ---- the ONE script block of each operation that runs inside the VM ----
# Fixed constants only; the operation, the helper's text and the task's user are the only values sent in.
# install and remove both stop every running helper first. Stopping the task is not enough: it ends conhost but the
# powershell.exe below it keeps running, and two helpers would then fight over the same frame files.
$GuestSetup = {
  param([string]$Op, [string]$HelperText, [string]$User)
  $dir = 'C:\ProgramData\Albera'
  $task = 'ALBERA Screen Helper'
  $helpers = { @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { [string]$_.CommandLine -like '*\ProgramData\Albera\screen-helper.ps1*' }) }
  if ([System.IO.Directory]::Exists($dir)) { [System.IO.File]::WriteAllText("$dir\stop", '') }
  if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $task
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
  }
  for ($i = 0; $i -lt 15 -and (& $helpers).Count -gt 0; $i++) { Start-Sleep -Milliseconds 200 } # a helper checks the stop file every ~1 s
  foreach ($p in & $helpers) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  if ([System.IO.Directory]::Exists($dir)) {
    foreach ($f in @('stop', 'frame.tmp', 'last-error.txt', 'screen-helper.ps1') + @([System.IO.Directory]::GetFiles($dir, 'frame-*.png'))) {
      $p = [System.IO.Path]::Combine($dir, [System.IO.Path]::GetFileName($f))
      if ([System.IO.File]::Exists($p)) { [System.IO.File]::Delete($p) }
    }
  }
  if ($Op -ceq 'remove') {
    if ([System.IO.Directory]::Exists($dir) -and @([System.IO.Directory]::EnumerateFileSystemEntries($dir)).Count -eq 0) { [System.IO.Directory]::Delete($dir) }
    return 'removed'
  }
  [void][System.IO.Directory]::CreateDirectory($dir)
  [System.IO.File]::WriteAllText("$dir\screen-helper.ps1", $HelperText, [System.Text.Encoding]::ASCII)
  # conhost --headless: no window at all. -WindowStyle Hidden alone is ignored when Windows Terminal is the default
  # terminal (Windows Server 2025), and the helper's window would then sit on the screen the AI is looking at.
  $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$dir\screen-helper.ps1`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
  $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
  # The helper exits after ten failed frames in a row; the task then starts it again a minute later.
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  [void](Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force)
  Start-ScheduledTask -TaskName $task
  'installed'
}

# Reads the newest frame (the highest frame-<ticks>.png; at most 32 MiB, written less than $MaxAgeMs ago by the guest's
# own clock) and scales it to the asked size. Only .NET calls. Returns 'missing' / 'stale' / 'bad' or [width, height, base64].
$GuestRead = {
  param([int]$Width, [int]$Height, [int]$MaxAgeMs)
  $dir = 'C:\ProgramData\Albera'
  if (-not [System.IO.Directory]::Exists($dir)) { return 'missing' }
  [string[]]$frames = [System.IO.Directory]::GetFiles($dir, 'frame-*.png') # typed: one file must stay an array, not a string
  if ($frames.Count -eq 0) { return 'missing' }
  [Array]::Sort($frames, [System.StringComparer]::Ordinal)
  $p = $frames[-1]
  if (([DateTime]::UtcNow - [System.IO.File]::GetLastWriteTimeUtc($p)).TotalMilliseconds -gt $MaxAgeMs) { return 'stale' }
  [void][System.Reflection.Assembly]::LoadWithPartialName('System.Drawing')
  $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
  try {
    $fs = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
    try {
      if ($fs.Length -gt 32MB) { return 'bad' }
      $ms = [System.IO.MemoryStream]::new()
      $fs.CopyTo($ms)
    }
    finally { $fs.Dispose() }
    $ms.Position = 0
    $src = [System.Drawing.Image]::FromStream($ms)
    try {
      $dst = [System.Drawing.Bitmap]::new($Width, $Height)
      try {
        $g = [System.Drawing.Graphics]::FromImage($dst)
        try {
          $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
          $g.DrawImage($src, 0, 0, $Width, $Height)
        }
        finally { $g.Dispose() }
        $out = [System.IO.MemoryStream]::new()
        $dst.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
        @($src.Width, $src.Height, [Convert]::ToBase64String($out.ToArray()))
      }
      finally { $dst.Dispose() }
    }
    finally { $src.Dispose() }
  }
  catch { 'bad' }
}

# ---- requests: UTF-8 lines from stdin, parsed with System.Text.Json (no cmdlet ever sees the password) ----
$stdin = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false))

function Read-Request {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { return $null }
  if ($line.Length -gt $MaxLineChars) { Fail 'desktop_input_rejected' }
  $req = @{}
  try {
    $doc = [System.Text.Json.JsonDocument]::Parse($line)
    try {
      if ($doc.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { Fail 'desktop_input_rejected' }
      foreach ($prop in $doc.RootElement.EnumerateObject()) {
        $v = $prop.Value
        if ($prop.Name -ceq 'password' -and $v.ValueKind -eq [System.Text.Json.JsonValueKind]::String) {
          $s = [System.Security.SecureString]::new()
          foreach ($ch in $v.GetString().ToCharArray()) { $s.AppendChar($ch) }
          $s.MakeReadOnly()
          $req.secure = $s
        }
        elseif ($v.ValueKind -eq [System.Text.Json.JsonValueKind]::String) { $req[$prop.Name] = $v.GetString() }
        elseif ($v.ValueKind -eq [System.Text.Json.JsonValueKind]::Number) { $n = 0; if ($v.TryGetInt32([ref]$n)) { $req[$prop.Name] = $n } }
      }
    }
    finally { $doc.Dispose() }
  }
  catch { Fail 'desktop_input_rejected' }
  $line = $null
  $req
}

function Get-Credential-From([hashtable]$req) {
  if ($req.vmName -isnot [string] -or $req.vmName -notmatch $VmNameRe) { Fail 'desktop_vm_not_found' }
  if ($req.user -isnot [string] -or $req.user -notmatch $UserRe) { Fail 'desktop_input_rejected' }
  if ($null -eq $req.secure -or $req.secure.Length -lt 1) { Fail 'desktop_input_rejected' }
  # Hyper-V names are matched without case by PowerShell Direct, so the name must be unique that way too.
  try { $vms = @(Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $req.vmName }) }
  catch { Fail 'desktop_unavailable' }
  if ($vms.Count -eq 0) { Fail 'desktop_vm_not_found' }
  if ($vms.Count -gt 1 -or $vms[0].Name -cne $req.vmName) { Fail 'desktop_unavailable' }
  if ([string]$vms[0].State -ne 'Running') { Fail 'desktop_unavailable' }
  [System.Management.Automation.PSCredential]::new($req.user, $req.secure)
}

function Get-FailCode([object]$err) {
  $category = [string]$err.CategoryInfo.Category
  $id = [string]$err.FullyQualifiedErrorId
  if ($category -in @('AuthenticationError', 'SecurityError', 'PermissionDenied') -or $id -match 'Credential|Logon|Password|AccessDenied') { return 'desktop_guest_auth_failed' }
  'desktop_unavailable'
}

$first = Read-Request
if ($null -eq $first) { Fail 'desktop_input_rejected' }
$cred = Get-Credential-From $first
$vmName = $first.vmName

if ($first.op -ceq 'install' -or $first.op -ceq 'remove') {
  try {
    $helper = if ($first.op -ceq 'install') { [System.IO.File]::ReadAllText($HelperPath) } else { '' }
    $out = @(Invoke-Command -VMName $vmName -Credential $cred -ScriptBlock $GuestSetup -ArgumentList $first.op, $helper, $first.user -ErrorAction Stop)
  }
  catch { Fail (Get-FailCode $_) }
  finally { $cred = $null; $first.secure.Dispose() }
  if ([string]$out[-1] -notin @('installed', 'removed')) { Fail 'desktop_unavailable' }
  Write-Line '{"ok":true}'
  exit 0
}

if ($first.op -cne 'serve') { Fail 'desktop_input_rejected' }
try {
  # -VMName, not -VMId: with -VMId PowerShell Direct failed to open the session on the real host (PSSessionStateBroken).
  $session = New-PSSession -VMName $vmName -Credential $cred -ErrorAction Stop
}
catch { Fail (Get-FailCode $_) }
finally { $cred = $null; $first.secure.Dispose() }
Write-Line '{"ok":true}'

try {
  while ($true) {
    $req = Read-Request
    if ($null -eq $req) { break }
    if ($req.op -cne 'read' -or $req.width -isnot [int] -or $req.height -isnot [int] -or
      $req.width -lt 1 -or $req.width -gt 4096 -or $req.height -lt 1 -or $req.height -gt 4096) { Fail 'desktop_input_rejected' }
    try { $out = @(Invoke-Command -Session $session -ScriptBlock $GuestRead -ArgumentList $req.width, $req.height, $MaxFrameAgeMs -ErrorAction Stop) }
    catch { Fail 'desktop_unavailable' } # a broken session ends this process; the broker starts a new one next time
    if ($out.Count -eq 1 -and [string]$out[0] -in @('missing', 'stale')) { Write-Line ('{"ok":false,"code":"desktop_guest_frame_' + $out[0] + '"}'); continue }
    $w = $out[0] -as [int]; $h = $out[1] -as [int]; $b64 = $out[2] -as [string]
    if ($out.Count -ne 3 -or $null -eq $w -or $null -eq $h -or $w -lt 1 -or $w -gt 16384 -or $h -lt 1 -or $h -gt 16384 -or
      [string]::IsNullOrEmpty($b64) -or $b64 -notmatch '^[A-Za-z0-9+/]+={0,2}$') {
      Write-Line '{"ok":false,"code":"desktop_unavailable"}'; continue
    }
    Write-Line ('{"ok":true,"realWidth":' + $w + ',"realHeight":' + $h + ',"png":"' + $b64 + '"}')
  }
}
finally { Remove-PSSession $session -ErrorAction SilentlyContinue }
