# ALBERA: the SEC-2 two-account check of the WSL bridge (ADR-012: "Settle in the lab, with two accounts, whether the image pin works from the Control Plane's account"). Windows PowerShell 5.1, ASCII only.
# For the owner to run, in an elevated console, AFTER the install with -AddWsl2Computer and BEFORE the image pin (settings wsl2.serverImageSha256) is set. NOT RUN anywhere yet.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\lab-sec2.ps1 -DryRun            prints every step and name; creates and changes nothing (needs no admin)
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\lab-sec2.ps1                    the check (elevated); it stops and tells you what to type in a NORMAL console
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\host\lab-sec2.ps1 -RemoveStale       only removes an account an earlier, killed run left (name albera-sec2-*, our description)
#
# What it does:
#   1. makes a temporary local account albera-sec2-<8 hex> (a random password that is never printed or stored; the account is a plain user, not an Administrator). It stands in for the Control Plane's identity.
#   2. makes the lab folder under the installed wsl-bridge data folder, copies the installed pipe client helper there (so that the account can run it), and writes a LAB bridge config: the installed bridge's own config with
#      another pipe name and controlPlaneSid = the temporary account, and its own state folders. The real bridge and its pipe are not touched.
#   3. asks YOU to start the lab bridge in a NORMAL (not elevated) console: that is the owner's bridge in the owner's session. It waits (default 10 minutes) for the pipe to appear.
#   4. runs, AS THE TEMPORARY ACCOUNT, the helper in its wsl-bridge mode three times (it proves the server and sends no request): with the owner SID expected (the owner check), with a wrong owner SID expected (must be refused),
#      and with the owner SID and the bridge's image hash expected (the image pin). It reads each answer: ok, or the helper's fixed code.
#   5. the account, its profile folder (if one was made) and the lab folder are removed on EVERY way out: normal end, an error, Ctrl+C. If the process is killed, run it again with -RemoveStale.
#   6. prints the answers in words; end the lab bridge with Ctrl+C in its console.
# Nothing here uses RunAs or a password on a command line. The programs started are the temporary account's powershell.exe (by its full System32 path) running a probe this script wrote, and the copied helper.
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$RemoveStale,
  [int]$WaitMinutes = 10
)
$PSModuleAutoLoadingPreference = 'None'
if (-not [string]::Equals($PSHOME.TrimEnd('\'), 'C:\Windows\System32\WindowsPowerShell\v1.0', [System.StringComparison]::OrdinalIgnoreCase)) {
  [Console]::WriteLine('REFUSED: this is not the Windows PowerShell 5.1 in C:\Windows\System32\WindowsPowerShell\v1.0; start it with that powershell.exe by its full path'); exit 3
}
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
foreach ($moduleName in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security')) {
  Import-Module -Name ([System.IO.Path]::Combine($PSHOME, 'Modules', $moduleName, $moduleName + '.psd1')) -DisableNameChecking -ErrorAction Stop
}
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'albera-host-lib.ps1')

# ---------------------------------------------------------------------------------------------- pure helpers (the tests call these)
function Get-Sec2Constants {
  [ordered]@{
    AccountPrefix = 'albera-sec2-'
    AccountDescription = 'ALBERA SEC-2 lab account (made by lab-sec2.ps1)'   # at most 48 characters (the SAM description limit used by the host installer too)
    LabPipeName = 'ALBERA_WslBridgeLab'
    LabFolder = 'lab-sec2'
    WrongOwnerSid = 'S-1-5-21-1-2-3-500'   # a well-formed SID that is nobody's here: the helper must refuse a server that is not owned by it
    ProbeSeconds = 90
  }
}
function New-Sec2AccountName([byte[]]$Random) {
  if ($null -eq $Random -or $Random.Length -lt 4) { throw 'random_too_short' }
  (Get-Sec2Constants).AccountPrefix + (([BitConverter]::ToString($Random, 0, 4) -replace '-', '').ToLowerInvariant())
}
# An account may be removed only when its name and its description are both exactly ours.
function Test-Sec2AccountOwned([string]$Name, [string]$Description) {
  $c = Get-Sec2Constants
  ($Name -cmatch ('^' + [regex]::Escape($c.AccountPrefix) + '[0-9a-f]{8}\z')) -and ($Name.Length -le 20) -and ($Description -ceq $c.AccountDescription)
}
# The three runs of the helper (each: what it expects of the server). $OwnerSid = the bridge's owner; $ImageSha256 = the bridge exe's SHA-256.
function Get-Sec2Cases([string]$PipeName, [string]$OwnerSid, [string]$ImageSha256) {
  $c = Get-Sec2Constants
  @(
    [pscustomobject]@{ Id = 'owner'; Pipe = $PipeName; Owner = $OwnerSid; Image = $null }
    [pscustomobject]@{ Id = 'wrongOwner'; Pipe = $PipeName; Owner = $c.WrongOwnerSid; Image = $null }
    [pscustomobject]@{ Id = 'ownerAndImage'; Pipe = $PipeName; Owner = $OwnerSid; Image = $ImageSha256 }
  )
}
# The answers, in words, from what the three runs returned. $Results = id -> @{ ran; ok; code }. A run that did not happen is never an answer ("not_measured").
function Get-Sec2Verdict($Results) {
  $get = { param($id) if ($Results -is [System.Collections.IDictionary] -and $Results.Contains($id)) { $Results[$id] } else { $null } }
  $owner = & $get 'owner'; $wrong = & $get 'wrongOwner'; $image = & $get 'ownerAndImage'
  $ran = { param($r) ($null -ne $r) -and [bool]$r.ran }
  $v = [ordered]@{}
  $v.ownerCheck = if (-not (& $ran $owner) -or -not (& $ran $wrong)) { 'not_measured' } elseif ($owner.ok -and -not $wrong.ok) { 'works' } elseif (-not $owner.ok) { 'fails_for_the_owner:' + $owner.code } else { 'accepts_any_owner' }
  $v.imagePin = if (-not (& $ran $image) -or -not (& $ran $owner)) { 'not_measured' } elseif ($image.ok -and $owner.ok) { 'works' } elseif ($owner.ok) { 'fails_from_this_account:' + $image.code } else { 'not_measured' }
  $v.advice = if ($v.imagePin -ceq 'works') { 'the image pin may be set (serverImageSha256)' } elseif ($v.imagePin -like 'fails*') { 'leave serverImageSha256 out: the proof stays the owner alone (SEC-2); write that down in ADR-012' } else { 'run the check again before deciding' }
  $v
}
# What the temporary account runs. It starts the helper in wsl-bridge mode, writes the start frame ([int32 LE length][JSON]), reads ONE reply frame and prints one json line. Nothing else is sent: no wire request.
function Get-Sec2ProbeText {
  @'
param([string]$Helper, [string]$PipeName, [string]$OwnerSid, [string]$ImageSha256, [string]$CaseId)
$ErrorActionPreference = 'Stop'
$r = [ordered]@{ id = $CaseId; ran = $false; ok = $false; code = $null; sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
try {
  $expect = [ordered]@{ ownerSid = $OwnerSid }
  if ($ImageSha256) { $expect['imageSha256'] = $ImageSha256 }
  $json = ([ordered]@{ pipeName = $PipeName; timeoutMs = 8000; replyTimeoutMs = 20000; expect = $expect } | ConvertTo-Json -Compress -Depth 4)
  $body = [System.Text.Encoding]::UTF8.GetBytes($json)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Helper; $psi.Arguments = 'wsl-bridge'; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  try {
    $stdin = $p.StandardInput.BaseStream
    $stdin.Write([BitConverter]::GetBytes([int]$body.Length), 0, 4); $stdin.Write($body, 0, $body.Length); $stdin.Flush()
    $out = $p.StandardOutput.BaseStream
    $head = New-Object byte[] 4
    $task = $out.ReadAsync($head, 0, 4)
    if (-not $task.Wait(15000) -or $task.Result -ne 4) { $r.code = 'no_reply' }
    else {
      $len = [BitConverter]::ToInt32($head, 0)
      if ($len -lt 1 -or $len -gt 4096) { $r.code = 'bad_reply_length' }
      else {
        $buf = New-Object byte[] $len; $got = 0
        while ($got -lt $len) { $t = $out.ReadAsync($buf, $got, $len - $got); if (-not $t.Wait(5000) -or $t.Result -le 0) { break }; $got += $t.Result }
        if ($got -ne $len) { $r.code = 'short_reply' }
        else {
          $reply = [System.Text.Encoding]::UTF8.GetString($buf) | ConvertFrom-Json
          $r.ran = $true; $r.ok = [bool]($reply.ok -eq $true); if (-not $r.ok) { $r.code = [string]$reply.code }
        }
      }
    }
  }
  finally { try { $p.StandardInput.Close() } catch { }; if (-not $p.WaitForExit(3000)) { try { $p.Kill() } catch { } } }
}
catch { $r.code = 'probe_error:' + $_.Exception.GetType().Name }
Write-Output ($r | ConvertTo-Json -Compress)
'@
}
function Get-Sec2PlanLines([string]$AccountName) {
  $c = Get-Sec2Constants
  @(
    "1. make the local account $AccountName (a plain user, random password never shown or stored; description '$($c.AccountDescription)'); first remove any $($c.AccountPrefix)* account left by a killed run",
    "2. make C:\ProgramData\Albera\wsl-bridge\$($c.LabFolder)\ (the account may read the copied helper there; you may write the lab state folders), copy the installed pipe client helper into it, write the lab bridge config (pipe $($c.LabPipeName), Control Plane = the account)",
    '3. tell you the one command to run in a NORMAL console (the lab bridge, as you), and wait for its pipe',
    '4. run the helper in wsl-bridge mode AS THE ACCOUNT three times: owner expected (owner check), wrong owner expected (must be refused), owner and bridge image hash expected (image pin); no request is sent',
    '5. remove the account, its profile folder if one exists, and the lab folder on every way out (also on an error or Ctrl+C)',
    '6. print: the owner check works / the image pin works or fails with the helper''s code, and what to do about serverImageSha256'
  )
}

# ---------------------------------------------------------------------------------------------- system side (the harness replaces these with fakes)
$SystemDirectory = [Environment]::SystemDirectory
$PowerShellExe = Join-Path $SystemDirectory 'WindowsPowerShell\v1.0\powershell.exe'
function Test-Sec2Elevated { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
function Get-Sec2LocalAccounts { @(([ADSI]'WinNT://.').Children | Where-Object { $_.SchemaClassName -eq 'User' } | ForEach-Object { [pscustomobject]@{ Name = [string]$_.Name; Description = [string]$_.Properties['Description'].Value } }) }
function Get-Sec2RandomPassword {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] 32; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose()
  (-join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })) + '#9a'
}
# Makes the account and returns @{ Name; Sid; Password (a SecureString) }. The plain password lives only in this function.
function New-Sec2Account([string]$Name) {
  $c = Get-Sec2Constants
  $plain = Get-Sec2RandomPassword
  $secure = New-Object System.Security.SecureString
  foreach ($ch in $plain.ToCharArray()) { $secure.AppendChar($ch) }
  $secure.MakeReadOnly()
  $computer = [ADSI]'WinNT://.'
  $user = $computer.Create('user', $Name)
  $user.SetPassword($plain); $user.Put('Description', $c.AccountDescription); $user.SetInfo()
  $plain = $null
  $sid = (New-Object System.Security.Principal.NTAccount($Name)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  @{ Name = $Name; Sid = $sid; Password = $secure }
}
# Removes the account (only when name and description are ours), then its profile folder when one was made (exactly C:\Users\<name>, not a link).
function Remove-Sec2Account([string]$Name) {
  $c = Get-Sec2Constants
  $found = @(Get-Sec2LocalAccounts | Where-Object { $_.Name -ceq $Name })
  if ($found.Count -eq 0) { return $false }
  if (-not (Test-Sec2AccountOwned $found[0].Name $found[0].Description)) { throw "the account $Name is not ours (name or description differ); left alone" }
  ([ADSI]'WinNT://.').Delete('user', $Name)
  $profile = Join-Path 'C:\Users' $Name
  if ([System.IO.Directory]::Exists($profile) -and (Get-ReparseChain $profile).Count -eq 0) { try { [System.IO.Directory]::Delete($profile, $true) } catch { Write-Host "WARNING: the profile folder $profile could not be removed ($($_.Exception.Message)); delete it yourself" } }
  $true
}
function Wait-Sec2Pipe([string]$PipeName, [int]$Minutes) {
  $end = (Get-Date).AddMinutes($Minutes)
  while ((Get-Date) -lt $end) {
    if (@([System.IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -ceq ('\\.\pipe\' + $PipeName) }).Count -gt 0) { return $true }
    Start-Sleep -Seconds 2
  }
  $false
}
# One case as the temporary account: powershell.exe running the probe, with the account's credentials (Process.Start with UserName and Password: no profile is loaded, no password on a command line).
function Invoke-Sec2ProbeAs($Account, [string]$ProbePath, [string]$HelperPath, $Case) {
  $c = Get-Sec2Constants
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $PowerShellExe; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.UserName = $Account.Name; $psi.Domain = '.'; $psi.Password = $Account.Password; $psi.LoadUserProfile = $false; $psi.WorkingDirectory = $SystemDirectory
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $ProbePath + '" -Helper "' + $HelperPath + '" -PipeName ' + $Case.Pipe + ' -OwnerSid ' + $Case.Owner + ' -CaseId ' + $Case.Id
  if ($Case.Image) { $arguments += ' -ImageSha256 ' + $Case.Image }
  $psi.Arguments = $arguments
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($c.ProbeSeconds * 1000)) { try { $p.Kill() } catch { }; return @{ ran = $false; ok = $false; code = 'probe_timeout' } }
  $p.WaitForExit()
  try { $r = ($out.Result.Trim().Split("`n") | Select-Object -Last 1) | ConvertFrom-Json } catch { return @{ ran = $false; ok = $false; code = 'probe_output_unreadable' } }
  if ($r.sid -cne $Account.Sid) { return @{ ran = $false; ok = $false; code = 'ran_as_another_account' } }
  @{ ran = [bool]$r.ran; ok = [bool]$r.ok; code = $r.code }
}
# The lab folder: the installed bridge config copied with another pipe, the account as Control Plane and its own state folders; the helper copied so the account can run it. Returns @{ Dir; Config; Probe; Helper; OwnerSid; BridgeExeSha256 }.
function New-Sec2LabFolder($Account, $L, $W) {
  $c = Get-Sec2Constants
  $bridgeText = [System.IO.File]::ReadAllText($W.Config)
  $bad = Test-Wsl2BridgeConfigText $bridgeText
  if ($bad.Count -gt 0) { throw "the installed bridge config is not valid ($($bad -join ', ')); install with -AddWsl2Computer first" }
  $settings = [System.IO.File]::ReadAllText($L.ApprovalSettings) | ConvertFrom-Json
  if ($null -eq $settings.PSObject.Properties['wsl2']) { throw 'the approval settings have no wsl2 block; install with -AddWsl2Computer first' }
  $ownerSid = [string]$settings.wsl2.serverSid
  if (-not (Test-AccountSidShape $ownerSid)) { throw 'the wsl2 block names no owner SID' }
  $dir = Join-Path $W.DataDir $c.LabFolder
  $state = Join-Path $dir 'state'; $distributions = Join-Path $dir 'distributions'; $helperDir = Join-Path $dir 'helper'
  $full = @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')
  New-SecuredDirectory $dir ($full + @("*${ownerSid}:(OI)(CI)RX"))
  New-SecuredDirectory $state ($full + @("*${ownerSid}:(OI)(CI)M"))
  New-SecuredDirectory $distributions ($full + @("*${ownerSid}:(OI)(CI)M"))
  New-SecuredDirectory $helperDir ($full + @("*$($Account.Sid):(OI)(CI)RX"))
  foreach ($f in [System.IO.Directory]::GetFiles($L.PipeClientBinDir, '*', [System.IO.SearchOption]::AllDirectories)) {
    $target = Join-Path $helperDir ($f.Substring($L.PipeClientBinDir.Length).TrimStart('\'))
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
    [System.IO.File]::Copy($f, $target, $false)
  }
  $helper = Join-Path $helperDir 'albera-windows-broker-pipe-client.exe'
  $probe = Join-Path $helperDir 'probe.ps1'
  [System.IO.File]::WriteAllText($probe, ((Get-Sec2ProbeText) -replace "`r?`n", "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  $cfg = $bridgeText | ConvertFrom-Json
  $cfg.pipeName = $c.LabPipeName; $cfg.controlPlaneSid = $Account.Sid; $cfg.stateFolder = $state; $cfg.distributionsFolder = $distributions
  $labJson = $cfg | ConvertTo-Json -Compress -Depth 6
  $bad = Test-Wsl2BridgeConfigText $labJson
  if ($bad.Count -gt 0) { throw "the lab bridge config failed this script's own check: $($bad -join ', ')" }
  $config = Join-Path $dir 'lab-bridge.json'
  [System.IO.File]::WriteAllText($config, $labJson, (New-Object System.Text.UTF8Encoding($false)))
  $sha = [System.Security.Cryptography.SHA256]::Create(); try { $exeBytes = [System.IO.File]::OpenRead($W.BridgeExe); try { $exeSha = ([BitConverter]::ToString($sha.ComputeHash($exeBytes)) -replace '-', '').ToLowerInvariant() } finally { $exeBytes.Dispose() } } finally { $sha.Dispose() }
  @{ Dir = $dir; Config = $config; Probe = $probe; Helper = $helper; OwnerSid = $ownerSid; BridgeExeSha256 = $exeSha }
}
function Remove-Sec2LabFolder([string]$Dir) { if ($Dir -and [System.IO.Directory]::Exists($Dir) -and (Get-ReparseChain $Dir).Count -eq 0) { [System.IO.Directory]::Delete($Dir, $true) } }

# The whole run, every system call through the functions above so that a test can replace them and make any of them fail. The account is removed in the finally, whatever happened.
function Invoke-Sec2Run($L, $W, [byte[]]$Random, [int]$Minutes) {
  $c = Get-Sec2Constants
  $name = New-Sec2AccountName $Random
  $account = $null; $lab = $null; $results = @{}
  $removed = $false; $labRemoved = $false
  try {
    foreach ($stale in @(Get-Sec2LocalAccounts | Where-Object { $_.Name -like ($c.AccountPrefix + '*') })) {
      if (Test-Sec2AccountOwned $stale.Name $stale.Description) { [void](Remove-Sec2Account $stale.Name); Write-Host "removed a stale account $($stale.Name)" }
    }
    Write-Host "1. making the account $name"
    $account = New-Sec2Account $name
    Write-Host '2. making the lab folder, the helper copy and the lab bridge config'
    $lab = New-Sec2LabFolder $account $L $W
    Write-Host '3. START THE LAB BRIDGE NOW, in a NORMAL (not elevated) console, as yourself:'
    Write-Host ('     "' + $W.BridgeExe + '" serve "' + $lab.Config + '"')
    Write-Host "   (it prints BRIDGE_READY; waiting up to $Minutes minute(s) for the pipe $($c.LabPipeName))"
    if (-not (Wait-Sec2Pipe $c.LabPipeName $Minutes)) { Write-Host 'the lab bridge did not start in time: nothing was measured'; return [ordered]@{ ownerCheck = 'not_measured'; imagePin = 'not_measured'; advice = 'start the lab bridge and run again' } }
    Write-Host '4. running the helper as the account (no request is sent)'
    foreach ($case in (Get-Sec2Cases $c.LabPipeName $lab.OwnerSid $lab.BridgeExeSha256)) { $results[$case.Id] = Invoke-Sec2ProbeAs $account $lab.Probe $lab.Helper $case }
    Get-Sec2Verdict $results
  }
  finally {
    try { $removed = [bool](Remove-Sec2Account $name); Write-Host "5. account removed: $removed" } catch { Write-Host "WARNING: the account $name could not be removed ($($_.Exception.Message)); run this script with -RemoveStale" }
    try { if ($lab) { Remove-Sec2LabFolder $lab.Dir; $labRemoved = $true } } catch { Write-Host "WARNING: the lab folder could not be removed ($($_.Exception.Message)); the lab bridge may still be running: end it, then delete $($lab.Dir) as an administrator" }
  }
}

if ($MyInvocation.InvocationName -eq '.') { return }   # dot-sourced by a test: the functions only
try {
  $c = Get-Sec2Constants
  $folderReasons = Test-FixedFolders ([Environment]::SystemDirectory) ([Environment]::GetFolderPath('ProgramFiles')) ([Environment]::GetFolderPath('CommonApplicationData'))
  if ($folderReasons.Count -gt 0) { Write-Host "REFUSED: Windows reports a non-standard system folder ($($folderReasons -join ', '))"; exit 3 }
  $L = Get-HostLayout ([Environment]::GetFolderPath('ProgramFiles')) ([Environment]::GetFolderPath('CommonApplicationData'))
  $W = Get-Wsl2Layout $L
  $random = New-Object byte[] 8; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($random); $rng.Dispose()
  if ($DryRun) {
    Write-Host 'lab-sec2.ps1 - DRY RUN. Nothing is created or changed.'
    foreach ($line in (Get-Sec2PlanLines ($c.AccountPrefix + '<8 hex>'))) { Write-Host $line }
    exit 0
  }
  if (-not (Test-Sec2Elevated)) { Write-Host 'REFUSED: run this in an elevated console (Run as administrator). It never elevates itself.'; exit 3 }
  if ($WaitMinutes -lt 1 -or $WaitMinutes -gt 60) { Write-Host 'REFUSED: -WaitMinutes is 1 to 60'; exit 2 }
  if ($RemoveStale) {
    $n = 0
    foreach ($stale in @(Get-Sec2LocalAccounts | Where-Object { $_.Name -like ($c.AccountPrefix + '*') })) {
      if (Test-Sec2AccountOwned $stale.Name $stale.Description) { [void](Remove-Sec2Account $stale.Name); $n++; Write-Host "removed $($stale.Name)" } else { Write-Host "left alone (not ours): $($stale.Name)" }
    }
    Write-Host "stale accounts removed: $n"
    exit 0
  }
  $verdict = Invoke-Sec2Run $L $W $random $WaitMinutes
  Write-Host 'SEC-2 result:'
  foreach ($p in $verdict.GetEnumerator()) { Write-Host ('  {0} = {1}' -f $p.Key, $p.Value) }
  Write-Host 'End the lab bridge with Ctrl+C in its console. Record the answers in ADR-012 (SEC-2).'
  exit 0
}
catch {
  Write-Host ('ERROR: ' + $_.Exception.Message)
  Write-Host 'The temporary account and the lab folder were removed on the way out; run with -RemoveStale if the process was killed.'
  exit 1
}
