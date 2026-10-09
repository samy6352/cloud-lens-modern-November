"""S2: the unattended first run creates exports and backfills, against a fake ARM.

Everything between the app and Azure is real -- `cost.azure` (retries, Retry-After, caching),
`schedules`, `capabilities`, `cost_data`, `focus_sync`, `focus_workflow`, durable `jobs` -- and
Azure itself is an `httpx.MockTransport` that keeps state like the real service: exports exist
once PUT, and a run is only visible as a report after it was requested. Only the blob read of a
finished report and its import are stood in for; tests/test_parquet_exports.py covers those.
"""
from __future__ import annotations

import asyncio
import json
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from tests.test_focus_schedules import offline_modules  # noqa: F401
from tests.test_job_orchestration import durable  # noqa: F401

pytestmark = pytest.mark.offline

ACCOUNT = ("/subscriptions/99999999-0000-0000-0000-000000000000/resourceGroups/rg-cl/providers/"
           "Microsoft.Storage/storageAccounts/offline")
S1, S2, S3, S4, S5 = (f"00000000-0000-0000-0000-00000000000{n}" for n in range(1, 6))
EXPORT_GRANT = {"actions": ["*/read", "Microsoft.CostManagement/*"], "notActions": []}
READ_ONLY = {"actions": ["*/read"], "notActions": []}


class FakeArm:
    """Stateful enough to be honest: exports persist, runs are recorded, 429s are scripted."""

    def __init__(self):
        self.exports: dict[str, dict[str, dict]] = {}
        self.puts: list[tuple[str, dict]] = []
        self.grants: list[str] = []
        self.runs: list[tuple[str, dict]] = []
        self.throttle: dict[str, int] = {}
        # What the live tenant does (30 Sep 2026): the app's identity may run exports, not write them.
        self.deny_writes = False
        self.permissions = {S1: EXPORT_GRANT, S3: EXPORT_GRANT, S4: READ_ONLY, S5: EXPORT_GRANT}
        self.pages = [
            [{"subscriptionId": S1, "displayName": "One", "state": "Enabled"},
             {"subscriptionId": S2, "displayName": "Two (disabled)", "state": "Disabled"}],
            [{"subscriptionId": S3, "displayName": "Three", "state": "Enabled"},
             {"subscriptionId": S4, "displayName": "Four", "state": "Enabled"},
             {"subscriptionId": S5, "displayName": "Five", "state": "Enabled"}],
        ]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = urlsplit(str(request.url))
        path, query = url.path, parse_qs(url.query)
        body = json.loads(request.content) if request.content else None
        if path == "/subscriptions":
            page = int(query.get("$skiptoken", ["0"])[0])
            payload = {"value": self.pages[page]}
            if page + 1 < len(self.pages):
                payload["nextLink"] = ("https://management.azure.com/subscriptions?"
                                       f"api-version=2022-12-01&$skiptoken={page + 1}")
            return httpx.Response(200, json=payload)
        if path.endswith("/providers/Microsoft.Authorization/permissions"):
            if path.startswith(ACCOUNT):
                return httpx.Response(200, json={"value": [{
                    "actions": ["*/read", "Microsoft.Authorization/*"], "notActions": [],
                    "condition": "@Request[...] ForAnyOfAnyValues:GuidEquals{ba92f5b4}",
                    "conditionVersion": "2.0"}]})
            sub = path.split("/")[2]
            return httpx.Response(200, json={"value": [self.permissions[sub]]})
        if "/providers/Microsoft.Authorization/roleAssignments/" in path:
            self.grants.append(path)
            return httpx.Response(201, json={})
        sub = path.split("/")[2]
        exports = self.exports.setdefault(sub, {})
        if path.endswith("/providers/Microsoft.CostManagement/exports"):
            return httpx.Response(200, json={"value": list(exports.values())})
        name = path.split("/exports/")[1].split("/")[0]
        if path.endswith("/run"):
            if self.throttle.get(sub):
                self.throttle[sub] -= 1
                return httpx.Response(429, headers={"Retry-After": "5"}, json={"error": {"code": "429"}})
            self.runs.append((sub, body["timePeriod"]))
            return httpx.Response(200, json={})
        if request.method == "PUT":
            if self.deny_writes:
                return httpx.Response(401, json={"error": {
                    "code": "RBACAccessDenied",
                    "message": "The client does not have authorization to perform action."}})
            self.puts.append((sub, body))
            saved = {**body, "name": name, "eTag": f"v{len(self.puts)}",
                     "identity": {"type": "SystemAssigned", "principalId": f"mi-{sub[-1]}"}}
            exports[name] = saved
            return httpx.Response(200, json=saved)
        if name in exports:
            return httpx.Response(200, json=exports[name])
        return httpx.Response(404, json={"error": {"code": "ExportNotFound"}})


