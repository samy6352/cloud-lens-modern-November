"""Estate hygiene: configuration that is wrong rather than spend that is wasted.

The waste module answers "what am I paying for and not using". This one answers a different
question — "what is configured in a way I would not choose today" — which covers two things
people ask for constantly:

  * **Tagging.** An untagged resource cannot be charged back, filtered in a report, or found
    by its owner. Tag coverage is the single number most governance conversations start with.
  * **Accelerated networking.** Off by default on older deployments, and a free performance
    win when the size supports it — lower latency, lower jitter, less CPU spent on packets.

Both are Resource Graph queries, so this is a live tab: seconds, not milliseconds. It is kept
out of the Networking *cost* tab deliberately — that one is a warehouse query that returns
instantly, and bolting a live Azure scan onto it would make every visit slow.

Everything here is read-only.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from .cost import ARM, arm_pages, list_subscriptions
from .waste import _arg, _costs_for

log = logging.getLogger("cloudlens.governance")

COMPUTE_API = "2024-07-01"

# Resource types that exist only as children of something else, or that Azure creates and
# manages itself. Counting these as "untagged" produces a number nobody can act on: you cannot
# tag a VM extension, and a Logic App connection inherits its parent's ownership.
NOT_TAGGABLE = (
    "microsoft.compute/virtualmachines/extensions",
    "microsoft.classiccompute/domainnames",
    "microsoft.insights/autoscalesettings",
    "microsoft.alertsmanagement/smartdetectoralertrules",
    "microsoft.security/automations",
)

UNTAGGED_QUERY = """
    Resources
    | where isnull(tags) or array_length(bag_keys(tags)) == 0
    | project id, name, type, resourceGroup, subscriptionId, location
"""

TAG_COVERAGE_QUERY = """
    Resources
    | extend n = array_length(bag_keys(tags))
    | summarize total = count(), tagged = countif(isnotnull(tags) and n > 0) by type
    | order by total desc
"""

# A NIC carries the flag, but the *VM size* decides whether it can be turned on at all, so the
# size is projected here and checked against the SKU catalogue below.
#
# The join key is lowercased on both sides. Azure returns the same resource id with different
# casing depending on which resource you asked — a NIC reports its VM as `resourceGroups/tub`
# while the VM itself reports `resourceGroups/TUB` — and Kusto's join is case-sensitive, so
# joining on the raw ids silently matches nothing. The cost join in waste.py has the same
# defence for the same reason.
ACCEL_QUERY = """
    Resources
    | where type =~ 'microsoft.network/networkinterfaces'
    | extend vmId = tolower(tostring(properties.virtualMachine.id))
    | where isnotempty(vmId)
    | extend accel = tobool(properties.enableAcceleratedNetworking)
    | project nicId = id, nicName = name, resourceGroup, subscriptionId, location, accel, vmId
    | join kind=inner (
        Resources
        | where type =~ 'microsoft.compute/virtualmachines'
        | project vmId = tolower(tostring(id)), vmName = name,
                  vmSize = tostring(properties.hardwareProfile.vmSize),
                  powerState = tostring(properties.extended.instanceView.powerState.displayStatus)
      ) on vmId
    | project nicId, nicName, resourceGroup, subscriptionId, location, accel,
              vmId, vmName, vmSize, powerState
"""

# Resource groups are their own object in Resource Graph (`ResourceContainers`), not rows in
# `Resources` -- the table everything else here queries -- so finding one with nothing in it is
# an anti-join rather than a filter. The key is `subscriptionId + lowercased name` on both
# sides: a resource group's own name and the `resourceGroup` field a resource reports itself
# under can differ in casing, and Kusto's join is case-sensitive -- the same defence `ACCEL_QUERY`
# needs for the same reason.
ORPHANED_RG_QUERY = """
    ResourceContainers
    | where type == 'microsoft.resources/subscriptions/resourcegroups'
    | extend key = strcat(subscriptionId, '/', tolower(name))
    | project key, name, subscriptionId, location
    | join kind=leftouter (
        Resources
        | extend key = strcat(subscriptionId, '/', tolower(resourceGroup))
        | summarize resourceCount = count() by key
      ) on key
    | where isnull(resourceCount) or resourceCount == 0
    | project name, subscriptionId, location
