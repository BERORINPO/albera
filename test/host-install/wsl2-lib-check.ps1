# Test driver (Windows PowerShell 5.1, ASCII only, no admin): runs the PURE WSL2 helpers of scripts/host/albera-host-lib.ps1 (-AddWsl2Computer) and prints one JSON object. Node makes the keys and judges the answers.
#   wsl2-lib-check.ps1 -Spki <base64 P-256 SPKI> -OtherSpki <another> -Rsa <base64 RSA-2048 SPKI of the approver>
param([Parameter(Mandatory = $true)][string]$Spki, [Parameter(Mandatory = $true)][string]$OtherSpki, [Parameter(Mandatory = $true)][string]$Rsa)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\host\albera-host-lib.ps1')
$K = Get-HostConstants
$C = Get-Wsl2Constants
$L = Get-HostLayout 'C:\Program Files' 'C:\ProgramData'
$W = Get-Wsl2Layout $L
$cpSid = Get-DerivedServiceSid 'AlberaControlPlane'
$brokerSid = Get-DerivedServiceSid 'AlberaHostBroker'
$owner = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
$vm = '0f4b8a9e-1d2c-4b3a-8e7f-6a5b4c3d2e1f'
$h = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
$r = [ordered]@{}
function J($o) { ConvertTo-HostJson $o }
function Parse([string]$text) { $text | ConvertFrom-Json }
function Mutate([string]$json, [scriptblock]$edit) { $o = $json | ConvertFrom-Json; & $edit $o; $o | ConvertTo-Json -Compress -Depth 6 }

# ---- Test-ComputersList
$list = { param($text) Test-ComputersList ((('{"computers":' + $text + '}') | ConvertFrom-Json).computers) }
$r.computers = [ordered]@{
  vmOnly = (& $list ('[{"computerId":"clone-01","vmId":"' + $vm + '"}]'))
  wsl2Only = (& $list '[{"computerId":"wsl-01","kind":"wsl2"}]')
  mixed = (& $list ('[{"computerId":"clone-01","vmId":"' + $vm + '"},{"computerId":"wsl-01","kind":"wsl2"}]'))
  empty = (& $list '[]')
  wsl2WithVm = (& $list ('[{"computerId":"wsl-01","kind":"wsl2","vmId":"' + $vm + '"}]'))
  otherKind = (& $list '[{"computerId":"wsl-01","kind":"hyperv"}]')
  kindUppercase = (& $list '[{"computerId":"wsl-01","kind":"WSL2"}]')
  sameIdTwoKinds = (& $list ('[{"computerId":"clone-01","vmId":"' + $vm + '"},{"computerId":"clone-01","kind":"wsl2"}]'))
  sameIdTwice = (& $list '[{"computerId":"wsl-01","kind":"wsl2"},{"computerId":"wsl-01","kind":"wsl2"}]')
  badId = (& $list '[{"computerId":"-bad","kind":"wsl2"}]')
  extraKey = (& $list '[{"computerId":"wsl-01","kind":"wsl2","x":1}]')
  nine = (& $list ('[' + ((1..9 | ForEach-Object { '{"computerId":"w' + $_ + '","kind":"wsl2"}' }) -join ',') + ']'))
  eight = (& $list ('[' + ((1..8 | ForEach-Object { '{"computerId":"w' + $_ + '","kind":"wsl2"}' }) -join ',') + ']'))
  notArray = (Test-ComputersList ([pscustomobject]@{ computerId = 'wsl-01'; kind = 'wsl2' }))
  stringValue = (Test-ComputersList 'wsl2')
}

