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
function Components($brokerFiles) { @{ broker = $brokerFiles; authority = @{ 'albera-approval-authority.exe' = $c2 }; 'pipe-client' = @{ 'albera-windows-broker-pipe-client.exe' = $d } } }
$base = Components @{ 'albera-windows-broker.exe' = $a; 'sub/x.dll' = $b }
$r.tree = Get-CanonicalTreeHash $base
$r.treeBackslashAndOrder = Get-CanonicalTreeHash (Components ([ordered]@{ 'sub\x.dll' = $b; 'albera-windows-broker.exe' = $a }))
$r.treeOther = [ordered]@{
  changedFile = Get-CanonicalTreeHash (Components @{ 'albera-windows-broker.exe' = $a; 'sub/x.dll' = $c2 })
  renamedFile = Get-CanonicalTreeHash (Components @{ 'albera-windows-broker.exe' = $a; 'sub/y.dll' = $b })
  extraFile = Get-CanonicalTreeHash (Components @{ 'albera-windows-broker.exe' = $a; 'sub/x.dll' = $b; 'planted.dll' = $d })
  missingFile = Get-CanonicalTreeHash (Components @{ 'albera-windows-broker.exe' = $a })
  movedToAuthority = Get-CanonicalTreeHash @{ broker = @{ 'albera-windows-broker.exe' = $a }; authority = @{ 'albera-approval-authority.exe' = $c2; 'sub/x.dll' = $b }; 'pipe-client' = @{ 'albera-windows-broker-pipe-client.exe' = $d } }
}
# the documented format, built by hand: <component>/<path> TAB <sha> LF, components in the fixed order, paths ordinal-sorted, SHA-256 of the UTF-8 bytes
$text = "broker/albera-windows-broker.exe`t$a`nbroker/sub/x.dll`t$b`nauthority/albera-approval-authority.exe`t$c2`npipe-client/albera-windows-broker-pipe-client.exe`t$d`n"
$sha = [System.Security.Cryptography.SHA256]::Create()
$r.treeByHand = ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text))) -replace '-', '').ToLowerInvariant()
function Msg([scriptblock]$Block) { try { & $Block | Out-Null; 'no error' } catch { $_.Exception.Message } }
$r.treeBad = [ordered]@{
  missingComponent = Msg { Get-CanonicalTreeHash @{ broker = @{ 'a.exe' = $a }; authority = @{ 'b.exe' = $b } } }
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
ConvertTo-Json -InputObject $r -Depth 8 -Compress
