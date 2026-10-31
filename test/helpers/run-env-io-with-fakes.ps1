# Runs env-io.ps1 (the real file, unchanged) with the SYNTHETIC cmdlets of fake-hyperv-cmdlets.ps1 in front of the Hyper-V ones. stdin and stdout are env-io.ps1's own.
# Only used by test/runtime-task-checkpoint-lifecycle.test.mjs; nothing here touches a VM. ASCII only.
param([Parameter(Mandatory = $true)][string]$Fakes, [Parameter(Mandatory = $true)][string]$Script)
$ErrorActionPreference = 'Stop'
. $Fakes
& $Script
exit $LASTEXITCODE
