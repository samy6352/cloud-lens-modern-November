<#
.SYNOPSIS
    Add subscriptions to an existing CloudLens deployment for cost analysis.
.DESCRIPTION
    Grants the running app's managed identity Reader, Cost Management Reader and (unless
    -ReadOnlyCostAccess) Cost Management Contributor on each named subscription, then verifies
    the assignments. Nothing is redeployed and no app setting changes. The app notices the new
    subscriptions on its next hourly pass; press "Check now" on the Setup page to skip the wait.

    Run it as someone who can assign roles on the target subscriptions (Owner, User Access
    Administrator or Role Based Access Control Administrator). Without that, use -InstructionsOnly
    to write the exact commands for an administrator to run, then rerun this script to verify.
    Subscriptions must be in the same tenant as the app.
.EXAMPLE
    .\infra\add-subscriptions.ps1 -ResourceGroup rg-cloudlens -SubscriptionId '<sub-a>','<sub-b>'
.EXAMPLE
    .\infra\add-subscriptions.ps1 -ResourceGroup rg-cloudlens -SubscriptionId '<sub-a>' -InstructionsOnly
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$ResourceGroup,
    [Parameter(Mandatory)][string[]]$SubscriptionId,
    [string]$AppName = '',
    [string]$HostingSubscriptionId = '',
    [switch]$ReadOnlyCostAccess,
    [switch]$InstructionsOnly,
    [string]$ReportPath = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'cost-access.ps1')

if (-not $AppName) {
    $listArgs = @('webapp', 'list', '--resource-group', $ResourceGroup, '--query', '[].name', '-o', 'tsv', '--only-show-errors')
    if ($HostingSubscriptionId) { $listArgs += @('--subscription', $HostingSubscriptionId) }
    $apps = @(az @listArgs)
    if ($LASTEXITCODE -ne 0) { throw "Listing web apps in '$ResourceGroup' failed." }
    if ($apps.Count -ne 1) {
        throw "Found $($apps.Count) web apps in '$ResourceGroup' ($($apps -join ', ')). Pass -AppName to choose one; refusing to guess."
    }
    $AppName = [string]$apps[0]
}

$readOnly = $InstructionsOnly -or -not $PSCmdlet.ShouldProcess(
    "$ResourceGroup/$AppName runtime managed identity", "Grant cost roles on $(@($SubscriptionId).Count) subscription(s)"
)
Invoke-CloudLensCostAccess -HostingSubscriptionId $HostingSubscriptionId -ResourceGroup $ResourceGroup `
    -AppName $AppName -CostScopeSubscriptions @($SubscriptionId) `
    -EnableExportManagement:(-not $ReadOnlyCostAccess) -InstructionsOnly:$readOnly -ReportPath $ReportPath
