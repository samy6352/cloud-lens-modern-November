"""Paged Resources must be the original full answer, cut into pages -- for every path.

The original query (`source == "legacy"`) is the oracle: forcing a reader without
rankings runs it unchanged. Every paged answer is compared with it resource by resource,
figure by figure.
"""
from __future__ import annotations

import datetime as dt

import pytest

from app import reporting, resource_ranks, resources

pytestmark = pytest.mark.postgres

HI = dt.date(2026, 9, 28)
SUBS = ("sub-a", "sub-b", "SUB-C")


def _row(day, resource, *, sub="sub-a", currency="USD", service="Compute", family="Compute",
         region="west", cost=1.0, tags=None, group="rg"):
    return {"ChargePeriodStart": day, "ResourceId": resource, "RegionName": region,
            "BillingCurrency": currency, "SubAccountId": sub, "SubAccountName": f"Name {sub}",
            "ServiceName": service, "ServiceFamily": family, "ResourceGroup": group,
            "ResourceName": (resource or "").rsplit("/", 1)[-1], "BilledCost": cost,
            "EffectiveCost": cost, "ChargeCategory": "Usage", "PricingModel": "OnDemand",
            "Tags": tags, "BillingCostBasis": "FOCUS"}


def _estate():
    rows = []
    for i in range(90):
        sub = SUBS[i % 3]
        rid = f"/subscriptions/{sub}/resourceGroups/rg{i % 4}/providers/x/vm{i}"
        first = dt.date(2026, 5, 20) + dt.timedelta(days=(i * 3) % 120)
        day = first
        while day <= min(first + dt.timedelta(days=20 + i % 40), HI):
            rows.append(_row(day.isoformat(), rid, sub=sub, currency="EUR" if i % 7 == 0 else "USD",
                             region="east" if i % 5 == 0 else "west", group=f"rg{i % 4}",
                             # Ties on purpose: every tenth resource costs exactly the same.
                             cost=5.0 if i % 10 == 0 else round(0.37 * (i % 13) + day.day / 10, 2),
                             tags='{"app": "a%d"}' % (i % 3) if i % 2 else None))
            if i % 4 == 0:  # a second service on the same resource
                rows.append(_row(day.isoformat(), rid, sub=sub, service="Storage", family="Storage",
                                 currency="EUR" if i % 7 == 0 else "USD", cost=0.5,
                                 region="east" if i % 5 == 0 else "west", group=f"rg{i % 4}"))
            day += dt.timedelta(days=2)
    # Case and whitespace variants fold into one identity; blanks are not resources.
    rows += [_row("2026-09-20", "/subscriptions/sub-a/X/Mixed", cost=3.0),
             _row("2026-09-21", " /subscriptions/sub-a/x/MIXED ", cost=4.0),
             _row("2026-09-22", " ", cost=9.0), _row("2026-09-22", None, cost=9.0),
             _row("2026-09-23", "/unknown-currency", currency="", cost=2.0),
             _row("2026-08-10", "/prior-only", cost=7.0),
             _row(HI.isoformat(), "/negative", cost=-3.0)]
    return rows


@pytest.fixture(scope="module")
def estate(module_postgres_warehouse):
    from app.warehouse import COLUMNS, insert_rows

    wh = module_postgres_warehouse
    with wh.connect() as con:
        insert_rows(con, [[r.get(c) for c in COLUMNS] for r in _estate()])
    wh.refresh_rollup(strict=True)
    with wh.reader() as r:
        assert r.ranks == resource_ranks.TABLE, "refresh_rollup must leave the rankings current"
    return wh


def _service(wh):
    service = resources.Resources.__new__(resources.Resources)
    service.wh = wh
    return service


