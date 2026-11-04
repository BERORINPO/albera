# Test driver (Windows PowerShell 5.1, ASCII only, no admin): runs the PURE approver key helpers of scripts/host/albera-host-lib.ps1 on the cases the Node test made and prints one JSON object.
#   approver-keys-check.ps1 -CasesFile <json>
# The cases file holds: records (name, bytes as base64: the content of a key record file), sets (name, the record names to put in one key list), the names of the records the config cases use, and one RSA-2048 SPKI.
# Node makes every key (the reference crypto) and every expected answer; this script only reports what the installer's helpers say. The helpers return `, @(list)`: a list is always assigned as it is, never wrapped in @( ).
param([Parameter(Mandatory = $true)][string]$CasesFile)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\host\albera-host-lib.ps1')
$cases = [System.IO.File]::ReadAllText($CasesFile) | ConvertFrom-Json
$r = [ordered]@{}
$K = Get-HostConstants
$L = Get-HostLayout 'C:\Program Files' 'C:\ProgramData'

# ---- every record file
$parsed = @{}
$r.records = [ordered]@{}
foreach ($case in $cases.records) {
  $result = Read-ApproverKeyRecordBytes ([Convert]::FromBase64String($case.b64))
  $parsed[$case.name] = $result
  $r.records[$case.name] = [ordered]@{ ok = $result.Ok; reasons = @($result.Reasons); keyId = $(if ($result.Ok) { $result.Record.keyId } else { $null }); fields = $(if ($result.Ok) { @($result.Record.PSObject.Properties | ForEach-Object { $_.Name }) } else { @() }) }
}

# ---- key lists
$r.sets = [ordered]@{}
foreach ($set in $cases.sets) {
  $records = @($set.records | ForEach-Object { $parsed[$_].Record })
  $r.sets[$set.name] = Test-ApproverKeySet $records
}

# ---- the key store (authority\approver-keys.json): its shape and its records, judged by the same rules
$r.stores = [ordered]@{}
foreach ($case in $cases.stores) {
  $result = Read-ApproverKeyStoreBytes ([Convert]::FromBase64String($case.b64))
  $r.stores[$case.name] = [ordered]@{ ok = $result.Ok; reasons = @($result.Reasons); keyIds = @($result.Records | ForEach-Object { $_.keyId }) }
}

# ---- the final key list: the keys in force plus the given ones, or the given ones alone
$r.merges = [ordered]@{}
foreach ($case in $cases.merges) {
  $inForce = @($case.inForce | ForEach-Object { $parsed[$_].Record })
  $given = @($case.given | ForEach-Object { $parsed[$_].Record })
  $m = Get-SetApproverFinalKeys $inForce $given ([bool]$case.replace)
  $r.merges[$case.name] = [ordered]@{ ok = $m.Ok; reasons = @($m.Reasons); ids = @($m.Records | ForEach-Object { $_.keyId }); kept = @($m.Kept | ForEach-Object { $_.keyId }); added = @($m.Added | ForEach-Object { $_.keyId }); removed = @($m.Removed | ForEach-Object { $_.keyId }) }
}

# ---- the legacy pair as the one hello-rsa record it is read as
$r.legacyPairs = [ordered]@{}
foreach ($case in $cases.legacyPairs) {
  $c = ConvertFrom-LegacyApproverPair $case.keyId $case.publicKey
  $r.legacyPairs[$case.name] = [ordered]@{ ok = $c.Ok; reasons = @($c.Reasons); fields = $(if ($c.Ok) { @($c.Record.PSObject.Properties | ForEach-Object { $_.Name }) } else { @() }); kind = $(if ($c.Ok) { $c.Record.kind } else { $null }); alg = $(if ($c.Ok) { $c.Record.alg } else { $null }) }
}

