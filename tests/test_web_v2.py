"""The v3 interface at /v2: auth gate, SPA fallback, hashed-asset caching and the CSP invariant."""
from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from app import main, web_v2
from app.auth import User

pytestmark = pytest.mark.offline
BUILT = Path(main.WEB) / "v2" / "index.html"


@pytest.fixture
def site(tmp_path):
    """A bare app with a fake build, so serving rules are tested without npm."""
    web = tmp_path / "web"
    (web / "v2" / "assets").mkdir(parents=True)
    (web / "v2" / "index.html").write_text(
        '<!doctype html><script type="module" src="/v2/assets/index-abc123.js"></script><div id="root"></div>',
        encoding="utf-8")
    (web / "v2" / "theme.js").write_text("/* theme */", encoding="utf-8")
    (web / "v2" / "assets" / "index-abc123.js").write_text("export {};", encoding="utf-8")
    (web / "secret.txt").write_text("not for you", encoding="utf-8")
    app = FastAPI()
    web_v2.install(app, web)
    return SimpleNamespace(client=TestClient(app), web=web)


def test_client_side_routes_all_get_the_shell(site):
    for path in ("/v2", "/v2/", "/v2/explore/billing", "/v2/explore/resources", "/v2/admin/setup",
                 "/v2/classic/budgets"):
        response = site.client.get(path)
        assert response.status_code == 200, path
        assert 'id="root"' in response.text
        assert response.headers["content-type"].startswith("text/html")
        assert response.headers["cache-control"] == "no-store"


def test_hashed_assets_are_cached_forever(site):
    response = site.client.get("/v2/assets/index-abc123.js")
    assert response.status_code == 200
    assert response.headers["cache-control"] == web_v2.IMMUTABLE


def test_top_level_files_are_served_but_nothing_else_that_looks_like_a_file(site):
    assert site.client.get("/v2/theme.js").text == "/* theme */"
    assert site.client.get("/v2/theme.js").headers["cache-control"] == "no-cache"
    for path in ("/v2/missing.js", "/v2/index.html", "/v2/deep/theme.js", "/v2/..%2Fsecret.txt",
                 "/v2/%2e%2e/secret.txt", "/v2/assets/../../secret.txt"):
        response = site.client.get(path)
        assert response.status_code == 404, path
        assert "not for you" not in response.text


def test_a_checkout_without_a_build_still_starts_and_says_why(tmp_path):
    app = FastAPI()
    web_v2.install(app, tmp_path / "web")
    client = TestClient(app)
    shell = client.get("/v2/explore/billing")
    assert shell.status_code == 503
    assert "npm" in shell.text
    assert client.get("/v2/assets/index-abc123.js").status_code == 404


@pytest.fixture
def gated(monkeypatch):
    state = SimpleNamespace(user=None)
    auth = SimpleNamespace(identify=lambda *_args: state.user,
                           sso=SimpleNamespace(delegated=True, enabled=False))
    monkeypatch.setattr(main, "_auth", auth)
    monkeypatch.setattr(main, "_log_access", lambda *_args: None)
    monkeypatch.delenv("CLOUDLENS_READ_ONLY", raising=False)
    state.client = TestClient(main.app, follow_redirects=False)
    yield state
    state.client.close()


def test_the_v2_shell_sits_behind_the_same_sign_in(gated):
    page = gated.client.get("/v2/explore/billing?month=2026-08", headers={"Accept": "text/html"})
    assert page.status_code == 303
    assert page.headers["location"] == "/login?next=%2Fv2%2Fexplore%2Fbilling%3Fmonth%3D2026-08"
    assert main.safe_next("/v2/explore/billing?month=2026-08") == "/v2/explore/billing?month=2026-08"
    assert gated.client.get("/v2/theme.js").status_code == 401


def test_v2_assets_are_public_like_the_classic_ones(gated):
    # Bundles carry code, never estate data; the login redirect must not break them.
    assert main.web_v2.ASSETS_PREFIX in main.PUBLIC_PREFIXES
    assert gated.client.get("/v2/assets/does-not-exist.js").status_code == 404


def test_signed_in_users_get_the_shell_under_the_strict_policy(gated):
    gated.user = User("Reader", admin=False, source="env")
    response = gated.client.get("/v2/overview-does-not-matter")
    assert response.status_code == (200 if BUILT.is_file() else 503)
    policy = response.headers["content-security-policy"]
    script = next(part for part in policy.split(";") if "script-src" in part)
    assert "'unsafe-inline'" not in script


@pytest.mark.skipif(not BUILT.is_file(), reason="ui/ has not been built")
def test_the_build_has_no_inline_script():
    """The CSP allows inline script only by hash. The v3 build must not need any."""
    html = BUILT.read_text(encoding="utf-8")
    inline = re.findall(r"<script(?![^>]*\ssrc=)[^>]*>(.*?)</script>", html, re.S | re.I)
    assert inline == []
    assert '<script src="/v2/theme.js"></script>' in html
