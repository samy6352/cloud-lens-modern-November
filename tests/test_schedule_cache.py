"""Caching the export listing must never show somebody a change that did not happen.

`/api/schedules` is one ARM call per subscription plus one per export to expand `runHistory`.
Every one of them was uncached, so the Reports tab paid seventeen round trips at concurrency
four -- 16.5s measured against this tenant. Reading through the shared cache removes that, but
only if a write is guaranteed to drop what it invalidates: a schedule that has just been
created and does not appear, or one just deleted that still does, reads as the write having
silently failed. That is strictly worse than the wait.

So the cache is allowed exactly one job, and these tests fence it:
  - reads may be served from it,
  - any non-GET purges that subscription's exports, for every caller,
  - the purge is scoped, so one subscription's write does not blank another's list,
  - and `fresh=True` bypasses it for changes made outside CloudLens entirely.
"""
from __future__ import annotations

import asyncio

import pytest

from app import schedules


@pytest.fixture
def arm(monkeypatch):
    """Record what `schedules` asks of Azure, and what it purges, without leaving the process.

    Patched onto the real `app.cost` module rather than swapped into `sys.modules`: the
    `from . import cost` inside `schedules` resolves through the already-imported package
    attribute, so replacing the module entry alone is invisible to it.
    """
    from app import cost as real_cost

    state = {"calls": [], "forgotten": []}

    async def fake_request(method, url, *, json_body=None, params=None, cache=True):
        state["calls"].append({"method": method, "url": url, "cache": cache})
        return {"value": []}

    monkeypatch.setattr(real_cost.azure, "request", fake_request)
    monkeypatch.setattr(real_cost, "forget", lambda fragment: state["forgotten"].append(fragment))
    return state


EXPORTS = ("https://management.azure.com/subscriptions/sub-a"
           "/providers/Microsoft.CostManagement/exports")


def test_a_read_is_only_cached_when_the_caller_asks(arm):
    asyncio.run(schedules._request("GET", EXPORTS))
    assert arm["calls"][-1]["cache"] is False, "the default must stay uncached"

    asyncio.run(schedules._request("GET", EXPORTS, cache=True))
    assert arm["calls"][-1]["cache"] is True


def test_a_read_never_purges_anything(arm):
    asyncio.run(schedules._request("GET", EXPORTS, cache=True))
    assert arm["forgotten"] == [], "a read that invalidates would defeat the cache entirely"


@pytest.mark.parametrize("method", ["PUT", "POST", "DELETE", "PATCH"])
def test_every_write_purges_that_subscription_s_exports(arm, method):
    asyncio.run(schedules._request(method, f"{EXPORTS}/cloudlens-focus-abc"))
    assert arm["forgotten"] == [EXPORTS], (
        f"a {method} left a stale list behind, which reads as the write having failed")


def test_running_an_export_purges_it_too(arm):
    """`run_now` POSTs to `.../exports/{name}/run`, and it changes the run history shown."""
    asyncio.run(schedules._request("POST", f"{EXPORTS}/cloudlens-focus-abc/run"))
    assert arm["forgotten"] == [EXPORTS]


def test_the_purge_does_not_reach_another_subscription(arm):
    other = EXPORTS.replace("sub-a", "sub-b")
    asyncio.run(schedules._request("DELETE", f"{other}/some-export"))
    assert arm["forgotten"] == [other]
    assert EXPORTS not in arm["forgotten"], "one write must not blank every estate's list"


def test_a_url_outside_the_exports_collection_is_left_alone(arm):
    """`_grant_storage` PUTs a role assignment. It must not be mistaken for an export write."""
    role = ("https://management.azure.com/subscriptions/sub-a/providers/"
            "Microsoft.Authorization/roleAssignments/guid")
    asyncio.run(schedules._request("PUT", role))
    assert arm["forgotten"] == [role], "an unrelated URL should purge only itself"


