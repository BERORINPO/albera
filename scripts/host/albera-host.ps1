# ALBERA host installer: puts the Host Broker and the Approval Authority on THIS Windows PC so the first real Windows Hello approval can happen.
# Windows PowerShell 5.1, ASCII only. Written for the owner to run in an elevated console (never self-elevating). Design notes: docs/architecture/host-install.md.
#
#   albera-host.ps1                                         plan (default): numbered list of everything install would do; changes nothing, needs no admin
#   albera-host.ps1 -Mode plan -PlanFor uninstall           the same for uninstall
#   albera-host.ps1 -Mode install -ApproverKeyId <hello-...>   install (elevated). Asks for the password of the new local account albera-cp.
#   albera-host.ps1 -Mode status                            read-only report of what is installed and whether it still matches (exit 1 on any difference)
#   albera-host.ps1 -Mode uninstall                         remove only what the install manifest says this script created (elevated)
#
# install and uninstall refuse unless the console is elevated; they never elevate. A completed install re-run says so and changes nothing. A partial install is finished
# from where it stopped, or refused with the reason. Nothing is ever printed that is secret: only public values (SIDs, public keys, hashes, paths).
# -ControlPlanePassword / -LabApproverValues are for the disposable lab VM only and are refused unless the environment variable ALBERA_LAB_VM is 1.
[CmdletBinding()]
param(
  [ValidateSet('plan', 'install', 'uninstall', 'status')][string]$Mode = 'plan',
  [ValidateSet('install', 'uninstall')][string]$PlanFor = 'install',
  [string]$ApproverKeyId,
  [string]$ApproverExe,
  [string]$RepoRoot,
  [string]$ProjectId,
  [string]$VmName,
  [string]$ComputerId,
  [switch]$StartCheck,
  [securestring]$ControlPlanePassword,
  [string]$LabApproverValues
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'albera-host-lib.ps1')

$K = Get-HostConstants
$SystemRoot = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
$ScExe = Join-Path $SystemRoot 'System32\sc.exe'
$IcaclsExe = Join-Path $SystemRoot 'System32\icacls.exe'
$script:Manifest = $null
$script:Approver = $null
$script:Sids = $null

function Say([string]$Text) { Write-Host $Text }
function Stop-Refused([string]$Why, [int]$Code = 3) { Write-Host "REFUSED: $Why"; exit $Code }

# ---------------------------------------------------------------------------------------------- environment and arguments
# ALBERA_HOST_ASSUME_NOT_ELEVATED=1 is a test seam that can only make the script refuse more (the tests use it so install can never run for real from a test).
function Test-Elevated {
  if ($env:ALBERA_HOST_ASSUME_NOT_ELEVATED -eq '1') { return $false }
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if ([string]::IsNullOrEmpty($RepoRoot)) { $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
if ([string]::IsNullOrEmpty($ProjectId)) { $ProjectId = $K.DefaultProjectId }
if ([string]::IsNullOrEmpty($VmName)) { $VmName = $K.DefaultVmName }
if ([string]::IsNullOrEmpty($ComputerId)) { $ComputerId = $K.DefaultComputerId }
if ($Mode -in @('install', 'uninstall') -and -not (Test-Elevated)) { Stop-Refused "$Mode needs an elevated console (Run as administrator). This script never elevates itself." }
if ($ControlPlanePassword -or $LabApproverValues) {
  $gate = Test-LabPasswordGate ([bool]($ControlPlanePassword -or $LabApproverValues)) $env:ALBERA_LAB_VM
  if ($gate) { Stop-Refused ($gate -replace 'control_plane_password_parameter_is_lab_only', '-ControlPlanePassword and -LabApproverValues are lab-only (disposable VM with ALBERA_LAB_VM=1)') 2 }
  if ($Mode -ne 'install') { Stop-Refused '-ControlPlanePassword and -LabApproverValues only apply to -Mode install' 2 }
}
if ($ApproverKeyId -and -not (Test-HostId $ApproverKeyId)) { Stop-Refused '-ApproverKeyId is not a valid key id' 2 }
if (-not (Test-HostId $ProjectId) -or -not (Test-HostId $ComputerId) -or $VmName -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') { Stop-Refused '-ProjectId, -VmName or -ComputerId is not a valid id' 2 }
if ($PSVersionTable.PSVersion.Major -ne 5) { Stop-Refused 'Windows PowerShell 5.1 is required' }
if (-not [Environment]::Is64BitProcess) { Stop-Refused 'a 64-bit PowerShell is required' }
if ([string]::IsNullOrEmpty($env:ProgramFiles) -or [string]::IsNullOrEmpty($env:ProgramData)) { Stop-Refused 'ProgramFiles / ProgramData are not set' }
$L = Get-HostLayout $env:ProgramFiles $env:ProgramData
foreach ($p in @($L.BrokerExe, $L.AuthorityExe, $L.PipeClientExe, $L.BrokerConfig, $L.AuthorityConfig, $L.ApprovalSettings, $L.BrokerDb, $L.ControlPlaneJournal)) {
  if (-not (Test-PlainAbsolutePath $p)) { Stop-Refused 'an install path is not a plain absolute path (the services refuse such paths)' }
}

# ---------------------------------------------------------------------------------------------- helpers that touch the system
function Invoke-Native([string]$Exe, [string]$Arguments, [int]$TimeoutMs = 60000) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe; $psi.Arguments = $Arguments; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($psi)
  $out = $process.StandardOutput.ReadToEndAsync(); $err = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutMs)) { try { $process.Kill() } catch { }; throw "timeout running $([System.IO.Path]::GetFileName($Exe))" }
  $process.WaitForExit()
  [pscustomobject]@{ Exit = $process.ExitCode; Out = $out.Result; Err = $err.Result }
}
function Invoke-Sc([string]$Arguments) {
  $r = Invoke-Native $ScExe $Arguments
  if ($r.Exit -ne 0) { throw ("sc.exe failed (exit $($r.Exit)): " + (($r.Out + $r.Err) -replace '\s+', ' ').Trim()) }
  $r
}
function Get-AccountSid([string]$Account) { (New-Object System.Security.Principal.NTAccount($Account)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
function Get-Sha256File([string]$Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $stream = [System.IO.File]::OpenRead($Path); try { ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() } finally { $stream.Dispose() } } finally { $sha.Dispose() }
}
function Test-HasReparsePoint([string]$Dir) {
  $bad = @(Get-ChildItem -LiteralPath $Dir -Recurse -Force -ErrorAction Stop | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint })
  $bad.Count -gt 0
}
# Relative path and SHA-256 of every file under a folder (sorted, ordinal); the tree hash is the SHA-256 of those lines.
function Get-TreeHashes([string]$Dir) {
  $root = (Resolve-Path -LiteralPath $Dir).Path.TrimEnd('\')
  $entries = foreach ($f in (Get-ChildItem -LiteralPath $Dir -Recurse -Force -File)) { [pscustomobject]@{ Rel = $f.FullName.Substring($root.Length + 1); Sha = (Get-Sha256File $f.FullName) } }
  $list = New-Object 'System.Collections.Generic.List[object]'
  foreach ($e in $entries) { $list.Add($e) }
  $list.Sort([Comparison[object]]{ param($a, $b) [string]::CompareOrdinal($a.Rel, $b.Rel) })
  $sorted = $list.ToArray()
  $text = ($sorted | ForEach-Object { $_.Rel + "`t" + $_.Sha + "`n" }) -join ''
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $tree = ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text))) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  [pscustomobject]@{ Files = $sorted; Tree = $tree }
}
function Set-HostAcl($Entry) {
  $args1 = (Quote-NativeArg $Entry.Path) + ' /inheritance:r'
  foreach ($g in $Entry.Grants) { $args1 += ' /grant:r ' + $g }
  $r = Invoke-Native $IcaclsExe $args1
  if ($r.Exit -ne 0) { throw "icacls failed for $($Entry.Path)" }
  $o = Invoke-Native $IcaclsExe ((Quote-NativeArg $Entry.Path) + ' /setowner *S-1-5-32-544')
  if ($o.Exit -ne 0) { throw "icacls /setowner failed for $($Entry.Path)" }
}
function Get-AclSummary([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  [pscustomobject]@{
    Owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    Protected = $acl.AreAccessRulesProtected
    AllowSids = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
  }
}
function Test-SecureStringEqual([securestring]$A, [securestring]$B) {
  $pa = [IntPtr]::Zero; $pb = [IntPtr]::Zero
  try {
    $pa = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($A); $pb = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($B)
    if ($A.Length -ne $B.Length) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $A.Length * 2; $i++) { $diff = $diff -bor ([System.Runtime.InteropServices.Marshal]::ReadByte($pa, $i) -bxor [System.Runtime.InteropServices.Marshal]::ReadByte($pb, $i)) }
    $diff -eq 0
  }
  finally {
    if ($pa -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pa) }
    if ($pb -ne [IntPtr]::Zero) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pb) }
  }
}

