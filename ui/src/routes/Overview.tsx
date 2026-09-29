import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Chart } from "@/components/Chart";
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
    () => [...views].sort((a, b) => (b.kpis.total ?? 0) - (a.kpis.total ?? 0)),
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
  const max = Math.max(...rows.map((r) => r.cost), 1);
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
                {r.change_pct == null ? "new" : `${r.change_pct > 0 ? "+" : ""}${r.change_pct.toFixed(1)}%`}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent/70 transition-[width] duration-500 ease-out-soft group-hover:bg-accent"
                style={{ width: `${(r.cost / max) * 100}%` }}
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
  const money = (v: number | null | undefined, compact = true) => formatMoney(v, currency, { system: numbers, compact });
  const period = search.month ? formatMonth(search.month) : `Last ${view?.days ?? 30} days`;

  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  return (
    <div>
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
              options={ordered.map((v) => ({ value: v.currency ?? "", label: v.currency ?? "—" }))}
            />
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
          value={formatNumber(view?.kpis.resources, { system: numbers, compact: true })}
          hint={view ? `${view.kpis.services ?? "—"} services · ${view.kpis.regions ?? "—"} regions` : undefined}
        />
        <KpiTile
          index={3}
          loading={loading}
          label="Top-5 service concentration"
          value={view?.kpis.top5_share_pct != null ? `${view.kpis.top5_share_pct.toFixed(1)}%` : "—"}
          hint="share of spend in the five largest services"
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Daily spend" subtitle="This period against the one before it" />
          <CardBody>
            {view && view.trend.labels.length ? (
              <Chart height={300} option={trendOption(view, numbers)} />
            ) : loading ? (
              <Skeleton className="h-[300px] w-full" />
            ) : (
              <p className="py-24 text-center text-sm text-muted">No daily data in this period.</p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Spend by area" subtitle="Where the money goes" />
          <CardBody>
            {view && view.areas.length ? (
              <>
                <Chart height={180} option={areaOption(view, numbers)} />
                <ul className="mt-3 space-y-1.5 text-sm">
                  {view.areas.slice(0, 6).map((a, i) => (
                    <li key={a.id ?? a.name} className="flex items-center gap-2">
                      <span className="size-2.5 shrink-0 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
                      <span className="flex-1 truncate">{a.label ?? a.name}</span>
                      <span className="num text-muted">{a.share_pct?.toFixed(1)}%</span>
                      <span className="num w-20 text-right font-medium">{money(a.cost)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <Skeleton className="h-[300px] w-full" />
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
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
        <Card className="mt-4">
          <CardHeader title="Monthly spend by area" subtitle="Calendar months in the warehouse" />
          <CardBody>
            <Chart height={300} option={monthlyOption(view, numbers)} />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
