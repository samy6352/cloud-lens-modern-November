<#
.SYNOPSIS
    Install CloudLens into your own Azure subscription -- two lines in Azure Cloud Shell (PowerShell).

.DESCRIPTION
        az account set --subscription <subscription-to-host-cloudlens>
        ./infra/install.ps1 -Location centralindia

    Optional: -Scope <subscription id | /providers/Microsoft.Management/managementGroups/<id>>
              -Size small|medium|large   -EntraClientId <id>   -LocalSignIn   -WhatIf

    What it does, in order, and nothing else:
      1. Checks PowerShell 7, the Azure CLI and the signed-in account; resolves the monitored scope
         (default: the current subscription; a management group covers every subscription under it).
      2. Registers the resource providers the stack needs in the hosting subscription, and
         Microsoft.CostManagementExports in every monitored subscription -- the app's own identity
         is not allowed to register providers, and cannot create an export without this one.
      3. Deploys the stack (infra/deploy.ps1) sized by -Size, with managed exports on: the app
         identity gets Reader, Cost Management Reader and Cost Management Contributor on the scope
         (plain Azure RBAC -- no EA or billing roles) and, on its own storage account only, the
         ABAC-limited right to grant an export's identity Storage Blob Data Contributor.
      4. Creates one paused FOCUS export per monitored subscription, as you (infra/focus-exports.ps1):
         Cost Management lets the app's identity run an export but not create one. Then prints the
         URL. On first start the app adopts those exports and imports the current month plus the
         two before it, newest first. An administrator can request up to 13 months on Setup;
         subscriptions added later show the one command to run on their Setup page.

    Safe to re-run: every step is idempotent and a rerun upgrades in place.

    You need: Owner (or Contributor + User Access Administrator) on the hosting subscription, a
    role-assignment right on the monitored scope, and -- unless you pass -EntraClientId or
    -LocalSignIn -- the right to create an Entra app registration and grant admin consent.

.EXAMPLE
    ./infra/install.ps1 -Location centralindia

.EXAMPLE
    ./infra/install.ps1 -Location centralindia -Scope /providers/Microsoft.Management/managementGroups/finance -Size large

.EXAMPLE
    # Preview only: shows what would be registered and deployed, changes nothing.
    ./infra/install.ps1 -Location centralindia -WhatIf
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Location,

    # What CloudLens monitors. Empty = the current subscription.
    [string]$Scope = '',

    [ValidateSet('small', 'medium', 'large')]
    [string]$Size = 'medium',

    [string]$ResourceGroup = 'rg-cloudlens',

    # Current month counts as one. Earlier history remains an explicit administrator choice.
    [ValidateRange(1, 13)]
    [int]$InitialHistoryMonths = 3,

    # An app registration an identity team created (single-tenant, public client). See infra/README.md.
    [string]$EntraClientId = '',

    # For tenants where app registration or admin consent is not available to the installer:
    # sign in with a local administrator. The installer generates its password here, gives the
    # app only a PBKDF2 hash (AUTH_USERS), and shows the password once in this terminal.
    [switch]$LocalSignIn,

    # With -LocalSignIn on a rerun: replace the local administrator's password instead of keeping it.
    [switch]$ResetLocalPassword,

    # When not run from a CloudLens checkout (e.g. `irm .../install.ps1 | iex`): a release zip,
    # as an https URL or a local path.
    [string]$Source = '',

    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$started = Get-Date

