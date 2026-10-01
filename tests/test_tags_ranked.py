"""The Tags tab chooses its resources from the stored rankings; the answer must be the same.

`tags.cost_by_tag` used to group every resource in the window and keep the top 8,000. It now
reads the candidates from `resource_ranks` and runs its own aggregation over them. These tests
hold that to the original query on a fixture with the awkward cases: raw spellings that fold
into one ranked identity, rows without a ResourceId, two currencies, scopes, ties.

Money is a double, so the same rows summed in another order differ in the last digit; the
original query does that between two identical runs. "Same" therefore means the same
resources, the same tags and keys, and every figure equal to the cent.
"""
from __future__ import annotations

import datetime as dt

import pytest

pytestmark = pytest.mark.postgres

HI = dt.date(2026, 9, 28)
SUBS = ("sub-a", "sub-b", "sub-c")


def _row(day, resource, *, sub="sub-a", currency="USD", cost=1.0, tags=None, group="rg"):
    return {"ChargePeriodStart": day, "ResourceId": resource, "RegionName": "west",
            "BillingCurrency": currency, "SubAccountId": sub, "SubAccountName": f"Name {sub}",
            "ServiceName": "Compute", "ServiceFamily": "Compute", "ResourceGroup": group,
            "ResourceName": (resource or "").rsplit("/", 1)[-1] or "(blank)", "BilledCost": cost,
            "EffectiveCost": cost, "ChargeCategory": "Usage", "PricingModel": "OnDemand",
            "Tags": tags, "BillingCostBasis": "FOCUS"}


def _estate():
    rows = []
    for i in range(60):
        sub = SUBS[i % 3]
        rid = f"/subscriptions/{sub}/resourceGroups/rg{i % 4}/providers/x/vm{i}"
        for step in range(0, 80, 2):
            day = HI - dt.timedelta(days=step)
            if step > 20 + i % 50:
                continue
            rows.append(_row(day.isoformat(), rid, sub=sub, group=f"rg{i % 4}",
                             currency="EUR" if i % 7 == 0 else "USD",
                             # Ties on purpose: every tenth resource costs the same.
                             cost=5.0 if i % 10 == 0 else round(0.37 * (i % 13) + day.day / 10, 2),
                             tags='{"app": "a%d", "env": "e%d"}' % (i % 3, i % 2) if i % 2 else None))
    rows += [
        # One resource spelled two ways: two raw groups, one ranked identity.
        _row("2026-09-20", "/subscriptions/sub-a/X/Mixed", cost=30.0, tags='{"app": "m"}'),
        _row("2026-09-21", " /subscriptions/sub-a/x/MIXED ", cost=40.0, tags='{"app": "m"}'),
        # No ResourceId at all: grouped by name, and absent from the rankings.
        _row("2026-09-22", " ", cost=90.0), _row("2026-09-22", None, cost=95.0),
        _row("2026-09-23", "/unknown-currency", currency="", cost=2.0),
        _row("2026-08-10", "/prior-only", cost=7.0),
        _row(HI.isoformat(), "/negative", cost=-3.0),
    ]
    return rows


@pytest.fixture(scope="module")
def estate(module_postgres_warehouse):
    from app import resource_ranks
    from app.warehouse import COLUMNS, insert_rows

    wh = module_postgres_warehouse
    with wh.connect() as con:
        insert_rows(con, [[r.get(c) for c in COLUMNS] for r in _estate()])
    wh.refresh_rollup(strict=True)
    with wh.reader() as r:
        assert r.ranks == resource_ranks.TABLE, "refresh_rollup must leave the rankings current"
    return wh


@pytest.fixture
def small(monkeypatch):
    """A cap small enough that the candidates, not the whole estate, decide the answer."""
    from app import tags

    monkeypatch.setattr(tags, "MAX_RESOURCES", 20)
    monkeypatch.setattr(tags, "CANDIDATE_MARGIN", 4)


@pytest.fixture
def spy(monkeypatch):
    """Records what the ranked read returned, so a test can say which path answered."""
    from app import tags

    seen = []
    real = tags._ranked_candidates

    def wrapped(*args, **kwargs):
        got = real(*args, **kwargs)
        seen.append(got)
        return got

    monkeypatch.setattr(tags, "_ranked_candidates", wrapped)
    return seen


def _original(monkeypatch, scope=None, days=30):
    from app import tags

    with monkeypatch.context() as m:
        m.setattr(tags, "_ranked_candidates", lambda *a, **k: None)
        return tags.cost_by_tag(scope, days=days)


def _tags_of(payload):
    return {r["id"]: sorted(zip(r["keys"], [payload["values"][i] for i in r["v"]]))
            for r in payload["resources"]}


