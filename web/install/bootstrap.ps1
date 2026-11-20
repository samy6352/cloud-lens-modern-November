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
    [string]$Scope = '',
    [string]$ResourceGroup = '',
    [string]$Location = '',
    [string]$AiLocation = '',
    [string]$VnetAddressPrefix = '',
    [string]$AppSubnetAddressPrefix = '',
    [string]$PostgresSubnetAddressPrefix = '',
    [string]$PrivateEndpointSubnetAddressPrefix = '',
    [ValidateSet('small', 'medium', 'large')]
    [string]$Size = 'medium',
    [ValidateRange(1, 13)]
    [int]$InitialHistoryMonths = 1,
    [string]$NamePrefix = '',
    [string]$NameSuffix = '',
    # Existing single-tenant Entra app registration client ID to reuse for sign-in.
    [string]$EntraClientId = '',
    # Sign-in bootstrap choice for deployment.
    [ValidateSet('', 'precreated', 'create-during-deploy')]
    [string]$SignInAppMode = '',
    # Runtime Azure access mode choice for deployment.
    [ValidateSet('', 'managed-identity', 'delegated-user')]
    [string]$RuntimeAccessMode = '',
    # Approved offline download or unpublished release rehearsal; hash must be supplied separately.
    [string]$SourceZip = '',
    [string]$SourceSha256 = '',
    # Skip the final interactive approval prompt (required for non-interactive runs).
    [switch]$Approve,
    [switch]$Resume,
    [switch]$Preview,
    [switch]$NoToolInstall
)
$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw "CloudLens setup requires PowerShell 7 in FullLanguage mode. This session is $($ExecutionContext.SessionState.LanguageMode). Use an organisation-approved environment, such as approved Azure Cloud Shell (PowerShell), or ask your administrator for an approved installation path."
}
function Write-SetupStage([int]$Number, [string]$Title, [string]$Detail) {
    Write-Host "`n[$Number/$stageCount] $Title" -ForegroundColor Cyan
    Write-Host "      $Detail"
}

