"""Verify the customer release selection and integrity checks without Azure."""
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
REPO = "samy6352/cloud-lens-modern-November"


@unittest.skipUnless(PWSH, "PowerShell 7 required")
class ReleaseLauncher(unittest.TestCase):
    def run_launcher(self, *, pin=False, prerelease=False, tamper=False):
        version = "2026.11.20-pilot2" if prerelease else "2026.11.20"
        name = f"CloudLens-Customer-{version}.zip"
        with tempfile.TemporaryDirectory() as work:
            archive = Path(work) / name
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr(f"CloudLens-{version}-source.zip", b"fixture inner archive")
                bundle.writestr("Install-CloudLens.ps1", """
param($SourceSha256,[switch]$Apply,[switch]$NoToolInstall)
Write-Output "INSTALLER:$Apply,$NoToolInstall,$SourceSha256"
""")
            digest = "0" * 64 if tamper else hashlib.sha256(archive.read_bytes()).hexdigest()
            url = f"https://github.com/{REPO}/releases/download/v{version}/{name}"
            release = json.dumps({
                "draft": False, "prerelease": prerelease, "tag_name": f"v{version}",
                "assets": [{"name": name, "state": "uploaded",
                            "browser_download_url": url, "digest": f"sha256:{digest}"}],
            })
            metadata = f"https://api.github.com/repos/{REPO}/releases/"
            metadata += f"tags/v{version}" if pin else "latest"
            command = f"""
$ErrorActionPreference = 'Stop'
function Invoke-WebRequest {{
    param($Uri,$TimeoutSec,[switch]$SkipHttpErrorCheck,$OutFile)
    if ($Uri -eq '{metadata}') {{ return @{{StatusCode=200; Content='{release}'}} }}
    if ($Uri -ne '{url}') {{ throw 'Wrong asset URL' }}
    Copy-Item -LiteralPath '{str(archive).replace("'", "''")}' -Destination $OutFile
}}
& '{str(ROOT / "tools/Start-CloudLensSetup.ps1").replace("'", "''")}' {
    f"-Version '{version}' -Preview -NoToolInstall" if pin else ""
}
"""
            return subprocess.run([PWSH, "-NoProfile", "-Command", command],
                                  capture_output=True, text=True, timeout=30)

    def test_latest_stable_starts_interactive_apply(self):
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        digest = hashlib.sha256(b"fixture inner archive").hexdigest().upper()
        self.assertIn(f"INSTALLER:True,False,{digest}", result.stdout)

    def test_explicit_pilot_can_be_previewed(self):
        result = self.run_launcher(pin=True, prerelease=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("INSTALLER:False,True,", result.stdout)

    def test_stable_lookup_rejects_prerelease(self):
        result = self.run_launcher(prerelease=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unexpected release", result.stderr)
        self.assertNotIn("INSTALLER:", result.stdout)

    def test_digest_mismatch_does_not_run_installer(self):
        result = self.run_launcher(tamper=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Bundle checksum mismatch", result.stderr)
        self.assertNotIn("INSTALLER:", result.stdout)


if __name__ == "__main__":
    unittest.main()
