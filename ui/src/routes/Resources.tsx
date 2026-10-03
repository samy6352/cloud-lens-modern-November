import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { columnHelper, DataTable } from "@/components/DataTable";
import { ErrorState, KpiTile, PageHeader, Segmented } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney, formatNumber } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import {
  resourcesQuery,
  type ResourceChange,
  type ResourcePage,
  type ResourceQuery,
  type ResourceRow,
  type ResourceSort,
} from "@/lib/queries";

const PAGE_SIZE = 100;
const CHANGES: Array<{ value: ResourceChange; label: string }> = [
  { value: "", label: "All" },
  { value: "increased", label: "Up" },
  { value: "decreased", label: "Down" },
  { value: "unchanged", label: "Flat" },
  { value: "no-baseline", label: "New spend" },
];
const SORT_IDS: Record<string, ResourceSort> = { cost: "cost", prior_cost: "prior", delta: "delta" };
const COLUMN_OF: Record<ResourceSort, string> = { cost: "cost", prior: "prior_cost", delta: "delta" };
const SOURCE_NOTE: Record<ResourcePage["source"], string> = {
  ranked: "ranked at the last data load",
  window: "ranked for this window",
  filtered: "ranked for these filters",
  legacy: "top resources only while rankings rebuild",
};

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return settled;
}

function useColumns() {
  const { numbers } = usePrefs();
  return useMemo(() => {
    const h = columnHelper<ResourceRow>();
    const money = (v: number, currency: string) => formatMoney(v, currency === "unknown" ? null : currency, { system: numbers });
    return [
      h.accessor("name", {
        header: "Resource",
        enableSorting: false,
        cell: (c) => (
          <div className="min-w-0 leading-tight" title={c.row.original.id}>
            <div className="truncate font-medium">{c.getValue()}</div>
            <div className="truncate text-xs text-muted">{c.row.original.service ?? "—"}</div>
          </div>
        ),
        meta: { width: "minmax(240px, 2.2fr)" },
      }),
      h.accessor((r) => r.resource_group ?? "", {
        id: "resource_group",
        header: "Group / region",
        enableSorting: false,
        cell: (c) => (
          <div className="min-w-0 leading-tight">
            <div className="truncate">{c.row.original.resource_group ?? "—"}</div>
            <div className="truncate text-xs text-muted">{c.row.original.region ?? "—"}</div>
          </div>
        ),
        meta: { width: "minmax(160px, 1.3fr)" },
      }),
      h.accessor((r) => r.subscription ?? r.subscription_id ?? "", {
        id: "subscription",
        header: "Subscription",
        enableSorting: false,
        cell: (c) => <span className="text-muted">{(c.getValue() as string) || "—"}</span>,
        meta: { width: "minmax(130px, 0.9fr)" },
      }),
      h.accessor("cost", {
        header: "Period cost",
        cell: (c) => money(c.getValue(), c.row.original.currency),
        meta: { align: "right", width: "minmax(120px, 0.8fr)" },
      }),
      h.accessor("prior_cost", {
        header: "Prior period",
        cell: (c) => <span className="text-muted">{money(c.getValue(), c.row.original.currency)}</span>,
        meta: { align: "right", width: "minmax(120px, 0.8fr)" },
      }),
      h.accessor("delta", {
        header: "Change",
        cell: (c) => {
          const r = c.row.original;
          if (!r.prior_cost) return <span className="text-muted">new spend</span>;
          const cls = r.delta > 0 ? "text-bad" : r.delta < 0 ? "text-good" : "text-muted";
          return (
            <span className={cls}>
              {r.delta > 0 ? "+" : ""}
              {money(r.delta, r.currency)}
              {r.change_pct != null && <span className="ml-1 text-xs">({r.change_pct > 0 ? "+" : ""}{r.change_pct}%)</span>}
            </span>
          );
        },
        meta: { align: "right", width: "minmax(190px, 1.2fr)" },
      }),
      h.accessor("tag_count", {
        header: "Tags",
        enableSorting: false,
        cell: (c) => (c.getValue() ? <span title={c.row.original.tags.map((t) => `${t.key}=${t.value}`).join("\n")}>{c.getValue()}</span> : <span className="text-muted">—</span>),
        meta: { align: "right", width: "minmax(64px, 0.4fr)" },
      }),
    ];
  }, [numbers]);
}

