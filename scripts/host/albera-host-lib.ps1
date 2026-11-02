# Helpers for scripts/host/albera-host.ps1 (dot-sourced). Windows PowerShell 5.1, ASCII only.
# Everything in the first half is PURE: it takes values and returns values (no file, no registry, no service, no account is touched), so the tests call it directly.
# The second half (key and process helpers) touches the system; only albera-host.ps1 install / uninstall calls those with machine scope.

# ---------------------------------------------------------------------------------------------- fixed names and values
function Get-HostConstants {
  [ordered]@{
    BrokerService = 'AlberaHostBroker'
    AuthorityService = 'AlberaApprovalAuthority'
    ControlPlaneUser = 'albera-cp'
    ControlPlaneUserDescription = 'ALBERA Control Plane account (created by albera-host.ps1)'
    BrokerPipeName = 'ALBERA_HostBroker'
    AuthorityPipeRoot = 'ALBERA\ApprovalAuthority'
    AuthorityKid = 'albera-authority-1'
    Audience = 'albera-host-broker'
    PolicyVersion = 'albera-host-policy-1'
    LeaseId = 'albera-host-lease-1'
    Generation = 1
    SigningKeyName = 'AlberaApprovalAuthority-host-1'
    SigningKeyProvider = 'software'
    DefaultProjectId = 'albera-host'
    DefaultVmName = 'albera-clone-01'
    DefaultComputerId = 'clone-01'
  }
}