def _same(new, old):
    assert {r["id"] for r in new["resources"]} == {r["id"] for r in old["resources"]}
    got, want = {r["id"]: r for r in new["resources"]}, {r["id"]: r for r in old["resources"]}
    for rid, item in got.items():
        for field in ("name", "service", "subscription", "subscription_id", "group", "tag_status", "d"):
            assert item[field] == want[rid][field], (rid, field)
        assert item["cost"] == pytest.approx(want[rid]["cost"], abs=0.005)
    assert _tags_of(new) == _tags_of(old)
    assert [(k["key"], k["resources"], k["values"], k["platform"]) for k in new["keys"]] == \
           [(k["key"], k["resources"], k["values"], k["platform"]) for k in old["keys"]]
    for a, b in zip(new["keys"], old["keys"]):
        assert a["cost"] == pytest.approx(b["cost"], abs=0.02)
    for field in ("currency", "mixed", "truncated", "tags_not_loaded", "days", "latest",
                  "daily_dropped", "totals_scope", "dates", "native_currencies", "platform_keys"):
        assert new[field] == old[field], field
    for field in ("tagged", "untagged", "unknown"):
        assert new[field]["resources"] == old[field]["resources"], field
        assert new[field]["cost"] == pytest.approx(old[field]["cost"], abs=0.02)
    assert new["total"] == pytest.approx(old["total"], abs=0.02)


@pytest.mark.parametrize("days", [7, 30, 60, 90])
def test_the_ranked_answer_is_the_original_answer(estate, monkeypatch, spy, days):
    from app import tags

    new = tags.cost_by_tag(None, days=days)
    assert spy and spy[-1] is not None, "the rankings should have answered"
    _same(new, _original(monkeypatch, days=days))


@pytest.mark.parametrize("scope", [["sub-a"], ["SUB-A", "sub-b"], list(SUBS)])
def test_scope_is_the_readers_scope(estate, monkeypatch, spy, scope):
    from app import tags

    new = tags.cost_by_tag(scope, days=30)
    assert spy[-1] is not None
    _same(new, _original(monkeypatch, scope=scope))


def test_two_spellings_of_one_resource_stay_two_groups(estate, spy):
    from app import tags

    ids = {r["id"] for r in tags.cost_by_tag(None, days=30)["resources"]}
    assert "/subscriptions/sub-a/X/Mixed" in ids and " /subscriptions/sub-a/x/MIXED " in ids


def test_rows_without_a_resource_id_are_still_counted(estate, monkeypatch, spy):
    from app import tags

    new = tags.cost_by_tag(None, days=30)
    assert spy[-1] is not None
    # Grouped by name, as before; the rankings leave them out, so the query asks for them itself.
    assert any(r["name"] == "(blank)" for r in new["resources"])
    _same(new, _original(monkeypatch))


@pytest.mark.parametrize("days", [7, 30, 90])
def test_a_cap_below_the_estate_is_answered_exactly(estate, monkeypatch, spy, small, days):
    """With the candidates deciding the answer, either they prove it or the full query runs."""
    from app import tags

    new = tags.cost_by_tag(None, days=days)
    assert spy and spy[-1] is not None
    assert len(new["resources"]) == 20 and new["truncated"] is True
    _same(new, _original(monkeypatch, days=days))


def test_candidates_that_cannot_prove_the_answer_fall_back(estate, monkeypatch, spy, small):
    """A cut-off the answer does not clear is refused rather than trusted."""
    from app import tags

    real = tags._ranked_candidates

    def too_few(r, hi, days, code):
        raw, _ = real(r, hi, days, code)
        # Pretend the ranking stopped at a cost no answer row can beat.
        return raw[:25], 10 ** 9

    monkeypatch.setattr(tags, "_ranked_candidates", too_few)
    new = tags.cost_by_tag(None, days=30)
    monkeypatch.setattr(tags, "_ranked_candidates", lambda *a, **k: None)
    _same(new, tags.cost_by_tag(None, days=30))


def test_a_calendar_month_is_not_served_from_the_rankings(estate, spy):
    from app import reporting, tags

    with reporting.select("2026-09"):
        tags.cost_by_tag(None, days=30)
    assert spy and all(got is None for got in spy)


def test_a_window_the_rankings_do_not_hold_uses_the_full_query(estate, spy):
    from app import tags

    tags.cost_by_tag(None, days=14)
    assert spy and all(got is None for got in spy)


def test_a_converted_currency_view_uses_the_full_query(estate, spy):
    from app import tags

    tags.cost_by_tag(None, days=30, currency="EUR")
    assert all(got is None for got in spy) or not spy


def test_a_failed_ranked_read_falls_back_to_the_full_query(estate, monkeypatch):
    from app import tags

    def broken(*args, **kwargs):
        raise RuntimeError("rankings unreadable")

    monkeypatch.setattr(tags, "_ranked_candidates", broken)
    new = tags.cost_by_tag(None, days=30)
    monkeypatch.setattr(tags, "_ranked_candidates", lambda *a, **k: None)
    _same(new, tags.cost_by_tag(None, days=30))


def test_a_stale_ranking_is_never_used(estate, monkeypatch):
    from app import resource_ranks, tags

    monkeypatch.setattr(resource_ranks, "current", lambda *a, **k: False)
    with estate.reader(usage=("tags",)) as r:
        assert getattr(r, "ranks", None) is None
    assert tags.cost_by_tag(None, days=30)["resources"], "the full query still answers"
