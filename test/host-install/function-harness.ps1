# Test harness (Windows PowerShell 5.1, ASCII only, no admin): runs the system-touching helper functions of scripts/host/albera-host.ps1 against a TEMP folder.
# The functions are taken out of the real script by name (PowerShell AST), so the code under test is the shipped code, not a copy. Nothing outside -Work is touched:
# no service, account, key or Program Files folder is involved (those need an elevated console and the VM lab). The temp folders are owned by the current (non-admin) user, which is
# exactly what a planted folder looks like to the installer.
#   function-harness.ps1 -Case <copy|remove|trust|secured|hyperv|desktop|group|cp|migrate> -Work <empty temp folder>     prints one JSON line
param(
  [Parameter(Mandatory = $true)][ValidateSet('copy', 'remove', 'trust', 'secured', 'hyperv', 'desktop', 'group', 'cp', 'migrate')][string]$Case,
  [Parameter(Mandatory = $true)][string]$Work
)
$ErrorActionPreference = 'Stop'
# -Work may arrive as an 8.3 short path (C:\Users\RUNNER~1\... on the CI runner). Windows PowerShell 5.1 / .NET Framework expands short names in GetFullPath, and the installer's own checks
# (Test-PlainAbsolutePath: the path must equal its GetFullPath) refuse a path that changes, so a layout under a short path would be refused. Real installs sit under C:\Program Files and C:\ProgramData.
$Work = [System.IO.Path]::GetFullPath($Work)
$repo =(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $repo 'scripts\host\albera-host-lib.ps1')
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts\host\albera-host.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'albera-host.ps1 does not parse' }
# EVERY function of the shipped script is loaded (not a list: a new step would otherwise silently run a copy that is not there); the cases then replace the few that touch the machine with fakes.
$found = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false))
if ($found.Count -lt 60) { throw ('expected the whole script, found only ' + $found.Count + ' functions') }
foreach ($f in $found) { Invoke-Expression $f.Extent.Text }
$script:ScriptFunctionNames = @($found | ForEach-Object { $_.Name })
# In the real script Stop-Refused exits; here it throws so a case can see the refusal.
function Stop-Refused([string]$Why, [int]$Code = 3) { throw "REFUSED: $Why" }

Add-Type -AssemblyName System.Web.Extensions
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$K = Get-HostConstants
$RepoRoot = Join-Path $Work 'repo'
$L = Get-HostLayout (Join-Path $Work 'pf') (Join-Path $Work 'pd')
$Mode = 'install'
$script:ManifestNote = $null
$ExpectedTreeHash = $null
$script:Manifest = $null
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Write-Fixture([string]$Dir, [string]$Exe) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'sub') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $Dir $Exe), 'exe bytes of ' + $Exe)
  [System.IO.File]::WriteAllText((Join-Path $Dir 'runtime.dll'), 'dll bytes')
  [System.IO.File]::WriteAllText((Join-Path $Dir 'sub\data.json'), '{"a":1}')
}
function Try-Run([scriptblock]$Block) { try { & $Block | Out-Null; $null } catch { $_.Exception.Message } }
function Set-Expected {
  $dirs = @{}; foreach ($b in (Get-BuildSources)) { $dirs[$b.Name] = $b.Dir }
  $script:ExpectedTreeHash = Get-CanonicalTreeHash (Get-ComponentHashes $dirs)
  $script:ExpectedTreeHash
}
function New-Junction([string]$Link, [string]$Target) { New-Item -ItemType Directory -Force -Path $Target | Out-Null; $null = & cmd.exe /c mklink /J ('"' + $Link + '"') ('"' + $Target + '"') }
function Remove-Junction([string]$Link) { $null = & cmd.exe /c rmdir ('"' + $Link + '"') }