@pytest.fixture
def legacy(estate, monkeypatch):
    """The original query's full answer, by forcing a reader without rankings."""
    from app import warehouse

    def run(scope=None, **kwargs):
        original = warehouse.Reader.__init__

        def unranked(self, *args, **kw):
            original(self, *args, **{**kw, "ranks": None})

        with monkeypatch.context() as m:
            m.setattr(warehouse.Reader, "__init__", unranked)
            out = _service(estate).inventory(scope, **kwargs)
        assert out.get("source") == "legacy" or out.get("empty")
        return out
    return run


def _key(item):
    return (item["subscription_id"], item["id"], item["currency"])


def _all_pages(wh, scope=None, size=7, **kwargs):
    out, page, first = [], 1, None
    while True:
        got = _service(wh).inventory(scope, page=page, page_size=size, **kwargs)
        first = first or got
        out += got["resources"]
        assert got["total"] == first["total"]
        if page >= max(1, got["pages"]):
            return first, out
        page += 1


def _same(paged, oracle):
    assert len(paged) == len(oracle)
    assert len({_key(i) for i in paged}) == len(paged), "a resource appeared on two pages"
    by_key = {_key(i): i for i in oracle}
    for item in paged:
        assert item == by_key[_key(item)]


@pytest.mark.parametrize("days", [7, 30, 60, 90, 14, 45])
def test_every_page_together_is_the_original_answer(estate, legacy, days):
    oracle = legacy(days=days)["resources"]
    first, paged = _all_pages(estate, days=days)
    assert first["source"] == ("ranked" if days in resource_ranks.ROLLING else "window")
    _same(paged, oracle)
    costs = [(i["cost"], i["prior_cost"]) for i in paged]
    assert costs == sorted(costs, reverse=True)
    assert first["total"] == len(oracle)
    for code, total in first["total_cost_by_currency"].items():
        expected = sum(i["cost"] for i in oracle if i["currency"] == code)
        assert total is None if code == "unknown" else total == pytest.approx(expected, abs=0.02)


@pytest.mark.parametrize("month", ["2026-09", "2026-08", "2026-07", "2026-06"])
def test_calendar_months(estate, legacy, month):
    with reporting.select(month):
        oracle = legacy(days=30)["resources"]
        first, paged = _all_pages(estate, days=30)
        bounds = resource_ranks.window_dates(first["as_of"], 30)
    stored = bounds in {tuple(p[1:]) for p in resource_ranks.periods_for(HI)}
    assert first["source"] == ("ranked" if stored else "window")
    _same(paged, oracle)


@pytest.mark.parametrize("kwargs", [
    {"q": "rg2"}, {"q": "MIXED"}, {"q": "100%_"}, {"billing_currency": "eur"},
    {"billing_currency": "unknown"}, {"change": "increased"}, {"change": "no-baseline"},
    {"change": "decreased", "q": "vm"}, {"sort": "delta"}, {"sort": "prior", "descending": False},
])
def test_search_filters_and_sorts_match_filtering_the_original(estate, legacy, kwargs):
    oracle = legacy(days=30)["resources"]
    q = kwargs.get("q", "").lower()
    cur = kwargs.get("billing_currency", "")
    want = [i for i in oracle
            if (not q or q in i["id"])
            and (not cur or i["currency"] == (cur.upper() if cur != "unknown" else "unknown"))
            and (not kwargs.get("change") or resources._change_of(i) == kwargs["change"])]
    first, paged = _all_pages(estate, days=30, **kwargs)
    _same(paged, want)
    field = {"cost": "cost", "prior": "prior_cost", "delta": "delta"}[kwargs.get("sort", "cost")]
    values = [i[field] for i in paged]
    assert values == sorted(values, reverse=kwargs.get("descending", True)) or \
        all(abs(a - b) <= 0.01 for a, b in zip(values, sorted(values, reverse=kwargs.get("descending", True))))


