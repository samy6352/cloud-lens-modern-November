"""Local launch plans are exercised without starting the app, a database or Azure."""
# cloudlens-test: requires-offline
from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import socket
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("local_launcher", ROOT / "tools/start_local.py")
LAUNCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHER)


class LocalStart(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env_file = Path(self.temp.name) / "private.env"
        self.env_file.write_text(
            "PGHOST=offline.invalid\nPROJECT_ENDPOINT=https://offline.invalid\n"
            "AUTH_PASSWORD=not-for-output\nAUTO_INGEST=true\nCLOUDLENS_READ_ONLY=false\n",
            encoding="utf-8",
        )

    def free_port(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return str(sock.getsockname()[1])

    def test_explicit_file_and_safe_mode_override_inherited_application_settings(self):
        with patch.dict(os.environ, {"PGHOST": "shared.invalid", "AZURE_CLIENT_SECRET": "do-not-copy",
                                      "USERNAME": "synthetic-fixture-user",
                                     "PYTHONPATH": "unexpected", "AUTO_REFRESH": "true"}):
            env = LAUNCHER.runtime_environment(self.env_file)
        self.assertEqual(env["PGHOST"], "offline.invalid")
        self.assertEqual(env["CLOUDLENS_ENV_FILE"], str(self.env_file.resolve()))
        self.assertTrue(LAUNCHER.READ_ONLY_SETTINGS.items() <= env.items())
        self.assertNotIn("AZURE_CLIENT_SECRET", env)
        self.assertNotIn("PYTHONPATH", env)
        self.assertEqual(env["USERNAME"], "synthetic-fixture-user")

    def test_writes_require_explicit_opt_in_and_use_file_settings(self):
        env = LAUNCHER.runtime_environment(self.env_file, allow_writes=True)
        self.assertEqual(env["AUTO_INGEST"], "true")
        self.assertEqual(env["CLOUDLENS_READ_ONLY"], "false")

    def test_invalid_ambiguous_or_incomplete_environment_is_refused(self):
        for content in (
            "PGHOST=one\nPGHOST=two\n", "PGHOST=one\npghost=two\n",
            "PGHOST\n", "PGHOST=one\ninvalid input\n",
            "PGHOST=one\nPROJECT_ENDPOINT=${PARENT_ENDPOINT}\n", "PROJECT_ENDPOINT=one\n",
            "PGHOST=one\n",
            "PGHOST=one\nPROJECT_ENDPOINT=https://offline.invalid\nINGEST_MONTHS=14\n",
        ):
            with self.subTest(content=content):
                self.env_file.write_text(content, encoding="utf-8")
                with self.assertRaises(ValueError):
                    LAUNCHER.runtime_environment(self.env_file)

    def test_check_never_spawns_or_prints_secret_values(self):
        output = io.StringIO()
        with patch.object(LAUNCHER.subprocess, "run") as run, contextlib.redirect_stdout(output):
            self.assertEqual(LAUNCHER.main(["--env-file", str(self.env_file),
                                           "--port", self.free_port(), "--check"]), 0)
        run.assert_not_called()
        self.assertNotIn("not-for-output", output.getvalue())
        self.assertNotIn("AUTH_PASSWORD", output.getvalue())

    def test_occupied_port_is_refused_without_touching_existing_process(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen()
            with patch.object(LAUNCHER.subprocess, "run") as run:
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                    LAUNCHER.main(["--env-file", str(self.env_file),
                                   "--port", str(sock.getsockname()[1])])
                self.assertEqual(raised.exception.code, 2)
                run.assert_not_called()

    def test_missing_runtime_dependency_is_reported_before_spawn(self):
        with (patch.object(LAUNCHER, "find_spec", return_value=None),
              patch.object(LAUNCHER.subprocess, "run") as run,
              contextlib.redirect_stderr(io.StringIO()),
              self.assertRaises(SystemExit) as raised):
            LAUNCHER.main(["--env-file", str(self.env_file), "--check"])
        self.assertEqual(raised.exception.code, 2)
        run.assert_not_called()

    def test_child_uses_durable_repo_command_and_propagates_failure(self):
        with (patch.object(LAUNCHER.subprocess, "run", return_value=SimpleNamespace(returncode=7)) as run,
              contextlib.redirect_stdout(io.StringIO())):
            self.assertEqual(LAUNCHER.main(["--env-file", str(self.env_file),
                                           "--port", self.free_port()]), 7)
        self.assertEqual(run.call_args.args[0][1:4], ["-m", "uvicorn", "app.main:app"])
        self.assertEqual(run.call_args.kwargs["cwd"], ROOT)
        self.assertEqual(run.call_args.kwargs["env"]["CLOUDLENS_READ_ONLY"], "true")


if __name__ == "__main__":
    unittest.main()
