"""Exercise customer packaging from a source directory without Git or Azure access."""
# cloudlens-test: requires-offline
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")


@unittest.skipUnless(POWERSHELL, "PowerShell is required for deployment packaging")
class Packaging(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / ".pytest_cache", ignore_cleanup_errors=True)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "source"
        self.archive = Path(self.temp.name) / "application.zip"
        for name, content in {
            "requirements.txt": "fastapi>=0.115.0\n",
            "app/__init__.py": "",
            "app/main.py": "from . import billing\n",
            "app/billing.py": "VALUE = 1\n",
            "web/index.html": "<html></html>",
            "web/login.html": "<html></html>",
            "web/assets/app.js": "export const value = 1;",
            "web/assets/app.css": "body { color: inherit; }",
            "web/assets/dashboard.js": 'import {value} from "./app.js"; import("./dashboard-billing.js");',
            "web/assets/dashboard-billing.js": "export const ready = true;",
            ".env": "AUTH_PASSWORD=must-not-ship",
            ".localdata/.session_secret": "must-not-ship",
            "data/users.json": '{"must-not-ship":true}',
            "sample.csv": "must-not-ship",
            "pyproject.toml": "[project]",
            "tests/test_example.py": "must-not-ship",
            "app/__pycache__/main.py": "must-not-ship",
            "web/assets/.local/private.js": "must-not-ship",
        }.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")

    def package(self, *options):
        return subprocess.run(
            [POWERSHELL, "-NoProfile", "-File", str(ROOT / "tools" / "package.ps1"),
             "-SourceRoot", str(self.root), "-Destination", str(self.archive),
             "-Python", sys.executable, *options],
            capture_output=True, text=True, timeout=60,
        )

    def verify_archive(self, kind, version=""):
        result = subprocess.run(
            [sys.executable, str(ROOT / "tools/verify_package.py"), str(self.archive),
             "--kind", kind, "--version", version],
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_includes_untracked_modules_excludes_state_and_records_hashes(self):
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        with zipfile.ZipFile(self.archive) as archive:
            names = set(archive.namelist())
            self.assertIn("app/billing.py", names)
            self.assertIn("web/assets/dashboard-billing.js", names)
            self.assertIn("release-manifest.json", names)
            self.assertEqual(len(names), 11)
            for name in names:
                self.assertNotIn(b"must-not-ship", archive.read(name))
            manifest = json.loads(archive.read("release-manifest.json"))
            for entry in manifest["files"]:
                content = archive.read(entry["path"])
                self.assertEqual(entry["sha256"], hashlib.sha256(content).hexdigest())
                self.assertEqual(entry["bytes"], len(content))
        self.verify_archive("app-service-runtime")

    def test_missing_lazy_module_refuses_package(self):
        (self.root / "web/assets/dashboard-billing.js").unlink()
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Missing imported module", result.stdout + result.stderr)
        self.assertFalse(self.archive.exists())

    def test_import_case_is_checked_for_linux(self):
        (self.root / "web/assets/dashboard.js").write_text('import("./Dashboard-billing.js");', encoding="utf-8")
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Missing imported module", result.stdout + result.stderr)

    def test_existing_destination_is_not_overwritten(self):
        self.archive.write_bytes(b"keep existing artifact")
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.archive.read_bytes(), b"keep existing artifact")

    def test_missing_python_module_refuses_package_without_importing_app(self):
        (self.root / "app/billing.py").unlink()
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Missing Python module", result.stdout + result.stderr)
        self.assertFalse(self.archive.exists())

    def test_invalid_python_syntax_refuses_package(self):
        (self.root / "app/main.py").write_text("def invalid(\n", encoding="utf-8")
        result = self.package()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Package source validation failed", result.stdout + result.stderr)
        self.assertFalse(self.archive.exists())

    def test_missing_html_asset_and_css_font_refuse_package(self):
        for name, content in (
            ("web/index.html", '<script type="module" src="/assets/missing.js"></script>'),
            ("web/assets/app.css", '@font-face { src: url("missing.woff2"); }'),
        ):
            path = self.root / name
            original = path.read_text(encoding="utf-8")
            path.write_text(content, encoding="utf-8")
            with self.subTest(name=name):
                result = self.package()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Missing web asset", result.stdout + result.stderr)
                self.assertFalse(self.archive.exists())
            path.write_text(original, encoding="utf-8")

    def test_javascript_import_fragments_do_not_change_the_file_name(self):
        (self.root / "web/assets/dashboard.js").write_text(
            'import("./dashboard-billing.js#version");', encoding="utf-8")
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def source_fixture(self):
        for name in (
            "README.md", "Cloudlens-Documentation.Md", ".env.example",
            "requirements.in", "requirements-dev.txt", "pyproject.toml",
            "ingest.py", "verify_warehouse.py",
            "tools/package.ps1", "tools/validate_package.py", "tools/verify_package.py", "tools/start_local.py", "infra/README.md",
            "infra/install.ps1", "infra/deploy.ps1", "infra/preflight.ps1",
            "infra/deployment-checks.ps1", "infra/cost-access.ps1", "infra/storage-naming.ps1",
            "infra/focus-exports.ps1", "infra/grant-cost-access.ps1", "infra/main.bicep",
            "infra/bicepconfig.json", "infra/modules/identity.bicep",
            "infra/modules/postgres-admin.bicep", "infra/modules/stack.bicep",
            "infra/sql/create-app-role.sql", "ui/package.json", "ui/package-lock.json",
            "ui/index.html", "ui/tsconfig.json", "ui/vite.config.ts",
            "ui/src/main.tsx", "ui/src/styles.css", "ui/public/favicon.svg",
            "ui/public/theme.js", "web/v2/index.html",
        ):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("", encoding="utf-8")
        (self.root / "ui/index.html").write_text(
            '<link rel="icon" href="/favicon.svg"><script src="/theme.js"></script>'
            '<script type="module" src="/src/main.tsx"></script>', encoding="utf-8")
        for name in (
            "ui/node_modules/private.js", "ui/src/private.test.ts", "ui/src/.private/secret.ts",
            "ui/src/credentials.json", "infra/private.json", "infra/main.json",
            "infra/terraform/customer.tfstate", "HANDOVER.md", "tools/bench-tabs-latest.json",
        ):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("must-not-ship", encoding="utf-8")

    def test_installer_source_is_consumable_and_excludes_private_state(self):
        self.source_fixture()
        result = self.package("-InstallerSource", "-Version", "reviewed-abc123", "-SkipUiBuild")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        with zipfile.ZipFile(self.archive) as archive:
            names = set(archive.namelist())
            self.assertTrue({"infra/install.ps1", "infra/main.bicep", "app/main.py",
                             "tools/package.ps1", "tools/validate_package.py", "tools/verify_package.py",
                             "tools/start_local.py", "requirements.in", ".env.example",
                             "ui/package-lock.json", "ui/src/main.tsx", "web/v2/index.html",
                             "ui/public/favicon.svg", "ui/public/theme.js"} <= names)
            manifest = json.loads(archive.read("release-manifest.json"))
            self.assertEqual(manifest["kind"], "installer-source")
            self.assertEqual(manifest["version"], "reviewed-abc123")
            self.assertEqual(names - {"release-manifest.json"},
                             {entry["path"] for entry in manifest["files"]})
            for entry in manifest["files"]:
                content = archive.read(entry["path"])
                self.assertNotIn(b"must-not-ship", content)
                self.assertEqual(entry["sha256"], hashlib.sha256(content).hexdigest())
                self.assertEqual(entry["bytes"], len(content))
        self.verify_archive("installer-source", "reviewed-abc123")

    def test_installer_source_requires_version_helpers_and_built_ui(self):
        self.source_fixture()
        result = self.package("-InstallerSource", "-SkipUiBuild")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Installer source needs -Version", result.stdout + result.stderr)
        self.assertFalse(self.archive.exists())
        for name in ("infra/install.ps1", "ui/package-lock.json", "web/v2/index.html"):
            path = self.root / name
            original = path.read_bytes()
            path.unlink()
            with self.subTest(name=name):
                result = self.package("-InstallerSource", "-Version", "abc123", "-SkipUiBuild")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(name, result.stdout + result.stderr)
                self.assertFalse(self.archive.exists())
            path.write_bytes(original)

    def test_runtime_archive_is_not_installer_source(self):
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        with zipfile.ZipFile(self.archive) as archive:
            self.assertNotIn("infra/install.ps1", archive.namelist())
            self.assertNotIn("ui/package-lock.json", archive.namelist())
            self.assertEqual(json.loads(archive.read("release-manifest.json"))["kind"],
                             "app-service-runtime")


if __name__ == "__main__":
    unittest.main()