# Member SIDs of a built-in local group. Get-LocalGroupMember throws on a group that holds an unresolvable (orphaned) SID, so the WinNT provider is used.
function Get-LocalGroupMemberSids([string]$GroupSid) {
  $name = (New-Object System.Security.Principal.SecurityIdentifier($GroupSid)).Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1]
  $group = [ADSI]"WinNT://./$name,group"
  @($group.Invoke('Members') | ForEach-Object {
      $entry = New-Object System.DirectoryServices.DirectoryEntry($_)
      (New-Object System.Security.Principal.SecurityIdentifier([byte[]]$entry.InvokeGet('objectSid'), 0)).Value
    })
}

# ---------------------------------------------------------------------------------------------- the install manifest (what this script created; nothing else is ever removed)
Add-Type -AssemblyName System.Web.Extensions
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
function Read-Manifest {
  if (-not (Test-Path -LiteralPath $L.ManifestPath)) { return $null }
  $m = $serializer.DeserializeObject([System.IO.File]::ReadAllText($L.ManifestPath))
  if ($m -isnot [System.Collections.IDictionary] -or $m['schema'] -ne 1 -or $m['tool'] -ne 'albera-host.ps1') { throw 'the install manifest is not one this script wrote; refusing to use it' }
  $m
}
# Read with JavaScriptSerializer (plain dictionaries and arrays), written with ConvertTo-Json: JavaScriptSerializer cannot write PowerShell-wrapped objects.
function Save-Manifest {
  $script:Manifest['updatedAt'] = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $tmp = $L.ManifestPath + '.tmp'
  [System.IO.File]::WriteAllText($tmp, ($script:Manifest | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $L.ManifestPath -Force
}
function New-Manifest {
  $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $created = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $created['dataRoot'] = $true; $created['installRoot'] = $false; $created['services'] = @(); $created['binaries'] = (New-Object 'System.Collections.Generic.Dictionary[string,object]')
  $values = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $m = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $m['schema'] = 1; $m['tool'] = 'albera-host.ps1'; $m['state'] = 'partial'; $m['startedAt'] = $now; $m['updatedAt'] = $now; $m['created'] = $created; $m['values'] = $values
  $m
}
function Test-ManifestHas([string]$Name) {
  if ($null -eq $script:Manifest -or -not $script:Manifest['created'].ContainsKey($Name)) { return $false }
  $v = $script:Manifest['created'][$Name]
  if ($null -eq $v) { return $false }
  if ($v -is [bool]) { return $v }
  if ($v -is [System.Array]) { return ($v.Count -gt 0) }
  $true
}

# ---------------------------------------------------------------------------------------------- the builds this script copies
function Get-BuildSources {
  $r = $RepoRoot
  @(
    [pscustomobject]@{ Name = 'broker'; Dir = Join-Path $r 'src\runtime\windows-broker\bin\Release\net10.0-windows\win-x64\publish'; Exe = 'albera-windows-broker.exe'; Dest = $L.BrokerBinDir; Build = 'npm run build:windows-broker' }
    [pscustomobject]@{ Name = 'authority'; Dir = Join-Path $r 'src\runtime\windows-approval-authority\bin\Release\net10.0-windows\win-x64\publish'; Exe = 'albera-approval-authority.exe'; Dest = $L.AuthorityBinDir; Build = 'npm run build:approval-authority' }
    [pscustomobject]@{ Name = 'pipe-client'; Dir = Join-Path $r 'src\runtime\windows-broker-pipe-client\bin\Release\net10.0-windows\win-x64\publish'; Exe = 'albera-windows-broker-pipe-client.exe'; Dest = $L.PipeClientBinDir; Build = 'npm run build:windows-broker' }
  )
}
function Get-ApproverExePath {
  if ($ApproverExe) { return $ApproverExe }
  Join-Path $RepoRoot 'src\runtime\windows-approver\bin\Release\net10.0-windows10.0.19041.0\win-x64\publish\AlberaApprover.exe'
}
# The exe must match the SHA-256 the build wrote next to it (a sidecar written by the same build: it catches a stale or damaged build, not a hostile one).
function Test-BuiltExe([string]$Exe) {
  if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return 'missing' }
  try { $m = Get-Content -Raw -LiteralPath ($Exe + '.manifest.json') | ConvertFrom-Json } catch { return 'manifest_missing' }
  if ($m.sha256 -notmatch '^[0-9a-f]{64}$') { return 'manifest_invalid' }
  if ((Get-Sha256File $Exe) -ne $m.sha256) { return 'sha256_differs_from_manifest' }
  'ok'
}
function Get-SourceProblems {
  $problems = New-Object System.Collections.Generic.List[string]
  foreach ($s in (Get-BuildSources)) {
    $state = Test-BuiltExe (Join-Path $s.Dir $s.Exe)
    if ($state -ne 'ok') { $problems.Add("$($s.Name): $state (run $($s.Build))") }
    elseif (Test-HasReparsePoint $s.Dir) { $problems.Add("$($s.Name): the publish folder contains a link or junction") }
  }
  , @($problems)
}

# ---------------------------------------------------------------------------------------------- service facts
function Get-ServiceFactsFor([string]$Name) {
  $svc = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction Stop
  if (-not $svc) { return [pscustomobject]@{ Exists = $false } }
  $sid = Invoke-Native $ScExe "qsidtype $Name"
  $privs = Invoke-Native $ScExe "qprivs $Name"
  [pscustomobject]@{
    Exists = $true; StartName = $svc.StartName; PathName = $svc.PathName; StartMode = $svc.StartMode; ServiceType = $svc.ServiceType
    SidTypeText = $sid.Out; PrivilegesText = $privs.Out; State = $svc.State; ExitCode = $svc.ExitCode; SpecificExitCode = $svc.ServiceSpecificExitCode
  }
}
function Get-ServiceSpecs {
  @(
    [pscustomobject]@{ Name = $K.BrokerService; Exe = $L.BrokerExe; Config = $L.BrokerConfig }
    [pscustomobject]@{ Name = $K.AuthorityService; Exe = $L.AuthorityExe; Config = $L.AuthorityConfig }
  )
}
function Wait-ServiceState([string]$Name, [string[]]$States, [int]$Seconds) {
  $end = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $end) {
    $s = Get-CimInstance Win32_Service -Filter "Name='$Name'"
    if (-not $s) { if ($States -contains 'Gone') { return $true } } elseif ($States -contains $s.State) { return $true }
    Start-Sleep -Milliseconds 300
  }
  $false
}