$Profiles = [ordered]@{
    # Plan section 9. Small stays on General Purpose until the burstable backfill spike (S5) says otherwise.
    small  = @{ PostgresSku = 'Standard_D2ds_v5'; PostgresStorageGb = 64;  AppServicePlanSku = 'B1'; Rows = 'up to ~1M cost rows a month' }
    medium = @{ PostgresSku = 'Standard_D2ds_v5'; PostgresStorageGb = 128; AppServicePlanSku = 'B2'; Rows = '~1-5M cost rows a month' }
    large  = @{ PostgresSku = 'Standard_E4ds_v5'; PostgresStorageGb = 256; AppServicePlanSku = 'B2'; Rows = '~5-20M cost rows a month' }
}
# Deployed resource types; ARM usually auto-registers these, but a policy-restricted deployer may
# not be allowed to, and a half-built stack is a worse failure than an explicit one up front.
$HostingProviders = @(
    'Microsoft.Web', 'Microsoft.DBforPostgreSQL', 'Microsoft.Storage', 'Microsoft.Network',
    'Microsoft.ManagedIdentity', 'Microsoft.OperationalInsights', 'Microsoft.Insights',
    'Microsoft.CognitiveServices'
)
$MonitoredProviders = @('Microsoft.CostManagement', 'Microsoft.CostManagementExports')
$Guid = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

function Step([string]$Message) { Write-Host ''; Write-Host "==> $Message" -ForegroundColor Cyan }
function Info([string]$Message) { Write-Host "    $Message" }

function Invoke-Az {
    <# The Azure CLI, parsed; throws with its own message on failure. #>
    param([Parameter(Mandatory)][string[]]$Arguments, [switch]$Raw)
    $output = & az @Arguments --only-show-errors -o $(if ($Raw) { 'tsv' } else { 'json' }) 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "az $($Arguments[0..([math]::Min(2, $Arguments.Count - 1))] -join ' ') failed: $(($output | Out-String).Trim())"
    }
    $text = ($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
    if ($Raw) { return $text.Trim() }
    if (-not $text) { return $null }
    return $text | ConvertFrom-Json
}

function Resolve-CloudLensScope([string]$Value, [string]$HostingSubscription) {
    $text = $Value.Trim().TrimEnd('/')
    if (-not $text) { return [pscustomobject]@{ Kind = 'subscription'; Id = $HostingSubscription; Path = "/subscriptions/$HostingSubscription" } }
    if ($text -match '^/subscriptions/([^/]+)$') { $text = $Matches[1] }
    if ($text -match $Guid) {
        return [pscustomobject]@{ Kind = 'subscription'; Id = $text.ToLowerInvariant(); Path = "/subscriptions/$($text.ToLowerInvariant())" }
    }
    if ($text -match '^/providers/Microsoft\.Management/managementGroups/([A-Za-z0-9._()-]{1,90})$') {
        return [pscustomobject]@{ Kind = 'managementGroup'; Id = $Matches[1]; Path = "/providers/Microsoft.Management/managementGroups/$($Matches[1])" }
    }
    throw "-Scope must be a subscription ID, /subscriptions/<id>, or /providers/Microsoft.Management/managementGroups/<id>; got '$Value'. Nothing has been changed."
}

function Get-ManagementGroupSubscriptions([string]$GroupId) {
    <# Every subscription anywhere under the group, following nextLink. #>
    $url = "https://management.azure.com/providers/Microsoft.Management/managementGroups/$GroupId/descendants?api-version=2020-05-01"
    $found = [System.Collections.Generic.List[string]]::new()
    for ($page = 0; $url -and $page -lt 100; $page++) {
        $payload = Invoke-Az @('rest', '--method', 'get', '--url', $url)
        foreach ($item in @($payload.value)) {
            if ($item.type -eq 'Microsoft.Management/managementGroups/subscriptions' -and $item.name -match $Guid) {
                $found.Add($item.name.ToLowerInvariant())
            }
        }
        $url = $payload.nextLink
        if ($url -and $url -notmatch '^https://management\.azure\.com/') { throw 'Management group listing returned a continuation outside Azure Resource Manager.' }
    }
    if ($url) { throw "Management group $GroupId lists more than 100 pages of descendants; the listing is incomplete." }
    return @($found | Select-Object -Unique)
}

