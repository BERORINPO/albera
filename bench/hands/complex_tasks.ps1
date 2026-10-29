# Complex task setup and ground-truth verification through PowerShell Direct.
# Usage: pwsh -File complex_tasks.ps1 -Vm albera-poc-01 -Task c1 -Mode setup|verify
param(
  [Parameter(Mandatory)] [string] $Vm,
  [Parameter(Mandatory)] [ValidateSet('c1', 'c2', 'c3', 'c4')] [string] $Task,
  [Parameter(Mandatory)] [ValidateSet('setup', 'verify')] [string] $Mode
)
$ErrorActionPreference = 'Stop'
$pwFile = Join-Path $PSScriptRoot 'local-secrets\admin-password.txt'
$pw = ConvertTo-SecureString (Get-Content $pwFile -Raw).Trim() -AsPlainText -Force
$cred = New-Object pscredential('Administrator', $pw)

$result = Invoke-Command -VMName $Vm -Credential $cred -ArgumentList $Task, $Mode -ScriptBlock {
  param($Task, $Mode)
  $desk = 'C:\Users\Administrator\Desktop'
  $names = 'proj*', 'readme*', 'form*', 'code*', 'inventory*', 'answer*', 'New folder*', 'New Text Document*', 't1*', 'albera-t2*', 'done*', 'rename-me*'
  function Expected-Code { $sum = 0; foreach ($ch in 'Velo'.ToCharArray()) { $sum += [int]$ch }; 'ALB-{0:D4}' -f (($sum * 7) % 9973) }
  function Inventory { 1..200 | ForEach-Object { [pscustomobject]@{ Name = 'item-{0:D3}' -f $_; Qty = (($_ * 37) % 211) + 1 } } }

  if ($Mode -eq 'setup') {
    Get-Process notepad, msedge, ServerManager, SystemSettings -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-ChildItem $desk -Force | Where-Object { $n = $_.Name; ($names | Where-Object { $n -like $_ }).Count -gt 0 } |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    $edge = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
    New-Item $edge -Force | Out-Null
    foreach ($kv in @{ HideFirstRunExperience = 1; DefaultBrowserSettingEnabled = 0; StartupBoostEnabled = 0; ShowRecommendationsEnabled = 0 }.GetEnumerator()) {
      Set-ItemProperty $edge -Name $kv.Key -Value $kv.Value -Type DWord
    }
    switch ($Task) {
      'c1' { Set-Content "$desk\readme-draft.txt" 'draft content 42' }
      'c2' {
        @'
<!doctype html><html><head><meta charset="utf-8"><title>ALBERA form</title></head>
<body style="font-family:Segoe UI;font-size:18px;margin:40px">
<h2>Registration</h2>
<p>Name <input id="n" style="font-size:18px"></p>
<p>Plan <select id="p" style="font-size:18px"><option value="3">Plan A</option><option value="7">Plan B</option><option value="11">Plan C</option></select></p>
<p><button onclick="go()" style="font-size:18px">Submit</button></p>
<p id="out" style="font-size:24px"></p>
<script>
function go(){var s=0,n=document.getElementById('n').value;for(var i=0;i<n.length;i++)s+=n.charCodeAt(i);
var v=parseInt(document.getElementById('p').value,10);var c=(s*v)%9973;
document.getElementById('out').textContent='Confirmation code: ALB-'+('0000'+c).slice(-4);}
</script></body></html>
'@ | Set-Content "$desk\form.html" -Encoding utf8
      }
      'c3' { Inventory | ForEach-Object { "$($_.Name),$($_.Qty)" } | Set-Content "$desk\inventory.txt" }
      'c4' { Set-TimeZone -Id 'Tokyo Standard Time' }
    }
    return @{ ok = $true; detail = 'ready' }
  }

  switch ($Task) {
    'c1' {
      $src = Test-Path "$desk\proj\src" -PathType Container
      $docs = Test-Path "$desk\proj\docs" -PathType Container
      $readme = "$desk\proj\docs\readme.txt"
      $content = if (Test-Path $readme) { (Get-Content $readme -Raw).Trim() } else { '' }
      $old = Test-Path "$desk\readme-draft.txt"
      return @{ ok = ($src -and $docs -and $content -eq 'draft content 42' -and -not $old); detail = "src=$src docs=$docs readme='$content' draft_left=$old" }
    }
    'c2' {
      $p = "$desk\code.txt"
      $got = if (Test-Path $p) { (Get-Content $p -Raw).Trim() } else { '' }
      $want = Expected-Code
      return @{ ok = ($got -eq $want); detail = "got='$got' want='$want'" }
    }
    'c3' {
      $inv = Inventory
      $q137 = ($inv | Where-Object Name -eq 'item-137').Qty
      $max = ($inv | Sort-Object Qty -Descending | Select-Object -First 1).Name
      $want = "item-137=$q137;max=$max"
      $p = "$desk\answer.txt"
      $got = if (Test-Path $p) { (Get-Content $p -Raw).Trim() } else { '' }
      return @{ ok = ($got -eq $want); detail = "got='$got' want='$want'" }
    }
    'c4' {
      $tz = (Get-TimeZone).Id
      return @{ ok = ($tz -eq 'Pacific Standard Time'); detail = "tz=$tz" }
    }
  }
}
[pscustomobject]@{ ok = [bool]$result.ok; detail = [string]$result.detail } | ConvertTo-Json -Compress
