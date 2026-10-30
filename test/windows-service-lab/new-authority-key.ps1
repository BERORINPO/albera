# Creates (or removes) the Approval Authority's signing key for the disposable lab VM. Windows PowerShell 5.1, ASCII only.
#   new-authority-key.ps1 -KeyName <name> -ServiceSid <S-1-5-80-...> [-Variant good|exportable|broad_ace]     create a MACHINE key (run as Administrator, in the lab VM only)
#   new-authority-key.ps1 -KeyName <name> -Remove                                                             delete it
# The key is an ECDSA P-256 key in the Microsoft Software Key Storage Provider (machine scope, as the Authority opens it: NCRYPT_MACHINE_KEY_FLAG).
#   good        Export Policy = none; DACL = SYSTEM, BUILTIN\Administrators and the service SID, nothing else (what the Authority's start-up guard requires)
#   exportable  Export Policy = allow export; the same DACL                    -> the Authority must refuse it (exit 78, key_exportable)
#   broad_ace   Export Policy = none; the same DACL plus Everyone (read)       -> the Authority must refuse it (exit 78, ace_untrusted)
# -Scope user exists only so the host test can run this script without admin rights (a per-user key); the lab never uses it. In user scope -ServiceSid
# defaults to the signed-in user. Never run it on a real host with -Scope machine: it creates a machine key.
# It prints one JSON line read back from a FRESH open of the key (export policy, security descriptor as SDDL), so the evidence is what is stored, not what was asked for.
param(
  [Parameter(Mandatory = $true)][string]$KeyName,
  [string]$ServiceSid,
  [ValidateSet('good', 'exportable', 'broad_ace')][string]$Variant = 'good',
  [ValidateSet('machine', 'user')][string]$Scope = 'machine',
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
if ($KeyName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'KeyName must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' }
$provider = [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
$openOptions = if ($Scope -eq 'machine') { [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey } else { [System.Security.Cryptography.CngKeyOpenOptions]::None }

if ($Remove) {
  $removed = $false
  if ([System.Security.Cryptography.CngKey]::Exists($KeyName, $provider, $openOptions)) {
    $old = [System.Security.Cryptography.CngKey]::Open($KeyName, $provider, $openOptions)
    $old.Delete()   # Delete disposes the handle
    $removed = $true
  }
  (@{ keyName = $KeyName; scope = $Scope; removed = $removed } | ConvertTo-Json -Compress)
  return
}

if ([System.Security.Cryptography.CngKey]::Exists($KeyName, $provider, $openOptions)) { throw "key $KeyName already exists; refusing to touch it" }
if (-not $ServiceSid) {
  if ($Scope -ne 'user') { throw '-ServiceSid is required for a machine key' }
  $ServiceSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}
if ($ServiceSid -notmatch '^S-1-5-(80-[0-9-]+|21-[0-9-]+)$') { throw 'ServiceSid must be a service SID (S-1-5-80-...) or an account SID (S-1-5-21-...)' }

$parameters = New-Object System.Security.Cryptography.CngKeyCreationParameters
$parameters.Provider = $provider
$parameters.KeyUsage = [System.Security.Cryptography.CngKeyUsages]::Signing
$parameters.ExportPolicy = if ($Variant -eq 'exportable') { [System.Security.Cryptography.CngExportPolicies]::AllowExport } else { [System.Security.Cryptography.CngExportPolicies]::None }
if ($Scope -eq 'machine') { $parameters.KeyCreationOptions = [System.Security.Cryptography.CngKeyCreationOptions]::MachineKey }

# DACL only (DACL_SECURITY_INFORMATION = 4); the owner is whoever created the key (Administrators for an elevated administrator). Protected: nothing inherited.
$sddl = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;$ServiceSid)"
if ($Variant -eq 'broad_ace') { $sddl += '(A;;GR;;;WD)' }
# User scope only (host tests): the signed-in user must stay able to open and delete the key, or it could not be read back or removed.
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($Scope -eq 'user' -and $me -ne $ServiceSid) { $sddl += "(A;;GA;;;$me)" }
$descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)
$bytes = New-Object byte[] $descriptor.BinaryLength
$descriptor.GetBinaryForm($bytes, 0)

$key = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256, $KeyName, $parameters)
try {
  $key.SetProperty((New-Object System.Security.Cryptography.CngProperty('Security Descr', $bytes, [System.Security.Cryptography.CngPropertyOptions]4)))
}
catch {
  $key.Delete()   # never leave a key behind whose DACL was not set
  throw
}
$key.Dispose()

# Read back from a fresh open: owner + DACL (OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION = 5) and the export policy.
$stored = [System.Security.Cryptography.CngKey]::Open($KeyName, $provider, $openOptions)
try {
  $storedBytes = [byte[]]$stored.GetProperty('Security Descr', [System.Security.Cryptography.CngPropertyOptions]5).GetValue()
  $readBack = [System.Security.AccessControl.RawSecurityDescriptor]::new($storedBytes, 0)
  $sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
  $report = [ordered]@{
    keyName = $KeyName; scope = $Scope; variant = $Variant; serviceSid = $ServiceSid
    exportPolicy = [int]$stored.ExportPolicy; algorithm = $stored.Algorithm.Algorithm; keySize = $stored.KeySize
    owner = $readBack.Owner.Value; sddl = $readBack.GetSddlForm($sections)
  }
}
finally { $stored.Dispose() }
($report | ConvertTo-Json -Compress)