function ConvertTo-UrlBase64([byte[]]$Bytes) {
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-CloudLensLocalAdmin {
    <#
    A strong password and the AUTH_USERS entry for it, in app/auth.py's own format:
    name:pbkdf2_sha256$<iterations>$<salt>$<key>:admin. Only the hash leaves this machine.
    #>
    $password = ConvertTo-UrlBase64 ([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(18))
    $salt = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
    $key = [System.Security.Cryptography.Rfc2898DeriveBytes]::Pbkdf2(
        [Text.Encoding]::UTF8.GetBytes($password), $salt, 260000,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256, 32)
    return [pscustomobject]@{
        Password = $password
        AuthUsers = "admin:pbkdf2_sha256`$260000`$$(ConvertTo-UrlBase64 $salt)`$$(ConvertTo-UrlBase64 $key):admin"
    }
}

function Get-CloudLensExistingSite([string]$Group) {
    <# The CloudLens web app already in this resource group, if this is a rerun. #>
    $exists = Invoke-Az -Raw @('group', 'exists', '--name', $Group)
    if ($exists -ne 'true') { return $null }
    return Invoke-Az @('webapp', 'list', '--resource-group', $Group,
        '--query', "[?tags.application=='CloudLens'].{name:name,host:defaultHostName}") | Select-Object -First 1
}

function Resolve-CloudLensRoot {
    if ($PSScriptRoot) {
        $candidate = Split-Path -Parent $PSScriptRoot
        if (Test-Path -LiteralPath (Join-Path (Join-Path $candidate 'app') 'main.py')) { return $candidate }
    }
    if (-not $Source) {
        throw ('Run this from a CloudLens checkout (./infra/install.ps1 -Location <region>), or pass ' +
               '-Source <release zip URL or path>. Nothing has been changed.')
    }
    $work = Join-Path ([IO.Path]::GetTempPath()) "cloudlens-install-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $work | Out-Null
    $zip = Join-Path $work 'cloudlens.zip'
    if ($Source -match '^https://') { Invoke-WebRequest -Uri $Source -OutFile $zip -UseBasicParsing }
    elseif (Test-Path -LiteralPath $Source -PathType Leaf) { Copy-Item -LiteralPath $Source -Destination $zip }
    else { throw "-Source must be an https URL or an existing zip file: $Source" }
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $work 'src')
    $root = Get-ChildItem -LiteralPath (Join-Path $work 'src') -Recurse -Filter 'main.py' |
        Where-Object { $_.Directory.Name -eq 'app' -and (Test-Path (Join-Path $_.Directory.Parent.FullName 'infra')) } |
        Select-Object -First 1
    if (-not $root) { throw "The -Source archive does not contain a CloudLens source tree (app/main.py beside infra/)." }
    return $root.Directory.Parent.FullName
}

# ------------------------------------------------------------------ 1. checks
Step 'Checking the environment'
if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'PowerShell 7 or later is required. In Azure Cloud Shell choose PowerShell; elsewhere install pwsh.'
}
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'The Azure CLI (az) was not found. Azure Cloud Shell has it; elsewhere install it and run az login.'
}
$root = Resolve-CloudLensRoot
$account = Invoke-Az @('account', 'show')
if (-not $account -or $account.id -notmatch $Guid) { throw "Not signed in to Azure. Run 'az login' (Cloud Shell is already signed in)." }
$hosting = $account.id.ToLowerInvariant()
$sizing = $Profiles[$Size]
Info "hosting      : $($account.name) ($hosting)"
Info "tenant       : $($account.tenantId)"
Info "source       : $root"
Info "size         : $Size -- $($sizing.Rows): PostgreSQL $($sizing.PostgresSku), $($sizing.PostgresStorageGb) GB; App Service $($sizing.AppServicePlanSku)"
Info "initial data : $InitialHistoryMonths calendar month(s), newest first"

