"""Published tab data must be the exact query answer, not an authorization cache."""
from __future__ import annotations

import datetime as dt
import json

import pytest
from psycopg.errors import UndefinedColumn

from app import jobs, reporting, tab_serving, tags, uptime

pytestmark = pytest.mark.postgres
HI = dt.date(2026, 9, 28)


def _estate():
    rows = []
    identities = ["/r/a", "/r/A", " /r/a ", "/r/shared", None, "", " ", "/credit"]
    for offset in range(100):
        day = HI - dt.timedelta(days=offset)
        for index, identity in enumerate(identities):
            rows.append({
                "ChargePeriodStart": day.isoformat(), "ResourceId": identity,
                "ResourceName": f"name-{index}", "SubAccountId": "s1" if index % 2 else "s2",
                "SubAccountName": "Subscription", "ResourceGroup": "rg", "RegionName": "west",
                "ServiceName": "Virtual Machines", "ServiceFamily": "Compute",
                "BillingCurrency": "USD", "BilledCost": -3.0 if index == 7 else 5.0,
                "EffectiveCost": -3.0 if index == 7 else 5.0,
                "PricingQuantity": 24.0, "UnitOfMeasure": "Hours",
                "MeterName": "compute", "ChargeCategory": "Usage",
                "Tags": ('{"Owner":"Ana","app":"prod"}' if index % 3 else
                         None if index == 6 else "{}"),
                "BillingCostBasis": "FOCUS" if index != 6 else None,
            })
    for currency in ("EUR", "", "unknown", "usd", None):
        rows.append({**rows[0], "ResourceId": "/other", "BillingCurrency": currency,
                     "BilledCost": 1.0})
    rows.append({**rows[0], "SubAccountId": "s3", "ResourceId": "/r/shared",
                 "BilledCost": -17.0, "Tags": '{"aks-managed-x":"bookkeeping"}'})
    return rows


@pytest.fixture(scope="module")
def estate(module_postgres_warehouse):
    from app.warehouse import COLUMNS, insert_rows

    wh = module_postgres_warehouse
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(tab_serving, "ENABLED", True)
        with wh.connect() as con:
            insert_rows(con, [[row.get(column) for column in COLUMNS] for row in _estate()])
        wh.refresh_rollup(strict=True)
        with wh.reader(usage=("hourly", "tags")) as r:
            assert r.tab_served
            assert tab_serving.read(r, "uptime", 30) is not None
        yield wh


def _function(endpoint):
    return uptime.hourly_cost if endpoint == "uptime" else tags.cost_by_tag


def _exact(wh, endpoint, days):
    with wh.reader(usage=("hourly", "tags")) as r:
        r.ranks = None
        r.counts = None
        return (uptime._build if endpoint == "uptime" else tags._build)(r, days)


@pytest.mark.parametrize("endpoint", ["uptime", "tags"])
@pytest.mark.parametrize("period", [7, 30, 60, 90, "2026-07", "2026-08", "2026-09"])
def test_normal_build_equals_exact_query(estate, endpoint, period, monkeypatch):
    month = period if isinstance(period, str) else None
    with reporting.select(month):
        days = reporting.period_days(30 if month else period)
        expected = _exact(estate, endpoint, days)
        # No exact resource/day reductions are allowed on a served request.
        module = uptime if endpoint == "uptime" else tags
        monkeypatch.setattr(module, "_build", lambda *a, **kw: pytest.fail("query fallback"))
        assert _function(endpoint)(days=days) == expected


@pytest.mark.parametrize("period", [7, 30, 60, 90, "2026-07", "2026-08", "2026-09"])
@pytest.mark.parametrize("endpoint", ["uptime", "tags"])
def test_encoded_tabs_preserve_exact_published_bytes_and_query_answer(estate, period, endpoint, monkeypatch):
    month = period if isinstance(period, str) else None
    with reporting.select(month):
        days = reporting.period_days(30 if month else period)
        expected = _exact(estate, endpoint, days)
        with estate.connect() as con:
            row = con.execute(
                f"SELECT payload FROM {tab_serving.TABLE} WHERE endpoint=? AND period=?",
                [endpoint, tab_serving.period_key(days)]).fetchone()
        monkeypatch.setattr(uptime if endpoint == "uptime" else tags, "_build",
                            lambda *a, **kw: pytest.fail("query fallback"))
        encoded = _function(endpoint)(days=days, encoded=True)
        assert isinstance(encoded, str)
        assert encoded == row[0]
        assert json.loads(encoded) == expected


