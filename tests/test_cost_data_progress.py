"""Scoped setup progress uses the caller's current catalog, never stale selections."""
import asyncio
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from tests.test_focus_schedules import offline_modules  # noqa: F401
from tests.test_job_orchestration import durable  # noqa: F401

pytestmark = pytest.mark.offline

S1 = "aaaaaaaa-bbbb-cccc-dddd-000000000001"
S2 = "aaaaaaaa-bbbb-cccc-dddd-000000000002"
STALE = "aaaaaaaa-bbbb-cccc-dddd-000000000099"


@pytest.fixture
def progress_catalog(durable, monkeypatch):  # noqa: F811
    from app import bootstrap, cost, main

    catalog = [{"id": S1.upper(), "name": "One", "state": "Enabled"},
               {"id": S2, "name": "Two", "state": "Enabled"}]
    real_listing = cost.list_subscriptions
    listing = AsyncMock(return_value={"subscriptions": catalog, "count": 2})
    monkeypatch.setattr(cost, "list_subscriptions", listing)
    permission = AsyncMock(return_value=None)
    monkeypatch.setattr(main, "permitted", permission)
    user = SimpleNamespace(source="local", admin=False, name="Viewer", sid="session")
    request = SimpleNamespace(state=SimpleNamespace(user=user))
    _, db = durable
    month = datetime.now(UTC).date().replace(day=1).isoformat()
    saved = {"blockers": {S1: [{"fix": "private deployment fix"}]},
             "deployment_blockers": [{"fix": "private storage fix"}],
             "error": "private deployment error"}
    for key, value in (
        ("focus-daily:" + S1, {"version": 2, "enabled": True}),
        ("focus-day:" + S1 + ":" + month, {"run_id": "fixture-report"}),
        (bootstrap.STATUS_KEY, saved),
    ):
        db.execute("INSERT INTO meta VALUES (?, ?, CURRENT_TIMESTAMP)", [key, json.dumps(value)])
    before = db.execute("SELECT key, value FROM meta ORDER BY key").fetchall()
    yield SimpleNamespace(request=request, permission=permission, listing=listing,
                          catalog=catalog, real_listing=real_listing, db=db, month=month[:7])
    assert db.execute("SELECT key, value FROM meta ORDER BY key").fetchall() == before


@pytest.mark.parametrize("scope,expected", [
    (None, [S1, S2]),
    (S1, [S1]),
    (S1.upper(), [S1]),
    (f" {S1.upper()} ,{S2},{S1}", [S1, S2]),
])
def test_current_progress_scope_and_case_are_read_only(progress_catalog, scope, expected):
    from app import main

    p = progress_catalog
    response = asyncio.run(main.cost_data_progress(p.request, scope=scope))
    grid = json.loads(response.body)
    assert response.status_code == 200
    assert [sub["id"] for sub in grid["subscriptions"]] == expected
    row = grid["subscriptions"][0]
    assert row["configured"] and row["cells"][p.month]["state"] == "loaded"
    assert all(sub["blockers"] == [] for sub in grid["subscriptions"])
    assert grid["deployment_blockers"] == [] and grid["error"] is None
    p.listing.assert_awaited_once()


@pytest.mark.parametrize("scope", [STALE, f"{S1},{STALE}", "One"])
@pytest.mark.parametrize("handler", ["cost_data_progress", "cost_data_status"])
def test_unknown_scope_is_400_not_500_or_partial_success(progress_catalog, scope, handler):
    from app import main

    with pytest.raises(HTTPException) as error:
        asyncio.run(getattr(main, handler)(progress_catalog.request, scope=scope))
    assert error.value.status_code == 400
    assert "subscription" in error.value.detail.lower()


