import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { Chart } from "@/components/Chart";
import { columnHelper, DataTable } from "@/components/DataTable";
import { ErrorState, KpiTile, PageHeader, Segmented } from "@/components/blocks";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatMoney, formatNumber } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { uptimeQuery, type UptimeMeter, type UptimeReport } from "@/lib/queries";

const WINDOWS = [
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days" },
];
type Focus = "" | "always" | "schedulable";
const FOCUS: Array<{ value: Focus; label: string }> = [
  { value: "", label: "All" },
  { value: "always", label: "Always on" },
  { value: "schedulable", label: "Schedulable" },
];

function trendOption(d: UptimeReport) {
  return {
    grid: { left: 8, right: 8, top: 24, bottom: 8, containLabel: true },
    legend: { top: 0, textStyle: { fontSize: 12 } },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: d.trend.labels, axisLabel: { hideOverlap: true } },
    yAxis: [
      { type: "value", name: "Hours", axisLabel: { formatter: (v: number) => formatNumber(v, { compact: true }) } },
      { type: "value", name: "Cost", splitLine: { show: false }, axisLabel: { formatter: (v: number) => formatNumber(v, { compact: true }) } },
    ],
    series: [
      { type: "bar", name: "Meter hours", data: d.trend.hours, barMaxWidth: 18 },
      { type: "line", name: "Cost", yAxisIndex: 1, showSymbol: false, data: d.trend.cost },
    ],
  };
}

function weekdayOption(d: UptimeReport) {
  return {
    grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: { type: "category", data: d.weekday.map((w) => w.short) },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => formatNumber(v, { compact: true }) } },
    series: [{ type: "bar", name: "Average hours per day", data: d.weekday.map((w) => (w.days ? Math.round(w.hours / w.days) : 0)), barMaxWidth: 28 }],
  };
}

