"""Unattended first run: this deployment creates its own FOCUS exports and backfills history.

Plan §7 S2, requirement R5. Switched on by CLOUDLENS_MANAGED_EXPORTS=true, which the installer
sets: running the installer is the administrator's approval, so nobody has to find the Cost data
tab and press "Review setup" before a dashboard can fill.

This module only does the part a person used to do -- find the subscriptions, check that this
deployment may export them, and approve a setup. The work itself is the existing durable pipeline
(cost_data -> focus_workflow -> jobs), unchanged in kind:

  * one `focus-setup` job; per subscription a `configure` task that adopts this deployment's own
    Parquet export (created by the operator: Cost Management lets the app's identity *run* an export
    but not *create* one, verified live 30 Sep 2026) and one task per month -- by default the
    current month and the two before it;
  * `focus_workflow.step` submits month-bounded runs newest month first, round-robin across
    subscriptions, one per subscription and at most CLOUDLENS_EXPORT_CONCURRENCY at once, backing
    off on 429; it polls manifests and imports exactly the run it asked for;
  * jobs persist in PostgreSQL; `focus_workflow.recover` resumes them after a restart without
    resubmitting a run Azure already accepted;
  * `cost_data.tick` then keeps each subscription current daily and reconciles 90 days on the 7th,
    which is what picks up late adjustments to the previous month.

Earlier months are optional. An administrator chooses up to 13 on the Setup page
(`set_history_months`); each pass then queues only the months that choice adds, for every
configured subscription whose current work has finished, as one more `focus-setup` job with no
configure step. A subscription's `extended_from` records them, so they are asked for once.

Newly visible subscriptions are onboarded on the next pass (hourly; every 5 minutes while something
is blocked or waiting, since a fresh install's role assignments take minutes to propagate). One
instance runs a pass at a time: a lease taken under the jobs advisory lock, plus idempotency keys
on the job itself.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import uuid4

from . import cost_data, focus_workflow, jobs, schedules
from .job_policy import initial_history_months, read_only_mode, require_writable

log = logging.getLogger("cloudlens.bootstrap")

FLAG = "CLOUDLENS_MANAGED_EXPORTS"
STATUS_KEY = "bootstrap:status"
LEASE_KEY = "bootstrap:lease"
HISTORY_KEY = "bootstrap:history_months"
EXCLUDED_KEY = "bootstrap:excluded_subscriptions"
LEASE_SECONDS = 900
EXPECTATION = ("First data usually arrives within a few hours. Azure can take up to 24 hours to start "
               "a brand-new export, and each month of history is a separate run.")
EXPORT_ROLE = "Cost Management Contributor"
# The only role the app may hand out on its storage account (infra/modules/stack.bicep).
STORAGE_CONDITION = (
    "((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR "
    "(@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] "
    "ForAnyOfAnyValues:GuidEquals{ba92f5b4-2d11-453d-a403-e96b0029c9fe}))")
CELL_STATES = ("queued", "running", "landed", "loaded", "failed")


def enabled() -> bool:
    return os.getenv(FLAG, "false").strip().lower() in {"true", "1"} and not read_only_mode()


def interval() -> int:
    try:
        return max(60, int(os.getenv("CLOUDLENS_BOOTSTRAP_INTERVAL", "3600")))
    except ValueError:
        return 3600


def retry_interval() -> int:
    """How soon to look again while setup is blocked. Right after an install, role assignments
    take minutes to propagate; waiting a full hour for the first export would be the norm."""
    try:
        return max(60, int(os.getenv("CLOUDLENS_BOOTSTRAP_RETRY", "300")))
    except ValueError:
        return 300


def _next_pass(result: dict[str, Any]) -> int:
    waiting = bool(result.get("error") or result.get("deployment_blockers") or result.get("blockers")
                   or result.get("history_waiting"))
    return retry_interval() if waiting else interval()


def history_months() -> int:
    """Use the persisted administrator choice, else the deployment's initial history."""
    from .warehouse import warehouse

    try:
        months = json.loads(warehouse.get_meta(HISTORY_KEY) or "{}").get("months")
    except (TypeError, ValueError, AttributeError):
        months = None
    if type(months) is int and 1 <= months <= cost_data.MANAGED_HISTORY_MONTHS:
        return months
    return initial_history_months()


