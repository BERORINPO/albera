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

# ---- approver output
$sample = @(
  'Windows Hello approver key (RSA-2048). Put these three values in the Authority config:',
  ('  "approverPublicKey": "' + $Rsa2048Spki + '",'), '  "approverKeyId": "hello-0123456789abcdef",', '  "approverSid": "S-1-5-21-1111111111-2222222222-3333333333-1001",',
  'Public values only. approverSid is this account: run approve as the same account, on this PC.', 'attestation: NotSupported (accepted with --accept-unattested: this key is NOT proven to be hardware-backed)',
  'Warning: trust these values only if they equal what your own first enroll printed. If you did not run enroll yourself, run enroll --replace.')
$shown = Read-ApproverShown $sample
$r.shown = $shown
$r.shownMissing = try { Read-ApproverShown ($sample | Where-Object { $_ -notlike '*approverSid*' }) | Out-Null; 'no error' } catch { $_.Exception.Message }
$r.shownRepeated = try { Read-ApproverShown ($sample + $sample[3]) | Out-Null; 'no error' } catch { $_.Exception.Message }
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
$goodFacts = [pscustomobject]@{ Exists = $true; StartName = 'NT SERVICE\AlberaHostBroker'; PathName = $r.brokerCommandLine; StartMode = 'Manual'; ServiceType = 'Own Process'; SidTypeText = "SERVICE_NAME: AlberaHostBroker`r`n        SERVICE_SID_TYPE:  RESTRICTED"; PrivilegesText = "SERVICE_NAME: AlberaHostBroker`r`n        PRIVILEGES       : SeChangeNotifyPrivilege" }
function WithFact($name, $value) { $c = $goodFacts.PSObject.Copy(); $c.$name = $value; $c }
$r.factsOk = Count (Test-ServiceFacts $goodFacts 'AlberaHostBroker' $r.brokerCommandLine)
$r.factsBad = [ordered]@{
  missing = Test-ServiceFacts ([pscustomobject]@{ Exists = $false }) 'AlberaHostBroker' $r.brokerCommandLine
  localSystem = Test-ServiceFacts (WithFact 'StartName' 'LocalSystem') 'AlberaHostBroker' $r.brokerCommandLine
  otherPath = Test-ServiceFacts (WithFact 'PathName' 'C:\evil.exe service x') 'AlberaHostBroker' $r.brokerCommandLine
  auto = Test-ServiceFacts (WithFact 'StartMode' 'Auto') 'AlberaHostBroker' $r.brokerCommandLine
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
$r.gate = [ordered]@{ labSupplied = $null -eq (Test-LabPasswordGate $true '1'); notLab = Test-LabPasswordGate $true ''; labWrongValue = Test-LabPasswordGate $true 'true'; noPassword = $null -eq (Test-LabPasswordGate $false '') }
$r.ids = @((Test-HostId 'albera-host'), (Test-HostId 'hello-951a135537287eae'), (Test-HostId '-x'), (Test-HostId ''), (Test-HostId 'a b'))
ConvertTo-Json -InputObject $r -Depth 8 -Compress