@pytest.mark.parametrize("days", [30, 14])
@pytest.mark.parametrize("scope", [["sub-a"], ["SUB-A", "sub-b"], list(SUBS)])
def test_scope_is_the_readers_scope(estate, legacy, scope, days):
    oracle = legacy(scope, days=days)["resources"]
    first, paged = _all_pages(estate, scope, days=days)
    assert first["source"] == ("ranked" if days == 30 else "window")
    _same(paged, oracle)
    assert first["total"] == len(oracle)
    for code, total in first["total_cost_by_currency"].items():
        expected = sum(i["cost"] for i in oracle if i["currency"] == code)
        assert total is None if code == "unknown" else total == pytest.approx(expected, abs=0.02)


def test_the_filter_bar_ranks_the_readers_own_rows(estate, legacy):
    oracle = legacy(days=30, filters={"region": ["east"]})["resources"]
    first, paged = _all_pages(estate, days=30, filters={"region": ["east"]})
    assert first["source"] == "filtered"
    _same(paged, oracle)


def test_without_a_page_the_original_shape_is_kept(estate, legacy, monkeypatch):
    monkeypatch.setattr(resources, "MAX_RESOURCES", 10)
    ranked = _service(estate).inventory(None, days=30)
    assert ranked["source"] == "ranked" and ranked["truncated"] and ranked["count"] == 10
    old = legacy(days=30)
    assert old["truncated"] and old["count"] == 10
    for field in ("total_cost_by_currency", "resource_groups", "regions", "services",
                  "subscriptions", "totals_scope"):
        assert ranked[field] == old[field], field
    _same(ranked["resources"], old["resources"])


def test_a_stale_ranking_is_never_served(estate):
    from app import jobs
    from app.warehouse import COLUMNS, insert_rows

    with estate.connect() as con:
        con.execute("BEGIN")
        jobs.lock_generation(con)
        insert_rows(con, [[r.get(c) for c in COLUMNS] for r in [_row(HI.isoformat(), "/fresh", cost=999.0)]])
        jobs.advance_generation(con, (HI, HI + dt.timedelta(days=1)))
        con.execute("COMMIT")
    with estate.reader() as r:
        assert r.ranks is None
    got = _service(estate).inventory(None, days=30, page=1, page_size=5)
    assert got["source"] == "legacy" and got["resources"][0]["id"] == "/fresh"
    estate.refresh_rollup(strict=True, incremental=True)
    with estate.reader() as r:
        assert r.ranks == resource_ranks.TABLE
    got = _service(estate).inventory(None, days=30, page=1, page_size=5)
    assert got["source"] == "ranked" and got["resources"][0]["id"] == "/fresh"


def test_refresh_is_a_no_op_when_current_and_a_failure_keeps_the_old_path(estate, monkeypatch):
    from app import jobs

    assert resource_ranks.STAMP_KEY in jobs.SERVING_STAMP_KEYS
    assert resource_ranks.refresh(estate) is False
    with estate.connect() as con:
        con.execute("UPDATE meta SET value = '-7' WHERE key = ?", [resource_ranks.STAMP_KEY])
    monkeypatch.setattr(resource_ranks, "build_sql", lambda *a, **k: ["SELECT broken FROM nowhere"])
    estate.refresh_serving()  # logs, never raises
    with estate.reader() as r:
        assert r.ranks is None
    monkeypatch.undo()
    estate.refresh_serving()
    with estate.reader() as r:
        assert r.ranks == resource_ranks.TABLE


def test_bad_parameters_are_refused(estate):
    with pytest.raises(ValueError):
        _service(estate).inventory(None, page=1, sort="name")
    with pytest.raises(ValueError):
        _service(estate).inventory(None, page=1, change="sideways")


@pytest.mark.parametrize("days", [1, 7, 30, 90, 365])
def test_window_dates_follow_reporting_window(days):
    class R:
        def rows(self, sql, limit=200):
            return [{"hi": HI, "lo": dt.date(2025, 1, 1)}]

    for month in (None, "2026-02", "2026-09"):
        with reporting.select(month):
            hi, start, prev = reporting.window(R(), days)
            lo, mid, top = resource_ranks.window_dates(hi, days)
            span = reporting.period_days(days)
        assert str(top) == str(hi)[:10]
        if month:
            assert start == f"DATE '{mid.isoformat()}'" and prev == f"DATE '{lo.isoformat()}'"
            assert (top - mid).days == span and (mid - lo).days == span
        else:
            assert (top - mid).days == days and (mid - lo).days == days


