<#
.SYNOPSIS
  The host-changing part of packaging the ALBERA approver as a self-signed MSIX (issue #101).
.DESCRIPTION
  Everything that creates a certificate, trusts it, installs or removes the package lives in THIS script and nowhere else. Without -Apply every step is a DRY RUN: it prints what it
  would change, what it needs and how to undo it, and changes nothing. With -Apply it does exactly what the dry run printed. It never elevates itself: the two steps that need
  administrator rights (Trust, Untrust) stop with a message unless you started PowerShell as administrator (this is the one UAC prompt).

  Steps, in the order for a first install (run each as a dry run first, then again with -Apply):
    Sign       not elevated. Makes a self-signed code-signing certificate (subject = the Publisher in scripts\approver-msix-identity.json) in Cert:\CurrentUser\My, packs and signs the
               package with it (needs `npm run build:approver` first), exports the PUBLIC half to AlberaApprover.cer, then deletes the certificate and its private key again, so no
               signing key stays on this PC.
    Trust      administrator. Imports AlberaApprover.cer (public) into Cert:\LocalMachine\TrustedPeople so Windows accepts the package.
    Install    not elevated. Add-AppxPackage of the signed package for this user.
  Undo, in this order:
    Uninstall  not elevated. Remove-AppxPackage.
    Untrust    administrator. Removes the certificate from Cert:\LocalMachine\TrustedPeople.

  The package family name (what Windows Hello scopes the key to) and every other identity value come from scripts\approver-msix-identity.json, the single registry.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\approver-msix-install.ps1 -Step Sign          (dry run)
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\approver-msix-install.ps1 -Step Sign -Apply
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('Sign', 'Trust', 'Install', 'Uninstall', 'Untrust')][string]$Step,
  [switch]$Apply,
  [ValidatePattern('^[0-9A-Fa-f]{40}$')][string]$Thumbprint
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$identity = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'approver-msix-identity.json') | ConvertFrom-Json
if ($identity.publisher -notmatch '^CN=[A-Za-z0-9][A-Za-z0-9 .-]{0,63}$' -or $identity.packageName -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$') {
  throw 'approver-msix-identity.json: publisher or packageName is not in the allowed form'
}
$outDir = Join-Path $repo 'src\runtime\windows-approver\bin\msix'
$msix = Join-Path $outDir 'AlberaApprover.msix'
$cer = Join-Path $outDir 'AlberaApprover.cer'
$packScript = Join-Path $PSScriptRoot 'package-windows-approver-msix.mjs'
$trustStore = 'Cert:\LocalMachine\TrustedPeople'

function Write-Plan([string[]]$Changes, [string[]]$Needs, [string[]]$Undo) {
  $mode = if ($Apply) { 'APPLY' } else { 'DRY RUN (nothing is changed; add -Apply to do it)' }
  Write-Host "== step $Step : $mode"
  foreach ($line in $Changes) { Write-Host "   CHANGES: $line" }
  foreach ($line in $Needs) { Write-Host "   NEEDS:   $line" }
  foreach ($line in $Undo) { Write-Host "   UNDO:    $line" }
}

function Test-Administrator {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Administrator {
  if (-not (Test-Administrator)) {
    throw 'this step needs administrator rights. Start PowerShell with "Run as administrator" (one UAC prompt) and run the same command again. This script never elevates itself.'
  }
}

# $null only in a dry run (so the plan can be read before the Sign step); with -Apply a missing file is an error.
function Read-PublicCertificate {
  if (-not (Test-Path -LiteralPath $cer)) {
    if (-not $Apply) { return $null }
    throw "missing $cer : run -Step Sign first"
  }
  $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($cer)
  if ($certificate.Subject -ne $identity.publisher -or $certificate.Issuer -ne $identity.publisher) { throw "the certificate in $cer is not the self-signed $($identity.publisher)" }
  if ($certificate.HasPrivateKey) { throw "$cer holds a private key; refusing to use it" }
  $usage = @($certificate.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] })
  if ($usage.Count -ne 1 -or -not ($usage[0].EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' })) { throw "$cer is not a code-signing certificate" }
  $constraints = @($certificate.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension] })
  if ($constraints.Count -eq 1 -and $constraints[0].CertificateAuthority) { throw "$cer is a CA certificate; refusing to trust it" }
  return $certificate
}

function Remove-SigningCertificate([string]$Print) {
  $path = "Cert:\CurrentUser\My\$Print"
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -DeleteKey -Force
    Write-Host "   removed the signing certificate and its private key ($Print) from Cert:\CurrentUser\My"
  }
}

