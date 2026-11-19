import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Chart } from "@/components/Chart";
import { columnHelper, DataTable } from "@/components/DataTable";
import { ErrorState, KpiTile, PageHeader, Segmented } from "@/components/blocks";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatMoney, formatNumber } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { periodParam } from "@/lib/period";
import { anomaliesQuery, windowDays, type AnomalyIncident, type AnomalyReport } from "@/lib/queries";


const SEVERITY_CLASS: Record<string, string> = {
  high: "bg-bad/10 text-bad",
  medium: "bg-warn/10 text-warn",
  low: "bg-surface-2 text-muted",
};

function trendOption(daily: AnomalyReport["daily"], incidents: AnomalyIncident[]) {
  const marked = new Set(incidents.map((i) => i.peak_day));
  const dates = daily.map((d) => d.day);
  return {
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    tooltip: { trigger: "item" },
    xAxis: { type: "time", axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => formatNumber(v, { compact: true }) } },
    series: [
      {
        type: "line",
        name: "Daily cost",
        showSymbol: true,
        symbolSize: 4,
        data: daily.flatMap((d, i) => {
          const previous = dates[i - 1];
          const point = {
            value: [d.day, d.cost],
            ...(marked.has(d.day) ? { symbolSize: 9, itemStyle: { color: "#e5484d" } } : {}),
          };
          if (!previous || Date.parse(d.day) - Date.parse(previous) <= 86_400_000) return [point];
          return [{ value: [Date.parse(previous) + 86_400_000, null] }, point];
        }),
        smooth: false,
      },
    ],
  };
}

export function AnomaliesPage() {
  const search = useSearch({ from: "__root__" });
  return <AnomaliesContent key={JSON.stringify([periodParam(search), search.scope, windowDays(search), search.currency])} />;
}

