#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][guid]$TenantId,
    [string]$DisplayName = 'CloudLens',
    [uri]$CallbackUri
)

$ErrorActionPreference = 'Stop'
if ($CallbackUri -and (-not $CallbackUri.IsAbsoluteUri -or $CallbackUri.Scheme -ne 'https' -or
    $CallbackUri.AbsolutePath -cne '/auth/callback' -or $CallbackUri.Query -or
    $CallbackUri.Fragment -or $CallbackUri.UserInfo)) {
    throw 'CallbackUri must be https://<cloudlens-host>/auth/callback.'
}

$activeTenant = az account show --query tenantId -o tsv --only-show-errors
if ($LASTEXITCODE -ne 0 -or $activeTenant -ne $TenantId.ToString()) {
    throw "Sign in to the customer tenant first: az login --tenant $TenantId --allow-no-subscriptions"
}

$escapedName = $DisplayName.Replace("'", "''")
$existing = az ad app list --filter "displayName eq '$escapedName'" --query '[].appId' -o tsv --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Could not check for existing app registrations.' }
if ($existing) {
    throw "Registration '$DisplayName' already exists. Review the existing registration before reusing its Application (client) ID; this script does not modify it."
}
if (-not $PSCmdlet.ShouldProcess("$DisplayName in tenant $TenantId", 'Create CloudLens app registration and enterprise application')) { return }

$scopes = @(
    '37f7f235-527c-4136-accd-4a02d197296e' # openid
    '14dad69e-099b-42c9-810b-d002981feec1' # profile
    '7427e0e9-2fba-42fe-b0c0-848c9e6a8182' # offline_access
    'e1fe6dd8-ba31-4d61-89e7-88639da4683d' # User.Read
)
$permissions = @(@{
    resourceAppId = '00000003-0000-0000-c000-000000000000'
    resourceAccess = @($scopes | ForEach-Object { @{ id = $_; type = 'Scope' } })
})
$manifest = New-TemporaryFile
try {
    ConvertTo-Json -InputObject $permissions -Depth 4 -Compress | Set-Content -LiteralPath $manifest.FullName -Encoding utf8
    $arguments = @('ad', 'app', 'create', '--display-name', $DisplayName,
        '--sign-in-audience', 'AzureADMyOrg', '--is-fallback-public-client', 'true',
        '--required-resource-accesses', "@$($manifest.FullName)", '--only-show-errors', '--query', 'appId', '-o', 'tsv')
    if ($CallbackUri) { $arguments += @('--public-client-redirect-uris', $CallbackUri.AbsoluteUri) }
    $clientId = az @arguments
    if ($LASTEXITCODE -ne 0 -or -not $clientId) { throw 'Entra app registration creation failed.' }
} finally {
    Remove-Item -LiteralPath $manifest.FullName
}

$enterpriseAppId = az ad sp create --id $clientId --only-show-errors --query id -o tsv
if ($LASTEXITCODE -ne 0 -or -not $enterpriseAppId) {
    throw "App registration $clientId exists, but enterprise application creation failed. Check Enterprise applications for that client ID before retrying only 'az ad sp create --id $clientId'."
}

[pscustomobject]@{
    TenantId = $TenantId
    EntraClientId = $clientId
    EnterpriseApplicationObjectId = $enterpriseAppId
    CallbackUri = $CallbackUri
}