@pytest.fixture
def azure(durable, monkeypatch):  # noqa: F811
    from app import archive, cost, exports, focus_workflow, schedules

    arm = FakeArm()
    original = httpx.AsyncClient
    monkeypatch.setattr(cost.httpx, "AsyncClient", lambda **kw: original(
        transport=httpx.MockTransport(arm), **kw))
    monkeypatch.setattr(cost.azure, "_bearer", AsyncMock(return_value="offline-token"))
    monkeypatch.setattr(cost, "_retry_after", lambda response, attempt: 0)
    monkeypatch.setenv("CLOUDLENS_MANAGED_EXPORTS", "true")
    monkeypatch.setenv("CLOUDLENS_EXPORT_CONCURRENCY", "2")
    monkeypatch.setenv("AZURE_CLIENT_ID", "synthetic-client")
    monkeypatch.setenv("AUTO_FOCUS_SYNC", "true")
    monkeypatch.setattr(archive, "ACCOUNT_ID", ACCOUNT)
    monkeypatch.setattr(archive, "ACCOUNT", "offline")
    monkeypatch.setattr(archive, "LOCATION", "centralindia")
    monkeypatch.setattr(schedules, "FOCUS_CONTAINER", "focus-exports")
    monkeypatch.setattr(schedules, "FOCUS_PREFIX", "focus")
    launched = []
    monkeypatch.setattr(focus_workflow, "launch", lambda record: launched.append(record["job_id"]))
    # A report exists for a window only once Azure was asked to run it.
    landed: set[tuple[str, str]] = set()

    async def manifests(schedule):
        sub = schedule["folder"].rsplit("/", 1)[-1]
        return [SimpleNamespace(run_id=f"{sub}:{w['from'][:10]}", submitted="2999-01-01T00:00:00+00:00",
                                export_name=schedule["name"], dataset="FocusCost",
                                window=(w["from"][:10], w["to"][:10]), timeframe="Custom")
                for s, w in arm.runs if s == sub and (sub, w["from"][:10]) in landed]

    monkeypatch.setattr(focus_workflow, "manifests", manifests)
    monkeypatch.setattr(focus_workflow, "actual_window", lambda m: m.window)
    ingest = AsyncMock(return_value={"rows": 10, "changed_days": 1, "unchanged_days": 0})
    monkeypatch.setattr(exports, "ingest_export", ingest)
    cost.clear_cache()
    yield SimpleNamespace(arm=arm, launched=launched, landed=landed, ingest=ingest,
                          jobs=durable[0], flow=focus_workflow)
    cost.clear_cache()


def _month(offset: int, today: date | None = None) -> str:
    cursor = (today or datetime.now(UTC).date()).replace(day=1)
    for _ in range(offset):
        cursor = (cursor - timedelta(days=1)).replace(day=1)
    return cursor.isoformat()


