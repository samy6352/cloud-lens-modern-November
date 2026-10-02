"""Every resource ranked by cost, so the Resources tab can page instead of loading them all.

Why
---
The Resources tab used to build per-service detail for every resource in the window and
then publish the top 8,000. Measured on the 16.9M-row estate (30 Sep 2026): 107.6 s, of
which ~90 s was sorting and grouping two million long text ids under the database's
libc collation (external merges spilling ~3 GB). Numbering each resource once and
ranking integers instead measured 6.4 s for a 30-day window; ranking once per rebuild
and reading a page of it measured 0.02 s. Everything a row *shows* -- name, group,
region, primary service, tags -- is then computed exactly as before, for the page's
resources only (0.25 s for fifty).

What it is
----------
Tables, rebuilt together from the *published* `resource_presence`:

    resource_rank_ids     one integer `rkey` per identity the tab groups by:
                          (lower(trim(ResourceId)), lower(SubAccountId), currency)
                          -- also how Waste prices resources by id (`waste._costs_for`)
    resource_rank_raw     every raw (ResourceId, SubAccountId, BillingCurrency) spelling
                          and the rkey it folds to -- so a page can go back to presence
                          through its ResourceId index, and a narrowed reader can join
                          to integers without re-normalising every row
    resource_rank_tag_exceptions
                          raw ids that split or merge ranking identities; always considered
                          by Tags so signed costs cannot invalidate its candidate cutoff
    resource_rank_daily   (ChargePeriodStart, rkey, BilledCost), the integer fact
    resource_rank_periods the periods ranked, each by its exact bounds (lo, mid, hi):
                          prior is (lo, mid], current is (mid, hi]
    resource_ranks        (period, rnk, rkey, cost, prior) for each of those periods

Every name carries the `resource_rank` prefix. The local database is shared with
CloudLens v2, which publishes its own `resource_ids` (a view over `resource_ids_a/_b`);
a v3 table of that name was dropped and renamed over it by each rebuild here, and v2
then refused to start.

Periods are keyed by their *bounds*, not their names. A request is served from a stored
ranking only when the bounds it computes -- by the same rule `reporting.window` uses --
are exactly the stored ones, so a window can never be answered by a neighbour's
ranking. Rolling windows are the ones the UI offers (`ROLLING`) anchored at the newest
day; calendar months are the newest `MONTHS` in the data.

Freshness
---------
Not a DERIVED_MODULE, for the reason `resource_counts` is not one: a resource's rank
depends on every other resource's cost, so it cannot be repaired one month at a time.
It is rebuilt in full after each derived rebuild (`refresh`), stamped with the ready
generation, withdrawn by `jobs.coherent_rollup`, and served only while the stamp equals
the generation the derived data is at (`current`). Until then the tab uses the path it
had before: slower, never wrong.
"""
from __future__ import annotations

import datetime as dt
import logging
import os
import time
from typing import Any

from . import presence

log = logging.getLogger("cloudlens.resource_ranks")

IDS = "resource_rank_ids"
SUBS = "resource_rank_subs"
RAW = "resource_rank_raw"
DAILY = "resource_rank_daily"
PERIODS = "resource_rank_periods"
TOTALS = "resource_rank_totals"
TAG_EXCEPTIONS = "resource_rank_tag_exceptions"
TABLE = "resource_ranks"
TABLES = (SUBS, IDS, RAW, DAILY, PERIODS, TABLE, TOTALS, TAG_EXCEPTIONS)
STAMP_KEY = "resource_ranks_generation"  # listed in jobs.SERVING_STAMP_KEYS
PERIOD = "ChargePeriodStart"

ROLLING = (7, 30, 60, 90)
MONTHS = max(0, int(os.getenv("CLOUDLENS_RESOURCE_RANK_MONTHS", "3")))

