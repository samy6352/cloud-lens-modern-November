"""Start a loopback-only CloudLens process from an explicit, protected environment file."""
from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
from importlib.util import find_spec
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
PLATFORM_ENV = {
    "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
    "HOME", "USERNAME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
    "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "PYTHONUTF8", "PYTHONIOENCODING",
}
READ_ONLY_SETTINGS = {
    "CLOUDLENS_READ_ONLY": "true",
    "AUTO_INGEST": "false",
    "AUTO_REFRESH": "false",
    "AUTO_FOCUS_SYNC": "false",
    "USER_BACKFILL": "false",
    "CLOUDLENS_MANAGED_EXPORTS": "false",
    "CLOUDLENS_WARM_EXPORTS": "false",
    "CLOUDLENS_WARM_LIVE_TABS": "false",
    "SNAPSHOT_CACHE_ENABLED": "false",
    "SNAPSHOT_WARMING_ENABLED": "false",
}


def runtime_environment(path: Path, *, allow_writes: bool = False) -> dict[str, str]:
    from dotenv import dotenv_values
    from dotenv.parser import parse_stream

    from app.job_policy import initial_history_months

    path = path.resolve(strict=True)
    if not path.is_file():
        raise ValueError("The environment path must be a file.")
    with path.open(encoding="utf-8-sig") as stream:
        bindings = list(parse_stream(stream))
    keys = set()
    for binding in bindings:
        if binding.error:
            raise ValueError(f"Invalid environment syntax at line {binding.original.line}.")
        if binding.key is None:
            continue
        normalized = binding.key.upper()
        if normalized in keys or binding.value is None:
            raise ValueError(f"Duplicate or valueless environment key at line {binding.original.line}.")
        keys.add(normalized)
    settings = dotenv_values(path, encoding="utf-8-sig", interpolate=False)
    env = {key: value for key, value in os.environ.items() if key.upper() in PLATFORM_ENV}
    for key, value in settings.items():
        if value is not None:
            if "${" in value:
                raise ValueError("Environment interpolation is unsupported; provide literal settings.")
            env[key] = value
    for key in ("PGHOST", "PROJECT_ENDPOINT"):
        if not env.get(key, "").strip():
            raise ValueError(f"The environment file must explicitly set {key}.")
    if not allow_writes:
        env.update(READ_ONLY_SETTINGS)
    initial_history_months(env)
    env["CLOUDLENS_ENV_FILE"] = str(path)
    return env


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--port", type=int, default=8101)
    parser.add_argument("--allow-writes", action="store_true",
                        help="Explicitly allow configured ingestion/workers; isolated deployments only.")
    parser.add_argument("--check", action="store_true", help="Check configuration and port; do not start.")
    args = parser.parse_args(argv)
    if sys.version_info < (3, 11):  # noqa: UP036 - a standalone launcher may use the wrong interpreter
        parser.error("Python 3.11 or later is required.")
    if not 1 <= args.port <= 65535:
        parser.error("Port must be from 1 to 65535.")
    if find_spec("uvicorn") is None:
        parser.error("Uvicorn is missing; install requirements.txt with this interpreter.")
    try:
        env = runtime_environment(args.env_file, allow_writes=args.allow_writes)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", args.port))
    except (OSError, ValueError, ImportError) as error:
        parser.error(str(error))
    mode = "configured writes allowed" if args.allow_writes else "ingestion/Azure mutations disabled"
    print(f"CloudLens local launch: 127.0.0.1:{args.port}; {mode}", flush=True)
    if args.check:
        return 0
    return subprocess.run(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
         "--port", str(args.port), "--workers", "1"],
        cwd=ROOT, env=env, check=False,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