# ---- the trust test for a file the Authority service wrote itself: its own SID may own it, nobody else beyond SYSTEM / Administrators / TrustedInstaller
$authoritySid = Get-DerivedServiceSid $K.AuthorityService
$userSid = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
$summary = { param($owner, $writers) [pscustomobject]@{ Owner = $owner; Protected = $false; AllowSids = @($writers); WriteSids = @($writers) } }
$r.trust = [ordered]@{
  authorityOwnerWithItsSid = Test-TrustSummary (& $summary $authoritySid @($authoritySid)) @($authoritySid) $false @($authoritySid)
  authorityOwnerWithoutTheAllowance = Test-TrustSummary (& $summary $authoritySid @($authoritySid)) @($authoritySid) $false
  userOwner = Test-TrustSummary (& $summary $userSid @($authoritySid)) @($authoritySid) $false @($authoritySid)
  systemOwner = Test-TrustSummary (& $summary 'S-1-5-18' @('S-1-5-18')) @($authoritySid) $false @($authoritySid)
  administratorsOwner = Test-TrustSummary (& $summary 'S-1-5-32-544' @('S-1-5-32-544', $authoritySid)) @($authoritySid) $false @($authoritySid)
  otherWriter = Test-TrustSummary (& $summary $authoritySid @($authoritySid, $userSid)) @($authoritySid) $false @($authoritySid)
  brokerSidOwner = Test-TrustSummary (& $summary (Get-DerivedServiceSid $K.BrokerService) @()) @($authoritySid) $false @($authoritySid)
}

# ---- Authority configs: the writer and the mirror of the Authority's rules
$sid = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
$cp = Get-DerivedServiceSid $K.ControlPlaneService
$good = @($cases.configRecords | ForEach-Object { $parsed[$_].Record })
$r.config = [ordered]@{}
$one = Get-AuthorityConfig $cp ([pscustomobject]@{ approverSid = $sid; approverKeys = @($good[0]) })
$all = Get-AuthorityConfig $cp ([pscustomobject]@{ approverSid = $sid; approverKeys = $good })
$oneJson = ConvertTo-HostJson $one
$allJson = ConvertTo-HostJson $all
$r.config.oneJson = $oneJson
$r.config.oneKeys = @($one.Keys)
$r.config.allKeys = @($all.Keys)
$r.config.oneReasons = Test-AuthorityConfigText $oneJson
$r.config.allReasons = Test-AuthorityConfigText $allJson
$r.config.allBytes = [System.Text.Encoding]::UTF8.GetByteCount($allJson)
$r.config.limitBytes = $K.AuthorityConfigMaxBytes
$legacy = [pscustomobject]@{ approverSid = $sid; approverKeyId = 'hello-0123456789abcdef'; approverPublicKey = $cases.rsa2048Spki }
$legacyJson = ConvertTo-HostJson (Get-AuthorityConfig $cp $legacy)
$r.config.legacyKeys = @((Get-AuthorityConfig $cp $legacy).Keys)
$r.config.legacyReasons = Test-AuthorityConfigText $legacyJson
$r.config.bothThrows = try { Get-AuthorityConfig $cp ([pscustomobject]@{ approverSid = $sid; approverKeyId = 'hello-0123456789abcdef'; approverPublicKey = $cases.rsa2048Spki; approverKeys = @($good[0]) }) | Out-Null; $false } catch { $_.Exception.Message }
$r.config.emptyListThrows = try { Get-AuthorityConfig $cp ([pscustomobject]@{ approverSid = $sid; approverKeys = @() }) | Out-Null; $false } catch { $_.Exception.Message }
# hand-made texts: the pair AND the list, a list that is not an array, an empty list, a bad record, one record twice, a stray field in a record, a bad value elsewhere, sizes
$r.config.pairAndList = Test-AuthorityConfigText ($oneJson -replace '"approverKeys":', '"approverKeyId":"hello-0123456789abcdef","approverKeys":')
$r.config.publicKeyAndList = Test-AuthorityConfigText ($oneJson -replace '"approverKeys":', ('"approverPublicKey":"' + $cases.rsa2048Spki + '","approverKeys":'))
$r.config.listIsObject = Test-AuthorityConfigText ($oneJson -replace '"approverKeys":\[(\{[^\]]*\})\]', '"approverKeys":$1')
$r.config.listEmpty = Test-AuthorityConfigText ($oneJson -replace '"approverKeys":\[\{[^\]]*\}\]', '"approverKeys":[]')
$r.config.listBadKeyId = Test-AuthorityConfigText ($oneJson -replace '"keyId":"webauthn-[0-9a-f]{16}"', '"keyId":"webauthn-0000000000000000"')
$r.config.listTwice = Test-AuthorityConfigText (ConvertTo-HostJson (Get-AuthorityConfig $cp ([pscustomobject]@{ approverSid = $sid; approverKeys = @($good[0], $good[0]) })))
$r.config.listExtraField = Test-AuthorityConfigText ($oneJson -replace '"approverKeys":\[\{', '"approverKeys":[{"extra":"x",')
$r.config.otherKeyStillChecked = Test-AuthorityConfigText ($oneJson -replace '"audience":"[^"]*"', '"audience":"Bad"')
$r.config.numberInsteadOfString = Test-AuthorityConfigText ($oneJson -replace '"policyVersion":"[^"]*"', '"policyVersion":5')
$r.config.tooBigLegacy = Test-AuthorityConfigText ($legacyJson -replace '"kid":"([^"]*)"', ('"kid":"$1","padding":"' + ('x' * 4200) + '"'))
$r.config.tooBigList = Test-AuthorityConfigText ($oneJson -replace '"kid":"([^"]*)"', ('"kid":"$1","padding":"' + ('x' * 33000) + '"'))
# what the config says about its keys (status and set-approver read this)
$fromList = Get-AuthorityConfigApproverKeys $allJson
$fromLegacy = Get-AuthorityConfigApproverKeys $legacyJson
$r.config.fromList = [ordered]@{ reasons = @($fromList.Reasons); legacy = $fromList.Legacy; keys = @($fromList.Keys | ForEach-Object { $_.KeyId + '|' + $_.Kind }); approverSid = $fromList.Approver.approverSid; recordCount = @($fromList.Approver.approverKeys).Count }
$r.config.fromLegacy = [ordered]@{ reasons = @($fromLegacy.Reasons); legacy = $fromLegacy.Legacy; keys = @($fromLegacy.Keys | ForEach-Object { $_.KeyId + '|' + $_.Kind }); approverSid = $fromLegacy.Approver.approverSid; hasList = ($null -ne $fromLegacy.Approver.PSObject.Properties['approverKeys']) }
$r.config.fromBad = @((Get-AuthorityConfigApproverKeys 'not json').Reasons)
# rebuilding a config from what it says about itself gives the same text (what set-approver relies on to call a config "the one install wrote")
$r.config.roundTripLegacy = ((ConvertTo-HostJson (Get-AuthorityConfig $cp $fromLegacy.Approver)) -ceq $legacyJson)
$r.config.roundTripList = ((ConvertTo-HostJson (Get-AuthorityConfig $cp $fromList.Approver)) -ceq $allJson)

