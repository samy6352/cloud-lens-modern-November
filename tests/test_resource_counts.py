"""`resource_counts` must equal counting the resources directly, for every window it serves."""
from __future__ import annotations

import datetime as dt

import pytest

from app import reporting, resource_counts

pytestmark = pytest.mark.postgres

HI = dt.date(2026, 9, 28)


def _row(day, resource, region="west", currency="USD", sub="sub-a", cost=1.0):
    return {"ChargePeriodStart": day, "ResourceId": resource, "RegionName": region,
            "BillingCurrency": currency, "SubAccountId": sub, "SubAccountName": sub,
            "ServiceName": "Compute", "ServiceFamily": "Compute", "ResourceGroup": "rg",
            "ResourceName": resource, "BilledCost": cost, "EffectiveCost": cost,
            "ChargeCategory": "Usage", "PricingModel": "OnDemand"}


def _estate():
    rows = []
    for i in range(60):
        # Staggered lifetimes so every window cuts through someone's history.
        first = dt.date(2026, 6, 1) + dt.timedelta(days=i * 2)
        last = min(first + dt.timedelta(days=10 + i % 17), HI)
        day = first
        while day <= last:
            rows.append(_row(day.isoformat(), f"/r/{i}", region="west" if i % 3 else "east",
                             currency="USD" if i % 5 else "EUR"))
            day += dt.timedelta(days=3)
        rows.append(_row(last.isoformat(), f"/r/{i}", region="west" if i % 3 else "east",
                         currency="USD" if i % 5 else "EUR"))
    # A resource seen in two regions, identities that are NULL, and a NULL region.
    rows += [_row("2026-09-20", "/moved", region="west"), _row("2026-09-25", "/moved", region="east"),
             _row("2026-09-27", None), _row("2026-08-03", None, region=None),
             _row("2026-09-26", "/regionless", region=None), _row(HI.isoformat(), "/today")]
    return rows


@pytest.fixture(scope="module")
def estate(module_postgres_warehouse):
    from app.warehouse import COLUMNS, insert_rows

    wh = module_postgres_warehouse
    with wh.connect() as con:
        insert_rows(con, [[r.get(c) for c in COLUMNS] for r in _estate()])
    wh.refresh_rollup(strict=True)
    with wh.reader() as r:
        assert r.counts == resource_counts.TABLE, "refresh_rollup must leave the counts current"
    return wh


def _direct(wh, start: dt.date, end: dt.date, *, by_region: bool):
    region = 'coalesce("RegionName", \'—\') AS name, ' if by_region else ""
    distinct = '"RegionName", ' if by_region else ""
    group = "1, 2" if by_region else "1"
    with wh.connect(read_only=True) as con:
        rows = con.execute(
            f'SELECT {region}"BillingCurrency" AS currency, count(*) FROM '
            f'(SELECT DISTINCT {distinct}"BillingCurrency", "ResourceId" FROM costs '
            f"WHERE \"ChargePeriodStart\" >= DATE '{start}' AND \"ChargePeriodStart\" <= DATE '{end}') x "
            f"GROUP BY {group}").fetchall()
    return {tuple(r[:-1]): r[-1] for r in rows}


def _served(wh, start_sql: str, month: dt.date | None, *, by_region: bool):
    with wh.reader() as r:
        assert r.counts == resource_counts.TABLE
        rows = r.rows(resource_counts.window_sql(r.counts, start_sql, month, by_region=by_region), None)
    key = ("name", "currency") if by_region else ("currency",)
    return {tuple(row[k] for k in key): row["resources"] for row in rows}


@pytest.mark.parametrize("days", [1, 3, 7, 30, 60, 90, 365])
@pytest.mark.parametrize("by_region", [False, True])
def test_rolling_windows_are_exact(estate, days, by_region):
    start = HI - dt.timedelta(days=days)
    expected = _direct(estate, start + dt.timedelta(days=1), HI, by_region=by_region)
    assert _served(estate, f"DATE '{HI}' - INTERVAL {days} DAY", None,
                   by_region=by_region) == expected


@pytest.mark.parametrize("month", ["2026-06", "2026-07", "2026-08", "2026-09"])
@pytest.mark.parametrize("by_region", [False, True])
def test_calendar_months_are_exact(estate, month, by_region):
    first = dt.date.fromisoformat(month + "-01")
    last = (first + dt.timedelta(days=32)).replace(day=1) - dt.timedelta(days=1)
    expected = _direct(estate, first, last, by_region=by_region)
    assert _served(estate, "", first, by_region=by_region) == expected


