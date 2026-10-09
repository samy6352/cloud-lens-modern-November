"""Release integrity checks require no application, warehouse or Azure access."""
# cloudlens-test: requires-offline
from __future__ import annotations

import hashlib
import importlib.util
import json
import stat
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("package_integrity", ROOT / "tools/verify_package.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
verify = MODULE.verify


class PackageIntegrity(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "release.zip"
        self.payload = {
            "app/main.py": b"app = None\n", "requirements.txt": b"fastapi\n",
            "web/index.html": b"<html></html>", "web/login.html": b"<html></html>",
        }

    def write(self, *, manifest=None, extra=None, duplicate=False, symlink=False):
        if manifest is None:
            manifest = self.manifest()
        with zipfile.ZipFile(self.path, "w") as archive:
            for name, content in self.payload.items():
                archive.writestr(name, content)
            archive.writestr("release-manifest.json", json.dumps(manifest))
            if extra:
                entry = zipfile.ZipInfo()
                # ZipInfo's constructor normalizes backslashes on Windows.
                entry.filename = entry.orig_filename = extra
                archive.writestr(entry, b"unexpected")
            if duplicate:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    archive.writestr("app/main.py", b"duplicate")
            if symlink:
                entry = zipfile.ZipInfo("link")
                entry.create_system = 3
                entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(entry, "app/main.py")

    def manifest(self, *, kind="app-service-runtime"):
        return {
            "application": "CloudLens", "kind": kind, "version": "release-123",
            "files": [{"path": name, "bytes": len(content),
                       "sha256": hashlib.sha256(content).hexdigest()}
                      for name, content in self.payload.items()],
        }

    def test_runtime_matches_independent_hash_and_version(self):
        self.write()
        result = verify(self.path, expected_sha256=hashlib.sha256(self.path.read_bytes()).hexdigest(),
                        expected_kind="app-service-runtime", expected_version="release-123")
        self.assertEqual(result["files"], 4)
        self.assertEqual(result["payloadBytes"], sum(map(len, self.payload.values())))

    def test_installer_source_requires_installable_tree(self):
        self.write(manifest=self.manifest(kind="installer-source"))
        with self.assertRaisesRegex(ValueError, "missing required files"):
            verify(self.path)
        for name in ("infra/install.ps1", "infra/main.bicep", "tools/package.ps1",
                     "tools/validate_package.py", "ui/package-lock.json",
                     "ui/src/main.tsx", "web/v2/index.html"):
            self.payload[name] = b"fixture"
        self.write(manifest=self.manifest(kind="installer-source"))
        self.assertEqual(verify(self.path)["kind"], "installer-source")

    def test_expected_identity_mismatches_are_refused(self):
        self.write()
        for options in ({"expected_sha256": "0" * 64}, {"expected_sha256": "bad"},
                        {"expected_kind": "installer-source"}, {"expected_version": "wrong"}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                verify(self.path, **options)

    def test_payload_tampering_is_refused(self):
        manifest = self.manifest()
        self.payload["app/main.py"] = b"bad = None\n"
        self.write(manifest=manifest)
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            verify(self.path)

    def test_size_mismatch_is_refused(self):
        manifest = self.manifest()
        manifest["files"][0]["bytes"] += 1
        self.write(manifest=manifest)
        with self.assertRaisesRegex(ValueError, "size mismatch"):
            verify(self.path)

    def test_unlisted_or_duplicate_entries_are_refused(self):
        for options in ({"extra": "unlisted.py"}, {"duplicate": True}):
            with self.subTest(options=options):
                self.write(**options)
                with self.assertRaises(ValueError):
                    verify(self.path)

    def test_unsafe_paths_and_links_are_refused(self):
        for name in ("../escape", "/absolute", "C:/drive", "app\\other.py",
                     "app/./other.py", "app//other.py", "folder/"):
            with self.subTest(name=name):
                self.write(extra=name)
                with self.assertRaisesRegex(ValueError, "Unsafe archive entry"):
                    verify(self.path)
        self.write(symlink=True)
        with self.assertRaisesRegex(ValueError, "Unsafe archive entry"):
            verify(self.path)

    def test_invalid_manifest_shapes_are_refused(self):
        cases = [[], {"application": "other"}, {**self.manifest(), "kind": "unknown"},
                 {**self.manifest(), "kind": []},
                 {**self.manifest(), "version": None},
                 {**self.manifest(), "files": []}, {**self.manifest(), "files": [1]}]
        for manifest in cases:
            with self.subTest(manifest=manifest):
                self.write(manifest=manifest)
                with self.assertRaises(ValueError):
                    verify(self.path)

    def test_invalid_and_duplicate_file_records_are_refused(self):
        for change in ({"path": "missing.py"}, {"path": "release-manifest.json"},
                       {"bytes": True}, {"sha256": "bad"}):
            with self.subTest(change=change):
                manifest = self.manifest()
                manifest["files"][0].update(change)
                self.write(manifest=manifest)
                with self.assertRaises(ValueError):
                    verify(self.path)
        manifest = self.manifest()
        manifest["files"].append(manifest["files"][0])
        self.write(manifest=manifest)
        with self.assertRaisesRegex(ValueError, "duplicate manifest path"):
            verify(self.path)

    def test_missing_manifest_and_invalid_zip_are_refused(self):
        with zipfile.ZipFile(self.path, "w") as archive:
            archive.writestr("app/main.py", b"fixture")
        with self.assertRaisesRegex(ValueError, "missing release-manifest"):
            verify(self.path)
        self.path.write_bytes(b"not a zip")
        with self.assertRaises(zipfile.BadZipFile):
            verify(self.path)


if __name__ == "__main__":
    unittest.main()
