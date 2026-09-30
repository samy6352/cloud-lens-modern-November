"""infra/install.ps1: the two-line Cloud Shell installer, against a fake Azure CLI (S3).

`az` is a PowerShell function that answers from a fixture and records every call, so nothing
here touches Azure. `deploy.ps1` is a stub that reports exactly the parameters it was given --
`test_every_parameter_the_installer_passes_exists_on_the_real_deploy_script` pins those to the
real script's signature, so the stub cannot drift from it.
"""
# cloudlens-test: requires-offline
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("pwsh")
HOST = "11111111-1111-4111-8111-111111111111"
OTHER = "99999999-9999-4999-8999-999999999999"
S1, S2, S3 = (f"{n}{n}{n}{n}{n}{n}{n}{n}-0000-4000-8000-00000000000{n}" for n in (5, 6, 7))
TENANT = "22222222-2222-4222-8222-222222222222"
FOREIGN = "33333333-3333-4333-8333-333333333333"
GROUP = "finance"
HOSTING = ["Microsoft.Web", "Microsoft.DBforPostgreSQL", "Microsoft.Storage", "Microsoft.Network",
           "Microsoft.ManagedIdentity", "Microsoft.OperationalInsights", "Microsoft.Insights",
           "Microsoft.CognitiveServices"]
DESCENDANTS = ("https://management.azure.com/providers/Microsoft.Management/managementGroups/"
               f"{GROUP}/descendants?api-version=2020-05-01")

MOCK = r"""
function global:Start-Sleep {}
function global:az {
    $global:LASTEXITCODE = 0
    $flat = @($args | ForEach-Object { $_ })
    $call = $flat -join ' '
    $calls.Add($call)
    function arg([string]$name) {
        $index = [array]::IndexOf($flat, $name)
        if ($index -ge 0) { return $flat[$index + 1] }
        return ''
    }
    $sub = arg '--subscription'
    if ($call.StartsWith('account show')) {
        if (-not $sub) { $sub = $fixture.host }
        return (ConvertTo-Json -Depth 10 -InputObject $fixture.accounts[$sub])
    }
    if ($call.StartsWith('account management-group show')) {
        return (ConvertTo-Json -Depth 10 -InputObject $fixture.groups[(arg '--name')])
    }
    if ($call.StartsWith('rest --method get')) {
        return (ConvertTo-Json -Depth 10 -InputObject $fixture.pages[(arg '--url')])
    }
    if ($call.StartsWith('provider list')) {
        return (ConvertTo-Json -InputObject @($fixture.registered[$sub]))
    }
    if ($call.StartsWith('provider register')) {
        if ($fixture.denied -contains $sub) {
            Write-Error 'AuthorizationFailed: cannot register providers' -ErrorAction Continue
            $global:LASTEXITCODE = 1
            return
        }
        $writes.Add($call)
        return '{}'
    }
    if ($call.StartsWith('provider show')) { return 'Registered' }
    if ($call.StartsWith('webapp list')) {
        return '[{"name":"cloudlens-web-abc","host":"cloudlens-web-abc.azurewebsites.net"}]'
    }
    throw "Unexpected Azure call; never invoke real Azure: $call"
}
"""

STUB_DEPLOY = r"""
[CmdletBinding()]
param(
    [string]$Location, [string]$ResourceGroup, [string]$PostgresSku, [int]$PostgresStorageGb,
    [string]$AppServicePlanSku, [switch]$SkipFocusExports, [switch]$EnableExportManagement,
    [bool]$ManagedExports, [string[]]$CostScopeSubscriptions, [string]$CostScopeManagementGroup,
    [string]$EntraClientId, [switch]$SkipEntra, [bool]$AuthAllowLocal, [switch]$WhatIf
)
$bound = [ordered]@{}
foreach ($key in $PSBoundParameters.Keys) {
    $value = $PSBoundParameters[$key]
    # Assigned inside each branch: an `if` expression would unroll a one-element array.
    if ($value -is [System.Management.Automation.SwitchParameter]) { $bound[$key] = $value.IsPresent }
    else { $bound[$key] = $value }
}
Write-Output ('DEPLOY:' + (ConvertTo-Json -Compress -Depth 5 -InputObject $bound))
"""


def _account(sub, name, tenant=TENANT):
    return {"id": sub, "name": name, "tenantId": tenant, "state": "Enabled"}


