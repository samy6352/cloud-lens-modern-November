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
    def test_restricted_language_stops_before_packaging_or_download(self):
        for path in ("tools/preview-install.ps1", "tools/install-customer.ps1",
                     "web/install/bootstrap.ps1", "infra/install.ps1"):
            with self.subTest(path=path):
                script = str(ROOT / path).replace("'", "''")
                result = subprocess.run(
                    [PWSH, "-NoProfile", "-Command",
                     "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; "
                     f"& '{script}'"],
                    capture_output=True, text=True, timeout=30,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("requires PowerShell 7 in FullLanguage mode", result.stderr)
                self.assertNotIn("Verify the source archive", result.stdout)

    def run_bootstrap(self, *, bad_hash=False, unsafe=False, approve=True, exists=False,
                      cloud_exists=False, resume=False, preview=False, blocked=False,
                      pipeline=False, offline=False, missing_hash=False, download_fail=False,
                      explicit_options=False, preview_exit=0, restore_failed=False,
                      many_subscriptions=False, retry_preview=False, back_from_entra=False,
                      custom_network=False, hong_kong=False, browse_all=False,
                      monitor_all=False, manual_regions=False):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            archive = root / "fixture.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("app/main.py", "")
                bundle.write(ROOT / "infra/install-prerequisites.ps1", "infra/install-prerequisites.ps1")
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
    [string]$VnetAddressPrefix,
    [string]$AppSubnetAddressPrefix,
    [string]$PostgresSubnetAddressPrefix,
    [string]$PrivateEndpointSubnetAddressPrefix,
    [switch]$NonInteractive,
    [switch]$WhatIf
)
# Kind = 'all'
if (($SubscriptionId -ne $Scope -and (-not $f.monitorAll -or $Scope -ne 'all')) -or
    $ResourceGroup -ne $EntraAppUniqueName) { throw 'Target drift' }
Write-Output "INSTALLED:$Location,$AiLocation,$AppIdentityOnly,preview=$WhatIf,scope=$Scope,group=$ResourceGroup"
Write-Output "OPTIONS:$Size,history=$InitialHistoryMonths,prefix=$NamePrefix,suffix=$NameSuffix"
if ($VnetAddressPrefix) {
    Write-Output "NETWORK:$VnetAddressPrefix,$AppSubnetAddressPrefix,$PostgresSubnetAddressPrefix,$PrivateEndpointSubnetAddressPrefix"
}
if ($WhatIf -and $f.previewExit -and (-not $f.retryPreview -or -not $global:previewAttempted)) {
    $global:previewAttempted = $true
    exit $f.previewExit
}
""")
                bundle.writestr("infra/deploy.ps1", """
param(
    [switch]$AppIdentityOnly
)
""")
                bundle.writestr("infra/preflight.ps1", """
