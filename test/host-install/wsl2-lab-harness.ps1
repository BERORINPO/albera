# Test harness (Windows PowerShell 5.1, ASCII only, no admin): the two lab scripts of the WSL2 computer, DOT-SOURCED (their functions only: a dot-sourced script returns before its main block), with FAKES for every
# call that would touch the machine (the key store, the tasks, the local accounts, the folders, the pipe). Nothing outside -Work is touched: no key, no task, no account, no ACL. Prints one JSON line.
#   wsl2-lab-harness.ps1 -Case <measure-pure|measure-flow|sec2-pure|sec2-flow> -Work <empty temp folder>
param(
  [Parameter(Mandatory = $true)][ValidateSet('measure-pure', 'measure-flow', 'sec2-pure', 'sec2-flow')][string]$Case,
  [Parameter(Mandatory = $true)][string]$Work
)
$ErrorActionPreference = 'Stop'
trap { [Console]::Error.WriteLine($_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage); exit 1 }
$Work = [System.IO.Path]::GetFullPath($Work)
$hostDir = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'scripts\host'
$OWNER = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
$r = [ordered]@{}
$script:LabRoot = $Work
$script:Log = New-Object System.Collections.Generic.List[string]
function Try-Run([scriptblock]$Block) { try { & $Block | Out-Null; $null } catch { $_.Exception.Message } }

if ($Case -like 'measure-*') {
  . (Join-Path $hostDir 'measure-attestation-key.ps1')
  $ids = Get-MeasureIdentities
  $brokerSid = $ids[0].Sid
  $okFacts = {
    @{ nonAdminCreate = @{ ran = $true; ok = $false; hresult = '0x80070005' }; key = @{ allowSids = @('S-1-5-18', 'S-1-5-32-544', $brokerSid); fileAllowSids = @('S-1-5-18', 'S-1-5-32-544', $brokerSid) }
      export = @{ refused = $true; hresult = '0x80090010' }; adminSign = @{ ok = $true; hresult = $null }
      asIdentity = @{ broker = @{ ran = $true; ok = $true }; other = @{ ran = $true; ok = $false; hresult = '0x80090016' }; controlplane = @{ ran = $true; ok = $false; hresult = '0x80090016' } } }
  }
}

