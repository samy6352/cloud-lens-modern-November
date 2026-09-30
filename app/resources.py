"""Resource-level cost and billing context from the warehouse, without live Azure reads.

This is not an ARM inventory: resources without cost records are absent. First/last seen
describe the reporting and comparison windows, not provisioning or deletion dates.

Paging
------
Two million resources cannot be one JSON response, and ranking them per request on
their long text ids was the tab's whole cost (see `resource_ranks`). So the list is
ranked on integer keys first -- from a ranking stored at rebuild time when one answers
this request exactly, else computed for this window -- and only the requested page's
resources go through the detail query below, which is the same SQL the tab always ran,
restricted to those resources' ids. Every figure on a row is therefore computed exactly
as before; only the choice of *which* rows is made differently.

    source     when                                             ranking cost
    ranked     stored ranking current, bounds match, no filter  a page of an index
    window     stored keys current, bounds do not match         one pass over integers
    filtered   stored keys current, filter bar or conversion    one pass over the reader's rows
    legacy     keys not yet built for this generation           the original query, capped

Without `page` the response keeps its original shape -- the top `MAX_RESOURCES` by cost
with `truncated` -- for the classic tab.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import math
from typing import Any

from . import resource_ranks

log = logging.getLogger("cloudlens.resources")

# Matches tags.py's own ceiling for the same reason: large enough to cover a real estate, small
# enough to stay a JSON response and a browser tab someone can still scroll and search. Past
# this the response says so rather than silently dropping the tail.
MAX_RESOURCES = 8000
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 500

_LEGACY_ORDER = "ORDER BY cost DESC, prior_cost DESC, id, subscription_id, currency"


def _detail_sql(r: Any, hi: Any, start: str, prev: str, *, limit: int | None,
                restricted: bool = False) -> str:
    """The tab's own per-resource query, optionally for a given set of raw ids only."""
    from . import resource_tags

    tag_source = getattr(r, "tags", None)
    source = getattr(r, "named", "costs") if tag_source else "costs"
    agg = getattr(r, "agg", "costs")
    combined = f'"ChargePeriodStart" > {prev} AND "ChargePeriodStart" <= DATE \'{hi}\''
    period = f'"ChargePeriodStart" > {start}'
    previous = f'"ChargePeriodStart" > {prev} AND "ChargePeriodStart" <= {start}'
    resource_identity = (
        'LOWER(TRIM("ResourceId")) AS id, LOWER(COALESCE("SubAccountId", \'\')) '
        'AS subscription_id, COALESCE(NULLIF(NULLIF(UPPER(TRIM("BillingCurrency")), '
        '\'\'), \'UNKNOWN\'), \'unknown\') AS currency')
    only = ' AND "ResourceId" = ANY(?)' if restricted else ""
    # Ranked per service rather than per row: every ranking key but the date is a
    # per-service figure, so the first-ranked service is the same, and the window
    # function sorts services instead of every charge.
    inline_tags = "" if tag_source else ', MAX(COALESCE("Tags", \'\')) AS tags'
    top = (
        'WITH names AS (SELECT LOWER(COALESCE("SubAccountId", \'\')) AS name_sub, '
        'MAX(COALESCE("SubAccountName", "SubAccountId", \'\')) AS name_text '
        f'FROM {agg} WHERE {combined} GROUP BY 1), '
        f'svc AS (SELECT {resource_identity}, "ServiceName", "ServiceFamily", '
        f'SUM(CASE WHEN {period} THEN "BilledCost" ELSE 0 END) AS service_cost, '
        f'SUM(CASE WHEN {previous} THEN "BilledCost" ELSE 0 END) AS service_prior_cost, '
        f'MAX(CASE WHEN {period} THEN 1 ELSE 0 END) AS service_current, '
        'MAX(COALESCE(NULLIF("ResourceName", \'\'), \'(unnamed)\')) AS name, '
        'MAX(COALESCE("ResourceGroup", \'\')) AS resource_group, '
        'MAX(COALESCE("RegionName", \'\')) AS region, '
        'MIN("ChargePeriodStart") AS first_seen, MAX("ChargePeriodStart") AS last_seen'
        f'{inline_tags} '
        f'FROM {source} WHERE {combined} '
        f'AND "ResourceId" IS NOT NULL AND TRIM("ResourceId") <> \'\'{only} '
        'GROUP BY 1, 2, 3, "ServiceName", "ServiceFamily"), '
        'ranked AS (SELECT *, row_number() OVER (PARTITION BY id, subscription_id, currency '
        'ORDER BY service_current DESC, abs(service_cost) DESC, '
        'abs(service_prior_cost) DESC, "ServiceName", "ServiceFamily") AS service_rank '
        'FROM svc), '
        'top AS (SELECT id, MAX(name) AS name, MAX(resource_group) AS resource_group, '
        'COALESCE(MAX(name_text), \'\') AS subscription, subscription_id, '
        'MAX(CASE WHEN service_rank = 1 THEN COALESCE("ServiceName", \'\') END) AS service, '
        'MAX(CASE WHEN service_rank = 1 THEN COALESCE("ServiceFamily", \'\') END) AS family, '
        'MAX(region) AS region, currency, '
        'SUM(service_cost) AS cost, SUM(service_prior_cost) AS prior_cost, '
        + ('MAX(tags) AS tags, ' if inline_tags else '')
        + 'MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen, '
        'COALESCE(json_agg(DISTINCT NULLIF("ServiceName", \'\')) '
        'FILTER (WHERE service_current = 1), json_agg(DISTINCT NULLIF("ServiceName", \'\'))) '
        'AS service_names '
        'FROM ranked LEFT JOIN names ON name_sub = subscription_id '
        'GROUP BY id, subscription_id, currency '
        f'{_LEGACY_ORDER}'
        + (f' LIMIT {limit})' if limit is not None else ')'))
    if tag_source:
        return (f'{top} SELECT top.*, COALESCE(tg.tags, \'\') AS tags FROM top '
                + resource_tags.lateral_sql(
                    tag_source, "top.id", "top.currency", prev, str(hi)[:10],
                    "COALESCE(NULLIF(NULLIF(UPPER(TRIM({c})), ''), 'UNKNOWN'), 'unknown')")
                + f' {_LEGACY_ORDER}')
    return f'{top} SELECT * FROM top {_LEGACY_ORDER}'