$mode = if ($Preview) { 'Preview only' } elseif ($Approve) { 'Unattended' } else { 'Guided' }
$stageCount = if ($Preview) { 5 } else { 6 }
Write-Host "`nCloudLens Setup | $Version | $mode" -ForegroundColor Cyan
$journey = 'Verify source > Configure > Check readiness > Preview > Review'
if (-not $Preview) { $journey += ' > Install' }
Write-Host $journey
if ($SourceZip -and $SourceSha256 -notmatch '^[a-fA-F0-9]{64}$') {
    throw '-SourceZip requires the separately supplied -SourceSha256 (64 hexadecimal characters).'
}
if ($SourceSha256 -and -not $SourceZip) { throw '-SourceSha256 requires -SourceZip.' }
$networkOptions = @{}
$networkNames = @('VnetAddressPrefix', 'AppSubnetAddressPrefix', 'PostgresSubnetAddressPrefix', 'PrivateEndpointSubnetAddressPrefix')
foreach ($key in $networkNames) {
    if ($PSBoundParameters.ContainsKey($key)) { $networkOptions[$key] = $PSBoundParameters[$key] }
}
if ($networkOptions.Count -and ($networkOptions.Count -ne 4 -or @($networkOptions.Values | Where-Object { -not $_ }).Count)) {
    throw 'For a custom network, supply a VNet prefix and all three subnet prefixes.'
}
Write-SetupStage 1 'Verify the source archive' 'Check the archive checksum and paths before running anything from it.'
if ($EntraClientId -and $EntraClientId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
    throw '-EntraClientId must be a GUID.'
}
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
if ($SourceZip) {
    Copy-Item -LiteralPath $SourceZip -Destination $zip -ErrorAction Stop
    $expected = $SourceSha256
    Write-Host "Verifying the supplied CloudLens source archive for $Version."
} else {
    Write-Host "Downloading CloudLens $Version from GitHub."
    Write-Host 'The release must be published and accessible. Private releases require repository access.'
    try {
        Invoke-WebRequest -Uri "$base/$asset" -OutFile $zip -TimeoutSec 120
        Invoke-WebRequest -Uri "$base/SHA256SUMS.txt" -OutFile $checksums -TimeoutSec 30
    } catch {
        throw "Could not download the release ZIP and checksum for v$Version. Verify repository/release accessibility, or use -SourceZip/-SourceSha256. $($_.Exception.Message)"
    }
    $matches = @(Get-Content -LiteralPath $checksums | Where-Object {
        $_ -match ('^[a-fA-F0-9]{64}\s+\*?' + [regex]::Escape($asset) + '$')
    })
    if ($matches.Count -ne 1) {
        throw "Expected one SHA-256 entry for $asset. Installation stopped."
    }
    $expected = ($matches[0] -split '\s+')[0]
}
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ine $expected) {
    throw "Release SHA-256 mismatch. Installation stopped; do not execute files in $Destination."
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
Write-SetupStage 2 'Configure CloudLens' 'Select where CloudLens runs and what it monitors. Type ? at a menu to see the trade-offs.'
$prerequisites = Join-Path $source 'infra\install-prerequisites.ps1'
if (Test-Path -LiteralPath $prerequisites -PathType Leaf) {
    . $prerequisites
    Initialize-CloudLensAzureCli -NoToolInstall:$NoToolInstall
    Connect-CloudLensAzure -NonInteractive:$Approve
} elseif (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'This older release needs Azure CLI installed in advance. Install it and sign in with az login, or use a newer verified installer-source release.'
}
function Invoke-BootstrapAz([string[]]$Arguments) {
    $output = & az @Arguments --only-show-errors --output json
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI failed: az $($Arguments -join ' '). Resolve the error before continuing." }
    if ($output) { return ($output -join "`n") | ConvertFrom-Json }
}
function Select-InstallOption([string]$Title, [object[]]$Options, [int]$Default = 1, [string]$HelpText) {
    Write-Host ''
    Write-Host $Title
    for ($i = 0; $i -lt $Options.Count; $i++) {
        $hint = if (($i + 1) -eq $Default) { '  <- default' } else { '' }
        Write-Host ("  {0}. {1}{2}" -f ($i + 1), $Options[$i].Label, $hint)
    }
    do {
        $answer = (Read-Host "Choose 1-$($Options.Count) [Enter: $Default, ?: help]").Trim()
        if (-not $answer) { return $Options[$Default - 1].Value }
        if ($answer -eq '?') {
            Write-Host "  Setup guide: $HelpText" -ForegroundColor Cyan
            continue
        }
        $pick = 0
        if ([int]::TryParse($answer, [ref]$pick) -and $pick -ge 1 -and $pick -le $Options.Count) {
            return $Options[$pick - 1].Value
        }
        Write-Warning "Choose a number from 1 to $($Options.Count)."
    } while ($true)
}
function Select-HostingSubscription([object[]]$Subscriptions, [string]$DefaultId) {
    $current = $Subscriptions | Where-Object { $_.id -eq $DefaultId } | Select-Object -First 1
    Write-Host "`nWhere should CloudLens run? ($($Subscriptions.Count) enabled subscriptions)"
    if ($current) { Write-Host "Press Enter to use the current subscription: $($current.name) ($($current.id))." }
    while ($true) {
        $query = (Read-Host 'Search by name, paste an ID, or type :list to browse all [?: help]').Trim()
        if (-not $query -and $current) { return $current.id }
        if (-not $query -or $query -eq '?') {
            Write-Host 'Choose the approved hosting subscription. It receives the infrastructure charges. Search narrows the list; :list shows all enabled subscriptions in pages.'
            continue
        }
        if ($query -eq ':list') {
            $found = @($Subscriptions | Sort-Object name, id)
        } else {
            $found = @($Subscriptions | Where-Object { $_.id -ieq $query })
            if (-not $found.Count) {
                $found = @($Subscriptions | Where-Object { $_.name -like "*$([WildcardPattern]::Escape($query))*" })
            }
        }
        if (-not $found.Count) { Write-Warning 'No enabled subscription matches. Try a different name or ID.'; continue }
        $pageSize = 8
        $lastPage = [int][math]::Floor(($found.Count - 1) / $pageSize)
        $page = 0
        while ($true) {
            $first = $page * $pageSize
            $last = [math]::Min($first + $pageSize - 1, $found.Count - 1)
            if ($lastPage) { Write-Host "Subscriptions $($first + 1)-$($last + 1) of $($found.Count)" }
            for ($i = $first; $i -le $last; $i++) {
                Write-Host "  $($i + 1). $($found[$i].name) ($($found[$i].id))"
            }
            $prompt = "Choose $($first + 1)-$($last + 1) [Enter: search again"
            if ($page -lt $lastPage) { $prompt += ', N: next' }
            if ($page -gt 0) { $prompt += ', P: previous' }
            $answer = (Read-Host "$prompt]").Trim()
            if (-not $answer) { break }
            if ($answer -eq 'n' -and $page -lt $lastPage) { $page++; continue }
            if ($answer -eq 'p' -and $page -gt 0) { $page--; continue }
            $pick = 0
            if ([int]::TryParse($answer, [ref]$pick) -and $pick -gt $first -and $pick -le ($last + 1)) {
                return $found[$pick - 1].id
            }
            Write-Warning 'Choose a subscription number on this page or use the paging options shown.'
        }
    }
}
function Select-AzureRegion([string]$Title, [object[]]$Options, [string]$HelpText) {
    $regionOptions = @($Options) + @{ Label = 'Enter another Azure region code'; Value = ':manual' }
    do {
        $selected = Select-InstallOption $Title $regionOptions 1 $HelpText
        if ($selected -ne ':manual') { return $selected }
        $regions = @(Invoke-BootstrapAz @('account', 'list-locations', '--query', '[].name'))
        if (-not $regions.Count) { throw 'Azure returned no regions for the selected subscription.' }
        while ($true) {
            $code = (Read-Host 'Azure region code, e.g. eastasia [Enter: back]').Trim().ToLowerInvariant()
            if (-not $code) { break }
            if ($code -match '^[a-z0-9]+$' -and $code -in $regions) { return $code }
            Write-Warning 'Enter a region code listed for this subscription, without spaces.'
        }
    } while ($true)
}
$DefaultAppLocation = 'southeastasia'
$DefaultAiLocation = 'southeastasia'
$PrefixRule = '^[a-z0-9][a-z0-9-]{0,10}[a-z0-9]$'
$SuffixRule = '^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$'
$original = Invoke-BootstrapAz @('account', 'show')
if (-not $original.id) { throw 'Sign in with az login before continuing.' }
$interactive = -not $Approve -and [Environment]::UserInteractive
$enabledSubscriptions = @(
    Invoke-BootstrapAz @('account', 'list', '--query',
        "[?state=='Enabled'].{name:name,id:id,tenantId:tenantId,isDefault:isDefault}")
)
if (-not $SubscriptionId) {
    if ($interactive -and $enabledSubscriptions.Count -gt 8) {
        $SubscriptionId = Select-HostingSubscription $enabledSubscriptions $original.id
    } elseif ($interactive -and $enabledSubscriptions.Count) {
        $choices = @($enabledSubscriptions | ForEach-Object {
            [pscustomobject]@{ Label = "$($_.name) ($($_.id))"; Value = $_.id }
        })
        $defaultIndex = [array]::FindIndex($enabledSubscriptions, [Predicate[object]]{ param($s) $s.isDefault }) + 1
        if ($defaultIndex -lt 1) { $defaultIndex = 1 }
        $SubscriptionId = Select-InstallOption 'Where should CloudLens run?' $choices $defaultIndex `
            'This subscription hosts the infrastructure and receives its Azure charges. Choose the approved target; the default is your current CLI subscription when available.'
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
    if (-not $PSBoundParameters.ContainsKey('Scope') -and $interactive) {
        $scopeChoice = Select-InstallOption 'Which subscriptions should CloudLens monitor?' @(
            @{ Label = 'Only the hosting subscription'; Value = $SubscriptionId }
            @{ Label = 'All enabled subscriptions I can see in the hosting tenant'; Value = 'all' }
            @{ Label = 'A management group (enter ID)'; Value = 'mg' }
        ) 1 'The hosting subscription is where CloudLens runs. Monitoring all visible subscriptions or a management group widens access and can require additional role assignments.'
        if ($scopeChoice -eq 'mg') {
            $mg = (Read-Host 'Management group ID').Trim()
            if (-not $mg) { throw 'Management group ID is required for that scope option.' }
            $Scope = "/providers/Microsoft.Management/managementGroups/$mg"
        } else {
            $Scope = $scopeChoice
        }
    }
    if (-not $PSBoundParameters.ContainsKey('Size') -and $interactive) {
        $Size = Select-InstallOption 'Select sizing profile:' @(
            @{ Label = 'Small  - lighter estates and lower steady-state cost'; Value = 'small' }
            @{ Label = 'Medium - balanced default for most deployments'; Value = 'medium' }
            @{ Label = 'Large  - heavier estates and larger query throughput'; Value = 'large' }
        ) 2 'Medium is a starting point. Small uses a smaller App Service plan. Large uses a larger PostgreSQL SKU and needs more capacity and budget.'
    }
    if (-not $PSBoundParameters.ContainsKey('InitialHistoryMonths') -and $interactive) {
        $InitialHistoryMonths = [int](Select-InstallOption 'Select initial import window:' @(
            @{ Label = '1 month (fastest first load)'; Value = 1 }
            @{ Label = '3 months'; Value = 3 }
            @{ Label = '6 months'; Value = 6 }
        ) 1 'Start with one month for the fastest first load. Choose a longer window only if you need more history on day one.')
    }
    if (-not $Location) {
        if ($interactive) {
            $Location = Select-AzureRegion 'Select app/database Azure region:' @(
                @{ Label = 'Southeast Asia - Singapore (southeastasia)'; Value = $DefaultAppLocation }
                @{ Label = 'Malaysia West (malaysiawest)'; Value = 'malaysiawest' }
                @{ Label = 'East Asia - Hong Kong (eastasia)'; Value = 'eastasia' }
                @{ Label = 'Central India (centralindia)'; Value = 'centralindia' }
                @{ Label = 'South India (southindia)'; Value = 'southindia' }
                @{ Label = 'West Europe (westeurope)'; Value = 'westeurope' }
                @{ Label = 'North Europe (northeurope)'; Value = 'northeurope' }
                @{ Label = 'East US (eastus)'; Value = 'eastus' }
                @{ Label = 'West US 2 (westus2)'; Value = 'westus2' }
            ) 'Choose an approved region for the app and database. Singapore is the default, not a guarantee of capacity or an assurance of data residency.'
        } else {
            $Location = $DefaultAppLocation
            Write-Host "Using app/database region: $Location"
        }
    }
    if (-not $AiLocation) {
        if ($interactive) {
            $AiLocation = Select-AzureRegion 'Select AI Azure region:' @(
                @{ Label = 'Southeast Asia - Singapore (southeastasia)'; Value = $DefaultAiLocation }
                @{ Label = 'East US 2 (eastus2)'; Value = 'eastus2' }
                @{ Label = 'Sweden Central (swedencentral)'; Value = 'swedencentral' }
                @{ Label = 'West Europe (westeurope)'; Value = 'westeurope' }
            ) 'The AI deployment region can differ from the app region. Preflight checks model availability and quota. GlobalStandard may process requests outside the deployment region.'
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
    if (-not $RuntimeAccessMode -and $interactive) {
        $RuntimeAccessMode = Select-InstallOption 'Select Azure runtime access mode:' @(
            @{ Label = 'Managed identity only (no delegated admin-consent requirement)'; Value = 'managed-identity' }
            @{ Label = 'Delegated user access (requires delegated ARM consent)'; Value = 'delegated-user' }
        ) 1 'Managed identity uses permissions assigned to the app. Choose delegated user access only if your tenant has approved delegated ARM consent.'
    }
    if (-not $RuntimeAccessMode) { $RuntimeAccessMode = 'managed-identity' }
    $chooseSignInMode = -not $SignInAppMode -and $interactive
    do {
        if ($chooseSignInMode) {
            $SignInAppMode = Select-InstallOption 'How should CloudLens users sign in?' @(
                @{ Label = 'Reuse an approved Entra app (have its Application (client) ID ready)'; Value = 'precreated' }
                @{ Label = 'Create an Entra sign-in app during deployment (requires app-registration rights)'; Value = 'create-during-deploy' }
            ) $(if ($EntraClientId) { 1 } else { 2 }) 'Copy the Application (client) ID from the app registration Overview, not its Object ID or a client secret. This is separate from the Azure runtime access choice.'
        } elseif (-not $SignInAppMode) {
            $SignInAppMode = if ($EntraClientId) { 'precreated' } else { 'create-during-deploy' }
        }
        if ($SignInAppMode -ne 'precreated' -or $EntraClientId -or -not $interactive) { break }
        while ($true) {
            $prompt = 'Application (client) ID (GUID)'
            if ($chooseSignInMode) { $prompt += ' [Enter: go back]' }
            $candidate = (Read-Host $prompt).Trim()
            if (-not $candidate -and $chooseSignInMode) { break }
            if ($candidate -match '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$') {
                $EntraClientId = $candidate
                break
            }
            Write-Warning 'Enter the Application (client) ID from the Entra app registration Overview.'
        }
    } while ($chooseSignInMode -and -not $EntraClientId)
    if ($SignInAppMode -eq 'precreated' -and ($EntraClientId -notmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$')) {
        throw "Sign-in app mode '$SignInAppMode' requires -EntraClientId (GUID)."
    }
    if ($SignInAppMode -eq 'create-during-deploy' -and $EntraClientId) {
        throw "Sign-in app mode '$SignInAppMode' cannot be combined with -EntraClientId. Choose -SignInAppMode precreated to reuse an app."
    }
    if (-not $ResourceGroup) {
        $defaultResourceGroup = ('rg-cloudlens-{0}' -f (Get-Date -Format 'yyyyMMdd-HHmm')).ToLowerInvariant()
        if ($interactive) {
            $rgMode = Select-InstallOption 'Resource group name:' @(
                @{ Label = "Use recommended new name ($defaultResourceGroup)"; Value = 'recommended' }
                @{ Label = 'Enter a custom new name'; Value = 'custom' }
            ) 1 'A dedicated resource group keeps recovery separate from other workloads. To resume an existing CloudLens stack, reuse its original settings with -Resume.'
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
        ) 1 'Generated names minimise naming collisions. Use a custom prefix and suffix when your organisation requires a naming convention.'
        if ($nameMode -eq 'custom') {
            $NamePrefix = (Read-Host 'Name prefix (2-12 lowercase letters/digits/hyphens)').Trim().ToLowerInvariant()
            $NameSuffix = (Read-Host 'Name suffix (1-10 lowercase letters/digits/hyphens)').Trim().ToLowerInvariant()
        }
    }
    if ($NamePrefix -and $NamePrefix -notmatch $PrefixRule) { throw 'NamePrefix must be 2-12 lowercase letters, digits or hyphens, not starting or ending with a hyphen.' }
    if ($NameSuffix -and $NameSuffix -notmatch $SuffixRule) { throw 'NameSuffix must be 1-10 lowercase letters, digits or hyphens, not starting or ending with a hyphen.' }
    if ($NamePrefix -and -not $NameSuffix) { throw 'Provide NameSuffix with NamePrefix.' }
    if ($NameSuffix -and -not $NamePrefix) { throw 'Provide NamePrefix with NameSuffix.' }
    $Scope = $Scope.Trim()
    if (-not $Scope) { $Scope = $SubscriptionId }
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
    $previewTarget = "$($account.name) ($SubscriptionId) / $ResourceGroup"
    Write-SetupStage 3 'Check Azure readiness' "Target: $previewTarget. Azure will check regions, capacity and access."
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
    if ($networkOptions.Count) {
        $installerParameters = (Get-Command -Name $installer).Parameters
        foreach ($key in $networkNames) {
            if (-not $installerParameters.ContainsKey($key)) { throw "This release does not support custom network parameter $key." }
        }
        $preflightOptions.VnetAddressPrefix = $VnetAddressPrefix
    }
    if ($preflightSupportsAppIdentityOnly -and $RuntimeAccessMode -eq 'managed-identity') {
        $preflightOptions.AppIdentityOnly = $true
    }
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
    $installerSupportsRequireDelegatedArm = $installerRaw -match '(?m)^\s*\[switch\]\s*\$RequireDelegatedArm\b'
    $installerSupportsEntraClientId = $installerRaw -match '(?m)^\s*\[string\]\s*\$EntraClientId\b'
    $deploySupportsAppIdentityOnly = $deployRaw -match '(?m)^\s*\[switch\]\s*\$AppIdentityOnly\b'
    $installerSupportsNonInteractive = $installerRaw -match '(?m)^\s*\[switch\]\s*\$NonInteractive\b'
    $installerSupportsNoToolInstall = $installerRaw -match '(?m)^\s*\[switch\]\s*\$NoToolInstall\b'
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
    foreach ($key in $networkOptions.Keys) { $options[$key] = $networkOptions[$key] }
    if ($RuntimeAccessMode -eq 'managed-identity') {
        if ($installerSupportsAppIdentityOnly -and $deploySupportsAppIdentityOnly) {
            $options.AppIdentityOnly = $true
        } elseif ($installerSupportsAppIdentityOnly -or $deploySupportsAppIdentityOnly) {
            Write-Warning 'This installer release has partial AppIdentityOnly support; continuing without that switch for compatibility.'
        }
    } elseif ($RuntimeAccessMode -eq 'delegated-user') {
        if ($installerSupportsRequireDelegatedArm) {
            $options.RequireDelegatedArm = $true
        } else {
            Write-Warning 'This installer release does not expose -RequireDelegatedArm; delegated mode may fall back if consent is unavailable.'
        }
    } else {
        throw "Unsupported runtime access mode: $RuntimeAccessMode"
    }
    if ($SignInAppMode -eq 'precreated') {
        if (-not $installerSupportsEntraClientId) {
            throw 'This installer release does not support -EntraClientId, but precreated sign-in app mode was requested.'
        }
        $options.EntraClientId = $EntraClientId
    }
    if ($installerSupportsNonInteractive) { $options.NonInteractive = $true }
    if ($installerSupportsNoToolInstall -and $NoToolInstall) { $options.NoToolInstall = $true }
    if ($NamePrefix) { $options.NamePrefix = $NamePrefix }
    if ($NameSuffix) { $options.NameSuffix = $NameSuffix }
    Write-SetupStage 4 'Preview Azure changes' 'Review the ARM What-If output. It does not show every Entra, access or export operation.'
    while ($true) {
        try {
            & $installer @options -WhatIf
            if (-not $?) { throw "Deployment preview failed (installer exit $LASTEXITCODE)." }
            break
        } catch {
            Write-Warning "Preview stopped. No provisioning was attempted. Target: $previewTarget. Keep the verified source and naming state at $source."
            if (-not $interactive) { throw }
            Write-Host "  $($_.Exception.Message)"
            $retry = Select-InstallOption 'What would you like to do?' @(
                @{ Label = 'Retry What-If with the same settings'; Value = 'retry' }
                @{ Label = 'Stop and keep the verified source'; Value = 'stop' }
            ) 2 'Retry after resolving the reported blocker. This does not provision resources or change your deployment settings. Press Enter to stop.'
            if ($retry -ne 'retry') { throw }
        }
    }
    Write-SetupStage 5 'Review the deployment plan' 'Check the billing subscription, monitoring scope and approved regions.'
    $scopeSummary = if ($managementGroupId) { "Management group: $managementGroupId" }
        elseif ($Scope -ieq 'all') { "All $($costScopeSubscriptions.Count) visible enabled subscriptions in this tenant" }
        elseif ($costScopeSubscriptions[0] -ieq $SubscriptionId) { 'Hosting subscription only' }
        else { "Subscription: $($costScopeSubscriptions[0])" }
    $plan = [ordered]@{
        'Target'               = $(if ($Resume) { 'Resume existing installation' } else { 'New installation' })
        'Hosting subscription' = "$($account.name) ($SubscriptionId)"
        'Tenant'               = $account.tenantId
        'Resource group'       = $ResourceGroup
        'Monitoring scope'     = $scopeSummary
        'App / database'       = $Location
        'AI region'            = $AiLocation
        'VNet range'           = $(if ($VnetAddressPrefix) { $VnetAddressPrefix } else { 'Release default (review What-If)' })
        'Sizing'               = "$Size (App Service $planSku / PostgreSQL $pgSku)"
        'First import'         = "$InitialHistoryMonths month(s)"
        'Naming'               = $(if ($NamePrefix) { "$NamePrefix / $NameSuffix (prefix / suffix)" } else { 'Generated' })
        'Runtime access'       = "$RuntimeAccessMode (requested)"
        'Entra sign-in app'    = $(if ($EntraClientId) { "$SignInAppMode ($EntraClientId)" } else { $SignInAppMode })
        'Recovery folder'      = $source
    }
    foreach ($item in $plan.GetEnumerator()) {
        Write-Host ('  {0,-21} {1}' -f ($item.Key + ':'), $item.Value)
    }
    if ($Preview) {
        Write-Host "`nPreview complete. No Azure resources were provisioned. Review the warnings and unsupported changes before planning an install." -ForegroundColor Green
        return
    }
    Write-Host "`nProvisioning can incur Azure charges and create Entra, role-assignment and FOCUS export configuration." -ForegroundColor Yellow
    if (-not $Approve) {
        if ($interactive) {
            $approval = Select-InstallOption 'Provision CloudLens with these settings?' @(
                @{ Label = 'Proceed with provisioning'; Value = 'proceed' }
                @{ Label = 'Cancel'; Value = 'cancel' }
            ) 2 'Cancel if the target or scope is not approved. Review the What-If output before proceeding; pressing Enter cancels.'
            if ($approval -ne 'proceed') {
                throw "Installation not approved. Verified source remains in $source."
            }
        } else {
            throw 'Non-interactive run requires -Approve to proceed after preview.'
        }
    }
    Write-SetupStage 6 'Provision CloudLens' 'Wait for deployment and export setup. The installer will report app readiness and any remaining export work.'
    try {
        & $installer @options
        if (-not $?) { throw "Installation failed (installer exit $LASTEXITCODE)." }
    } catch {
        Write-Warning "Provisioning stopped and Azure changes may already exist. Keep $source and its deployment state. Check '$ResourceGroup' in '$SubscriptionId' before retrying; use the original settings and preview first."
        throw
    }
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
    try {
        Invoke-BootstrapAz @('account', 'set', '--subscription', $original.id) | Out-Null
    } catch {
        Write-Warning "Could not restore the previous Azure CLI subscription. Run: az account set --subscription $($original.id)"
    }
}
