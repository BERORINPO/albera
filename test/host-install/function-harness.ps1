# Test harness (Windows PowerShell 5.1, ASCII only, no admin): runs the system-touching helper functions of scripts/host/albera-host.ps1 against a TEMP folder.
# The functions are taken out of the real script by name (PowerShell AST), so the code under test is the shipped code, not a copy. Nothing outside -Work is touched:
# no service, account, ACL, key or Program Files folder is involved (those need an elevated console and the VM lab).
#   function-harness.ps1 -Case <copy|remove|exe|secure> -Work <empty temp folder>     prints one JSON line
param(
  [Parameter(Mandatory = $true)][ValidateSet('copy', 'remove', 'exe', 'secure')][string]$Case,
  [Parameter(Mandatory = $true)][string]$Work
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $repo 'scripts\host\albera-host-lib.ps1')
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts\host\albera-host.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'albera-host.ps1 does not parse' }
$wanted = @('Say', 'Get-Sha256File', 'Test-HasReparsePoint', 'Get-TreeHashes', 'Test-BuiltExe', 'Get-BuildSources', 'Copy-HostBinaries', 'Remove-HostTree', 'Test-ManifestHas', 'New-Manifest', 'Save-Manifest', 'Read-Manifest', 'Test-SecureStringEqual')
$found = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $wanted -contains $n.Name }, $false))
if ($found.Count -ne $wanted.Count) { throw ('expected ' + $wanted.Count + ' functions, found ' + $found.Count) }
foreach ($f in $found) { Invoke-Expression $f.Extent.Text }

Add-Type -AssemblyName System.Web.Extensions
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$K = Get-HostConstants
$RepoRoot = Join-Path $Work 'repo'
$L = Get-HostLayout (Join-Path $Work 'pf') (Join-Path $Work 'pd')
New-Item -ItemType Directory -Force -Path $L.DataRoot, $L.InstallRoot | Out-Null
$script:Manifest = New-Manifest

function Write-Fixture([string]$Dir, [string]$Exe, [switch]$NoManifest) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'sub') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $Dir $Exe), 'exe bytes of ' + $Exe)
  [System.IO.File]::WriteAllText((Join-Path $Dir 'runtime.dll'), 'dll bytes')
  [System.IO.File]::WriteAllText((Join-Path $Dir 'sub\data.json'), '{"a":1}')
  if (-not $NoManifest) { [System.IO.File]::WriteAllText((Join-Path $Dir ($Exe + '.manifest.json')), (@{ sha256 = (Get-Sha256File (Join-Path $Dir $Exe)) } | ConvertTo-Json)) }
}
function Try-Run([scriptblock]$Block) { try { & $Block | Out-Null; $null } catch { $_.Exception.Message } }

