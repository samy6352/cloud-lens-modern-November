"""Customer launcher checks against fake Azure and installer scripts; no cloud writes."""
# cloudlens-test: requires-offline
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PWSH = shutil.which("pwsh")
SUB = "11111111-1111-4111-8111-111111111111"
ORIGINAL = "99999999-9999-4999-8999-999999999999"

INSTALL = r"""
param(
    [string]$Location, [string]$AiLocation, [string]$ResourceGroup,
    [string]$EntraAppUniqueName, [string]$NamePrefix, [string]$NameSuffix, [string]$Scope,
    [string]$Size, [int]$InitialHistoryMonths, [string]$EntraClientId,
    [switch]$AppIdentityOnly, [switch]$WhatIf
)
$record = @{}
foreach ($key in $PSBoundParameters.Keys) {
    $value = $PSBoundParameters[$key]
    if ($value -is [Management.Automation.SwitchParameter]) { $value = $value.IsPresent }
    $record[$key] = $value
}
$global:installs.Add($record)
# Deployment helpers intentionally accept absent optional response properties.
$optionalResponse = [pscustomobject]@{}
$null = $optionalResponse.optionalProperty
if ($global:failApply -and -not $WhatIf) { throw 'simulated deployment error' }
"""

PREFLIGHT = r"""
param(
    [string]$Location, [string]$AiLocation, [string]$ResourceGroup,
    [string[]]$CostScopeSubscriptions, [string]$PostgresSku, [string]$AppServicePlanSku,
    [switch]$AppIdentityOnly
)
$global:checks.Add(@{
    Location=$Location; AiLocation=$AiLocation; Subscriptions=$CostScopeSubscriptions
    PostgresSku=$PostgresSku; AppServicePlanSku=$AppServicePlanSku
})
exit $global:preflightCode
"""