def test_only_the_unscoped_unfiltered_reader_is_served(estate):
    with estate.reader(["sub-a"]) as r:
        assert r.counts is None
    with estate.reader(filters={"region": ["west"]}) as r:
        assert r.counts is None
    with reporting.select("2026-08"), estate.reader() as r:
        assert r.counts == resource_counts.TABLE


def test_executive_counts_match_the_unserved_path(estate, monkeypatch):
    from app import warehouse
    from app.dashboard import Dashboard

    served = Dashboard().executive(None, days=30)
    original = warehouse.Reader.__init__

    def without_counts(self, *args, **kwargs):
        original(self, *args, **{**kwargs, "counts": None})

    monkeypatch.setattr(warehouse.Reader, "__init__", without_counts)
    direct = Dashboard().executive(None, days=30)
    assert served == direct
    assert any(v.get("kpis", {}).get("resources") for v in [served, *served.get("by_currency", [])])


def test_a_windowed_repair_that_moves_last_seen_earlier_stays_exact(estate):
    """Deleting a resource's latest days moves its last-seen day before the repaired span."""
    from app.warehouse import COLUMNS, insert_rows

    victim = "/late-only"
    with estate.connect() as con:
        insert_rows(con, [[r.get(c) for c in COLUMNS]
                          for r in (_row("2026-07-02", victim), _row("2026-09-24", victim))])
    estate.refresh_rollup(strict=True)
    with estate.connect() as con:
        con.execute('DELETE FROM costs WHERE "ResourceId" = ? AND "ChargePeriodStart" >= ?',
                    [victim, dt.date(2026, 9, 1)])
    estate.refresh_rollup(strict=True, window=(dt.date(2026, 9, 1), dt.date(2026, 10, 1)))
    for days in (7, 30, 90):
        start = HI - dt.timedelta(days=days)
        assert _served(estate, f"DATE '{HI}' - INTERVAL {days} DAY", None, by_region=False) == \
            _direct(estate, start + dt.timedelta(days=1), HI, by_region=False)
    assert _served(estate, "", dt.date(2026, 7, 1), by_region=False) == \
        _direct(estate, dt.date(2026, 7, 1), dt.date(2026, 7, 31), by_region=False)


def test_a_stale_table_is_never_served(estate):
    """A write advances the source generation; until the rebuild, readers count directly."""
    from app import jobs
    from app.warehouse import COLUMNS, insert_rows

    with estate.connect() as con:
        con.execute("BEGIN")
        jobs.lock_generation(con)
        insert_rows(con, [[r.get(c) for c in COLUMNS] for r in [_row(HI.isoformat(), "/fresh")]])
        jobs.advance_generation(con, (HI, HI + dt.timedelta(days=1)))
        con.execute("COMMIT")
    with estate.reader() as r:
        assert r.counts is None
    estate.refresh_rollup(strict=True, incremental=True)
    with estate.reader() as r:
        assert r.counts == resource_counts.TABLE
    assert _served(estate, f"DATE '{HI}' - INTERVAL 1 DAY", None, by_region=False) == \
        _direct(estate, HI, HI, by_region=False)


def test_refresh_is_a_no_op_when_current_and_waits_for_presence(estate):
    from app import jobs

    assert resource_counts.STAMP_KEY in jobs.SERVING_STAMP_KEYS
    assert resource_counts.refresh(estate) is False
    with estate.connect() as con:
        con.execute("UPDATE meta SET value = '-7' WHERE key = ?", [resource_counts.STAMP_KEY])
    with estate.reader() as r:
        assert r.counts is None
    assert resource_counts.refresh(estate) is True
    with estate.reader() as r:
        assert r.counts == resource_counts.TABLE


def test_a_failed_refresh_leaves_readers_on_the_direct_path(estate, monkeypatch):
    with estate.connect() as con:
        con.execute("UPDATE meta SET value = '-7' WHERE key = ?", [resource_counts.STAMP_KEY])
    monkeypatch.setattr(resource_counts, "select_sql", lambda source: "SELECT broken FROM nowhere")
    estate.refresh_serving()  # logs, never raises
    with estate.reader() as r:
        assert r.counts is None
    monkeypatch.undo()
    estate.refresh_serving()
    with estate.reader() as r:
        assert r.counts == resource_counts.TABLE
