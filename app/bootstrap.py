"""Unattended first run: this deployment creates its own FOCUS exports and backfills history.

Plan §7 S2, requirement R5. Switched on by CLOUDLENS_MANAGED_EXPORTS=true, which the installer
sets: running the installer is the administrator's approval, so nobody has to find the Cost data
tab and press "Review setup" before a dashboard can fill.

This module only does the part a person used to do -- find the subscriptions, check that this
deployment may export them, and approve a setup. The work itself is the existing durable pipeline
(cost_data -> focus_workflow -> jobs), unchanged in kind:

  * one `focus-setup` job; per subscription a `configure` task that adopts this deployment's own
    Parquet export (created by the operator: Cost Management lets the app's identity *run* an export
    but not *create* one, verified live 30 Sep 2026) and one task per month;
  * `focus_workflow.step` submits month-bounded runs newest month first, round-robin across
    subscriptions, one per subscription and at most CLOUDLENS_EXPORT_CONCURRENCY at once, backing
    off on 429; it polls manifests and imports exactly the run it asked for;
  * jobs persist in PostgreSQL; `focus_workflow.recover` resumes them after a restart without
    resubmitting a run Azure already accepted;
  * `cost_data.tick` then keeps each subscription current daily and reconciles 90 days on the 7th,
    which is what picks up late adjustments to the previous month.

Newly visible subscriptions are onboarded on the next pass (hourly; every 5 minutes while something
is blocked, since a fresh install's role assignments take minutes to propagate). One instance runs a pass at a
time: a lease taken under the jobs advisory lock, plus idempotency keys on the job itself.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import uuid4

from . import cost_data, focus_workflow, jobs, schedules
from .job_policy import read_only_mode

log = logging.getLogger("cloudlens.bootstrap")

FLAG = "CLOUDLENS_MANAGED_EXPORTS"
STATUS_KEY = "bootstrap:status"
LEASE_KEY = "bootstrap:lease"
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
    waiting = bool(result.get("error") or result.get("deployment_blockers") or result.get("blockers"))
    return retry_interval() if waiting else interval()


def _assignee() -> str:
    return os.getenv("AZURE_CLIENT_ID") or "<app-identity-client-id>"


def fix_command(role: str, scope: str, *, condition: str | None = None) -> str:
    command = f'az role assignment create --assignee {_assignee()} --role "{role}" --scope {scope}'
    if condition:
        command += f' --condition "{condition}" --condition-version 2.0'
    return command


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
        subs = [{"id": s["id"].lower(), "name": s.get("name") or s["id"]}
                for s in (await cost.list_subscriptions())["subscriptions"]]
        pending = await asyncio.to_thread(jobs.listing, None, active_only=True, limit=500)
        busy = {sub for job in pending for sub in job["scope"]}
        configs = {s["id"]: await asyncio.to_thread(cost_data.read, s["id"]) for s in subs}
        managed = [s for s in subs if configs[s["id"]].get("version") == 2]
        unmanaged = [s for s in subs if configs[s["id"]].get("version") != 2 and s["id"] not in busy]
        lo, hi, _ = cost_data.managed_history()
        result.update(subscriptions=len(subs), managed=len(managed), history={"from": lo, "to": hi},
                      onboarding=[], job_id=None, blockers={}, deployment_blockers=[],
                      in_progress=sorted(busy & {s["id"] for s in subs}), resumed=[])
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
    """Months x subscriptions, from the database only -- safe to poll."""
    from .warehouse import warehouse

    saved = status()
    history = saved.get("history") or dict(zip(("from", "to"), cost_data.managed_history()[:2]))
    months = _month_list(history["from"], history["to"])
    recent = jobs.listing(limit=500)
    rows, totals = [], dict.fromkeys((*CELL_STATES, "none"), 0)
    with warehouse.connect(read_only=True) as con:
        for sub in subscriptions:
            sid = sub["id"].lower()
            job = max((j for j in recent if j["kind"] == "focus-setup" and sid in j["scope"]),
                      key=lambda j: j["created_at"], default=None)
            tasks = {t["from"][:7]: t for t in (job or {}).get("tasks", [])
                     if t["subscription"] == sid and t.get("from")}
            prefix = f"focus-day:{sid}:"
            days: dict[str, int] = {}
            for (key,) in con.execute("SELECT key FROM meta WHERE key >= ? AND key <= ?",
                                      [prefix + history["from"], prefix + history["to"]]).fetchall():
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
            config = jobs._read(con, "focus-daily:" + sid) or {}
            rows.append({"id": sid, "name": sub.get("name") or sid,
                         "configured": config.get("version") == 2 and bool(config.get("enabled")),
                         "job_id": job["job_id"] if job else None, "cells": cells,
                         "blockers": (saved.get("blockers") or {}).get(sid, []) if admin else []})
    return {
        "enabled": enabled(), "months": months, "subscriptions": rows, "totals": totals,
        "history": history, "expectation": EXPECTATION,
        "checked_at": saved.get("checked_at"), "error": saved.get("error") if admin else None,
        "deployment_blockers": saved.get("deployment_blockers", []) if admin else [],
        "concurrency": focus_workflow.export_concurrency(),
        "states": {
            "queued": "Waiting for a free export slot",
            "running": "Azure is generating this month",
            "landed": "Report delivered; importing",
            "loaded": "Imported and validated",
            "failed": "Needs attention; existing costs are kept",
            "none": "No export run requested for this month yet",
        },
    }
