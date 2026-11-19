#requires -Version 7.0
<#
.SYNOPSIS
    Run the guided Azure deployment preview from a CloudLens checkout.
#>
[CmdletBinding()]
param([switch]$NoToolInstall)

$ErrorActionPreference = 'Stop'
$version = 'guided-preview'
$zip = Join-Path ([IO.Path]::GetTempPath()) "CloudLens-guided-$([guid]::NewGuid()).zip"
try {
    $package = & (Join-Path $PSScriptRoot 'package.ps1') -Destination $zip -InstallerSource -SkipUiBuild -Version $version
    if (-not $? -or -not $package.Sha256) { throw 'Could not build a verified CloudLens preview package.' }
    & (Join-Path $PSScriptRoot 'install-customer.ps1') -Version $version -SourceZip $zip `
        -SourceSha256 $package.Sha256 -Preview -NoToolInstall:$NoToolInstall
    if (-not $?) { throw "CloudLens preview failed (exit $LASTEXITCODE)." }
} finally {
    if (Test-Path -LiteralPath $zip) {
        Remove-Item -LiteralPath $zip -ErrorAction Continue
    }
}
