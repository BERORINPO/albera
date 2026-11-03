# ALBERA host installer: puts the Host Broker, the Approval Authority and the Control Plane service (the room, Claude Code as the hands; docs/architecture/control-plane-service.md) on THIS Windows PC so the first real Windows Hello approval can happen.
# Windows PowerShell 5.1, ASCII only. Written for the owner to run in an elevated console (never self-elevating). Design notes: docs/architecture/host-install.md.
#
# Start it ALWAYS as   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\albera-host.ps1 <arguments>
# (the full path: cmd.exe looks in the current folder before PATH. -NoProfile skips profiles ONLY; user modules are handled by the script itself, see the first statements below.)
# install / uninstall: ONLY from an elevated `cmd /d` whose environment has no COR_* / COMPLUS_* / CORECLR_* variable (they load a DLL into powershell.exe before line 1),
# running a COPY of the two script files in C:\Program Files\AlberaSetup whose hashes you checked with certutil (host-install.md, "The elevated console").
#
#   albera-host.ps1                                           plan (default): numbered list of everything install would do; changes nothing, needs no admin
#   albera-host.ps1 -Mode plan -PlanFor uninstall             the same for uninstall
#   albera-host.ps1 -Mode plan -PlanFor migrate               the same for -Mode migrate (reads the legacy install; the steps it would take)
#   albera-host.ps1 -Mode hashes                              prints the per-file SHA-256 JSON and the line ALBERA_HOST_TREE_HASH=<hex> (for a CI run; NOT a proof by itself, see below)
#   albera-host.ps1 -Mode install -ExpectedTreeHash <64 hex> -ApproverKeyId <hello-...> -ApproverPublicKey <spki> -ApproverSid <S-1-5-21-...> [-SetupRunId <decimal>]
#                                                             install (elevated): the Broker, the Approval Authority and the Control Plane service AlberaControlPlane (NT SERVICE virtual account, no local account),
#                                                             all three start= delayed-auto; the pinned node.exe and claude.exe; the Start menu shortcuts and the approver tray entry. albera-setup.exe passes the
#                                                             tree hash from the attested build-hashes.json and the run id of the attestation (-SetupRunId; an older run than the install record holds is refused).
#   albera-host.ps1 -Mode install ... -GrantHyperVToBroker -VmName <the VM's name> [-ComputerId <id>]
#                                                             OPTIONAL (ADR-002 Amendment 2026-11-03, host-install.md "Giving the Broker Hyper-V"): also puts ONLY the Broker's service SID into
#                                                             BUILTIN\Hyper-V Administrators, makes the Broker's SID type unrestricted, and writes the VM's GUID (looked up now from -VmName) into the Broker config,
#                                                             and writes the `desktop` block (installed helper path + its SHA-256) into the Control Plane settings, which the gated room requires.
#                                                             The Control Plane and the Authority are never added. Without this option nothing about the install changes. Uninstall removes the SID again (the install record says so).
#   albera-host.ps1 -Mode migrate (-ExpectedTreeHash <64 hex> | -TrustLocalBuilds)
#                                                             ONCE, for an install made by the first layout (the local account albera-cp; control-plane-service.md section 9, decision D7): reads that install's
#                                                             record and configs (the Hello public values, the VM GUID, the computer id, whether the Hyper-V grant was made), stops albera-cp's processes by PID,
#                                                             stops the services, runs the uninstall (the Broker's SID leaves Hyper-V Administrators first), installs the new layout with the carried-over values, and deletes the
#                                                             account and its profile. -TrustLocalBuilds says that you accept the tree hash of the builds in this working tree instead of one typed from a CI log (the
#                                                             trade the contract makes for this one run). Lost by design: the Control Plane and Broker journals and the Authority's signing key (a new one is made).
#   albera-host.ps1 -Mode status                              read-only report of what is installed and whether it still matches (exit 1 on any difference)
#   albera-host.ps1 -Mode uninstall                           remove only what the install manifest says this script created (elevated)
#
# Attacker model: an AI agent running as the owner's NON-admin session. It can pre-create C:\ProgramData\Albera, plant a manifest or a junction there, rewrite every file
# in the repository working tree (the builds, their sidecar manifests, this script's own folder), and set user environment variables that an elevated console inherits. Therefore:
#   - nothing that already exists is trusted until it is owned by SYSTEM / Administrators, has no write right for anyone else, and is no link anywhere on its path;
#   - no environment variable decides a path: sc.exe, icacls.exe and the install roots come from [Environment]::SystemDirectory / GetFolderPath and are refused unless they are
#     C:\Windows\System32, C:\Program Files and C:\ProgramData; no executable is found through PATH;
#   - the three approver values come from the owner (who ran `AlberaApprover.exe enroll --show` in a NORMAL console); no program from the repository is ever started by this script (the one exception is
#     -Mode migrate -TrustLocalBuilds: see the paragraph on launch-check below);
#   - no user module can run in the elevated session: Windows PowerShell 5.1 searches ~\Documents\WindowsPowerShell\Modules and HKCU PSModulePath before its own folder, even with -NoProfile, and loads
#     CimCmdlets, LocalAccounts, Security, Utility and Management lazily. So the first statements switch auto-loading off, reset PSModulePath to $PSHOME\Modules and import the five modules by full path;
#   - the builds are accepted only when the tree hash of the COPIES (copied into an administrator-only folder first) equals -ExpectedTreeHash, a value the owner TYPES from the CI log
#     of the reviewed commit (a parameter, not a file: a file in Downloads can be rewritten together with the builds). Run this script itself from a reviewed checkout.
# install and uninstall refuse unless the console is elevated; they never elevate. A completed install re-run says so and changes nothing. A partial install is finished
# from where it stopped, or refused with the reason. Nothing secret is printed or stored: only public values (SIDs, public keys, hashes, paths).
# The only programs this script starts are sc.exe and icacls.exe by their full System32 paths, and ONE exception: `launch-check` of the INSTALLED Control Plane host (the hash-verified copy in the
# administrator-only bin folder, with a minimal environment), which must answer 0 before the service is registered. Nothing from the repository working tree is executed - EXCEPT with -Mode migrate -TrustLocalBuilds
# (decision D7, the one first migration): there the installed copy IS a copy of a build in the working tree whose tree hash this same run computed, so it has no provenance, and launch-check runs that program elevated. Every
# other run takes the tree hash from the attested build-hashes.json (setup) or from the CI log, and runs only a copy that matches it.
# -VmId (a fixed VM GUID instead of the lookup), -NodeSource and -ClaudeSource (a node.exe / claude.exe from elsewhere) are for the disposable lab VM only and are refused unless the environment variable ALBERA_LAB_VM is 1.
[CmdletBinding()]
param(
  [ValidateSet('plan', 'install', 'uninstall', 'status', 'hashes', 'migrate')][string]$Mode = 'plan',
  [ValidateSet('install', 'uninstall', 'migrate')][string]$PlanFor = 'install',
  [string]$ApproverKeyId,
  [string]$ApproverPublicKey,
  [string]$ApproverSid,
  [string]$ExpectedTreeHash,
  [string]$RepoRoot,
  [string]$ProjectId,
  [string]$VmName,
  [string]$ComputerId,
  [switch]$StartCheck,
  [switch]$GrantHyperVToBroker,
  [string]$VmId,
  # The run id of the attested workflow run that built what albera-setup.exe verified (a decimal number). Recorded as `setupRunId` in the install record; a smaller one is refused, the same one is fine.
  [string]$SetupRunId,
  [switch]$TrustLocalBuilds,
  [string]$NodeSource,
  [string]$ClaudeSource
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
if ($Mode -in @('install', 'uninstall', 'migrate') -and -not (Test-Elevated)) { Stop-Refused "$Mode needs an elevated console (Run as administrator). This script never elevates itself." }
$installLike = ($Mode -eq 'install') -or ($Mode -eq 'migrate') -or ($Mode -eq 'plan' -and $PlanFor -ne 'uninstall')
if ($NodeSource -or $ClaudeSource) {
  if (Test-LabSourceGate $true $env:ALBERA_LAB_VM) { Stop-Refused '-NodeSource and -ClaudeSource are lab-only (disposable VM with ALBERA_LAB_VM=1); on a real PC node.exe comes from C:\Program Files\nodejs and claude.exe from your own profile' 2 }
  if (-not $installLike) { Stop-Refused '-NodeSource and -ClaudeSource only apply to install and migrate (and their plan)' 2 }
  foreach ($source in @($NodeSource, $ClaudeSource)) { if ($source -and -not (Test-PlainAbsolutePath $source)) { Stop-Refused '-NodeSource / -ClaudeSource is not a plain absolute path' 2 } }
}
if ($GrantHyperVToBroker -and -not ($Mode -eq 'install' -or ($Mode -eq 'plan' -and $PlanFor -eq 'install'))) { Stop-Refused '-GrantHyperVToBroker only applies to -Mode install (and its plan); migrate, status and uninstall follow what the install record says' 2 }
if ($SetupRunId -and $null -eq (ConvertTo-SetupRunId $SetupRunId)) { Stop-Refused '-SetupRunId must be a decimal number (the run id of the attested workflow run)' 2 }
if ($SetupRunId -and -not $installLike) { Stop-Refused '-SetupRunId only applies to install and migrate (and their plan)' 2 }
if ($TrustLocalBuilds -and -not ($Mode -eq 'migrate' -or ($Mode -eq 'plan' -and $PlanFor -eq 'migrate'))) { Stop-Refused '-TrustLocalBuilds only applies to -Mode migrate (and its plan): every other run takes the tree hash from setup or from the CI log' 2 }
if ($TrustLocalBuilds -and $ExpectedTreeHash) { Stop-Refused '-TrustLocalBuilds and -ExpectedTreeHash exclude each other: give the typed hash, or accept the local builds, not both' 2 }
if ($Mode -eq 'migrate' -and ($ApproverKeyId -or $ApproverPublicKey -or $ApproverSid)) { Stop-Refused 'migrate carries the approver values over from the legacy install; do not pass -ApproverKeyId, -ApproverPublicKey or -ApproverSid' 2 }
if ($VmId) {
  if (Test-LabVmIdGate $true $env:ALBERA_LAB_VM) { Stop-Refused '-VmId is lab-only (disposable VM with ALBERA_LAB_VM=1); on a real PC the GUID is looked up from -VmName' 2 }
  if (-not $GrantHyperVToBroker) { Stop-Refused '-VmId only applies together with -GrantHyperVToBroker' 2 }
  if (-not (Test-VmGuid $VmId)) { Stop-Refused '-VmId is not a lowercase GUID' 2 }
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
foreach ($p in @($L.BrokerExe, $L.AuthorityExe, $L.PipeClientExe, $L.ControlPlaneExe, $L.ApproverExe, $L.ClaudeExe, $L.ControlPlaneNodeExe, $L.OpenScript, $L.BrokerConfig, $L.AuthorityConfig, $L.ControlPlaneConfig, $L.ApprovalSettings, $L.BrokerDb, $L.ControlPlaneJournal, $L.ControlPlaneLogDir)) {
  if (-not (Test-PlainAbsolutePath $p)) { Stop-Refused 'an install path is not a plain absolute path (the services refuse such paths)' }
}

# ---------------------------------------------------------------------------------------------- helpers that touch the system
# The only programs this script ever starts are sc.exe and icacls.exe, by their full System32 paths. Nothing from the repository is executed.
function Invoke-Native([string]$Exe, [string]$Arguments, [int]$TimeoutMs = 60000, [switch]$MinimalEnvironment) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe; $psi.Arguments = $Arguments; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  if ($MinimalEnvironment) {   # nothing is inherited (COR_PROFILER, DOTNET_STARTUP_HOOKS and the like load code into a .NET program before its first line): only the two variables Windows itself needs
    $psi.EnvironmentVariables.Clear()
    $psi.EnvironmentVariables['SystemRoot'] = [System.IO.Path]::GetDirectoryName($SystemDirectory); $psi.EnvironmentVariables['windir'] = [System.IO.Path]::GetDirectoryName($SystemDirectory)
  }
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
function Get-TreeHashes([string]$Dir, [string[]]$ExcludeTop = @()) {
  $all = Get-TreeEntries $Dir -FilesOnly   # assigned first: the function returns , @(...) (one array object), which a pipeline would not unroll
  $files = @($all | Where-Object { $rel = $_.Rel; -not (@($ExcludeTop | Where-Object { $rel.StartsWith($_ + '\', [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) })
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
# What a failed native call says, for the error text: the exit code and what the program printed (icacls prints the Windows error, for example "No mapping between account names and security IDs was done").
# Only paths and SIDs go through these calls; nothing secret does.
function Format-NativeFailure([string]$What, $Result) {
  $text = (([string]$Result.Out + ' ' + [string]$Result.Err) -replace '\s+', ' ').Trim()
  if ($text.Length -gt 400) { $text = $text.Substring(0, 400) + '...' }
  "$What (exit $($Result.Exit)): $text"
}
# The DACL of an EXISTING folder that already passed the trust checks: protected (nothing inherited) and exactly the planned rules. It is written with .NET and NOT with icacls: icacls looks every SID up and
# refuses one that belongs to a service that does not exist yet (exit 1332, "no mapping between account names and security IDs"), and the Control Plane's service SID is in the plan long before the service
# is registered. .NET stores a SID that is not mapped yet as it is, and the rule works once the service exists (a folder this script CREATES is made the same way: New-SecuredDirectory). Only the access
# section is written (a new DirectorySecurity persists only what was modified); the owner follows in Set-HostAcl. A link on the way is refused before and after: SetAccessControl follows one.
function Set-HostDacl([string]$Path, [string[]]$Grants) {
  if ((Get-ReparseChain $Path).Count -gt 0) { throw "$Path is reached through a link; refusing to change its ACL" }
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  foreach ($rule in (ConvertTo-FileSystemRules $Grants)) { $security.AddAccessRule($rule) }
  [System.IO.Directory]::SetAccessControl($Path, $security)
  if ((Get-ReparseChain $Path).Count -gt 0) { throw "$Path turned out to be reached through a link while its ACL was set; inspect it" }
}
# The plan's ACL on an existing folder: the DACL through .NET (Set-HostDacl), then the owner Administrators through icacls /setowner (only a built-in SID, which always resolves). /L: act on a link itself.
function Set-HostAcl($Entry) {
  Set-HostDacl $Entry.Path $Entry.Grants
  $o = Invoke-Native $IcaclsExe ((Quote-NativeArg $Entry.Path) + ' /setowner *S-1-5-32-544 /L')
  if ($o.Exit -ne 0) { throw (Format-NativeFailure "icacls /setowner failed for $($Entry.Path)" $o) }
}
# Member SIDs of a built-in local group. Get-LocalGroupMember throws on a group that holds an unresolvable (orphaned) SID, so the WinNT provider is used.
function Get-LocalGroupMemberSids([string]$GroupSid) {
  $name = (New-Object System.Security.Principal.SecurityIdentifier($GroupSid)).Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1]
  $group = [ADSI]"WinNT://./$name,group"
  @($group.Invoke('Members') | ForEach-Object {
      $entry = New-Object System.DirectoryServices.DirectoryEntry($_)
      try { (New-Object System.Security.Principal.SecurityIdentifier([byte[]]$entry.InvokeGet('objectSid'), 0)).Value }
      catch { Resolve-MemberPathSid ([string]$entry.Path) }   # a member without an objectSid property (a service's virtual account): from its path
    })
}
function Resolve-MemberPathSid([string]$Path) {
  $p = ConvertFrom-WinNTMemberPath $Path
  if ($null -eq $p) { throw "cannot read the SID of a group member ($Path)" }
  if ($p.Sid) { return $p.Sid }
  (New-Object System.Security.Principal.NTAccount($p.Account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
}

# ---------------------------------------------------------------------------------------------- the install manifest (what this script created; nothing else is ever removed)
Add-Type -AssemblyName System.Web.Extensions
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
# A manifest is read only when C:\ProgramData\Albera and the manifest file are owned by SYSTEM / Administrators, writable by nobody else, and reached through no link; and its content has the
# shape this script writes (fixed service, user and key names). install / uninstall refuse otherwise; plan / status (no admin rights, so the ACLs cannot be read) ignore it and say so.
function Initialize-Manifest {
  if (-not (Test-Path -LiteralPath $L.ManifestPath)) { return }
  $mutating = $Mode -in @('install', 'uninstall', 'migrate')
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
# The run id of the attested run (-SetupRunId), kept in the manifest as a decimal STRING. It only ever goes up. Get-RollbackRefusal is the anti-rollback check: an older run than the LARGER of the manifest's
# record and the floor is refused, the same one is fine. The manifest goes away with uninstall; the FLOOR does not: HKLM\SOFTWARE\Albera\SetupRunIdFloor (REG_SZ, decimal) is written by every run that
# has a -SetupRunId, only ever raised, and NO step of uninstall removes it (a test pins that), so uninstall followed by an install of an old, validly attested build is refused too.
# An administrator who really wants an older build deletes that one value by hand.
# The 64-bit registry view, whatever the bitness of this PowerShell: albera-setup.exe (x64) reads the same one.
function Open-FloorBaseKey { [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64) }
function Get-SetupRunIdFloor {
  $machine = Open-FloorBaseKey
  try {
    $key = $machine.OpenSubKey('SOFTWARE\Albera')
    if (-not $key) { return $null }
    try {
      $value = $key.GetValue('SetupRunIdFloor', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $kind = if ($null -ne $value) { $key.GetValueKind('SetupRunIdFloor') } else { $null }
    }
    finally { $key.Dispose() }
  }
  finally { $machine.Dispose() }
  if ($null -eq $value) { return $null }
  if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String) { return 'not-a-string' }   # refused as an invalid floor, never read as "no floor"
  [string]$value
}
function Write-SetupRunIdFloorRaw([string]$Text) {
  $machine = Open-FloorBaseKey
  try {
    $key = $machine.CreateSubKey('SOFTWARE\Albera')
    try { $key.SetValue('SetupRunIdFloor', $Text, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
  }
  finally { $machine.Dispose() }
}
function Set-SetupRunIdFloorValue {
  if (-not $SetupRunId) { return }
  $new = ConvertTo-SetupRunId $SetupRunId
  if ($null -eq $new) { return }
  $text = $new.ToString([System.Globalization.CultureInfo]::InvariantCulture)
  $stored = Get-SetupRunIdFloor
  $current = ConvertTo-SetupRunId $stored
  if ($null -ne $stored -and $null -eq $current) { throw 'the run-id floor (HKLM\SOFTWARE\Albera\SetupRunIdFloor) is not a decimal number; an administrator must correct or delete that one value. It was not changed' }
  if ($null -ne $current -and $new -le $current) { return }
  Write-SetupRunIdFloorRaw $text
  if ((Get-SetupRunIdFloor) -cne $text) { throw 'the run-id floor was written but does not read back' }
}
function Get-RollbackRefusal {
  $recorded = if ($script:Manifest -and $script:Manifest.ContainsKey('setupRunId')) { $script:Manifest['setupRunId'] } else { $null }
  Get-SetupRunIdRefusal $recorded $SetupRunId (Get-SetupRunIdFloor)
}
function Get-RollbackMessage([string]$Word) {
  $recorded = if ($script:Manifest -and $script:Manifest.ContainsKey('setupRunId')) { $script:Manifest['setupRunId'] } else { 'none' }
  $floor = Get-SetupRunIdFloor; if ($null -eq $floor) { $floor = 'none' }
  "${Word}: this run is $SetupRunId; the install record holds setupRunId $recorded and the floor of this PC (HKLM\SOFTWARE\Albera\SetupRunIdFloor) is $floor. An older (validly attested) build is never installed over a newer one"
}
function Set-ManifestSetupRunId {
  Set-SetupRunIdFloorValue   # the floor is written even when there is no manifest (yet)
  if (-not $SetupRunId -or -not $script:Manifest) { return }
  $new = ConvertTo-SetupRunId $SetupRunId
  $old = if ($script:Manifest.ContainsKey('setupRunId')) { ConvertTo-SetupRunId $script:Manifest['setupRunId'] } else { $null }
  if ($null -eq $old -or $new -gt $old) { $script:Manifest['setupRunId'] = $new.ToString([System.Globalization.CultureInfo]::InvariantCulture); Save-Manifest }
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
    [pscustomobject]@{ Name = 'control-plane'; Dir = Join-Path $r 'src\runtime\windows-control-plane-host\bin\Release\net10.0-windows\win-x64\publish'; Exe = 'albera-control-plane-host.exe'; Dest = $L.ControlPlaneBinDir; Build = 'npm run build:control-plane' }
    [pscustomobject]@{ Name = 'approver'; Dir = Join-Path $r 'src\runtime\windows-approver\bin\Release\net10.0-windows10.0.19041.0\win-x64\publish'; Exe = 'AlberaApprover.exe'; Dest = $L.ApproverBinDir; Build = 'npm run build:approver' }
  )
}
# -ExpectedTreeHash: typed by the owner from the CI log. @{ Ok; Reason; Value }
function Get-ExpectedTreeHashState {
  if ($TrustLocalBuilds) {
    # -Mode migrate -TrustLocalBuilds (decision D7, control-plane-service.md section 9): the owner accepts the tree hash of the builds in THIS working tree. It proves nothing about who built them; it is
    # computed once, from the publish folders, and the COPIES are still hashed and compared with it (so a file changed between this line and the copy is still caught).
    if (-not $script:LocalTreeHash) {
      $dirs = @{}
      foreach ($s in (Get-BuildSources)) {
        if (-not [System.IO.Directory]::Exists($s.Dir)) { return [pscustomobject]@{ Ok = $false; Reason = "$($s.Name): publish folder missing (run $($s.Build))"; Value = $null } }
        if (Test-HasReparsePoint $s.Dir) { return [pscustomobject]@{ Ok = $false; Reason = "$($s.Name): the publish folder contains a link or junction"; Value = $null } }
        $dirs[$s.Name] = $s.Dir
      }
      $script:LocalTreeHash = Get-CanonicalTreeHash (Get-ComponentHashes $dirs)
    }
    return [pscustomobject]@{ Ok = $true; Reason = ''; Value = $script:LocalTreeHash }
  }
  if (-not $ExpectedTreeHash) { return [pscustomobject]@{ Ok = $false; Reason = '-ExpectedTreeHash <64 hex> is required: type the ALBERA_HOST_TREE_HASH value from the CI log of the reviewed commit. A hash computed from this working tree proves nothing: a non-admin can rewrite the builds.'; Value = $null } }
  if (-not (Test-TreeHashValue $ExpectedTreeHash)) { return [pscustomobject]@{ Ok = $false; Reason = '-ExpectedTreeHash must be 64 lowercase hex characters'; Value = $null } }
  [pscustomobject]@{ Ok = $true; Reason = ''; Value = $ExpectedTreeHash }
}
# component name -> relative path -> SHA-256, for the three folders given (publish folders or installed copies); the canonical tree hash is made from this by ONE function (Get-CanonicalTreeHash).
# $Installed: the folders are the installed copies, where the control-plane component also holds the pinned node\ (added after the tree hash was checked; it has its own hash in the install record).
function Get-ComponentHashes($Dirs, [switch]$Installed) {
  $components = @{}
  foreach ($name in $script:HashComponents) {
    $exclude = if ($Installed -and $name -eq 'control-plane') { @('node') } else { @() }
    $h = @{}; foreach ($f in (Get-TreeHashes $Dirs[$name] $exclude).Files) { $h[$f.Rel] = $f.Sha }; $components[$name] = $h
  }
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
    Exists = $true; StartName = $svc.StartName; PathName = $svc.PathName; StartMode = $svc.StartMode; DelayedAutoStart = [bool]$svc.DelayedAutoStart; ServiceType = $svc.ServiceType
    SidTypeText = $sid.Out; PrivilegesText = $privs.Out; FailureActions = (Read-ServiceFailureActions $Name); State = $svc.State; ExitCode = $svc.ExitCode; SpecificExitCode = $svc.ServiceSpecificExitCode
  }
}
# The failure actions the SCM stored (REG_BINARY, see ConvertFrom-FailureActionsBytes), or $null when there are none. Not `sc qfailure`: its text is localized. The name is one of the three fixed service names.
function Read-ServiceFailureActions([string]$Name) {
  $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Services\' + $Name)
  if (-not $key) { return $null }
  try { $value = $key.GetValue('FailureActions', $null) } finally { $key.Dispose() }
  if ($value -is [byte[]]) { return , $value }
  $null
}
# The three services. `Phase`: the Broker and the Authority are made first (the folders' ACLs need their SIDs and the Broker's service ACL needs the Control Plane's, all derived from the names); the Control Plane
# service is made last, after its files exist and the installed host has said `launch-check` is fine. `RestartOnFailure`: only the Control Plane restarts itself (control-plane-service.md section 2).
function Get-ServiceSpecs {
  @(
    [pscustomobject]@{ Name = $K.BrokerService; Exe = $L.BrokerExe; Config = $L.BrokerConfig; Phase = 'early'; RestartOnFailure = $false }
    [pscustomobject]@{ Name = $K.AuthorityService; Exe = $L.AuthorityExe; Config = $L.AuthorityConfig; Phase = 'early'; RestartOnFailure = $false }
    [pscustomobject]@{ Name = $K.ControlPlaneService; Exe = $L.ControlPlaneExe; Config = $L.ControlPlaneConfig; Phase = 'late'; RestartOnFailure = $true }
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
# The three service SIDs are known before the services exist (derived from the fixed names); they are cross-checked against what Windows says once the services exist.
# The Control Plane SID is its service SID. Only a record of the FIRST layout (it holds the local account albera-cp) has an account SID there instead: uninstall and migrate must still recognise the folders
# and the groups of that layout, so for such a record the account's SID is the Control Plane's. `Approver` is the owner's SID (the parameter, or what the record holds) for the ui\ folder's Read right.
function Test-LegacyLayout { [bool](Test-ManifestHas 'user') }
function Resolve-HostSids {
  $legacy = Test-LegacyLayout
  $cpSid = if ($legacy) { $script:Manifest['created']['user']['sid'] } else { Get-DerivedServiceSid $K.ControlPlaneService }
  $approver = $null
  if ($script:Approver) { $approver = $script:Approver.approverSid }
  elseif ($ApproverSid) { $approver = $ApproverSid }
  elseif ($script:Manifest -and $script:Manifest['values'].ContainsKey('approverSid')) { $approver = $script:Manifest['values']['approverSid'] }
  $script:Sids = @{ Broker = (Get-DerivedServiceSid $K.BrokerService); Authority = (Get-DerivedServiceSid $K.AuthorityService); ControlPlane = $cpSid; Approver = $approver; Legacy = $legacy }
  $checked = @(@('Broker', $K.BrokerService), @('Authority', $K.AuthorityService))
  if (-not $legacy) { $checked += , @('ControlPlane', $K.ControlPlaneService) }
  foreach ($spec in $checked) {
    if (Get-CimInstance Win32_Service -Filter "Name='$($spec[1])'") {
      $real = Get-AccountSid "NT SERVICE\$($spec[1])"
      if ($real -ne $script:Sids[$spec[0]]) { throw "the SID Windows gives $($spec[1]) differs from the derived one; refusing to continue" }
    }
  }
}
# The live LEGACY Control Plane account as the ownership check wants it, or $null (only -Mode migrate and uninstall of a first-layout install look for it).
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
# C:\Program Files\Albera may exist before install starts: albera-setup.exe runs from bin\setup (the owner put it there) and makes setup-work\ there while it runs this script (control-plane-service.md
# section 8). It is adopted - a folder this script did not create is otherwise never adopted - only when it passes the trust checks (owner SYSTEM / Administrators, nobody else may write, no link) and holds nothing
# but those two setup folders. Returns the reasons it cannot be adopted (empty = absent or adoptable).
function Get-InstallRootAdoptionReasons {
  if (-not (Test-Path -LiteralPath $L.InstallRoot)) { return , @() }
  $reasons = Get-PathTrustReasons $L.InstallRoot (Get-AdminSids) $false
  if ($reasons.Count -gt 0) { return , @($reasons) }
  if (Test-HasReparsePoint $L.InstallRoot) { return , @('link_or_junction_inside') }
  $entries = Get-TreeEntries $L.InstallRoot
  $unknown = @($entries | ForEach-Object { $_.Rel } | Where-Object {
      $lower = $_.ToLowerInvariant()
      -not ($lower -eq 'bin' -or $lower -eq 'bin\setup' -or $lower.StartsWith('bin\setup\') -or $lower -eq 'setup-work' -or $lower.StartsWith('setup-work\'))
    })
  if ($unknown.Count -gt 0) { return , @($unknown | ForEach-Object { 'unknown_entry:' + $_ } | Select-Object -First 5) }
  # Every entry that is left - bin, bin\setup and setup-work with EVERYTHING below them, files included - must be owned by SYSTEM, Administrators or TrustedInstaller and be writable by no one else
  # (Test-TrustSummary on Get-AclSummary: a CREATOR OWNER rule that is inherit-only is the ordinary placeholder and is skipped). One planted file or a user-owned sub-folder refuses the adoption.
  $bad = New-Object System.Collections.Generic.List[string]
  foreach ($e in $entries) {
    try { $summary = Get-AclSummary $e.Full } catch { $bad.Add($e.Rel + ':acl_unreadable'); if ($bad.Count -ge 5) { break }; continue }
    foreach ($why in (Test-TrustSummary $summary (Get-AdminSids) $false)) { $bad.Add($e.Rel + ':' + $why) }
    if ($bad.Count -ge 5) { break }
  }
  if ($bad.Count -gt 0) { return , @($bad.ToArray() | Select-Object -First 5) }
  , @()
}
# BUILTIN\Users get read and execute on exactly three folders of the install (bin\approver, bin\launcher, bin\setup: the owner's own session runs the approver tray, the launcher and - through UAC - setup) and on
# nothing else: the install folder itself, bin, bin\claude, bin\control-plane (with node\) and the .partial folders carry SYSTEM, Administrators and the three service SIDs only. $ShouldHave says which kind
# of folder this is. Returns the problems (empty = as intended); a Users rule that can write is one.
function Get-UsersAceProblems([string]$Path, [bool]$ShouldHave) {
  $problems = New-Object System.Collections.Generic.List[string]
  $summary = Get-AclSummary $Path
  $has = @($summary.AllowSids) -contains 'S-1-5-32-545'
  if ($ShouldHave) {
    if (-not $has) { $problems.Add('users_ace_missing') }
    elseif (@($summary.WriteSids) -contains 'S-1-5-32-545') { $problems.Add('users_can_write') }
  }
  elseif ($has) { $problems.Add('users_ace_unexpected') }
  , @($problems)
}
function Grant-UsersReadExecute([string]$Path) {
  if ((Get-ReparseChain $Path).Count -gt 0) { throw "$Path is reached through a link; refusing to change its ACL" }
  $r = Invoke-Native $IcaclsExe ((Quote-NativeArg $Path) + ' /grant:r *S-1-5-32-545:(OI)(CI)RX /L')
  if ($r.Exit -ne 0) { throw (Format-NativeFailure "icacls failed for $Path" $r) }   # BUILTIN\Users always resolves, so this is the only SID icacls is ever given a grant for
  $bad = Get-UsersAceProblems $Path $true
  if ($bad.Count -gt 0) { throw "the ACL of $Path is not as intended after the change: $($bad -join ', ')" }
}
# The albera-setup.exe in bin\setup is what the "ALBERA update" shortcut starts (elevated, through its manifest). Before that shortcut is made the file and its folder must pass the trust test, and - when this
# run was started by setup, which keeps the copy it verified beside the repo folder - the file must be that copy (same SHA-256). $null = nothing wrong or not installed.
function Get-SetupExeProblem {
  if (-not (Test-Path -LiteralPath $L.SetupExe -PathType Leaf)) { return $null }
  if ((Get-ReparseChain $L.SetupExe).Count -gt 0) { return 'albera-setup.exe is reached through a link' }
  foreach ($p in @($L.SetupExe, $L.SetupBinDir)) {
    $r = Get-PathTrustReasons $p (Get-AdminSids) $false
    if ($r.Count -gt 0) { return 'albera-setup.exe cannot be trusted: ' + (Format-TrustRefusal $p $r) }
  }
  $verified = Join-Path (Split-Path -Parent $RepoRoot) 'setup\albera-setup.exe'
  if ((Split-Path -Leaf $RepoRoot) -ceq 'repo' -and (Test-Path -LiteralPath $verified -PathType Leaf)) {
    if ((Get-Sha256File $verified) -cne (Get-Sha256File $L.SetupExe)) { return 'the albera-setup.exe in bin\setup is not the copy setup verified in this update (the SHA-256 differs)' }
  }
  $null
}

# ---------------------------------------------------------------------------------------------- install steps: each has a read-only Test (-> done / todo / blocked:<why> / unknown:<why>) and a Do
# The three approver values: the parameters, or - in -Mode migrate - what the legacy install already holds (the owner does not type them again).
function Get-ApproverInput {
  if ($script:LegacyValues) { return [pscustomobject]@{ KeyId = $script:LegacyValues.ApproverKeyId; PublicKey = $script:LegacyValues.ApproverPublicKey; Sid = $script:LegacyValues.ApproverSid } }
  [pscustomobject]@{ KeyId = $ApproverKeyId; PublicKey = $ApproverPublicKey; Sid = $ApproverSid }
}
function Get-InstallSteps {
  $steps = @(
    [pscustomobject]@{ Id = 'sources'; Title = 'Check -ExpectedTreeHash (the tree hash of the reviewed build: from the attested build-hashes.json when setup runs this, otherwise typed from the CI log) and list the five publish folders; nothing in the repository is executed'
      Detail = @("publish folders are read from $RepoRoot\src\runtime\...\publish (npm run build:windows-broker, build:approval-authority, build:control-plane, build:approver); the COPIES are hashed later and their tree hash must equal the value you gave", 'a link or junction in a publish folder is refused', 'a -SetupRunId older than the larger of the install record''s setupRunId and the floor HKLM\SOFTWARE\Albera\SetupRunIdFloor (which uninstall keeps) is refused (anti-rollback); the same one is fine')
      Test = {
        if (Test-ManifestHas 'user') { return 'blocked:the install record is from the first layout (the local account albera-cp). Run -Mode migrate to move it to the new layout, or -Mode uninstall first' }
        if (-not $GrantHyperVToBroker -and (Test-ManifestHas 'hyperVGrant')) { return 'blocked:the install record says the Hyper-V grant was made; run again WITH -GrantHyperVToBroker to finish it, or uninstall first' }
        $rollback = Get-RollbackRefusal; if ($rollback) { return 'blocked:' + (Get-RollbackMessage $rollback) }
        $st = Get-ExpectedTreeHashState; if (-not $st.Ok) { return 'blocked:' + $st.Reason }
        foreach ($s in (Get-BuildSources)) {
          if (-not [System.IO.Directory]::Exists($s.Dir)) { return "blocked:$($s.Name): publish folder missing (run $($s.Build))" }
          if (Test-HasReparsePoint $s.Dir) { return "blocked:$($s.Name): the publish folder contains a link or junction" }
        }
        'todo' }
      Do = { Say '    the tree hash is given; the five publish folders exist and hold no links'; if ($SetupRunId) { Set-SetupRunIdFloorValue; Say "    setup run id $SetupRunId (the floor of this PC is at least that now)" } } }
    [pscustomobject]@{ Id = 'approver'; Title = 'Check the approver values (-ApproverKeyId, -ApproverPublicKey, -ApproverSid, from your own "AlberaApprover.exe enroll --show" in a normal console; migrate carries them over)'
      Detail = @('the key id must be a valid id; the public key an RSA-2048 SPKI; the SID an S-1-5-21 user SID', 'this script does not run the approver program: it would run elevated')
      Test = {
        $in = Get-ApproverInput
        if (-not $in.KeyId -or -not $in.PublicKey -or -not $in.Sid) { return 'blocked:-ApproverKeyId, -ApproverPublicKey and -ApproverSid are all required for install' }
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
        $script:Manifest = New-Manifest; Save-Manifest; Set-ManifestSetupRunId; Say "    created $($L.DataRoot)" } }
    [pscustomobject]@{ Id = 'services'; Title = "Create services $($K.BrokerService) and $($K.AuthorityService) (own process, NT SERVICE virtual account, restricted SID, SeChangeNotifyPrivilege only, start=delayed-auto)" + $(if ($GrantHyperVToBroker) { "; WITH -GrantHyperVToBroker the Broker's SID type is UNRESTRICTED instead (Hyper-V refuses a restricted token), the Authority stays restricted" } else { '' })
      Detail = @("$($K.BrokerService) service ACL: SYSTEM and Administrators full, $($K.ControlPlaneService) only SERVICE_QUERY_STATUS (LC)", 'the services are NOT started by install: they start by themselves, delayed, at the next start of Windows; you can start them now (Start-Service)')
      Test = {
        $states = foreach ($spec in (Get-ServiceSpecs | Where-Object { $_.Phase -eq 'early' })) {
          $exists = [bool](Get-CimInstance Win32_Service -Filter "Name='$($spec.Name)'")
          $mine = (Test-ManifestHas 'services') -and (@($script:Manifest['created']['services']) -contains $spec.Name)
          if ($exists -and -not $mine) { 'blocked:service ' + $spec.Name + ' already exists and was not created by this script' } elseif ($exists) { 'done' } else { 'todo' }
        }
        $b = @($states | Where-Object { $_ -like 'blocked:*' }); if ($b.Count) { return $b[0] }
        if (@($states | Where-Object { $_ -ne 'done' }).Count -ne 0) { return 'todo' }
        # A service of an older run (start=demand) is brought to delayed-auto; the Broker's SID type must be the one this run's option asks for, in BOTH directions: an install begun without the option and finished with it
        # (restricted -> unrestricted), and one begun WITH it and finished without (unrestricted -> restricted; without this the install would complete with an unrestricted Broker and no grant).
        foreach ($spec in (Get-ServiceSpecs | Where-Object { $_.Phase -eq 'early' })) {
          $facts = Get-ServiceFactsFor $spec.Name
          if ($facts.StartMode -ne 'Auto' -or $facts.DelayedAutoStart -ne $true) { return 'todo' }
        }
        $brokerUnrestricted = (Get-ServiceFactsFor $K.BrokerService).SidTypeText -cmatch '(?<![A-Za-z])UNRESTRICTED'
        if (((Get-ExpectedSidType $K.BrokerService $GrantHyperVToBroker) -ceq 'unrestricted') -ne $brokerUnrestricted) { return 'todo' }
        'done' }
      Do = { New-HostServices } }
    [pscustomobject]@{ Id = 'folders'; Title = "Create the folders, each born with its final ACL (inheritance removed) and read back: $($L.InstallRoot); $($L.DataRoot)\{broker-config,broker,authority,control-plane,control-plane\logs,control-plane-config,secrets,ui}"
      Detail = @('SYSTEM and Administrators full everywhere; Broker SID Modify on broker\ only; Authority SID Modify on authority\ only; the Control Plane service SID: full control on control-plane\ and control-plane\logs\ (its journal requires it), Modify on secrets\ and ui\, READ ONLY on control-plane-config\',
        'ui\ also gives your account (the approver SID) Read, so the "Open ALBERA" shortcut can read room.json; nobody else of yours can read it or secrets\',
        'an existing folder is used only if it is owned by SYSTEM/Administrators, has no other writer and is reached through no link; otherwise the run stops. C:\Program Files\Albera is adopted when it holds only albera-setup.exe''s own folders (bin\setup, setup-work)')
      Test = {
        if (-not (Test-ManifestHas 'services')) { return 'todo' }
        if ((Test-Path -LiteralPath $L.InstallRoot) -and -not (Test-ManifestHas 'installRoot')) {
          $why = Get-InstallRootAdoptionReasons
          if ($why.Count -gt 0) { return 'blocked:' + $L.InstallRoot + ' exists but was not created by this script and is not only albera-setup.exe''s own folders (' + ($why -join ', ') + '); inspect it, delete it as an administrator, run again' }
          return 'todo'
        }
        Resolve-HostSids
        foreach ($e in (Get-AclPlan $L $script:Sids)) {
          if (-not (Test-Path -LiteralPath $e.Path)) { return 'todo' }
          $r = Get-PathTrustReasons $e.Path (Get-PlannedWriters $e) $true
          if ($r.Count -gt 0) { return 'blocked:' + (Format-TrustRefusal $e.Path $r) }
          if ((Test-AclMatchesPlan $e (Get-AclSummary $e.Path)).Count -gt 0) { return 'todo' }
        }
        if ((Test-Path -LiteralPath $L.SetupBinDir) -and (Get-UsersAceProblems $L.SetupBinDir $true).Count -gt 0) { return 'todo' }
        'done' }
      Do = { New-HostFolders } }
    [pscustomobject]@{ Id = 'binaries'; Title = "Copy the five builds into $($L.BinRoot)\{broker,authority,pipe-client,control-plane,approver} (already administrator-only), then hash the COPIES and require their tree hash to equal the tree hash given"
      Detail = @('copied to .partial folders, hashed there; any difference from the tree hash (a missing, extra, moved or changed file) deletes all five copies and stops; only then are they renamed', 'an existing copy that does not match, or a half-copied bin folder, is refused (update = uninstall + install)')
      Test = {
        if (-not (Test-ManifestHas 'installRoot')) { return 'todo' }
        foreach ($s in (Get-BuildSources)) { if (-not (Test-Path -LiteralPath $s.Dest)) { return 'todo' }; if (-not $script:Manifest['created']['binaries'].ContainsKey($s.Name)) { return 'todo' } }
        if ((Test-Path -LiteralPath $L.ApproverBinDir) -and (Get-UsersAceProblems $L.ApproverBinDir $true).Count -gt 0) { return 'todo' }
        'done' }
      Do = { Copy-HostBinaries } }
    [pscustomobject]@{ Id = 'key'; Title = "Create the Authority machine signing key $($K.SigningKeyName) (ECDSA P-256, Software KSP, machine scope, Export Policy none, DACL SYSTEM/Administrators/Authority service SID only)"
      Detail = @('read back from a fresh open and checked like the Authority start-up guard; one sign/verify round trip; only the PUBLIC key (SPKI) leaves it, into the Broker config')
      Test = {
        if ((Test-ManifestHas 'key') -and (Test-AuthoritySigningKeyExists $K.SigningKeyName)) { return 'done' }
        if (Test-AuthoritySigningKeyExists $K.SigningKeyName) { return 'blocked:a machine key named ' + $K.SigningKeyName + ' exists and was not created by this script; it is never adopted' }
        'todo' }
      Do = { New-HostSigningKey } }
    [pscustomobject]@{ Id = 'node'; Title = "Copy node.exe from C:\Program Files\nodejs to $($L.ControlPlaneNodeExe) (administrator-only) and record the SHA-256 of the COPY; the Control Plane host refuses to start node when the hash differs"
      Detail = @('C:\Program Files\nodejs itself is refused by the host (its parent folder is writable by a bare BUILTIN SID), so the service never runs that copy', 'the node you have installed is trusted at the moment of the copy and not afterwards; running this script again after a Node update does NOT refresh the pin (update = uninstall + install)')
      Test = {
        if (-not (Test-ManifestHas 'installRoot') -or -not $script:Manifest['created']['binaries'].ContainsKey('control-plane')) { return 'todo' }
        if (Test-Path -LiteralPath $L.ControlPlaneNodeExe) {
          if ((Test-ManifestHas 'controlPlane') -and ((Get-Sha256File $L.ControlPlaneNodeExe) -ceq $script:Manifest['created']['controlPlane']['nodeSha256'])) { return 'done' }
          return 'blocked:' + $L.ControlPlaneNodeExe + ' exists but is not the copy the install record describes; uninstall, then install'
        }
        $problem = Get-NodePinProblem; if ($problem) { return 'blocked:' + $problem }
        'todo' }
      Do = { Copy-PinnedNode } }
    [pscustomobject]@{ Id = 'claude'; Title = "Copy YOUR Claude Code (<your profile>\.local\bin\claude.exe, found from the approver SID) to $($L.ClaudeExe) (administrator-only) and record the SHA-256 of the COPY and its file version"
      Detail = @('run it as the approver account (the one that says yes to UAC): another administrator account is refused', 'ALBERA never downloads or ships Claude Code; it is NOT started here (the version is read from the file version resource, not by running it, because this script starts no program of yours while elevated)', 'its trust is your PC at the moment of the copy, not an attestation')
      Test = {
        if (-not (Test-ManifestHas 'installRoot')) { return 'todo' }
        if (Test-Path -LiteralPath $L.ClaudeExe) {
          if ((Test-ManifestHas 'claude') -and ((Get-Sha256File $L.ClaudeExe) -ceq $script:Manifest['created']['claude']['sha256'])) { return 'done' }
          return 'blocked:' + $L.ClaudeExe + ' exists but is not the copy the install record describes; uninstall, then install'
        }
        $problem = Get-ClaudePinProblem; if ($problem) { return 'blocked:' + $problem }
        'todo' }
      Do = { Copy-PinnedClaude } }
    [pscustomobject]@{ Id = 'configs'; Title = "Write the Broker config, the Authority config, the Control Plane service config and the approval settings (an existing file must pass the same trust checks and is overwritten)"
      Detail = @($L.BrokerConfig, $L.AuthorityConfig, "$($L.ControlPlaneConfig)  (host, claude, ui blocks; the Control Plane service can only READ it)", "$($L.ApprovalSettings)  (no attestation key; journal $($L.ControlPlaneJournal); computers: $VmName -> $ComputerId, project $ProjectId)", 'no policy.json is written: the Authority starts at tier careful (every action needs a person)', 'service-check is not run: from an elevated console it cannot judge a Broker or Authority config (config_untrusted), and it would execute a build; the first service start is the real test (the Control Plane host gets its own launch-check in the next step)') + $(if ($GrantHyperVToBroker) { @("Broker config also gets computers: $ComputerId -> <GUID of the VM $VmName>, which creates the Broker's desktop pipe", "The approval settings also get desktop: { helperPath $($L.PipeClientExe), helperSha256 <SHA-256 of that installed exe> }, which the gated room requires") } else { @() })
      Test = {
        if (-not ((Test-Path -LiteralPath $L.BrokerConfig) -and (Test-Path -LiteralPath $L.AuthorityConfig) -and (Test-Path -LiteralPath $L.ControlPlaneConfig) -and (Test-Path -LiteralPath $L.ApprovalSettings))) { return 'todo' }
        # the service config is exactly what this run writes for the recorded pins; anything else (an older file, a hand edit) is written again
        if (-not (Test-ManifestHas 'controlPlane') -or -not (Test-ManifestHas 'claude')) { return 'todo' }
        try {
          Resolve-HostSids
          $approverSid = (Get-ApproverInput).Sid; if (-not $approverSid) { $approverSid = $script:Manifest['values']['approverSid'] }
          $same = Test-ControlPlaneServiceConfigText ([System.IO.File]::ReadAllText($L.ControlPlaneConfig)) $L $script:Manifest['created']['controlPlane']['nodeSha256'] $script:Manifest['created']['claude']['sha256'] $script:Sids.ControlPlane $approverSid
          if ($same.Count -gt 0) { return 'todo' }
        } catch { return 'todo' }
        # an install begun without the option and finished with it: the Broker config exists but has no computers yet, and the settings have no desktop block yet
        if ($GrantHyperVToBroker) {
          $vm = Resolve-BrokerVm
          try { if (($vm.Kind -eq 'ok') -and (Test-BrokerConfigComputers ([System.IO.File]::ReadAllText($L.BrokerConfig)) $ComputerId $vm.Id) -and (Test-ControlPlaneDesktop ([System.IO.File]::ReadAllText($L.ApprovalSettings)) $L.PipeClientExe (Get-DesktopHelperSha256))) { return 'done' } } catch { }
          return 'todo'
        }
        'done' }
      Do = { Write-HostConfigs } }
    [pscustomobject]@{ Id = 'cpservice'; Title = "Register the service $($K.ControlPlaneService) (own process, NT SERVICE virtual account, restricted SID, SeChangeNotifyPrivilege only, start=delayed-auto, restart after 5 s twice on failure) once the installed host's launch-check answers 0"
      Detail = @('launch-check runs the INSTALLED, hash-verified host once with a minimal environment: it validates the service config and the checks made before every node launch (node hash, app tree, ACLs). It is the one program besides sc.exe and icacls.exe this script starts, and nothing is registered when it fails',
        "$($K.ControlPlaneService) gets only SERVICE_QUERY_STATUS on the Broker's service object (set by the services step) and no control over the Broker or the Authority", 'not started by install')
      Test = {
        $exists = [bool](Get-CimInstance Win32_Service -Filter "Name='$($K.ControlPlaneService)'")
        $mine = (Test-ManifestHas 'services') -and (@($script:Manifest['created']['services']) -contains $K.ControlPlaneService)
        if ($exists -and -not $mine) { return 'blocked:service ' + $K.ControlPlaneService + ' already exists and was not created by this script' }
        if (-not $exists) { return 'todo' }
        $spec = Get-ServiceSpecs | Where-Object { $_.Name -ceq $K.ControlPlaneService }
        if ((Test-ServiceFacts (Get-ServiceFactsFor $spec.Name) $spec.Name (Get-ServiceCommandLine $spec.Exe $spec.Config) 'restricted' $true).Count -gt 0) { return 'todo' }
        'done' }
      Do = { New-ControlPlaneService } }
    [pscustomobject]@{ Id = 'shortcuts'; Title = "Make the launcher ($($L.OpenScript)), the Start menu shortcuts in $($L.StartMenuDir) ('Open ALBERA', and 'ALBERA update' when albera-setup.exe is installed) and the HKLM Run entry $($K.RunValueName) for the approver tray"
      Detail = @('the launcher reads ui\room.json, requires the service to be RUNNING and the port to be held by the process the file names, then opens http://127.0.0.1:<port>/room/#b=<code>',
        "HKLM\$($K.RunKeyPath)\$($K.RunValueName) = `"$($L.ApproverExe)`" --tray  (the tray exits quietly for any account that is not the approver)", 'the shortcut folder is born with SYSTEM / Administrators full control and Users read; each shortcut is read back')
      Test = {
        if (-not (Test-ManifestHas 'services')) { return 'todo' }
        if ((Test-ManifestHas 'launcher') -and (Test-ManifestHas 'shortcuts') -and (Test-ManifestHas 'runEntry') -and (Test-ShortcutsInPlace)) { return 'done' }
        'todo' }
      Do = { New-HostShortcuts } }
    [pscustomobject]@{ Id = 'finish'; Title = 'Record the install as complete in the manifest (services stay stopped until the next start of Windows or Start-Service)'
      Detail = @()
      Test = { if ($script:Manifest -and $script:Manifest['state'] -eq 'complete') { 'done' } else { 'todo' } }
      Do = { $script:Manifest['state'] = 'complete'; Save-Manifest; Set-ManifestSetupRunId; Say '    install complete' } }
  )
  if (-not $GrantHyperVToBroker) { return $steps }
  # With the option: the VM lookup comes right after the checks (nothing has been created yet if the VM is missing), the group change right after the services exist.
  $withGrant = New-Object 'System.Collections.Generic.List[object]'
  foreach ($s in $steps) {
    $withGrant.Add($s)
    if ($s.Id -eq 'approver') { $withGrant.Add((Get-HyperVVmStep)) }
    if ($s.Id -eq 'services') { $withGrant.Add((Get-HyperVGrantStep)) }
  }
  $withGrant.ToArray()
}

function Set-ApproverValues {
  $in = Get-ApproverInput
  $shown = [pscustomobject]@{ approverPublicKey = $in.PublicKey; approverKeyId = $in.KeyId; approverSid = $in.Sid }
  # The Control Plane is a service now: its SID is derived from the name, so it is known (and can be compared with the approver's) before anything exists.
  $cp = Get-DerivedServiceSid $K.ControlPlaneService
  $reasons = Test-ApproverValues $shown $in.KeyId $cp
  if ($reasons.Count -gt 0) { Stop-Refused ('approver values rejected: ' + ($reasons -join ', ')) }
  $script:Approver = $shown
  Say "    approver key id $($in.KeyId), approver SID $($in.Sid)"
}

# One service of ours, brought to what this run asks for. A service that exists already (made by an earlier run of this script) is only reconfigured: delayed start, SID type, the one privilege, and
# for the Control Plane the failure actions. Every sc.exe call is checked by its exit code; the facts are read back by the caller.
function New-OneService($Spec) {
  if (-not (Get-CimInstance Win32_Service -Filter "Name='$($Spec.Name)'")) {
    Invoke-Sc (Get-ScCreateArguments $Spec.Name $Spec.Exe $Spec.Config) | Out-Null
    $script:Manifest['created']['services'] = @($script:Manifest['created']['services']) + $Spec.Name; Save-Manifest
  }
  Invoke-Sc "config $($Spec.Name) start= delayed-auto" | Out-Null
  # restricted for all three, except the Broker of an install WITH -GrantHyperVToBroker (Get-ExpectedSidType is the one place that decides)
  if ((Get-ExpectedSidType $Spec.Name $GrantHyperVToBroker) -ceq 'unrestricted') { Invoke-Sc "sidtype $($Spec.Name) unrestricted" | Out-Null } else { Invoke-Sc "sidtype $($Spec.Name) restricted" | Out-Null }
  Invoke-Sc "privs $($Spec.Name) SeChangeNotifyPrivilege" | Out-Null
  if ($Spec.RestartOnFailure) { Invoke-Sc (Get-ScFailureArguments $Spec.Name) | Out-Null }
}
function New-HostServices {
  foreach ($spec in (Get-ServiceSpecs | Where-Object { $_.Phase -eq 'early' })) { New-OneService $spec }
  Resolve-HostSids
  Invoke-Sc ("sdset $($K.BrokerService) " + (Quote-NativeArg (Get-BrokerServiceSddl $script:Sids.ControlPlane))) | Out-Null
  foreach ($spec in (Get-ServiceSpecs | Where-Object { $_.Phase -eq 'early' })) {
    $bad = Test-ServiceFacts (Get-ServiceFactsFor $spec.Name) $spec.Name (Get-ServiceCommandLine $spec.Exe $spec.Config) (Get-ExpectedSidType $spec.Name $GrantHyperVToBroker)
    if ($bad.Count -gt 0) { throw "service $($spec.Name) is not as intended: $($bad -join ', ')" }
  }
  $sd = (Invoke-Sc "sdshow $($K.BrokerService)").Out.Trim()
  $badSd = Test-ServiceSdMatches $sd $script:Sids.ControlPlane
  if ($badSd.Count -gt 0) { throw "the Broker service ACL is not as intended: $($badSd -join ', ')" }
  Say "    services created; Broker SID $($script:Sids.Broker), Authority SID $($script:Sids.Authority); both start delayed"
}
# `launch-check <config>` of the INSTALLED Control Plane host (the copy in the administrator-only bin folder whose tree hash was checked): the service config is validated exactly as the service would, then the checks
# made before every node launch (node hash, app tree, ACLs). Nothing is started. A minimal environment, so nothing the owner's session sets can load code into it. Replaced by a Fake in the tests.
function Invoke-LaunchCheck {
  $r = Invoke-Native $L.ControlPlaneExe ('launch-check ' + (Quote-NativeArg $L.ControlPlaneConfig)) 60000 -MinimalEnvironment
  [pscustomobject]@{ Exit = $r.Exit; Out = (($r.Out + $r.Err) -replace '\s+', ' ').Trim() }
}
function New-ControlPlaneService {
  $spec = Get-ServiceSpecs | Where-Object { $_.Name -ceq $K.ControlPlaneService }
  $check = Invoke-LaunchCheck
  if ($check.Exit -ne 0) { throw "launch-check of the installed Control Plane host answered $($check.Exit), so the service was NOT registered: $($check.Out)" }
  Say "    launch-check: $($check.Out)"
  New-OneService $spec
  Resolve-HostSids
  $bad = Test-ServiceFacts (Get-ServiceFactsFor $spec.Name) $spec.Name (Get-ServiceCommandLine $spec.Exe $spec.Config) 'restricted' $true
  if ($bad.Count -gt 0) { throw "service $($spec.Name) is not as intended: $($bad -join ', ')" }
  Say "    service $($spec.Name) created; SID $($script:Sids.ControlPlane); delayed start; restarts twice after 5 s on failure"
}

# ---------------------------------------------------------------------------------------------- the pinned programs: node.exe and Claude Code
# Both are copied into administrator-only folders and the SHA-256 of the COPY is recorded (the service config names it). The source is trusted as the owner's PC is at the moment of the copy (control-plane-service.md
# section 8, "What stays trust"): nothing here proves where node.exe or claude.exe came from. Neither is started.
function Get-NodeSourceFile { if ($NodeSource) { $NodeSource } else { Get-NodeSourcePath $ProgramFilesDir } }
function Get-ElevatedSid { [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
# The profile folder Windows records for this SID (HKLM ...\ProfileList\<SID>\ProfileImagePath), or $null. Never an environment variable: this console may have been started from a poisoned session.
function Get-OwnerProfilePath([string]$Sid) {
  if (-not (Test-AccountSidShape $Sid)) { return $null }
  $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $Sid)
  if (-not $key) { return $null }
  try { $value = $key.GetValue('ProfileImagePath', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { $key.Dispose() }
  if ($value -is [string] -and (Test-PlainAbsolutePath $value)) { $value } else { $null }
}
function Get-ClaudeSourceFile {
  if ($ClaudeSource) { return $ClaudeSource }
  $profile = Get-OwnerProfilePath (Get-ApproverInput).Sid
  if (-not $profile) { return $null }
  Get-ClaudeSourcePath $profile
}
# A source program must be an existing regular file with no link anywhere on its path. Returns the reason, or $null.
function Get-PinSourceProblem($Path, [string]$What) {
  if (-not $Path) { return "$What cannot be located" }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "$What not found at $Path" }
  if ((Get-ReparseChain $Path).Count -gt 0) { return "$What is reached through a link ($Path)" }
  $null
}
# node.exe is looked for in Program Files, so its file AND its folder must pass the trust test (owner SYSTEM / Administrators / TrustedInstaller, nobody else may write, no link). The lab-only -NodeSource is a file
# in a disposable VM and is not judged. claude.exe is the other way round: it lives in the owner's own profile, where the owner (and anything running as the owner) can write by design, so it has no such test;
# the handle the copy is made from is what is checked (Copy-PinnedFile).
function Get-NodePinProblem {
  $path = Get-NodeSourceFile
  $problem = Get-PinSourceProblem $path 'node.exe'
  if ($problem) { return $problem }
  if ($NodeSource) { return $null }
  foreach ($p in @($path, (Split-Path -Parent $path))) {
    $reasons = Get-PathTrustReasons $p (Get-AdminSids) $false
    if ($reasons.Count -gt 0) { return 'the node.exe source cannot be trusted: ' + (Format-TrustRefusal $p $reasons) }
  }
  $null
}
function Get-ClaudePinProblem {
  $in = Get-ApproverInput
  if (-not $in.Sid) { return 'the approver SID is not given yet, so claude.exe cannot be located' }
  $refusal = Get-ClaudePinRefusal (Get-ElevatedSid) $in.Sid
  if ($refusal) { return "${refusal}: run this as the account that owns the Claude Code you want to pin (the approver account)" }
  Get-PinSourceProblem (Get-ClaudeSourceFile) 'claude.exe'
}
# GetFinalPathNameByHandleW, declared with System.Reflection.Emit (no Add-Type: that would start the C# compiler from an elevated session and load a DLL from a temp folder). Returns the path the OPEN handle
# really points at, without the \\?\ prefix; a UNC path is refused.
$script:FinalPathMethod = $null
function Get-FinalPathOfStream([System.IO.FileStream]$Stream) {
  if (-not $script:FinalPathMethod) {
    $assembly = [System.AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object System.Reflection.AssemblyName('AlberaFinalPath')), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
    $type = $assembly.DefineDynamicModule('AlberaFinalPath').DefineType('Native', [System.Reflection.TypeAttributes]'Public, Class')
    $method = $type.DefinePInvokeMethod('GetFinalPathNameByHandleW', 'kernel32.dll', [System.Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [System.Reflection.CallingConventions]::Standard,
      [uint32], [Type[]]@([IntPtr], [System.Text.StringBuilder], [uint32], [uint32]), [System.Runtime.InteropServices.CallingConvention]::Winapi, [System.Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags([System.Reflection.MethodImplAttributes]::PreserveSig)
    $script:FinalPathMethod = $type.CreateType().GetMethod('GetFinalPathNameByHandleW')
  }
  $builder = New-Object System.Text.StringBuilder 2048
  $arguments = New-Object 'object[]' 4   # filled one by one: an array literal would wrap the StringBuilder in a PSObject, which reflection cannot pass on
  $arguments[0] = $Stream.SafeFileHandle.DangerousGetHandle(); $arguments[1] = $builder.PSObject.BaseObject; $arguments[2] = [uint32]$builder.Capacity; $arguments[3] = [uint32]0
  $length = [uint32]$script:FinalPathMethod.Invoke($null, $arguments)
  if ($length -eq 0 -or $length -ge $builder.Capacity) { throw 'the final path of the opened file could not be read' }
  $path = $builder.ToString()
  if ($path.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'the opened file is on a network share; refused' }
  if ($path.StartsWith('\\?\', [System.StringComparison]::Ordinal)) { $path = $path.Substring(4) }
  $path
}
# Copy a file into an administrator-only folder under a .partial name, from ONE handle opened on the source (final path checked), hash the COPY, rename it, check the result with the same trust test as every other file. Returns the SHA-256 of the copy.
function Copy-PinnedFile([string]$Source, [string]$Destination) {
  $dir = Split-Path -Parent $Destination
  if (-not (Test-Path -LiteralPath $dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
  $untrusted = Get-PathTrustReasons $dir (Get-AdminSids) $false
  if ($untrusted.Count -gt 0) { throw (Format-TrustRefusal $dir $untrusted) }
  if (Test-Path -LiteralPath $Destination) { throw "$Destination already exists" }
  $partial = $Destination + '.partial'
  if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
  # The source is opened ONCE (nobody else may write it while it is open) and the bytes are copied from that handle. After the open the handle is asked for its final path: it must be exactly the path
  # that was asked for, so a link anywhere on the way (put there after the earlier checks) is caught on the thing that is actually read. The hash is that of the COPY.
  $in = $null; $out = $null
  try {
    $in = New-Object System.IO.FileStream($Source, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $final = Get-FinalPathOfStream $in
    $expected = [System.IO.Path]::GetFullPath($Source)
    if (-not [string]::Equals($final, $expected, [System.StringComparison]::OrdinalIgnoreCase)) { throw "the file that was opened is at ${final}, not at ${expected}: a link is on the path; nothing was copied" }
    $out = New-Object System.IO.FileStream($partial, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $in.CopyTo($out)
    $out.Flush()
    $out.Dispose(); $out = $null
    $in.Dispose(); $in = $null
    $sha = Get-Sha256File $partial
    Move-Item -LiteralPath $partial -Destination $Destination
  }
  catch { if ($out) { $out.Dispose() }; if ($in) { $in.Dispose() }; if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }; throw }
  finally { if ($out) { $out.Dispose() }; if ($in) { $in.Dispose() } }
  $after = Get-PathTrustReasons $Destination (Get-AdminSids) $false
  if ($after.Count -gt 0) { Remove-Item -LiteralPath $Destination -Force; throw (Format-TrustRefusal $Destination $after) }
  $sha
}
function Copy-PinnedNode {
  $problem = Get-NodePinProblem; if ($problem) { throw $problem }
  $sha = Copy-PinnedFile (Get-NodeSourceFile) $L.ControlPlaneNodeExe
  $rec = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $rec['serviceSid'] = Get-DerivedServiceSid $K.ControlPlaneService; $rec['nodeSha256'] = $sha; $rec['nodeSource'] = [string](Get-NodeSourceFile)
  $script:Manifest['created']['controlPlane'] = $rec; Save-Manifest
  Say "    node.exe copied to $($L.ControlPlaneNodeExe); sha256 $sha"
}
function Copy-PinnedClaude {
  $problem = Get-ClaudePinProblem; if ($problem) { throw $problem }
  $source = [string](Get-ClaudeSourceFile)
  $sha = Copy-PinnedFile $source $L.ClaudeExe
  $version = [string][System.Diagnostics.FileVersionInfo]::GetVersionInfo($L.ClaudeExe).FileVersion   # read from the file's version resource; the program is not started
  if ($version.Length -gt 64) { $version = $version.Substring(0, 64) }
  $rec = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $rec['sha256'] = $sha; $rec['fileVersion'] = $version; $rec['source'] = $source
  $script:Manifest['created']['claude'] = $rec; Save-Manifest
  Say "    claude.exe copied to $($L.ClaudeExe); sha256 $sha; file version '$version'"
}

# ---------------------------------------------------------------------------------------------- the launcher, the shortcuts and the tray entry
function Get-RunEntryValue {
  $e = Get-RunEntry $L
  $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($e.KeyPath)
  if (-not $key) { return $null }
  try { $key.GetValue($e.Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { $key.Dispose() }
}
function Set-RunEntryValue {
  $e = Get-RunEntry $L
  $key = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey($e.KeyPath)
  try { $key.SetValue($e.Name, $e.Command, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
}
function Remove-RunEntryValue {
  $e = Get-RunEntry $L
  $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($e.KeyPath, $true)
  if (-not $key) { return }
  try { $key.DeleteValue($e.Name, $false) } finally { $key.Dispose() }
}
function New-ShellLink($Spec) {
  $shell = New-Object -ComObject WScript.Shell
  try {
    $link = $shell.CreateShortcut($Spec.Path)
    $link.TargetPath = $Spec.Target; $link.Arguments = $Spec.Arguments; $link.WorkingDirectory = $Spec.WorkingDirectory; $link.Description = $Spec.Description
    $link.Save()
  }
  finally { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}
function Read-ShellLink([string]$Path) {
  if (-not [System.IO.File]::Exists($Path)) { return $null }
  $shell = New-Object -ComObject WScript.Shell
  try { $link = $shell.CreateShortcut($Path); [pscustomobject]@{ TargetPath = [string]$link.TargetPath; Arguments = [string]$link.Arguments; WorkingDirectory = [string]$link.WorkingDirectory } }
  finally { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}
function Get-CurrentShortcutSpecs {
  $usable = (Test-Path -LiteralPath $L.SetupExe -PathType Leaf) -and -not (Get-SetupExeProblem)   # the update shortcut only for a setup that passed the trust test
  Get-ShortcutSpecs $L $SystemDirectory ([bool]$usable)
}
# True when the launcher is the file install wrote, every shortcut matches its spec and the Run value is the recorded command (the live state, read back).
function Test-ShortcutsInPlace {
  $M = $script:Manifest['created']
  if (-not (Test-Path -LiteralPath $L.OpenScript) -or (Get-Sha256File $L.OpenScript) -cne $M['launcher']['sha256']) { return $false }
  foreach ($spec in (Get-CurrentShortcutSpecs)) {
    if (@($M['shortcuts']) -cnotcontains (Split-Path -Leaf $spec.Path)) { return $false }
    if ((Test-ShortcutMatches $spec (Read-ShellLink $spec.Path)).Count -gt 0) { return $false }
  }
  (Get-RunEntryValue) -ceq (Get-RunEntry $L).Command
}
function New-HostShortcuts {
  $M = $script:Manifest['created']
  # the launcher: text made by this script, written into bin\launcher (administrator-only by inheritance, trust-checked), its hash recorded
  if (-not (Test-Path -LiteralPath $L.LauncherDir)) { [void][System.IO.Directory]::CreateDirectory($L.LauncherDir) }
  $untrusted = Get-PathTrustReasons $L.LauncherDir (Get-AdminSids) $false
  if ($untrusted.Count -gt 0) { throw (Format-TrustRefusal $L.LauncherDir $untrusted) }
  Grant-UsersReadExecute $L.LauncherDir   # the owner's session runs the launcher
  Write-OneConfig $L.OpenScript (Get-OpenAlberaScriptText $L) (Get-AdminSids)
  $launcher = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $launcher['sha256'] = Get-Sha256File $L.OpenScript
  $M['launcher'] = $launcher; Save-Manifest
  # the Start menu folder: born with its final ACL (everyone may read, only administrators write), or - from an earlier run - re-checked
  if (Test-Path -LiteralPath $L.StartMenuDir) {
    $why = Get-PathTrustReasons $L.StartMenuDir (Get-AdminSids) $false
    if ($why.Count -gt 0) { throw (Format-TrustRefusal $L.StartMenuDir $why) }
  }
  else { New-TrustedDirectory $L.StartMenuDir @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-32-545:(OI)(CI)RX') }
  $made = @()
  $setupProblem = Get-SetupExeProblem
  if ($setupProblem) { Say "    the 'ALBERA update' shortcut is NOT made: $setupProblem" }
  foreach ($spec in (Get-CurrentShortcutSpecs)) {
    if (Test-Path -LiteralPath $spec.Path) { Remove-Item -LiteralPath $spec.Path -Force }
    New-ShellLink $spec
    $bad = Test-ShortcutMatches $spec (Read-ShellLink $spec.Path)
    if ($bad.Count -gt 0) { throw "the shortcut $($spec.Path) is not as intended: $($bad -join ', ')" }
    $made += Split-Path -Leaf $spec.Path
  }
  $M['shortcuts'] = @($made); Save-Manifest
  # the tray: HKLM Run (only an administrator can write it), read back
  Set-RunEntryValue
  $entry = Get-RunEntry $L
  if ((Get-RunEntryValue) -cne $entry.Command) { throw 'the HKLM Run value is not what was written' }
  $run = New-Object 'System.Collections.Generic.Dictionary[string,object]'; $run['name'] = $entry.Name; $run['command'] = $entry.Command
  $M['runEntry'] = $run; Save-Manifest
  Say "    launcher written; shortcuts: $($made -join ', '); Run value $($entry.Name) set; all read back"
}

# ---------------------------------------------------------------------------------------------- the Hyper-V grant (-GrantHyperVToBroker; ADR-002 Amendment 2026-11-03)
# The only code that adds or removes a member of Hyper-V Administrators is Grant-BrokerHyperV / Revoke-BrokerHyperV below, and both take the group and the member from Get-HyperVGrantPlan, which can only
# return the Broker's own derived service SID (never albera-cp, never the Authority). A test pins that no other call exists.
$script:ResolvedVm = $null
# Read only. root\virtualization\v2 needs an administrator (or a Hyper-V Administrators member). $VmName passed the id grammar (no quote character), so it is safe inside the WQL filter.
function Get-VmCandidates {
  @(Get-CimInstance -Namespace 'root\virtualization\v2' -ClassName Msvm_ComputerSystem -Filter "ElementName='$VmName'" -ErrorAction Stop)
}
# Kind: ok (Id is the lowercase GUID) | refused (the VM is missing or the name is not unique) | unreadable (the VM list could not be read). -VmId (lab only) replaces the lookup.
function Resolve-BrokerVm {
  if ($script:ResolvedVm) { return $script:ResolvedVm }
  if ($VmId) { $script:ResolvedVm = [pscustomobject]@{ Kind = 'ok'; Id = $VmId; Message = '' }; return $script:ResolvedVm }
  try { $candidates = Get-VmCandidates }
  catch { return [pscustomobject]@{ Kind = 'unreadable'; Id = $null; Message = "the Hyper-V virtual machine list could not be read (needs an elevated console and the Hyper-V role): $($_.Exception.Message)" } }
  $pick = Select-VmByName $candidates $VmName
  if ($pick.Ok) { $script:ResolvedVm = [pscustomobject]@{ Kind = 'ok'; Id = $pick.VmId; Message = '' }; return $script:ResolvedVm }
  $why = if ($pick.Reason -eq 'vm_name_ambiguous') { "more than one virtual machine is named $VmName; make the name unique first, otherwise the GUID would be a guess" } else { "no virtual machine is named $VmName (check the exact name in Hyper-V Manager); create it first or pass its exact name as -VmName" }
  [pscustomobject]@{ Kind = 'refused'; Id = $null; Message = $why }
}
function Get-HyperVVmStep {
  [pscustomobject]@{ Id = 'vm'; Title = "Look up the GUID of the virtual machine $VmName (read only; -GrantHyperVToBroker)"
    Detail = @("exactly one VM must have that name; its GUID goes into the Broker config as computers: $ComputerId -> <guid>; the Broker queries by GUID and never by name", 'reading the VM list needs an elevated console (or Hyper-V Administrators), so a plan run without admin rights can only say "unknown"')
    Test = { $vm = Resolve-BrokerVm; if ($vm.Kind -eq 'ok') { 'todo' } elseif ($vm.Kind -eq 'refused') { 'blocked:' + $vm.Message } else { 'unknown:' + $vm.Message } }
    Do = { $vm = Resolve-BrokerVm; if ($vm.Kind -ne 'ok') { throw $vm.Message }; Say "    virtual machine $VmName is $($vm.Id)" } }
}
function Get-HyperVGrantStep {
  [pscustomobject]@{ Id = 'hyperv'; Title = "Add ONLY the Broker's service SID ($(Get-DerivedServiceSid $K.BrokerService)) to BUILTIN\Hyper-V Administrators (S-1-5-32-578) and record it in the manifest (-GrantHyperVToBroker)"
    Detail = @("$($K.ControlPlaneService) (and the legacy account $($K.ControlPlaneUser)) and the Authority are never added; membership is all-or-nothing in Windows, so the Broker's code (a fixed allowlist: screen capture and keyboard/mouse of the one VM in its config) is what limits it",
      'the record is written BEFORE the member is added and the membership is read back; uninstall removes the SID from the group first, before the service is deleted')
    Test = {
      if (-not (Test-ManifestHas 'services')) { return 'todo' }
      # done only with a record AND a member list that has nothing to report (so a Grant that added the Broker and then found albera-cp in the group is run again, and fails again, instead of passing)
      try { Resolve-HostSids; if ((Test-ManifestHas 'hyperVGrant') -and (Get-HyperVMemberProblems).Count -eq 0) { 'done' } else { 'todo' } } catch { 'todo' } }
    Do = { Grant-BrokerHyperV } }
}
function Get-HyperVRevokeStep {
  [pscustomobject]@{ Id = 'hyperv'; Title = "Remove the Broker's service SID from Hyper-V Administrators (the install record says -GrantHyperVToBroker added it), BEFORE the service is deleted"
    Detail = @('a deleted service leaves its SID in the group, and the next service of that name would inherit the right: so the SID leaves first, is read back, and the run stops if it is still there', 'no other member of the group is touched')
    Test = { if (Test-ManifestHas 'hyperVGrant') { 'todo' } else { 'done' } }
    Do = { Revoke-BrokerHyperV } }
}
# $true when the local group with this SID exists; $false ONLY when Windows says the SID maps to no account (IdentityNotMappedException). Any other failure is thrown: "I could not find out" must never
# read as "the group is not there" (the undo would drop its record and delete the service on that reading).
function Test-LocalGroupExists([string]$GroupSid) {
  try { $null = (New-Object System.Security.Principal.SecurityIdentifier($GroupSid)).Translate([System.Security.Principal.NTAccount]); return $true }
  catch {
    $notMapped = [System.Security.Principal.IdentityNotMappedException]
    if (($_.Exception -is $notMapped) -or ($_.Exception.InnerException -is $notMapped)) { return $false }
    throw
  }
}
# What is wrong with Hyper-V Administrators right now, whether or not the install record mentions it (empty = nothing). A group that is not there has no member to be wrong, unless the record says the Broker
# should be in it. albera-cp and the Authority are looked for every time; the Broker is expected exactly when the record says the grant was made.
function Get-HyperVMemberProblems {
  $hv = Get-HyperVGrantPlan $script:Sids
  $recorded = [bool](Test-ManifestHas 'hyperVGrant')
  if (-not (Test-LocalGroupExists $hv.Group)) { if ($recorded) { return , @('group_missing') } else { return , @() } }
  Test-HyperVMembers @(Get-LocalGroupMemberSids $hv.Group) $script:Sids $recorded
}
function Grant-BrokerHyperV {
  Resolve-HostSids
  $vm = Resolve-BrokerVm
  if ($vm.Kind -ne 'ok') { throw $vm.Message }
  $hv = Get-HyperVGrantPlan $script:Sids
  if (-not (Test-LocalGroupExists $hv.Group)) { throw "the local group $($hv.Group) (Hyper-V Administrators) does not exist on this PC; nothing was added" }
  # The record comes first: a crash before the add leaves a record for a SID that is not in the group (uninstall copes), never a member that nothing records.
  $rec = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $rec['group'] = $hv.Group; $rec['sid'] = $hv.Member; $rec['computerId'] = $ComputerId; $rec['vmId'] = $vm.Id
  $script:Manifest['created']['hyperVGrant'] = $rec; Save-Manifest
  if ((Get-LocalGroupMemberSids $hv.Group) -notcontains $hv.Member) { Add-LocalGroupMember -SID $hv.Group -Member $hv.Member }
  $bad = Test-HyperVMembers (Get-LocalGroupMemberSids $hv.Group) $script:Sids
  if ($bad.Count -gt 0) { throw "Hyper-V Administrators is not as intended after the change: $($bad -join ', ')" }
  Say "    Broker service SID $($hv.Member) is a member of Hyper-V Administrators ($($hv.Group)); read back. Control Plane and Authority are not. VM $ComputerId -> $($vm.Id)"
}
function Revoke-BrokerHyperV {
  Resolve-HostSids
  $hv = Get-HyperVGrantPlan $script:Sids
  $rec = $script:Manifest['created']['hyperVGrant']
  if ($rec['sid'] -cne $hv.Member -or $rec['group'] -cne $hv.Group) { throw 'internal: the grant record does not name the Broker service SID; refusing to remove anything' }
  if (Test-LocalGroupExists $hv.Group) {   # throws on anything but "no such group": the record stays and the services are not deleted
    # Removed without asking first (asking needs a readable member list, and a failed read must not leave the right in place); "not a member" is fine, the read-back below is what counts.
    try { Remove-LocalGroupMember -SID $hv.Group -Member $hv.Member } catch { Say "    Remove-LocalGroupMember said: $($_.Exception.Message)" }
    if ((Get-LocalGroupMemberSids $hv.Group) -contains $hv.Member) { throw "the Broker service SID $($hv.Member) is still in Hyper-V Administrators; the services were NOT deleted. Remove it yourself (Remove-LocalGroupMember -SID $($hv.Group) -Member $($hv.Member)) and run uninstall again" }
    Say "    removed the Broker service SID from Hyper-V Administrators; read back"
  }
  else { Say '    the group Hyper-V Administrators does not exist on this PC; nothing to remove' }
  $script:Manifest['created'].Remove('hyperVGrant') | Out-Null; Save-Manifest
}

# A folder born with its final descriptor (New-SecuredDirectory reads back owner, protected DACL and accounts) and then re-checked with the SAME trust test used for existing folders (owner SYSTEM/Administrators,
# no other writer, no link on the way). Throws before any later step - user, services, Save-Manifest - can run on a folder that is not what was asked for.
function New-TrustedDirectory([string]$Path, [string[]]$Grants, [string]$OwnerSid = 'S-1-5-32-544') {
  New-SecuredDirectory $Path $Grants $OwnerSid
  $reasons = Get-PathTrustReasons $Path (Get-PlannedWriters ([pscustomobject]@{ Grants = $Grants })) $true
  if ($reasons.Count -gt 0) { throw (Format-TrustRefusal $Path $reasons) }
}
# Every folder is created WITH its final security descriptor (owner Administrators, protected DACL), so there is no moment with an inherited ACL. A folder that already exists is used only after
# it passed the trust checks (owner, writers, no link on the way); only then is its ACL brought to the plan (Set-HostAcl: DACL through .NET, owner through icacls).
function New-HostFolders {
  Resolve-HostSids
  # C:\Program Files\Albera made by albera-setup.exe (bin\setup, setup-work) is adopted: it has just passed Get-InstallRootAdoptionReasons (trusted owner, nobody else may write, no link, nothing but setup's folders)
  # and is recorded as ours (uninstall then removes our folders from it and leaves setup's). Its inherited ACL is replaced by the plan below like any other folder's.
  $adopted = $false
  if ((Test-Path -LiteralPath $L.InstallRoot) -and -not (Test-ManifestHas 'installRoot')) {
    $why = Get-InstallRootAdoptionReasons
    if ($why.Count -gt 0) { throw ($L.InstallRoot + ' exists but was not created by this script and is not only albera-setup.exe''s own folders (' + ($why -join ', ') + ')') }
    $script:Manifest['created']['installRoot'] = $true; Save-Manifest; $adopted = $true
    Say "    $($L.InstallRoot) was made by albera-setup.exe (bin\setup, setup-work); adopted"
  }
  $plan = @(Get-AclPlan $L $script:Sids)
  foreach ($entry in $plan) { if (-not ($adopted -and $entry.Path -ceq $L.InstallRoot)) { Assert-PlannedPathTrusted $entry } }
  foreach ($entry in $plan) {
    if (Test-Path -LiteralPath $entry.Path) { Set-HostAcl $entry; continue }
    New-TrustedDirectory $entry.Path $entry.Grants
    if ($entry.Path -ceq $L.InstallRoot) { $script:Manifest['created']['installRoot'] = $true; Save-Manifest }
  }
  foreach ($entry in $plan) {
    $diffs = Test-AclMatchesPlan $entry (Get-AclSummary $entry.Path)
    if ($diffs.Count -gt 0) { throw "ACL of $($entry.Path) is not as planned: $($diffs -join ', ')" }
  }
  if (Test-Path -LiteralPath $L.SetupBinDir) { Grant-UsersReadExecute $L.SetupBinDir }   # the owner's setup folder lost the Users rule it inherited from Program Files when the root's inheritance was removed
  Say '    folders created with their final ACL; every ACL read back and matches the plan; Users may read and execute bin\approver, bin\launcher and bin\setup only'
}

# The copies are made INSIDE the already administrator-only bin folder and only the COPIES are hashed: all five components are copied to .partial folders, the canonical tree hash of the copies must equal
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
    $have = Get-ComponentHashes $dirs -Installed
    $tree = Get-CanonicalTreeHash $have
    if ($tree -cne $state.Value) { throw "the installed copies hash to $tree, not to -ExpectedTreeHash; update means uninstall, then install" }
    foreach ($s in $sources) { if (-not $record.ContainsKey($s.Name)) { Set-BinaryRecord $s (Get-TreeHashes $s.Dest $(if ($s.Name -eq 'control-plane') { @('node') } else { @() })) } }
    Grant-UsersReadExecute $L.ApproverBinDir   # a run that was cut off between the move and this line is finished here
    return
  }
  if ($present.Count -gt 0) { throw "$($L.BinRoot) holds only part of the builds; uninstall, then install again" }
  $listings = @{}
  foreach ($s in $sources) { $listings[$s.Name] = Get-SourceFiles $s.Dir }   # refuses a link or junction in a publish folder
  # the folder node\ of the control-plane component is where install puts the pinned node.exe, AFTER the tree hash was checked: a build that ships one would be hashed with it, and the installed copy could not be compared
  if (@($listings['control-plane'] | Where-Object { $_.Rel.StartsWith('node\', [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) { throw 'the control-plane build has a node\ folder; that folder is reserved for the pinned node.exe' }
  foreach ($s in $sources) {
    $partial = $s.Dest + '.partial'
    if (Test-Path -LiteralPath $partial) { Remove-TreeNoFollow $partial }   # left by a failed run of this script, inside the administrator-only bin folder
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
    foreach ($s in $sources) { if (Test-Path -LiteralPath ($s.Dest + '.partial')) { Remove-TreeNoFollow ($s.Dest + '.partial') } }
    throw
  }
  foreach ($s in $sources) { Move-Item -LiteralPath ($s.Dest + '.partial') -Destination $s.Dest }
  foreach ($s in $sources) { Set-BinaryRecord $s (Get-TreeHashes $s.Dest) }
  Grant-UsersReadExecute $L.ApproverBinDir   # only the approver (the owner's session runs it), and only now: the .partial folder it was copied into had no Users rule
  Say "    all five builds match the tree hash $tree"
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
  if ($o.Exit -ne 0) { throw (Format-NativeFailure "icacls /setowner failed for $Path" $o) }
  $after = Get-PathTrustReasons $Path $Writers $false
  if ($after.Count -gt 0) { throw (Format-TrustRefusal $Path $after) }
}
# -GrantHyperVToBroker only: SHA-256 of the pipe client helper as it is installed now (the copy in the administrator-only bin folder), for the `desktop` block of the Control Plane
# settings. It must equal the exe hash the install record took when it copied and verified the build; if the two differ the copy changed in between and nothing is written.
function Get-DesktopHelperSha256 {
  if (-not (Test-Path -LiteralPath $L.PipeClientExe -PathType Leaf)) { throw "the pipe client helper is not installed at $($L.PipeClientExe)" }
  $live = Get-Sha256File $L.PipeClientExe
  $binaries = if ($script:Manifest) { $script:Manifest['created']['binaries'] } else { $null }
  if ($null -eq $binaries -or -not $binaries.ContainsKey('pipe-client')) { throw 'the install record has no pipe client helper hash' }
  if ($binaries['pipe-client']['exeSha256'] -cne $live) { throw 'the installed pipe client helper differs from the install record' }
  $live
}
function Write-HostConfigs {
  Resolve-HostSids
  if (-not $script:Approver) { throw 'internal: approver values missing' }
  $spki = $script:Manifest['values']['authoritySpki']
  $cp = $script:Sids.ControlPlane
  $computers = $null
  $helperSha = $null
  if ($GrantHyperVToBroker) {
    $vm = Resolve-BrokerVm
    if ($vm.Kind -ne 'ok') { throw $vm.Message }
    $computers = Get-BrokerComputers $ComputerId $vm.Id
    $helperSha = Get-DesktopHelperSha256
  }
  $brokerJson = ConvertTo-HostJson (Get-BrokerConfig $L $cp $spki $computers)
  $authorityJson = ConvertTo-HostJson (Get-AuthorityConfig $cp $script:Approver)
  $settingsJson = ConvertTo-HostJson (Get-ControlPlaneSettings $L $ProjectId $VmName $ComputerId $helperSha)
  if (-not (Test-ManifestHas 'controlPlane') -or -not (Test-ManifestHas 'claude')) { throw 'the node.exe and claude.exe pins are not recorded yet; the service config names their hashes' }
  $nodeSha = $script:Manifest['created']['controlPlane']['nodeSha256']; $claudeSha = $script:Manifest['created']['claude']['sha256']
  $serviceJson = ConvertTo-HostJson (Get-ControlPlaneServiceConfig $L $nodeSha $claudeSha $cp $script:Approver.approverSid)
  foreach ($pair in @(@('broker config', (Test-BrokerConfigText $brokerJson)), @('authority config', (Test-AuthorityConfigText $authorityJson)),
      @('control plane service config', (Test-ControlPlaneServiceConfigText $serviceJson $L $nodeSha $claudeSha $cp $script:Approver.approverSid)))) {
    if ($pair[1].Count -gt 0) { throw "$($pair[0]) failed this script's own check: $($pair[1] -join ', ')" }
  }
  if ($GrantHyperVToBroker -and -not (Test-ControlPlaneDesktop $settingsJson $L.PipeClientExe $helperSha)) { throw 'control plane settings failed this script''s own check: desktop' }
  $plan = @(Get-AclPlan $L $script:Sids)
  $writersOf = { param($dir) Get-PlannedWriters ($plan | Where-Object { $_.Path -ceq $dir } | Select-Object -First 1) }
  Write-OneConfig $L.BrokerConfig $brokerJson (& $writersOf $L.BrokerConfigDir)
  Write-OneConfig $L.AuthorityConfig $authorityJson (& $writersOf $L.AuthorityDir)
  Write-OneConfig $L.ControlPlaneConfig $serviceJson (& $writersOf $L.ControlPlaneConfigDir)
  Write-OneConfig $L.ApprovalSettings $settingsJson (& $writersOf $L.ControlPlaneConfigDir)
  $values = $script:Manifest['values']
  $values['controlPlaneSid'] = $cp; $values['approverSid'] = $script:Approver.approverSid; $values['approverKeyId'] = $script:Approver.approverKeyId
  $values['brokerServiceSid'] = $script:Sids.Broker; $values['authorityServiceSid'] = $script:Sids.Authority; Save-Manifest
  Say '    configs written and re-checked; service-check of the Broker and the Authority was NOT run (see the plan); their first service start is the real test'
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
  $grantRecorded = [bool](Test-ManifestHas 'hyperVGrant')
  Add-Line $(if ($M['state'] -eq 'complete') { 'ok' } else { 'FAIL' }) "install state: $($M['state'])"
  try {
    Resolve-HostSids
    if ($M['created'].ContainsKey('user')) {
      # the first layout: the local account albera-cp. Reported as it was, and as the thing that has to go (-Mode migrate); the checks below then show what the new layout still lacks.
      $live = Get-LiveControlPlaneUser
      $why = Test-OwnedUser $M['created']['user'] $live
      $admins = @(Get-LocalGroupMemberSids 'S-1-5-32-544')
      $good = ($why.Count -eq 0) -and $live.Enabled -and ($admins -notcontains $live.Sid)
      Add-Line $(if ($good) { 'ok' } else { 'FAIL' }) ("user $($K.ControlPlaneUser): " + $(if ($good) { 'present, enabled, not an Administrator, description and SID as recorded' } else { ($why -join ', ') + ' (or disabled / an Administrator)' }))
      Add-Line 'FAIL' "install layout: the first layout (the local account $($K.ControlPlaneUser) is the Control Plane). Run -Mode migrate once; the Control Plane is a service now (control-plane-service.md section 9)"
    }
    foreach ($spec in (Get-ServiceSpecs)) {
      $facts = Get-ServiceFactsFor $spec.Name
      if (-not $facts.Exists -and $spec.Phase -eq 'late' -and (Test-LegacyLayout)) { continue }   # the first layout has no Control Plane service; the line above says so
      $bad = Test-ServiceFacts $facts $spec.Name (Get-ServiceCommandLine $spec.Exe $spec.Config) (Get-ExpectedSidType $spec.Name $grantRecorded) $spec.RestartOnFailure
      if ($spec.Name -eq $K.BrokerService -and $facts.Exists) {
        # Assign first: the test functions return , @(list), and @(call) would keep the outer array, so an empty result would count as one item.
        $badSd = Test-ServiceSdMatches (Invoke-Native $ScExe "sdshow $($spec.Name)").Out.Trim() $script:Sids.ControlPlane
        $bad = @($bad) + @($badSd)
      }
      Add-Line $(if ($bad.Count -eq 0) { 'ok' } else { 'FAIL' }) ("service $($spec.Name): " + $(if ($bad.Count -eq 0) { "as installed (state $($facts.State))" } else { $bad -join ', ' }))
    }
    # The group is read every time, record or not: albera-cp and the Authority must never be in it, and the Broker only when the record says so. A clean group of an install without the grant adds no line.
    $hvBad = @(); $hvRead = $true
    try { $hvBad = Get-HyperVMemberProblems } catch { $hvRead = $false; Add-Line 'unknown' ('Hyper-V Administrators: the member list could not be read: ' + $_.Exception.Message) }
    if ($hvRead -and ($grantRecorded -or $hvBad.Count -gt 0)) {
      Add-Line $(if ($hvBad.Count -eq 0) { 'ok' } else { 'FAIL' }) ('Hyper-V Administrators: ' + $(if ($hvBad.Count -eq 0) { "the Broker service SID is a member; $(if (Test-LegacyLayout) { $K.ControlPlaneUser } else { $K.ControlPlaneService }) and the Authority are not" } else { $hvBad -join ', ' }))
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
      $exclude = if ($s.Name -eq 'control-plane') { @('node') } else { @() }   # the pinned node\ has its own line below
      $same = (Test-Path -LiteralPath $s.Dest) -and ((Get-TreeHashes $s.Dest $exclude).Tree -eq $M['created']['binaries'][$s.Name]['treeSha256'])
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
    if ($grantRecorded -and (Test-Path -LiteralPath $L.BrokerConfig)) {
      $rec = $M['created']['hyperVGrant']
      $same = Test-BrokerConfigComputers ([System.IO.File]::ReadAllText($L.BrokerConfig)) $rec['computerId'] $rec['vmId']
      Add-Line $(if ($same) { 'ok' } else { 'FAIL' }) ('Broker config computers: ' + $(if ($same) { "$($rec['computerId']) -> $($rec['vmId']), as recorded" } else { 'not the one computer the install recorded' }))
    }
    Add-Line $(if (Test-Path -LiteralPath $L.ApprovalSettings) { 'ok' } else { 'FAIL' }) "Control Plane settings: $(if (Test-Path -LiteralPath $L.ApprovalSettings) { 'present' } else { 'missing' })"
    foreach ($line in (Get-ControlPlaneStatusLines)) { Add-Line $line.State $line.Text }
    if ($grantRecorded -and (Test-Path -LiteralPath $L.ApprovalSettings)) {
      $recordedHelper = if ($M['created']['binaries'].ContainsKey('pipe-client')) { $M['created']['binaries']['pipe-client']['exeSha256'] } else { '' }
      $same = Test-ControlPlaneDesktop ([System.IO.File]::ReadAllText($L.ApprovalSettings)) $L.PipeClientExe $recordedHelper
      Add-Line $(if ($same) { 'ok' } else { 'FAIL' }) ('Control Plane settings desktop: ' + $(if ($same) { 'the installed pipe client helper and its recorded SHA-256, as written by install' } else { 'not the helper path and SHA-256 the install recorded' }))
    }
    # an install without the grant writes no desktop block: one found anyway was not written by this install (a clean install has no such line)
    if (-not $grantRecorded -and (Test-Path -LiteralPath $L.ApprovalSettings) -and (Test-ControlPlaneHasDesktopKey ([System.IO.File]::ReadAllText($L.ApprovalSettings)))) {
      Add-Line 'FAIL' 'Control Plane settings desktop: a desktop block is present but the install record has no Hyper-V grant (install without -GrantHyperVToBroker writes none)'
    }
  }
  catch { Add-Line 'unknown' ('status check could not finish (is this console elevated?): ' + $_.Exception.Message) }
  , $lines.ToArray()
}
# The lines about what is new with the Control Plane service: the pins, the service config, the launcher, the shortcuts, the tray entry and the run id. Each reads the live state and compares it with the install record.
function Get-ControlPlaneStatusLines {
  $out = New-Object System.Collections.Generic.List[object]
  $M = $script:Manifest
  function Add-Cp([string]$State, [string]$Text) { $out.Add([pscustomobject]@{ State = $State; Text = $Text }) }
  if (Test-LegacyLayout) { return , $out.ToArray() }   # a first-layout record has none of these
  if ($M.ContainsKey('setupRunId')) { Add-Cp 'ok' "setup run id: $($M['setupRunId']) (a smaller one is refused)" }
  $floor = Get-SetupRunIdFloor
  if ($null -ne $floor) { Add-Cp $(if ($null -ne (ConvertTo-SetupRunId $floor)) { 'ok' } else { 'FAIL' }) "run-id floor of this PC (HKLM\SOFTWARE\Albera\SetupRunIdFloor, kept by uninstall): $floor" }
  foreach ($users in @(
      @{ Path = $L.ApproverBinDir; Has = $true }, @{ Path = $L.LauncherDir; Has = $true }, @{ Path = $L.SetupBinDir; Has = $true },
      @{ Path = $L.InstallRoot; Has = $false }, @{ Path = $L.BinRoot; Has = $false }, @{ Path = $L.ClaudeBinDir; Has = $false }, @{ Path = $L.ControlPlaneBinDir; Has = $false })) {
    if (-not (Test-Path -LiteralPath $users.Path)) { continue }
    try { $problems = Get-UsersAceProblems $users.Path $users.Has } catch { $problems = @('acl_unreadable') }
    Add-Cp $(if ($problems.Count -eq 0) { 'ok' } else { 'FAIL' }) ("BUILTIN\Users on $($users.Path): " + $(if ($problems.Count -eq 0) { $(if ($users.Has) { 'read and execute only' } else { 'no rule (as intended)' }) } else { $problems -join ', ' }))
  }
  if (-not (Test-ManifestHas 'controlPlane')) { Add-Cp 'FAIL' 'node.exe pin: not recorded' }
  else {
    $same = (Test-Path -LiteralPath $L.ControlPlaneNodeExe) -and ((Get-Sha256File $L.ControlPlaneNodeExe) -ceq $M['created']['controlPlane']['nodeSha256'])
    Add-Cp $(if ($same) { 'ok' } else { 'FAIL' }) ("node.exe pin: " + $(if ($same) { 'the copy in the control-plane folder has the recorded SHA-256' } else { 'missing or changed since install' }))
  }
  if (-not (Test-ManifestHas 'claude')) { Add-Cp 'FAIL' 'claude.exe pin: not recorded' }
  else {
    $same = (Test-Path -LiteralPath $L.ClaudeExe) -and ((Get-Sha256File $L.ClaudeExe) -ceq $M['created']['claude']['sha256'])
    Add-Cp $(if ($same) { 'ok' } else { 'FAIL' }) ("claude.exe pin: " + $(if ($same) { "the copy has the recorded SHA-256 (file version '$($M['created']['claude']['fileVersion'])')" } else { 'missing or changed since install' }))
  }
  if ((Test-ManifestHas 'controlPlane') -and (Test-ManifestHas 'claude') -and (Test-Path -LiteralPath $L.ControlPlaneConfig)) {
    $approverSid = if ($M['values'].ContainsKey('approverSid')) { $M['values']['approverSid'] } else { '' }
    $r = Test-ControlPlaneServiceConfigText ([System.IO.File]::ReadAllText($L.ControlPlaneConfig)) $L $M['created']['controlPlane']['nodeSha256'] $M['created']['claude']['sha256'] $script:Sids.ControlPlane $approverSid
    Add-Cp $(if ($r.Count -eq 0) { 'ok' } else { 'FAIL' }) ('Control Plane service config: ' + $(if ($r.Count -eq 0) { 'exactly what install writes for the recorded pins' } else { $r -join ', ' }))
  }
  elseif (-not (Test-Path -LiteralPath $L.ControlPlaneConfig)) { Add-Cp 'FAIL' 'Control Plane service config: missing' }
  if ((Test-ManifestHas 'launcher') -and (Test-ManifestHas 'shortcuts') -and (Test-ManifestHas 'runEntry')) {
    $ok = Test-ShortcutsInPlace
    Add-Cp $(if ($ok) { 'ok' } else { 'FAIL' }) ('launcher, Start menu shortcuts and HKLM Run entry: ' + $(if ($ok) { 'as recorded, read back' } else { 'missing or changed since install' }))
  }
  else { Add-Cp 'FAIL' 'launcher, Start menu shortcuts and HKLM Run entry: not recorded' }
  , $out.ToArray()
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
# Uninstall acts on FIXED names only (the three services, the one key, the legacy account, the two roots, the two shortcuts, the one Run value), and only when the (trusted) manifest also lists them.
function Get-UninstallSteps {
  $steps = @(
    [pscustomobject]@{ Id = 'runentry'; Title = "Remove the HKLM Run value $($K.RunValueName) (only if it is the command install wrote)"; Detail = @()
      Test = { if (Test-ManifestHas 'runEntry') { 'todo' } else { 'done' } }
      Do = {
        $rec = $script:Manifest['created']['runEntry']
        if ((Get-RunEntryValue) -ceq $rec['command']) { Remove-RunEntryValue; Say "    removed the Run value $($rec['name'])" }
        else { Say "    WARNING: the Run value $($rec['name']) is not the command install wrote (or is gone); left alone" }
        $script:Manifest['created'].Remove('runEntry') | Out-Null; Save-Manifest } }
    [pscustomobject]@{ Id = 'shortcuts'; Title = "Remove the Start menu shortcuts install made ($($K.OpenShortcut), $($K.UpdateShortcut)) and their folder when it is then empty"; Detail = @('the launcher script itself goes with the install folder below')
      Test = { if ((Test-ManifestHas 'shortcuts') -or (Test-ManifestHas 'launcher')) { 'todo' } else { 'done' } }
      Do = { Remove-HostShortcuts } }
    [pscustomobject]@{ Id = 'services'; Title = "Stop and delete the services this script created ($($K.ControlPlaneService), $($K.AuthorityService), $($K.BrokerService))"; Detail = @('a service whose command line is not the one install wrote is left alone and reported')
      Test = { $mine = if (Test-ManifestHas 'services') { @($script:Manifest['created']['services']) } else { @() }; if (@(Get-ServiceSpecs | Where-Object { $mine -contains $_.Name } | Where-Object { Get-CimInstance Win32_Service -Filter "Name='$($_.Name)'" }).Count -gt 0) { 'todo' } else { 'done' } }
      Do = { Remove-HostServices } }
    [pscustomobject]@{ Id = 'key'; Title = "Delete the machine signing key $($K.SigningKeyName) (only if this script created it)"; Detail = @()
      Test = { if ((Test-ManifestHas 'key') -and ($script:Manifest['created']['key']['name'] -ceq $K.SigningKeyName) -and (Test-AuthoritySigningKeyExists $K.SigningKeyName)) { 'todo' } else { 'done' } }
      Do = { Remove-AuthoritySigningKey $K.SigningKeyName | Out-Null; $script:Manifest['created'].Remove('key') | Out-Null; Save-Manifest; Say '    key deleted' } }
    [pscustomobject]@{ Id = 'installroot'; Title = "Remove the folders this script made in $($L.InstallRoot) (the copied builds, the pinned node.exe and claude.exe, the launcher)"; Detail = @('refused if the folder holds anything but those and albera-setup.exe''s own folders (bin\setup, setup-work), a link, or if it no longer passes the trust checks', 'setup''s own folders are left in place, and the root with them')
      Test = { if ((Test-ManifestHas 'installRoot') -and (Test-Path -LiteralPath $L.InstallRoot)) { 'todo' } else { 'done' } }
      Do = { Remove-HostInstallTree; $script:Manifest['created']['installRoot'] = $false; Save-Manifest } }
    [pscustomobject]@{ Id = 'data'; Title = "Remove the data folders under $($L.DataRoot) (configs, databases, policy.json, settings, the stored credential, ui\room.json, logs; the manifest goes last)"; Detail = @('refused for any folder that holds a file this script does not know (the folders the Control Plane service fills itself - logs, claude-run, secrets, ui - are removed as a whole), a link, or an untrusted owner / writer')
      Test = { if (@(Get-DataFolders | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0) { 'todo' } else { 'done' } }
      Do = { foreach ($d in (Get-DataFolders)) { if (Test-Path -LiteralPath $d) { Remove-TrustedTree $d @() @() $false } } } }
    [pscustomobject]@{ Id = 'user'; Title = "Remove the legacy local user $($K.ControlPlaneUser) of the first layout and its profile (only if its name, description and SID are exactly what the old install set)"; Detail = @('any other account, whatever the manifest says, is never touched; a new install has no such account')
      Test = { if (Test-ManifestHas 'user') { 'todo' } else { 'done' } }
      Do = {
        $rec = $script:Manifest['created']['user']
        $why = Test-OwnedUser $rec (Get-LiveControlPlaneUser)
        if ($why.Count -eq 0) { Remove-LocalUser -SID (New-Object System.Security.Principal.SecurityIdentifier($rec['sid'])); Say "    removed $($K.ControlPlaneUser)"; Remove-LegacyProfile $rec['sid'] }
        else { Say "    WARNING: the account is NOT removed ($($why -join ', ')); remove it yourself if it is yours" }
        $script:Manifest['created'].Remove('user') | Out-Null; Save-Manifest } }
    [pscustomobject]@{ Id = 'manifest'; Title = "Remove the manifest and $($L.DataRoot) itself"; Detail = @('only when nothing else is left in it', 'HKLM\SOFTWARE\Albera\SetupRunIdFloor is NOT removed: it is what refuses an older build after an uninstall')
      Test = { if (Test-Path -LiteralPath $L.DataRoot) { 'todo' } else { 'done' } }
      Do = {
        $left = @(Get-ChildItem -LiteralPath $L.DataRoot -Force | Where-Object { $_.Name -ne 'install-manifest.json' })
        if ($left.Count -gt 0) { throw "$($L.DataRoot) still holds: $(($left | ForEach-Object { $_.Name }) -join ', '); left in place" }
        Remove-Item -LiteralPath $L.ManifestPath -Force; Remove-Item -LiteralPath $L.DataRoot -Force; $script:Manifest = $null; Say '    manifest and data root removed' } }
  )
  # The group change is undone FIRST, while the service still exists: a deleted service leaves its SID in the group.
  if (Test-ManifestHas 'hyperVGrant') { return @(Get-HyperVRevokeStep) + $steps }
  $steps
}
function Get-DataFolders { @($L.BrokerConfigDir, $L.BrokerDbDir, $L.AuthorityDir, $L.ControlPlaneDir, $L.ControlPlaneConfigDir, $L.SecretsDir, $L.UiDir) }
function Remove-HostServices {
  # the Control Plane first: it is the client of the other two
  $specs = @(Get-ServiceSpecs); [array]::Reverse($specs)
  foreach ($spec in $specs) {
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
# The shortcuts install recorded (fixed names only, in the fixed folder) and the folder when nothing else is in it. A link on the way is refused.
function Remove-HostShortcuts {
  $names = if (Test-ManifestHas 'shortcuts') { @($script:Manifest['created']['shortcuts']) } else { @() }
  foreach ($name in $names) {
    $path = Join-Path $L.StartMenuDir $name
    if (-not (Test-Path -LiteralPath $path)) { continue }
    if ((Get-ReparseChain $path).Count -gt 0) { throw "$path is reached through a link; refusing to delete it" }
    Remove-Item -LiteralPath $path -Force; Say "    removed $path"
  }
  if (Test-Path -LiteralPath $L.StartMenuDir) {
    if ((Get-ReparseChain $L.StartMenuDir).Count -gt 0) { throw "$($L.StartMenuDir) is reached through a link; refusing to delete it" }
    if (@(Get-ChildItem -LiteralPath $L.StartMenuDir -Force).Count -eq 0) { Remove-Item -LiteralPath $L.StartMenuDir -Force; Say "    removed $($L.StartMenuDir)" }
  }
  $script:Manifest['created'].Remove('shortcuts') | Out-Null; $script:Manifest['created'].Remove('launcher') | Out-Null; Save-Manifest
}
# The profile folder of the legacy account (control-plane-service.md section 9, step 4), found by SID and deleted only when it is C:\Users\albera-cp exactly. A profile that is still loaded cannot be deleted: said, not guessed.
function Remove-LegacyProfile([string]$Sid) {
  if (-not (Test-AccountSidShape $Sid)) { return }
  $profile = Get-CimInstance Win32_UserProfile -Filter "SID='$Sid'"
  if (-not $profile) { Say "    no profile of $($K.ControlPlaneUser) to remove"; return }
  $expected = Join-Path 'C:\Users' $K.ControlPlaneUser
  if (-not [string]::Equals([string]$profile.LocalPath, $expected, [System.StringComparison]::OrdinalIgnoreCase)) { Say "    WARNING: the profile of that SID is at $($profile.LocalPath), not $expected; left alone"; return }
  try { Remove-CimInstance -InputObject $profile; Say "    removed the profile $expected" }
  catch { Say "    WARNING: the profile $expected could not be removed ($($_.Exception.Message)); delete it yourself" }
}
# Remove OUR folders from C:\Program Files\Albera. What albera-setup.exe keeps there (bin\setup, setup-work) stays, and the root with it; the root goes only when nothing else is in it.
function Get-OurInstallFolders { @('bin\broker', 'bin\authority', 'bin\pipe-client', 'bin\control-plane', 'bin\approver', 'bin\claude', 'bin\launcher') }
function Test-OurInstallEntry([string]$Rel) {
  $lower = $Rel.ToLowerInvariant()
  if ($lower -eq 'bin' -or $lower -eq 'bin\setup' -or $lower.StartsWith('bin\setup\') -or $lower -eq 'setup-work' -or $lower.StartsWith('setup-work\')) { return $true }
  foreach ($d in (Get-OurInstallFolders)) { if ($lower -eq $d -or $lower.StartsWith($d + '\')) { return $true } }
  $false
}
function Remove-HostInstallTree {
  Resolve-HostSids
  $entry = Get-AclPlan $L $script:Sids | Where-Object { $_.Path -ceq $L.InstallRoot } | Select-Object -First 1
  $reasons = Get-PathTrustReasons $L.InstallRoot (Get-PlannedWriters $entry) $true
  if ($reasons.Count -gt 0) { throw (Format-TrustRefusal $L.InstallRoot $reasons) }
  if (Test-HasReparsePoint $L.InstallRoot) { throw "$($L.InstallRoot) is or contains a link or junction; refusing to delete it" }
  $all = Get-TreeEntries $L.InstallRoot
  $unknown = @($all | ForEach-Object { $_.Rel } | Where-Object { -not (Test-OurInstallEntry $_) })
  if ($unknown.Count -gt 0) { throw "$($L.InstallRoot) holds files this script did not create ($($unknown -join ', ')); nothing was deleted there" }
  foreach ($d in (Get-OurInstallFolders)) {
    $p = Join-Path $L.InstallRoot $d
    if (Test-Path -LiteralPath $p) { Remove-TreeNoFollow $p; Say "    removed $p" }
  }
  $bin = Join-Path $L.InstallRoot 'bin'
  if ((Test-Path -LiteralPath $bin) -and @(Get-ChildItem -LiteralPath $bin -Force).Count -eq 0) { Remove-Item -LiteralPath $bin -Force }
  if (@(Get-ChildItem -LiteralPath $L.InstallRoot -Force).Count -eq 0) { Remove-Item -LiteralPath $L.InstallRoot -Force; Say "    removed $($L.InstallRoot)" }
  else { Say "    left $($L.InstallRoot) in place: albera-setup.exe's own folders are in it" }
}
# Delete a folder this script made, after proving it holds only what it should: no link/junction (the folder itself included), no file outside the known list. The folders the Control Plane service fills itself
# (Get-KnownDataWorkFolders) are known as a whole. $InstallTree is the old whole-install-folder mode, kept for the callers that still pass it (Remove-HostInstallTree replaced it for the real run).
function Remove-HostTree([string]$Dir, [string[]]$AllowedTop, [string[]]$AllowedFolders, [bool]$InstallTree) {
  if (Test-HasReparsePoint $Dir) { throw "$Dir is or contains a link or junction; refusing to delete it" }
  if ($InstallTree) {
    $all = Get-TreeEntries $Dir
    $unknown = @($all | ForEach-Object { $_.Rel } | Where-Object { -not (Test-OurInstallEntry $_) })
  }
  else { $unknown = @((Get-DataUnknownEntries $Dir)) }
  if ($unknown.Count -gt 0) { throw "$Dir holds files this script did not create ($($unknown -join ', ')); nothing was deleted there" }
  Remove-TreeNoFollow $Dir
  Say "    removed $Dir"
}
# The entries of a data folder (as paths relative to the data root) that are not on the known lists; the folders the service fills itself count as known as a whole.
function Get-DataUnknownEntries([string]$Dir) {
  $all = Get-TreeEntries $Dir
  $rel = @($all | ForEach-Object { $_.Rel })
  $prefix = $Dir.Substring($L.DataRoot.Length + 1)
  @((Get-UnknownEntries ($rel | ForEach-Object { $prefix + '\' + $_ }) (Get-KnownDataFiles) (Get-KnownDataFolders) (Get-KnownDataWorkFolders)))
}
# Deletes a folder tree WITHOUT following links. Every entry is judged at the moment it is deleted: a link (junction, symbolic link, mount point) is removed as a link - its target is neither entered nor touched -
# a plain folder is emptied first, a file goes. (Remove-Item -Recurse is not used: between a check and the delete a link can be put in place, and the Control Plane's own folders are written by a service.)
function Remove-TreeNoFollow([string]$Path) {
  $info = New-Object System.IO.DirectoryInfo($Path)
  $reparse = [System.IO.FileAttributes]::ReparsePoint
  if (($info.Attributes -band $reparse) -ne 0) { $info.Delete(); return }
  foreach ($entry in $info.GetFileSystemInfos()) {
    $isDirectory = ($entry.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0
    $isLink = ($entry.Attributes -band $reparse) -ne 0
    if ($isDirectory -and -not $isLink) { Remove-TreeNoFollow $entry.FullName }
    elseif ($isDirectory) { $entry.Delete() }
    else { if (($entry.Attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) { $entry.Attributes = [System.IO.FileAttributes]::Normal }; $entry.Delete() }
  }
  if (($info.Attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) { $info.Attributes = [System.IO.FileAttributes]::Directory }
  $info.Delete()
}
# Only the fixed roots and their planned sub-folders, and only when they still pass the trust checks (owner, writers, no link on the way).
function Remove-TrustedTree([string]$Dir, [string[]]$AllowedTop, [string[]]$AllowedFolders, [bool]$InstallTree) {
  Resolve-HostSids
  $entry = Get-AclPlan $L $script:Sids | Where-Object { $_.Path -ceq $Dir } | Select-Object -First 1
  if (-not $entry) { throw "$Dir is not one of the folders this script creates; refusing to delete it" }
  $reasons = Get-PathTrustReasons $Dir (Get-PlannedWriters $entry) $true
  if ($reasons.Count -gt 0) { throw (Format-TrustRefusal $Dir $reasons) }
  Remove-HostTree $Dir $AllowedTop $AllowedFolders $InstallTree
}

# ---------------------------------------------------------------------------------------------- migration (-Mode migrate; control-plane-service.md section 9, decision D7)
# ONE run, for an install of the first layout (the local account albera-cp). It reads what must survive (the Hello public values, the VM GUID and computer id, the Hyper-V grant choice), checks - before it
# removes anything - that the new install can be made, stops the account's processes by PID, runs the ordinary uninstall (the Broker's SID leaves Hyper-V Administrators first), and then the ordinary install
# with the carried-over values. The account and its profile go in the uninstall's user step. Lost by design: the Control Plane and Broker journals and the Authority's signing key (a new one is made).
$script:LegacyValues = $null
# Reasons it cannot be read (empty = ok, and $script:LegacyValues is set). Reads only files in the data root, after the manifest itself passed the trust checks, and the configs again pass their own.
function Import-LegacyInstall {
  if (-not $script:Manifest) { return , @('no_install_record') }
  $admin = Get-AdminSids
  foreach ($f in @($L.BrokerConfig, $L.AuthorityConfig)) {
    if (-not (Test-Path -LiteralPath $f)) { return , @('legacy_file_missing:' + (Split-Path -Leaf $f)) }
    $untrusted = Get-PathTrustReasons $f $admin $false
    if ($untrusted.Count -gt 0) { return , @($untrusted | ForEach-Object { 'legacy_file_untrusted:' + $_ }) }
  }
  if (-not (Test-Path -LiteralPath $L.LegacyApprovalSettings)) { return , @('legacy_file_missing:albera.approval.json') }
  $conv = ConvertFrom-LegacyInstall $script:Manifest ([System.IO.File]::ReadAllText($L.BrokerConfig)) ([System.IO.File]::ReadAllText($L.AuthorityConfig)) ([System.IO.File]::ReadAllText($L.LegacyApprovalSettings))
  if (-not $conv.Ok) { return , @($conv.Reasons) }
  $script:LegacyValues = $conv.Values
  , @()
}
# The carried-over values become this run's parameters (the parameter variables are script scope).
function Use-LegacyValues {
  $v = $script:LegacyValues
  $script:ProjectId = $v.ProjectId; $script:VmName = $v.VmName; $script:ComputerId = $v.ComputerId
  if ($v.Grant) {
    $script:GrantHyperVToBroker = $true
    $script:ResolvedVm = [pscustomobject]@{ Kind = 'ok'; Id = $v.Grant.VmId; Message = '' }   # the GUID the old install recorded; no lookup by name
  }
}
# What would stop the new install, found BEFORE anything is removed: the builds and the tree hash, node.exe, claude.exe and the account that says yes to UAC.
function Get-MigratePreflightProblems {
  $problems = New-Object System.Collections.Generic.List[string]
  $st = Get-ExpectedTreeHashState
  if (-not $st.Ok) { $problems.Add($st.Reason) }
  else {
    foreach ($s in (Get-BuildSources)) {
      if (-not [System.IO.Directory]::Exists($s.Dir)) { $problems.Add("$($s.Name): publish folder missing (run $($s.Build))") }
      elseif (Test-HasReparsePoint $s.Dir) { $problems.Add("$($s.Name): the publish folder contains a link or junction") }
    }
  }
  $node = Get-NodePinProblem; if ($node) { $problems.Add($node) }
  $claude = Get-ClaudePinProblem; if ($claude) { $problems.Add($claude) }
  foreach ($unknown in (Get-LegacyUnknownProblems)) { $problems.Add($unknown) }
  , $problems.ToArray()
}
# The uninstall that migrate runs refuses a folder with a file it does not know, a link, or an unknown entry in the install folder - and by then the services would be gone. So the same scan is made BEFORE anything
# is touched, and the first unknown file stops the migration.
function Get-LegacyUnknownProblems {
  $problems = New-Object System.Collections.Generic.List[string]
  foreach ($d in (Get-DataFolders)) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    if (Test-HasReparsePoint $d) { $problems.Add("$d is or contains a link or junction"); continue }
    $unknown = @((Get-DataUnknownEntries $d))
    if ($unknown.Count -gt 0) { $problems.Add("$d holds files this script did not create ($(@($unknown | Select-Object -First 3) -join ', ')); move or delete them first") }
  }
  if (Test-Path -LiteralPath $L.InstallRoot) {
    if (Test-HasReparsePoint $L.InstallRoot) { $problems.Add("$($L.InstallRoot) is or contains a link or junction") }
    else {
      $all = Get-TreeEntries $L.InstallRoot
      $unknown = @($all | ForEach-Object { $_.Rel } | Where-Object { -not (Test-OurInstallEntry $_) })
      if ($unknown.Count -gt 0) { $problems.Add("$($L.InstallRoot) holds files this script did not create ($(@($unknown | Select-Object -First 3) -join ', ')); move or delete them first") }
    }
  }
  , $problems.ToArray()
}
# Process IDs whose owner SID is this one (Win32_Process has no owner property; GetOwnerSid answers per process). Never a lookup by image name.
function Get-ProcessIdsOwnedBy([string]$Sid) {
  $ids = New-Object 'System.Collections.Generic.List[int]'
  foreach ($p in @(Get-CimInstance Win32_Process)) {
    if ([int]$p.ProcessId -le 4) { continue }
    $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    if ($owner -and $owner.ReturnValue -eq 0 -and $owner.Sid -ceq $Sid) { $ids.Add([int]$p.ProcessId) }
  }
  , $ids.ToArray()
}
# The one place a process other than the script's own children is ended: by its PID (taken from the owner SID above), never by name. Replaced by a Fake in the tests.
function End-ProcessById([int]$Id) {
  $process = [System.Diagnostics.Process]::GetProcessById($Id)
  $process.Kill()
  [void]$process.WaitForExit(10000)
}
# 1. the same ownership test uninstall makes (recorded name, live name, SID, description), 2. Disable-LocalUser by SID, 3. read back. Only then are processes stopped.
function Disable-LegacyAccount {
  $record = $script:Manifest['created']['user']
  $why = Test-OwnedUser $record (Get-LiveControlPlaneUser)
  if ($why.Count -gt 0) { throw "the account $($K.ControlPlaneUser) is not the one the old install made ($($why -join ', ')); nothing was changed" }
  Disable-LocalUser -SID (New-Object System.Security.Principal.SecurityIdentifier($record['sid']))
  $after = Get-LiveControlPlaneUser
  if ($after -and $after.Enabled) { throw "the account $($K.ControlPlaneUser) is still enabled after Disable-LocalUser; no process was stopped" }
  Say "    $($K.ControlPlaneUser) is disabled"
}
function Stop-LegacyProcesses {
  $sid = $script:LegacyValues.LegacySid
  foreach ($id in (Get-ProcessIdsOwnedBy $sid)) {
    try { End-ProcessById $id; Say "    stopped process $id" }
    catch { Say "    process $id had ended or could not be stopped: $($_.Exception.Message)" }
  }
  $left = Get-ProcessIdsOwnedBy $sid
  if ($left.Count -gt 0) { throw "processes of $($K.ControlPlaneUser) are still running (PID $($left -join ', ')); nothing was uninstalled" }
}
function Get-MigrateLeadSteps {
  @(
    [pscustomobject]@{ Id = 'legacy'; Title = "Read the first-layout install: the record, the Authority and Broker configs and the old settings; carry over the Hello public values, the VM GUID, the computer id and the Hyper-V grant choice"
      Detail = @('refused unless the record is complete and has the local account albera-cp, the configs pass this script''s own checks and agree with the record', 'only public values are carried over (key id, public key, SIDs, GUID, names)')
      Test = { $why = Import-LegacyInstall; if ($why.Count -gt 0) { 'blocked:' + ($why -join ', ') } else { 'todo' } }
      Do = {
        $why = Import-LegacyInstall; if ($why.Count -gt 0) { throw ('cannot migrate: ' + ($why -join ', ')) }
        Use-LegacyValues
        $v = $script:LegacyValues
        Say "    carried over (public values; keep this if the run stops half-way, they are what -Mode install needs): -ApproverKeyId $($v.ApproverKeyId) -ApproverSid $($v.ApproverSid) -ProjectId $($v.ProjectId) -VmName $($v.VmName) -ComputerId $($v.ComputerId)$(if ($v.Grant) { " -GrantHyperVToBroker (VM GUID $($v.Grant.VmId))" } else { '' })"
        Say "    approver public key: $($v.ApproverPublicKey)" } }
    [pscustomobject]@{ Id = 'preflight'; Title = 'Check, before anything is removed, that the new install can be made: the five builds and the tree hash, node.exe, claude.exe, and that the account that says yes to UAC is the approver'
      Detail = @('with -TrustLocalBuilds the tree hash is the hash of the builds in this working tree (it proves nothing about who built them); with -ExpectedTreeHash it is the one you typed from the CI log')
      Test = { if (-not $script:LegacyValues) { return 'unknown:the legacy install has not been read yet' }; $p = Get-MigratePreflightProblems; if ($p.Count -gt 0) { 'blocked:' + ($p -join '; ') } else { 'todo' } }
      Do = { $p = Get-MigratePreflightProblems; if ($p.Count -gt 0) { throw ('the new install cannot be made yet, so nothing was removed: ' + ($p -join '; ')) }; Say '    the new install can be made; going on' } }
    [pscustomobject]@{ Id = 'disable'; Title = "Check once more that $($K.ControlPlaneUser) is the account the old install made (name, description and SID), then DISABLE it, so nothing can be started under it while its processes are stopped"
      Detail = @('an account that is not exactly that one stops the run and nothing is changed', 'the account is removed later, in the uninstall that follows')
      Test = { if ($script:LegacyValues) { 'todo' } else { 'unknown:the legacy install has not been read yet' } }
      Do = { Disable-LegacyAccount } }
    [pscustomobject]@{ Id = 'stop'; Title = "Stop the processes of the account $($K.ControlPlaneUser) by PID (found by owner SID, never by image name); the services are stopped by the uninstall that follows"
      Detail = @('a process of that account that cannot be stopped stops the run before anything is uninstalled')
      Test = { if ($script:LegacyValues) { 'todo' } else { 'unknown:the legacy install has not been read yet' } }
      Do = { Stop-LegacyProcesses } }
  )
}
function Show-MigratePlan {
  $why = if ($script:Manifest) { Import-LegacyInstall } else { , @('no_install_record') }
  if ($why.Count -gt 0) { Show-Plan @(Get-MigrateLeadSteps) 'migrate'; return }
  Use-LegacyValues
  Show-Plan (@(Get-MigrateLeadSteps) + @(Get-UninstallSteps) + @(Get-InstallSteps)) 'migrate'
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

# Runs steps in order: a step that is blocked stops the run with its reason, a step that is done is skipped. Returns the number of the last step (so a second list continues the numbering).
function Invoke-InstallSteps([object[]]$Steps, [int]$Number = 0) {
  $n = $Number
  foreach ($s in $Steps) {
    $n++
    $state = & $s.Test
    if ($state -like 'blocked:*') { Stop-Refused ($state.Substring(8)) }
    if ($state -eq 'done') { Say ('{0,3}. [skip] {1} (already done)' -f $n, $s.Title); continue }
    Say ('{0,3}. {1}' -f $n, $s.Title)
    [void](& $s.Do)   # a step's output is its Say lines (the host stream); anything else a cmdlet leaks must not become part of the number this function returns
  }
  $n
}
function Invoke-UninstallSteps([object[]]$Steps, [int]$Number = 0) {
  $n = $Number
  foreach ($s in $Steps) {
    $n++
    if ((& $s.Test) -eq 'done') { Say ('{0,3}. [skip] {1} (nothing to do)' -f $n, $s.Title); continue }
    Say ('{0,3}. {1}' -f $n, $s.Title)
    [void](& $s.Do)
  }
  $n
}
function Show-InstalledMessage {
  Say ''
  Say "Installed. The three services ($($K.BrokerService), $($K.AuthorityService), $($K.ControlPlaneService)) start by themselves, delayed, the next time Windows starts. To start them now, in this elevated console:"
  Say "  Start-Service $($K.BrokerService); Start-Service $($K.AuthorityService); Start-Service $($K.ControlPlaneService)"
  Say "Then open the room from the Start menu: ALBERA > Open ALBERA (it reads ui\room.json; the tray of the approver starts at your next sign-in, or run AlberaApprover.exe --tray)."
  Say 'See docs/architecture/host-install.md ("First approval") for albera-runtime approval-check.'
  if ($GrantHyperVToBroker) {
    Say "The Broker's service SID is in Hyper-V Administrators and its SID type is unrestricted. Undo: -Mode uninstall removes the SID from the group first (host-install.md, 'Giving the Broker Hyper-V')."
    Say "The Control Plane settings already hold the desktop block (installed helper path and its SHA-256) that the gated room needs; nothing has to be edited by hand."
  }
}
# A complete install met again: the anti-rollback check first (an older run id is refused), then - when a tree hash was given - whether the installed copies are the build that was verified. In-place update (stop
# the services, replace the builds, start again) is not part of this installer: a different build is said so and exits 5 without touching anything.
function Invoke-CompleteInstallCheck {
  if (Test-LegacyLayout) { Stop-Refused 'This install is from the first layout (the local account albera-cp). Run -Mode migrate once to move it to the Control Plane service.' }
  $rollback = Get-RollbackRefusal
  if ($rollback) { Stop-Refused (Get-RollbackMessage $rollback) }
  Say 'The install is already complete; checking it (nothing will be changed).'
  if ($GrantHyperVToBroker -and -not (Test-ManifestHas 'hyperVGrant')) { Say 'NOTE: -GrantHyperVToBroker was given, but this install was made without it, so NOTHING was granted. To add the grant: uninstall, then install again with the option.' }
  $given = Get-ExpectedTreeHashState
  if ($given.Ok) {
    $dirs = @{}; foreach ($s in (Get-BuildSources)) { $dirs[$s.Name] = $s.Dest }
    $installedTree = Get-CanonicalTreeHash (Get-ComponentHashes $dirs -Installed)
    if ($installedTree -cne $given.Value) {
      Say "NOTE: the installed builds hash to $installedTree, not to the verified tree hash $($given.Value). Updating in place is not part of this installer yet: -Mode uninstall, then install again. Nothing was changed."
      exit 5
    }
  }
  Set-ManifestSetupRunId   # the run id only ever goes up
  exit (Show-Status)
}

# -Mode migrate: 1. read what must survive, check that the new install can be made, stop the account's processes (nothing is removed before the preflight passed); 2. the ordinary uninstall of the first layout
# (the Broker's SID leaves Hyper-V Administrators first; the account and its profile go in its user step); 3. the ordinary install with the carried-over values (built only now: its titles and tests read the run's variables).
function Invoke-Migrate {
  if (-not $script:Manifest) { Say 'No install manifest found: there is no first-layout install to migrate. Use -Mode install.'; return 0 }
  if (-not (Test-LegacyLayout)) { Say 'This install is not of the first layout (it has no local account albera-cp): nothing to migrate.'; return 0 }
  if ($TrustLocalBuilds) { Say 'NOTE: -TrustLocalBuilds - the tree hash is the hash of the builds in this working tree. It proves nothing about who built them; every later update goes through attested setup.' }
  $n = Invoke-InstallSteps (Get-MigrateLeadSteps)
  $n = Invoke-UninstallSteps (Get-UninstallSteps) $n
  $n = Invoke-InstallSteps (Get-InstallSteps) $n
  if ($StartCheck) { Say '  Start check (starts each service once, then stops it):'; Invoke-StartCheck }
  Show-InstalledMessage
  Say 'Migrated. Lost by design: the Control Plane and Broker journals and the Authority signing key (a new one was made; its public key is in the Broker config).'
  0
}

try {
  if ($Mode -in @('install', 'uninstall', 'migrate')) { Get-ScriptFileHashes }
  if ($Mode -ne 'hashes') { Initialize-Manifest }
  switch ($Mode) {
    'hashes' { Show-Hashes; exit 0 }
    'status' { exit (Show-Status) }
    'plan' {
      if ($PlanFor -eq 'uninstall') { Show-Plan (Get-UninstallSteps) 'uninstall' }
      elseif ($PlanFor -eq 'migrate') { Show-MigratePlan }
      else { Show-Plan (Get-InstallSteps) 'install' }
      exit 0
    }
    'install' {
      if ($script:Manifest -and $script:Manifest['state'] -eq 'complete') { Invoke-CompleteInstallCheck }
      [void](Invoke-InstallSteps (Get-InstallSteps))
      if ($StartCheck) { Say '  Start check (starts each service once, then stops it):'; Invoke-StartCheck }
      Show-InstalledMessage
      exit 0
    }
    'uninstall' {
      if (-not $script:Manifest) { Say 'No install manifest found: this script did not install anything here, so it removes nothing.'; exit 0 }
      [void](Invoke-UninstallSteps (Get-UninstallSteps))
      Say 'Uninstalled. Only what the manifest listed was removed.'
      exit 0
    }
    'migrate' { exit (Invoke-Migrate) }
  }
}
catch {
  Write-Host ('ERROR: ' + $_.Exception.Message + ' (script line ' + $_.InvocationInfo.ScriptLineNumber + ')')
  Write-Host 'Nothing else was changed after this point. Run -Mode status to see the state; run install again to continue, or uninstall to remove what was created.'
  exit 1
}