switch ($Case) {
  'measure-pure' {
    $r.keyName = New-MeasureKeyName ([byte[]](1..8))
    $r.shortRandomThrows = Try-Run { New-MeasureKeyName ([byte[]](1, 2)) }
    $r.identities = $ids
    $r.errorNames = [ordered]@{ badKeyset = Get-CngErrorName '0x80090016'; perm = Get-CngErrorName '0x80090010'; exists = Get-CngErrorName '0x8009000F'; denied = Get-CngErrorName '0x80070005'; unknown = Get-CngErrorName '0x12345678'; none = Get-CngErrorName $null }
    $xmlService = ConvertTo-MeasureTaskXml 'NT SERVICE\AlberaMeasureOther' 'service' 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' '-File "C:\x\probe.ps1" -Mode sign'
    $xmlUser = ConvertTo-MeasureTaskXml $OWNER 'interactive' 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' '-File "C:\x\probe.ps1" -Mode create'
    $describe = { param($text) $d = New-Object System.Xml.XmlDocument; $d.LoadXml($text); $tag = { param($n) $d.GetElementsByTagName($n).Item(0).InnerText }; [ordered]@{ valid = $true; userId = (& $tag 'UserId'); logonType = (& $tag 'LogonType'); runLevel = (& $tag 'RunLevel'); triggers = $d.GetElementsByTagName('Triggers').Item(0).ChildNodes.Count } }
    $r.taskService = & $describe $xmlService
    $r.taskInteractive = & $describe $xmlUser
    $awkward = '-File "C:\a&b\p<1>.ps1" -KeyName ''x'''
    $xmlAwkward = New-Object System.Xml.XmlDocument; $xmlAwkward.LoadXml((ConvertTo-MeasureTaskXml 'NT SERVICE\AlberaMeasureOther' 'service' 'C:\Windows\System32\cmd.exe' $awkward))
    $r.taskEscaped = [ordered]@{ argumentsRoundTrip = ($xmlAwkward.GetElementsByTagName('Arguments').Item(0).InnerText -ceq $awkward) }
    $r.verdicts = Get-MeasureVerdicts (& $okFacts)
    $unrun = & $okFacts
    $unrun.asIdentity.controlplane = @{ ran = $false; ok = $false; error = 'task_not_created' }
    $unrun.nonAdminCreate = @{ ran = $false; ok = $false }
    $r.verdictsUnrun = Get-MeasureVerdicts $unrun
    $wrong = & $okFacts
    $wrong.asIdentity.other = @{ ran = $true; ok = $true }
    $r.verdictsWrong = Get-MeasureVerdicts $wrong
    $good = [pscustomobject]@{ version = 1; measuredAt = '2026-11-07T00:00:00Z'; keyName = 'AlberaMeasure-0123456789ab'; machine = 'PC'; key = [ordered]@{ allowSids = @('S-1-5-18') }; facts = [ordered]@{}; verdicts = [ordered]@{ a = 'yes' }; cleanup = [ordered]@{ keyDeleted = $true }; notes = @('ok') }
    $r.reportGood = Test-MeasureReport $good
    $blob = $good.PSObject.Copy(); $blob.notes = @('A' * 200)
    $r.reportBlob = Test-MeasureReport $blob
    $private = $good.PSObject.Copy(); $private.notes = @('exported Pkcs8PrivateBlob')
    $r.reportPrivate = Test-MeasureReport $private
    $missing = $good.PSObject.Copy(); $missing.PSObject.Properties.Remove('cleanup')
    $r.reportMissing = Test-MeasureReport $missing
    $r.planLines = @(Get-MeasurePlanLines 'AlberaMeasure-<12 hex>' 'C:\x\report.json')
  }
  'measure-flow' {
    $script:Store = @{}
    $script:Scenario = @{ failAt = $null; nonAdminOk = $false; ran = @{ broker = $true; other = $true; controlplane = $true } }
    function Log([string]$s) { $script:Log.Add($s) }
    function New-SecuredDirectory([string]$Path, [string[]]$Grants, [string]$OwnerSid = 'S-1-5-32-544') { Log 'dir'; New-Item -ItemType Directory -Force -Path $Path | Out-Null; $script:LastDirGrants = $Grants }
    function Get-PathTrustReasons([string]$Path, [string[]]$AllowedWriters, [bool]$RequireProtected) { , @() }
    function Test-AuthoritySigningKeyExists([string]$KeyName, [string]$Scope = 'machine') { $script:Store.ContainsKey($KeyName) }
    function New-AuthoritySigningKey([string]$KeyName, [string]$ServiceSid, [string]$Scope = 'machine') {
      Log 'create-key'
      if ($script:Scenario.failAt -eq 'create-key') { throw 'cng said no' }
      $script:Store[$KeyName] = $ServiceSid; $script:CreatedFor = $ServiceSid
      [pscustomobject]@{ spki = 'x'; report = [pscustomobject]@{ algorithm = 'ECDSA_P256'; keySize = 256; exportPolicy = 0; owner = 'S-1-5-32-544'; allowSids = @('S-1-5-18', 'S-1-5-32-544', $ServiceSid) } }
    }
    function Remove-AuthoritySigningKey([string]$KeyName, [string]$Scope = 'machine') { if ($script:Store.ContainsKey($KeyName)) { Log 'delete-key'; $script:Store.Remove($KeyName); return $true }; $false }
    function Find-MachineKeyFile([string]$KeyName) { $p = Join-Path $script:LabRoot 'keyfile'; [System.IO.File]::WriteAllText($p, 'x'); $p }   # not $Work: Invoke-Measurement has a local $work
    function Read-FileAllowSids([string]$Path) { [pscustomobject]@{ Sddl = 'O:SYD:(A;;FA;;;SY)'; AllowSids = @('S-1-5-18', 'S-1-5-32-544', $brokerSid) } }
    function Measure-KeyExportAndSign([string]$KeyName) {
      Log 'export-sign'
      if ($script:Scenario.failAt -eq 'export-sign') { throw 'open failed' }
      @{ adminSign = @{ ok = $true; hresult = $null }; export = @{ refused = $true; hresult = '0x80090010' } }
    }
    function Invoke-TaskProbe($WorkInfo, [string]$TaskName, [string]$Principal, [string]$Logon, [string]$ResultSid, [string]$Mode, [string]$KeyName) {
      $id = $TaskName -replace '^AlberaMeasure-', ''
      if ($id -eq 'create') {
        Log 'create-name-nonadmin'
        if ($script:Scenario.nonAdminOk) { $script:Store[$KeyName] = 'made-by-user'; return @{ ran = $true; ok = $true; hresult = $null } }
        return @{ ran = $true; ok = $false; hresult = '0x80070005' }
      }
      Log "task:$id"
      if ($script:Scenario.failAt -eq "task:$id") { throw 'schtasks exploded' }
      if (-not $script:Scenario.ran[$id]) { return @{ ran = $false; ok = $false; error = 'task_not_created' } }
      @{ ran = $true; ok = ($id -eq 'broker'); hresult = $(if ($id -eq 'broker') { $null } else { '0x80090016' }) }
    }
    function Invoke-NativeShort([string]$Exe, [string]$Arguments, [int]$TimeoutMs = 60000) { [pscustomobject]@{ Exit = 0; Out = '' } }
    $run = {
      param($name, $scenario)
      $script:Log.Clear(); $script:Store = @{}; $script:Scenario = $scenario
      $folder = Join-Path $Work $name
      $path = Join-Path $folder 'report.json'
      $threw = $false; $report = $null; $message = $null
      try { $report = Invoke-Measurement $path } catch { $threw = $true; $message = $_.Exception.Message }
      $left = if (Test-Path -LiteralPath $folder) { @(Get-ChildItem -LiteralPath $folder -Directory | Where-Object { $_.Name -like 'run-*' }).Count } else { 0 }
      [ordered]@{
        order = @($script:Log); threw = $threw; message = $message; reportWritten = [System.IO.File]::Exists($path); keyDeleted = ($script:Store.Count -eq 0); workRemoved = ($left -eq 0)
        verdicts = $(if ($report) { $report.verdicts } else { $null }); reportText = $(if ([System.IO.File]::Exists($path)) { [System.IO.File]::ReadAllText($path) } else { '' })
        brokerSid = $brokerSid; createdKeyDacl = @($script:CreatedFor)
      }
    }
    $r.normal = & $run 'normal' @{ failAt = $null; nonAdminOk = $false; ran = @{ broker = $true; other = $true; controlplane = $true } }
    $made = & $run 'nonadmin' @{ failAt = $null; nonAdminOk = $true; ran = @{ broker = $true; other = $true; controlplane = $true } }
    $r.nonAdminMadeIt = [ordered]@{ deletedBeforeCreate = ($made.order.IndexOf('delete-key') -ge 0 -and $made.order.IndexOf('delete-key') -lt $made.order.IndexOf('create-key')); verdict = $made.verdicts.nonAdministratorCanTakeTheName }
    $r.failures = [ordered]@{}
    foreach ($stage in @('create-key', 'export-sign', 'task:other')) { $f = & $run ('fail-' + ($stage -replace '\W', '-')) @{ failAt = $stage; nonAdminOk = $false; ran = @{ broker = $true; other = $true; controlplane = $true } }; $r.failures[$stage -replace '^task:', 'task:'] = $f }
    # a task Windows will not run, and a task that ran as another account: the real Invoke-TaskProbe, with a fake schtasks
    Remove-Item function:Invoke-TaskProbe
    $realCore = $null
    . (Join-Path $hostDir 'measure-attestation-key.ps1')   # the real Invoke-TaskProbe and Invoke-TaskProbeCore again
    function Invoke-NativeShort([string]$Exe, [string]$Arguments, [int]$TimeoutMs = 60000) {
      $script:Log.Add($Arguments)
      if ($script:NativeMode -eq 'create-fails' -and $Arguments -like '/Create*') { return [pscustomobject]@{ Exit = 1; Out = 'ERROR: Access is denied.' } }
      if ($Arguments -like '/Run*' -and $script:NativeMode -eq 'other-account') {
        $name = [regex]::Match($Arguments, 'TN "([^"]+)"').Groups[1].Value
        [System.IO.File]::WriteAllText((Join-Path $script:TaskWork.Results ($name + '.json')), '{"mode":"sign","sid":"S-1-5-18","elevated":true,"ok":true,"hresult":null,"errorType":null}')
      }
      [pscustomobject]@{ Exit = 0; Out = '' }
    }
    $script:TaskWork = [pscustomobject]@{ Root = (Join-Path $Work 'task'); Probe = (Join-Path $Work 'task\probe.ps1'); Results = (Join-Path $Work 'task\results') }
    New-Item -ItemType Directory -Force -Path $script:TaskWork.Results | Out-Null
    $script:Log.Clear(); $script:NativeMode = 'create-fails'
    $cannot = Invoke-TaskProbe $script:TaskWork 'AlberaMeasure-controlplane' 'NT SERVICE\AlberaControlPlane' 'service' $ids[2].Sid 'sign' 'AlberaMeasure-0123456789ab'
    $script:NativeMode = 'other-account'
    $another = Invoke-TaskProbe $script:TaskWork 'AlberaMeasure-other' 'NT SERVICE\AlberaMeasureOther' 'service' $ids[1].Sid 'sign' 'AlberaMeasure-0123456789ab'
    $facts = & $okFacts
    $f1 = & $okFacts; $f1.asIdentity.controlplane = $cannot
    $f2 = & $okFacts; $f2.asIdentity.other = $another
    $r.taskThatCannotStart = [ordered]@{ ran = $cannot.ran; error = $cannot.error; verdict = (Get-MeasureVerdicts $f1).signs_controlplane; ranAsAnother = (Get-MeasureVerdicts $f2).signs_other; anotherError = $another.error }
  }
  'sec2-pure' {
    . (Join-Path $hostDir 'lab-sec2.ps1')
    $c = Get-Sec2Constants
    $r.accountName = New-Sec2AccountName ([byte[]](0xde, 0xad, 0xbe, 0xef, 1, 2))
    $r.description = $c.AccountDescription
    $r.owned = [ordered]@{
      ours = Test-Sec2AccountOwned 'albera-sec2-deadbeef' $c.AccountDescription
      wrongName = Test-Sec2AccountOwned 'albera-sec2-xyz' $c.AccountDescription
      wrongDescription = Test-Sec2AccountOwned 'albera-sec2-deadbeef' 'something else'
      uppercase = Test-Sec2AccountOwned 'ALBERA-SEC2-DEADBEEF' $c.AccountDescription
      tooLong = Test-Sec2AccountOwned 'albera-sec2-deadbeef00' $c.AccountDescription
      prefixOnly = Test-Sec2AccountOwned 'albera-sec2-' $c.AccountDescription
      otherUser = Test-Sec2AccountOwned 'bob' $c.AccountDescription
    }
    $r.cases = @(Get-Sec2Cases $c.LabPipeName $OWNER ('ab' * 32))
    $res = { param($ok, $code) @{ ran = $true; ok = $ok; code = $code } }
    $r.verdicts = [ordered]@{
      works = Get-Sec2Verdict @{ owner = (& $res $true $null); wrongOwner = (& $res $false 'server_identity_mismatch'); ownerAndImage = (& $res $true $null) }
      pinFails = Get-Sec2Verdict @{ owner = (& $res $true $null); wrongOwner = (& $res $false 'server_identity_mismatch'); ownerAndImage = (& $res $false 'server_identity_unavailable') }
      acceptsAny = Get-Sec2Verdict @{ owner = (& $res $true $null); wrongOwner = (& $res $true $null); ownerAndImage = (& $res $true $null) }
      ownerFails = Get-Sec2Verdict @{ owner = (& $res $false 'broker_unavailable'); wrongOwner = (& $res $false 'broker_unavailable'); ownerAndImage = (& $res $false 'broker_unavailable') }
      notRun = Get-Sec2Verdict @{ owner = @{ ran = $false; ok = $false; code = 'probe_timeout' }; wrongOwner = (& $res $false 'x'); ownerAndImage = (& $res $true $null) }
      noResults = Get-Sec2Verdict @{}
    }
    $text = Get-Sec2ProbeText
    $errs = $null; $toks = $null
    $probeAst = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$toks, [ref]$errs)
    $r.probe = [ordered]@{
      parses = ($errs.Count -eq 0)
      params = @($probeAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
      sendsOnlyTheStartFrame = ([regex]::Matches($text, '\.Write\(').Count -eq 2)
      usesHelperArgument = $(if ($text -match "\`$psi\.Arguments = '([^']+)'") { $Matches[1] } else { $null })
    }
  }
  'sec2-flow' {
    . (Join-Path $hostDir 'lab-sec2.ps1')
    $c = Get-Sec2Constants
    $realRemove = ${function:Remove-Sec2Account}
    $script:Accounts = @{}
    $script:Fail = $null
    $script:Pipe = $true
    $script:RemovedNames = New-Object System.Collections.Generic.List[string]
    $script:LabRemoved = $false
    function Log([string]$s) { $script:Log.Add($s) }
    function Write-Host { param([Parameter(ValueFromRemainingArguments = $true)]$Text) $script:Said.Add(($Text -join ' ')) }
    $script:Said = New-Object System.Collections.Generic.List[string]
    function Get-Sec2LocalAccounts { Log 'sweep'; @($script:Accounts.Keys | ForEach-Object { [pscustomobject]@{ Name = $_; Description = $script:Accounts[$_] } }) }
    function New-Sec2Account([string]$Name) {
      Log 'create-account'
      if ($script:Fail -eq 'create-account') { throw 'cannot create' }
      $script:Accounts[$Name] = $c.AccountDescription
      @{ Name = $Name; Sid = 'S-1-5-21-5-6-7-1010'; Password = (New-Object System.Security.SecureString) }
    }
    function Remove-Sec2Account([string]$Name) {
      Log 'remove-account'; $script:RemovedNames.Add($Name)
      if ($script:Fail -eq 'remove-fails') { throw 'access denied' }
      if (-not $script:Accounts.ContainsKey($Name)) { return $false }
      $script:Accounts.Remove($Name); $true
    }
    function New-Sec2LabFolder($Account, $L, $W) {
      Log 'lab-folder'
      if ($script:Fail -eq 'lab-folder') { throw 'cannot copy the helper' }
      @{ Dir = (Join-Path $Work 'lab'); Config = 'C:\lab\lab-bridge.json'; Probe = 'C:\lab\probe.ps1'; Helper = 'C:\lab\h.exe'; OwnerSid = $OWNER; BridgeExeSha256 = ('cd' * 32) }
    }
    function Wait-Sec2Pipe([string]$PipeName, [int]$Minutes) { Log 'wait-pipe'; $script:Pipe }
    function Invoke-Sec2ProbeAs($Account, [string]$ProbePath, [string]$HelperPath, $Case) {
      Log ('probe:' + $Case.Id)
      if ($script:Fail -eq 'probe-throws') { throw 'process could not start' }
      if ($script:Fail -eq 'probe-throws-late' -and $Case.Id -eq 'ownerAndImage') { throw 'process died' }
      @{ ran = $true; ok = ($Case.Id -ne 'wrongOwner'); code = $(if ($Case.Id -eq 'wrongOwner') { 'server_identity_mismatch' } else { $null }) }
    }
    function Remove-Sec2LabFolder([string]$Dir) { Log 'remove-lab'; $script:LabRemoved = $true }
    $layoutL = @{ PipeClientBinDir = 'x'; ApprovalSettings = 'x' }; $layoutW = @{ BridgeExe = 'C:\b.exe'; Config = 'C:\b.json' }
    $go = {
      param($fail, $pipe, $accounts)
      $script:Log.Clear(); $script:Said.Clear(); $script:RemovedNames.Clear(); $script:LabRemoved = $false
      $script:Fail = $fail; $script:Pipe = $pipe; $script:Accounts = $accounts
      $threw = $false; $verdict = $null
      try { $verdict = Invoke-Sec2Run $layoutL $layoutW ([byte[]](1..8)) 1 } catch { $threw = $true }
      [ordered]@{ order = @($script:Log); threw = $threw; verdict = $(if ($verdict) { $verdict.ownerCheck } else { $null }); accountsLeft = @($script:Accounts.Keys | Where-Object { $_ -like 'albera-sec2-0102*' }).Count; removeCalls = $script:RemovedNames.Count; removed = $script:RemovedNames.Count; labRemoved = $script:LabRemoved; said = @($script:Said) }
    }
    $r.normal = & $go $null $true @{}
    $r.failures = [ordered]@{}
    $r.failures['create-account'] = & $go 'create-account' $true @{}
    $r.failures['lab-folder'] = & $go 'lab-folder' $true @{}
    $r.failures['wait-pipe-timeout'] = & $go $null $false @{}
    $r.failures['probe-throws'] = & $go 'probe-throws' $true @{}
    $r.failures['probe-throws-late'] = & $go 'probe-throws-late' $true @{}
    $failing = & $go 'remove-fails' $true @{}
    $r.removalThatFails = [ordered]@{ warned = (@($failing.said | Where-Object { $_ -like 'WARNING: the account*-RemoveStale*' -or ($_ -like 'WARNING: the account*' -and $_ -like '*-RemoveStale*') }).Count -ge 1); verdict = $failing.verdict }
    $stale = & $go $null $true @{ 'albera-sec2-deadbeef' = $c.AccountDescription; 'albera-sec2-cafe0000' = 'somebody else' }
    $r.stale = [ordered]@{ removed = @($script:RemovedNames | Where-Object { $_ -eq 'albera-sec2-deadbeef' }).Count; foreignKept = $script:Accounts.ContainsKey('albera-sec2-cafe0000') }
    $script:Accounts = @{ 'albera-sec2-deadbeef' = 'somebody else' }
    function Get-Sec2LocalAccounts { @($script:Accounts.Keys | ForEach-Object { [pscustomobject]@{ Name = $_; Description = $script:Accounts[$_] } }) }
    $r.notOurs = [ordered]@{ threw = [bool](Try-Run { & $realRemove 'albera-sec2-deadbeef' }) }
  }
}
$r | ConvertTo-Json -Depth 8 -Compress
