# Test harness (Windows PowerShell 5.1, ASCII only, no admin): runs the system-touching helper functions of scripts/host/albera-host.ps1 against a TEMP folder.
# The functions are taken out of the real script by name (PowerShell AST), so the code under test is the shipped code, not a copy. Nothing outside -Work is touched:
# no service, account, key or Program Files folder is involved (those need an elevated console and the VM lab). The temp folders are owned by the current (non-admin) user, which is
# exactly what a planted folder looks like to the installer.
#   function-harness.ps1 -Case <copy|hashes|remove|trust|secured|secure> -Work <empty temp folder>     prints one JSON line
param(
  [Parameter(Mandatory = $true)][ValidateSet('copy', 'remove', 'trust', 'secured', 'secure')][string]$Case,
  [Parameter(Mandatory = $true)][string]$Work
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $repo 'scripts\host\albera-host-lib.ps1')
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts\host\albera-host.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'albera-host.ps1 does not parse' }
$wanted = @('Say', 'Get-Sha256File', 'Test-HasReparsePoint', 'Get-TreeEntries', 'Get-TreeHashes', 'Get-BuildSources', 'Get-SourceFiles', 'Get-ExpectedTreeHashState', 'Get-ComponentHashes', 'Set-BinaryRecord', 'Copy-HostBinaries', 'Remove-HostTree', 'New-TrustedDirectory',
  'Test-ManifestHas', 'New-Manifest', 'Save-Manifest', 'Read-Manifest', 'Initialize-Manifest', 'Assert-PlannedPathTrusted', 'Test-SecureStringEqual')
$found = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $wanted -contains $n.Name }, $false))
if ($found.Count -ne $wanted.Count) { throw ('expected ' + $wanted.Count + ' functions, found ' + $found.Count) }
foreach ($f in $found) { Invoke-Expression $f.Extent.Text }
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
    # 4. the install tree: only the three build folders
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
