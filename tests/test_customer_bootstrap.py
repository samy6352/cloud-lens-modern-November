"""Rehearse release download and extraction without network or Azure access."""
# cloudlens-test: requires-offline
import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PWSH = shutil.which("pwsh")
SUB = "11111111-1111-4111-8111-111111111111"
ORIGINAL = "99999999-9999-4999-8999-999999999999"


@unittest.skipUnless(PWSH, "PowerShell 7 required")
class CustomerBootstrap(unittest.TestCase):
    def run_bootstrap(self, *, bad_hash=False, unsafe=False, approve=True, exists=False,
                      cloud_exists=False, resume=False, preview=False, blocked=False,
                      pipeline=False, offline=False, missing_hash=False, download_fail=False,
                      explicit_options=False):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            archive = root / "fixture.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("app/main.py", "")
                bundle.writestr("infra/install.ps1", """
param(
    [string]$Location,
    [string]$AiLocation,
    [switch]$AppIdentityOnly,
    [string]$SubscriptionId,
    [string]$Scope,
    [string]$ResourceGroup,
    [string]$EntraAppUniqueName,
    [string]$Size,
    [int]$InitialHistoryMonths,
    [string]$NamePrefix,
    [string]$NameSuffix,
    [switch]$NonInteractive,
    [switch]$WhatIf
)
if ($SubscriptionId -ne $Scope -or $ResourceGroup -ne $EntraAppUniqueName) { throw 'Target drift' }
Write-Output "INSTALLED:$Location,$AiLocation,$AppIdentityOnly,preview=$WhatIf,scope=$Scope,group=$ResourceGroup"
Write-Output "OPTIONS:$Size,history=$InitialHistoryMonths,prefix=$NamePrefix,suffix=$NameSuffix"
""")
                bundle.writestr("infra/deploy.ps1", """
param(
    [switch]$AppIdentityOnly
)
""")
                bundle.writestr("infra/preflight.ps1", """
param($Location,$AiLocation,$ResourceGroup,$CostScopeSubscriptions,$PostgresSku,$AppServicePlanSku,[switch]$AppIdentityOnly)
Write-Output 'CHECKED'
exit $global:preflightCode
""")
                if unsafe:
                    bundle.writestr("../escaped.txt", "must not extract")
            digest = "0" * 64 if bad_hash else hashlib.sha256(archive.read_bytes()).hexdigest()
            checksum = root / "fixture.sha"
            checksum.write_text(f"{digest}  CloudLens-2026.11.12-rc5-source.zip\n")
            target = root / "deployment"
            if exists:
                target.mkdir()
            fixture = json.dumps({
                "zip": str(archive), "sha": str(checksum), "destination": str(target),
                "script": str(ROOT / "tools/install-customer.ps1"),
                "approval": f"INSTALL {SUB} rg-customer" if approve else "NO",
                "cloudExists": cloud_exists, "blocked": blocked,
                "downloadFail": download_fail,
            }).replace("'", "''")
            options = ("-Resume " if resume else "") + ("-Preview " if preview else "")
            if offline:
                options += "-SourceZip $f.zip "
                if not missing_hash:
                    options += f"-SourceSha256 '{digest}' "
            if explicit_options:
                options += (f"-Location southeastasia -AiLocation eastus2 -SubscriptionId '{SUB}' "
                            f"-Scope '{SUB}' -ResourceGroup rg-customer -Size small -InitialHistoryMonths 1 "
                            "-NamePrefix cl -NameSuffix fixture ")
            elif not pipeline:
                options += (f"-Location southeastasia -AiLocation eastus2 -SubscriptionId '{SUB}' "
                            f"-Scope '{SUB}' -ResourceGroup rg-customer -Size small -InitialHistoryMonths 1 "
                            "-NamePrefix cl -NameSuffix t1 ")
            if approve and not preview and not pipeline:
                options += "-Approve "

            if pipeline:
                answers = [
                    "1",  # hosting subscription
                    "1",  # sizing profile
                    "1",  # initial history
                    "3",  # app region: southeastasia
                    "1",  # AI region: eastus2
                    "2",  # scope: hosting subscription only
                    "1",  # resource group naming mode: recommended
                    "1",  # resource naming mode: generated
                    "1" if approve else "2",  # proceed / cancel
                ]
            elif approve:
                answers = []
            else:
                answers = ["2"]  # cancel at final approval prompt
            answers_literal = ",".join("'" + answer.replace("'", "''") + "'" for answer in answers)
            command = f"""
$ErrorActionPreference = 'Stop'
$f = ConvertFrom-Json '{fixture}'
$global:downloads = [Collections.Generic.List[string]]::new()
$global:answers = [Collections.Generic.Queue[string]]::new()
foreach ($answer in @({answers_literal})) {{ $answers.Enqueue($answer) }}
$global:current = '{ORIGINAL}'
$global:preflightCode = [int]$f.blocked
function az {{
    $global:LASTEXITCODE = 0
    $call = $args -join ' '
    if ($call.StartsWith('account show')) {{ return (ConvertTo-Json @{{id=$global:current;state='Enabled';name='Customer';tenantId='fixture'}}) }}
    if ($call.StartsWith('account list')) {{
        return (ConvertTo-Json @(
            @{{name='Current';id=$global:current;tenantId='fixture';isDefault=$true;state='Enabled'}},
            @{{name='Target';id='{SUB}';tenantId='fixture';isDefault=$false;state='Enabled'}}
        ))
    }}
    if ($call.StartsWith('account set')) {{ $global:current=$args[[array]::IndexOf($args,'--subscription')+1]; return }}
    if ($call.StartsWith('group exists')) {{ return $f.cloudExists.ToString().ToLowerInvariant() }}
    throw "Unexpected cloud command: $call"
}}
function Invoke-WebRequest {{
    param($Uri, $OutFile)
    $downloads.Add($Uri)
    if ($f.downloadFail) {{ throw 'HTTP 404' }}
    Copy-Item -LiteralPath $(if ($Uri.EndsWith('.zip')) {{ $f.zip }} else {{ $f.sha }}) -Destination $OutFile
}}
function Read-Host {{ return $answers.Dequeue() }}
function Join-Path {{
    param($Path,$ChildPath)
    if ($ChildPath.StartsWith('CloudLens\\')) {{ return $f.destination }}
    Microsoft.PowerShell.Management\\Join-Path $Path $ChildPath
}}
try {{
    {"Get-Content -LiteralPath $f.script -Raw | Invoke-Expression" if pipeline else
     "& $f.script -Destination $f.destination " + options}
    $code = 0
}} catch {{
    Write-Output ('FAILURE:' + $_.Exception.Message)
    $code = 1
}}
Write-Output ('DOWNLOADS:' + $downloads.Count)
Write-Output ('CURRENT:' + $global:current)
exit $code
"""
            result = subprocess.run(
                [PWSH, "-NoProfile", "-Command", command],
                capture_output=True, text=True, timeout=60,
            )
            self.assertFalse((root / "escaped.txt").exists())
            return result

    def test_downloads_extracts_and_uses_approved_identity_mode(self):
        result = self.run_bootstrap()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("INSTALLED:southeastasia,eastus2,True", result.stdout)
        self.assertIn("DOWNLOADS:2", result.stdout)
        self.assertIn("preview=True", result.stdout)
        self.assertIn("preview=False", result.stdout)
        self.assertIn("CURRENT:" + ORIGINAL, result.stdout)

    def test_documented_powershell_pipeline_runs_the_full_bootstrap(self):
        result = self.run_bootstrap(pipeline=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("preview=False", result.stdout)
        self.assertIn("group=rg-cloudlens-", result.stdout)

    def test_offline_candidate_uses_the_same_verified_install_path(self):
        result = self.run_bootstrap(offline=True, explicit_options=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("DOWNLOADS:0", result.stdout)
        self.assertIn("OPTIONS:small,history=1,prefix=cl,suffix=fixture", result.stdout)
        self.assertIn("preview=True", result.stdout)
        self.assertIn("preview=False", result.stdout)
        self.assertIn("CURRENT:" + ORIGINAL, result.stdout)

    def test_offline_archive_requires_an_independent_hash(self):
        result = self.run_bootstrap(offline=True, missing_hash=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("separately supplied", result.stdout)
        self.assertIn("DOWNLOADS:0", result.stdout)
        self.assertNotIn("INSTALLED:", result.stdout)

    def test_unpublished_release_is_an_actionable_failure(self):
        result = self.run_bootstrap(download_fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Verify repository/release accessibility", result.stdout)
        self.assertNotIn("INSTALLED:", result.stdout)

    def test_bad_checksum_stops_before_installer(self):
        result = self.run_bootstrap(bad_hash=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SHA-256 mismatch", result.stdout)
        self.assertNotIn("INSTALLED:", result.stdout)

    def test_unsafe_archive_stops_before_extraction(self):
        result = self.run_bootstrap(unsafe=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unsafe archive entry", result.stdout)
        self.assertNotIn("INSTALLED:", result.stdout)

    def test_confirmation_is_required(self):
        result = self.run_bootstrap(approve=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Installation not approved", result.stdout)
        self.assertIn("preview=True", result.stdout)
        self.assertNotIn("preview=False", result.stdout)

    def test_existing_destination_is_never_overwritten(self):
        result = self.run_bootstrap(exists=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Destination already exists", result.stdout)
        self.assertIn("DOWNLOADS:0", result.stdout)

    def test_existing_cloud_group_requires_explicit_resume(self):
        result = self.run_bootstrap(cloud_exists=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exists. Use a new name", result.stdout)
        self.assertNotIn("INSTALLED:", result.stdout)
        resumed = self.run_bootstrap(cloud_exists=True, resume=True)
        self.assertEqual(resumed.returncode, 0, resumed.stdout + resumed.stderr)

    def test_preview_and_preflight_blockers_never_apply(self):
        result = self.run_bootstrap(preview=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("preview=True", result.stdout)
        self.assertNotIn("preview=False", result.stdout)
        blocked = self.run_bootstrap(blocked=True)
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn("blockers", blocked.stdout)
        self.assertNotIn("INSTALLED:", blocked.stdout)


if __name__ == "__main__":
    unittest.main()
