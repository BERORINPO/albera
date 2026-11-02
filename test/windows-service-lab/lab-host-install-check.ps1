# Guest-side hook for the HOST installer (scripts/host/albera-host.ps1). Runs INSIDE a disposable lab VM as Administrator (Windows PowerShell 5.1), ASCII only. LAB ONLY.
#   lab-host-install-check.ps1 -HostScriptDir <folder with albera-host.ps1 + albera-host-lib.ps1> -RepoRoot <folder holding src\runtime\...\publish build outputs> [-KeepInstalled]
# It runs install (with -StartCheck: each service is started once and stopped again), status, a second install (must change nothing), uninstall and a final status, all NON-interactively,
# and prints one JSON evidence object. It never prints the account password (a random one is made here and handed over as a SecureString, which is accepted only because the lab
# driver sets ALBERA_LAB_VM=1 in the VM). The Hello key is replaced by a throw-away public key (no private half exists): the lab has no Windows Hello, and no check here asks for an approval.
# Refuses to run unless ALBERA_LAB_VM=1 and the two Albera folders do not exist yet. NOT executed yet (the lab VM run is the lead's): expect first-run fixes.
param(
  [Parameter(Mandatory = $true)][string]$HostScriptDir,
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [switch]$KeepInstalled
)
$ErrorActionPreference = 'Stop'
if ($env:ALBERA_LAB_VM -ne '1') { throw 'refusing to run: this is the lab VM hook. ALBERA_LAB_VM=1 must be set by the lab driver inside the disposable VM; never run it on a real PC.' }
$hostScript = Join-Path $HostScriptDir 'albera-host.ps1'
if (-not (Test-Path -LiteralPath $hostScript)) { throw 'albera-host.ps1 not found in -HostScriptDir' }
$programData = Join-Path $env:ProgramData 'Albera'; $programFiles = Join-Path $env:ProgramFiles 'Albera'
foreach ($p in @($programData, $programFiles)) { if (Test-Path -LiteralPath $p) { throw "$p already exists; the lab hook needs a fresh VM" } }

# A throw-away RSA-2048 PUBLIC key (the one lab-guest.ps1 pins); the approver SID is this Administrator account (S-1-5-21-...-500), which is not the new albera-cp account.
$labApproverKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3XSX1Rx6n1/sVaG+opeyv2Qj/+8woifjIQgxqheuZ1LtyB/JUeDgkP6wIc6YSAQzMKbdwZ88ipVJidmpixqr0P4tcE3Ud6VqerYfHnrVlqGKHojUU0r2kmtKib9f3bT0+ljHa54Dux9jcGSncwXpXcRrOkNFRFrWuS99+yXpFWdgYeawOK9SegknG1J4Rw7fjPZurkVWYYLl17T10PSIg0TGY0eJRgRXVw7PQhsLRh4u3ErDSd4dkE4j1aUR0jCGovRZJrrAMib7P1+GPRUOL6bviCkYY9Q2yOIP+OKWevFw80WXdYktQv/3xeloBWYctgzU6aS7J+7logyEYr0zWwIDAQAB'
$approverSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$labValues = (@{ approverPublicKey = $labApproverKey; approverKeyId = 'hello-lab-0001'; approverSid = $approverSid } | ConvertTo-Json -Compress)

$bytes = New-Object byte[] 12; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose()
$password = ConvertTo-SecureString ('Lab-' + ([BitConverter]::ToString($bytes) -replace '-', '') + '-a1!') -AsPlainText -Force

# $Params is a hashtable of the host script's parameters (a hashtable splat binds names; an array splat would pass '-Mode' as a value).
function Invoke-Host([hashtable]$Params) {
  $all = @{ RepoRoot = $RepoRoot } + $Params
  $text = (& $hostScript @all *>&1 | Out-String)
  [pscustomobject]@{ Exit = $LASTEXITCODE; Output = $text }
}
. (Join-Path $HostScriptDir 'albera-host-lib.ps1')
function Get-Remnants {
  [ordered]@{
    services = @(@('AlberaHostBroker', 'AlberaApprovalAuthority') | Where-Object { Get-CimInstance Win32_Service -Filter "Name='$_'" })
    user = [bool](Get-LocalUser -Name 'albera-cp' -ErrorAction SilentlyContinue)
    key = [bool](Test-AuthoritySigningKeyExists (Get-HostConstants).SigningKeyName)
    programData = Test-Path -LiteralPath $programData
    programFiles = Test-Path -LiteralPath $programFiles
  }
}

$evidence = [ordered]@{ approverSid = $approverSid }
$install = Invoke-Host @{ Mode = 'install'; ApproverKeyId = 'hello-lab-0001'; StartCheck = $true; ControlPlanePassword = $password; LabApproverValues = $labValues }
$evidence.install = [ordered]@{ exit = $install.Exit; output = $install.Output }
$status = Invoke-Host @{ Mode = 'status' }
$evidence.status = [ordered]@{ exit = $status.Exit; output = $status.Output }
$manifest = Join-Path $programData 'install-manifest.json'
$hashBefore = if (Test-Path -LiteralPath $manifest) { (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash } else { '' }
$again = Invoke-Host @{ Mode = 'install'; ApproverKeyId = 'hello-lab-0001'; ControlPlanePassword = $password; LabApproverValues = $labValues }
$hashAfter = if (Test-Path -LiteralPath $manifest) { (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash } else { '' }
$evidence.reinstall = [ordered]@{ exit = $again.Exit; manifestUnchanged = ($hashBefore -ne '' -and $hashBefore -eq $hashAfter); saysAlreadyComplete = ($again.Output -match 'already complete') }
$evidence.afterInstall = Get-Remnants
if (-not $KeepInstalled) {
  $un = Invoke-Host @{ Mode = 'uninstall' }
  $evidence.uninstall = [ordered]@{ exit = $un.Exit; output = $un.Output }
  $evidence.remnants = Get-Remnants
  $final = Invoke-Host @{ Mode = 'status' }
  $evidence.finalStatus = [ordered]@{ exit = $final.Exit; saysNotInstalled = ($final.Output -match 'not installed') }
}
$evidence.pass = ($install.Exit -eq 0) -and ($status.Exit -eq 0) -and ($again.Exit -eq 0) -and $evidence.reinstall.manifestUnchanged -and $evidence.reinstall.saysAlreadyComplete -and
  ($KeepInstalled -or (($evidence.uninstall.exit -eq 0) -and -not $evidence.remnants.user -and -not $evidence.remnants.key -and -not $evidence.remnants.programData -and -not $evidence.remnants.programFiles -and @($evidence.remnants.services).Count -eq 0 -and $evidence.finalStatus.saysNotInstalled))
$evidence | ConvertTo-Json -Depth 5
if (-not $evidence.pass) { exit 1 }