# The identity the Resources tab has always grouped by. Normalised under the database's
# own collation -- `lower()` folds non-ASCII letters only there -- and then stored under
# "C", so the build's sorts and every later comparison are byte-wise.
ID_SQL = 'lower(trim(raw COLLATE "default"))'
SUB_SQL = 'lower(raw_sub COLLATE "default")'
CURRENCY_SQL = ("COALESCE(NULLIF(NULLIF(UPPER(TRIM(raw_cur COLLATE \"default\")), ''), "
                "'UNKNOWN'), 'unknown')")


# ------------------------------------------------------------------ windows
def window_dates(hi: dt.date | str, days: int) -> tuple[dt.date, dt.date, dt.date]:
    """`(lo, mid, hi)` for the request in progress, by `reporting.window`'s own rule.

    `hi` is the newest day in the reader's data. Prior is `(lo, mid]`, current
    `(mid, hi]`. A selected calendar month replaces the rolling window exactly as
    `reporting.window` does.
    """
    from . import reporting

    newest = dt.date.fromisoformat(str(hi)[:10])
    bounds = reporting.month_bounds()
    if bounds:
        first, last = bounds
        length = reporting.period_days(days)
        return first - dt.timedelta(days=length + 1), first - dt.timedelta(days=1), last
    days = max(1, min(int(days), 365))
    return newest - dt.timedelta(days=2 * days), newest - dt.timedelta(days=days), newest


def periods_for(newest: dt.date) -> list[tuple[str, dt.date, dt.date, dt.date]]:
    """The periods a rebuild ranks: `(label, lo, mid, hi)`.

    Months go through `window_dates` under `reporting.select`, the same code a request
    runs, so a stored month's bounds are the bounds that month's request will compute
    (including a current month cut at today). A month whose bounds later move -- the
    current one, as days pass -- simply stops matching and is ranked on the fly.
    """
    from . import reporting

    newest = dt.date.fromisoformat(str(newest)[:10])
    out = [(f"d{d}", *window_dates(newest, d)) for d in ROLLING]
    month = newest.replace(day=1)
    for _ in range(MONTHS):
        label = month.strftime("%Y-%m")
        try:
            with reporting.select(label):
                bounds = window_dates(newest, 30)
        except ValueError:  # a month after today's cannot be selected, so is never asked for
            bounds = None
        # A month ending on the newest day is the 30-day window's twin; rank it once.
        if bounds and all(tuple(p[1:]) != bounds for p in out):
            out.append((f"m{label}", *bounds))
        month = (month - dt.timedelta(days=1)).replace(day=1)
    return out


# ------------------------------------------------------------------ freshness
def _pair(con: Any) -> tuple[int | None, int | None]:
    from .jobs import ROLLUP_GENERATION_KEY

    values = dict(con.execute("SELECT key, value FROM meta WHERE key IN (?, ?)",
                              [ROLLUP_GENERATION_KEY, STAMP_KEY]).fetchall())
    ready, stamp = values.get(ROLLUP_GENERATION_KEY), values.get(STAMP_KEY)
    return (int(ready) if ready is not None else None,
            int(stamp) if stamp is not None else None)


def current(con: Any, fresh: frozenset[str] | set[str]) -> bool:
    """Whether the tables describe the generation the published derived data is at."""
    if presence.TABLE not in fresh:
        return False
    try:
        ready, stamp = _pair(con)
    except Exception as exc:  # noqa: BLE001 - unknown means "rank it the slow way"
        log.debug("resource_ranks: could not read its stamp (%s)", str(exc)[:200])
        return False
    return ready is not None and ready >= 0 and stamp == ready


# ------------------------------------------------------------------ build
def tag_exceptions_sql(raw: str) -> str:
    """Raw ids whose Tags group is not one-to-one with a ranked identity.

    These must be considered independently of rank: credits can make one raw
    spelling exceed its merged ranking, and several subscriptions can share a raw id.
    """
    return f"""WITH split AS (
                 SELECT rkey FROM {raw} GROUP BY rkey HAVING count(*) > 1
               ), merged AS (
                 SELECT raw FROM {raw} GROUP BY raw HAVING min(rkey) <> max(rkey)
               )
               SELECT raw FROM {raw} JOIN split USING (rkey)
               UNION SELECT raw FROM merged"""


