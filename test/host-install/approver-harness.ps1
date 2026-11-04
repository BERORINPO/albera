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
$ExpectedTreeHash = $null; $ApproverKeyId = $null; $ApproverPublicKey = $null; $ApproverSid = $null; $ApproverKeyFile = @(); $ExpectedApproverKeyId = @()
$VmName = 'albera-clone-01'; $ComputerId = 'clone-01'; $ProjectId = 'albera-host'; $GrantHyperVToBroker = $false; $SetupRunId = $null; $TrustLocalBuilds = $false
function Try-Run([scriptblock]$Block) { try { & $Block | Out-Null; $null } catch { $_.Exception.Message } }
function New-Junction([string]$Link, [string]$Target) { New-Item -ItemType Directory -Force -Path $Target | Out-Null; $null = & cmd.exe /c mklink /J ('"' + $Link + '"') ('"' + $Target + '"') }
function Remove-Junction([string]$Link) { $null = & cmd.exe /c rmdir ('"' + $Link + '"') }
function Write-Text([string]$Path, [string]$Text) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null; [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false))) }
function Read-Text([string]$Path) { if ([System.IO.File]::Exists($Path)) { [System.IO.File]::ReadAllText($Path) } else { $null } }
function Get-TextHash([string]$Text) { if ($null -eq $Text) { return $null }; $sha = [System.Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() } }

# ---- the keys: record files in -Work\keys, made here (an ES256 key per file; the hello-rsa record is the lab's throw-away RSA-2048 key)
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
$recA = New-EcRecord; $recB = New-EcRecord; $recH = New-HelloRecord
$fileA = Save-KeyFile 'a.json' $recA; $fileB = Save-KeyFile 'b.json' $recB; $fileH = Save-KeyFile 'h.json' $recH
$legacyId = 'hello-0123456789abcdef'

# ---- the fake machine: the SCM (a service is Running or Stopped), the trusted config write, the clock of the settle wait
function Get-PathTrustReasons { , @() }   # the temp folders belong to this user; the real trust test has its own cases in function-harness.ps1
$origChain = ${function:Get-ReparseChain}
function Get-ReparseChain([string]$Path) { $c = & $origChain $Path; , @($c | Where-Object { $_.Length -ge $Work.Length -and $_.StartsWith($Work, [System.StringComparison]::OrdinalIgnoreCase) }) }   # only links inside -Work count (the temp root may be one)
$script:Said = New-Object 'System.Collections.Generic.List[string]'
function Say([string]$Text) { $script:Said.Add($Text) }
$script:Order = New-Object 'System.Collections.Generic.List[string]'
$script:ConfigWrites = New-Object 'System.Collections.Generic.List[object]'
$script:StartSnapshots = New-Object 'System.Collections.Generic.List[object]'
$script:Svc = @{}
$script:WrongPath = $false; $script:StopFails = $false; $script:StartMode = 'works'; $script:OldAuthorityBuild = $false; $script:AuthorityNeverStarts = $false
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
# the fake SCM. A start reads the config file as the service would: an OLD Authority build ($OldAuthorityBuild) refuses a config with approverKeys; a refused start either throws (sc.exe error) or leaves the service stopped.
function Invoke-Sc([string]$Arguments) {
  $script:Order.Add('sc ' + $Arguments)
  $t = $Arguments -split ' '; $name = $t[1]
  if ($t[0] -eq 'stop') { if ($script:StopFails) { throw 'sc.exe failed (exit 1052): fake, the service cannot be stopped' }; $script:Svc[$name].state = 'Stopped' }
  if ($t[0] -eq 'start') {
    $text = Read-Text $L.AuthorityConfig
    $script:StartSnapshots.Add([ordered]@{ configHasList = ($text -like '*"approverKeys"*'); configHasPair = ($text -like '*"approverKeyId"*'); storeExists = [System.IO.File]::Exists($L.AuthorityKeyStore) })
    $refused = $script:AuthorityNeverStarts -or ($script:OldAuthorityBuild -and ($text -like '*"approverKeys"*'))
    if ($refused) { if ($script:StartMode -eq 'throws') { throw 'sc.exe failed (exit 1053): fake, the service did not respond' }; $script:Svc[$name].state = 'Stopped' }
    else { $script:Svc[$name].state = 'Running' }
  }
  [pscustomobject]@{ Exit = 0; Out = ''; Err = '' }
}
# the trusted write path, as a plain write that records what the world looked like at that moment
function Write-OneConfig([string]$Path, [string]$Text, [string[]]$Writers) {
  $script:Order.Add('write ' + (Split-Path -Leaf $Path))
  $state = if ($script:Svc.ContainsKey($K.AuthorityService)) { $script:Svc[$K.AuthorityService].state } else { $null }
  $script:ConfigWrites.Add([ordered]@{ file = (Split-Path -Leaf $Path); serviceState = $state; storeExists = [System.IO.File]::Exists($L.AuthorityKeyStore); writers = @($Writers) })
  Write-Text $Path $Text
}

