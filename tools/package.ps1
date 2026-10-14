<#
.SYNOPSIS
    Build an App Service ZIP, or an installer source ZIP, without local state.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Destination,
    [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
    # Defaults to whichever of python / python3 exists: Azure Cloud Shell has only python3.
    [string]$Python = '',
    # Package the web/v2 build already on disk instead of running npm (for example in CI, where
    # the UI was built in an earlier step).
    [switch]$SkipUiBuild,
    # Installer source includes infra/, buildable ui/ and the tested web/v2 assets.
    # It is not a ZIP to send directly to App Service.
    [switch]$InstallerSource,
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Python) {
    $Python = @('python', 'python3') | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue } |
        Select-Object -First 1
    if (-not $Python) { throw 'Python 3 was not found (tried python and python3); pass -Python <path>.' }
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = (Get-Item -LiteralPath $SourceRoot).FullName.TrimEnd('\', '/')
if ($InstallerSource -and $Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
    throw 'Installer source needs -Version <reviewed release label or commit SHA>.'
}
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) {
    throw "Destination already exists: $destinationPath"
}

# The v3 interface (ui/) is built into web/v2, which is git-ignored, so a package made from a clean
# checkout would otherwise ship without it. Built here, before files are collected, so the output
# goes through exactly the same filtering and reference checks as the rest of web/.
$ui = Join-Path $root 'ui'
$hasUi = Test-Path -LiteralPath (Join-Path $ui 'package.json') -PathType Leaf
$builtUi = $false
if ($hasUi -and -not $SkipUiBuild) {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        # Not fatal while the classic interface at / is still the product: /v2 answers with an
        # explanation instead. Failing here would stop a deployment after its infrastructure exists.
        Write-Warning 'Node.js (npm) was not found, so the v3 preview interface at /v2 was not rebuilt. Install Node.js 20+ to include it.'
    } else {
        Push-Location -LiteralPath $ui
        try {
            & npm ci --no-audit --no-fund --loglevel=error
            if ($LASTEXITCODE -ne 0) { throw 'npm ci failed for ui/.' }
            & npm run build --silent
            if ($LASTEXITCODE -ne 0) { throw 'The v3 interface (ui/) failed to build.' }
            $builtUi = $true
        } finally {
            Pop-Location
        }
    }
}
$files = [System.Collections.Generic.List[object]]::new()
$allowedWeb = @('.html', '.js', '.css', '.svg', '.png', '.ico', '.woff', '.woff2', '.ttf')
foreach ($directory in @('app', 'web')) {
    $base = Join-Path $root $directory
    if (-not (Test-Path -LiteralPath $base -PathType Container)) {
        throw "Package source is missing $directory."
    }
    foreach ($folder in @((Get-Item -LiteralPath $base)) + @(Get-ChildItem -LiteralPath $base -Recurse -Directory -Force)) {
        if ($folder.LinkType -in @('SymbolicLink', 'Junction')) {
            throw "Refusing a linked package directory: $($folder.FullName)"
        }
    }
    foreach ($file in Get-ChildItem -LiteralPath $base -Recurse -File -Force) {
        $relative = $file.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
        if ($relative -match '(^|/)(\.|__pycache__|node_modules|tests/)' -or
            $relative -match '\.(test|spec)\.js$') { continue }
        if (($directory -eq 'app' -and $file.Extension -ne '.py') -or
            ($directory -eq 'web' -and $file.Extension -notin $allowedWeb)) { continue }
        if ($file.LinkType -in @('SymbolicLink', 'Junction')) {
            throw "Refusing a linked package file: $relative"
        }
        $files.Add([pscustomobject]@{ Path = $relative; Source = $file.FullName; Size = $file.Length })
    }
}
$requirements = Join-Path $root 'requirements.txt'
if (-not (Test-Path -LiteralPath $requirements -PathType Leaf)) {
    throw 'Package source is missing requirements.txt.'
}
if ((Get-Item -LiteralPath $requirements).LinkType -in @('SymbolicLink', 'Junction')) {
    throw 'Refusing linked requirements.txt.'
}
$files.Add([pscustomobject]@{
    Path = 'requirements.txt'; Source = $requirements; Size = (Get-Item -LiteralPath $requirements).Length
})
$paths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($file in $files) { $paths.Add($file.Path) | Out-Null }
$requiredFiles = @('app/__init__.py', 'app/main.py', 'web/login.html', 'web/assets/app.css')
if ($builtUi -or $InstallerSource) { $requiredFiles += 'web/v2/index.html' }
if ($InstallerSource) {
    $sourceFiles = @(
        'README.md', 'Cloudlens-Documentation.Md', '.env.example',
        'requirements.in', 'requirements-dev.txt', 'pyproject.toml',
        'ingest.py', 'verify_warehouse.py',
        'tools/package.ps1', 'tools/validate_package.py', 'tools/verify_package.py', 'tools/start_local.py',
        'infra/README.md', 'infra/install.ps1', 'infra/deploy.ps1',
        'infra/preflight.ps1', 'infra/deployment-checks.ps1',
        'infra/cost-access.ps1', 'infra/storage-naming.ps1',
        'infra/focus-exports.ps1', 'infra/grant-cost-access.ps1',
        'infra/main.bicep', 'infra/bicepconfig.json',
        'infra/modules/identity.bicep', 'infra/modules/postgres-admin.bicep',
        'infra/modules/stack.bicep', 'infra/sql/create-app-role.sql',
        'ui/package.json', 'ui/package-lock.json', 'ui/index.html',
        'ui/tsconfig.json', 'ui/vite.config.ts',
        'ui/public/favicon.svg', 'ui/public/theme.js'
    )
    $uiSource = Join-Path $ui 'src'
    if (-not (Test-Path -LiteralPath $uiSource -PathType Container)) {
        throw 'Installer source is missing ui/src.'
    }
    foreach ($folder in @((Get-Item -LiteralPath $uiSource)) + @(Get-ChildItem -LiteralPath $uiSource -Recurse -Directory -Force)) {
        if ($folder.LinkType -in @('SymbolicLink', 'Junction')) {
            throw "Refusing a linked source directory: $($folder.FullName)"
        }
    }
    foreach ($file in Get-ChildItem -LiteralPath $uiSource -Recurse -File -Force) {
        $relative = $file.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
        if ($relative -match '(^|/)(\.|__pycache__|node_modules|tests/)' -or
            $relative -match '\.(test|spec)\.[cm]?[jt]sx?$' -or
            $file.Extension -notin @('.ts', '.tsx', '.js', '.jsx', '.css', '.svg', '.png', '.ico', '.woff', '.woff2', '.ttf')) { continue }
        $sourceFiles += $relative
    }
    foreach ($relative in $sourceFiles) {
        $source = Join-Path $root $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Installer source is missing $relative."
        }
        $item = Get-Item -LiteralPath $source
        if ($item.LinkType -in @('SymbolicLink', 'Junction')) {
            throw "Refusing a linked source file: $relative"
        }
        # A file can look ordinary while a parent directory is a junction.
        $parent = $item.Directory
        while ($parent -and $parent.FullName.Length -ge $root.Length) {
            if ($parent.LinkType -in @('SymbolicLink', 'Junction')) {
                throw "Refusing a linked source directory: $($parent.FullName)"
            }
            $parent = $parent.Parent
        }
        $files.Add([pscustomobject]@{ Path = $relative; Source = $source; Size = $item.Length })
        $paths.Add($relative) | Out-Null
    }
    $requiredFiles += @('ui/src/main.tsx', 'ui/src/styles.css')
}
foreach ($required in $requiredFiles) {
    if (-not $paths.Contains($required)) { throw "Package is missing $required." }
}