@unittest.skipUnless(PWSH, "PowerShell 7 required")
class EwbInstaller(unittest.TestCase):
    def run_launcher(self, options="", *, answers=(), exists=False, blocked=False,
                     fail_apply=False, signed_in=True, fail_cli=False, strict_parent=False,
                     real_install=False):
        fixture = json.dumps({
            "answers": answers, "exists": exists, "blocked": blocked,
            "failApply": fail_apply, "signedIn": signed_in, "failCli": fail_cli,
        }).replace("'", "''")
        with tempfile.TemporaryDirectory() as work:
            infra = Path(work) / "infra"
            infra.mkdir()
            shutil.copy(ROOT / "infra" / "install-ewb.ps1", infra)
            (infra / "install.ps1").write_text(INSTALL, encoding="utf-8")
            (infra / "preflight.ps1").write_text(PREFLIGHT, encoding="utf-8")
            (infra / "deploy.ps1").write_text("", encoding="utf-8")
            if real_install:
                shutil.copy(ROOT / "infra" / "install.ps1", infra)
                (infra.parent / "app").mkdir()
                (infra.parent / "app" / "main.py").write_text("")
                (infra / "deploy.ps1").write_text("throw 'REAL_INSTALL_VALIDATION_PASSED'")
            script = str(infra / "install-ewb.ps1").replace("'", "''")
            command = f"""
$ErrorActionPreference = 'Stop'
$global:fixture = ConvertFrom-Json -AsHashtable '{fixture}'
$global:answers = [Collections.Generic.Queue[string]]::new()
foreach ($answer in $fixture.answers) {{ $answers.Enqueue($answer) }}
$global:calls = [Collections.Generic.List[string]]::new()
$global:checks = [Collections.Generic.List[object]]::new()
$global:installs = [Collections.Generic.List[object]]::new()
$global:current = '{ORIGINAL}'
$global:preflightCode = [int]$fixture.blocked
$global:failApply = $fixture.failApply
function global:Read-Host {{ return $global:answers.Dequeue() }}
function global:az {{
    $global:LASTEXITCODE = 0
    $call = $args -join ' '
    $global:calls.Add($call)
    if ($fixture.failCli) {{ $global:LASTEXITCODE = 1; return }}
    if ($call.StartsWith('account list')) {{
        if ($fixture.signedIn) {{ return '[{{"id":"{ORIGINAL}"}}]' }}
        return '[]'
    }}
    if ($call.StartsWith('login')) {{ return '[]' }}
    if ($call.StartsWith('account set')) {{
        $global:current = $args[[array]::IndexOf($args, '--subscription') + 1]
        return
    }}
    if ($call.StartsWith('account show')) {{
        return (ConvertTo-Json @{{id=$global:current; state='Enabled'; name='EWB customer'; tenantId='test-tenant'}})
    }}
    if ($call.StartsWith('group exists')) {{ return $fixture.exists.ToString().ToLowerInvariant() }}
    if ($call.StartsWith('provider list')) {{
        return '["Microsoft.Web","Microsoft.DBforPostgreSQL","Microsoft.Storage","Microsoft.Network","Microsoft.ManagedIdentity","Microsoft.OperationalInsights","Microsoft.Insights","Microsoft.CognitiveServices","Microsoft.CostManagement","Microsoft.CostManagementExports"]'
    }}
    throw "Unexpected Azure command: $call"
}}
{"Set-StrictMode -Version Latest" if strict_parent else ""}
try {{
    & '{script}' {options} 6>&1 | ForEach-Object {{ "$_" }}
    $code = 0
}} catch {{
    Write-Output ('FAILURE:' + $_.Exception.Message)
    $code = 1
}}
Write-Output ('RESULT:' + (ConvertTo-Json -Compress -Depth 10 @{{
    calls=@($calls); checks=@($checks); installs=@($installs); current=$current
}}))
exit $code
"""
            result = subprocess.run(
                [PWSH, "-NoProfile", "-Command", command],
                capture_output=True, text=True, timeout=60,
            )
        record = next(line[7:] for line in result.stdout.splitlines() if line.startswith("RESULT:"))
        return result, json.loads(record)

    def test_default_is_offline_and_contains_no_customer_identifiers(self):
        result, record = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(record["calls"], [])
        self.assertEqual(record["installs"], [])
        source = (ROOT / "infra" / "install-ewb.ps1").read_text(encoding="utf-8")
        import re
        self.assertEqual(re.findall(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", source), [])

    def test_check_prompts_for_id_and_restores_account(self):
        result, record = self.run_launcher("-Check", answers=[SUB])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(record["checks"][0]["Subscriptions"], [SUB])
        self.assertEqual(record["installs"], [])
        self.assertEqual(record["current"], ORIGINAL)

    def test_install_checks_previews_then_applies_with_customer_scope(self):
        result, record = self.run_launcher("-Install", answers=[SUB, f"INSTALL {SUB}"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(record["checks"]), 1)
        preview, apply = record["installs"]
        self.assertTrue(preview.pop("WhatIf"))
        self.assertEqual(preview, apply)
        self.assertEqual(apply["Scope"], SUB)
        self.assertEqual(apply["ResourceGroup"], "rg-cloudlens-ewb")
        self.assertEqual(apply["EntraAppUniqueName"], "rg-cloudlens-ewb")
        self.assertEqual(apply["NamePrefix"], "ewbcloudlens")
        self.assertLessEqual(len(apply["NamePrefix"]), 12)
        self.assertEqual(apply["InitialHistoryMonths"], 3)
        self.assertTrue(apply["AppIdentityOnly"])
        self.assertRegex(apply["NameSuffix"], r"^[a-f0-9]{10}$")
        self.assertEqual(record["current"], ORIGINAL)

    def test_real_installer_accepts_wrapper_naming_before_deployment(self):
        result, record = self.run_launcher(
            f"-Preview -SubscriptionId {SUB}", real_install=True)
        self.assertIn("REAL_INSTALL_VALIDATION_PASSED", result.stdout + result.stderr)
        self.assertNotIn("Provide -NameSuffix", result.stdout + result.stderr)
        self.assertEqual(record["current"], ORIGINAL)

    def test_suffix_is_stable_across_resume_and_customizable(self):
        _, first = self.run_launcher(f"-Preview -SubscriptionId {SUB}")
        _, resumed = self.run_launcher(f"-Preview -SubscriptionId {SUB} -Resume", exists=True)
        self.assertEqual(first["installs"][0]["NameSuffix"], resumed["installs"][0]["NameSuffix"])
        result, custom = self.run_launcher(f"-Preview -SubscriptionId {SUB} -NameSuffix bank-prod")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(custom["installs"][0]["NameSuffix"], "bank-prod")

    def test_preview_and_overrides_are_forwarded(self):
        result, record = self.run_launcher(
            f"-Preview -SubscriptionId {SUB} -Location malaysiawest -AiLocation swedencentral "
            f"-Size large -InitialHistoryMonths 1 -EntraClientId {SUB}")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(record["installs"]), 1)
        self.assertTrue(record["installs"][0]["WhatIf"])
        self.assertEqual(record["installs"][0]["AiLocation"], "swedencentral")
        self.assertEqual(record["installs"][0]["EntraClientId"], SUB)
        self.assertEqual(record["checks"][0]["PostgresSku"], "Standard_E4ds_v5")

    def test_launcher_does_not_impose_strict_mode_on_existing_helpers(self):
        result, record = self.run_launcher(f"-Preview -SubscriptionId {SUB}", strict_parent=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(record["installs"]), 1)

    def test_refused_confirmation_never_applies(self):
        result, record = self.run_launcher(
            f"-Install -SubscriptionId {SUB}", answers=["no"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Approval not supplied", result.stdout)
        self.assertEqual(len(record["installs"]), 1)
        self.assertTrue(record["installs"][0]["WhatIf"])
        self.assertEqual(record["current"], ORIGINAL)

    def test_blocker_or_existing_group_stops_before_preview(self):
        for kwargs, message in (({"blocked": True}, "blockers"),
                                ({"exists": True}, "already exists")):
            with self.subTest(kwargs=kwargs):
                result, record = self.run_launcher(f"-Install -SubscriptionId {SUB}", **kwargs)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stdout)
                self.assertEqual(record["installs"], [])
                self.assertEqual(record["current"], ORIGINAL)

    def test_resume_is_explicit_and_cli_login_is_supported(self):
        result, record = self.run_launcher(
            f"-Preview -SubscriptionId {SUB} -Resume", exists=True, signed_in=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(any(call.startswith("login") for call in record["calls"]))
        self.assertEqual(len(record["installs"]), 1)

    def test_apply_failure_propagates_and_restores_account(self):
        result, record = self.run_launcher(
            f"-Install -SubscriptionId {SUB}", answers=[f"INSTALL {SUB}"], fail_apply=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("simulated deployment error", result.stdout)
        self.assertEqual(record["current"], ORIGINAL)

    def test_invalid_id_and_cli_errors_fail_without_deployment(self):
        for options, kwargs in (("-Check -SubscriptionId invalid", {}),
                                (f"-Check -SubscriptionId {SUB}", {"fail_cli": True})):
            with self.subTest(options=options):
                result, record = self.run_launcher(options, **kwargs)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(record["installs"], [])
                self.assertEqual(record["checks"], [])


if __name__ == "__main__":
    unittest.main()
