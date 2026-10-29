# PROTOTYPE: fixed read-only checks inside a Hyper-V guest over PowerShell Direct (spec/room.md section 7).
# Runs as the calling user (needs "Hyper-V Administrators"); this is NOT the privileged Host Broker of ADR-002.
# Reads ONE JSON request from stdin and prints ONE JSON line to stdout:
#   in:  {"vmName":"name","user":"Administrator","password":"...","checks":[{"kind":"file_text","path":"C:\\x.txt","text":"..."}]}
#   out: {"ok":true,"findings":["ok","missing","differs","error"]}  or  {"ok":false,"code":"..."}
# The password only becomes a PSCredential in memory: it is never printed, logged or put on a command line.
# Exception messages are never printed (they may hold host paths or user names). Only finding codes leave the VM.
$ErrorActionPreference = 'Stop'
$VmNameRe = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
$UserRe = '^(?:\.\\)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
$PathRe = '^[A-Za-z]:\\(?:[^\\/:*?"<>|\x00-\x1f]+\\)*[^\\/:*?"<>|\x00-\x1f]*$'
$NameRe = '^[^\\/:*?"<>|\x00-\x1f]{1,255}$'
$Kinds = @('file_exists', 'file_text', 'dir_has')
$Findings = @('ok', 'missing', 'differs', 'error')
$MaxChecks = 8
$MaxRequestBytes = 65536

# Written straight to stdout: Fail is also called inside an assignment, whose pipeline output would be captured.
function Fail([string]$code) { [Console]::Out.WriteLine(([pscustomobject]@{ ok = $false; code = $code } | ConvertTo-Json -Compress)); exit 1 }

function Test-GuestPath([object]$p) {
  if ($p -isnot [string] -or $p.Length -gt 260 -or $p -notmatch $PathRe) { return $false }
  return -not (($p -split '\\') | Where-Object { $_ -eq '..' -or $_ -eq '.' })
}

# The ONE script block that runs inside the VM. Read-only: Test-Path, Get-Item and a read of at most 64 KiB.
# It compares inside the VM and returns one finding per check, in order. File contents never leave the VM.
$GuestCheck = {
  param([object[]]$Checks)
  $ErrorActionPreference = 'Stop'
  $MaxBytes = 65536
  foreach ($c in $Checks) {
    try {
      $p = [string]$c.path
      if ($c.kind -eq 'file_exists') {
        if (Test-Path -LiteralPath $p -PathType Leaf) { 'ok' } else { 'missing' }
      }
      elseif ($c.kind -eq 'file_text') {
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { 'missing' }
        else {
          $item = Get-Item -LiteralPath $p -Force
          if ($item.Length -gt $MaxBytes) { 'differs' }
          else {
            $buf = New-Object byte[] $MaxBytes
            $n = 0
            $fs = [System.IO.File]::Open($item.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            try {
              while ($n -lt $MaxBytes) { $r = $fs.Read($buf, $n, $MaxBytes - $n); if ($r -le 0) { break }; $n += $r }
            }
            finally { $fs.Dispose() }
            $sr = New-Object System.IO.StreamReader((New-Object System.IO.MemoryStream($buf, 0, $n)), (New-Object System.Text.UTF8Encoding($false)), $true)
            try { $text = $sr.ReadToEnd() } finally { $sr.Dispose() }
            if ($text.Trim() -ceq [string]$c.text) { 'ok' } else { 'differs' }
          }
        }
      }
      elseif ($c.kind -eq 'dir_has') {
        if (-not (Test-Path -LiteralPath $p -PathType Container)) { 'missing' }
        elseif (Test-Path -LiteralPath ([System.IO.Path]::Combine($p, [string]$c.name))) { 'ok' }
        else { 'missing' }
      }
      else { 'error' }
    }
    catch { 'error' }
  }
}

try {
  # Raw UTF-8 bytes from stdin (paths may hold non-ASCII text); the buffer is cleared once parsed.
  $stdin = [Console]::OpenStandardInput()
  $ms = New-Object System.IO.MemoryStream
  $stdin.CopyTo($ms)
  $bytes = $ms.ToArray()
  $ms.SetLength(0)
  if ($bytes.Length -gt $MaxRequestBytes) { Fail 'guest_check_invalid' }
  $req = [System.Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  [Array]::Clear($bytes, 0, $bytes.Length)
}
catch { Fail 'guest_check_invalid' }

if ($req.vmName -isnot [string] -or $req.vmName -notmatch $VmNameRe) { Fail 'guest_check_invalid' }
if ($req.user -isnot [string] -or $req.user -notmatch $UserRe) { Fail 'guest_check_invalid' }
if ($req.password -isnot [string] -or $req.password.Length -lt 1) { Fail 'guest_check_invalid' }
$raw = @($req.checks)
if ($raw.Count -lt 1 -or $raw.Count -gt $MaxChecks) { Fail 'guest_check_invalid' }
# Rebuild each check from its allowed fields only, checked again here.
$checks = foreach ($c in $raw) {
  if ($c.kind -notin $Kinds -or -not (Test-GuestPath $c.path)) { Fail 'guest_check_invalid' }
  if ($c.kind -eq 'file_text' -and ($c.text -isnot [string] -or $c.text.Length -gt 200)) { Fail 'guest_check_invalid' }
  if ($c.kind -eq 'dir_has' -and ($c.name -isnot [string] -or $c.name -notmatch $NameRe -or $c.name -eq '..' -or $c.name -eq '.')) { Fail 'guest_check_invalid' }
  @{ kind = [string]$c.kind; path = [string]$c.path; text = [string]$c.text; name = [string]$c.name }
}
$checks = @($checks)

# Hyper-V names are matched without case by Invoke-Command, so the name must be unique that way too.
try { $vms = @(Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $req.vmName }) }
catch { Fail 'guest_unavailable' }
if ($vms.Count -eq 0) { Fail 'guest_vm_not_found' }
if ($vms.Count -gt 1 -or $vms[0].Name -cne $req.vmName) { Fail 'guest_unavailable' }
if ([string]$vms[0].State -ne 'Running') { Fail 'guest_vm_not_running' }

try {
  $secure = ConvertTo-SecureString -String $req.password -AsPlainText -Force
  $req.password = $null
  $cred = New-Object System.Management.Automation.PSCredential($req.user, $secure)
}
catch { Fail 'guest_check_invalid' }

try {
  # -VMName, not -VMId: with -VMId PowerShell Direct failed to open the session on the real host (PSSessionStateBroken).
  $out = @(Invoke-Command -VMName $req.vmName -Credential $cred -ScriptBlock $GuestCheck -ArgumentList (, $checks) -ErrorAction Stop)
}
catch {
  $category = [string]$_.CategoryInfo.Category
  $id = [string]$_.FullyQualifiedErrorId
  if ($category -in @('AuthenticationError', 'SecurityError', 'PermissionDenied') -or $id -match 'Credential|Logon|Password|AccessDenied') { Fail 'guest_auth_failed' }
  Fail 'guest_unavailable'
}
finally { $cred = $null; $secure = $null }

$found = @($out | ForEach-Object { [string]$_ })
if ($found.Count -ne $checks.Count -or @($found | Where-Object { $_ -notin $Findings }).Count -gt 0) { Fail 'guest_unavailable' }
[pscustomobject]@{ ok = $true; findings = $found } | ConvertTo-Json -Compress
