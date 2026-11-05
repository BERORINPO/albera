# Builds albera-demo.exe: the control room demo (fake VMs, a scripted AI) with node.exe inside, as one file that needs no install.
# Windows only: it uses the C# compiler that ships with Windows, so nothing is added to the repository's dependencies.
#   powershell -File scripts/demo-exe/build.ps1 -NodeDir <folder of the official Node.js zip> -OutDir <empty or new folder>
param(
  [Parameter(Mandatory = $true)][string]$NodeDir,
  [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
foreach ($need in @((Join-Path $NodeDir 'node.exe'), (Join-Path $NodeDir 'LICENSE'), $csc)) {
  if (-not (Test-Path -LiteralPath $need -PathType Leaf)) { throw "missing: $need" }
}

$pack = Join-Path $OutDir 'pack'
New-Item -ItemType Directory -Force -Path $pack | Out-Null
$app = Join-Path $OutDir 'app.zip'
& git -C $repo archive --format=zip -o $app HEAD src package.json LICENSE
if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
& (Join-Path $env:WINDIR 'System32\tar.exe') -xf $app -C $pack
if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
Copy-Item -LiteralPath (Join-Path $NodeDir 'node.exe') -Destination $pack
Copy-Item -LiteralPath (Join-Path $NodeDir 'LICENSE') -Destination (Join-Path $pack 'node-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launch.mjs') -Destination $pack

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = Join-Path $OutDir 'demo.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($pack, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)

$exe = Join-Path $OutDir 'albera-demo.exe'
& $csc /nologo /target:exe /platform:x64 "/out:$exe" "/resource:$zip,demo.zip" /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll (Join-Path $PSScriptRoot 'Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'csc failed' }
Write-Output "built $exe"