param($Location,$AiLocation,$ResourceGroup,$CostScopeSubscriptions,$PostgresSku,$AppServicePlanSku,[switch]$AppIdentityOnly,$VnetAddressPrefix)
Write-Output 'CHECKED'
if ($VnetAddressPrefix) { Write-Output "PREFLIGHT_NETWORK:$VnetAddressPrefix" }
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
                "downloadFail": download_fail, "previewExit": preview_exit,
                "restoreFailed": restore_failed,
                "manySubscriptions": many_subscriptions,
                "retryPreview": retry_preview,
                "monitorAll": monitor_all,
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
            if not pipeline:
                options += "-SignInAppMode create-during-deploy -RuntimeAccessMode managed-identity "
            if custom_network:
                options += ("-VnetAddressPrefix 10.91.0.0/16 -AppSubnetAddressPrefix 10.91.1.0/24 "
                            "-PostgresSubnetAddressPrefix 10.91.2.0/24 -PrivateEndpointSubnetAddressPrefix 10.91.3.0/24 ")
            if approve and not preview and not pipeline:
                options += "-Approve "

            if pipeline:
                answers = [
                    "?",  # explain the subscription choice without consuming it
                    "1",  # hosting subscription
                    "2" if monitor_all else "",  # monitoring scope
                    "1",  # sizing profile
                    "1",  # initial history
                    "3" if hong_kong else "",  # app region
                    "2" if hong_kong else "",  # AI region
                    "1",  # runtime: managed identity
                    "2",  # sign-in: create registration
                    "1",  # resource group naming mode: recommended
                    "1",  # resource naming mode: generated
                    "1" if approve else "2",  # proceed / cancel
                ]
                if back_from_entra:
                    answers[8:9] = ["1", "not-a-guid", "", "2"]
                if manual_regions:
                    answers[5:7] = ["10", "not-a-region", "AustraliaEast", "5", "", "5", "japaneast"]
                if browse_all:
                    answers[:2] = [":list", "n", "p", "", SUB, "1"]
                elif many_subscriptions:
                    answers[:2] = ["sandbox", "n", "", "not present", SUB, "1"]
            elif approve:
                answers = []
            else:
                answers = ["?", ""]  # read approval guidance, then cancel with Enter
            if retry_preview:
                answers = ["1"]  # retry What-If; the preview flag prevents provisioning
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
    if ($call -match '^(version|account get-access-token)\\b') {{ return }}
    if ($call.StartsWith('account show')) {{ return (ConvertTo-Json @{{id=$global:current;state='Enabled';name='Customer';tenantId='fixture'}}) }}
    if ($call.StartsWith('account list-locations')) {{ return '["australiaeast","japaneast"]' }}
    if ($call.StartsWith('account list')) {{
        $subscriptions = @(
            @{{name='Current';id='{ORIGINAL}';tenantId='other-tenant';isDefault=$true;state='Enabled'}},
            @{{name='Target';id='{SUB}';tenantId='fixture';isDefault=$false;state='Enabled'}}
        )
        if ($f.manySubscriptions) {{
            $subscriptions += @(1..97 | ForEach-Object {{
                @{{name="Sandbox fixture $_";id=[guid]::NewGuid().ToString();tenantId='fixture';isDefault=$false;state='Enabled'}}
            }})
        }}
        return (ConvertTo-Json -InputObject $subscriptions)
    }}
    if ($call.StartsWith('account set')) {{
        $target = $args[[array]::IndexOf($args,'--subscription')+1]
        if ($target -eq '{ORIGINAL}' -and $f.restoreFailed) {{ $global:LASTEXITCODE = 1; return }}
        $global:current = $target
        return
    }}
    if ($call.StartsWith('group exists')) {{ return $f.cloudExists.ToString().ToLowerInvariant() }}
    throw "Unexpected cloud command: $call"
}}
function Invoke-WebRequest {{
    param($Uri, $OutFile, $TimeoutSec)
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
        self.assertIn("This subscription hosts the infrastructure", result.stdout)
        self.assertIn("Hosting subscription only", result.stdout)
        self.assertIn("managed-identity (requested)", result.stdout)
        self.assertLess(result.stdout.index("[5/6] Review"), result.stdout.index("[6/6] Provision"))

    def test_offline_candidate_uses_the_same_verified_install_path(self):
        result = self.run_bootstrap(offline=True, explicit_options=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("DOWNLOADS:0", result.stdout)
        self.assertIn("OPTIONS:small,history=1,prefix=cl,suffix=fixture", result.stdout)
        self.assertIn("preview=True", result.stdout)
        self.assertIn("preview=False", result.stdout)
        self.assertIn("CURRENT:" + ORIGINAL, result.stdout)

    def test_large_subscription_search_pages_results(self):
        result = self.run_bootstrap(pipeline=True, many_subscriptions=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("99 enabled subscriptions", result.stdout)
        self.assertIn("Subscriptions 1-8 of 97", result.stdout)
        self.assertIn("Subscriptions 9-16 of 97", result.stdout)
        self.assertIn("No enabled subscription matches", result.stdout)
        self.assertNotIn("Subscriptions 89-96", result.stdout)
        self.assertIn(f"scope={SUB}", result.stdout)

    def test_invalid_entra_client_id_can_be_corrected_or_backed_out(self):
        result = self.run_bootstrap(pipeline=True, back_from_entra=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Enter the Application (client) ID", result.stdout)
        self.assertEqual(result.stdout.count("How should CloudLens users sign in?"), 2)
        self.assertIn("create-during-deploy", result.stdout)

    def test_customer_network_is_used_by_preflight_preview_and_apply(self):
        result = self.run_bootstrap(custom_network=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PREFLIGHT_NETWORK:10.91.0.0/16", result.stdout)
        self.assertEqual(result.stdout.count("NETWORK:10.91.0.0/16,10.91.1.0/24,10.91.2.0/24,10.91.3.0/24"), 2)

    def test_hong_kong_menu_selects_eastasia_for_the_app(self):
        result = self.run_bootstrap(pipeline=True, hong_kong=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("East Asia - Hong Kong (eastasia)", result.stdout)
        self.assertIn("INSTALLED:eastasia,eastus2,True,preview=True", result.stdout)

    def test_browse_all_subscriptions_and_monitor_all_from_the_start(self):
        result = self.run_bootstrap(pipeline=True, many_subscriptions=True, browse_all=True, monitor_all=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.count("Subscriptions 1-8 of 99"), 2)
        self.assertIn("Subscriptions 9-16 of 99", result.stdout)
        self.assertLess(result.stdout.index("Which subscriptions should CloudLens monitor?"),
                        result.stdout.index("Select sizing profile"))
        self.assertIn("All 98 visible enabled subscriptions in this tenant", result.stdout)
        self.assertIn("INSTALLED:southeastasia,southeastasia,True,preview=True,scope=all", result.stdout)

    def test_manual_regions_are_validated_and_passed_to_the_installer(self):
        result = self.run_bootstrap(pipeline=True, manual_regions=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Enter a region code listed for this subscription", result.stdout)
        self.assertIn("INSTALLED:australiaeast,japaneast,True,preview=True", result.stdout)

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
        self.assertIn("DOWNLOADS:1", result.stdout)
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
        self.assertIn("pressing Enter cancels", result.stdout)
        self.assertNotIn("[6/6]", result.stdout)
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
        self.assertIn("Preview complete", result.stdout)
        self.assertIn("[5/5] Review", result.stdout)
        self.assertNotIn("> Install", result.stdout)
        self.assertNotIn("preview=False", result.stdout)
        blocked = self.run_bootstrap(blocked=True)
        self.assertNotEqual(blocked.returncode, 0)
        self.assertIn("blockers", blocked.stdout)
        self.assertNotIn("INSTALLED:", blocked.stdout)

    def test_preview_failure_blocks_apply_even_if_subscription_restore_fails(self):
        result = self.run_bootstrap(preview_exit=7, restore_failed=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Deployment preview failed", result.stdout)
        self.assertIn("Could not restore the previous Azure CLI subscription", result.stdout)
        self.assertNotIn("preview=False", result.stdout)
        self.assertNotIn("Retry What-If with the same settings", result.stdout)

    def test_interactive_retry_reuses_target_and_never_provisions_in_preview_mode(self):
        result = self.run_bootstrap(preview=True, preview_exit=7, retry_preview=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Retry What-If with the same settings", result.stdout)
        self.assertEqual(result.stdout.count(f"preview=True,scope={SUB},group=rg-customer"), 2)
        self.assertIn("Preview complete", result.stdout)
        self.assertNotIn("preview=False", result.stdout)


if __name__ == "__main__":
    unittest.main()
