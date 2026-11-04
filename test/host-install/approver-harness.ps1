# Test harness (Windows PowerShell 5.1, ASCII only, no admin): the approver key part of scripts/host/albera-host.ps1 - `-Mode set-approver` and the key-file form of install / migrate - run for real
# against a TEMP layout, with FAKES for the machine (the SCM and the Authority service, the trusted config write, the ACL trust tests). The functions are taken out of the real script by AST, like
# function-harness.ps1, so the code under test is the shipped code. Nothing outside -Work is touched: no service, no Program Files folder, no real config. Prints one JSON line.
#   approver-harness.ps1 -Work <empty temp folder> -RsaSpki <base64 SPKI of an RSA-2048 key made by Node>
param([Parameter(Mandatory = $true)][string]$Work, [Parameter(Mandatory = $true)][string]$RsaSpki)
$ErrorActionPreference = 'Stop'
$Work = [System.IO.Path]::GetFullPath($Work)   # an 8.3 short name would change in GetFullPath and the installer's plain-path checks refuse a path that changes
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $repo 'scripts\host\albera-host-lib.ps1')
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts\host\albera-host.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'albera-host.ps1 does not parse' }
$found = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false))
if ($found.Count -lt 60) { throw ('expected the whole script, found only ' + $found.Count + ' functions') }
foreach ($f in $found) { Invoke-Expression $f.Extent.Text }
# In the real script Stop-Refused exits; here it throws so a case can see the refusal.
function Stop-Refused([string]$Why, [int]$Code = 3) { throw "REFUSED: $Why" }

Add-Type -AssemblyName System.Web.Extensions
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$K = Get-HostConstants
$RepoRoot = Join-Path $Work 'repo'
$L = Get-HostLayout (Join-Path $Work 'pf') (Join-Path $Work 'pd')
$Mode = 'set-approver'
$script:ManifestNote = $null
$script:Manifest = $null
$script:Approver = $null
$script:LegacyValues = $null
$ExpectedTreeHash = $null; $ApproverKeyId = $null; $ApproverPublicKey = $null; $ApproverSid = $null; $ApproverKeyFile = @(); $ExpectedApproverKeyId = $null; $Replace = $false; $LabAssumeYes = $false
$IcaclsExe = Join-Path ([Environment]::SystemDirectory) 'icacls.exe'
# the console of THIS process (the tests start it with piped input and output): what the shipped check says about it, before the fakes below stand in for a console a person can type in
$realConsoleInteractive = [bool](Test-ConsoleInteractive)
$VmName = 'albera-clone-01'; $ComputerId = 'clone-01'; $ProjectId = 'albera-host'; $GrantHyperVToBroker = $false; $SetupRunId = $null; $TrustLocalBuilds = $false
function Try-Run([scriptblock]$Block) { try { & $Block | Out-Null; $null } catch { $_.Exception.Message } }
function New-Junction([string]$Link, [string]$Target) { New-Item -ItemType Directory -Force -Path $Target | Out-Null; $null = & cmd.exe /c mklink /J ('"' + $Link + '"') ('"' + $Target + '"') }
function Remove-Junction([string]$Link) { $null = & cmd.exe /c rmdir ('"' + $Link + '"') }
function Write-Text([string]$Path, [string]$Text) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null; [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false))) }
function Read-Text([string]$Path) { if ([System.IO.File]::Exists($Path)) { [System.IO.File]::ReadAllText($Path) } else { $null } }
function Get-FileBytesHash([string]$Path) { if (-not [System.IO.File]::Exists($Path)) { return $null }; $sha = [System.Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($Path))) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() } }
function Get-TextHash([string]$Text) { if ($null -eq $Text) { return $null }; $sha = [System.Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() } }

# ---- the keys: record files in -Work\keys, made here (an ES256 key per file; the hello-rsa record is built on the RSA-2048 key Node made, and its id is the hash of that key, so it is also a valid LEGACY key)
$labApproverKey = $RsaSpki
$ownerSid = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
$cpSid = Get-DerivedServiceSid $K.ControlPlaneService
$keysDir = Join-Path $Work 'keys'
function New-EcRecord {
  $ecc = New-Object System.Security.Cryptography.ECDsaCng(256)
  try { $spki = [Convert]::FromBase64String((ConvertTo-P256Spki ([byte[]]$ecc.Key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)))) } finally { $ecc.Dispose() }
  $credential = New-Object byte[] 32; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($credential); $rng.Dispose()
  ConvertTo-ApproverKeyObject ([pscustomobject]@{ keyId = (Get-ApproverKeyIdFor 'webauthn' $spki); kind = 'webauthn'; alg = -7; publicKey = [Convert]::ToBase64String($spki); credentialId = (ConvertTo-Base64UrlNoPad $credential) })
}
function New-HelloRecord {
  $spki = [Convert]::FromBase64String($labApproverKey)
  ConvertTo-ApproverKeyObject ([pscustomobject]@{ keyId = (Get-ApproverKeyIdFor 'hello-rsa' $spki); kind = 'hello-rsa'; alg = -257; publicKey = $labApproverKey })
}
function Save-KeyFile([string]$Name, $Record) {
  $path = Join-Path $keysDir $Name
  New-Item -ItemType Directory -Force -Path $keysDir | Out-Null
  [System.IO.File]::WriteAllBytes($path, [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-ApproverKeyText $Record)))
  $path
}
$recA = New-EcRecord; $recB = New-EcRecord; $recH = New-HelloRecord; $recX = New-EcRecord; $recY = New-EcRecord
$fileA = Save-KeyFile 'a.json' $recA; $fileB = Save-KeyFile 'b.json' $recB; $fileH = Save-KeyFile 'h.json' $recH; $fileX = Save-KeyFile 'x.json' $recX; $fileY = Save-KeyFile 'y.json' $recY
# -ExpectedApproverKeyId is REQUIRED with -ApproverKeyFile (one id per file, in order). Unless a scenario sets $script:ExpectedApproverKeyId itself ($null = "not set"), the expected ids are what the OWNER would have seen on the
# enroll screen: the key id of the file as it is when the scenario starts. A file that cannot be read gets a well-formed id nobody holds.
$noKeyId = 'webauthn-0000000000000000'
function Get-ExpectedFor([string[]]$Files) {
  $ids = @()
  foreach ($path in $Files) {
    $file = Read-ApproverKeyFileBytes $path
    $parsed = $(if ($file.Ok) { Read-ApproverKeyRecordBytes $file.Bytes } else { $null })
    $ids += $(if ($parsed -and $parsed.Ok) { $parsed.Record.keyId } else { $noKeyId })
  }
  , $ids
}
# the files and the expected ids the owner saw, set together (what the command line carries)
function Use-KeyFiles([string[]]$Files) {
  $script:ApproverKeyFile = $Files
  $script:ExpectedApproverKeyId = Get-ExpectedFor $Files
  $script:ApproverKeyRead = $null
}
$legacyId = $recH.keyId                  # a legacy pair whose id is the hash of its key: a valid hello-rsa record, so it can be carried into approverKeys
$badLegacyId = 'hello-0123456789abcdef'  # a legacy pair whose id is NOT the hash of its key: it cannot

