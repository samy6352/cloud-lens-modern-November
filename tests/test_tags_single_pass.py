"""The Tags tab reads its resources and their daily cells in one pass; the answer must not change.

`tags._resources_and_cells` replaces two statements -- the top resources and the per-resource
daily cells -- with one grouping-sets pass over the window. These tests hold it to those two
statements on a fixture with the awkward cases: one ResourceId billed under two subscriptions,
names that differ between rows, rows without a ResourceId, a blank currency, two currencies,
negative lines and ties. Every amount is a multiple of 1/4, so sums are exact in any order and
the payloads must be identical, not merely close.
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.postgres

SUBS = ("sub-a", "sub-b", "sub-c")


def _row(day, resource, *, sub="sub-a", currency="USD", cost=1.0, tags=None, name=None,
         group="rg", service="Compute"):
    return {"ChargePeriodStart": day, "ResourceId": resource, "RegionName": "west",
            "BillingCurrency": currency, "SubAccountId": sub, "SubAccountName": f"Name {sub}",
            "ServiceName": service, "ServiceFamily": "Compute", "ResourceGroup": group,
            "ResourceName": name if name is not None else (resource or "").rsplit("/", 1)[-1],
            "BilledCost": cost, "EffectiveCost": cost, "ChargeCategory": "Usage",
            "PricingModel": "OnDemand", "Tags": tags, "BillingCostBasis": "FOCUS"}


def _estate():
    rows = []
    for i in range(40):
        sub = SUBS[i % 3]
        rid = f"/subscriptions/{sub}/resourceGroups/rg{i % 4}/providers/x/Vm{i}"
        for day in range(1, 31, 3):
            rows.append(_row(f"2026-09-{day:02d}", rid, sub=sub, group=f"rg{i % 4}",
                             currency="EUR" if i % 9 == 0 else "USD",
                             # Ties on purpose: every fifth resource costs the same.
                             cost=4.0 if i % 5 == 0 else 0.25 * (i % 11 + day % 4),
                             tags='{"app": "a%d"}' % (i % 3) if i % 2 else None))
    rows += [
        # One ResourceId under two subscriptions, with two spellings of its name and group.
        _row("2026-09-05", "/shared/disk", sub="sub-a", name="disk-A", group="rg-a", cost=6.5),
        _row("2026-09-06", "/shared/disk", sub="sub-b", name="disk-b", group="rg-B", cost=7.25,
             service="Storage"),
        # Identical duplicate lines are two charges, and a credit nets against them.
        _row("2026-09-07", "/dup", cost=2.5), _row("2026-09-07", "/dup", cost=2.5),
        _row("2026-09-08", "/dup", cost=-1.25),
        # No ResourceId: grouped by name, blank or NULL alike.
        _row("2026-09-09", " ", name="spaces", cost=9.0), _row("2026-09-09", None, name="none", cost=9.5),
        _row("2026-09-10", "", name="", cost=3.0),
        _row("2026-09-11", "/blank-currency", currency="", cost=2.0),
        _row("2026-08-20", "/prior-month", cost=8.0),
    ]
    return rows


@pytest.fixture(scope="module")
def estate(module_postgres_warehouse):
    from app.warehouse import COLUMNS, insert_rows

    wh = module_postgres_warehouse
    with wh.connect() as con:
        insert_rows(con, [[r.get(c) for c in COLUMNS] for r in _estate()])
    wh.refresh_rollup(strict=True)
    return wh


def _both(monkeypatch, scope, month="2026-09", currency=None):
    from app import reporting, tags

    with reporting.select(month):
        single = tags.cost_by_tag(scope, currency=currency)
        with monkeypatch.context() as m:
            m.setattr(tags, "_resources_and_cells", lambda *a, **k: (None, None))
            legacy = tags.cost_by_tag(scope, currency=currency)
    return single, legacy


@pytest.mark.parametrize("scope", [None, ["sub-a"], ["sub-a", "sub-b"], ["SUB-B", "sub-c"]])
def test_single_pass_matches_the_two_statements(estate, monkeypatch, scope):
    single, legacy = _both(monkeypatch, scope)
    assert single["resources"], "the fixture must return resources for every scope"
    assert single == legacy


def test_single_pass_is_the_path_taken(estate, monkeypatch):
    from app import reporting, tags

    calls = []
    real = tags._resources_and_cells
    monkeypatch.setattr(tags, "_resources_and_cells",
                        lambda *a, **k: calls.append(1) or real(*a, **k))
    with reporting.select("2026-09"):
        tags.cost_by_tag(["sub-a", "sub-b"])
    assert calls == [1]


def test_shared_resource_keeps_no_single_subscription(estate, monkeypatch):
    single, legacy = _both(monkeypatch, ["sub-a", "sub-b"])
    shared = next(r for r in single["resources"] if r["id"] == "/shared/disk")
    assert shared["subscription_id"] == ""
    assert shared["cost"] == 13.75
    assert single == legacy


def test_truncated_answer_matches(estate, monkeypatch):
    from app import tags

    monkeypatch.setattr(tags, "MAX_RESOURCES", 7)
    single, legacy = _both(monkeypatch, None)
    assert single["truncated"] and len(single["resources"]) == 7
    assert single == legacy


def test_dropped_daily_detail_matches(estate, monkeypatch):
    from app import tags

    monkeypatch.setattr(tags, "MAX_DAILY_CELLS", 5)
    single, legacy = _both(monkeypatch, ["sub-a"])
    assert single["daily_dropped"] and not single["dates"]
    assert single == legacy


def test_mixed_currency_selects_the_same_rows(estate, monkeypatch):
    single, legacy = _both(monkeypatch, None)
    assert single["mixed"] and single["currency"] == "USD"
    assert single == legacy