@pytest.mark.parametrize("mode", ["scoped", "empty", "converted", "arbitrary", "history"])
@pytest.mark.parametrize("endpoint", ["uptime", "tags"])
def test_encoded_unsupported_tabs_retain_exact_query_path(estate, mode, endpoint, monkeypatch):
    from app import currency

    monkeypatch.setattr(currency, "rate_to", lambda code: 1.0)
    with reporting.comparison_history() if mode == "history" else reporting.select(None):
        args = {"scope": ["s1"] if mode in {"scoped", "converted"} else [] if mode == "empty" else None,
                "days": 13 if mode == "arbitrary" else 30,
                "currency": "USD" if mode == "converted" else None}
        expected = _function(endpoint)(**args)
        assert _function(endpoint)(**args, encoded=True) == expected


@pytest.mark.parametrize("text", [
    '{"cost":NaN}', '{"cost":Infinity}', '{"cost":-Infinity}', '{"cost":1e999}',
    '{"cost":-1e999}', '{"broken":', '["not a report"]',
    '{"note":"Bearer private-token","note":"ordinary"}',
    '{"rows":[{"note":"Bearer private-token","note":"ordinary"}]}',
])
def test_encoded_corrupt_or_nonfinite_publications_raise(text, monkeypatch):
    monkeypatch.setattr(tab_serving, "_read_payload", lambda *args: text)
    with pytest.raises(ValueError):
        tab_serving.read_json(None, "tags", 30)


def test_encoded_valid_json_preserves_unicode_signed_credits_and_negative_zero(monkeypatch):
    text = '{"name":"caf\\u00e9","cost":-123.456789012345,"credit":-0.0}'
    monkeypatch.setattr(tab_serving, "_read_payload", lambda *args: text)
    assert tab_serving.read_json(None, "tags", 30) == text.encode("utf-8")


@pytest.mark.parametrize("endpoint", ["uptime", "tags"])
@pytest.mark.parametrize("mode", [
    "scoped", "empty", "filtered", "converted", "month_missing", "arbitrary", "history",
])
def test_narrowed_or_unsupported_requests_use_exact_path(estate, endpoint, mode, monkeypatch):
    module = uptime if endpoint == "uptime" else tags
    calls = []
    original = module._build

    def build(r, days, *args):
        calls.append(True)
        return original(r, days, *args)

    monkeypatch.setattr(module, "_build", build)
    with reporting.select("2026-06" if mode == "month_missing" else None):
        if mode == "filtered":
            with estate.reader(filters={"region": ["west"]}, usage=("hourly", "tags")) as r:
                assert not r.tab_served
                assert tab_serving.read(r, endpoint, 30) is None
            return
        if mode == "history":
            with reporting.comparison_history(), estate.reader(usage=("hourly", "tags")) as r:
                assert tab_serving.read(r, endpoint, 30) is None
            return
        if mode == "converted":
            from app import currency
            monkeypatch.setattr(currency, "rate_to", lambda code: 1.0)
            _function(endpoint)(scope=["s1"], currency="USD")
        else:
            _function(endpoint)(scope=["s1"] if mode == "scoped" else [] if mode == "empty" else None,
                                days=13 if mode == "arbitrary" else 30)
    assert bool(calls) == (mode != "empty")


def test_current_and_disabled_refresh_are_noops(estate, monkeypatch):
    assert tab_serving.STAMP_KEY in jobs.SERVING_STAMP_KEYS
    assert tab_serving.refresh(estate) is False
    monkeypatch.setattr(tab_serving, "ENABLED", False)
    monkeypatch.setattr(estate, "connect", lambda *a, **kw: pytest.fail("disabled builder"))
    assert tab_serving.refresh(estate) is False


