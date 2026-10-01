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
import { anomaliesQuery, type AnomalyIncident, type AnomalyReport } from "@/lib/queries";

const WINDOWS = [
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days" },
];

const SEVERITY_CLASS: Record<string, string> = {
  high: "bg-bad/10 text-bad",
  medium: "bg-warn/10 text-warn",
  low: "bg-surface-2 text-muted",
};

function trendOption(report: AnomalyReport, incidents: AnomalyIncident[]) {
  const marked = new Set(incidents.flatMap((i) => [i.peak_day]));
  return {
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: report.daily.map((d) => d.day), axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => formatNumber(v, { compact: true }) } },
    series: [
      {
        type: "line",
        name: "Daily cost",
        showSymbol: false,
        data: report.daily.map((d) => ({
          value: d.cost,
          ...(marked.has(d.day) ? { symbol: "circle", symbolSize: 9, itemStyle: { color: "#e5484d" } } : {}),
        })),
        smooth: false,
      },
    ],
  };
}

export function AnomaliesPage() {
  const search = useSearch({ from: "__root__" });
  const { numbers } = usePrefs();
  const [days, setDays] = useState("60");
  const [currency, setCurrency] = useState("");
  const query = useQuery({ ...anomaliesQuery(search, Number(days), currency), placeholderData: keepPreviousData });
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
            <div className="leading-tight">
              <div className="num">{r.first_day === r.last_day ? r.first_day : `${r.first_day} → ${r.last_day}`}</div>
              <div className="text-xs text-muted">{r.duration_days === 1 ? "1 day" : `${r.duration_days} days`}</div>
            </div>
          );
        },
        meta: { width: "minmax(170px, 1.1fr)" },
      }),
      h.accessor("key", {
        header: "What changed",
        enableSorting: false,
        cell: (c) => (
          <div className="min-w-0 leading-tight" title={c.getValue()}>
            <div className="truncate font-medium">{c.getValue()}</div>
            <div className="truncate text-xs text-muted">{c.row.original.dimension}</div>
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

  const currencies = data?.mixed_currency ? Array.from(new Set(data.incidents.map((i) => i.currency).filter(Boolean))) : [];
  return (
    <div>
      <PageHeader
        title="Anomalies"
        subtitle={
          data ? (
            <>
              Days compared with a rolling median
              {data.window_from && data.window_to && (
                <>
                  {" "}· judged <span className="num">{data.window_from}</span> to <span className="num">{data.window_to}</span>
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
            <Segmented label="Window" value={days} onChange={setDays} options={WINDOWS} />
          </>
        }
      />

      {data?.note && <Card className="mb-4 p-4 text-sm text-muted">{data.note}</Card>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile index={0} loading={!data} label="Incidents" value={formatNumber(data?.incident_count, { system: numbers, digits: 0 })} hint={`${formatNumber(data?.count, { system: numbers, digits: 0 })} anomalous days`} />
        <KpiTile index={1} loading={!data} label="High severity" value={formatNumber(data?.high, { system: numbers, digits: 0 })} hint="days rated high" />
        <KpiTile index={2} loading={!data} label="Increases" value={formatNumber(data?.increases, { system: numbers, digits: 0 })} hint={`${formatNumber(data?.decreases, { system: numbers, digits: 0 })} decreases`} />
        <KpiTile index={3} loading={!data} label="Extra spend" value={data?.currency ? money(data.impact, data.currency) : "Mixed"} hint="sum of increases in the window" />
      </div>

      <Card className="mt-4">
        <CardHeader title="Daily cost" subtitle="Red points mark each incident's peak day." />
        <CardBody>{data ? <Chart height={240} option={trendOption(data, data.incidents)} /> : <Skeleton className="h-[240px] w-full" />}</CardBody>
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
              empty={data.unavailable ? "Not enough verified history to assess this window." : "Nothing unusual in this window."}
            />
          ) : (
            <Skeleton className="h-[320px] w-full" />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