# Validate local module imports before writing any archive, including untracked lazy views.
$imports = '(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["''](?<path>\.{1,2}/[^"'']+)["'']'
foreach ($file in $files | Where-Object { $_.Path.EndsWith('.js') }) {
    $source = [string](Get-Content -LiteralPath $file.Source -Raw)
    foreach ($match in [regex]::Matches($source, $imports)) {
        $module = ($match.Groups['path'].Value -split '[?#]', 2)[0]
        $absolute = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $file.Source) $module))
        if (-not $absolute.StartsWith($root + [IO.Path]::DirectorySeparatorChar,
                                      [StringComparison]::OrdinalIgnoreCase)) {
            throw "Module import escapes the package: $($file.Path) -> $module"
        }
        $relative = $absolute.Substring($root.Length).TrimStart('\', '/').Replace('\', '/')
        if (-not $paths.Contains($relative)) {
            throw "Missing imported module: $($file.Path) -> $module"
        }
    }
}

# Parse source only: packaging must not initialize the warehouse or read local configuration.
$validation = Join-Path $PSScriptRoot 'validate_package.py'
@($files.Path | Where-Object { $_ -like 'app/*' -or $_ -like 'web/*' }) |
    ConvertTo-Json -Compress | & $Python $validation $root
if ($LASTEXITCODE -ne 0) { throw 'Package source validation failed.' }

$manifest = [ordered]@{
    application = 'CloudLens'
    kind = $(if ($InstallerSource) { 'installer-source' } else { 'app-service-runtime' })
    version = $Version
    createdUtc = [DateTime]::UtcNow.ToString('o')
    files = @($files | Sort-Object Path | ForEach-Object {
        [ordered]@{ path = $_.Path; bytes = $_.Size; sha256 = (Get-FileHash -LiteralPath $_.Source -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destinationPath)) | Out-Null
$stream = [IO.File]::Open($destinationPath, [IO.FileMode]::CreateNew)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in $files | Sort-Object Path) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $file.Source, $file.Path, [IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
    $entry = $archive.CreateEntry('release-manifest.json')
    $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
    try { $writer.Write(($manifest | ConvertTo-Json -Depth 5)) } finally { $writer.Dispose() }
} catch {
    $archive.Dispose()
    $stream.Dispose()
    Remove-Item -LiteralPath $destinationPath -Force
    throw
} finally {
    $archive.Dispose()
    $stream.Dispose()
}
[pscustomobject]@{
    Path = $destinationPath
    Files = $files.Count
    Bytes = (Get-Item -LiteralPath $destinationPath).Length
    Sha256 = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
}