"""


async def _accel_sku_support(subscription_id: str, region: str) -> dict[str, bool]:
    """Only explicit Azure SKU support flags are evidence, useful for the VM's own region."""
    data = await arm_pages(
        f"{ARM}/subscriptions/{subscription_id}/providers/Microsoft.Compute/skus",
        params={
            "api-version": COMPUTE_API,
            "$filter": f"location eq '{region}'",
        },
    )
    support: dict[str, bool] = {}
    for sku in data:
        if sku.get("resourceType") != "virtualMachines":
            continue
        for cap in sku.get("capabilities", []):
            value = str(cap.get("value", "")).lower()
            if cap.get("name") == "AcceleratedNetworkingEnabled" and value in {"true", "false"}:
                support[str(sku.get("name") or "").lower()] = value == "true"
                break
    return support


async def tagging(subscription_ids: list[str] | None = None,
                  days: int = 30, top: int = 200) -> dict[str, Any]:
    """Tag coverage across the estate, and what the untagged resources are costing."""
    subs = subscription_ids or [s["id"] for s in (await list_subscriptions())["subscriptions"]]
    if not subs:
        return {"empty": True, "reason": "No subscriptions in scope."}

    coverage, untagged = await asyncio.gather(
        _arg(TAG_COVERAGE_QUERY, subs, top=500),
        _arg(UNTAGGED_QUERY, subs, top=2000),
        return_exceptions=True,
    )
    if isinstance(coverage, Exception):
        raise coverage
    if isinstance(untagged, Exception):
        raise untagged

    # Drop the types nobody can tag, from both the list and the coverage maths, so the
    # percentage means "of things I could have tagged" rather than being permanently short.
    untagged = [r for r in untagged if str(r.get("type", "")).lower() not in NOT_TAGGABLE]
    coverage = [c for c in coverage if str(c.get("type", "")).lower() not in NOT_TAGGABLE]

    costs = await asyncio.to_thread(_costs_for, [r["id"] for r in untagged], days)
    for r in untagged:
        hit = costs.get(str(r["id"]).lower(), {})
        r["cost"] = hit.get("cost")
        r["currency"] = hit.get("currency")

    total = sum(int(c.get("total") or 0) for c in coverage)
    tagged = sum(int(c.get("tagged") or 0) for c in coverage)

    by_type = [
        {
            "type": c["type"].split("/")[-1],
            "full_type": c["type"],
            "total": int(c.get("total") or 0),
            "tagged": int(c.get("tagged") or 0),
            "untagged": int(c.get("total") or 0) - int(c.get("tagged") or 0),
            "coverage_pct": (
                round(int(c.get("tagged") or 0) / int(c["total"]) * 100, 1)
                if c.get("total") else None
            ),
        }
        for c in coverage
    ]
    by_type = [t for t in by_type if t["untagged"]]
    by_type.sort(key=lambda t: -t["untagged"])

    # Which tag keys are actually in use, so someone can see the convention they already have
    # rather than inventing a new one.
    keys = await _arg(
        "Resources | where isnotnull(tags) | mv-expand tags "
        "| extend k = tostring(bag_keys(tags)[0]) | summarize n = count() by k "
        "| order by n desc | limit 15",
        subs, top=15,
    )

    priced = [r for r in untagged if r.get("cost")]
    priced.sort(key=lambda r: -(r.get("cost") or 0))

    return {
        "days": days,
        "scanned": {"resources": total, "tagged": tagged},
        "coverage_pct": round(tagged / total * 100, 1) if total else None,
        "untagged_total": total - tagged,
        "untagged_cost": round(sum(r.get("cost") or 0 for r in priced), 2),
        "currency": next((r.get("currency") for r in priced if r.get("currency")), None),
        "by_type": by_type[:20],
        "tag_keys": [{"key": k.get("k"), "count": int(k.get("n") or 0)} for k in keys if k.get("k")],
        "resources": priced[:top],
        "note": (
            "Coverage excludes resource types that cannot carry their own tags, such as VM "
            "extensions — counting those would make the figure permanently unreachable."
        ),
    }


