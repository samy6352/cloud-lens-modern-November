import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Chart } from "@/components/Chart";
import { RegionSpend } from "@/components/RegionSpend";
import { orderCurrencyViews } from "@/components/RegionSpendModel";
import { ErrorState, KpiTile, PageHeader, Segmented } from "@/components/blocks";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatMoney, formatMonth, formatNumber } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { PALETTE } from "@/lib/palette";
import { executiveQuery, subscriptionsQuery, type ExecutiveView, type Ranked } from "@/lib/queries";

/** A mixed-currency estate has no honest single total, so the page shows one currency at a time. */
function useCurrencyViews(views: ExecutiveView[]) {
  const [picked, setPicked] = useState<string | null>(null);
  const ordered = useMemo(
    () => orderCurrencyViews(views),
    [views],
  );
  const view = ordered.find((v) => v.currency === picked) ?? ordered[0];
  return { view, ordered, setPicked };
}

function RankedBars({
  rows,
  currency,
  onPick,
  empty = "Nothing to show for this period.",
}: {
  rows: Ranked[];
  currency: string | null;
  onPick?: (row: Ranked) => void;
  empty?: string;
}) {
  const { numbers } = usePrefs();
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted">{empty}</p>;
  const max = Math.max(...rows.map((r) => Math.abs(r.cost)), 1);
  return (
    <ul className="space-y-1">
      {rows.map((r) => (
        <li key={r.id ?? r.name}>
          <button
            type="button"
            disabled={!onPick}
            onClick={() => onPick?.(r)}
            className={cn("group block w-full rounded-lg px-2 py-1.5 text-left", onPick && "hover:bg-surface-2")}
          >
            <div className="flex items-baseline gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate" title={r.name}>
                {r.name}
              </span>
              <span className="num shrink-0 font-medium">{formatMoney(r.cost, currency, { system: numbers, compact: true })}</span>
              <span
                className={cn(
                  "num w-14 shrink-0 text-right text-xs",
                  (r.change_pct ?? 0) > 0 ? "text-bad" : (r.change_pct ?? 0) < 0 ? "text-good" : "text-muted",
                )}
              >
                {r.change_pct == null ? "—" : `${r.change_pct > 0 ? "+" : ""}${r.change_pct.toFixed(1)}%`}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className={cn("h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500", r.cost < 0 ? "bg-good/70" : "bg-accent/70")}
                style={{ width: `${(Math.abs(r.cost) / max) * 100}%` }}
              />
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function trendOption(view: ExecutiveView, system: "indian" | "international") {
  const money = (v: number) => formatMoney(v, view.currency, { system, compact: true });
  return {
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    legend: { top: 0, right: 0, itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11 } },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => money(v) },
    xAxis: {
      type: "category",
      data: view.trend.labels,
      boundaryGap: false,
      axisLabel: { formatter: (d: string) => d.slice(5), fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: { type: "value", axisLabel: { formatter: money, fontSize: 11 } },
    series: [
      {
        name: "This period",
        type: "line",
        data: view.trend.values,
        smooth: 0.25,
        symbol: "none",
        lineStyle: { width: 2.5 },
        areaStyle: { opacity: 0.12 },
      },
      {
        name: "Previous period",
        type: "line",
        data: view.trend.previous,
        smooth: 0.25,
        symbol: "none",
        lineStyle: { width: 1.5, type: "dashed" },
        itemStyle: { color: "#94a3b8" },
      },
    ],
  };
}

function areaOption(view: ExecutiveView, system: "indian" | "international") {
  const signed = view.areas.some((area) => area.cost < 0);
  if (signed) {
    return {
      grid: { left: 8, right: 16, top: 8, bottom: 8, containLabel: true },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => formatMoney(v, view.currency, { system, compact: true }) },
      xAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => formatMoney(v, view.currency, { system, compact: true }) } },
      yAxis: { type: "category", inverse: true, data: view.areas.map((a) => a.label ?? a.name), axisLabel: { width: 95, overflow: "truncate", fontSize: 10 } },
      series: [{ type: "bar", barMaxWidth: 16, data: view.areas.map((a) => a.cost) }],
    };
  }
  return {
    tooltip: {
      trigger: "item",
      valueFormatter: (v: number) => formatMoney(v, view.currency, { system, compact: true }),
    },
    series: [
      {
        type: "pie",
        radius: ["58%", "82%"],
        padAngle: 1.5,
        itemStyle: { borderRadius: 4 },
        label: { show: false },
        data: view.areas.map((a) => ({ name: a.label ?? a.name, value: a.cost })),
      },
    ],
  };
}

function monthlyOption(view: ExecutiveView, system: "indian" | "international") {
  const monthly = view.monthly!;
  const money = (v: number) => formatMoney(v, monthly.currency, { system, compact: true });
  return {
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    legend: { top: 0, type: "scroll", itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11 } },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: number) => money(v) },
    xAxis: { type: "category", data: monthly.months.map(formatMonth), axisTick: { show: false } },
    yAxis: { type: "value", axisLabel: { formatter: money, fontSize: 11 } },
    series: monthly.areas.map((a) => ({ name: a.label, type: "bar", stack: "total", barMaxWidth: 56, data: a.data })),
  };
}