def test_managed_history_defaults_to_three_months_and_allows_up_to_thirteen():
    from app import cost_data

    assert cost_data.managed_history(date(2026, 9, 30)) == ("2026-07-01", "2026-09-30", 92)
    assert cost_data.managed_history(date(2026, 9, 30), 13) == ("2025-09-01", "2026-09-30", 395)
    assert cost_data.managed_history(date(2024, 3, 1), 13) == ("2023-03-01", "2024-03-01", 367)
    for bad in (0, 14, "3", True, 3.0):
        with pytest.raises(ValueError):
            cost_data.managed_history(date(2026, 9, 30), bad)
    today = datetime.now(UTC).date()
    lo, hi, _ = cost_data.managed_history()
    assert cost_data.managed_window(lo, hi)[:2] == (lo, hi)
    # Optional earlier months end before today, and reach back to the 13th month at most.
    earlier = (_month(12), (date.fromisoformat(_month(2)) - timedelta(days=1)).isoformat())
    assert cost_data.managed_window(*earlier)[:2] == earlier
    for bad in [((date.fromisoformat(lo) + timedelta(days=1)).isoformat(), hi),  # not month-aligned
                (_month(13), hi),                                                # 14 months
                (_month(13), earlier[1]),                                        # 14th month, ends early
                (lo, (today + timedelta(days=1)).isoformat())]:                  # future
        with pytest.raises(ValueError):
            cost_data.managed_window(*bad)
    # The interactive horizon is unchanged: 365 days, validated as before.
    with pytest.raises(ValueError):
        cost_data.history_window(history_days=366)
    assert cost_data.requested_from({}) is None
    assert cost_data.requested_from({"history": {"from": "2026-07-01"}, "extended_from": "2025-10-01"}) == "2025-10-01"


def test_one_month_initial_history_limits_managed_setup_and_preserves_admin_choice(azure, monkeypatch):
    from app import bootstrap

    monkeypatch.setenv("INGEST_MONTHS", "1")
    first = asyncio.run(bootstrap.run_once())
    assert first["error"] is None and first["history_months"] == 1
    job = azure.jobs.get(first["job_id"])
    windows = [task for task in job["tasks"] if task.get("from")]
    assert len(windows) == 3
    assert {task["from"][:7] for task in windows} == {_month(0)[:7]}
    grid = bootstrap.progress([{"id": S1, "name": "One"}], admin=True)
    assert grid["history_months"] == {"chosen": 1, "default": 1, "max": 13}
    assert grid["months"] == [_month(0)[:7]]
    assert bootstrap.set_history_months(6, "Admin") == 6
    monkeypatch.setenv("INGEST_MONTHS", "1")
    assert bootstrap.history_months() == 6
    assert bootstrap.progress([{"id": S1, "name": "One"}])["history_months"] == {
        "chosen": 6, "default": 1, "max": 13}


def test_subscription_listing_follows_next_link_and_refuses_to_leave_arm(azure, monkeypatch):
    from app import cost

    subs = asyncio.run(cost.list_subscriptions())["subscriptions"]
    assert [s["id"] for s in subs] == [S1, S3, S4, S5]
    azure.arm.pages[0][0]["subscriptionId"] = S1  # unchanged; now point the link elsewhere
    original = azure.arm.__call__

    def hostile(request):
        response = original(request)
        if urlsplit(str(request.url)).path == "/subscriptions" and "nextLink" in response.json():
            return httpx.Response(200, json={**response.json(), "nextLink": "https://evil.invalid/subscriptions"})
        return response

    monkeypatch.setattr(FakeArm, "__call__", lambda self, request: hostile(request))
    cost.clear_cache()
    with pytest.raises(cost.CostError, match="outside Azure Resource Manager"):
        asyncio.run(cost.list_subscriptions())


