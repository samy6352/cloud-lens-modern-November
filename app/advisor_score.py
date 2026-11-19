"""Live Azure Advisor pillar scores, independent of the billing warehouse."""
from __future__ import annotations

import asyncio
import logging
import math
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

import httpx
from azure.core.exceptions import AzureError

from .cost import ARM, CostError, azure, list_subscriptions

log = logging.getLogger("cloudlens.advisor_score")
API_VERSION = "2025-01-01"
PILLARS = (
    ("Cost", "Cost"),
    ("Security", "Security"),
    ("HighAvailability", "Reliability"),
    ("OperationalExcellence", "Operational Excellence"),
    ("Performance", "Performance"),
)


def _number(value: Any, *, maximum: float | None = None) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0 or (maximum is not None and value > maximum):
        return None
    return float(value)


def _pillars(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_name = {record["name"]: record for record in records
               if isinstance(record.get("name"), str)}
    out = []
    for category, label in PILLARS:
        record = by_name.get(category) or {}
        properties = record.get("properties") or {}
        if not isinstance(properties, dict):
            raise CostError("Azure returned invalid Advisor Score properties.")
        latest = properties.get("lastRefreshedScore") or {}
        if not isinstance(latest, dict):
            raise CostError("Azure returned invalid Advisor Score details.")
        out.append({
            "category": category,
            "label": label,
            # Azure returns percentages already, including valid values between 0 and 1.
            "score": _number(latest.get("score"), maximum=100),
            "date": latest.get("date") if isinstance(latest.get("date"), str) else None,
            "impacted_resources": _number(latest.get("impactedResourceCount")),
            "potential_increase": _number(latest.get("potentialScoreIncrease"), maximum=100),
        })
    return out


async def _records(subscription: str) -> list[dict[str, Any]]:
    url = f"{ARM}/subscriptions/{subscription}/providers/Microsoft.Advisor/advisorScore"
    original = urlparse(url)
    params: dict[str, str] | None = {"api-version": API_VERSION}
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for _ in range(50):
        if url in seen:
            raise CostError("Advisor Score pagination repeated a page.")
        seen.add(url)
        payload = await azure.request("GET", url, params=params, attempts=2)
        page = payload.get("value") if isinstance(payload, dict) else None
        if not isinstance(page, list) or any(not isinstance(item, dict) for item in page):
            raise CostError("Azure returned an invalid Advisor Score response.")
        records.extend(page)
        if len(records) > 5000:
            raise CostError("Advisor Score response exceeds the safety limit.")
        next_url = payload.get("nextLink")
        if not next_url:
            return records
        if not isinstance(next_url, str):
            raise CostError("Advisor Score returned an invalid continuation URL.")
        parsed = urlparse(next_url)
        if (parsed.scheme != "https" or parsed.netloc != original.netloc
                or parsed.path.lower() != original.path.lower()):
            raise CostError("Advisor Score returned an invalid continuation URL.")
        url, params = next_url, None
    raise CostError("Advisor Score pagination exceeds the safety limit.")


async def advisor_scores(subscription_ids: list[str] | None = None) -> dict[str, Any]:
    if subscription_ids is None:
        subscription_ids = [s["id"] for s in (await list_subscriptions())["subscriptions"]]
    subscriptions = list(dict.fromkeys(str(UUID(sub)) for sub in subscription_ids))
    semaphore = asyncio.Semaphore(8)

    async def one(subscription: str) -> dict[str, Any]:
        try:
            async with semaphore, asyncio.timeout(30):
                pillars = _pillars(await _records(subscription))
            missing = [p["label"] for p in pillars if p["score"] is None]
            message = (
                "Advisor has not published a valid score for: " + ", ".join(missing) + "."
                if missing else None
            )
            if message:
                log.warning("Advisor Score incomplete for %s: %s", subscription, message)
            return {"subscription_id": subscription, "status": "partial" if missing else "ok",
                    "error": message, "pillars": pillars}
        except (CostError, TimeoutError, httpx.HTTPError, AzureError) as exc:
            if isinstance(exc, TimeoutError):
                message = "Advisor Score request timed out. Retry in a moment."
            elif isinstance(exc, httpx.HTTPError):
                message = "Could not reach Azure Advisor Score. Check connectivity and retry."
            elif isinstance(exc, AzureError):
                message = "Azure authentication for Advisor Score failed. Check the calling identity and tenant."
            elif exc.status_code == 403:
                message = "Azure refused Advisor Score access. The calling identity needs Reader on this subscription."
            elif exc.status_code == 401:
                message = "Azure rejected the credential for Advisor Score. Sign in again and check the tenant."
            else:
                message = str(exc)[:300]
            log.warning("Advisor Score unavailable for %s: %s", subscription, message)
            return {"subscription_id": subscription, "status": "error",
                    "error": message, "pillars": _pillars([])}

    rows = await asyncio.gather(*(one(sub) for sub in subscriptions))
    summary = []
    for category, label in PILLARS:
        values = [p["score"] for row in rows for p in row["pillars"]
                  if p["category"] == category and p["score"] is not None]
        summary.append({"category": category, "label": label,
                        "score": round(sum(values) / len(values), 2) if values else None,
                        "available_subscriptions": len(values),
                        "total_subscriptions": len(subscriptions)})
    errors = [{"subscription_id": row["subscription_id"], "message": row["error"]}
              for row in rows if row["error"]]
    return {
        "pillars": summary, "subscriptions": rows, "partial": bool(errors), "errors": errors,
        "aggregation": "unweighted_mean",
        "note": "CloudLens shows unweighted subscription averages, not an official Azure estate score. "
                "Missing scores are excluded, never treated as zero. These are the latest Advisor "
                "scores; billing date and currency filters do not apply.",
    }
