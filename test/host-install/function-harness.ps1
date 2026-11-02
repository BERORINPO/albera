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
$wanted = @('Say', 'Get-Sha256File', 'Test-HasReparsePoint', 'Get-TreeHashes', 'ConvertTo-HashMap', 'Get-BuildSources', 'Get-SourceFiles', 'Get-ExpectedHashesState', 'Copy-HostBinaries', 'Remove-HostTree',
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
$script:ExpectedState = $null
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
  $map = @{}
  foreach ($s in (Get-BuildSources)) { $h = @{}; foreach ($f in (Get-TreeHashes $s.Dir).Files) { $h[$f.Rel.Replace('\', '/')] = $f.Sha }; $map[$s.Name] = $h }
  $script:ExpectedState = [pscustomobject]@{ Ok = $true; Reason = ''; Map = $map }
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
    Set-Expected
    $result.firstRunError = Try-Run { Copy-HostBinaries }
    $result.recorded = @($script:Manifest['created']['binaries'].Keys | Sort-Object)
    $result.destFiles = @(Get-ChildItem -LiteralPath $L.BinRoot -Recurse -File | ForEach-Object { $_.FullName.Substring($L.BinRoot.Length + 1) } | Sort-Object)
    $result.noPartialLeft = (@(Get-ChildItem -LiteralPath $L.BinRoot -Directory | Where-Object { $_.Name -like '*.partial' }).Count -eq 0)
    $src = Get-BuildSources | Select-Object -First 1
    $result.treeEqual = ((Get-TreeHashes $src.Dir).Tree -eq (Get-TreeHashes $src.Dest).Tree) -and ((Get-TreeHashes $src.Dest).Tree -eq $script:Manifest['created']['binaries'][$src.Name]['treeSha256'])
    $result.exeShaRecorded = ($script:Manifest['created']['binaries'][$src.Name]['exeSha256'] -eq (Get-Sha256File (Join-Path $src.Dest $src.Exe)))
    $before = (Get-Item -LiteralPath (Join-Path $src.Dest $src.Exe)).LastWriteTimeUtc.Ticks
    $result.secondRunError = Try-Run { Copy-HostBinaries }
    $result.secondRunUntouched = ($before -eq (Get-Item -LiteralPath (Join-Path $src.Dest $src.Exe)).LastWriteTimeUtc.Ticks)
    # a changed installed copy is refused
    [System.IO.File]::WriteAllText((Join-Path $src.Dest 'runtime.dll'), 'tampered')
    $result.tamperedError = Try-Run { Copy-HostBinaries }
    # --- the build in the working tree is replaced after the owner got the reviewed hashes: the copy must be refused and deleted
    Remove-Item -LiteralPath $L.BinRoot -Recurse -Force
    $script:Manifest['created']['binaries'].Clear()
    [System.IO.File]::WriteAllText((Join-Path $src.Dir 'runtime.dll'), 'a different dll, written by an agent')
    $result.replacedBuildError = Try-Run { Copy-HostBinaries }
    $result.replacedBuildNothingLeft = -not (Test-Path -LiteralPath $src.Dest) -and -not (Test-Path -LiteralPath ($src.Dest + '.partial'))
    $result.replacedBuildNotRecorded = -not $script:Manifest['created']['binaries'].ContainsKey($src.Name)
    # an extra file and a missing file are refused too
    [System.IO.File]::WriteAllText((Join-Path $src.Dir 'runtime.dll'), 'dll bytes')
    [System.IO.File]::WriteAllText((Join-Path $src.Dir 'planted.dll'), 'extra')
    $result.extraFileError = Try-Run { Copy-HostBinaries }
    Remove-Item -LiteralPath (Join-Path $src.Dir 'planted.dll')
    Remove-Item -LiteralPath (Join-Path $src.Dir 'sub\data.json')
    $result.missingFileError = Try-Run { Copy-HostBinaries }
    [System.IO.File]::WriteAllText((Join-Path $src.Dir 'sub\data.json'), '{"a":1}')
    # a link inside the publish folder is refused before anything is copied
    $linkTarget = Join-Path $Work 'elsewhere'; [System.IO.File]::WriteAllText((Join-Path (New-Item -ItemType Directory -Force -Path $linkTarget).FullName 'secret.txt'), 'x')
    New-Junction (Join-Path $src.Dir 'link') $linkTarget
    $result.junctionInSourceError = Try-Run { Copy-HostBinaries }
    Remove-Junction (Join-Path $src.Dir 'link')
    $result.junctionTargetIntact = Test-Path -LiteralPath (Join-Path $linkTarget 'secret.txt')
    # the clean build copies again, a leftover .partial from a failed run is replaced, and the manifest on disk round-trips
    $result.cleanAgainError = Try-Run { Copy-HostBinaries }
    $result.recordedAgain = @($script:Manifest['created']['binaries'].Keys | Sort-Object)
    $second = Get-BuildSources | Select-Object -Skip 1 -First 1
    Remove-Item -LiteralPath $second.Dest -Recurse -Force
    $script:Manifest['created']['binaries'].Remove($second.Name) | Out-Null
    New-Item -ItemType Directory -Force -Path ($second.Dest + '.partial') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path ($second.Dest + '.partial') 'stale.txt'), 'stale')
    $result.afterPartialError = Try-Run { Copy-HostBinaries }
    $result.staleGone = -not (Test-Path -LiteralPath (Join-Path $second.Dest 'stale.txt'))
    $result.secondCopied = Test-Path -LiteralPath (Join-Path $second.Dest $second.Exe)
    $reread = Read-Manifest
    $result.manifestReread = @($reread['created']['binaries'].Keys | Sort-Object)
    # without a usable -ExpectedHashes nothing is copied
    $script:ExpectedState = $null; $ExpectedHashes = $null
    Remove-Item -LiteralPath $L.BinRoot -Recurse -Force
    $script:Manifest['created']['binaries'].Clear()
    $result.noHashesError = Try-Run { Copy-HostBinaries }
    $result.noHashesNothingCopied = -not (Test-Path -LiteralPath $L.BinRoot)
    # the hashes file inside the repository tree is refused, one outside is read
    $inside = Join-Path $RepoRoot 'hashes.json'; [System.IO.File]::WriteAllText($inside, '{}')
    $ExpectedHashes = $inside; $script:ExpectedState = $null
    $result.hashesInRepo = (Get-ExpectedHashesState).Reason
    $outside = Join-Path $Work 'hashes-outside.json'; [System.IO.File]::WriteAllText($outside, '{"version":1}')
    $ExpectedHashes = $outside; $script:ExpectedState = $null
    $result.hashesBadShape = (Get-ExpectedHashesState).Reason
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
    $sids = @{ Broker = (Get-DerivedServiceSid $K.BrokerService); Authority = (Get-DerivedServiceSid $K.AuthorityService); ControlPlane = 'S-1-5-21-1111111111-2222222222-3333333333-1500' }
    $plan = @(Get-AclPlan $L $sids)
    # 1. an attacker (the current non-admin user) plants C:\ProgramData\Albera with a well-formed manifest. install / uninstall refuse it; plan / status ignore it and say why.
    New-Item -ItemType Directory -Force -Path $L.DataRoot | Out-Null
    [System.IO.File]::WriteAllText($L.ManifestPath, ((New-Manifest) | ConvertTo-Json -Depth 8 -Compress))
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
