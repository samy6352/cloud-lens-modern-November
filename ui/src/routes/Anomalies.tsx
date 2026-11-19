import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Chart } from "@/components/Chart";
import { DayContributorsPanel, dayLabel } from "@/components/DayContributors";
import { columnHelper, DataTable } from "@/components/DataTable";
import { ErrorState, KpiTile, PageHeader, Segmented } from "@/components/blocks";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatMoney, formatNumber } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { periodParam, rangeDays, validRange } from "@/lib/period";
import { anomaliesQuery, windowDays, type AnomalyIncident } from "@/lib/queries";


const SEVERITY_CLASS: Record<string, string> = {
  high: "bg-bad/10 text-bad",
  medium: "bg-warn/10 text-warn",
  low: "bg-surface-2 text-muted",
};

function trendOption(days: string[], daily: Map<string, number>, incidents: AnomalyIncident[], selected?: string) {
  const marked = new Set(incidents.map((i) => i.peak_day));
  return {
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", valueFormatter: (v: unknown) => typeof v === "number" ? formatNumber(v) : "No billing data" },
    xAxis: { type: "category", data: days, axisLabel: { hideOverlap: true, formatter: (day: string) => day.slice(5) } },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => formatNumber(v, { compact: true }) } },
    series: [
      {
        type: "line",
        name: "Daily cost",
        showSymbol: true,
        symbolSize: 4,
        data: days.map(day => ({
          value: daily.get(day) ?? null,
          ...(marked.has(day) ? { symbolSize: 9, itemStyle: { color: "#e5484d" } } : selected === day ? { symbolSize: 9 } : {}),
        })),
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
  const [picked, setPicked] = useState<{ day: string; code: string | null } | null>(null);
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
  const checked = new Map(verified.map(([code, points]) => [code, new Set(points.map(p => p.day))]));
  const reported = data?.reported_daily_by_currency ?? {};
  const codes = [...new Set([...Object.keys(reported), ...checked.keys()])].sort();
  const observed = [...Object.values(reported).flat(), ...verified.flatMap(([, points]) => points)].map(p => p.day).sort();
  const datesFrom = data?.requested_from ?? observed[0];
  const datesTo = data?.requested_to ?? observed.at(-1);
  const dates = validRange(datesFrom, datesTo) && datesTo
    ? Array.from({ length: rangeDays(datesFrom, datesTo) }, (_, index) =>
        new Date(Date.parse(datesFrom) + index * 86_400_000).toISOString().slice(0, 10))
    : [];
  const selection = picked && dates.includes(picked.day) ? picked : null;
  const trendLabel = !Object.values(reported).some(points => points.length) && verified.length ? "Verified daily cost" : "Reported daily cost";
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
              <Segmented label="Display currency" value={currency} onChange={value => { setPicked(null); setCurrency(value); }} options={[{ value: "", label: "All" }, ...currencies.map((c) => ({ value: c, label: c.toUpperCase() }))]} />
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
        <CardHeader title={trendLabel} subtitle="Select any day on the chart or from the date list to see its top cost contributors. Red points mark verified incident peaks; gaps mean no billing data." />
        <CardBody>
          {!data ? <Skeleton className="h-[240px] w-full" /> : <>
            {codes.length > 0 && dates.length > 0 ? <div className="grid gap-4 xl:grid-cols-2">
              {codes.map(code => {
                const points = new Map([...(verified.find(([key]) => key === code)?.[1] ?? []), ...(reported[code] ?? [])].map(p => [p.day, p.cost]));
                return <div key={code} className={codes.length === 1 ? "xl:col-span-2" : undefined}>
                  <h3 className="text-sm font-medium">{code === "unknown" ? "Currency unspecified" : code}</h3>
                  <Chart height={200} option={trendOption(dates, points, data.incidents.filter(i => i.currency === code), selection?.day)}
                    onCategoryClick={day => setPicked({ day, code })} />
                </div>;
              })}
            </div> : <p className="text-sm text-muted">No billing data for the selected dates and subscriptions.</p>}
            {dates.length > 0 && <label className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
              Contributor date
              <select className="rounded border border-border bg-surface px-2 py-1 text-fg" value={selection?.day ?? ""}
                onChange={e => setPicked(e.target.value ? { day: e.target.value, code: null } : null)}>
                <option value="">Select a day</option>
                {dates.map(day => <option key={day} value={day}>{dayLabel(day)}</option>)}
              </select>
            </label>}
            {selection && !query.isPlaceholderData && <DayContributorsPanel currentOnly day={selection.day} currency={selection.code}
              scope={{ ...search, currency: currency || undefined }}
              partial={selection.code ? !checked.get(selection.code)?.has(selection.day) : !verified.some(([, points]) => points.some(p => p.day === selection.day))}
              onClose={() => setPicked(null)} />}
          </>}
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