# ---- the Broker config with the wsl2 computer and the attestation key
$wsl2Broker = [pscustomobject]@{ ComputerId = 'wsl-01'; KeyName = $C.AttestationKeyName; KeyId = $C.AttestationKeyId }
$brokerPlain = J (Get-BrokerConfig $L $cpSid $Spki)
$brokerWsl2 = J (Get-BrokerConfig $L $cpSid $Spki $null $wsl2Broker)
$brokerBoth = J (Get-BrokerConfig $L $cpSid $Spki (Get-BrokerComputers 'clone-01' $vm) $wsl2Broker)
$r.broker = [ordered]@{
  plainKeys = @((Parse $brokerPlain).PSObject.Properties | ForEach-Object { $_.Name })
  wsl2Keys = @((Parse $brokerWsl2).PSObject.Properties | ForEach-Object { $_.Name })
  wsl2 = Parse $brokerWsl2
  plainReasons = Test-BrokerConfigText $brokerPlain
  wsl2Reasons = Test-BrokerConfigText $brokerWsl2
  bothReasons = Test-BrokerConfigText $brokerBoth
  bothComputers = @((Parse $brokerBoth).computers)
  bothHyperVRecordOk = (Test-BrokerConfigComputers $brokerBoth 'clone-01' $vm)
  wsl2OnlyHyperVRecord = (Test-BrokerConfigComputers $brokerWsl2 'clone-01' $vm)
  badAttestationName = Test-BrokerConfigText (Mutate $brokerWsl2 { param($o) $o.attestation.keyName = 'bad name' })
  badAttestationId = Test-BrokerConfigText (Mutate $brokerWsl2 { param($o) $o.attestation.keyId = '-x' })
  extraAttestationKey = Test-BrokerConfigText (Mutate $brokerWsl2 { param($o) $o.attestation | Add-Member -NotePropertyName extra -NotePropertyValue 1 })
  badKind = Test-BrokerConfigText (Mutate $brokerWsl2 { param($o) $o.computers[0].kind = 'vm' })
}

# ---- the Authority config pins the key
$approver = [pscustomobject]@{ approverSid = $owner; approverKeyId = 'hello-0123456789abcdef'; approverPublicKey = $Rsa }
$att = [pscustomobject]@{ keyId = $C.AttestationKeyId; spki = $Spki }
$authPlain = J (Get-AuthorityConfig $cpSid $approver)
$authAtt = J (Get-AuthorityConfig $cpSid $approver $att)
$state = Get-AuthorityConfigApproverKeys $authAtt
$rebuilt = J (Get-AuthorityConfig $cpSid $state.Approver $state.Attestation)
$r.authority = [ordered]@{
  plainKeys = @((Parse $authPlain).PSObject.Properties | ForEach-Object { $_.Name })
  attKeys = @((Parse $authAtt).PSObject.Properties | ForEach-Object { $_.Name })
  plainReasons = Test-AuthorityConfigText $authPlain
  attReasons = Test-AuthorityConfigText $authAtt
  onlyKeyId = Test-AuthorityConfigText (Mutate $authAtt { param($o) $o.PSObject.Properties.Remove('attestationPublicKey') })
  onlyPublicKey = Test-AuthorityConfigText (Mutate $authAtt { param($o) $o.PSObject.Properties.Remove('attestationKeyId') })
  badSpki = Test-AuthorityConfigText (Mutate $authAtt { param($o) $o.attestationPublicKey = $Rsa })
  badKeyId = Test-AuthorityConfigText (Mutate $authAtt { param($o) $o.attestationKeyId = '-no' })
  stateAttestationKeyId = $state.Attestation.keyId
  stateAttestationSpki = $state.Attestation.spki
  plainStateAttestation = (Get-AuthorityConfigApproverKeys $authPlain).Attestation
  rebuiltEqualsOriginal = ($rebuilt -ceq $authAtt)
}

