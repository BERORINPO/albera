# Test harness (Windows PowerShell 5.1, ASCII only, no admin): the WSL2 part of scripts/host/albera-host.ps1 (-AddWsl2Computer) run against a TEMP layout with FAKES for the machine: the CNG key store, the registry,
# the ACL writes, the trust checks and the bridge program. The functions are taken out of the real script by AST (EVERY function), so the code under test is the shipped code. Nothing outside -Work is touched:
# no key, account, service, task, ACL, registry value or Program Files folder, and no program is started. Prints one JSON line.
#   wsl2-harness.ps1 -Case <steps|inputs|install|uninstall> -Work <empty temp folder> -Spki <P-256 SPKI base64> -OtherSpki <another> -Rsa <RSA-2048 SPKI base64>
param(
  [Parameter(Mandatory = $true)][ValidateSet('steps', 'inputs', 'install', 'uninstall')][string]$Case,
  [Parameter(Mandatory = $true)][string]$Work,
  [Parameter(Mandatory = $true)][string]$Spki,
  [Parameter(Mandatory = $true)][string]$OtherSpki,
  [Parameter(Mandatory = $true)][string]$Rsa
)
$ErrorActionPreference = 'Stop'
trap { [Console]::Error.WriteLine($_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage); exit 1 }
$Work = [System.IO.Path]::GetFullPath($Work)
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $repo 'scripts\host\albera-host-lib.ps1')
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts\host\albera-host.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'albera-host.ps1 does not parse' }
$found = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false))
if ($found.Count -lt 100) { throw ('expected the whole script, found only ' + $found.Count + ' functions') }
foreach ($f in $found) { Invoke-Expression $f.Extent.Text }
function Stop-Refused([string]$Why, [int]$Code = 3) { throw "REFUSED: $Why" }

Add-Type -AssemblyName System.Web.Extensions
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$K = Get-HostConstants
$C2 = Get-Wsl2Constants
$RepoRoot = Join-Path $Work 'repo'
$L = Get-HostLayout (Join-Path $Work 'pf') (Join-Path $Work 'pd')
$W = Get-Wsl2Layout $L
$Mode = 'install'; $PlanFor = 'install'
$script:ManifestNote = $null; $script:Manifest = $null; $script:Approver = $null; $script:Sids = $null
$ApproverSid = $null; $ApproverKeyId = $null; $ApproverPublicKey = $null; $ApproverKeyFile = @(); $ExpectedApproverKeyId = $null; $Replace = $false; $LabAssumeYes = $false
$ExpectedTreeHash = $null; $VmName = 'albera-clone-01'; $ComputerId = 'clone-01'; $ProjectId = 'albera-host'; $StartCheck = $false; $GrantHyperVToBroker = $false; $VmId = $null; $SetupRunId = $null; $TrustLocalBuilds = $false
$NodeSource = $null; $ClaudeSource = $null
$SystemDirectory = [Environment]::SystemDirectory; $ProgramFilesDir = Join-Path $Work 'pf'; $ProgramDataDir = Join-Path $Work 'pd'
$ScExe = Join-Path $SystemDirectory 'sc.exe'; $IcaclsExe = Join-Path $SystemDirectory 'icacls.exe'
$AddWsl2Computer = $false; $Wsl2ComputerId = ''; $Wsl2RepositoryId = ''; $Wsl2RepositoryPath = ''; $Wsl2Image = ''; $Wsl2ImageSha256 = ''; $Wsl2BridgeTreeHash = ''; $Wsl2FloorExpiresAt = ''; $Wsl2GitPath = ''; $Wsl2FirstStartWord = ''
$OWNER = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
$H = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
function Hex([byte[]]$bytes) { ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant() }
function FileSha([string]$path) { $sha = [System.Security.Cryptography.SHA256]::Create(); try { Hex ($sha.ComputeHash([System.IO.File]::ReadAllBytes($path))) } finally { $sha.Dispose() } }
function Write-Text([string]$Path, [string]$Text) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null; [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false))) }
function Try-Run([scriptblock]$Block) { try { & $Block | Out-Null; $null } catch { $_.Exception.Message } }
function Json([string]$text) { $text | ConvertFrom-Json }

