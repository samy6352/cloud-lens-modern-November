"""The Hourly Billing tab stages its window once; the answer must be the original three queries'.

`uptime.hourly_cost` used to build the same per-meter, per-day aggregation three times (meters,
the estate's daily series, per-meter cells). It now aggregates once into a temp table and
reduces that. These tests hold the staged path to the original on a fixture with the awkward
cases: a meter billed on several days, two meters on one resource, a minority currency, units
that are and are not hours, ties at the row cap, and a cap on the daily cells.

Money is a double, so the same rows summed in another order differ in the last digit; "same"
means the same meters, the same figures to the cent, and identical series.
"""
from __future__ import annotations

import datetime as dt

import pytest

pytestmark = pytest.mark.postgres

HI = dt.date(2026, 9, 28)


def _row(day, resource, meter, *, hours=24.0, unit="1 Hour", cost=1.0, currency="USD",
         sub="sub-a", service="Virtual Machines", tags=None):
    return {"ChargePeriodStart": day, "ResourceId": resource, "ResourceName": (resource or "").rsplit("/", 1)[-1],
            "RegionName": "west", "BillingCurrency": currency, "SubAccountId": sub,
            "SubAccountName": f"Name {sub}", "ServiceName": service, "ServiceFamily": "Compute",
            "ResourceGroup": "rg", "MeterName": meter, "UnitOfMeasure": unit, "PricingQuantity": hours,
            "BilledCost": cost, "EffectiveCost": cost, "ChargeCategory": "Usage",
            "PricingModel": "OnDemand", "Tags": tags, "BillingCostBasis": "FOCUS"}