export function OverviewPage() {
  const search = useSearch({ from: "__root__" });
  const navigate = useNavigate();
  const { numbers } = usePrefs();
  const query = useQuery(executiveQuery(search));
  const subs = useQuery(subscriptionsQuery);

  const views = useMemo<ExecutiveView[]>(() => {
    const data = query.data;
    if (!data) return [];
    if (data.by_currency?.length) return data.by_currency;
    return [data];
  }, [query.data]);
  const { view, ordered, setPicked } = useCurrencyViews(views);

  const subIds = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of subs.data?.subscriptions ?? []) if (s.name) map.set(s.name, s.id);
    return map;
  }, [subs.data]);

  const loading = query.isPending;
  const currency = view?.currency ?? null;
  const money = (v: number | null | undefined, compact = true) =>
    v == null || !Number.isFinite(v) ? "Unavailable" : formatMoney(v, currency, { system: numbers, compact });
  const period = search.month ? formatMonth(search.month) : `Last ${view?.days ?? 30} days`;

  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  return (
    <div className="min-w-0">
      <PageHeader
        title="Overview"
        subtitle={
          view ? (
            <>
              {period} · data to <span className="num">{view.as_of}</span>
              {ordered.length > 1 && " · currencies reported separately"}
            </>
          ) : (
            <Skeleton className="h-4 w-56" />
          )
        }
        actions={
          ordered.length > 1 ? (
            <Segmented
              label="Currency"
              value={currency ?? ""}
              onChange={(c) => setPicked(c)}
              options={ordered.map((v) => ({ value: v.currency ?? "", label: v.currency ?? "Unspecified" }))}
            />
          ) : null
        }
      />

      {view && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-2 px-4 py-3 text-xs">
          <p><span className="font-semibold">Your financial snapshot</span><span className="text-muted"> · {currency ?? "Currency unspecified"} · {period}</span></p>
          <p className="text-muted">{ordered.length > 1 ? "One currency at a time. Totals are never combined or converted." : "Recorded billing spend, including credits."}</p>
        </div>
      )}
      {query.data?.notice && <p className="mb-4 text-sm text-muted">{query.data.notice}</p>}

      <div className="grid grid-cols-1 gap-4 [&>*]:min-w-0 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          index={0}
          loading={loading}
          label="Total spend"
          value={money(view?.kpis.total)}
          changePct={view?.kpis.change_pct}
          hint={view?.kpis.previous != null ? `vs ${money(view.kpis.previous)} previous` : undefined}
        />
        <KpiTile
          index={1}
          loading={loading}
          label="Daily average"
          value={money(view?.kpis.daily_avg)}
          hint={view ? `${formatNumber(view.kpis.subscriptions, { system: numbers, digits: 0 })} subscriptions` : undefined}
        />
        <KpiTile
          index={2}
          loading={loading}
          label="Resources billed"
          value={view?.kpis.resources == null ? "Unavailable" : formatNumber(view.kpis.resources, { system: numbers, compact: true })}
          hint={view ? `${view.kpis.services ?? "Unavailable"} services · ${view.kpis.regions ?? "Unavailable"} regions` : undefined}
        />
        <KpiTile
          index={3}
          loading={loading}
          label="Top-5 service concentration"
          value={view?.kpis.top5_share_pct != null ? `${view.kpis.top5_share_pct.toFixed(1)}%` : "Unavailable"}
          hint="share of spend in the five largest services"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="min-w-0 xl:col-span-2">
          <CardHeader title="Daily spend" subtitle="This period against the one before it" />
          <CardBody>
            {view && view.trend.labels.length ? (
              <>
                <div role="img" aria-label={`Daily spend in ${currency ?? "unspecified currency"}, this and previous period. Exact daily values are available below.`}><div aria-hidden="true"><Chart height={300} option={trendOption(view, numbers)} /></div></div>
                {view.trend.partial_last && <p className="mt-2 text-xs text-muted">Latest day is partial; do not compare it with a complete billing day.</p>}
                <details className="mt-3 text-xs">
                  <summary className="w-fit cursor-pointer font-medium text-accent">View daily values</summary>
                  <div className="mt-2 max-h-64 overflow-auto" tabIndex={0} role="region" aria-label="Daily spend data">
                    <table className="w-full text-left"><caption className="py-2 text-left text-muted">Executive API · {currency ?? "currency unspecified"} · previous period aligned by day</caption><thead><tr><th scope="col" className="py-2">Date</th><th scope="col">Current</th><th scope="col">Previous</th></tr></thead><tbody>{view.trend.labels.map((day, i) => <tr key={day} className="border-t border-border"><th scope="row" className="py-2 font-normal">{day}{view.trend.partial_last && i === view.trend.labels.length - 1 ? " (partial)" : ""}</th><td className="num">{money(view.trend.values[i], false)}</td><td className="num">{money(view.trend.previous[i], false)}</td></tr>)}</tbody></table>
                  </div>
                </details>
              </>
            ) : loading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : (
              <p className="py-24 text-center text-sm text-muted">No daily data in this period.</p>
            )}
          </CardBody>
        </Card>
        <Card className="min-w-0">
          <CardHeader title="Spend by area" subtitle="Where the money goes" />
          <CardBody>
            {view && view.areas.length ? (
              <>
                {view.areas.every((a) => Number.isFinite(a.cost)) && view.areas.some((a) => a.cost !== 0) ? (
                  <div role="img" aria-label={`Spend by billing area in ${currency ?? "unspecified currency"}. Exact values are listed below.`}><div aria-hidden="true"><Chart height={180} option={areaOption(view, numbers)} /></div></div>
                ) : <p className="py-8 text-center text-xs text-muted">No complete, non-zero area costs to chart.</p>}
                {view.areas.some((a) => a.cost < 0) && <p className="mt-2 text-xs text-muted">Credits included. Signed bars replace the ring to preserve net spend.</p>}
                <ul className="mt-3 space-y-1.5 text-sm">
                  {view.areas.map((a, i) => (
                    <li key={a.id ?? a.name} className="flex items-center gap-2">
                      <span className="size-2.5 shrink-0 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
                      <span className="min-w-0 flex-1 break-words">{a.label ?? a.name}</span>
                      <span className="num text-xs text-muted">{a.share_pct == null ? "—" : `${a.share_pct.toFixed(1)}%`}</span>
                      <span className="num w-20 text-right font-medium">{money(a.cost)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : loading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : (
              <p className="py-24 text-center text-sm text-muted">No area data in this period.</p>
            )}
          </CardBody>
        </Card>
      </div>

      {view ? <RegionSpend key={`${currency}-${search.month ?? ""}-${search.scope ?? ""}`} rows={view.regions ?? []} currency={currency} /> : loading ? <Skeleton className="mt-4 h-[420px] w-full" /> : null}

      <div className="mt-4 grid grid-cols-1 gap-4 [&>*]:min-w-0 lg:grid-cols-3">
        <Card>
          <CardHeader title="Top services" />
          <CardBody>{view ? <RankedBars rows={view.services} currency={currency} /> : <Skeleton className="h-64" />}</CardBody>
        </Card>
        <Card>
          <CardHeader title="Top subscriptions" subtitle="Click to scope the dashboard" />
          <CardBody>
            {view ? (
              <RankedBars
                rows={view.subscriptions}
                currency={currency}
                onPick={(r) => {
                  const id = subIds.get(r.name);
                  if (id) void navigate({ to: ".", search: { ...search, scope: id } });
                }}
              />
            ) : (
              <Skeleton className="h-64" />
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Biggest movers" subtitle="Largest change against the previous period" />
          <CardBody>{view ? <RankedBars rows={view.movers} currency={currency} /> : <Skeleton className="h-64" />}</CardBody>
        </Card>
      </div>

      {view?.monthly && view.monthly.months.length > 1 && (
        <Card className="mt-4 min-w-0">
          <CardHeader title="Monthly spend by area" subtitle={`Calendar months in the warehouse · ${view.monthly.currency}`} />
          <CardBody>
            <Chart height={300} option={monthlyOption(view, numbers)} />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