def set_history_months(months: int, by: str | None = None) -> int:
    """Persist how many months to import; the next pass queues whatever that adds."""
    if type(months) is not int or not 1 <= months <= cost_data.MANAGED_HISTORY_MONTHS:
        raise ValueError(f"Choose 1–{cost_data.MANAGED_HISTORY_MONTHS} months of history.")
    require_writable()
    with jobs.transaction() as con:
        jobs._put(con, HISTORY_KEY, {"months": months, "by": by, "at": jobs.now()})
    return months


def excluded_subscriptions() -> list[str]:
    """Subscriptions intentionally excluded from managed export setup and sync."""
    from .warehouse import warehouse

    try:
        saved = json.loads(warehouse.get_meta(EXCLUDED_KEY) or "{}")
    except (TypeError, ValueError, AttributeError):
        return []
    rows = saved.get("subscriptions")
    if not isinstance(rows, list):
        return []
    unique: list[str] = []
    for value in rows:
        sid = str(value).strip().lower()
        if _GUID.match(sid) and sid not in unique:
            unique.append(sid)
    return unique


def set_excluded_subscriptions(subscription_ids: list[str], by: str | None = None) -> list[str]:
    """Persist exclusions and immediately stop managed polling for those subscriptions."""
    require_writable()
    unique: list[str] = []
    for value in subscription_ids:
        sid = str(value).strip().lower()
        if not _GUID.match(sid):
            raise ValueError(f"Invalid subscription id: {value}")
        if sid not in unique:
            unique.append(sid)
    if len(unique) > 500:
        raise ValueError("Choose at most 500 excluded subscriptions.")
    excluded_set = set(unique)
    with jobs.transaction() as con:
        jobs._put(con, EXCLUDED_KEY, {"subscriptions": unique, "by": by, "at": jobs.now()})
        for sid in unique:
            key = "focus-daily:" + sid
            config = jobs._read(con, key) or {}
            if not config:
                continue
            config.update(
                enabled=False,
                next_check=None,
                setup_job=None,
                detail="Excluded from managed sync by an administrator.",
                excluded=True,
            )
            jobs._put(con, key, config)
        # Remove stale exclusion marker from subscriptions re-enabled by list changes.
        for (key,) in con.execute("SELECT key FROM meta WHERE key LIKE 'focus-daily:%'").fetchall():
            sid = key.split("focus-daily:", 1)[-1].lower()
            if sid in excluded_set:
                continue
            config = jobs._read(con, key) or {}
            if config.get("excluded"):
                config.pop("excluded", None)
                jobs._put(con, key, config)
    return unique


def _assignee() -> str:
    return os.getenv("AZURE_CLIENT_ID") or "<app-identity-client-id>"


def fix_command(role: str, scope: str, *, condition: str | None = None) -> str:
    command = f'az role assignment create --assignee {_assignee()} --role "{role}" --scope {scope}'
    if condition:
        command += f' --condition "{condition}" --condition-version 2.0'
    return command


_GUID = re.compile(r"^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")
GRANT_ROLES = ("Reader", "Cost Management Reader", EXPORT_ROLE)


def grant_commands(sub: str) -> list[str]:
    """The role assignments that make a subscription visible to this app and let it export."""
    return [fix_command(role, f"/subscriptions/{sub}") for role in GRANT_ROLES]


def grant_script(subs: list[str]) -> str:
    """The same grant through the repository script, filled in from this App Service's own settings."""
    owner = os.getenv("WEBSITE_OWNER_NAME", "").split("+")[0]
    host = owner if _GUID.match(owner) else "<hosting-subscription-id>"
    group = os.getenv("WEBSITE_RESOURCE_GROUP") or "<resource-group>"
    app = os.getenv("WEBSITE_SITE_NAME") or "<app-name>"
    ids = ",".join(f"'{s}'" for s in subs)
    return (f".\\infra\\add-subscriptions.ps1 -HostingSubscriptionId '{host}' -ResourceGroup '{group}' "
            f"-AppName '{app}' -SubscriptionId @({ids})")