$target = Resolve-CloudLensScope $Scope $hosting
Step "Resolving the monitored scope ($($target.Path))"
if ($target.Kind -eq 'subscription') {
    $info = Invoke-Az @('account', 'show', '--subscription', $target.Id)
    if ($info.tenantId -ine $account.tenantId) { throw "Subscription $($target.Id) is in another tenant; CloudLens monitors its own tenant only." }
    if ($info.state -ne 'Enabled') { throw "Subscription $($target.Id) is $($info.state), not Enabled." }
    $monitored = @($target.Id)
    Info "subscription : $($info.name)"
} else {
    $group = Invoke-Az @('account', 'management-group', 'show', '--name', $target.Id)
    if ($group.tenantId -and $group.tenantId -ine $account.tenantId) { throw "Management group $($target.Id) is in another tenant." }
    $monitored = @(Get-ManagementGroupSubscriptions $target.Id)
    Info "group        : $($group.displayName) -- $($monitored.Count) subscription(s) today; later ones are covered automatically"
    if (-not $monitored.Count) { Write-Warning "Management group $($target.Id) has no subscriptions yet; CloudLens will onboard them as they appear." }
}

# ------------------------------------------------------------------ 2. providers
Step 'Registering resource providers'
$wanted = [ordered]@{}
$wanted[$hosting] = @($HostingProviders)
foreach ($sub in $monitored) { $wanted[$sub] = @(@($wanted[$sub]) + $MonitoredProviders | Where-Object { $_ } | Select-Object -Unique) }
$pending = [System.Collections.Generic.List[object]]::new()
$unregistrable = [System.Collections.Generic.List[string]]::new()
foreach ($sub in $wanted.Keys) {
    try {
        $registered = @(Invoke-Az @('provider', 'list', '--subscription', $sub,
            '--query', "[?registrationState=='Registered'].namespace"))
    } catch {
        $unregistrable.Add("${sub}: $($_.Exception.Message)")
        continue
    }
    foreach ($namespace in $wanted[$sub]) {
        if ($registered -contains $namespace) { continue }
        if ($WhatIf) { Info "would register $namespace in $sub"; continue }
        try {
            Invoke-Az @('provider', 'register', '--namespace', $namespace, '--subscription', $sub) | Out-Null
            $pending.Add([pscustomobject]@{ Subscription = $sub; Namespace = $namespace })
            Info "registering  : $namespace in $sub"
        } catch {
            $unregistrable.Add("${sub}: az provider register --namespace $namespace --subscription $sub")
        }
    }
}
# Registration is asynchronous; the deployment needs the hosting ones, the app the export one.
$deadline = (Get-Date).AddMinutes(10)
while ($pending.Count -and (Get-Date) -lt $deadline) {
    foreach ($item in @($pending)) {
        $state = Invoke-Az -Raw @('provider', 'show', '--namespace', $item.Namespace, '--subscription', $item.Subscription,
            '--query', 'registrationState')
        if ($state -eq 'Registered') { [void]$pending.Remove($item) }
    }
    if ($pending.Count) { Start-Sleep -Seconds 10 }
}
foreach ($item in $pending) { Write-Warning "$($item.Namespace) is still registering in $($item.Subscription); continuing." }
if ($unregistrable.Count) {
    Write-Warning 'These registrations need someone with Contributor on the subscription (CloudLens reports the same on its Setup page):'
    foreach ($line in $unregistrable) { Write-Warning "  $line" }
}
if (-not $pending.Count -and -not $unregistrable.Count -and -not $WhatIf) { Info 'all required providers are registered' }