def test_missing_relation_and_old_contract_fall_back_without_rebuild(estate, monkeypatch):
    monkeypatch.setattr(estate, "refresh_rollup", lambda *a, **kw: pytest.fail("live rebuild"))
    with estate.connect() as con, con.raw.transaction():
        con.execute(f'ALTER TABLE {tab_serving.TABLE} RENAME TO _held_tab_serving')
        from app.warehouse import Reader
        assert tab_serving.read(Reader(con, tab_served=True), "tags", 30) is None
        con.execute(f'ALTER TABLE _held_tab_serving RENAME TO {tab_serving.TABLE}')
    with monkeypatch.context() as patch:
        patch.setattr(tab_serving, "VERSION", 999)
        with estate.reader(usage=("hourly", "tags")) as r:
            assert tab_serving.read(r, "tags", 30) is None
    assert tab_serving.refresh(estate) is False


def test_schema_failure_is_not_swallowed_and_transaction_recovers(estate):
    from app.warehouse import Reader

    with estate.connect() as con, con.raw.transaction():
        with pytest.raises(UndefinedColumn), con.raw.transaction():
            con.execute(f"ALTER TABLE {tab_serving.TABLE} RENAME COLUMN payload TO broken")
            tab_serving.read(Reader(con, tab_served=True), "tags", 30)
        assert con.execute("SELECT 1").fetchone() == (1,)
        assert tab_serving.read(Reader(con, tab_served=True), "tags", 30)


def test_failure_rolls_back_payload_and_stamp(estate, monkeypatch):
    with estate.connect() as con:
        before = con.execute(f"SELECT * FROM {tab_serving.TABLE} ORDER BY endpoint, period").fetchall()
        stamp = con.execute("SELECT value FROM meta WHERE key = ?", [tab_serving.STAMP_KEY]).fetchone()
    monkeypatch.setattr(tab_serving, "VERSION", 999)
    monkeypatch.setattr(tags, "_build", lambda *a: (_ for _ in ()).throw(RuntimeError("failed build")))
    with pytest.raises(RuntimeError, match="failed build"):
        tab_serving.refresh(estate)
    with estate.connect() as con:
        assert con.execute(f"SELECT * FROM {tab_serving.TABLE} ORDER BY endpoint, period").fetchall() == before
        assert con.execute("SELECT value FROM meta WHERE key = ?", [tab_serving.STAMP_KEY]).fetchone() == stamp


@pytest.mark.parametrize("mutation", ["ingest", "dirty", "unstamp", "invalidate", "stamp"])
def test_atomic_read_rechecks_readiness_after_reader_creation(estate, mutation):
    from app.warehouse import Reader

    # A rollback keeps the module estate pristine; the ready Reader flag is deliberately
    # held across invalidation to exercise the statement-level certificate.
    with estate.connect() as con:
        con.execute("BEGIN")
        try:
            r = Reader(con, tab_served=True)
            assert tab_serving.read(r, "tags", 30)
            assert tab_serving.read_json(r, "tags", 30)
            if mutation == "ingest":
                jobs.lock_generation(con)
                jobs.advance_generation(con, (HI, HI + dt.timedelta(days=1)))
            elif mutation == "dirty":
                jobs._write_dirty(con, *jobs._generation_pair(con), None)
            elif mutation == "unstamp":
                jobs.unstamp(con, [next(iter(tab_serving.REQUIRED))])
            elif mutation == "invalidate":
                jobs.invalidate_rollup(con)
            else:
                con.execute("DELETE FROM meta WHERE key = ?", [tab_serving.STAMP_KEY])
            assert tab_serving.read(r, "tags", 30) is None
            assert tab_serving.read_json(r, "tags", 30) is None
            assert con.execute("SELECT 1").fetchone() == (1,)
        finally:
            con.execute("ROLLBACK")


