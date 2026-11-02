# ALBERA host installer: puts the Host Broker and the Approval Authority on THIS Windows PC so the first real Windows Hello approval can happen.
# Windows PowerShell 5.1, ASCII only. Written for the owner to run in an elevated console (never self-elevating). Design notes: docs/architecture/host-install.md.
#
# Start it ALWAYS as   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1 <arguments>
# (the full path: cmd.exe looks in the current folder before PATH. -NoProfile skips profiles ONLY; user modules are handled by the script itself, see the first statements below.)
# install / uninstall: ONLY from an elevated `cmd /d` whose environment has no COR_* / COMPLUS_* / CORECLR_* variable (they load a DLL into powershell.exe before line 1),
# running a COPY of the two script files in C:\Program Files\AlberaSetup whose hashes you checked with certutil (host-install.md, "The elevated console").
#
#   albera-host.ps1                                           plan (default): numbered list of everything install would do; changes nothing, needs no admin
#   albera-host.ps1 -Mode plan -PlanFor uninstall             the same for uninstall
#   albera-host.ps1 -Mode hashes                              prints the per-file SHA-256 JSON and the line ALBERA_HOST_TREE_HASH=<hex> (for a CI run; NOT a proof by itself, see below)
#   albera-host.ps1 -Mode install -ExpectedTreeHash <64 hex> -ApproverKeyId <hello-...> -ApproverPublicKey <spki> -ApproverSid <S-1-5-21-...>
#                                                             install (elevated). Asks for the password of the new local account albera-cp.
#   albera-host.ps1 -Mode status                              read-only report of what is installed and whether it still matches (exit 1 on any difference)
#   albera-host.ps1 -Mode uninstall                           remove only what the install manifest says this script created (elevated)
#
# Attacker model: an AI agent running as the owner's NON-admin session. It can pre-create C:\ProgramData\Albera, plant a manifest or a junction there, rewrite every file
# in the repository working tree (the builds, their sidecar manifests, this script's own folder), and set user environment variables that an elevated console inherits. Therefore:
#   - nothing that already exists is trusted until it is owned by SYSTEM / Administrators, has no write right for anyone else, and is no link anywhere on its path;
#   - no environment variable decides a path: sc.exe, icacls.exe and the install roots come from [Environment]::SystemDirectory / GetFolderPath and are refused unless they are
#     C:\Windows\System32, C:\Program Files and C:\ProgramData; no executable is found through PATH;
#   - the three approver values come from the owner (who ran `AlberaApprover.exe enroll --show` in a NORMAL console); no program from the repository is ever started by this script;
#   - no user module can run in the elevated session: Windows PowerShell 5.1 searches ~\Documents\WindowsPowerShell\Modules and HKCU PSModulePath before its own folder, even with -NoProfile, and loads
#     CimCmdlets, LocalAccounts, Security, Utility and Management lazily. So the first statements switch auto-loading off, reset PSModulePath to $PSHOME\Modules and import the five modules by full path;
#   - the builds are accepted only when the tree hash of the COPIES (copied into an administrator-only folder first) equals -ExpectedTreeHash, a value the owner TYPES from the CI log
#     of the reviewed commit (a parameter, not a file: a file in Downloads can be rewritten together with the builds). Run this script itself from a reviewed checkout.
# install and uninstall refuse unless the console is elevated; they never elevate. A completed install re-run says so and changes nothing. A partial install is finished
# from where it stopped, or refused with the reason. Nothing secret is printed or stored: only public values (SIDs, public keys, hashes, paths).
# -ControlPlanePassword is for the disposable lab VM only and is refused unless the environment variable ALBERA_LAB_VM is 1.
[CmdletBinding()]
param(
  [ValidateSet('plan', 'install', 'uninstall', 'status', 'hashes')][string]$Mode = 'plan',
  [ValidateSet('install', 'uninstall')][string]$PlanFor = 'install',
  [string]$ApproverKeyId,
  [string]$ApproverPublicKey,
  [string]$ApproverSid,
  [string]$ExpectedTreeHash,
  [string]$RepoRoot,
  [string]$ProjectId,
  [string]$VmName,
  [string]$ComputerId,
  [switch]$StartCheck,
  [securestring]$ControlPlanePassword
)
# ---------------------------------------------------------------------------------------------- module hijack guard: these are the first statements, before anything can auto-load a module
# At this point only Microsoft.PowerShell.Core exists (Import-Module, Get-Module, Where-Object, ForEach-Object, Out-Null) and .NET: Write-Host, Join-Path, Test-Path, Get-Acl, ConvertTo-Json and the rest
# are auto-loaded from PSModulePath on first use, and that path begins with the user's own Documents\WindowsPowerShell\Modules (and whatever HKCU\Environment sets). So: no auto-loading, a module path that is
# only the system folder, and every module the script uses imported from its manifest under $PSHOME\Modules. Only .NET is used until the imports are done.
$PSModuleAutoLoadingPreference = 'None'
if (-not [string]::Equals($PSHOME.TrimEnd('\'), 'C:\Windows\System32\WindowsPowerShell\v1.0', [System.StringComparison]::OrdinalIgnoreCase)) {
  [Console]::WriteLine('REFUSED: this is not the Windows PowerShell 5.1 in C:\Windows\System32\WindowsPowerShell\v1.0 (' + $PSHOME + '); start it with that powershell.exe by its full path')
  exit 3
}
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
foreach ($moduleName in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security', 'CimCmdlets', 'Microsoft.PowerShell.LocalAccounts')) {
  $moduleDir = [System.IO.Path]::Combine($PSHOME, 'Modules', $moduleName)
  $manifestPath = [System.IO.Path]::Combine($moduleDir, $moduleName + '.psd1')
  if (-not [System.IO.File]::Exists($manifestPath)) {   # some modules sit in a version folder (LocalAccounts\1.0.0.0)
    $versionDirs = [System.IO.Directory]::GetDirectories($moduleDir)
    [System.Array]::Sort($versionDirs, [System.StringComparer]::Ordinal)
    $manifestPath = if ($versionDirs.Length -gt 0) { [System.IO.Path]::Combine($versionDirs[$versionDirs.Length - 1], $moduleName + '.psd1') } else { $manifestPath }
  }
  if (-not [System.IO.File]::Exists($manifestPath)) { [Console]::WriteLine('REFUSED: the system module ' + $moduleName + ' was not found under ' + $PSHOME); exit 3 }
  Import-Module -Name $manifestPath -DisableNameChecking -ErrorAction Stop
}
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'albera-host-lib.ps1')

$K = Get-HostConstants
$script:Manifest = $null
$script:ManifestNote = $null
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
# The script files as they are on disk now: compare with the ALBERA_HOST_SCRIPT_SHA256 lines of the CI run on main (docs/architecture/host-install.md). This detects a swap after the fact, it cannot prevent one.
function Get-ScriptFileHashes {
  foreach ($f in @($PSCommandPath, (Join-Path $PSScriptRoot 'albera-host-lib.ps1'))) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $stream = [System.IO.File]::OpenRead($f); try { Write-Host ('script ' + [System.IO.Path]::GetFileName($f) + ' sha256 ' + (([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant())) } finally { $stream.Dispose() } } finally { $sha.Dispose() }
  }
}
# Paths come from Windows, never from environment variables (HKCU\Environment can set them for a user's processes, and an elevated console started from that session inherits them).
$SystemDirectory = [Environment]::SystemDirectory
$ProgramFilesDir = [Environment]::GetFolderPath('ProgramFiles')
$ProgramDataDir = [Environment]::GetFolderPath('CommonApplicationData')
$ScExe = Join-Path $SystemDirectory 'sc.exe'
$IcaclsExe = Join-Path $SystemDirectory 'icacls.exe'
if ($Mode -in @('install', 'uninstall') -and -not (Test-Elevated)) { Stop-Refused "$Mode needs an elevated console (Run as administrator). This script never elevates itself." }
if ($ControlPlanePassword) {
  $gate = Test-LabPasswordGate $true $env:ALBERA_LAB_VM
  if ($gate) { Stop-Refused '-ControlPlanePassword is lab-only (disposable VM with ALBERA_LAB_VM=1)' 2 }
  if ($Mode -ne 'install') { Stop-Refused '-ControlPlanePassword only applies to -Mode install' 2 }
}
if ($ExpectedTreeHash -and -not (Test-TreeHashValue $ExpectedTreeHash)) { Stop-Refused '-ExpectedTreeHash must be 64 lowercase hex characters (the ALBERA_HOST_TREE_HASH value of the CI run)' 2 }
if ($ApproverKeyId -and -not (Test-HostId $ApproverKeyId)) { Stop-Refused '-ApproverKeyId is not a valid key id' 2 }
if ($ApproverPublicKey -and -not (Test-Rsa2048Spki $ApproverPublicKey)) { Stop-Refused '-ApproverPublicKey is not a base64 RSA-2048 SubjectPublicKeyInfo' 2 }
if ($ApproverSid -and -not (Test-AccountSidShape $ApproverSid)) { Stop-Refused '-ApproverSid is not an S-1-5-21-... user SID' 2 }
if (-not (Test-HostId $ProjectId) -or -not (Test-HostId $ComputerId) -or $VmName -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') { Stop-Refused '-ProjectId, -VmName or -ComputerId is not a valid id' 2 }
if ($PSVersionTable.PSVersion.Major -ne 5) { Stop-Refused 'Windows PowerShell 5.1 is required' }
if (-not [Environment]::Is64BitProcess) { Stop-Refused 'a 64-bit PowerShell is required' }
$folderReasons = Test-FixedFolders $SystemDirectory $ProgramFilesDir $ProgramDataDir
if ($folderReasons.Count -gt 0) { Stop-Refused ("Windows reports a non-standard system folder ($($folderReasons -join ', ')); this script only works with C:\Windows\System32, C:\Program Files and C:\ProgramData") }
$L = Get-HostLayout $ProgramFilesDir $ProgramDataDir
foreach ($p in @($L.BrokerExe, $L.AuthorityExe, $L.PipeClientExe, $L.BrokerConfig, $L.AuthorityConfig, $L.ApprovalSettings, $L.BrokerDb, $L.ControlPlaneJournal)) {
  if (-not (Test-PlainAbsolutePath $p)) { Stop-Refused 'an install path is not a plain absolute path (the services refuse such paths)' }
}

# ---------------------------------------------------------------------------------------------- helpers that touch the system
# The only programs this script ever starts are sc.exe and icacls.exe, by their full System32 paths. Nothing from the repository is executed.
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
# True when the folder ITSELF or anything under it is a link, junction or mount point (attributes only; nothing is followed).
function Test-HasReparsePoint([string]$Dir) {
  if (([System.IO.File]::GetAttributes($Dir) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
  $bad = @(Get-ChildItem -LiteralPath $Dir -Recurse -Force -ErrorAction Stop | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint })
  $bad.Count -gt 0
}
# Every entry under a folder with its path relative to that folder. The relative path is built while walking, never by cutting the folder's
# length off FullName: a short 8.3 name (C:\Users\RUNNER~1\...) and its long form differ in length (found on the CI runner). Links are listed, not entered.
function Get-TreeEntries([string]$Dir, [switch]$FilesOnly) {
  $out = New-Object 'System.Collections.Generic.List[object]'
  $stack = New-Object 'System.Collections.Generic.Stack[object]'
  $stack.Push([pscustomobject]@{ Info = (New-Object System.IO.DirectoryInfo($Dir)); Prefix = '' })
  while ($stack.Count -gt 0) {
    $item = $stack.Pop()
    foreach ($e in $item.Info.GetFileSystemInfos()) {
      $rel = if ($item.Prefix) { $item.Prefix + '\' + $e.Name } else { $e.Name }
      $isDir = ($e.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0
      if (-not ($isDir -and $FilesOnly)) { $out.Add([pscustomobject]@{ Rel = $rel; Full = $e.FullName; IsDir = $isDir }) }
      if ($isDir -and (($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)) { $stack.Push([pscustomobject]@{ Info = $e; Prefix = $rel }) }
    }
  }
  , $out.ToArray()
}
# Relative path and SHA-256 of every file under a folder (sorted, ordinal); the tree hash is the SHA-256 of those lines.
function Get-TreeHashes([string]$Dir) {
  $files = Get-TreeEntries $Dir -FilesOnly
  $entries = foreach ($f in $files) { [pscustomobject]@{ Rel = $f.Rel; Sha = (Get-Sha256File $f.Full) } }
  $list = New-Object 'System.Collections.Generic.List[object]'
  foreach ($e in $entries) { $list.Add($e) }
  $list.Sort([Comparison[object]]{ param($a, $b) [string]::CompareOrdinal($a.Rel, $b.Rel) })
  $sorted = $list.ToArray()
  $text = ($sorted | ForEach-Object { $_.Rel + "`t" + $_.Sha + "`n" }) -join ''
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $tree = ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text))) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  [pscustomobject]@{ Files = $sorted; Tree = $tree }
}
# icacls on an EXISTING folder that already passed the trust checks. /L: act on a link itself, never on its target.
function Set-HostAcl($Entry) {
  $args1 = (Quote-NativeArg $Entry.Path) + ' /inheritance:r'
  foreach ($g in $Entry.Grants) { $args1 += ' /grant:r ' + $g }
  $r = Invoke-Native $IcaclsExe ($args1 + ' /L')
  if ($r.Exit -ne 0) { throw "icacls failed for $($Entry.Path)" }
  $o = Invoke-Native $IcaclsExe ((Quote-NativeArg $Entry.Path) + ' /setowner *S-1-5-32-544 /L')
  if ($o.Exit -ne 0) { throw "icacls /setowner failed for $($Entry.Path)" }
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
# A manifest is read only when C:\ProgramData\Albera and the manifest file are owned by SYSTEM / Administrators, writable by nobody else, and reached through no link; and its content has the
# shape this script writes (fixed service, user and key names). install / uninstall refuse otherwise; plan / status (no admin rights, so the ACLs cannot be read) ignore it and say so.
function Initialize-Manifest {
  if (-not (Test-Path -LiteralPath $L.ManifestPath)) { return }
  $mutating = $Mode -in @('install', 'uninstall')
  $reasons = @()
  $reasons += Get-PathTrustReasons $L.DataRoot (Get-AdminSids) $true
  $reasons += Get-PathTrustReasons $L.ManifestPath (Get-AdminSids) $false
  if ($reasons.Count -gt 0) {
    $why = Format-TrustRefusal $L.ManifestPath $reasons
    if ($mutating) { Stop-Refused $why }
    $script:ManifestNote = "an install manifest is present but is NOT trusted or cannot be verified without admin rights ($($reasons -join ', ')); it is ignored"
    return
  }
  try { $m = $serializer.DeserializeObject([System.IO.File]::ReadAllText($L.ManifestPath)) } catch { $m = $null }
  $shape = Test-ManifestShape $m
  if ($shape.Count -gt 0) {
    $why = "the install manifest is not one this script wrote ($($shape -join ', '))"
    if ($mutating) { Stop-Refused ($why + '; nothing was changed') }
    $script:ManifestNote = $why + '; it is ignored'
    return
  }
  $script:Manifest = $m
}
# Read with JavaScriptSerializer (plain dictionaries and arrays), written with ConvertTo-Json: JavaScriptSerializer cannot write PowerShell-wrapped objects.
function Save-Manifest {
  $script:Manifest['updatedAt'] = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $tmp = $L.ManifestPath + '.tmp'
  [System.IO.File]::WriteAllText($tmp, ($script:Manifest | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $L.ManifestPath -Force
}
function Read-Manifest {
  if (-not (Test-Path -LiteralPath $L.ManifestPath)) { return $null }
  $serializer.DeserializeObject([System.IO.File]::ReadAllText($L.ManifestPath))
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

# ---------------------------------------------------------------------------------------------- the builds this script copies, and what they must hash to
function Get-BuildSources {
  $r = $RepoRoot
  @(
    [pscustomobject]@{ Name = 'broker'; Dir = Join-Path $r 'src\runtime\windows-broker\bin\Release\net10.0-windows\win-x64\publish'; Exe = 'albera-windows-broker.exe'; Dest = $L.BrokerBinDir; Build = 'npm run build:windows-broker' }
    [pscustomobject]@{ Name = 'authority'; Dir = Join-Path $r 'src\runtime\windows-approval-authority\bin\Release\net10.0-windows\win-x64\publish'; Exe = 'albera-approval-authority.exe'; Dest = $L.AuthorityBinDir; Build = 'npm run build:approval-authority' }
    [pscustomobject]@{ Name = 'pipe-client'; Dir = Join-Path $r 'src\runtime\windows-broker-pipe-client\bin\Release\net10.0-windows\win-x64\publish'; Exe = 'albera-windows-broker-pipe-client.exe'; Dest = $L.PipeClientBinDir; Build = 'npm run build:windows-broker' }
  )
}
# -ExpectedTreeHash: typed by the owner from the CI log. @{ Ok; Reason; Value }
function Get-ExpectedTreeHashState {
  if (-not $ExpectedTreeHash) { return [pscustomobject]@{ Ok = $false; Reason = '-ExpectedTreeHash <64 hex> is required: type the ALBERA_HOST_TREE_HASH value from the CI log of the reviewed commit. A hash computed from this working tree proves nothing: a non-admin can rewrite the builds.'; Value = $null } }
  if (-not (Test-TreeHashValue $ExpectedTreeHash)) { return [pscustomobject]@{ Ok = $false; Reason = '-ExpectedTreeHash must be 64 lowercase hex characters'; Value = $null } }
  [pscustomobject]@{ Ok = $true; Reason = ''; Value = $ExpectedTreeHash }
}
# component name -> relative path -> SHA-256, for the three folders given (publish folders or installed copies); the canonical tree hash is made from this by ONE function (Get-CanonicalTreeHash).
function Get-ComponentHashes($Dirs) {
  $components = @{}
  foreach ($name in $script:HashComponents) { $h = @{}; foreach ($f in (Get-TreeHashes $Dirs[$name]).Files) { $h[$f.Rel] = $f.Sha }; $components[$name] = $h }
  $components
}
# Source files, listed without following anything: a link or junction in the publish folder is refused.
function Get-SourceFiles([string]$Dir) {
  if (Test-HasReparsePoint $Dir) { throw "$Dir contains a link or junction" }
  $files = Get-TreeEntries $Dir -FilesOnly
  @($files | ForEach-Object { [pscustomobject]@{ Rel = $_.Rel; Full = $_.Full } })
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
# The live Control Plane account as the ownership check wants it, or $null.
function Get-LiveControlPlaneUser {
  $u = Get-LocalUser -Name $K.ControlPlaneUser -ErrorAction SilentlyContinue
  if (-not $u) { return $null }
  [pscustomobject]@{ Name = $u.Name; Sid = $u.SID.Value; Description = $u.Description; Enabled = $u.Enabled }
}
# Throws (with the refusal text) when an existing planned path is not trustworthy. Missing paths are fine: they are created.
function Assert-PlannedPathTrusted($Entry) {
  if (-not (Test-Path -LiteralPath $Entry.Path)) { return }
  $reasons = Get-PathTrustReasons $Entry.Path (Get-PlannedWriters $Entry) $true
  if ($reasons.Count -gt 0) { throw (Format-TrustRefusal $Entry.Path $reasons) }
}

# ---------------------------------------------------------------------------------------------- install steps: each has a read-only Test (-> done / todo / blocked:<why> / unknown:<why>) and a Do
function Get-InstallSteps {
  @(
    [pscustomobject]@{ Id = 'sources'; Title = 'Check -ExpectedTreeHash (the tree hash of the reviewed build, typed from the CI log) and list the three publish folders; nothing in the repository is executed'
      Detail = @("publish folders are read from $RepoRoot\src\runtime\...\publish (npm run build:windows-broker, npm run build:approval-authority); the COPIES are hashed later and their tree hash must equal the value you typed", 'a link or junction in a publish folder is refused')
      Test = {
        $st = Get-ExpectedTreeHashState; if (-not $st.Ok) { return 'blocked:' + $st.Reason }
        foreach ($s in (Get-BuildSources)) {
          if (-not [System.IO.Directory]::Exists($s.Dir)) { return "blocked:$($s.Name): publish folder missing (run $($s.Build))" }
          if (Test-HasReparsePoint $s.Dir) { return "blocked:$($s.Name): the publish folder contains a link or junction" }
        }
        'todo' }
      Do = { Say '    -ExpectedTreeHash given; the three publish folders exist and hold no links' } }
    [pscustomobject]@{ Id = 'approver'; Title = 'Check the approver values you pass (-ApproverKeyId, -ApproverPublicKey, -ApproverSid, from your own "AlberaApprover.exe enroll --show" in a normal console)'
      Detail = @('the key id must be a valid id; the public key an RSA-2048 SPKI; the SID an S-1-5-21 user SID that differs from albera-cp', 'this script does not run the approver program: it would run elevated')
      Test = {
        if (-not $ApproverKeyId -or -not $ApproverPublicKey -or -not $ApproverSid) { return 'blocked:-ApproverKeyId, -ApproverPublicKey and -ApproverSid are all required for install' }
        'todo' }
      Do = { Set-ApproverValues } }
    [pscustomobject]@{ Id = 'dataroot'; Title = "Create $($L.DataRoot) (SYSTEM and Administrators only, born with that ACL and read back before anything else) and the install manifest"
      Detail = @("manifest: $($L.ManifestPath) lists exactly what this script creates; uninstall removes only that", 'an existing folder of that name is never adopted')
      Test = {
        if ($script:Manifest) { return 'done' }
        if ($script:ManifestNote) { return 'blocked:' + $script:ManifestNote }
        if (Test-Path -LiteralPath $L.DataRoot) { return 'blocked:' + $L.DataRoot + ' exists but was not created by this script (Users can create folders there, so anyone may have made it); inspect it, delete it as an administrator, run again' }
        'todo' }
      Do = {
        New-TrustedDirectory $L.DataRoot @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
        $script:Manifest = New-Manifest; Save-Manifest; Say "    created $($L.DataRoot)" } }
    [pscustomobject]@{ Id = 'user'; Title = "Create the local standard user $($K.ControlPlaneUser) (BUILTIN\Users only, not Administrators); you type its password"
      Detail = @('PROVISIONAL Control Plane identity: the Authority refuses one SID for both pipes and the approver SID is your own account', 'the password is read as a SecureString, used once for New-LocalUser, never stored, printed or logged')
      Test = {
        $live = Get-LiveControlPlaneUser
        if ($live -and (Test-ManifestHas 'user') -and (Test-OwnedUser $script:Manifest['created']['user'] $live).Count -eq 0) { return 'done' }
        if ($live) { return "blocked:a local user named $($K.ControlPlaneUser) already exists and was not created by this script; it is never adopted" }
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
    [pscustomobject]@{ Id = 'folders'; Title = "Create the folders, each born with its final ACL (inheritance removed) and read back: $($L.InstallRoot); $($L.DataRoot)\{broker-config,broker,authority,control-plane}"
      Detail = @('SYSTEM and Administrators full everywhere; Broker SID Modify on broker\ only; Authority SID Modify on authority\ only; albera-cp Modify on control-plane\ only', 'an existing folder is used only if it is owned by SYSTEM/Administrators, has no other writer and is reached through no link; otherwise the run stops')
      Test = {
        if (-not (Test-ManifestHas 'user') -or -not (Test-ManifestHas 'services')) { return 'todo' }
        if ((Test-Path -LiteralPath $L.InstallRoot) -and -not (Test-ManifestHas 'installRoot')) { return 'blocked:' + $L.InstallRoot + ' exists but was not created by this script; inspect it, delete it as an administrator, run again' }
        Resolve-HostSids
        foreach ($e in (Get-AclPlan $L $script:Sids)) {
          if (-not (Test-Path -LiteralPath $e.Path)) { return 'todo' }
          $r = Get-PathTrustReasons $e.Path (Get-PlannedWriters $e) $true
          if ($r.Count -gt 0) { return 'blocked:' + (Format-TrustRefusal $e.Path $r) }
          if ((Test-AclMatchesPlan $e (Get-AclSummary $e.Path)).Count -gt 0) { return 'todo' }
        }
        'done' }
      Do = { New-HostFolders } }
    [pscustomobject]@{ Id = 'binaries'; Title = "Copy the three builds into $($L.BinRoot)\{broker,authority,pipe-client} (already administrator-only), then hash the COPIES and require their tree hash to equal -ExpectedTreeHash"
      Detail = @('copied to .partial folders, hashed there; any difference from -ExpectedTreeHash (a missing, extra, moved or changed file) deletes all three copies and stops; only then are they renamed', 'an existing copy that does not match, or a half-copied bin folder, is refused (update = uninstall + install)')
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
    [pscustomobject]@{ Id = 'configs'; Title = "Write the Broker config, the Authority config and the Control Plane settings (an existing file must pass the same trust checks and is overwritten)"
      Detail = @($L.BrokerConfig, $L.AuthorityConfig, "$($L.ApprovalSettings)  (attestation null; computers: $VmName -> $ComputerId, project $ProjectId)", 'no policy.json is written: the Authority starts at tier careful (every action needs a person)', 'service-check is not run: from an elevated console it cannot judge a config (config_untrusted), and it would execute a build; the first service start is the real test')
      Test = { if ((Test-Path -LiteralPath $L.BrokerConfig) -and (Test-Path -LiteralPath $L.AuthorityConfig) -and (Test-Path -LiteralPath $L.ApprovalSettings)) { 'done' } else { 'todo' } }
      Do = { Write-HostConfigs } }
    [pscustomobject]@{ Id = 'finish'; Title = 'Record the install as complete in the manifest (services stay stopped)'
      Detail = @()
      Test = { if ($script:Manifest -and $script:Manifest['state'] -eq 'complete') { 'done' } else { 'todo' } }
      Do = { $script:Manifest['state'] = 'complete'; Save-Manifest; Say '    install complete' } }
  )
}

function Set-ApproverValues {
  $shown = [pscustomobject]@{ approverPublicKey = $ApproverPublicKey; approverKeyId = $ApproverKeyId; approverSid = $ApproverSid }
  $cp = if ($script:Manifest -and (Test-ManifestHas 'user')) { $script:Manifest['created']['user']['sid'] } else { $null }
  $reasons = Test-ApproverValues $shown $ApproverKeyId $cp
  if ($reasons.Count -gt 0) { Stop-Refused ('approver values rejected: ' + ($reasons -join ', ')) }
  $script:Approver = $shown
  Say "    approver key id $ApproverKeyId, approver SID $ApproverSid"
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
    New-LocalUser -Name $K.ControlPlaneUser -Password $password -FullName 'ALBERA Control Plane' -Description $K.ControlPlaneUserDescription -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires | Out-Null
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

# A folder born with its final descriptor (New-SecuredDirectory reads back owner, protected DACL and accounts) and then re-checked with the SAME trust test used for existing folders (owner SYSTEM/Administrators,
# no other writer, no link on the way). Throws before any later step - user, services, Save-Manifest - can run on a folder that is not what was asked for.
function New-TrustedDirectory([string]$Path, [string[]]$Grants, [string]$OwnerSid = 'S-1-5-32-544') {
  New-SecuredDirectory $Path $Grants $OwnerSid
  $reasons = Get-PathTrustReasons $Path (Get-PlannedWriters ([pscustomobject]@{ Grants = $Grants })) $true
  if ($reasons.Count -gt 0) { throw (Format-TrustRefusal $Path $reasons) }
}
# Every folder is created WITH its final security descriptor (owner Administrators, protected DACL), so there is no moment with an inherited ACL. A folder that already exists is used only after
# it passed the trust checks (owner, writers, no link on the way); only then is its ACL brought to the plan, with icacls /L.
function New-HostFolders {
  Resolve-HostSids
  if ((Test-Path -LiteralPath $L.InstallRoot) -and -not (Test-ManifestHas 'installRoot')) { throw ($L.InstallRoot + ' exists but was not created by this script') }
  $plan = @(Get-AclPlan $L $script:Sids)
  foreach ($entry in $plan) { Assert-PlannedPathTrusted $entry }
  foreach ($entry in $plan) {
    if (Test-Path -LiteralPath $entry.Path) { Set-HostAcl $entry; continue }
    New-TrustedDirectory $entry.Path $entry.Grants
    if ($entry.Path -ceq $L.InstallRoot) { $script:Manifest['created']['installRoot'] = $true; Save-Manifest }
  }
  foreach ($entry in $plan) {
    $diffs = Test-AclMatchesPlan $entry (Get-AclSummary $entry.Path)
    if ($diffs.Count -gt 0) { throw "ACL of $($entry.Path) is not as planned: $($diffs -join ', ')" }
  }
  Say '    folders created with their final ACL; every ACL read back and matches the plan'
}

# The copies are made INSIDE the already administrator-only bin folder and only the COPIES are hashed: all three components are copied to .partial folders, the canonical tree hash of the copies must equal
# -ExpectedTreeHash, and only then are they renamed. On any difference all copies are deleted and the run stops. (A hash of the source would prove nothing: it can change between hashing and copying, and the
# tree is writable by a non-admin.) Existing copies: all three must be there and hash to the same value; a half-copied bin folder is refused.
function Copy-HostBinaries {
  $state = Get-ExpectedTreeHashState
  if (-not $state.Ok) { throw $state.Reason }
  $sources = @(Get-BuildSources)
  $record = $script:Manifest['created']['binaries']
  $present = @($sources | Where-Object { Test-Path -LiteralPath $_.Dest })
  if ($present.Count -eq $sources.Count) {
    foreach ($s in $sources) {
      $untrusted = Get-PathTrustReasons $s.Dest (Get-AdminSids) $false
      if ($untrusted.Count -gt 0) { throw (Format-TrustRefusal $s.Dest $untrusted) }
    }
    $dirs = @{}; foreach ($s in $sources) { $dirs[$s.Name] = $s.Dest }
    $have = Get-ComponentHashes $dirs
    $tree = Get-CanonicalTreeHash $have
    if ($tree -cne $state.Value) { throw "the installed copies hash to $tree, not to -ExpectedTreeHash; update means uninstall, then install" }
    foreach ($s in $sources) { if (-not $record.ContainsKey($s.Name)) { Set-BinaryRecord $s (Get-TreeHashes $s.Dest) } }
    return
  }
  if ($present.Count -gt 0) { throw "$($L.BinRoot) holds only part of the builds; uninstall, then install again" }
  $listings = @{}
  foreach ($s in $sources) { $listings[$s.Name] = Get-SourceFiles $s.Dir }   # refuses a link or junction in a publish folder
  foreach ($s in $sources) {
    $partial = $s.Dest + '.partial'
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Recurse -Force }   # left by a failed run of this script, inside the administrator-only bin folder
  }
  $partials = @{}
  try {
    foreach ($s in $sources) {
      $partial = $s.Dest + '.partial'
      foreach ($f in $listings[$s.Name]) {
        $target = Join-Path $partial $f.Rel
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        [System.IO.File]::Copy($f.Full, $target, $false)
      }
      $partials[$s.Name] = $partial
    }
    $copied = Get-ComponentHashes $partials
    $tree = Get-CanonicalTreeHash $copied
    if ($tree -cne $state.Value) {
      throw "the copies of the builds hash to $tree, not to -ExpectedTreeHash; the copies were deleted. The build in the working tree is not the reviewed one (or it is not reproducible on this PC)."
    }
  }
  catch {
    foreach ($s in $sources) { if (Test-Path -LiteralPath ($s.Dest + '.partial')) { Remove-Item -LiteralPath ($s.Dest + '.partial') -Recurse -Force } }
    throw
  }
  foreach ($s in $sources) { Move-Item -LiteralPath ($s.Dest + '.partial') -Destination $s.Dest }
  foreach ($s in $sources) { Set-BinaryRecord $s (Get-TreeHashes $s.Dest) }
  Say "    all three builds match -ExpectedTreeHash $tree"
}
function Set-BinaryRecord($Source, $Hashes) {
  $exeSha = ($Hashes.Files | Where-Object { $_.Rel -eq $Source.Exe }).Sha
  $rec = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $rec['exeSha256'] = $exeSha; $rec['treeSha256'] = $Hashes.Tree; $rec['files'] = $Hashes.Files.Count
  $script:Manifest['created']['binaries'][$Source.Name] = $rec; Save-Manifest
  Say "    $($Source.Name): $($Hashes.Files.Count) files; exe sha256 $exeSha"
}

function New-HostSigningKey {
  Resolve-HostSids
  $made = New-AuthoritySigningKey $K.SigningKeyName $script:Sids.Authority 'machine'
  $rec = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $rec['name'] = $K.SigningKeyName; $rec['provider'] = $K.SigningKeyProvider
  $script:Manifest['created']['key'] = $rec; $script:Manifest['values']['authoritySpki'] = $made.spki; Save-Manifest
  Say "    key created and read back (export policy $($made.report.exportPolicy), allowed: $($made.report.allowSids -join ', ')); public key $($made.spki)"
}

# A file that already exists must pass the trust checks (owner, writers, no link) and is then OVERWRITTEN: identical content does not make an attacker-owned file ours.
function Write-OneConfig([string]$Path, [string]$Text, [string[]]$Writers) {
  if (Test-Path -LiteralPath $Path) {
    $reasons = Get-PathTrustReasons $Path $Writers $false
    if ($reasons.Count -gt 0) { throw (Format-TrustRefusal $Path $reasons) }
  }
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
  $o = Invoke-Native $IcaclsExe ((Quote-NativeArg $Path) + ' /setowner *S-1-5-32-544 /L')
  if ($o.Exit -ne 0) { throw "icacls /setowner failed for $Path" }
  $after = Get-PathTrustReasons $Path $Writers $false
  if ($after.Count -gt 0) { throw (Format-TrustRefusal $Path $after) }
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
  $plan = @(Get-AclPlan $L $script:Sids)
  $writersOf = { param($dir) Get-PlannedWriters ($plan | Where-Object { $_.Path -ceq $dir } | Select-Object -First 1) }
  Write-OneConfig $L.BrokerConfig $brokerJson (& $writersOf $L.BrokerConfigDir)
  Write-OneConfig $L.AuthorityConfig $authorityJson (& $writersOf $L.AuthorityDir)
  Write-OneConfig $L.ApprovalSettings $settingsJson (& $writersOf $L.ControlPlaneDir)
  $values = $script:Manifest['values']
  $values['controlPlaneSid'] = $cp; $values['approverSid'] = $script:Approver.approverSid; $values['approverKeyId'] = $script:Approver.approverKeyId
  $values['brokerServiceSid'] = $script:Sids.Broker; $values['authorityServiceSid'] = $script:Sids.Authority; Save-Manifest
  Say '    configs written and re-checked; service-check was NOT run (see the plan); the first service start is the real test'
}

# Optional (-StartCheck): the one real test of the configs. Start each INSTALLED (hash-verified, administrator-only) service once, see whether it stays up, stop it again.
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

# ---------------------------------------------------------------------------------------------- hashes (a tool for the CI run, not a proof)
function Show-Hashes {
  $dirs = @{}
  foreach ($s in (Get-BuildSources)) {
    if (-not [System.IO.Directory]::Exists($s.Dir)) { Stop-Refused "$($s.Name): publish folder missing (run $($s.Build))" }
    if (Test-HasReparsePoint $s.Dir) { Stop-Refused "$($s.Name): the publish folder contains a link or junction" }
    $dirs[$s.Name] = $s.Dir
  }
  $hashes = Get-ComponentHashes $dirs
  $tree = Get-CanonicalTreeHash $hashes
  $components = [ordered]@{}
  foreach ($name in $script:HashComponents) {
    $files = [ordered]@{}
    foreach ($rel in ($hashes[$name].Keys | Sort-Object { $_.Replace('\', '/') } )) { $files[$rel.Replace('\', '/')] = $hashes[$name][$rel] }
    $components[$name] = [ordered]@{ files = $files }
  }
  Write-Output (ConvertTo-Json -InputObject ([ordered]@{ version = 1; treeHash = $tree; components = $components }) -Depth 6 -Compress)
  Write-Output "ALBERA_HOST_TREE_HASH=$tree"
}

# ---------------------------------------------------------------------------------------------- status
function Get-StatusLines {
  $lines = New-Object System.Collections.Generic.List[object]
  function Add-Line([string]$State, [string]$Text) { $lines.Add([pscustomobject]@{ State = $State; Text = $Text }) }
  if ($script:ManifestNote) { Add-Line 'unknown' $script:ManifestNote; return , $lines.ToArray() }
  if (-not $script:Manifest) { return , $lines.ToArray() }
  $M = $script:Manifest
  Add-Line $(if ($M['state'] -eq 'complete') { 'ok' } else { 'FAIL' }) "install state: $($M['state'])"
  try {
    Resolve-HostSids
    if ($M['created'].ContainsKey('user')) {
      $live = Get-LiveControlPlaneUser
      $why = Test-OwnedUser $M['created']['user'] $live
      $admins = @(Get-LocalGroupMemberSids 'S-1-5-32-544')
      $good = ($why.Count -eq 0) -and $live.Enabled -and ($admins -notcontains $live.Sid)
      Add-Line $(if ($good) { 'ok' } else { 'FAIL' }) ("user $($K.ControlPlaneUser): " + $(if ($good) { 'present, enabled, not an Administrator, description and SID as recorded' } else { ($why -join ', ') + ' (or disabled / an Administrator)' }))
    }
    foreach ($spec in (Get-ServiceSpecs)) {
      $facts = Get-ServiceFactsFor $spec.Name
      $bad = Test-ServiceFacts $facts $spec.Name (Get-ServiceCommandLine $spec.Exe $spec.Config)
      if ($spec.Name -eq $K.BrokerService -and $facts.Exists) {
        # Assign first: the test functions return , @(list), and @(call) would keep the outer array, so an empty result would count as one item.
        $badSd = Test-ServiceSdMatches (Invoke-Native $ScExe "sdshow $($spec.Name)").Out.Trim() $script:Sids.ControlPlane
        $bad = @($bad) + @($badSd)
      }
      Add-Line $(if ($bad.Count -eq 0) { 'ok' } else { 'FAIL' }) ("service $($spec.Name): " + $(if ($bad.Count -eq 0) { "as installed (state $($facts.State))" } else { $bad -join ', ' }))
    }
    foreach ($entry in (Get-AclPlan $L $script:Sids)) {
      if (-not (Test-Path -LiteralPath $entry.Path)) { Add-Line 'FAIL' "folder $($entry.Path): missing"; continue }
      $chain = Get-ReparseChain $entry.Path
      if ($chain.Count -gt 0) { Add-Line 'FAIL' "folder $($entry.Path): reached through a link ($($chain -join ', '))"; continue }
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
# Uninstall acts on FIXED names only (the two services, the one key, the one account, the two roots), and only when the (trusted) manifest also lists them.
function Get-UninstallSteps {
  @(
    [pscustomobject]@{ Id = 'services'; Title = "Stop and delete the services this script created ($($K.BrokerService), $($K.AuthorityService))"; Detail = @('a service whose command line is not the one install wrote is left alone and reported')
      Test = { $mine = if (Test-ManifestHas 'services') { @($script:Manifest['created']['services']) } else { @() }; if (@(Get-ServiceSpecs | Where-Object { $mine -contains $_.Name } | Where-Object { Get-CimInstance Win32_Service -Filter "Name='$($_.Name)'" }).Count -gt 0) { 'todo' } else { 'done' } }
      Do = { Remove-HostServices } }
    [pscustomobject]@{ Id = 'key'; Title = "Delete the machine signing key $($K.SigningKeyName) (only if this script created it)"; Detail = @()
      Test = { if ((Test-ManifestHas 'key') -and ($script:Manifest['created']['key']['name'] -ceq $K.SigningKeyName) -and (Test-AuthoritySigningKeyExists $K.SigningKeyName)) { 'todo' } else { 'done' } }
      Do = { Remove-AuthoritySigningKey $K.SigningKeyName | Out-Null; $script:Manifest['created'].Remove('key') | Out-Null; Save-Manifest; Say '    key deleted' } }
    [pscustomobject]@{ Id = 'installroot'; Title = "Remove $($L.InstallRoot) (the copied builds)"; Detail = @('refused if it holds anything but the three build folders, a link, or if it no longer passes the trust checks')
      Test = { if ((Test-ManifestHas 'installRoot') -and (Test-Path -LiteralPath $L.InstallRoot)) { 'todo' } else { 'done' } }
      Do = { Remove-TrustedTree $L.InstallRoot @('bin') @('bin\broker', 'bin\authority', 'bin\pipe-client') $true; $script:Manifest['created']['installRoot'] = $false; Save-Manifest } }
    [pscustomobject]@{ Id = 'data'; Title = "Remove the data folders under $($L.DataRoot) (configs, databases, policy.json, settings; the manifest goes last)"; Detail = @('refused for any folder that holds a file this script does not know, a link, or an untrusted owner / writer')
      Test = { if (Test-Path -LiteralPath $L.BrokerDbDir) { 'todo' } elseif (Test-Path -LiteralPath $L.AuthorityDir) { 'todo' } elseif (Test-Path -LiteralPath $L.BrokerConfigDir) { 'todo' } elseif (Test-Path -LiteralPath $L.ControlPlaneDir) { 'todo' } else { 'done' } }
      Do = { foreach ($d in @($L.BrokerConfigDir, $L.BrokerDbDir, $L.AuthorityDir, $L.ControlPlaneDir)) { if (Test-Path -LiteralPath $d) { Remove-TrustedTree $d @() @() $false } } } }
    [pscustomobject]@{ Id = 'user'; Title = "Remove the local user $($K.ControlPlaneUser) (only if its name, description and SID are exactly what install set; its profile folder, if any, is left)"; Detail = @('any other account, whatever the manifest says, is never touched')
      Test = { if (Test-ManifestHas 'user') { 'todo' } else { 'done' } }
      Do = {
        $rec = $script:Manifest['created']['user']
        $why = Test-OwnedUser $rec (Get-LiveControlPlaneUser)
        if ($why.Count -eq 0) { Remove-LocalUser -SID (New-Object System.Security.Principal.SecurityIdentifier($rec['sid'])); Say "    removed $($K.ControlPlaneUser)" }
        else { Say "    WARNING: the account is NOT removed ($($why -join ', ')); remove it yourself if it is yours" }
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
# Delete a folder this script made, after proving it holds only what it should: no link/junction (the folder itself included), no file outside the known list (data) or the expected folders (install).
function Remove-HostTree([string]$Dir, [string[]]$AllowedTop, [string[]]$AllowedFolders, [bool]$InstallTree) {
  if (Test-HasReparsePoint $Dir) { throw "$Dir is or contains a link or junction; refusing to delete it" }
  $all = Get-TreeEntries $Dir
  $rel = @($all | ForEach-Object { $_.Rel })
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
# Only the two fixed roots and their planned sub-folders, and only when they still pass the trust checks (owner, writers, no link on the way).
function Remove-TrustedTree([string]$Dir, [string[]]$AllowedTop, [string[]]$AllowedFolders, [bool]$InstallTree) {
  Resolve-HostSids
  $entry = Get-AclPlan $L $script:Sids | Where-Object { $_.Path -ceq $Dir } | Select-Object -First 1
  if (-not $entry) { throw "$Dir is not one of the folders this script creates; refusing to delete it" }
  $reasons = Get-PathTrustReasons $Dir (Get-PlannedWriters $entry) $true
  if ($reasons.Count -gt 0) { throw (Format-TrustRefusal $Dir $reasons) }
  Remove-HostTree $Dir $AllowedTop $AllowedFolders $InstallTree
}

# ---------------------------------------------------------------------------------------------- run
function Show-Plan([object[]]$Steps, [string]$Title) {
  Say "ALBERA host $Title - PLAN ONLY. Nothing is changed by this mode, and it needs no admin rights."
  Say "Computer: $([Environment]::MachineName)   elevated: $(if (Test-Elevated) { 'yes' } else { 'no (install and uninstall will refuse)' })   repo: $RepoRoot"
  Say "Install folder: $($L.InstallRoot)   data folder: $($L.DataRoot)   manifest: $(if ($script:Manifest) { "present (state $($script:Manifest['state']))" } elseif ($script:ManifestNote) { 'present but ignored (see below)' } else { 'none' })"
  if ($script:ManifestNote) { Say "NOTE: $($script:ManifestNote)" }
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
  if ($Mode -in @('install', 'uninstall')) { Get-ScriptFileHashes }
  if ($Mode -ne 'hashes') { Initialize-Manifest }
  switch ($Mode) {
    'hashes' { Show-Hashes; exit 0 }
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
