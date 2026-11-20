#requires -Version 7.0
<#
.SYNOPSIS
    Preview or apply CloudLens from the locally supplied customer bundle.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$SourceSha256,
    [string]$SubscriptionId,
    [string]$ResourceGroup,
    [string]$Location,
    [string]$AiLocation,
    [string]$Scope,
    [string]$EntraClientId,
    [string]$VnetAddressPrefix,
    [string]$AppSubnetAddressPrefix,
    [string]$PostgresSubnetAddressPrefix,
    [string]$PrivateEndpointSubnetAddressPrefix,
    [switch]$Apply,
    [switch]$NoToolInstall
)

$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw 'Use an organisation-approved PowerShell 7 FullLanguage session.'
}
$assets = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'CloudLens-*-source.zip' -File)
if ($assets.Count -ne 1 -or $assets[0].Name -notmatch '^CloudLens-([A-Za-z0-9][A-Za-z0-9._-]{0,127})-source\.zip$') {
    throw 'Keep exactly one CloudLens versioned source ZIP next to this launcher.'
}
$options = @{}
foreach ($key in $PSBoundParameters.Keys) {
    if ($key -ne 'Apply') { $options[$key] = $PSBoundParameters[$key] }
}
$options.Version = $Matches[1]
$options.SourceZip = $assets[0].FullName
$options.Preview = -not $Apply
& (Join-Path $PSScriptRoot 'install-customer.ps1') @options
if (-not $?) { throw "CloudLens setup stopped (exit $LASTEXITCODE)." }