def _item(row: dict[str, Any]) -> dict[str, Any]:
    from .dashboard import _group_for_family
    from .tags import _pairs

    cost = round(float(row.get("cost") or 0), 2)
    prior = round(float(row.get("prior_cost") or 0), 2)
    area_id, area_label = _group_for_family(row.get("family") or "")
    pairs = _pairs(row.get("tags"))
    service_names = row.get("service_names")
    if isinstance(service_names, str):
        service_names = json.loads(service_names)
    return {
        "id": row["id"],
        "name": row["name"],
        "resource_group": row["resource_group"] or None,
        "subscription": row["subscription"] or None,
        "subscription_id": row["subscription_id"] or None,
        "service": row["service"] or None,
        "service_names": sorted({name for name in service_names or [row["service"]] if name}),
        "area": area_label,
        "area_id": area_id,
        "region": row["region"] or None,
        "currency": row["currency"],
        "cost": cost,
        "prior_cost": prior,
        "delta": round(cost - prior, 2),
        # No prior spend does not establish when the resource was created.
        "change_pct": (round((cost - prior) / prior * 100, 1) if prior else None),
        "tags": [{"key": k, "value": v} for k, v in pairs],
        "tag_count": len(pairs),
        "first_seen": str(row["first_seen"]) if row.get("first_seen") else None,
        "last_seen": str(row["last_seen"]) if row.get("last_seen") else None,
    }


def _change_of(item: dict[str, Any]) -> str:
    """`resource_ranks.change_sql`'s classification, on the rounded figures shown."""
    if item["prior_cost"] == 0:
        return "no-baseline"
    delta = round(item["cost"] - item["prior_cost"], 2)
    return "unchanged" if delta == 0 else "increased" if delta > 0 else "decreased"