def build_sql(schema: str, source: str, periods: list[tuple[str, dt.date, dt.date, dt.date]],
              suffix: str = "_next") -> list[str]:
    """The statements that build every table as `<name><suffix>`, CTAS throughout."""
    q = f'"{schema}".'
    n = {t: f"{q}{t}{suffix}" for t in TABLES}
    values = ", ".join(
        f"({i}::smallint, '{label}', DATE '{lo}', DATE '{mid}', DATE '{hi}')"
        for i, (label, lo, mid, hi) in enumerate(periods, start=1)) or \
        "(NULL::smallint, NULL::text, NULL::date, NULL::date, NULL::date)"
    return [
        *(f"DROP TABLE IF EXISTS {n[t]}" for t in TABLES),
        # Normalise each distinct spelling once, not every row: lower() under a libc
        # collation costs microseconds a call.
        f"""CREATE TEMP TABLE _rr_raw ON COMMIT DROP AS
            SELECT raw, raw_sub, raw_cur,
                   {ID_SQL} COLLATE "C" AS id, {SUB_SQL} COLLATE "C" AS sub,
                   {CURRENCY_SQL} COLLATE "C" AS currency
            FROM (SELECT DISTINCT "ResourceId" COLLATE "C" AS raw,
                         COALESCE("SubAccountId", '') COLLATE "C" AS raw_sub,
                         COALESCE("BillingCurrency", '') COLLATE "C" AS raw_cur
                  FROM {source} WHERE "ResourceId" IS NOT NULL) d
            WHERE trim(raw) <> ''""",
        f"""CREATE TABLE {n[SUBS]} AS
            SELECT (row_number() OVER (ORDER BY sub))::int AS skey, sub
            FROM (SELECT DISTINCT sub FROM _rr_raw) s""",
        f"""CREATE TABLE {n[IDS]} AS
            SELECT (row_number() OVER (ORDER BY k.id, k.sub, k.currency))::int AS rkey,
                   k.id, k.sub, k.currency, s.skey
            FROM (SELECT DISTINCT id, sub, currency FROM _rr_raw) k
            JOIN {n[SUBS]} s USING (sub)""",
        f"""CREATE TABLE {n[RAW]} AS
            SELECT r.raw, r.raw_sub, r.raw_cur, i.rkey, i.skey, i.currency
            FROM _rr_raw r JOIN {n[IDS]} i USING (id, sub, currency)""",
        f"CREATE TABLE {n[TAG_EXCEPTIONS]} AS {tag_exceptions_sql(n[RAW])}",
        f"""CREATE TABLE {n[DAILY]} AS
            SELECT p."{PERIOD}", m.rkey, m.skey, m.currency, sum(p."BilledCost") AS cost
            FROM {source} p JOIN {n[RAW]} m
              ON m.raw = p."ResourceId" COLLATE "C"
             AND m.raw_sub = COALESCE(p."SubAccountId", '') COLLATE "C"
             AND m.raw_cur = COALESCE(p."BillingCurrency", '') COLLATE "C"
            GROUP BY 1, 2, 3, 4""",
        f"""CREATE TABLE {n[PERIODS]} AS
            SELECT v.period, v.label, v.lo, v.mid, v.hi FROM (VALUES {values})
              AS v(period, label, lo, mid, hi) WHERE v.period IS NOT NULL""",
        # Same arithmetic as the tab's own query: CASE sums, so a window with no charge on
        # one side reads 0, not NULL. Subscription, currency and the change class ride
        # along so scope, totals and those filters never join back to the identities.
        f"""CREATE TABLE {n[TABLE]} AS
            SELECT period, (row_number() OVER (PARTITION BY period
                              ORDER BY cost DESC, prior DESC, rkey))::int AS rnk,
                   rkey, skey, currency, cost, prior, {change_sql('cost', 'prior')} AS change
            FROM (SELECT p.period, d.rkey, d.skey, d.currency,
                         sum(CASE WHEN d."{PERIOD}" > p.mid THEN d.cost ELSE 0 END) AS cost,
                         sum(CASE WHEN d."{PERIOD}" <= p.mid THEN d.cost ELSE 0 END) AS prior
                  FROM {n[PERIODS]} p JOIN {n[DAILY]} d
                    ON d."{PERIOD}" > p.lo AND d."{PERIOD}" <= p.hi
                  GROUP BY 1, 2, 3, 4) w""",
        # "How many, and how much" per period, subscription, currency and change class --
        # a few thousand rows -- so a page's header never re-sums two million, whatever
        # the scope.
        f"""CREATE TABLE {n[TOTALS]} AS
            SELECT period, skey, currency, change, count(*) AS resources,
                   sum(cost) AS cost, sum(prior) AS prior
            FROM {n[TABLE]} GROUP BY 1, 2, 3, 4""",
        f"ALTER TABLE {n[SUBS]} ADD PRIMARY KEY (skey)",
        f"ALTER TABLE {n[IDS]} ADD PRIMARY KEY (rkey)",
        # Looking resources up by id (`waste._costs_for`). Hash, not btree: ids run to
        # hundreds of bytes, and a btree over two million of them measured 520 MB to the
        # hash index's 64 MB for the same 2 ms lookup; only equality is ever asked.
        f"CREATE INDEX ON {n[IDS]} USING hash (id)",
        f"CREATE INDEX ON {n[RAW]} (rkey)",
        f'CREATE INDEX ON {n[DAILY]} ("{PERIOD}")',
        # A scope whose window is not a stored one ranks only its own subscriptions' days.
        f'CREATE INDEX ON {n[DAILY]} (skey, "{PERIOD}")',
        # A handful of resources' money over a window, without scanning every day's rows.
        f'CREATE INDEX ON {n[DAILY]} (rkey, "{PERIOD}")',
        f"ALTER TABLE {n[TABLE]} ADD PRIMARY KEY (period, rnk)",
        # A narrow scope reads its own resources in rank order rather than filtering the
        # whole period's ranking down to them.
        f"CREATE INDEX ON {n[TABLE]} (period, skey, rnk)",
        *(f"ANALYZE {n[t]}" for t in TABLES),
    ]