def test_first_run_creates_parquet_exports_and_queues_three_months_newest_first(azure):
    from app import bootstrap, cost_data

    first = asyncio.run(bootstrap.run_once())
    assert first["error"] is None and first["subscriptions"] == 4 and first["history_months"] == 3
    # S4's identity may read but not export: blocked, with the exact command that fixes it.
    assert first["onboarding"] == [S1, S3, S5]
    fix = first["blockers"][S4][0]["fix"]
    assert fix == (f'az role assignment create --assignee synthetic-client --role '
                   f'"Cost Management Contributor" --scope /subscriptions/{S4}')
    assert first["deployment_blockers"] == []  # the ABAC-conditional storage grant is not a denial
    job = azure.jobs.get(first["job_id"])
    assert azure.launched == [job["job_id"]]
    assert job["kind"] == "focus-setup" and job["identity"] == "workload" and job["payload"]["managed"]
    lo, hi, _ = cost_data.managed_history()
    assert (job["payload"]["from"], job["payload"]["to"]) == (lo, hi)
    windows = [t for t in job["tasks"] if t.get("from")]
    assert len([t for t in job["tasks"] if t.get("operation") == "configure"]) == 3
    assert len(windows) == 3 * 3 and {t["from"][:7] for t in windows} == {
        _month(n)[:7] for n in range(3)}

    # Idempotent: a second pass, or a second instance, creates nothing new.
    again = asyncio.run(bootstrap.run_once())
    assert again["onboarding"] == [] and again["job_id"] is None
    assert len(azure.jobs.listing()) == 1
    assert azure.arm.puts == []  # nothing is written to Azure until the job runs

    # One step: configure every subscription, then fill the two export slots with the newest month.
    asyncio.run(azure.flow.step(job["job_id"]))
    created = dict(azure.arm.puts)
    assert set(created) == {S1, S3, S5}
    for body in created.values():
        p = body["properties"]
        assert p["format"] == "Parquet" and p["compressionMode"] == "snappy"
        assert p["definition"]["dataSet"]["configuration"]["dataVersion"] == "1.0r2"
        assert p["schedule"]["status"] == "Inactive"  # the app drives exact windows itself
    assert len(azure.arm.grants) == 3
    assert [(s, w["from"][:10]) for s, w in azure.arm.runs] == [(S1, _month(0)), (S3, _month(0))]
    saved = azure.jobs.get(job["job_id"])
    s5_now = next(t for t in saved["tasks"] if t["subscription"] == S5 and t.get("from") == _month(0))
    assert s5_now["status"] == "queued" and "CLOUDLENS_EXPORT_CONCURRENCY" in s5_now["detail"]

    # Reports land: S5's current month goes before anyone's previous month (round-robin).
    azure.landed.update({(S1, _month(0)), (S3, _month(0))})
    asyncio.run(azure.flow.step(job["job_id"]))
    assert [(s, w["from"][:10]) for s, w in azure.arm.runs][2:] == [(S5, _month(0)), (S1, _month(1))]
    assert azure.ingest.await_count == 2
    kwargs = azure.ingest.await_args.kwargs
    assert kwargs["required_metric"] == "FocusCost" and kwargs["run_identity"][0].endswith(_month(0))


def test_throttled_runs_back_off_exponentially_under_retry_after(azure, monkeypatch):
    from app import bootstrap

    monkeypatch.setenv("CLOUDLENS_EXPORT_CONCURRENCY", "1")
    job_id = asyncio.run(bootstrap.run_once())["job_id"]
    azure.arm.throttle[S1] = 10  # every attempt inside Azure._fetch and the next pass: 429

    def s1_now():
        return next(t for t in azure.jobs.get(job_id)["tasks"]
                    if t["subscription"] == S1 and t.get("from") == _month(0))

    asyncio.run(azure.flow.step(job_id))
    task = s1_now()
    assert task["throttles"] == 1 and task["requested_at"] is None
    wait = datetime.fromisoformat(task["retry_at"]) - datetime.now(UTC)
    assert timedelta(seconds=50) < wait <= timedelta(seconds=60)  # Retry-After 5 s, floor 60 s
    # Throttling is tenant-wide: no other subscription starts a run while the backoff lasts,
    # and the throttled submission holds no slot.
    assert azure.arm.runs == []
    others = [t for t in azure.jobs.get(job_id)["tasks"] if t.get("from") == _month(0) and t["subscription"] != S1]
    assert {t["status"] for t in others} == {"queued"} and all("throttling" in t["detail"] for t in others)
    monkeypatch.setattr(azure.jobs, "now", lambda: task["retry_at"])
    asyncio.run(azure.flow.step(job_id))
    task = s1_now()
    wait = datetime.fromisoformat(task["retry_at"]) - datetime.now(UTC)
    assert task["throttles"] == 2 and timedelta(seconds=110) < wait <= timedelta(seconds=120)
    azure.arm.throttle[S1] = 0
    monkeypatch.setattr(azure.jobs, "now", lambda: task["retry_at"])
    asyncio.run(azure.flow.step(job_id))
    task = s1_now()
    assert task["throttles"] == 0 and task["requested_at"] and task["status"] == "waiting-for-Azure"
    # Newest month first again once the backoff passes; the cap (1) then holds everyone else.
    assert [s for s, _ in azure.arm.runs] == [S1]