def test_the_scope_helper_covers_the_collection_and_its_children():
    for suffix in ("", "/an-export", "/an-export/run"):
        assert schedules._exports_scope(f"{EXPORTS}{suffix}") == EXPORTS


# --------------------------------------------------------------- the listing itself

@pytest.fixture
def listing_probe(monkeypatch, arm):
    """Enough of `cost` for `listing()` to run without touching Azure."""
    from app import cost as real_cost

    async def resolved(ids):
        return [{"id": i, "name": i} for i in (ids or ["sub-a"])]

    monkeypatch.setattr(real_cost, "_resolve", resolved)
    monkeypatch.setattr(real_cost, "ARM", "https://management.azure.com")
    return arm


def test_listing_reads_through_the_cache(listing_probe):
    asyncio.run(schedules.listing(["sub-a"]))
    reads = [c for c in listing_probe["calls"] if c["method"] == "GET"]
    assert reads, "the listing made no read at all"
    assert all(c["cache"] for c in reads), (
        "an uncached listing is the 16.5s Reports tab this change exists to fix")


def test_an_explicit_reload_bypasses_the_cache(listing_probe):
    asyncio.run(schedules.listing(["sub-a"], fresh=True))
    assert listing_probe["forgotten"] == [EXPORTS], (
        "Reload must drop the cached list first, or it returns the same answer")


def test_an_ordinary_load_does_not_bypass_the_cache(listing_probe):
    asyncio.run(schedules.listing(["sub-a"]))
    assert listing_probe["forgotten"] == [], "only the Reload button may force a fresh read"


