# Test driver (Windows PowerShell 5.1, ASCII only, NO admin): makes the Authority signing key the way albera-host.ps1 does, but in USER scope (a persisted per-user software-KSP key with a
# random name, removed at the end), signs a message with it and prints the SPKI the installer would put into the Broker config. The Node test verifies the signature with that SPKI.
# Machine scope, the service SID in the DACL and the Authority's start-up guard are lab-only.
param([Parameter(Mandatory = $true)][string]$KeyName, [Parameter(Mandatory = $true)][string]$MessageBase64)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\host\albera-host-lib.ps1')
$serviceSid = Get-DerivedServiceSid 'AlberaApprovalAuthority'
$out = [ordered]@{}
$created = $false
try {
  $made = New-AuthoritySigningKey $KeyName $serviceSid 'user'
  $created = $true
  $out.spki = $made.spki
  $out.report = $made.report
  $out.serviceSid = $serviceSid
  $again = Read-AuthoritySigningKey $KeyName 'user'
  $out.readSpkiEqual = ($again.spki -eq $made.spki)
  $out.exists = Test-AuthoritySigningKeyExists $KeyName 'user'
  $key = [System.Security.Cryptography.CngKey]::Open($KeyName, [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider, [System.Security.Cryptography.CngKeyOpenOptions]::None)
  try { $signer = New-Object System.Security.Cryptography.ECDsaCng($key); $out.signature = [Convert]::ToBase64String($signer.SignData([Convert]::FromBase64String($MessageBase64))) } finally { $key.Dispose() }
  $out.secondCreateRefused = try { New-AuthoritySigningKey $KeyName $serviceSid 'user' | Out-Null; $false } catch { $_.Exception.Message }
  $out.machineNeedsServiceSid = try { New-AuthoritySigningKey ($KeyName + 'x') 'S-1-5-21-1-2-3-4' 'machine' | Out-Null; $false } catch { $_.Exception.Message }
}
finally {
  if ($created) { $out.removed = Remove-AuthoritySigningKey $KeyName 'user' }
  $out.existsAfter = Test-AuthoritySigningKeyExists $KeyName 'user'
}
ConvertTo-Json -InputObject $out -Depth 5 -Compress
