#Requires -Version 7.0
# Deploys the ALBERA feedback intake Worker and puts its secrets (docs/architecture/feedback-intake.md, "Deploy").
# Run by the owner in their own console, after creating the GitHub App and installing it on BERORINPO/albera-feedback only:
#   pwsh scripts/feedback-intake-deploy.ps1 -PemPath <downloaded .pem> -AppId <App ID> -InstallationId <installation id> [-DryRun]
# First use downloads Wrangler 4.151.3 into the npm cache (about 150 MB with its local runtime). Nothing is added to the repository.
# Wrangler signs in with its own browser login (a Cloudflare OAuth grant made by the owner); this script never reads or prints a token.
# Secrets never reach the screen, argv, a file or a log: node reads the .pem, converts it to PKCS#8 in memory and pipes JSON into `wrangler secret bulk`,
# and WRANGLER_LOG_SANITIZE is pinned on so Wrangler's own debug log leaves request bodies out.
param(
    [Parameter(Mandatory = $true)] [string] $PemPath,
    [Parameter(Mandatory = $true)] [ValidatePattern('^\d{1,12}$')] [string] $AppId,
    [Parameter(Mandatory = $true)] [ValidatePattern('^\d{1,15}$')] [string] $InstallationId,
    [switch] $DryRun
)
$ErrorActionPreference = 'Stop'
$env:WRANGLER_LOG_SANITIZE = 'true'
$Wrangler = 'wrangler@4.151.3'
$Repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$Project = Join-Path $Repo 'services/feedback-intake'
$SecretsTool = Join-Path $Repo 'scripts/feedback-intake-secrets.mjs'

if (-not (Test-Path -LiteralPath $PemPath -PathType Leaf)) { throw "PemPath not found: $PemPath" }
foreach ($tool in 'node', 'npx') { if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH" } }

Write-Host "Plan:"
Write-Host "  1. npx $Wrangler whoami (login in the browser if needed)"
Write-Host "  2. npx $Wrangler deploy   in $Project"
Write-Host "  3. secrets APP_ID, APP_INSTALLATION_ID, APP_PRIVATE_KEY (from the .pem, PKCS#8), IP_HASH_KEY (new random) piped into 'wrangler secret bulk'"
Write-Host "  4. check: preflight answers 204, an empty POST answers 400 (the intake is open)"
if ($DryRun) { Write-Host "Dry run: nothing was run."; return }

Push-Location $Project
try {
    $who = (& npx --yes $Wrangler whoami 2>&1 | Out-String)
    if ($who -match 'not authenticated') {
        & npx --yes $Wrangler login
        if ($LASTEXITCODE -ne 0) { throw 'wrangler login failed' }
    }

    $deploy = (& npx --yes $Wrangler deploy 2>&1 | Tee-Object -Variable lines | Out-String)
    $lines | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw 'wrangler deploy failed' }
    $match = [regex]::Match($deploy, 'https://albera-feedback\.[a-z0-9-]+\.workers\.dev')
    if (-not $match.Success) { throw 'deploy finished but no workers.dev address was printed; check the dashboard' }
    $base = $match.Value

    # node prints the JSON on standard output only and `secret bulk` with no file reads standard input: the key never lands in a file
    & node $SecretsTool $PemPath $AppId $InstallationId - | & npx --yes $Wrangler secret bulk
    if ($LASTEXITCODE -ne 0) { throw 'wrangler secret bulk failed' }
}
finally {
    Pop-Location
}

$endpoint = "$base/v1/feedback"
$origin = 'http://127.0.0.1:1'
$pre = Invoke-WebRequest -Uri $endpoint -Method Options -Headers @{ Origin = $origin; 'Access-Control-Request-Method' = 'POST' } -SkipHttpErrorCheck
$post = Invoke-WebRequest -Uri $endpoint -Method Post -Headers @{ Origin = $origin } -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck
Write-Host ""
Write-Host "Preflight: $($pre.StatusCode) (want 204)   Empty POST: $($post.StatusCode) $($post.Content) (want 400 invalid_request; 503 intake_closed means a secret is missing)"
Write-Host "Intake address: $endpoint"
Write-Host "Next: tell Velo this address. Then delete the downloaded .pem file: Cloudflare holds the key now."