@pytest.mark.parametrize("scope", ["", " , "])
def test_explicit_empty_scope_never_expands(progress_catalog, scope):
    from app import main

    with pytest.raises(HTTPException) as error:
        asyncio.run(main.cost_data_progress(progress_catalog.request, scope=scope))
    assert error.value.status_code == 400
    progress_catalog.permission.assert_not_awaited()
    progress_catalog.listing.assert_not_awaited()


def test_revoked_scope_is_403_before_catalog_lookup(progress_catalog):
    from app import main

    p = progress_catalog
    p.permission.return_value = [S1]
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.cost_data_progress(p.request, scope=STALE))
    assert error.value.status_code == 403
    p.listing.assert_not_awaited()


def test_no_current_subscriptions_is_400(progress_catalog):
    from app import main

    p = progress_catalog
    p.listing.return_value = {"subscriptions": [], "count": 0}
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.cost_data_progress(p.request))
    assert error.value.status_code == 400


def test_scope_matches_ids_not_another_subscriptions_name(progress_catalog):
    from app import main

    p = progress_catalog
    p.catalog[1]["name"] = S1
    grid = json.loads(asyncio.run(main.cost_data_progress(p.request, scope=S1)).body)
    assert [sub["id"] for sub in grid["subscriptions"]] == [S1]


def test_progress_keeps_admin_only_deployment_details(progress_catalog):
    from app import main

    p = progress_catalog
    p.request.state.user.admin = True
    grid = json.loads(asyncio.run(main.cost_data_progress(p.request, scope=S1)).body)
    assert grid["subscriptions"][0]["blockers"] == [{"fix": "private deployment fix"}]
    assert grid["deployment_blockers"] == [{"fix": "private storage fix"}]
    assert grid["error"] == "private deployment error"


def test_delegated_progress_uses_current_multitenant_caller_catalog(progress_catalog, monkeypatch):
    from app import cost, main

    p = progress_catalog
    p.request.state.user.source = "entra"
    session = SimpleNamespace(oid="fixture-principal", sid="session", problem=None)
    caller = cost.Caller("fixture-token", subscriptions=p.catalog)
    sso = SimpleNamespace(delegated=True, get=lambda sid: session,
                          caller=AsyncMock(return_value=caller))
    monkeypatch.setattr(main, "auth_service", lambda: SimpleNamespace(sso=sso))
    p.permission.return_value = [S1.upper(), S2]
    monkeypatch.setattr(cost, "list_subscriptions", p.real_listing)
    grid = json.loads(asyncio.run(main.cost_data_progress(p.request, scope=S1)).body)
    assert [sub["id"] for sub in grid["subscriptions"]] == [S1]
    sso.caller.assert_awaited_once_with(session)
    assert cost._caller.get() is None


def test_catalog_failure_is_not_misreported_as_invalid_scope(progress_catalog):
    from app import cost, main

    p = progress_catalog
    p.listing.side_effect = cost.CostError("Azure denied catalog access", status_code=403)
    with pytest.raises(cost.CostError, match="Azure denied catalog access"):
        asyncio.run(main.cost_data_progress(p.request, scope=S1))


@pytest.mark.parametrize("scope,status", [
    (None, 200), (S1, 200), (S1.upper(), 200),
    (STALE, 400), (f"{S1},{STALE}", 400), ("", 400),
])
def test_progress_get_http_contract_without_app_startup(progress_catalog, scope, status):
    from app import main

    api = FastAPI()

    @api.middleware("http")
    async def signed_in(request, call_next):
        request.state.user = progress_catalog.request.state.user
        return await call_next(request)

    api.add_api_route("/api/cost-data/progress", main.cost_data_progress, methods=["GET"])

    async def get():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api),
                                     base_url="http://fixture") as client:
            return await client.get("/api/cost-data/progress",
                                    params={} if scope is None else {"scope": scope})

    response = asyncio.run(get())
    assert response.status_code == status
    if status == 200:
        assert len(response.json()["subscriptions"]) == (2 if scope is None else 1)
    else:
        assert "subscription" in response.json()["detail"].lower()