def _estate():
    rows = []
    for i in range(40):
        rid = f"/subscriptions/sub-a/resourceGroups/rg/providers/x/vm{i}"
        for step in range(0, 70, 3):
            day = (HI - dt.timedelta(days=step)).isoformat()
            if step > 15 + i * 2:
                continue
            rows.append(_row(day, rid, "D2 v5", hours=24.0 if i % 3 else 12.0,
                             # Ties on purpose: every fifth meter costs the same each day.
                             cost=2.0 if i % 5 == 0 else round(0.5 + (i % 7) * 0.31, 2),
                             currency="EUR" if i % 9 == 0 else "USD",
                             tags=f'{{"app": "a{i % 3}"}}' if i % 2 else None))
            if i % 4 == 0:  # a second hourly meter on the same resource
                rows.append(_row(day, rid, "Licence", hours=24.0, cost=0.4,
                                 currency="EUR" if i % 9 == 0 else "USD"))
    rows += [
        _row(HI.isoformat(), "/not-hourly", "Storage", unit="1 GB/Month", cost=50.0),
        _row(HI.isoformat(), "/composite", "Mixed", unit="100 Hours", hours=2.0, cost=3.0),
        _row(HI.isoformat(), " ", "NoId", hours=5.0, cost=4.0),
        _row(HI.isoformat(), None, "NoIdEither", hours=5.0, cost=4.5),
        _row("2026-07-01", "/old", "Old", cost=99.0),
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


@pytest.fixture
def staged(monkeypatch):
    """Records whether the staged path answered, so a test can say which path ran."""
    from app import uptime

    seen = []
    real = uptime._stage_daily

    def wrapped(*args, **kwargs):
        ok = real(*args, **kwargs)
        seen.append(ok)
        return ok

    monkeypatch.setattr(uptime, "_stage_daily", wrapped)
    return seen


def _original(monkeypatch, scope=None, days=30):
    from app import uptime

    with monkeypatch.context() as m:
        m.setattr(uptime, "_stage_daily", lambda *a, **k: False)
        return uptime.hourly_cost(scope, days=days)


def _tags_of(payload):
    return {r["key"]: sorted(zip(r.get("keys", []), [payload["tag_values"][i] for i in r.get("v", [])]))
            for r in payload["resources"]}


def _same(new, old):
    assert {r["key"] for r in new["resources"]} == {r["key"] for r in old["resources"]}
    got, want = {r["key"]: r for r in new["resources"]}, {r["key"]: r for r in old["resources"]}
    for key, item in got.items():
        for field, value in item.items():
            if field in ("keys", "v"):
                continue
            expected = want[key][field]
            if isinstance(value, float) and expected is not None:
                assert value == pytest.approx(expected, abs=0.005), (key, field)
            else:
                assert value == expected, (key, field)
    assert _tags_of(new) == _tags_of(old)
    for field in ("trend", "weekday", "tagged", "untagged", "tag_keys", "totals", "dates", "daily"):
        assert new[field] == pytest.approx(old[field], abs=0.02) if field in ("trend", "totals") \
            else new[field] == old[field], field
    for field in ("days", "latest", "currency", "mixed_currency", "truncated", "daily_dropped",
                  "total_spend"):
        assert new[field] == pytest.approx(old[field], abs=0.02) if field == "total_spend" \
            else new[field] == old[field], field


@pytest.mark.parametrize("days", [7, 30, 60, 90])
def test_the_staged_answer_is_the_original_answer(estate, monkeypatch, staged, days):
    from app import uptime

    new = uptime.hourly_cost(None, days=days)
    assert staged and staged[-1] is True, "staging should have answered"
    _same(new, _original(monkeypatch, days=days))


def test_a_scope_is_the_readers_scope(estate, monkeypatch, staged):
    from app import uptime

    new = uptime.hourly_cost(["sub-a"], days=30)
    assert staged[-1] is True
    _same(new, _original(monkeypatch, scope=["sub-a"]))


def test_only_hour_billed_meters_are_counted(estate, staged):
    from app import uptime

    names = {r["meter"] for r in uptime.hourly_cost(None, days=30)["resources"]}
    assert "Storage" not in names and "Old" not in names
    assert {"D2 v5", "Licence"} <= names


def test_a_cap_below_the_estate_is_answered_exactly(estate, monkeypatch, staged):
    from app import uptime

    # Ties sit at the cut, so the *set* may differ between two runs of either path; every meter
    # that is in both must agree, and every dropped meter must cost no more than the last kept.
    monkeypatch.setattr(uptime, "MAX_ROWS", 12)
    new = uptime.hourly_cost(None, days=30)
    old = _original(monkeypatch)
    assert staged[-1] is True and new["truncated"] and old["truncated"]
    assert len(new["resources"]) == len(old["resources"]) == 12
    floor = min(r["cost"] for r in new["resources"])
    assert floor == pytest.approx(min(r["cost"] for r in old["resources"]), abs=0.005)
    assert new["totals"]["cost"] == pytest.approx(old["totals"]["cost"], abs=0.02)
    got, want = {r["key"]: r for r in new["resources"]}, {r["key"]: r for r in old["resources"]}
    for key in got.keys() & want.keys():
        assert got[key]["hours"] == pytest.approx(want[key]["hours"], abs=0.05)
        assert got[key]["cost"] == pytest.approx(want[key]["cost"], abs=0.005)


def test_daily_cells_over_the_cap_are_dropped_without_being_fetched(estate, monkeypatch, staged):
    from app import uptime

    monkeypatch.setattr(uptime, "MAX_DAILY_CELLS", 10)
    new = uptime.hourly_cost(None, days=30)
    assert staged[-1] is True
    assert new["daily_dropped"] is True and new["daily"] == {}
    old = _original(monkeypatch)
    assert old["daily_dropped"] is True and old["daily"] == {}
    assert new["trend"] == pytest.approx(old["trend"], abs=0.02)


def test_daily_cells_over_the_cap_are_not_fetched_at_all(estate, monkeypatch, staged):
    """Reading 150,000 cells to throw them away was a third of the tab's time."""
    from app import uptime
    from app.warehouse import Reader

    monkeypatch.setattr(uptime, "MAX_DAILY_CELLS", 10)
    sql_seen = []
    real = Reader.rows

    def spy(self, sql, *args, **kwargs):
        sql_seen.append(sql)
        return real(self, sql, *args, **kwargs)

    monkeypatch.setattr(Reader, "rows", spy)
    uptime.hourly_cost(None, days=30)
    assert staged[-1] is True
    assert not any("SELECT id, meter, currency, day, hours, cost FROM" in s for s in sql_seen)
    assert any("SELECT count(*) AS n FROM (SELECT 1 FROM _uptime_daily" in s
               and "LIMIT 11" in s for s in sql_seen)


def test_daily_cells_under_the_cap_are_fetched(estate, staged):
    from app import uptime

    new = uptime.hourly_cost(None, days=30)
    assert staged[-1] is True and not new["daily_dropped"] and new["daily"]


@pytest.mark.parametrize("indexed", [False, True])
def test_staging_that_fails_falls_back_to_the_original_queries(estate, monkeypatch, indexed):
    from app import read_indexes, uptime

    monkeypatch.setattr(read_indexes, "ENABLED", indexed)

    real = uptime._stage_daily

    def broken(r, hourly):
        # A statement that fails mid-way, as the real helper would report it.
        return real(r, hourly.replace("FROM", "FROM_BROKEN", 1))

    monkeypatch.setattr(uptime, "_stage_daily", broken)
    new = uptime.hourly_cost(None, days=30)
    monkeypatch.setattr(uptime, "_stage_daily", lambda *a, **k: False)
    _same(new, uptime.hourly_cost(None, days=30))


def test_a_reader_that_cannot_execute_uses_the_original_queries():
    from types import SimpleNamespace

    from app import uptime

    assert uptime._stage_daily(SimpleNamespace(rows=lambda *a, **k: []), "SELECT 1") is False


def test_the_staging_tables_do_not_outlive_the_call(estate):
    from app import uptime

    uptime.hourly_cost(None, days=30)
    with estate.reader(usage=("hourly",)) as r:
        left = r.rows("SELECT count(*) AS n FROM pg_tables WHERE tablename IN ('_uptime_src', '_uptime_daily')"
                      " AND schemaname LIKE 'pg_temp%'", limit=2)
    assert left[0]["n"] == 0


@pytest.mark.parametrize("unit,multiplier", [
    ("Hours", 1), (" 1 Hour ", 1), ("1 HOURS", 1), ("0.5 Hours", 0.5),
    ("10 Hours", 10), ("1/Hour", 1), ("100 hours", 100),
])
def test_fast_unit_multiplier_preserves_hourly_grain(postgres_warehouse, unit, multiplier):
    from app import uptime
    from app.warehouse import COLUMNS, insert_rows

    wh = postgres_warehouse
    record = _row(HI.isoformat(), "/unit-probe", "Duration", hours=2, unit=unit)
    with wh.connect() as con:
        insert_rows(con, [[record.get(c) for c in COLUMNS]])
    wh.refresh_rollup(strict=True)
    payload = uptime.hourly_cost()
    assert payload["resources"][0]["hours"] == pytest.approx(2 * multiplier)


def test_daily_cell_count_at_cap_is_not_dropped(estate, monkeypatch):
    from app import uptime

    uncapped = uptime.hourly_cost()
    # Count every positive meter-day, not just cells retained by the meter cap.
    with estate.reader(usage=("hourly",)) as r:
        count = r.rows(
            """SELECT count(*) AS n FROM (
                 SELECT "ResourceId", "MeterName", "BillingCurrency", "ChargePeriodStart"
                 FROM hourly_usage WHERE "ChargePeriodStart" > DATE '2026-08-29'
                   AND "BillingCurrency" = 'USD'
                 GROUP BY 1, 2, 3, 4 HAVING sum("PricingQuantity") > 0
               ) cells""")[0]["n"]
    monkeypatch.setattr(uptime, "MAX_DAILY_CELLS", count)
    _same(uptime.hourly_cost(), uncapped)


def test_metadata_is_reduced_only_after_the_meter_cap(postgres_warehouse, monkeypatch):
    from app import uptime
    from app.warehouse import COLUMNS, Reader, insert_rows

    records = [_row(HI.isoformat(), "/retained", "Compute", cost=100),
               _row("2026-09-27", "/retained", "Compute", cost=50, sub="sub-b"),
               _row(HI.isoformat(), "/discarded", "Compute", cost=1)]
    records[0]["ResourceName"] = "alpha"
    records[1]["ResourceName"] = "Zulu"
    records[1]["ResourceGroup"] = "another-group"
    wh = postgres_warehouse
    with wh.connect() as con:
        insert_rows(con, [[record.get(c) for c in COLUMNS] for record in records])
    wh.refresh_rollup(strict=True)
    monkeypatch.setattr(uptime, "MAX_ROWS", 1)
    seen = []
    real = Reader.rows

    def spy(self, sql, *args, **kwargs):
        if "FROM _uptime_src WHERE id = ANY(?)" in sql:
            seen.append(kwargs)
        return real(self, sql, *args, **kwargs)

    monkeypatch.setattr(Reader, "rows", spy)
    new = uptime.hourly_cost()
    _same(new, _original(monkeypatch))
    assert seen and seen[0]["limit"] is None
    # Includes the sentinel as well: truncation is still decided by the original cap.
    assert set(seen[0]["params"][0]) == {"/retained", "/discarded"}