def swap_sql(schema: str, suffix: str = "_next") -> list[str]:
    q = f'"{schema}".'
    return ([f"DROP TABLE IF EXISTS {q}{t}" for t in TABLES]
            + [f"ALTER TABLE {q}{t}{suffix} RENAME TO {t}" for t in TABLES])


def refresh(warehouse: Any) -> bool:
    """Rebuild from the published `resource_presence` if it is current and we are not.

    Holds the derived-rebuild lock so presence cannot change underneath the build
    (minutes on a large estate). Readers are never blocked: until the stamp is written
    they use the unranked path. Returns True when a new generation was published.
    """
    from . import derived, jobs

    schema = warehouse._rollup_schema
    with warehouse.connect() as con:
        con.execute("BEGIN")
        try:
            derived.lock_rebuild(con, schema)
            if not jobs.rollup_current(con, presence.TABLE):
                con.execute("ROLLBACK")
                return False
            ready, stamp = _pair(con)
            if stamp == ready:
                con.execute("ROLLBACK")
                return False
            t0 = time.monotonic()
            source = f'"{schema}".{presence.TABLE}'
            newest = con.execute(f'SELECT max("{PERIOD}") FROM {source}').fetchone()[0]
            periods = periods_for(newest) if newest else []
            for statement in build_sql(schema, source, periods):
                con.execute(statement)
            for statement in swap_sql(schema):
                con.execute(statement)
            con.execute("INSERT INTO meta (key, value, updated_at) VALUES (?, ?, now()) "
                        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, "
                        "updated_at = excluded.updated_at", [STAMP_KEY, str(ready)])
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise
    log.info("resource_ranks: rebuilt for generation %s in %.1fs", ready, time.monotonic() - t0)
    return True