# ---- the approval settings
$helper = $h
$settingsWsl2 = [pscustomobject]@{ ComputerId = 'wsl-01'; RepositoryId = 'repo-main'; PipeName = $C.BridgePipeName; ServerSid = $owner; Git = $C.DefaultGitPath }
$settingsJson = J (Get-ControlPlaneSettings $L 'albera-host' 'albera-clone-01' 'clone-01' $helper $settingsWsl2)
$noHelper = $null; try { Get-ControlPlaneSettings $L 'albera-host' 'albera-clone-01' 'clone-01' $null $settingsWsl2 | Out-Null } catch { $noHelper = $_.Exception.Message }
$expect = [pscustomobject]@{ KeyName = $C.AttestationKeyName; KeyId = $C.AttestationKeyId; ComputerId = 'wsl-01'; RepositoryId = 'repo-main'; PipeName = $C.BridgePipeName; ServerSid = $owner; Git = $C.DefaultGitPath }
$r.settings = [ordered]@{
  json = $settingsJson
  plainKeys = @((Parse (J (Get-ControlPlaneSettings $L 'albera-host' 'albera-clone-01' 'clone-01' $null $null))).PSObject.Properties | ForEach-Object { $_.Name })
  withoutHelperThrows = $noHelper
  reasons = Test-Wsl2SettingsText $settingsJson $expect
  noWsl2Block = Test-Wsl2SettingsText (Mutate $settingsJson { param($o) $o.PSObject.Properties.Remove('wsl2') }) $expect
  noComputer = Test-Wsl2SettingsText (Mutate $settingsJson { param($o) $o.computers.PSObject.Properties.Remove('wsl-01') }) $expect
  otherSid = Test-Wsl2SettingsText (Mutate $settingsJson { param($o) $o.wsl2.serverSid = $cpSid }) $expect
  otherRepo = Test-Wsl2SettingsText (Mutate $settingsJson { param($o) $o.computers.'wsl-01'.repositoryId = 'other' }) $expect
  noDesktop = Test-Wsl2SettingsText (Mutate $settingsJson { param($o) $o.PSObject.Properties.Remove('desktop') }) $expect
}

# ---- the bridge config
$inputs = [pscustomobject]@{ ComputerId = 'wsl-01'; RepositoryId = 'repo-main'; RepositoryPath = 'C:\Work\repo'; ImageSha256 = $h; GitPath = $C.DefaultGitPath; FloorExpiresAt = 1900000000 }
$bridge = J (Get-Wsl2BridgeConfig $W $cpSid $C.AttestationKeyId $Spki $inputs)
$m = { param($edit) Test-Wsl2BridgeConfigText (Mutate $bridge $edit) }
$r.bridge = [ordered]@{
  json = $bridge
  keys = @((Parse $bridge).PSObject.Properties | ForEach-Object { $_.Name })
  reasons = Test-Wsl2BridgeConfigText $bridge
  missingKey = & $m { param($o) $o.PSObject.Properties.Remove('gitPath') }
  extraKey = & $m { param($o) $o | Add-Member -NotePropertyName x -NotePropertyValue 1 }
  badSid = & $m { param($o) $o.controlPlaneSid = 'S-1-1-0' }
  badSpki = & $m { param($o) $o.brokerSpki = $Rsa }
  relativePath = & $m { param($o) $o.imagePath = 'albera.tar' }
  badHash = & $m { param($o) $o.imageSha256 = 'ABC' }
  floorZero = & $m { param($o) $o.floorExpiresAt = 0 }
  badVersion = & $m { param($o) $o.minWslVersion = 'two' }
  noRepositories = & $m { param($o) $o.repositories = @() }
  dupRepositories = & $m { param($o) $o.repositories = @($o.repositories[0], $o.repositories[0]) }
  repositoryExtra = & $m { param($o) $o.repositories[0] | Add-Member -NotePropertyName x -NotePropertyValue 1 }
  pipeBadStart = & $m { param($o) $o.pipeName = '_pipe' }
  tooLarge = Test-Wsl2BridgeConfigText ('{"a":"' + ('x' * 9000) + '"}')
  notJson = Test-Wsl2BridgeConfigText 'nope'
}