# ---------------------------------------------------------------------------------------------- SIDs
# The two service SIDs are known before the services exist (derived from the fixed names); they are cross-checked against what Windows says once the services exist.
function Resolve-HostSids {
  $cpSid = $null
  if ($script:Manifest -and $script:Manifest['created'].ContainsKey('user') -and $script:Manifest['created']['user']) { $cpSid = $script:Manifest['created']['user']['sid'] }
  $script:Sids = @{ Broker = (Get-DerivedServiceSid $K.BrokerService); Authority = (Get-DerivedServiceSid $K.AuthorityService); ControlPlane = $cpSid }
  foreach ($spec in @(@('Broker', $K.BrokerService), @('Authority', $K.AuthorityService))) {
    if (Get-CimInstance Win32_Service -Filter "Name='$($spec[1])'") {
      $real = Get-AccountSid "NT SERVICE\$($spec[1])"
      if ($real -ne $script:Sids[$spec[0]]) { throw "the SID Windows gives $($spec[1]) differs from the derived one; refusing to continue" }
    }
  }
}

# ---------------------------------------------------------------------------------------------- install steps: each has a read-only Test (-> done / todo / blocked:<why> / unknown:<why>) and a Do
function Get-InstallSteps {
  @(
    [pscustomobject]@{ Id = 'sources'; Title = 'Verify the published builds (Broker, Authority, pipe client) against their SHA-256 manifests'
      Detail = @("builds are read from $RepoRoot\src\runtime\...\publish (npm run build:windows-broker, npm run build:approval-authority)")
      Test = { $p = Get-SourceProblems; if ($p.Count -gt 0) { 'blocked:' + ($p -join '; ') } else { 'todo' } }
      Do = { $p = Get-SourceProblems; if ($p.Count -gt 0) { Stop-Refused ('build problems: ' + ($p -join '; ')) } ; Say '    all three builds match their manifests' } }
    [pscustomobject]@{ Id = 'approver'; Title = 'Read the approver key with "AlberaApprover.exe enroll --show" and check it against -ApproverKeyId'
      Detail = @('the key id shown must equal -ApproverKeyId; the approver SID must be an S-1-5-21 user SID and differ from albera-cp; the public key must be an RSA-2048 SPKI', 'enroll --show opens the existing key without a prompt; it creates and changes nothing')
      Test = {
        if ($LabApproverValues) { return 'todo' }
        if (-not $ApproverKeyId) { return 'blocked:-ApproverKeyId <hello-...> is required for install' }
        $s = Test-BuiltExe (Get-ApproverExePath); if ($s -ne 'ok') { return "blocked:approver exe $s (run npm run build:approver)" }
        'todo' }
      Do = { Invoke-ApproverStep } }
    [pscustomobject]@{ Id = 'dataroot'; Title = "Create $($L.DataRoot) (SYSTEM and Administrators only) and the install manifest"
      Detail = @("manifest: $($L.ManifestPath) lists exactly what this script creates; uninstall removes only that")
      Test = {
        if ($script:Manifest) { return 'done' }
        if (Test-Path -LiteralPath $L.DataRoot) { return 'blocked:' + $L.DataRoot + ' exists but was not created by this script; remove or rename it yourself' }
        'todo' }
      Do = {
        New-Item -ItemType Directory -Path $L.DataRoot | Out-Null
        Set-HostAcl ([pscustomobject]@{ Path = $L.DataRoot; Grants = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F') })
        $script:Manifest = New-Manifest; Save-Manifest; Say "    created $($L.DataRoot)" } }
    [pscustomobject]@{ Id = 'user'; Title = "Create the local standard user $($K.ControlPlaneUser) (BUILTIN\Users only, not Administrators); you type its password"
      Detail = @('PROVISIONAL Control Plane identity: the Authority refuses one SID for both pipes and the approver SID is your own account', 'the password is read as a SecureString, used once for New-LocalUser, never stored, printed or logged')
      Test = {
        $u = Get-LocalUser -Name $K.ControlPlaneUser -ErrorAction SilentlyContinue
        if ($u -and (Test-ManifestHas 'user') -and $u.SID.Value -eq $script:Manifest['created']['user']['sid']) { return 'done' }
        if ($u) { return "blocked:a local user named $($K.ControlPlaneUser) already exists and was not created by this script; it is never adopted" }
        'todo' }
      Do = { New-ControlPlaneUser } }
    [pscustomobject]@{ Id = 'services'; Title = "Create services $($K.BrokerService) and $($K.AuthorityService) (own process, NT SERVICE virtual account, restricted SID, SeChangeNotifyPrivilege only, start=demand)"
      Detail = @("$($K.BrokerService) service ACL: SYSTEM and Administrators full, $($K.ControlPlaneUser) only SERVICE_QUERY_STATUS (LC)", 'the services are NOT started by install; you start them (Start-Service) when you are ready')
      Test = {
        $states = foreach ($spec in (Get-ServiceSpecs)) {
          $exists = [bool](Get-CimInstance Win32_Service -Filter "Name='$($spec.Name)'")
          $mine = (Test-ManifestHas 'services') -and (@($script:Manifest['created']['services']) -contains $spec.Name)
          if ($exists -and -not $mine) { 'blocked:service ' + $spec.Name + ' already exists and was not created by this script' } elseif ($exists) { 'done' } else { 'todo' }
        }
        $b = @($states | Where-Object { $_ -like 'blocked:*' }); if ($b.Count) { return $b[0] }
        if (@($states | Where-Object { $_ -ne 'done' }).Count -eq 0) { 'done' } else { 'todo' } }
      Do = { New-HostServices } }
    [pscustomobject]@{ Id = 'folders'; Title = "Create the folders and set their ACLs (inheritance removed): $($L.InstallRoot); $($L.DataRoot)\{broker-config,broker,authority,control-plane}"
      Detail = @('SYSTEM and Administrators full everywhere; Broker SID Modify on broker\ only; Authority SID Modify on authority\ only; albera-cp Modify on control-plane\ only', 'read/execute on bin for the three service-side accounts; parents stay administrator-only (the Broker does not check them)')
      Test = {
        if (-not (Test-ManifestHas 'user') -or -not (Test-ManifestHas 'services')) { return 'todo' }
        if ((Test-Path -LiteralPath $L.InstallRoot) -and -not (Test-ManifestHas 'installRoot')) { return 'blocked:' + $L.InstallRoot + ' exists but was not created by this script; remove or rename it yourself' }
        Resolve-HostSids
        foreach ($e in (Get-AclPlan $L $script:Sids)) { if (-not (Test-Path -LiteralPath $e.Path)) { return 'todo' }; if ((Test-AclMatchesPlan $e (Get-AclSummary $e.Path)).Count -gt 0) { return 'todo' } }
        'done' }
      Do = { New-HostFolders } }
    [pscustomobject]@{ Id = 'binaries'; Title = "Copy the three builds to $($L.BinRoot)\{broker,authority,pipe-client} and record SHA-256 (exe and whole-folder hash)"
      Detail = @('copied to a .partial folder, every file hashed against the source, then renamed; an existing different copy is refused (update = uninstall + install)')
      Test = {
        if (-not (Test-ManifestHas 'installRoot')) { return 'todo' }
        foreach ($s in (Get-BuildSources)) { if (-not (Test-Path -LiteralPath $s.Dest)) { return 'todo' }; if (-not $script:Manifest['created']['binaries'].ContainsKey($s.Name)) { return 'todo' } }
        'done' }
      Do = { Copy-HostBinaries } }
    [pscustomobject]@{ Id = 'key'; Title = "Create the Authority machine signing key $($K.SigningKeyName) (ECDSA P-256, Software KSP, machine scope, Export Policy none, DACL SYSTEM/Administrators/Authority service SID only)"
      Detail = @('read back from a fresh open and checked like the Authority start-up guard; one sign/verify round trip; only the PUBLIC key (SPKI) leaves it, into the Broker config')
      Test = {
        if ((Test-ManifestHas 'key') -and (Test-AuthoritySigningKeyExists $K.SigningKeyName)) { return 'done' }
        if (Test-AuthoritySigningKeyExists $K.SigningKeyName) { return 'blocked:a machine key named ' + $K.SigningKeyName + ' exists and was not created by this script; it is never adopted' }
        'todo' }
      Do = { New-HostSigningKey } }
    [pscustomobject]@{ Id = 'configs'; Title = "Write the Broker config, the Authority config and the Control Plane settings; validate them (own checks, then service-check)"
      Detail = @($L.BrokerConfig, $L.AuthorityConfig, "$($L.ApprovalSettings)  (attestation null; computers: $VmName -> $ComputerId, project $ProjectId)", 'no policy.json is written: the Authority starts at tier careful (every action needs a person)')
      Test = { if ((Test-Path -LiteralPath $L.BrokerConfig) -and (Test-Path -LiteralPath $L.AuthorityConfig) -and (Test-Path -LiteralPath $L.ApprovalSettings)) { 'done' } else { 'todo' } }
      Do = { Write-HostConfigs } }
    [pscustomobject]@{ Id = 'finish'; Title = 'Record the install as complete in the manifest (services stay stopped)'
      Detail = @()
      Test = { if ($script:Manifest -and $script:Manifest['state'] -eq 'complete') { 'done' } else { 'todo' } }
      Do = { $script:Manifest['state'] = 'complete'; Save-Manifest; Say '    install complete' } }
  )
}

function Invoke-ApproverStep {
  if ($LabApproverValues) {
    $o = $LabApproverValues | ConvertFrom-Json
    $shown = [pscustomobject]@{ approverPublicKey = [string]$o.approverPublicKey; approverKeyId = [string]$o.approverKeyId; approverSid = [string]$o.approverSid }
  }
  else {
    $exe = Get-ApproverExePath
    $r = Invoke-Native $exe 'enroll --show' 30000
    if ($r.Exit -ne 0) { Stop-Refused ("the approver exe could not show the enrolled key (exit $($r.Exit)): " + (($r.Err -split "`r?`n")[0]) + ' - run AlberaApprover.exe enroll first') }
    $shown = Read-ApproverShown ($r.Out -split "`r?`n")
  }
  $expected = if ($ApproverKeyId) { $ApproverKeyId } else { $shown.approverKeyId }
  $cp = if ($script:Manifest -and (Test-ManifestHas 'user')) { $script:Manifest['created']['user']['sid'] } else { $null }
  $reasons = Test-ApproverValues $shown $expected $cp
  if ($reasons.Count -gt 0) { Stop-Refused ('approver values rejected: ' + ($reasons -join ', ')) }
  $script:Approver = $shown
  Say "    approver key id $($shown.approverKeyId), approver SID $($shown.approverSid)"
}

function New-ControlPlaneUser {
  $password = $ControlPlanePassword
  $own = @()
  try {
    if (-not $password) {
      if ([Console]::IsInputRedirected) { Stop-Refused 'the password prompt needs an interactive console' }
      $first = Read-Host "Choose a password for the new local account $($K.ControlPlaneUser) (not stored anywhere)" -AsSecureString
      $second = Read-Host 'Type it again' -AsSecureString
      $own = @($first, $second)
      if ($first.Length -eq 0 -or -not (Test-SecureStringEqual $first $second)) { Stop-Refused 'the two passwords are empty or differ; nothing was created' }
      $password = $first
    }
    New-LocalUser -Name $K.ControlPlaneUser -Password $password -FullName 'ALBERA Control Plane' -Description 'ALBERA Control Plane account (created by albera-host.ps1)' -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires | Out-Null
  }
  finally { foreach ($s in $own) { $s.Dispose() }; $password = $null }
  $u = Get-LocalUser -Name $K.ControlPlaneUser
  $rec = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $rec['name'] = $K.ControlPlaneUser; $rec['sid'] = $u.SID.Value
  $script:Manifest['created']['user'] = $rec; Save-Manifest
  if ((Get-LocalGroupMemberSids 'S-1-5-32-545') -notcontains $u.SID.Value) { Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $u }
  if ((Get-LocalGroupMemberSids 'S-1-5-32-544') -contains $u.SID.Value) { throw 'the new account is an Administrator; refusing' }
  if ($script:Approver -and $script:Approver.approverSid -ceq $u.SID.Value) { throw 'the approver SID equals the Control Plane SID; the Authority refuses one SID for both pipes' }
  Say "    created $($K.ControlPlaneUser), SID $($u.SID.Value), member of BUILTIN\Users only"
}

function New-HostServices {
  if (-not (Test-ManifestHas 'user')) { throw 'internal: the Control Plane account must exist before the services' }
  foreach ($spec in (Get-ServiceSpecs)) {
    if (-not (Get-CimInstance Win32_Service -Filter "Name='$($spec.Name)'")) {
      Invoke-Sc (Get-ScCreateArguments $spec.Name $spec.Exe $spec.Config) | Out-Null
      $script:Manifest['created']['services'] = @($script:Manifest['created']['services']) + $spec.Name; Save-Manifest
    }
    Invoke-Sc "sidtype $($spec.Name) restricted" | Out-Null
    Invoke-Sc "privs $($spec.Name) SeChangeNotifyPrivilege" | Out-Null
  }
  Resolve-HostSids
  Invoke-Sc ("sdset $($K.BrokerService) " + (Quote-NativeArg (Get-BrokerServiceSddl $script:Sids.ControlPlane))) | Out-Null
  foreach ($spec in (Get-ServiceSpecs)) {
    $bad = Test-ServiceFacts (Get-ServiceFactsFor $spec.Name) $spec.Name (Get-ServiceCommandLine $spec.Exe $spec.Config)
    if ($bad.Count -gt 0) { throw "service $($spec.Name) is not as intended: $($bad -join ', ')" }
  }
  $sd = (Invoke-Sc "sdshow $($K.BrokerService)").Out.Trim()
  $badSd = Test-ServiceSdMatches $sd $script:Sids.ControlPlane
  if ($badSd.Count -gt 0) { throw "the Broker service ACL is not as intended: $($badSd -join ', ')" }
  Say "    services created; Broker SID $($script:Sids.Broker), Authority SID $($script:Sids.Authority)"
}

function New-HostFolders {
  Resolve-HostSids
  if (-not (Test-Path -LiteralPath $L.InstallRoot)) {
    New-Item -ItemType Directory -Path $L.InstallRoot | Out-Null
    $script:Manifest['created']['installRoot'] = $true; Save-Manifest
  }
  foreach ($entry in (Get-AclPlan $L $script:Sids)) {
    if (-not (Test-Path -LiteralPath $entry.Path)) { New-Item -ItemType Directory -Path $entry.Path | Out-Null }
    Set-HostAcl $entry
  }
  foreach ($entry in (Get-AclPlan $L $script:Sids)) {
    $diffs = Test-AclMatchesPlan $entry (Get-AclSummary $entry.Path)
    if ($diffs.Count -gt 0) { throw "ACL of $($entry.Path) is not as planned: $($diffs -join ', ')" }
  }
  Say '    folders created; every ACL read back and matches the plan'
}

function Copy-HostBinaries {
  foreach ($s in (Get-BuildSources)) {
    $record = $script:Manifest['created']['binaries']
    $source = Get-TreeHashes $s.Dir
    if (Test-Path -LiteralPath $s.Dest) {
      if ($record.ContainsKey($s.Name) -and (Get-TreeHashes $s.Dest).Tree -eq $record[$s.Name]['treeSha256'] -and $source.Tree -eq $record[$s.Name]['treeSha256']) { continue }
      throw "$($s.Dest) already exists and differs from the build (or from the manifest); update means uninstall, then install"
    }
    $partial = $s.Dest + '.partial'
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Recurse -Force }   # left by a failed run of this script, inside the locked bin folder
    foreach ($f in $source.Files) {
      $target = Join-Path $partial $f.Rel
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      [System.IO.File]::Copy((Join-Path $s.Dir $f.Rel), $target, $false)
    }
    $copied = Get-TreeHashes $partial
    if ($copied.Tree -ne $source.Tree) { throw "the copy of $($s.Name) does not match the build" }
    Move-Item -LiteralPath $partial -Destination $s.Dest
    $exeSha = ($source.Files | Where-Object { $_.Rel -eq $s.Exe }).Sha
    $rec = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $rec['exeSha256'] = $exeSha; $rec['treeSha256'] = $source.Tree; $rec['files'] = $source.Files.Count
    $record[$s.Name] = $rec; Save-Manifest
    Say "    $($s.Name): $($source.Files.Count) files, exe sha256 $exeSha"
  }
}

function New-HostSigningKey {
  Resolve-HostSids
  $made = New-AuthoritySigningKey $K.SigningKeyName $script:Sids.Authority 'machine'
  $rec = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $rec['name'] = $K.SigningKeyName; $rec['provider'] = $K.SigningKeyProvider
  $script:Manifest['created']['key'] = $rec; $script:Manifest['values']['authoritySpki'] = $made.spki; Save-Manifest
  Say "    key created and read back (export policy $($made.report.exportPolicy), allowed: $($made.report.allowSids -join ', ')); public key $($made.spki)"
}

function Write-OneConfig([string]$Path, [string]$Text) {
  if (Test-Path -LiteralPath $Path) {
    if ([System.IO.File]::ReadAllText($Path) -ceq $Text) { return }
    throw "$Path exists and differs from what this script would write; uninstall and install again, or edit it by hand"
  }
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
  $o = Invoke-Native $IcaclsExe ((Quote-NativeArg $Path) + ' /setowner *S-1-5-32-544')
  if ($o.Exit -ne 0) { throw "icacls /setowner failed for $Path" }
}
function Invoke-ServiceCheck([string]$Exe, [string]$Config, [string]$Label) {
  $r = Invoke-Native $Exe ('service-check ' + (Quote-NativeArg $Config))
  $line = @($r.Out -split "`r?`n" | Where-Object { $_ -like 'SERVICE_CONFIG=*' })[0]
  if ($line -eq 'SERVICE_CONFIG=ok' -and $r.Exit -eq 0) { Say "    ${Label} service-check: ok"; return }
  # The shipped builds trust a config file only when the process token carries the per-service SID, which an elevated console never has: service-check from here always ends
  # SERVICE_CONFIG=invalid:config_untrusted, before it looks at anything else. That is not a verdict on the config; the first start of the service is the real test.
  if ($line -eq 'SERVICE_CONFIG=invalid:config_untrusted') { Say "    ${Label} service-check: INCONCLUSIVE (config_untrusted is expected outside the service token; this script's own checks passed; the first service start is the real test)"; return }
  throw "${Label} service-check failed: $line (exit $($r.Exit))"
}
function Write-HostConfigs {
  Resolve-HostSids
  if (-not $script:Approver) { throw 'internal: approver values missing' }
  $spki = $script:Manifest['values']['authoritySpki']
  $cp = $script:Sids.ControlPlane
  $brokerJson = ConvertTo-HostJson (Get-BrokerConfig $L $cp $spki)
  $authorityJson = ConvertTo-HostJson (Get-AuthorityConfig $cp $script:Approver)
  $settingsJson = ConvertTo-HostJson (Get-ControlPlaneSettings $L $ProjectId $VmName $ComputerId)
  foreach ($pair in @(@('broker config', (Test-BrokerConfigText $brokerJson)), @('authority config', (Test-AuthorityConfigText $authorityJson)))) {
    if ($pair[1].Count -gt 0) { throw "$($pair[0]) failed this script's own check: $($pair[1] -join ', ')" }
  }
  Write-OneConfig $L.BrokerConfig $brokerJson
  Write-OneConfig $L.AuthorityConfig $authorityJson
  Write-OneConfig $L.ApprovalSettings $settingsJson
  $values = $script:Manifest['values']
  $values['controlPlaneSid'] = $cp; $values['approverSid'] = $script:Approver.approverSid; $values['approverKeyId'] = $script:Approver.approverKeyId
  $values['brokerServiceSid'] = $script:Sids.Broker; $values['authorityServiceSid'] = $script:Sids.Authority; Save-Manifest
  Invoke-ServiceCheck $L.BrokerExe $L.BrokerConfig 'Broker'
  Invoke-ServiceCheck $L.AuthorityExe $L.AuthorityConfig 'Authority'
}

# Optional (-StartCheck): the one real test of the configs. Start each service, see whether it stays up, stop it again. Never run by default: the owner starts the services.
function Invoke-StartCheck {
  foreach ($spec in (Get-ServiceSpecs)) {
    Invoke-Sc "start $($spec.Name)" | Out-Null
    Wait-ServiceState $spec.Name @('Running', 'Stopped') 30 | Out-Null
    $f = Get-ServiceFactsFor $spec.Name
    Say "    $($spec.Name): state $($f.State), exit $($f.ExitCode), service-specific exit $($f.SpecificExitCode)"
    if ($f.State -eq 'Running') { Invoke-Sc "stop $($spec.Name)" | Out-Null; Wait-ServiceState $spec.Name @('Stopped') 30 | Out-Null }
    else { throw "$($spec.Name) did not stay running (see docs/architecture/host-install.md for the exit codes)" }
  }
}

# ---------------------------------------------------------------------------------------------- status
function Get-StatusLines {
  $lines = New-Object System.Collections.Generic.List[object]
  function Add-Line([string]$State, [string]$Text) { $lines.Add([pscustomobject]@{ State = $State; Text = $Text }) }
  if (-not $script:Manifest) { return , $lines.ToArray() }
  $M = $script:Manifest
  Add-Line $(if ($M['state'] -eq 'complete') { 'ok' } else { 'FAIL' }) "install state: $($M['state'])"
  try {
    Resolve-HostSids
    if ($M['created'].ContainsKey('user')) {
      $u = Get-LocalUser -Name $M['created']['user']['name'] -ErrorAction SilentlyContinue
      $okUser = $u -and $u.SID.Value -eq $M['created']['user']['sid'] -and $u.Enabled
      $admins = @(Get-LocalGroupMemberSids 'S-1-5-32-544')
      Add-Line $(if ($okUser -and $admins -notcontains $M['created']['user']['sid']) { 'ok' } else { 'FAIL' }) "user $($K.ControlPlaneUser): present, enabled, not an Administrator"
    }
    foreach ($spec in (Get-ServiceSpecs)) {
      $facts = Get-ServiceFactsFor $spec.Name
      $bad = Test-ServiceFacts $facts $spec.Name (Get-ServiceCommandLine $spec.Exe $spec.Config)
      if ($spec.Name -eq $K.BrokerService -and $facts.Exists) { $bad = @($bad) + @(Test-ServiceSdMatches (Invoke-Native $ScExe "sdshow $($spec.Name)").Out.Trim() $script:Sids.ControlPlane) }
      Add-Line $(if ($bad.Count -eq 0) { 'ok' } else { 'FAIL' }) ("service $($spec.Name): " + $(if ($bad.Count -eq 0) { "as installed (state $($facts.State))" } else { $bad -join ', ' }))
    }
    foreach ($entry in (Get-AclPlan $L $script:Sids)) {
      if (-not (Test-Path -LiteralPath $entry.Path)) { Add-Line 'FAIL' "folder $($entry.Path): missing"; continue }
      $d = Test-AclMatchesPlan $entry (Get-AclSummary $entry.Path)
      Add-Line $(if ($d.Count -eq 0) { 'ok' } else { 'FAIL' }) ("folder $($entry.Path): " + $(if ($d.Count -eq 0) { 'ACL as planned' } else { $d -join ', ' }))
    }
    foreach ($s in (Get-BuildSources)) {
      if (-not $M['created']['binaries'].ContainsKey($s.Name)) { Add-Line 'FAIL' "binaries $($s.Name): not recorded"; continue }
      $same = (Test-Path -LiteralPath $s.Dest) -and ((Get-TreeHashes $s.Dest).Tree -eq $M['created']['binaries'][$s.Name]['treeSha256'])
      Add-Line $(if ($same) { 'ok' } else { 'FAIL' }) "binaries $($s.Name): $(if ($same) { 'folder hash equals the recorded one' } else { 'missing or changed since install' })"
    }
    $key = Read-AuthoritySigningKey $K.SigningKeyName
    if (-not $key) { Add-Line 'FAIL' "signing key $($K.SigningKeyName): missing" }
    else {
      $bad = Test-KeyReadBack $key.report $script:Sids.Authority
      $same = $key.spki -eq $M['values']['authoritySpki']
      Add-Line $(if ($bad.Count -eq 0 -and $same) { 'ok' } else { 'FAIL' }) ("signing key $($K.SigningKeyName): " + $(if ($bad.Count -eq 0 -and $same) { 'non-exportable, DACL limited to SYSTEM/Administrators/Authority SID, public key equals the Broker config' } else { ($bad -join ', ') + $(if (-not $same) { ' public_key_changed' } else { '' }) }))
    }
    foreach ($pair in @(@('Broker config', $L.BrokerConfig, 'Broker'), @('Authority config', $L.AuthorityConfig, 'Authority'))) {
      if (-not (Test-Path -LiteralPath $pair[1])) { Add-Line 'FAIL' "$($pair[0]): missing"; continue }
      $text = [System.IO.File]::ReadAllText($pair[1])
      $r = if ($pair[2] -eq 'Broker') { Test-BrokerConfigText $text } else { Test-AuthorityConfigText $text }
      Add-Line $(if ($r.Count -eq 0) { 'ok' } else { 'FAIL' }) ("$($pair[0]): " + $(if ($r.Count -eq 0) { 'shape valid' } else { $r -join ', ' }))
    }
    Add-Line $(if (Test-Path -LiteralPath $L.ApprovalSettings) { 'ok' } else { 'FAIL' }) "Control Plane settings: $(if (Test-Path -LiteralPath $L.ApprovalSettings) { 'present' } else { 'missing' })"
  }
  catch { Add-Line 'unknown' ('status check could not finish (is this console elevated?): ' + $_.Exception.Message) }
  , $lines.ToArray()
}
function Show-Status {
  $lines = Get-StatusLines
  if ($lines.Count -eq 0) { Say 'STATUS: not installed (no install manifest). Nothing to check.'; return 0 }
  $n = 0; foreach ($l in $lines) { $n++; Say ('  {0,2}. [{1}] {2}' -f $n, $l.State, $l.Text) }
  $bad = @($lines | Where-Object { $_.State -ne 'ok' }).Count
  if ($bad -eq 0) { Say 'STATUS: ok. Everything matches the install manifest.'; return 0 }
  Say "STATUS: $bad item(s) differ or could not be checked."
  return 1
}

# ---------------------------------------------------------------------------------------------- uninstall steps
function Get-UninstallSteps {
  @(
    [pscustomobject]@{ Id = 'services'; Title = "Stop and delete the services this script created ($($K.BrokerService), $($K.AuthorityService))"; Detail = @('a service whose command line is not the one install wrote is left alone and reported')
      Test = { $mine = if (Test-ManifestHas 'services') { @($script:Manifest['created']['services']) } else { @() }; if (@($mine | Where-Object { Get-CimInstance Win32_Service -Filter "Name='$_'" }).Count -gt 0) { 'todo' } else { 'done' } }
      Do = { Remove-HostServices } }
    [pscustomobject]@{ Id = 'key'; Title = "Delete the machine signing key $($K.SigningKeyName) (only if this script created it)"; Detail = @()
      Test = { if ((Test-ManifestHas 'key') -and (Test-AuthoritySigningKeyExists $K.SigningKeyName)) { 'todo' } else { 'done' } }
      Do = { Remove-AuthoritySigningKey $K.SigningKeyName | Out-Null; $script:Manifest['created'].Remove('key') | Out-Null; Save-Manifest; Say '    key deleted' } }
    [pscustomobject]@{ Id = 'installroot'; Title = "Remove $($L.InstallRoot) (the copied builds)"; Detail = @('refused if it holds anything but the three build folders')
      Test = { if ((Test-ManifestHas 'installRoot') -and (Test-Path -LiteralPath $L.InstallRoot)) { 'todo' } else { 'done' } }
      Do = { Remove-HostTree $L.InstallRoot @('bin') @('bin\broker', 'bin\authority', 'bin\pipe-client') $true; $script:Manifest['created']['installRoot'] = $false; Save-Manifest } }
    [pscustomobject]@{ Id = 'data'; Title = "Remove the data folders under $($L.DataRoot) (configs, databases, policy.json, settings; the manifest goes last)"; Detail = @('refused for any folder that holds a file this script does not know')
      Test = { if (Test-Path -LiteralPath $L.BrokerDbDir) { 'todo' } elseif (Test-Path -LiteralPath $L.AuthorityDir) { 'todo' } elseif (Test-Path -LiteralPath $L.BrokerConfigDir) { 'todo' } elseif (Test-Path -LiteralPath $L.ControlPlaneDir) { 'todo' } else { 'done' } }
      Do = { foreach ($d in @($L.BrokerConfigDir, $L.BrokerDbDir, $L.AuthorityDir, $L.ControlPlaneDir)) { if (Test-Path -LiteralPath $d) { Remove-HostTree $d @() @() $false } } } }
    [pscustomobject]@{ Id = 'user'; Title = "Remove the local user $($K.ControlPlaneUser) (only if this script created it; its profile folder, if any, is left)"; Detail = @()
      Test = { if (Test-ManifestHas 'user') { 'todo' } else { 'done' } }
      Do = {
        $rec = $script:Manifest['created']['user']
        $u = Get-LocalUser -Name $rec['name'] -ErrorAction SilentlyContinue
        if ($u -and $u.SID.Value -eq $rec['sid']) { Remove-LocalUser -SID $u.SID; Say "    removed $($rec['name'])" }
        elseif ($u) { Say "    WARNING: a user named $($rec['name']) exists but its SID is not the one recorded; left alone" }
        $script:Manifest['created'].Remove('user') | Out-Null; Save-Manifest } }
    [pscustomobject]@{ Id = 'manifest'; Title = "Remove the manifest and $($L.DataRoot) itself"; Detail = @('only when nothing else is left in it')
      Test = { if (Test-Path -LiteralPath $L.DataRoot) { 'todo' } else { 'done' } }
      Do = {
        $left = @(Get-ChildItem -LiteralPath $L.DataRoot -Force | Where-Object { $_.Name -ne 'install-manifest.json' })
        if ($left.Count -gt 0) { throw "$($L.DataRoot) still holds: $(($left | ForEach-Object { $_.Name }) -join ', '); left in place" }
        Remove-Item -LiteralPath $L.ManifestPath -Force; Remove-Item -LiteralPath $L.DataRoot -Force; Say '    manifest and data root removed' } }
  )
}
function Remove-HostServices {
  foreach ($spec in (Get-ServiceSpecs)) {
    if (@($script:Manifest['created']['services']) -notcontains $spec.Name) { continue }
    $facts = Get-ServiceFactsFor $spec.Name
    if (-not $facts.Exists) { continue }
    if ($facts.PathName -cne (Get-ServiceCommandLine $spec.Exe $spec.Config)) { Say "    WARNING: $($spec.Name) runs a different command line than install wrote; left alone"; continue }
    if ($facts.State -ne 'Stopped') { Invoke-Sc "stop $($spec.Name)" | Out-Null; if (-not (Wait-ServiceState $spec.Name @('Stopped') 30)) { throw "$($spec.Name) did not stop" } }
    Invoke-Sc "delete $($spec.Name)" | Out-Null
    if (-not (Wait-ServiceState $spec.Name @('Gone') 30)) { throw "$($spec.Name) is still marked for deletion; close tools that hold it (services.msc, Event Viewer) and run uninstall again" }
    $script:Manifest['created']['services'] = @($script:Manifest['created']['services'] | Where-Object { $_ -ne $spec.Name }); Save-Manifest
    Say "    deleted service $($spec.Name)"
  }
}
# Delete a folder this script made, after proving it holds only what it should: no link/junction, no file outside the known list (data) or the expected folders (install).
function Remove-HostTree([string]$Dir, [string[]]$AllowedTop, [string[]]$AllowedFolders, [bool]$InstallTree) {
  if (Test-HasReparsePoint $Dir) { throw "$Dir contains a link or junction; refusing to delete it" }
  $root = (Resolve-Path -LiteralPath $Dir).Path.TrimEnd('\')
  $rel = @(Get-ChildItem -LiteralPath $Dir -Recurse -Force | ForEach-Object { $_.FullName.Substring($root.Length + 1) })
  if ($InstallTree) {
    $unknown = @($rel | Where-Object { $p = $_; -not (@('bin', 'bin\broker', 'bin\authority', 'bin\pipe-client') -contains $p) -and -not (@('bin\broker\', 'bin\authority\', 'bin\pipe-client\') | Where-Object { $p.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) }) })
  }
  else {
    $prefix = $Dir.Substring($L.DataRoot.Length + 1)
    $unknown = @((Get-UnknownEntries ($rel | ForEach-Object { $prefix + '\' + $_ }) (Get-KnownDataFiles) (Get-KnownDataFolders)))
  }
  if ($unknown.Count -gt 0) { throw "$Dir holds files this script did not create ($($unknown -join ', ')); nothing was deleted there" }
  Remove-Item -LiteralPath $Dir -Recurse -Force
  Say "    removed $Dir"
}

# ---------------------------------------------------------------------------------------------- run
function Show-Plan([object[]]$Steps, [string]$Title) {
  Say "ALBERA host $Title - PLAN ONLY. Nothing is changed by this mode, and it needs no admin rights."
  Say "Computer: $env:COMPUTERNAME   elevated: $(if (Test-Elevated) { 'yes' } else { 'no (install and uninstall will refuse)' })   repo: $RepoRoot"
  Say "Install folder: $($L.InstallRoot)   data folder: $($L.DataRoot)   manifest: $(if ($script:Manifest) { "present (state $($script:Manifest['state']))" } else { 'none' })"
  $n = 0
  foreach ($s in $Steps) {
    $n++
    try { $state = & $s.Test } catch { $state = 'unknown:' + $_.Exception.Message }
    $label = if ($state -like 'blocked:*') { 'blocked' } elseif ($state -like 'unknown:*') { 'unknown' } else { $state }
    Say ('{0,3}. [{1}] {2}' -f $n, $label, $s.Title)
    if ($state -like 'blocked:*' -or $state -like 'unknown:*') { Say ('       reason: ' + $state.Substring($state.IndexOf(':') + 1)) }
    foreach ($d in $s.Detail) { Say "       $d" }
  }
  Say 'PLAN ONLY: nothing was changed.'
}

try {
  if (Test-Path -LiteralPath $L.ManifestPath) { $script:Manifest = Read-Manifest }
  switch ($Mode) {
    'status' { exit (Show-Status) }
    'plan' {
      if ($PlanFor -eq 'uninstall') { Show-Plan (Get-UninstallSteps) 'uninstall' } else { Show-Plan (Get-InstallSteps) 'install' }
      exit 0
    }
    'install' {
      if ($script:Manifest -and $script:Manifest['state'] -eq 'complete') {
        Say 'The install is already complete; checking it (nothing will be changed).'
        exit (Show-Status)
      }
      $n = 0
      foreach ($s in (Get-InstallSteps)) {
        $n++
        $state = & $s.Test
        if ($state -like 'blocked:*') { Stop-Refused ($state.Substring(8)) }
        if ($state -eq 'done') { Say ('{0,3}. [skip] {1} (already done)' -f $n, $s.Title); continue }
        Say ('{0,3}. {1}' -f $n, $s.Title)
        & $s.Do
      }
      if ($StartCheck) { Say '  Start check (starts each service once, then stops it):'; Invoke-StartCheck }
      Say ''
      Say 'Installed. The services are stopped (start=demand). Next, in this elevated console:'
      Say "  Start-Service $($K.BrokerService); Start-Service $($K.AuthorityService)"
      Say 'then see docs/architecture/host-install.md ("First approval") for albera-runtime approval-check.'
      exit 0
    }
    'uninstall' {
      if (-not $script:Manifest) { Say 'No install manifest found: this script did not install anything here, so it removes nothing.'; exit 0 }
      $n = 0
      foreach ($s in (Get-UninstallSteps)) {
        $n++
        if ((& $s.Test) -eq 'done') { Say ('{0,3}. [skip] {1} (nothing to do)' -f $n, $s.Title); continue }
        Say ('{0,3}. {1}' -f $n, $s.Title)
        & $s.Do
      }
      Say 'Uninstalled. Only what the manifest listed was removed.'
      exit 0
    }
  }
}
catch {
  Write-Host ('ERROR: ' + $_.Exception.Message + ' (script line ' + $_.InvocationInfo.ScriptLineNumber + ')')
  Write-Host 'Nothing else was changed after this point. Run -Mode status to see the state; run install again to continue, or uninstall to remove what was created.'
  exit 1
}
