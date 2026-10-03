"""Fast imported-cost reads retain explicit live evidence and scope boundaries."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from tests.test_focus_schedules import offline_modules  # noqa: F401

pytestmark = pytest.mark.offline

S1 = "aaaaaaaa-bbbb-cccc-dddd-000000000001"
S2 = "aaaaaaaa-bbbb-cccc-dddd-000000000002"


@pytest.fixture
def viewer(offline_modules, monkeypatch):  # noqa: F811
    from app import main

    monkeypatch.setattr(main, "permitted", AsyncMock(return_value=None))
    return SimpleNamespace(state=SimpleNamespace(user=SimpleNamespace(
        source="local", admin=False, name="Viewer", sid="fixture")))


def test_cost_only_tags_preserve_exact_payload_without_azure_lookup(viewer, monkeypatch):
    from app import main, tags

    payload = {"keys": [], "resources": [], "total": -123.45, "currency": "USD"}
    seen = []

    def costs(scope, **kwargs):
        seen.append((scope, kwargs))
        return payload

    live = AsyncMock(side_effect=AssertionError("Cost-only reads must not call Azure"))
    monkeypatch.setattr(tags, "cost_by_tag", costs)
    monkeypatch.setattr(tags, "live_tag_keys", live)
    response = asyncio.run(main.dashboard_tags(
        viewer, days=7, scope=S1, currency="USD", include_live=False))
    assert json.loads(response.body) == payload
    assert seen == [([S1], {"days": 7, "currency": "USD", "encoded": True})]
    live.assert_not_awaited()


def test_large_valid_reports_keep_content_validation_and_explicit_size_bounds():
    from app.snapshot_cache import _body, SnapshotStore
    from starlette.responses import JSONResponse

    response = JSONResponse({"total": -123.45, "description": "x" * (8 * 1024 * 1024)})
    assert _body(response, 8 * 1024 * 1024) is None
    assert _body(response, 16 * 1024 * 1024) == response.body
    assert _body(JSONResponse({"password": "never-cache", "description": "x" * len(response.body)}),
                 16 * 1024 * 1024) is None
    assert SnapshotStore(lambda: None, max_bytes=1024, max_payload=16 * 1024 * 1024).max_payload == 1024


def test_encoded_cost_only_tags_keep_json_content_type_and_actual_snapshot_validation(viewer, monkeypatch):
    from app import main, tags
    from app.snapshot_cache import _body

    encoded = '{"keys":[],"resources":[],"total":-123.456789012345,"currency":"USD"}'
    monkeypatch.setattr(tags, "cost_by_tag", lambda *args, **kwargs: encoded)
    response = asyncio.run(main.dashboard_tags(viewer, include_live=False))
    assert response.body == encoded.encode("utf-8")
    assert response.headers["content-type"] == "application/json"
    assert _body(response, 1024) == encoded.encode("utf-8")
    monkeypatch.setattr(tags, "cost_by_tag", lambda *args, **kwargs: '{"password":"never-cache"}')
    unsafe = asyncio.run(main.dashboard_tags(viewer, include_live=False))
    assert _body(unsafe, 1024) is None


@pytest.mark.parametrize("missing", [False, True])
@pytest.mark.parametrize("encoded", [
    '{"total":-123.456789012345,"currency":"USD","resources":[{"name":"é","cost":-0.0}]}',
    " { } \n",
])
def test_encoded_uptime_preserves_body_and_independent_tag_caveat(viewer, monkeypatch, missing, encoded):
    from app import main, uptime
    from app.snapshot_cache import ParsedJSONResponse, _body

    seen = []

    def costs(scope, **kwargs):
        seen.append((scope, kwargs))
        return encoded

    monkeypatch.setattr(uptime, "hourly_cost", costs)
    monkeypatch.setattr(main, "_tags_missing_from_load", lambda: missing)
    response = asyncio.run(main.dashboard_uptime(viewer, days=7, scope=S1, currency="USD"))
    assert isinstance(response, ParsedJSONResponse)
    assert json.loads(response.body) == {**json.loads(encoded), "tags_not_loaded": missing}
    assert response.body.startswith(encoded.rstrip()[:-1].encode("utf-8"))
    assert _body(response, 1024) == response.body
    assert seen == [([S1], {"days": 7, "currency": "USD", "encoded": True})]


@pytest.mark.parametrize("encoded", [
    '{"total":NaN}', '{"total":Infinity}', '{"total":1e999}',
    '{"total":1,"total":2}', '{"tags_not_loaded":true}', "[]", '{"total":1',
])
def test_encoded_uptime_rejects_corrupt_actual_annotated_body(viewer, monkeypatch, encoded):
    from app import main, uptime

    monkeypatch.setattr(uptime, "hourly_cost", lambda *args, **kwargs: encoded)
    monkeypatch.setattr(main, "_tags_missing_from_load", lambda: False)
    with pytest.raises(ValueError):
        asyncio.run(main.dashboard_uptime(viewer))


def test_uptime_query_fallback_retains_tag_caveat_and_privacy_validation(viewer, monkeypatch):
    from app import main, uptime
    from app.snapshot_cache import _body

    monkeypatch.setattr(uptime, "hourly_cost", lambda *args, **kwargs: {"total": 123})
    monkeypatch.setattr(main, "_tags_missing_from_load", lambda: True)
    response = asyncio.run(main.dashboard_uptime(viewer))
    assert json.loads(response.body) == {"total": 123, "tags_not_loaded": True}
    monkeypatch.setattr(uptime, "hourly_cost", lambda *args, **kwargs: '{"password":"never-cache"}')
    unsafe = asyncio.run(main.dashboard_uptime(viewer))
    assert _body(unsafe, 1024) is None


def test_legacy_tags_still_include_optional_live_keys_by_default(viewer, monkeypatch):
    from app import main, tags

    monkeypatch.setattr(tags, "cost_by_tag", lambda *args, **kwargs: {
        "keys": [], "resources": [], "total": 100})
    live = AsyncMock(return_value=[{"key": "Owner", "resources": 2}])
    monkeypatch.setattr(tags, "live_tag_keys", live)
    response = asyncio.run(main.dashboard_tags(viewer, scope=S1))
    assert json.loads(response.body)["uncosted"] == [
        {"key": "Owner", "resources": 2, "platform": False}]
    live.assert_awaited_once_with([S1])


def test_live_tags_are_separate_scoped_evidence_without_costs(viewer, monkeypatch):
    from app import main, tags

    read = AsyncMock(return_value=[{"key": "Owner", "resources": 3}])
    monkeypatch.setattr(tags, "read_live_tag_keys", read)
    response = asyncio.run(main.dashboard_live_tags(viewer, scope=S1))
    assert json.loads(response.body) == {
        "keys": [{"key": "Owner", "resources": 3, "platform": False}],
        "source": "Azure Resource Graph"}
    read.assert_awaited_once_with([S1])


def test_live_tags_reject_unauthorized_scope_before_azure_lookup(viewer, monkeypatch):
    from app import main, tags

    monkeypatch.setattr(main, "permitted", AsyncMock(return_value=[S1]))
    read = AsyncMock()
    monkeypatch.setattr(tags, "read_live_tag_keys", read)
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.dashboard_live_tags(viewer, scope=S2))
    assert error.value.status_code == 403
    read.assert_not_awaited()


def test_strict_live_tags_propagate_source_failure_and_empty_scope_never_widens(monkeypatch):
    from app import tags, waste

    read = AsyncMock(side_effect=RuntimeError("Azure evidence unavailable"))
    monkeypatch.setattr(waste, "_arg", read)
    assert asyncio.run(tags.read_live_tag_keys([])) == []
    read.assert_not_awaited()
    with pytest.raises(RuntimeError, match="Azure evidence unavailable"):
        asyncio.run(tags.read_live_tag_keys([S1]))
    assert asyncio.run(tags.live_tag_keys([S1])) == []


@pytest.mark.parametrize("listing", ["available", "empty", "failed"])
def test_picker_distinguishes_current_historical_and_unverified_access(viewer, monkeypatch, listing):
    from app import backfill, cost, main, onboarding, warehouse

    monkeypatch.setattr(warehouse.warehouse, "subscriptions", lambda: [
        {"id": S1, "name": "Current", "cost": 10},
        {"id": S2, "name": "Historical", "cost": 20},
    ])
    catalog = AsyncMock(return_value={"subscriptions": [
        {"id": S1.upper(), "name": "Current"}] if listing == "available" else []})
    if listing == "failed":
        catalog.side_effect = RuntimeError("Azure offline")
    monkeypatch.setattr(cost, "list_subscriptions", catalog)
    monkeypatch.setattr(onboarding, "settled", lambda: True)
    monkeypatch.setattr(main, "read_only_mode", lambda: True)
    monkeypatch.setattr(backfill, "status_for", lambda *args, **kwargs: {})
    response = asyncio.run(main.subscriptions(viewer))
    rows = json.loads(response.body)["subscriptions"]
    by_id = {row["id"].lower(): row for row in rows}
    assert len(rows) == 2
    assert all(row["in_warehouse"] for row in rows)
    assert by_id[S1]["cost"] == 10
    assert by_id[S2]["cost"] == 20
    assert by_id[S1]["azure_access"] is (
        True if listing == "available" else False if listing == "empty" else None)
    assert by_id[S2]["azure_access"] is (None if listing == "failed" else False)


def test_picker_case_insensitive_authorization_never_exposes_other_historical_costs(viewer, monkeypatch):
    from app import backfill, cost, main, onboarding, warehouse

    monkeypatch.setattr(main, "permitted", AsyncMock(return_value=[S1.upper()]))
    monkeypatch.setattr(warehouse.warehouse, "subscriptions", lambda: [
        {"id": S1, "name": "Allowed", "cost": 10},
        {"id": S2, "name": "Other", "cost": 20},
    ])
    monkeypatch.setattr(cost, "list_subscriptions", AsyncMock(return_value={"subscriptions": []}))
    monkeypatch.setattr(onboarding, "settled", lambda: True)
    monkeypatch.setattr(main, "read_only_mode", lambda: True)
    monkeypatch.setattr(backfill, "status_for", lambda *args, **kwargs: {})
    response = asyncio.run(main.subscriptions(viewer))
    assert [row["id"] for row in json.loads(response.body)["subscriptions"]] == [S1]