function Invoke-Sign {
  Write-Plan @(
    "makes a self-signed code-signing certificate '$($identity.publisher)' (RSA 3072, non-exportable key, $($identity.certificateYears) years) in Cert:\CurrentUser\My",
    "runs node scripts\package-windows-approver-msix.mjs --sign-thumbprint <it>: writes $msix",
    "writes the public certificate $cer",
    'deletes the certificate AND its private key from Cert:\CurrentUser\My again (also if packing fails)') @(
    'npm run build:approver done first; node on PATH; network (the pinned, hash-checked Windows SDK build tools are fetched into a temp folder)') @(
    "delete $msix and $cer",
    "if this stopped half way: Get-ChildItem Cert:\CurrentUser\My | Where-Object Subject -eq '$($identity.publisher)' | Remove-Item -DeleteKey")
  if (-not $Apply) { return }
  $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $created = New-SelfSignedCertificate -Type Custom -Subject $identity.publisher -KeyUsage DigitalSignature -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
    -KeyExportPolicy NonExportable -FriendlyName 'ALBERA Local Approver (self-signed, local use only)' -NotAfter (Get-Date).AddYears([int]$identity.certificateYears) `
    -CertStoreLocation 'Cert:\CurrentUser\My' -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
  try {
    Write-Host "   made certificate $($created.Thumbprint)"
    & $node $packScript --sign-thumbprint $created.Thumbprint
    if ($LASTEXITCODE -ne 0) { throw "packing or signing failed (exit $LASTEXITCODE)" }
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    Export-Certificate -Cert $created -FilePath $cer -Type CERT | Out-Null
    Write-Host "   wrote $msix and $cer (public certificate $($created.Thumbprint))"
  }
  finally { Remove-SigningCertificate $created.Thumbprint }
}

function Get-PrintOrPlaceholder($certificate) {
  if ($certificate) { return $certificate.Thumbprint }
  return '<thumbprint of AlberaApprover.cer, known after the Sign step>'
}

function Invoke-Trust {
  $certificate = Read-PublicCertificate
  $print = Get-PrintOrPlaceholder $certificate
  Write-Plan @("imports the PUBLIC certificate $print ($($identity.publisher)) from $cer into $trustStore. This PC then accepts any package signed with it; its private key was deleted by the Sign step") @(
    'a PowerShell started as administrator (one UAC prompt); this script does not elevate itself') @(
    "powershell -File scripts\approver-msix-install.ps1 -Step Untrust -Apply   (or Remove-Item $trustStore\$print as administrator)")
  if (-not $Apply) { return }
  Assert-Administrator
  if (Test-Path -LiteralPath "$trustStore\$print") { Write-Host '   already trusted; nothing to do'; return }
  Import-Certificate -FilePath $cer -CertStoreLocation $trustStore | Out-Null
  Write-Host "   trusted $print in $trustStore"
}

function Invoke-Install {
  $certificate = Read-PublicCertificate
  $print = Get-PrintOrPlaceholder $certificate
  Write-Plan @("installs $msix for the current user as package '$($identity.packageName)' (Add-AppxPackage); creates the command $($identity.alias) in %LOCALAPPDATA%\Microsoft\WindowsApps") @(
    "$msix signed (-Step Sign) and the certificate $print trusted (-Step Trust)") @(
    "powershell -File scripts\approver-msix-install.ps1 -Step Uninstall -Apply   (or Get-AppxPackage -Name $($identity.packageName) | Remove-AppxPackage)")
  if (-not $Apply) { return }
  if (-not (Test-Path -LiteralPath $msix)) { throw "missing $msix : run -Step Sign first" }
  if (-not (Test-Path -LiteralPath "$trustStore\$print")) { throw "the certificate $print is not in $trustStore : run -Step Trust as administrator first" }
  Add-AppxPackage -Path $msix
  $package = Get-AppxPackage -Name $identity.packageName
  Write-Host "   installed $($package.PackageFullName)"
  Write-Host "   package family name: $($package.PackageFamilyName)   (the Windows Hello key will belong to this)"
  Write-Host "   start it as: $env:LOCALAPPDATA\Microsoft\WindowsApps\$($identity.alias)"
}

function Invoke-Uninstall {
  Write-Plan @("removes the package '$($identity.packageName)' for the current user (Remove-AppxPackage). The Hello key the package enrolled belongs to its family name, so enrol again after a new install and put the new key into the Authority config") @(
    'nothing') @('install again with -Step Install')
  if (-not $Apply) { return }
  $packages = @(Get-AppxPackage -Name $identity.packageName)
  if ($packages.Count -eq 0) { Write-Host '   not installed; nothing to do'; return }
  foreach ($package in $packages) { Remove-AppxPackage -Package $package.PackageFullName }
  Write-Host '   removed'
}

function Invoke-Untrust {
  $print = if ($Thumbprint) { $Thumbprint.ToUpperInvariant() } else { Get-PrintOrPlaceholder (Read-PublicCertificate) }
  Write-Plan @("removes the certificate $print from $trustStore (Windows then refuses new installs of packages signed with it; an installed package keeps running)") @(
    'a PowerShell started as administrator (one UAC prompt)') @('import it again with -Step Trust')
  if (-not $Apply) { return }
  Assert-Administrator
  $path = "$trustStore\$print"
  if (-not (Test-Path -LiteralPath $path)) { Write-Host '   not in the store; nothing to do'; return }
  Remove-Item -LiteralPath $path -Force
  Write-Host "   removed $print from $trustStore"
}

switch ($Step) {
  'Sign' { Invoke-Sign }
  'Trust' { Invoke-Trust }
  'Install' { Invoke-Install }
  'Uninstall' { Invoke-Uninstall }
  'Untrust' { Invoke-Untrust }
}
