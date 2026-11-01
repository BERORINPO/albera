# Issue #23 lab, runs AS THE PERSON stand-in (lab-person.ps1) through the lab shim's child mode, inside the disposable lab VM. ASCII only.
#   person-probe.ps1 <targets.json>
# targets.json is an array of { id, kind, path } with kind one of:
#   dir-list     list a folder                          dir-create   create a new file in a folder (FileMode.CreateNew, deleted on close)
#   file-read    open an existing file for reading       file-write   open an existing file for writing (nothing is written; the handle is closed at once)
#   cng-key      open a persisted MACHINE key of the Microsoft Software Key Storage Provider by name (path = the key name)
# Prints one JSON line: { probe: "person-files", results: [ { id, kind, outcome } ] } with outcome "opened", "denied", "missing" or "error:<type>".
# Read-only by design: a write probe that is NOT denied changes nothing either (create-new is deleted on close, open-for-write writes no byte).
param([Parameter(Mandatory = $true)][string]$TargetsFile)
$ErrorActionPreference = 'Stop'

function Get-Outcome([System.Exception]$e) {
  while ($e.InnerException -and -not ($e -is [System.UnauthorizedAccessException] -or $e -is [System.Security.Cryptography.CryptographicException] -or $e -is [System.IO.IOException])) { $e = $e.InnerException }
  if ($e -is [System.UnauthorizedAccessException]) { return 'denied' }
  if ($e -is [System.IO.FileNotFoundException] -or $e -is [System.IO.DirectoryNotFoundException]) { return 'missing' }
  $code = '{0:X8}' -f $e.HResult   # compared as text: hex literals above 0x7FFFFFFF parse differently across PowerShell versions
  if ($code -in @('80070005', '80090010')) { return 'denied' }                     # E_ACCESSDENIED, NTE_PERM
  if ($code -in @('80090016', '80070002', '80070003')) { return 'missing' }        # NTE_BAD_KEYSET, file / path not found
  'error:' + $e.GetType().Name + ':0x' + $code
}

function Invoke-Target($t) {
  try {
    switch ($t.kind) {
      'dir-list' { $null = [System.IO.Directory]::GetFileSystemEntries([string]$t.path) }
      'dir-create' {
        $p = Join-Path ([string]$t.path) ('person-probe-' + [guid]::NewGuid().ToString('N') + '.tmp')
        $s = New-Object System.IO.FileStream($p, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None, 1, [System.IO.FileOptions]::DeleteOnClose)
        $s.Dispose()
      }
      'file-read' { $s = [System.IO.File]::Open([string]$t.path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete); $s.Dispose() }
      'file-write' { $s = [System.IO.File]::Open([string]$t.path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete); $s.Dispose() }
      'cng-key' {
        $k = [System.Security.Cryptography.CngKey]::Open([string]$t.path, [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider, [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey)
        $k.Dispose()
      }
      default { return 'error:unknown_kind' }
    }
    'opened'
  }
  catch { Get-Outcome $_.Exception }
}

$parsed = ConvertFrom-Json (Get-Content -Raw -LiteralPath $TargetsFile)
$targets = @($parsed | ForEach-Object { $_ })   # Windows PowerShell 5.1 hands a JSON array over as one object; the pipeline unrolls it
$results = @($targets | ForEach-Object { [ordered]@{ id = [string]$_.id; kind = [string]$_.kind; outcome = (Invoke-Target $_) } })
[ordered]@{ probe = 'person-files'; results = $results } | ConvertTo-Json -Compress -Depth 4