async def plan_add_subscriptions(raw_ids: list[str]) -> dict[str, Any]:
    """Which of the named subscriptions this app can already see, and how to grant the rest.

    Asked of Azure as the workload identity: the question is whether the *app* can read the
    subscription, not whether the administrator can. Nothing is granted here -- role assignments
    need an owner of the target subscription, so the app hands back the commands and then
    onboards whatever has become visible on the next pass.
    """
    from . import cost

    ids: list[str] = []
    invalid: list[str] = []
    for value in raw_ids:
        value = value.strip().lower()
        if not _GUID.match(value) or not value.strip("0-"):
            invalid.append(value)
        elif value not in ids:
            ids.append(value)

    tokens = (cost._caller.set(None), cost._caller_id.set("server"))
    try:
        async def probe(sub: str) -> dict[str, Any]:
            try:
                row = await cost.azure.request(
                    "GET", f"{cost.ARM}/subscriptions/{sub}", params={"api-version": cost.SUBS_API})
            except Exception as exc:  # noqa: BLE001 - any refusal means "not yet visible"
                return {"id": sub, "visible": False, "detail": str(exc)[:200]}
            state = row.get("state")
            return {"id": sub, "visible": state == "Enabled", "name": row.get("displayName"),
                    "detail": "" if state == "Enabled" else f"Subscription state is {state}."}

        results = list(await asyncio.gather(*(probe(s) for s in ids)))
    finally:
        cost._caller.reset(tokens[0])
        cost._caller_id.reset(tokens[1])

    missing = [r["id"] for r in results if not r["visible"]]
    for r in results:
        r["fix"] = [] if r["visible"] else grant_commands(r["id"])
    return {"subscriptions": results, "invalid": invalid,
            "script": grant_script(missing) if missing else None}


# ------------------------------------------------------------------ lease and status
def _claim(owner: str) -> bool:
    with jobs.transaction() as con:
        clock = float(con.execute("SELECT extract(epoch FROM clock_timestamp())").fetchone()[0])
        lease = jobs._read(con, LEASE_KEY) or {}
        if lease.get("expires", 0) > clock and lease.get("owner") != owner:
            return False
        jobs._put(con, LEASE_KEY, {"owner": owner, "expires": clock + LEASE_SECONDS})
        return True


def _release(owner: str) -> None:
    with jobs.transaction() as con:
        if (jobs._read(con, LEASE_KEY) or {}).get("owner") == owner:
            con.execute("DELETE FROM meta WHERE key = ?", [LEASE_KEY])


def status() -> dict[str, Any]:
    from .warehouse import warehouse

    raw = warehouse.get_meta(STATUS_KEY)
    return json.loads(raw) if raw else {}


def _save_status(value: dict[str, Any]) -> None:
    with jobs.transaction() as con:
        jobs._put(con, STATUS_KEY, value)


# ------------------------------------------------------------------ self-check
async def self_check(subscriptions: list[str]) -> tuple[dict[str, list[dict]], list[dict]]:
    """Per-subscription and deployment blockers, each with the exact command that fixes it.

    Only a *complete* permissions read that grants nothing is a blocker. A conditional grant (the
    storage role is ABAC-limited by design) or an unreadable permissions API is not evidence of
    denial; Azure is the final judge when the work is submitted.
    """
    from . import archive, capabilities

    blockers: dict[str, list[dict]] = {}
    deployment: list[dict] = []
    if not archive.ACCOUNT_ID or not archive.enabled():
        deployment.append({"capability": "storage", "detail":
                           "This deployment has no export storage account configured (ARCHIVE_ACCOUNT_ID).",
                           "fix": "Redeploy with infra/install.ps1 or infra/deploy.ps1 so the storage account "
                                  "and its app settings are created."})
    for start in range(0, len(subscriptions), capabilities.MAX_SUBSCRIPTIONS):
        batch = subscriptions[start:start + capabilities.MAX_SUBSCRIPTIONS]
        try:
            report = await capabilities.report(batch, force=True)
        except Exception as exc:  # noqa: BLE001 - an unreadable check is not a denial
            log.info("bootstrap self-check unavailable: %s", str(exc)[:200])
            continue
        for item in report["capabilities"]:
            if (item.get("feature") in {"exports-configure", "exports-run"}
                    and item.get("authorization_status") == "denied" and item.get("subscription_id")):
                sub = item["subscription_id"]
                if any(b["capability"] == "export-role" for b in blockers.get(sub, [])):
                    continue
                blockers.setdefault(sub, []).append({
                    "capability": "export-role",
                    "detail": (f"The app identity cannot create or run Cost Management exports on this "
                               f"subscription. Grant {EXPORT_ROLE} here, or once at a management group "
                               "above every monitored subscription."),
                    "fix": fix_command(EXPORT_ROLE, f"/subscriptions/{sub}"),
                })
    if archive.ACCOUNT_ID:
        observation = await capabilities._observe(archive.ACCOUNT_ID, asyncio.Semaphore(1), True)
        verdict = capabilities.evaluate_permission(
            observation["entries"], "Microsoft.Authorization/roleAssignments/write",
            complete=bool(observation["complete"]))
        if verdict["status"] == "denied":
            deployment.append({
                "capability": "storage-delegation",
                "detail": ("An export writes with its own managed identity, which the app must grant Storage "
                           "Blob Data Contributor on the export container. The app identity cannot assign "
                           "that role on its storage account."),
                "fix": fix_command("User Access Administrator", archive.ACCOUNT_ID,
                                   condition=STORAGE_CONDITION),
            })
    return blockers, deployment


