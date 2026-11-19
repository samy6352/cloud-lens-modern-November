function Get-CloudLensIpv4Range([string]$Cidr) {
    if ($Cidr -notmatch '^(\d{1,3}(?:\.\d{1,3}){3})/(\d{1,2})$') {
        throw "Invalid IPv4 CIDR: $Cidr"
    }
    $prefix = [int]$Matches[2]
    $octets = @($Matches[1].Split('.') | ForEach-Object { [int]$_ })
    if ($prefix -gt 32 -or @($octets | Where-Object { $_ -gt 255 }).Count) {
        throw "Invalid IPv4 CIDR: $Cidr"
    }
    $address = [uint64]0
    foreach ($octet in $octets) { $address = $address * 256 + $octet }
    $size = [uint64][math]::Pow(2, 32 - $prefix)
    $start = [uint64]([math]::Floor($address / $size) * $size)
    if ($start -ne $address) { throw "CIDR must start at its network address: $Cidr" }
    return @{ Start = $start; End = $start + $size - 1 }
}

function Test-CloudLensIpv4Overlap([string]$Left, [string]$Right) {
    $a = Get-CloudLensIpv4Range $Left
    $b = Get-CloudLensIpv4Range $Right
    return $a.Start -le $b.End -and $b.Start -le $a.End
}

function Get-CloudLensPostgresTier([string]$Sku) {
    if ($Sku -match '^Standard_B') { return 'Burstable' }
    if ($Sku -match '^Standard_E') { return 'MemoryOptimized' }
    return 'GeneralPurpose'
}

function Get-CloudLensModelQuota($Models, $Usages, [string]$ModelName, [string]$Sku, [int]$Capacity) {
    $names = @($Models | Where-Object { $_.model.name -eq $ModelName } |
        ForEach-Object { $_.model.skus } |
        Where-Object { $_.name -eq $Sku -and $_.usageName -and $_.usageName -notmatch 'finetune' } |
        ForEach-Object { $_.usageName } | Select-Object -Unique)
    $matches = @($Usages | Where-Object { $_.name.value -in $names })
    if ($matches.Count -ne 1 -or $null -eq $matches[0].limit -or $null -eq $matches[0].currentValue) {
        return @{ Status = 'unknown'; Message = 'Exact model quota could not be resolved; catalogue availability is not a quota guarantee.' }
    }

    $quota = $matches[0]
    $remaining = [double]$quota.limit - [double]$quota.currentValue
    $status = if ($quota.limit -lt 0) { 'unknown' } elseif ($remaining -lt $Capacity) { 'blocked' } else { 'ok' }
    return @{ Status = $status; Name = $quota.name.value; Remaining = $remaining
        Message = "$($quota.name.value): $($quota.currentValue) used of $($quota.limit); requesting $Capacity capacity units." }
}

function Wait-CloudLensApplication {
    param(
        [Parameter(Mandatory)][string]$BaseUrl,
        [string]$ExpectedReleaseId = '',
        [ValidateRange(1, 3600)][int]$TimeoutSeconds = 600,
        [ValidateRange(1, 120)][int]$Attempts = 40
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $ready = $false
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $remaining = [int][math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds)
        if ($remaining -le 0) { break }
        try {
            $readiness = Invoke-RestMethod -Uri "$BaseUrl/readyz" -TimeoutSec ([math]::Min(20, $remaining))
            if ($readiness.status -eq 'ready') {
                if ($ExpectedReleaseId) {
                    $release = Invoke-RestMethod -Uri "$BaseUrl/release.json" -TimeoutSec ([math]::Min(20, $remaining))
                    if ($release.releaseId -cne $ExpectedReleaseId) {
                        Write-Verbose 'The running process has not activated the expected release.'
                    } else { $ready = $true; break }
                } else { $ready = $true; break }
            }
        } catch {
            Write-Verbose "Readiness check $attempt failed: $($_.Exception.Message)"
            if ($attempt % 3 -eq 1) { Write-Host ("    waiting for the app to start (check {0}; the first start can take a few minutes)" -f $attempt) }
        }
        $remaining = [int][math]::Floor(($deadline - [DateTime]::UtcNow).TotalSeconds)
        if ($attempt -lt $Attempts -and $remaining -gt 0) {
            Start-Sleep -Seconds ([math]::Min(15, $remaining))
        }
    }
    if (-not $ready) {
        throw "The app did not become ready with the expected running release within $TimeoutSeconds seconds. Check application startup, release activation and PostgreSQL connectivity/schema."
    }

    # Do not follow a login redirect and mistake its 200 response for anonymous access.
    try {
        $response = Invoke-WebRequest -Uri $BaseUrl -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 20 -ErrorAction Stop
        $status = [int]$response.StatusCode
    } catch {
        if (-not $_.Exception.Response) { throw }
        $status = [int]$_.Exception.Response.StatusCode
    }
    if ($status -notin @(401, 302, 303, 307)) {
        throw "/ returned $status without an authentication challenge. Verify sign-in settings before hand-off."
    }
}

function Get-CloudLensScmHost([string]$WebAppUrl) {
    <# The Kudu host: first DNS label + ".scm." -- also right for regional default hostnames. #>
    return ([uri]$WebAppUrl).Host -replace '^([^.]+)\.', '$1.scm.'
}

