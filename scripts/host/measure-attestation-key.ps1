# ALBERA: the C6 and N7 measurement of the Broker's CNG attestation key (ADR-002 Amendment 2026-11-04, ADR-012 "Before the installer makes the key"). Windows PowerShell 5.1, ASCII only.
# For the owner to run in an elevated console, from the CHECKED COPY of the scripts (host-install.md: copy the script files to C:\Program Files\AlberaSetup, compare their SHA-256 with the
# ALBERA_HOST_SCRIPT_SHA256 lines of the CI run on main). It prints its own hash and the lib's at the start. NOT RUN anywhere yet.
#
#   measure-attestation-key.ps1 -Phase N7 -DryRun    prints every step and every name; creates and changes nothing (needs no admin)
#   measure-attestation-key.ps1 -Phase N7            BEFORE the install: a throwaway key (names, ACL, who can use it, export, can a non-administrator take the name first)
#   measure-attestation-key.ps1 -Phase C6            AFTER the install: the REAL attestation key and the REAL services; nothing is created and nothing is deleted
#   measure-attestation-key.ps1 -RemoveLeftovers     after a forced stop: removes the throwaway key, tasks and work folder an interrupted -Phase N7 left (it never touches the real key)
#
# -Phase N7, in order (each result goes into the report; an error is written as the code Windows returned, never as a bare "failed"):
#   1. a NON-administrator (your own account without its elevation, through a one-shot task) tries to create a machine key of the throwaway name FIRST (N7: can a non-administrator take the name?). A key it made is deleted.
#   2. an administrator creates the throwaway key: ECDSA P-256, Microsoft Software KSP, machine scope, Export Policy none, DACL = SYSTEM, Administrators and the SID of a throwaway virtual account that stands in for the Broker.
#      The DACL and the key file's own DACL (under C:\ProgramData\Microsoft\Crypto\Keys: L9) are read back and shown. The name is written to pending-key.json BEFORE the key is made.
#   3. an export of the private key is tried (it must be refused).
#   4. who can use it: the administrator signs once (control); then one-shot tasks run as the stand-in Broker (must sign), as another virtual account (must not) and as the Control Plane (must not).
#   5. the key, the tasks and the work folder are deleted; the report says what was and was not cleaned up. A failure at any step still writes the report.
# -Phase C6 does steps 3 and 4 and the reads of step 2 against the installed key AlberaHostBroker-attest-1 with the real NT SERVICE\AlberaHostBroker and NT SERVICE\AlberaControlPlane.
# A task Windows will not run is reported as "not measured", never as a pass. Nothing is started from the repository: schtasks.exe and powershell.exe by their full System32 paths. No service is made; the tasks
# are one-shot, have no trigger, and are deleted. No RunAs. The report holds names, SIDs, SDDL text, HRESULT codes and yes / no answers: no key material.
[CmdletBinding()]
param(
  [switch]$DryRun,
  [ValidateSet('N7', 'C6')][string]$Phase = 'N7',
  [switch]$RemoveLeftovers,
  [string]$ReportPath = 'C:\ProgramData\AlberaMeasure\attestation-key-report.json'
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
function Get-MeasureConstants {
  [ordered]@{
    KeyPrefix = 'AlberaMeasure-'
    BrokerStandIn = 'AlberaMeasureBroker'   # a virtual account that never exists as a service: only its SID is used in the key's DACL, and Task Scheduler is asked to run as it
    OtherAccount = 'AlberaMeasureOther'
    ControlPlane = 'AlberaControlPlane'   # the real name (the Broker config's controlPlaneSid is this service's SID)
    TaskPrefix = 'AlberaMeasure-'
    ProbeSeconds = 60
  }
}
function New-MeasureKeyName([byte[]]$Random) {
  if ($null -eq $Random -or $Random.Length -lt 6) { throw 'random_too_short' }
  $name = (Get-MeasureConstants).KeyPrefix + (([BitConverter]::ToString($Random, 0, 6) -replace '-', '').ToLowerInvariant())
  if (-not (Test-KeyName $name)) { throw 'key_name_invalid' }
  $name
}
# The identities of step 4, with the answer each must give. Sid: the SID Windows derives from the service name (the lib's Get-DerivedServiceSid).
function Get-MeasureIdentities([string]$Phase = 'N7') {
  $c = Get-MeasureConstants
  $broker = if ($Phase -eq 'C6') { 'AlberaHostBroker' } else { $c.BrokerStandIn }   # C6 uses the real service's account
  @(
    [pscustomobject]@{ Id = 'broker'; Account = 'NT SERVICE\' + $broker; Sid = (Get-DerivedServiceSid $broker); MustSign = $true }
    [pscustomobject]@{ Id = 'other'; Account = 'NT SERVICE\' + $c.OtherAccount; Sid = (Get-DerivedServiceSid $c.OtherAccount); MustSign = $false }
    [pscustomobject]@{ Id = 'controlplane'; Account = 'NT SERVICE\' + $c.ControlPlane; Sid = (Get-DerivedServiceSid $c.ControlPlane); MustSign = $false }
  )
}
# The HRESULTs a CNG open, sign, create or export can give, by name. Unknown codes keep the number.
function Get-CngErrorName([string]$HResult) {
  if ([string]::IsNullOrEmpty($HResult)) { return $null }
  switch ($HResult.ToUpperInvariant()) {
    '0X80090016' { 'NTE_BAD_KEYSET' } '0X80090010' { 'NTE_PERM' } '0X8009000F' { 'NTE_EXISTS' } '0X8009000D' { 'NTE_NO_KEY' } '0X80090005' { 'NTE_BAD_DATA' }
    '0X80090029' { 'NTE_NOT_SUPPORTED' } '0X80090009' { 'NTE_BAD_FLAGS' } '0X80070005' { 'E_ACCESSDENIED' } '0X80090011' { 'NTE_NOT_FOUND' } '0X8009002A' { 'NTE_NO_MEMORY' }
    default { 'unknown_' + $HResult }
  }
}
# Does a DACL (the allow SIDs read back) name this SID? An ACL reading, not a token test: a virtual account's token holds no group that SY, BA or the stand-in SID names.
function Get-AclVerdict($AllowSids, [string]$Sid) { @($AllowSids) -contains $Sid }
# The one-shot task: no trigger, runs once, as the account. $Logon = 'service' (a virtual account, no password) or 'interactive' (the signed-in user's token WITHOUT elevation).
function ConvertTo-MeasureTaskXml([string]$Principal, [ValidateSet('service', 'interactive')][string]$Logon, [string]$Command, [string]$Arguments) {
  $esc = { param($t) [System.Security.SecurityElement]::Escape($t) }
  $user = if ($Logon -eq 'service') { '<UserId>' + (& $esc $Principal) + '</UserId><LogonType>ServiceAccount</LogonType>' } else { '<UserId>' + (& $esc $Principal) + '</UserId><LogonType>InteractiveToken</LogonType>' }
  '<?xml version="1.0" encoding="UTF-16"?>' + "`r`n" + '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers/>' +
    '<Principals><Principal id="A">' + $user + '<RunLevel>LeastPrivilege</RunLevel></Principal></Principals>' +
    '<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT2M</ExecutionTimeLimit><Enabled>true</Enabled></Settings>' +
    '<Actions Context="A"><Exec><Command>' + (& $esc $Command) + '</Command><Arguments>' + (& $esc $Arguments) + '</Arguments></Exec></Actions></Task>'
}
# What the child runs (as each identity). It opens (sign) or creates (create) the machine key and writes ONE json line: who it was, whether it was elevated, ok, the HRESULT and the exception type. The signed data is 32 zero bytes;
# nothing is read from the key.
function Get-MeasureProbeText {
  @'
param([string]$Mode, [string]$KeyName, [string]$ResultFile)
$ErrorActionPreference = 'Stop'
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$r = [ordered]@{ mode = $Mode; sid = $id.User.Value; elevated = ([System.Security.Principal.WindowsPrincipal]$id).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator); ok = $false; hresult = $null; errorType = $null }
try {
  $provider = [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
  if ($Mode -eq 'sign') {
    $key = [System.Security.Cryptography.CngKey]::Open($KeyName, $provider, [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey)
    $ecdsa = New-Object System.Security.Cryptography.ECDsaCng($key)
    [void]$ecdsa.SignData((New-Object byte[] 32))
    $r.ok = $true
  }
  elseif ($Mode -eq 'create') {
    $p = New-Object System.Security.Cryptography.CngKeyCreationParameters
    $p.Provider = $provider; $p.KeyCreationOptions = [System.Security.Cryptography.CngKeyCreationOptions]::MachineKey
    $p.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::None; $p.KeyUsage = [System.Security.Cryptography.CngKeyUsages]::Signing
    $key = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256, $KeyName, $p)
    $r.ok = $true
  }
}
catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; $r.errorType = $e.GetType().FullName; $r.hresult = ('0x{0:X8}' -f $e.HResult) }
[System.IO.File]::WriteAllText($ResultFile, ($r | ConvertTo-Json -Compress))
'@
}
# The answers, from the facts. $F holds: nonAdminCreate (@{ ran; ok; hresult }), key (@{ allowSids; fileAllowSids }), export (@{ refused; hresult }), adminSign (@{ ok; hresult }) and asIdentity (id -> @{ ran; ok; hresult; error }).
# yes / no / not_measured; a task that did not run is never an answer.
function Get-MeasureVerdicts($F) {
  $ids = Get-MeasureIdentities $(if ($F.ContainsKey('phase')) { $F.phase } else { 'N7' })
  $v = [ordered]@{}
  $v.nonAdministratorCanTakeTheName = if (-not $F.nonAdminCreate.ran) { 'not_measured' } elseif ($F.nonAdminCreate.ok) { 'yes' } else { 'no' }
  $v.keyCannotBeExported = if ($null -eq $F.export) { 'not_measured' } elseif ($F.export.refused) { 'yes' } else { 'no' }
  $v.administratorCanSign = if ($null -eq $F.adminSign) { 'not_measured' } elseif ($F.adminSign.ok) { 'yes' } else { 'no' }
  foreach ($i in $ids) {
    $acl = Get-AclVerdict $F.key.allowSids $i.Sid
    $file = Get-AclVerdict $F.key.fileAllowSids $i.Sid
    $v['aclAllows_' + $i.Id] = if ($acl) { 'yes' } else { 'no' }
    $v['fileAclAllows_' + $i.Id] = if ($null -eq $F.key.fileAllowSids) { 'not_measured' } elseif ($file) { 'yes' } else { 'no' }
    $run = $F.asIdentity[$i.Id]
    $v['signs_' + $i.Id] = if ($null -eq $run -or -not $run.ran) { 'not_measured' } elseif ($run.ok) { 'yes' } else { 'no' }
    $v['asExpected_' + $i.Id] = if ($null -eq $run -or -not $run.ran) { 'not_measured' } elseif ([bool]$run.ok -eq $i.MustSign) { 'yes' } else { 'NO' }
  }
  $v
}
# The report may hold only these keys and no long blob: names, SIDs, SDDL, HRESULT codes, yes / no. Returns the reasons it is not fit to be written (empty = fine).
function Test-MeasureReport($Report) {
  $r = New-Object System.Collections.Generic.List[string]
  $text = $Report | ConvertTo-Json -Depth 8 -Compress
  if ($text -cmatch '[A-Za-z0-9+/=]{120,}') { $r.Add('long_blob') }
  if ($text -cmatch '(?i)BEGIN [A-Z ]*PRIVATE|PrivateBlob|Pkcs8') { $r.Add('key_material') }
  foreach ($k in @('version', 'measuredAt', 'phase', 'keyName', 'machine', 'key', 'facts', 'verdicts', 'cleanup', 'failed', 'notes')) {
    $has = if ($Report -is [System.Collections.IDictionary]) { $Report.Contains($k) } else { $null -ne $Report.PSObject.Properties[$k] }
    if (-not $has) { $r.Add('missing_' + $k) }
  }
  , @($r)
}
function Get-MeasurePlanLines([string]$KeyName, [string]$ReportPath, [string]$Phase = 'N7') {
  $c = Get-MeasureConstants; $ids = Get-MeasureIdentities $Phase
  if ($Phase -eq 'C6') {
    return @(
      "report file: $ReportPath",
      "the installed key $((Get-Wsl2Constants).AttestationKeyName) is READ (DACL, key file DACL) and tried (an export, which must be refused; one signature as the administrator); NOTHING is created and NOTHING is deleted",
      "who can sign: one-shot tasks as $($ids[0].Account) (must sign), $($ids[1].Account) (must not), $($ids[2].Account) (must not); a task Windows will not run is reported as not measured",
      'the tasks and the work folder are deleted; the report says what was and was not cleaned up'
    )
  }
  @(
    "report file: $ReportPath (folder made administrator-only; the work folder next to it is removed at the end)",
    "1. a non-administrator (your own account, one-shot task, not elevated) tries to create the machine key $KeyName first; a key it made is deleted",
    "2. the administrator creates $KeyName (ECDSA P-256, Software KSP, machine scope, Export Policy none, DACL SYSTEM, Administrators, $($ids[0].Account) = $($ids[0].Sid)); the key DACL and the key file DACL are read back",
    '3. an export of the private key is tried (it must be refused)',
    "4. who can sign: the administrator (control), then one-shot tasks as $($ids[0].Account) (must sign), $($ids[1].Account) (must not), $($ids[2].Account) (must not); a task Windows will not run is reported as not measured",
    "5. the key, the $($c.TaskPrefix)* tasks and the work folder are deleted on every way out; the report is written"
  )
}

# ---------------------------------------------------------------------------------------------- system side
$SystemDirectory = [Environment]::SystemDirectory
$SchtasksExe = Join-Path $SystemDirectory 'schtasks.exe'
$PowerShellExe = Join-Path $SystemDirectory 'WindowsPowerShell\v1.0\powershell.exe'
function Invoke-NativeShort([string]$Exe, [string]$Arguments, [int]$TimeoutMs = 60000) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe; $psi.Arguments = $Arguments; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($psi)
  $out = $process.StandardOutput.ReadToEndAsync(); $err = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutMs)) { try { $process.Kill() } catch { }; throw "timeout running $([System.IO.Path]::GetFileName($Exe))" }
  $process.WaitForExit()
  [pscustomobject]@{ Exit = $process.ExitCode; Out = (($out.Result + ' ' + $err.Result) -replace '\s+', ' ').Trim() }
}
function Test-MeasureElevated { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
function Read-FileAllowSids([string]$Path) {
  $acl = [System.IO.File]::GetAccessControl($Path)
  [pscustomobject]@{
    Sddl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner)
    AllowSids = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
  }
}
# The key file of a machine key: <CommonApplicationData>\Microsoft\Crypto\Keys\<UniqueName> (L9: the file's own ACL is the mechanism assumed). $null when it is not where this expects it; said in the report.
function Find-MachineKeyFile([string]$KeyName) {
  $provider = [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
  $key = [System.Security.Cryptography.CngKey]::Open($KeyName, $provider, [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey)
  try { $unique = $key.UniqueName } finally { $key.Dispose() }
  $path = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('Microsoft\Crypto\Keys\' + $unique)
  if ([System.IO.File]::Exists($path)) { $path } else { $null }
}
# One one-shot task as one identity: write the task, run it, wait for its result file (at most ProbeSeconds), delete the task. @{ ran; ok; hresult; error; elevated; sid }.
function Invoke-TaskProbe($Work, [string]$TaskName, [string]$Principal, [string]$Logon, [string]$ResultSid, [string]$Mode, [string]$KeyName) {
  try { Invoke-TaskProbeCore $Work $TaskName $Principal $Logon $ResultSid $Mode $KeyName }
  catch { @{ ran = $false; ok = $false; hresult = $null; error = 'probe_failed: ' + $_.Exception.Message } }   # a probe that cannot even be set up is not an answer
}
function Invoke-TaskProbeCore($Work, [string]$TaskName, [string]$Principal, [string]$Logon, [string]$ResultSid, [string]$Mode, [string]$KeyName) {
  $c = Get-MeasureConstants
  $result = Join-Path $Work.Results ($TaskName + '.json')
  $xmlPath = Join-Path $Work.Root ($TaskName + '.xml')
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $Work.Probe + '" -Mode ' + $Mode + ' -KeyName ' + $KeyName + ' -ResultFile "' + $result + '"'
  [System.IO.File]::WriteAllText($xmlPath, (ConvertTo-MeasureTaskXml $Principal $Logon $PowerShellExe $arguments), [System.Text.Encoding]::Unicode)
  $made = Invoke-NativeShort $SchtasksExe ('/Create /TN "' + $TaskName + '" /XML "' + $xmlPath + '" /F')
  if ($made.Exit -ne 0) { return @{ ran = $false; ok = $false; hresult = $null; error = 'task_not_created: ' + $made.Out } }
  try {
    $started = Invoke-NativeShort $SchtasksExe ('/Run /TN "' + $TaskName + '"')
    if ($started.Exit -ne 0) { return @{ ran = $false; ok = $false; hresult = $null; error = 'task_not_started: ' + $started.Out } }
    $end = (Get-Date).AddSeconds($c.ProbeSeconds)
    while ((Get-Date) -lt $end -and -not [System.IO.File]::Exists($result)) { Start-Sleep -Milliseconds 500 }
    if (-not [System.IO.File]::Exists($result)) { return @{ ran = $false; ok = $false; hresult = $null; error = 'no_result_in_time' } }
    Start-Sleep -Milliseconds 200
    $r = [System.IO.File]::ReadAllText($result) | ConvertFrom-Json
    if ($r.sid -cne $ResultSid) { return @{ ran = $false; ok = $false; hresult = $null; error = 'ran_as_another_account:' + $r.sid } }   # the task did not run as the asked identity: not a measurement of it
    @{ ran = $true; ok = [bool]$r.ok; hresult = $r.hresult; error = $r.errorType; elevated = [bool]$r.elevated; sid = $r.sid }
  }
  finally {
    [void](Invoke-NativeShort $SchtasksExe ('/End /TN "' + $TaskName + '"'))
    [void](Invoke-NativeShort $SchtasksExe ('/Delete /TN "' + $TaskName + '" /F'))
  }
}
# Step 3 and the control of step 4: with the key open as the administrator, one export of the private key (must be refused) and one signature. The exported blob, if there were one, is dropped at once and never stored.
function Measure-KeyExportAndSign([string]$KeyName) {
  $provider = [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
  $opened = [System.Security.Cryptography.CngKey]::Open($KeyName, $provider, [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey)
  try {
    $sign = @{ ok = $false; hresult = $null }
    try { $ecdsa = New-Object System.Security.Cryptography.ECDsaCng($opened); [void]$ecdsa.SignData((New-Object byte[] 32)); $sign = @{ ok = $true; hresult = $null } }
    catch { $sign = @{ ok = $false; hresult = ('0x{0:X8}' -f $_.Exception.HResult) } }
    $export = $null
    try { [void]$opened.Export([System.Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob); $export = @{ refused = $false; hresult = $null } }
    catch { $export = @{ refused = $true; hresult = ('0x{0:X8}' -f $_.Exception.HResult) } }
    @{ adminSign = $sign; export = $export }
  }
  finally { $opened.Dispose() }
}
function Invoke-NativeSafe([string]$Exe, [string]$Arguments) { try { Invoke-NativeShort $Exe $Arguments } catch { [pscustomobject]@{ Exit = -1; Out = $_.Exception.Message } } }
# Deletes the throwaway tasks one by one (one that will not delete does not stop the others) and asks again: returns the names that are STILL there.
function Remove-MeasureTasks([string[]]$Names) {
  foreach ($n in $Names) { [void](Invoke-NativeSafe $SchtasksExe ('/End /TN "' + $n + '"')); [void](Invoke-NativeSafe $SchtasksExe ('/Delete /TN "' + $n + '" /F')) }
  , @($Names | Where-Object { (Invoke-NativeSafe $SchtasksExe ('/Query /TN "' + $_ + '"')).Exit -eq 0 })
}
function Invoke-Measurement([string]$ReportPath, [string]$Phase = 'N7') {
  $c = Get-MeasureConstants
  $random = New-Object byte[] 8; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($random); $rng.Dispose()
  $owns = ($Phase -eq 'N7')   # only N7 makes a key, and only that key is ever deleted
  $keyName = if ($owns) { New-MeasureKeyName $random } else { (Get-Wsl2Constants).AttestationKeyName }
  $ids = Get-MeasureIdentities $Phase
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $folder = Split-Path -Parent $ReportPath
  if (-not (Test-PlainAbsolutePath $ReportPath)) { throw 'the report path is not a plain absolute path' }
  if (Test-Path -LiteralPath $folder) {
    $why = Get-PathTrustReasons $folder (Get-AdminSids) $true
    if ($why.Count -gt 0) { throw (Format-TrustRefusal $folder $why) }
  }
  else { New-SecuredDirectory $folder @('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F') }
  $work = [pscustomobject]@{ Root = Join-Path $folder ('run-' + ([BitConverter]::ToString($random, 0, 4) -replace '-', '').ToLowerInvariant()); Probe = $null; Results = $null }
  $work.Probe = Join-Path $work.Root 'probe.ps1'; $work.Results = Join-Path $work.Root 'results'
  $sids = @($ids | ForEach-Object { $_.Sid }) + @($me)
  $facts = @{ phase = $Phase; nonAdminCreate = @{ ran = $false; ok = $false; hresult = $null }; key = @{ allowSids = @(); fileAllowSids = $null }; export = $null; adminSign = $null; asIdentity = @{} }
  $cleanup = [ordered]@{ keyDeleted = (-not $owns); keyKept = (-not $owns); tasksLeft = @(); workFolderRemoved = $false }
  $notes = New-Object System.Collections.Generic.List[string]
  $keyInfo = [ordered]@{}
  $failed = $false
  $taskNames = @($ids | ForEach-Object { $c.TaskPrefix + $_.Id }) + @($c.TaskPrefix + 'create')
  $marker = Join-Path $folder 'pending-key.json'
  try {
    # the work folder: administrators write; the identities read the probe and write their one result file
    New-SecuredDirectory $work.Root (@('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F') + @($sids | ForEach-Object { "*${_}:(OI)(CI)RX" }))
    New-SecuredDirectory $work.Results (@('*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F') + @($sids | ForEach-Object { "*${_}:(OI)(CI)M" }))
    [System.IO.File]::WriteAllText($work.Probe, ((Get-MeasureProbeText) -replace "`r?`n", "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    if ($owns) {
      # written BEFORE the key exists: -RemoveLeftovers reads it after a forced stop
      [System.IO.File]::WriteAllText($marker, (([ordered]@{ keyName = $keyName; tasks = $taskNames; workFolder = $work.Root }) | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "1. a non-administrator tries to create $keyName first"
      $facts.nonAdminCreate = Invoke-TaskProbe $work ($c.TaskPrefix + 'create') $me 'interactive' $me 'create' $keyName
      if ($facts.nonAdminCreate.ok -and (Test-AuthoritySigningKeyExists $keyName)) { [void](Remove-AuthoritySigningKey $keyName); $notes.Add('the key a non-administrator made was deleted') }
      Write-Host "2. the administrator creates $keyName"
      $made = New-AuthoritySigningKey $keyName $ids[0].Sid 'machine'
      $keyInfo = [ordered]@{ algorithm = $made.report.algorithm; keySize = $made.report.keySize; exportPolicy = $made.report.exportPolicy; owner = $made.report.owner; allowSids = @($made.report.allowSids) }
      $facts.key.allowSids = @($made.report.allowSids)
    }
    else {
      Write-Host "2. reading the installed key $keyName (nothing is created)"
      $have = Read-AuthoritySigningKey $keyName
      if (-not $have) { throw "the installed key $keyName does not exist; install with -AddWsl2Computer first" }
      $keyInfo = [ordered]@{ algorithm = $have.report.algorithm; keySize = $have.report.keySize; exportPolicy = $have.report.exportPolicy; owner = $have.report.owner; allowSids = @($have.report.allowSids) }
      $facts.key.allowSids = @($have.report.allowSids)
    }
    $file = Find-MachineKeyFile $keyName
    if ($file) { $f = Read-FileAllowSids $file; $keyInfo['file'] = $file; $keyInfo['fileSddl'] = $f.Sddl; $facts.key.fileAllowSids = @($f.AllowSids) }
    else { $notes.Add('the key file was not found where C:\ProgramData\Microsoft\Crypto\Keys\<UniqueName> would be: the file DACL (L9) is not measured') }
    Write-Host '3. an export of the private key is tried; the administrator signs once'
    $local = Measure-KeyExportAndSign $keyName
    $facts.export = $local.export; $facts.adminSign = $local.adminSign
    Write-Host '4. who can sign'
    foreach ($i in $ids) { $facts.asIdentity[$i.Id] = Invoke-TaskProbe $work ($c.TaskPrefix + $i.Id) $i.Account 'service' $i.Sid 'sign' $keyName }
  }
  catch { $failed = $true; $notes.Add('FAILED: ' + $_.Exception.Message) }
  finally {
    if ($owns) { try { if (Test-AuthoritySigningKeyExists $keyName) { [void](Remove-AuthoritySigningKey $keyName) }; $cleanup.keyDeleted = -not (Test-AuthoritySigningKeyExists $keyName) } catch { $notes.Add('the key could not be deleted: ' + $_.Exception.Message) } }
    try { $cleanup.tasksLeft = Remove-MeasureTasks $taskNames } catch { $notes.Add('the tasks could not be checked: ' + $_.Exception.Message) }
    try { if (Test-Path -LiteralPath $work.Root) { [System.IO.Directory]::Delete($work.Root, $true) }; $cleanup.workFolderRemoved = -not (Test-Path -LiteralPath $work.Root) } catch { $notes.Add('the work folder could not be removed: ' + $_.Exception.Message) }
    if ($owns -and $cleanup.keyDeleted -and $cleanup.workFolderRemoved -and @($cleanup.tasksLeft).Count -eq 0) { try { if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force } } catch { } }
  }
  $report = [ordered]@{
    version = 1; measuredAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); phase = $Phase; keyName = $keyName; machine = [Environment]::MachineName
    key = $keyInfo
    facts = [ordered]@{
      nonAdminCreate = $facts.nonAdminCreate; export = $facts.export; adminSign = $facts.adminSign
      asIdentity = [ordered]@{ broker = $facts.asIdentity['broker']; other = $facts.asIdentity['other']; controlplane = $facts.asIdentity['controlplane'] }
      errorNames = [ordered]@{ nonAdminCreate = (Get-CngErrorName $facts.nonAdminCreate.hresult); export = $(if ($facts.export) { Get-CngErrorName $facts.export.hresult }); other = $(if ($facts.asIdentity['other']) { Get-CngErrorName $facts.asIdentity['other'].hresult }); controlplane = $(if ($facts.asIdentity['controlplane']) { Get-CngErrorName $facts.asIdentity['controlplane'].hresult }) }
    }
    verdicts = Get-MeasureVerdicts $facts
    cleanup = $cleanup
    failed = $failed
    notes = @($notes)
  }
  $bad = Test-MeasureReport $report
  if ($bad.Count -gt 0) { throw "the report is not fit to be written: $($bad -join ', ')" }
  [System.IO.File]::WriteAllText($ReportPath, ($report | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))   # also after a failure: what was and was not cleaned up is in it
  $report
}
# After a forced stop of -Phase N7: the marker names the throwaway key. Only a name of exactly our form is ever deleted; the real attestation key can never match it.
function Invoke-RemoveLeftovers([string]$ReportPath) {
  $folder = Split-Path -Parent $ReportPath
  $marker = Join-Path $folder 'pending-key.json'
  if (-not (Test-Path -LiteralPath $marker)) { Write-Host 'no pending-key.json: nothing was left by an interrupted -Phase N7'; return 0 }
  $why = Get-PathTrustReasons $folder (Get-AdminSids) $true
  if ($why.Count -gt 0) { Write-Host (Format-TrustRefusal $folder $why); return 3 }
  $m = [System.IO.File]::ReadAllText($marker) | ConvertFrom-Json
  $c = Get-MeasureConstants
  if ([string]$m.keyName -cnotmatch ('^' + [regex]::Escape($c.KeyPrefix) + '[0-9a-f]{12}\z')) { Write-Host 'the marker names no throwaway key of ours; nothing was deleted'; return 3 }
  $deleted = $false
  if (Test-AuthoritySigningKeyExists $m.keyName) { [void](Remove-AuthoritySigningKey $m.keyName); $deleted = $true }
  $left = Remove-MeasureTasks @($c.TaskPrefix + 'broker', $c.TaskPrefix + 'other', $c.TaskPrefix + 'controlplane', $c.TaskPrefix + 'create')
  foreach ($d in @([System.IO.Directory]::GetDirectories($folder, 'run-*'))) { try { [System.IO.Directory]::Delete($d, $true) } catch { Write-Host "could not remove $d ($($_.Exception.Message))" } }
  $stillThere = Test-AuthoritySigningKeyExists $m.keyName
  Write-Host "throwaway key $($m.keyName): deleted now: $deleted; still there: $stillThere; tasks still there: $(@($left).Count)"
  if (-not $stillThere -and @($left).Count -eq 0) { Remove-Item -LiteralPath $marker -Force; return 0 }
  1
}

if ($MyInvocation.InvocationName -eq '.') { return }   # dot-sourced by a test: the functions only
try {
  foreach ($f in @($PSCommandPath, (Join-Path $PSScriptRoot 'albera-host-lib.ps1'))) { Write-Host ('script ' + [System.IO.Path]::GetFileName($f) + ' sha256 ' + (Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLowerInvariant() + '  (compare with the ALBERA_HOST_SCRIPT_SHA256 line of the CI run on main)') }
  if ($DryRun) {
    Write-Host "measure-attestation-key.ps1 -Phase $Phase - DRY RUN. Nothing is created or changed."
    foreach ($line in (Get-MeasurePlanLines ((Get-MeasureConstants).KeyPrefix + '<12 hex>') $ReportPath $Phase)) { Write-Host $line }
    exit 0
  }
  if (-not (Test-MeasureElevated)) { Write-Host 'REFUSED: run this in an elevated console (Run as administrator). It never elevates itself.'; exit 3 }
  if ($RemoveLeftovers) { exit (Invoke-RemoveLeftovers $ReportPath) }
  $report = Invoke-Measurement $ReportPath $Phase
  Write-Host "Report written: $ReportPath"
  foreach ($p in $report.verdicts.GetEnumerator()) { Write-Host ('  {0} = {1}' -f $p.Key, $p.Value) }
  $cl = $report.cleanup
  Write-Host "cleanup: key deleted: $($cl.keyDeleted) (kept on purpose in C6: $($cl.keyKept)); tasks still there: $(@($cl.tasksLeft).Count); work folder removed: $($cl.workFolderRemoved)"
  $dirty = (-not $cl.keyDeleted) -or @($cl.tasksLeft).Count -gt 0 -or (-not $cl.workFolderRemoved)
  if ($dirty) { Write-Host 'NOT everything was cleaned up. Run this script with -RemoveLeftovers.' }
  if ($report.failed) { Write-Host 'The measurement FAILED part-way (see notes in the report); the answers above are incomplete.' }
  exit $(if ($report.failed -or $dirty) { 1 } else { 0 })
}
catch {
  Write-Host ('ERROR: ' + $_.Exception.Message)
  Write-Host 'Nothing is claimed about cleanup here. Run with -RemoveLeftovers to remove a throwaway key, tasks and work folder an interrupted -Phase N7 may have left.'
  exit 1
}