# ---- the inputs
$good = [pscustomobject]@{ ComputerId = 'wsl-01'; RepositoryId = 'repo-main'; RepositoryPath = 'C:\Work\repo'; ImagePath = 'C:\Images\a.tar'; ImageSha256 = $h; BridgeTreeHash = $h; FloorExpiresAt = 1900000000; GitPath = 'C:\Program Files\Git\cmd\git.exe' }
$with = { param($name, $value) $copy = $good.PSObject.Copy(); $copy.$name = $value; Test-Wsl2Inputs $copy 1800000000 'clone-01' }
$r.inputs = [ordered]@{
  good = Test-Wsl2Inputs $good 1800000000 'clone-01'
  sameAsVm = & $with 'ComputerId' 'clone-01'
  badComputer = & $with 'ComputerId' '-x'
  noRepository = & $with 'RepositoryId' $null
  relativeRepositoryPath = & $with 'RepositoryPath' 'repo'
  imageHashShort = & $with 'ImageSha256' 'abc'
  treeHashUpper = & $with 'BridgeTreeHash' $h.ToUpperInvariant()
  floorPast = & $with 'FloorExpiresAt' 1700000000
  floorNow = & $with 'FloorExpiresAt' 1800000000
  gitElsewhere = & $with 'GitPath' 'C:\Tools\git.exe'
  gitNotExe = & $with 'GitPath' 'C:\Program Files\Git\cmd\git'
  gitTraversal = & $with 'GitPath' 'C:\Program Files\Git\..\x\git.exe'
  gitPrefixTrick = & $with 'GitPath' 'C:\Program Files\Git2\git.exe'
  gitLowercase = & $with 'GitPath' 'c:\program files\git\cmd\git.exe'
}

# ---- tree hash, floor file, run entry, ACL plan, record
$files = @{ 'albera-wsl-bridge.exe' = $h; 'sub\data.json' = ('f' * 64); 'a.dll' = ('1' * 64) }
$r.treeHash = Get-Wsl2BridgeTreeHash $files
$emptyTree = $null; try { Get-Wsl2BridgeTreeHash @{} | Out-Null } catch { $emptyTree = $_.Exception.Message }
$badTree = $null; try { Get-Wsl2BridgeTreeHash @{ '..\x' = $h } | Out-Null } catch { $badTree = $_.Exception.Message }
$r.treeHashErrors = [ordered]@{ empty = $emptyTree; traversal = $badTree }
$r.floor = [ordered]@{
  text = (Get-Wsl2LeaseFloorText 7)
  read = [ordered]@{ ok = (Read-Wsl2LeaseFloor "7`r`n"); noEol = (Read-Wsl2LeaseFloor '12'); empty = (Read-Wsl2LeaseFloor ''); text = (Read-Wsl2LeaseFloor 'seven'); zero = (Read-Wsl2LeaseFloor '0'); negative = (Read-Wsl2LeaseFloor '-1'); twoLines = (Read-Wsl2LeaseFloor "1`n2"); long = (Read-Wsl2LeaseFloor ('1' * 33)) }
}
$zero = $null; try { Get-Wsl2LeaseFloorText 0 | Out-Null } catch { $zero = $_.Exception.Message }
$r.floor.zeroThrows = $zero
$entry = Get-Wsl2RunEntry $W
$r.run = [ordered]@{ name = $entry.Name; command = $entry.Command; keyPath = $entry.KeyPath }
$plan = Get-Wsl2AclPlan $W @{ Approver = $owner }
$r.acl = [ordered]@{
  paths = @($plan | ForEach-Object { $_.Path })
  grants = @($plan | ForEach-Object { , @($_.Grants) })
  writers = @($plan | ForEach-Object { $writ = Get-PlannedWriters $_; , @($writ) })
}
$noOwner = $null; try { Get-Wsl2AclPlan $W @{ Approver = $null } | Out-Null } catch { $noOwner = $_.Exception.Message }
$r.acl.noOwnerThrows = $noOwner
$rec = { param($edit) $d = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $d['computerId'] = 'wsl-01'; $d['repositoryId'] = 'repo-main'; $d['keyName'] = $C.AttestationKeyName; $d['keyId'] = $C.AttestationKeyId; & $edit $d; Test-Wsl2Record $d }
$run = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $run['name'] = $C.RunValueName; $run['command'] = $entry.Command
$r.record = [ordered]@{
  minimal = (& $rec { param($d) })
  full = (& $rec { param($d) $d['gitPath'] = $C.DefaultGitPath; $d['bridgeTreeSha256'] = $h; $d['bridgeExeSha256'] = $h; $d['imageSha256'] = $h; $d['floorGeneration'] = 1; $d['runEntry'] = $run })
  extraKey = (& $rec { param($d) $d['x'] = 1 })
  otherKeyName = (& $rec { param($d) $d['keyName'] = 'AlberaApprovalAuthority-host-1' })
  otherRunName = (& $rec { param($d) $bad = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $bad['name'] = 'AlberaApprover'; $bad['command'] = 'x'; $d['runEntry'] = $bad })
  badHash = (& $rec { param($d) $d['imageSha256'] = 'zz' })
  badGit = (& $rec { param($d) $d['gitPath'] = 'C:\Windows\cmd.exe' })
  notDictionary = (Test-Wsl2Record ([pscustomobject]@{ computerId = 'wsl-01' }))
}
# the manifest shape knows the record and the spki
$manifest = { param($edit) $m = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $cr = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $v = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $m['schema'] = 1; $m['tool'] = 'albera-host.ps1'; $m['state'] = 'partial'; $m['created'] = $cr; $m['values'] = $v; & $edit $cr $v; Test-ManifestShape $m }
$goodRec = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $goodRec['computerId'] = 'wsl-01'; $goodRec['repositoryId'] = 'repo-main'; $goodRec['keyName'] = $C.AttestationKeyName; $goodRec['keyId'] = $C.AttestationKeyId
$badRec = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $badRec['computerId'] = 'wsl-01'
$r.manifest = [ordered]@{
  withRecord = (& $manifest { param($cr, $v) $cr['wsl2'] = $goodRec; $v['attestationSpki'] = $Spki })
  badRecord = (& $manifest { param($cr, $v) $cr['wsl2'] = $badRec })
  badSpki = (& $manifest { param($cr, $v) $v['attestationSpki'] = $Rsa })
}