# ------------------------------------------------------------------ reads
SORTS = {
    "cost": "r.cost",
    "prior": "r.prior",
    "delta": "(r.cost - r.prior)",
}
# The classic tab's classification (`resourceChange`), on the figures it shows: rounded
# to the cent. Stored as a code so filtering is an equality, not four roundings a row.
CHANGES = {"no-baseline": 0, "unchanged": 1, "increased": 2, "decreased": 3}


def change_sql(cost: str, prior: str) -> str:
    # Both rounded to the cent, so "less than a cent apart" is "equal".
    c, p = f"round(({cost})::numeric, 2)", f"round(({prior})::numeric, 2)"
    return (f"(CASE WHEN {p} = 0 THEN 0 WHEN {c} = {p} THEN 1 "
            f"WHEN {c} > {p} THEN 2 ELSE 3 END)::smallint")


def like_pattern(text: str) -> str:
    """A LIKE substring pattern for `text`, with its own wildcards escaped."""
    escaped = text.strip().lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def stored_period(reader: Any, lo: dt.date, mid: dt.date, hi: dt.date) -> int | None:
    rows = reader.rows(
        f"SELECT period FROM {PERIODS} WHERE lo = ? AND mid = ? AND hi = ?",
        params=[lo, mid, hi])
    return rows[0]["period"] if rows else None


def scope_keys(reader: Any) -> list[int] | None:
    """The subscription keys a scoped reader may see, or None when that is all of them.

    Read from the connection's own `_scope`, so it is exactly the scope every other
    query on the connection applies. "All of them" is exact, not a shortcut: every
    ranked resource belongs to one of `resource_rank_subs`, so a scope naming each of those
    selects every row -- and can use the unscoped paths and totals.
    """
    rows = reader.rows(
        f'SELECT skey, sub IN (SELECT id COLLATE "C" FROM _scope) AS seen FROM {SUBS}',
        limit=None)
    keys = [row["skey"] for row in rows if row["seen"]]
    return None if len(keys) == len(rows) else keys


def filters_sql(*, skeys: list[int] | None, q: str, currency: str, change: str
                ) -> tuple[list[str], list[Any], list[str], list[Any]]:
    """`(identity conditions on i, their params, ranking conditions on r, their params)`.

    `i` is `resource_rank_ids`, `r` a ranking. Kept apart because identity conditions are
    resolved to a set of keys first; ranking conditions read columns the ranking holds.
    """
    ids: list[str] = []
    id_params: list[Any] = []
    if q.strip():
        ids.append("i.id LIKE ? ESCAPE '\\'")
        id_params.append(like_pattern(q))
    ranks: list[str] = []
    rank_params: list[Any] = []
    if skeys is not None:
        ranks.append("r.skey = ANY(?)")
        rank_params.append(skeys)
    if currency.strip():
        ranks.append('r.currency = ? COLLATE "C"')
        rank_params.append(currency.strip().upper() if currency.strip().lower() != "unknown"
                           else "unknown")
    if change:
        ranks.append("r.change = ?")
        rank_params.append(CHANGES[change])
    return ids, id_params, ranks, rank_params


def order_sql(sort: str, descending: bool) -> str:
    direction = "DESC" if descending else "ASC"
    column = SORTS[sort]
    # The stored order's tie-breaks (prior, then identity) keep pages disjoint.
    return f"{column} {direction}, r.prior {direction}, r.rkey"