def test_restart_resumes_from_the_database_without_resubmitting(azure):
    from app import bootstrap, focus_workflow

    job_id = asyncio.run(bootstrap.run_once())["job_id"]
    asyncio.run(focus_workflow.step(job_id))
    submitted = list(azure.arm.runs)
    assert len(submitted) == 2
    # A new process: nothing in memory, the job and its submission intents only in the database.
    focus_workflow._running.clear()
    azure.launched.clear()
    after = asyncio.run(bootstrap.run_once())
    assert after["job_id"] is None and after["in_progress"] == [S1, S3, S5]
    assert azure.launched == [job_id]  # recovered, not recreated
    asyncio.run(focus_workflow.step(job_id))
    assert azure.arm.runs == submitted  # still generating: polled, never asked again


def test_newly_visible_subscription_is_onboarded_on_the_next_pass(azure):
    from app import bootstrap

    first = asyncio.run(bootstrap.run_once())
    azure.arm.pages[1].append({"subscriptionId": "00000000-0000-0000-0000-000000000006",
                               "displayName": "Six", "state": "Enabled"})
    azure.arm.permissions["00000000-0000-0000-0000-000000000006"] = EXPORT_GRANT
    from app import cost
    cost.clear_cache()
    second = asyncio.run(bootstrap.run_once())
    assert second["onboarding"] == ["00000000-0000-0000-0000-000000000006"]
    assert second["job_id"] != first["job_id"]


def test_disabled_flag_and_read_only_do_nothing(azure, monkeypatch):
    from app import bootstrap

    monkeypatch.setenv("CLOUDLENS_MANAGED_EXPORTS", "false")
    assert asyncio.run(bootstrap.run_once()) == {"enabled": False}
    monkeypatch.setenv("CLOUDLENS_MANAGED_EXPORTS", "true")
    monkeypatch.setenv("CLOUDLENS_READ_ONLY", "true")
    assert asyncio.run(bootstrap.run_once()) == {"enabled": False}
    assert azure.jobs.listing() == [] and azure.arm.puts == []


def test_progress_grid_months_by_subscription(azure):
    from app import bootstrap

    job_id = asyncio.run(bootstrap.run_once())["job_id"]
    asyncio.run(azure.flow.step(job_id))
    azure.landed.add((S1, _month(0)))
    asyncio.run(azure.flow.step(job_id))
    subs = [{"id": s, "name": n} for s, n in ((S1, "One"), (S3, "Three"), (S4, "Four"), (S5, "Five"))]
    grid = bootstrap.progress(subs, admin=True)
    assert grid["months"][0] == _month(0)[:7] and len(grid["months"]) == 3
    assert grid["history_months"] == {"chosen": 3, "default": 3, "max": 13}
    rows = {r["id"]: r for r in grid["subscriptions"]}
    assert rows[S1]["cells"][_month(0)[:7]]["state"] == "loaded"
    assert rows[S3]["cells"][_month(0)[:7]]["state"] == "running"
    # S1's slot went to S5's current month, not to S1's previous month.
    assert rows[S5]["cells"][_month(0)[:7]]["state"] == "running"
    assert rows[S1]["cells"][_month(1)[:7]]["state"] == "queued"
    assert "CLOUDLENS_EXPORT_CONCURRENCY" in rows[S1]["cells"][_month(1)[:7]]["detail"]
    assert rows[S4]["cells"][_month(0)[:7]]["state"] == "none"
    assert "az role assignment create" in rows[S4]["blockers"][0]["fix"]
    assert grid["totals"]["loaded"] == 1 and "24 hours" in grid["expectation"]
    viewer = bootstrap.progress(subs, admin=False)
    assert all(r["blockers"] == [] for r in viewer["subscriptions"])
    assert viewer["deployment_blockers"] == [] and viewer["error"] is None

