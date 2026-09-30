"""Exact resource counts for the Overview, without hashing two million identities per view.

Why
---
Counting resources is the one Overview question that cannot be answered by summing:
distinct counts do not re-aggregate. Even from `resource_presence`, counting the distinct
resources in a 30-day window hashes ~2M long ARM ids per view. Measured on the 16.9M-row
estate (Sep 2026): 48 s for the headline count and 46 s for the per-region count --
94 of the Overview's 95 cold seconds. Every query-level variant bottomed out near 4.5 s
(the hash itself), so the answer is precomputed.

Why it is exact
---------------
A rolling window always ends on the newest day in the data (`reporting.window` anchors
`hi` to it), so a resource has a row in `(start, hi]` exactly when the last day it has
any row is after `start`. Counting resources grouped by that last-seen day answers every
rolling window -- 7, 30, 90 or 365 days -- with one range sum:

    count(DISTINCT key) over (start, hi]  ==  sum(resources) WHERE last_seen > start

Calendar months have no such anchor, so they are counted directly, one row per month.

    bucket             ChargePeriodStart means   key counted
    last_seen          last day seen             (currency, resource)
    region_last_seen   last day seen             (region, currency, resource)
    month              first of the month        (currency, resource)
    region_month       first of the month        (region, currency, resource)

NULL `ResourceId` and NULL `RegionName` are values of their own, exactly as the
`SELECT DISTINCT` this replaces counts them.

Freshness
---------
This is not one of the warehouse's `DERIVED_MODULES`: its grain cannot be repaired one
month at a time (correcting a day can move a resource's last-seen day to any earlier
day), and every guarantee those modules share -- monthly leaves, window-only repair -- is
one it would have to be the exception to. It is instead a small serving table rebuilt in
full from the *published* `resource_presence` after each derived rebuild (`refresh`),
stamped with the ready generation it was built from, and served only while that stamp
equals the generation the rest of the derived data is at (`current`). Until then readers
count from `resource_presence` as before: slower, never wrong.

What it serves
--------------
Only the unscoped, unfiltered, unconverted reader (`Reader.counts`). A scope or filter
changes which resources exist, and recounting under one needs the per-resource detail
this table deliberately does not keep; those readers keep the scoped query.
"""
from __future__ import annotations

import datetime as dt
import logging
import time
from typing import Any

from . import presence

log = logging.getLogger("cloudlens.resource_counts")

TABLE = "resource_counts"
PERIOD = "ChargePeriodStart"
STAMP_KEY = "resource_counts_generation"  # listed in jobs.SERVING_STAMP_KEYS

LAST_SEEN = "last_seen"
REGION_LAST_SEEN = "region_last_seen"
MONTH = "month"
REGION_MONTH = "region_month"
BUCKETS = (LAST_SEEN, REGION_LAST_SEEN, MONTH, REGION_MONTH)


def table_sql(schema: str) -> str:
    return (f'CREATE TABLE IF NOT EXISTS "{schema}".{TABLE} ("{PERIOD}" date, bucket text, '
            f'"BillingCurrency" text, "RegionName" text, resources bigint)')


def select_sql(source: str) -> str:
    """Every bucket, counted from the whole of `source` (a `resource_presence` relation)."""
    period = f'"{PERIOD}"'
    return f"""
      WITH keyed AS MATERIALIZED (
        SELECT "RegionName", "BillingCurrency", "ResourceId",
          date_trunc('month', {period})::date AS month, max({period})::date AS last_seen
        FROM {source} WHERE {period} IS NOT NULL
        GROUP BY "RegionName", "BillingCurrency", "ResourceId", month
      )
      SELECT last_seen AS {period}, '{LAST_SEEN}'::text AS bucket, "BillingCurrency",
        NULL::text AS "RegionName", count(*) AS resources
      FROM (SELECT "BillingCurrency", "ResourceId", max(last_seen) AS last_seen
            FROM keyed GROUP BY "BillingCurrency", "ResourceId") k
      GROUP BY last_seen, "BillingCurrency"
      UNION ALL
      SELECT last_seen, '{REGION_LAST_SEEN}', "BillingCurrency", "RegionName", count(*)
      FROM (SELECT "RegionName", "BillingCurrency", "ResourceId", max(last_seen) AS last_seen
            FROM keyed GROUP BY "RegionName", "BillingCurrency", "ResourceId") k
      GROUP BY last_seen, "BillingCurrency", "RegionName"
      UNION ALL
      SELECT month, '{MONTH}', "BillingCurrency", NULL::text, count(*)
      FROM (SELECT DISTINCT month, "BillingCurrency", "ResourceId" FROM keyed) k
      GROUP BY month, "BillingCurrency"
      UNION ALL
      SELECT month, '{REGION_MONTH}', "BillingCurrency", "RegionName", count(*)
      FROM keyed GROUP BY month, "BillingCurrency", "RegionName"
    """