function Publish-CloudLensPackage {
    param(
        [Parameter(Mandatory)][string]$ScmHost,
        [Parameter(Mandatory)][string]$PackagePath
    )
    $token = az account get-access-token --resource 'https://management.core.windows.net/' `
        --query accessToken -o tsv --only-show-errors
    if ($LASTEXITCODE -ne 0 -or -not $token) { throw 'Could not obtain an ARM token for package publication.' }
    $deployer = "cloudlens-$([guid]::NewGuid().ToString('N'))"
    $headers = @{ Authorization = "Bearer $token" }
    try {
        $response = Invoke-WebRequest -Method Post `
            -Uri "https://$ScmHost/api/zipdeploy?isAsync=true&deployer=$deployer" `
            -Headers $headers -ContentType 'application/zip' -InFile $PackagePath `
            -MaximumRedirection 0 -TimeoutSec 600
        $location = [string](@($response.Headers.Location)[0])
        $receipt = [uri]::new([uri]"https://$ScmHost", $location)
        if ($response.StatusCode -ne 202 -or -not $location -or $receipt.Scheme -ne 'https' -or
            $receipt.Host -ine $ScmHost -or -not $receipt.AbsolutePath.StartsWith('/api/deployments/')) {
            throw 'Upload did not return a valid same-site deployment receipt. Publication state is unknown; inspect SCM before retrying.'
        }
        return [pscustomobject]@{ ReceiptUrl = $receipt.AbsoluteUri; Deployer = $deployer }
    } finally { $token = $null; $headers.Clear() }
}

function Get-CloudLensNewestDeployment([string]$ScmHost) {
    <# The newest real App Service deployment record, or $null. "temp-*" records are placeholders. #>
    $raw = az rest --method get --url "https://$ScmHost/api/deployments" `
        --resource 'https://management.core.windows.net/' -o json 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    return @($raw | ConvertFrom-Json) |
        Where-Object { $_.id -and -not ([string]$_.id).StartsWith('temp-') } |
        Sort-Object { [string]$_.start_time } -Descending | Select-Object -First 1
}

function Wait-CloudLensDeployment {
    <#
    .SYNOPSIS
        Follow one App Service ZIP deployment to its real outcome.

    .DESCRIPTION
        The first Python build on a small plan takes longer than the publish gateway waits, so a
        synchronous `az webapp deploy` reports "504 GatewayTimeout" for a deployment that goes on
        to succeed (measured: B1, build 8 min, 30 Sep 2026). A timeout is an unknown state, not a
        failure. This follows the upload's receipt, accepts only its unique deployer correlation,
        then binds the actual deployment ID until success (status 4) or failure (status 3).
        Unreadable/unmatched receipts remain unknown states, never another release's success.
    #>
    param(
        [Parameter(Mandatory)][string]$ScmHost,
        [Parameter(Mandatory)][string]$ReceiptUrl,
        [Parameter(Mandatory)][string]$Deployer,
        [ValidateRange(10, 7200)][int]$TimeoutSeconds = 1800,
        [ValidateRange(10, 3600)][int]$AppearSeconds = 300,
        [ValidateRange(1, 1000)][int]$MaxAttempts = 180,
        [ValidateRange(1, 120)][int]$PollSeconds = 20
    )
    $started = [DateTime]::UtcNow
    $deadline = $started.AddSeconds($TimeoutSeconds)
    $seen = $null
    $deploymentId = ''
    $receipt = [uri]$ReceiptUrl
    if ($receipt.Scheme -ne 'https' -or $receipt.Host -ine $ScmHost -or
        -not $receipt.AbsolutePath.StartsWith('/api/deployments/') -or $Deployer -notmatch '^cloudlens-[a-f0-9]{32}$') {
        throw 'Invalid upload receipt or deployment correlation.'
    }
    for ($attempt = 0; $attempt -lt $MaxAttempts -and [DateTime]::UtcNow -lt $deadline; $attempt++) {
        $url = if ($deploymentId) { "https://$ScmHost/api/deployments/$deploymentId" } else { $ReceiptUrl }
        # Windows az.cmd can split the receipt's &time= query before reaching --resource.
        # Keep the opaque receipt intact by sending it through PowerShell's HTTP client.
        $token = az account get-access-token --resource 'https://management.core.windows.net/' `
            --query accessToken -o tsv --only-show-errors
        if ($LASTEXITCODE -ne 0 -or -not $token) { throw 'Could not obtain an ARM token for deployment polling.' }
        $headers = @{ Authorization = "Bearer $token" }
        try {
            $latest = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 60
        } catch {
            throw "Cannot read this upload's receipt. Publication state is unknown; inspect $url before retrying. $($_.Exception.Message)"
        } finally { $token = $null; $headers.Clear() }
        if ($latest -and $latest.deployer -ceq $Deployer -and $latest.id -match '^[A-Za-z0-9_-]+$' -and
            -not ([string]$latest.id).StartsWith('temp-')) {
            if ($deploymentId -and $latest.id -cne $deploymentId) { throw 'SCM returned a different deployment ID; refusing to infer success.' }
            $deploymentId = [string]$latest.id
            $seen = $latest
            if ([int]$latest.status -eq 4 -and $latest.complete) { return $latest }
            if ([int]$latest.status -eq 3) {
                throw "App Service deployment $($latest.id) failed. Its log: https://$ScmHost/api/deployments/$($latest.id)/log"
            }
            Write-Host ("    [{0:00}:{1:00}] building     : status {2} {3}" -f [int][math]::Floor(([DateTime]::UtcNow - $started).TotalMinutes), ([DateTime]::UtcNow - $started).Seconds, $latest.status, $latest.progress)
        } elseif (([DateTime]::UtcNow - $started).TotalSeconds -gt $AppearSeconds) {
            throw "This upload's correlated deployment did not appear within $AppearSeconds seconds; publication state is unknown."
        }
        Start-Sleep -Seconds $PollSeconds
    }
    $which = if ($seen) { "Deployment $($seen.id) is still at status $($seen.status)" } else { 'No new deployment was seen' }
    throw "$which after $TimeoutSeconds seconds. Its state is unknown, not failed: inspect https://$ScmHost/api/deployments before retrying."
}