def test_progress_and_check_now_routes(azure, monkeypatch):
    """HTTP contract: anyone signed in sees their grid; blockers and "Check now" are for admins."""
    from fastapi import HTTPException

    from app import main

    admin = SimpleNamespace(state=SimpleNamespace(user=SimpleNamespace(
        admin=True, source="local", name="Admin", sid="s")), query_params={})
    viewer = SimpleNamespace(state=SimpleNamespace(user=SimpleNamespace(
        admin=False, source="local", name="Viewer", sid="s")), query_params={})
    monkeypatch.setattr(main, "permitted", AsyncMock(return_value=None))
    started = json.loads(asyncio.run(main.run_cost_data_bootstrap(admin)).body)
    assert started["onboarding"] == [S1, S3, S5]
    with pytest.raises(HTTPException) as denied:
        asyncio.run(main.run_cost_data_bootstrap(viewer))
    assert denied.value.status_code == 403
    grid = json.loads(asyncio.run(main.cost_data_progress(admin)).body)
    assert [r["id"] for r in grid["subscriptions"]] == [S1, S3, S4, S5]
    assert grid["subscriptions"][2]["blockers"][0]["fix"].startswith("az role assignment create")
    seen = json.loads(asyncio.run(main.cost_data_progress(viewer)).body)
    assert all(r["blockers"] == [] for r in seen["subscriptions"])
    monkeypatch.setenv("CLOUDLENS_MANAGED_EXPORTS", "false")
    with pytest.raises(HTTPException) as off:
        asyncio.run(main.run_cost_data_bootstrap(admin))
    assert off.value.status_code == 409 and "CLOUDLENS_MANAGED_EXPORTS" in off.value.detail


def _finish(azure, job_id: str) -> None:
    """Run a job the way `launch` does, letting every report it asks for land, until it is done."""
    for _ in range(30):
        asyncio.run(azure.jobs.run(job_id, lambda: azure.flow.step(job_id)))
        azure.landed.update((s, w["from"][:10]) for s, w in azure.arm.runs)
        if azure.jobs.get(job_id)["status"] in azure.jobs.TERMINAL:
            return
    raise AssertionError("the job never finished")


