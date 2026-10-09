"""Verify a release ZIP without extracting it or importing the application."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath


def verify(archive_path: Path, *, expected_sha256: str = "",
           expected_kind: str = "", expected_version: str = "") -> dict[str, str | int]:
    if expected_sha256 and not re.fullmatch(r"[0-9a-fA-F]{64}", expected_sha256):
        raise ValueError("Expected SHA-256 must contain 64 hexadecimal characters.")
    with archive_path.open("rb") as stream:
        archive_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    if expected_sha256 and archive_hash != expected_sha256.lower():
        raise ValueError("Archive SHA-256 does not match the expected value.")
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        archive_names = set(names)
        if len(names) != len(archive_names):
            raise ValueError("Archive contains duplicate entry names.")
        for entry in entries:
            path = PurePosixPath(entry.filename)
            if (entry.filename != entry.orig_filename or entry.is_dir()
                    or path.is_absolute() or "\\" in entry.filename
                    or ":" in entry.filename or ".." in path.parts
                    or str(path) != entry.filename
                    or stat.S_ISLNK(entry.external_attr >> 16)):
                raise ValueError(f"Unsafe archive entry: {entry.filename}")
        if "release-manifest.json" not in archive_names:
            raise ValueError("Archive is missing release-manifest.json.")
        manifest_entry = archive.getinfo("release-manifest.json")
        if manifest_entry.file_size > 8 * 1024 * 1024:
            raise ValueError("Release manifest exceeds 8 MiB.")
        manifest = json.loads(archive.read(manifest_entry))
        if not isinstance(manifest, dict) or manifest.get("application") != "CloudLens":
            raise ValueError("Manifest does not describe a CloudLens release.")
        kind = manifest.get("kind")
        if not isinstance(kind, str) or kind not in {"installer-source", "app-service-runtime"}:
            raise ValueError("Manifest has an unsupported package kind.")
        if expected_kind and kind != expected_kind:
            raise ValueError("Package kind does not match the expected value.")
        version = manifest.get("version")
        if not isinstance(version, str) or (
                kind == "installer-source"
                and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", version)):
            raise ValueError("Manifest has an invalid version.")
        if expected_version and version != expected_version:
            raise ValueError("Package version does not match the expected value.")
        files = manifest.get("files")
        if not isinstance(files, list) or not files:
            raise ValueError("Manifest must contain a nonempty files list.")
        recorded = set()
        total_bytes = 0
        for item in files:
            if not isinstance(item, dict):
                raise ValueError("Manifest file records must be objects.")
            name, size, digest = item.get("path"), item.get("bytes"), item.get("sha256")
            if (not isinstance(name, str) or name == "release-manifest.json"
                    or name in recorded or name not in archive_names):
                raise ValueError(f"Invalid or duplicate manifest path: {name}")
            if (type(size) is not int or size < 0 or not isinstance(digest, str)
                    or not re.fullmatch(r"[0-9a-f]{64}", digest)):
                raise ValueError(f"Invalid size or SHA-256: {name}")
            entry = archive.getinfo(name)
            if entry.file_size != size:
                raise ValueError(f"Payload size mismatch: {name}")
            with archive.open(entry) as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual != digest:
                raise ValueError(f"Payload SHA-256 mismatch: {name}")
            recorded.add(name)
            total_bytes += size
        if recorded != archive_names - {"release-manifest.json"}:
            raise ValueError("Archive contains payload files absent from the manifest.")
        required = {"app/main.py", "requirements.txt", "web/index.html", "web/login.html"}
        if kind == "installer-source":
            required |= {"infra/install.ps1", "infra/main.bicep", "tools/package.ps1",
                         "tools/validate_package.py", "ui/package-lock.json",
                         "ui/src/main.tsx", "web/v2/index.html"}
        if not required <= recorded:
            raise ValueError(f"Package is missing required files: {sorted(required - recorded)}")
    return {"path": str(archive_path.resolve()), "kind": kind, "version": version,
            "files": len(recorded), "payloadBytes": total_bytes, "sha256": archive_hash}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--sha256", default="")
    parser.add_argument("--kind", choices=("installer-source", "app-service-runtime"), default="")
    parser.add_argument("--version", default="")
    args = parser.parse_args()
    try:
        result = verify(args.archive, expected_sha256=args.sha256,
                        expected_kind=args.kind, expected_version=args.version)
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as error:
        print(f"Package verification failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
