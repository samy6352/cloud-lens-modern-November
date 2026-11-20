#requires -Version 7.0
<#
.SYNOPSIS
    Run the guided Azure deployment preview from a CloudLens checkout.
#>
[CmdletBinding()]
param([string]$SubscriptionId, [switch]$NoToolInstall)

$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw "CloudLens preview requires PowerShell 7 in FullLanguage mode. This session is $($ExecutionContext.SessionState.LanguageMode). Use an organisation-approved environment, such as approved Azure Cloud Shell (PowerShell), or ask your administrator for an approved installation path."
}
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $root 'web/v2/index.html') -PathType Leaf)) {
    throw 'The preview needs a complete CloudLens checkout with built UI assets. Update the checkout or build the UI with npm ci and npm run build from its ui directory, then retry.'
}
$version = 'guided-preview'
$zip = Join-Path ([IO.Path]::GetTempPath()) "CloudLens-guided-$([guid]::NewGuid()).zip"
try {
    $package = & (Join-Path $PSScriptRoot 'package.ps1') -Destination $zip -InstallerSource -SkipUiBuild -Version $version
    if (-not $? -or -not $package.Sha256) { throw 'Could not build a verified CloudLens preview package.' }
    & (Join-Path $PSScriptRoot 'install-customer.ps1') -Version $version -SourceZip $zip `
        -SourceSha256 $package.Sha256 -SubscriptionId $SubscriptionId -Preview -NoToolInstall:$NoToolInstall
    if (-not $?) { throw "CloudLens preview failed (exit $LASTEXITCODE)." }
} finally {
    if (Test-Path -LiteralPath $zip) {
        Remove-Item -LiteralPath $zip -ErrorAction Continue
    }
}
