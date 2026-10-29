# Task setup and ground-truth verification through PowerShell Direct (host -> guest, no network).
# Usage: pwsh -File tasks.ps1 -Vm albera-poc-01 -Task t1 -Mode setup|verify
param(
  [Parameter(Mandatory)] [string] $Vm,
  [Parameter(Mandatory)] [ValidateSet('t1', 't2', 't3')] [string] $Task,
  [Parameter(Mandatory)] [ValidateSet('setup', 'verify')] [string] $Mode
)
$ErrorActionPreference = 'Stop'
$pwFile = Join-Path $PSScriptRoot 'local-secrets\admin-password.txt'
$pw = ConvertTo-SecureString (Get-Content $pwFile -Raw).Trim() -AsPlainText -Force
$cred = New-Object pscredential('Administrator', $pw)

$result = Invoke-Command -VMName $Vm -Credential $cred -ArgumentList $Task, $Mode -ScriptBlock {
  param($Task, $Mode)
  $desk = 'C:\Users\Administrator\Desktop'
  if ($Mode -eq 'setup') {
    Get-Process notepad, ServerManager -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-ChildItem $desk -Force | Where-Object { $_.Name -like 't1*' -or $_.Name -like 'albera-t2*' -or $_.Name -like 'rename-me*' -or $_.Name -like 'done*' -or $_.Name -like 'New folder*' -or $_.Name -like 'New Text Document*' } |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    if ($Task -eq 't3') { Set-Content "$desk\rename-me.txt" 'rename me' }
    return @{ ok = $true; detail = 'ready' }
  }
  switch ($Task) {
    't1' {
      $p = "$desk\t1.txt"
      if (-not (Test-Path $p)) { return @{ ok = $false; detail = 't1.txt not found' } }
      $c = (Get-Content $p -Raw).Trim()
      return @{ ok = ($c -eq 'ALBERA hands test 1'); detail = "content='$c'" }
    }
    't2' {
      $ok = Test-Path "$desk\albera-t2" -PathType Container
      return @{ ok = $ok; detail = "folder exists=$ok" }
    }
    't3' {
      $done = Test-Path "$desk\done.txt"; $old = Test-Path "$desk\rename-me.txt"
      return @{ ok = ($done -and -not $old); detail = "done.txt=$done rename-me.txt=$old" }
    }
  }
}
[pscustomobject]@{ ok = [bool]$result.ok; detail = [string]$result.detail } | ConvertTo-Json -Compress