# ---- the status line
function New-Dict([hashtable]$Entries) { $d = New-Object 'System.Collections.Generic.Dictionary[string,object]'; foreach ($k in $Entries.Keys) { $d[$k] = $Entries[$k] }; $d }
$recordLegacy = New-Dict @{ approverKeyId = 'hello-0123456789abcdef' }
$recordOtherLegacy = New-Dict @{ approverKeyId = 'hello-ffffffffffffffff' }
$recordList = New-Dict @{ approverKeys = (ConvertTo-ApproverKeysManifestValue $good) }
$recordShorter = New-Dict @{ approverKeys = (ConvertTo-ApproverKeysManifestValue @($good[0])) }
$recordNone = New-Dict @{}
$line = { param($json, $values) $l = Get-ApproverKeysStatusLine $json $values; [ordered]@{ state = $l.State; text = $l.Text } }
$r.status = [ordered]@{
  legacyOk = (& $line $legacyJson $recordLegacy)
  legacyOtherId = (& $line $legacyJson $recordOtherLegacy)
  listOk = (& $line $allJson $recordList)
  listVsShorterRecord = (& $line $allJson $recordShorter)
  listVsLegacyRecord = (& $line $allJson $recordLegacy)
  legacyVsListRecord = (& $line $legacyJson $recordList)
  noRecord = (& $line $allJson $recordNone)
  badConfig = (& $line 'nope' $recordList)
}

