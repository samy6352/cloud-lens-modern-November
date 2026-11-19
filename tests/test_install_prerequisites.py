"""Rehearse tool installation without installing software or contacting Azure."""
# cloudlens-test: requires-offline
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PWSH = shutil.which("pwsh")
pytestmark = pytest.mark.skipif(not PWSH, reason="PowerShell 7 required")


@pytest.mark.parametrize("mode", ["repair", "opt-out", "install-fails", "expired-session"])
def test_missing_tools_are_repaired_or_reported_before_deployment(tmp_path, mode):
    prebuilt = tmp_path / "web/v2/index.html"
    prebuilt.parent.mkdir(parents=True)
    prebuilt.touch()
    root = str(tmp_path).replace("'", "''")
    helper = str(ROOT / "infra/install-prerequisites.ps1").replace("'", "''")
    command = rf"""
$ErrorActionPreference = 'Stop'
. '{helper}'
$global:bicepReady = $false
function az {{
    $global:LASTEXITCODE = 0
    switch ($args[0..1] -join ' ') {{
        'bicep version' {{ if (-not $global:bicepReady) {{ $global:LASTEXITCODE = 1 }} }}
        'bicep install' {{
            Write-Host 'BICEP_INSTALL'
            if ('{mode}' -eq 'install-fails') {{ $global:LASTEXITCODE = 1; return }}
            $global:bicepReady = $true
        }}
        'account get-access-token' {{ $global:LASTEXITCODE = 1 }}
        default {{ throw "Unexpected CLI command: $args" }}
    }}
}}
$global:pythonReady = $false
function Find-CloudLensPython {{ if ($global:pythonReady) {{ return 'fixture-python' }} }}
function Install-CloudLensWindowsTool {{
    param($Name, $PackageId, $ManualUrl, [switch]$NoToolInstall)
    if ($Name -ne 'Python 3.11+' -or $NoToolInstall) {{ throw 'Unexpected installation' }}
    Write-Host "WINDOWS_INSTALL:$PackageId"
    $global:pythonReady = $true
}}
function Test-CloudLensNode {{ throw 'A source bundle with built UI must not need Node.js' }}
try {{
    if ('{mode}' -eq 'expired-session') {{
        Connect-CloudLensAzure -NonInteractive
    }} else {{
        $tools = Initialize-CloudLensBuildTools -SourceRoot '{root}' -NoToolInstall:('{mode}' -eq 'opt-out')
        Write-Output "READY:$($tools.Python):$($tools.SkipUiBuild)"
    }}
}} catch {{ Write-Output $_.Exception.Message; exit 1 }}
"""
    result = subprocess.run([PWSH, "-NoProfile", "-Command", command],
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    if mode == "repair":
        assert result.returncode == 0, result.stdout + result.stderr
        assert "BICEP_INSTALL" in result.stdout
        assert "WINDOWS_INSTALL:Python.Python.3.13" in result.stdout
        assert "READY:fixture-python:True" in result.stdout
    else:
        assert result.returncode == 1, result.stdout + result.stderr
        assert "WINDOWS_INSTALL" not in result.stdout
        if mode == "opt-out":
            assert "BICEP_INSTALL" not in result.stdout
            assert "Bicep is required" in result.stdout
        elif mode == "install-fails":
            assert "Bicep installation failed" in result.stdout
        else:
            assert "No usable Azure CLI session" in result.stdout
