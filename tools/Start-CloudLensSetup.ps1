#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidatePattern('^[0-9][A-Za-z0-9._-]{0,126}$')]
    [string]$Version,
    [switch]$Preview,
    [switch]$NoToolInstall
)

$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw 'Use an organisation-approved PowerShell 7 FullLanguage session.'
}

$repo = 'samy6352/cloud-lens-modern-November'
$ref = if ($Version) { "tags/v$Version" } else { 'latest' }
Write-Host "Checking GitHub for $(if ($Version) { "CloudLens v$Version" } else { 'the latest stable CloudLens release' })..."
$response = Invoke-WebRequest "https://api.github.com/repos/$repo/releases/$ref" -TimeoutSec 30 -SkipHttpErrorCheck
if ($response.StatusCode -eq 404) {
    if ($Version) { throw "CloudLens v$Version is not published. See https://github.com/$repo/releases." }
    throw "No stable CloudLens release is published. To run an approved prerelease, pass -Version <version> from https://github.com/$repo/releases."
}
if ($response.StatusCode -ne 200) { throw "GitHub release lookup failed (HTTP $($response.StatusCode))." }
$release = $response.Content | ConvertFrom-Json
if ($release.draft -or (-not $Version -and $release.prerelease) -or
    $release.tag_name -cnotmatch '^v([0-9][A-Za-z0-9._-]{0,126})$' -or
    ($Version -and $release.tag_name -cne "v$Version")) {
    throw 'GitHub returned an unexpected release.'
}
$resolvedVersion = $Matches[1]
$name = "CloudLens-Customer-$resolvedVersion.zip"
$url = "https://github.com/$repo/releases/download/v$resolvedVersion/$name"
$assets = @($release.assets | Where-Object name -CEQ $name)
if ($assets.Count -ne 1 -or $assets[0].state -ne 'uploaded' -or
    $assets[0].browser_download_url -cne $url -or $assets[0].digest -notmatch '^sha256:[a-f0-9]{64}$') {
    throw "Release v$resolvedVersion does not have a verifiable $name."
}

$folder = Join-Path ([IO.Path]::GetTempPath()) "CloudLens-$(New-Guid)"
$zip = "$folder.zip"
try {
    Write-Host "Downloading and verifying CloudLens v$resolvedVersion..."
    Invoke-WebRequest $url -OutFile $zip -TimeoutSec 180
    if ("sha256:$((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash)" -ine $assets[0].digest) {
        throw 'Bundle checksum mismatch. Setup was not started.'
    }
    Expand-Archive -LiteralPath $zip -DestinationPath $folder
    $source = Join-Path $folder "CloudLens-$resolvedVersion-source.zip"
    $launcher = Join-Path $folder 'Install-CloudLens.ps1'
    if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw 'The verified customer bundle is incomplete.'
    }
    # The outer digest covers both the launcher and the inner archive.
    $hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    & $launcher -SourceSha256 $hash -Apply:(-not $Preview) -NoToolInstall:$NoToolInstall
    if (-not $?) { throw "CloudLens setup stopped (exit $LASTEXITCODE)." }
} finally {
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -ErrorAction Continue }
    if (Test-Path -LiteralPath $folder) { Remove-Item -LiteralPath $folder -Recurse -ErrorAction Continue }
}