def test_earlier_history_is_optional_and_queued_once_after_current_work(azure):
    """Three months by default. An administrator adds earlier ones: every configured subscription
    gets just the months that adds, as one more job, after its first months -- and only once."""
    from app import bootstrap, cost_data

    setup = asyncio.run(bootstrap.run_once())["job_id"]
    asyncio.run(azure.flow.step(setup))  # configures S1, S3 and S5; their first months start
    assert bootstrap.history_months() == 3
    assert bootstrap.set_history_months(13, "Admin") == 13 and bootstrap.history_months() == 13
    for bad in (0, 14, "13", True):
        with pytest.raises(ValueError):
            bootstrap.set_history_months(bad)

    # Still importing the first months: nothing is queued yet, and they are looked at again soon.
    waiting = asyncio.run(bootstrap.run_once())
    assert waiting["extending"] == [] and waiting["history_waiting"] == [S1, S3, S5]
    assert len(azure.jobs.listing()) == 1

    _finish(azure, setup)
    assert azure.jobs.get(setup)["status"] == "ready"
    extended = asyncio.run(bootstrap.run_once())
    assert extended["error"] is None and extended["extending"] == [S1, S3, S5]
    job = azure.jobs.get(extended["history_jobs"][0])
    assert azure.launched[-1] == job["job_id"]
    assert job["kind"] == "focus-setup" and job["identity"] == "workload"
    assert job["payload"]["action"] == "history" and job["payload"]["managed"]
    assert job["payload"]["to"] == (date.fromisoformat(_month(2)) - timedelta(days=1)).isoformat()
    # Only the ten earlier months; no reconfiguration; reports Azure already delivered are reused.
    assert not [t for t in job["tasks"] if t.get("operation") == "configure"]
    assert len(job["tasks"]) == 3 * 10 and not any(t["force_new"] for t in job["tasks"])
    assert {t["from"][:7] for t in job["tasks"]} == {_month(n)[:7] for n in range(3, 13)}
    for sub in (S1, S3, S5):
        config = cost_data.read(sub)
        # Recorded with the job, so it is asked for once; the daily catch-up anchor is untouched.
        assert config["extended_from"] == _month(12) and config["history"]["from"] == _month(2)
    again = asyncio.run(bootstrap.run_once())
    assert again["extending"] == [] and again["history_waiting"] == [] and len(azure.jobs.listing()) == 2

    # All thirteen months show: the recent ones from the first job, the earlier ones queued.
    grid = bootstrap.progress([{"id": s, "name": s} for s in (S1, S3, S4, S5)], admin=True)
    assert len(grid["months"]) == 13 and grid["history_months"]["chosen"] == 13
    row = {r["id"]: r for r in grid["subscriptions"]}[S1]
    assert row["job_id"] == job["job_id"]
    assert row["cells"][_month(0)[:7]]["state"] == "loaded"
    assert row["cells"][_month(12)[:7]]["state"] == "queued"

    # Newest earlier month first, round-robin across subscriptions, within the cap (2).
    runs = len(azure.arm.runs)
    asyncio.run(azure.flow.step(job["job_id"]))
    assert [(s, w["from"][:10]) for s, w in azure.arm.runs[runs:]] == [(S1, _month(3)), (S3, _month(3))]


def test_history_route_is_admin_only_bounded_and_applies_at_once(azure, monkeypatch):
    from fastapi import HTTPException
    from pydantic import ValidationError

    from app import bootstrap, main

    admin = SimpleNamespace(state=SimpleNamespace(user=SimpleNamespace(
        admin=True, source="local", name="Admin", sid="s")), query_params={})
    viewer = SimpleNamespace(state=SimpleNamespace(user=SimpleNamespace(
        admin=False, source="local", name="Viewer", sid="s")), query_params={})
    monkeypatch.setattr(main, "permitted", AsyncMock(return_value=None))
    for bad in (0, 14, "6", 6.5, True):
        with pytest.raises(ValidationError):
            main.HistoryRequest(months=bad)
    body = main.HistoryRequest(months=6)
    with pytest.raises(HTTPException) as denied:
        asyncio.run(main.set_cost_data_history(body, viewer))
    assert denied.value.status_code == 403 and bootstrap.history_months() == 3
    result = json.loads(asyncio.run(main.set_cost_data_history(body, admin)).body)
    # Nothing was set up yet, so the first run itself imports the six months.
    assert result["months"] == 6 and result["onboarding"] == [S1, S3, S5]
    job = azure.jobs.get(result["job_id"])
    assert {t["from"][:7] for t in job["tasks"] if t.get("from")} == {_month(n)[:7] for n in range(6)}
    grid = json.loads(asyncio.run(main.cost_data_progress(viewer)).body)
    assert grid["history_months"] == {"chosen": 6, "default": 3, "max": 13} and len(grid["months"]) == 6
    monkeypatch.setenv("CLOUDLENS_MANAGED_EXPORTS", "false")
    with pytest.raises(HTTPException) as off:
        asyncio.run(main.set_cost_data_history(body, admin))
    assert off.value.status_code == 409