# ---- the fake machine: the SCM (a service is Running or Stopped), the trusted config write, the clock of the settle wait
function Get-PathTrustReasons { , @() }   # the temp folders belong to this user; the real trust test has its own cases in function-harness.ps1
$script:StoreUntrusted = $false
function Get-AuthorityFileTrustReasons([string]$Path) { if ($script:StoreUntrusted) { , @('owner_untrusted') } else { , @() } }   # the pure part (owner = the Authority's own SID is allowed) is tested in approver-keys-check.ps1
$origChain = ${function:Get-ReparseChain}
function Get-ReparseChain([string]$Path) { $c = & $origChain $Path; , @($c | Where-Object { $_.Length -ge $Work.Length -and $_.StartsWith($Work, [System.StringComparison]::OrdinalIgnoreCase) }) }   # only links inside -Work count (the temp root may be one)
$script:Said = New-Object 'System.Collections.Generic.List[string]'
function Say([string]$Text) { $script:Said.Add($Text) }
$script:Order = New-Object 'System.Collections.Generic.List[string]'
$script:ConfigWrites = New-Object 'System.Collections.Generic.List[object]'
$script:StartSnapshots = New-Object 'System.Collections.Generic.List[object]'
$script:Svc = @{}
$script:WrongPath = $false; $script:StopFails = $false; $script:StartMode = 'works'; $script:OldAuthorityBuild = $false; $script:AuthorityNeverStarts = $false
$script:FailFirstStarts = 0; $script:SeedOnFailedStart = $false; $script:ConfigWriteFailsOnce = $false
function Get-CimInstance { param([Parameter(Position = 0)]$Class, $Namespace, $ClassName, $Filter)
  if ($Class -eq 'Win32_Service') { $n = [regex]::Match([string]$Filter, "Name='([^']+)'").Groups[1].Value; if ($script:Svc.ContainsKey($n)) { return [pscustomobject]@{ Name = $n } } }
  $null }
function Get-AccountSid([string]$Account) { Get-DerivedServiceSid ($Account -replace '^NT SERVICE\\', '') }
function Get-ServiceFactsFor([string]$Name) {
  if (-not $script:Svc.ContainsKey($Name)) { return [pscustomobject]@{ Exists = $false } }
  $spec = Get-ServiceSpecs | Where-Object { $_.Name -eq $Name }
  [pscustomobject]@{ Exists = $true; PathName = $(if ($script:WrongPath) { 'C:\evil.exe service x' } else { Get-ServiceCommandLine $spec.Exe $spec.Config }); State = $script:Svc[$Name].state }
}
function Wait-ServiceState([string]$Name, [string[]]$States, [int]$Seconds) { $States -contains $script:Svc[$Name].state }
function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) }
# The console a person types in. The shipped Test-ConsoleInteractive / Read-ConfirmationLine are replaced by these (the real console check is run once above, on this process's own piped console): by default an interactive
# console where the person types yes; a scenario changes $script:Console. Every prompt is logged with what was on the screen and what had been done when it was asked.
$script:Console = @{ Interactive = $true; Answer = 'yes' }
$script:Prompts = New-Object 'System.Collections.Generic.List[object]'
function Test-ConsoleInteractive { [bool]$script:Console.Interactive }
function Read-ConfirmationLine([string]$Prompt) {
  $script:Prompts.Add([ordered]@{ prompt = $Prompt; listShown = (@($script:Said | Where-Object { $_ -like '*will trust exactly these*' }).Count -gt 0); stepsDone = $script:Order.Count; saidLines = $script:Said.Count })
  $script:Console.Answer
}
# icacls (the owner of a restored key store): never run for real; every call is logged, and a scenario can make it fail
$script:NativeCalls = New-Object 'System.Collections.Generic.List[string]'
$script:NativeExit = 0
function Invoke-Native([string]$Exe, [string]$Arguments, [int]$TimeoutMs = 60000, [switch]$MinimalEnvironment) { $script:NativeCalls.Add($Arguments); [pscustomobject]@{ Exit = $script:NativeExit; Out = ''; Err = 'fake icacls failure' } }
# a failing disk for the install record
$script:ManifestFails = $false
$realSaveManifest = ${function:Save-Manifest}
function Save-Manifest { if ($script:ManifestFails) { throw 'the install record could not be written (fake: disk full)' }; & $realSaveManifest }
# The key store as the Authority writes it (approver-webauthn.md, "Key store"): {"v":1,"revision":n,"keys":[records],"signCounts":{"<keyId>":n}}.
function Write-Store($Records, [int]$Revision = 3, $SignCounts = $null) {
  $counts = [ordered]@{}
  if ($null -ne $SignCounts) { foreach ($id in $SignCounts.Keys) { $counts[$id] = $SignCounts[$id] } } else { foreach ($r in @($Records)) { $counts[$r.keyId] = 7 } }
  Write-Text $L.AuthorityKeyStore (ConvertTo-Json -InputObject ([ordered]@{ v = 1; revision = $Revision; keys = @($Records); signCounts = $counts }) -Depth 6 -Compress)
}
# the fake SCM. A start reads the config file as the service would: an OLD Authority build ($OldAuthorityBuild) refuses a config with approverKeys; a refused start either throws (sc.exe error) or leaves the service stopped.
# A start that works makes the key store from the config when there is none ("on start, a missing store is created from the config keys"), as the Authority of phase 2 does.
function Invoke-Sc([string]$Arguments) {
  $script:Order.Add('sc ' + $Arguments)
  $t = $Arguments -split ' '; $name = $t[1]
  if ($t[0] -eq 'stop') { if ($script:StopFails) { throw 'sc.exe failed (exit 1052): fake, the service cannot be stopped' }; $script:Svc[$name].state = 'Stopped'; if ($script:OnStop) { & $script:OnStop } }
  if ($t[0] -eq 'start') {
    $text = Read-Text $L.AuthorityConfig
    $script:StartSnapshots.Add([ordered]@{ configHasList = ($text -like '*"approverKeys"*'); configHasPair = ($text -like '*"approverKeyId"*'); storeExists = [System.IO.File]::Exists($L.AuthorityKeyStore) })
    $refused = $script:AuthorityNeverStarts -or ($script:OldAuthorityBuild -and ($text -like '*"approverKeys"*'))
    # a start that fails once for another reason (a process squatting the Authority pipe name while the service was stopped): the Authority gets as far as making its key store from the config, then dies at the pipe
    if (-not $refused -and $script:FailFirstStarts -gt 0) {
      $script:FailFirstStarts--
      if ($script:SeedOnFailedStart -and -not [System.IO.File]::Exists($L.AuthorityKeyStore) -and -not [System.IO.Directory]::Exists($L.AuthorityKeyStore)) {
        $failedSeed = Get-AuthorityConfigApproverKeys $text
        if ($failedSeed.Reasons.Count -eq 0) { if ($failedSeed.Legacy) { $failedLegacy = ConvertFrom-LegacyApproverPair $failedSeed.Approver.approverKeyId $failedSeed.Approver.approverPublicKey; if ($failedLegacy.Ok) { Write-Store $failedLegacy.Record 1 @{} } } else { Write-Store $failedSeed.Approver.approverKeys 1 @{} } }
      }
      $refused = $true
    }
    if ($refused) { if ($script:StartMode -eq 'throws') { throw 'sc.exe failed (exit 1053): fake, the service did not respond' }; $script:Svc[$name].state = 'Stopped' }
    else {
      $script:Svc[$name].state = 'Running'
      if (-not [System.IO.File]::Exists($L.AuthorityKeyStore) -and -not [System.IO.Directory]::Exists($L.AuthorityKeyStore)) {
        $seed = Get-AuthorityConfigApproverKeys $text
        if ($seed.Reasons.Count -eq 0) {
          if ($seed.Legacy) { $legacyRecord = ConvertFrom-LegacyApproverPair $seed.Approver.approverKeyId $seed.Approver.approverPublicKey; if ($legacyRecord.Ok) { Write-Store $legacyRecord.Record 1 @{} } }
          else { Write-Store $seed.Approver.approverKeys 1 @{} }
        }
      }
    }
  }
  [pscustomobject]@{ Exit = 0; Out = ''; Err = '' }
}
# the trusted write path, as a plain write that records what the world looked like at that moment
function Write-OneConfig([string]$Path, [string]$Text, [string[]]$Writers) {
  $script:Order.Add('write ' + (Split-Path -Leaf $Path))
  if ($script:ConfigWriteFailsOnce) { $script:ConfigWriteFailsOnce = $false; throw 'the Authority config could not be written (fake: access denied half-way)' }
  $state = if ($script:Svc.ContainsKey($K.AuthorityService)) { $script:Svc[$K.AuthorityService].state } else { $null }
  $script:ConfigWrites.Add([ordered]@{ file = (Split-Path -Leaf $Path); serviceState = $state; storeExists = [System.IO.File]::Exists($L.AuthorityKeyStore); writers = @($Writers) })
  Write-Text $Path $Text
}