# ---- an installed world: a complete record, the Authority config with the legacy Hello pair, a key store the Authority made, files beside it, three services
$script:OldConfig = $null
function New-World([string]$AuthorityState = 'Running') {
  if (Test-Path -LiteralPath $L.DataRoot) { Remove-Item -LiteralPath $L.DataRoot -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $L.AuthorityDir | Out-Null
  $legacy = [pscustomobject]@{ approverSid = $ownerSid; approverKeyId = $legacyId; approverPublicKey = $labApproverKey }
  $script:OldConfig = ConvertTo-HostJson (Get-AuthorityConfig $cpSid $legacy)
  Write-Text $L.AuthorityConfig $script:OldConfig
  Write-Text $L.AuthorityKeyStore '{"v":1,"revision":3,"keys":[],"signCounts":{}}'
  Write-Text (Join-Path $L.AuthorityDir 'policy.json') '{"policy":"kept"}'
  Write-Text (Join-Path $L.AuthorityDir 'notes.txt') 'kept'
  $script:Manifest = New-Manifest
  $script:Manifest['state'] = 'complete'
  $script:Manifest['created']['services'] = @($K.BrokerService, $K.AuthorityService, $K.ControlPlaneService)
  $values = $script:Manifest['values']
  $values['approverSid'] = $ownerSid; $values['approverKeyId'] = $legacyId; $values['controlPlaneSid'] = $cpSid
  Save-Manifest
  $script:ManifestNote = $null; $script:Sids = $null; $script:Approver = $null; $script:LegacyValues = $null
  $script:Svc = @{}
  foreach ($n in @($K.BrokerService, $K.AuthorityService, $K.ControlPlaneService)) { $script:Svc[$n] = @{ state = 'Running' } }
  $script:Svc[$K.AuthorityService].state = $AuthorityState
  $script:WrongPath = $false; $script:StopFails = $false; $script:StartMode = 'works'; $script:OldAuthorityBuild = $false; $script:AuthorityNeverStarts = $false
  $script:Order.Clear(); $script:ConfigWrites.Clear(); $script:StartSnapshots.Clear(); $script:Said.Clear()
  $script:ExpectedApproverKeyId = @()
}
# runs -Mode set-approver for these files and reports what is observable
function Invoke-Set([string[]]$Files) {
  $script:ApproverKeyFile = $Files
  $script:ApproverKeyRead = $null
  $script:ExitCode = $null
  $script:SetApprover = New-SetApproverState
  $script:Order.Clear(); $script:ConfigWrites.Clear(); $script:StartSnapshots.Clear(); $script:Said.Clear()
  $out = [ordered]@{}
  $out.error = Try-Run { $script:ExitCode = Invoke-SetApprover }
  $out.exit = $script:ExitCode
  $out.order = @($script:Order)
  $out.said = @($script:Said)
  $out.writes = $script:ConfigWrites.ToArray()
  $out.starts = $script:StartSnapshots.ToArray()
  $out.service = $script:Svc[$K.AuthorityService].state
  $out.config = Read-Text $L.AuthorityConfig
  $out.configIsOld = ($out.config -ceq $script:OldConfig)
  $out.storeExists = [System.IO.File]::Exists($L.AuthorityKeyStore)
  $out.folder = @(Get-ChildItem -LiteralPath $L.AuthorityDir -Force | ForEach-Object { $_.Name } | Sort-Object)
  $disk = Read-Manifest
  $recordedIds = Get-RecordedKeyIds $disk
  $out.record = [ordered]@{
    approverKeys = $recordedIds; hasLegacyId = $disk['values'].ContainsKey('approverKeyId'); setAt = $(if ($disk['values'].ContainsKey('approverKeysSetAt')) { $disk['values']['approverKeysSetAt'] } else { $null })
    approverSid = $disk['values']['approverSid']; shape = (Test-ManifestShape $disk); manifestHash = (Get-TextHash ([System.IO.File]::ReadAllText($L.ManifestPath)))
  }
  $out
}
# the ids and kinds the install record on disk holds, always as an array (a one-element result must not turn into a plain string)
function Get-RecordedKeyIds($Disk) {
  $ids = @()
  if ($Disk['values'].ContainsKey('approverKeys')) { $ids = @($Disk['values']['approverKeys'] | ForEach-Object { $_['keyId'] + '|' + $_['kind'] }) }
  , $ids
}
$result = [ordered]@{ ids = [ordered]@{ a = $recA.keyId; b = $recB.keyId; h = $recH.keyId; legacy = $legacyId }; ownerSid = $ownerSid; cpSid = $cpSid; authoritySid = (Get-DerivedServiceSid $K.AuthorityService); authorityDir = $L.AuthorityDir; storePath = $L.AuthorityKeyStore }

# ---- 1. legacy install -> one WebAuthn key, the service running
New-World
$result.beforeManifestHash = Get-TextHash ([System.IO.File]::ReadAllText($L.ManifestPath))
$result.one = Invoke-Set @($fileA)
$result.oneConfig = $(if ($result.one.config) { $result.one.config | ConvertFrom-Json } else { $null })
$result.oneStatus = $(if ($result.one.config) { $statusLine = Get-ApproverKeysStatusLine $result.one.config (Read-Manifest)['values']; [ordered]@{ state = $statusLine.State; text = $statusLine.Text } } else { $null })
$result.oneConfigReasons = Test-AuthorityConfigText $result.one.config
$oldObject = $script:OldConfig | ConvertFrom-Json
$result.oneOtherFieldsSame = (@('pipeRoot', 'controlPlaneSid', 'approverSid', 'signingKeyName', 'signingKeyProvider', 'kid', 'audience', 'policyVersion') | Where-Object { $result.oneConfig.$_ -cne $oldObject.$_ }).Count -eq 0
# ---- 2. the same files again: everything is in place, nothing happens
$result.again = Invoke-Set @($fileA)
# ---- 3. two files (a WebAuthn key and the Hello key), from a legacy world: the order of the files is the order of the list
New-World
$result.two = Invoke-Set @($fileA, $fileH)
$result.twoKeys = $(if ($result.two.config) { @(($result.two.config | ConvertFrom-Json).approverKeys | ForEach-Object { $_.keyId }) } else { @() })
# ---- 4. the service is not running: the config changes, nothing is stopped or started
New-World 'Stopped'
$result.stopped = Invoke-Set @($fileA)
# ---- 5. the installed Authority build does not read approverKeys (it dies at start): the old config goes back, the service runs again, nothing is recorded
foreach ($howItFails in @('dies', 'throws')) {
  New-World; $script:OldAuthorityBuild = $true; $script:StartMode = $howItFails
  $result["oldBuild_$howItFails"] = Invoke-Set @($fileA)
}
# ... and an Authority that does not start at all, with the old config either
New-World; $script:AuthorityNeverStarts = $true; $script:StartMode = 'dies'
$result.neverStarts = Invoke-Set @($fileA)
# ---- 5b. a run that was cut off after the config was written (the record and the key store are still the old ones): the next run finishes the job without writing the config again
New-World
$null = Invoke-Set @($fileA)
$script:Manifest['values'].Remove('approverKeys') | Out-Null; $script:Manifest['values'].Remove('approverKeysSetAt') | Out-Null; $script:Manifest['values']['approverKeyId'] = $legacyId; Save-Manifest
Write-Text $L.AuthorityKeyStore '{"v":1,"revision":9,"keys":[],"signCounts":{}}'
$result.resumed = Invoke-Set @($fileA)
# ... and when the Authority will not start with that config, there is no "old" config to put back, and the run says so
New-World
$null = Invoke-Set @($fileA)
$script:Manifest['values'].Remove('approverKeys') | Out-Null; $script:Manifest['values'].Remove('approverKeysSetAt') | Out-Null; $script:Manifest['values']['approverKeyId'] = $legacyId; Save-Manifest
$script:AuthorityNeverStarts = $true; $script:StartMode = 'dies'
$result.resumedNeverStarts = Invoke-Set @($fileA)
# ---- 6. the service will not stop: nothing is changed
New-World; $script:StopFails = $true
$result.stopFails = Invoke-Set @($fileA)
# ---- 7. the key store cannot be deleted (it is held open): the config goes back, the service runs again, nothing is recorded
New-World
$held = New-Object System.IO.FileStream($L.AuthorityKeyStore, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
try { $result.storeHeld = Invoke-Set @($fileA) } finally { $held.Dispose() }
# ---- 8. the key store is not a plain file: refused before anything is touched
New-World
Remove-Item -LiteralPath $L.AuthorityKeyStore -Force
New-Item -ItemType Directory -Force -Path $L.AuthorityKeyStore | Out-Null; Write-Text (Join-Path $L.AuthorityKeyStore 'inside.txt') 'precious'
$result.storeIsFolder = Invoke-Set @($fileA)
$result.storeFolderIntact = [System.IO.File]::Exists((Join-Path $L.AuthorityKeyStore 'inside.txt'))
New-World
Remove-Item -LiteralPath $L.AuthorityKeyStore -Force
$linkTarget = Join-Path $Work 'link-target'; Write-Text (Join-Path $linkTarget 'precious.txt') 'precious'
New-Junction $L.AuthorityKeyStore $linkTarget
$result.storeIsJunction = Invoke-Set @($fileA)
$result.junctionTargetIntact = [System.IO.File]::Exists((Join-Path $linkTarget 'precious.txt'))
Remove-Junction $L.AuthorityKeyStore
# no key store at all: the step is skipped and the run still works
New-World
Remove-Item -LiteralPath $L.AuthorityKeyStore -Force
$result.noStore = Invoke-Set @($fileA)
# ---- 9. Remove-ApproverKeyStore touches only that one file
New-World
Write-Text (Join-Path $L.AuthorityDir 'approver-keys.json.bak') 'x'; Write-Text (Join-Path $L.AuthorityDir 'approver-keys.tmp') 'x'; Write-Text (Join-Path $L.AuthorityDir 'sub\approver-keys.json') 'x'; Write-Text (Join-Path $L.DataRoot 'approver-keys.json') 'x'
$result.removeStore = [ordered]@{
  first = (Remove-ApproverKeyStore); second = (Remove-ApproverKeyStore)
  left = @(Get-ChildItem -LiteralPath $L.DataRoot -Recurse -Force | Where-Object { -not $_.PSIsContainer } | ForEach-Object { $_.FullName.Substring($L.DataRoot.Length + 1) } | Sort-Object)
}
# ---- 10. refusals: each leaves the world exactly as it was
$refusals = [ordered]@{}
$refuse = {
  param($name, [scriptblock]$Setup, [string[]]$Files)
  New-World
  & $Setup
  $before = [ordered]@{ config = (Read-Text $L.AuthorityConfig); manifest = (Get-TextHash ([System.IO.File]::ReadAllText($L.ManifestPath))); store = (Read-Text $L.AuthorityKeyStore) }
  $run = Invoke-Set $Files
  $refusals[$name] = [ordered]@{ error = $run.error; sc = @($run.order | Where-Object { $_ -like 'sc *' }).Count; writes = @($run.writes).Count; configSame = ($run.config -ceq $before.config); manifestSame = ($run.record.manifestHash -ceq $before.manifest); storeSame = ((Read-Text $L.AuthorityKeyStore) -ceq $before.store); service = $run.service }
}
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
& $refuse 'expectedIdsDiffer' { $script:ExpectedApproverKeyId = @($recB.keyId) } @($fileA)
& $refuse 'expectedIdsMissingOne' { $script:ExpectedApproverKeyId = @($recA.keyId) } @($fileA, $fileB)
$tooMany = @(1..17 | ForEach-Object { Save-KeyFile ("many$_.json") (New-EcRecord) })
& $refuse 'seventeenFiles' { } $tooMany
$result.refusals = $refusals
# the expected ids, when they match (in any order), let the run through
New-World; $script:ExpectedApproverKeyId = @($recB.keyId, $recA.keyId)
$result.expectedOk = Invoke-Set @($fileA, $fileB)

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
$null = Invoke-Set @($fileA, $fileH)
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
New-World
$script:ApproverKeyFile = @($fileA, $fileH); $script:ApproverKeyRead = $null; $script:SetApprover = New-SetApproverState; $script:Said.Clear(); $script:Order.Clear()
Show-Plan (Get-SetApproverSteps) 'set-approver'
$result.plan = [ordered]@{ lines = @($script:Said); order = @($script:Order); configSame = ((Read-Text $L.AuthorityConfig) -ceq $script:OldConfig); storeExists = [System.IO.File]::Exists($L.AuthorityKeyStore) }
$script:ManifestNote = 'cannot be read by this account'; $script:Manifest = $null; $script:Said.Clear()
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
$script:ExpectedApproverKeyId = @()
$script:ApproverKeyFile = @($fileA, $fileH); $script:ApproverKeyRead = $null; $ApproverSid = $ownerSid
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
$ApproverSid = $ownerSid; $script:ApproverKeyFile = @($fileA, (Join-Path $keysDir 'missing.json')); $script:ApproverKeyRead = $null
$result.install.badFile = & $step.Test
$script:ApproverKeyFile = @($fileA); $script:ApproverKeyRead = $null; $script:ExpectedApproverKeyId = @($recB.keyId)
$result.install.expectedDiffers = & $step.Test
$script:ExpectedApproverKeyId = @()
$script:ApproverKeyFile = @($fileA); $script:ApproverKeyRead = $null; $ApproverSid = $cpSid
$result.install.sidIsControlPlane = Try-Run { Set-ApproverValues }
$ApproverSid = $ownerSid
# legacy values: nothing changes for them
$script:ApproverKeyFile = @(); $script:ApproverKeyRead = $null; $ApproverKeyId = $legacyId; $ApproverPublicKey = $labApproverKey
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
$script:ApproverKeyFile = @($fileA, (Join-Path $keysDir 'missing.json')); $script:ApproverKeyRead = $null
$preflight = Get-MigratePreflightProblems   # assigned first: the function returns , @(list)
$result.migratePreflight = @($preflight | Where-Object { $_ -like 'approver key record rejected*' })
ConvertTo-Json -InputObject $result -Compress -Depth 8
