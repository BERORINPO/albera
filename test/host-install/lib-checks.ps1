# Test driver (Windows PowerShell 5.1, ASCII only, no admin): calls the PURE helpers of scripts/host/albera-host-lib.ps1 and prints one JSON object.
# The Node test (test/host-install.test.mjs) feeds it keys made by Node and checks the answers against the C# rules and Node's own crypto.
param(
  [Parameter(Mandatory = $true)][string]$EcX,           # base64url x of a P-256 public key made by Node
  [Parameter(Mandatory = $true)][string]$EcY,
  [Parameter(Mandatory = $true)][string]$EcSpki,        # the same key as SPKI (Node's export)
  [Parameter(Mandatory = $true)][string]$Rsa2048Spki,
  [Parameter(Mandatory = $true)][string]$Rsa3072Spki
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\host\albera-host-lib.ps1')
function FromB64Url([string]$s) { $s = $s.Replace('-', '+').Replace('_', '/'); while ($s.Length % 4) { $s += '=' }; , [Convert]::FromBase64String($s) }
function Count($x) { @($x).Count }

Add-Type -AssemblyName System.Web.Extensions
$r = [ordered]@{}
$K = Get-HostConstants
$L = Get-HostLayout 'C:\Program Files' 'C:\ProgramData'
$r.layout = $L
$r.constants = $K

# ---- service SIDs: the TrustedInstaller vector is the one the C# harness pins for DeriveServiceSid
$r.sidTrustedInstaller = Get-DerivedServiceSid 'TrustedInstaller'
$r.sidCaseInsensitive = ((Get-DerivedServiceSid 'AlberaHostBroker') -eq (Get-DerivedServiceSid 'ALBERAHOSTBROKER'))
$r.sidBroker = Get-DerivedServiceSid $K.BrokerService
$r.sidAuthority = Get-DerivedServiceSid $K.AuthorityService

# ---- SPKI: built from x / y exactly as the machine key's EccPublicBlob would be
$blob = New-Object byte[] 72
[BitConverter]::GetBytes([uint32]0x31534345).CopyTo($blob, 0); [BitConverter]::GetBytes([uint32]32).CopyTo($blob, 4)
(FromB64Url $EcX).CopyTo($blob, 8); (FromB64Url $EcY).CopyTo($blob, 40)
$r.spkiBuilt = ConvertTo-P256Spki $blob
$r.spkiMatchesNode = ($r.spkiBuilt -eq $EcSpki)
$r.spkiRoundTripBlob = ([Convert]::ToBase64String((ConvertFrom-P256Spki $EcSpki)) -eq [Convert]::ToBase64String($blob))
$r.p256Accepts = @((Test-P256Spki $EcSpki), (Test-P256Spki $r.spkiBuilt))
$r.p256Rejects = @((Test-P256Spki $Rsa2048Spki), (Test-P256Spki ''), (Test-P256Spki 'not base64!'), (Test-P256Spki ($EcSpki.Substring(0, $EcSpki.Length - 4))))
$bad = New-Object byte[] 72; $blob.CopyTo($bad, 0); [BitConverter]::GetBytes([uint32]1).CopyTo($bad, 0)
$r.badBlobRefused = try { ConvertTo-P256Spki $bad | Out-Null; $false } catch { $true }
$r.rsaAccepts = Test-Rsa2048Spki $Rsa2048Spki
$r.rsaRejects = @((Test-Rsa2048Spki $Rsa3072Spki), (Test-Rsa2048Spki $EcSpki), (Test-Rsa2048Spki ''))

# ---- approver values (passed as parameters by the owner)
$shown = [pscustomobject]@{ approverPublicKey = $Rsa2048Spki; approverKeyId = 'hello-0123456789abcdef'; approverSid = 'S-1-5-21-1111111111-2222222222-3333333333-1001' }
$r.shown = $shown
$cp = 'S-1-5-21-1111111111-2222222222-3333333333-1500'
$r.approverOk = Count (Test-ApproverValues $shown 'hello-0123456789abcdef' $cp)
$r.approverWrongId = Test-ApproverValues $shown 'hello-other' $cp
$r.approverSameSid = Test-ApproverValues ([pscustomobject]@{ approverPublicKey = $shown.approverPublicKey; approverKeyId = $shown.approverKeyId; approverSid = $cp }) 'hello-0123456789abcdef' $cp
$r.approverVirtualSid = Test-ApproverValues ([pscustomobject]@{ approverPublicKey = $shown.approverPublicKey; approverKeyId = $shown.approverKeyId; approverSid = (Get-DerivedServiceSid 'X') }) 'hello-0123456789abcdef' $cp
$r.approverGroupSid = Test-ApproverValues ([pscustomobject]@{ approverPublicKey = $shown.approverPublicKey; approverKeyId = $shown.approverKeyId; approverSid = 'S-1-5-32-544' }) 'hello-0123456789abcdef' $cp
$r.approverBadKey = Test-ApproverValues ([pscustomobject]@{ approverPublicKey = $Rsa3072Spki; approverKeyId = $shown.approverKeyId; approverSid = $shown.approverSid }) 'hello-0123456789abcdef' $cp

# ---- the three config files
$brokerObj = Get-BrokerConfig $L $cp $EcSpki
$authorityObj = Get-AuthorityConfig $cp $shown
$settingsObj = Get-ControlPlaneSettings $L 'albera-host' 'albera-clone-01' 'clone-01'
$brokerJson = ConvertTo-HostJson $brokerObj
$authorityJson = ConvertTo-HostJson $authorityObj
$r.brokerJson = $brokerJson
$r.authorityJson = $authorityJson
$r.settingsJson = ConvertTo-HostJson $settingsObj
$r.brokerReasons = Test-BrokerConfigText $brokerJson
$r.authorityReasons = Test-AuthorityConfigText $authorityJson
$r.brokerBad = [ordered]@{
  extraKey = Test-BrokerConfigText ($brokerJson -replace '^\{', '{"extra":"x",')
  missingKey = Test-BrokerConfigText ($brokerJson -replace ',"policyVersion":"[^"]*"', '')
  relativeDb = Test-BrokerConfigText ($brokerJson -replace 'C:\\\\ProgramData\\\\Albera\\\\broker\\\\journal.sqlite', 'broker\\journal.sqlite')
  slashDb = Test-BrokerConfigText ($brokerJson -replace 'C:\\\\ProgramData\\\\Albera\\\\broker\\\\journal.sqlite', 'C:/ProgramData/Albera/journal.sqlite')
  groupSid = Test-BrokerConfigText ($brokerJson -replace 'S-1-5-21-[0-9-]+', 'S-1-5-32-545')
  allServicesSid = Test-BrokerConfigText ($brokerJson -replace 'S-1-5-21-[0-9-]+', 'S-1-5-80-0')
  generationZero = Test-BrokerConfigText ($brokerJson -replace '"generation":1', '"generation":0')
  rsaKey = Test-BrokerConfigText ((ConvertTo-HostJson (Get-BrokerConfig $L $cp $Rsa2048Spki)))
  badPipe = Test-BrokerConfigText ($brokerJson -replace 'ALBERA_HostBroker', '..\\evil')
  notJson = Test-BrokerConfigText 'nope'
  tooBig = Test-BrokerConfigText ('{"a":"' + ('x' * 5000) + '"}')
}
$r.authorityBad = [ordered]@{
  sameSid = Test-AuthorityConfigText ($authorityJson -replace '"controlPlaneSid":"[^"]*"', ('"controlPlaneSid":"' + $shown.approverSid + '"'))
  approverVirtual = Test-AuthorityConfigText ($authorityJson -replace '"approverSid":"[^"]*"', ('"approverSid":"' + (Get-DerivedServiceSid 'X') + '"'))
  pipeRootLower = Test-AuthorityConfigText ($authorityJson -replace 'ALBERA\\\\ApprovalAuthority', 'albera\\ApprovalAuthority')
  providerOther = Test-AuthorityConfigText ($authorityJson -replace '"signingKeyProvider":"software"', '"signingKeyProvider":"file"')
  audienceUpper = Test-AuthorityConfigText ($authorityJson -replace 'albera-host-broker', 'Albera')
  numberValue = Test-AuthorityConfigText ($authorityJson -replace '"policyVersion":"[^"]*"', '"policyVersion":5')
  ecApproverKey = Test-AuthorityConfigText ($authorityJson -replace '"approverPublicKey":"[^"]*"', ('"approverPublicKey":"' + $EcSpki + '"'))
  extraKey = Test-AuthorityConfigText ($authorityJson -replace '^\{', '{"attestationKeyId":"x",')
}
$r.policyVersionsEqual = ($brokerObj.policyVersion -eq $authorityObj.policyVersion)
$r.brokerKeys = @($brokerObj.Keys)
$r.authorityKeys = @($authorityObj.Keys)
# the list form of the Authority config (approverKeys instead of the pair): one webauthn record built on the P-256 key Node made
$listRecord = ConvertTo-ApproverKeyObject ([pscustomobject]@{ keyId = (Get-ApproverKeyIdFor 'webauthn' ([Convert]::FromBase64String($EcSpki))); kind = 'webauthn'; alg = -7; publicKey = $EcSpki; credentialId = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' })
$authorityListObj = Get-AuthorityConfig $cp ([pscustomobject]@{ approverSid = $shown.approverSid; approverKeys = @($listRecord) })
$r.authorityListJson = ConvertTo-HostJson $authorityListObj
$r.authorityListReasons = Test-AuthorityConfigText $r.authorityListJson

# ---- ACL plan
$sids = @{ Broker = (Get-DerivedServiceSid $K.BrokerService); Authority = (Get-DerivedServiceSid $K.AuthorityService); ControlPlane = $cp }
$plan = Get-AclPlan $L $sids
$r.aclPlan = @($plan | ForEach-Object { [ordered]@{ path = $_.Path; grants = @($_.Grants) } })
$entry = $plan | Where-Object { $_.Path -eq $L.BrokerDbDir }
$good = [pscustomobject]@{ Owner = 'S-1-5-32-544'; Protected = $true; AllowSids = @(Get-GrantedSids $entry) }
$r.aclGood = Count (Test-AclMatchesPlan $entry $good)
$r.aclInherited = Test-AclMatchesPlan $entry ([pscustomobject]@{ Owner = $good.Owner; Protected = $false; AllowSids = $good.AllowSids })
$r.aclEveryone = Test-AclMatchesPlan $entry ([pscustomobject]@{ Owner = $good.Owner; Protected = $true; AllowSids = @($good.AllowSids + 'S-1-1-0') })
$r.aclMissing = Test-AclMatchesPlan $entry ([pscustomobject]@{ Owner = $good.Owner; Protected = $true; AllowSids = @('S-1-5-18') })
$r.aclOwnerUser = Test-AclMatchesPlan $entry ([pscustomobject]@{ Owner = $cp; Protected = $true; AllowSids = $good.AllowSids })

# ---- services
$r.brokerCommandLine = Get-ServiceCommandLine $L.BrokerExe $L.BrokerConfig
$r.scCreate = Get-ScCreateArguments $K.BrokerService $L.BrokerExe $L.BrokerConfig
$sddl = Get-BrokerServiceSddl $cp
$r.sddl = $sddl
$r.sddlOk = Count (Test-ServiceSdMatches $sddl $cp)
$r.sddlExtraUsers = Test-ServiceSdMatches ($sddl + '(A;;LC;;;BU)') $cp
$r.sddlCpMore = Test-ServiceSdMatches ($sddl -replace '\(A;;LC;;;S-1-5-21[0-9-]+\)', '(A;;CCLCSWRPWPDTLOCRSDRCWDWO;;;S-1-5-21-1111111111-2222222222-3333333333-1500)') $cp
$r.sddlNoCp = Test-ServiceSdMatches 'D:(A;;GA;;;SY)(A;;GA;;;BA)' $cp
$r.sddlJunk = Test-ServiceSdMatches 'not an sddl' $cp
$goodFacts = [pscustomobject]@{ Exists = $true; StartName = 'NT SERVICE\AlberaHostBroker'; PathName = $r.brokerCommandLine; StartMode = 'Auto'; DelayedAutoStart = $true; ServiceType = 'Own Process'; SidTypeText = "SERVICE_NAME: AlberaHostBroker`r`n        SERVICE_SID_TYPE:  RESTRICTED"; PrivilegesText = "SERVICE_NAME: AlberaHostBroker`r`n        PRIVILEGES       : SeChangeNotifyPrivilege" }
function WithFact($name, $value) { $c = $goodFacts.PSObject.Copy(); $c.$name = $value; $c }
$r.factsOk = Count (Test-ServiceFacts $goodFacts 'AlberaHostBroker' $r.brokerCommandLine)
$r.factsBad = [ordered]@{
  missing = Test-ServiceFacts ([pscustomobject]@{ Exists = $false }) 'AlberaHostBroker' $r.brokerCommandLine
  localSystem = Test-ServiceFacts (WithFact 'StartName' 'LocalSystem') 'AlberaHostBroker' $r.brokerCommandLine
  otherPath = Test-ServiceFacts (WithFact 'PathName' 'C:\evil.exe service x') 'AlberaHostBroker' $r.brokerCommandLine
  demand = Test-ServiceFacts (WithFact 'StartMode' 'Manual') 'AlberaHostBroker' $r.brokerCommandLine
  autoNotDelayed = Test-ServiceFacts (WithFact 'DelayedAutoStart' $false) 'AlberaHostBroker' $r.brokerCommandLine
  disabled = Test-ServiceFacts (WithFact 'StartMode' 'Disabled') 'AlberaHostBroker' $r.brokerCommandLine
  shared = Test-ServiceFacts (WithFact 'ServiceType' 'Share Process') 'AlberaHostBroker' $r.brokerCommandLine
  unrestricted = Test-ServiceFacts (WithFact 'SidTypeText' 'SERVICE_SID_TYPE:  UNRESTRICTED') 'AlberaHostBroker' $r.brokerCommandLine
  impersonate = Test-ServiceFacts (WithFact 'PrivilegesText' "PRIVILEGES : SeChangeNotifyPrivilege`r`n  SeImpersonatePrivilege") 'AlberaHostBroker' $r.brokerCommandLine
  noPrivs = Test-ServiceFacts (WithFact 'PrivilegesText' 'PRIVILEGES : ') 'AlberaHostBroker' $r.brokerCommandLine
}

# ---- the signing key checks
$authSid = $sids.Authority
$keyGood = [pscustomobject]@{ exportPolicy = 0; algorithm = 'ECDSA_P256'; keySize = 256; owner = 'S-1-5-32-544'; allowSids = @('S-1-5-18', 'S-1-5-32-544', $authSid) }
$r.keyGood = Count (Test-KeyReadBack $keyGood $authSid)
$r.keyExportable = Test-KeyReadBack ([pscustomobject]@{ exportPolicy = 1; algorithm = 'ECDSA_P256'; keySize = 256; owner = 'S-1-5-32-544'; allowSids = $keyGood.allowSids }) $authSid
$r.keyEveryone = Test-KeyReadBack ([pscustomobject]@{ exportPolicy = 0; algorithm = 'ECDSA_P256'; keySize = 256; owner = 'S-1-5-32-544'; allowSids = @($keyGood.allowSids + 'S-1-1-0') }) $authSid
$r.keyBrokerSid = Test-KeyReadBack ([pscustomobject]@{ exportPolicy = 0; algorithm = 'ECDSA_P256'; keySize = 256; owner = 'S-1-5-32-544'; allowSids = @($keyGood.allowSids + $sids.Broker) }) $authSid
$r.keyOwnerUser = Test-KeyReadBack ([pscustomobject]@{ exportPolicy = 0; algorithm = 'ECDSA_P256'; keySize = 256; owner = $cp; allowSids = $keyGood.allowSids }) $authSid
$r.keySddl = New-KeySddl $authSid
$r.keyNameOk = @((Test-KeyName 'AlberaApprovalAuthority-host-1'), (Test-KeyName '..\x'), (Test-KeyName ''))

# ---- removal safety, paths, lab gate
$r.unknownEntries = Get-UnknownEntries @('broker\journal.sqlite', 'Broker\JOURNAL.SQLITE-wal', 'broker\notes.txt', 'authority\policy.json', 'control-plane\sub\x') (Get-KnownDataFiles) (Get-KnownDataFolders)
$r.pathsOk = @((Test-PlainAbsolutePath 'C:\ProgramData\Albera\broker\journal.sqlite'), (Test-PlainAbsolutePath 'C:\a\b'))
$r.pathsBad = @((Test-PlainAbsolutePath 'broker\journal.sqlite'), (Test-PlainAbsolutePath 'C:/a/b'), (Test-PlainAbsolutePath 'C:\a\..\b'), (Test-PlainAbsolutePath '\\server\share\x'), (Test-PlainAbsolutePath 'C:\a\b\'), (Test-PlainAbsolutePath 'C:\a\b:stream'), (Test-PlainAbsolutePath 'C:\a\\b'), (Test-PlainAbsolutePath ('C:\' + ('x' * 250))))
$r.gate = [ordered]@{ labSupplied = $null -eq (Test-LabSourceGate $true '1'); notLab = Test-LabSourceGate $true ''; labWrongValue = Test-LabSourceGate $true 'true'; noSource = $null -eq (Test-LabSourceGate $false '') }
$r.ids = @((Test-HostId 'albera-host'), (Test-HostId 'hello-951a135537287eae'), (Test-HostId '-x'), (Test-HostId ''), (Test-HostId 'a b'))
# ---- trust: who may have written what the installer relies on
$admins = Get-AdminSids
$attackerSid = 'S-1-5-21-1111111111-2222222222-3333333333-1002'
$ok = [pscustomobject]@{ Owner = 'S-1-5-32-544'; Protected = $true; WriteSids = @('S-1-5-18', 'S-1-5-32-544') }
$r.trustOk = Count (Test-TrustSummary $ok $admins $true)
$r.trustPlantedOwner = Test-TrustSummary ([pscustomobject]@{ Owner = $attackerSid; Protected = $true; WriteSids = @('S-1-5-32-544') }) $admins $true
$r.trustUserWriter = Test-TrustSummary ([pscustomobject]@{ Owner = 'S-1-5-32-544'; Protected = $true; WriteSids = @('S-1-5-32-544', $attackerSid) }) $admins $true
$r.trustInherited = Test-TrustSummary ([pscustomobject]@{ Owner = 'S-1-5-32-544'; Protected = $false; WriteSids = @('S-1-5-32-544') }) $admins $true
$r.trustInheritedFileOk = Count (Test-TrustSummary ([pscustomobject]@{ Owner = 'S-1-5-32-544'; Protected = $false; WriteSids = @('S-1-5-32-544') }) $admins $false)
$r.trustServiceWriterOnItsOwn = Count (Test-TrustSummary ([pscustomobject]@{ Owner = 'S-1-5-18'; Protected = $true; WriteSids = @('S-1-5-18', $sids.Broker) }) (@($admins) + $sids.Broker) $true)
$r.trustServiceWriterElsewhere = Test-TrustSummary ([pscustomobject]@{ Owner = 'S-1-5-18'; Protected = $true; WriteSids = @('S-1-5-18', $sids.Broker) }) $admins $true
$ti = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$r.trustTrustedInstaller = Count (Test-TrustSummary ([pscustomobject]@{ Owner = $ti; Protected = $false; WriteSids = @('S-1-5-18', $ti) }) $admins $false)
$r.trustCreatorOwnerWriter = Test-TrustSummary ([pscustomobject]@{ Owner = 'S-1-5-32-544'; Protected = $false; WriteSids = @('S-1-3-0') }) $admins $false
$r.trustCreatorOwnerOwner = Test-TrustSummary ([pscustomobject]@{ Owner = 'S-1-3-0'; Protected = $false; WriteSids = @() }) $admins $false
$r.trustedSids = Get-TrustedSids
$r.plannedWriters = [ordered]@{
  dataRoot = Get-PlannedWriters ($plan | Where-Object { $_.Path -eq $L.DataRoot })
  brokerDb = Get-PlannedWriters ($plan | Where-Object { $_.Path -eq $L.BrokerDbDir })
  brokerConfig = Get-PlannedWriters ($plan | Where-Object { $_.Path -eq $L.BrokerConfigDir })
  controlPlane = Get-PlannedWriters ($plan | Where-Object { $_.Path -eq $L.ControlPlaneDir })
}
$r.refusalText = Format-TrustRefusal 'C:\ProgramData\Albera' @('owner_untrusted')
$rules = ConvertTo-FileSystemRules $plan[3].Grants
$r.rules = @($rules | ForEach-Object { [ordered]@{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; inherit = [int]$_.InheritanceFlags; type = [string]$_.AccessControlType } })
$r.badGrant = try { ConvertTo-FileSystemRules @('*S-1-1-0:(OI)(CI)W') | Out-Null; 'no error' } catch { $_.Exception.Message }

# ---- the tree hash the owner types, and the fixed system folders
$a = '1' * 64; $b = '2' * 64; $c2 = '3' * 64; $d = '4' * 64
$e5 = '5' * 64; $f6 = '6' * 64
function Components($brokerFiles) { @{ broker = $brokerFiles; authority = @{ 'albera-approval-authority.exe' = $c2 }; 'pipe-client' = @{ 'albera-windows-broker-pipe-client.exe' = $d }; 'control-plane' = @{ 'albera-control-plane-host.exe' = $e5; 'app/src/runtime/entry.mjs' = $b }; approver = @{ 'AlberaApprover.exe' = $f6 } } }
$base = Components @{ 'albera-windows-broker.exe' = $a; 'sub/x.dll' = $b }
$r.tree = Get-CanonicalTreeHash $base
$r.treeBackslashAndOrder = Get-CanonicalTreeHash (Components ([ordered]@{ 'sub\x.dll' = $b; 'albera-windows-broker.exe' = $a }))
$r.treeOther = [ordered]@{
  changedFile = Get-CanonicalTreeHash (Components @{ 'albera-windows-broker.exe' = $a; 'sub/x.dll' = $c2 })
  renamedFile = Get-CanonicalTreeHash (Components @{ 'albera-windows-broker.exe' = $a; 'sub/y.dll' = $b })
  extraFile = Get-CanonicalTreeHash (Components @{ 'albera-windows-broker.exe' = $a; 'sub/x.dll' = $b; 'planted.dll' = $d })
  missingFile = Get-CanonicalTreeHash (Components @{ 'albera-windows-broker.exe' = $a })
  movedToAuthority = Get-CanonicalTreeHash @{ broker = @{ 'albera-windows-broker.exe' = $a }; authority = @{ 'albera-approval-authority.exe' = $c2; 'sub/x.dll' = $b }; 'pipe-client' = @{ 'albera-windows-broker-pipe-client.exe' = $d }; 'control-plane' = @{ 'albera-control-plane-host.exe' = $e5; 'app/src/runtime/entry.mjs' = $b }; approver = @{ 'AlberaApprover.exe' = $f6 } }
  controlPlaneChanged = Get-CanonicalTreeHash (@{ broker = $base.broker; authority = $base.authority; 'pipe-client' = $base['pipe-client']; 'control-plane' = @{ 'albera-control-plane-host.exe' = $e5; 'app/src/runtime/entry.mjs' = $a }; approver = $base.approver })
}
# the documented format, built by hand: <component>/<path> TAB <sha> LF, components in the fixed order, paths ordinal-sorted, SHA-256 of the UTF-8 bytes
$text = "broker/albera-windows-broker.exe`t$a`nbroker/sub/x.dll`t$b`nauthority/albera-approval-authority.exe`t$c2`npipe-client/albera-windows-broker-pipe-client.exe`t$d`ncontrol-plane/albera-control-plane-host.exe`t$e5`ncontrol-plane/app/src/runtime/entry.mjs`t$b`napprover/AlberaApprover.exe`t$f6`n"
$sha = [System.Security.Cryptography.SHA256]::Create()
$r.treeByHand = ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text))) -replace '-', '').ToLowerInvariant()
function Msg([scriptblock]$Block) { try { & $Block | Out-Null; 'no error' } catch { $_.Exception.Message } }
$r.treeBad = [ordered]@{
  missingComponent = Msg { Get-CanonicalTreeHash @{ broker = @{ 'a.exe' = $a }; authority = @{ 'b.exe' = $b } } }
  approverMissing = Msg { Get-CanonicalTreeHash @{ broker = $base.broker; authority = $base.authority; 'pipe-client' = $base['pipe-client']; 'control-plane' = $base['control-plane'] } }
  extraComponent = Msg { Get-CanonicalTreeHash ($base + @{ evil = @{ 'x' = $a } }) }
  emptyComponent = Msg { Get-CanonicalTreeHash (Components @{}) }
  dotdot = Msg { Get-CanonicalTreeHash (Components @{ '../evil.dll' = $a }) }
  absolute = Msg { Get-CanonicalTreeHash (Components @{ '/evil.dll' = $a }) }
  drive = Msg { Get-CanonicalTreeHash (Components @{ 'C:/evil.dll' = $a }) }
  upperHex = Msg { Get-CanonicalTreeHash (Components @{ 'a.exe' = ('A' * 64) }) }
  duplicate = Msg { Get-CanonicalTreeHash (Components ([ordered]@{ 'sub/x.dll' = $a; 'sub\x.dll' = $b })) }
}
$r.treeValue = @((Test-TreeHashValue ('a' * 64)), (Test-TreeHashValue ('A' * 64)), (Test-TreeHashValue ('a' * 63)), (Test-TreeHashValue ''), (Test-TreeHashValue ('g' * 64)))
$r.fixedOk = @((Count (Test-FixedFolders 'C:\Windows\System32' 'C:\Program Files' 'C:\ProgramData')), (Count (Test-FixedFolders 'c:\windows\system32\' 'c:\program files' 'C:\PROGRAMDATA')))
$r.fixedBad = [ordered]@{
  system = Test-FixedFolders 'D:\Users\evil\bin' 'C:\Program Files' 'C:\ProgramData'
  programFiles = Test-FixedFolders 'C:\Windows\System32' 'C:\Users\evil\Program Files' 'C:\ProgramData'
  programData = Test-FixedFolders 'C:\Windows\System32' 'C:\Program Files' 'C:\Users\evil\ProgramData'
  x86 = Test-FixedFolders 'C:\Windows\System32' 'C:\Program Files (x86)' 'C:\ProgramData'
  empty = Test-FixedFolders '' '' ''
  all = Test-FixedFolders 'E:\w' 'E:\p' 'E:\d'
}
# what the script really gets from Windows on this PC, with a hostile user environment: the answer does not move
$saved = @{ SystemRoot = $env:SystemRoot; ProgramFiles = $env:ProgramFiles; ProgramData = $env:ProgramData; windir = $env:windir }
$env:SystemRoot = 'D:\evil'; $env:ProgramFiles = 'D:\evil\pf'; $env:ProgramData = 'D:\evil\pd'; $env:windir = 'D:\evil'
$r.hostileEnv = [ordered]@{ system = [Environment]::SystemDirectory; programFiles = [Environment]::GetFolderPath('ProgramFiles'); programData = [Environment]::GetFolderPath('CommonApplicationData') }
$r.hostileEnvReasons = Count (Test-FixedFolders $r.hostileEnv.system $r.hostileEnv.programFiles $r.hostileEnv.programData)
foreach ($k in $saved.Keys) { Set-Item -Path "Env:$k" -Value $saved[$k] }

# ---- manifest shape and the account that may be removed
function NewManifest { [ordered]@{ schema = 1; tool = 'albera-host.ps1'; state = 'partial'; created = [ordered]@{ dataRoot = $true; installRoot = $true; services = @('AlberaHostBroker', 'AlberaApprovalAuthority'); binaries = @{ broker = @{ exeSha256 = ('1' * 64) } }; user = @{ name = 'albera-cp'; sid = $cp }; key = @{ name = 'AlberaApprovalAuthority-host-1' } }; values = @{ authoritySpki = $EcSpki; controlPlaneSid = $cp } } }
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
function Shape($mutate) { $m = $serializer.DeserializeObject((ConvertTo-Json -InputObject (NewManifest) -Depth 8 -Compress)); & $mutate $m; Test-ManifestShape $m }
$r.shapeOk = Count (Shape { param($m) })
$r.shapeBad = [ordered]@{
  userName = Shape { param($m) $m['created']['user']['name'] = 'Yosuke' }
  userSidGroup = Shape { param($m) $m['created']['user']['sid'] = 'S-1-5-32-544' }
  serviceName = Shape { param($m) $m['created']['services'] = @('AlberaHostBroker', 'Spooler') }
  keyName = Shape { param($m) $m['created']['key']['name'] = 'SomeoneElsesKey' }
  binaryName = Shape { param($m) $m['created']['binaries']['evil'] = @{} }
  unknownCreated = Shape { param($m) $m['created']['folders'] = @('C:\Windows') }
  unknownValue = Shape { param($m) $m['values']['x'] = 'y' }
  badSpki = Shape { param($m) $m['values']['authoritySpki'] = 'AAAA' }
  badState = Shape { param($m) $m['state'] = 'owned' }
  notDict = Test-ManifestShape 'text'
  nullManifest = Test-ManifestShape $null
}
$c = Get-HostConstants
$recorded = @{ name = 'albera-cp'; sid = $cp }
$live = [pscustomobject]@{ Name = 'albera-cp'; Sid = $cp; Description = $c.ControlPlaneUserDescription }
$r.ownedOk = Count (Test-OwnedUser $recorded $live)
$r.owned = [ordered]@{
  forgedName = Test-OwnedUser @{ name = 'Yosuke'; sid = 'S-1-5-21-1111111111-2222222222-3333333333-1002' } ([pscustomobject]@{ Name = 'Yosuke'; Sid = 'S-1-5-21-1111111111-2222222222-3333333333-1002'; Description = $c.ControlPlaneUserDescription })
  forgedNameLiveOwner = Test-OwnedUser @{ name = 'Yosuke'; sid = 'S-1-5-21-1111111111-2222222222-3333333333-1002' } ([pscustomobject]@{ Name = 'Yosuke'; Sid = 'S-1-5-21-1111111111-2222222222-3333333333-1002'; Description = '' })
  otherSid = Test-OwnedUser $recorded ([pscustomobject]@{ Name = 'albera-cp'; Sid = 'S-1-5-21-1111111111-2222222222-3333333333-1999'; Description = $c.ControlPlaneUserDescription })
  otherDescription = Test-OwnedUser $recorded ([pscustomobject]@{ Name = 'albera-cp'; Sid = $cp; Description = 'my own account' })
  caseName = Test-OwnedUser @{ name = 'Albera-CP'; sid = $cp } ([pscustomobject]@{ Name = 'Albera-CP'; Sid = $cp; Description = $c.ControlPlaneUserDescription })
  gone = Test-OwnedUser $recorded $null
  unrecorded = Test-OwnedUser $null $live
}
# ---- the Hyper-V grant (-GrantHyperVToBroker; ADR-002 Amendment 2026-11-03)
$hvK = Get-HostConstants   # not $K: the loops above reuse $k (variable names are case-insensitive)
$guidA = '8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f'; $guidB = '11111111-2222-4333-8444-555555555555'
$hvSids = @{ Broker = $sids.Broker; Authority = $sids.Authority; ControlPlane = $cp }
$r.hvConstant = $hvK.HyperVAdminsSid
$hvPlan = Get-HyperVGrantPlan $hvSids
$r.hvPlan = [ordered]@{ group = $hvPlan.Group; member = $hvPlan.Member; memberIsBroker = ($hvPlan.Member -eq $sids.Broker) }
$r.hvPlanNoCpYet = (Get-HyperVGrantPlan @{ Broker = $sids.Broker; Authority = $sids.Authority; ControlPlane = $null }).Member
$r.hvPlanRefused = [ordered]@{
  brokerIsControlPlane = Msg { Get-HyperVGrantPlan @{ Broker = $sids.Broker; Authority = $sids.Authority; ControlPlane = $sids.Broker } }
  brokerIsAuthority = Msg { Get-HyperVGrantPlan @{ Broker = $sids.Broker; Authority = $sids.Broker; ControlPlane = $cp } }
  controlPlaneSid = Msg { Get-HyperVGrantPlan @{ Broker = $cp; Authority = $sids.Authority; ControlPlane = $cp } }
  authoritySid = Msg { Get-HyperVGrantPlan @{ Broker = $sids.Authority; Authority = $sids.Authority; ControlPlane = $cp } }
  otherServiceSid = Msg { Get-HyperVGrantPlan @{ Broker = (Get-DerivedServiceSid 'SomeOtherService'); Authority = $sids.Authority; ControlPlane = $cp } }
  administrators = Msg { Get-HyperVGrantPlan @{ Broker = 'S-1-5-32-544'; Authority = $sids.Authority; ControlPlane = $cp } }
  nothing = Msg { Get-HyperVGrantPlan @{ Broker = $null; Authority = $sids.Authority; ControlPlane = $cp } }
}
$r.hvMembers = [ordered]@{
  ok = Count (Test-HyperVMembers @($sids.Broker, 'S-1-5-21-1111111111-2222222222-3333333333-1234') $hvSids)
  brokerMissing = Test-HyperVMembers @('S-1-5-21-1111111111-2222222222-3333333333-1234') $hvSids
  controlPlaneIn = Test-HyperVMembers @($sids.Broker, $cp) $hvSids
  authorityIn = Test-HyperVMembers @($sids.Broker, $sids.Authority) $hvSids
  empty = Test-HyperVMembers @() $hvSids
  # without a record: the Broker must NOT be in, albera-cp and the Authority never
  noRecordClean = Count (Test-HyperVMembers @('S-1-5-21-1111111111-2222222222-3333333333-1234') $hvSids $false)
  noRecordEmpty = Count (Test-HyperVMembers @() $hvSids $false)
  noRecordBroker = Test-HyperVMembers @($sids.Broker) $hvSids $false
  noRecordControlPlane = Test-HyperVMembers @($cp) $hvSids $false
  noRecordAuthority = Test-HyperVMembers @($sids.Authority) $hvSids $false
}
$r.vmGuid = @((Test-VmGuid $guidA), (Test-VmGuid $guidA.ToUpperInvariant()), (Test-VmGuid ($guidA + "`n")), (Test-VmGuid '{8f0d5c1e-7a3b-4c2d-9e6f-0a1b2c3d4e5f}'), (Test-VmGuid '00000000-0000-0000-0000-000000000000'), (Test-VmGuid ''), (Test-VmGuid $null), (Test-VmGuid 'clone-01'))
function Vm([string]$Name, [string]$Element) { [pscustomobject]@{ Name = $Name; ElementName = $Element } }
$r.vmPick = [ordered]@{
  one = Select-VmByName @((Vm $guidA.ToUpperInvariant() 'albera-clone-01')) 'albera-clone-01'
  caseInsensitiveName = Select-VmByName @((Vm $guidA 'Albera-Clone-01')) 'albera-clone-01'
  none = Select-VmByName @() 'albera-clone-01'
  otherName = Select-VmByName @((Vm $guidA 'other')) 'albera-clone-01'
  twoWithTheName = Select-VmByName @((Vm $guidA 'albera-clone-01'), (Vm $guidB 'ALBERA-CLONE-01')) 'albera-clone-01'
  hostIsNoVm = Select-VmByName @((Vm 'HOSTNAME-PC' 'albera-clone-01')) 'albera-clone-01'
  hostAndOne = Select-VmByName @((Vm 'HOSTNAME-PC' 'albera-clone-01'), (Vm $guidA 'albera-clone-01')) 'albera-clone-01'
  nullEntry = Select-VmByName @($null, (Vm $guidA 'albera-clone-01')) 'albera-clone-01'
}
$r.vmIdGate = [ordered]@{ lab = $null -eq (Test-LabVmIdGate $true '1'); notLab = Test-LabVmIdGate $true ''; wrongValue = Test-LabVmIdGate $true 'true'; notSupplied = $null -eq (Test-LabVmIdGate $false '') }

# the Broker config: the seven keys it always had, plus `computers` only when the Hyper-V grant is asked for
$computers = Get-BrokerComputers 'clone-01' $guidA
$r.hvComputers = $computers
$r.hvComputersBad = [ordered]@{ id = Msg { Get-BrokerComputers 'bad id' $guidA }; vm = Msg { Get-BrokerComputers 'clone-01' $guidA.ToUpperInvariant() } }
$plainJson = ConvertTo-HostJson (Get-BrokerConfig $L $cp $EcSpki)
$r.hvPlainSame = [ordered]@{
  noArgument = ($plainJson -ceq $brokerJson)
  nullComputers = ((ConvertTo-HostJson (Get-BrokerConfig $L $cp $EcSpki $null)) -ceq $brokerJson)
  emptyComputers = ((ConvertTo-HostJson (Get-BrokerConfig $L $cp $EcSpki @())) -ceq $brokerJson)
  hasNoComputersKey = (@((Get-BrokerConfig $L $cp $EcSpki $null).Keys) -cnotcontains 'computers')
}
$grantJson = ConvertTo-HostJson (Get-BrokerConfig $L $cp $EcSpki $computers)
$r.hvGrantJson = $grantJson
$r.hvGrantReasons = Test-BrokerConfigText $grantJson
$r.hvGrantKeys = @((Get-BrokerConfig $L $cp $EcSpki $computers).Keys)
$r.hvGrantComputersMatch = [ordered]@{ same = (Test-BrokerConfigComputers $grantJson 'clone-01' $guidA); otherVm = (Test-BrokerConfigComputers $grantJson 'clone-01' $guidB); otherId = (Test-BrokerConfigComputers $grantJson 'clone-02' $guidA); plain = (Test-BrokerConfigComputers $plainJson 'clone-01' $guidA); junk = (Test-BrokerConfigComputers 'nope' 'clone-01' $guidA) }
$r.hvGrantBad = [ordered]@{
  upperGuid = Test-BrokerConfigText ($grantJson -replace [regex]::Escape($guidA), $guidA.ToUpperInvariant())
  wrongShape = Test-BrokerConfigText ($grantJson -replace '"vmId":"[^"]*"', '"vmId":"not-a-guid"')
  zeroGuid = Test-BrokerConfigText ($grantJson -replace [regex]::Escape($guidA), '00000000-0000-0000-0000-000000000000')
  extraField = Test-BrokerConfigText ($grantJson -replace '"vmId"', '"name":"x","vmId"')
  missingField = Test-BrokerConfigText ($grantJson -replace ',"vmId":"[^"]*"', '')
  notAnArray = Test-BrokerConfigText ($grantJson -replace '"computers":\[(\{[^\]]*\})\]', '"computers":$1')
  isNull = Test-BrokerConfigText ($grantJson -replace '"computers":\[[^\]]*\]', '"computers":null')
  duplicateVm = Test-BrokerConfigText ($grantJson -replace '"computers":\[(\{[^\]]*\})\]', ('"computers":[$1,{"computerId":"clone-02","vmId":"' + $guidA + '"}]'))
  duplicateId = Test-BrokerConfigText ($grantJson -replace '"computers":\[(\{[^\]]*\})\]', ('"computers":[$1,{"computerId":"clone-01","vmId":"' + $guidB + '"}]'))
  badId = Test-BrokerConfigText ($grantJson -replace '"computerId":"clone-01"', '"computerId":"a b"')
  nineEntries = Test-BrokerConfigText ((Get-BrokerConfig $L $cp $EcSpki @(1..9 | ForEach-Object { [ordered]@{ computerId = "c$_"; vmId = ('00000000-0000-4000-8000-{0:D12}' -f $_) } })) | ConvertTo-Json -Depth 6 -Compress)
  eightEntries = Test-BrokerConfigText ((Get-BrokerConfig $L $cp $EcSpki @(1..8 | ForEach-Object { [ordered]@{ computerId = "c$_"; vmId = ('00000000-0000-4000-8000-{0:D12}' -f $_) } })) | ConvertTo-Json -Depth 6 -Compress)
}

# service facts: the SID type is expected per the install record, never "anything goes"
$r.sidTypeExpected = [ordered]@{
  brokerPlain = Get-ExpectedSidType $hvK.BrokerService $false
  brokerGranted = Get-ExpectedSidType $hvK.BrokerService $true
  authorityPlain = Get-ExpectedSidType $hvK.AuthorityService $false
  authorityGranted = Get-ExpectedSidType $hvK.AuthorityService $true
  unknownServiceGranted = Get-ExpectedSidType 'SomethingElse' $true
}
$unrestrictedFacts = WithFact 'SidTypeText' "SERVICE_NAME: AlberaHostBroker`r`n        SERVICE_SID_TYPE:  UNRESTRICTED"
$unrestrictedImpersonate = WithFact 'SidTypeText' $unrestrictedFacts.SidTypeText
$unrestrictedImpersonate.PrivilegesText = "PRIVILEGES : SeChangeNotifyPrivilege`r`n  SeImpersonatePrivilege"
$r.sidTypeFacts = [ordered]@{
  grantedOk = Count (Test-ServiceFacts $unrestrictedFacts 'AlberaHostBroker' $r.brokerCommandLine 'unrestricted')
  grantedButRestricted = Test-ServiceFacts $goodFacts 'AlberaHostBroker' $r.brokerCommandLine 'unrestricted'
  grantedButNone = Test-ServiceFacts (WithFact 'SidTypeText' 'SERVICE_SID_TYPE:  NONE') 'AlberaHostBroker' $r.brokerCommandLine 'unrestricted'
  plainButUnrestricted = Test-ServiceFacts $unrestrictedFacts 'AlberaHostBroker' $r.brokerCommandLine
  plainButUnrestrictedExplicit = Test-ServiceFacts $unrestrictedFacts 'AlberaHostBroker' $r.brokerCommandLine 'restricted'
  plainOk = Count (Test-ServiceFacts $goodFacts 'AlberaHostBroker' $r.brokerCommandLine 'restricted')
  grantedStillMinimalPrivileges = Test-ServiceFacts $unrestrictedImpersonate 'AlberaHostBroker' $r.brokerCommandLine 'unrestricted'
  badExpectation = Msg { Test-ServiceFacts $goodFacts 'AlberaHostBroker' $r.brokerCommandLine 'none' }
}

$r.winNtPaths = [ordered]@{
  sid = ConvertFrom-WinNTMemberPath 'WinNT://S-1-5-80-1-2-3-4-5'
  service = ConvertFrom-WinNTMemberPath 'WinNT://NT SERVICE/AlberaHostBroker'
  local = ConvertFrom-WinNTMemberPath 'WinNT://./albera-cp'
  withMachine = ConvertFrom-WinNTMemberPath 'WinNT://SERVER/NT SERVICE/AlberaHostBroker'
  junk = ConvertFrom-WinNTMemberPath 'LDAP://x'
  nothing = ConvertFrom-WinNTMemberPath ''
  badSid = ConvertFrom-WinNTMemberPath 'WinNT://S-1-x'
}

# the install record: only the fixed group and the Broker's own derived SID can be named, so a forged record removes nobody else from the group
function ManifestWithGrant($grant) { $m = NewManifest; $m['created']['hyperVGrant'] = $grant; $m }
function ShapeOf($manifest) { $x = $serializer.DeserializeObject((ConvertTo-Json -InputObject $manifest -Depth 8 -Compress)); Test-ManifestShape $x }
$goodGrant = @{ group = 'S-1-5-32-578'; sid = $sids.Broker; computerId = 'clone-01'; vmId = $guidA }
function WithGrant($name, $value) { $g = @{} + $goodGrant; if ($null -eq $value) { $g.Remove($name) } else { $g[$name] = $value }; $g }
$r.hvRecord = [ordered]@{
  ok = Count (ShapeOf (ManifestWithGrant $goodGrant))
  noRecordStillOk = Count (ShapeOf (NewManifest))
  controlPlaneSid = ShapeOf (ManifestWithGrant (WithGrant 'sid' $cp))
  authoritySid = ShapeOf (ManifestWithGrant (WithGrant 'sid' $sids.Authority))
  otherGroup = ShapeOf (ManifestWithGrant (WithGrant 'group' 'S-1-5-32-544'))
  badVm = ShapeOf (ManifestWithGrant (WithGrant 'vmId' $guidA.ToUpperInvariant()))
  badComputer = ShapeOf (ManifestWithGrant (WithGrant 'computerId' 'a b'))
  extraKey = ShapeOf (ManifestWithGrant ((WithGrant 'x' 'y')))
  missingKey = ShapeOf (ManifestWithGrant (WithGrant 'vmId' $null))
  notADictionary = ShapeOf (ManifestWithGrant 'S-1-5-32-578')
}

# the Control Plane settings: the keys they always had; with the grant (a helper hash is passed) the `desktop` block is added between `computers` and `attestation`
$helperSha = 'ab' * 32
$helperPath = $L.PipeClientExe
$desktopJson = ConvertTo-HostJson (Get-ControlPlaneSettings $L 'albera-host' 'albera-clone-01' 'clone-01' $helperSha)
$r.desktopHelperSha = $helperSha
$r.desktopSettingsJson = $desktopJson
$r.desktopPlainSame = [ordered]@{
  noArgument = ((ConvertTo-HostJson (Get-ControlPlaneSettings $L 'albera-host' 'albera-clone-01' 'clone-01')) -ceq $r.settingsJson)
  nullSha = ((ConvertTo-HostJson (Get-ControlPlaneSettings $L 'albera-host' 'albera-clone-01' 'clone-01' $null)) -ceq $r.settingsJson)
  emptySha = ((ConvertTo-HostJson (Get-ControlPlaneSettings $L 'albera-host' 'albera-clone-01' 'clone-01' '')) -ceq $r.settingsJson)
  hasNoDesktopKey = (@((Get-ControlPlaneSettings $L 'albera-host' 'albera-clone-01' 'clone-01').Keys) -cnotcontains 'desktop')
}
$r.desktopKeys = @((Get-ControlPlaneSettings $L 'albera-host' 'albera-clone-01' 'clone-01' $helperSha).Keys)
$r.desktopBadSha = [ordered]@{ short = Msg { Get-ControlPlaneSettings $L 'p' 'v' 'c' ('ab' * 31) }; upper = Msg { Get-ControlPlaneSettings $L 'p' 'v' 'c' ('AB' * 32) }; notHex = Msg { Get-ControlPlaneSettings $L 'p' 'v' 'c' ('zz' * 32) } }
$r.desktopHasKey = [ordered]@{ plain = Test-ControlPlaneHasDesktopKey $r.settingsJson; withBlock = Test-ControlPlaneHasDesktopKey $desktopJson; nullBlock = Test-ControlPlaneHasDesktopKey '{"desktop":null}'; notJson = Test-ControlPlaneHasDesktopKey 'nope' }
$r.desktopCheck = [ordered]@{
  same = Test-ControlPlaneDesktop $desktopJson $helperPath $helperSha
  plainFile = Test-ControlPlaneDesktop $r.settingsJson $helperPath $helperSha
  otherSha = Test-ControlPlaneDesktop $desktopJson $helperPath ('cd' * 32)
  upperSha = Test-ControlPlaneDesktop ($desktopJson -replace $helperSha, $helperSha.ToUpperInvariant()) $helperPath $helperSha
  otherPath = Test-ControlPlaneDesktop $desktopJson 'C:\Program Files\Albera\bin\other.exe' $helperSha
  extraKey = Test-ControlPlaneDesktop ($desktopJson -replace '"helperSha256"', '"x":"y","helperSha256"') $helperPath $helperSha
  missingKey = Test-ControlPlaneDesktop ($desktopJson -replace ',"helperSha256":"[0-9a-f]+"', '') $helperPath $helperSha
  desktopIsString = Test-ControlPlaneDesktop ($desktopJson -replace '"desktop":\{[^}]*\}', '"desktop":"x"') $helperPath $helperSha
  shaIsNumber = Test-ControlPlaneDesktop ($desktopJson -replace '"helperSha256":"[0-9a-f]+"', '"helperSha256":5') $helperPath $helperSha
  notJson = Test-ControlPlaneDesktop 'nope' $helperPath $helperSha
  empty = Test-ControlPlaneDesktop '' $helperPath $helperSha
}

# ---- PR7: the Control Plane service (a service SID, no account), its pins, config, failure actions, launcher, shortcuts, Run entry, legacy migration and the setup run id
$cpSvc = Get-DerivedServiceSid $hvK.ControlPlaneService
$r.cp = [ordered]@{ service = $hvK.ControlPlaneService; sid = $cpSvc; sidShape = (Test-ServiceSidShape $cpSvc); differsFromOthers = (($cpSvc -ne $sids.Broker) -and ($cpSvc -ne $sids.Authority)) }
$nodeSha = 'ab' * 32; $claudeSha = 'cd' * 32; $approverSid2 = $shown.approverSid
$cfgObj = Get-ControlPlaneServiceConfig $L $nodeSha $claudeSha $cpSvc $approverSid2
$cfgJson = ConvertTo-HostJson $cfgObj
$r.cfg = [ordered]@{ json = $cfgJson; top = @($cfgObj.Keys); host = @($cfgObj.host.Keys); claude = @($cfgObj.claude.Keys); ui = @($cfgObj.ui.Keys); reasons = (Test-ControlPlaneServiceConfigText $cfgJson $L $nodeSha $claudeSha $cpSvc $approverSid2) }
function CfgReasons([string]$Json) { Test-ControlPlaneServiceConfigText $Json $L $nodeSha $claudeSha $cpSvc $approverSid2 }
$r.cfgBad = [ordered]@{
  otherNode = CfgReasons ($cfgJson -replace $nodeSha, ('00' * 32))
  otherClaude = CfgReasons ($cfgJson -replace $claudeSha, ('00' * 32))
  extraTopKey = CfgReasons ($cfgJson -replace '^\{', '{"extra":1,')
  extraHostKey = CfgReasons ($cfgJson -replace '"nodePath"', '"x":"y","nodePath"')
  missingHostKey = CfgReasons ($cfgJson -replace ',"stableRunMs":\d+', '')
  noClaude = CfgReasons ($cfgJson -replace ',"claude":\{[^}]*\}', '')
  otherUiSid = CfgReasons ($cfgJson -replace '"approverSid":"[^"]*"', '"approverSid":"S-1-5-21-1-2-3-9"')
  cpSidIsAccount = CfgReasons ($cfgJson -replace '"controlPlaneSid":"[^"]*"', '"controlPlaneSid":"S-1-5-21-1111111111-2222222222-3333333333-1500"')
  portableNode = CfgReasons ($cfgJson -replace 'node\\\\node.exe', 'node.exe')
  maxMinutesString = CfgReasons ($cfgJson -replace '"maxMinutes":15', '"maxMinutes":"15"')
  notJson = CfgReasons 'nope'
  tooBig = CfgReasons ('{"a":"' + ('x' * 17000) + '"}')
}
$r.cfgInputsRefused = [ordered]@{
  shortNode = Msg { Get-ControlPlaneServiceConfig $L ('ab' * 31) $claudeSha $cpSvc $approverSid2 }
  accountAsCp = Msg { Get-ControlPlaneServiceConfig $L $nodeSha $claudeSha $cp $approverSid2 }
  serviceAsApprover = Msg { Get-ControlPlaneServiceConfig $L $nodeSha $claudeSha $cpSvc $cpSvc }
}
# the new folders of the plan, with a service SID as Control Plane and the owner's SID for ui\
$sids2 = @{ Broker = $sids.Broker; Authority = $sids.Authority; ControlPlane = $cpSvc; Approver = $approverSid2 }
$plan2 = @(Get-AclPlan $L $sids2)
$r.aclPlan2 = @($plan2 | ForEach-Object { [ordered]@{ path = $_.Path; grants = @($_.Grants); writers = (Get-PlannedWriters $_) } })
$r.aclPlan2NoApprover = @((Get-AclPlan $L @{ Broker = $sids.Broker; Authority = $sids.Authority; ControlPlane = $cpSvc } | Where-Object { $_.Path -eq $L.UiDir }).Grants)
$r.readRules = @(ConvertTo-FileSystemRules @("*${approverSid2}:(OI)(CI)R") | ForEach-Object { [ordered]@{ rights = [int]$_.FileSystemRights; inherit = [int]$_.InheritanceFlags } })
# services: delayed start, the failure actions, the Broker's service ACL for a service SID
$r.scCreateCp = Get-ScCreateArguments $hvK.ControlPlaneService $L.ControlPlaneExe $L.ControlPlaneConfig
$r.scFailure = Get-ScFailureArguments $hvK.ControlPlaneService
# The failure actions as the SCM stores them (HKLM\SYSTEM\CurrentControlSet\Services\<name>\FailureActions, REG_BINARY): reset period, reboot-message offset, command offset, cActions, offset of the array, then
# {type, delay in ms} per action (0 none, 1 restart, 2 reboot, 3 run command). Not `sc qfailure`: that text is localized.
function New-FailureBytes([uint32]$Reset, [object[]]$Actions) {
  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)
  $writer.Write([uint32]$Reset); $writer.Write([uint32]0); $writer.Write([uint32]0); $writer.Write([uint32]$Actions.Count); $writer.Write([uint32]20)
  foreach ($a in $Actions) { $writer.Write([uint32]$a[0]); $writer.Write([uint32]$a[1]) }
  $writer.Flush()
  , $stream.ToArray()
}
$restart = @(1, 5000); $none = @(0, 0)
$failOk = New-FailureBytes 86400 @($restart, $restart)
$spoolerBytes = [byte[]]@(0x10, 0x0e, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0x14, 0, 0, 0, 1, 0, 0, 0, 0x88, 0x13, 0, 0, 1, 0, 0, 0, 0x88, 0x13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)   # as Windows wrote it for the Spooler on the PC this was written on (reset 3600 s)
$r.failureBytes = [ordered]@{
  ok = Count (Test-ServiceFailureBytes $failOk)
  okWithThirdNone = Count (Test-ServiceFailureBytes (New-FailureBytes 86400 @($restart, $restart, $none)))
  none = Test-ServiceFailureBytes (New-FailureBytes 86400 @())
  one = Test-ServiceFailureBytes (New-FailureBytes 86400 @(,$restart))
  three = Test-ServiceFailureBytes (New-FailureBytes 86400 @($restart, $restart, $restart))
  otherDelay = Test-ServiceFailureBytes (New-FailureBytes 86400 @(@(1, 60000), @(1, 60000)))
  reboot = Test-ServiceFailureBytes (New-FailureBytes 86400 @($restart, $restart, @(2, 5000)))
  rebootSecond = Test-ServiceFailureBytes (New-FailureBytes 86400 @($restart, @(2, 5000)))
  runCommand = Test-ServiceFailureBytes (New-FailureBytes 86400 @($restart, $restart, @(3, 5000)))
  otherReset = Test-ServiceFailureBytes (New-FailureBytes 3600 @($restart, $restart))
  noBytes = Test-ServiceFailureBytes $null
  tooShort = Test-ServiceFailureBytes ([byte[]]@(1, 2, 3, 4))
  countTooBig = Test-ServiceFailureBytes ([byte[]]@(0x80, 0x51, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0, 0, 0, 0x14, 0, 0, 0))
  arrayPastTheEnd = Test-ServiceFailureBytes ([byte[]]@(0x80, 0x51, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0x14, 0, 0, 0, 1, 0, 0, 0, 0x88, 0x13, 0, 0))
  realSpooler = Test-ServiceFailureBytes $spoolerBytes
}
$cpFacts = [pscustomobject]@{ Exists = $true; StartName = 'NT SERVICE\AlberaControlPlane'; PathName = (Get-ServiceCommandLine $L.ControlPlaneExe $L.ControlPlaneConfig); StartMode = 'Auto'; DelayedAutoStart = $true; ServiceType = 'Own Process'; SidTypeText = 'SERVICE_SID_TYPE:  RESTRICTED'; PrivilegesText = 'PRIVILEGES : SeChangeNotifyPrivilege'; FailureActions = $failOk }
$cpNoFailure = $cpFacts | Select-Object *; $cpNoFailure.FailureActions = (New-FailureBytes 86400 @())
$r.cpFacts = [ordered]@{
  ok = Count (Test-ServiceFacts $cpFacts $hvK.ControlPlaneService $cpFacts.PathName 'restricted' $true)
  noFailureActions = Test-ServiceFacts $cpNoFailure $hvK.ControlPlaneService $cpFacts.PathName 'restricted' $true
  brokerNeedsNoFailureActions = Count (Test-ServiceFacts $cpNoFailure $hvK.ControlPlaneService $cpFacts.PathName 'restricted' $false)
}
$r.sddlCpService = [ordered]@{ sddl = (Get-BrokerServiceSddl $cpSvc); ok = Count (Test-ServiceSdMatches (Get-BrokerServiceSddl $cpSvc) $cpSvc); accountSidFails = Test-ServiceSdMatches (Get-BrokerServiceSddl $cpSvc) $cp }
# the work folders of the service are known as a whole; anything else unlisted in the data root is still unknown
$r.unknownWork = Get-UnknownEntries @('control-plane\logs', 'control-plane\logs\host.log', 'control-plane\logs\host.log.1', 'control-plane\claude-run\run-0123456789abcdef\config\x', 'secrets\claude-oauth-token.dpapi', 'ui\room.json', 'control-plane\notes.txt', 'control-plane\logsX\a', 'control-plane-config\AlberaControlPlane.service.json', 'control-plane-config\extra.json', 'secrets', 'ui') (Get-KnownDataFiles) (Get-KnownDataFolders) (Get-KnownDataWorkFolders)
$r.unknownWorkWithoutWorkFolders = Get-UnknownEntries @('control-plane\logs\host.log', 'ui\room.json') (Get-KnownDataFiles) (Get-KnownDataFolders)
# records in the manifest: fixed names and hashes only
function NewCpManifest { $m = NewManifest; $m['created'].Remove('user'); $m['created']['services'] = @('AlberaHostBroker', 'AlberaApprovalAuthority', 'AlberaControlPlane'); $m['created']['controlPlane'] = @{ serviceSid = $cpSvc; nodeSha256 = $nodeSha; nodeSource = 'C:\Program Files\nodejs\node.exe' }; $m['created']['claude'] = @{ sha256 = $claudeSha; fileVersion = '2.1.310'; source = 'C:\Users\x\.local\bin\claude.exe' }; $m['created']['launcher'] = @{ sha256 = $nodeSha }; $m['created']['shortcuts'] = @($hvK.OpenShortcut, $hvK.UpdateShortcut); $m['created']['runEntry'] = @{ name = $hvK.RunValueName; command = '"C:\Program Files\Albera\bin\approver\AlberaApprover.exe" --tray' }; $m['setupRunId'] = '1234567890123'; $m }
function CpShape($mutate) { $m = $serializer.DeserializeObject((ConvertTo-Json -InputObject (NewCpManifest) -Depth 8 -Compress)); & $mutate $m; Test-ManifestShape $m }
$r.cpShapeOk = Count (CpShape { param($m) })
$r.cpShapeBad = [ordered]@{
  otherServiceSid = CpShape { param($m) $m['created']['controlPlane']['serviceSid'] = $sids.Broker }
  badNodeHash = CpShape { param($m) $m['created']['controlPlane']['nodeSha256'] = 'AB' * 32 }
  extraCpKey = CpShape { param($m) $m['created']['controlPlane']['x'] = 'y' }
  badClaudeHash = CpShape { param($m) $m['created']['claude']['sha256'] = 'zz' }
  longVersion = CpShape { param($m) $m['created']['claude']['fileVersion'] = ('9' * 65) }
  badLauncher = CpShape { param($m) $m['created']['launcher']['sha256'] = 'x' }
  shortcutName = CpShape { param($m) $m['created']['shortcuts'] = @('..\..\Windows\win.ini') }
  runName = CpShape { param($m) $m['created']['runEntry']['name'] = 'Something' }
  runNotDictionary = CpShape { param($m) $m['created']['runEntry'] = 'x' }
  topLevelKey = CpShape { param($m) $m['owner'] = 'x' }
  runIdText = CpShape { param($m) $m['setupRunId'] = '12abc' }
  runIdNegative = CpShape { param($m) $m['setupRunId'] = '-1' }
  runIdTooBig = CpShape { param($m) $m['setupRunId'] = '18446744073709551616' }
  unknownService = CpShape { param($m) $m['created']['services'] = @('AlberaControlPlane', 'Spooler') }
}
# the setup run id: an unsigned 64-bit number, compared as a number
function Id($v) { $x = ConvertTo-SetupRunId $v; if ($null -eq $x) { $null } else { $x.ToString() } }
$r.runId = [ordered]@{
  parse = @((Id '1234567'), (Id '0'), (Id '18446744073709551615'), (Id '18446744073709551616'), (Id '-1'), (Id '1e3'), (Id ' 1'), (Id '1 '), (Id ''), (Id $null), (Id 'abc'), (Id '012'), (Id '1234567890123456789012'), (Id 1234567))
  refusal = [ordered]@{
    nothingSupplied = Get-SetupRunIdRefusal '100' $null
    emptySupplied = Get-SetupRunIdRefusal '100' ''
    noRecord = Get-SetupRunIdRefusal $null '100'
    older = Get-SetupRunIdRefusal '100' '99'
    same = Get-SetupRunIdRefusal '100' '100'
    newer = Get-SetupRunIdRefusal '100' '101'
    numericNotText = Get-SetupRunIdRefusal '10' '9'
    textOrderWouldSayNewer = Get-SetupRunIdRefusal '9' '10'
    biggest = Get-SetupRunIdRefusal '18446744073709551615' '18446744073709551614'
    biggestSame = Get-SetupRunIdRefusal '18446744073709551615' '18446744073709551615'
    suppliedJunk = Get-SetupRunIdRefusal '100' 'x'
    recordedJunk = Get-SetupRunIdRefusal 'x' '100'
  }
  # the floor (HKLM\SOFTWARE\Albera\SetupRunIdFloor): the third argument; the LARGER of the record and the floor decides
  floor = [ordered]@{
    older = Get-SetupRunIdRefusal $null '99' '100'
    same = Get-SetupRunIdRefusal $null '100' '100'
    newer = Get-SetupRunIdRefusal $null '101' '100'
    floorBeatsRecord = Get-SetupRunIdRefusal '50' '99' '100'
    recordBeatsFloor = Get-SetupRunIdRefusal '100' '99' '50'
    numericNotText = Get-SetupRunIdRefusal $null '9' '10'
    biggest = Get-SetupRunIdRefusal $null '18446744073709551614' '18446744073709551615'
    noFloor = Get-SetupRunIdRefusal $null '1' $null
    nothingSupplied = Get-SetupRunIdRefusal '5' $null '100'
    junk = Get-SetupRunIdRefusal $null '100' 'x'
    empty = Get-SetupRunIdRefusal $null '100' ''
    notAString = Get-SetupRunIdRefusal $null '100' 'not-a-string'
    negative = Get-SetupRunIdRefusal $null '100' '-1'
    tooBig = Get-SetupRunIdRefusal $null '100' '18446744073709551616'
  }
}
# the pins and the claude account rule
$r.pins = [ordered]@{
  node = Get-NodeSourcePath 'C:\Program Files'
  claude = Get-ClaudeSourcePath 'C:\Users\Yosuke'
  claudeNoProfile = Get-ClaudeSourcePath 'C:\Users\..\Yosuke'
  claudeRelative = Get-ClaudeSourcePath 'Users\Yosuke'
  refusalSame = Get-ClaudePinRefusal $approverSid2 $approverSid2
  refusalOtherAdmin = Get-ClaudePinRefusal 'S-1-5-21-1111111111-2222222222-3333333333-500' $approverSid2
  refusalSystem = Get-ClaudePinRefusal 'S-1-5-18' $approverSid2
  refusalNoApprover = Get-ClaudePinRefusal $approverSid2 $null
  labGate = [ordered]@{ lab = $null -eq (Test-LabSourceGate $true '1'); notLab = Test-LabSourceGate $true ''; none = $null -eq (Test-LabSourceGate $false '') }
}
# the launcher, run for real against fakes of Get-Service, Get-NetTCPConnection, Start-Process and Read-Host (the text is the shipped one; only `exit 1` becomes a throw so the case survives it)
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('albera-lib-' + [guid]::NewGuid().ToString('N'))
$Lt = Get-HostLayout 'C:\Program Files' $work
New-Item -ItemType Directory -Force -Path $Lt.UiDir | Out-Null
$openText = Get-OpenAlberaScriptText $Lt
$tokens = $null; $errs = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($openText, [ref]$tokens, [ref]$errs)
$r.open = [ordered]@{ ascii = (-not ($openText -cmatch '[^\x09\x0A\x0D\x20-\x7E]')); parseErrors = $errs.Count; crlf = ($openText.Contains("`r`n") -and -not ($openText -cmatch "[^\r]\n")); hasService = $openText.Contains("'AlberaControlPlane'"); hasRoomFile = $openText.Contains($Lt.UiDir + '\room.json'); noPlaceholder = (-not $openText.Contains('@@')) }
$script:FakeServiceStatus = 'Running'; $script:FakeListeners = @(); $script:Started = New-Object System.Collections.Generic.List[string]; $script:Said = New-Object System.Collections.Generic.List[string]
function Get-Service { param($Name) [pscustomobject]@{ Name = $Name; Status = $script:FakeServiceStatus } }
function Get-NetTCPConnection { param($State, $LocalAddress, $LocalPort) @($script:FakeListeners | Where-Object { $_.LocalPort -eq $LocalPort -and $LocalAddress -eq '127.0.0.1' -and $State -eq 'Listen' }) }
function Start-Process { param($FilePath) $script:Started.Add([string]$FilePath) }
function Read-Host { param($Prompt) '' }
$openRunnable = [scriptblock]::Create($openText.Replace('exit 1', "throw 'EXIT'"))
function RunOpen($RoomJson) {
  $script:Started.Clear()
  if ($null -eq $RoomJson) { if (Test-Path -LiteralPath (Join-Path $Lt.UiDir 'room.json')) { Remove-Item -LiteralPath (Join-Path $Lt.UiDir 'room.json') } } else { [System.IO.File]::WriteAllText((Join-Path $Lt.UiDir 'room.json'), $RoomJson) }
  $out = New-Object System.Collections.Generic.List[string]
  $err = try { & $openRunnable 6>&1 | ForEach-Object { $out.Add([string]$_) }; $null } catch { $_.Exception.Message }
  [ordered]@{ exited = ($err -eq 'EXIT'); started = @($script:Started); said = ($out -join '|') }
}
$goodRoom = '{"port":51234,"code":"AbCdEfGhIjKlMnOpQrStUv_-12","pid":4321,"writtenAt":"2026-11-03T00:00:00Z"}'
$script:FakeListeners = @([pscustomobject]@{ LocalPort = 51234; OwningProcess = 4321 })
$r.openRuns = [ordered]@{ good = RunOpen $goodRoom }
$script:FakeServiceStatus = 'Stopped'; $r.openRuns.serviceStopped = RunOpen $goodRoom; $script:FakeServiceStatus = 'Running'
$r.openRuns.noFile = RunOpen $null
$r.openRuns.notJson = RunOpen 'nope'
$r.openRuns.codeWithSpace = RunOpen '{"port":51234,"code":"has a space 1234567890","pid":4321}'
$r.openRuns.codeShort = RunOpen '{"port":51234,"code":"short","pid":4321}'
$r.openRuns.portLow = RunOpen '{"port":80,"code":"AbCdEfGhIjKlMnOpQrStUv_-12","pid":4321}'
$r.openRuns.portText = RunOpen '{"port":"51234","code":"AbCdEfGhIjKlMnOpQrStUv_-12","pid":4321}'
$r.openRuns.pidText = RunOpen '{"port":51234,"code":"AbCdEfGhIjKlMnOpQrStUv_-12","pid":"4321"}'
$script:FakeListeners = @([pscustomobject]@{ LocalPort = 51234; OwningProcess = 999 }); $r.openRuns.otherProcessHoldsThePort = RunOpen $goodRoom
$script:FakeListeners = @(); $r.openRuns.nobodyHoldsThePort = RunOpen $goodRoom
Remove-Item -LiteralPath $work -Recurse -Force
# shortcuts and the Run entry
$sc = Get-ShortcutSpecs $L 'C:\Windows\System32' $true
$r.shortcuts = [ordered]@{
  specs = @($sc | ForEach-Object { [ordered]@{ path = $_.Path; target = $_.Target; arguments = $_.Arguments; workingDirectory = $_.WorkingDirectory } })
  withoutSetup = @(Get-ShortcutSpecs $L 'C:\Windows\System32' $false | ForEach-Object { Split-Path -Leaf $_.Path })
  matchSame = Count (Test-ShortcutMatches $sc[0] ([pscustomobject]@{ TargetPath = $sc[0].Target; Arguments = $sc[0].Arguments; WorkingDirectory = $sc[0].WorkingDirectory }))
  matchCaseOfPath = Count (Test-ShortcutMatches $sc[0] ([pscustomobject]@{ TargetPath = $sc[0].Target.ToUpperInvariant(); Arguments = $sc[0].Arguments; WorkingDirectory = $sc[0].WorkingDirectory.ToLowerInvariant() }))
  otherTarget = Test-ShortcutMatches $sc[0] ([pscustomobject]@{ TargetPath = 'C:\evil.exe'; Arguments = $sc[0].Arguments; WorkingDirectory = $sc[0].WorkingDirectory })
  otherArguments = Test-ShortcutMatches $sc[0] ([pscustomobject]@{ TargetPath = $sc[0].Target; Arguments = ($sc[0].Arguments + ' -Command x'); WorkingDirectory = $sc[0].WorkingDirectory })
  otherArgumentsCase = Test-ShortcutMatches $sc[0] ([pscustomobject]@{ TargetPath = $sc[0].Target; Arguments = $sc[0].Arguments.ToUpperInvariant(); WorkingDirectory = $sc[0].WorkingDirectory })
  missing = Test-ShortcutMatches $sc[0] $null
}
$run = Get-RunEntry $L
$r.run = [ordered]@{ keyPath = $run.KeyPath; name = $run.Name; command = $run.Command }
# the first layout: what a migration carries over, and what refuses it
$legacySettings = ConvertTo-HostJson ([ordered]@{ version = 1; projectId = 'albera-host'; broker = [ordered]@{ pipeName = 'ALBERA_HostBroker'; expect = [ordered]@{ serviceName = 'AlberaHostBroker' } }; authority = [ordered]@{ pipeRoot = 'ALBERA\ApprovalAuthority'; expect = [ordered]@{ serviceName = 'AlberaApprovalAuthority' } }; journal = $L.ControlPlaneJournal; computers = [ordered]@{ 'albera-clone-01' = 'clone-01' }; attestation = $null })
$legacyBroker = ConvertTo-HostJson (Get-BrokerConfig $L $cp $EcSpki $computers)
$legacyBrokerNoVm = $brokerJson
function LegacyManifest([bool]$grant, [string]$state = 'complete') { $m = NewManifest; $m['state'] = $state; if ($grant) { $m['created']['hyperVGrant'] = @{ group = 'S-1-5-32-578'; sid = $sids.Broker; computerId = 'clone-01'; vmId = $guidA } }; $serializer.DeserializeObject((ConvertTo-Json -InputObject $m -Depth 8 -Compress)) }
function Legacy($manifest, [string]$b, [string]$a, [string]$s) { $x = ConvertFrom-LegacyInstall $manifest $b $a $s; [ordered]@{ ok = $x.Ok; reasons = @($x.Reasons); values = $x.Values } }
$r.legacy = [ordered]@{
  noGrant = Legacy (LegacyManifest $false) $legacyBrokerNoVm $authorityJson $legacySettings
  grant = Legacy (LegacyManifest $true) $legacyBroker $authorityJson $legacySettings
  partial = Legacy (LegacyManifest $false 'partial') $legacyBrokerNoVm $authorityJson $legacySettings
  newLayout = Legacy ($serializer.DeserializeObject((ConvertTo-Json -InputObject (NewCpManifest) -Depth 8 -Compress))) $legacyBrokerNoVm $authorityJson $legacySettings
  badAuthority = Legacy (LegacyManifest $false) $legacyBrokerNoVm ($authorityJson -replace '"audience":"[^"]*"', '"audience":"Bad"') $legacySettings
  badBroker = Legacy (LegacyManifest $false) 'nope' $authorityJson $legacySettings
  grantButBrokerWithoutComputers = Legacy (LegacyManifest $true) $legacyBrokerNoVm $authorityJson $legacySettings
  grantComputerDiffers = Legacy (LegacyManifest $true) $legacyBroker $authorityJson ($legacySettings -replace 'clone-01', 'clone-02')
  twoComputers = Legacy (LegacyManifest $false) $legacyBrokerNoVm $authorityJson ($legacySettings -replace '"albera-clone-01":"clone-01"', '"albera-clone-01":"clone-01","other":"clone-02"')
  settingsNotJson = Legacy (LegacyManifest $false) $legacyBrokerNoVm $authorityJson 'nope'
  badVmName = Legacy (LegacyManifest $false) $legacyBrokerNoVm $authorityJson ($legacySettings -replace 'albera-clone-01', 'bad name!')
  badProject = Legacy (LegacyManifest $false) $legacyBrokerNoVm $authorityJson ($legacySettings -replace '"projectId":"albera-host"', '"projectId":"../x"')
}

ConvertTo-Json -InputObject $r -Depth 8 -Compress