# ---------------------------------------------------------------------------------------------- the fake machine
$script:Keys = @{}
$script:KeyCalls = New-Object System.Collections.Generic.List[object]
$script:Deleted = New-Object System.Collections.Generic.List[string]
$script:Dacls = @{}
$script:RunValue = $null
$script:SaveCount = 0
$script:DaclLog = New-Object System.Collections.Generic.List[object]
function Resolve-HostSids { $script:Sids = @{ Broker = (Get-DerivedServiceSid $K.BrokerService); Authority = (Get-DerivedServiceSid $K.AuthorityService); ControlPlane = (Get-DerivedServiceSid $K.ControlPlaneService); Approver = $OWNER; Legacy = $false } }
function Save-Manifest { $script:SaveCount++ }
function Test-AuthoritySigningKeyExists([string]$KeyName, [string]$Scope = 'machine') { $script:Keys.ContainsKey($KeyName) }
function New-FakeKey([string]$Name, [string]$Sid, [string]$PublicKey) {
  $script:Keys[$Name] = @{ spki = $PublicKey; report = [pscustomobject]@{ keyName = $Name; scope = 'machine'; exportPolicy = 0; algorithm = 'ECDSA_P256'; keySize = 256; owner = 'S-1-5-32-544'; allowSids = @('S-1-5-18', 'S-1-5-32-544', $Sid) } }
}
function New-AuthoritySigningKey([string]$KeyName, [string]$ServiceSid, [string]$Scope = 'machine') {
  $script:KeyCalls.Add([pscustomobject]@{ name = $KeyName; sid = $ServiceSid; scope = $Scope })
  if ($script:Keys.ContainsKey($KeyName)) { throw 'key_already_exists' }
  New-FakeKey $KeyName $ServiceSid $Spki
  [pscustomobject]@{ spki = $Spki; report = $script:Keys[$KeyName].report }
}
function Remove-AuthoritySigningKey([string]$KeyName, [string]$Scope = 'machine') { if (-not $script:Keys.ContainsKey($KeyName)) { return $false }; $script:Keys.Remove($KeyName); $script:Deleted.Add($KeyName); $true }
function Read-AuthoritySigningKey([string]$KeyName, [string]$Scope = 'machine') { if (-not $script:Keys.ContainsKey($KeyName)) { return $null }; [pscustomobject]@{ report = $script:Keys[$KeyName].report; spki = $script:Keys[$KeyName].spki } }
function Get-DesktopHelperSha256 { $H }
function Write-OneConfig([string]$Path, [string]$Text, [string[]]$Writers) { Write-Text $Path $Text }
function Get-PathTrustReasons([string]$Path, [string[]]$AllowedWriters, [bool]$RequireProtected) { , @() }
function New-TrustedDirectory([string]$Path, [string[]]$Grants, [string]$OwnerSid = 'S-1-5-32-544') { New-Item -ItemType Directory -Force -Path $Path | Out-Null; $script:Dacls[$Path] = @($Grants) }
function Set-HostAcl($Entry) { $script:Dacls[$Entry.Path] = @($Entry.Grants) }
function Set-HostDacl([string]$Path, [string[]]$Grants) { $script:Dacls[$Path] = @($Grants); $script:DaclLog.Add([pscustomobject]@{ path = $Path; grants = @($Grants); existed = (Test-Path -LiteralPath $Path); hadFiles = (@(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue).Count -gt 0) }) }
function Get-AclSummary([string]$Path) {
  $grants = @($script:Dacls[$Path])
  $sids = @($grants | ForEach-Object { if ($_ -match '^\*(S-[0-9-]+):') { $Matches[1] } })
  $writers = @($grants | ForEach-Object { if ($_ -match '^\*(S-[0-9-]+):(?:\(OI\)\(CI\))?(?:M|F)$') { $Matches[1] } })
  [pscustomobject]@{ Owner = 'S-1-5-32-544'; Protected = $true; AllowSids = @($sids | Sort-Object -Unique); WriteSids = @($writers | Sort-Object -Unique) }
}
function Invoke-Native([string]$Exe, [string]$Arguments, [int]$TimeoutMs = 60000, [switch]$MinimalEnvironment) { throw "unexpected native call: $Exe $Arguments" }
function Get-Wsl2RunValue { $script:RunValue }
function Set-Wsl2RunValue { $script:RunValue = (Get-Wsl2RunEntry $W).Command }
function Remove-Wsl2RunValue { $script:RunValue = $null }

