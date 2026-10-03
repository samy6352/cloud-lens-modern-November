"""Report pickers wait for certified summaries without querying costs or Azure."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from tests.test_focus_schedules import offline_modules  # noqa: F401

pytestmark = pytest.mark.offline

S1 = "aaaaaaaa-bbbb-cccc-dddd-000000000001"
S2 = "aaaaaaaa-bbbb-cccc-dddd-000000000002"


class MetadataConnection:
    def __init__(self):
        self.meta = {
            "data_generation": "14",
            "data_rollup_generation": "14",
            "data_rollup_tables": "costs_rollup,resource_presence",
        }
        self.queries = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def execute(self, sql, params):
        # Exercise the real generation/dirty-ledger/roster logic, not a mocked boolean.
        assert sql.startswith("SELECT ")
        assert " FROM meta " in sql
        self.queries.append((sql, params))
        if "SELECT key,value" in sql:
            rows = [(key, self.meta[key]) for key in params if key in self.meta]
        else:
            rows = [(self.meta[params[0]],)] if params[0] in self.meta else []
        return SimpleNamespace(fetchall=lambda: rows,
                               fetchone=lambda: rows[0] if rows else None)


@pytest.fixture
def picker(offline_modules, monkeypatch):  # noqa: F811
    from app import dashboard, main, warehouse

    con = MetadataConnection()
    connect = Mock(return_value=con)
    monkeypatch.setattr(warehouse.warehouse, "connect", connect)
    sections = Mock(return_value={
        "sections": [{"id": "compute", "label": "Compute & Web", "cost": 123.45},
                     {"id": "storage", "label": "Storage", "cost": 0},
                     {"id": "data", "label": "AI & Data", "cost": None}],
        "currency": "USD", "as_of": "2026-10-01",
    })
    dashboard_get = Mock(return_value=SimpleNamespace(sections=sections))
    monkeypatch.setattr(dashboard, "get_dashboard", dashboard_get)
    permission = AsyncMock(return_value=[S1, S2])
    monkeypatch.setattr(main, "permitted", permission)
    request = SimpleNamespace(state=SimpleNamespace(user=SimpleNamespace(
        source="local", admin=False, sid="fixture", name="Viewer")))
    return SimpleNamespace(con=con, connect=connect, sections=sections,
                           dashboard_get=dashboard_get, permission=permission,
                           request=request)


@pytest.mark.parametrize("scope,expected", [
    ("", [S1, S2]), (S1, [S1]), (S1.upper(), [S1]),
])
def test_ready_payload_and_authorized_scope_are_unchanged(picker, scope, expected):
    from app import main
    from app.report import BLOCKS, FORMATS, LIVE

    response = asyncio.run(main.report_options(picker.request, scope=scope))
    assert response.status_code == 200
    assert json.loads(response.body) == {
        "areas": [{"id": "compute", "label": "Compute & Web", "cost": 123.45}],
        "blocks": list(BLOCKS),
        "live": [{"id": k, "label": v} for k, v in LIVE.items()],
        "formats": [{"id": k, "label": v[0]} for k, v in FORMATS.items()],
        "currency": "USD", "as_of": "2026-10-01",
    }
    picker.sections.assert_called_once_with(expected, days=30, currency=None)
    picker.connect.assert_called_once_with(read_only=True)


@pytest.mark.parametrize("days,expected", [(-1, 1), (800, 365), (60, 60)])
def test_ready_currency_and_days_are_preserved(picker, days, expected):
    from app import main

    asyncio.run(main.report_options(picker.request, scope=S1, days=days, currency="INR"))
    picker.sections.assert_called_once_with([S1], days=expected, currency="INR")


@pytest.mark.parametrize("state", [
    "source-ahead", "missing-source", "missing-ready", "missing-both",
    "negative-generation", "missing-table-certificate", "maintenance-pending",
    "unknown-dirty-coverage", "stale-dirty-ledger",
])
def test_pending_or_uncertified_never_starts_dashboard_or_raw_scan(picker, state):
    from app import main

    meta = picker.con.meta
    if state == "source-ahead":
        meta["data_rollup_generation"] = "13"
    elif state == "missing-source":
        del meta["data_generation"]
    elif state == "missing-ready":
        del meta["data_rollup_generation"]
    elif state == "missing-both":
        del meta["data_generation"]
        del meta["data_rollup_generation"]
    elif state == "negative-generation":
        meta["data_generation"] = meta["data_rollup_generation"] = "-1"
    elif state == "missing-table-certificate":
        meta["data_rollup_tables"] = "resource_presence"
    else:
        meta["data_rollup_dirty"] = json.dumps({
            "generation": 13 if state == "stale-dirty-ledger" else 14,
            "base_generation": 14,
            "windows": None if state == "unknown-dirty-coverage" else [
                ["2026-10-01", "2026-10-02"]],
        })
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.report_options(picker.request, scope=S1))
    assert error.value.status_code == 503
    assert error.value.detail == "Committed source data is still being prepared."
    assert error.value.headers["Retry-After"] == "3"
    assert error.value.headers["Cache-Control"] == "no-store"
    assert error.value.headers["X-CloudLens-Source-State"] == "pending"
    picker.dashboard_get.assert_not_called()
    picker.sections.assert_not_called()
    assert picker.con.queries


@pytest.mark.parametrize("status", [401, 403, 503])
def test_entitlement_failure_precedes_readiness_lookup(picker, status):
    from app import main

    picker.permission.side_effect = HTTPException(status, "Current entitlement failure")
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.report_options(picker.request, scope=S1))
    assert error.value.status_code == status
    picker.connect.assert_not_called()
    picker.dashboard_get.assert_not_called()


def test_anonymous_failure_precedes_permissions_and_global_metadata(picker):
    from app import main

    del picker.request.state.user
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.report_options(picker.request))
    assert error.value.status_code == 401
    picker.permission.assert_not_awaited()
    picker.connect.assert_not_called()


@pytest.mark.parametrize("scope,allowed", [(S2, [S1]), ("", []), (f"{S1},{S2}", [S1])])
def test_invalid_scope_never_reads_global_metadata_or_other_subscriptions(picker, scope, allowed):
    from app import main

    picker.permission.return_value = allowed
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.report_options(picker.request, scope=scope))
    assert error.value.status_code == 403
    picker.connect.assert_not_called()
    picker.dashboard_get.assert_not_called()


def test_unrestricted_ready_scope_retains_legacy_behavior(picker):
    from app import main

    picker.permission.return_value = None
    asyncio.run(main.report_options(picker.request))
    picker.sections.assert_called_once_with(None, days=30, currency=None)


def test_missing_roster_retains_existing_legacy_certificate_policy(picker):
    from app import main

    del picker.con.meta["data_rollup_tables"]
    assert asyncio.run(main.report_options(picker.request)).status_code == 200


def test_pending_http_contract_returns_retryable_error_not_empty_financial_data(picker):
    from app import main

    picker.con.meta["data_rollup_generation"] = "13"
    api = FastAPI()

    @api.middleware("http")
    async def signed_in(request, call_next):
        request.state.user = picker.request.state.user
        return await call_next(request)

    api.add_api_route("/api/report/options", main.report_options, methods=["GET"])

    async def get():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api),
                                     base_url="http://fixture") as client:
            return await client.get("/api/report/options", params={"scope": S1})

    response = asyncio.run(get())
    assert response.status_code == 503
    assert response.json() == {"detail": "Committed source data is still being prepared."}
    assert response.headers["retry-after"] == "3"
    picker.sections.assert_not_called()