def test_blocked_setup_is_rechecked_in_minutes_not_hours(monkeypatch):
    """Right after an install the role assignments are still propagating."""
    from app import bootstrap

    monkeypatch.delenv("CLOUDLENS_BOOTSTRAP_INTERVAL", raising=False)
    monkeypatch.delenv("CLOUDLENS_BOOTSTRAP_RETRY", raising=False)
    assert bootstrap._next_pass({"blockers": {S4: [{"capability": "export-role"}]}}) == 300
    assert bootstrap._next_pass({"deployment_blockers": [{"capability": "storage"}]}) == 300
    assert bootstrap._next_pass({"error": "throttled"}) == 300
    # Earlier months chosen while a subscription is still importing start minutes after it ends.
    assert bootstrap._next_pass({"history_waiting": [S1]}) == 300
    assert bootstrap._next_pass({"blockers": {}, "deployment_blockers": [], "error": None}) == 3600


def test_an_unregistered_export_provider_says_who_can_fix_it():
    from app import schedules

    text = schedules._explain_create(
        "Azure returned 409: MissingSubscriptionRegistration: The subscription is not registered to use "
        "namespace 'Microsoft.CostManagementExports'.", S1)
    assert f"az provider register --namespace Microsoft.CostManagementExports --subscription {S1}" in text


def test_an_export_the_app_may_not_create_is_created_by_an_operator_and_then_adopted(azure, monkeypatch):
    """The live finding: the app's identity may run an export but not create or update one.

    Setup stops at `configure` with the exact operator command, keeps rechecking, and continues on
    its own once the operator has created the export -- which it then adopts as its own, leaves
    alone (its native schedule cannot be paused either), and runs month by month.
    """
    from app import bootstrap, cost_data, focus_sync, schedules

    monkeypatch.setenv("WEBSITE_RESOURCE_GROUP", "rg-cl")
    monkeypatch.setenv("WEBSITE_SITE_NAME", "cloudlens-abc")
    azure.arm.deny_writes = True
    job_id = asyncio.run(bootstrap.run_once())["job_id"]
    asyncio.run(azure.jobs.run(job_id, lambda: azure.flow.step(job_id)))
    job = azure.jobs.get(job_id)
    configure = next(t for t in job["tasks"] if t["subscription"] == S1 and t.get("operation") == "configure")
    command = f"./infra/focus-exports.ps1 -ResourceGroup rg-cl -WebAppName cloudlens-abc -Subscriptions {S1} -Paused"
    assert configure["status"] == "failed" and command in configure["detail"]
    assert job["status"] == "failed" and azure.arm.runs == []

    # The next pass names the fix per subscription and retries (every 5 min while blocked).
    second = asyncio.run(bootstrap.run_once())
    assert second["resumed"] == [job_id]
    assert second["blockers"][S1][0]["fix"] == command
    assert bootstrap._next_pass(second) == bootstrap.retry_interval()

    # The operator runs the command: the export now exists, created by a person, and active.
    for sub in (S1, S3, S5):
        name = schedules.export_name("FocusCost", **schedules.destination(sub))
        body = schedules._body("FocusCost", ACCOUNT, "focus-exports", f"focus/{sub}")
        body["properties"]["schedule"]["status"] = "Active"
        azure.arm.exports.setdefault(sub, {})[name] = {**body, "name": name, "eTag": "op1"}
    # The startup/list cache still says no owned export; an operator write cannot invalidate it.
    assert asyncio.run(focus_sync.owned([S1])) == []
    # The job the second pass resumed now runs, as `launch` would run it.
    asyncio.run(azure.jobs.run(job_id, lambda: azure.flow.step(job_id)))
    assert azure.arm.puts == []  # adopted, never rewritten
    config = cost_data.read(S1)
    assert config["enabled"] and config["native_schedule"].startswith("active")
    # Month windows now run as the app's identity -- the operation it is allowed.
    assert [(s, w["from"][:10]) for s, w in azure.arm.runs] == [(S1, _month(0)), (S3, _month(0))]
    fourth = asyncio.run(bootstrap.run_once())
    # Only S4's genuinely missing export role remains; nothing is resumed again.
    assert set(fourth["blockers"]) == {S4} and fourth["resumed"] == []