# ---- the install record's copy of the list, and the whole manifest shape with the new value keys
$mk = { param($entries) $list = foreach ($e in $entries) { $d = New-Object 'System.Collections.Generic.Dictionary[string,object]'; foreach ($p in $e.PSObject.Properties) { $d[$p.Name] = $p.Value }; $d }; , @($list) }
$entry = { param($id, $kind) [pscustomobject]@{ keyId = $id; kind = $kind } }
$v = '0123456789abcdef'
$r.manifestList = [ordered]@{
  good = Test-ApproverKeysManifestList (& $mk @((& $entry "webauthn-$v" 'webauthn'), (& $entry "hello-$v" 'hello-rsa')))
  empty = Test-ApproverKeysManifestList @()
  seventeen = Test-ApproverKeysManifestList (& $mk @(1..17 | ForEach-Object { & $entry "webauthn-$v" 'webauthn' }))
  sixteen = Test-ApproverKeysManifestList (& $mk @(1..16 | ForEach-Object { & $entry "webauthn-$v" 'webauthn' }))
  unknownKind = Test-ApproverKeysManifestList (& $mk @((& $entry "webauthn-$v" 'fido')))
  prefixDisagrees = Test-ApproverKeysManifestList (& $mk @((& $entry "hello-$v" 'webauthn')))
  shortId = Test-ApproverKeysManifestList (& $mk @((& $entry 'webauthn-0123' 'webauthn')))
  upperId = Test-ApproverKeysManifestList (& $mk @((& $entry 'webauthn-0123456789ABCDEF' 'webauthn')))
  extraField = Test-ApproverKeysManifestList (& $mk @([pscustomobject]@{ keyId = "webauthn-$v"; kind = 'webauthn'; credentialId = 'x' }))
  notAList = Test-ApproverKeysManifestList 'webauthn-0123456789abcdef'
}
function New-ManifestLike {
  $created = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $created['dataRoot'] = $true; $created['installRoot'] = $false; $created['services'] = @(); $created['binaries'] = (New-Object 'System.Collections.Generic.Dictionary[string,object]')
  $values = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $m = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $m['schema'] = 1; $m['tool'] = 'albera-host.ps1'; $m['state'] = 'complete'; $m['startedAt'] = '2026-11-04T00:00:00Z'; $m['updatedAt'] = '2026-11-04T00:00:00Z'; $m['created'] = $created; $m['values'] = $values
  $m
}
$shape = { param($mutate) $m = New-ManifestLike; & $mutate $m; $reasons = Test-ManifestShape $m; , @($reasons) }
$r.manifestShape = [ordered]@{
  plain = (& $shape { param($m) })
  withList = (& $shape { param($m) $m['values']['approverKeys'] = ConvertTo-ApproverKeysManifestValue $good; $m['values']['approverKeysSetAt'] = '2026-11-04T12:30:00Z' })
  badList = (& $shape { param($m) $m['values']['approverKeys'] = (& $mk @((& $entry "webauthn-$v" 'fido'))) })
  badSetAt = (& $shape { param($m) $m['values']['approverKeysSetAt'] = 'yesterday' })
  setAtNumber = (& $shape { param($m) $m['values']['approverKeysSetAt'] = 5 })
  otherValueKey = (& $shape { param($m) $m['values']['somethingElse'] = 'x' })
}

# ---- uninstall knows the key store file (a service that ran leaves it behind in the authority folder)
$known = Get-KnownDataFiles
$r.known = [ordered]@{
  storeListed = ($known -contains 'authority\approver-keys.json')
  storePath = $L.AuthorityKeyStore
  storeUnderAuthorityDir = $L.AuthorityKeyStore.StartsWith($L.AuthorityDir + '\')
  unknown = Get-UnknownEntries @('authority\approver-keys.json', 'authority\policy.json', 'authority\approver-keys.json.bak', 'authority\approver-keys.tmp') $known (Get-KnownDataFolders)
}
ConvertTo-Json -InputObject $r -Depth 8 -Compress
