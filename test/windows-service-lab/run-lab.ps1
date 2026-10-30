# Issue #23 service-identity lab, HOST driver. Needs the Hyper-V PowerShell Direct permission the lab approval names; changes nothing on the host
# except reading repo build output and writing the evidence folder. ASCII only.
#   1. npm run build:windows-broker ; npm run build:windows-service-lab     (host builds; the guest is offline)
#   2. node scripts/windows-service-lab-inputs.mjs <inputs.json>
#   3. pwsh/powershell -File test/windows-service-lab/run-lab.ps1 -InputsFile <inputs.json> -EvidenceDir <empty folder>
# The guest password is read into a SecureString in memory only; it is never printed, logged or put on a command line.
# STATUS: executed 2026-10-30 (run 3 of 3: 13 PASS, 1 BLOCKED) with the Broker hosted in-process by the shim. This revision runs the REAL Broker
# service host (`albera-windows-broker.exe service <config>`, checks g_*): not executed yet. Set the guest clock to host time first (golden image starts 16 h ahead).
# The Broker publish folder is copied whole (exe + dll + runtime); nothing else changes in this driver.
param(
  [string]$VmName = 'albera-clone-04-lab23',
  [string]$PasswordFile = 'U:\dev\hyperv\albera-poc-01\local-secrets\admin-password.txt',
  [Parameter(Mandatory = $true)][string]$InputsFile,
  [Parameter(Mandatory = $true)][string]$EvidenceDir,
  [string]$LabRoot = 'C:\albera-lab23'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$publish = @{
  shim   = Join-Path $repo 'test\windows-service-lab\bin\Release\net10.0-windows\win-x64\publish'
  broker = Join-Path $repo 'src\runtime\windows-broker\bin\Release\net10.0-windows\win-x64\publish'
  helper = Join-Path $repo 'src\runtime\windows-broker-pipe-client\bin\Release\net10.0-windows\win-x64\publish'
}
foreach ($p in $publish.Values) { if (-not (Test-Path $p)) { throw "missing build output: $p" } }
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null

$secure = (Get-Content -Raw $PasswordFile).Trim() | ConvertTo-SecureString -AsPlainText -Force
$session = New-PSSession -VMName $VmName -Credential (New-Object System.Management.Automation.PSCredential('Administrator', $secure))
try {
  Invoke-Command -Session $session -ScriptBlock { param($root) New-Item -ItemType Directory -Force -Path "$root\bin\shim", "$root\bin\broker", "$root\bin\helper", "$root\inputs" | Out-Null } -ArgumentList $LabRoot
  foreach ($name in $publish.Keys) { Copy-Item -ToSession $session -Path (Join-Path $publish[$name] '*') -Destination "$LabRoot\bin\$name" -Recurse -Force }
  Copy-Item -ToSession $session -Path $InputsFile -Destination "$LabRoot\inputs\lab-inputs.json" -Force
  try {
    Invoke-Command -Session $session -FilePath (Join-Path $PSScriptRoot 'lab-guest.ps1') -ArgumentList $LabRoot, 'run' | Tee-Object -FilePath (Join-Path $EvidenceDir 'guest-run.txt')
  }
  finally {
    # Evidence first, then rollback, even when the run failed half-way.
    Copy-Item -FromSession $session -Path "$LabRoot\evidence" -Destination (Join-Path $EvidenceDir 'evidence') -Recurse -Force -ErrorAction Continue
    Copy-Item -FromSession $session -Path "$LabRoot\results" -Destination (Join-Path $EvidenceDir 'results') -Recurse -Force -ErrorAction Continue
    Invoke-Command -Session $session -FilePath (Join-Path $PSScriptRoot 'lab-guest.ps1') -ArgumentList $LabRoot, 'rollback' | Tee-Object -FilePath (Join-Path $EvidenceDir 'guest-rollback.json')
  }
}
finally { Remove-PSSession $session }
