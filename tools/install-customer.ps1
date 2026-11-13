#requires -Version 7.0
<#
.SYNOPSIS
    Download, verify and extract the customer release, then start guided installation.
#>
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
    [string]$Version = '2026.11.12-rc5',
    [string]$Destination = '',
    [string]$SubscriptionId = '',
    # What CloudLens should monitor. Empty or 'all' includes every enabled same-tenant
    # subscription visible to the installer account. You may also pass a specific
    # subscription ID, /subscriptions/<id>, or
    # /providers/Microsoft.Management/managementGroups/<id>.
    [string]$Scope = 'all',
    [string]$ResourceGroup = '',
    [string]$Location = '',
    [string]$AiLocation = '',
    [ValidateSet('small', 'medium', 'large')]
    [string]$Size = 'medium',
    [ValidateRange(1, 13)]
    [int]$InitialHistoryMonths = 1,
    [string]$NamePrefix = '',
    [string]$NameSuffix = '',
    # Approved offline download or unpublished release rehearsal; hash must be supplied separately.
    [string]$SourceZip = '',
    [string]$SourceSha256 = '',
    # Skip the final interactive approval prompt (required for non-interactive runs).
    [switch]$Approve,
    [switch]$Resume,
    [switch]$Preview
)
$ErrorActionPreference = 'Stop'
if ($SourceZip -and $SourceSha256 -notmatch '^[a-fA-F0-9]{64}$') {
    throw '-SourceZip requires the separately supplied -SourceSha256 (64 hexadecimal characters).'
}
if ($SourceSha256 -and -not $SourceZip) { throw '-SourceSha256 requires -SourceZip.' }
if (-not $Destination) {
    $Destination = Join-Path $HOME ("CloudLens\{0}-{1}" -f $Version, [guid]::NewGuid().ToString('N'))
}
if (Test-Path -LiteralPath $Destination) {
    throw "Destination already exists: $Destination. Choose a new folder; existing installations are not overwritten."
}
$Destination = [IO.Path]::GetFullPath($Destination)
$null = New-Item -ItemType Directory -Path $Destination
$asset = "CloudLens-$Version-source.zip"
$base = "https://github.com/samy6352/cloud-lens-modern-November/releases/download/v$Version"
$zip = Join-Path $Destination $asset
$checksums = Join-Path $Destination 'SHA256SUMS.txt'
$downloadedFromArchive = $false
if ($SourceZip) {
    Copy-Item -LiteralPath $SourceZip -Destination $zip -ErrorAction Stop
    $expected = $SourceSha256
    Write-Host "Verifying the supplied CloudLens source archive for $Version."
} else {
    Write-Host "Downloading CloudLens $Version from GitHub."
    Write-Host 'The release must be published and accessible. Private releases require repository access.'
    try {
        Invoke-WebRequest -Uri "$base/$asset" -OutFile $zip
        Invoke-WebRequest -Uri "$base/SHA256SUMS.txt" -OutFile $checksums
    } catch {
        Write-Warning "Release asset v$Version is unavailable ($($_.Exception.Message))."
        Write-Warning 'Falling back to the repository source archive from GitHub.'
        $fallbacks = @(
            "https://github.com/samy6352/cloud-lens-modern-November/archive/refs/tags/v$Version.zip",
            'https://github.com/samy6352/cloud-lens-modern-November/archive/refs/heads/main.zip'
        )
        $downloaded = $false
        foreach ($fallback in $fallbacks) {
            try {
                Invoke-WebRequest -Uri $fallback -OutFile $zip
                Write-Host "Downloaded fallback source archive: $fallback"
                $downloaded = $true
                $downloadedFromArchive = $true
                break
            } catch {
                continue
            }
        }
        if (-not $downloaded) {
            throw "Could not download release v$Version or fallback source archives. Verify repository/release accessibility, or use -SourceZip/-SourceSha256. $($_.Exception.Message)"
        }
    }
    if (-not $downloadedFromArchive) {
        $matches = @(Get-Content -LiteralPath $checksums | Where-Object {
            $_ -match ('^[a-fA-F0-9]{64}\s+\*?' + [regex]::Escape($asset) + '$')
        })
        if ($matches.Count -ne 1) {
            throw "Expected one SHA-256 entry for $asset. Installation stopped."
        }
        $expected = ($matches[0] -split '\s+')[0]
    }
}
if (-not $downloadedFromArchive -and (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ine $expected) {
    throw "Release SHA-256 mismatch. Installation stopped; do not execute files in $Destination."
}
if ($downloadedFromArchive) {
    Write-Warning 'Using the repository source archive fallback (no release checksum file was available).'
}

$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName
        if ($name -match '(^[/\\]|[:\\]|(^|/)\.\.?(/|$))' -or
            -not $names.Add($name) -or
            (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
            throw "Unsafe archive entry: $name. Installation stopped."
        }
    }
} finally {
    $archive.Dispose()
}
$source = Join-Path $Destination 'source'
Expand-Archive -LiteralPath $zip -DestinationPath $source
$sourceRoot = $source
$installer = Join-Path $sourceRoot 'infra\install.ps1'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $sourceRoot 'app\main.py') -PathType Leaf)) {
    $candidates = @(
        Get-ChildItem -LiteralPath $source -Directory -ErrorAction SilentlyContinue |
        Where-Object {
            (Test-Path -LiteralPath (Join-Path $_.FullName 'infra\install.ps1') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $_.FullName 'app\main.py') -PathType Leaf)
        }
    )
    if ($candidates.Count -eq 1) {
        $sourceRoot = $candidates[0].FullName
        $installer = Join-Path $sourceRoot 'infra\install.ps1'
    }
}
if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $sourceRoot 'app\main.py') -PathType Leaf)) {
    throw 'The downloaded ZIP is not a complete customer installer-source release.'
}
$source = $sourceRoot
Write-Host "Verified and extracted to $source"
Write-Host 'Keep this folder for deployment state and recovery. Installation incurs Azure charges.'
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Install Azure CLI and sign in with az login before continuing.' }
function Invoke-BootstrapAz([string[]]$Arguments) {
    $output = & az @Arguments --only-show-errors --output json
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI failed: az $($Arguments -join ' '). Resolve the error before continuing." }
    if ($output) { return ($output -join "`n") | ConvertFrom-Json }
}
function Select-InstallOption([string]$Title, [object[]]$Options, [int]$Default = 1) {
    Write-Host ''
    Write-Host $Title
    for ($i = 0; $i -lt $Options.Count; $i++) {
        $hint = if (($i + 1) -eq $Default) { '  <- recommended' } else { '' }
        Write-Host ("  {0}. {1}{2}" -f ($i + 1), $Options[$i].Label, $hint)
    }
    $answer = (Read-Host "Choose 1-$($Options.Count) [$Default]").Trim()
    $pick = if ($answer) { 0 + $answer } else { $Default }
    if ($pick -lt 1 -or $pick -gt $Options.Count) { throw "Choose a number from 1 to $($Options.Count)." }
    return $Options[$pick - 1].Value
}
$DefaultAppLocation = 'centralindia'
$DefaultAiLocation = 'eastus2'
$PrefixRule = '^[a-z0-9][a-z0-9-]{0,10}[a-z0-9]$'
$SuffixRule = '^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$'
$original = Invoke-BootstrapAz @('account', 'show')
if (-not $original.id) { throw 'Sign in with az login before continuing.' }
$interactive = [Environment]::UserInteractive
$enabledSubscriptions = @(
    Invoke-BootstrapAz @('account', 'list', '--query',
        "[?state=='Enabled'].{name:name,id:id,tenantId:tenantId,isDefault:isDefault}")
)
if (-not $SubscriptionId) {
    if ($interactive -and $enabledSubscriptions.Count) {
        $choices = @($enabledSubscriptions | ForEach-Object {
            [pscustomobject]@{ Label = "$($_.name) ($($_.id))"; Value = $_.id }
        })
        $defaultIndex = [array]::FindIndex($enabledSubscriptions, [Predicate[object]]{ param($s) $s.isDefault }) + 1
        if ($defaultIndex -lt 1) { $defaultIndex = 1 }
        $SubscriptionId = Select-InstallOption 'Select the hosting subscription:' $choices $defaultIndex
    } else {
        $defaultSub = $enabledSubscriptions | Where-Object { $_.isDefault } | Select-Object -First 1
        if (-not $defaultSub -and $original.id) {
            $defaultSub = [pscustomobject]@{ name = $original.name; id = $original.id }
        }
        if (-not $defaultSub -or -not $defaultSub.id) {
            throw 'No enabled hosting subscription could be resolved. Pass -SubscriptionId explicitly.'
        }
        $SubscriptionId = [string]$defaultSub.id
        Write-Host "Using hosting subscription: $($defaultSub.name) ($SubscriptionId)"
    }
}
if ($SubscriptionId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
    throw 'Hosting subscription must be a GUID.'
}
try {
    Invoke-BootstrapAz @('account', 'set', '--subscription', $SubscriptionId) | Out-Null
    $account = Invoke-BootstrapAz @('account', 'show')
    if ($account.id -ine $SubscriptionId -or $account.state -ne 'Enabled') { throw 'Requested enabled hosting subscription was not selected.' }
    if (-not $PSBoundParameters.ContainsKey('Size') -and $interactive) {
        $Size = Select-InstallOption 'Select sizing profile:' @(
            @{ Label = 'Small  - lighter estates and lower steady-state cost'; Value = 'small' }
            @{ Label = 'Medium - balanced default for most deployments'; Value = 'medium' }
            @{ Label = 'Large  - heavier estates and larger query throughput'; Value = 'large' }
        ) 2
    }
    if (-not $PSBoundParameters.ContainsKey('InitialHistoryMonths') -and $interactive) {
        $InitialHistoryMonths = [int](Select-InstallOption 'Select initial import window:' @(
            @{ Label = '1 month (fastest first load)'; Value = 1 }
            @{ Label = '3 months'; Value = 3 }
            @{ Label = '6 months'; Value = 6 }
        ) 1)
    }
    if (-not $Location) {
        if ($interactive) {
            $Location = Select-InstallOption 'Select app/database Azure region:' @(
                @{ Label = 'Central India (centralindia)'; Value = 'centralindia' }
                @{ Label = 'South India (southindia)'; Value = 'southindia' }
                @{ Label = 'Southeast Asia (southeastasia)'; Value = 'southeastasia' }
                @{ Label = 'West Europe (westeurope)'; Value = 'westeurope' }
                @{ Label = 'North Europe (northeurope)'; Value = 'northeurope' }
                @{ Label = 'East US (eastus)'; Value = 'eastus' }
                @{ Label = 'West US 2 (westus2)'; Value = 'westus2' }
                @{ Label = 'Australia East (australiaeast)'; Value = 'australiaeast' }
            ) 1
        } else {
            $Location = $DefaultAppLocation
            Write-Host "Using app/database region: $Location"
        }
    }
    if (-not $AiLocation) {
        if ($interactive) {
            $AiLocation = Select-InstallOption 'Select AI Azure region:' @(
                @{ Label = 'East US 2 (eastus2)'; Value = 'eastus2' }
                @{ Label = 'Sweden Central (swedencentral)'; Value = 'swedencentral' }
                @{ Label = 'West Europe (westeurope)'; Value = 'westeurope' }
                @{ Label = 'Southeast Asia (southeastasia)'; Value = 'southeastasia' }
            ) 1
        } else {
            $AiLocation = $DefaultAiLocation
            Write-Host "Using AI region: $AiLocation"
        }
    }
    foreach ($region in @($Location, $AiLocation)) {
        if ($region -notmatch '^[a-z0-9]+$') {
            throw 'Use an approved Azure region code such as southeastasia. Installation stopped.'
        }
    }
    if (-not $PSBoundParameters.ContainsKey('Scope') -and $interactive) {
        $scopeChoice = Select-InstallOption 'Select monitoring scope:' @(
            @{ Label = 'All enabled subscriptions I can see in this tenant'; Value = 'all' }
            @{ Label = "Only the hosting subscription ($SubscriptionId)"; Value = $SubscriptionId }
            @{ Label = 'A management group (enter ID)'; Value = 'mg' }
        ) 1
        if ($scopeChoice -eq 'mg') {
            $mg = (Read-Host 'Management group ID').Trim()
            if (-not $mg) { throw 'Management group ID is required for that scope option.' }
            $Scope = "/providers/Microsoft.Management/managementGroups/$mg"
        } else {
            $Scope = $scopeChoice
        }
    }
    if (-not $ResourceGroup) {
        $defaultResourceGroup = ('rg-cloudlens-{0}' -f (Get-Date -Format 'yyyyMMdd-HHmm')).ToLowerInvariant()
        if ($interactive) {
            $rgMode = Select-InstallOption 'Resource group name:' @(
                @{ Label = "Use recommended new name ($defaultResourceGroup)"; Value = 'recommended' }
                @{ Label = 'Enter a custom new name'; Value = 'custom' }
            ) 1
            if ($rgMode -eq 'custom') {
                $input = (Read-Host "NEW dedicated CloudLens resource group name [$defaultResourceGroup]").Trim()
                $ResourceGroup = if ($input) { $input } else { $defaultResourceGroup }
            } else {
                $ResourceGroup = $defaultResourceGroup
            }
        } else {
            $ResourceGroup = $defaultResourceGroup
            Write-Host "Using dedicated resource group: $ResourceGroup"
        }
    }
    if ($ResourceGroup -notmatch '^[A-Za-z0-9_-]{1,80}$') { throw 'Use 1-80 letters, digits, underscores or hyphens for the resource group.' }
    if (-not $NamePrefix -and -not $NameSuffix -and $interactive) {
        $nameMode = Select-InstallOption 'Resource naming mode:' @(
            @{ Label = 'Use generated default names'; Value = 'generated' }
            @{ Label = 'Set custom prefix/suffix'; Value = 'custom' }
        ) 1
        if ($nameMode -eq 'custom') {
            $NamePrefix = (Read-Host 'Name prefix (2-12 lowercase letters/digits/hyphens)').Trim().ToLowerInvariant()
            $NameSuffix = (Read-Host 'Name suffix (1-10 lowercase letters/digits/hyphens)').Trim().ToLowerInvariant()
        }
    }
    if ($NamePrefix -and $NamePrefix -notmatch $PrefixRule) { throw 'NamePrefix must be 2-12 lowercase letters, digits or hyphens, not starting or ending with a hyphen.' }
    if ($NameSuffix -and $NameSuffix -notmatch $SuffixRule) { throw 'NameSuffix must be 1-10 lowercase letters, digits or hyphens, not starting or ending with a hyphen.' }
    if ($NamePrefix -and -not $NameSuffix) { throw 'Provide NameSuffix with NamePrefix.' }
    if ($NameSuffix -and -not $NamePrefix) { throw 'Provide NamePrefix with NameSuffix.' }
    if (-not $Scope) { $Scope = 'all' }
    $Scope = $Scope.Trim()
    $managementGroupId = ''
    $costScopeSubscriptions = @()
    if ($Scope -ieq 'all') {
        $visible = Invoke-BootstrapAz @('account', 'list', '--query', "[?state=='Enabled'].{id:id,tenantId:tenantId}")
        if (-not $visible) { throw 'Could not list enabled subscriptions for -Scope all.' }
        $sameTenant = @($visible | Where-Object { $_.tenantId -ieq $account.tenantId } | ForEach-Object { $_.id.ToLowerInvariant() } | Select-Object -Unique)
        if (-not $sameTenant.Count) {
            throw "No enabled subscriptions are visible in tenant $($account.tenantId) for -Scope all."
        }
        $costScopeSubscriptions = $sameTenant
    } elseif ($Scope -match '^/providers/Microsoft\.Management/managementGroups/([A-Za-z0-9._()-]{1,90})$') {
        $managementGroupId = $Matches[1]
    } else {
        $scopeSub = $Scope
        if ($scopeSub -match '^/subscriptions/([0-9a-fA-F-]{36})$') { $scopeSub = $Matches[1] }
        if ($scopeSub -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
            throw "-Scope must be 'all', a subscription GUID, /subscriptions/<id>, or /providers/Microsoft.Management/managementGroups/<id>."
        }
        $costScopeSubscriptions = @($scopeSub.ToLowerInvariant())
    }
    $exists = Invoke-BootstrapAz @('group', 'exists', '--name', $ResourceGroup, '--subscription', $SubscriptionId)
    if ($exists -isnot [bool]) { throw 'Resource group existence could not be verified.' }
    if ($exists -and -not $Resume) { throw "Resource group '$ResourceGroup' exists. Use a new name, or -Resume only for this same CloudLens installation." }
    $global:LASTEXITCODE = 0
    $pgSku = if ($Size -eq 'large') { 'Standard_E4ds_v5' } else { 'Standard_D2ds_v5' }
    $planSku = if ($Size -eq 'small') { 'B1' } else { 'B2' }
    $preflight = Join-Path $source 'infra\preflight.ps1'
    $preflightRaw = Get-Content -LiteralPath $preflight -Raw
    $preflightSupportsAppIdentityOnly = $preflightRaw -match '(?m)^\s*\[switch\]\s*\$AppIdentityOnly\b'
    $preflightOptions = @{
        Location = $Location
        AiLocation = $AiLocation
        ResourceGroup = $ResourceGroup
        PostgresSku = $pgSku
        AppServicePlanSku = $planSku
    }
    if ($preflightSupportsAppIdentityOnly) { $preflightOptions.AppIdentityOnly = $true }
    if ($managementGroupId) {
        $preflightOptions.ManagementGroupId = $managementGroupId
    } else {
        $preflightOptions.CostScopeSubscriptions = $costScopeSubscriptions
    }
    & $preflight @preflightOptions
    if ($LASTEXITCODE -ne 0) { throw 'Readiness checks reported blockers. Resolve them before installation.' }
    $installerRaw = Get-Content -LiteralPath $installer -Raw
    $deployRaw = Get-Content -LiteralPath (Join-Path $source 'infra\deploy.ps1') -Raw
    $installerSupportsAllScope = $installerRaw -match "Kind = 'all'" -or $installerRaw -match "-Scope must be 'all'"
    $installerSupportsAppIdentityOnly = $installerRaw -match '(?m)^\s*\[switch\]\s*\$AppIdentityOnly\b'
    $deploySupportsAppIdentityOnly = $deployRaw -match '(?m)^\s*\[switch\]\s*\$AppIdentityOnly\b'
    $installerSupportsNonInteractive = $installerRaw -match '(?m)^\s*\[switch\]\s*\$NonInteractive\b'
    $effectiveScope = $Scope
    $postInstallExpandAllVisible = $false
    if ($Scope -ieq 'all' -and -not $installerSupportsAllScope) {
        Write-Warning "This installer release does not support -Scope all directly; continuing with hosting-subscription scope first, then automatically extending managed-identity access and exports to visible subscriptions."
        $effectiveScope = $SubscriptionId
        $postInstallExpandAllVisible = $true
    }
    $options = @{
        Location = $location; AiLocation = $aiLocation; SubscriptionId = $SubscriptionId
        Scope = $effectiveScope; ResourceGroup = $ResourceGroup; EntraAppUniqueName = $ResourceGroup
        Size = $Size; InitialHistoryMonths = $InitialHistoryMonths
    }
    if ($installerSupportsAppIdentityOnly -and $deploySupportsAppIdentityOnly) {
        $options.AppIdentityOnly = $true
    } elseif ($installerSupportsAppIdentityOnly -or $deploySupportsAppIdentityOnly) {
        Write-Warning 'This installer release has partial AppIdentityOnly support; continuing without that switch for compatibility.'
    }
    if ($installerSupportsNonInteractive) { $options.NonInteractive = $true }
    if ($NamePrefix) { $options.NamePrefix = $NamePrefix }
    if ($NameSuffix) { $options.NameSuffix = $NameSuffix }
    & $installer @options -WhatIf
    if ($Preview) { return }
    Write-Host "Hosting subscription: $($account.name) ($SubscriptionId); tenant: $($account.tenantId); scope: $Scope; resource group: $ResourceGroup"
    if (-not $Approve) {
        if ($interactive) {
            $approval = Select-InstallOption 'Provision CloudLens with these settings?' @(
                @{ Label = 'Proceed with provisioning'; Value = 'proceed' }
                @{ Label = 'Cancel'; Value = 'cancel' }
            ) 1
            if ($approval -ne 'proceed') {
                throw "Installation not approved. Verified source remains in $source."
            }
        } else {
            throw 'Non-interactive run requires -Approve to proceed after preview.'
        }
    }
    & $installer @options
    if ($postInstallExpandAllVisible -and -not $managementGroupId -and $costScopeSubscriptions.Count -gt 1) {
        Write-Warning 'Applying compatibility follow-up: extending runtime access and exports across visible subscriptions for -Scope all.'
        $cloudLensApps = @((Invoke-BootstrapAz @('webapp', 'list', '--resource-group', $ResourceGroup,
            '--query', "[?tags.application=='CloudLens'].name")) | Where-Object { $_ })
        if ($cloudLensApps.Count -ne 1) {
            throw "Could not uniquely identify the deployed CloudLens app in $ResourceGroup (found $($cloudLensApps.Count))."
        }
        $appName = [string]$cloudLensApps[0]
        & (Join-Path $source 'infra\grant-cost-access.ps1') -ResourceGroup $ResourceGroup -AppName $appName `
            -HostingSubscriptionId $SubscriptionId -CostScopeSubscriptions $costScopeSubscriptions -EnableExportManagement
        & (Join-Path $source 'infra\focus-exports.ps1') -ResourceGroup $ResourceGroup -WebAppName $appName `
            -HostingSubscriptionId $SubscriptionId -Subscriptions $costScopeSubscriptions -Paused
    }
} finally {
    Invoke-BootstrapAz @('account', 'set', '--subscription', $original.id) | Out-Null
}