class Resources:
    """Reads the warehouse. Holds no state."""

    def __init__(self) -> None:
        from .warehouse import warehouse

        self.wh = warehouse

    def inventory(self, scope: list[str] | None, days: int = 30,
                  currency: str | None = None,
                  filters: dict[str, list[str]] | None = None, *,
                  page: int | None = None, page_size: int | None = None,
                  sort: str = "cost", descending: bool = True, q: str = "",
                  billing_currency: str = "", change: str = "") -> dict[str, Any]:
        """Compare adjacent windows, keeping currency groups separate.

        Without `page`: the top `MAX_RESOURCES` by cost, in the original shape. With it:
        one page of every matching resource, with `total` and totals over all of them.
        """
        from . import reporting

        if sort not in resource_ranks.SORTS:
            raise ValueError(f"sort must be one of {', '.join(resource_ranks.SORTS)}")
        if change and change not in resource_ranks.CHANGES:
            raise ValueError(f"change must be one of {', '.join(resource_ranks.CHANGES)}")
        paged = page is not None
        if paged:
            page = max(1, int(page))
            size = max(1, min(int(page_size or DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE))
        else:
            page, size, sort, descending, q, billing_currency, change = (
                1, MAX_RESOURCES, "cost", True, "", "", "")
        q = (q or "").strip()[:200]
        billing_currency = (billing_currency or "").strip()[:16]

        days = reporting.period_days(days)
        with reporting.comparison_history(), \
                self.wh.reader(scope, currency, filters, usage=("tags",)) as r:
            hi, start, prev = reporting.window(r, days)
            if not hi:
                empty = {"empty": True, "days": days, "resources": []}
                if paged:
                    empty.update(page=page, page_size=size, pages=0, total=0, truncated=False)
                return empty

            ranking = None
            if getattr(r, "ranks", None):
                try:
                    ranking = self._rank(r, hi, days, page=page, size=size, sort=sort,
                                         descending=descending, q=q,
                                         billing_currency=billing_currency, change=change)
                except Exception as exc:  # noqa: BLE001 - the original query still answers
                    log.warning("resources: ranked read failed (%s); using the full query",
                                str(exc)[:300])
                    ranking = None
            if ranking is not None:
                rows = self._details(r, hi, start, prev, ranking["page"])
                source = ranking["source"]
            else:
                rows = r.rows(_detail_sql(r, hi, start, prev, limit=MAX_RESOURCES + 1),
                              limit=MAX_RESOURCES + 1)
                source = "legacy"

        if ranking is None:
            return self._legacy_payload(rows, days, hi, paged=paged, page=page, size=size,
                                        sort=sort, descending=descending, q=q,
                                        billing_currency=billing_currency, change=change)

        items = [_item(row) for row in rows]
        if not paged:
            return self._compat_payload(items, days, hi, truncated=ranking["total"] > size,
                                        source=source, raw=rows)
        return self._paged_payload(items, days, hi, ranking["totals"], page=page, size=size,
                                   sort=sort, descending=descending, source=source)

    # -------------------------------------------------------------- ranking
    def _rank(self, r: Any, hi: Any, days: int, *, page: int, size: int, sort: str,
              descending: bool, q: str, billing_currency: str, change: str
              ) -> dict[str, Any] | None:
        """This page's resources in order, with totals over everything that matches."""
        lo, mid, top = resource_ranks.window_dates(hi, days)
        narrowed = bool(getattr(r, "narrowed", False))
        skeys = resource_ranks.scope_keys(r) if getattr(r, "scoped", False) else None
        id_where, id_params, rank_where, rank_params = resource_ranks.filters_sql(
            skeys=skeys, q=q, currency=billing_currency, change=change)
        offset = (page - 1) * size

        stored = None if narrowed else resource_ranks.stored_period(r, lo, mid, top)
        if stored is not None:
            source = "ranked"
            relation = (f"(SELECT rnk, rkey, skey, currency, cost, prior, change "
                        f"FROM {resource_ranks.TABLE} WHERE period = ?)")
            rel_params: list[Any] = [stored]
        else:
            source = "filtered" if narrowed else "window"
            relation, rel_params = "_resource_window", []
            self._window(r, lo, mid, top, narrowed=narrowed, skeys=skeys)

        default_order = sort == "cost" and descending
        order = ("r.rnk" if stored is not None and default_order
                 else resource_ranks.order_sql(sort, descending))
        # A search resolves to a set of keys first, which the ranking then hash-joins --
        # rather than probing two million identities one by one in rank order.
        # Everything else reads columns the ranking carries.
        keyed = (f"k AS MATERIALIZED (SELECT rkey FROM {resource_ranks.IDS} i "
                 f"WHERE {' AND '.join(id_where)}), " if id_where else "")
        join = " JOIN k ON k.rkey = r.rkey" if id_where else ""
        where = f" WHERE {' AND '.join(rank_where)}" if rank_where else ""
        # Stored totals are kept per subscription, currency and change class, so they
        # answer any scope and those filters; only a search has to re-sum.
        tallied = stored is not None and not id_where
        if tallied and default_order and not rank_where:
            # The stored rank is the default order, so the page is an index range.
            keys = r.rows(
                f"SELECT rkey FROM {resource_ranks.TABLE} "
                "WHERE period = ? AND rnk > ? AND rnk <= ? ORDER BY rnk",
                limit=None, params=[stored, offset, offset + size])
        elif id_where:
            # One statement: the identity scan behind a search runs once, and only its
            # integer keys are held -- the page reads the ranking through them in rank
            # order and stops at the page, the totals hash-join them.
            join_where = f"{where} AND r.rkey IN (SELECT rkey FROM k)" if where \
                else " WHERE r.rkey IN (SELECT rkey FROM k)"
            both = r.rows(
                f"WITH {keyed}"
                f"t AS (SELECT r.currency, count(*) AS resources, sum(r.cost) AS cost, "
                f"sum(r.prior) AS prior FROM {relation} r{join}{where} GROUP BY r.currency), "
                f"p AS (SELECT r.rkey FROM {relation} r{join_where} ORDER BY {order} "
                "LIMIT ? OFFSET ?) "
                "SELECT NULL::int AS rkey, currency, resources, cost, prior, NULL::bigint AS ord "
                "FROM t UNION ALL SELECT rkey, NULL, NULL, NULL, NULL, row_number() OVER () FROM p",
                limit=None, params=[*id_params, *rel_params, *rank_params,
                                    *rel_params, *rank_params, size, offset])
            keys = sorted((row for row in both if row["rkey"] is not None),
                          key=lambda row: row["ord"])
            totals = [row for row in both if row["rkey"] is None]
        else:
            keys = r.rows(
                f"SELECT r.rkey FROM {relation} r{where} ORDER BY {order} LIMIT ? OFFSET ?",
                limit=None, params=[*rel_params, *rank_params, size, offset])

        if tallied:
            totals = r.rows(
                "SELECT currency, sum(resources) AS resources, sum(cost) AS cost, "
                f"sum(prior) AS prior FROM {resource_ranks.TOTALS} r WHERE period = ?"
                + "".join(f" AND {w}" for w in rank_where) + " GROUP BY currency",
                limit=None, params=[stored, *rank_params])
        elif not id_where:
            totals = r.rows(
                "SELECT r.currency, count(*) AS resources, sum(r.cost) AS cost, "
                f"sum(r.prior) AS prior FROM {relation} r{where} GROUP BY r.currency",
                limit=None, params=[*rel_params, *rank_params])

        identities = {row["rkey"]: row for row in r.rows(
            f"SELECT rkey, id, sub, currency FROM {resource_ranks.IDS} WHERE rkey = ANY(?)",
            limit=None, params=[[k["rkey"] for k in keys]])} if keys else {}
        return {"source": source, "page": [identities[k["rkey"]] for k in keys],
                "totals": totals, "total": sum(int(t["resources"]) for t in totals)}

    @staticmethod
    def _window(r: Any, lo: dt.date, mid: dt.date, hi: dt.date, *, narrowed: bool,
                skeys: list[int] | None = None) -> None:
        """This window's per-resource figures, in a temp table on the reader's connection.

        Not narrowed: from the integer fact, only the scope's subscriptions' days when
        scoped. Narrowed: from the reader's own (filtered, converted, already scoped)
        rows, folded to integer keys by joining on the raw spellings -- no per-row
        normalisation, no text sort.
        """
        period = f'"{resource_ranks.PERIOD}"'
        params: list[Any] = [mid, mid, lo, hi]
        if narrowed:
            source = getattr(r, "named", "costs")
            sql = (
                f"SELECT m.rkey, m.skey, m.currency, "
                f"sum(CASE WHEN p.{period} > ? THEN p.\"BilledCost\" ELSE 0 END) AS cost, "
                f"sum(CASE WHEN p.{period} <= ? THEN p.\"BilledCost\" ELSE 0 END) AS prior "
                f"FROM {source} p JOIN {resource_ranks.RAW} m "
                'ON m.raw = p."ResourceId" COLLATE "C" '
                "AND m.raw_sub = COALESCE(p.\"SubAccountId\", '') COLLATE \"C\" "
                "AND m.raw_cur = COALESCE(p.\"BillingCurrency\", '') COLLATE \"C\" "
                f"WHERE p.{period} > ? AND p.{period} <= ? GROUP BY m.rkey, m.skey, m.currency")
        else:
            scoped = ""
            if skeys is not None:
                scoped = " AND skey = ANY(?)"
                params.append(skeys)
            sql = (
                f"SELECT rkey, skey, currency, sum(CASE WHEN {period} > ? THEN cost ELSE 0 END) AS cost, "
                f"sum(CASE WHEN {period} <= ? THEN cost ELSE 0 END) AS prior "
                f"FROM {resource_ranks.DAILY} WHERE {period} > ? AND {period} <= ?{scoped} "
                "GROUP BY rkey, skey, currency")
        r.execute("DROP TABLE IF EXISTS _resource_window")
        r.execute(f"CREATE TEMP TABLE _resource_window AS SELECT w.*, "
                  f"{resource_ranks.change_sql('w.cost', 'w.prior')} AS change FROM ({sql}) w",
                  params)
        r.execute("ANALYZE _resource_window")

    @staticmethod
    def _details(r: Any, hi: Any, start: str, prev: str,
                 page_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The tab's own figures for exactly these resources, in the ranking's order."""
        if not page_rows:
            return []
        keys = [row["rkey"] for row in page_rows]
        raw = [row["raw"] for row in r.rows(
            f"SELECT raw FROM {resource_ranks.RAW} WHERE rkey = ANY(?)", limit=None,
            params=[keys])]
        detail = r.rows(_detail_sql(r, hi, start, prev, limit=None, restricted=True),
                        limit=None, params=[raw])
        found = {(d["id"], d["subscription_id"], d["currency"]): d for d in detail}
        out = []
        for row in page_rows:
            match = found.get((row["id"], row["sub"], row["currency"]))
            if match is None:
                # Cannot happen while the stamp holds; said loudly rather than skipped
                # silently, because a missing row would make the page quietly short.
                log.error("resources: ranked resource %s has no detail row", row["rkey"])
                continue
            out.append(match)
        return out

    # -------------------------------------------------------------- payloads
    @staticmethod
    def _currency_fields(codes: set[str]) -> tuple[str | None, bool]:
        single = next(iter(codes)) if len(codes) == 1 else None
        return (single if single != "unknown" else None), len(codes) > 1

    def _compat_payload(self, items: list[dict[str, Any]], days: int, hi: Any, *,
                        truncated: bool, source: str,
                        raw: list[dict[str, Any]]) -> dict[str, Any]:
        currencies = {i["currency"] for i in items}
        # Rounded only after aggregating: two 0.004 charges total 0.01, not 0.00.
        totals = {
            code: (round(math.fsum(float(r.get("cost") or 0) for r in raw
                                   if r["currency"] == code), 2)
                   if code != "unknown" else None)
            for code in sorted(currencies)
        }
        items.sort(key=lambda x: -x["cost"])
        single = next(iter(currencies)) if len(currencies) == 1 else None
        return {
            "days": days,
            "as_of": str(hi),
            "currency": single if single != "unknown" else None,
            "mixed_currency": len(currencies) > 1,
            "resources": items,
            "count": len(items),
            "unique_count": len({(i["subscription_id"], i["id"]) for i in items}),
            "total_cost": totals.get(single) if items else 0.0,
            "total_cost_by_currency": totals,
            "totals_scope": "returned_resources",
            "service_metadata_basis": "largest absolute current-period service cost; prior-period fallback",
            "resource_groups": len({
                (i["subscription_id"], i["resource_group"].lower())
                for i in items if i["resource_group"]
            }),
            "regions": len({i["region"] for i in items if i["region"]}),
            "services": len({i["service"] for i in items if i["service"]}),
            "subscriptions": len({i["subscription_id"] for i in items if i["subscription_id"]}),
            "truncated": truncated,
            "source": source,
        }

    def _paged_payload(self, items: list[dict[str, Any]], days: int, hi: Any,
                       totals: list[dict[str, Any]], *, page: int, size: int, sort: str,
                       descending: bool, source: str, truncated: bool = False
                       ) -> dict[str, Any]:
        codes = {t["currency"] for t in totals}
        single, mixed = self._currency_fields(codes)
        total = sum(int(t["resources"]) for t in totals)

        def money(field: str) -> dict[str, float | None]:
            return {t["currency"]: (round(float(t[field] or 0), 2)
                                    if t["currency"] != "unknown" else None)
                    for t in sorted(totals, key=lambda t: t["currency"])}

        by_currency = money("cost")
        return {
            "days": days,
            "as_of": str(hi),
            "currency": single,
            "mixed_currency": mixed,
            "currencies": sorted(codes),
            "resources": items,
            "count": len(items),
            "page": page,
            "page_size": size,
            "pages": math.ceil(total / size) if total else 0,
            "total": total,
            "resources_by_currency": {t["currency"]: int(t["resources"]) for t in totals},
            "total_cost": by_currency.get(single) if single else (0.0 if not total else None),
            "total_cost_by_currency": by_currency,
            "prior_cost_by_currency": money("prior"),
            "totals_scope": "matching_resources",
            "sort": sort,
            "descending": descending,
            "service_metadata_basis": "largest absolute current-period service cost; prior-period fallback",
            "truncated": truncated,
            "source": source,
        }

    def _legacy_payload(self, rows: list[dict[str, Any]], days: int, hi: Any, *, paged: bool,
                        page: int, size: int, sort: str, descending: bool, q: str,
                        billing_currency: str, change: str) -> dict[str, Any]:
        """The original, capped query -- used until this generation's keys exist."""
        truncated = len(rows) > MAX_RESOURCES
        rows = rows[:MAX_RESOURCES]
        items = [_item(row) for row in rows]
        if not paged:
            return self._compat_payload(items, days, hi, truncated=truncated, source="legacy",
                                        raw=rows)
        needle = q.lower()
        wanted = billing_currency.upper() if billing_currency.lower() != "unknown" else "unknown"
        matched = [(i, r) for i, r in zip(items, rows)
                   if (not needle or needle in i["id"])
                   and (not billing_currency or i["currency"] == wanted)
                   and (not change or _change_of(i) == change)]
        key = {"cost": lambda p: p[0]["cost"], "prior": lambda p: p[0]["prior_cost"],
               "delta": lambda p: p[0]["cost"] - p[0]["prior_cost"]}[sort]
        matched.sort(key=key, reverse=descending)
        totals: dict[str, dict[str, Any]] = {}
        for i, r in matched:
            t = totals.setdefault(i["currency"], {"currency": i["currency"], "resources": 0,
                                                  "cost": 0.0, "prior": 0.0})
            t["resources"] += 1
            t["cost"] += float(r.get("cost") or 0)
            t["prior"] += float(r.get("prior_cost") or 0)
        start = (page - 1) * size
        return self._paged_payload([i for i, _ in matched[start:start + size]], days, hi,
                                   list(totals.values()), page=page, size=size, sort=sort,
                                   descending=descending, source="legacy", truncated=truncated)


resources: Resources | None = None


def get_resources() -> Resources:
    global resources
    if resources is None:
        resources = Resources()
    return resources