# ---- the agreement of the key, its three copies, the floor and the names
$expectKey = [pscustomobject]@{ KeyName = $C.AttestationKeyName; KeyId = $C.AttestationKeyId; ComputerId = 'wsl-01'; RepositoryId = 'repo-main' }
$floorText = Get-Wsl2LeaseFloorText $K.Generation
$agree = { param($broker, $authority, $bridgeJson, $floor, $live) Test-Wsl2KeyAgreement $expectKey $live $broker $authority $bridgeJson $floor }
$goodBroker = $brokerBoth; $goodAuth = $authAtt; $goodBridge = $bridge
$r.agreement = [ordered]@{
  allAgree = & $agree $goodBroker $goodAuth $goodBridge $floorText $Spki
  liveKeyDiffers = & $agree $goodBroker $goodAuth $goodBridge $floorText $OtherSpki
  authorityPinsOther = & $agree $goodBroker (Mutate $goodAuth { param($o) $o.attestationPublicKey = $OtherSpki }) $goodBridge $floorText $Spki
  authorityKeyId = & $agree $goodBroker (Mutate $goodAuth { param($o) $o.attestationKeyId = 'albera-other' }) $goodBridge $floorText $Spki
  authorityNoPin = & $agree $goodBroker $authPlain $goodBridge $floorText $Spki
  bridgeSpki = & $agree $goodBroker $goodAuth (Mutate $goodBridge { param($o) $o.brokerSpki = $OtherSpki }) $floorText $Spki
  bridgeKeyId = & $agree $goodBroker $goodAuth (Mutate $goodBridge { param($o) $o.brokerKeyId = 'albera-other' }) $floorText $Spki
  brokerKeyId = & $agree (Mutate $goodBroker { param($o) $o.attestation.keyId = 'albera-other' }) $goodAuth $goodBridge $floorText $Spki
  brokerKeyName = & $agree (Mutate $goodBroker { param($o) $o.attestation.keyName = 'Other-key' }) $goodAuth $goodBridge $floorText $Spki
  brokerNoAttestation = & $agree $brokerPlain $goodAuth $goodBridge $floorText $Spki
  brokerNoWsl2 = & $agree (Mutate $goodBroker { param($o) $o.computers = @($o.computers[0]) }) $goodAuth $goodBridge $floorText $Spki
  brokerOtherComputer = & $agree (Mutate $goodBroker { param($o) $o.computers[1].computerId = 'wsl-02' }) $goodAuth $goodBridge $floorText $Spki
  bridgeComputer = & $agree $goodBroker $goodAuth (Mutate $goodBridge { param($o) $o.computerId = 'wsl-02' }) $floorText $Spki
  bridgeRepository = & $agree $goodBroker $goodAuth (Mutate $goodBridge { param($o) $o.repositories[0].repositoryId = 'other' }) $floorText $Spki
  floorAbove = & $agree $goodBroker $goodAuth $goodBridge (Get-Wsl2LeaseFloorText 2) $Spki
  floorBelow = & $agree (Mutate $goodBroker { param($o) $o.generation = 5 }) $goodAuth $goodBridge $floorText $Spki
  floorMissing = & $agree $goodBroker $goodAuth $goodBridge $null $Spki
  floorGarbage = & $agree $goodBroker $goodAuth $goodBridge 'one' $Spki
  brokerUnreadable = & $agree 'nope' $goodAuth $goodBridge $floorText $Spki
  authorityUnreadable = & $agree $goodBroker $null $goodBridge $floorText $Spki
  bridgeUnreadable = & $agree $goodBroker $goodAuth '' $floorText $Spki
  badLiveSpki = & $agree $goodBroker $goodAuth $goodBridge $floorText 'AAAA'
}
# ---- round 2: strict floor, the bridge fields, the floor ACL, the first-start record, the real git.exe
$expectFull = [pscustomobject]@{ KeyName = $C.AttestationKeyName; KeyId = $C.AttestationKeyId; ComputerId = 'wsl-01'; RepositoryId = 'repo-main'; PipeName = $C.BridgePipeName; ControlPlaneSid = $cpSid; Git = $C.DefaultGitPath; ImageSha256 = $h }
$full = { param($edit) Test-Wsl2KeyAgreement $expectFull $Spki $goodBroker $goodAuth (Mutate $goodBridge $edit) $floorText }
$brokerGen5 = Mutate $goodBroker { param($o) $o.generation = 5 }
$r.agreement2 = [ordered]@{
  fullAgree = & $full { param($o) }
  pipe = & $full { param($o) $o.pipeName = 'OTHER' }
  cp = & $full { param($o) $o.controlPlaneSid = $owner }
  git = & $full { param($o) $o.gitPath = 'C:\Program Files\Git\cmd\git.exe' }
  image = & $full { param($o) $o.imageSha256 = ('9' * 64) }
  strictEqual = Test-Wsl2KeyAgreement $expectKey $Spki $goodBroker $goodAuth $goodBridge $floorText $true
  strictBelow = Test-Wsl2KeyAgreement $expectKey $Spki $brokerGen5 $goodAuth $goodBridge $floorText $true
  strictAbove = Test-Wsl2KeyAgreement $expectKey $Spki $goodBroker $goodAuth $goodBridge (Get-Wsl2LeaseFloorText 2) $true
  lenientBelow = Test-Wsl2KeyAgreement $expectKey $Spki $brokerGen5 $goodAuth $goodBridge $floorText $false
}
$r.floorAcl = [ordered]@{
  good = Test-Wsl2FloorAcl @('S-1-5-18', 'S-1-5-32-544', $owner) $owner
  adminsOnly = Test-Wsl2FloorAcl @('S-1-5-18', 'S-1-5-32-544') $owner
  users = Test-Wsl2FloorAcl @('S-1-5-18', 'S-1-5-32-544', $owner, 'S-1-5-32-545') $owner
  service = Test-Wsl2FloorAcl @('S-1-5-18', $brokerSid) $owner
  everyone = Test-Wsl2FloorAcl @('S-1-1-0') $owner
}
$rec2 = { param($edit) $d = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $d['computerId'] = 'wsl-01'; $d['repositoryId'] = 'repo-main'; $d['keyName'] = $C.AttestationKeyName; $d['keyId'] = $C.AttestationKeyId; & $edit $d; Test-Wsl2Record $d }
$fs = { param($word, $at) $f = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $f['word'] = $word; $f['at'] = $at; $f }
$r.firstStartRecord = [ordered]@{
  good = (& $rec2 { param($d) $d['firstStart'] = (& $fs 'control_plane_is_self' '2026-11-07T01:02:03Z') })
  otherWord = (& $rec2 { param($d) $d['firstStart'] = (& $fs 'elevated' '2026-11-07T01:02:03Z') })
  badTime = (& $rec2 { param($d) $d['firstStart'] = (& $fs 'control_plane_is_self' 'yesterday') })
  notDict = (& $rec2 { param($d) $d['firstStart'] = 'control_plane_is_self' })
}
$r.git = [ordered]@{ default = $C.DefaultGitPath; defaultOk = (Test-Wsl2GitPath $C.DefaultGitPath); firstStartWord = $C.FirstStartWord }
# ---- round 3: the gate of -Mode wsl2-run-entry
function Rep([hashtable]$v) { [pscustomobject]$v }
$goodV = [ordered]@{ keyCannotBeExported = 'yes'; asExpected_broker = 'yes'; asExpected_other = 'yes'; asExpected_controlplane = 'yes' }
$c6 = { param($edit) $o = [pscustomobject]@{ phase = 'C6'; failed = $false; verdicts = $null }; $o.verdicts = [pscustomobject]$goodV; & $edit $o; $o }
$sec2good = [pscustomobject]@{ ownerCheck = 'works'; imagePin = 'works' }
$gate = { param($edit, $sec, $accept) Test-Wsl2Gate (& $c6 $edit) $sec $accept }
$r.gate = [ordered]@{
  good = & $gate { param($o) } $sec2good $false
  pinFails = & $gate { param($o) } ([pscustomobject]@{ ownerCheck = 'works'; imagePin = 'fails_from_this_account:server_identity_unavailable' }) $false
  noC6 = Test-Wsl2Gate $null $sec2good $false
  noSec2 = Test-Wsl2Gate (& $c6 { param($o) }) $null $false
  phaseN7 = & $gate { param($o) $o.phase = 'N7' } $sec2good $false
  failed = & $gate { param($o) $o.failed = $true } $sec2good $false
  unexpected = & $gate { param($o) $o.verdicts.asExpected_other = 'NO' } $sec2good $false
  unexpectedEvenAccepted = & $gate { param($o) $o.verdicts.asExpected_other = 'NO' } $sec2good $true
  notMeasured = & $gate { param($o) $o.verdicts.asExpected_controlplane = 'not_measured' } $sec2good $false
  notMeasuredAccepted = & $gate { param($o) $o.verdicts.asExpected_controlplane = 'not_measured' } $sec2good $true
  exportable = & $gate { param($o) $o.verdicts.keyCannotBeExported = 'no' } $sec2good $true
  exportNotMeasured = & $gate { param($o) $o.verdicts.keyCannotBeExported = 'not_measured' } $sec2good $false
  incomplete = & $gate { param($o) $o.verdicts = [pscustomobject]@{ keyCannotBeExported = 'yes'; asExpected_broker = 'yes' } } $sec2good $false
  ownerCheckFails = & $gate { param($o) } ([pscustomobject]@{ ownerCheck = 'accepts_any_owner'; imagePin = 'works' }) $false
  sec2NotMeasured = & $gate { param($o) } ([pscustomobject]@{ ownerCheck = 'not_measured'; imagePin = 'not_measured' }) $false
  sec2NotMeasuredAccepted = & $gate { param($o) } ([pscustomobject]@{ ownerCheck = 'not_measured'; imagePin = 'not_measured' }) $true
  sec2OddPin = & $gate { param($o) } ([pscustomobject]@{ ownerCheck = 'works'; imagePin = 'maybe' }) $false
}
$mp = Get-MeasurePaths 'C:\ProgramData'
$r.measurePaths = $mp
$r | ConvertTo-Json -Depth 12 -Compress