# ------------------------------------------------------------------ one pass
async def run_once() -> dict[str, Any]:
    """Onboard every visible, unmanaged subscription; safe to call repeatedly and concurrently."""
    if not enabled():
        return {"enabled": False}
    owner = str(uuid4())
    if not await asyncio.to_thread(_claim, owner):
        return {"enabled": True, "skipped": "Another instance is running this pass."}
    from . import cost

    # The workload identity, never a signed-in person: this runs with nobody watching.
    tokens = (cost._caller.set(None), cost._caller_id.set("server"))
    started = datetime.now(UTC).isoformat()
    result: dict[str, Any] = {"enabled": True, "checked_at": started, "error": None}
    try:
        await focus_workflow.recover()
        listed = [{"id": s["id"].lower(), "name": s.get("name") or s["id"]}
                  for s in (await cost.list_subscriptions())["subscriptions"]]
        excluded = set(excluded_subscriptions())
        excluded_rows = [s for s in listed if s["id"] in excluded]
        subs = [s for s in listed if s["id"] not in excluded]
        pending = await asyncio.to_thread(jobs.listing, None, active_only=True, limit=500)
        busy = {sub for job in pending for sub in job["scope"]}
        configs = {s["id"]: await asyncio.to_thread(cost_data.read, s["id"]) for s in subs}
        managed = [s for s in subs if configs[s["id"]].get("version") == 2 and
                   (configs[s["id"]].get("enabled") or configs[s["id"]].get("setup_job"))]
        unmanaged = [s for s in subs if s["id"] not in busy and s not in managed]
        months = await asyncio.to_thread(history_months)
        lo, hi, _ = cost_data.managed_history(months=months)
        result.update(subscriptions=len(subs), managed=len(managed), history={"from": lo, "to": hi},
                      history_months=months, onboarding=[], job_id=None, blockers={},
                      deployment_blockers=[], in_progress=sorted(busy & {s["id"] for s in subs}),
                      resumed=[], extending=[], history_jobs=[], history_waiting=[],
                      excluded=excluded_rows)
        # Subscriptions whose setup stopped at "configure" -- almost always an export that only
        # an operator can create. Show the command, and resume the job on every pass so setup
        # continues by itself once the export exists.
        stalled: dict[str, list[dict]] = {}
        for s in managed:
            config = configs[s["id"]]
            if config.get("enabled") or s["id"] in busy or not config.get("setup_job"):
                continue
            job = await asyncio.to_thread(jobs.get, config["setup_job"])
            task = next((t for t in (job or {}).get("tasks", []) if t["subscription"] == s["id"]
                         and t.get("operation") == "configure"), None)
            if job and task and task["status"] == "failed":
                result["blockers"][s["id"]] = [{
                    "capability": "export-create",
                    "detail": (task.get("detail") or "Setup could not configure this subscription's export.")[:600],
                    "fix": schedules.operator_command(s["id"]),
                }]
                # A job still working on other subscriptions keeps going; retry once it settles.
                if job["status"] in jobs.TERMINAL:
                    stalled.setdefault(job["job_id"], []).append(s)
        for job_id in stalled:
            focus_workflow.launch(await focus_workflow.resume(job_id))
            result["resumed"].append(job_id)
        if unmanaged:
            blockers, deployment = await self_check([s["id"] for s in unmanaged])
            result["deployment_blockers"] = deployment
            eligible = [] if deployment else [s for s in unmanaged if not blockers.get(s["id"])]
            if eligible:
                plan = await cost_data.preview(eligible, action="setup", managed=True, start=lo, end=hi)
                rows = []
                for row in plan["subscriptions"]:
                    if row["blockers"]:
                        blockers.setdefault(row["subscription"], []).extend(
                            {"capability": "preflight", "detail": text} for text in row["blockers"])
                    else:
                        rows.append(row)
                if rows:
                    plan["subscriptions"] = rows
                    ids = sorted(r["subscription"] for r in rows)
                    key = "managed:" + hashlib.sha256(json.dumps([ids, lo, hi]).encode()).hexdigest()[:32]
                    record = await cost_data.create(plan, key)
                    focus_workflow.launch(record)
                    result.update(onboarding=ids, job_id=record["job_id"])
                    log.info("managed exports: onboarding %d subscription(s), job %s", len(ids),
                             record["job_id"])
            result["blockers"] = {**blockers, **result["blockers"]}
        await _extend_history(managed, configs, busy, lo, result)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - reported on the setup page and retried next pass
        log.warning("managed exports pass failed: %s", str(exc)[:300])
        result["error"] = str(exc)[:500]
    finally:
        cost._caller_id.reset(tokens[1])
        cost._caller.reset(tokens[0])
        result["finished_at"] = datetime.now(UTC).isoformat()
        try:
            await asyncio.to_thread(_save_status, result)
        finally:
            await asyncio.to_thread(_release, owner)
    return result