export function UptimePage() {
  const search = useSearch({ from: "__root__" });
  const { numbers } = usePrefs();
  const [days, setDays] = useState("30");
  const [focus, setFocus] = useState<Focus>("");
  const [text, setText] = useState("");
  const q = useDeferredValue(text.trim().toLowerCase());
  const query = useQuery(uptimeQuery(search, Number(days)));
  const data = query.data;
  const money = (v: number | null | undefined) => formatMoney(v, data?.currency ?? null, { system: numbers, compact: true });

  const meters = useMemo(() => {
    if (!data) return [];
    return data.resources.filter(
      (r) =>
        (focus === "" || (focus === "always" ? r.always_on : r.schedulable)) &&
        (!q || `${r.name} ${r.meter ?? ""} ${r.resource_group ?? ""} ${r.subscription ?? ""} ${r.service ?? ""}`.toLowerCase().includes(q)),
    );
  }, [data, focus, q]);

  const columns = useMemo(() => {
    const h = columnHelper<UptimeMeter>();
    const fmt = (v: number) => formatNumber(v, { system: numbers, digits: 0 });
    return [
      h.accessor("name", {
        header: "Resource / meter",
        cell: (c) => (
          <div className="min-w-0 leading-tight" title={c.row.original.id}>
            <div className="truncate font-medium">{c.getValue()}</div>
            <div className="truncate text-xs text-muted">{c.row.original.meter ?? c.row.original.service ?? "—"}</div>
          </div>
        ),
        meta: { width: "minmax(260px, 2.4fr)" },
      }),
      h.accessor((r) => r.resource_group ?? "", {
        id: "resource_group",
        header: "Group / region",
        cell: (c) => (
          <div className="min-w-0 leading-tight">
            <div className="truncate">{c.row.original.resource_group ?? "—"}</div>
            <div className="truncate text-xs text-muted">{c.row.original.region ?? "—"}</div>
          </div>
        ),
        meta: { width: "minmax(170px, 1.4fr)" },
      }),
      h.accessor("hours", { header: "Hours", cell: (c) => fmt(c.getValue()), meta: { align: "right", width: "minmax(90px, 0.6fr)" } }),
      h.accessor("rate", {
        header: "Rate / hour",
        cell: (c) => formatMoney(c.getValue(), data?.currency ?? null, { system: numbers }),
        meta: { align: "right", width: "minmax(110px, 0.7fr)" },
      }),
      h.accessor("cost", {
        header: "Cost",
        cell: (c) => formatMoney(c.getValue(), data?.currency ?? null, { system: numbers }),
        meta: { align: "right", width: "minmax(130px, 0.9fr)" },
      }),
      h.accessor((r) => r.uptime_pct ?? -1, {
        id: "uptime_pct",
        header: "Billed uptime",
        cell: (c) => (c.row.original.uptime_pct == null ? <span className="text-muted">—</span> : `${c.row.original.uptime_pct.toFixed(1)}%`),
        meta: { align: "right", width: "minmax(110px, 0.7fr)" },
      }),
      h.accessor((r) => (r.always_on ? 2 : r.schedulable ? 1 : 0), {
        id: "pattern",
        header: "Pattern",
        cell: (c) => {
          const r = c.row.original;
          const label = r.always_on ? "Always on" : r.schedulable ? "Schedulable" : "—";
          return <span className={cn("text-xs font-medium", r.always_on && "text-warn", r.schedulable && "text-accent", !r.always_on && !r.schedulable && "text-muted")}>{label}</span>;
        },
        meta: { width: "minmax(110px, 0.7fr)" },
      }),
    ];
  }, [numbers, data?.currency]);

  if (query.isError && !data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const t = data?.totals;
  return (
    <div>
      <PageHeader
        title="Hourly Billing"
        subtitle={
          data ? (
            <>
              Daily hour-meter billing quantities and derived rates, not monitored availability · {data.days}-day window
              {data.latest && (
                <>
                  {" "}· data through <span className="num">{data.latest}</span>
                </>
              )}
            </>
          ) : (
            <Skeleton className="h-4 w-80" />
          )
        }
        actions={<Segmented label="Window" value={days} onChange={setDays} options={WINDOWS} />}
      />

      {data?.tags_not_loaded && (
        <Card className="mb-4 border-warn/40 p-4 text-sm">The latest data load could not carry tags, so tag-based views may be incomplete.</Card>
      )}
      {data?.truncated && (
        <Card className="mb-4 border-warn/40 p-4 text-sm">
          Showing the {formatNumber(data.resources.length, { system: numbers, digits: 0 })} highest-cost meters. Totals cover these meters only.
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile index={0} loading={!data} label="Metered cost" value={money(t?.cost)} hint={t?.coverage_pct != null ? `${t.coverage_pct}% of total spend` : undefined} />
        <KpiTile index={1} loading={!data} label="Meter hours" value={formatNumber(t?.hours, { system: numbers, digits: 0 })} hint={`${formatNumber(t?.meters, { system: numbers, digits: 0 })} meters on ${formatNumber(t?.resources, { system: numbers, digits: 0 })} resources`} />
        <KpiTile index={2} loading={!data} label="Always on" value={money(t?.always_on_cost)} hint={`${formatNumber(t?.always_on, { system: numbers, digits: 0 })} meters billed every hour`} />
        <KpiTile index={3} loading={!data} label="Schedulable" value={money(t?.schedulable_cost)} hint={`${formatNumber(t?.schedulable, { system: numbers, digits: 0 })} meters with an on/off pattern`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Hours and cost by day" />
          <CardBody>{data ? <Chart height={260} option={trendOption(data)} /> : <Skeleton className="h-[260px] w-full" />}</CardBody>
        </Card>
        <Card>
          <CardHeader title="Average hours by weekday" />
          <CardBody>{data ? <Chart height={260} option={weekdayOption(data)} /> : <Skeleton className="h-[260px] w-full" />}</CardBody>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Meters"
          subtitle={data ? `${formatNumber(meters.length, { system: numbers, digits: 0 })} shown` : undefined}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Segmented label="Usage pattern" value={focus} onChange={setFocus} options={FOCUS} />
              <label className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Search resource, meter, group…"
                  aria-label="Search meters"
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
              data={meters}
              columns={columns}
              rowKey={(r) => r.key}
              initialSort={{ id: "cost", desc: true }}
              height={560}
              empty="No meters match these filters."
            />
          ) : (
            <Skeleton className="h-[560px] w-full" />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
