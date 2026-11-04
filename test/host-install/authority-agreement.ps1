# Test driver (Windows PowerShell 5.1, ASCII only, no admin): the installer's side of the agreement test with the phase 2 Authority (test/host-install-authority.test.mjs).
#   authority-agreement.ps1 -CasesFile <json>
# Three jobs, one JSON object out:
#   writer   Authority configs as the installer WRITES them (Get-AuthorityConfig + ConvertTo-HostJson) for lists of record files, and what the installer's own check says about each text
#   configs  what Test-AuthorityConfigText (the installer's mirror of the Authority's config rules) says about config texts Node built, to compare with the Authority's own verdict (service-check)
#   stores   what Read-ApproverKeyStoreBytes (the installer's store reader) says about store files the Authority wrote, and the list set-approver would write after adding records to the keys in the store
# Everything the Authority decides is decided by the Authority (Node runs it); this script only reports what the installer says.
param([Parameter(Mandatory = $true)][string]$CasesFile)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\host\albera-host-lib.ps1')
$cases = [System.IO.File]::ReadAllText($CasesFile) | ConvertFrom-Json
$K = Get-HostConstants
$cpSid = Get-DerivedServiceSid $K.ControlPlaneService
function Read-Record([string]$B64) {
  $parsed = Read-ApproverKeyRecordBytes ([Convert]::FromBase64String($B64))
  if (-not $parsed.Ok) { throw ('record rejected: ' + ($parsed.Reasons -join ',')) }
  $parsed.Record
}
$r = [ordered]@{ writer = [ordered]@{}; configs = [ordered]@{}; stores = [ordered]@{} }

foreach ($case in $cases.writer) {
  $records = @($case.records | ForEach-Object { Read-Record $_ })
  if ($case.legacy) { $approver = [pscustomobject]@{ approverSid = $case.approverSid; approverKeyId = $case.legacy.keyId; approverPublicKey = $case.legacy.publicKey } }
  else { $approver = [pscustomobject]@{ approverSid = $case.approverSid; approverKeys = $records } }
  $text = ConvertTo-HostJson (Get-AuthorityConfig $cpSid $approver)
  $r.writer[$case.name] = [ordered]@{ text = $text; reasons = (Test-AuthorityConfigText $text); bytes = [System.Text.Encoding]::UTF8.GetByteCount($text) }
}

foreach ($case in $cases.configs) {
  $r.configs[$case.name] = [ordered]@{ reasons = (Test-AuthorityConfigText $case.text) }
}

foreach ($case in $cases.stores) {
  $store = Read-ApproverKeyStoreBytes ([Convert]::FromBase64String($case.b64))
  $entry = [ordered]@{ ok = $store.Ok; reasons = @($store.Reasons); keyIds = @($store.Records | ForEach-Object { $_.keyId }) }
  if ($store.Ok -and $case.given) {
    $given = @($case.given | ForEach-Object { Read-Record $_ })
    $add = Get-SetApproverFinalKeys $store.Records $given $false
    $entry.addOk = $add.Ok
    $entry.addReasons = @($add.Reasons)
    $entry.addIds = @($add.Records | ForEach-Object { $_.keyId })
  }
  $r.stores[$case.name] = $entry
}
ConvertTo-Json -InputObject $r -Depth 8 -Compress