async def _extend_history(managed: list[dict], configs: dict[str, dict], busy: set[str], lo: str,
                          result: dict[str, Any]) -> None:
    """Queue the earlier months the chosen horizon adds, for each configured subscription.

    Only months before everything already requested: a month that was asked for and failed is
    retried from Setup, never re-queued here. A subscription still working waits for the next
    pass, so its current months finish first. Subscriptions needing the same window share one job,
    because jobs step one at a time and a job per subscription would run them one after another.
    """
    windows: dict[tuple[str, str], list[dict]] = {}
    for s in managed:
        config = configs[s["id"]]
        earliest = cost_data.requested_from(config)
        if not config.get("enabled") or not earliest or earliest <= lo:
            continue
        if s["id"] in busy:
            result["history_waiting"].append(s["id"])
            continue
        end = (date.fromisoformat(earliest) - timedelta(days=1)).isoformat()
        windows.setdefault((lo, end), []).append(s)
    for (start, end), subs in sorted(windows.items()):
        plan = await cost_data.preview(subs, action="history", managed=True, start=start, end=end)
        rows = []
        for row in plan["subscriptions"]:
            if row["blockers"]:
                result["blockers"].setdefault(row["subscription"], []).extend(
                    {"capability": "history", "detail": text} for text in row["blockers"])
            else:
                rows.append(row)
        if not rows:
            continue
        plan["subscriptions"] = rows
        ids = sorted(r["subscription"] for r in rows)
        key = "history:" + hashlib.sha256(json.dumps([ids, start, end]).encode()).hexdigest()[:32]
        record = await cost_data.create(plan, key)
        focus_workflow.launch(record)
        result["extending"].extend(ids)
        result["history_jobs"].append(record["job_id"])
        log.info("managed exports: importing %s..%s for %d subscription(s), job %s", start, end,
                 len(ids), record["job_id"])


async def run_forever(initial_delay: float = 20.0) -> None:
    """Started from the app lifespan when the flag is on."""
    await asyncio.sleep(initial_delay)
    while True:
        result: dict[str, Any] = {}
        try:
            result = await run_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - never let one bad pass stop the next
            log.warning("managed exports loop: %s", str(exc)[:300])
            result = {"error": str(exc)}
        await asyncio.sleep(_next_pass(result))


# ------------------------------------------------------------------ progress grid
def _month_list(lo: str, hi: str) -> list[str]:
    months, cursor, end = [], date.fromisoformat(lo).replace(day=1), date.fromisoformat(hi)
    while cursor <= end:
        months.append(cursor.strftime("%Y-%m"))
        cursor = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)
    return list(reversed(months))