# ---- an installed world: a complete record, the Authority config, a key store, files beside it, three services
#   -Config legacy : the legacy pair (approverKeyId = -LegacyId, the lab RSA key); the record has values.approverKeyId
#   -Config keys   : approverKeys = -ConfigKeys; the record has values.approverKeys
#   -Store         : the records the Authority's key store holds (none = no store file)
$script:OldConfig = $null
function New-World([string]$AuthorityState = 'Running', [string]$Config = 'legacy', $ConfigKeys = @(), $Store = $null, [string]$LegacyId = $legacyId) {
  if (Test-Path -LiteralPath $L.DataRoot) { Remove-Item -LiteralPath $L.DataRoot -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $L.AuthorityDir | Out-Null
  $approver = if ($Config -eq 'keys') { [pscustomobject]@{ approverSid = $ownerSid; approverKeys = @($ConfigKeys) } } else { [pscustomobject]@{ approverSid = $ownerSid; approverKeyId = $LegacyId; approverPublicKey = $labApproverKey } }
  $script:OldConfig = ConvertTo-HostJson (Get-AuthorityConfig $cpSid $approver)
  Write-Text $L.AuthorityConfig $script:OldConfig
  if ($null -ne $Store) { Write-Store $Store }
  Write-Text (Join-Path $L.AuthorityDir 'policy.json') '{"policy":"kept"}'
  Write-Text (Join-Path $L.AuthorityDir 'notes.txt') 'kept'
  $script:Manifest = New-Manifest
  $script:Manifest['state'] = 'complete'
  $script:Manifest['created']['services'] = @($K.BrokerService, $K.AuthorityService, $K.ControlPlaneService)
  $values = $script:Manifest['values']
  $values['approverSid'] = $ownerSid; $values['controlPlaneSid'] = $cpSid
  if ($Config -eq 'keys') { $values['approverKeys'] = ConvertTo-ApproverKeysManifestValue $ConfigKeys } else { $values['approverKeyId'] = $LegacyId }
  Save-Manifest
  $script:ManifestNote = $null; $script:Sids = $null; $script:Approver = $null; $script:LegacyValues = $null
  $script:Svc = @{}
  foreach ($n in @($K.BrokerService, $K.AuthorityService, $K.ControlPlaneService)) { $script:Svc[$n] = @{ state = 'Running' } }
  $script:Svc[$K.AuthorityService].state = $AuthorityState
  $script:WrongPath = $false; $script:StopFails = $false; $script:StartMode = 'works'; $script:OldAuthorityBuild = $false; $script:AuthorityNeverStarts = $false; $script:StoreUntrusted = $false
  $script:FailFirstStarts = 0; $script:SeedOnFailedStart = $false; $script:ConfigWriteFailsOnce = $false; $script:ManifestFails = $false; $script:NativeExit = 0
  $script:Console = @{ Interactive = $true; Answer = 'yes' }; $script:Prompts.Clear(); $script:NativeCalls.Clear(); $script:LabAssumeYes = $false
  $script:Order.Clear(); $script:ConfigWrites.Clear(); $script:StartSnapshots.Clear(); $script:Said.Clear()
  $script:ExpectedApproverKeyId = $null; $script:Replace = $false; $script:OnStop = $null   # $null: Invoke-Set supplies the ids of the files as the owner saw them
}
# the ids and kinds the install record on disk holds, always as an array (a one-element result must not turn into a plain string)
function Get-RecordedKeyIds($Disk) {
  $ids = @()
  if ($Disk['values'].ContainsKey('approverKeys')) { $ids = @($Disk['values']['approverKeys'] | ForEach-Object { $_['keyId'] + '|' + $_['kind'] }) }
  , $ids
}
# the key ids a config or a store text holds (approverKeys, or the legacy pair as one id), as an array
function Get-TextKeyIds([string]$Text, [string]$What) {
  $ids = @()
  if ($Text) {
    try {
      $o = $Text | ConvertFrom-Json
      if ($What -eq 'store') { $ids = @($o.keys | ForEach-Object { $_.keyId }) }
      elseif ($null -ne $o.PSObject.Properties['approverKeys']) { $ids = @($o.approverKeys | ForEach-Object { $_.keyId }) }
      else { $ids = @($o.approverKeyId) }
    }
    catch { $ids = @('(not json)') }
  }
  , $ids
}
# runs -Mode set-approver for these files (-UseReplace: with -Replace) and reports what is observable
function Invoke-Set([string[]]$Files, [switch]$UseReplace) {
  $explicitExpected = $script:ExpectedApproverKeyId   # $null: the scenario did not set it, so the ids of these files as the owner saw them are used (and only for this run)
  $script:ApproverKeyFile = $Files
  if ($null -eq $explicitExpected) { $script:ExpectedApproverKeyId = Get-ExpectedFor $Files }
  $script:Replace = [bool]$UseReplace
  $script:ApproverKeyRead = $null
  $script:ExitCode = $null
  $script:SetApprover = New-SetApproverState
  $script:Order.Clear(); $script:ConfigWrites.Clear(); $script:StartSnapshots.Clear(); $script:Said.Clear(); $script:Prompts.Clear(); $script:NativeCalls.Clear()
  $out = [ordered]@{}
  $out.error = Try-Run { $script:ExitCode = Invoke-SetApprover }
  $script:ExpectedApproverKeyId = $explicitExpected
  $out.exit = $script:ExitCode
  $out.prompts = $script:Prompts.ToArray()
  $out.nativeCalls = $script:NativeCalls.ToArray()
  $out.storeHash = Get-FileBytesHash $L.AuthorityKeyStore
  $out.order = @($script:Order)
  $out.said = @($script:Said)
  $out.writes = $script:ConfigWrites.ToArray()
  $out.starts = $script:StartSnapshots.ToArray()
  $out.service = $script:Svc[$K.AuthorityService].state
  $out.config = Read-Text $L.AuthorityConfig
  $out.configIsOld = ($out.config -ceq $script:OldConfig)
  $configIds = Get-TextKeyIds $out.config 'config'
  $out.configKeyIds = $configIds
  $out.storeExists = [System.IO.File]::Exists($L.AuthorityKeyStore)
  $storeIds = Get-TextKeyIds (Read-Text $L.AuthorityKeyStore) 'store'
  $out.storeKeyIds = $storeIds
  $out.folder = @(Get-ChildItem -LiteralPath $L.AuthorityDir -Force | ForEach-Object { $_.Name } | Sort-Object)
  $disk = Read-Manifest
  $recordedIds = Get-RecordedKeyIds $disk
  $out.record = [ordered]@{
    approverKeys = $recordedIds; hasLegacyId = $disk['values'].ContainsKey('approverKeyId'); setAt = $(if ($disk['values'].ContainsKey('approverKeysSetAt')) { $disk['values']['approverKeysSetAt'] } else { $null })
    approverSid = $disk['values']['approverSid']; shape = (Test-ManifestShape $disk); manifestHash = (Get-TextHash ([System.IO.File]::ReadAllText($L.ManifestPath)))
  }
  $out
}
$result = [ordered]@{ ids = [ordered]@{ a = $recA.keyId; b = $recB.keyId; h = $recH.keyId; x = $recX.keyId; y = $recY.keyId; legacy = $legacyId; badLegacy = $badLegacyId }; ownerSid = $ownerSid; cpSid = $cpSid; authoritySid = (Get-DerivedServiceSid $K.AuthorityService); authorityDir = $L.AuthorityDir; storePath = $L.AuthorityKeyStore }

# ---- 1. -Replace: a legacy install with a key store, one WebAuthn key, the service running (the old shape of the run)
New-World -Store @($recH)
$result.beforeManifestHash = Get-TextHash ([System.IO.File]::ReadAllText($L.ManifestPath))
$result.one = Invoke-Set @($fileA) -UseReplace
$result.oneConfig = $(if ($result.one.config) { $result.one.config | ConvertFrom-Json } else { $null })
$result.oneStatus = $(if ($result.one.config) { $statusLine = Get-ApproverKeysStatusLine $result.one.config (Read-Manifest)['values']; [ordered]@{ state = $statusLine.State; text = $statusLine.Text } } else { $null })
$result.oneConfigReasons = Test-AuthorityConfigText $result.one.config
$oldObject = $script:OldConfig | ConvertFrom-Json
$result.oneOtherFieldsSame = (@('pipeRoot', 'controlPlaneSid', 'approverSid', 'signingKeyName', 'signingKeyProvider', 'kid', 'audience', 'policyVersion') | Where-Object { $result.oneConfig.$_ -cne $oldObject.$_ }).Count -eq 0
# ---- 2. -Replace with the same files again: the keys in force (the store the Authority made again), the config and the record already are this list - nothing happens, the store is left alone
$storeBefore = Read-Text $L.AuthorityKeyStore
$result.again = Invoke-Set @($fileA) -UseReplace
$result.againStoreUntouched = ((Read-Text $L.AuthorityKeyStore) -ceq $storeBefore)
# ... which needs no confirmation either: it writes and restarts nothing, so a console that cannot be typed in is no obstacle
$script:Console.Interactive = $false
$result.againNoConsole = Invoke-Set @($fileA) -UseReplace
$script:Console.Interactive = $true
# ---- 3. -Replace with two files (a WebAuthn key and the Hello key): the order of the files is the order of the list
New-World
$result.two = Invoke-Set @($fileA, $fileH) -UseReplace
$result.twoKeys = $result.two.configKeyIds
# ---- 4. the service is not running: the config changes, nothing is stopped or started
New-World 'Stopped' -Store @($recH)
$result.stopped = Invoke-Set @($fileA) -UseReplace
# ---- 5. the installed Authority build does not read approverKeys (it dies at start): the old config goes back, the service runs again, nothing is recorded
foreach ($howItFails in @('dies', 'throws')) {
  New-World -Store @($recH); $script:OldAuthorityBuild = $true; $script:StartMode = $howItFails
  $result["oldBuild_$howItFails"] = Invoke-Set @($fileA) -UseReplace
}
# ... and an Authority that does not start at all, with the old config either
New-World -Store @($recH); $script:AuthorityNeverStarts = $true; $script:StartMode = 'dies'
$result.neverStarts = Invoke-Set @($fileA) -UseReplace
# ---- 5b. a run that was cut off after the config was written (the record and the key store are still the old ones): the next run finishes the job without writing the config again
New-World -Store @($recH)
$null = Invoke-Set @($fileA) -UseReplace
$script:Manifest['values'].Remove('approverKeys') | Out-Null; $script:Manifest['values'].Remove('approverKeysSetAt') | Out-Null; $script:Manifest['values']['approverKeyId'] = $legacyId; Save-Manifest
Write-Store @($recH) 9
$result.resumed = Invoke-Set @($fileA) -UseReplace
# ... and when the Authority will not start with that config, there is no "old" config to put back, and the run says so
New-World -Store @($recH)
$null = Invoke-Set @($fileA) -UseReplace
$script:Manifest['values'].Remove('approverKeys') | Out-Null; $script:Manifest['values'].Remove('approverKeysSetAt') | Out-Null; $script:Manifest['values']['approverKeyId'] = $legacyId; Save-Manifest
Write-Store @($recH) 9
$script:AuthorityNeverStarts = $true; $script:StartMode = 'dies'
$result.resumedNeverStarts = Invoke-Set @($fileA) -UseReplace
# ---- 6. the service will not stop: nothing is changed
New-World -Store @($recH); $script:StopFails = $true
$result.stopFails = Invoke-Set @($fileA) -UseReplace
# ---- 7. the key store cannot be deleted (it is held open): the config goes back, the service runs again, nothing is recorded
New-World -Store @($recH)
$held = New-Object System.IO.FileStream($L.AuthorityKeyStore, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)   # readable by others (the install reads the store), NOT deletable
$result.storeHeldHashBefore = Get-FileBytesHash $L.AuthorityKeyStore
try { $result.storeHeld = Invoke-Set @($fileA) -UseReplace } finally { $held.Dispose() }
# ---- 8. the key store is not a plain file: refused before anything is touched
New-World -Store @($recH)
Remove-Item -LiteralPath $L.AuthorityKeyStore -Force
New-Item -ItemType Directory -Force -Path $L.AuthorityKeyStore | Out-Null; Write-Text (Join-Path $L.AuthorityKeyStore 'inside.txt') 'precious'
$result.storeIsFolder = Invoke-Set @($fileA) -UseReplace
$result.storeFolderIntact = [System.IO.File]::Exists((Join-Path $L.AuthorityKeyStore 'inside.txt'))
New-World -Store @($recH)
Remove-Item -LiteralPath $L.AuthorityKeyStore -Force
$linkTarget = Join-Path $Work 'link-target'; Write-Text (Join-Path $linkTarget 'precious.txt') 'precious'
New-Junction $L.AuthorityKeyStore $linkTarget
$result.storeIsJunction = Invoke-Set @($fileA) -UseReplace
$result.junctionTargetIntact = [System.IO.File]::Exists((Join-Path $linkTarget 'precious.txt'))
Remove-Junction $L.AuthorityKeyStore
# no key store at all (an Authority that never ran with the key list): the step is skipped and the run still works
New-World
$result.noStore = Invoke-Set @($fileA) -UseReplace
# ---- 9. Remove-ApproverKeyStore touches only that one file
New-World -Store @($recH)
Write-Text (Join-Path $L.AuthorityDir 'approver-keys.json.bak') 'x'; Write-Text (Join-Path $L.AuthorityDir 'approver-keys.tmp') 'x'; Write-Text (Join-Path $L.AuthorityDir 'sub\approver-keys.json') 'x'; Write-Text (Join-Path $L.DataRoot 'approver-keys.json') 'x'
$result.removeStore = [ordered]@{
  first = (Remove-ApproverKeyStore); second = (Remove-ApproverKeyStore)
  left = @(Get-ChildItem -LiteralPath $L.DataRoot -Recurse -Force | Where-Object { -not $_.PSIsContainer } | ForEach-Object { $_.FullName.Substring($L.DataRoot.Length + 1) } | Sort-Object)
}

# ---- 9b. ADDING (no -Replace): the keys in force come first, the given keys are appended, nothing is dropped
# a legacy install (the Hello key as the legacy pair, no key store yet): the result is the Hello key AND the new key
New-World
$result.addToLegacy = Invoke-Set @($fileA)
# a key store the Authority made again after that: adding a second one starts from the store
$result.addSecond = Invoke-Set @($fileB)
# the same key twice is refused (it is in force already), the Hello key of the legacy pair is refused for the same reason
$result.addAgain = Invoke-Set @($fileB)
New-World
$result.addLegacyKeyAgain = Invoke-Set @($fileH)
# ---- 9c. THE STORE WINS: key X was in the config, then taken out at run time (key_remove), so the store holds [A] and the config still holds [A, X]. Adding Y must give [A, Y] - never X.
New-World -Config keys -ConfigKeys @($recA, $recX) -Store @($recA)
$result.storeWins = Invoke-Set @($fileY)
# ... and the contrast: with no store, the config IS the keys in force, so X stays
New-World -Config keys -ConfigKeys @($recA, $recX)
$result.noStoreConfigWins = Invoke-Set @($fileY)
# a store that is there but cannot be used is never replaced by a look at the config: add is refused; -Replace (the complete list) is not
foreach ($case in @('untrusted', 'garbage', 'noKeys', 'badRecord', 'twoKeysSame')) {
  New-World -Config keys -ConfigKeys @($recA, $recX) -Store @($recA)
  switch ($case) {
    'untrusted' { $script:StoreUntrusted = $true }
    'garbage' { Write-Text $L.AuthorityKeyStore 'not json' }
    'noKeys' { Write-Text $L.AuthorityKeyStore '{"v":1,"revision":3,"keys":[],"signCounts":{}}' }
    'badRecord' { Write-Text $L.AuthorityKeyStore ((Read-Text $L.AuthorityKeyStore) -replace '"keyId":"webauthn-[0-9a-f]{16}"', '"keyId":"webauthn-0000000000000000"') }
    'twoKeysSame' { Write-Store @($recA, $recA) }
  }
  $storeTextBefore = Read-Text $L.AuthorityKeyStore
  $add = Invoke-Set @($fileY)
  $add.configUntouched = $add.configIsOld; $add.storeUntouched = ((Read-Text $L.AuthorityKeyStore) -ceq $storeTextBefore)
  $result["badStore_$case"] = [ordered]@{ add = $add }
  if ($case -ne 'untrusted') { $script:StoreUntrusted = $false }
  $result["badStore_$case"].replaceRun = Invoke-Set @($fileY) -UseReplace
}
# a legacy pair that is not a valid record (its id is not the hash of its key) cannot be carried: add is refused, -Replace is not
New-World -LegacyId $badLegacyId
$result.badLegacy = [ordered]@{ add = (Invoke-Set @($fileA)) }
$result.badLegacy.replaceRun = Invoke-Set @($fileA) -UseReplace
# the limit: 15 in force + 1 = 16 is fine, 16 + 1 is refused with the count in the message
$sixteen = @(1..16 | ForEach-Object { New-EcRecord })
New-World -Config keys -ConfigKeys $sixteen[0..14] -Store $sixteen[0..14]
$result.fifteenPlusOne = Invoke-Set @($fileY)
New-World -Config keys -ConfigKeys $sixteen -Store $sixteen
$result.sixteenPlusOne = Invoke-Set @($fileY)
# -Replace needs neither the store nor the config: 16 given files are 16 keys, whatever is in force
New-World -Config keys -ConfigKeys @($recA, $recX) -Store @($recA)
$sixteenFiles = @(0..15 | ForEach-Object { Save-KeyFile ("sixteen$_.json") $sixteen[$_] })
$result.replaceWithSixteen = Invoke-Set $sixteenFiles -UseReplace
# the final list is on the screen BEFORE the config is written (the order of the lines of one run)
$result.addToLegacyOrder = [ordered]@{ listAt = 0; writtenAt = 0 }
New-World
$orderRun = Invoke-Set @($fileA)
$result.addToLegacyOrder.listAt = [array]::IndexOf(@($orderRun.said), (@($orderRun.said) | Where-Object { $_ -like '*will trust exactly these*' } | Select-Object -First 1))
$result.addToLegacyOrder.writtenAt = [array]::IndexOf(@($orderRun.said), (@($orderRun.said) | Where-Object { $_ -like '*config written*' } | Select-Object -First 1))
# the final list changes between the screen and the write (a key_remove while the service was being stopped): nothing is written, the service is started again
New-World -Config keys -ConfigKeys @($recA, $recX) -Store @($recA, $recX)
$script:OnStop = { Write-Store @($recA) 4 }   # a key_remove lands just as the service stops: X leaves the store
$result.changedWhileStopping = Invoke-Set @($fileY)
$script:OnStop = $null

# ---- 9d. THE ROLLBACK PUTS THE KEY STORE BACK, BYTE FOR BYTE (Zaku SEC-001). Key X is in the config but was taken out of the store by key_remove (the store holds [A]). A run that fails after the store was deleted must not
# leave the Authority without a store: its next start would make one from the old config and bring X back. A store as a real Authority leaves it (indented, a line break at the end, sign counts that have moved) is the test bytes.
function Write-StoreAsFound($Records, [int]$Revision = 5) {
  $counts = [ordered]@{}; $n = 40
  foreach ($r in @($Records)) { $counts[$r.keyId] = $n; $n += 2 }
  Write-Text $L.AuthorityKeyStore ((ConvertTo-Json -InputObject ([ordered]@{ v = 1; revision = $Revision; keys = @($Records); signCounts = $counts }) -Depth 6) + "`r`n")
}
function Get-EffectiveIds { $eff = Get-EffectiveApproverKeys; , @($eff.Records | ForEach-Object { $_.keyId }) }
$rollback = [ordered]@{}
# (a) the Authority does not start with the new config for a reason that has nothing to do with the build (a process squatting its pipe name while it was stopped); the failed start had made a store from the NEW config
New-World -Config keys -ConfigKeys @($recA, $recX); Write-StoreAsFound @($recA)
$rollback.removedKeyBefore = Get-FileBytesHash $L.AuthorityKeyStore
$script:FailFirstStarts = 1; $script:SeedOnFailedStart = $true
$rollback.removedKey = Invoke-Set @($fileY)
$rollback.removedKeyEffective = Get-EffectiveIds
# (b) the same without the seeded leftover (the failed start died before it made a store)
New-World -Config keys -ConfigKeys @($recA, $recX); Write-StoreAsFound @($recA)
$rollback.plainBefore = Get-FileBytesHash $L.AuthorityKeyStore
$script:FailFirstStarts = 1; $script:SeedOnFailedStart = $false
$rollback.plain = Invoke-Set @($fileY)
# (c) there was no store at the start (the config was the keys in force): the rollback leaves NO store, then the Authority makes its own from the OLD config at the start the rollback does
New-World -Config keys -ConfigKeys @($recA, $recX)
$script:FailFirstStarts = 1; $script:SeedOnFailedStart = $true
$rollback.noOriginal = Invoke-Set @($fileY)
# (d) the install record cannot be written after the Authority came up with the new list: the old config AND the old store come back, the service is restarted with them
New-World -Config keys -ConfigKeys @($recA, $recX); Write-StoreAsFound @($recA)
$rollback.recordFailsBefore = Get-FileBytesHash $L.AuthorityKeyStore
$script:ManifestFails = $true
$rollback.recordFails = Invoke-Set @($fileY)
$script:ManifestFails = $false
$rollback.recordFailsEffective = Get-EffectiveIds
# (e) the config write fails half-way (before the store step): the store was never touched, and is left alone (no icacls, no write)
New-World -Config keys -ConfigKeys @($recA, $recX); Write-StoreAsFound @($recA)
$rollback.configFailsBefore = Get-FileBytesHash $L.AuthorityKeyStore
$script:ConfigWriteFailsOnce = $true
$rollback.configFails = Invoke-Set @($fileY)
# (f) -Replace over a store that is trusted but is not a valid store: it is deleted by the run, and put back as it was found (garbage and all) when the run fails
New-World -Config keys -ConfigKeys @($recA, $recX)
Write-Text $L.AuthorityKeyStore "not a key store`r`nat all`r`n"
$rollback.garbageBefore = Get-FileBytesHash $L.AuthorityKeyStore
$script:FailFirstStarts = 1; $script:SeedOnFailedStart = $true
$rollback.garbage = Invoke-Set @($fileY) -UseReplace
# (g) a store the install does not trust (-Replace goes on without it): there is nothing to put back, and the run says so
New-World -Config keys -ConfigKeys @($recA, $recX) -Store @($recA); $script:StoreUntrusted = $true
$script:FailFirstStarts = 1; $script:SeedOnFailedStart = $true
$rollback.untrusted = Invoke-Set @($fileY) -UseReplace
$script:StoreUntrusted = $false
# (h) the store cannot be put back (icacls fails): the service is left STOPPED, never started on a store the run did not mean to leave
New-World -Config keys -ConfigKeys @($recA, $recX); Write-StoreAsFound @($recA)
$script:FailFirstStarts = 1; $script:SeedOnFailedStart = $true; $script:NativeExit = 5
$rollback.restoreFails = Invoke-Set @($fileY)
$script:NativeExit = 0
$result.rollback = $rollback

# ---- 10. refusals: each leaves the world exactly as it was
$refusals = [ordered]@{}
$refuse = {
  param($name, [scriptblock]$Setup, [string[]]$Files)
  New-World -Store @($recH)
  & $Setup
  $before = [ordered]@{ config = (Read-Text $L.AuthorityConfig); manifest = (Get-TextHash ([System.IO.File]::ReadAllText($L.ManifestPath))); store = (Read-Text $L.AuthorityKeyStore) }
  $run = Invoke-Set $Files
  $refusals[$name] = [ordered]@{ error = $run.error; sc = @($run.order | Where-Object { $_ -like 'sc *' }).Count; writes = @($run.writes).Count; configSame = ($run.config -ceq $before.config); manifestSame = ($run.record.manifestHash -ceq $before.manifest); storeSame = ((Read-Text $L.AuthorityKeyStore) -ceq $before.store); service = $run.service; prompts = @($run.prompts).Count; native = @($run.nativeCalls).Count }
}
# the confirmation (Zaku SEC-002): the person types yes after the final list is shown, BEFORE the service is stopped or anything is written. A console that cannot be typed in, or any other answer, is refused with nothing changed.
& $refuse 'consoleNotInteractive' { $script:Console.Interactive = $false } @($fileA)
& $refuse 'answerNo' { $script:Console.Answer = 'no' } @($fileA)
& $refuse 'answerY' { $script:Console.Answer = 'y' } @($fileA)
& $refuse 'answerEmpty' { $script:Console.Answer = '' } @($fileA)
& $refuse 'answerNothingAtAll' { $script:Console.Answer = $null } @($fileA)
& $refuse 'answerCapitals' { $script:Console.Answer = 'YES' } @($fileA)
& $refuse 'answerLonger' { $script:Console.Answer = 'yes please' } @($fileA)
& $refuse 'labFlagOutsideTheLab' { $script:LabAssumeYes = $true; $env:ALBERA_LAB_VM = $null; $script:Console.Interactive = $false } @($fileA)
$env:ALBERA_LAB_VM = $null
& $refuse 'partial' { $script:Manifest['state'] = 'partial'; Save-Manifest } @($fileA)
& $refuse 'firstLayout' { $u = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $u['name'] = $K.ControlPlaneUser; $u['sid'] = 'S-1-5-21-1111111111-2222222222-3333333333-1500'; $script:Manifest['created']['user'] = $u; Save-Manifest } @($fileA)
& $refuse 'noAuthorityInRecord' { $script:Manifest['created']['services'] = @($K.BrokerService); Save-Manifest } @($fileA)
& $refuse 'noManifest' { $script:Manifest = $null } @($fileA)
& $refuse 'unreadableManifest' { $script:Manifest = $null; $script:ManifestNote = 'C:\ProgramData\Albera cannot be read by this account' } @($fileA)
& $refuse 'configMissing' { Remove-Item -LiteralPath $L.AuthorityConfig -Force } @($fileA)
& $refuse 'configGarbage' { Write-Text $L.AuthorityConfig 'not json' } @($fileA)
& $refuse 'configOtherKid' { Write-Text $L.AuthorityConfig ($script:OldConfig -replace '"kid":"[^"]*"', '"kid":"somebody-elses"') } @($fileA)
& $refuse 'configExtraKey' { Write-Text $L.AuthorityConfig ($script:OldConfig -replace '^\{', '{"attestationKeyId":"x",') } @($fileA)
& $refuse 'configOtherSid' { Write-Text $L.AuthorityConfig ($script:OldConfig -replace '"approverSid":"[^"]*"', '"approverSid":"S-1-5-21-1111111111-2222222222-3333333333-1999"') } @($fileA)
& $refuse 'serviceOtherCommandLine' { $script:WrongPath = $true } @($fileA)
& $refuse 'serviceMissing' { $script:Svc.Remove($K.AuthorityService) } @($fileA)
& $refuse 'fileMissing' { } @((Join-Path $keysDir 'missing.json'))
& $refuse 'twoFilesSameKey' { } @($fileA, $fileA)
& $refuse 'noFiles' { } @()
# -ExpectedApproverKeyId is required: one id per file, in order, each the key id of that file's public key (the id the owner saw on the enroll screen)
& $refuse 'expectedMissing' { $script:ExpectedApproverKeyId = @() } @($fileA)
& $refuse 'expectedMissingTwoFiles' { $script:ExpectedApproverKeyId = @() } @($fileA, $fileB)
& $refuse 'expectedIdsDiffer' { $script:ExpectedApproverKeyId = @($recB.keyId) } @($fileA)
& $refuse 'expectedIdsMissingOne' { $script:ExpectedApproverKeyId = @($recA.keyId) } @($fileA, $fileB)
& $refuse 'expectedIdsOneTooMany' { $script:ExpectedApproverKeyId = @($recA.keyId, $recB.keyId) } @($fileA)
& $refuse 'expectedIdsRightKeysWrongOrder' { $script:ExpectedApproverKeyId = @($recB.keyId, $recA.keyId) } @($fileA, $fileB)
& $refuse 'expectedIdHelloForWebauthn' { $script:ExpectedApproverKeyId = @($recH.keyId) } @($fileA)
# the swapped file: the owner enrolled key A and saw its id; a program running as the owner then put a VALID record of key X under the same file name
$swapped = Save-KeyFile 'swapped.json' $recA
$swappedBefore = Get-ExpectedFor @($swapped)
$null = Save-KeyFile 'swapped.json' $recX
& $refuse 'swappedFile' { $script:ExpectedApproverKeyId = $swappedBefore } @($swapped)
& $refuse 'swappedOneOfTwo' { $script:ExpectedApproverKeyId = @($recA.keyId, $recB.keyId) } @($fileA, $swapped)
$tooMany = @(1..17 | ForEach-Object { Save-KeyFile ("many$_.json") (New-EcRecord) })
& $refuse 'seventeenFiles' { } $tooMany
$result.refusals = $refusals
$result.swappedExpected = $swappedBefore
$swappedNow = Get-ExpectedFor @($swapped)   # assigned first: the function returns , @(list)
$result.swappedNowHolds = $swappedNow
# the expected ids, when they match (position by position), let the run through
New-World -Store @($recH); $script:ExpectedApproverKeyId = @($recA.keyId, $recB.keyId)
$result.expectedOk = Invoke-Set @($fileA, $fileB)
# a file swapped AFTER the plan/check but before the write (while the service is being stopped) is caught by the second read: nothing is written
New-World -Store @($recH)
$swapLate = Save-KeyFile 'late.json' $recA
$lateExpected = Get-ExpectedFor @($swapLate)
$script:ExpectedApproverKeyId = $lateExpected
$script:OnStop = { $null = Save-KeyFile 'late.json' $recY }
$result.swappedWhileStopping = Invoke-Set @($swapLate)
$script:OnStop = $null
$null = Save-KeyFile 'late.json' $recA
# the confirmation, accepted: yes with blanks and a line break around it; and, in the lab VM only, the flag instead of a console
New-World -Store @($recH); $script:Console.Answer = "  yes `r`n"
$result.confirmBlanks = Invoke-Set @($fileA) -UseReplace
New-World -Store @($recH); $script:LabAssumeYes = $true; $env:ALBERA_LAB_VM = '1'; $script:Console.Interactive = $false
$result.labYes = Invoke-Set @($fileA) -UseReplace
$env:ALBERA_LAB_VM = $null
$result.realConsoleInteractive = $realConsoleInteractive

# ---- 10b. the status line about the approver keys, from the real Get-StatusLines (the machine facts it reads besides are faked away)
function Get-HyperVMemberProblems { , @() }
function Get-SetupRunIdFloor { $null }
function Read-AuthoritySigningKey([string]$KeyName, [string]$Scope = 'machine') { $null }
function Get-StatusKeyLines { $lines = Get-StatusLines; @($lines | Where-Object { $_.Text -like 'Authority approver keys*' } | ForEach-Object { $_.State + ' ' + $_.Text }) }
$realInvokeNative = ${function:Invoke-Native}
function Invoke-Native([string]$Exe, [string]$Arguments, [int]$TimeoutMs = 60000, [switch]$MinimalEnvironment) { [pscustomobject]@{ Exit = 0; Out = ''; Err = '' } }
New-World
$statusLegacy = Get-StatusKeyLines
$result.status = [ordered]@{ legacy = $statusLegacy }
$null = Invoke-Set @($fileA, $fileH) -UseReplace
$statusKeys = Get-StatusKeyLines
$result.status.keys = $statusKeys
$script:Manifest['values']['approverKeys'] = ConvertTo-ApproverKeysManifestValue @($recB)
$statusOtherRecord = Get-StatusKeyLines
$result.status.recordDiffers = $statusOtherRecord
$script:Manifest['values']['approverKeys'] = ConvertTo-ApproverKeysManifestValue @($recA, $recH)
Write-Text $L.AuthorityConfig $script:OldConfig
$statusConfigBack = Get-StatusKeyLines
$result.status.configIsLegacyAgain = $statusConfigBack
Write-Text $L.AuthorityConfig 'not json'
$statusBadConfig = Get-StatusKeyLines
$result.status.configGarbage = $statusBadConfig
${function:Invoke-Native} = $realInvokeNative

# ---- 10c. the key file path: a link on the way, a folder, the size limit, a path that is not plain
$realDir = Join-Path $Work 'real-keys'
New-Item -ItemType Directory -Force -Path $realDir | Out-Null
Copy-Item -LiteralPath $fileA -Destination (Join-Path $realDir 'a.json')
New-Junction (Join-Path $Work 'linked-keys') $realDir
Write-Text (Join-Path $realDir 'big.json') ('x' * ($K.MaxApproverKeyFileBytes + 1))
Write-Text (Join-Path $realDir 'limit.json') ('x' * $K.MaxApproverKeyFileBytes)
$fileCheck = { param($path) $x = Read-ApproverKeyFileBytes $path; [ordered]@{ ok = $x.Ok; reason = $x.Reason; length = $(if ($x.Ok) { $x.Bytes.Length } else { $null }) } }
$result.fileChecks = [ordered]@{
  direct = (& $fileCheck (Join-Path $realDir 'a.json'))
  viaJunction = (& $fileCheck (Join-Path $Work 'linked-keys\a.json'))
  folder = (& $fileCheck $realDir)
  missing = (& $fileCheck (Join-Path $realDir 'nope.json'))
  relative = (& $fileCheck 'keys\a.json')
  dotDot = (& $fileCheck ($realDir + '\..\real-keys\a.json'))
  overTheLimit = (& $fileCheck (Join-Path $realDir 'big.json'))
  atTheLimit = (& $fileCheck (Join-Path $realDir 'limit.json'))
  expectedLength = ([System.IO.File]::ReadAllBytes($fileA)).Length
}
Remove-Junction (Join-Path $Work 'linked-keys')
$result.fileChecks.targetIntact = [System.IO.File]::Exists((Join-Path $realDir 'a.json'))

# ---- 11. the plan: seven steps, the key ids and kinds, nothing changes
New-World -Store @($recH)
Use-KeyFiles @($fileA, $fileB); $script:Replace = $false; $script:SetApprover = New-SetApproverState; $script:Said.Clear(); $script:Order.Clear()
Show-Plan (Get-SetApproverSteps) 'set-approver'
$result.plan = [ordered]@{ lines = @($script:Said); order = @($script:Order); configSame = ((Read-Text $L.AuthorityConfig) -ceq $script:OldConfig); storeExists = [System.IO.File]::Exists($L.AuthorityKeyStore) }
# a plan of a key that is in force already says it would be refused
Use-KeyFiles @($fileH); $script:SetApprover = New-SetApproverState; $script:Said.Clear()
Show-Plan (Get-SetApproverSteps) 'set-approver'
$result.planRefused = @($script:Said)
Use-KeyFiles @($fileA, $fileB); $script:Replace = $true; $script:SetApprover = New-SetApproverState; $script:Said.Clear()
Show-Plan (Get-SetApproverSteps) 'set-approver'
$result.planReplace = @($script:Said)
$script:Replace = $false
$script:ManifestNote = 'cannot be read by this account'; $script:Manifest = $null; $script:Said.Clear(); $script:ApproverKeyRead = $null
Show-Plan (Get-SetApproverSteps) 'set-approver'
$result.planUnreadable = @($script:Said)

# ---- 12. install and migrate with key files: the approver step, the values, the config and the record
$script:ManifestNote = $null
New-World
$script:Manifest = New-Manifest
$nodeRecord = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $nodeRecord['serviceSid'] = $cpSid; $nodeRecord['nodeSha256'] = ('ab' * 32); $nodeRecord['nodeSource'] = 'C:\Program Files\nodejs\node.exe'
$claudeRecord = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $claudeRecord['sha256'] = ('cd' * 32); $claudeRecord['fileVersion'] = '2.1.310'; $claudeRecord['source'] = 'C:\Users\x\.local\bin\claude.exe'
$script:Manifest['created']['controlPlane'] = $nodeRecord; $script:Manifest['created']['claude'] = $claudeRecord
$ecc = New-Object System.Security.Cryptography.ECDsaCng(256)
try { $script:Manifest['values']['authoritySpki'] = ConvertTo-P256Spki ([byte[]]$ecc.Key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)) } finally { $ecc.Dispose() }
function Resolve-HostSids { $script:Sids = @{ Broker = (Get-DerivedServiceSid $K.BrokerService); Authority = (Get-DerivedServiceSid $K.AuthorityService); ControlPlane = $cpSid; Approver = $ownerSid; Legacy = $false } }
function Get-ApproverStepDef { Get-InstallSteps | Where-Object { $_.Id -eq 'approver' } }
Use-KeyFiles @($fileA, $fileH); $ApproverSid = $ownerSid
$step = Get-ApproverStepDef
$result.install = [ordered]@{ title = $step.Title; detail = @($step.Detail); test = (& $step.Test) }
$script:ApproverKeyRead = $null
$script:Said.Clear()
& $step.Do
$result.install.said = @($script:Said)
$result.install.approver = [ordered]@{ properties = @($script:Approver.PSObject.Properties | ForEach-Object { $_.Name }); sid = $script:Approver.approverSid; keys = @($script:Approver.approverKeys | ForEach-Object { $_.keyId }) }
$script:Said.Clear(); $script:Order.Clear(); $script:ConfigWrites.Clear()
New-Item -ItemType Directory -Force -Path $L.BrokerConfigDir, $L.ControlPlaneConfigDir | Out-Null
$result.install.writeError = Try-Run { Write-HostConfigs }
$result.install.writes = @($script:ConfigWrites.ToArray() | ForEach-Object { $_.file })
$authorityText = Read-Text $L.AuthorityConfig
$result.install.authorityConfig = $(if ($authorityText) { $authorityText | ConvertFrom-Json } else { $null })
$result.install.authorityReasons = Test-AuthorityConfigText $authorityText
$disk = Read-Manifest
$installedIds = Get-RecordedKeyIds $disk
$result.install.record = [ordered]@{ approverKeys = $installedIds; hasLegacyId = $disk['values'].ContainsKey('approverKeyId'); approverSid = $disk['values']['approverSid']; shape = (Test-ManifestShape $disk) }
# the step's refusals: no SID, a bad file, a key file with the old three values
$ApproverSid = $null; $script:ApproverKeyRead = $null
$result.install.noSid = & $step.Test
$ApproverSid = $ownerSid; Use-KeyFiles @($fileA, (Join-Path $keysDir 'missing.json'))
$result.install.badFile = & $step.Test
Use-KeyFiles @($fileA); $script:ExpectedApproverKeyId = @($recB.keyId)
$result.install.expectedDiffers = & $step.Test
# the expected ids are required with key files: none, or too few, is refused by the step (the command line refuses it earlier still)
$script:ExpectedApproverKeyId = @(); $script:ApproverKeyRead = $null
$result.install.expectedMissing = & $step.Test
Use-KeyFiles @($fileA, $fileB); $script:ExpectedApproverKeyId = @($recA.keyId); $script:ApproverKeyRead = $null
$result.install.expectedTooFew = & $step.Test
# a file swapped under its name after the enroll: the owner saw A's id, the file now holds X
$swappedInstall = Save-KeyFile 'swapped-install.json' $recA
Use-KeyFiles @($swappedInstall)
$null = Save-KeyFile 'swapped-install.json' $recX
$result.install.swappedFile = & $step.Test
$result.install.swappedFileDo = Try-Run { & $step.Do }
$null = Save-KeyFile 'swapped-install.json' $recA
$script:ApproverKeyRead = $null   # the plan's answer is kept per run; a new run reads the files again
$result.install.sameFileBack = & $step.Test
Use-KeyFiles @($fileA); $ApproverSid = $cpSid
$result.install.sidIsControlPlane = Try-Run { Set-ApproverValues }
$ApproverSid = $ownerSid
# legacy values: nothing changes for them
Use-KeyFiles @(); $ApproverKeyId = $legacyId; $ApproverPublicKey = $labApproverKey
$legacyStep = Get-ApproverStepDef
$result.legacy = [ordered]@{ detail = @($legacyStep.Detail).Count; test = (& $legacyStep.Test) }
& $legacyStep.Do
$result.legacy.approver = [ordered]@{ properties = @($script:Approver.PSObject.Properties | ForEach-Object { $_.Name }) }
$script:Manifest = New-Manifest; $script:Manifest['created']['controlPlane'] = $nodeRecord; $script:Manifest['created']['claude'] = $claudeRecord
$script:Manifest['values']['authoritySpki'] = (ConvertTo-P256Spki ([byte[]](New-Object System.Security.Cryptography.ECDsaCng(256)).Key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)))
$result.legacy.writeError = Try-Run { Write-HostConfigs }
$legacyText = Read-Text $L.AuthorityConfig
$result.legacy.authorityKeys = @(($legacyText | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $_.Name })
$result.legacy.recordKeys = @((Read-Manifest)['values'].Keys | Sort-Object)
$result.legacy.nothingBlank = Test-AuthorityConfigText $legacyText
# the install input with migrate: the SID comes from the old install, the keys from the files
$script:LegacyValues = [pscustomobject]@{ ApproverKeyId = $legacyId; ApproverPublicKey = $labApproverKey; ApproverSid = $ownerSid }
$ApproverKeyId = $null; $ApproverPublicKey = $null; $ApproverSid = $null
$script:ApproverKeyFile = @($fileA)
$withFiles = Get-ApproverInput
$script:ApproverKeyFile = @()
$withoutFiles = Get-ApproverInput
$result.migrateInput = [ordered]@{ withFiles = $withFiles; withoutFiles = $withoutFiles }
function Get-NodePinProblem { $null }; function Get-ClaudePinProblem { $null }; function Get-LegacyUnknownProblems { , @() }
function Get-ExpectedTreeHashState { [pscustomobject]@{ Ok = $true; Reason = ''; Value = ('a' * 64) } }
Use-KeyFiles @($fileA, (Join-Path $keysDir 'missing.json'))
$preflight = Get-MigratePreflightProblems   # assigned first: the function returns , @(list)
$result.migratePreflight = @($preflight | Where-Object { $_ -like 'approver key record rejected*' })
# migrate with a swapped file: the preflight (which reads the files again) refuses it before anything is stopped
$swappedMigrate = Save-KeyFile 'swapped-migrate.json' $recA
Use-KeyFiles @($swappedMigrate)
$null = Save-KeyFile 'swapped-migrate.json' $recY
$preflightSwapped = Get-MigratePreflightProblems
$result.migratePreflightSwapped = @($preflightSwapped | Where-Object { $_ -like 'approver key record rejected*' })
# and with no expected ids at all
$script:ExpectedApproverKeyId = @(); $script:ApproverKeyRead = $null
$preflightNoIds = Get-MigratePreflightProblems
$result.migratePreflightNoIds = @($preflightNoIds | Where-Object { $_ -like 'approver key record rejected*' })
ConvertTo-Json -InputObject $result -Compress -Depth 8
