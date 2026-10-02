"""Generation-owned, immutable responses for the two large interactive tab datasets.

The publication is serving data, not a viewer cache: no identity, authorization or
TTL enters its key. SQL computes money through the exact tab builders on one pinned
published generation. Request reads do no resource/day aggregation or tag shaping.
Unsupported or narrowed readers retain the exact query path.

Opt-in prevents an upgrade/start-up from building shared serving data unexpectedly.
The normal successful derived refresh invokes this publisher when enabled.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

from . import hourly_usage, presence, reporting, resource_tags, rollup

log = logging.getLogger("cloudlens.tab_serving")
ENABLED = os.getenv("CLOUDLENS_TAB_SERVING", "false").strip().lower() == "true"
TABLE = "tab_serving_v1"
STAMP_KEY = "tab_serving_generation"
ROLLING = (7, 30, 60, 90)
RECENT_MONTHS = 3
REQUIRED = frozenset({rollup.TABLE, presence.TABLE, hourly_usage.TABLE, resource_tags.TABLE})
VERSION = 1


def contract() -> str:
    """Bump VERSION when exact builders change semantics; caps also invalidate rows."""
    from . import tags, uptime

    return (f"{VERSION}:{uptime.MAX_ROWS}:{uptime.MAX_DAILY_CELLS}:"
            f"{tags.MAX_RESOURCES}:{tags.MAX_DAILY_CELLS}:{uptime.ALWAYS_ON}")


def period_key(days: int) -> str | None:
    bounds = reporting.month_bounds()
    if bounds:
        return f"month:{bounds[0]}:{bounds[1]}"
    return f"rolling:{days}" if days in ROLLING else None


def table_sql(schema: str) -> str:
    return (f'CREATE TABLE IF NOT EXISTS "{schema}".{TABLE} ('
            "endpoint text NOT NULL, period text NOT NULL, generation bigint NOT NULL, "
            "contract text NOT NULL, payload text NOT NULL, "
            "PRIMARY KEY (endpoint, period))")


def read(r: Any, endpoint: str, days: int) -> dict[str, Any] | None:
    """An atomic payload+certificate read; missing/old publication is just a miss.

    Only absence is tolerated. Bad schema, corrupt payload or malformed metadata
    raises normally; speculative statements never poison a reader transaction.
    """
    from . import jobs

    if (not getattr(r, "tab_served", False) or getattr(r, "scoped", False)
            or getattr(r, "narrowed", False) or reporting.comparison_selected()):
        return None
    key = period_key(days)
    if key is None:
        return None
    exists = r.rows("SELECT to_regclass(?) AS relation", 1, [TABLE])
    if not exists[0]["relation"]:
        return None
    # Metadata and data share a statement snapshot. An ingest/rebuild/unstamp between
    # reader creation and this statement cannot validate yesterday's payload.
    rows = r.rows(f"""
        WITH state AS (
          SELECT
            coalesce(max(value) FILTER (WHERE key = ?), '0')::bigint AS source,
            coalesce(max(value) FILTER (WHERE key = ?), '-1')::bigint AS ready,
            max(value) FILTER (WHERE key = ?) AS stamp,
            max(value) FILTER (WHERE key = ?) AS dirty,
            coalesce(nullif(max(value) FILTER (WHERE key = ?), ''), ?) AS roster
          FROM meta WHERE key = ANY(?)
        )
        SELECT p.payload FROM {TABLE} p CROSS JOIN state s
        WHERE p.endpoint = ? AND p.period = ? AND p.contract = ?
          AND s.ready >= 0 AND s.source = s.ready
          AND s.stamp = s.ready::text AND p.generation = s.ready
          AND string_to_array(s.roster, ',') @> ?::text[]
          AND (s.dirty IS NULL OR (
            (s.dirty::jsonb ->> 'generation')::bigint = s.source
            AND (s.dirty::jsonb ->> 'base_generation')::bigint = s.ready
            AND s.dirty::jsonb -> 'windows' = '[]'::jsonb))
        """, 1, [
            jobs.GENERATION_KEY, jobs.ROLLUP_GENERATION_KEY, STAMP_KEY,
            jobs.ROLLUP_DIRTY_KEY, jobs.ROLLUP_TABLES_KEY,
            ",".join(jobs.LEGACY_ROLLUP_TABLES),
            [jobs.GENERATION_KEY, jobs.ROLLUP_GENERATION_KEY, STAMP_KEY,
             jobs.ROLLUP_DIRTY_KEY, jobs.ROLLUP_TABLES_KEY],
            endpoint, key, contract(), sorted(REQUIRED),
        ])
    return json.loads(rows[0]["payload"]) if rows else None


def _reader(con: Any, schema: str, bounds: tuple | None) -> Any:
    from .warehouse import Reader

    def relation(table: str) -> str:
        source = f'"{schema}".{table}'
        if bounds is None or table == resource_tags.TABLE:
            return source
        lo, hi = bounds
        return (f'(SELECT * FROM {source} WHERE "ChargePeriodStart" >= DATE \'{lo}\' '
                f'AND "ChargePeriodStart" <= DATE \'{hi}\') AS {table}')

    # No ranked shortcut or serving recursion. Money is reduced from published SQL
    # summaries, tags retain their full monthly masks, native currencies use this
    # very same connection/generation.
    return Reader(con, relation(rollup.TABLE), relation(presence.TABLE),
                  relation(presence.TABLE),
                  usage={"hourly": relation(hourly_usage.TABLE),
                         "tags": relation(resource_tags.TABLE)})


def refresh(warehouse: Any) -> bool:
    """Atomically replace all responses and their stamp under the derived lock."""
    if not ENABLED:
        return False
    from . import derived, jobs, tags, uptime

    schema = warehouse._rollup_schema
    started = time.monotonic()
    with reporting.select(None), warehouse.connect() as con, con.raw.transaction():
        # transaction() preserves rollback/savepoint semantics of existing Reader code.
        derived.lock_rebuild(con, schema)
        if not REQUIRED.issubset(jobs.fresh_derived_tables(con)):
            return False
        _, ready = jobs._generation_pair(con)
        con.execute(table_sql(schema))
        months = [row[0] for row in con.execute(
            f'SELECT DISTINCT to_char("ChargePeriodStart", \'YYYY-MM\') AS month '
            f'FROM "{schema}".{rollup.TABLE} '
            'WHERE "ChargePeriodStart" >= DATE \'0002-01-01\' '
            'AND "ChargePeriodStart" <= ? ORDER BY month DESC LIMIT ?',
            [reporting.today(), RECENT_MONTHS]).fetchall()]
        periods = [(None, days) for days in ROLLING] + [(month, 30) for month in months]
        wanted = []
        for month, days in periods:
            with reporting.select(month):
                wanted.extend((endpoint, period_key(reporting.period_days(days)))
                              for endpoint in ("uptime", "tags"))
        stamp = con.execute("SELECT value FROM meta WHERE key = ?", [STAMP_KEY]).fetchone()
        existing = con.execute(
            f'SELECT endpoint, period FROM "{schema}".{TABLE} '
            "WHERE generation = ? AND contract = ?", [ready, contract()]).fetchall()
        if stamp and stamp[0] == str(ready) and set(existing) == set(wanted):
            return False

        con.execute(f'DELETE FROM "{schema}".{TABLE}')
        for month, days in periods:
            with reporting.select(month):
                days = reporting.period_days(days)
                reader = _reader(con, schema, reporting.month_bounds())
                for endpoint, build in (("uptime", uptime._build), ("tags", tags._build)):
                    payload = build(reader, days)
                    con.execute(
                        f'INSERT INTO "{schema}".{TABLE} '
                        "(endpoint, period, generation, contract, payload) VALUES (?, ?, ?, ?, ?)",
                        [endpoint, period_key(days), ready, contract(),
                         json.dumps(payload, ensure_ascii=False, separators=(",", ":"),
                                    allow_nan=False)])
        # Publishing the old ready generation is harmless if ingest advanced during
        # the build: the atomic read refuses it until derived data catches up.
        con.execute(
            "INSERT INTO meta (key, value, updated_at) VALUES (?, ?, now()) "
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value, "
            "updated_at = excluded.updated_at", [STAMP_KEY, str(ready)])
    log.info("tab serving: published %d responses at generation %s in %.2fs",
             len(wanted), ready, time.monotonic() - started)
    return True