export function ResourcesPage() {
  const search = useSearch({ from: "__root__" });
  const { numbers } = usePrefs();
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 300);
  const [state, setState] = useState<Omit<ResourceQuery, "q">>({
    page: 1,
    pageSize: PAGE_SIZE,
    sort: "cost",
    desc: true,
    currency: "",
    change: "",
  });
  // Any change of what matches starts again from the first page.
  useEffect(() => setState((s) => ({ ...s, page: 1 })), [q, search.month, search.scope]);

  const query = useQuery({ ...resourcesQuery(search, { ...state, q }), placeholderData: keepPreviousData });
  const data = query.data;
  const columns = useColumns();
  // Mixed currencies are never added together; like Billing, the header totals the
  // currency most resources bill in unless another one is picked.
  const dominant = data ? (Object.entries(data.resources_by_currency).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null) : null;
  const currency = state.currency || data?.currency || (dominant === "unknown" ? null : dominant);
  const others = data && currency && !state.currency && data.mixed_currency
    ? data.total - (data.resources_by_currency[currency] ?? 0)
    : 0;
  const money = (v: number | null | undefined) => formatMoney(v, currency, { system: numbers, compact: true });
  const cost = currency ? data?.total_cost_by_currency[currency] : null;
  const prior = currency ? data?.prior_cost_by_currency[currency] : null;
  const changePct = cost != null && prior ? ((cost - prior) / prior) * 100 : null;
  const first = data && data.total ? (data.page - 1) * data.page_size + 1 : 0;
  const last = data ? Math.min(data.page * data.page_size, data.total) : 0;
  const set = (patch: Partial<Omit<ResourceQuery, "q">>) => setState((s) => ({ ...s, page: 1, ...patch }));

  if (query.isError && !data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  return (
    <div>
      <PageHeader
        title="All resources"
        subtitle={
          data ? (
            <>
              Every billed resource, {data.days}-day period vs the one before
              {data.as_of && (
                <>
                  {" "}· data through <span className="num">{data.as_of}</span>
                </>
              )}
              {" "}· {SOURCE_NOTE[data.source]}
            </>
          ) : (
            <Skeleton className="h-4 w-72" />
          )
        }
        actions={
          data && data.currencies.length > 1 ? (
            <Segmented
              label="Billing currency"
              value={state.currency}
              onChange={(v) => set({ currency: v })}
              options={[{ value: "", label: "All" }, ...data.currencies.map((c) => ({ value: c, label: c.toUpperCase() }))]}
            />
          ) : null
        }
      />

      {data?.truncated && (
        <Card className="mb-4 border-warn/40 p-4 text-sm">
          Showing the top {formatNumber(data.total, { system: numbers, digits: 0 })} resources while the full ranking is rebuilt after the latest data load.
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile index={0} loading={!data} label="Resources" value={formatNumber(data?.total, { system: numbers, digits: 0 })} hint={q || state.change || state.currency ? "matching the filters" : "billed in this period or the one before"} />
        <KpiTile
          index={1}
          loading={!data}
          label="Period cost"
          value={currency ? money(cost) : "Mixed"}
          changePct={changePct}
          hint={
            !currency
              ? "pick a billing currency to total"
              : others
                ? `${currency.toUpperCase()} only · ${formatNumber(others, { system: numbers, digits: 0 })} in other currencies`
                : "resource-attributed"
          }
        />
        <KpiTile index={2} loading={!data} label="Prior period" value={currency ? money(prior) : "—"} hint="same length, immediately before" />
        <KpiTile
          index={3}
          loading={!data}
          label="Change"
          value={currency && cost != null && prior != null ? money(cost - prior) : "—"}
          goodWhenDown
          hint="period cost minus prior"
        />
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Resources"
          subtitle="Sorted and filtered on the server; pages load as you go."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Segmented label="Cost change" value={state.change} onChange={(v) => set({ change: v })} options={CHANGES} />
              <label className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Search name, group, type, ID…"
                  aria-label="Search resources"
                  maxLength={200}
                  className="h-9 w-64 rounded-lg border border-border bg-surface pl-8 pr-3 text-sm outline-none focus:border-accent/60"
                />
              </label>
            </div>
          }
        />
        <CardBody>
          {data ? (
            <DataTable
              data={data.resources}
              columns={columns}
              rowKey={(r) => `${r.subscription_id ?? ""}|${r.id}|${r.currency}`}
              sort={{ id: COLUMN_OF[state.sort], desc: state.desc }}
              onSortChange={({ id, desc }) => set({ sort: SORT_IDS[id] ?? "cost", desc })}
              busy={query.isFetching}
              height={620}
              empty={q || state.change || state.currency ? "No resources match these filters." : "No resource-attributed cost in this period."}
              footer={
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="num">
                    {data.total
                      ? `${formatNumber(first, { system: numbers, digits: 0 })}–${formatNumber(last, { system: numbers, digits: 0 })} of ${formatNumber(data.total, { system: numbers, digits: 0 })}`
                      : "0 resources"}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="num">
                      Page {formatNumber(data.page, { digits: 0 })} of {formatNumber(Math.max(1, data.pages), { digits: 0 })}
                    </span>
                    <Button size="sm" variant="ghost" aria-label="Previous page" disabled={data.page <= 1 || query.isFetching} onClick={() => setState((s) => ({ ...s, page: s.page - 1 }))}>
                      <ChevronLeft />
                    </Button>
                    <Button size="sm" variant="ghost" aria-label="Next page" disabled={data.page >= data.pages || query.isFetching} onClick={() => setState((s) => ({ ...s, page: s.page + 1 }))}>
                      <ChevronRight />
                    </Button>
                  </span>
                </div>
              }
            />
          ) : (
            <Skeleton className="h-[620px] w-full" />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
