# PROTOTYPE: fixed read-only checks inside a Hyper-V guest over PowerShell Direct (spec/room.md section 7).
# Runs as the calling user (needs "Hyper-V Administrators"); this is NOT the privileged Host Broker of ADR-002.
# Reads ONE JSON request from stdin and prints ONE JSON line to stdout:
#   in:  {"vmName":"name","user":"Administrator","password":"...","checks":[{"kind":"file_text","path":"C:\\x.txt","text":"..."}]}
#   out: {"ok":true,"findings":["ok","missing","differs","error"]}  or  {"ok":false,"code":"..."}
# The password only becomes a SecureString / PSCredential in memory: it is never printed or put on a command line,
# and it is never passed to a cmdlet (module logging, event 4103, records cmdlet parameters and pipeline input).
# The request is therefore parsed with System.Text.Json and the SecureString is built one character at a time.
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

# The ONE script block that runs inside the VM. Read-only, and only .NET calls: a function or alias defined inside the
# guest (for example by a startup script on the PowerShell Direct endpoint) cannot shadow them the way it could shadow
# Test-Path, Get-Item or New-Object. It still trusts the guest's runtime: a passed check is not tamper-proof.
# It compares inside the VM (a read of at most 64 KiB) and returns one finding per check, in order.
$GuestCheck = {
  param([object[]]$Checks)
  $max = 65536
  foreach ($c in $Checks) {
    try {
      $p = [string]$c.path
      if ($c.kind -eq 'file_exists') {
        if ([System.IO.File]::Exists($p)) { 'ok' } else { 'missing' }
      }
      elseif ($c.kind -eq 'file_text') {
        if (-not [System.IO.File]::Exists($p)) { 'missing' }
        else {
          $fs = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
          try {
            if ($fs.Length -gt $max) { 'differs' }
            else {
              $buf = [byte[]]::new($max)
              $n = 0
              while ($n -lt $max) { $r = $fs.Read($buf, $n, $max - $n); if ($r -le 0) { break }; $n += $r }
              $sr = [System.IO.StreamReader]::new([System.IO.MemoryStream]::new($buf, 0, $n), [System.Text.UTF8Encoding]::new($false), $true)
              try { $text = $sr.ReadToEnd() } finally { $sr.Dispose() }
              if ($text.Trim() -ceq [string]$c.text) { 'ok' } else { 'differs' }
            }
          }
          finally { $fs.Dispose() }
        }
      }
      elseif ($c.kind -eq 'dir_has') {
        if (-not [System.IO.Directory]::Exists($p)) { 'missing' }
        else {
          $entry = [System.IO.Path]::Combine($p, [string]$c.name)
          if ([System.IO.File]::Exists($entry) -or [System.IO.Directory]::Exists($entry)) { 'ok' } else { 'missing' }
        }
      }
      else { 'error' }
    }
    catch { 'error' }
  }
}

# ---- the request: raw UTF-8 from stdin, parsed with System.Text.Json (no cmdlet ever sees the password) ----
$vmName = $null; $user = $null; $secure = $null; $raw = @()
try {
  $ms = [System.IO.MemoryStream]::new()
  [Console]::OpenStandardInput().CopyTo($ms)
  $bytes = $ms.ToArray()
  $ms.SetLength(0)
  if ($bytes.Length -gt $MaxRequestBytes) { Fail 'guest_check_invalid' }
  $doc = [System.Text.Json.JsonDocument]::Parse([System.IO.MemoryStream]::new($bytes))
  [Array]::Clear($bytes, 0, $bytes.Length)
  try {
    $root = $doc.RootElement
    if ($root.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { Fail 'guest_check_invalid' }
    foreach ($prop in $root.EnumerateObject()) {
      $v = $prop.Value
      $isString = $v.ValueKind -eq [System.Text.Json.JsonValueKind]::String
      if ($prop.Name -ceq 'vmName' -and $isString) { $vmName = $v.GetString() }
      elseif ($prop.Name -ceq 'user' -and $isString) { $user = $v.GetString() }
      elseif ($prop.Name -ceq 'password' -and $isString) {
        $secure = [System.Security.SecureString]::new()
        foreach ($ch in $v.GetString().ToCharArray()) { $secure.AppendChar($ch) }
        $secure.MakeReadOnly()
      }
      elseif ($prop.Name -ceq 'checks' -and $v.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
        $raw = @(foreach ($item in $v.EnumerateArray()) {
          $c = @{}
          if ($item.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
            foreach ($f in $item.EnumerateObject()) {
              if ($f.Value.ValueKind -eq [System.Text.Json.JsonValueKind]::String) { $c[$f.Name] = $f.Value.GetString() } else { $c[$f.Name] = $null }
            }
          }
          $c
        })
      }
    }
  }
  finally { $doc.Dispose() }
}
catch { Fail 'guest_check_invalid' }

if ($vmName -isnot [string] -or $vmName -notmatch $VmNameRe) { Fail 'guest_check_invalid' }
if ($user -isnot [string] -or $user -notmatch $UserRe) { Fail 'guest_check_invalid' }
if ($null -eq $secure -or $secure.Length -lt 1) { Fail 'guest_check_invalid' }
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
try { $vms = @(Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $vmName }) }
catch { Fail 'guest_unavailable' }
if ($vms.Count -eq 0) { Fail 'guest_vm_not_found' }
if ($vms.Count -gt 1 -or $vms[0].Name -cne $vmName) { Fail 'guest_unavailable' }
if ([string]$vms[0].State -ne 'Running') { Fail 'guest_vm_not_running' }

$cred = [System.Management.Automation.PSCredential]::new($user, $secure)
try {
  # -VMName, not -VMId: with -VMId PowerShell Direct failed to open the session on the real host (PSSessionStateBroken).
  $out = @(Invoke-Command -VMName $vmName -Credential $cred -ScriptBlock $GuestCheck -ArgumentList (, $checks) -ErrorAction Stop)
}
catch {
  $category = [string]$_.CategoryInfo.Category
  $id = [string]$_.FullyQualifiedErrorId
  if ($category -in @('AuthenticationError', 'SecurityError', 'PermissionDenied') -or $id -match 'Credential|Logon|Password|AccessDenied') { Fail 'guest_auth_failed' }
  Fail 'guest_unavailable'
}
finally { $cred = $null; $secure.Dispose(); $secure = $null }

$found = @($out | ForEach-Object { [string]$_ })
if ($found.Count -ne $checks.Count -or @($found | Where-Object { $_ -notin $Findings }).Count -gt 0) { Fail 'guest_unavailable' }
[pscustomobject]@{ ok = $true; findings = $found } | ConvertTo-Json -Compress