# ------------------------------------------------------------------ 3. deploy
Step 'Deploying CloudLens (infra/deploy.ps1)'
$deploy = [ordered]@{
    Location               = $Location
    ResourceGroup          = $ResourceGroup
    PostgresSku            = $sizing.PostgresSku
    PostgresStorageGb      = $sizing.PostgresStorageGb
    AppServicePlanSku      = $sizing.AppServicePlanSku
    # This installer creates paused exports after deployment; skip deploy.ps1's separate export step.
    SkipFocusExports       = $true
    EnableExportManagement = $true
    ManagedExports         = $true
    InitialHistoryMonths   = $InitialHistoryMonths
}
if ($target.Kind -eq 'managementGroup') { $deploy.CostScopeManagementGroup = $target.Id }
else { $deploy.CostScopeSubscriptions = @($target.Id) }
if ($EntraClientId) { $deploy.EntraClientId = $EntraClientId }
$localPassword = $null
if ($LocalSignIn) {
    $deploy.SkipEntra = $true
    $deploy.AuthAllowLocal = $true
    # A rerun keeps the administrator it created: the template owns AUTH_USERS, so passing
    # nothing would erase it, and generating a new one would silently rotate the password.
    $existing = Get-CloudLensExistingSite $ResourceGroup
    $kept = if ($existing -and -not $ResetLocalPassword) {
        Invoke-Az -Raw @('webapp', 'config', 'appsettings', 'list', '--resource-group', $ResourceGroup,
            '--name', $existing.name, '--query', "[?name=='AUTH_USERS'].value | [0]")
    } else { '' }
    if ($kept) {
        $deploy.AuthUsers = $kept
        Info 'local admin  : keeping the existing administrator (-ResetLocalPassword replaces it)'
    } elseif (-not $WhatIf) {
        $admin = New-CloudLensLocalAdmin
        $deploy.AuthUsers = $admin.AuthUsers
        $localPassword = $admin.Password
    }
}
if ($WhatIf) { $deploy.WhatIf = $true }
& (Join-Path (Join-Path $root 'infra') 'deploy.ps1') @deploy
if ($WhatIf) {
    Write-Host ''
    Write-Host 'Preview only: no provider was registered and nothing was deployed.' -ForegroundColor Yellow
    return
}

# ------------------------------------------------------------------ 4. hand-off
$site = Invoke-Az @('webapp', 'list', '--resource-group', $ResourceGroup,
    '--query', "[?tags.application=='CloudLens'].{name:name,host:defaultHostName}") | Select-Object -First 1

# Cost Management lets the app's identity *run* an export but not *create* one: the creator must
# be able to grant the export's own identity a role on the storage account (verified live, 30 Sep
# 2026: 401 RBACAccessDenied even with an unconditional role-assignment grant). So the exports are
# created here, as you, paused -- the app then adopts them and runs every month window itself.
Step 'Creating the FOCUS exports (once, as you)'
if (-not $monitored.Count) {
    Info 'no subscriptions to export yet'
} elseif (-not $site) {
    Write-Warning "The web app was not found in $ResourceGroup; exports were not created."
} else {
    try {
        & (Join-Path (Join-Path $root 'infra') 'focus-exports.ps1') -ResourceGroup $ResourceGroup `
            -WebAppName $site.name -Subscriptions $monitored -HostingSubscriptionId $hosting -Paused
    } catch {
        Write-Warning "Exports were not all created: $($_.Exception.Message)"
        Write-Warning 'CloudLens shows the exact command per subscription on its Setup progress page.'
    }
}
$elapsed = (Get-Date) - $started
Step "CloudLens is installed ($([int]$elapsed.TotalMinutes) min $($elapsed.Seconds) s)"
if ($site) {
    Write-Host "    https://$($site.host)" -ForegroundColor Green
    Info "Setup progress: https://$($site.host)/v2/admin/setup"
}
Info "Monitoring   : $($target.Path)"
Info 'First cost data usually arrives within a few hours; a brand-new export can take up to 24 h.'
if ($localPassword) {
    Write-Host ''
    Write-Host '    Sign in as   : admin' -ForegroundColor Green
    Write-Host "    Password     : $localPassword" -ForegroundColor Green
    Info 'Shown once and stored nowhere (the app holds only its hash). Keep it in a password manager;'
    Info 'rerun with -LocalSignIn -ResetLocalPassword to replace it.'
} elseif ($LocalSignIn) {
    Info 'Sign in as the existing local administrator.'
}
