"""The production dependency file is a portable, exact lock for supported platforms."""
from pathlib import Path

import pytest
from packaging.markers import default_environment
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.version import Version

ROOT = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.offline


def requirements(name):
    return [Requirement(line.split("#", 1)[0].strip())
            for line in (ROOT / name).read_text(encoding="utf-8").splitlines()
            if line.split("#", 1)[0].strip()]


@pytest.mark.parametrize("platform", ["win32", "linux"])
@pytest.mark.parametrize("python", ["3.11", "3.13", "3.14"])
def test_runtime_lock_pins_editable_inputs_on_each_supported_environment(platform, python):
    env = {**default_environment(), "sys_platform": platform,
           "python_version": python, "python_full_version": python + ".0",
           "os_name": "nt" if platform == "win32" else "posix"}
    pins = {}
    for requirement in requirements("requirements.txt"):
        specs = list(requirement.specifier)
        assert requirement.url is None and len(specs) == 1
        assert specs[0].operator == "==" and "*" not in specs[0].version
        if requirement.marker is None or requirement.marker.evaluate(env):
            name = canonicalize_name(requirement.name)
            assert name not in pins
            pins[name] = Version(specs[0].version)
    for source in requirements("requirements.in"):
        name = canonicalize_name(source.name)
        assert name in pins
        assert pins[name] in source.specifier
    assert "psycopg-binary" in pins
    assert ("uvloop" in pins) == (platform == "linux")
    assert ("tzdata" in pins) == (platform == "win32")


def test_runtime_lock_contains_no_local_resolver_paths():
    text = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    assert "session-state" not in text
    assert "file://" not in text
    assert "Users/" not in text