$result = [ordered]@{ case = $Case }
switch ($Case) {
  'copy' {
    foreach ($s in (Get-BuildSources)) { Write-Fixture $s.Dir $s.Exe }
    $problem = Try-Run { Copy-HostBinaries }
    $result.firstRunError = $problem
    $result.recorded = @($script:Manifest['created']['binaries'].Keys | Sort-Object)
    $result.destFiles = @(Get-ChildItem -LiteralPath $L.BinRoot -Recurse -File | ForEach-Object { $_.FullName.Substring($L.BinRoot.Length + 1) } | Sort-Object)
    $result.noPartialLeft = (@(Get-ChildItem -LiteralPath $L.BinRoot -Directory | Where-Object { $_.Name -like '*.partial' }).Count -eq 0)
    $src = Get-BuildSources | Select-Object -First 1
    $result.treeEqual = ((Get-TreeHashes $src.Dir).Tree -eq (Get-TreeHashes $src.Dest).Tree) -and ((Get-TreeHashes $src.Dest).Tree -eq $script:Manifest['created']['binaries'][$src.Name]['treeSha256'])
    $result.exeShaRecorded = ($script:Manifest['created']['binaries'][$src.Name]['exeSha256'] -eq (Get-Sha256File (Join-Path $src.Dest $src.Exe)))
    $before = (Get-Item -LiteralPath (Join-Path $src.Dest $src.Exe)).LastWriteTimeUtc.Ticks
    $result.secondRunError = Try-Run { Copy-HostBinaries }
    $result.secondRunUntouched = ($before -eq (Get-Item -LiteralPath (Join-Path $src.Dest $src.Exe)).LastWriteTimeUtc.Ticks)
    [System.IO.File]::WriteAllText((Join-Path $src.Dest 'runtime.dll'), 'tampered')
    $result.tamperedError = Try-Run { Copy-HostBinaries }
    # a leftover .partial folder from a failed earlier run is replaced, not trusted (the tampered copy is cleared first so only the second build is copied again)
    Remove-Item -LiteralPath $src.Dest -Recurse -Force
    $script:Manifest['created']['binaries'].Remove($src.Name) | Out-Null
    $second = Get-BuildSources | Select-Object -Skip 1 -First 1
    Remove-Item -LiteralPath $second.Dest -Recurse -Force
    $script:Manifest['created']['binaries'].Remove($second.Name) | Out-Null
    New-Item -ItemType Directory -Force -Path ($second.Dest + '.partial') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path ($second.Dest + '.partial') 'stale.txt'), 'stale')
    $result.afterPartialError = Try-Run { Copy-HostBinaries }
    $reread = Read-Manifest
    $result.manifestReread = @($reread['created']['binaries'].Keys | Sort-Object)
    $result.manifestState = [string]$reread['state']
    $result.staleGone = -not (Test-Path -LiteralPath (Join-Path $second.Dest 'stale.txt'))
    $result.secondCopied = Test-Path -LiteralPath (Join-Path $second.Dest $second.Exe)
  }
  'exe' {
    $dir = Join-Path $Work 'exe'
    Write-Fixture $dir 'x.exe'
    $result.ok = Test-BuiltExe (Join-Path $dir 'x.exe')
    $result.missing = Test-BuiltExe (Join-Path $dir 'nope.exe')
    Write-Fixture (Join-Path $Work 'exe2') 'y.exe' -NoManifest
    $result.noManifest = Test-BuiltExe (Join-Path $Work 'exe2\y.exe')
    [System.IO.File]::WriteAllText((Join-Path $dir 'x.exe'), 'changed')
    $result.changed = Test-BuiltExe (Join-Path $dir 'x.exe')
    [System.IO.File]::WriteAllText((Join-Path $dir 'x.exe.manifest.json'), '{"sha256":"zz"}')
    $result.badManifest = Test-BuiltExe (Join-Path $dir 'x.exe')
  }
  'remove' {
    # the data root as a finished install leaves it
    foreach ($d in (Get-KnownDataFolders)) { New-Item -ItemType Directory -Force -Path (Join-Path $L.DataRoot $d) | Out-Null }
    foreach ($f in @('broker\journal.sqlite', 'broker\journal.sqlite-wal', 'authority\policy.json', 'authority\AlberaApprovalAuthority.service.json', 'control-plane\operations.sqlite')) { [System.IO.File]::WriteAllText((Join-Path $L.DataRoot $f), 'x') }
    # 1. an unknown file in control-plane: refused, and NOTHING in that folder is deleted
    [System.IO.File]::WriteAllText((Join-Path $L.ControlPlaneDir 'my-notes.txt'), 'not ours')
    $result.unknownRefused = Try-Run { Remove-HostTree $L.ControlPlaneDir @() @() $false }
    $result.unknownKept = (Test-Path -LiteralPath (Join-Path $L.ControlPlaneDir 'my-notes.txt')) -and (Test-Path -LiteralPath (Join-Path $L.ControlPlaneDir 'operations.sqlite'))
    # 2. known files only: removed
    $result.knownRemoved = Try-Run { Remove-HostTree $L.BrokerDbDir @() @() $false }
    $result.knownGone = -not (Test-Path -LiteralPath $L.BrokerDbDir)
    # 3. a sub-folder inside a known folder is unknown
    New-Item -ItemType Directory -Force -Path (Join-Path $L.AuthorityDir 'extra') | Out-Null
    $result.subfolderRefused = Try-Run { Remove-HostTree $L.AuthorityDir @() @() $false }
    $result.authorityKept = Test-Path -LiteralPath $L.AuthorityDir
    # 4. the install tree: only the three build folders
    foreach ($s in (Get-BuildSources)) { New-Item -ItemType Directory -Force -Path $s.Dest | Out-Null; [System.IO.File]::WriteAllText((Join-Path $s.Dest 'a.dll'), 'x') }
    $result.installTreeRemoved = Try-Run { Remove-HostTree $L.InstallRoot @('bin') @() $true }
    $result.installGone = -not (Test-Path -LiteralPath $L.InstallRoot)
    New-Item -ItemType Directory -Force -Path (Join-Path $L.InstallRoot 'bin\broker') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $L.InstallRoot 'readme.txt'), 'x')
    $result.installUnknownRefused = Try-Run { Remove-HostTree $L.InstallRoot @('bin') @() $true }
    $result.installUnknownKept = Test-Path -LiteralPath (Join-Path $L.InstallRoot 'readme.txt')
    # 5. a junction inside the folder: refused (never followed)
    $target = Join-Path $Work 'outside'; New-Item -ItemType Directory -Force -Path $target | Out-Null; [System.IO.File]::WriteAllText((Join-Path $target 'precious.txt'), 'keep')
    $junction = Join-Path $L.ControlPlaneDir 'link'
    $null = & cmd.exe /c mklink /J ('"' + $junction + '"') ('"' + $target + '"')
    Remove-Item -LiteralPath (Join-Path $L.ControlPlaneDir 'my-notes.txt') -Force
    $result.junctionRefused = Try-Run { Remove-HostTree $L.ControlPlaneDir @() @() $false }
    $result.outsideIntact = Test-Path -LiteralPath (Join-Path $target 'precious.txt')
    $null = & cmd.exe /c rmdir ('"' + $junction + '"')
  }
  'secure' {
    $a = ConvertTo-SecureString 'Correct-Horse-1' -AsPlainText -Force
    $b = ConvertTo-SecureString 'Correct-Horse-1' -AsPlainText -Force
    $c = ConvertTo-SecureString 'Correct-Horse-2' -AsPlainText -Force
    $d = ConvertTo-SecureString 'Correct-Horse-10' -AsPlainText -Force
    $result.same = Test-SecureStringEqual $a $b
    $result.differentLastChar = Test-SecureStringEqual $a $c
    $result.differentLength = Test-SecureStringEqual $a $d
    $result.reflexive = Test-SecureStringEqual $a $a
  }
}
($result | ConvertTo-Json -Compress -Depth 4)
