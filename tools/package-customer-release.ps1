#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][ValidatePattern('^[0-9][A-Za-z0-9._-]{0,126}$')][string]$Version
)

$ErrorActionPreference = 'Stop'
$out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Destination)
if (Test-Path -LiteralPath $out) { throw "Release output already exists: $out" }
$null = New-Item -ItemType Directory -Path $out
$stage = Join-Path $out 'bundle'
$null = New-Item -ItemType Directory -Path $stage
$source = Join-Path $stage "CloudLens-$Version-source.zip"
$runtime = Join-Path $out "CloudLens-$Version-runtime.zip"
$bundle = Join-Path $out "CloudLens-Customer-$Version.zip"
$root = Split-Path -Parent $PSScriptRoot

$sourceInfo = & (Join-Path $PSScriptRoot 'package.ps1') -InstallerSource -SkipUiBuild -Version $Version -Destination $source
if (-not $? -or -not $sourceInfo.Sha256) { throw 'Customer source packaging failed.' }
$runtimeInfo = & (Join-Path $PSScriptRoot 'package.ps1') -SkipUiBuild -Version $Version -Destination $runtime
if (-not $? -or -not $runtimeInfo.Sha256) { throw 'Runtime packaging failed.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-customer-install.ps1') -Destination (Join-Path $stage 'Install-CloudLens.ps1')
Copy-Item -LiteralPath @(
    (Join-Path $PSScriptRoot 'install-customer.ps1'),
    (Join-Path $PSScriptRoot 'New-CloudLensEntraApp.ps1'),
    (Join-Path $root 'infra\CUSTOMER-DEPLOYMENT.md')
) -Destination $stage
Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $stage -File).FullName -DestinationPath $bundle
Move-Item -LiteralPath $source -Destination $out
Remove-Item -LiteralPath $stage -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Start-CloudLensSetup.ps1') -Destination $out
Get-ChildItem -LiteralPath $out -File | Sort-Object Name | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
} | Set-Content -LiteralPath (Join-Path $out 'SHA256SUMS.txt') -Encoding ascii
Write-Host "Built CloudLens $Version release assets in $out"