def _pair(con: Any) -> tuple[int | None, int | None]:
    from .jobs import ROLLUP_GENERATION_KEY

    values = dict(con.execute("SELECT key, value FROM meta WHERE key IN (?, ?)",
                              [ROLLUP_GENERATION_KEY, STAMP_KEY]).fetchall())
    ready, stamp = values.get(ROLLUP_GENERATION_KEY), values.get(STAMP_KEY)
    return (int(ready) if ready is not None else None,
            int(stamp) if stamp is not None else None)


def current(con: Any, fresh: frozenset[str] | set[str]) -> bool:
    """Whether the table describes the generation the published derived data is at.

    `fresh` is the reader's own `jobs.fresh_derived_tables` answer, so this adds one
    small `meta` read and nothing else to the connection.
    """
    if presence.TABLE not in fresh:
        return False
    try:
        ready, stamp = _pair(con)
    except Exception as exc:  # noqa: BLE001 - unknown means "count it the slow way"
        log.debug("resource_counts: could not read its stamp (%s)", str(exc)[:200])
        return False
    return ready is not None and ready >= 0 and stamp == ready


def refresh(warehouse: Any) -> bool:
    """Rebuild from the published `resource_presence` if it is current and we are not.

    Holds the derived-rebuild lock so presence cannot change underneath the build, which
    is measured in seconds to a minute; readers are never blocked (they fall back).
    Returns True when a new generation was published.
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
            con.execute(table_sql(schema))
            # CREATE TABLE AS so the aggregation may run in parallel (an INSERT ... SELECT
            # may not), then a swap of a few hundred rows inside the same transaction.
            source = f'"{schema}".{presence.TABLE}'
            con.execute(f"CREATE TEMP TABLE _resource_counts ON COMMIT DROP AS {select_sql(source)}")
            con.execute(f'DELETE FROM "{schema}".{TABLE}')
            con.execute(f'INSERT INTO "{schema}".{TABLE} SELECT * FROM _resource_counts')
            con.execute("INSERT INTO meta (key, value, updated_at) VALUES (?, ?, now()) "
                        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, "
                        "updated_at = excluded.updated_at", [STAMP_KEY, str(ready)])
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise
    log.info("resource_counts: rebuilt for generation %s in %.1fs", ready, time.monotonic() - t0)
    return True


def window_sql(relation: str, start: str, month: dt.date | None, *, by_region: bool) -> str:
    """Resource counts for `(start, hi]`, or for calendar `month` when given.

    Shaped like the queries it replaces: `currency, resources`, plus `name` (the region,
    NULL shown as the dash the dashboard uses) when `by_region`. `start` is the
    dashboard's own SQL date expression, so the two cannot drift apart.
    """
    if month is not None:
        bucket = REGION_MONTH if by_region else MONTH
        where = f"\"{PERIOD}\" = DATE '{month.replace(day=1).isoformat()}'"
    else:
        bucket = REGION_LAST_SEEN if by_region else LAST_SEEN
        where = f'"{PERIOD}" > {start}'
    region = "coalesce(\"RegionName\", '—') AS name, " if by_region else ""
    group = "1, 2" if by_region else "1"
    return (f'SELECT {region}"BillingCurrency" AS currency, '
            f"CAST(sum(resources) AS bigint) AS resources FROM {relation} "
            f"WHERE bucket = '{bucket}' AND {where} GROUP BY {group}")