@pytest.mark.parametrize("endpoint", ["uptime", "tags"])
@pytest.mark.parametrize("daily_cap", [1, 100000])
def test_caps_ties_credits_and_raw_aliases_remain_exact(estate, endpoint, daily_cap, monkeypatch):
    monkeypatch.setattr(uptime, "MAX_ROWS", 3)
    monkeypatch.setattr(tags, "MAX_RESOURCES", 3)
    monkeypatch.setattr(uptime, "MAX_DAILY_CELLS", daily_cap)
    monkeypatch.setattr(tags, "MAX_DAILY_CELLS", daily_cap)
    try:
        assert tab_serving.refresh(estate)
        expected = _exact(estate, endpoint, 30)
        assert expected["truncated"]
        assert expected["daily_dropped"] == (daily_cap == 1)
        assert _function(endpoint)(days=30) == expected
    finally:
        monkeypatch.undo()
        tab_serving.refresh(estate)


def test_empty_generation_is_published_not_missing(postgres_warehouse, monkeypatch):
    monkeypatch.setattr(tab_serving, "ENABLED", True)
    postgres_warehouse.refresh_rollup(strict=True)
    with postgres_warehouse.reader(usage=("hourly", "tags")) as r:
        for endpoint in ("uptime", "tags"):
            expected = (uptime._empty if endpoint == "uptime" else tags._empty)(30)
            assert tab_serving.read(r, endpoint, 30) == expected


def test_unready_source_never_builds(postgres_warehouse, monkeypatch):
    monkeypatch.setattr(tab_serving, "ENABLED", True)
    monkeypatch.setattr(uptime, "_build", lambda *a: pytest.fail("unready build"))
    assert tab_serving.refresh(postgres_warehouse) is False


def test_warm_pooled_queries_resolve_later_scope_and_month_shadows(estate):
    query = 'SELECT DISTINCT "SubAccountId" AS sub FROM costs_rollup ORDER BY sub'
    with estate.reader() as r:
        for _ in range(8):  # beyond psycopg's automatic prepare threshold
            assert len(r.rows(query)) == 3
    with estate.reader(["s1"]) as r:
        assert r.rows(query) == [{"sub": "s1"}]
    edge = 'SELECT max("ChargePeriodStart") AS hi FROM costs_rollup'
    with estate.reader() as r:
        for _ in range(8):
            assert r.rows(edge) == [{"hi": HI}]
    with reporting.select("2026-07"), estate.reader() as r:
        assert r.rows(edge) == [{"hi": dt.date(2026, 7, 31)}]


def test_converted_native_currency_query_uses_one_scoped_connection(estate, monkeypatch):
    from app import currency

    monkeypatch.setattr(currency, "rate_to", lambda code: 0.5)
    original = estate.reader
    calls = []

    def reader(*args, **kwargs):
        calls.append(True)
        return original(*args, **kwargs)

    monkeypatch.setattr(estate, "reader", reader)
    with reporting.select("2026-08"):
        payload = tags.cost_by_tag(["s1"], currency="EUR")
    assert len(calls) == 1
    assert payload["currency"] == "EUR"
    assert payload["native_currencies"] == {"s1": ["USD"]}


def test_converted_native_units_preserve_server_filters(estate, monkeypatch):
    from app import currency

    monkeypatch.setattr(currency, "rate_to", lambda code: 0.5)
    with estate.reader(["s1"], currency="EUR", filters={"region": ["west"]},
                       usage=("tags",)) as r:
        assert not r.tab_served
        payload = tags._build(r, 30, "EUR")
    assert payload["native_currencies"] == {"s1": ["USD"]}


def test_native_currency_source_uses_certified_environment_grain(estate, monkeypatch):
    from app import environment, rollup

    monkeypatch.setattr(environment, "ENABLED", True)
    monkeypatch.setattr(rollup, "FILTERABLE", rollup.FILTERABLE | {"env"})
    with estate.connect() as con:
        con.fresh_tables = frozenset({rollup.TABLE})
        con.native_where = f"WHERE {environment.RAW_SQL} IN (SELECT val FROM _filter WHERE dim = 'env')"
        sql = estate._native_currency_source(con, {"env": ["prod"]})
    assert '"Environment" = ANY(' in sql
    assert '"Tags"' not in sql