function AnomaliesContent() {
  const search = useSearch({ from: "__root__" });
  const { numbers } = usePrefs();
  const [currency, setCurrency] = useState("");
  const inventory = useQuery(anomaliesQuery(search, windowDays(search), ""));
  const filtered = useQuery({ ...anomaliesQuery(search, windowDays(search), currency), enabled: !!currency, placeholderData: keepPreviousData });
  const query = currency ? filtered : inventory;
  const data = query.data;
  const money = (v: number | null | undefined, c: string | null | undefined) => formatMoney(v, c ?? null, { system: numbers });

  const columns = useMemo(() => {
    const h = columnHelper<AnomalyIncident>();
    return [
      h.accessor("first_day", {
        header: "When",
        enableSorting: false,
        cell: (c) => {
          const r = c.row.original;
          return (
            <div className="flex min-w-0 items-baseline gap-2">
              <div className="min-w-0 shrink num">{r.first_day === r.last_day ? r.first_day : `${r.first_day} → ${r.last_day}`}</div>
              <div className="min-w-0 shrink-[2] text-xs text-muted">{r.duration_days === 1 ? "1 day" : `${r.duration_days} days`}</div>
            </div>
          );
        },
        meta: { width: "minmax(170px, 1.1fr)" },
      }),
      h.accessor("key", {
        header: "What changed",
        enableSorting: false,
        cell: (c) => (
          <div className="flex min-w-0 items-baseline gap-2" title={c.getValue()}>
            <div className="min-w-0 shrink truncate font-medium">{c.getValue()}</div>
            <div className="min-w-0 shrink-[2] truncate text-xs text-muted">{c.row.original.dimension}</div>
          </div>
        ),
        meta: { width: "minmax(240px, 2.2fr)" },
      }),
      h.accessor("severity", {
        header: "Severity",
        enableSorting: false,
        cell: (c) => (
          <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium capitalize", SEVERITY_CLASS[c.getValue()] ?? SEVERITY_CLASS.low)}>
            {c.getValue()}
          </span>
        ),
        meta: { width: "minmax(90px, 0.6fr)" },
      }),
      h.accessor((r) => r.baseline ?? 0, {
        id: "baseline",
        header: "Usual",
        enableSorting: false,
        cell: (c) => <span className="text-muted">{money(c.row.original.baseline, c.row.original.currency)}</span>,
        meta: { align: "right", width: "minmax(110px, 0.7fr)" },
      }),
      h.accessor((r) => r.cost ?? 0, {
        id: "peak",
        header: "Peak day",
        enableSorting: false,
        cell: (c) => money(c.row.original.cost, c.row.original.currency),
        meta: { align: "right", width: "minmax(110px, 0.7fr)" },
      }),
      h.accessor("total_delta", {
        header: "Total effect",
        enableSorting: false,
        cell: (c) => {
          const r = c.row.original;
          return (
            <span className={r.direction === "up" ? "text-bad" : "text-good"}>
              {r.total_delta > 0 ? "+" : ""}
              {money(r.total_delta, r.currency)}
            </span>
          );
        },
        meta: { align: "right", width: "minmax(130px, 0.8fr)" },
      }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numbers]);

  if (query.isError && !data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const currencies = Array.from(new Set((inventory.data?.incidents ?? []).map((i) => i.currency).filter(Boolean)));
  const verified = Object.entries(data?.daily_by_currency ?? {}).filter(([, points]) => points.length);
  if (!verified.length && data?.daily?.length) verified.push([data.currency ?? "unknown", data.daily]);
  const reported = Object.entries(data?.reported_daily_by_currency ?? {}).filter(([, points]) => points.length);
  const trends = verified.length ? verified : reported;
  const trendLabel = verified.length ? "Verified daily cost" : "Reported daily cost";
  return (
    <div>
      <PageHeader
        title="Anomalies"
        subtitle={
          data ? (
            <>
              {data.unavailable ? "Anomaly assessment unavailable for this selection" : "Days compared with a rolling median"}
              {data.window_from && data.window_to && (
                <>
                  {" "}· billing dates <span className="num">{data.window_from}</span> to <span className="num">{data.window_to}</span>
                </>
              )}
            </>
          ) : (
            <Skeleton className="h-4 w-72" />
          )
        }
        actions={
          <>
            {currencies.length > 1 && (
              <Segmented label="Display currency" value={currency} onChange={setCurrency} options={[{ value: "", label: "All" }, ...currencies.map((c) => ({ value: c, label: c.toUpperCase() }))]} />
            )}
          </>
        }
      />

      {data?.note && <Card className="mb-4 p-4 text-sm text-muted">{data.note}</Card>}
      {data?.coverage_reason && data.coverage_reason !== data.note && (
        <p className="mb-4 text-sm text-muted">{data.coverage_reason}</p>
      )}

      {!data?.unavailable && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile index={0} loading={!data} label="Incidents" value={formatNumber(data?.incident_count, { system: numbers, digits: 0 })} hint={`${formatNumber(data?.count, { system: numbers, digits: 0 })} anomalous days`} />
        <KpiTile index={1} loading={!data} label="High severity" value={formatNumber(data?.high, { system: numbers, digits: 0 })} hint="days rated high" />
        <KpiTile index={2} loading={!data} label="Increases" value={formatNumber(data?.increases, { system: numbers, digits: 0 })} hint={`${formatNumber(data?.decreases, { system: numbers, digits: 0 })} decreases`} />
        <KpiTile index={3} loading={!data} label="Extra spend" value={data?.currency ? money(data.impact, data.currency) : "Mixed"} hint="sum of increases in the window" />
      </div>}

      <Card className="mt-4">
        <CardHeader title={trendLabel} subtitle={verified.length ? "Red points mark incident peaks. Missing days are not filled with zero." : "Reported charges are not sufficient evidence to classify an anomaly."} />
        <CardBody>
          {!data ? <Skeleton className="h-[240px] w-full" /> : trends.length ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {trends.map(([code, points]) => (
                <div key={code} className={trends.length === 1 ? "xl:col-span-2" : undefined}>
                  <h3 className="text-sm font-medium">{code === "unknown" ? "Currency unspecified" : code}</h3>
                  <Chart height={200} option={trendOption(points, verified.length ? data.incidents.filter((i) => i.currency === code) : [])} />
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-muted">No billing data for the selected dates and subscriptions. Try a different reporting period or scope.</p>}
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHeader title="Incidents" subtitle="Consecutive anomalous days on one thing count once." />
        <CardBody>
          {data ? (
            <DataTable
              data={data.incidents}
              columns={columns}
              rowKey={(r) => r.id}
              busy={query.isFetching}
              height={Math.min(560, 56 + data.incidents.length * 56)}
              empty={data.unavailable ? "Not enough verified history to assess this window." : data.partial ? "No incidents detected in the days that could be assessed." : "Nothing unusual in this window."}
            />
          ) : (
            <Skeleton className="h-[320px] w-full" />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