def test_the_endpoint_and_the_button_agree_on_the_parameter():
    """Structural: a `fresh` the browser sends and the server ignores is worse than neither."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    server = (root / "app" / "main.py").read_text(encoding="utf-8")
    client = (root / "web" / "assets" / "dashboard-reports.js").read_text(encoding="utf-8")

    assert "fresh: bool = False" in server
    assert "schedules.listing(picked or allowed, fresh=fresh," in server
    assert 'fresh ? "&fresh=true" : ""' in client
    assert "renderSettings(ctx.loadToken, true)" in client, (
        "the Reload button has to be the thing that asks for it")


# ------------------------------------------------------ last-run history, split from the list

@pytest.fixture
def three_exports(monkeypatch, listing_probe):
    """One list call returning three exports; any expansion read is recorded and answered."""
    from app import cost as real_cost

    names = ["cloudlens-focus-a", "legacy-b", "legacy-c"]

    async def fake_request(method, url, *, json_body=None, params=None, cache=True):
        listing_probe["calls"].append({"method": method, "url": url, "cache": cache})
        if url.endswith("/exports"):
            return {"value": [{"name": n, "properties": {}} for n in names]}
        name = url.rsplit("/", 1)[-1]
        run = {"properties": {"status": "Completed", "executionTime": "2026-10-01T00:00:00Z"}}
        return {"name": name, "properties": {"runHistory": {"value": [run]}}}

    monkeypatch.setattr(real_cost.azure, "request", fake_request)
    return listing_probe


def test_listing_without_expansion_is_one_read_per_subscription(three_exports):
    result = asyncio.run(schedules.listing(["sub-a"], expand=False))
    reads = [c for c in three_exports["calls"] if c["method"] == "GET"]
    assert len(reads) == 1, f"{len(reads)} reads; the expansions are what made this 145s"
    assert result["count"] == 3
    assert all(e["history_pending"] and e["last_status"] is None for e in result["schedules"])


def test_listing_with_expansion_is_unchanged(three_exports):
    result = asyncio.run(schedules.listing(["sub-a"]))
    assert len([c for c in three_exports["calls"] if c["method"] == "GET"]) == 4
    assert all(not e["history_pending"] and e["last_status"] == "Completed"
               for e in result["schedules"])


def test_history_is_keyed_by_subscription_and_name(three_exports):
    found = asyncio.run(schedules.history_for(["sub-a"]))
    assert found["sub-a/legacy-b"] == {"last_run": "2026-10-01T00:00:00Z",
                                       "last_status": "Completed"}
    assert len(found) == 3


def test_the_tab_asks_for_the_fast_list_then_the_history():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    server = (root / "app" / "main.py").read_text(encoding="utf-8")
    client = (root / "web" / "assets" / "dashboard-reports.js").read_text(encoding="utf-8")
    assert "expand=history" in server and '"/api/schedules/history"' in server
    assert "&history=false" in client and "loadScheduleHistory(sched, token, sequence)" in client


def test_startup_warms_the_export_list_without_expansion(three_exports):
    import app.main as main

    asyncio.run(main._warm_export_list())
    reads = [c for c in three_exports["calls"] if c["method"] == "GET"]
    assert len(reads) == 1 and reads[0]["cache"] is True


def test_a_failed_warm_up_is_swallowed(monkeypatch):
    import app.main as main

    async def boom(*a, **k):
        raise RuntimeError("azure down")

    monkeypatch.setattr(schedules, "listing", boom)
    asyncio.run(main._warm_export_list())


# ------------------------------------------------- live-Azure tabs warmed on sign-in

def _recording_app(seen, fail=()):
    """A bare ASGI app: records who asked for what, and answers 502 for the tabs in `fail`."""
    from urllib.parse import parse_qs

    async def stand_in(scope, receive, send):
        headers = dict(scope["headers"])
        cookie = headers.get(b"cookie", b"").decode()
        days = parse_qs(scope["query_string"].decode()).get("days", [None])[0]
        tab = scope["path"].rsplit("/", 1)[-1]
        seen.append((tab, days, cookie.partition("=")[2]))
        status = 502 if tab in fail else 200
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": b"{}"})

    return stand_in


def test_sign_in_warms_each_live_tab_once_as_that_session(monkeypatch):
    import app.main as main

    seen = []
    monkeypatch.setattr(main, "app", _recording_app(seen))
    monkeypatch.setattr(main, "COOKIE", "cloudlens_session")
    warmed = asyncio.run(main.warm_live_tabs("signed-token", paths=("/api/dashboard/waste",
                                                                   "/api/dashboard/esu")))
    assert warmed == 2
    assert seen == [("waste", "30", "signed-token"), ("esu", "30", "signed-token")]


def test_one_failing_tab_does_not_stop_the_others(monkeypatch):
    import app.main as main

    seen = []
    monkeypatch.setattr(main, "app", _recording_app(seen, fail={"waste"}))
    monkeypatch.setattr(main, "COOKIE", "cloudlens_session")
    warmed = asyncio.run(main.warm_live_tabs("t", paths=("/api/dashboard/waste",
                                                        "/api/dashboard/esu")))
    assert warmed == 1 and [s[0] for s in seen] == ["waste", "esu"]


def test_the_live_tab_warm_up_can_be_switched_off(monkeypatch):
    import app.main as main

    seen = []
    monkeypatch.setattr(main, "app", _recording_app(seen))
    monkeypatch.setenv("CLOUDLENS_WARM_LIVE_TABS", "false")
    assert asyncio.run(main.warm_live_tabs("t")) == 0 and seen == []


def test_every_sign_in_path_starts_the_warm_up():
    from pathlib import Path

    server = (Path(__file__).resolve().parents[1] / "app" / "main.py").read_text(encoding="utf-8")
    assert server.count("BackgroundTask(warm_live_tabs, token)") == 2, (
        "password sign-in and the Entra callback must both warm the viewer's tabs")
    live = server[server.index("LIVE_AZURE_TABS = ("):server.index("async def warm_live_tabs")]
    from app.snapshot_cache import DEFAULT_POLICIES
    assert all(path in DEFAULT_POLICIES for path in
               __import__("re").findall(r'"(/api/dashboard/[a-z-]+)"', live)), (
        "a tab that is not snapshot-cached would be warmed for nothing")

