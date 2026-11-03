# Test harness (Windows PowerShell 5.1, ASCII only, no admin): runs the system-touching helper functions of scripts/host/albera-host.ps1 against a TEMP folder.
# The functions are taken out of the real script by name (PowerShell AST), so the code under test is the shipped code, not a copy. Nothing outside -Work is touched:
# no service, account, key or Program Files folder is involved (those need an elevated console and the VM lab). The temp folders are owned by the current (non-admin) user, which is
# exactly what a planted folder looks like to the installer.
#   function-harness.ps1 -Case <copy|remove|trust|secured|secure|hyperv|group> -Work <empty temp folder>     prints one JSON line
param(
  [Parameter(Mandatory = $true)][ValidateSet('copy', 'remove', 'trust', 'secured', 'secure', 'hyperv', 'group')][string]$Case,
  [Parameter(Mandatory = $true)][string]$Work
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $repo 'scripts\host\albera-host-lib.ps1')
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts\host\albera-host.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'albera-host.ps1 does not parse' }
$wanted = @('Say', 'Get-Sha256File', 'Test-HasReparsePoint', 'Get-TreeEntries', 'Get-TreeHashes', 'Get-BuildSources', 'Get-SourceFiles', 'Get-ExpectedTreeHashState', 'Get-ComponentHashes', 'Set-BinaryRecord', 'Copy-HostBinaries', 'Remove-HostTree', 'New-TrustedDirectory',
  'Test-ManifestHas', 'New-Manifest', 'Save-Manifest', 'Read-Manifest', 'Initialize-Manifest', 'Assert-PlannedPathTrusted', 'Test-SecureStringEqual',
  'Get-InstallSteps', 'Get-UninstallSteps', 'Resolve-HostSids', 'Get-VmCandidates', 'Resolve-BrokerVm', 'Get-HyperVVmStep', 'Get-HyperVGrantStep', 'Get-HyperVRevokeStep', 'Grant-BrokerHyperV', 'Revoke-BrokerHyperV', 'Show-Plan', 'Test-Elevated',
  'Test-LocalGroupExists', 'Get-HyperVMemberProblems', 'Get-ServiceSpecs', 'New-HostServices', 'Get-StatusLines', 'Remove-HostServices', 'Wait-ServiceState')
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
      [pscustomobject]@{ Exists = $true; StartName = "NT SERVICE\$Name"; PathName = (Get-ServiceCommandLine $spec.Exe $spec.Config); StartMode = 'Manual'; ServiceType = 'Own Process'
        SidTypeText = ('SERVICE_SID_TYPE:  ' + $script:Svc[$Name].ToUpperInvariant()); PrivilegesText = 'SeChangeNotifyPrivilege'; State = 'Stopped' }
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
  'group' {
    # The real Test-LocalGroupExists (nothing faked, read only): a group that exists, a SID that maps to nothing, and a failure that is neither.
    $result.administrators = Test-LocalGroupExists 'S-1-5-32-544'
    $result.unmapped = Test-LocalGroupExists 'S-1-5-32-99999'
    $result.malformed = Try-Run { Test-LocalGroupExists 'not-a-sid' }
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