$result = [ordered]@{ case = $Case }
switch ($Case) {
  'copy' {
    # The temp folders belong to the current user, so the real trust check would (rightly) refuse the existing copies; it has its own case below. Stubbed here to test the copy and hash logic alone.
    function Get-PathTrustReasons { , @() }
    New-Item -ItemType Directory -Force -Path $L.DataRoot, $L.InstallRoot | Out-Null
    $script:Manifest = New-Manifest
    foreach ($s in (Get-BuildSources)) { Write-Fixture $s.Dir $s.Exe }
    $result.expected = Set-Expected
    $result.firstRunError = Try-Run { Copy-HostBinaries }
    $result.recorded = @($script:Manifest['created']['binaries'].Keys | Sort-Object)
    $result.destFiles = @(Get-TreeEntries $L.BinRoot -FilesOnly | ForEach-Object { $_.Rel } | Sort-Object)   # built while walking: the temp path may be an 8.3 short name
    $result.noPartialLeft = (@(Get-ChildItem -LiteralPath $L.BinRoot -Directory | Where-Object { $_.Name -like '*.partial' }).Count -eq 0)
    $src = Get-BuildSources | Select-Object -First 1
    $copiedDirs = @{}; foreach ($b in (Get-BuildSources)) { $copiedDirs[$b.Name] = $b.Dest }
    $result.copiesTreeEqualsExpected = ((Get-CanonicalTreeHash (Get-ComponentHashes $copiedDirs)) -eq $result.expected)
    $result.exeShaRecorded = ($script:Manifest['created']['binaries'][$src.Name]['exeSha256'] -eq (Get-Sha256File (Join-Path $src.Dest $src.Exe)))
    $before = (Get-Item -LiteralPath (Join-Path $src.Dest $src.Exe)).LastWriteTimeUtc.Ticks
    $result.secondRunError = Try-Run { Copy-HostBinaries }
    $result.secondRunUntouched = ($before -eq (Get-Item -LiteralPath (Join-Path $src.Dest $src.Exe)).LastWriteTimeUtc.Ticks)
    # a changed installed copy is refused
    [System.IO.File]::WriteAllText((Join-Path $src.Dest 'runtime.dll'), 'tampered')
    $result.tamperedError = Try-Run { Copy-HostBinaries }
    # --- the build in the working tree is replaced after the owner typed the reviewed tree hash: ALL copies are refused and deleted
    Remove-Item -LiteralPath $L.BinRoot -Recurse -Force
    $script:Manifest['created']['binaries'].Clear()
    [System.IO.File]::WriteAllText((Join-Path $src.Dir 'runtime.dll'), 'a different dll, written by an agent')
    $result.replacedBuildError = Try-Run { Copy-HostBinaries }
    $result.replacedBuildNothingLeft = (@(Get-ChildItem -LiteralPath $L.BinRoot -Force -ErrorAction SilentlyContinue).Count -eq 0)
    $result.replacedBuildNotRecorded = ($script:Manifest['created']['binaries'].Count -eq 0)
    # an extra file, a missing file and a file moved to another component each change the tree hash
    [System.IO.File]::WriteAllText((Join-Path $src.Dir 'runtime.dll'), 'dll bytes')
    [System.IO.File]::WriteAllText((Join-Path $src.Dir 'planted.dll'), 'extra')
    $result.extraFileError = Try-Run { Copy-HostBinaries }
    Remove-Item -LiteralPath (Join-Path $src.Dir 'planted.dll')
    Remove-Item -LiteralPath (Join-Path $src.Dir 'sub\data.json')
    $result.missingFileError = Try-Run { Copy-HostBinaries }
    $other = Get-BuildSources | Select-Object -Skip 1 -First 1
    Move-Item -LiteralPath (Join-Path $other.Dir 'sub\data.json') -Destination (Join-Path $src.Dir 'sub\data.json')
    $result.movedFileError = Try-Run { Copy-HostBinaries }
    Move-Item -LiteralPath (Join-Path $src.Dir 'sub\data.json') -Destination (Join-Path $other.Dir 'sub\data.json')
    [System.IO.File]::WriteAllText((Join-Path $src.Dir 'sub\data.json'), '{"a":1}')   # the file the missing-file case deleted
    # a link inside the publish folder is refused before anything is copied
    $linkTarget = Join-Path $Work 'elsewhere'; [System.IO.File]::WriteAllText((Join-Path (New-Item -ItemType Directory -Force -Path $linkTarget).FullName 'secret.txt'), 'x')
    New-Junction (Join-Path $src.Dir 'link') $linkTarget
    $result.junctionInSourceError = Try-Run { Copy-HostBinaries }
    Remove-Junction (Join-Path $src.Dir 'link')
    $result.junctionTargetIntact = Test-Path -LiteralPath (Join-Path $linkTarget 'secret.txt')
    # a half-copied bin folder is refused; a stale .partial from a failed run is replaced; the clean build then copies
    New-Item -ItemType Directory -Force -Path $src.Dest | Out-Null
    $result.halfCopiedError = Try-Run { Copy-HostBinaries }
    Remove-Item -LiteralPath $L.BinRoot -Recurse -Force
    $second = Get-BuildSources | Select-Object -Skip 1 -First 1
    New-Item -ItemType Directory -Force -Path ($second.Dest + '.partial') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path ($second.Dest + '.partial') 'stale.txt'), 'stale')
    $result.cleanAgainError = Try-Run { Copy-HostBinaries }
    $result.recordedAgain = @($script:Manifest['created']['binaries'].Keys | Sort-Object)
    $result.staleGone = -not (Test-Path -LiteralPath (Join-Path $second.Dest 'stale.txt'))
    $reread = Read-Manifest
    $result.manifestReread = @($reread['created']['binaries'].Keys | Sort-Object)
    # the pinned node.exe is added INSIDE the control-plane folder after the hash was checked: the installed copies still hash to the typed value (the node\ folder is left out), a second run is fine,
    # and the recorded folder hash leaves it out too. Counting it WOULD change the hash (the control).
    $cpSource = Get-BuildSources | Where-Object { $_.Name -eq 'control-plane' }
    New-Item -ItemType Directory -Force -Path (Join-Path $cpSource.Dest 'node') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $cpSource.Dest 'node\node.exe'), 'a pinned node')
    $installedDirs = @{}; foreach ($b in (Get-BuildSources)) { $installedDirs[$b.Name] = $b.Dest }
    $result.nodeAddedStillEqual = ((Get-CanonicalTreeHash (Get-ComponentHashes $installedDirs -Installed)) -eq $script:ExpectedTreeHash)
    $result.nodeInstalledWithoutExclusionDiffers = ((Get-CanonicalTreeHash (Get-ComponentHashes $installedDirs)) -ne $script:ExpectedTreeHash)
    $result.nodeAddedSecondRunError = Try-Run { Copy-HostBinaries }
    $result.nodeAddedRecordedTreeSame = ((Get-TreeHashes $cpSource.Dest @('node')).Tree -eq $script:Manifest['created']['binaries']['control-plane']['treeSha256'])
    # a build that ships a node\ folder itself is refused before anything is copied
    Remove-Item -LiteralPath $L.BinRoot -Recurse -Force
    $script:Manifest['created']['binaries'].Clear()
    New-Item -ItemType Directory -Force -Path (Join-Path $cpSource.Dir 'node') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $cpSource.Dir 'node\node.exe'), 'x')
    $result.nodeFolderInSourceError = Try-Run { Copy-HostBinaries }
    $result.nodeFolderInSourceNothingCopied = (-not (Test-Path -LiteralPath $L.BinRoot)) -or (@(Get-ChildItem -LiteralPath $L.BinRoot -Force).Count -eq 0)
    Remove-Item -LiteralPath (Join-Path $cpSource.Dir 'node') -Recurse -Force
    $result.nodeCleanAgainError = Try-Run { Copy-HostBinaries }   # the clean build copies again; the checks below start from a populated bin folder as before
    # without a usable -ExpectedTreeHash nothing is copied
    $expected = $script:ExpectedTreeHash
    Remove-Item -LiteralPath $L.BinRoot -Recurse -Force
    $script:Manifest['created']['binaries'].Clear()
    $script:ExpectedTreeHash = $null
    $result.noHashError = Try-Run { Copy-HostBinaries }
    $result.noHashNothingCopied = -not (Test-Path -LiteralPath $L.BinRoot)
    $script:ExpectedTreeHash = 'ABC'
    $result.badFormat = (Get-ExpectedTreeHashState).Reason
    $script:ExpectedTreeHash = $expected.ToUpperInvariant()
    $result.upperCaseRefused = -not (Get-ExpectedTreeHashState).Ok
    $script:ExpectedTreeHash = ('0' * 64)
    $result.wrongHashError = Try-Run { Copy-HostBinaries }
    $result.wrongHashNothingLeft = (@(Get-ChildItem -LiteralPath $L.BinRoot -Force -ErrorAction SilentlyContinue).Count -eq 0)
  }
  'remove' {
    New-Item -ItemType Directory -Force -Path $L.DataRoot, $L.InstallRoot | Out-Null
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
    # 4. the install tree: only the build folders of the five components (and setup's own folders)
    foreach ($s in (Get-BuildSources)) { New-Item -ItemType Directory -Force -Path $s.Dest | Out-Null; [System.IO.File]::WriteAllText((Join-Path $s.Dest 'a.dll'), 'x') }
    $result.installTreeRemoved = Try-Run { Remove-HostTree $L.InstallRoot @('bin') @() $true }
    $result.installGone = -not (Test-Path -LiteralPath $L.InstallRoot)
    New-Item -ItemType Directory -Force -Path (Join-Path $L.InstallRoot 'bin\broker') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $L.InstallRoot 'readme.txt'), 'x')
    $result.installUnknownRefused = Try-Run { Remove-HostTree $L.InstallRoot @('bin') @() $true }
    $result.installUnknownKept = Test-Path -LiteralPath (Join-Path $L.InstallRoot 'readme.txt')
    # 5. a junction INSIDE the folder: refused (never followed)
    $target = Join-Path $Work 'outside'; New-Item -ItemType Directory -Force -Path $target | Out-Null; [System.IO.File]::WriteAllText((Join-Path $target 'precious.txt'), 'keep')
    $junction = Join-Path $L.ControlPlaneDir 'link'
    New-Junction $junction $target
    Remove-Item -LiteralPath (Join-Path $L.ControlPlaneDir 'my-notes.txt') -Force
    $result.junctionRefused = Try-Run { Remove-HostTree $L.ControlPlaneDir @() @() $false }
    $result.outsideIntact = Test-Path -LiteralPath (Join-Path $target 'precious.txt')
    Remove-Junction $junction
    # 6. the folder ITSELF is a junction (the case a planted layout produces): refused, the target is left alone
    Remove-Item -LiteralPath $L.BrokerConfigDir -Recurse -Force
    New-Junction $L.BrokerConfigDir $target
    $result.selfJunctionRefused = Try-Run { Remove-HostTree $L.BrokerConfigDir @() @() $false }
    $result.selfJunctionTargetIntact = Test-Path -LiteralPath (Join-Path $target 'precious.txt')
    Remove-Junction $L.BrokerConfigDir
    # 7. the folders the Control Plane SERVICE fills itself (host logs, one folder per Claude Code run, the DPAPI blobs, ui\room.json) are removed as a whole
    New-Item -ItemType Directory -Force -Path (Join-Path $L.ControlPlaneDir 'logs'), (Join-Path $L.ControlPlaneDir 'claude-run\run-0123456789abcdef\config'), $L.SecretsDir, $L.UiDir | Out-Null
    foreach ($f in @('control-plane\logs\host.log', 'control-plane\logs\host.log.1', 'control-plane\claude-run\run-0123456789abcdef\config\x.json', 'control-plane\operations.sqlite', 'secrets\claude-oauth-token.dpapi', 'secrets\claude-oauth-token.meta', 'ui\room.json')) { [System.IO.File]::WriteAllText((Join-Path $L.DataRoot $f), 'x') }
    $result.workFoldersRemoved = Try-Run { foreach ($d in @($L.ControlPlaneDir, $L.SecretsDir, $L.UiDir)) { Remove-HostTree $d @() @() $false } }
    $result.workFoldersGone = (-not (Test-Path -LiteralPath $L.ControlPlaneDir)) -and (-not (Test-Path -LiteralPath $L.SecretsDir)) -and (-not (Test-Path -LiteralPath $L.UiDir))
    New-Item -ItemType Directory -Force -Path (Join-Path $L.ControlPlaneDir 'logs') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $L.ControlPlaneDir 'logs\host.log'), 'x'); [System.IO.File]::WriteAllText((Join-Path $L.ControlPlaneDir 'notes.txt'), 'not ours')
    $result.strayInControlPlaneRefused = Try-Run { Remove-HostTree $L.ControlPlaneDir @() @() $false }
    New-Item -ItemType Directory -Force -Path $L.SecretsDir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $L.SecretsDir 'whatever.bin'), 'x')
    $result.strayInSecretsAllowed = Try-Run { Remove-HostTree $L.SecretsDir @() @() $false }
    New-Item -ItemType Directory -Force -Path $L.ControlPlaneConfigDir | Out-Null
    [System.IO.File]::WriteAllText($L.ControlPlaneConfig, '{}'); [System.IO.File]::WriteAllText((Join-Path $L.ControlPlaneConfigDir 'extra.json'), '{}')
    $result.configUnknownRefused = Try-Run { Remove-HostTree $L.ControlPlaneConfigDir @() @() $false }
    Remove-Item -LiteralPath (Join-Path $L.ControlPlaneConfigDir 'extra.json'); [System.IO.File]::WriteAllText($L.ApprovalSettings, '{}')
    $result.configKnownRemoved = Try-Run { Remove-HostTree $L.ControlPlaneConfigDir @() @() $false }
  }
  'trust' {
    function Set-OwnedByMe([string]$Path) {
      $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      $null = & (Join-Path ([Environment]::SystemDirectory) 'icacls.exe') $Path /setowner "*$me" /L /Q
      if ($LASTEXITCODE -ne 0) { throw "icacls /setowner failed for $Path" }
    }
    $sids = @{ Broker = (Get-DerivedServiceSid $K.BrokerService); Authority = (Get-DerivedServiceSid $K.AuthorityService); ControlPlane = 'S-1-5-21-1111111111-2222222222-3333333333-1500' }
    $plan = @(Get-AclPlan $L $sids)
    # 1. an attacker (the current non-admin user) plants C:\ProgramData\Albera with a well-formed manifest. install / uninstall refuse it; plan / status ignore it and say why.
    # The owner is set to this user's own SID explicitly: an elevated process (the CI runner) would otherwise create them owned by Administrators.
    New-Item -ItemType Directory -Force -Path $L.DataRoot | Out-Null
    [System.IO.File]::WriteAllText($L.ManifestPath, ((New-Manifest) | ConvertTo-Json -Depth 8 -Compress))
    Set-OwnedByMe $L.DataRoot
    Set-OwnedByMe $L.ManifestPath
    $result.plantedReasons = Get-PathTrustReasons $L.DataRoot (Get-AdminSids) $true
    $result.plantedManifestReasons = Get-PathTrustReasons $L.ManifestPath (Get-AdminSids) $false
    $Mode = 'install'; $result.plantedInstall = Try-Run { Initialize-Manifest }
    $Mode = 'uninstall'; $result.plantedUninstall = Try-Run { Initialize-Manifest }
    $Mode = 'plan'; $script:Manifest = $null; $script:ManifestNote = $null
    $result.plantedPlanError = Try-Run { Initialize-Manifest }
    $result.plantedPlanManifestIgnored = ($null -eq $script:Manifest)
    $result.plantedPlanNote = $script:ManifestNote
    # 2. the same folder is a junction to another vendor's service folder: refused before any ACL is read; the target is untouched
    Remove-Item -LiteralPath $L.DataRoot -Recurse -Force
    $vendor = Join-Path $Work 'vendor-service'; New-Item -ItemType Directory -Force -Path $vendor | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $vendor 'install-manifest.json'), ((New-Manifest) | ConvertTo-Json -Depth 8 -Compress))
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $L.DataRoot) | Out-Null
    New-Junction $L.DataRoot $vendor
    $result.junctionRootReasons = Get-PathTrustReasons $L.DataRoot (Get-AdminSids) $true
    $Mode = 'install'; $script:Manifest = $null; $result.junctionRootInstall = Try-Run { Initialize-Manifest }
    Remove-Junction $L.DataRoot
    # 3. a planned sub-folder (control-plane) is a junction: Assert-PlannedPathTrusted refuses, so the folder step stops before icacls
    New-Item -ItemType Directory -Force -Path $L.DataRoot | Out-Null
    $control = $plan | Where-Object { $_.Path -ceq $L.ControlPlaneDir }
    New-Junction $L.ControlPlaneDir $vendor
    $result.junctionChildError = Try-Run { Assert-PlannedPathTrusted $control }
    $result.vendorUntouched = (Test-Path -LiteralPath (Join-Path $vendor 'install-manifest.json'))
    Remove-Junction $L.ControlPlaneDir
    # 4. a planted plain folder owned by the user is refused; a missing one is fine (it will be created)
    New-Item -ItemType Directory -Force -Path $L.BrokerDbDir | Out-Null
    Set-OwnedByMe $L.BrokerDbDir
    $result.plantedChildError = Try-Run { Assert-PlannedPathTrusted ($plan | Where-Object { $_.Path -ceq $L.BrokerDbDir }) }
    $result.missingChildError = Try-Run { Assert-PlannedPathTrusted ($plan | Where-Object { $_.Path -ceq $L.AuthorityDir }) }
    # 5. a parent that is a link: the chain check finds it even when the folder itself is a plain one
    $realParent = Join-Path $Work 'real-parent'; New-Item -ItemType Directory -Force -Path (Join-Path $realParent 'child') | Out-Null
    $linkParent = Join-Path $Work 'link-parent'; New-Junction $linkParent $realParent
    $result.parentChain = @(Get-ReparseChain (Join-Path $linkParent 'child') | ForEach-Object { Split-Path -Leaf $_ })
    $result.plainChain = (Get-ReparseChain (Join-Path $realParent 'child')).Count
    $result.baseChain = (Get-ReparseChain $Work).Count
    Remove-Junction $linkParent
  }
  'secured' {
    # A folder born with its final descriptor: owner and DACL as asked, inheritance removed, no inherited ACE at any time. (Owner = the current user here: only an administrator may assign Administrators.)
    $dir = Join-Path $Work 'secured'
    $grants = @("*${me}:(OI)(CI)F", '*S-1-5-32-544:(OI)(CI)RX', '*S-1-5-18:(OI)(CI)F')
    New-SecuredDirectory $dir $grants $me
    $summary = Get-AclSummary $dir
    $result.owner = ($summary.Owner -eq $me)
    $result.protected = $summary.Protected
    $result.allow = @($summary.AllowSids | Sort-Object)
    $result.expectedAllow = @(@($me, 'S-1-5-32-544', 'S-1-5-18') | Sort-Object)
    $result.writers = @($summary.WriteSids | Sort-Object)
    $child = Join-Path $dir 'child'; New-Item -ItemType Directory -Path $child | Out-Null
    $result.childInherits = (@((Get-AclSummary $child).AllowSids | Sort-Object) -join ',') -eq (@($result.expectedAllow) -join ',')
    $result.existingRefused = Try-Run { New-SecuredDirectory $dir $grants $me }
    $result.badGrantRefused = Try-Run { New-SecuredDirectory (Join-Path $Work 'secured2') @('*S-1-1-0:(OI)(CI)W') $me }
    $result.badGrantCreatedNothing = -not (Test-Path -LiteralPath (Join-Path $Work 'secured2'))
    # DirectoryInfo.Create succeeds silently on an existing folder: a folder someone made a moment earlier (plain, inherited ACL) is caught by the read-back
    $planted = Join-Path $Work 'planted'; New-Item -ItemType Directory -Path $planted | Out-Null
    $result.createOnExistingError = Try-Run { Invoke-SecuredCreate $planted $grants $me }
    $result.createOnExistingKept = Test-Path -LiteralPath $planted
    # ... and so is a link
    $vendor = Join-Path $Work 'vendor'; New-Item -ItemType Directory -Path $vendor | Out-Null
    $link = Join-Path $Work 'linked'; New-Junction $link $vendor
    $result.createOnJunctionError = Try-Run { Invoke-SecuredCreate $link $grants $me }
    Remove-Junction $link
    # a folder created exactly as asked is still refused when it fails the installer's trust test (owner is not SYSTEM/Administrators): no later step may run
    $result.trustedCreateError = Try-Run { New-TrustedDirectory (Join-Path $Work 'trusted') $grants $me }
  }
  'hyperv' {
    # -GrantHyperVToBroker: the shipped step list, VM lookup, group change and its undo, run against FAKES of the machine (Get-CimInstance, Get-LocalGroup, Add-/Remove-LocalGroupMember,
    # the member list). No group, service or account is touched. The fakes record every call, so the test can prove exactly who is added and removed.
    $VmName = 'albera-clone-01'; $ComputerId = 'clone-01'; $ProjectId = 'albera-host'; $VmId = $null; $GrantHyperVToBroker = $false
    $cpSid = 'S-1-5-21-1111111111-2222222222-3333333333-1500'
    $otherMember = 'S-1-5-21-1111111111-2222222222-3333333333-1234'
    $brokerSid = Get-DerivedServiceSid $K.BrokerService
    $guidA = '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f'
    $script:FakeVms = @(); $script:VmListFails = $false; $script:GroupExists = $true; $script:GroupLookupFails = $false; $script:RemoveStuck = $false
    $script:Members = New-Object 'System.Collections.Generic.List[string]'
    $script:Calls = New-Object 'System.Collections.Generic.List[string]'
    # the services of the fake machine: name -> SID type ('none' | 'restricted' | 'unrestricted'); ScCalls is every sc.exe argument line the shipped code issued
    $script:Svc = @{}
    $script:FakeStartMode = 'Auto'; $script:FakeDelayed = $true
    $script:ScCalls = New-Object 'System.Collections.Generic.List[string]'
    function Get-CimInstance { param([Parameter(Position = 0)]$Class, $Namespace, $ClassName, $Filter)
      if ($Namespace -eq 'root\virtualization\v2') { $script:Calls.Add('cim ' + $Filter); if ($script:VmListFails) { throw 'Access denied (fake)' }; return @($script:FakeVms) }
      if ($Class -eq 'Win32_Service') { $n = [regex]::Match([string]$Filter, "Name='([^']+)'").Groups[1].Value; if ($script:Svc.ContainsKey($n)) { return [pscustomobject]@{ Name = $n } } }
      $null }
    function Test-LocalGroupExists([string]$GroupSid) { if ($script:GroupLookupFails) { throw 'the group lookup failed (fake)' }; $script:GroupExists }
    function Get-LocalGroupMemberSids([string]$GroupSid) { @($script:Members.ToArray()) }
    function Get-AccountSid([string]$Account) { Get-DerivedServiceSid ($Account -replace '^NT SERVICE\\', '') }
    function Get-ServiceFactsFor([string]$Name) {
      if (-not $script:Svc.ContainsKey($Name)) { return [pscustomobject]@{ Exists = $false } }
      $spec = Get-ServiceSpecs | Where-Object { $_.Name -eq $Name }
      [pscustomobject]@{ Exists = $true; StartName = "NT SERVICE\$Name"; PathName = (Get-ServiceCommandLine $spec.Exe $spec.Config); StartMode = $script:FakeStartMode; DelayedAutoStart = $script:FakeDelayed; ServiceType = 'Own Process'
        SidTypeText = ('SERVICE_SID_TYPE:  ' + $script:Svc[$Name].ToUpperInvariant()); PrivilegesText = 'SeChangeNotifyPrivilege'; FailureText = 'FAILURE_ACTIONS : RESTART -- Delay = 5000 milliseconds. RESTART -- Delay = 5000 milliseconds.'; State = 'Stopped' }
    }
    function Invoke-Sc([string]$Arguments) {
      $script:ScCalls.Add($Arguments)
      $t = $Arguments -split ' '
      if ($t[0] -eq 'create') { $script:Svc[$t[1]] = 'none' }
      if ($t[0] -eq 'sidtype') { $script:Svc[$t[1]] = $t[2] }
      if ($t[0] -eq 'delete') { $script:Svc.Remove($t[1]) }
      $out = if ($t[0] -eq 'sdshow') { Get-BrokerServiceSddl $cpSid } else { '' }
      [pscustomobject]@{ Exit = 0; Out = $out; Err = '' }
    }
    function Read-AuthoritySigningKey([string]$Name) { $null }
    function Add-LocalGroupMember { param($SID, $Member) $script:Calls.Add("add $SID $Member"); $script:Members.Add([string]$Member) }
    function Remove-LocalGroupMember { param($SID, $Member) $script:Calls.Add("remove $SID $Member"); if (-not $script:RemoveStuck) { [void]$script:Members.Remove([string]$Member) } }
    function Reset-Fakes { $script:ResolvedVm = $null; $script:Sids = $null; $script:Members.Clear(); $script:Calls.Clear(); $script:GroupExists = $true; $script:GroupLookupFails = $false; $script:RemoveStuck = $false; $script:VmListFails = $false; $script:Svc = @{}; $script:ScCalls.Clear() }
    function New-InstalledManifest {
      New-Item -ItemType Directory -Force -Path $L.DataRoot | Out-Null
      $script:Manifest = New-Manifest
      $u = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $u['name'] = $K.ControlPlaneUser; $u['sid'] = $cpSid
      $script:Manifest['created']['user'] = $u
      $script:Manifest['created']['services'] = @($K.BrokerService, $K.AuthorityService)
      Save-Manifest
    }
    function New-Vm([string]$Name, [string]$Element) { [pscustomobject]@{ Name = $Name; ElementName = $Element } }
    function Count-Changes { @($script:Calls | Where-Object { $_ -notlike 'cim *' }).Count }
    # A plan prints the machine's own error text for steps whose helpers are not loaded here (localized on this PC); keep the JSON line ASCII.
    function Get-PlanText($Steps, [string]$Title) { (((& { Show-Plan $Steps $Title } 6>&1) | ForEach-Object { $_.ToString() }) -join "`n") -replace '[^\x09\x0A\x20-\x7E]', '?' }

    # 1. the step lists: without the option exactly the ten install steps and six removal steps of today; with it two more, in the right places
    $result.defaultInstallIds = @(Get-InstallSteps | ForEach-Object { $_.Id })
    $result.defaultUninstallIds = @(Get-UninstallSteps | ForEach-Object { $_.Id })
    $result.defaultServicesTitle = (Get-InstallSteps | Where-Object { $_.Id -eq 'services' }).Title
    $result.defaultConfigsDetail = @((Get-InstallSteps | Where-Object { $_.Id -eq 'configs' }).Detail).Count
    $GrantHyperVToBroker = $true
    $grantSteps = @(Get-InstallSteps)
    $result.grantInstallIds = @($grantSteps | ForEach-Object { $_.Id })
    $result.grantServicesTitle = ($grantSteps | Where-Object { $_.Id -eq 'services' }).Title
    $result.grantConfigsDetail = @(($grantSteps | Where-Object { $_.Id -eq 'configs' }).Detail)
    $result.grantTitles = @($grantSteps | Where-Object { $_.Id -in @('vm', 'hyperv') } | ForEach-Object { $_.Title })
    $GrantHyperVToBroker = $false
    # the plan as the owner reads it (what a plan run prints, with the fakes answering the VM lookup)
    $script:FakeVms = @((New-Vm $guidA 'albera-clone-01')); $script:Manifest = $null; $script:ManifestNote = $null
    $result.planDefault = Get-PlanText (Get-InstallSteps) 'install'
    $GrantHyperVToBroker = $true
    $result.planGrant = Get-PlanText (Get-InstallSteps) 'install'
    $GrantHyperVToBroker = $false

    # 2. the VM lookup: the GUID comes from the name, once; the display name is never trusted twice
    $vmStep = Get-HyperVVmStep
    Reset-Fakes; $script:FakeVms = @((New-Vm $guidA.ToUpperInvariant() 'albera-clone-01'))
    $found = Resolve-BrokerVm
    $result.lookupFound = [ordered]@{ kind = $found.Kind; id = $found.Id; test = (& $vmStep.Test); filter = (@($script:Calls | Where-Object { $_ -like 'cim *' })[0]) }
    Reset-Fakes; $script:FakeVms = @()
    $result.lookupNone = [ordered]@{ kind = (Resolve-BrokerVm).Kind; test = (& $vmStep.Test) }
    Reset-Fakes; $script:FakeVms = @((New-Vm 'HOSTNAME-PC' 'albera-clone-01'))
    $result.lookupHostOnly = (Resolve-BrokerVm).Kind
    Reset-Fakes; $script:FakeVms = @((New-Vm $guidA 'albera-clone-01'), (New-Vm '11111111-2222-4333-8444-555555555555' 'Albera-Clone-01'))
    $result.lookupTwo = [ordered]@{ kind = (Resolve-BrokerVm).Kind; test = (& $vmStep.Test) }
    Reset-Fakes; $script:VmListFails = $true
    $result.lookupUnreadable = [ordered]@{ kind = (Resolve-BrokerVm).Kind; test = (& $vmStep.Test) }
    Reset-Fakes; $VmId = $guidA
    $result.labVmId = [ordered]@{ kind = (Resolve-BrokerVm).Kind; id = (Resolve-BrokerVm).Id; cimCalls = @($script:Calls | Where-Object { $_ -like 'cim *' }).Count }
    $VmId = $null

    # 3. the grant: exactly one call, the Broker's own SID into S-1-5-32-578; the record is on disk; Control Plane and Authority are not members
    Reset-Fakes; New-InstalledManifest
    $script:FakeVms = @((New-Vm $guidA.ToUpperInvariant() 'albera-clone-01'))
    $grantStep = Get-HyperVGrantStep
    $result.grantTestBefore = & $grantStep.Test
    $result.grantError = Try-Run { & $grantStep.Do }
    $result.grantCalls = @($script:Calls | Where-Object { $_ -notlike 'cim *' })
    $result.grantMembers = @($script:Members)
    $result.grantRecord = $script:Manifest['created']['hyperVGrant']
    $reread = Read-Manifest
    $result.grantRecordOnDisk = $reread['created']['hyperVGrant']
    $result.grantTestAfter = & $grantStep.Test
    $result.grantUninstallIds = @(Get-UninstallSteps | ForEach-Object { $_.Id })
    $result.planUninstall = Get-PlanText (Get-UninstallSteps) 'uninstall'
    $script:Calls.Clear()
    $result.grantAgainError = Try-Run { & $grantStep.Do }
    $result.grantAgainCalls = @($script:Calls | Where-Object { $_ -notlike 'cim *' })
    # ... and the undo: only the Broker's SID leaves; someone else already in the group stays
    $script:Members.Add($otherMember); $script:Calls.Clear()
    $revoke = Get-HyperVRevokeStep
    $result.revokeTestBefore = & $revoke.Test
    $result.revokeError = Try-Run { & $revoke.Do }
    $result.revokeCalls = @($script:Calls)
    $result.revokeMembers = @($script:Members)
    $result.revokeRecordGone = -not (Test-ManifestHas 'hyperVGrant')
    $result.revokeTestAfter = & $revoke.Test
    $result.revokeUninstallIds = @(Get-UninstallSteps | ForEach-Object { $_.Id })

    # 4. refusals leave nothing behind
    Reset-Fakes; New-InstalledManifest; $script:FakeVms = @()
    $result.noVmError = Try-Run { Grant-BrokerHyperV }
    $result.noVmChanged = [ordered]@{ calls = (Count-Changes); record = (Test-ManifestHas 'hyperVGrant') }
    Reset-Fakes; New-InstalledManifest; $script:FakeVms = @((New-Vm $guidA 'albera-clone-01')); $script:GroupExists = $false
    $result.noGroupError = Try-Run { Grant-BrokerHyperV }
    $result.noGroupChanged = [ordered]@{ calls = (Count-Changes); record = (Test-ManifestHas 'hyperVGrant') }
    # the Control Plane account already sits in the group (put there by someone else): the grant adds the Broker, then refuses to call the result fine
    Reset-Fakes; New-InstalledManifest; $script:FakeVms = @((New-Vm $guidA 'albera-clone-01')); $script:Members.Add($cpSid)
    $result.cpMemberError = Try-Run { Grant-BrokerHyperV }
    $result.cpMemberCalls = @($script:Calls | Where-Object { $_ -notlike 'cim *' })
    # a manifest that names the Control Plane account with the Broker's SID: the plan refuses before anything is added
    Reset-Fakes; New-InstalledManifest; $script:FakeVms = @((New-Vm $guidA 'albera-clone-01'))
    $script:Manifest['created']['user']['sid'] = $brokerSid
    $result.cpEqualsBrokerError = Try-Run { Grant-BrokerHyperV }
    $result.cpEqualsBrokerCalls = (Count-Changes)
    # the undo stops before the service is deleted when the SID will not leave
    Reset-Fakes; New-InstalledManifest; $script:FakeVms = @((New-Vm $guidA 'albera-clone-01'))
    Grant-BrokerHyperV
    $script:RemoveStuck = $true
    $result.stuckError = Try-Run { Revoke-BrokerHyperV }
    $result.stuckRecordKept = (Test-ManifestHas 'hyperVGrant')
    # the group is gone (the Hyper-V feature was removed): nothing to remove, the record is dropped
    Reset-Fakes; New-InstalledManifest; $script:FakeVms = @((New-Vm $guidA 'albera-clone-01'))
    Grant-BrokerHyperV
    $script:GroupExists = $false; $script:Calls.Clear()
    $result.noGroupUndoError = Try-Run { Revoke-BrokerHyperV }
    $result.noGroupUndoCalls = @($script:Calls).Count
    $result.noGroupUndoRecordGone = -not (Test-ManifestHas 'hyperVGrant')
    # a record that names another SID is refused before anything is removed
    Reset-Fakes; New-InstalledManifest; $script:FakeVms = @((New-Vm $guidA 'albera-clone-01'))
    Grant-BrokerHyperV
    $script:Manifest['created']['hyperVGrant']['sid'] = $cpSid; $script:Calls.Clear()
    $result.forgedRecordError = Try-Run { Revoke-BrokerHyperV }
    $result.forgedRecordCalls = @($script:Calls).Count

    # 5. the undo stops, and keeps the record, when the group lookup FAILS (as opposed to "no such group"): the services are not deleted on a guess
    Reset-Fakes; New-InstalledManifest; $script:FakeVms = @((New-Vm $guidA 'albera-clone-01'))
    Grant-BrokerHyperV
    $script:GroupLookupFails = $true; $script:Calls.Clear()
    $result.lookupFailUndoError = Try-Run { Revoke-BrokerHyperV }
    $result.lookupFailUndoRecordKept = (Test-ManifestHas 'hyperVGrant')
    $result.lookupFailUndoCalls = @($script:Calls).Count
    $result.lookupFailUndoManifestOnDisk = [bool](Read-Manifest)['created']['hyperVGrant']

    # 6. the group is read whether or not there is a record: albera-cp and the Authority are never allowed in; the Broker only with a record
    function Get-LiveControlPlaneUser { [pscustomobject]@{ Name = $K.ControlPlaneUser; Sid = $cpSid; Description = $K.ControlPlaneUserDescription; Enabled = $true } }
    $other = $otherMember; $authSid = Get-DerivedServiceSid $K.AuthorityService
    function Get-Problems([string[]]$InGroup) { $script:Members.Clear(); foreach ($m in $InGroup) { $script:Members.Add($m) }; Resolve-HostSids; $found = Get-HyperVMemberProblems; , @($found) }
    Reset-Fakes; New-InstalledManifest
    $result.noRecord = [ordered]@{
      empty = Get-Problems @(); other = Get-Problems @($other); controlPlane = Get-Problems @($cpSid); authority = Get-Problems @($authSid); broker = Get-Problems @($brokerSid)
      all = Get-Problems @($brokerSid, $cpSid, $authSid)
    }
    $script:GroupExists = $false
    $result.noRecordNoGroup = Get-Problems @()
    $script:GroupExists = $true
    # the status page lists the same findings (no line for a clean group of an install without the grant)
    function Get-HvLines { @((Get-StatusLines) | Where-Object { $_.Text -like 'Hyper-V Administrators:*' } | ForEach-Object { $_.State + ' ' + $_.Text }) }
    $result.statusNoRecord = [ordered]@{ clean = @(Get-HvLines) }
    foreach ($pair in @(@('controlPlane', $cpSid), @('authority', $authSid), @('broker', $brokerSid))) { $script:Members.Clear(); $script:Members.Add($pair[1]); $result.statusNoRecord[$pair[0]] = @(Get-HvLines) }
    $script:Members.Clear(); $script:GroupLookupFails = $true
    $result.statusLookupFails = [ordered]@{ hv = @((Get-StatusLines) | Where-Object { $_.Text -like 'Hyper-V Administrators:*' } | ForEach-Object { $_.State + ' ' + $_.Text }); laterLineStillThere = [bool]@((Get-StatusLines) | Where-Object { $_.Text -like 'Control Plane settings:*' }).Count }
    $script:GroupLookupFails = $false
    # with a record: the Broker has to be in, and still nobody else
    Reset-Fakes; New-InstalledManifest; $script:FakeVms = @((New-Vm $guidA 'albera-clone-01'))
    Grant-BrokerHyperV
    $hvTest = (Get-HyperVGrantStep).Test
    $result.recorded = [ordered]@{ ok = Get-Problems @($brokerSid); brokerGone = Get-Problems @(); controlPlane = Get-Problems @($brokerSid, $cpSid) }
    $script:GroupExists = $false; $result.recorded.noGroup = Get-Problems @(); $script:GroupExists = $true
    $script:Members.Clear(); $script:Members.Add($brokerSid)
    $result.statusRecorded = [ordered]@{ ok = @(Get-HvLines) }
    $script:Members.Add($cpSid); $result.statusRecorded.controlPlane = @(Get-HvLines)
    # the install step: done only when the record is there AND the member list has nothing to report
    $script:Members.Clear(); $script:Members.Add($brokerSid); $result.stepClean = & $hvTest
    $script:Members.Add($cpSid); $result.stepControlPlane = & $hvTest
    $script:Members.Clear(); $script:Members.Add($brokerSid); $script:Members.Add($authSid); $result.stepAuthority = & $hvTest
    $script:Members.Clear(); $result.stepBrokerGone = & $hvTest
    # a grant that added the Broker and THEN found albera-cp in the group threw; the next run must not call the step done
    Reset-Fakes; New-InstalledManifest; $script:FakeVms = @((New-Vm $guidA 'albera-clone-01')); $script:Members.Add($cpSid)
    $result.afterThrowGrantError = Try-Run { Grant-BrokerHyperV }
    $result.afterThrowStep = & $hvTest
    [void]$script:Members.Remove($cpSid)
    $result.afterThrowFixedStep = & $hvTest

    # 6b. the status also checks the Control Plane settings' desktop block against the install record (only for an install with the grant record)
    function Get-DesktopLines { @((Get-StatusLines) | Where-Object { $_.Text -like 'Control Plane settings desktop:*' } | ForEach-Object { $_.State + ' ' + $_.Text }) }
    function Write-SettingsFile([string]$Sha) { New-Item -ItemType Directory -Force -Path $L.ControlPlaneConfigDir | Out-Null; [System.IO.File]::WriteAllText($L.ApprovalSettings, (ConvertTo-HostJson (Get-ControlPlaneSettings $L $ProjectId $VmName $ComputerId $Sha))) }
    $helperSha = ('ab' * 32)
    Reset-Fakes; New-InstalledManifest; $script:FakeVms = @((New-Vm $guidA 'albera-clone-01'))
    Grant-BrokerHyperV
    $helperRecord = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $helperRecord['exeSha256'] = $helperSha; $helperRecord['treeSha256'] = ('cd' * 32); $helperRecord['files'] = 1
    $script:Manifest['created']['binaries']['pipe-client'] = $helperRecord
    Write-SettingsFile $helperSha
    $result.statusDesktop = [ordered]@{ asRecorded = @(Get-DesktopLines) }
    Write-SettingsFile ('cd' * 32); $result.statusDesktop.otherHash = @(Get-DesktopLines)
    Write-SettingsFile $null; $result.statusDesktop.noBlock = @(Get-DesktopLines)
    Write-SettingsFile $helperSha; $script:Manifest['created']['binaries'].Remove('pipe-client') | Out-Null; $result.statusDesktop.noHelperRecord = @(Get-DesktopLines)
    Reset-Fakes; New-InstalledManifest; Write-SettingsFile $null
    $result.statusDesktop.installWithoutGrant = @(Get-DesktopLines)
    Write-SettingsFile $helperSha
    $result.statusDesktop.desktopWithoutGrantRecord = @(Get-DesktopLines)

    # 7. the services step: the Broker's SID type has to match the option of THIS run, in both directions
    $svcStep = { Get-InstallSteps | Where-Object { $_.Id -eq 'services' } }
    function Set-Services([string]$BrokerType, [string]$AuthorityType = 'restricted') { $script:Svc = @{}; $script:Svc[$K.BrokerService] = $BrokerType; $script:Svc[$K.AuthorityService] = $AuthorityType; $script:ScCalls.Clear() }
    function Get-SidCalls { @($script:ScCalls | Where-Object { $_ -like 'sidtype *' }) }
    # an install begun WITH the option (Broker unrestricted) and run again WITHOUT it: not done; the Do puts the Broker back to restricted, and says so by reading it back
    Reset-Fakes; New-InstalledManifest; Set-Services 'unrestricted'; $GrantHyperVToBroker = $false
    $step = & $svcStep
    $result.svcNoOptionWasUnrestricted = [ordered]@{ test = (& $step.Test) }
    $result.svcNoOptionWasUnrestricted.doError = Try-Run { & $step.Do }
    $result.svcNoOptionWasUnrestricted.sidCalls = @(Get-SidCalls)
    $result.svcNoOptionWasUnrestricted.broker = $script:Svc[$K.BrokerService]
    $result.svcNoOptionWasUnrestricted.authority = $script:Svc[$K.AuthorityService]
    $result.svcNoOptionWasUnrestricted.testAfter = (& $step.Test)
    # the unchanged cases: no option and restricted = done (nothing issued); option and restricted = todo, then unrestricted; option and unrestricted = done
    Reset-Fakes; New-InstalledManifest; Set-Services 'restricted'
    $result.svcNoOptionRestricted = [ordered]@{ test = (& (& $svcStep).Test); sidCalls = @(Get-SidCalls).Count }
    $GrantHyperVToBroker = $true
    $step = & $svcStep
    $result.svcOptionRestricted = [ordered]@{ test = (& $step.Test) }
    $result.svcOptionRestricted.doError = Try-Run { & $step.Do }
    $result.svcOptionRestricted.broker = $script:Svc[$K.BrokerService]
    $result.svcOptionRestricted.authority = $script:Svc[$K.AuthorityService]
    $result.svcOptionRestricted.testAfter = (& $step.Test)
    $result.svcOptionUnrestricted = (& $step.Test)
    $GrantHyperVToBroker = $false

    # 8. the whole uninstall, step by step as the runner does it, for an install whose services were NEVER started (their data folders are empty: broker, authority, control-plane), with and without the grant
    $script:KeyExists = $false; $script:RemovedUsers = New-Object 'System.Collections.Generic.List[string]'
    function Remove-TrustedTree([string]$Dir, [string[]]$AllowedTop, [string[]]$AllowedFolders, [bool]$InstallTree) { Remove-HostTree $Dir $AllowedTop $AllowedFolders $InstallTree }   # the trust test has its own case
    function Test-AuthoritySigningKeyExists([string]$KeyName, [string]$Scope = 'machine') { $script:KeyExists }
    function Remove-AuthoritySigningKey([string]$KeyName, [string]$Scope = 'machine') { $script:KeyExists = $false; $true }
    function Remove-LocalUser { param($SID) $script:RemovedUsers.Add([string]$SID.Value) }
    function Invoke-FakeUninstall([bool]$WithGrant) {
      function Get-PathTrustReasons { , @() }   # the temp folders are the current user's: the trust test has its own case, the removal itself is what is run here
      if (Test-Path -LiteralPath $L.DataRoot) { Remove-Item -LiteralPath $L.DataRoot -Recurse -Force }
      if (Test-Path -LiteralPath $L.InstallRoot) { Remove-Item -LiteralPath $L.InstallRoot -Recurse -Force }
      Reset-Fakes; New-InstalledManifest; $script:FakeVms = @((New-Vm $guidA 'albera-clone-01'))
      if ($WithGrant) { Grant-BrokerHyperV }
      Set-Services $(if ($WithGrant) { 'unrestricted' } else { 'restricted' })
      foreach ($d in (Get-KnownDataFolders)) { New-Item -ItemType Directory -Force -Path (Join-Path $L.DataRoot $d) | Out-Null }
      [System.IO.File]::WriteAllText($L.BrokerConfig, '{}')
      foreach ($s in (Get-BuildSources)) { New-Item -ItemType Directory -Force -Path $s.Dest | Out-Null; [System.IO.File]::WriteAllText((Join-Path $s.Dest 'a.dll'), 'x') }
      $key = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $key['name'] = $K.SigningKeyName
      $script:Manifest['created']['installRoot'] = $true; $script:Manifest['created']['key'] = $key; Save-Manifest
      $script:KeyExists = $true; $script:RemovedUsers.Clear(); $script:Calls.Clear()
      $ran = New-Object 'System.Collections.Generic.List[string]'; $error1 = $null
      foreach ($s in (Get-UninstallSteps)) {
        if ((& $s.Test) -eq 'done') { continue }
        $ran.Add($s.Id)
        try { & $s.Do } catch { $error1 = $s.Id + ': ' + $_.Exception.Message; break }
      }
      [ordered]@{ error = $error1; ran = @($ran); services = @($script:Svc.Keys); keyGone = (-not $script:KeyExists); userRemoved = @($script:RemovedUsers); dataRootGone = (-not (Test-Path -LiteralPath $L.DataRoot))
        installRootGone = (-not (Test-Path -LiteralPath $L.InstallRoot)); members = @($script:Members); removeCalls = @($script:Calls | Where-Object { $_ -like 'remove *' }) }
    }
    $result.uninstallWithGrant = Invoke-FakeUninstall $true
    $result.uninstallWithoutGrant = Invoke-FakeUninstall $false
    # an empty known folder is not "unknown": the real removal of one
    New-Item -ItemType Directory -Force -Path (Join-Path $L.DataRoot 'broker') | Out-Null
    $result.emptyKnownFolderError = Try-Run { Remove-HostTree (Join-Path $L.DataRoot 'broker') @() @() $false }
  }
  'desktop' {
    # The shipped Write-HostConfigs and the 'configs' step test, run with a Write-OneConfig that writes plain files into the temp folder (the trust and ACL work of the real one has its own cases) and a
    # fixed SID table. The pipe client helper is a real file in the temp bin folder with a real install record (Set-BinaryRecord). No service, account, key or group is touched.
    $VmName = 'albera-clone-01'; $ComputerId = 'clone-01'; $ProjectId = 'albera-host'; $GrantHyperVToBroker = $false
    $guidA = '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f'; $VmId = $guidA
    $cpSid = 'S-1-5-21-1111111111-2222222222-3333333333-1500'
    # the throw-away RSA-2048 public key that lab-host-install-check.ps1 pins as the approver key
    $labApproverKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3XSX1Rx6n1/sVaG+opeyv2Qj/+8woifjIQgxqheuZ1LtyB/JUeDgkP6wIc6YSAQzMKbdwZ88ipVJidmpixqr0P4tcE3Ud6VqerYfHnrVlqGKHojUU0r2kmtKib9f3bT0+ljHa54Dux9jcGSncwXpXcRrOkNFRFrWuS99+yXpFWdgYeawOK9SegknG1J4Rw7fjPZurkVWYYLl17T10PSIg0TGY0eJRgRXVw7PQhsLRh4u3ErDSd4dkE4j1aUR0jCGovRZJrrAMib7P1+GPRUOL6bviCkYY9Q2yOIP+OKWevFw80WXdYktQv/3xeloBWYctgzU6aS7J+7logyEYr0zWwIDAQAB'
    $script:Approver = [pscustomobject]@{ approverPublicKey = $labApproverKey; approverKeyId = 'hello-0123456789abcdef'; approverSid = 'S-1-5-21-1111111111-2222222222-3333333333-1001' }
    $cpServiceSid = Get-DerivedServiceSid $K.ControlPlaneService
    function Resolve-HostSids { $script:Sids = @{ Broker = (Get-DerivedServiceSid $K.BrokerService); Authority = (Get-DerivedServiceSid $K.AuthorityService); ControlPlane = $cpServiceSid } }
    $script:Written = New-Object 'System.Collections.Generic.List[string]'
    function Write-OneConfig([string]$Path, [string]$Text, [string[]]$Writers) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null; [System.IO.File]::WriteAllText($Path, $Text); $script:Written.Add($Path) }
    function Invoke-WriteConfigs { $script:Written.Clear(); Try-Run { Write-HostConfigs } }
    # '' for a file that was not written, so a refused write shows up as the case's error text (and a failed assertion), not as an exception here
    function Read-Config([string]$Path) { if (Test-Path -LiteralPath $Path) { [System.IO.File]::ReadAllText($Path) } else { '' } }
    function Get-ConfigsStep { Get-InstallSteps | Where-Object { $_.Id -eq 'configs' } }

    New-Item -ItemType Directory -Force -Path $L.DataRoot | Out-Null
    $script:Manifest = New-Manifest
    # the pins the service config names (recorded by the node and claude steps)
    $nodeRecord = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $nodeRecord['serviceSid'] = $cpServiceSid; $nodeRecord['nodeSha256'] = ('ab' * 32); $nodeRecord['nodeSource'] = 'C:\Program Files\nodejs\node.exe'
    $claudeRecord = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $claudeRecord['sha256'] = ('cd' * 32); $claudeRecord['fileVersion'] = '2.1.310'; $claudeRecord['source'] = 'C:\Users\x\.local\bin\claude.exe'
    $script:Manifest['created']['controlPlane'] = $nodeRecord; $script:Manifest['created']['claude'] = $claudeRecord
    $result.cpServiceSid = $cpServiceSid
    $ecc = New-Object System.Security.Cryptography.ECDsaCng(256)
    try { $script:Manifest['values']['authoritySpki'] = ConvertTo-P256Spki ($ecc.Key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)) } finally { $ecc.Dispose() }
    $helperSource = Get-BuildSources | Where-Object { $_.Name -eq 'pipe-client' }
    Write-Fixture $helperSource.Dest $helperSource.Exe
    Set-BinaryRecord $helperSource (Get-TreeHashes $helperSource.Dest)
    $result.helperPath = $L.PipeClientExe
    $result.helperRecorded = $script:Manifest['created']['binaries']['pipe-client']['exeSha256']
    $result.helperLive = Get-Sha256File $L.PipeClientExe

    # 1. without the option: the settings are exactly what they were before the option had a desktop block, and the step is done once the three files exist
    $result.plainError = Invoke-WriteConfigs
    $result.plainWritten = @($script:Written | ForEach-Object { Split-Path -Leaf $_ })
    $result.plainSettings = Read-Config $L.ApprovalSettings
    $result.plainBrokerHasComputers = (Read-Config $L.BrokerConfig) -like '*"computers"*'
    $result.plainTest = & (Get-ConfigsStep).Test

    # 2. with the option over those plain files: the step is not done (no computers, no desktop block); the run writes both
    $GrantHyperVToBroker = $true
    $step = Get-ConfigsStep
    $result.grantTestOverPlain = & $step.Test
    $result.grantError = Invoke-WriteConfigs
    $result.grantSettings = Read-Config $L.ApprovalSettings
    $result.grantBrokerComputers = (Read-Config $L.BrokerConfig | ConvertFrom-Json).computers
    $result.grantTestAfter = & $step.Test

    # 3. a desktop block that is not the installed helper's makes the step todo again (an older or hand-edited file is rewritten, never trusted)
    $good = Read-Config $L.ApprovalSettings
    [System.IO.File]::WriteAllText($L.ApprovalSettings, $good.Replace($result.helperRecorded, ('0' * 64)))
    $result.testOtherHash = & $step.Test
    [System.IO.File]::WriteAllText($L.ApprovalSettings, $good.Replace('"helperPath":', '"helperPathX":'))
    $result.testOtherKey = & $step.Test
    [System.IO.File]::WriteAllText($L.ApprovalSettings, $good)
    $result.testRestored = & $step.Test

    # 4. the helper on disk is not the one the install record took: nothing is written, the step is todo, and the error says why
    [System.IO.File]::WriteAllText($L.PipeClientExe, 'a replaced helper')
    $before = Read-Config $L.ApprovalSettings
    $result.replacedTest = & $step.Test
    $result.replacedError = Invoke-WriteConfigs
    $result.replacedWritten = $script:Written.Count
    $result.replacedSettingsUntouched = ($before -ceq (Read-Config $L.ApprovalSettings))
    [System.IO.File]::WriteAllText($L.PipeClientExe, 'exe bytes of ' + $helperSource.Exe)

    # 5. no record of the helper (binaries step never ran): nothing is written
    $recorded = $script:Manifest['created']['binaries']['pipe-client']
    $script:Manifest['created']['binaries'].Remove('pipe-client') | Out-Null
    $result.noRecordError = Invoke-WriteConfigs
    $result.noRecordWritten = $script:Written.Count
    $script:Manifest['created']['binaries']['pipe-client'] = $recorded
    # ... and no helper file at all
    Remove-Item -LiteralPath $L.PipeClientExe
    $result.noFileError = Invoke-WriteConfigs
    $result.noFileWritten = $script:Written.Count
    $result.noFileTest = & $step.Test
  }
  'group' {
    # The real Test-LocalGroupExists (nothing faked, read only): a group that exists, a SID that maps to nothing, and a failure that is neither.
    $result.administrators = Test-LocalGroupExists 'S-1-5-32-544'
    $result.unmapped = Test-LocalGroupExists 'S-1-5-32-99999'
    $result.malformed = Try-Run { Test-LocalGroupExists 'not-a-sid' }
  }
  'cp' {
    # The new install steps of the Control Plane service, run for real against a TEMP layout with FAKES for the machine (sc.exe, the SCM, the shell, the registry, ACLs): the pinned node.exe and
    # claude.exe, the order of the service registration (launch-check first), the launcher / shortcuts / Run entry, adopting the install root albera-setup.exe made, and anti-rollback. The trust
    # test (the temp folders belong to this user) has its own cases. Nothing outside -Work is touched.
    function Get-PathTrustReasons { , @() }
    $origChain = ${function:Get-ReparseChain}
    function Get-ReparseChain([string]$Path) { $c = & $origChain $Path; , @($c | Where-Object { $_.Length -ge $Work.Length -and $_.StartsWith($Work, [System.StringComparison]::OrdinalIgnoreCase) }) }   # only links INSIDE the temp folder count (the temp path itself may sit behind one)
    $origResolveHostSids = ${function:Resolve-HostSids}
    $approverSid = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
    $VmName = 'albera-clone-01'; $ComputerId = 'clone-01'; $ProjectId = 'albera-host'; $GrantHyperVToBroker = $false
    $ApproverKeyId = 'hello-0123456789abcdef'; $ApproverPublicKey = 'x'; $ApproverSid = $approverSid
    $script:Approver = [pscustomobject]@{ approverPublicKey = 'x'; approverKeyId = $ApproverKeyId; approverSid = $approverSid }
    $cpSvcSid = Get-DerivedServiceSid $K.ControlPlaneService
    $SystemDirectory = Join-Path $Work 'sys32'
    $script:Order = New-Object 'System.Collections.Generic.List[string]'
    function New-CpManifest {
      New-Item -ItemType Directory -Force -Path $L.DataRoot | Out-Null
      $script:Manifest = New-Manifest
      $script:Manifest['created']['installRoot'] = $true
      $script:Manifest['created']['services'] = @($K.BrokerService, $K.AuthorityService)
      $script:Manifest['values']['approverSid'] = $approverSid
      Save-Manifest
    }
    function Get-Step([string]$Id) { Get-InstallSteps | Where-Object { $_.Id -eq $Id } }
    function Write-Bytes([string]$Path, [string]$Text) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null; [System.IO.File]::WriteAllText($Path, $Text) }

    # ---- 1. the pinned node.exe: copied into bin\control-plane\node (never run), the SHA-256 of the COPY is recorded
    New-CpManifest
    New-Item -ItemType Directory -Force -Path $L.ControlPlaneBinDir | Out-Null
    $binRec = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $binRec['exeSha256'] = ('1' * 64); $binRec['treeSha256'] = ('2' * 64); $binRec['files'] = 1
    $script:Manifest['created']['binaries']['control-plane'] = $binRec
    $nodeFile = Join-Path $Work 'src-node\node.exe'; Write-Bytes $nodeFile 'fake node bytes'
    $NodeSource = $nodeFile
    $nodeStep = Get-Step 'node'
    $result.nodeBefore = & $nodeStep.Test
    $result.nodeError = Try-Run { & $nodeStep.Do }
    $result.nodeShaOfCopy = Get-Sha256File $L.ControlPlaneNodeExe
    $result.nodeShaOfSource = Get-Sha256File $nodeFile
    $result.nodeRecord = $script:Manifest['created']['controlPlane']
    $result.nodeRecordOnDisk = (Read-Manifest)['created']['controlPlane']
    $result.nodePartialLeft = Test-Path -LiteralPath ($L.ControlPlaneNodeExe + '.partial')
    $result.nodeAfter = & $nodeStep.Test
    [System.IO.File]::WriteAllText($L.ControlPlaneNodeExe, 'a node somebody replaced')
    $result.nodeTampered = & $nodeStep.Test
    Remove-Item -LiteralPath $L.ControlPlaneNodeDir -Recurse -Force; $script:Manifest['created'].Remove('controlPlane') | Out-Null
    $NodeSource = Join-Path $Work 'nowhere\node.exe'
    $result.nodeSourceMissing = & $nodeStep.Test
    $real = Join-Path $Work 'real-node'; Write-Bytes (Join-Path $real 'node.exe') 'x'
    $link = Join-Path $Work 'link-node'; New-Junction $link $real
    $NodeSource = Join-Path $link 'node.exe'
    $result.nodeSourceLink = & $nodeStep.Test
    Remove-Junction $link
    $NodeSource = $nodeFile

    # ---- 2. the pinned claude.exe: the owner's own profile (found from the approver SID), only when the account that said yes to UAC is the approver
    $profile = Join-Path $Work 'profile'; $claudeFile = Join-Path $profile '.local\bin\claude.exe'; Write-Bytes $claudeFile 'fake claude bytes'
    $script:FakeProfile = $profile; $script:FakeElevated = $approverSid
    function Get-OwnerProfilePath([string]$Sid) { if ($Sid -ceq $approverSid) { $script:FakeProfile } else { $null } }
    function Get-ElevatedSid { $script:FakeElevated }
    $ClaudeSource = $null
    $claudeStep = Get-Step 'claude'
    $result.claudeBefore = & $claudeStep.Test
    $result.claudeError = Try-Run { & $claudeStep.Do }
    $result.claudeShaOfCopy = Get-Sha256File $L.ClaudeExe
    $result.claudeShaOfSource = Get-Sha256File $claudeFile
    $result.claudeRecord = $script:Manifest['created']['claude']
    $result.claudeAfter = & $claudeStep.Test
    Remove-Item -LiteralPath $L.ClaudeBinDir -Recurse -Force; $script:Manifest['created'].Remove('claude') | Out-Null
    $script:FakeElevated = 'S-1-5-21-1111111111-2222222222-3333333333-500'
    $result.claudeOtherAdmin = & $claudeStep.Test
    $result.claudeOtherAdminDoError = Try-Run { & $claudeStep.Do }
    $result.claudeOtherAdminNothingCopied = -not (Test-Path -LiteralPath $L.ClaudeExe)
    $script:FakeElevated = 'S-1-5-18'; $result.claudeSystem = & $claudeStep.Test
    $script:FakeElevated = $approverSid; $script:FakeProfile = $null; $result.claudeNoProfile = & $claudeStep.Test
    $script:FakeProfile = (Join-Path $Work 'empty-profile'); New-Item -ItemType Directory -Force -Path $script:FakeProfile | Out-Null; $result.claudeNotInstalled = & $claudeStep.Test
    $script:FakeProfile = $profile
    $ClaudeSource = $claudeFile                      # the lab-only parameter: any file, still only by the approver account
    $result.claudeLabSource = & $claudeStep.Test
    $script:FakeElevated = 'S-1-5-21-1111111111-2222222222-3333333333-500'; $result.claudeLabSourceOtherAdmin = & $claudeStep.Test; $script:FakeElevated = $approverSid
    $ClaudeSource = $null
    $result.claudeDoAgainError = Try-Run { & $claudeStep.Do }   # leaves both pins recorded for the sections below

    # ---- 3. the service: launch-check of the installed host FIRST, then the registration; a host that refuses leaves nothing registered. The fake SCM is driven by what the script issues.
    $script:Svc = @{}
    function Get-CimInstance { param([Parameter(Position = 0)]$Class, $Namespace, $ClassName, $Filter)
      if ($Class -eq 'Win32_Service') { $n = [regex]::Match([string]$Filter, "Name='([^']+)'").Groups[1].Value; if ($script:Svc.ContainsKey($n)) { return [pscustomobject]@{ Name = $n } } }
      $null }
    function Get-AccountSid([string]$Account) { Get-DerivedServiceSid ($Account -replace '^NT SERVICE\\', '') }
    function Invoke-Sc([string]$Arguments) {
      $script:Order.Add('sc ' + $Arguments)
      $t = $Arguments -split ' '; $name = $t[1]
      switch ($t[0]) {
        'create' { $script:Svc[$name] = [ordered]@{ auto = ($Arguments -like '*start= delayed-auto*'); delayed = ($Arguments -like '*start= delayed-auto*'); sid = 'none'; privs = 'all'; failure = '' } }
        'config' { if ($Arguments -like '*start= delayed-auto*') { $script:Svc[$name].auto = $true; $script:Svc[$name].delayed = $true } }
        'sidtype' { $script:Svc[$name].sid = $t[2] }
        'privs' { $script:Svc[$name].privs = $t[2] }
        'failure' { $n = ([regex]::Matches($Arguments, 'restart/5000')).Count; $script:Svc[$name].failure = ((1..$n | ForEach-Object { 'RESTART -- Delay = 5000 milliseconds.' }) -join ' ') }
      }
      [pscustomobject]@{ Exit = 0; Out = ''; Err = '' }
    }
    function Get-ServiceFactsFor([string]$Name) {
      if (-not $script:Svc.ContainsKey($Name)) { return [pscustomobject]@{ Exists = $false } }
      $s = $script:Svc[$Name]; $spec = Get-ServiceSpecs | Where-Object { $_.Name -eq $Name }
      [pscustomobject]@{ Exists = $true; StartName = "NT SERVICE\$Name"; PathName = (Get-ServiceCommandLine $spec.Exe $spec.Config); StartMode = $(if ($s.auto) { 'Auto' } else { 'Manual' }); DelayedAutoStart = $s.delayed; ServiceType = 'Own Process'
        SidTypeText = ('SERVICE_SID_TYPE:  ' + $s.sid.ToUpperInvariant()); PrivilegesText = $(if ($s.privs -eq 'SeChangeNotifyPrivilege') { 'PRIVILEGES : SeChangeNotifyPrivilege' } else { 'PRIVILEGES : SeImpersonatePrivilege SeChangeNotifyPrivilege SeCreateGlobalPrivilege' }); FailureText = $s.failure; State = 'Stopped' }
    }
    $script:LaunchExit = 0
    function Invoke-LaunchCheck { $script:Order.Add('launch-check'); [pscustomobject]@{ Exit = $script:LaunchExit; Out = 'SERVICE_CONFIG=ok CPHOST_LAUNCH=ok' } }
    $cpStep = Get-Step 'cpservice'
    $result.cpBefore = & $cpStep.Test
    $script:LaunchExit = 78; $script:Order.Clear()
    $result.cpRefusedError = Try-Run { & $cpStep.Do }
    $result.cpRefusedOrder = @($script:Order)
    $result.cpRefusedRegistered = $script:Svc.ContainsKey($K.ControlPlaneService)
    $result.cpRefusedRecorded = [bool](@($script:Manifest['created']['services']) -contains $K.ControlPlaneService)
    $script:LaunchExit = 0; $script:Order.Clear()
    $result.cpError = Try-Run { & $cpStep.Do }
    $result.cpOrder = @($script:Order)
    $result.cpRecorded = [bool](@($script:Manifest['created']['services']) -contains $K.ControlPlaneService)
    $result.cpRecordedOnDisk = [bool](@((Read-Manifest)['created']['services']) -contains $K.ControlPlaneService)
    $result.cpAfter = & $cpStep.Test
    $result.cpState = $script:Svc[$K.ControlPlaneService]
    # a service of that name that this script did not make is never touched
    $script:Manifest['created']['services'] = @($K.BrokerService, $K.AuthorityService)
    $result.cpForeign = & $cpStep.Test
    $script:Manifest['created']['services'] = @($K.BrokerService, $K.AuthorityService, $K.ControlPlaneService)
    # drift is seen: not delayed, no failure actions, an extra privilege
    $script:Svc[$K.ControlPlaneService].delayed = $false; $result.cpNotDelayed = & $cpStep.Test; $script:Svc[$K.ControlPlaneService].delayed = $true
    $script:Svc[$K.ControlPlaneService].failure = ''; $result.cpNoFailureActions = & $cpStep.Test; $script:Svc[$K.ControlPlaneService].failure = 'RESTART -- Delay = 5000 milliseconds. RESTART -- Delay = 5000 milliseconds.'
    $script:Svc[$K.ControlPlaneService].privs = 'all'; $result.cpExtraPrivilege = & $cpStep.Test; $script:Svc[$K.ControlPlaneService].privs = 'SeChangeNotifyPrivilege'
    $result.cpDriftFixed = & $cpStep.Test

    # ---- 4. the launcher, the Start menu shortcuts and the HKLM Run entry (fakes for the shell link and the registry; the script text and the records are the shipped ones)
    New-CpManifest
    $script:RunValue = $null; $script:TrustedDirs = New-Object 'System.Collections.Generic.List[string]'
    function Write-OneConfig([string]$Path, [string]$Text, [string[]]$Writers) { Write-Bytes $Path $Text }
    function New-TrustedDirectory([string]$Path, [string[]]$Grants, [string]$OwnerSid = 'S-1-5-32-544') { $script:TrustedDirs.Add($Path + ' | ' + ($Grants -join ' ')); New-Item -ItemType Directory -Force -Path $Path | Out-Null }
    function New-ShellLink($Spec) { Write-Bytes $Spec.Path (ConvertTo-Json -InputObject ([ordered]@{ TargetPath = $Spec.Target; Arguments = $Spec.Arguments; WorkingDirectory = $Spec.WorkingDirectory }) -Compress) }
    function Read-ShellLink([string]$Path) { if (-not (Test-Path -LiteralPath $Path)) { return $null }; $o = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json; [pscustomobject]@{ TargetPath = $o.TargetPath; Arguments = $o.Arguments; WorkingDirectory = $o.WorkingDirectory } }
    function Get-RunEntryValue { $script:RunValue }
    function Set-RunEntryValue { $script:RunValue = (Get-RunEntry $L).Command }
    function Remove-RunEntryValue { $script:RunValue = $null }
    $shStep = Get-Step 'shortcuts'
    $result.shBefore = & $shStep.Test
    $result.shError = Try-Run { & $shStep.Do }
    $result.shLauncherIsShipped = ([System.IO.File]::ReadAllText($L.OpenScript) -ceq (Get-OpenAlberaScriptText $L))
    $result.shLauncherRecord = $script:Manifest['created']['launcher']
    $result.shLauncherSha = Get-Sha256File $L.OpenScript
    $result.shShortcutsRecord = @($script:Manifest['created']['shortcuts'])
    $result.shLinks = @(Get-ChildItem -LiteralPath $L.StartMenuDir -File | ForEach-Object { $_.Name } | Sort-Object)
    $result.shRunRecord = $script:Manifest['created']['runEntry']
    $result.shRunValue = $script:RunValue
    $result.shTrustedDirs = @($script:TrustedDirs)
    $result.shAfter = & $shStep.Test
    $result.shOnDisk = [ordered]@{ launcher = [bool](Read-Manifest)['created'].ContainsKey('launcher'); shortcuts = @((Read-Manifest)['created']['shortcuts']); run = [bool](Read-Manifest)['created'].ContainsKey('runEntry') }
    # with albera-setup.exe in place the update shortcut is made too
    Write-Bytes $L.SetupExe 'setup'
    $result.shWithSetupBefore = & $shStep.Test
    $result.shWithSetupError = Try-Run { & $shStep.Do }
    $result.shWithSetupRecord = @($script:Manifest['created']['shortcuts'])
    $result.shWithSetupAfter = & $shStep.Test
    # drift is seen: the Run value, the launcher, a shortcut target
    $script:RunValue = '"C:\evil.exe"'; $result.shRunChanged = & $shStep.Test; Set-RunEntryValue
    [System.IO.File]::WriteAllText($L.OpenScript, 'changed'); $result.shLauncherChanged = & $shStep.Test; [System.IO.File]::WriteAllText($L.OpenScript, (Get-OpenAlberaScriptText $L))
    Write-Bytes $L.OpenShortcut '{"TargetPath":"C:\\evil.exe","Arguments":"","WorkingDirectory":""}'; $result.shLinkChanged = & $shStep.Test
    $result.shRestoredError = Try-Run { & $shStep.Do }
    $result.shRestored = & $shStep.Test
    # a shortcut that reads back wrong is an error, never recorded
    function Read-ShellLink([string]$Path) { [pscustomobject]@{ TargetPath = 'C:\somewhere\else.exe'; Arguments = ''; WorkingDirectory = '' } }
    $result.shReadBackWrongError = Try-Run { & $shStep.Do }

    # ---- 5. the install root made by albera-setup.exe (bin\setup, setup-work) is adopted; anything else in it is not
    if (Test-Path -LiteralPath $L.DataRoot) { Remove-Item -LiteralPath $L.DataRoot -Recurse -Force }
    if (Test-Path -LiteralPath $L.InstallRoot) { Remove-Item -LiteralPath $L.InstallRoot -Recurse -Force }
    $why = Get-InstallRootAdoptionReasons; $result.adoptAbsent = $why.Count
    Write-Bytes (Join-Path $L.InstallRoot 'bin\setup\albera-setup.exe') 'setup'; Write-Bytes (Join-Path $L.InstallRoot 'setup-work\abc123\copy\repo\x.txt') 'x'
    $why = Get-InstallRootAdoptionReasons; $result.adoptSetupOnly = $why.Count
    New-CpManifest; $script:Manifest['created']['installRoot'] = $false
    $foldersStep = Get-Step 'folders'
    $result.adoptFoldersTest = & $foldersStep.Test
    Write-Bytes (Join-Path $L.InstallRoot 'readme.txt') 'x'
    $why = Get-InstallRootAdoptionReasons; $result.adoptReadme = @($why)
    $result.adoptReadmeFoldersTest = & $foldersStep.Test
    Remove-Item -LiteralPath (Join-Path $L.InstallRoot 'readme.txt')
    Write-Bytes (Join-Path $L.InstallRoot 'bin\broker\x.exe') 'x'
    $why = Get-InstallRootAdoptionReasons; $result.adoptOurFolder = @($why)
    Remove-Item -LiteralPath (Join-Path $L.InstallRoot 'bin\broker') -Recurse -Force
    $other = Join-Path $Work 'other-target'; New-Item -ItemType Directory -Force -Path $other | Out-Null
    New-Junction (Join-Path $L.InstallRoot 'bin\setup\link') $other
    $why = Get-InstallRootAdoptionReasons; $result.adoptJunction = @($why)
    Remove-Junction (Join-Path $L.InstallRoot 'bin\setup\link')
    function Get-PathTrustReasons { , @('owner_untrusted') }
    $why = Get-InstallRootAdoptionReasons; $result.adoptUntrusted = @($why)
    $result.adoptUntrustedFoldersTest = & $foldersStep.Test
    function Get-PathTrustReasons { , @() }
    # the ACL of an adopted root is replaced like any other folder's, and the record then says it is ours
    $script:Calls = New-Object 'System.Collections.Generic.List[string]'
    function Set-HostAcl($Entry) { $script:Calls.Add('acl ' + $Entry.Path) }
    function Get-AclSummary([string]$Path) { [pscustomobject]@{ Owner = 'S-1-5-32-544'; Protected = $true; AllowSids = @(); WriteSids = @() } }
    function Test-AclMatchesPlan($Entry, $Summary) { , @() }
    function Resolve-HostSids { $script:Sids = @{ Broker = (Get-DerivedServiceSid $K.BrokerService); Authority = (Get-DerivedServiceSid $K.AuthorityService); ControlPlane = $cpSvcSid; Approver = $approverSid; Legacy = $false } }
    $result.adoptDoError = Try-Run { & $foldersStep.Do }
    $result.adoptRecorded = [bool]$script:Manifest['created']['installRoot']
    $result.adoptRecordedOnDisk = [bool](Read-Manifest)['created']['installRoot']
    $result.adoptAclFirst = @($script:Calls)[0]
    $result.adoptFolderCount = @($script:Calls).Count
    $result.adoptSetupKept = Test-Path -LiteralPath (Join-Path $L.InstallRoot 'bin\setup\albera-setup.exe')
    # an install root that is not ours and not setup's is refused outright
    New-CpManifest; $script:Manifest['created']['installRoot'] = $false; Remove-Item -LiteralPath $L.InstallRoot -Recurse -Force
    Write-Bytes (Join-Path $L.InstallRoot 'someone-elses.txt') 'x'
    $result.foreignRootDoError = Try-Run { & $foldersStep.Do }

    # ---- 6. anti-rollback (the install record's setupRunId against -SetupRunId) and the first-layout guard
    Set-Item -Path Function:\Resolve-HostSids -Value $origResolveHostSids   # the shipped one again (section 5 used a fixed table)
    New-CpManifest; $script:Manifest['setupRunId'] = '100'; Save-Manifest
    $sourcesStep = Get-Step 'sources'
    $out = [ordered]@{}
    foreach ($id in @('99', '100', '101', '18446744073709551615', '')) { $SetupRunId = $id; $out['id' + $id] = [ordered]@{ refusal = (Get-RollbackRefusal); blocked = ([string](& $sourcesStep.Test)).StartsWith('blocked:setup_run_id_older_than_installed') } }
    $SetupRunId = $null; $out['none'] = [ordered]@{ refusal = (Get-RollbackRefusal) }
    $result.rollback = $out
    $result.rollbackMessage = $null; $SetupRunId = '99'; $result.rollbackMessage = (& $sourcesStep.Test); $SetupRunId = $null
    $SetupRunId = '101'; Set-ManifestSetupRunId; $result.ratchetUp = [ordered]@{ memory = $script:Manifest['setupRunId']; disk = (Read-Manifest)['setupRunId'] }
    $SetupRunId = '50'; Set-ManifestSetupRunId; $result.ratchetNotDown = [ordered]@{ memory = $script:Manifest['setupRunId']; disk = (Read-Manifest)['setupRunId'] }
    $SetupRunId = '18446744073709551615'; Set-ManifestSetupRunId; $result.ratchetMax = (Read-Manifest)['setupRunId']
    $SetupRunId = $null
    New-CpManifest; $SetupRunId = '7'; Set-ManifestSetupRunId; $result.ratchetFirst = (Read-Manifest)['setupRunId']; $SetupRunId = $null
    New-CpManifest; $u = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $u['name'] = $K.ControlPlaneUser; $u['sid'] = 'S-1-5-21-1111111111-2222222222-3333333333-1500'; $script:Manifest['created']['user'] = $u
    $result.legacyGuard = (& $sourcesStep.Test)
    $result.legacyLayout = [ordered]@{ legacy = (Test-LegacyLayout); sids = $(Resolve-HostSids; [ordered]@{ cp = $script:Sids.ControlPlane; legacyFlag = $script:Sids.Legacy }) }
    New-CpManifest; Resolve-HostSids
    $result.newLayout = [ordered]@{ legacy = (Test-LegacyLayout); cpIsServiceSid = ($script:Sids.ControlPlane -ceq $cpSvcSid); approver = $script:Sids.Approver }
  }
  'migrate' {
    # -Mode migrate end to end against a TEMP layout with FAKES for the machine (services, the account and its profile, processes, the Hyper-V group, the machine key, the shell, the registry,
    # ACLs): a first-layout install is read, the new install is checked BEFORE anything is removed, the account's processes are stopped by PID, the uninstall runs, the new install runs with the
    # carried-over values, and what albera-setup.exe keeps in the install folder stays. The shipped functions run; only what touches the machine is replaced.
    function Get-PathTrustReasons { , @() }
    $origChain = ${function:Get-ReparseChain}
    function Get-ReparseChain([string]$Path) { $c = & $origChain $Path; , @($c | Where-Object { $_.Length -ge $Work.Length -and $_.StartsWith($Work, [System.StringComparison]::OrdinalIgnoreCase) }) }
    $ownerSid = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
    $legacySid = 'S-1-5-21-1111111111-2222222222-3333333333-1500'
    $guidA = '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f'
    $labApproverKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3XSX1Rx6n1/sVaG+opeyv2Qj/+8woifjIQgxqheuZ1LtyB/JUeDgkP6wIc6YSAQzMKbdwZ88ipVJidmpixqr0P4tcE3Ud6VqerYfHnrVlqGKHojUU0r2kmtKib9f3bT0+ljHa54Dux9jcGSncwXpXcRrOkNFRFrWuS99+yXpFWdgYeawOK9SegknG1J4Rw7fjPZurkVWYYLl17T10PSIg0TGY0eJRgRXVw7PQhsLRh4u3ErDSd4dkE4j1aUR0jCGovRZJrrAMib7P1+GPRUOL6bviCkYY9Q2yOIP+OKWevFw80WXdYktQv/3xeloBWYctgzU6aS7J+7logyEYr0zWwIDAQAB'
    $ecc = New-Object System.Security.Cryptography.ECDsaCng(256)
    try { $spki = ConvertTo-P256Spki ($ecc.Key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)) } finally { $ecc.Dispose() }
    $SystemDirectory = Join-Path $Work 'sys32'; $ProgramFilesDir = Join-Path $Work 'pf'
    $script:Order = New-Object 'System.Collections.Generic.List[string]'
    $script:State = [ordered]@{}
    function Read-Json([string]$Path) { if (Test-Path -LiteralPath $Path) { [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json } else { $null } }
    function Write-Bytes([string]$Path, [string]$Text) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null; [System.IO.File]::WriteAllText($Path, $Text) }

    # ---- the fake machine
    function Get-CimInstance { param([Parameter(Position = 0)]$Class, $Namespace, $ClassName, $Filter)
      if ($Class -eq 'Win32_Service') { $n = [regex]::Match([string]$Filter, "Name='([^']+)'").Groups[1].Value; if ($script:Svc.ContainsKey($n)) { return [pscustomobject]@{ Name = $n } }; return $null }
      if ($Class -eq 'Win32_UserProfile') { if ($script:ProfileExists) { return [pscustomobject]@{ SID = $legacySid; LocalPath = 'C:\Users\albera-cp' } }; return $null }
      $null }
    function Remove-CimInstance { param($InputObject) $script:Order.Add('remove profile ' + $InputObject.LocalPath); $script:ProfileExists = $false }
    function Get-AccountSid([string]$Account) { Get-DerivedServiceSid ($Account -replace '^NT SERVICE\\', '') }
    function Invoke-Sc([string]$Arguments) {
      $script:Order.Add('sc ' + $Arguments)
      $t = $Arguments -split ' '; $name = $t[1]
      switch ($t[0]) {
        'create' { $script:Svc[$name] = [ordered]@{ auto = ($Arguments -like '*start= delayed-auto*'); delayed = ($Arguments -like '*start= delayed-auto*'); sid = 'none'; privs = 'all'; failure = '' } }
        'config' { if ($Arguments -like '*start= delayed-auto*') { $script:Svc[$name].auto = $true; $script:Svc[$name].delayed = $true } }
        'sidtype' { $script:Svc[$name].sid = $t[2] }
        'privs' { $script:Svc[$name].privs = $t[2] }
        'failure' { $n = ([regex]::Matches($Arguments, 'restart/5000')).Count; $script:Svc[$name].failure = ((1..$n | ForEach-Object { 'RESTART -- Delay = 5000 milliseconds.' }) -join ' ') }
        'delete' { $script:Svc.Remove($name) }
        'sdshow' { return [pscustomobject]@{ Exit = 0; Out = (Get-BrokerServiceSddl $script:Sids.ControlPlane); Err = '' } }
      }
      [pscustomobject]@{ Exit = 0; Out = ''; Err = '' }
    }
    function Get-ServiceFactsFor([string]$Name) {
      if (-not $script:Svc.ContainsKey($Name)) { return [pscustomobject]@{ Exists = $false } }
      $s = $script:Svc[$Name]; $spec = Get-ServiceSpecs | Where-Object { $_.Name -eq $Name }
      [pscustomobject]@{ Exists = $true; StartName = "NT SERVICE\$Name"; PathName = (Get-ServiceCommandLine $spec.Exe $spec.Config); StartMode = $(if ($s.auto) { 'Auto' } else { 'Manual' }); DelayedAutoStart = $s.delayed; ServiceType = 'Own Process'
        SidTypeText = ('SERVICE_SID_TYPE:  ' + $s.sid.ToUpperInvariant()); PrivilegesText = $(if ($s.privs -eq 'SeChangeNotifyPrivilege') { 'PRIVILEGES : SeChangeNotifyPrivilege' } else { 'PRIVILEGES : SeImpersonatePrivilege SeChangeNotifyPrivilege' }); FailureText = $s.failure; State = 'Stopped' }
    }
    function Wait-ServiceState([string]$Name, [string[]]$States, [int]$Seconds) { $true }
    function Invoke-Native([string]$Exe, [string]$Arguments, [int]$TimeoutMs = 60000, [switch]$MinimalEnvironment) { $script:Order.Add('native ' + $Arguments); $out = if ($Arguments -like 'sdshow*') { Get-BrokerServiceSddl $script:Sids.ControlPlane } else { '' }; [pscustomobject]@{ Exit = 0; Out = $out; Err = '' } }
    function Read-AuthoritySigningKey([string]$KeyName, [string]$Scope = 'machine') { [pscustomobject]@{ report = [pscustomobject]@{ keyName = $KeyName; exportPolicy = 0; algorithm = 'ECDSA_P256'; keySize = 256; owner = 'S-1-5-32-544'; allowSids = @('S-1-5-18', 'S-1-5-32-544', (Get-DerivedServiceSid $K.AuthorityService)) }; spki = $spki } }
    function Get-LiveControlPlaneUser { if ($script:UserExists) { [pscustomobject]@{ Name = $K.ControlPlaneUser; Sid = $legacySid; Description = $K.ControlPlaneUserDescription; Enabled = $true } } else { $null } }
    function Remove-LocalUser { param($SID) $script:Order.Add('Remove-LocalUser ' + $SID.Value); $script:UserExists = $false }
    function Get-ProcessIdsOwnedBy([string]$Sid) { , @($script:Pids.ToArray()) }
    function End-ProcessById([int]$Id) { $script:Order.Add("stop pid $Id"); [void]$script:Pids.Remove($Id) }
    function Test-AuthoritySigningKeyExists([string]$KeyName, [string]$Scope = 'machine') { $script:KeyExists }
    function Remove-AuthoritySigningKey([string]$KeyName, [string]$Scope = 'machine') { $script:Order.Add('delete key'); $script:KeyExists = $false; $true }
    function New-AuthoritySigningKey([string]$KeyName, [string]$ServiceSid, [string]$Scope = 'machine') { $script:Order.Add('create key'); $script:KeyExists = $true; [pscustomobject]@{ spki = $spki; report = [pscustomobject]@{ exportPolicy = 0; allowSids = @('S-1-5-18', 'S-1-5-32-544', $ServiceSid) } } }
    function Test-LocalGroupExists([string]$GroupSid) { $true }
    function Get-LocalGroupMemberSids([string]$GroupSid) { , @($script:Members.ToArray()) }
    function Add-LocalGroupMember { param($SID, $Member) $script:Order.Add("group add $Member"); $script:Members.Add([string]$Member) }
    function Remove-LocalGroupMember { param($SID, $Member) $script:Order.Add("group remove $Member"); [void]$script:Members.Remove([string]$Member) }
    function New-TrustedDirectory([string]$Path, [string[]]$Grants, [string]$OwnerSid = 'S-1-5-32-544') { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
    function Set-HostAcl($Entry) { }
    function Get-AclSummary([string]$Path) { [pscustomobject]@{ Owner = 'S-1-5-32-544'; Protected = $true; AllowSids = @(); WriteSids = @() } }
    function Test-AclMatchesPlan($Entry, $Summary) { , @() }
    function Write-OneConfig([string]$Path, [string]$Text, [string[]]$Writers) { Write-Bytes $Path $Text }
    function Invoke-LaunchCheck { $script:Order.Add('launch-check'); [pscustomobject]@{ Exit = 0; Out = 'SERVICE_CONFIG=ok CPHOST_LAUNCH=ok' } }
    function Get-OwnerProfilePath([string]$Sid) { if ($Sid -ceq $ownerSid) { $script:FakeProfile } else { $null } }
    function Get-ElevatedSid { $ownerSid }
    function New-ShellLink($Spec) { Write-Bytes $Spec.Path (ConvertTo-Json -InputObject ([ordered]@{ TargetPath = $Spec.Target; Arguments = $Spec.Arguments; WorkingDirectory = $Spec.WorkingDirectory }) -Compress) }
    function Read-ShellLink([string]$Path) { if (-not (Test-Path -LiteralPath $Path)) { return $null }; $o = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json; [pscustomobject]@{ TargetPath = $o.TargetPath; Arguments = $o.Arguments; WorkingDirectory = $o.WorkingDirectory } }
    function Get-RunEntryValue { $script:RunValue }
    function Set-RunEntryValue { $script:RunValue = (Get-RunEntry $L).Command }
    function Remove-RunEntryValue { $script:RunValue = $null }

    # ---- a first-layout install on disk (record, configs, binaries) and the new builds in the working tree
    function New-LegacyInstall([bool]$Grant) {
      foreach ($p in @($L.DataRoot, $L.InstallRoot, $RepoRoot, (Join-Path $Work 'profile'))) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force } }
      $script:Svc = @{}; $script:Order.Clear(); $script:UserExists = $true; $script:ProfileExists = $true; $script:KeyExists = $true; $script:RunValue = $null
      $script:Pids = New-Object 'System.Collections.Generic.List[int]'; foreach ($i in @(4101, 4102)) { $script:Pids.Add($i) }
      $script:Members = New-Object 'System.Collections.Generic.List[string]'
      $script:Sids = $null; $script:ResolvedVm = $null; $script:LegacyValues = $null; $script:Approver = $null; $script:LocalTreeHash = $null
      $script:FakeProfile = Join-Path $Work 'profile'
      $script:ApproverKeyId = $null; $script:ApproverPublicKey = $null; $script:ApproverSid = $null; $script:GrantHyperVToBroker = $false; $script:VmName = 'default-vm'; $script:ComputerId = 'default'; $script:ProjectId = 'default'
      New-Item -ItemType Directory -Force -Path $L.DataRoot | Out-Null
      $legacyCp = $legacySid
      $brokerSid = Get-DerivedServiceSid $K.BrokerService
      $computers = if ($Grant) { Get-BrokerComputers 'clone-01' $guidA } else { $null }
      Write-Bytes $L.BrokerConfig (ConvertTo-HostJson (Get-BrokerConfig $L $legacyCp $spki $computers))
      $approver = [pscustomobject]@{ approverSid = $ownerSid; approverKeyId = 'hello-0123456789abcdef'; approverPublicKey = $labApproverKey }
      Write-Bytes $L.AuthorityConfig (ConvertTo-HostJson (Get-AuthorityConfig $legacyCp $approver))
      Write-Bytes $L.LegacyApprovalSettings (ConvertTo-HostJson (Get-ControlPlaneSettings $L 'legacy-project' 'legacy-vm-name' 'clone-01'))
      Write-Bytes $L.ControlPlaneJournal 'journal'
      foreach ($d in @($L.BrokerDbDir)) { Write-Bytes (Join-Path $d 'journal.sqlite') 'x' }
      $script:Manifest = New-Manifest
      $u = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $u['name'] = $K.ControlPlaneUser; $u['sid'] = $legacySid
      $key = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $key['name'] = $K.SigningKeyName
      $script:Manifest['created']['user'] = $u; $script:Manifest['created']['key'] = $key; $script:Manifest['created']['installRoot'] = $true
      $script:Manifest['created']['services'] = @($K.BrokerService, $K.AuthorityService)
      foreach ($n in @('broker', 'authority', 'pipe-client')) { $b = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $b['exeSha256'] = ('1' * 64); $b['treeSha256'] = ('2' * 64); $b['files'] = 1; $script:Manifest['created']['binaries'][$n] = $b }
      foreach ($d in @($L.BrokerBinDir, $L.AuthorityBinDir, $L.PipeClientBinDir)) { Write-Bytes (Join-Path $d 'old.dll') 'old' }
      Write-Bytes $L.SetupExe 'albera-setup.exe, put there by the owner'; Write-Bytes (Join-Path $L.InstallRoot 'setup-work\run1\x.txt') 'x'
      $script:Manifest['values']['authoritySpki'] = $spki; $script:Manifest['values']['approverSid'] = $ownerSid; $script:Manifest['values']['controlPlaneSid'] = $legacySid
      foreach ($n in @($K.BrokerService, $K.AuthorityService)) { $script:Svc[$n] = [ordered]@{ auto = $false; delayed = $false; sid = $(if ($Grant -and $n -eq $K.BrokerService) { 'unrestricted' } else { 'restricted' }); privs = 'SeChangeNotifyPrivilege'; failure = '' } }
      if ($Grant) {
        $g = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $g['group'] = 'S-1-5-32-578'; $g['sid'] = $brokerSid; $g['computerId'] = 'clone-01'; $g['vmId'] = $guidA
        $script:Manifest['created']['hyperVGrant'] = $g; $script:Members.Add($brokerSid)
      }
      $script:Manifest['state'] = 'complete'; Save-Manifest
      # the new builds (five publish folders) and the pins' sources
      foreach ($s in (Get-BuildSources)) { Write-Fixture $s.Dir $s.Exe }
      Write-Bytes (Join-Path $Work 'src-node\node.exe') 'fake node'; $script:NodeSource = Join-Path $Work 'src-node\node.exe'
      Write-Bytes (Join-Path $script:FakeProfile '.local\bin\claude.exe') 'fake claude'
    }
    $script:NodeSource = $null; $ClaudeSource = $null; $TrustLocalBuilds = $true; $ExpectedTreeHash = $null; $SetupRunId = $null; $StartCheck = $false
    $NodeSource = $null
    function Snapshot-Result {
      $m = $script:Manifest
      [ordered]@{
        layoutLegacy = (Test-LegacyLayout); state = $(if ($m) { $m['state'] } else { 'no manifest' }); services = @($script:Svc.Keys | Sort-Object); user = $script:UserExists; profile = $script:ProfileExists; key = $script:KeyExists; pids = @($script:Pids)
        members = @($script:Members); binaries = $(if ($m) { @($m['created']['binaries'].Keys | Sort-Object) } else { @() })
        createdKeys = $(if ($m) { @($m['created'].Keys | Sort-Object) } else { @() })
      }
    }
    function Index-Of([string]$Prefix) { $i = 0; foreach ($o in $script:Order) { if ($o.StartsWith($Prefix, [System.StringComparison]::Ordinal)) { return $i }; $i++ }; -1 }

    # ---- A. the preflight: with no Claude Code to pin, NOTHING is removed
    New-LegacyInstall $false
    Remove-Item -LiteralPath (Join-Path $script:FakeProfile '.local') -Recurse -Force
    $before = Snapshot-Result
    $result.preflight = [ordered]@{ error = (Try-Run { Invoke-Migrate }); orderIsEmpty = ($script:Order.Count -eq 0); order = @($script:Order); same = ((ConvertTo-Json -InputObject (Snapshot-Result) -Compress) -ceq (ConvertTo-Json -InputObject $before -Compress)); journalKept = (Test-Path -LiteralPath $L.ControlPlaneJournal); pidsKept = @($script:Pids) }
    # ... and the same with no builds in the working tree
    New-LegacyInstall $false
    Remove-Item -LiteralPath (Join-Path $RepoRoot 'src\runtime\windows-approver') -Recurse -Force
    $result.preflightNoBuild = [ordered]@{ error = (Try-Run { Invoke-Migrate }); orderIsEmpty = ($script:Order.Count -eq 0) }
    New-LegacyInstall $false
    $TrustLocalBuilds = $false
    $result.preflightNoHash = [ordered]@{ error = (Try-Run { Invoke-Migrate }); orderIsEmpty = ($script:Order.Count -eq 0) }
    $TrustLocalBuilds = $true
    # an install record that is not complete, and one that is not a first-layout record, are refused / ignored
    New-LegacyInstall $false; $script:Manifest['state'] = 'partial'; Save-Manifest
    $result.partial = [ordered]@{ error = (Try-Run { Invoke-Migrate }); orderIsEmpty = ($script:Order.Count -eq 0) }
    New-LegacyInstall $false; $script:Manifest['created'].Remove('user') | Out-Null; Save-Manifest
    $result.notLegacy = [ordered]@{ exit = (Invoke-Migrate 6>&1 | Select-Object -Last 1); orderIsEmpty = ($script:Order.Count -eq 0) }
    $script:Manifest = $null
    $result.noRecord = [ordered]@{ exit = (Invoke-Migrate 6>&1 | Select-Object -Last 1); orderIsEmpty = ($script:Order.Count -eq 0) }
    # a configs file that someone changed (Authority config no longer valid) refuses the read, nothing is removed
    New-LegacyInstall $false
    Write-Bytes $L.AuthorityConfig ((ConvertTo-HostJson (Get-AuthorityConfig $legacySid ([pscustomobject]@{ approverSid = $ownerSid; approverKeyId = 'hello-0123456789abcdef'; approverPublicKey = $labApproverKey }))) -replace '"audience":"[^"]*"', '"audience":"Bad"')
    $result.badConfig = [ordered]@{ error = (Try-Run { Invoke-Migrate }); orderIsEmpty = ($script:Order.Count -eq 0) }

    # ---- B. a migration without the Hyper-V grant
    New-LegacyInstall $false
    $plainSteps = @(Get-MigrateLeadSteps | ForEach-Object { $_.Id })
    $result.leadIds = $plainSteps
    $result.planBefore = @(Get-MigrateLeadSteps | ForEach-Object { try { & $_.Test } catch { 'error: ' + $_.Exception.Message } })
    $result.runError = Try-Run { $script:Exit = Invoke-Migrate }
    $result.exit = $script:Exit
    $result.after = Snapshot-Result
    $result.order = @($script:Order)
    $result.stopBeforeUninstall = (((Index-Of 'stop pid 4101') -ge 0) -and ((Index-Of 'stop pid 4101') -lt (Index-Of 'sc delete')) -and ((Index-Of 'stop pid 4102') -lt (Index-Of 'Remove-LocalUser')))
    $result.carried = [ordered]@{
      authority = (Read-Json $L.AuthorityConfig)
      settings = (Read-Json $L.ApprovalSettings)
      brokerHasComputers = ([bool]((Read-Json $L.BrokerConfig).PSObject.Properties['computers']))
      brokerCp = (Read-Json $L.BrokerConfig).controlPlaneSid
      authorityCp = (Read-Json $L.AuthorityConfig).controlPlaneSid
      service = (Read-Json $L.ControlPlaneConfig)
    }
    $result.gone = [ordered]@{ legacySettings = (-not (Test-Path -LiteralPath $L.LegacyApprovalSettings)); oldDll = (-not (Test-Path -LiteralPath (Join-Path $L.BrokerBinDir 'old.dll'))); journal = (-not (Test-Path -LiteralPath $L.ControlPlaneJournal)); oldBrokerDb = (-not (Test-Path -LiteralPath (Join-Path $L.BrokerDbDir 'journal.sqlite'))) }
    $result.kept = [ordered]@{ setupExe = (Test-Path -LiteralPath $L.SetupExe); setupWork = (Test-Path -LiteralPath (Join-Path $L.InstallRoot 'setup-work\run1\x.txt')); manifestOnDisk = (Test-Path -LiteralPath $L.ManifestPath) }
    $result.newFiles = [ordered]@{ node = (Test-Path -LiteralPath $L.ControlPlaneNodeExe); claude = (Test-Path -LiteralPath $L.ClaudeExe); open = (Test-Path -LiteralPath $L.OpenScript); config = (Test-Path -LiteralPath $L.ControlPlaneConfig); secrets = (Test-Path -LiteralPath $L.SecretsDir); ui = (Test-Path -LiteralPath $L.UiDir); logs = (Test-Path -LiteralPath $L.ControlPlaneLogDir) }
    $result.record = [ordered]@{ keys = @((Read-Manifest)['created'].Keys | Sort-Object); services = @((Read-Manifest)['created']['services']); hasGrant = (Test-ManifestHas 'hyperVGrant'); approverSid = (Read-Manifest)['values']['approverSid']; approverKeyId = (Read-Manifest)['values']['approverKeyId']; setupRunId = (Read-Manifest).ContainsKey('setupRunId') }
    $result.statusAfter = @((Get-StatusLines) | Where-Object { $_.State -ne 'ok' } | ForEach-Object { $_.State + ' ' + $_.Text })
    $result.migrateAgain = [ordered]@{ exit = (Invoke-Migrate 6>&1 | Select-Object -Last 1) }

    # ---- C. a migration WITH the Hyper-V grant: the Broker's SID leaves the group first, the same VM GUID comes back, the Broker config keeps its one computer
    New-LegacyInstall $true
    $brokerSid = Get-DerivedServiceSid $K.BrokerService
    $result.grantRunError = Try-Run { $script:Exit2 = Invoke-Migrate }
    $result.grantExit = $script:Exit2
    $result.grantOrder = @($script:Order)
    $result.grantAfter = Snapshot-Result
    $result.grant = [ordered]@{
      removeBeforeDelete = ((Index-Of "group remove $brokerSid") -ge 0) -and ((Index-Of "group remove $brokerSid") -lt (Index-Of 'sc delete'))
      addedBack = ((Index-Of "group add $brokerSid") -gt (Index-Of 'sc delete'))
      broker = (Read-Json $L.BrokerConfig).computers
      desktop = (Read-Json $L.ApprovalSettings).desktop
      settingsComputers = (Read-Json $L.ApprovalSettings).computers
      sidTypeBroker = $script:Svc[$K.BrokerService].sid
      sidTypeAuthority = $script:Svc[$K.AuthorityService].sid
      sidTypeCp = $script:Svc[$K.ControlPlaneService].sid
      recordGrant = (Read-Manifest)['created']['hyperVGrant']
      members = @($script:Members)
    }
    # a process that cannot be stopped stops the run before anything is uninstalled
    New-LegacyInstall $false
    function End-ProcessById([int]$Id) { throw 'access denied (fake)' }
    $result.stuck = [ordered]@{ error = (Try-Run { Invoke-Migrate }); removedNothing = ((Index-Of 'sc ') -eq -1) -and $script:UserExists -and ((Index-Of 'Remove-LocalUser') -eq -1); pids = @($script:Pids) }
  }
}
($result | ConvertTo-Json -Compress -Depth 6)