def test_a_month_twinned_with_a_rolling_window_is_ranked_once(monkeypatch):
    monkeypatch.setattr(reporting, "today", lambda: dt.date(2026, 9, 30))
    periods = resource_ranks.periods_for(dt.date(2026, 9, 30))
    bounds = [tuple(p[1:]) for p in periods]
    assert len(bounds) == len(set(bounds))
    assert "m2026-09" not in {p[0] for p in periods} and "m2026-08" in {p[0] for p in periods}


# ------------------------------------------------------------------ waste pricing
def _waste_costs(wh, monkeypatch, ids, days, *, ranked):
    """`waste._costs_for` on the fixture, from the integer tables or forced onto presence."""
    from app import warehouse, waste

    used = []
    original_ranked = waste._ranked_costs

    def spy(*args, **kwargs):
        rows = original_ranked(*args, **kwargs)
        used.append(rows is not None)
        return rows

    with monkeypatch.context() as m:
        m.setattr(warehouse, "warehouse", wh)
        m.setattr(waste, "_ranked_costs", spy)
        if not ranked:
            original = warehouse.Reader.__init__
            m.setattr(warehouse.Reader, "__init__",
                      lambda self, *a, **kw: original(self, *a, **{**kw, "ranks": None}))
        out = waste._costs_for(ids, days, allow_mixed=True)
    assert used == [ranked]
    return out


@pytest.mark.parametrize("month", [None, "2026-08"])
@pytest.mark.parametrize("days", [10, 3650])
def test_waste_prices_resources_from_the_ranked_ids_exactly(estate, monkeypatch, days, month):
    with estate.reader() as r:
        ids = [row["id"] for row in r.rows(
            'SELECT DISTINCT "ResourceId" AS id FROM costs WHERE "ResourceId" IS NOT NULL', None)]
    # Other spellings of one resource, and one the warehouse has never seen.
    ids += ["/SUBSCRIPTIONS/SUB-A/X/MIXED", "  /subscriptions/sub-a/x/mixed", "/not-billed"]
    with reporting.select(month):
        ranked = _waste_costs(estate, monkeypatch, ids, days, ranked=True)
        presence = _waste_costs(estate, monkeypatch, ids, days, ranked=False)
    # The last ten days and August do not overlap: both paths must agree that is nothing.
    assert bool(ranked) == (days == 3650 or month is None)
    assert ranked.keys() == presence.keys()
    for rid, value in presence.items():
        assert ranked[rid]["pricing_status"] == value["pricing_status"]
        assert ranked[rid]["currency"] == value["currency"]
        assert ranked[rid]["cost_by_currency"].keys() == value["cost_by_currency"].keys()
        for code, amount in value["cost_by_currency"].items():
            assert ranked[rid]["cost_by_currency"][code] == pytest.approx(amount, abs=0.005)
    if days == 3650 and month is None:
        assert ranked["/subscriptions/sub-a/x/mixed"]["cost_by_currency"] == {"USD": 7.0}
        assert ranked["/unknown-currency"]["pricing_status"] == "unavailable"


def test_waste_pricing_falls_back_when_the_ranked_read_fails(estate, monkeypatch):
    from app import warehouse, waste

    original = warehouse.Reader.rows

    def rows(self, sql, *args, **kwargs):
        if "resource_daily" in sql:
            raise RuntimeError("simulated")
        return original(self, sql, *args, **kwargs)

    monkeypatch.setattr(warehouse, "warehouse", estate)
    monkeypatch.setattr(warehouse.Reader, "rows", rows)
    got = waste._costs_for(["/prior-only"], 3650, allow_mixed=True)
    assert got["/prior-only"]["cost_by_currency"] == {"USD": 7.0}
