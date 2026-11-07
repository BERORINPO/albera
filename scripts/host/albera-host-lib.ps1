# Helpers for scripts/host/albera-host.ps1 (dot-sourced). Windows PowerShell 5.1, ASCII only.
# Everything in the first half is PURE: it takes values and returns values (no file, no registry, no service, no account is touched), so the tests call it directly.
# The second half (key and process helpers) touches the system; only albera-host.ps1 install / uninstall calls those with machine scope.

# ---------------------------------------------------------------------------------------------- fixed names and values
function Get-HostConstants {
  [ordered]@{
    BrokerService = 'AlberaHostBroker'
    AuthorityService = 'AlberaApprovalAuthority'
    ControlPlaneService = 'AlberaControlPlane'   # the Control Plane is NT SERVICE\AlberaControlPlane (control-plane-service.md section 1); there is no ordinary account any more
    ControlPlaneUser = 'albera-cp'   # LEGACY: the local account of the first install layout. Nothing creates it now; -Mode migrate and uninstall remove it
    ControlPlaneUserDescription = 'ALBERA Control Plane (made by albera-host.ps1)'   # the description the legacy install set (Remove-LocalUser checks it); at most 48 characters (a test pins it)
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
    HyperVAdminsSid = 'S-1-5-32-578'   # BUILTIN\Hyper-V Administrators: only -GrantHyperVToBroker puts anything in it, and only the Broker's service SID (ADR-002 Amendment 2026-11-03)
    StartMenuFolder = 'ALBERA'   # under the All Users Start Menu\Programs (administrator-writable)
    OpenShortcut = 'Open ALBERA.lnk'
    UpdateShortcut = 'ALBERA update.lnk'
    RunKeyPath = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Run'   # HKLM: the tray of the approver starts in the owner's session (control-plane-service.md section 7)
    RunValueName = 'AlberaApprover'
    FailureResetSeconds = 86400
    FailureRestartMilliseconds = 5000   # sc failure: restart after 5 s, twice, then leave stopped (control-plane-service.md section 2)
    MaxApproverKeys = 16   # approver-webauthn.md, "Wire contract": approverKeys holds 1 to 16 key records
    MaxApproverKeyFileBytes = 4096   # one canonical record is at most about 2.4 KB (RSA-4096 and a 1023-byte credential id); anything bigger is not one
    AuthorityKeyStoreMaxBytes = 32768   # ApproverKeyStore.MaxFileBytes: the Authority writes no bigger file and refuses one on start, so set-approver reads no bigger one (compared with the C# source by a test)
    AuthorityConfigMaxBytes = 32768   # AuthorityConfig.MaxFileBytes: the Authority reads no bigger config (16 key records with long credential ids do not fit 4 KiB); compared with the C# source by a test
    MaxApproverKeyMetadataBytes = 1900   # ApproverKeyRules.MaxMetadataBytes: the `keys` reply (ids, kinds, credential ids of all keys) must fit one frame, so a list whose metadata is bigger is refused by the Authority
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
    # the Control Plane service host and its app tree (one published component; the pinned node sits in node\ beside them and is NOT part of the component's hash)
    ControlPlaneBinDir = Join-Path $install 'bin\control-plane'
    ControlPlaneExe = Join-Path $install 'bin\control-plane\albera-control-plane-host.exe'
    ControlPlaneAppDir = Join-Path $install 'bin\control-plane\app'
    ControlPlaneNodeDir = Join-Path $install 'bin\control-plane\node'
    ControlPlaneNodeExe = Join-Path $install 'bin\control-plane\node\node.exe'
    ApproverBinDir = Join-Path $install 'bin\approver'
    ApproverExe = Join-Path $install 'bin\approver\AlberaApprover.exe'
    ClaudeBinDir = Join-Path $install 'bin\claude'   # the pinned copy of the owner's Claude Code (administrator-only; ALBERA never downloads or ships it)
    ClaudeExe = Join-Path $install 'bin\claude\claude.exe'
    LauncherDir = Join-Path $install 'bin\launcher'
    OpenScript = Join-Path $install 'bin\launcher\open-albera.ps1'   # what the Start menu "Open ALBERA" shortcut runs (text: Get-OpenAlberaScriptText)
    SetupBinDir = Join-Path $install 'bin\setup'
    SetupExe = Join-Path $install 'bin\setup\albera-setup.exe'   # put there by the owner (setup refuses to install from anywhere else); only the "ALBERA update" shortcut points at it
    DataRoot = $data
    ManifestPath = Join-Path $data 'install-manifest.json'
    BrokerConfigDir = Join-Path $data 'broker-config'
    BrokerConfig = Join-Path $data ('broker-config\' + $c.BrokerService + '.service.json')
    BrokerDbDir = Join-Path $data 'broker'
    BrokerDb = Join-Path $data 'broker\journal.sqlite'
    AuthorityDir = Join-Path $data 'authority'
    AuthorityConfig = Join-Path $data ('authority\' + $c.AuthorityService + '.service.json')
    AuthorityKeyStore = Join-Path $data 'authority\approver-keys.json'   # written by the Authority only (approver-webauthn.md, "Key store"); set-approver deletes it, uninstall knows it
    ControlPlaneDir = Join-Path $data 'control-plane'   # the Control Plane's own working data: full control for its service SID
    ControlPlaneLogDir = Join-Path $data 'control-plane\logs'
    ControlPlaneJournal = Join-Path $data 'control-plane\operations.sqlite'
    # the Control Plane's settings, moved out of control-plane\ so that the service can only READ them (closes the known limit 2026-11-03+cp-settings-pin-scope)
    ControlPlaneConfigDir = Join-Path $data 'control-plane-config'
    ControlPlaneConfig = Join-Path $data ('control-plane-config\' + $c.ControlPlaneService + '.service.json')
    ApprovalSettings = Join-Path $data 'control-plane-config\albera.approval.json'
    LegacyApprovalSettings = Join-Path $data 'control-plane\albera.approval.json'   # where the first install layout put it (migration reads it, uninstall removes it)
    SecretsDir = Join-Path $data 'secrets'   # DPAPI blobs of the credential the owner types into the room
    UiDir = Join-Path $data 'ui'   # ui\room.json: the one-time code the "Open ALBERA" shortcut reads
    StartMenuDir = Join-Path $ProgramData ('Microsoft\Windows\Start Menu\Programs\' + $c.StartMenuFolder)
    OpenShortcut = Join-Path $ProgramData ('Microsoft\Windows\Start Menu\Programs\' + $c.StartMenuFolder + '\' + $c.OpenShortcut)
    UpdateShortcut = Join-Path $ProgramData ('Microsoft\Windows\Start Menu\Programs\' + $c.StartMenuFolder + '\' + $c.UpdateShortcut)
  }
}

# The files a normal run of the installed services and the control plane leave inside the data root. Uninstall removes the root only when it holds nothing else.
function Get-KnownDataFiles {
  @(
    'install-manifest.json',
    'broker-config\AlberaHostBroker.service.json',
    'broker\journal.sqlite', 'broker\journal.sqlite-wal', 'broker\journal.sqlite-shm', 'broker\journal.sqlite-journal',
    'authority\AlberaApprovalAuthority.service.json', 'authority\policy.json', 'authority\approver-keys.json',
    'control-plane\albera.approval.json', 'control-plane\operations.sqlite', 'control-plane\operations.sqlite-wal', 'control-plane\operations.sqlite-shm',
    'control-plane-config\AlberaControlPlane.service.json', 'control-plane-config\albera.approval.json',
    'wsl-bridge\bridge.json', 'wsl-bridge\first-check.json', 'wsl-bridge\lease-floor', 'wsl-bridge\albera-wsl2.tar'
  )
}
function Get-KnownDataFolders { @('broker-config', 'broker', 'authority', 'control-plane', 'control-plane-config', 'secrets', 'ui', 'wsl-bridge') }
# Folders the Control Plane SERVICE itself fills while it runs (host logs, one folder per Claude Code run, DPAPI blobs and their .meta files, ui\room.json). What is in them is not listed by name:
# uninstall removes them as a whole after the link check, and they are the only places where an unlisted file is allowed.
function Get-KnownDataWorkFolders { @('control-plane\logs', 'control-plane\claude-run', 'secrets', 'ui', 'wsl-bridge\state', 'wsl-bridge\distributions') }

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
# Lowercase 8-4-4-4-12 hex (ComputerBinding.IsVmId). \z, not $: a trailing newline must not pass (this text goes into a config the Broker puts in a WQL query).
function Test-VmGuid([string]$Value) { ($null -ne $Value) -and ($Value -cmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z') -and ($Value -cne '00000000-0000-0000-0000-000000000000') }

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
# The SID half of the above, for an install whose keys come from key record files (-ApproverKeyFile): the keys have their own checks (Test-ApproverKeyRecord), the SID is still typed.
function Test-ApproverSidValue([string]$ApproverSid, [string]$ControlPlaneSid) {
  $reasons = New-Object System.Collections.Generic.List[string]
  if (-not (Test-AccountSidShape $ApproverSid)) { $reasons.Add('approver_sid_not_a_user_sid') }
  if ($ControlPlaneSid -and ($ApproverSid -ceq $ControlPlaneSid)) { $reasons.Add('approver_sid_equals_control_plane_sid') }
  , @($reasons)
}

# ---------------------------------------------------------------------------------------------- approver key records (approver-webauthn.md, "Wire contract (fixed for phases 2 to 4)")
# A key record is public data only: { keyId, kind, alg, publicKey [, credentialId] }. The owner's session writes the record file (`AlberaApprover.exe enroll --webauthn` puts it in
# %LOCALAPPDATA%\Albera\approver-keys\<keyId>.json) and the ELEVATED installer reads it, so every rule of the contract is checked here and the canonical bytes are required (one text per record, no room for
# an ambiguity between what was checked and what is written). Reasons are fixed words; nothing the file said is ever echoed. Everything in this section is pure: values in, values out.
function ConvertTo-Base64UrlNoPad([byte[]]$Bytes) { [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
# base64url WITHOUT padding -> bytes, or $null. One text per value: the bytes must encode back to exactly this text (no stray trailing bits, no padding, no other alphabet). \z, not $: a trailing newline must not pass.
function ConvertFrom-Base64UrlNoPad([string]$Text) {
  if ([string]::IsNullOrEmpty($Text) -or $Text.Length -gt 1400 -or $Text -cnotmatch '^[A-Za-z0-9_-]+\z' -or ($Text.Length % 4) -eq 1) { return $null }
  $standard = $Text.Replace('-', '+').Replace('_', '/')
  while (($standard.Length % 4) -ne 0) { $standard += '=' }
  try { $bytes = [Convert]::FromBase64String($standard) } catch { return $null }
  if ((ConvertTo-Base64UrlNoPad $bytes) -cne $Text) { return $null }
  , $bytes
}
# Ordinary base64 WITH padding, one text per value (the same round-trip rule). The SPKI of a key is at most about 1 KB, so the text is bounded.
function ConvertFrom-Base64Strict([string]$Text) {
  if ([string]::IsNullOrEmpty($Text) -or $Text.Length -gt 1400 -or $Text -cnotmatch '^[A-Za-z0-9+/]+={0,2}\z' -or ($Text.Length % 4) -ne 0) { return $null }
  try { $bytes = [Convert]::FromBase64String($Text) } catch { return $null }
  if ([Convert]::ToBase64String($bytes) -cne $Text) { return $null }
  , $bytes
}
# webauthn- or hello- plus the first 8 bytes of SHA-256 over the SPKI DER, lower-case hex ("Keys" in the design).
function Get-ApproverKeyIdFor([string]$Kind, [byte[]]$Spki) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = $sha.ComputeHash($Spki) } finally { $sha.Dispose() }
  $prefix = if ($Kind -ceq 'webauthn') { 'webauthn-' } else { 'hello-' }
  $prefix + (([BitConverter]::ToString($hash, 0, 8) -replace '-', '').ToLowerInvariant())
}

# One DER element at $Offset: @{ Tag; Start; Length; End }, or $null. Strict: single-byte tags, definite and minimal lengths, and the element stays inside $Bytes.
function Read-DerElement([byte[]]$Bytes, [int]$Offset) {
  if ($Offset -lt 0 -or ($Offset + 2) -gt $Bytes.Length) { return $null }
  $tag = [int]$Bytes[$Offset]
  if (($tag -band 0x1F) -eq 0x1F) { return $null }
  $first = [int]$Bytes[$Offset + 1]
  $position = $Offset + 2
  if ($first -lt 0x80) { $length = $first }
  else {
    $count = $first -band 0x7F
    if ($count -lt 1 -or $count -gt 3 -or ($position + $count) -gt $Bytes.Length) { return $null }
    if ($Bytes[$position] -eq 0) { return $null }   # not minimal
    $length = 0
    for ($i = 0; $i -lt $count; $i++) { $length = ($length -shl 8) -bor [int]$Bytes[$position + $i] }
    $position += $count
    if ($length -lt 0x80) { return $null }   # the long form is for 128 and up
  }
  if (($position + $length) -gt $Bytes.Length) { return $null }
  [pscustomobject]@{ Tag = $tag; Start = $position; Length = $length; End = ($position + $length) }
}
function Test-BytesEqualAt([byte[]]$Bytes, [int]$Offset, [byte[]]$Expected) {
  if ($Offset -lt 0 -or ($Offset + $Expected.Length) -gt $Bytes.Length) { return $false }
  for ($i = 0; $i -lt $Expected.Length; $i++) { if ($Bytes[$Offset + $i] -ne $Expected[$i]) { return $false } }
  $true
}
$script:RsaEncryptionOid = [byte[]](0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01)   # 1.2.840.113549.1.1.1
# An RSA SubjectPublicKeyInfo: SEQUENCE { SEQUENCE { OID rsaEncryption, NULL }, BIT STRING { 0, SEQUENCE { INTEGER n, INTEGER e } } }, every length exact. -> @{ Bits; Exponent } or $null.
function Get-RsaSpkiInfo([byte[]]$Spki) {
  $outer = Read-DerElement $Spki 0
  if ($null -eq $outer -or $outer.Tag -ne 0x30 -or $outer.End -ne $Spki.Length) { return $null }
  $algorithm = Read-DerElement $Spki $outer.Start
  if ($null -eq $algorithm -or $algorithm.Tag -ne 0x30) { return $null }
  $oid = Read-DerElement $Spki $algorithm.Start
  if ($null -eq $oid -or $oid.Tag -ne 0x06 -or $oid.Length -ne $script:RsaEncryptionOid.Length -or -not (Test-BytesEqualAt $Spki $oid.Start $script:RsaEncryptionOid)) { return $null }
  $nul = Read-DerElement $Spki $oid.End
  if ($null -eq $nul -or $nul.Tag -ne 0x05 -or $nul.Length -ne 0 -or $nul.End -ne $algorithm.End) { return $null }
  $bits = Read-DerElement $Spki $algorithm.End
  if ($null -eq $bits -or $bits.Tag -ne 0x03 -or $bits.End -ne $outer.End -or $bits.Length -lt 2 -or $Spki[$bits.Start] -ne 0) { return $null }
  $pair = Read-DerElement $Spki ($bits.Start + 1)
  if ($null -eq $pair -or $pair.Tag -ne 0x30 -or $pair.End -ne $bits.End) { return $null }
  $modulus = Read-DerElement $Spki $pair.Start
  if ($null -eq $modulus -or $modulus.Tag -ne 0x02 -or $modulus.Length -lt 2) { return $null }
  $exponent = Read-DerElement $Spki $modulus.End
  if ($null -eq $exponent -or $exponent.Tag -ne 0x02 -or $exponent.End -ne $pair.End -or $exponent.Length -lt 1 -or $exponent.Length -gt 4) { return $null }
  # n: a positive, minimal INTEGER (a leading 0x00 only when the next byte has its top bit set) and odd. e: positive, at most 4 bytes.
  $lead = [int]$Spki[$modulus.Start]
  if (($lead -band 0x80) -ne 0) { return $null }
  $skip = 0
  if ($lead -eq 0) { if (([int]$Spki[$modulus.Start + 1] -band 0x80) -eq 0) { return $null }; $skip = 1 }
  if (([int]$Spki[$modulus.End - 1] -band 1) -eq 0) { return $null }
  if (([int]$Spki[$exponent.Start] -band 0x80) -ne 0) { return $null }
  $top = [int]$Spki[$modulus.Start + $skip]
  $topBits = 0
  while ($top -gt 0) { $topBits++; $top = $top -shr 1 }
  $value = [long]0
  for ($i = $exponent.Start; $i -lt $exponent.End; $i++) { $value = ($value -shl 8) -bor [long]$Spki[$i] }
  [pscustomobject]@{ Bits = (8 * ($modulus.Length - $skip - 1)) + $topBits; Exponent = $value }
}
# True when the 91-byte P-256 SPKI holds a point that is ON the curve: Windows' own CNG refuses to import one that is not (probed in Windows PowerShell 5.1), and the Authority imports it the same way.
function Test-P256PointOnCurve([byte[]]$Spki) {
  try {
    $blob = ConvertFrom-P256Spki ([Convert]::ToBase64String($Spki))
    $key = [System.Security.Cryptography.CngKey]::Import($blob, [System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
    $key.Dispose()
    $true
  }
  catch { $false }
}

# The contract's rules on the key material itself. $Record has passed the field checks (right fields, right types). Reasons are fixed words.
function Test-ApproverKeyMaterial($Record) {
  $reasons = New-Object System.Collections.Generic.List[string]
  $kind = [string]$Record.kind
  $alg = [long]$Record.alg
  if ($Record.keyId -cnotmatch '^(webauthn|hello)-[0-9a-f]{16}\z') { $reasons.Add('record_key_id_form') }
  elseif (-not $Record.keyId.StartsWith($(if ($kind -ceq 'webauthn') { 'webauthn-' } else { 'hello-' }), [System.StringComparison]::Ordinal)) { $reasons.Add('record_key_id_form') }
  if ($kind -ceq 'hello-rsa') { if ($alg -ne -257) { $reasons.Add('record_alg') } }
  elseif ($alg -ne -7 -and $alg -ne -257) { $reasons.Add('record_alg') }
  $spki = ConvertFrom-Base64Strict $Record.publicKey
  if ($null -eq $spki) { $reasons.Add('record_public_key_encoding') }
  else {
    if ($alg -eq -7) {
      if ($spki.Length -ne 91 -or -not (Test-BytesStartWith $spki $script:P256SpkiPrefix)) { $reasons.Add('record_curve') }   # not a P-256 key (another curve, or not an EC key at all)
      elseif (-not (Test-P256PointOnCurve $spki)) { $reasons.Add('record_point_not_on_curve') }
    }
    elseif ($alg -eq -257) {
      $info = Get-RsaSpkiInfo $spki
      if ($null -eq $info) { $reasons.Add('record_public_key_not_rsa') }
      else {
        if ($info.Exponent -ne 65537) { $reasons.Add('record_rsa_exponent') }
        $sizeOk = if ($kind -ceq 'hello-rsa') { $info.Bits -eq 2048 } else { $info.Bits -ge 2048 -and $info.Bits -le 4096 }   # webauthn: 2048 or larger (capped at 4096 here, fail-safe); hello-rsa: exactly 2048
        if (-not $sizeOk) { $reasons.Add('record_rsa_size') }
      }
    }
    if ((Get-ApproverKeyIdFor $kind $spki) -cne [string]$Record.keyId) { $reasons.Add('record_key_id_mismatch') }
  }
  if ($kind -ceq 'webauthn') {
    $text = [string]$Record.credentialId
    $credential = ConvertFrom-Base64UrlNoPad $text
    if ($text.Length -eq 0 -or ($null -ne $credential -and ($credential.Length -lt 1 -or $credential.Length -gt 1023))) { $reasons.Add('record_credential_id_length') }
    elseif ($null -eq $credential) { $reasons.Add('record_credential_id_form') }
  }
  , @($reasons)
}
# A parsed record (a PSCustomObject from ConvertFrom-Json, in the file or in the config) -> the reasons it is not a valid key record (empty = valid).
function Test-ApproverKeyRecord($Record) {
  $reasons = New-Object System.Collections.Generic.List[string]
  if ($Record -isnot [System.Management.Automation.PSCustomObject]) { $reasons.Add('record_not_one_object'); return , @($reasons) }
  $names = Get-ObjectKeys $Record
  $kind = if ($names -ccontains 'kind') { $Record.kind } else { $null }
  if ($kind -isnot [string] -or @('webauthn', 'hello-rsa') -cnotcontains $kind) { $reasons.Add('record_kind'); return , @($reasons) }
  $expected = @('keyId', 'kind', 'alg', 'publicKey')
  if ($kind -ceq 'webauthn') { $expected += 'credentialId' }
  if (-not (Test-SameKeySet $Record $expected)) { $reasons.Add('record_fields'); return , @($reasons) }
  $typesOk = ($Record.keyId -is [string]) -and ($Record.publicKey -is [string]) -and (($Record.alg -is [int]) -or ($Record.alg -is [long])) -and (($kind -ceq 'hello-rsa') -or ($Record.credentialId -is [string]))
  if (-not $typesOk) { $reasons.Add('record_field_types'); return , @($reasons) }
  foreach ($why in (Test-ApproverKeyMaterial $Record)) { $reasons.Add($why) }
  , @($reasons | Select-Object -Unique)
}
# The record as one ordered object (the fixed field order of the contract), whatever it was read from.
function ConvertTo-ApproverKeyObject($Record) {
  $o = [ordered]@{ keyId = [string]$Record.keyId; kind = [string]$Record.kind; alg = [int]$Record.alg; publicKey = [string]$Record.publicKey }
  if ($o.kind -ceq 'webauthn') { $o['credentialId'] = [string]$Record.credentialId }
  [pscustomobject]$o
}
# The canonical text of a VALID record: the fields in exactly that order, no spaces, no escapes (every string was matched against a plain alphabet first), credentialId left out for hello-rsa.
function ConvertTo-ApproverKeyText($Record) {
  $text = '{"keyId":"' + $Record.keyId + '","kind":"' + $Record.kind + '","alg":' + ([long]$Record.alg).ToString([System.Globalization.CultureInfo]::InvariantCulture) + ',"publicKey":"' + $Record.publicKey + '"'
  if ($Record.kind -ceq 'webauthn') { $text += ',"credentialId":"' + $Record.credentialId + '"' }
  $text + '}'
}
# The bytes of one record file -> @{ Ok; Reasons; Record }. Exactly one record, UTF-8 without a byte order mark, and the file IS its canonical form byte for byte (so no extra field, no space, no line break,
# no other key order, no escape sequence, no repeated key can pass).
function Read-ApproverKeyRecordBytes([byte[]]$Bytes) {
  $c = Get-HostConstants
  $fail = { param($why) [pscustomobject]@{ Ok = $false; Reasons = @($why); Record = $null } }
  if ($Bytes.Length -eq 0) { return (& $fail 'record_empty') }
  if ($Bytes.Length -gt $c.MaxApproverKeyFileBytes) { return (& $fail 'record_too_large') }
  if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) { return (& $fail 'record_bom') }
  try { $text = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($Bytes) } catch { return (& $fail 'record_not_utf8') }
  if ($text.TrimStart().StartsWith('[', [System.StringComparison]::Ordinal)) { return (& $fail 'record_not_one_object') }
  try { $parsed = $text | ConvertFrom-Json } catch { return (& $fail 'record_syntax') }
  if (@($parsed).Count -ne 1) { return (& $fail 'record_not_one_object') }
  $reasons = Test-ApproverKeyRecord $parsed
  if ($reasons.Count -gt 0) { return [pscustomobject]@{ Ok = $false; Reasons = @($reasons); Record = $null } }
  $canonical = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-ApproverKeyText $parsed))
  $same = ($canonical.Length -eq $Bytes.Length)
  for ($i = 0; $same -and $i -lt $canonical.Length; $i++) { if ($canonical[$i] -ne $Bytes[$i]) { $same = $false } }
  if (-not $same) { return (& $fail 'record_not_canonical') }
  [pscustomobject]@{ Ok = $true; Reasons = @(); Record = (ConvertTo-ApproverKeyObject $parsed) }
}
# The metadata the Authority's `keys` reply carries for a list: [{"keyId","kind"[,"credentialId"]},...], compact, as ApproverKeyRules.MetadataJson writes it. Its size is capped (MaxApproverKeyMetadataBytes).
function Get-ApproverKeyMetadataBytes($Records) {
  $items = @(@($Records) | ForEach-Object { '{"keyId":"' + $_.keyId + '","kind":"' + $_.kind + '"' + $(if ($_.kind -ceq 'webauthn') { ',"credentialId":"' + $_.credentialId + '"' } else { '' }) + '}' })
  [System.Text.Encoding]::UTF8.GetByteCount('[' + ($items -join ',') + ']')
}
# The rules of a whole key list (1 to 16 records; no key, credential or public key twice; the metadata of the list fits a reply). Reasons are fixed words. Same rules as ApproverKeyRules.Fits of the Authority.
function Test-ApproverKeySet($Records) {
  $c = Get-HostConstants
  $reasons = New-Object System.Collections.Generic.List[string]
  $items = @($Records)
  if ($items.Count -lt 1) { $reasons.Add('approver_keys_none') }
  if ($items.Count -gt $c.MaxApproverKeys) { $reasons.Add('approver_keys_too_many') }
  # -CaseSensitive: base64 and base64url texts differ by case, and Sort-Object -Unique would otherwise take two different values for one
  $ids = @($items | ForEach-Object { [string]$_.keyId })
  if (@($ids | Sort-Object -Unique -CaseSensitive).Count -ne $ids.Count) { $reasons.Add('approver_keys_duplicate_key_id') }
  $credentials = @($items | Where-Object { $_.kind -ceq 'webauthn' } | ForEach-Object { [string]$_.credentialId })
  if (@($credentials | Sort-Object -Unique -CaseSensitive).Count -ne $credentials.Count) { $reasons.Add('approver_keys_duplicate_credential_id') }
  $publicKeys = @($items | ForEach-Object { [string]$_.publicKey })
  if (@($publicKeys | Sort-Object -Unique -CaseSensitive).Count -ne $publicKeys.Count) { $reasons.Add('approver_keys_duplicate_public_key') }
  if ($items.Count -ge 1 -and (Get-ApproverKeyMetadataBytes $items) -gt $c.MaxApproverKeyMetadataBytes) { $reasons.Add('approver_keys_metadata_too_large') }   # long credential ids lower the number of keys that fit
  , @($reasons)
}
# "webauthn-0123456789abcdef (webauthn), hello-... (hello-rsa)" for the lines a person reads.
function Get-ApproverKeySummary($Records) { (@($Records) | ForEach-Object { "$($_.keyId) ($($_.kind))" }) -join ', ' }
# True when two lists hold the same records in the same order.
function Test-ApproverKeyListsEqual($A, $B) {
  $x = @($A | ForEach-Object { ConvertTo-ApproverKeyText $_ }); $y = @($B | ForEach-Object { ConvertTo-ApproverKeyText $_ })
  ($x.Count -eq $y.Count) -and ((($x -join "`n") -ceq ($y -join "`n")))
}
# The legacy pair (approverKeyId + approverPublicKey) as the one hello-rsa record the Authority reads it as. -> @{ Ok; Reasons; Record }. It is a record like any other, so it must pass every rule: a legacy id that is not
# the hash of its key (or a key that is not RSA-2048 with exponent 65537) cannot be carried into approverKeys, and the caller says so instead of changing the id of a key.
function ConvertFrom-LegacyApproverPair([string]$KeyId, [string]$PublicKey) {
  $candidate = [pscustomobject]@{ keyId = $KeyId; kind = 'hello-rsa'; alg = -257; publicKey = $PublicKey }
  $reasons = Test-ApproverKeyRecord $candidate
  if ($reasons.Count -gt 0) { return [pscustomobject]@{ Ok = $false; Reasons = @($reasons); Record = $null } }
  [pscustomobject]@{ Ok = $true; Reasons = @(); Record = (ConvertTo-ApproverKeyObject $candidate) }
}
# The bytes of authority\approver-keys.json (approver-webauthn.md, "Key store": {"v":1,"revision":n,"keys":[records],"signCounts":{"<keyId>":n}}) -> @{ Ok; Reasons; Records }. The records are judged by the same rules as a
# key file's (Test-ApproverKeyRecord, then the list rules); the file is the Authority's, not a canonical record file, so its own formatting is not judged (a JSON writer may escape a '+' as \u002B).
function Read-ApproverKeyStoreBytes([byte[]]$Bytes) {
  $c = Get-HostConstants
  $fail = { param($why) [pscustomobject]@{ Ok = $false; Reasons = @($why); Records = @() } }
  if ($Bytes.Length -eq 0) { return (& $fail 'store_empty') }
  if ($Bytes.Length -gt $c.AuthorityKeyStoreMaxBytes) { return (& $fail 'store_too_large') }
  if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) { return (& $fail 'store_bom') }
  try { $text = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($Bytes) } catch { return (& $fail 'store_not_utf8') }
  try { $o = $text | ConvertFrom-Json } catch { return (& $fail 'store_syntax') }
  # '{' first: a top-level array of one store would come out of ConvertFrom-Json as that store
  if (-not $text.TrimStart().StartsWith('{', [System.StringComparison]::Ordinal) -or $o -isnot [System.Management.Automation.PSCustomObject] -or -not (Test-SameKeySet $o @('v', 'revision', 'keys', 'signCounts'))) { return (& $fail 'store_fields') }
  $isWhole = { param($n) ($n -is [int] -or $n -is [long]) -and $n -ge 0 -and $n -le 4294967295 }   # a sign count is a uint32
  if (($o.v -isnot [int]) -or $o.v -ne 1) { return (& $fail 'store_version') }
  if (-not (& $isWhole $o.revision) -or $o.revision -lt 1) { return (& $fail 'store_revision') }   # the Authority starts at revision 1
  if ($o.keys -isnot [System.Array]) { return (& $fail 'store_keys') }
  if ($o.signCounts -isnot [System.Management.Automation.PSCustomObject]) { return (& $fail 'store_sign_counts') }
  $reasons = New-Object System.Collections.Generic.List[string]
  $records = New-Object System.Collections.Generic.List[object]
  foreach ($item in $o.keys) {
    $why = Test-ApproverKeyRecord $item
    if ($why.Count -gt 0) { foreach ($w in $why) { if (-not $reasons.Contains("store_key:$w")) { $reasons.Add("store_key:$w") } } }
    else { $records.Add((ConvertTo-ApproverKeyObject $item)) }
  }
  if ($reasons.Count -eq 0) { foreach ($w in (Test-ApproverKeySet $records.ToArray())) { $reasons.Add("store_keys:$w") } }
  if ($reasons.Count -gt 0) { return [pscustomobject]@{ Ok = $false; Reasons = @($reasons); Records = @() } }
  # a sign count only for a registered key, and a whole number (the Authority refuses a store with a count for a key it does not hold)
  foreach ($count in $o.signCounts.PSObject.Properties) {
    $name = $count.Name
    if (@($records | Where-Object { $_.keyId -ceq $name }).Count -eq 0 -or -not (& $isWhole $count.Value)) { return (& $fail 'store_sign_counts') }
  }
  [pscustomobject]@{ Ok = $true; Reasons = @(); Records = $records.ToArray() }
}
# The key list set-approver writes: the keys IN FORCE (the Authority's key store when there is one, otherwise the config's keys) plus the given records - or, with $Replace, the given records alone. The keys in force
# come first, in their order; nothing is dropped without -Replace. A given keyId that is in force already is refused (not skipped), and so is a list over the limit. -> @{ Ok; Reasons; Records; Kept; Added; Removed }
# Starting from the config alone would bring back a key that key_remove took out of the store (a lost device): the caller passes the store's keys whenever the store is there.
function Get-SetApproverFinalKeys($InForce, $Given, [bool]$Replace) {
  $c = Get-HostConstants
  $given = @($Given); $inForce = @($InForce)
  $reasons = New-Object System.Collections.Generic.List[string]
  if ($Replace) { $final = $given; $kept = @(); $removed = @($inForce | Where-Object { $id = $_.keyId; -not (@($given | Where-Object { $_.keyId -ceq $id }).Count -gt 0) }) }
  else {
    $already = @($given | Where-Object { $id = $_.keyId; @($inForce | Where-Object { $_.keyId -ceq $id }).Count -gt 0 })
    if ($already.Count -gt 0) { $reasons.Add('already_registered:' + (@($already | ForEach-Object { $_.keyId }) -join ',')) }
    if ($inForce.Count + $given.Count -gt $c.MaxApproverKeys) { $reasons.Add('too_many_keys:' + ($inForce.Count + $given.Count)) }
    $final = @($inForce) + @($given); $kept = $inForce; $removed = @()
  }
  if ($reasons.Count -eq 0) { foreach ($why in (Test-ApproverKeySet $final)) { $reasons.Add($why) } }
  [pscustomobject]@{ Ok = ($reasons.Count -eq 0); Reasons = @($reasons); Records = @($final); Kept = @($kept); Added = $given; Removed = @($removed) }
}

# The install record's copy of the list: { keyId, kind } per key (public ids only). Used by Test-ManifestShape and by set-approver / install when they record a list.
function Test-ApproverKeysManifestList($List) {
  $c = Get-HostConstants
  if ($List -isnot [System.Collections.IEnumerable] -or $List -is [string]) { return $false }
  $items = @($List)
  if ($items.Count -lt 1 -or $items.Count -gt $c.MaxApproverKeys) { return $false }
  foreach ($e in $items) {
    if ($e -isnot [System.Collections.IDictionary]) { return $false }
    $keys = @($e.Keys)
    if ($keys.Count -ne 2 -or $keys -cnotcontains 'keyId' -or $keys -cnotcontains 'kind') { return $false }
    if ($e['keyId'] -isnot [string] -or $e['kind'] -isnot [string] -or $e['keyId'] -cnotmatch '^(webauthn|hello)-[0-9a-f]{16}\z') { return $false }
    if (@('webauthn', 'hello-rsa') -cnotcontains $e['kind']) { return $false }
    if (-not $e['keyId'].StartsWith($(if ($e['kind'] -ceq 'webauthn') { 'webauthn-' } else { 'hello-' }), [System.StringComparison]::Ordinal)) { return $false }
  }
  $true
}
function ConvertTo-ApproverKeysManifestValue($Records) {
  $list = New-Object System.Collections.Generic.List[object]
  foreach ($r in @($Records)) {
    $d = New-Object 'System.Collections.Generic.Dictionary[string,object]'
    $d['keyId'] = [string]$r.keyId; $d['kind'] = [string]$r.kind
    $list.Add($d)
  }
  , $list.ToArray()
}

# ---------------------------------------------------------------------------------------------- the three config files
# $Computers is $null (or empty) for an install without -GrantHyperVToBroker: the config is then exactly the seven keys it always had. With it, the optional `computers` key is added last.
# $Wsl2 is $null without -AddWsl2Computer; with it { ComputerId, KeyName, KeyId }: the `kind: wsl2` computer is added to `computers` and the `attestation` key is added last (ServiceConfig.cs).
function Get-BrokerConfig($Layout, [string]$ControlPlaneSid, [string]$AuthoritySpki, $Computers = $null, $Wsl2 = $null) {
  $c = Get-HostConstants
  $config = [ordered]@{
    pipeName = $c.BrokerPipeName
    database = $Layout.BrokerDb
    authorityKeys = @([ordered]@{ kid = $c.AuthorityKid; spki = $AuthoritySpki })
    controlPlaneSid = $ControlPlaneSid
    generation = $c.Generation
    leaseId = $c.LeaseId
    policyVersion = $c.PolicyVersion
  }
  $entries = @()
  if ($null -ne $Computers -and @($Computers).Count -gt 0) { $entries += @($Computers) }
  if ($null -ne $Wsl2) { $entries += [ordered]@{ computerId = $Wsl2.ComputerId; kind = 'wsl2' } }
  if ($entries.Count -gt 0) { $config['computers'] = @($entries) }
  if ($null -ne $Wsl2) { $config['attestation'] = [ordered]@{ keyName = $Wsl2.KeyName; keyId = $Wsl2.KeyId } }
  $config
}
# One entry of the Broker config `computers` list (ServiceConfig.cs: computerId = contract id, vmId = lowercase GUID of the VM).
function Get-BrokerComputers([string]$ComputerId, [string]$VmId) {
  if (-not (Test-HostId $ComputerId)) { throw 'computer_id_invalid' }
  if (-not (Test-VmGuid $VmId)) { throw 'vm_id_invalid' }
  , @([ordered]@{ computerId = $ComputerId; vmId = $VmId })
}
# $Approver holds approverSid and EITHER the legacy pair (approverKeyId + approverPublicKey: one Windows Hello key) OR approverKeys (1 to 16 key records, approver-webauthn.md). Never both: the Authority
# refuses a config that has the pair and the list (config_approver_keys), and this function will not write one.
# $Attestation is $null without -AddWsl2Computer; with it { keyId, spki }: the Broker's attestation key the Authority pins (AuthorityConfig.cs: attestationKeyId + attestationPublicKey, only together).
function Get-AuthorityConfig([string]$ControlPlaneSid, $Approver, $Attestation = $null) {
  $c = Get-HostConstants
  $hasList = $null -ne $Approver.PSObject.Properties['approverKeys']
  $hasPair = ($null -ne $Approver.PSObject.Properties['approverKeyId']) -or ($null -ne $Approver.PSObject.Properties['approverPublicKey'])
  if ($hasList -and $hasPair) { throw 'approver_pair_and_keys_together' }
  $config = [ordered]@{
    pipeRoot = $c.AuthorityPipeRoot
    controlPlaneSid = $ControlPlaneSid
    approverSid = $Approver.approverSid
    signingKeyName = $c.SigningKeyName
    signingKeyProvider = $c.SigningKeyProvider
    kid = $c.AuthorityKid
  }
  if ($hasList) {
    if (@($Approver.approverKeys).Count -lt 1) { throw 'approver_keys_empty' }
    $config['approverKeys'] = @($Approver.approverKeys | ForEach-Object { ConvertTo-ApproverKeyObject $_ })
  }
  else {
    $config['approverKeyId'] = $Approver.approverKeyId
    $config['approverPublicKey'] = $Approver.approverPublicKey
  }
  if ($null -ne $Attestation) { $config['attestationKeyId'] = $Attestation.keyId; $config['attestationPublicKey'] = $Attestation.spki }
  $config['audience'] = $c.Audience
  $config['policyVersion'] = $c.PolicyVersion
  $config
}
# The settings of the approval flow (room-approval-wiring.mjs). The settings parser needs at least one computer; approval-check uses the first. There is NO attestation key (the Control Plane service
# flow does not use one, PR #185 hand-over item 4); the parser reads a missing key as null, so approval-check is unaffected. The file sits in control-plane-config\ (the service can only READ it);
# the journal it names is in control-plane\ (the one place the service can write).
# $HelperSha256 is $null for an install without -GrantHyperVToBroker: the settings are then without a desktop block. With it the `desktop` block that the gated room requires
# (room-approval-wiring.mjs: exactly { helperPath, helperSha256 }, placed after `computers`) is added: the installed pipe client helper and the SHA-256 of that exe. Both are public values.
# $Wsl2 is $null without -AddWsl2Computer; with it { ComputerId, RepositoryId, PipeName, ServerSid, Git }: a second computer (no VM) and the `wsl2` block (room-approval-wiring.mjs), which needs the desktop block too.
function Get-ControlPlaneSettings($Layout, [string]$ProjectId, [string]$VmName, [string]$ComputerId, [string]$HelperSha256 = $null, $Wsl2 = $null) {
  $c = Get-HostConstants
  $settings = [ordered]@{
    version = 1
    projectId = $ProjectId
    broker = [ordered]@{ pipeName = $c.BrokerPipeName; expect = [ordered]@{ serviceName = $c.BrokerService } }
    authority = [ordered]@{ pipeRoot = $c.AuthorityPipeRoot; expect = [ordered]@{ serviceName = $c.AuthorityService } }
    journal = $Layout.ControlPlaneJournal
    computers = [ordered]@{ $VmName = $ComputerId }
  }
  if (-not [string]::IsNullOrEmpty($HelperSha256)) {
    if (-not (Test-TreeHashValue $HelperSha256)) { throw 'helper_sha256_invalid' }
    $settings['desktop'] = [ordered]@{ helperPath = $Layout.PipeClientExe; helperSha256 = $HelperSha256 }
  }
  if ($null -ne $Wsl2) {
    if ([string]::IsNullOrEmpty($HelperSha256)) { throw 'wsl2_needs_desktop_block' }
    $settings['computers'][$Wsl2.ComputerId] = [ordered]@{ computerId = $Wsl2.ComputerId; isolation = 'wsl2'; repositoryId = $Wsl2.RepositoryId }
    $settings['wsl2'] = [ordered]@{ pipeName = $Wsl2.PipeName; serverSid = $Wsl2.ServerSid; git = $Wsl2.Git }
  }
  $settings
}
function ConvertTo-HostJson($Object) { $Object | ConvertTo-Json -Depth 6 -Compress }

# AlberaControlPlane.service.json, read by two programs: the .NET host reads ONLY its top-level key `host` (HostConfig.cs: exactly these nine keys), and room-service reads ONLY `claude` and `ui`
# (PR #185: any other top-level key, or any other key inside claude / ui, is refused). The values are public: paths, hashes, two SIDs. maxMinutes / maxToolCalls are the contract's section 6.6 defaults.
$script:CpHostDefaults = [ordered]@{ logMaxBytes = 1048576; maxRestarts = 5; restartDelayMs = 5000; stableRunMs = 60000 }
$script:CpClaudeDefaults = [ordered]@{ maxMinutes = 15; maxToolCalls = 120 }
function Get-ControlPlaneServiceConfig($Layout, [string]$NodeSha256, [string]$ClaudeSha256, [string]$ControlPlaneSid, [string]$ApproverSid) {
  if (-not (Test-TreeHashValue $NodeSha256)) { throw 'node_sha256_invalid' }
  if (-not (Test-TreeHashValue $ClaudeSha256)) { throw 'claude_sha256_invalid' }
  if (-not (Test-ServiceSidShape $ControlPlaneSid)) { throw 'control_plane_sid_invalid' }
  if (-not (Test-AccountSidShape $ApproverSid)) { throw 'approver_sid_invalid' }
  [ordered]@{
    host = [ordered]@{
      nodePath = $Layout.ControlPlaneNodeExe; nodeSha256 = $NodeSha256; appPath = $Layout.ControlPlaneAppDir; dataRoot = $Layout.DataRoot; logDirectory = $Layout.ControlPlaneLogDir
      logMaxBytes = $script:CpHostDefaults.logMaxBytes; maxRestarts = $script:CpHostDefaults.maxRestarts; restartDelayMs = $script:CpHostDefaults.restartDelayMs; stableRunMs = $script:CpHostDefaults.stableRunMs
    }
    claude = [ordered]@{ executable = $Layout.ClaudeExe; executableSha256 = $ClaudeSha256; maxMinutes = $script:CpClaudeDefaults.maxMinutes; maxToolCalls = $script:CpClaudeDefaults.maxToolCalls }
    ui = [ordered]@{ controlPlaneSid = $ControlPlaneSid; approverSid = $ApproverSid }
  }
}
# The reasons a service config text is not exactly the one install writes for these values (empty = it is). Compared case-sensitively, key set by key set (a stray key is how a file the installer did not write shows up).
function Test-ControlPlaneServiceConfigText([string]$Json, $Layout, [string]$NodeSha256, [string]$ClaudeSha256, [string]$ControlPlaneSid, [string]$ApproverSid) {
  $reasons = New-Object System.Collections.Generic.List[string]
  if ((Get-ByteLength $Json) -gt 16384) { $reasons.Add('config_too_large'); return , @($reasons) }
  try { $o = $Json | ConvertFrom-Json } catch { $reasons.Add('config_syntax'); return , @($reasons) }
  if (-not (Test-SameKeySet $o @('host', 'claude', 'ui'))) { $reasons.Add('config_keys'); return , @($reasons) }
  try { $want = (ConvertTo-HostJson (Get-ControlPlaneServiceConfig $Layout $NodeSha256 $ClaudeSha256 $ControlPlaneSid $ApproverSid)) | ConvertFrom-Json } catch { $reasons.Add('expected_values_invalid'); return , @($reasons) }
  foreach ($section in @('host', 'claude', 'ui')) {
    $have = $o.$section; $expect = $want.$section
    if ($have -isnot [System.Management.Automation.PSCustomObject] -or -not (Test-SameKeySet $have (Get-ObjectKeys $expect))) { $reasons.Add($section + '_keys'); continue }
    foreach ($key in (Get-ObjectKeys $expect)) {
      $a = $have.$key; $b = $expect.$key
      $same = if ($b -is [string]) { ($a -is [string]) -and ($a -ceq $b) } else { ($a -isnot [string]) -and ($a -eq $b) }
      if (-not $same) { $reasons.Add($section + '_' + $key) }
    }
  }
  , @($reasons)
}

function Get-ObjectKeys($Object) { @($Object.PSObject.Properties | ForEach-Object { $_.Name }) }
function Test-SameKeySet($Object, [string[]]$Expected) {
  $keys = Get-ObjectKeys $Object
  ($keys.Count -eq $Expected.Count) -and (@($keys | Where-Object { $Expected -ccontains $_ }).Count -eq $Expected.Count)
}
function Get-ByteLength([string]$Text) { [System.Text.Encoding]::UTF8.GetByteCount($Text) }

# Each returns the list of fixed reason words (empty = the real service would accept the shape). They cannot see the machine (the SID lookup, the folder ACLs, whether a folder
# exists), and `service-check` run from an elevated console cannot either: see albera-host.ps1 ("service-check is inconclusive").
# Mirror of ServiceConfig.ReadComputers: an array of 0..8 entries, each exactly { computerId, vmId } (a contract id and a lowercase GUID) or { computerId, kind: "wsl2" } (a contract id),
# every computerId at most once across both kinds and every vmId at most once.
function Test-ComputersList($List) {
  if ($null -eq $List -or $List -is [string] -or $List -isnot [System.Array]) { return $false }
  $items = @($List)
  if ($items.Count -gt 8) { return $false }
  $vmIds = New-Object System.Collections.Generic.List[string]
  foreach ($e in $items) {
    if ($e -isnot [System.Management.Automation.PSCustomObject]) { return $false }
    if (Test-SameKeySet $e @('computerId', 'kind')) {
      if ($e.computerId -isnot [string] -or $e.kind -isnot [string] -or $e.kind -cne 'wsl2' -or -not (Test-HostId $e.computerId)) { return $false }
    }
    elseif (Test-SameKeySet $e @('computerId', 'vmId')) {
      if ($e.computerId -isnot [string] -or $e.vmId -isnot [string] -or -not (Test-HostId $e.computerId) -or -not (Test-VmGuid $e.vmId)) { return $false }
      $vmIds.Add($e.vmId)
    }
    else { return $false }
  }
  (@($items | ForEach-Object { $_.computerId } | Sort-Object -Unique).Count -eq $items.Count) -and (@($vmIds | Sort-Object -Unique).Count -eq $vmIds.Count)
}
# True when the Broker config holds exactly the one computer the install intends (used to tell a finished config from one written before -GrantHyperVToBroker).
function Test-BrokerConfigComputers([string]$Json, [string]$ComputerId, [string]$VmId) {
  try { $o = $Json | ConvertFrom-Json } catch { return $false }
  if ($null -eq $o.PSObject.Properties['computers'] -or -not (Test-ComputersList $o.computers)) { return $false }
  $items = @(@($o.computers) | Where-Object { $null -ne $_.PSObject.Properties['vmId'] })   # a `kind: wsl2` entry (-AddWsl2Computer) is not a VM
  ($items.Count -eq 1) -and ($items[0].computerId -ceq $ComputerId) -and ($items[0].vmId -ceq $VmId)
}
# True when the Control Plane settings text has a `desktop` key at all (any value). An install without -GrantHyperVToBroker writes none, so status reports one found without the grant record.
function Test-ControlPlaneHasDesktopKey([string]$Json) {
  try { $o = $Json | ConvertFrom-Json } catch { return $false }
  ($null -ne $o) -and ($null -ne $o.PSObject.Properties['desktop'])
}
# True when the Control Plane settings hold exactly the `desktop` block the install intends (the installed helper path and its SHA-256). False for a file written before
# -GrantHyperVToBroker (no block), for extra or missing keys, and for any other value. Compared case-sensitively, like the settings parser.
function Test-ControlPlaneDesktop([string]$Json, [string]$HelperPath, [string]$HelperSha256) {
  try { $o = $Json | ConvertFrom-Json } catch { return $false }
  if ($null -eq $o -or $null -eq $o.PSObject.Properties['desktop']) { return $false }
  $d = $o.desktop
  if ($d -isnot [System.Management.Automation.PSCustomObject] -or -not (Test-SameKeySet $d @('helperPath', 'helperSha256'))) { return $false }
  ($d.helperPath -is [string]) -and ($d.helperSha256 -is [string]) -and ($d.helperPath -ceq $HelperPath) -and ($d.helperSha256 -ceq $HelperSha256)
}
# Mirror of ServiceConfig.ReadAttestation: exactly { keyName, keyId }, a CNG key name (1..64 letters, digits, . _ -) and a contract id. The installer creates the key; this only checks the shape.
function Test-AttestationConfig($Value) {
  if ($Value -isnot [System.Management.Automation.PSCustomObject] -or -not (Test-SameKeySet $Value @('keyName', 'keyId'))) { return $false }
  ($Value.keyName -is [string]) -and ($Value.keyId -is [string]) -and ($Value.keyName -cmatch '^[A-Za-z0-9._-]{1,64}\z') -and (Test-HostId $Value.keyId)
}
function Test-BrokerConfigText([string]$Json) {
  $reasons = New-Object System.Collections.Generic.List[string]
  if ((Get-ByteLength $Json) -gt 4096) { $reasons.Add('config_too_large'); return , @($reasons) }
  try { $o = $Json | ConvertFrom-Json } catch { $reasons.Add('config_syntax'); return , @($reasons) }
  $expected = @('pipeName', 'database', 'authorityKeys', 'controlPlaneSid', 'generation', 'leaseId', 'policyVersion')
  $hasComputers = $null -ne $o.PSObject.Properties['computers']   # the one optional key (ServiceConfig.cs ComputersKey)
  if ($hasComputers) { $expected = @($expected) + 'computers' }
  $hasAttestation = $null -ne $o.PSObject.Properties['attestation']   # the other optional key (ServiceConfig.cs AttestationKey); the lib never writes it
  if ($hasAttestation) { $expected = @($expected) + 'attestation' }
  if (-not (Test-SameKeySet $o $expected)) { $reasons.Add('config_keys'); return , @($reasons) }
  if ($hasComputers -and -not (Test-ComputersList $o.computers)) { $reasons.Add('computers') }
  if ($hasAttestation -and -not (Test-AttestationConfig $o.attestation)) { $reasons.Add('attestation') }
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
  $c = Get-HostConstants
  $reasons = New-Object System.Collections.Generic.List[string]
  $size = Get-ByteLength $Json
  if ($size -gt $c.AuthorityConfigMaxBytes) { $reasons.Add('config_too_large'); return , @($reasons) }
  try { $o = $Json | ConvertFrom-Json } catch { $reasons.Add('config_syntax'); return , @($reasons) }
  if ($o -isnot [System.Management.Automation.PSCustomObject]) { $reasons.Add('config_keys'); return , @($reasons) }
  # Two shapes: the legacy pair (one Windows Hello key), or approverKeys (1 to 16 key records, approver-webauthn.md). Both together are refused, like the Authority refuses them.
  $names = Get-ObjectKeys $o
  $hasList = $names -ccontains 'approverKeys'
  if ($hasList -and ($names -ccontains 'approverKeyId' -or $names -ccontains 'approverPublicKey')) { $reasons.Add('config_approver_keys'); return , @($reasons) }
  if (-not $hasList -and $size -gt 4096) { $reasons.Add('config_too_large'); return , @($reasons) }   # the size the Authority has always read; only a key list needs more
  $expected = @('pipeRoot', 'controlPlaneSid', 'approverSid', 'signingKeyName', 'signingKeyProvider', 'kid', 'audience', 'policyVersion') + $(if ($hasList) { @('approverKeys') } else { @('approverKeyId', 'approverPublicKey') })
  $hasAttestation = ($names -ccontains 'attestationKeyId') -or ($names -ccontains 'attestationPublicKey')   # the Broker's attestation key (-AddWsl2Computer): both keys or neither
  if ($hasAttestation) { $expected = @($expected) + @('attestationKeyId', 'attestationPublicKey') }
  $allStrings = @($o.PSObject.Properties | Where-Object { $_.Name -cne 'approverKeys' -and $_.Value -isnot [string] }).Count -eq 0
  if (-not (Test-SameKeySet $o $expected) -or -not $allStrings) { $reasons.Add('config_keys'); return , @($reasons) }
  if (-not (Test-PipeRoot $o.pipeRoot)) { $reasons.Add('pipe_root') }
  if (-not ((Test-AccountSidShape $o.controlPlaneSid) -or (Test-ServiceSidShape $o.controlPlaneSid))) { $reasons.Add('control_plane_sid') }
  if (-not (Test-AccountSidShape $o.approverSid)) { $reasons.Add('approver_sid') }
  if ($o.controlPlaneSid -ceq $o.approverSid) { $reasons.Add('sids_not_distinct') }
  if (-not (Test-KeyName $o.signingKeyName)) { $reasons.Add('signing_key') }
  if ($o.signingKeyProvider -cne 'software' -and $o.signingKeyProvider -cne 'tpm') { $reasons.Add('signing_provider') }
  if (-not (Test-HostId $o.kid)) { $reasons.Add('kid') }
  if ($hasList) { foreach ($why in (Test-AuthorityConfigKeyList $o.approverKeys)) { $reasons.Add($why) } }
  else {
    if (-not (Test-HostId $o.approverKeyId)) { $reasons.Add('approver_key_id') }
    if (-not (Test-Rsa2048Spki $o.approverPublicKey)) { $reasons.Add('approver_public_key') }
  }
  if ($hasAttestation -and -not (Test-HostId $o.attestationKeyId)) { $reasons.Add('attestation_key_id') }
  if ($hasAttestation -and -not (Test-P256Spki $o.attestationPublicKey)) { $reasons.Add('attestation_public_key') }
  if (-not (Test-AudienceName $o.audience)) { $reasons.Add('audience') }
  if (-not (Test-HostId $o.policyVersion)) { $reasons.Add('policy_version') }
  , @($reasons)
}
# The approverKeys value of an Authority config: an array of 1 to 16 valid key records, no key, credential or public key twice. Reason words: approver_keys, approver_keys:<record or set reason>.
function Test-AuthorityConfigKeyList($List) {
  $reasons = New-Object System.Collections.Generic.List[string]
  if ($List -isnot [System.Array]) { $reasons.Add('approver_keys'); return , @($reasons) }
  $items = @($List)
  $valid = New-Object System.Collections.Generic.List[object]
  foreach ($item in $items) {
    $why = Test-ApproverKeyRecord $item
    if ($why.Count -gt 0) { foreach ($w in $why) { if (-not $reasons.Contains("approver_keys:$w")) { $reasons.Add("approver_keys:$w") } } }
    else { $valid.Add((ConvertTo-ApproverKeyObject $item)) }
  }
  if ($reasons.Count -eq 0) { foreach ($w in (Test-ApproverKeySet $valid.ToArray())) { $reasons.Add("approver_keys:$w") } }
  , @($reasons)
}
# What an Authority config (text) says about its approver keys, for status and set-approver: @{ Reasons; Legacy; Approver; Keys }. Reasons = what Test-AuthorityConfigText says (empty = valid). Keys = { KeyId; Kind } in
# order (the legacy pair counts as one hello-rsa key, as the Authority reads it). Approver = the object Get-AuthorityConfig takes (approverSid and the pair or the list), to rebuild the config with.
function Get-AuthorityConfigApproverKeys([string]$Json) {
  $reasons = Test-AuthorityConfigText $Json
  if ($reasons.Count -gt 0) { return [pscustomobject]@{ Reasons = @($reasons); Legacy = $false; Approver = $null; Keys = @(); Attestation = $null } }
  $o = $Json | ConvertFrom-Json
  # the Broker's attestation key (-AddWsl2Computer) is carried along: set-approver rebuilds the config and must not drop it
  $attestation = if ($null -ne $o.PSObject.Properties['attestationKeyId']) { [pscustomobject]@{ keyId = [string]$o.attestationKeyId; spki = [string]$o.attestationPublicKey } } else { $null }
  if ($null -ne $o.PSObject.Properties['approverKeys']) {
    $records = @($o.approverKeys | ForEach-Object { ConvertTo-ApproverKeyObject $_ })
    return [pscustomobject]@{ Reasons = @(); Legacy = $false; Approver = [pscustomobject]@{ approverSid = [string]$o.approverSid; approverKeys = $records }; Keys = @($records | ForEach-Object { [pscustomobject]@{ KeyId = $_.keyId; Kind = $_.kind } }); Attestation = $attestation }
  }
  [pscustomobject]@{
    Reasons = @(); Legacy = $true
    Approver = [pscustomobject]@{ approverSid = [string]$o.approverSid; approverKeyId = [string]$o.approverKeyId; approverPublicKey = [string]$o.approverPublicKey }
    Keys = @([pscustomobject]@{ KeyId = [string]$o.approverKeyId; Kind = 'hello-rsa' }); Attestation = $attestation
  }
}
# The status line about the approver keys: the keys the Authority config holds (ids and kinds), compared with the install record. $RecordValues = the manifest's `values`. -> @{ State; Text }.
function Get-ApproverKeysStatusLine([string]$ConfigJson, $RecordValues) {
  $state = Get-AuthorityConfigApproverKeys $ConfigJson
  if ($state.Reasons.Count -gt 0) { return [pscustomobject]@{ State = 'FAIL'; Text = 'Authority approver keys: the config is not valid (' + ($state.Reasons -join ', ') + ')' } }
  $shown = (@($state.Keys) | ForEach-Object { "$($_.KeyId) ($($_.Kind))" }) -join ', '
  $source = if ($state.Legacy) { 'the legacy fields approverKeyId + approverPublicKey, one hello-rsa key' } else { 'approverKeys' }
  $problem = $null
  if ($RecordValues.ContainsKey('approverKeys')) {
    $recorded = @($RecordValues['approverKeys'] | ForEach-Object { "$($_['keyId']) ($($_['kind']))" }) -join ', '
    if ($state.Legacy -or $recorded -cne $shown) { $problem = "the install record says: $recorded" }
  }
  elseif ($RecordValues.ContainsKey('approverKeyId')) {
    if (-not $state.Legacy -or $RecordValues['approverKeyId'] -cne $state.Keys[0].KeyId) { $problem = "the install record says: $($RecordValues['approverKeyId'])" }
  }
  if ($problem) { return [pscustomobject]@{ State = 'FAIL'; Text = "Authority approver keys: $shown ($source) differ from the install record ($problem)" } }
  [pscustomobject]@{ State = 'ok'; Text = "Authority approver keys: $(@($state.Keys).Count) key(s): $shown ($source)" }
}

# ---------------------------------------------------------------------------------------------- folders and ACLs
# One entry per folder: icacls grants ('*SID:rights'). Inheritance is removed on every folder; SYSTEM and Administrators get full control; nobody else gets write unless it is their own
# folder. Same pattern as Set-LabAcl in test/windows-service-lab/lab-guest.ps1. `Sids` = @{ Broker; Authority; ControlPlane } (SID strings).
function Get-AclPlan($Layout, $Sids) {
  $full = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
  $b = $Sids.Broker; $a = $Sids.Authority; $cp = $Sids.ControlPlane
  $plan = @(
    # The install folder carries SYSTEM, Administrators and the three service SIDs ONLY - not BUILTIN\Users. Users get read and execute on three sub-folders and nothing else (Grant-UsersReadExecute in
    # albera-host.ps1: bin\approver, bin\launcher, bin\setup, which the owner's own session runs), so bin\claude, bin\control-plane (node included) and the .partial folders cannot be read or run by the owner's session.
    [pscustomobject]@{ Path = $Layout.InstallRoot; Grants = @($full + @("*${b}:(OI)(CI)RX", "*${a}:(OI)(CI)RX", "*${cp}:(OI)(CI)RX")) }
    [pscustomobject]@{ Path = $Layout.DataRoot; Grants = @($full + @("*${b}:RX", "*${a}:RX", "*${cp}:RX")) }
    [pscustomobject]@{ Path = $Layout.BrokerConfigDir; Grants = @($full + @("*${b}:(OI)(CI)RX")) }
    [pscustomobject]@{ Path = $Layout.BrokerDbDir; Grants = @($full + @("*${b}:(OI)(CI)M")) }
    [pscustomobject]@{ Path = $Layout.AuthorityDir; Grants = @($full + @("*${a}:(OI)(CI)M")) }
    # Full, not Modify: the Control Plane journal (src/runtime/sqlite-operation-store.mjs, assertPrivateWindowsAcl) refuses a folder or file where its own user lacks full control
    [pscustomobject]@{ Path = $Layout.ControlPlaneDir; Grants = @($full + @("*${cp}:(OI)(CI)F")) }
    # The host's log folder must exist before the service starts (HostConfig.cs checks it) and the service writes in it: its own entry, so that it is born with its final ACL.
    [pscustomobject]@{ Path = $Layout.ControlPlaneLogDir; Grants = @($full + @("*${cp}:(OI)(CI)F")) }
    # The settings the service READS (host block, claude and ui blocks, the approval settings): it can read them and not change them.
    [pscustomobject]@{ Path = $Layout.ControlPlaneConfigDir; Grants = @($full + @("*${cp}:(OI)(CI)R")) }
    # DPAPI blobs: the service reads and writes them; nobody else, the owner included (control-plane-service.md section 3).
    [pscustomobject]@{ Path = $Layout.SecretsDir; Grants = @($full + @("*${cp}:(OI)(CI)M")) }
  )
  # ui\: the service writes room.json and replaces it; the owner (approverSid) may read it, and nothing else of the owner's. Without an approver SID (a status of a record that has none) the folder is planned without it.
  $ui = @($full + @("*${cp}:(OI)(CI)M"))
  if ($Sids.Approver) { $ui += "*$($Sids.Approver):(OI)(CI)R" }
  $plan + @([pscustomobject]@{ Path = $Layout.UiDir; Grants = $ui })
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
  # all three services start by themselves, delayed (control-plane-service.md D5): the services are not an on-demand tool any more, the room must be there after a reboot
  'create ' + $Name + ' binPath= "' + $bin + '" obj= "NT SERVICE\' + $Name + '" start= delayed-auto type= own'
}
# `sc failure`: restart after 5 s, twice, and nothing the third time ("restart after 5 s, twice, then leave stopped"). The third action is an empty one (sc.exe's "none"). The counter resets after a day.
function Get-ScFailureArguments([string]$Name) {
  $c = Get-HostConstants
  $ms = $c.FailureRestartMilliseconds
  'failure ' + $Name + ' reset= ' + $c.FailureResetSeconds + ' actions= restart/' + $ms + '/restart/' + $ms + '//0'
}
# SERVICE_FAILURE_ACTIONS as the SCM stores it in HKLM\SYSTEM\CurrentControlSet\Services\<name>\FailureActions (REG_BINARY): DWORD reset period (seconds), DWORD reboot-message offset, DWORD command offset,
# DWORD cActions, DWORD offset of the action array, then cActions x { DWORD type (0 none, 1 restart, 2 reboot, 3 run command), DWORD delay (ms) }. Read from the registry instead of `sc qfailure`, whose text
# is localized (a Japanese or German Windows prints other words). $null when the bytes are not that structure.
function ConvertFrom-FailureActionsBytes([byte[]]$Bytes) {
  if ($null -eq $Bytes -or $Bytes.Length -lt 20) { return $null }
  [long]$count = [BitConverter]::ToUInt32($Bytes, 12)
  [long]$offset = [BitConverter]::ToUInt32($Bytes, 16)
  if ($count -gt 16 -or $offset -lt 20 -or ($offset + 8 * $count) -gt $Bytes.Length) { return $null }
  $actions = New-Object System.Collections.Generic.List[object]
  for ($i = 0; $i -lt $count; $i++) { $actions.Add([pscustomobject]@{ Type = [int][BitConverter]::ToUInt32($Bytes, [int]($offset + 8 * $i)); DelayMs = [int64][BitConverter]::ToUInt32($Bytes, [int]($offset + 8 * $i + 4)) }) }
  [pscustomobject]@{ ResetSeconds = [int64][BitConverter]::ToUInt32($Bytes, 0); Actions = $actions.ToArray() }
}
# The reasons the stored failure actions are not "restart after 5 s, twice, then nothing, counter reset after a day" (empty = they are). The first two actions are restarts of 5000 ms; any further one is "none".
function Test-ServiceFailureBytes([byte[]]$Bytes) {
  $c = Get-HostConstants
  $reasons = New-Object System.Collections.Generic.List[string]
  $parsed = ConvertFrom-FailureActionsBytes $Bytes
  if ($null -eq $parsed) { $reasons.Add('failure_actions_unreadable'); return , @($reasons) }
  $actions = @($parsed.Actions)
  if ($actions.Count -lt 2 -or $actions[0].Type -ne 1 -or $actions[1].Type -ne 1) { $reasons.Add('failure_actions_not_two_restarts') }
  elseif ($actions[0].DelayMs -ne $c.FailureRestartMilliseconds -or $actions[1].DelayMs -ne $c.FailureRestartMilliseconds) { $reasons.Add('failure_restart_delay_differs') }
  if (@($actions | Select-Object -Skip 2 | Where-Object { $_.Type -ne 0 }).Count -gt 0) { $reasons.Add('failure_action_not_restart') }   # a third restart, a reboot or a command
  if (@($actions | Where-Object { $_.Type -eq 2 -or $_.Type -eq 3 }).Count -gt 0 -and -not ($reasons -contains 'failure_action_not_restart')) { $reasons.Add('failure_action_not_restart') }
  if ($parsed.ResetSeconds -ne $c.FailureResetSeconds) { $reasons.Add('failure_reset_period_differs') }
  , @($reasons)
}

# Which SID type install gives a service: restricted for both, EXCEPT the Broker of an install whose record says the Hyper-V grant was made (ADR-002 Amendment 2026-11-03: Hyper-V refuses a restricted
# token even for a member of Hyper-V Administrators, so the Broker is unrestricted exactly when it is in that group). The Authority is restricted in every case.
function Get-ExpectedSidType([string]$ServiceName, [bool]$HyperVGrantRecorded) {
  $c = Get-HostConstants
  if ($HyperVGrantRecorded -and $ServiceName -ceq $c.BrokerService) { return 'unrestricted' }
  'restricted'
}

# Facts read from the machine: @{ Exists; StartName; PathName; StartMode; ServiceType; SidTypeText (sc qsidtype); PrivilegesText (sc qprivs) }. Returns the differences from what install makes.
# $ExpectedSidType comes from Get-ExpectedSidType; the default is the install without the grant.
function Test-ServiceFacts($Facts, [string]$Name, [string]$ExpectedPathName, [ValidateSet('restricted', 'unrestricted')][string]$ExpectedSidType = 'restricted', [bool]$ExpectRestartOnFailure = $false) {
  $reasons = New-Object System.Collections.Generic.List[string]
  if (-not $Facts.Exists) { $reasons.Add('service_missing'); return , @($reasons) }
  if ($Facts.StartName -ne ('NT SERVICE\' + $Name)) { $reasons.Add('start_name_differs') }
  if ($Facts.PathName -cne $ExpectedPathName) { $reasons.Add('path_differs') }
  # start= delayed-auto: Win32_Service says StartMode Auto and DelayedAutoStart true
  if ($Facts.StartMode -ne 'Auto') { $reasons.Add('start_mode_not_auto') }
  elseif ($Facts.DelayedAutoStart -ne $true) { $reasons.Add('start_not_delayed') }
  if ($ExpectRestartOnFailure) { foreach ($r in (Test-ServiceFailureBytes $Facts.FailureActions)) { $reasons.Add($r) } }
  if ($Facts.ServiceType -ne 'Own Process') { $reasons.Add('not_own_process') }
  # RESTRICTED but not UNRESTRICTED, which contains the word
  if ($ExpectedSidType -ceq 'unrestricted') {
    if ($Facts.SidTypeText -cnotmatch '(?<![A-Za-z])UNRESTRICTED') { $reasons.Add('sid_type_not_unrestricted') }
  }
  elseif ($Facts.SidTypeText -cnotmatch '(?<![A-Za-z])RESTRICTED') { $reasons.Add('sid_type_not_restricted') }
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
function Get-UnknownEntries([string[]]$RelativePaths, [string[]]$KnownFiles, [string[]]$KnownFolders, [string[]]$WorkFolders = @()) {
  $known = @($KnownFiles | ForEach-Object { $_.ToLowerInvariant() }) + @($KnownFolders | ForEach-Object { $_.ToLowerInvariant() })
  $work = @($WorkFolders | ForEach-Object { $_.ToLowerInvariant() })
  # An EMPTY folder (a service that was never started has written nothing yet) gives $null here, and piping $null runs the filter once with $_ = $null: skip it, there is nothing to judge.
  # A work folder (Get-KnownDataWorkFolders) is known as a whole: the folder itself and anything below it.
  , @(@($RelativePaths) | Where-Object {
      if ($null -eq $_) { return $false }
      $lower = $_.ToLowerInvariant()
      if ($known -contains $lower) { return $false }
      foreach ($w in $work) { if ($lower -eq $w -or $lower.StartsWith($w + '\')) { return $false } }
      $true
    })
}

# ---------------------------------------------------------------------------------------------- trust: who may have written what the installer is about to rely on
# An attacker model for this section: an AI agent running as the owner's NON-admin session. It can create C:\ProgramData\Albera (Users may create folders there), make it or a
# child a junction, plant files in it, and rewrite files in the repository working tree. So nothing that already exists is trusted until it passes these checks.
$script:WriteRightsMask = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000   # WriteData AppendData DeleteChild Delete WriteDac WriteOwner GenericAll GenericWrite (as ServicePathGuard.cs)
$script:AdminSids = @('S-1-5-18', 'S-1-5-32-544')
function Get-AdminSids { , $script:AdminSids }
# Who may OWN a trusted object or hold a write right on it: SYSTEM, Administrators and NT SERVICE\TrustedInstaller (the owner of Program Files and of most of what Windows ships). The same set as
# FileSystemChecks.cs in setup. CREATOR OWNER (S-1-3-0) is not in it: an inherit-only ACE for it is a placeholder that turns into the creator's own rule and is skipped by Get-AclSummary; any other one counts.
$script:TrustedInstallerSid = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$script:TrustedSids = @('S-1-5-18', 'S-1-5-32-544', $script:TrustedInstallerSid)
function Get-TrustedSids { , $script:TrustedSids }

# $Summary = @{ Owner; Protected; WriteSids } (Get-AclSummary). Returns the reasons it is not trustworthy (empty = trusted).
function Test-TrustSummary($Summary, [string[]]$AllowedWriters, [bool]$RequireProtected, [string[]]$AllowedOwners = @()) {
  $reasons = New-Object System.Collections.Generic.List[string]
  # $AllowedOwners: owners besides SYSTEM, Administrators and TrustedInstaller. Only a file a SERVICE writes itself needs one (its own SID: the Authority's guard accepts that owner on the files it makes).
  if ((@($script:TrustedSids) + @($AllowedOwners)) -notcontains $Summary.Owner) { $reasons.Add('owner_untrusted') }
  if ($RequireProtected -and -not $Summary.Protected) { $reasons.Add('inheritance_not_removed') }
  $writers = @($script:TrustedSids) + @($AllowedWriters)
  foreach ($sid in @($Summary.WriteSids)) { if ($writers -notcontains $sid) { $reasons.Add('writer_untrusted:' + $sid) } }
  , @($reasons)
}
# Who may hold write rights on a planned folder: SYSTEM, Administrators and the plan's own Modify / Full-control accounts.
function Get-PlannedWriters($Entry) {
  $own = @($Entry.Grants | ForEach-Object { if ($_ -match '^\*(S-[0-9-]+):(?:\(OI\)\(CI\))?(?:M|F)$') { $Matches[1] } })
  , @($script:AdminSids + $own | Sort-Object -Unique)
}
# Read with .NET (a file or a folder, nothing followed by this call): the cmdlet Get-Acl costs several milliseconds per path and the adoption check reads every entry below bin\setup and setup-work.
function Get-AclSummary([string]$Path) {
  $acl = if ([System.IO.Directory]::Exists($Path)) { [System.IO.Directory]::GetAccessControl($Path) } else { [System.IO.File]::GetAccessControl($Path) }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' })
  # CREATOR OWNER (S-1-3-0) as an inherit-only rule is the placeholder every Program Files folder carries; it is not a principal that can write THIS object
  # The bare BUILTIN domain SID (S-1-5-32, shown by icacls as BUILTIN\BUILTIN) is the domain's own identifier, not a group: no logon token holds it, so a rule for it lets nobody write. The Node.js
  # installer leaves such a full-control rule on C:\Program Files\nodejs (seen on the owner's PC, 2026-11-04), which made the node.exe source check refuse a folder nobody can actually write.
  $isPlaceholder = { param($rule) (($rule.IdentityReference.Value -eq 'S-1-3-0') -and (([int]$rule.PropagationFlags -band [int][System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)) -or ($rule.IdentityReference.Value -eq 'S-1-5-32') }
  [pscustomobject]@{
    Owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    Protected = $acl.AreAccessRulesProtected
    AllowSids = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
    WriteSids = @($rules | Where-Object { (([int]$_.FileSystemRights -band $script:WriteRightsMask) -ne 0) -and -not (& $isPlaceholder $_) } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
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
    if ($g -cnotmatch '^\*(S-[0-9-]+):(\(OI\)\(CI\))?(F|RX|R|M)$') { throw 'grant_not_understood' }
    $rights = switch ($Matches[3]) { 'F' { [System.Security.AccessControl.FileSystemRights]::FullControl } 'RX' { [System.Security.AccessControl.FileSystemRights]::ReadAndExecute } 'R' { [System.Security.AccessControl.FileSystemRights]::Read } 'M' { [System.Security.AccessControl.FileSystemRights]::Modify } }
    $inherit = if ($Matches[2]) { [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [System.Security.AccessControl.InheritanceFlags]::None }
    New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($Matches[1])), $rights, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  }
  , @($rules)
}
# Create a folder that is born with its final security descriptor (owner, protected DACL): there is no moment at which it carries an inherited ACL. Refuses an existing path.
# DirectoryInfo.Create succeeds silently on .NET Framework when the folder already exists (made by someone between the check and the call), keeping ITS owner and ACL: so what was created is always read back
# (owner, protected, exactly the requested accounts, no link) and anything else throws. Invoke-SecuredCreate is the part after the existence check, so the race can be tested.
function New-SecuredDirectory([string]$Path, [string[]]$Grants, [string]$OwnerSid = 'S-1-5-32-544') {
  if ([System.IO.File]::Exists($Path) -or [System.IO.Directory]::Exists($Path)) { throw 'directory_already_exists' }
  Invoke-SecuredCreate $Path $Grants $OwnerSid
}
function Invoke-SecuredCreate([string]$Path, [string[]]$Grants, [string]$OwnerSid = 'S-1-5-32-544') {
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  $security.SetOwner((New-Object System.Security.Principal.SecurityIdentifier($OwnerSid)))
  foreach ($rule in (ConvertTo-FileSystemRules $Grants)) { $security.AddAccessRule($rule) }
  (New-Object System.IO.DirectoryInfo($Path)).Create($security)
  $wrong = New-Object System.Collections.Generic.List[string]
  if ((Get-ReparseChain $Path).Count -gt 0) { $wrong.Add('reparse_point') }
  else {
    $summary = Get-AclSummary $Path
    if ($summary.Owner -ne $OwnerSid) { $wrong.Add('owner') }
    if (-not $summary.Protected) { $wrong.Add('not_protected') }
    $want = @(Get-GrantedSids ([pscustomobject]@{ Grants = $Grants }) | Sort-Object -Unique)
    if ((@($summary.AllowSids | Sort-Object -Unique) -join ',') -ne ($want -join ',')) { $wrong.Add('accounts') }
  }
  if ($wrong.Count -gt 0) { throw ('created_directory_not_as_requested:' + ($wrong -join ',')) }
}

# ---------------------------------------------------------------------------------------------- the one value the owner types (or setup passes): the tree hash of the five builds
# -ExpectedTreeHash is ONE SHA-256 that the owner copies from the CI log of the reviewed commit (the line ALBERA_HOST_TREE_HASH=<hex> of `albera-host.ps1 -Mode hashes`). It is a parameter, not a file: a file
# in Downloads can be rewritten together with the builds by a non-admin. The same function makes the value for -Mode hashes (CI) and for install (the COPIES in the administrator-only bin folder), so the
# two cannot drift.
# Canonical listing: for each component in the fixed order broker, authority, pipe-client, control-plane, approver, and inside it for each published file sorted by ordinal comparison of its relative path (written with '/'),
# one line   <component>/<relative path> TAB <SHA-256 of the file, 64 lowercase hex> LF   (LF = 0x0A, TAB = 0x09, no other whitespace, no BOM). The tree hash is the lowercase-hex SHA-256 of the UTF-8
# bytes of all lines concatenated. A file moved to another component, renamed, added, dropped or changed changes it. (control-plane is the host publish folder WITH its app\ tree; the pinned node\ that
# install adds beside them is not part of it. The order is the one of SetupLayout.Components in src/runtime/windows-setup, which a test compares.)
$script:HashComponents = @('broker', 'authority', 'pipe-client', 'control-plane', 'approver')
function Test-TreeHashValue([string]$Value) { ($null -ne $Value) -and ($Value -cmatch '^[0-9a-f]{64}$') }
function Get-CanonicalTreeHash($Components) {
  $builder = New-Object System.Text.StringBuilder
  if (@($Components.Keys).Count -ne $script:HashComponents.Count) { throw 'tree_hash_components' }
  foreach ($name in $script:HashComponents) {
    if (@($Components.Keys) -cnotcontains $name) { throw 'tree_hash_components' }
    $files = $Components[$name]
    if (@($files.Keys).Count -eq 0) { throw "tree_hash_empty:$name" }
    $byRel = @{}
    foreach ($k in $files.Keys) {
      $rel = ([string]$k).Replace('\', '/')
      if ($rel.Length -eq 0 -or $rel.StartsWith('/') -or $rel.Contains('..') -or $rel.Contains(':') -or $rel.Contains("`t") -or $rel.Contains("`n") -or $byRel.ContainsKey($rel)) { throw "tree_hash_path:$name" }
      if (-not (Test-TreeHashValue $files[$k])) { throw "tree_hash_value:$name" }
      $byRel[$rel] = $files[$k]
    }
    $rels = New-Object 'System.Collections.Generic.List[string]'
    foreach ($rel in $byRel.Keys) { $rels.Add($rel) }
    $rels.Sort([System.StringComparer]::Ordinal)
    foreach ($rel in $rels) { [void]$builder.Append($name).Append('/').Append($rel).Append("`t").Append($byRel[$rel]).Append("`n") }
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($builder.ToString()))) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}

# ---------------------------------------------------------------------------------------------- the fixed system folders (no environment variable decides a path)
# HKCU\Environment can set SystemRoot / ProgramFiles / ProgramData for a user's processes, and an elevated console started from that session inherits them. So the script never reads those variables:
# it asks Windows ([Environment]::SystemDirectory / GetFolderPath) and refuses anything but the standard places. Returns the differences (empty = standard).
function Test-FixedFolders([string]$SystemDirectory, [string]$ProgramFiles, [string]$ProgramData) {
  $reasons = New-Object System.Collections.Generic.List[string]
  if ([string]::IsNullOrEmpty($SystemDirectory) -or -not [string]::Equals($SystemDirectory.TrimEnd('\'), 'C:\Windows\System32', [System.StringComparison]::OrdinalIgnoreCase)) { $reasons.Add('system_directory_not_C:\Windows\System32') }
  if ([string]::IsNullOrEmpty($ProgramFiles) -or -not [string]::Equals($ProgramFiles.TrimEnd('\'), 'C:\Program Files', [System.StringComparison]::OrdinalIgnoreCase)) { $reasons.Add('program_files_not_C:\Program Files') }
  if ([string]::IsNullOrEmpty($ProgramData) -or -not [string]::Equals($ProgramData.TrimEnd('\'), 'C:\ProgramData', [System.StringComparison]::OrdinalIgnoreCase)) { $reasons.Add('program_data_not_C:\ProgramData') }
  , @($reasons)
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
  foreach ($k in $created.Keys) { if (@('dataRoot', 'installRoot', 'services', 'binaries', 'user', 'key', 'hyperVGrant', 'controlPlane', 'claude', 'launcher', 'shortcuts', 'runEntry', 'wsl2') -cnotcontains $k) { $reasons.Add('created_key:' + $k) } }
  foreach ($k in $values.Keys) { if (@('authoritySpki', 'controlPlaneSid', 'approverSid', 'approverKeyId', 'approverKeys', 'approverKeysSetAt', 'brokerServiceSid', 'authorityServiceSid', 'attestationSpki') -cnotcontains $k) { $reasons.Add('values_key:' + $k) } }
  # The approver key list the install (or set-approver) recorded: ids and kinds only, 1 to 16, in the contract's form. approverKeysSetAt is the UTC time set-approver last changed it.
  if ((Test-HasKey $values 'approverKeys') -and -not (Test-ApproverKeysManifestList $values['approverKeys'])) { $reasons.Add('approver_keys_record') }
  if ((Test-HasKey $values 'approverKeysSetAt') -and ($values['approverKeysSetAt'] -isnot [string] -or $values['approverKeysSetAt'] -cnotmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\z')) { $reasons.Add('approver_keys_set_at') }
  foreach ($k in $M.Keys) { if (@('schema', 'tool', 'state', 'startedAt', 'updatedAt', 'created', 'values', 'setupRunId') -cnotcontains $k) { $reasons.Add('manifest_key:' + $k) } }
  if ((Test-HasKey $M 'setupRunId') -and $null -eq (ConvertTo-SetupRunId $M['setupRunId'])) { $reasons.Add('setup_run_id') }
  if ((Test-HasKey $created 'services')) { foreach ($n in @($created['services'])) { if (@($c.BrokerService, $c.AuthorityService, $c.ControlPlaneService) -cnotcontains $n) { $reasons.Add('service_name_not_fixed') } } }
  # The records of the Control Plane install can name nothing but the fixed service SID, a hash and the fixed shortcut / Run names: a forged one cannot make uninstall delete another file or value.
  if ((Test-HasKey $created 'controlPlane') -and (-not (Test-ControlPlaneRecord $created['controlPlane']))) { $reasons.Add('control_plane_record') }
  if ((Test-HasKey $created 'claude') -and (-not (Test-ClaudeRecord $created['claude']))) { $reasons.Add('claude_record') }
  if ((Test-HasKey $created 'launcher') -and (-not (Test-LauncherRecord $created['launcher']))) { $reasons.Add('launcher_record') }
  if ((Test-HasKey $created 'shortcuts')) { foreach ($n in @($created['shortcuts'])) { if (@($c.OpenShortcut, $c.UpdateShortcut) -cnotcontains $n) { $reasons.Add('shortcut_name_not_fixed') } } }
  if ((Test-HasKey $created 'runEntry') -and (-not (Test-RunEntryRecord $created['runEntry']))) { $reasons.Add('run_entry_record') }
  if ((Test-HasKey $created 'user') -and $null -ne $created['user']) {
    $u = $created['user']
    if ($u -isnot [System.Collections.IDictionary] -or $u['name'] -cne $c.ControlPlaneUser -or -not (Test-AccountSidShape $u['sid'])) { $reasons.Add('user_record') }
  }
  if ((Test-HasKey $created 'key') -and $null -ne $created['key']) {
    if ($created['key'] -isnot [System.Collections.IDictionary] -or $created['key']['name'] -cne $c.SigningKeyName) { $reasons.Add('key_record') }
  }
  # The grant record can name nothing but the fixed group and the Broker's own derived service SID: a forged record cannot make uninstall remove another account from Hyper-V Administrators.
  if ((Test-HasKey $created 'hyperVGrant') -and (-not (Test-HyperVGrantRecord $created['hyperVGrant']))) { $reasons.Add('hyperv_grant_record') }
  if ((Test-HasKey $created 'binaries') -and $created['binaries'] -is [System.Collections.IDictionary]) {
    foreach ($k in $created['binaries'].Keys) { if ($script:HashComponents -cnotcontains $k) { $reasons.Add('binary_name:' + $k) } }
  }
  if ((Test-HasKey $values 'authoritySpki') -and -not (Test-P256Spki $values['authoritySpki'])) { $reasons.Add('authority_spki') }
  if ((Test-HasKey $values 'attestationSpki') -and -not (Test-P256Spki $values['attestationSpki'])) { $reasons.Add('attestation_spki') }
  if ((Test-HasKey $created 'wsl2') -and -not (Test-Wsl2Record $created['wsl2'])) { $reasons.Add('wsl2_record') }
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

# ---------------------------------------------------------------------------------------------- the Hyper-V grant (-GrantHyperVToBroker; ADR-002 Amendment 2026-11-03)
# What the owner decided: the Broker's service SID, and ONLY that, goes into BUILTIN\Hyper-V Administrators (S-1-5-32-578), and the Broker is then sidtype unrestricted. The Control Plane account
# (albera-cp) is never a member. Everything that adds or removes a member takes its SID from Get-HyperVGrantPlan, which has no parameter for "who": a test pins that no other path exists.
# $Sids = @{ Broker; Authority; ControlPlane } (SID strings; ControlPlane may be $null before the account exists). Returns @{ Group; Member }.
function Get-HyperVGrantPlan($Sids) {
  $c = Get-HostConstants
  $broker = [string]$Sids.Broker
  if (-not (Test-ServiceSidShape $broker) -or $broker -cne (Get-DerivedServiceSid $c.BrokerService)) { throw 'hyperv_grant_member_not_the_broker_service_sid' }
  if ($broker -ceq [string]$Sids.ControlPlane -or $broker -ceq [string]$Sids.Authority) { throw 'hyperv_grant_member_not_the_broker_service_sid' }
  [pscustomobject]@{ Group = $c.HyperVAdminsSid; Member = $broker }
}
# A group member's WinNT path as ADSI reports it -> @{ Sid; Account }, or $null when it is neither shape. `WinNT://S-1-5-...` is how an entry that cannot be named shows up; `WinNT://NT SERVICE/Name`
# (or `WinNT://./Name`) is a named account. Used only as the fallback of Get-LocalGroupMemberSids, for members (such as a service's virtual account) that have no objectSid property to read.
function ConvertFrom-WinNTMemberPath([string]$Path) {
  if ($Path -cmatch '^WinNT://(S-1-[0-9]+(?:-[0-9]+)+)$') { return [pscustomobject]@{ Sid = $Matches[1]; Account = $null } }
  if ($Path -cmatch '^WinNT://(?:[^/]+/)*([^/\\]+)/([^/\\]+)$') { return [pscustomobject]@{ Sid = $null; Account = ($Matches[1] + '\' + $Matches[2]) } }
  $null
}
# The install record `created.hyperVGrant`: the group, the Broker's SID, and what the Broker config was told (computerId, VM GUID). Anything else is not a record this script wrote.
function Test-HyperVGrantRecord($Record) {
  $c = Get-HostConstants
  if ($Record -isnot [System.Collections.IDictionary]) { return $false }
  $keys = @($Record.Keys)
  if ($keys.Count -ne 4 -or @(@('group', 'sid', 'computerId', 'vmId') | Where-Object { $keys -ccontains $_ }).Count -ne 4) { return $false }
  ($Record['group'] -ceq $c.HyperVAdminsSid) -and ($Record['sid'] -ceq (Get-DerivedServiceSid $c.BrokerService)) -and (Test-HostId $Record['computerId']) -and (Test-VmGuid $Record['vmId'])
}
# Members of Hyper-V Administrators as read from the machine (SID strings) -> the reasons it is not what the install record says (empty = fine). albera-cp and the Authority must NEVER be in, record or no
# record. The Broker must be in exactly when the record says the grant was made ($BrokerRecorded); a Broker in the group WITHOUT a record is somebody else's change and is reported.
function Test-HyperVMembers([string[]]$MemberSids, $Sids, [bool]$BrokerRecorded = $true) {
  $reasons = New-Object System.Collections.Generic.List[string]
  $brokerIn = @($MemberSids) -ccontains [string]$Sids.Broker
  if ($BrokerRecorded -and -not $brokerIn) { $reasons.Add('broker_not_a_member') }
  if (-not $BrokerRecorded -and $brokerIn) { $reasons.Add('broker_is_a_member_without_a_record') }
  if ($Sids.ControlPlane -and @($MemberSids) -ccontains [string]$Sids.ControlPlane) { $reasons.Add('control_plane_is_a_member') }
  if (@($MemberSids) -ccontains [string]$Sids.Authority) { $reasons.Add('authority_is_a_member') }
  , @($reasons)
}
# The VM the owner named -> its GUID. $Candidates are the Msvm_ComputerSystem objects (Name, ElementName) the name query returned; the host itself (Name = the computer name) is no GUID and is skipped.
# The display name is only used HERE, once, at install time; the Broker is told the GUID and queries by Name, never by ElementName (a name another group member could reuse).
# Returns @{ Ok; VmId; Reason } with a fixed reason word: vm_not_found, vm_name_ambiguous.
function Select-VmByName($Candidates, [string]$VmName) {
  $hits = @(@($Candidates) | Where-Object { $null -ne $_ -and [string]$_.ElementName -ieq $VmName -and ([string]$_.Name).ToLowerInvariant() -cmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z' })
  if ($hits.Count -eq 0) { return [pscustomobject]@{ Ok = $false; VmId = $null; Reason = 'vm_not_found' } }
  if ($hits.Count -gt 1) { return [pscustomobject]@{ Ok = $false; VmId = $null; Reason = 'vm_name_ambiguous' } }
  $id = ([string]$hits[0].Name).ToLowerInvariant()
  if (-not (Test-VmGuid $id)) { return [pscustomobject]@{ Ok = $false; VmId = $null; Reason = 'vm_not_found' } }
  [pscustomobject]@{ Ok = $true; VmId = $id; Reason = '' }
}
# -VmId (a fixed GUID instead of the lookup) exists for the disposable lab VM only, like -NodeSource and -ClaudeSource. Returns the refusal word, or $null when allowed.
function Test-LabVmIdGate([bool]$VmIdSupplied, [string]$LabEnvironment) {
  if ($VmIdSupplied -and $LabEnvironment -ne '1') { return 'vm_id_parameter_is_lab_only' }
  $null
}
# -LabAssumeYes (set-approver: the flag stands in for the "yes" a person types in the elevated console) exists for the disposable lab VM only, like -NodeSource, -ClaudeSource and -VmId, so the lab hook can run with
# no console to type in. Returns the refusal word, or $null when allowed.
function Test-LabConfirmGate([bool]$AssumeYesSupplied, [string]$LabEnvironment) {
  if ($AssumeYesSupplied -and $LabEnvironment -ne '1') { return 'assume_yes_parameter_is_lab_only' }
  $null
}
# What a person has to type before set-approver writes anything: the word yes, nothing else (surrounding blanks are ignored; capitals, "y", an empty line and anything longer are not a yes).
function Test-ConfirmationAnswer($Answer) {
  if ($null -eq $Answer) { return $false }
  ([string]$Answer).Trim() -ceq 'yes'
}
# Two byte arrays are the same bytes (a key store is put back "exactly as it was found": the proof is this, not a look at the keys in it).
function Test-BytesEqual([byte[]]$A, [byte[]]$B) {
  if ($null -eq $A -or $null -eq $B) { return ($null -eq $A -and $null -eq $B) }
  if ($A.Length -ne $B.Length) { return $false }
  for ($i = 0; $i -lt $A.Length; $i++) { if ($A[$i] -ne $B[$i]) { return $false } }
  $true
}

# ---------------------------------------------------------------------------------------------- the lab-only source gate
# -NodeSource and -ClaudeSource (a node.exe / claude.exe somewhere else than the places install looks in) are accepted ONLY in the disposable lab VM, which announces itself with ALBERA_LAB_VM=1.
# The lab guest has no Claude Code of the owner's. Returns the refusal word, or $null when allowed.
function Test-LabSourceGate([bool]$SourceSupplied, [string]$LabEnvironment) {
  if ($SourceSupplied -and $LabEnvironment -ne '1') { return 'binary_source_parameter_is_lab_only' }
  $null
}

# ---------------------------------------------------------------------------------------------- the Control Plane install records and the setup run id
# The run id of the attested workflow run that built what setup verified (setup passes it as -SetupRunId; the C# side compares it with the record before it starts this script). It is a decimal ulong,
# kept in the manifest as a STRING (a JSON number would lose digits in a parser that reads doubles). $null for anything else.
function ConvertTo-SetupRunId($Value) {
  if ($null -eq $Value) { return $null }
  $text = [string]$Value
  if ($text -cnotmatch '^[0-9]{1,20}$') { return $null }
  $id = [uint64]0
  if (-not [uint64]::TryParse($text, [System.Globalization.NumberStyles]::None, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$id)) { return $null }
  $id
}
# Anti-rollback: an older run than the larger of the install record's `setupRunId` and the FLOOR is refused; the same run is fine (a half-finished install is finished by the same build). Returns the refusal word
# or $null. The floor lives outside everything uninstall removes (HKLM\SOFTWARE\Albera\SetupRunIdFloor, REG_SZ, decimal), so uninstalling and installing an old build again does not get past it.
function Get-SetupRunIdRefusal($Recorded, $Supplied, $Floor = $null) {
  $r = ConvertTo-SetupRunId $Recorded
  $f = ConvertTo-SetupRunId $Floor
  $s = ConvertTo-SetupRunId $Supplied
  if ($null -eq $Supplied -or $Supplied -eq '') { return $null }
  if ($null -eq $s) { return 'setup_run_id_invalid' }
  if ($null -ne $Recorded -and $null -eq $r) { return 'recorded_setup_run_id_invalid' }
  if ($null -ne $Floor -and $null -eq $f) { return 'setup_run_id_floor_invalid' }   # an empty value is not "no floor" (setup refuses it as well)
  if ($null -ne $r -and $s -lt $r) { return 'setup_run_id_older_than_installed' }
  if ($null -ne $f -and $s -lt $f) { return 'setup_run_id_older_than_floor' }
  $null
}

function Test-ControlPlaneRecord($Record) {
  $c = Get-HostConstants
  if ($Record -isnot [System.Collections.IDictionary]) { return $false }
  $keys = @($Record.Keys)
  if ($keys.Count -ne 3 -or @(@('serviceSid', 'nodeSha256', 'nodeSource') | Where-Object { $keys -ccontains $_ }).Count -ne 3) { return $false }
  ($Record['serviceSid'] -ceq (Get-DerivedServiceSid $c.ControlPlaneService)) -and (Test-TreeHashValue $Record['nodeSha256']) -and ($Record['nodeSource'] -is [string]) -and ($Record['nodeSource'].Length -le 260)
}
function Test-ClaudeRecord($Record) {
  if ($Record -isnot [System.Collections.IDictionary]) { return $false }
  $keys = @($Record.Keys)
  if ($keys.Count -ne 3 -or @(@('sha256', 'fileVersion', 'source') | Where-Object { $keys -ccontains $_ }).Count -ne 3) { return $false }
  (Test-TreeHashValue $Record['sha256']) -and ($Record['fileVersion'] -is [string]) -and ($Record['fileVersion'].Length -le 64) -and ($Record['source'] -is [string]) -and ($Record['source'].Length -le 260)
}
function Test-LauncherRecord($Record) {
  if ($Record -isnot [System.Collections.IDictionary]) { return $false }
  $keys = @($Record.Keys)
  ($keys.Count -eq 1) -and ($keys -ccontains 'sha256') -and (Test-TreeHashValue $Record['sha256'])
}
function Test-RunEntryRecord($Record) {
  $c = Get-HostConstants
  if ($Record -isnot [System.Collections.IDictionary]) { return $false }
  $keys = @($Record.Keys)
  ($keys.Count -eq 2) -and ($keys -ccontains 'name') -and ($keys -ccontains 'command') -and ($Record['name'] -ceq $c.RunValueName) -and ($Record['command'] -is [string]) -and ($Record['command'].Length -le 300)
}

# ---------------------------------------------------------------------------------------------- the pinned programs, the launcher, the shortcuts and the tray entry
# node.exe comes from the one place the Node installer puts it (no environment variable and no PATH lookup decide it). Claude Code comes from the owner's own profile, found from the owner's SID (the record
# of the profile list), never from an environment variable: `<profile>\.local\bin\claude.exe` (the place Claude Code's own installer uses). $ProfileImagePath is what Windows records for that SID.
function Get-NodeSourcePath([string]$ProgramFiles) { Join-Path $ProgramFiles 'nodejs\node.exe' }
function Get-ClaudeSourcePath([string]$ProfileImagePath) {
  if (-not (Test-PlainAbsolutePath $ProfileImagePath)) { return $null }
  Join-Path $ProfileImagePath '.local\bin\claude.exe'
}
# The elevated token must be the owner's: the copy of the owner's claude.exe is made only when the account that said yes to UAC is the account whose profile holds it (control-plane-service.md section 8).
function Get-ClaudePinRefusal([string]$ElevatedSid, [string]$ApproverSid) {
  if (-not (Test-AccountSidShape $ElevatedSid)) { return 'elevated_sid_is_not_a_user_account' }
  if ($ElevatedSid -cne $ApproverSid) { return 'elevated_account_is_not_the_approver' }
  $null
}

# What the Start menu "Open ALBERA" shortcut runs, as the owner (a normal, non-elevated session). It reads ui\room.json, requires the service to be RUNNING and the port to be held by the process the file names,
# then opens the browser at http://127.0.0.1:<port>/room/#b=<code> (the fragment is never sent to the server). Every value it reads is checked against a fixed grammar before it is used. ASCII only.
# The text is made here, written by install into the administrator-only bin\launcher folder and hashed into the install record: it is never taken from anywhere else.
function Get-OpenAlberaScriptText($Layout) {
  $c = Get-HostConstants
  $room = Join-Path $Layout.UiDir 'room.json'
  $text = @'
# open-albera.ps1 - made by albera-host.ps1 for the Start menu shortcut "Open ALBERA"; do not edit (the install record holds its hash). ASCII only.
$ErrorActionPreference = 'Stop'
function Stop-Here([string]$Why) { Write-Host ('ALBERA: ' + $Why); [void](Read-Host 'Press Enter to close'); exit 1 }
$serviceName = '@@SERVICE@@'
$roomFile = '@@ROOM@@'
try {
  $service = Get-Service -Name $serviceName
  if ($service.Status -ne 'Running') { Stop-Here ('the service ' + $serviceName + ' is ' + $service.Status + '. Start it (or restart the PC; it starts by itself) and try again.') }
  $room = [System.IO.File]::ReadAllText($roomFile) | ConvertFrom-Json
  $portOk = ($room.port -is [int]) -and ($room.port -ge 1024) -and ($room.port -le 65535)
  $pidOk = ($room.pid -is [int]) -and ($room.pid -gt 0)
  $codeOk = ($room.code -is [string]) -and ($room.code -cmatch '^[A-Za-z0-9_-]{16,128}$')
  if (-not ($portOk -and $pidOk -and $codeOk)) { Stop-Here 'ui\room.json is not in the expected form.' }
  # A listening socket is the one with remote port 0. Not -State Listen: Windows 11 build 26300 reports most listening sockets with state 0, so that filter finds none (measured 2026-11-04).
  $held = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $room.port -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $room.pid -and $_.RemotePort -eq 0 })
  if ($held.Count -eq 0) { Stop-Here 'the port named in ui\room.json is not held by the ALBERA process. Wait a few seconds and try again.' }
  Start-Process ('http://127.0.0.1:' + $room.port + '/room/#b=' + $room.code)
}
catch { Stop-Here ('could not open the room: ' + $_.Exception.Message) }
'@
  ($text.Replace('@@SERVICE@@', $c.ControlPlaneService).Replace('@@ROOM@@', $room) -replace "`r?`n", "`r`n")
}
# The two shortcuts. "Open ALBERA" runs Windows PowerShell by its full path on the launcher script; "ALBERA update" runs albera-setup.exe (its manifest asks for UAC). The update shortcut is made only when
# setup is installed where setup demands (the owner put it there; this script never copies setup). Each spec: Path, Target, Arguments, WorkingDirectory, Description.
function Get-ShortcutSpecs($Layout, [string]$SystemDirectory, [bool]$SetupInstalled) {
  $specs = New-Object System.Collections.Generic.List[object]
  $specs.Add([pscustomobject]@{ Path = $Layout.OpenShortcut; Target = (Join-Path $SystemDirectory 'WindowsPowerShell\v1.0\powershell.exe'); Arguments = ('-NoProfile -ExecutionPolicy Bypass -File "' + $Layout.OpenScript + '"'); WorkingDirectory = $Layout.LauncherDir; Description = 'Open the ALBERA room in your browser' })
  if ($SetupInstalled) { $specs.Add([pscustomobject]@{ Path = $Layout.UpdateShortcut; Target = $Layout.SetupExe; Arguments = ''; WorkingDirectory = (Split-Path -Parent $Layout.SetupExe); Description = 'Update ALBERA (asks for administrator rights)' }) }
  , $specs.ToArray()
}
# $Read = what the shell link says now (TargetPath, Arguments, WorkingDirectory). Returns the differences from the spec (empty = as intended); compared case-insensitively for paths (Windows), exactly for arguments.
function Test-ShortcutMatches($Spec, $Read) {
  $reasons = New-Object System.Collections.Generic.List[string]
  if ($null -eq $Read) { $reasons.Add('shortcut_missing'); return , @($reasons) }
  if (-not [string]::Equals([string]$Read.TargetPath, [string]$Spec.Target, [System.StringComparison]::OrdinalIgnoreCase)) { $reasons.Add('shortcut_target_differs') }
  if ([string]$Read.Arguments -cne [string]$Spec.Arguments) { $reasons.Add('shortcut_arguments_differ') }
  if (-not [string]::Equals([string]$Read.WorkingDirectory, [string]$Spec.WorkingDirectory, [System.StringComparison]::OrdinalIgnoreCase)) { $reasons.Add('shortcut_working_directory_differs') }
  , @($reasons)
}
# The tray of the approver, started in the owner's session at sign-in from HKLM Run (control-plane-service.md section 7). The tray itself exits quietly for any account that is not approverSid.
function Get-RunEntry($Layout) {
  $c = Get-HostConstants
  [pscustomobject]@{ KeyPath = $c.RunKeyPath; Name = $c.RunValueName; Command = ('"' + $Layout.ApproverExe + '" --tray') }
}

# ---------------------------------------------------------------------------------------------- migration from the first layout (-Mode migrate; control-plane-service.md section 9)
# Pure: the legacy manifest (parsed), the Broker config text, the Authority config text and the old Control Plane settings text in; the values the new install carries over, or the reasons it cannot. Nothing is read from
# the machine here. A legacy install is one whose record has the local account `albera-cp`. What is carried over: the Hello public values (the key id, the SPKI and the SID are in the Authority config), the VM GUID and
# the computer id (the record of the Hyper-V grant), the project id and the VM name (the old settings). A record that is not complete, or configs that do not agree with it, are refused.
function ConvertFrom-LegacyInstall($Manifest, [string]$BrokerJson, [string]$AuthorityJson, [string]$SettingsJson) {
  $reasons = New-Object System.Collections.Generic.List[string]
  $fail = { param($w) $reasons.Add($w); [pscustomobject]@{ Ok = $false; Reasons = @($reasons); Values = $null } }
  if ($Manifest -isnot [System.Collections.IDictionary] -or $Manifest['state'] -cne 'complete') { return (& $fail 'legacy_install_not_complete') }
  $created = $Manifest['created']
  if (-not (Test-HasKey $created 'user') -or $null -eq $created['user']) { return (& $fail 'not_a_legacy_install') }
  if ((Test-HasKey $created 'controlPlane') -and $null -ne $created['controlPlane']) { return (& $fail 'already_the_new_layout') }
  if ($reasons.Count -eq 0) { foreach ($w in (Test-AuthorityConfigText $AuthorityJson)) { $reasons.Add('authority_config:' + $w) } }
  if ($reasons.Count -eq 0) { foreach ($w in (Test-BrokerConfigText $BrokerJson)) { $reasons.Add('broker_config:' + $w) } }
  if ($reasons.Count -gt 0) { return [pscustomobject]@{ Ok = $false; Reasons = @($reasons); Values = $null } }
  $authority = $AuthorityJson | ConvertFrom-Json
  try { $settings = $SettingsJson | ConvertFrom-Json } catch { return (& $fail 'settings_syntax') }
  $names = @(if ($null -ne $settings -and $settings.computers -is [System.Management.Automation.PSCustomObject]) { Get-ObjectKeys $settings.computers })   # @( ) around the whole if: a one-name result would otherwise be a string, and $names[0] its first character
  if ($names.Count -ne 1 -or -not (Test-HostId ([string]$settings.projectId))) { return (& $fail 'settings_not_one_computer') }
  $vmName = $names[0]
  $computerId = [string]$settings.computers.$vmName
  if ($vmName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' -or -not (Test-HostId $computerId)) { return (& $fail 'settings_computer_invalid') }
  $grant = $null
  if ((Test-HasKey $created 'hyperVGrant') -and $null -ne $created['hyperVGrant']) {
    $g = $created['hyperVGrant']
    if (-not (Test-HyperVGrantRecord $g)) { return (& $fail 'grant_record_invalid') }
    if (-not (Test-BrokerConfigComputers $BrokerJson $g['computerId'] $g['vmId'])) { return (& $fail 'broker_config_disagrees_with_grant_record') }
    if ($g['computerId'] -cne $computerId) { return (& $fail 'grant_computer_differs_from_settings') }
    $grant = [pscustomobject]@{ ComputerId = $g['computerId']; VmId = $g['vmId'] }
  }
  [pscustomobject]@{
    Ok = $true; Reasons = @()
    Values = [pscustomobject]@{
      ApproverKeyId = [string]$authority.approverKeyId; ApproverPublicKey = [string]$authority.approverPublicKey; ApproverSid = [string]$authority.approverSid
      ProjectId = [string]$settings.projectId; VmName = $vmName; ComputerId = $computerId; Grant = $grant
      LegacySid = [string]$created['user']['sid']
    }
  }
}

# ---------------------------------------------------------------------------------------------- the WSL2 computer (-AddWsl2Computer; ADR-012 phase 5, ADR-002 Amendment 2026-11-04)
# One option adds: the Broker's CNG attestation key (the only place it is made), the three places that hold its public half (the Authority's pinned key, the bridge's brokerKeyId + brokerSpki and the Broker's
# `attestation`), the WSL bridge program (administrator-only folder), its config, its lease floor file, the `kind: wsl2` computer and the `wsl2` block of the approval settings. Everything below is PURE
# (values in, values out) unless it says otherwise. NOT RUN on a real PC.
function Get-Wsl2Constants {
  [ordered]@{
    DefaultComputerId = 'wsl-01'
    AttestationKeyName = 'AlberaHostBroker-attest-1'   # the CNG key name in the Broker config `attestation.keyName` (1..64 of letters, digits, . _ -)
    AttestationKeyId = 'albera-broker-attest-1'   # the id the run lease names its signer by: the Authority's attestationKeyId, the bridge's brokerKeyId, the Broker's attestation.keyId
    BridgePipeName = 'ALBERA_WslBridge'   # the settings' wsl2.pipeName grammar ([A-Za-z0-9_-]) is narrower than the bridge's: this name passes both
    RunValueName = 'AlberaWslBridge'
    ImageFileName = 'albera-wsl2.tar'
    DefaultGitPath = 'C:\Program Files\Git\mingw64\bin\git.exe'   # the real git.exe, not the cmd\git.exe launcher
    GitInstallDir = 'C:\Program Files\Git'   # room-approval-wiring.mjs GIT_INSTALL_DIR: the settings refuse a git outside it
    MinWslVersion = '2.4.0'   # the values the bridge's config comment gives (BridgeConfig.cs); the floor itself is the owner's to raise
    MinKernelVersion = '6.6.87'
    MaxRepositories = 8
    FirstStartWord = 'control_plane_is_self'   # what the bridge prints in a NORMAL console when its Control Plane SID is the account it runs as (BRIDGE_FATAL=<word>, exit 77)
  }
}
# Where the WSL2 parts go. Pure: derived from the host layout.
function Get-Wsl2Layout($Layout) {
  $c = Get-Wsl2Constants
  $data = Join-Path $Layout.DataRoot 'wsl-bridge'
  [ordered]@{
    BinDir = Join-Path $Layout.InstallRoot 'bin\wsl-bridge'
    BridgeExe = Join-Path $Layout.InstallRoot 'bin\wsl-bridge\albera-wsl-bridge.exe'
    DataDir = $data   # administrators write; the owner (the bridge's account) reads: config, floor file, image
    Config = Join-Path $data 'bridge.json'
    FirstCheckConfig = Join-Path $data 'first-check.json'   # made for the first-start check and deleted again
    FloorFile = Join-Path $data 'lease-floor'
    Image = Join-Path $data $c.ImageFileName
    StateDir = Join-Path $data 'state'   # the bridge writes here (owner Modify)
    DistributionsDir = Join-Path $data 'distributions'   # and here
  }
}
function Test-Wsl2GitPath([string]$Path) {
  $c = Get-Wsl2Constants
  if (-not (Test-PlainAbsolutePath $Path) -or -not $Path.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  $Path.StartsWith($c.GitInstallDir + '\', [System.StringComparison]::OrdinalIgnoreCase)
}
# $V = { ComputerId; RepositoryId; RepositoryPath; ImagePath; ImageSha256; BridgeTreeHash; FloorExpiresAt; GitPath }. $NowEpoch = seconds since 1970. $HyperVComputerId = the id the Hyper-V computer uses (one id once across both kinds).
# Returns the reason words (empty = every value has the shape the configs need). Does not look at the machine.
function Test-Wsl2Inputs($V, [long]$NowEpoch, [string]$HyperVComputerId) {
  $r = New-Object System.Collections.Generic.List[string]
  if (-not (Test-HostId $V.ComputerId)) { $r.Add('wsl2_computer_id') }
  if ($V.ComputerId -ceq $HyperVComputerId) { $r.Add('wsl2_computer_id_same_as_vm_computer') }
  if (-not (Test-HostId $V.RepositoryId)) { $r.Add('wsl2_repository_id') }
  if (-not (Test-PlainAbsolutePath $V.RepositoryPath)) { $r.Add('wsl2_repository_path') }
  if (-not (Test-PlainAbsolutePath $V.ImagePath)) { $r.Add('wsl2_image_path') }
  if (-not (Test-TreeHashValue $V.ImageSha256)) { $r.Add('wsl2_image_sha256') }
  if (-not (Test-TreeHashValue $V.BridgeTreeHash)) { $r.Add('wsl2_bridge_tree_hash') }
  if (-not (Test-Wsl2GitPath $V.GitPath)) { $r.Add('wsl2_git_path') }
  if ($V.FloorExpiresAt -le $NowEpoch -or $V.FloorExpiresAt -gt 9007199254740991) { $r.Add('wsl2_floor_expires_at') }   # the bridge refuses past it: a floor already expired would refuse every run
  , @($r)
}
# The tree hash of the bridge folder: the lines "<relative path with />\t<sha256>\n" of every file, sorted ordinal, hashed (what Get-TreeHashes computes for one folder). $Files = hashtable relative path -> sha256.
function Get-Wsl2BridgeTreeHash($Files) {
  $byRel = @{}
  foreach ($k in $Files.Keys) {
    $rel = ([string]$k).Replace('\', '/')
    if ($rel.Length -eq 0 -or $rel.StartsWith('/') -or $rel.Contains('..') -or $rel.Contains(':') -or $rel.Contains("`t") -or $rel.Contains("`n") -or $byRel.ContainsKey($rel)) { throw 'wsl2_tree_hash_path' }
    if (-not (Test-TreeHashValue $Files[$k])) { throw 'wsl2_tree_hash_value' }
    $byRel[$rel] = $Files[$k]
  }
  if ($byRel.Count -eq 0) { throw 'wsl2_tree_hash_empty' }
  $rels = New-Object 'System.Collections.Generic.List[string]'
  foreach ($rel in $byRel.Keys) { $rels.Add($rel) }
  $rels.Sort([System.StringComparer]::Ordinal)
  $builder = New-Object System.Text.StringBuilder
  foreach ($rel in $rels) { [void]$builder.Append($rel).Append("`t").Append($byRel[$rel]).Append("`n") }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($builder.ToString()))) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}
# The folders of the WSL2 part, each with its grants (the same shape as Get-AclPlan). $Sids.Approver is the owner (the bridge runs as that account): read on the folder (config, floor file and image inherit it:
# no service SID and nobody else reads the floor), Modify only on the two folders the bridge itself writes.
function Get-Wsl2AclPlan($W, $Sids) {
  if (-not $Sids.Approver) { throw 'wsl2_owner_sid_missing' }
  $full = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
  $o = $Sids.Approver
  @(
    [pscustomobject]@{ Path = $W.DataDir; Grants = @($full + @("*${o}:(OI)(CI)RX")) }
    [pscustomobject]@{ Path = $W.StateDir; Grants = @($full + @("*${o}:(OI)(CI)M")) }
    [pscustomobject]@{ Path = $W.DistributionsDir; Grants = @($full + @("*${o}:(OI)(CI)M")) }
  )
}
# The bridge's config: exactly the 15 keys of BridgeConfig.cs, in its order. $I = the inputs (ComputerId, RepositoryId, RepositoryPath, ImageSha256, GitPath, FloorExpiresAt).
function Get-Wsl2BridgeConfig($W, [string]$ControlPlaneSid, [string]$KeyId, [string]$Spki, $I) {
  $c = Get-Wsl2Constants
  [ordered]@{
    pipeName = $c.BridgePipeName
    controlPlaneSid = $ControlPlaneSid
    computerId = $I.ComputerId
    brokerKeyId = $KeyId
    brokerSpki = $Spki
    leaseFloorPath = $W.FloorFile
    imagePath = $W.Image
    imageSha256 = $I.ImageSha256
    distributionsFolder = $W.DistributionsDir
    stateFolder = $W.StateDir
    gitPath = $I.GitPath
    minWslVersion = $c.MinWslVersion
    minKernelVersion = $c.MinKernelVersion
    floorExpiresAt = [long]$I.FloorExpiresAt
    repositories = @([ordered]@{ repositoryId = $I.RepositoryId; path = $I.RepositoryPath })
  }
}
# Mirror of BridgeConfig.TryParse / Build (the fixed reason words are this script's own). Empty = the bridge would accept the shape; the paths, the image and the ACLs it also checks at start need the machine.
function Test-Wsl2BridgeConfigText([string]$Json) {
  $r = New-Object System.Collections.Generic.List[string]
  if ((Get-ByteLength $Json) -gt 8192) { $r.Add('config_too_large'); return , @($r) }
  try { $o = $Json | ConvertFrom-Json } catch { $r.Add('config_syntax'); return , @($r) }
  $keys = @('pipeName', 'controlPlaneSid', 'computerId', 'brokerKeyId', 'brokerSpki', 'leaseFloorPath', 'imagePath', 'imageSha256', 'distributionsFolder', 'stateFolder', 'gitPath', 'minWslVersion', 'minKernelVersion', 'floorExpiresAt', 'repositories')
  if ($o -isnot [System.Management.Automation.PSCustomObject] -or -not (Test-SameKeySet $o $keys)) { $r.Add('config_keys'); return , @($r) }
  $strings = @('pipeName', 'controlPlaneSid', 'computerId', 'brokerKeyId', 'brokerSpki', 'leaseFloorPath', 'imagePath', 'imageSha256', 'distributionsFolder', 'stateFolder', 'gitPath', 'minWslVersion', 'minKernelVersion')
  if (@($strings | Where-Object { $o.$_ -isnot [string] }).Count -gt 0) { $r.Add('config_keys'); return , @($r) }
  if (-not (Test-PlainPipeName $o.pipeName)) { $r.Add('pipe_name') }
  if (-not ((Test-AccountSidShape $o.controlPlaneSid) -or (Test-ServiceSidShape $o.controlPlaneSid))) { $r.Add('control_plane_sid') }
  if (-not (Test-HostId $o.computerId)) { $r.Add('computer_id') }
  if (-not (Test-HostId $o.brokerKeyId) -or -not (Test-P256Spki $o.brokerSpki)) { $r.Add('broker_key') }
  if (-not (Test-PlainAbsolutePath $o.leaseFloorPath)) { $r.Add('lease_floor_path') }
  if (-not (Test-PlainAbsolutePath $o.imagePath)) { $r.Add('image') }
  if (-not (Test-TreeHashValue $o.imageSha256)) { $r.Add('image_hash_format') }
  if (-not (Test-PlainAbsolutePath $o.distributionsFolder) -or -not (Test-PlainAbsolutePath $o.stateFolder)) { $r.Add('folder') }
  if (-not (Test-PlainAbsolutePath $o.gitPath)) { $r.Add('git_path') }
  $v = $null
  if (-not ([version]::TryParse($o.minWslVersion, [ref]$v) -and [version]::TryParse($o.minKernelVersion, [ref]$v) -and ($o.floorExpiresAt -is [int] -or $o.floorExpiresAt -is [long]) -and $o.floorExpiresAt -ge 1)) { $r.Add('floor') }
  $repos = @($o.repositories)
  $reposOk = ($o.repositories -is [System.Array]) -and ($repos.Count -ge 1) -and ($repos.Count -le 8)
  if ($reposOk) {
    foreach ($e in $repos) { if ($e -isnot [System.Management.Automation.PSCustomObject] -or -not (Test-SameKeySet $e @('repositoryId', 'path')) -or -not (Test-HostId $e.repositoryId) -or -not (Test-PlainAbsolutePath $e.path)) { $reposOk = $false } }
    if ($reposOk -and ((@($repos | ForEach-Object { $_.repositoryId } | Sort-Object -Unique).Count -ne $repos.Count) -or (@($repos | ForEach-Object { $_.path } | Sort-Object -Unique).Count -ne $repos.Count))) { $reposOk = $false }
  }
  if (-not $reposOk) { $r.Add('repositories') }
  , @($r)
}
# The lease floor file (LeaseFloor.cs): one number in ASCII, line ends after it. $Generation is the Broker config's `generation`: a lease the Broker signs at generation N is accepted at floor N.
function Get-Wsl2LeaseFloorText([long]$Generation) {
  if ($Generation -lt 1) { throw 'wsl2_generation_invalid' }
  [string]$Generation + "`r`n"
}
function Read-Wsl2LeaseFloor([string]$Text) {
  if ($null -eq $Text -or $Text.Length -eq 0 -or $Text.Length -gt 32) { return $null }
  $t = $Text.TrimEnd("`r", "`n")
  if ($t -cnotmatch '^[0-9]{1,16}$') { return $null }
  $n = [long]$t
  if ($n -lt 1) { return $null }
  $n
}
# The three places that hold the Broker's attestation public half, plus the live key, the floor file and the computer names, read back. Every argument is a TEXT the caller read from disk (or the key's own SPKI).
# $Expect = { KeyName; KeyId; ComputerId; RepositoryId }. Returns the reason words (empty = all agree). A text that cannot be read is its own word, never a pass.
# $StrictFloor (install): the floor must EQUAL the Broker generation. Status is not strict: a revocation raises the floor first, so a higher floor for a moment is how it is done; status says so in words.
# $Expect may also carry ControlPlaneSid, PipeName, Git and ImageSha256: the bridge config is then compared with them too.
function Test-Wsl2KeyAgreement($Expect, [string]$LiveSpki, [string]$BrokerJson, [string]$AuthorityJson, [string]$BridgeJson, [string]$FloorText, [bool]$StrictFloor = $false) {
  $r = New-Object System.Collections.Generic.List[string]
  if (-not (Test-P256Spki $LiveSpki)) { $r.Add('live_key_spki') }
  $read = { param($text) try { $text | ConvertFrom-Json } catch { $null } }
  $broker = & $read $BrokerJson; $authority = & $read $AuthorityJson; $bridge = & $read $BridgeJson
  if ($null -eq $broker) { $r.Add('broker_config_unreadable') }
  else {
    $a = $broker.PSObject.Properties['attestation']
    if ($null -eq $a -or -not (Test-AttestationConfig $a.Value)) { $r.Add('broker_attestation') }
    elseif ($a.Value.keyName -cne $Expect.KeyName -or $a.Value.keyId -cne $Expect.KeyId) { $r.Add('broker_attestation_differs') }
    $wsl = @(@($broker.computers) | Where-Object { $null -ne $_ -and $null -ne $_.PSObject.Properties['kind'] -and $_.kind -ceq 'wsl2' })
    if ($wsl.Count -ne 1 -or $wsl[0].computerId -cne $Expect.ComputerId) { $r.Add('broker_wsl2_computer') }
  }
  if ($null -eq $authority) { $r.Add('authority_config_unreadable') }
  else {
    if ($null -eq $authority.PSObject.Properties['attestationKeyId'] -or $authority.attestationKeyId -cne $Expect.KeyId) { $r.Add('authority_key_id') }
    if ($null -eq $authority.PSObject.Properties['attestationPublicKey'] -or $authority.attestationPublicKey -cne $LiveSpki) { $r.Add('authority_spki') }
  }
  if ($null -eq $bridge) { $r.Add('bridge_config_unreadable') }
  else {
    if ($bridge.brokerKeyId -cne $Expect.KeyId) { $r.Add('bridge_key_id') }
    if ($bridge.brokerSpki -cne $LiveSpki) { $r.Add('bridge_spki') }
    if ($bridge.computerId -cne $Expect.ComputerId) { $r.Add('bridge_computer_id') }
    if (@(@($bridge.repositories) | Where-Object { $_.repositoryId -ceq $Expect.RepositoryId }).Count -ne 1) { $r.Add('bridge_repository') }
    $has = { param($n) $null -ne $Expect.PSObject.Properties[$n] -and -not [string]::IsNullOrEmpty([string]$Expect.$n) }
    if ((& $has 'ControlPlaneSid') -and $bridge.controlPlaneSid -cne $Expect.ControlPlaneSid) { $r.Add('bridge_control_plane_sid') }
    if ((& $has 'PipeName') -and $bridge.pipeName -cne $Expect.PipeName) { $r.Add('bridge_pipe_name') }
    if ((& $has 'Git') -and $bridge.gitPath -cne $Expect.Git) { $r.Add('bridge_git_path') }
    if ((& $has 'ImageSha256') -and $bridge.imageSha256 -cne $Expect.ImageSha256) { $r.Add('bridge_image_sha256') }
  }
  $floor = Read-Wsl2LeaseFloor $FloorText
  if ($null -eq $floor) { $r.Add('floor_unreadable') }
  elseif ($null -ne $broker -and ($broker.generation -is [int] -or $broker.generation -is [long]) -and $floor -gt [long]$broker.generation) { $r.Add('floor_above_generation') }
  elseif ($StrictFloor -and $null -ne $broker -and ($broker.generation -is [int] -or $broker.generation -is [long]) -and $floor -ne [long]$broker.generation) { $r.Add('floor_below_generation') }   # a floor above the Broker's generation refuses every lease the Broker signs
  , @($r)
}
# Who may read the lease floor file (ADR-012: Phase 5 required): SYSTEM, Administrators and the owner, nobody else. $AllowSids = the allow ACEs read back from the file.
function Test-Wsl2FloorAcl($AllowSids, [string]$OwnerSid) {
  $r = New-Object System.Collections.Generic.List[string]
  foreach ($sid in @($AllowSids)) { if (@('S-1-5-18', 'S-1-5-32-544', $OwnerSid) -cnotcontains $sid) { $r.Add('floor_acl:' + $sid) } }
  , @($r)
}
# The settings text (control-plane-config\albera.approval.json) against what -AddWsl2Computer intends: the wsl2 computer, the wsl2 block and the desktop block it needs. Empty = as intended.
# $Expect = { ComputerId; RepositoryId; PipeName; ServerSid; Git }.
function Test-Wsl2SettingsText([string]$Json, $Expect) {
  $r = New-Object System.Collections.Generic.List[string]
  try { $o = $Json | ConvertFrom-Json } catch { $r.Add('settings_syntax'); return , @($r) }
  if ($o -isnot [System.Management.Automation.PSCustomObject]) { $r.Add('settings_syntax'); return , @($r) }   # an empty or missing text parses to nothing
  $computer = if ($null -ne $o.computers -and $null -ne $o.computers.PSObject.Properties[$Expect.ComputerId]) { $o.computers.($Expect.ComputerId) } else { $null }
  if ($computer -isnot [System.Management.Automation.PSCustomObject] -or -not (Test-SameKeySet $computer @('computerId', 'isolation', 'repositoryId')) -or $computer.computerId -cne $Expect.ComputerId -or $computer.isolation -cne 'wsl2' -or $computer.repositoryId -cne $Expect.RepositoryId) { $r.Add('settings_wsl2_computer') }
  $block = $o.PSObject.Properties['wsl2']
  if ($null -eq $block -or $block.Value -isnot [System.Management.Automation.PSCustomObject] -or -not (Test-SameKeySet $block.Value @('pipeName', 'serverSid', 'git'))) { $r.Add('settings_wsl2_block') }
  elseif ($block.Value.pipeName -cne $Expect.PipeName -or $block.Value.serverSid -cne $Expect.ServerSid -or $block.Value.git -cne $Expect.Git) { $r.Add('settings_wsl2_block_differs') }
  if ($null -eq $o.PSObject.Properties['desktop']) { $r.Add('settings_desktop') }
  , @($r)
}
# The bridge runs in the owner's session, started at sign-in from HKLM Run like the approver tray. Its own config is the one argument.
function Get-Wsl2RunEntry($W) {
  $c = Get-HostConstants; $w2 = Get-Wsl2Constants
  [pscustomobject]@{ KeyPath = $c.RunKeyPath; Name = $w2.RunValueName; Command = ('"' + $W.BridgeExe + '" serve "' + $W.Config + '"') }
}
# The record `created.wsl2` of the install manifest (a Dictionary). Names a fixed key, a fixed Run value and hashes: a forged record cannot make uninstall delete another key or value.
function Test-Wsl2Record($Record) {
  $c = Get-Wsl2Constants
  if ($Record -isnot [System.Collections.IDictionary]) { return $false }
  $allowed = @('computerId', 'repositoryId', 'keyName', 'keyId', 'gitPath', 'bridgeTreeSha256', 'bridgeExeSha256', 'imageSha256', 'floorGeneration', 'runEntry', 'firstStart')
  foreach ($k in @($Record.Keys)) { if ($allowed -cnotcontains $k) { return $false } }
  foreach ($k in @('computerId', 'repositoryId', 'keyName', 'keyId')) { if (-not (Test-HasKey $Record $k)) { return $false } }
  if (-not (Test-HostId $Record['computerId']) -or -not (Test-HostId $Record['repositoryId']) -or $Record['keyName'] -cne $c.AttestationKeyName -or $Record['keyId'] -cne $c.AttestationKeyId) { return $false }
  foreach ($k in @('bridgeTreeSha256', 'bridgeExeSha256', 'imageSha256')) { if ((Test-HasKey $Record $k) -and -not (Test-TreeHashValue $Record[$k])) { return $false } }
  if ((Test-HasKey $Record 'gitPath') -and -not (Test-Wsl2GitPath $Record['gitPath'])) { return $false }
  if ((Test-HasKey $Record 'floorGeneration') -and ($Record['floorGeneration'] -isnot [int] -and $Record['floorGeneration'] -isnot [long])) { return $false }
  if (Test-HasKey $Record 'firstStart') {
    $f = $Record['firstStart']
    if ($f -isnot [System.Collections.IDictionary] -or @($f.Keys).Count -ne 2 -or $f['word'] -cne $c.FirstStartWord -or $f['at'] -isnot [string] -or $f['at'] -cnotmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\z') { return $false }
  }
  if (Test-HasKey $Record 'runEntry') {
    $e = $Record['runEntry']
    if ($e -isnot [System.Collections.IDictionary] -or @($e.Keys).Count -ne 2 -or $e['name'] -cne $c.RunValueName -or $e['command'] -isnot [string] -or $e['command'].Length -gt 400) { return $false }
  }
  $true
}