# Where everything goes. Pure: the two roots come in as parameters (the script passes the machine's Program Files and ProgramData).
function Get-HostLayout([string]$ProgramFiles, [string]$ProgramData) {
  $c = Get-HostConstants
  $install = Join-Path $ProgramFiles 'Albera'
  $data = Join-Path $ProgramData 'Albera'
  [ordered]@{
    InstallRoot = $install
    BinRoot = Join-Path $install 'bin'
    BrokerBinDir = Join-Path $install 'bin\broker'
    AuthorityBinDir = Join-Path $install 'bin\authority'
    PipeClientBinDir = Join-Path $install 'bin\pipe-client'
    BrokerExe = Join-Path $install 'bin\broker\albera-windows-broker.exe'
    AuthorityExe = Join-Path $install 'bin\authority\albera-approval-authority.exe'
    PipeClientExe = Join-Path $install 'bin\pipe-client\albera-windows-broker-pipe-client.exe'
    DataRoot = $data
    ManifestPath = Join-Path $data 'install-manifest.json'
    BrokerConfigDir = Join-Path $data 'broker-config'
    BrokerConfig = Join-Path $data ('broker-config\' + $c.BrokerService + '.service.json')
    BrokerDbDir = Join-Path $data 'broker'
    BrokerDb = Join-Path $data 'broker\journal.sqlite'
    AuthorityDir = Join-Path $data 'authority'
    AuthorityConfig = Join-Path $data ('authority\' + $c.AuthorityService + '.service.json')
    ControlPlaneDir = Join-Path $data 'control-plane'
    ApprovalSettings = Join-Path $data 'control-plane\albera.approval.json'
    ControlPlaneJournal = Join-Path $data 'control-plane\operations.sqlite'
  }
}

# The files a normal run of the installed services and the control plane leave inside the data root. Uninstall removes the root only when it holds nothing else.
function Get-KnownDataFiles {
  @(
    'install-manifest.json',
    'broker-config\AlberaHostBroker.service.json',
    'broker\journal.sqlite', 'broker\journal.sqlite-wal', 'broker\journal.sqlite-shm', 'broker\journal.sqlite-journal',
    'authority\AlberaApprovalAuthority.service.json', 'authority\policy.json',
    'control-plane\albera.approval.json', 'control-plane\operations.sqlite', 'control-plane\operations.sqlite-wal', 'control-plane\operations.sqlite-shm'
  )
}
function Get-KnownDataFolders { @('broker-config', 'broker', 'authority', 'control-plane') }

# ---------------------------------------------------------------------------------------------- validators (mirror the C# rules)
$script:IdRegex = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'   # ActionDigest.IdPattern
function Test-HostId([string]$Value) { ($null -ne $Value) -and ($Value -cmatch $script:IdRegex) }
function Test-AudienceName([string]$Value) { ($null -ne $Value) -and ($Value -cmatch '^[a-z][a-z0-9-]{0,63}$') }
function Test-KeyName([string]$Value) { ($null -ne $Value) -and ($Value -cmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') }
function Test-PipeRoot([string]$Value) { ($null -ne $Value) -and ($Value.Length -le 128) -and ($Value -cmatch '^ALBERA(\\[A-Za-z0-9][A-Za-z0-9._-]{0,31}){1,3}$') }
function Test-PlainPipeName([string]$Value) { ($null -ne $Value) -and ($Value.Length -ge 1) -and ($Value.Length -le 128) -and ($Value -cmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') }
# "C:\dir\file", already in the form GetFullPath returns (ServiceConfig.IsPlainAbsolutePath): no relative, UNC, device, '..', '/', doubled separators, streams, wildcards.
function Test-PlainAbsolutePath([string]$Path) {
  if ($null -eq $Path -or $Path.Length -lt 4 -or $Path.Length -gt 240) { return $false }
  if ($Path[0] -notmatch '^[A-Za-z]$' -or $Path[1] -ne ':' -or $Path[2] -ne '\') { return $false }
  if ($Path[$Path.Length - 1] -eq '\' -or $Path.IndexOf(':', 2) -ge 0) { return $false }
  if ($Path.IndexOfAny([System.IO.Path]::GetInvalidPathChars()) -ge 0 -or $Path.IndexOfAny([char[]]@('*', '?')) -ge 0) { return $false }
  try { return [string]::Equals([System.IO.Path]::GetFullPath($Path), $Path, [System.StringComparison]::Ordinal) } catch { return $false }
}
# S-1-5-21-a-b-c-rid (an account SID, 8 parts). The Broker and the Authority also look it up and insist it is a USER; that part needs the machine.
function Test-AccountSidShape([string]$Sid) { ($null -ne $Sid) -and ($Sid -cmatch '^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$') }
function Test-ServiceSidShape([string]$Sid) { ($null -ne $Sid) -and ($Sid -cmatch '^S-1-5-80(-[0-9]+){5}$') }

function ConvertFrom-Base64Safe([string]$Text) {
  if ([string]::IsNullOrEmpty($Text) -or ($Text -notmatch '^[A-Za-z0-9+/]+={0,2}$') -or (($Text.Length % 4) -ne 0)) { return $null }
  try { return , [Convert]::FromBase64String($Text) } catch { return $null }
}

$script:P256SpkiPrefix = [byte[]](0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01, 0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04)
$script:Rsa2048SpkiPrefix = [byte[]](0x30, 0x82, 0x01, 0x22, 0x30, 0x0D, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01, 0x05, 0x00, 0x03, 0x82, 0x01, 0x0F, 0x00)

function Test-BytesStartWith([byte[]]$Bytes, [byte[]]$Prefix) {
  if ($Bytes.Length -lt $Prefix.Length) { return $false }
  for ($i = 0; $i -lt $Prefix.Length; $i++) { if ($Bytes[$i] -ne $Prefix[$i]) { return $false } }
  $true
}
# 91 bytes: the fixed ECDSA P-256 SubjectPublicKeyInfo header, then 0x04 || X || Y. (The Broker imports it with ImportSubjectPublicKeyInfo and insists on 256 bits.)
function Test-P256Spki([string]$Base64) {
  $bytes = ConvertFrom-Base64Safe $Base64
  ($null -ne $bytes) -and ($bytes.Length -eq 91) -and (Test-BytesStartWith $bytes $script:P256SpkiPrefix)
}
# RSA-2048 SPKI as Windows Hello's KeyCredential gives it: 294 bytes with the fixed header (the Authority's RsaPresenceVerifier pins exactly this size).
function Test-Rsa2048Spki([string]$Base64) {
  $bytes = ConvertFrom-Base64Safe $Base64
  ($null -ne $bytes) -and ($bytes.Length -eq 294) -and (Test-BytesStartWith $bytes $script:Rsa2048SpkiPrefix)
}

# BCRYPT_ECCKEY_BLOB for a P-256 ECDSA public key (CngKey.Export EccPublicBlob): magic 'ECS1' (0x31534345), cbKey 32, then X (32) and Y (32).
function ConvertTo-P256Spki([byte[]]$EccPublicBlob) {
  if ($EccPublicBlob.Length -ne 72 -or [BitConverter]::ToUInt32($EccPublicBlob, 0) -ne 0x31534345 -or [BitConverter]::ToUInt32($EccPublicBlob, 4) -ne 32) { throw 'public_blob_not_p256_ecdsa' }
  $spki = New-Object byte[] 91
  [Array]::Copy($script:P256SpkiPrefix, 0, $spki, 0, $script:P256SpkiPrefix.Length)
  [Array]::Copy($EccPublicBlob, 8, $spki, $script:P256SpkiPrefix.Length, 64)
  [Convert]::ToBase64String($spki)
}
function ConvertFrom-P256Spki([string]$Base64) {
  if (-not (Test-P256Spki $Base64)) { throw 'not_a_p256_spki' }
  $spki = [Convert]::FromBase64String($Base64)
  $blob = New-Object byte[] 72
  [BitConverter]::GetBytes([uint32]0x31534345).CopyTo($blob, 0)
  [BitConverter]::GetBytes([uint32]32).CopyTo($blob, 4)
  [Array]::Copy($spki, $script:P256SpkiPrefix.Length, $blob, 8, 64)
  , $blob
}

# The per-service SID of a service name: S-1-5-80 plus the SHA-1 of the upper-cased UTF-16LE name as five little-endian DWORDs (what the C# ServicePathGuard derives).
function Get-DerivedServiceSid([string]$ServiceName) {
  $sha1 = [System.Security.Cryptography.SHA1]::Create()
  try { $hash = $sha1.ComputeHash([System.Text.Encoding]::Unicode.GetBytes($ServiceName.ToUpperInvariant())) } finally { $sha1.Dispose() }
  $parts = for ($i = 0; $i -lt 5; $i++) { [BitConverter]::ToUInt32($hash, $i * 4) }
  'S-1-5-80-' + ($parts -join '-')
}

# ---------------------------------------------------------------------------------------------- approver values
# The owner runs `AlberaApprover.exe enroll --show` in a NORMAL console and passes the three public values as parameters (the installer never runs that exe: it is elevated).
# The checks the installer owes before it writes the Authority config. Returns the reasons (an empty list means all hold).
function Test-ApproverValues($Shown, [string]$ExpectedKeyId, [string]$ControlPlaneSid) {
  $reasons = New-Object System.Collections.Generic.List[string]
  if (-not (Test-HostId $ExpectedKeyId)) { $reasons.Add('expected_key_id_invalid') }
  if ($Shown.approverKeyId -cne $ExpectedKeyId) { $reasons.Add('approver_key_id_differs_from_expected') }
  if (-not (Test-HostId $Shown.approverKeyId)) { $reasons.Add('approver_key_id_invalid') }
  if (-not (Test-Rsa2048Spki $Shown.approverPublicKey)) { $reasons.Add('approver_public_key_not_rsa2048_spki') }
  if (-not (Test-AccountSidShape $Shown.approverSid)) { $reasons.Add('approver_sid_not_a_user_sid') }
  if ($ControlPlaneSid -and ($Shown.approverSid -ceq $ControlPlaneSid)) { $reasons.Add('approver_sid_equals_control_plane_sid') }
  , @($reasons)
}

# ---------------------------------------------------------------------------------------------- the three config files
function Get-BrokerConfig($Layout, [string]$ControlPlaneSid, [string]$AuthoritySpki) {
  $c = Get-HostConstants
  [ordered]@{
    pipeName = $c.BrokerPipeName
    database = $Layout.BrokerDb
    authorityKeys = @([ordered]@{ kid = $c.AuthorityKid; spki = $AuthoritySpki })
    controlPlaneSid = $ControlPlaneSid
    generation = $c.Generation
    leaseId = $c.LeaseId
    policyVersion = $c.PolicyVersion
  }
}
function Get-AuthorityConfig([string]$ControlPlaneSid, $Approver) {
  $c = Get-HostConstants
  [ordered]@{
    pipeRoot = $c.AuthorityPipeRoot
    controlPlaneSid = $ControlPlaneSid
    approverSid = $Approver.approverSid
    signingKeyName = $c.SigningKeyName
    signingKeyProvider = $c.SigningKeyProvider
    kid = $c.AuthorityKid
    approverKeyId = $Approver.approverKeyId
    approverPublicKey = $Approver.approverPublicKey
    audience = $c.Audience
    policyVersion = $c.PolicyVersion
  }
}
# examples/albera.approval.example.json without the attestation (null: the first run asks a person). The settings parser needs at least one computer; approval-check uses the first.
function Get-ControlPlaneSettings($Layout, [string]$ProjectId, [string]$VmName, [string]$ComputerId) {
  $c = Get-HostConstants
  [ordered]@{
    version = 1
    projectId = $ProjectId
    broker = [ordered]@{ pipeName = $c.BrokerPipeName; expect = [ordered]@{ serviceName = $c.BrokerService } }
    authority = [ordered]@{ pipeRoot = $c.AuthorityPipeRoot; expect = [ordered]@{ serviceName = $c.AuthorityService } }
    journal = $Layout.ControlPlaneJournal
    computers = [ordered]@{ $VmName = $ComputerId }
    attestation = $null
  }
}
function ConvertTo-HostJson($Object) { $Object | ConvertTo-Json -Depth 6 -Compress }

function Get-ObjectKeys($Object) { @($Object.PSObject.Properties | ForEach-Object { $_.Name }) }
function Test-SameKeySet($Object, [string[]]$Expected) {
  $keys = Get-ObjectKeys $Object
  ($keys.Count -eq $Expected.Count) -and (@($keys | Where-Object { $Expected -ccontains $_ }).Count -eq $Expected.Count)
}
function Get-ByteLength([string]$Text) { [System.Text.Encoding]::UTF8.GetByteCount($Text) }

# Each returns the list of fixed reason words (empty = the real service would accept the shape). They cannot see the machine (the SID lookup, the folder ACLs, whether a folder
# exists), and `service-check` run from an elevated console cannot either: see albera-host.ps1 ("service-check is inconclusive").
function Test-BrokerConfigText([string]$Json) {
  $reasons = New-Object System.Collections.Generic.List[string]
  if ((Get-ByteLength $Json) -gt 4096) { $reasons.Add('config_too_large'); return , @($reasons) }
  try { $o = $Json | ConvertFrom-Json } catch { $reasons.Add('config_syntax'); return , @($reasons) }
  $expected = @('pipeName', 'database', 'authorityKeys', 'controlPlaneSid', 'generation', 'leaseId', 'policyVersion')
  if (-not (Test-SameKeySet $o $expected)) { $reasons.Add('config_keys'); return , @($reasons) }
  if (-not (Test-PlainPipeName $o.pipeName)) { $reasons.Add('pipe_name') }
  if (-not (Test-PlainAbsolutePath $o.database)) { $reasons.Add('database') }
  $keys = @($o.authorityKeys)
  $keysOk = ($keys.Count -ge 1) -and ($keys.Count -le 2)
  foreach ($k in $keys) {
    if (-not (Test-SameKeySet $k @('kid', 'spki')) -or -not (Test-HostId $k.kid) -or -not (Test-P256Spki $k.spki)) { $keysOk = $false }
  }
  if ($keysOk -and (@($keys | ForEach-Object { $_.kid } | Sort-Object -Unique).Count -ne $keys.Count)) { $keysOk = $false }
  if (-not $keysOk) { $reasons.Add('authority_keys') }
  if (-not ((Test-AccountSidShape $o.controlPlaneSid) -or (Test-ServiceSidShape $o.controlPlaneSid))) { $reasons.Add('control_plane_sid') }
  if (-not (($o.generation -is [int] -or $o.generation -is [long]) -and $o.generation -ge 1)) { $reasons.Add('generation') }
  if (-not (Test-HostId $o.leaseId)) { $reasons.Add('lease_id') }
  if (-not (Test-HostId $o.policyVersion)) { $reasons.Add('policy_version') }
  , @($reasons)
}
function Test-AuthorityConfigText([string]$Json) {
  $reasons = New-Object System.Collections.Generic.List[string]
  if ((Get-ByteLength $Json) -gt 4096) { $reasons.Add('config_too_large'); return , @($reasons) }
  try { $o = $Json | ConvertFrom-Json } catch { $reasons.Add('config_syntax'); return , @($reasons) }
  $expected = @('pipeRoot', 'controlPlaneSid', 'approverSid', 'signingKeyName', 'signingKeyProvider', 'kid', 'approverKeyId', 'approverPublicKey', 'audience', 'policyVersion')
  $allStrings = @($o.PSObject.Properties | Where-Object { $_.Value -isnot [string] }).Count -eq 0
  if (-not (Test-SameKeySet $o $expected) -or -not $allStrings) { $reasons.Add('config_keys'); return , @($reasons) }
  if (-not (Test-PipeRoot $o.pipeRoot)) { $reasons.Add('pipe_root') }
  if (-not ((Test-AccountSidShape $o.controlPlaneSid) -or (Test-ServiceSidShape $o.controlPlaneSid))) { $reasons.Add('control_plane_sid') }
  if (-not (Test-AccountSidShape $o.approverSid)) { $reasons.Add('approver_sid') }
  if ($o.controlPlaneSid -ceq $o.approverSid) { $reasons.Add('sids_not_distinct') }
  if (-not (Test-KeyName $o.signingKeyName)) { $reasons.Add('signing_key') }
  if ($o.signingKeyProvider -cne 'software' -and $o.signingKeyProvider -cne 'tpm') { $reasons.Add('signing_provider') }
  if (-not (Test-HostId $o.kid)) { $reasons.Add('kid') }
  if (-not (Test-HostId $o.approverKeyId)) { $reasons.Add('approver_key_id') }
  if (-not (Test-Rsa2048Spki $o.approverPublicKey)) { $reasons.Add('approver_public_key') }
  if (-not (Test-AudienceName $o.audience)) { $reasons.Add('audience') }
  if (-not (Test-HostId $o.policyVersion)) { $reasons.Add('policy_version') }
  , @($reasons)
}

# ---------------------------------------------------------------------------------------------- folders and ACLs
# One entry per folder: icacls grants ('*SID:rights'). Inheritance is removed on every folder; SYSTEM and Administrators get full control; nobody else gets write unless it is their own
# folder. Same pattern as Set-LabAcl in test/windows-service-lab/lab-guest.ps1. `Sids` = @{ Broker; Authority; ControlPlane } (SID strings).
function Get-AclPlan($Layout, $Sids) {
  $full = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
  $b = $Sids.Broker; $a = $Sids.Authority; $cp = $Sids.ControlPlane
  @(
    [pscustomobject]@{ Path = $Layout.InstallRoot; Grants = @($full + @("*${b}:(OI)(CI)RX", "*${a}:(OI)(CI)RX", "*${cp}:(OI)(CI)RX")) }
    [pscustomobject]@{ Path = $Layout.DataRoot; Grants = @($full + @("*${b}:RX", "*${a}:RX", "*${cp}:RX")) }
    [pscustomobject]@{ Path = $Layout.BrokerConfigDir; Grants = @($full + @("*${b}:(OI)(CI)RX")) }
    [pscustomobject]@{ Path = $Layout.BrokerDbDir; Grants = @($full + @("*${b}:(OI)(CI)M")) }
    [pscustomobject]@{ Path = $Layout.AuthorityDir; Grants = @($full + @("*${a}:(OI)(CI)M")) }
    [pscustomobject]@{ Path = $Layout.ControlPlaneDir; Grants = @($full + @("*${cp}:(OI)(CI)M")) }
  )
}
function Get-GrantedSids($Entry) { @($Entry.Grants | ForEach-Object { if ($_ -match '^\*(S-[0-9-]+):') { $Matches[1] } }) }
# $Summary = @{ Owner; Protected; AllowSids } read from a real folder; returns the differences from the plan (empty = as planned).
function Test-AclMatchesPlan($Entry, $Summary) {
  $diffs = New-Object System.Collections.Generic.List[string]
  if ($Summary.Owner -ne 'S-1-5-32-544' -and $Summary.Owner -ne 'S-1-5-18') { $diffs.Add('owner_untrusted') }
  if (-not $Summary.Protected) { $diffs.Add('inheritance_not_removed') }
  $want = @(Get-GrantedSids $Entry | Sort-Object -Unique)
  $have = @($Summary.AllowSids | Sort-Object -Unique)
  foreach ($s in $have) { if ($want -notcontains $s) { $diffs.Add("unexpected_principal:$s") } }
  foreach ($s in $want) { if ($have -notcontains $s) { $diffs.Add("missing_principal:$s") } }
  , @($diffs)
}

# ---------------------------------------------------------------------------------------------- services
function Get-ServiceCommandLine([string]$Exe, [string]$Config) { '"' + $Exe + '" service "' + $Config + '"' }
function Get-BrokerServiceSddl([string]$ControlPlaneSid) {
  # SYSTEM and Administrators everything; the Control Plane account ONLY LC (SERVICE_QUERY_STATUS) - exactly the lab's SDDL with the account's SID.
  "D:(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;LC;;;${ControlPlaneSid})"
}
function Quote-NativeArg([string]$Value) { '"' + ($Value -replace '"', '\"') + '"' }
# The argument string for `sc.exe create`: binPath= takes one argument that itself holds quotes (the path under Program Files has a space).
function Get-ScCreateArguments([string]$Name, [string]$Exe, [string]$Config) {
  $bin = (Get-ServiceCommandLine $Exe $Config) -replace '"', '\"'
  'create ' + $Name + ' binPath= "' + $bin + '" obj= "NT SERVICE\' + $Name + '" start= demand type= own'
}

# Facts read from the machine: @{ Exists; StartName; PathName; StartMode; ServiceType; SidTypeText (sc qsidtype); PrivilegesText (sc qprivs) }. Returns the differences from what install makes.
function Test-ServiceFacts($Facts, [string]$Name, [string]$ExpectedPathName) {
  $reasons = New-Object System.Collections.Generic.List[string]
  if (-not $Facts.Exists) { $reasons.Add('service_missing'); return , @($reasons) }
  if ($Facts.StartName -ne ('NT SERVICE\' + $Name)) { $reasons.Add('start_name_differs') }
  if ($Facts.PathName -cne $ExpectedPathName) { $reasons.Add('path_differs') }
  if ($Facts.StartMode -ne 'Manual') { $reasons.Add('start_mode_not_demand') }
  if ($Facts.ServiceType -ne 'Own Process') { $reasons.Add('not_own_process') }
  # RESTRICTED but not UNRESTRICTED, which contains the word
  if ($Facts.SidTypeText -cnotmatch '(?<![A-Za-z])RESTRICTED') { $reasons.Add('sid_type_not_restricted') }
  $privs = @([regex]::Matches([string]$Facts.PrivilegesText, 'Se[A-Za-z]+Privilege') | ForEach-Object { $_.Value })
  if ($privs.Count -ne 1 -or $privs[0] -ne 'SeChangeNotifyPrivilege') { $reasons.Add('privileges_not_minimal') }
  , @($reasons)
}
# The Broker service object: SYSTEM and Administrators, and the Control Plane account with exactly SERVICE_QUERY_STATUS (SDDL LC = 0x4). Nobody else.
function Test-ServiceSdMatches([string]$Sddl, [string]$ControlPlaneSid) {
  $reasons = New-Object System.Collections.Generic.List[string]
  try { $sd = New-Object System.Security.AccessControl.RawSecurityDescriptor($Sddl) } catch { $reasons.Add('sddl_unreadable'); return , @($reasons) }
  $seenCp = $false
  foreach ($ace in $sd.DiscretionaryAcl) {
    $sid = $ace.SecurityIdentifier.Value
    if ($ace.AceType -ne 'AccessAllowed') { continue }
    if ($sid -eq $ControlPlaneSid) { $seenCp = $true; if ($ace.AccessMask -ne 4) { $reasons.Add('control_plane_access_not_lc') } }
    elseif ($sid -ne 'S-1-5-18' -and $sid -ne 'S-1-5-32-544') { $reasons.Add('unexpected_principal:' + $sid) }
  }
  if (-not $seenCp) { $reasons.Add('control_plane_ace_missing') }
  , @($reasons)
}

# ---------------------------------------------------------------------------------------------- the signing key
# What the Authority's SigningKeyGuard requires of the stored key: export policy none; owner and every allow ACE limited to the service SID, SYSTEM and Administrators.
function New-KeySddl([string]$ServiceSid) { "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;$ServiceSid)" }
function Test-KeyReadBack($Report, [string]$ServiceSid) {
  $reasons = New-Object System.Collections.Generic.List[string]
  if ($Report.exportPolicy -ne 0) { $reasons.Add('key_exportable') }
  if ($Report.algorithm -ne 'ECDSA_P256' -and $Report.algorithm -ne 'ECDSA') { $reasons.Add('key_algorithm') }
  if ($Report.keySize -ne 256) { $reasons.Add('key_size') }
  $trusted = @('S-1-5-18', 'S-1-5-32-544', $ServiceSid)
  if ($trusted -notcontains $Report.owner) { $reasons.Add('owner_untrusted') }
  foreach ($sid in @($Report.allowSids)) { if ($trusted -notcontains $sid) { $reasons.Add('ace_untrusted') } }
  foreach ($sid in $trusted) { if (@($Report.allowSids) -notcontains $sid) { $reasons.Add('ace_missing') } }
  , @($reasons | Select-Object -Unique)
}

# What is stored (read from an open key handle): export policy, algorithm, owner and the SIDs of every allow ACE.
function Get-SigningKeyReport($Key, [string]$KeyName, [string]$Scope) {
  $descr = [byte[]]$Key.GetProperty('Security Descr', [System.Security.Cryptography.CngPropertyOptions]5).GetValue()
  $readBack = [System.Security.AccessControl.RawSecurityDescriptor]::new($descr, 0)
  [pscustomobject]@{
    keyName = $KeyName; scope = $Scope; exportPolicy = [int]$Key.ExportPolicy; algorithm = $Key.Algorithm.Algorithm; keySize = $Key.KeySize
    owner = $readBack.Owner.Value
    allowSids = @($readBack.DiscretionaryAcl | Where-Object { $_.AceType -eq 'AccessAllowed' } | ForEach-Object { $_.SecurityIdentifier.Value })
  }
}
# Read-only: open the key and report it. Returns $null when there is no such key.
function Read-AuthoritySigningKey([string]$KeyName, [string]$Scope = 'machine') {
  $provider = [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
  $open = if ($Scope -eq 'machine') { [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey } else { [System.Security.Cryptography.CngKeyOpenOptions]::None }
  if (-not [System.Security.Cryptography.CngKey]::Exists($KeyName, $provider, $open)) { return $null }
  $key = [System.Security.Cryptography.CngKey]::Open($KeyName, $provider, $open)
  try {
    [pscustomobject]@{ report = (Get-SigningKeyReport $key $KeyName $Scope); spki = (ConvertTo-P256Spki ([byte[]]$key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob))) }
  }
  finally { $key.Dispose() }
}

# Create the Authority's signing key (ECDSA P-256, Microsoft Software KSP, Export Policy none, DACL SY + BA + the service SID), read it back from a FRESH open, check it like the Authority's
# guard will, and return the PUBLIC key as SPKI base64. The key is deleted again if anything fails. Same parameters as test/windows-service-lab/new-authority-key.ps1 ('good').
# -Scope user exists for the host tests only (a per-user key with a random name); albera-host.ps1 always uses machine scope.
function New-AuthoritySigningKey([string]$KeyName, [string]$ServiceSid, [ValidateSet('machine', 'user')][string]$Scope = 'machine') {
  if (-not (Test-KeyName $KeyName)) { throw 'key_name_invalid' }
  $provider = [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
  $open = if ($Scope -eq 'machine') { [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey } else { [System.Security.Cryptography.CngKeyOpenOptions]::None }
  if ([System.Security.Cryptography.CngKey]::Exists($KeyName, $provider, $open)) { throw 'key_already_exists' }
  if ($Scope -eq 'machine' -and -not (Test-ServiceSidShape $ServiceSid)) { throw 'service_sid_invalid' }
  $parameters = New-Object System.Security.Cryptography.CngKeyCreationParameters
  $parameters.Provider = $provider
  $parameters.KeyUsage = [System.Security.Cryptography.CngKeyUsages]::Signing
  $parameters.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::None
  if ($Scope -eq 'machine') { $parameters.KeyCreationOptions = [System.Security.Cryptography.CngKeyCreationOptions]::MachineKey }
  $sddl = New-KeySddl $ServiceSid
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($Scope -eq 'user' -and $me -ne $ServiceSid) { $sddl += "(A;;GA;;;$me)" }   # host tests only: the signed-in user must be able to open and delete its own test key
  $descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)
  $bytes = New-Object byte[] $descriptor.BinaryLength
  $descriptor.GetBinaryForm($bytes, 0)
  $key = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256, $KeyName, $parameters)
  $done = $false
  try {
    try { $key.SetProperty((New-Object System.Security.Cryptography.CngProperty('Security Descr', $bytes, [System.Security.Cryptography.CngPropertyOptions]4))) }
    finally { $key.Dispose() }
    $stored = [System.Security.Cryptography.CngKey]::Open($KeyName, $provider, $open)
    try {
      $report = Get-SigningKeyReport $stored $KeyName $Scope
      $problems = Test-KeyReadBack $report $ServiceSid
      if ($Scope -eq 'user') { $problems = @($problems | Where-Object { $_ -ne 'ace_untrusted' -and $_ -ne 'owner_untrusted' }) }   # the extra ACE for the test user
      if ($problems.Count -gt 0) { throw ('key_read_back_failed:' + ($problems -join ',')) }
      $spki = ConvertTo-P256Spki ([byte[]]$stored.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob))
      # Round trip: sign once with the stored key, verify with a key rebuilt from the SPKI alone. Proves the SPKI is THIS key's public half.
      $message = New-Object byte[] 32
      $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($message); $rng.Dispose()
      $signer = New-Object System.Security.Cryptography.ECDsaCng($stored)
      $signature = $signer.SignData($message)
      $publicKey = [System.Security.Cryptography.CngKey]::Import((ConvertFrom-P256Spki $spki), [System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
      $verifier = New-Object System.Security.Cryptography.ECDsaCng($publicKey)
      if (-not $verifier.VerifyData($message, $signature)) { throw 'key_round_trip_failed' }
      $publicKey.Dispose()
      $done = $true
      return [pscustomobject]@{ spki = $spki; report = $report }
    }
    finally { $stored.Dispose() }
  }
  finally {
    if (-not $done) { Remove-AuthoritySigningKey $KeyName $Scope | Out-Null }   # never leave a key whose protection was not confirmed
  }
}
function Remove-AuthoritySigningKey([string]$KeyName, [string]$Scope = 'machine') {
  if (-not (Test-KeyName $KeyName)) { throw 'key_name_invalid' }
  $provider = [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
  $open = if ($Scope -eq 'machine') { [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey } else { [System.Security.Cryptography.CngKeyOpenOptions]::None }
  if (-not [System.Security.Cryptography.CngKey]::Exists($KeyName, $provider, $open)) { return $false }
  $old = [System.Security.Cryptography.CngKey]::Open($KeyName, $provider, $open)
  $old.Delete()   # Delete disposes the handle
  $true
}
function Test-AuthoritySigningKeyExists([string]$KeyName, [string]$Scope = 'machine') {
  $provider = [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
  $open = if ($Scope -eq 'machine') { [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey } else { [System.Security.Cryptography.CngKeyOpenOptions]::None }
  [System.Security.Cryptography.CngKey]::Exists($KeyName, $provider, $open)
}

# ---------------------------------------------------------------------------------------------- removal safety
# Relative paths (under the data root) that are not on the known list. Uninstall refuses to delete a folder that holds any.
function Get-UnknownEntries([string[]]$RelativePaths, [string[]]$KnownFiles, [string[]]$KnownFolders) {
  $known = @($KnownFiles | ForEach-Object { $_.ToLowerInvariant() }) + @($KnownFolders | ForEach-Object { $_.ToLowerInvariant() })
  , @($RelativePaths | Where-Object { $known -notcontains $_.ToLowerInvariant() })
}

# ---------------------------------------------------------------------------------------------- trust: who may have written what the installer is about to rely on
# An attacker model for this section: an AI agent running as the owner's NON-admin session. It can create C:\ProgramData\Albera (Users may create folders there), make it or a
# child a junction, plant files in it, and rewrite files in the repository working tree. So nothing that already exists is trusted until it passes these checks.
$script:WriteRightsMask = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000   # WriteData AppendData DeleteChild Delete WriteDac WriteOwner GenericAll GenericWrite (as ServicePathGuard.cs)
$script:AdminSids = @('S-1-5-18', 'S-1-5-32-544')
function Get-AdminSids { , $script:AdminSids }

# $Summary = @{ Owner; Protected; WriteSids } (Get-AclSummary). Returns the reasons it is not trustworthy (empty = trusted).
function Test-TrustSummary($Summary, [string[]]$AllowedWriters, [bool]$RequireProtected) {
  $reasons = New-Object System.Collections.Generic.List[string]
  if ($script:AdminSids -notcontains $Summary.Owner) { $reasons.Add('owner_untrusted') }
  if ($RequireProtected -and -not $Summary.Protected) { $reasons.Add('inheritance_not_removed') }
  $writers = @($script:AdminSids) + @($AllowedWriters)
  foreach ($sid in @($Summary.WriteSids)) { if ($writers -notcontains $sid) { $reasons.Add('writer_untrusted:' + $sid) } }
  , @($reasons)
}
# Who may hold write rights on a planned folder: SYSTEM, Administrators and the plan's own Modify / Full-control accounts.
function Get-PlannedWriters($Entry) {
  $own = @($Entry.Grants | ForEach-Object { if ($_ -match '^\*(S-[0-9-]+):(?:\(OI\)\(CI\))?(?:M|F)$') { $Matches[1] } })
  , @($script:AdminSids + $own | Sort-Object -Unique)
}
function Get-AclSummary([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' })
  [pscustomobject]@{
    Owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    Protected = $acl.AreAccessRulesProtected
    AllowSids = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
    WriteSids = @($rules | Where-Object { ([int]$_.FileSystemRights -band $script:WriteRightsMask) -ne 0 } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
  }
}
# The path itself and every parent up to the volume root that is a reparse point (junction, symlink, mount point). Attributes only; nothing is followed.
function Get-ReparseChain([string]$Path) {
  $found = New-Object System.Collections.Generic.List[string]
  $p = $Path
  while ($p) {
    if ([System.IO.File]::Exists($p) -or [System.IO.Directory]::Exists($p)) {
      if (([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { $found.Add($p) }
    }
    $parent = [System.IO.Path]::GetDirectoryName($p)
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $p) { break }
    $p = $parent
  }
  , @($found)
}
# Existing path -> reasons it cannot be trusted (empty list = it can). A link anywhere on the way stops the check before any ACL is read (reading it would follow the link).
function Get-PathTrustReasons([string]$Path, [string[]]$AllowedWriters, [bool]$RequireProtected) {
  $chain = Get-ReparseChain $Path
  if ($chain.Count -gt 0) { return , @($chain | ForEach-Object { 'reparse_point:' + $_ }) }
  try { $summary = Get-AclSummary $Path } catch { return , @('acl_unreadable') }
  Test-TrustSummary $summary $AllowedWriters $RequireProtected
}
function Format-TrustRefusal([string]$Path, [string[]]$Reasons) {
  "$Path cannot be trusted ($($Reasons -join ', ')). Something other than this script made or changed it. Inspect it, then delete it yourself as an administrator and run this script again."
}

# File system rules for a planned folder: the icacls-style grants of Get-AclPlan, as .NET rules (so the folder can be CREATED with its final ACL, with no window in between).
function ConvertTo-FileSystemRules([string[]]$Grants) {
  $rules = foreach ($g in $Grants) {
    if ($g -cnotmatch '^\*(S-[0-9-]+):(\(OI\)\(CI\))?(F|RX|M)$') { throw 'grant_not_understood' }
    $rights = switch ($Matches[3]) { 'F' { [System.Security.AccessControl.FileSystemRights]::FullControl } 'RX' { [System.Security.AccessControl.FileSystemRights]::ReadAndExecute } 'M' { [System.Security.AccessControl.FileSystemRights]::Modify } }
    $inherit = if ($Matches[2]) { [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [System.Security.AccessControl.InheritanceFlags]::None }
    New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($Matches[1])), $rights, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  }
  , @($rules)
}
# Create a folder that is born with its final security descriptor (owner, protected DACL): there is no moment at which it carries an inherited ACL. Refuses an existing path.
function New-SecuredDirectory([string]$Path, [string[]]$Grants, [string]$OwnerSid = 'S-1-5-32-544') {
  if ([System.IO.File]::Exists($Path) -or [System.IO.Directory]::Exists($Path)) { throw 'directory_already_exists' }
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner((New-Object System.Security.Principal.SecurityIdentifier($OwnerSid)))
  foreach ($rule in (ConvertTo-FileSystemRules $Grants)) { $security.AddAccessRule($rule) }
  (New-Object System.IO.DirectoryInfo($Path)).Create($security)
}

# ---------------------------------------------------------------------------------------------- what the owner recorded as expected: SHA-256 of every published file
# JSON: { "version": 1, "components": { "broker": { "files": { "<relative/path>": "<64 lowercase hex>" } }, "authority": {...}, "pipe-client": {...} } }. It comes from OUTSIDE the repository tree
# (the CI run's printed hashes / a reviewed build): the tree can be rewritten by a non-admin, so a hash taken from it proves nothing. Returns @{ Ok; Reason; Map } (Map: component -> relative path -> sha).
$script:HashComponents = @('broker', 'authority', 'pipe-client')
function Read-ExpectedHashes([string]$Json) {
  $fail = { param($why) [pscustomobject]@{ Ok = $false; Reason = $why; Map = $null } }
  if ($null -eq $Json -or $Json.Length -eq 0 -or $Json.Length -gt 4MB) { return (& $fail 'hashes_file_size') }
  try { $o = $Json | ConvertFrom-Json } catch { return (& $fail 'hashes_not_json') }
  if (-not (Test-SameKeySet $o @('version', 'components')) -or $o.version -ne 1) { return (& $fail 'hashes_shape') }
  if (-not (Test-SameKeySet $o.components $script:HashComponents)) { return (& $fail 'hashes_components') }
  $map = @{}
  foreach ($name in $script:HashComponents) {
    $c = $o.components.$name
    if (-not (Test-SameKeySet $c @('files'))) { return (& $fail "hashes_shape:$name") }
    $files = @{}
    foreach ($prop in $c.files.PSObject.Properties) {
      $rel = $prop.Name
      if ($rel -cnotmatch '^[A-Za-z0-9._+@ -]+(/[A-Za-z0-9._+@ -]+)*$' -or $rel.Contains('..') -or ($prop.Value -isnot [string]) -or ($prop.Value -cnotmatch '^[0-9a-f]{64}$')) { return (& $fail "hashes_entry:$name") }
      $files[$rel] = $prop.Value
    }
    if ($files.Count -eq 0) { return (& $fail "hashes_empty:$name") }
    $map[$name] = $files
  }
  [pscustomobject]@{ Ok = $true; Reason = ''; Map = $map }
}
# $Actual: relative path (either slash) -> sha of the files that were COPIED. Differences, by name only (never contents); empty = identical.
function Compare-FileHashSets($Expected, $Actual) {
  $diffs = New-Object System.Collections.Generic.List[string]
  $have = @{}
  foreach ($k in $Actual.Keys) { $have[([string]$k).Replace('\', '/')] = $Actual[$k] }
  foreach ($k in $Expected.Keys) {
    if (-not $have.ContainsKey($k)) { $diffs.Add('missing:' + $k) } elseif ($have[$k] -cne $Expected[$k]) { $diffs.Add('mismatch:' + $k) }
  }
  foreach ($k in $have.Keys) { if (-not $Expected.ContainsKey($k)) { $diffs.Add('unexpected:' + $k) } }
  , @($diffs | Sort-Object)
}
# The hashes file must not sit in the repository tree (a non-admin can rewrite it there).
function Test-PathInside([string]$Path, [string]$Root) {
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\') + '\'
  $base = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $full.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)
}

# ---------------------------------------------------------------------------------------------- the manifest and the account: what uninstall may touch
# The manifest is only read after its folder and file passed the trust checks above; even then, uninstall acts on FIXED names only, so a forged entry can name nothing else.
function Test-HasKey($Dict, [string]$Key) { @($Dict.Keys) -ccontains $Key }
function Test-ManifestShape($M) {
  $c = Get-HostConstants
  $reasons = New-Object System.Collections.Generic.List[string]
  if ($M -isnot [System.Collections.IDictionary] -or $M['schema'] -ne 1 -or $M['tool'] -cne 'albera-host.ps1' -or @('partial', 'complete') -cnotcontains $M['state']) { $reasons.Add('manifest_header'); return , @($reasons) }
  $created = $M['created']; $values = $M['values']
  if ($created -isnot [System.Collections.IDictionary] -or $values -isnot [System.Collections.IDictionary]) { $reasons.Add('manifest_sections'); return , @($reasons) }
  foreach ($k in $created.Keys) { if (@('dataRoot', 'installRoot', 'services', 'binaries', 'user', 'key') -cnotcontains $k) { $reasons.Add('created_key:' + $k) } }
  foreach ($k in $values.Keys) { if (@('authoritySpki', 'controlPlaneSid', 'approverSid', 'approverKeyId', 'brokerServiceSid', 'authorityServiceSid') -cnotcontains $k) { $reasons.Add('values_key:' + $k) } }
  if ((Test-HasKey $created 'services')) { foreach ($n in @($created['services'])) { if (@($c.BrokerService, $c.AuthorityService) -cnotcontains $n) { $reasons.Add('service_name_not_fixed') } } }
  if ((Test-HasKey $created 'user') -and $null -ne $created['user']) {
    $u = $created['user']
    if ($u -isnot [System.Collections.IDictionary] -or $u['name'] -cne $c.ControlPlaneUser -or -not (Test-AccountSidShape $u['sid'])) { $reasons.Add('user_record') }
  }
  if ((Test-HasKey $created 'key') -and $null -ne $created['key']) {
    if ($created['key'] -isnot [System.Collections.IDictionary] -or $created['key']['name'] -cne $c.SigningKeyName) { $reasons.Add('key_record') }
  }
  if ((Test-HasKey $created 'binaries') -and $created['binaries'] -is [System.Collections.IDictionary]) {
    foreach ($k in $created['binaries'].Keys) { if ($script:HashComponents -cnotcontains $k) { $reasons.Add('binary_name:' + $k) } }
  }
  if ((Test-HasKey $values 'authoritySpki') -and -not (Test-P256Spki $values['authoritySpki'])) { $reasons.Add('authority_spki') }
  , @($reasons | Select-Object -Unique)
}
# $Recorded: the manifest's created.user (name, sid) or $null. $Live: @{ Name; Sid; Description } read from the machine or $null. Returns why this account must NOT be removed.
function Test-OwnedUser($Recorded, $Live) {
  $c = Get-HostConstants
  $reasons = New-Object System.Collections.Generic.List[string]
  if ($null -eq $Recorded) { $reasons.Add('not_recorded'); return , @($reasons) }
  if ($Recorded['name'] -cne $c.ControlPlaneUser) { $reasons.Add('recorded_name_not_fixed') }
  if ($null -eq $Live) { $reasons.Add('account_missing'); return , @($reasons) }
  if ($Live.Name -cne $c.ControlPlaneUser) { $reasons.Add('live_name_not_fixed') }
  if ($Live.Sid -cne $Recorded['sid']) { $reasons.Add('sid_differs') }
  if ($Live.Description -cne $c.ControlPlaneUserDescription) { $reasons.Add('description_differs') }
  , @($reasons)
}

# ---------------------------------------------------------------------------------------------- the lab-only password gate
# -ControlPlanePassword (non-interactive) is accepted ONLY in the disposable lab VM, which announces itself with ALBERA_LAB_VM=1. Returns the refusal word, or $null when allowed.
function Test-LabPasswordGate([bool]$PasswordSupplied, [string]$LabEnvironment) {
  if ($PasswordSupplied -and $LabEnvironment -ne '1') { return 'control_plane_password_parameter_is_lab_only' }
  $null
}