async def accelerated_networking(subscription_ids: list[str] | None = None,
                                 top: int = 200) -> dict[str, Any]:
    """VMs whose NIC could have accelerated networking on, and does not."""
    subs = subscription_ids or [s["id"] for s in (await list_subscriptions())["subscriptions"]]
    if not subs:
        return {"empty": True, "reason": "No subscriptions in scope."}

    limit = 2000
    nics = await _arg(ACCEL_QUERY, subs, top=limit)
    enabled = sum(n.get("accel") is True for n in nics)
    unverified = sum(n.get("accel") is None for n in nics)
    off = [n for n in nics if n.get("accel") is False]

    def scope(nic: dict) -> tuple[str, str]:
        return str(nic.get("subscriptionId") or "").lower(), str(nic.get("location") or "").lower()

    pairs = sorted({scope(nic) for nic in off if all(scope(nic))})
    concurrent = asyncio.Semaphore(8)

    async def lookup(pair: tuple[str, str]) -> dict[str, bool]:
        try:
            async with concurrent:
                return await _accel_sku_support(*pair)
        except Exception as exc:  # noqa: BLE001
            log.warning("accelerated networking: SKU catalogue unavailable for %s/%s: %s",
                        *pair, str(exc)[:200])
            return {}

    catalogues = dict(zip(pairs, await asyncio.gather(*(lookup(pair) for pair in pairs)), strict=True))
    eligible = []
    unsupported = 0
    for n in off:
        support = catalogues.get(scope(n), {}).get(str(n.get("vmSize") or "").lower())
        if support is True and n.get("nicId") and n.get("vmId"):
            eligible.append({**n, "vm": n.get("vmName"), "nic": n.get("nicName")})
        elif support is False:
            unsupported += 1
        else:
            unverified += 1
    eligible.sort(key=lambda n: (scope(n), str(n["vmId"]).lower(), str(n["nicId"]).lower()))

    return {
        "scanned": {"nics": len(nics), "vms": len({n.get("vmId") for n in nics})},
        "enabled": enabled,
        "not_supported": unsupported,
        "unverified": unverified,
        "catalogue": any(catalogues.values()),
        "eligible_count": len(eligible),
        "truncated": len(nics) >= limit or len(eligible) > top,
        "eligible": eligible[:top],
        "note": (
            "Candidates are attached NICs with Accelerated Networking off and explicit Azure VM "
            "SKU support. Verify guest OS and driver support and plan downtime: enabling it "
            "on an existing NIC requires deallocating the VM first."
        ),
    }


async def orphaned_resource_groups(subscription_ids: list[str] | None = None,
                                   top: int = 200) -> dict[str, Any]:
    """Resource groups holding nothing at all.

    Not a cost problem on its own -- an empty resource group bills nothing -- but a hygiene
    one, and a different one from what `tagging` and `accelerated_networking` find: those are
    about resources configured in a way nobody would choose today, this is about containers
    that outlived everything they held. A landing zone that provisions one resource group per
    environment or a pipeline that tears down what it deploys but not the group it deployed
    into both leave exactly this behind, and each one is a name someone has to skip past while
    looking for the resource group that still holds something.
    """
    subs = subscription_ids or [s["id"] for s in (await list_subscriptions())["subscriptions"]]
    if not subs:
        return {"empty": True, "reason": "No subscriptions in scope."}

    rows = await _arg(ORPHANED_RG_QUERY, subs, top=2000)
    rows.sort(key=lambda r: (r.get("subscriptionId") or "", str(r.get("name") or "").lower()))

    return {
        "scanned": {"resource_groups": len(rows)},
        "groups": rows[:top],
        "truncated": len(rows) > top,
        "note": (
            "A resource group can still carry role assignments, policies or locks with nothing "
            "in it to apply to -- Resource Graph only sees resources, so those are not checked "
            "here. Confirm before deleting one that a teardown really finished."
        ),
    }