function New-Rec([hashtable]$Values) { $d = New-Object 'System.Collections.Generic.Dictionary[string,object]'; foreach ($k in $Values.Keys) { $d[$k] = $Values[$k] }; $d }
function Set-BaseManifest {
  $script:Manifest = New-Manifest
  $script:Manifest['created']['services'] = @($K.BrokerService, $K.AuthorityService)
  $script:Manifest['created']['installRoot'] = $true
  $script:Manifest['created']['controlPlane'] = New-Rec @{ nodeSha256 = $H }
  $script:Manifest['created']['claude'] = New-Rec @{ sha256 = $H; fileVersion = '2.1.0' }
  $script:Manifest['values']['authoritySpki'] = $OtherSpki
  $script:Approver = [pscustomobject]@{ approverSid = $OWNER; approverKeyId = 'hello-0123456789abcdef'; approverPublicKey = $Rsa }
}
function Set-Wsl2Options {
  $script:Fixture = Join-Path $Work 'fixture'
  $publish = Get-Wsl2PublishDir
  New-Item -ItemType Directory -Force -Path (Join-Path $publish 'sub') | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $publish 'albera-wsl-bridge.exe'), 'bridge exe bytes')
  [System.IO.File]::WriteAllText((Join-Path $publish 'runtime.dll'), 'dll bytes')
  [System.IO.File]::WriteAllText((Join-Path $publish 'sub\data.json'), '{"a":1}')
  # the expected hashes are made here with .NET alone (not with the lib's functions), the same canonical lines
  $lines = foreach ($rel in @('albera-wsl-bridge.exe', 'runtime.dll', 'sub/data.json')) { $rel + "`t" + (FileSha (Join-Path $publish ($rel -replace '/', '\'))) + "`n" }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $script:ExpectedBridgeTree = Hex ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(($lines -join ''))))
  $image = Join-Path $script:Fixture 'image\albera-wsl2.tar'
  Write-Text $image 'image bytes of the guest'
  $script:ExpectedImageSha = FileSha $image
  $repoDir = Join-Path $script:Fixture 'repo'; New-Item -ItemType Directory -Force -Path $repoDir | Out-Null
  $script:AddWsl2Computer = $true
  $script:Wsl2RepositoryId = 'repo-main'; $script:Wsl2RepositoryPath = $repoDir; $script:Wsl2Image = $image; $script:Wsl2ImageSha256 = $script:ExpectedImageSha
  $script:Wsl2BridgeTreeHash = $script:ExpectedBridgeTree; $script:Wsl2FloorExpiresAt = [string]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 2592000)
  $script:RepositoryPath = $repoDir
}
function Set-Folders { foreach ($d in @($L.DataRoot, $L.BrokerConfigDir, $L.AuthorityDir, $L.ControlPlaneConfigDir, (Join-Path $L.InstallRoot 'bin'))) { New-Item -ItemType Directory -Force -Path $d | Out-Null } }
function Get-Ids($steps) { @($steps | ForEach-Object { $_.Id }) }
$r = [ordered]@{}

switch ($Case) {
  'steps' {
    Set-BaseManifest
    $script:Manifest = $null
    $r.installPlain = Get-Ids (Get-InstallSteps)
    $AddWsl2Computer = $true
    $r.installWsl2 = Get-Ids (Get-InstallSteps)
    $GrantHyperVToBroker = $true
    $r.installBoth = Get-Ids (Get-InstallSteps)
    $r.hyperVVmId = (Get-HyperVVmStep).Id
    $AddWsl2Computer = $false; $GrantHyperVToBroker = $false
    $r.uninstallPlain = Get-Ids (Get-UninstallSteps)
    Set-BaseManifest
    $script:Manifest['created']['wsl2'] = New-Rec @{ computerId = 'wsl-01'; repositoryId = 'repo-main'; keyName = $C2.AttestationKeyName; keyId = $C2.AttestationKeyId }
    $r.uninstallWsl2 = Get-Ids (Get-UninstallSteps)
    $r.dataFolders = @(Get-DataFolders)
    $r.wslDataDir = $W.DataDir
  }
  'inputs' {
    $Wsl2ComputerId = 'wsl-07'; $Wsl2RepositoryId = 'repo-x'; $Wsl2FloorExpiresAt = '1900000000'
    $o = Get-Wsl2Inputs; $r.fromOptions = $o
    $Wsl2ComputerId = ''; $Wsl2RepositoryId = ''; $Wsl2FloorExpiresAt = ''
    $r.defaults = Get-Wsl2Inputs
    Set-BaseManifest
    $script:Manifest['created']['wsl2'] = New-Rec @{ computerId = 'wsl-09'; repositoryId = 'repo-rec'; keyName = $C2.AttestationKeyName; keyId = $C2.AttestationKeyId; gitPath = 'C:\Program Files\Git\mingw64\bin\git.exe'; imageSha256 = $H }
    $r.fromRecord = Get-Wsl2Inputs
    $Wsl2FloorExpiresAt = 'soon'
    $r.floorNotNumber = (Get-Wsl2Inputs).FloorExpiresAt
  }
  'install' {
    Set-Folders; Set-BaseManifest; Set-Wsl2Options
    $brokerSid = Get-DerivedServiceSid $K.BrokerService
    $r.brokerSid = $brokerSid; $r.controlPlaneSid = Get-DerivedServiceSid $K.ControlPlaneService; $r.repositoryPath = $script:RepositoryPath
    $r.expectedBridgeTree = $script:ExpectedBridgeTree; $r.expectedImageSha = $script:ExpectedImageSha
    # ---- the key step: a key of that name that this script did not make is never adopted
    $keyStep = Get-Wsl2KeyStep
    New-FakeKey $C2.AttestationKeyName $brokerSid $OtherSpki
    $r.keyStepBlockedWhenForeignKeyExists = & $keyStep.Test
    [void]$script:Keys.Remove($C2.AttestationKeyName)
    $r.keyStepTodo = & $keyStep.Test
    [void](& $keyStep.Do)
    $r.keyStepDone = & $keyStep.Test
    $r.createdKeyArgs = $script:KeyCalls[0]
    $r.record = $script:Manifest['created']['wsl2']
    $r.valuesSpki = $script:Manifest['values']['attestationSpki']
    # ---- the configs: written by the shipped Write-HostConfigs, then judged
    $before = if ((Get-Wsl2ConfigProblems).Count -gt 0) { 'todo' } else { 'done' }
    Write-HostConfigs
    $r.configsStepBefore = $before
    $r.configsStepAfter = if ((Get-Wsl2ConfigProblems).Count -gt 0) { 'todo' } else { 'done' }
    $r.brokerConfig = Json ([System.IO.File]::ReadAllText($L.BrokerConfig))
    $r.authorityConfig = Json ([System.IO.File]::ReadAllText($L.AuthorityConfig))
    $r.settingsText = [System.IO.File]::ReadAllText($L.ApprovalSettings)
    $good = [System.IO.File]::ReadAllText($L.AuthorityConfig)
    $o = Json $good; $o.PSObject.Properties.Remove('attestationPublicKey'); $o.PSObject.Properties.Remove('attestationKeyId')
    [System.IO.File]::WriteAllText($L.AuthorityConfig, ($o | ConvertTo-Json -Compress))
    $r.configsStepAfterTamper = if ((Get-Wsl2ConfigProblems).Count -gt 0) { 'todo' } else { 'done' }
    [System.IO.File]::WriteAllText($L.AuthorityConfig, $good)
    # ---- the folders
    $foldersStep = Get-Wsl2FoldersStep; $filesStep = Get-Wsl2FilesStep
    $r.foldersStepBefore = & $foldersStep.Test
    $r.filesStepBefore = & $filesStep.Test
    [void](& $foldersStep.Do)
    $r.foldersStepAfter = & $foldersStep.Test
    # ---- the copies are refused when they do not hash to what was typed (nothing is left behind)
    $goodTree = $script:Wsl2BridgeTreeHash
    $script:Wsl2BridgeTreeHash = 'f' * 64
    $r.wrongTreeHashError = Try-Run { Copy-Wsl2Parts }
    $r.partialLeftAfterWrongTree = (Test-Path -LiteralPath ($W.BinDir + '.partial')) -or (Test-Path -LiteralPath $W.BinDir)
    $script:Wsl2BridgeTreeHash = $goodTree
    $goodImage = $script:Wsl2ImageSha256
    $script:Wsl2ImageSha256 = 'e' * 64
    $r.wrongImageError = Try-Run { Copy-Wsl2Parts }
    $r.imageLeftAfterWrong = Test-Path -LiteralPath $W.Image
    $script:Wsl2ImageSha256 = $goodImage
    if (Test-Path -LiteralPath $W.BinDir) { Remove-TreeNoFollow $W.BinDir }
    # ---- the real copy
    [void](& $filesStep.Do)
    $rec = $script:Manifest['created']['wsl2']
    $r.bridgeTree = Get-Wsl2TreeOf $W.BinDir
    $r.bridgeRecord = $rec
    $r.imageRecord = $rec['imageSha256']
    $r.floorFileText = [System.IO.File]::ReadAllText($W.FloorFile)
    $r.bridgeConfig = Json ([System.IO.File]::ReadAllText($W.Config))
    $r.ownerAclOnBin = @($script:Dacls[$W.BinDir] | Where-Object { $_ -like "*$OWNER*" })[0]
    $r.filesStepAfter = & $filesStep.Test
    [System.IO.File]::WriteAllText($W.FloorFile, "5`r`n")
    $r.filesStepAfterFloorChanged = & $filesStep.Test
    [System.IO.File]::WriteAllText($W.FloorFile, (Get-Wsl2LeaseFloorText $K.Generation))
    [System.IO.File]::AppendAllText((Join-Path $W.BinDir 'runtime.dll'), 'tampered')
    $r.installedCopyChangedError = Try-Run { Copy-Wsl2Parts }
    [System.IO.File]::WriteAllText((Join-Path $W.BinDir 'runtime.dll'), 'dll bytes')
    # ---- the agreement (no program is started: there is no fake of a start any more)
    $r.verifyOk = Try-Run { Invoke-Wsl2Verify }
    $r.firstStartConfig = Json ([System.IO.File]::ReadAllText($W.FirstCheckConfig))
    $r.firstStartConfigKept = [System.IO.File]::Exists($W.FirstCheckConfig)
    $auth = [System.IO.File]::ReadAllText($L.AuthorityConfig)
    $o = Json $auth; $o.attestationPublicKey = $OtherSpki
    [System.IO.File]::WriteAllText($L.AuthorityConfig, ($o | ConvertTo-Json -Compress))
    $r.verifyDisagree = Try-Run { Invoke-Wsl2Verify }
    [System.IO.File]::WriteAllText($L.AuthorityConfig, $auth)
    $script:Keys[$C2.AttestationKeyName].report.exportPolicy = 1
    $r.verifyKeyExportable = Try-Run { Invoke-Wsl2Verify }
    $script:Keys[$C2.AttestationKeyName].report.exportPolicy = 0
    $script:Keys[$C2.AttestationKeyName].report.allowSids = @('S-1-5-18', 'S-1-5-32-544', $brokerSid, 'S-1-1-0')
    $r.verifyKeyAclExtra = Try-Run { Invoke-Wsl2Verify }
    $script:Keys[$C2.AttestationKeyName].report.allowSids = @('S-1-5-18', 'S-1-5-32-544', $brokerSid)
    # L1: at install the floor must EQUAL the Broker generation; L2: only Administrators, SYSTEM and the owner may read the floor file
    [System.IO.File]::WriteAllText($W.FloorFile, "5`r`n")
    $r.verifyFloorAbove = Try-Run { Invoke-Wsl2Verify }
    [System.IO.File]::WriteAllText($W.FloorFile, (Get-Wsl2LeaseFloorText $K.Generation))
    $script:Dacls[$W.FloorFile] = @('*S-1-5-18:F', '*S-1-5-32-544:F', "*${OWNER}:R", '*S-1-5-32-545:R')
    $r.verifyFloorReadableByUsers = Try-Run { Invoke-Wsl2Verify }
    $r.copyFloorReadableByUsers = Try-Run { Copy-Wsl2Parts }
    [void]$script:Dacls.Remove($W.FloorFile)
    # L3: the bridge config on disk is compared with what the install recorded
    $bridgeGood = [System.IO.File]::ReadAllText($W.Config)
    foreach ($edit in @(@('pipeName', 'OTHER_PIPE'), @('gitPath', 'C:\Program Files\Git\cmd\git.exe'), @('imageSha256', ('9' * 64)), @('controlPlaneSid', $OWNER))) {
      $o = Json $bridgeGood; $o.($edit[0]) = $edit[1]
      [System.IO.File]::WriteAllText($W.Config, ($o | ConvertTo-Json -Compress -Depth 6))
      $r["status_$($edit[0])"] = (Get-Wsl2ReadBackProblems) -join ','
    }
    [System.IO.File]::WriteAllText($W.Config, $bridgeGood)
    # ---- M2 / H1: the first start is confirmed by the WORD the owner read in a normal console
    $lines = Get-Wsl2StatusLines; $r.statusBeforeConfirm = $lines
    $Wsl2FirstStartWord = 'elevated'; $r.confirmElevated = Invoke-Wsl2FirstStartConfirm
    $Wsl2FirstStartWord = 'something'; $r.confirmOther = Invoke-Wsl2FirstStartConfirm
    $r.firstStartRecordedAfterRefusals = $script:Manifest['created']['wsl2'].ContainsKey('firstStart')
    $r.runEntryBeforeFirstStart = Invoke-Wsl2RunEntryMode
    $r.runValueBeforeFirstStart = $script:RunValue
    $Wsl2FirstStartWord = $C2.FirstStartWord; $r.confirmRight = Invoke-Wsl2FirstStartConfirm
    $r.firstStartRecord = $script:Manifest['created']['wsl2']['firstStart']
    $r.manifestShapeAfterConfirm = Test-Wsl2Record $script:Manifest['created']['wsl2']
    # ---- the Run entry is the last, separate step
    $script:Keys[$C2.AttestationKeyName].spki = $OtherSpki
    $r.runEntryWhenKeyDiffers = Invoke-Wsl2RunEntryMode
    $script:Keys[$C2.AttestationKeyName].spki = $Spki
    $r.runEntryOk = Invoke-Wsl2RunEntryMode
    $r.runValue = $script:RunValue
    $r.expectedRunCommand = (Get-Wsl2RunEntry $W).Command
    $r.runRecord = $script:Manifest['created']['wsl2']['runEntry']
    $r.stepIdsHaveNoRun = (Get-Ids (Get-InstallSteps)) -notcontains 'wsl2run'
    # ---- status
    $script:RunValue = (Get-Wsl2RunEntry $W).Command
    $lines = Get-Wsl2StatusLines   # assigned first: the function returns , array
    $r.statusLines = $lines
    [System.IO.File]::WriteAllText($W.FloorFile, "5`r`n"); $lines = Get-Wsl2StatusLines; $r.statusFloorWarning = @($lines | Where-Object { $_.Text -like 'WARNING: the lease floor*' }).Count; [System.IO.File]::WriteAllText($W.FloorFile, (Get-Wsl2LeaseFloorText $K.Generation))
    [System.IO.File]::AppendAllText((Join-Path $W.BinDir 'runtime.dll'), 'tampered')
    $lines = Get-Wsl2StatusLines
    $r.statusTamperedLines = $lines
    $script:Manifest['created'].Remove('wsl2') | Out-Null
    $lines = Get-Wsl2StatusLines
    $r.statusWithoutRecord = $lines.Count
  }
  'uninstall' {
    Set-Folders; Set-BaseManifest
    $brokerSid = Get-DerivedServiceSid $K.BrokerService
    $entry = Get-Wsl2RunEntry $W
    $run = New-Rec @{ name = $C2.RunValueName; command = $entry.Command }
    $script:Manifest['created']['wsl2'] = New-Rec @{ computerId = 'wsl-01'; repositoryId = 'repo-main'; keyName = $C2.AttestationKeyName; keyId = $C2.AttestationKeyId; runEntry = $run }
    # a Run value that is not the recorded command is left alone
    $script:RunValue = 'something else'
    $runStep = Get-Wsl2UninstallRunStep
    [void](& $runStep.Do)
    $r.foreignRunValueKept = ($script:RunValue -ceq 'something else')
    $script:Manifest['created']['wsl2']['runEntry'] = $run
    $script:RunValue = $entry.Command
    $r.runStepBefore = & $runStep.Test
    [void](& $runStep.Do)
    $r.runValueAfter = $script:RunValue
    # the key
    New-FakeKey $C2.AttestationKeyName $brokerSid $Spki
    $keyStep = Get-Wsl2UninstallKeyStep
    $r.keyStepBefore = & $keyStep.Test
    [void](& $keyStep.Do)
    $r.deletedKeys = @($script:Deleted)
    $r.keyStepAfter = & $keyStep.Test
    # the data folder: the shipped data step removes it as a whole, and refuses a file it did not make
    foreach ($rel in @('bridge.json', 'lease-floor', 'albera-wsl2.tar', 'state\operations.log', 'state\git-home\config', 'distributions\albera-run-1\ext4.vhdx')) { Write-Text (Join-Path $W.DataDir $rel) 'x' }
    $r.dataFolderExistsBefore = Test-Path -LiteralPath $W.DataDir
    Write-Text (Join-Path $W.DataDir 'notes.txt') 'not ours'
    $r.dataFolderWithForeignFile = Try-Run { Remove-TrustedTree $W.DataDir @() @() $false }
    $r.dataFolderForeignFileStillThere = Test-Path -LiteralPath (Join-Path $W.DataDir 'notes.txt')
    Remove-Item -LiteralPath (Join-Path $W.DataDir 'notes.txt') -Force
    # H2: a lab folder of lab-sec2.ps1 next to the data folder, with a file held open (its bridge still running): uninstall is not stopped by it
    $labSibling = Join-Path $ProgramDataDir 'AlberaLabSec2\state'
    Write-Text (Join-Path $labSibling 'operations.log') 'x'
    $lockHold = New-Object System.IO.FileStream((Join-Path $labSibling 'operations.log'), [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $script:DaclLog.Clear()
    try {
      Remove-TrustedTree $W.DataDir @() @() $false
      $dataStep = @(Get-UninstallSteps) | Where-Object { $_.Id -eq 'data' }
      $r.dataStepWithLockedLab = Try-Run { & $dataStep.Do }
    }
    finally { $lockHold.Dispose() }
    $r.labSiblingStillThere = Test-Path -LiteralPath $labSibling
    $r["daclLog"] = @($script:DaclLog | ForEach-Object { $_ })
    $r.dataFolderExistsAfter = Test-Path -LiteralPath $W.DataDir
  }
}
$r | ConvertTo-Json -Depth 10 -Compress
