"""Top contributors on one day, against the day before, on an in-memory warehouse."""
from __future__ import annotations

import re
import sqlite3
from contextlib import contextmanager

import pytest

from app.dashboard import Dashboard

pytestmark = pytest.mark.offline


class Reader:
    def __init__(self, db):
        self.db = db

    def rows(self, sql, limit=200):
        sql = re.sub(r"DATE '([^']+)'", r"'\1'", sql, flags=re.I)
        cursor = self.db.execute(sql)
        names = [column[0] for column in cursor.description]
        rows = cursor.fetchall() if limit is None else cursor.fetchmany(limit)
        return [dict(zip(names, row)) for row in rows]


class Warehouse:
    def __init__(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute('CREATE TABLE costs ("ChargePeriodStart", "BillingCurrency", "BilledCost" REAL, '
                        '"ServiceName", "ResourceGroup", "SubAccountId", "SubAccountName")')

    def add(self, amount, *, day="2026-09-10", currency="USD", service="Virtual Machines",
            group="app", subscription="sub-a"):
        self.db.execute("INSERT INTO costs VALUES (?,?,?,?,?,?,?)",
                        (day, currency, amount, service, group, subscription, subscription))

    @contextmanager
    def reader(self, scope=None, currency=None, filters=None):
        clauses = []
        if scope:
            clauses.append('"SubAccountId" IN (' + ",".join("'" + s + "'" for s in scope) + ")")
        if filters and filters.get("service"):
            clauses.append('"ServiceName" IN (' + ",".join("'" + s + "'" for s in filters["service"]) + ")")
        self.db.execute("CREATE TEMP VIEW costs AS SELECT * FROM main.costs"
                        + (" WHERE " + " AND ".join(clauses) if clauses else ""))
        try:
            yield Reader(self.db)
        finally:
            self.db.execute("DROP VIEW temp.costs")


@pytest.fixture
def dashboard():
    dashboard = Dashboard.__new__(Dashboard)
    dashboard.wh = Warehouse()
    yield dashboard
    dashboard.wh.db.close()


def test_ranks_the_day_and_compares_each_contributor_with_the_day_before(dashboard):
    dashboard.wh.add(40, day="2026-09-09", service="Virtual Machines")
    dashboard.wh.add(60, day="2026-09-10", service="Virtual Machines")
    dashboard.wh.add(20, day="2026-09-10", service="Storage")
    dashboard.wh.add(10, day="2026-09-09", service="Networking")
    result = dashboard.day_contributors(None, "2026-09-10")

    assert result["prior_day"] == "2026-09-09"
    assert [c["name"] for c in result["contributors"]] == ["Virtual Machines", "Storage", "Networking"]
    vm, storage, network = result["contributors"]
    assert (vm["cost"], vm["prior"], vm["delta"], vm["change_pct"]) == (60.0, 40.0, 20.0, 50.0)
    assert vm["share_pct"] == 75.0
    assert storage["change_pct"] is None  # nothing to compare with, not a zero change
    assert (network["cost"], network["change_pct"]) == (0.0, -100.0)
    assert result["totals"] == [{"currency": "USD", "cost": 80.0, "prior": 50.0}]
    assert result["other"] == []


def test_everything_below_the_limit_is_rolled_into_one_other_line(dashboard):
    for name, amount in [("A", 50), ("B", 30), ("C", 15), ("D", 5)]:
        dashboard.wh.add(amount, service=name)
    result = dashboard.day_contributors(None, "2026-09-10", limit=2)

    assert [c["name"] for c in result["contributors"]] == ["A", "B"]
    assert result["other"] == [{"currency": "USD", "cost": 20.0, "prior": 0.0, "count": 2}]
    assert sum(c["cost"] for c in result["contributors"]) + result["other"][0]["cost"] == 100.0


def test_mixed_currency_days_are_kept_apart_never_added_together(dashboard):
    dashboard.wh.add(30, service="Virtual Machines", currency="USD")
    dashboard.wh.add(10, service="Virtual Machines", currency="EUR")
    result = dashboard.day_contributors(None, "2026-09-10")

    assert result["mixed_currency"] is True
    assert {t["currency"] for t in result["totals"]} == {"USD", "EUR"}
    usd = next(c for c in result["contributors"] if c["currency"] == "USD")
    assert usd["share_pct"] == 100.0  # share is of that currency's own total


def test_each_currency_is_ranked_on_its_own_so_a_large_amount_cannot_crowd_out_another(dashboard):
    for name, amount in [("Databricks", 2_000_000), ("Storage", 1_000_000), ("Monitor", 500_000)]:
        dashboard.wh.add(amount, service=name, currency="INR")
    for name, amount in [("Security", 40), ("Networking", 25), ("Tiny", 5)]:
        dashboard.wh.add(amount, service=name, currency="USD")
    result = dashboard.day_contributors(None, "2026-09-10", limit=2)

    named = {cur: [c["name"] for c in result["contributors"] if c["currency"] == cur] for cur in ("INR", "USD")}
    assert named == {"INR": ["Databricks", "Storage"], "USD": ["Security", "Networking"]}
    rest = {o["currency"]: (o["cost"], o["count"]) for o in result["other"]}
    assert rest == {"INR": (500_000.0, 1), "USD": (5.0, 1)}


def test_scope_limits_the_contributors_to_the_chosen_subscriptions(dashboard):
    dashboard.wh.add(70, subscription="sub-a", service="Virtual Machines")
    dashboard.wh.add(900, subscription="sub-b", service="Storage")
    result = dashboard.day_contributors(["sub-a"], "2026-09-10")

    assert [c["name"] for c in result["contributors"]] == ["Virtual Machines"]
    assert result["totals"] == [{"currency": "USD", "cost": 70.0, "prior": 0.0}]


def test_subscription_dimension_names_each_subscription(dashboard):
    dashboard.wh.add(25, subscription="sub-a")
    dashboard.wh.add(5, subscription="sub-b")
    result = dashboard.day_contributors(None, "2026-09-10", dimension="subscription")

    assert [c["name"] for c in result["contributors"]] == ["sub-a", "sub-b"]


def test_a_day_with_no_spend_is_empty_not_an_error(dashboard):
    dashboard.wh.add(10, day="2026-08-01")
    result = dashboard.day_contributors(None, "2026-09-10")

    assert result["contributors"] == [] and result["other"] == [] and result["totals"] == []


@pytest.mark.parametrize("kwargs", [{"dimension": "tenant"}, {"day": "10/09/2026"}])
def test_rejects_an_unknown_dimension_or_a_malformed_day(dashboard, kwargs):
    arguments = {"day": "2026-09-10", **kwargs}
    with pytest.raises(ValueError):
        dashboard.day_contributors(None, **arguments)