def _cell(task: dict) -> str:
    if task["status"] == "ready":
        return "loaded"
    if task["status"] == "failed":
        return "failed"
    if task["status"] in {"downloading", "validating", "importing", "publishing"}:
        return "landed"
    if task.get("requested_at"):
        return "running"
    return "queued"


def progress(subscriptions: list[dict], *, admin: bool = False) -> dict[str, Any]:
    """Months x subscriptions, from the database only -- safe to poll.

    Columns run from the chosen horizon, or the earliest month any listed subscription was
    already asked for if that is earlier, to today -- never beyond Cost Management's 13 months.
    """
    from .warehouse import warehouse

    saved = status()
    excluded_set = set(excluded_subscriptions())
    excluded_rows = [{"id": sub["id"].lower(), "name": sub.get("name") or sub["id"]}
                     for sub in subscriptions if sub["id"].lower() in excluded_set]
    subscriptions = [sub for sub in subscriptions if sub["id"].lower() not in excluded_set]
    chosen = history_months()
    today = datetime.now(UTC).date()
    lo, hi, _ = cost_data.managed_history(today, chosen)
    floor = cost_data.managed_history(today, cost_data.MANAGED_HISTORY_MONTHS)[0]
    recent = jobs.listing(limit=500)
    rows, totals = [], dict.fromkeys((*CELL_STATES, "none"), 0)
    with warehouse.connect(read_only=True) as con:
        configs = {sub["id"].lower(): jobs._read(con, "focus-daily:" + sub["id"].lower()) or {}
                   for sub in subscriptions}
        requested = [d for d in map(cost_data.requested_from, configs.values()) if d]
        start = max(floor, min([lo, *requested]))[:8] + "01"
        months = _month_list(start, hi)
        for sub in subscriptions:
            sid = sub["id"].lower()
            own = sorted((j for j in recent if j["kind"] == "focus-setup" and sid in j["scope"]),
                         key=lambda j: j["created_at"])
            job = own[-1] if own else None
            # The first setup holds the recent months and an earlier-history job the older ones;
            # where two jobs asked for the same month, the later one is the current word.
            tasks = {t["from"][:7]: t for j in own for t in j.get("tasks", [])
                     if t["subscription"] == sid and t.get("from")}
            prefix = f"focus-day:{sid}:"
            days: dict[str, int] = {}
            for (key,) in con.execute("SELECT key FROM meta WHERE key >= ? AND key <= ?",
                                      [prefix + start, prefix + hi]).fetchall():
                month = key.rsplit(":", 1)[-1][:7]
                days[month] = days.get(month, 0) + 1
            cells = {}
            for month in months:
                task = tasks.get(month)
                if task:
                    state = _cell(task)
                    cells[month] = {"state": state, "detail": (task.get("detail") or "")[:300],
                                    "retry_at": task.get("retry_at")}
                else:
                    state = "loaded" if days.get(month) else "none"
                    cells[month] = {"state": state, "detail": "", "retry_at": None}
                totals[state] += 1
            config = configs[sid]
            rows.append({"id": sid, "name": sub.get("name") or sid,
                         "configured": config.get("version") == 2 and bool(config.get("enabled")),
                         "job_id": job["job_id"] if job else None, "cells": cells,
                         "blockers": (saved.get("blockers") or {}).get(sid, []) if admin else []})
    return {
        "enabled": enabled(), "months": months, "subscriptions": rows, "totals": totals,
        "history": {"from": start, "to": hi},
        "history_months": {"chosen": chosen, "default": initial_history_months(),
                           "max": cost_data.MANAGED_HISTORY_MONTHS},
        "expectation": EXPECTATION,
        "checked_at": saved.get("checked_at"), "error": saved.get("error") if admin else None,
        "deployment_blockers": saved.get("deployment_blockers", []) if admin else [],
        "concurrency": focus_workflow.export_concurrency(),
        "excluded": excluded_rows,
        "states": {
            "queued": "Waiting for a free export slot",
            "running": "Azure is generating this month",
            "landed": "Report delivered; importing",
            "loaded": "Imported and validated",
            "failed": "Needs attention; existing costs are kept",
            "none": "No export run requested for this month yet",
        },
    }