def fixture():
    account = _account
    return {
        "host": HOST,
        "accounts": {HOST: account(HOST, "Hosting"), OTHER: account(OTHER, "Monitored"),
                     FOREIGN: account(FOREIGN, "Elsewhere", tenant=FOREIGN)},
        "groups": {GROUP: {"name": GROUP, "displayName": "Finance", "tenantId": TENANT}},
        "pages": {
            DESCENDANTS: {"value": [
                {"name": S1, "type": "Microsoft.Management/managementGroups/subscriptions"},
                {"name": "finance-emea", "type": "Microsoft.Management/managementGroups"},
            ], "nextLink": DESCENDANTS + "&$skiptoken=2"},
            DESCENDANTS + "&$skiptoken=2": {"value": [
                {"name": S2, "type": "Microsoft.Management/managementGroups/subscriptions"},
                {"name": S3, "type": "Microsoft.Management/managementGroups/subscriptions"},
            ]},
        },
        # The hosting subscription already has most providers; monitored ones have none.
        "registered": {HOST: [*HOSTING[:6], "Microsoft.CostManagement"], OTHER: [], S1: [],
                       S2: ["Microsoft.CostManagement", "Microsoft.CostManagementExports"], S3: []},
        "denied": [],
    }


@unittest.skipUnless(POWERSHELL, "PowerShell 7 (pwsh) is required for installer checks")
class Installer(unittest.TestCase):
    def setUp(self):
        (ROOT / ".pytest_cache").mkdir(exist_ok=True)
        self.work = tempfile.TemporaryDirectory(dir=ROOT / ".pytest_cache", ignore_cleanup_errors=True)
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name) / "cloudlens"
        (self.root / "app").mkdir(parents=True)
        (self.root / "infra").mkdir()
        (self.root / "app" / "main.py").write_text("", encoding="utf-8")
        shutil.copy(ROOT / "infra" / "install.ps1", self.root / "infra" / "install.ps1")
        (self.root / "infra" / "deploy.ps1").write_text(STUB_DEPLOY, encoding="utf-8")

    def install(self, options="", data=None, script=None):
        data = data or fixture()
        script = str(script or self.root / "infra" / "install.ps1").replace("'", "''")
        literal = json.dumps(data).replace("'", "''")
        command = f"""
$ErrorActionPreference = 'Stop'
$fixture = ConvertFrom-Json -AsHashtable '{literal}'
$calls = [Collections.Generic.List[string]]::new()
$writes = [Collections.Generic.List[string]]::new()
{MOCK}
try {{
    & '{script}' -Location centralindia {options} 6>&1 | ForEach-Object {{ "$_" }}
    $code = 0
}} catch {{
    Write-Output ('FAILURE:' + $_.Exception.Message)
    $code = 1
}}
Write-Output ('RESULT:' + (ConvertTo-Json -Compress -Depth 10 -InputObject @{{calls=@($calls);writes=@($writes)}}))
exit $code
"""
        result = subprocess.run([POWERSHELL, "-NoProfile", "-Command", command],
                                capture_output=True, text=True, timeout=120)
        lines = result.stdout.splitlines()
        recorded = json.loads(next((line[7:] for line in lines if line.startswith("RESULT:")), "{}"))
        deploy = next((json.loads(line[7:]) for line in lines if line.startswith("DEPLOY:")), None)
        return result, recorded, deploy

    def registered(self, recorded):
        return sorted((c.split("--namespace ")[1].split()[0], c.split("--subscription ")[1].split()[0])
                      for c in recorded["writes"])

    def test_default_install_monitors_the_current_subscription_with_managed_exports(self):
        result, recorded, deploy = self.install()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(deploy, {
            "Location": "centralindia", "ResourceGroup": "rg-cloudlens",
            "PostgresSku": "Standard_D2ds_v5", "PostgresStorageGb": 128, "AppServicePlanSku": "B2",
            "SkipFocusExports": True, "EnableExportManagement": True, "ManagedExports": True,
            "CostScopeSubscriptions": [HOST]})
        # Only what is missing: two hosting providers and the export provider.
        self.assertEqual(self.registered(recorded), sorted([
            ("Microsoft.Insights", HOST), ("Microsoft.CognitiveServices", HOST),
            ("Microsoft.CostManagementExports", HOST)]))
        self.assertIn("https://cloudlens-web-abc.azurewebsites.net", result.stdout)
        self.assertIn("/v2/admin/setup", result.stdout)

    def test_management_group_scope_pages_descendants_and_grants_once_at_the_group(self):
        result, recorded, deploy = self.install(
            f"-Scope /providers/Microsoft.Management/managementGroups/{GROUP} -Size large")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(deploy["CostScopeManagementGroup"], GROUP)
        self.assertNotIn("CostScopeSubscriptions", deploy)
        self.assertEqual((deploy["PostgresSku"], deploy["PostgresStorageGb"]), ("Standard_E4ds_v5", 256))
        exports = [sub for ns, sub in self.registered(recorded) if ns == "Microsoft.CostManagementExports"]
        self.assertEqual(sorted(exports), sorted([S1, S3]))  # S2 already had it; the nested MG is not a sub
        self.assertIn(("Microsoft.CostManagement", S1), self.registered(recorded))
        self.assertIn("3 subscription(s) today", result.stdout)

    def test_subscription_scope_accepts_both_spellings(self):
        for scope in (OTHER, f"/subscriptions/{OTHER}/"):
            with self.subTest(scope=scope):
                result, recorded, deploy = self.install(f"-Scope {scope} -Size small")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(deploy["CostScopeSubscriptions"], [OTHER])
                self.assertEqual((deploy["AppServicePlanSku"], deploy["PostgresStorageGb"]), ("B1", 64))
                self.assertIn(("Microsoft.CostManagementExports", OTHER), self.registered(recorded))

    def test_invalid_or_foreign_scope_is_refused_before_any_change(self):
        for scope, message in (("rg-something", "-Scope must be"),
                               (FOREIGN, "in another tenant")):
            with self.subTest(scope=scope):
                result, recorded, deploy = self.install(f"-Scope {scope}")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stdout)
                self.assertEqual(recorded["writes"], [])
                self.assertIsNone(deploy)

    def test_whatif_registers_nothing_and_previews_the_deployment(self):
        result, recorded, deploy = self.install("-WhatIf")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(recorded["writes"], [])
        self.assertTrue(deploy["WhatIf"])
        self.assertIn("would register Microsoft.CostManagementExports", result.stdout)
        self.assertIn("Preview only", result.stdout)
        self.assertFalse(any(c.startswith("webapp list") for c in recorded["calls"]))

    def test_rerun_with_everything_registered_writes_nothing(self):
        data = fixture()
        data["registered"][HOST] = [*HOSTING, "Microsoft.CostManagement", "Microsoft.CostManagementExports"]
        result, recorded, deploy = self.install(data=data)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(recorded["writes"], [])
        self.assertIn("all required providers are registered", result.stdout)
        self.assertTrue(deploy["ManagedExports"])

    def test_a_subscription_the_installer_cannot_register_is_reported_not_fatal(self):
        data = fixture()
        data["denied"] = [S3]
        result, _, deploy = self.install(
            f"-Scope /providers/Microsoft.Management/managementGroups/{GROUP}", data=data)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIsNotNone(deploy)
        self.assertIn(f"az provider register --namespace Microsoft.CostManagementExports --subscription {S3}",
                      result.stdout + result.stderr)

    def test_local_sign_in_and_existing_registration_are_passed_through(self):
        result, _, deploy = self.install("-LocalSignIn")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(deploy["SkipEntra"] and deploy["AuthAllowLocal"])
        self.assertIn("az webapp log tail", result.stdout)
        _, _, deploy = self.install("-EntraClientId 55555555-5555-4555-8555-555555555555")
        self.assertEqual(deploy["EntraClientId"], "55555555-5555-4555-8555-555555555555")
        self.assertNotIn("SkipEntra", deploy)

    def test_outside_a_checkout_it_needs_a_source_and_touches_nothing(self):
        lonely = Path(self.work.name) / "elsewhere"
        lonely.mkdir()
        shutil.copy(ROOT / "infra" / "install.ps1", lonely / "install.ps1")
        result, recorded, deploy = self.install(script=lonely / "install.ps1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("-Source", result.stdout)
        self.assertEqual(recorded["calls"], [])
        self.assertIsNone(deploy)

    def test_every_parameter_the_installer_passes_exists_on_the_real_deploy_script(self):
        passed = {}
        for options in ("", f"-Scope /providers/Microsoft.Management/managementGroups/{GROUP}",
                        "-LocalSignIn -WhatIf", "-EntraClientId 55555555-5555-4555-8555-555555555555"):
            _, _, deploy = self.install(options)
            for key, value in deploy.items():
                passed[key] = type(value).__name__
        script = str(ROOT / "infra" / "deploy.ps1").replace("'", "''")
        probe = subprocess.run([POWERSHELL, "-NoProfile", "-Command", f"""
$command = Get-Command '{script}'
$command.Parameters.Values | ForEach-Object {{ $_.Name + '=' + $_.ParameterType.Name }}
"""], capture_output=True, text=True, timeout=60)
        real = dict(line.split("=", 1) for line in probe.stdout.splitlines() if "=" in line)
        for key, kind in passed.items():
            self.assertIn(key, real, f"install.ps1 passes -{key}, which deploy.ps1 does not declare")
            if kind == "bool" and real[key] == "SwitchParameter":
                continue
            if real[key] == "Boolean":
                self.assertEqual(kind, "bool", key)


if __name__ == "__main__":
    unittest.main()
