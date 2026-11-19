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
import { uptimeQuery, windowDays, type UptimeMeter, type UptimeReport } from "@/lib/queries";

type Focus = "" | "always" | "schedulable";
type SavingMode = "window" | "annualized";
type Schedule = "business" | "weekdays" | "weekend" | "custom";

interface UptimeProjected extends UptimeMeter {
  observed_weekly_hours: number | null;
  scheduled_weekly_hours: number | null;
  annual_current_cost: number | null;
  annual_scheduled_cost: number | null;
  annual_saving: number | null;
  window_saving: number | null;
}

const FOCUS: Array<{ value: Focus; label: string }> = [
  { value: "", label: "All" },
  { value: "always", label: "Always on" },
  { value: "schedulable", label: "Schedulable" },
];

const SCHEDULE_HOURS: Record<Exclude<Schedule, "custom">, number> = {
  business: 50,
  weekdays: 120,
  weekend: 48,
};

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

function toWeeklyObserved(r: UptimeMeter): number | null {
  if (r.uptime_pct != null && Number.isFinite(r.uptime_pct)) return Math.max(0, Math.min(168, (r.uptime_pct / 100) * 168));
  if (r.hours > 0 && r.span_days > 0) return Math.max(0, Math.min(168, (r.hours / r.span_days) * 7));
  return null;
}

function toAnnualCurrentCost(r: UptimeMeter, observedWeeklyHours: number | null): number | null {
  if (r.cost > 0 && r.span_days > 0) return (r.cost * 365) / r.span_days;
  if (r.rate > 0 && observedWeeklyHours != null) return r.rate * observedWeeklyHours * 52;
  return null;
}

function sum(rows: UptimeProjected[], pick: (r: UptimeProjected) => number | null): number | null {
  const values = rows.map(pick).filter((v): v is number => v != null && Number.isFinite(v));
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0);
}

export function UptimePage() {
  const search = useSearch({ from: "__root__" });
  const { numbers } = usePrefs();
  const days = windowDays(search);
  const [focus, setFocus] = useState<Focus>("");
  const [text, setText] = useState("");
  const [schedule, setSchedule] = useState<Schedule>("business");
  const [customHours, setCustomHours] = useState("60");
  const [savingMode, setSavingMode] = useState<SavingMode>("annualized");
  const q = useDeferredValue(text.trim().toLowerCase());
  const query = useQuery(uptimeQuery(search, days));
  const data = query.data;
  const parsed = Number.parseInt(customHours, 10);
  const targetWeeklyHours = schedule === "custom"
    ? (Number.isFinite(parsed) ? Math.max(0, Math.min(168, parsed)) : 60)
    : SCHEDULE_HOURS[schedule];
  const modeLabel = savingMode === "annualized" ? "Annualized saving" : "Possible saving";

  const money = (v: number | null | undefined) => formatMoney(v, data?.currency ?? null, { system: numbers, compact: true });
  const projected = useMemo(() => {
    if (!data) return [];
    return data.resources.map((r): UptimeProjected => {
      const observedWeeklyHours = toWeeklyObserved(r);
      const scheduledWeeklyHours = observedWeeklyHours == null ? null : Math.min(observedWeeklyHours, targetWeeklyHours);
      const annualCurrent = toAnnualCurrentCost(r, observedWeeklyHours);
      const annualScheduled = annualCurrent == null || observedWeeklyHours == null || observedWeeklyHours <= 0 || scheduledWeeklyHours == null
        ? annualCurrent
        : annualCurrent * (scheduledWeeklyHours / observedWeeklyHours);
      const annualSaving = annualCurrent == null || annualScheduled == null ? null : Math.max(0, annualCurrent - annualScheduled);
      const windowSaving = annualSaving == null ? null : annualSaving * (r.span_days > 0 ? (r.span_days / 365) : (days / 365));
      return {
        ...r,
        observed_weekly_hours: observedWeeklyHours,
        scheduled_weekly_hours: scheduledWeeklyHours,
        annual_current_cost: annualCurrent,
        annual_scheduled_cost: annualScheduled,
        annual_saving: annualSaving,
        window_saving: windowSaving,
      };
    });
  }, [data, targetWeeklyHours, days]);

  const meters = useMemo(() => {
    return projected.filter(
      (r) =>
        (focus === "" || (focus === "always" ? r.always_on : r.schedulable)) &&
        (!q || `${r.name} ${r.meter ?? ""} ${r.resource_group ?? ""} ${r.subscription ?? ""} ${r.service ?? ""}`.toLowerCase().includes(q)),
    );
  }, [projected, focus, q]);

  const totalAnnualSaving = sum(meters, (r) => r.annual_saving);
  const totalWindowSaving = sum(meters, (r) => r.window_saving);
  const totalAnnualCurrent = sum(meters, (r) => r.annual_current_cost);
  const totalAnnualScheduled = sum(meters, (r) => r.annual_scheduled_cost);

  const columns = useMemo(() => {
    const h = columnHelper<UptimeProjected>();
    const fmt = (v: number) => formatNumber(v, { system: numbers, digits: 0 });
    const costCell = (v: number | null | undefined) => (v == null ? "Unavailable" : formatMoney(v, data?.currency ?? null, { system: numbers }));
    const savingCell = (r: UptimeProjected) => costCell(savingMode === "annualized" ? r.annual_saving : r.window_saving);
    return [
      h.accessor("name", {
        header: "Resource / meter",
        cell: (c) => (
          <div className="flex min-w-0 items-baseline gap-2" title={c.row.original.id}>
            <div className="min-w-0 shrink truncate font-medium">{c.getValue()}</div>
            <div className="min-w-0 shrink-[2] truncate text-xs text-muted">{c.row.original.meter ?? c.row.original.service ?? "—"}</div>
          </div>
        ),
        meta: { width: "minmax(260px, 2.4fr)" },
      }),
      h.accessor((r) => r.resource_group ?? "", {
        id: "resource_group",
        header: "Group / region",
        cell: (c) => (
          <div className="flex min-w-0 items-baseline gap-2">
            <div className="min-w-0 shrink truncate">{c.row.original.resource_group ?? "—"}</div>
            <div className="min-w-0 shrink-[2] truncate text-xs text-muted">{c.row.original.region ?? "—"}</div>
          </div>
        ),
        meta: { width: "minmax(170px, 1.3fr)" },
      }),
      h.accessor("hours", { header: "Hours", cell: (c) => fmt(c.getValue()), meta: { align: "right", width: "minmax(90px, 0.6fr)" } }),
      h.accessor("rate", {
        header: "Rate / hour",
        cell: (c) => formatMoney(c.getValue(), data?.currency ?? null, { system: numbers }),
        meta: { align: "right", width: "minmax(100px, 0.7fr)" },
      }),
      h.accessor("cost", {
        header: `Cost / ${days}d`,
        cell: (c) => formatMoney(c.getValue(), data?.currency ?? null, { system: numbers }),
        meta: { align: "right", width: "minmax(110px, 0.8fr)" },
      }),
      h.accessor((r) => r.observed_weekly_hours ?? -1, {
        id: "observed_weekly_hours",
        header: "Observed h/week",
        cell: (c) => (c.row.original.observed_weekly_hours == null ? "—" : fmt(c.row.original.observed_weekly_hours)),
        meta: { align: "right", width: "minmax(100px, 0.8fr)" },
      }),
      h.accessor((r) => r.scheduled_weekly_hours ?? -1, {
        id: "scheduled_weekly_hours",
        header: "Scheduled h/week",
        cell: (c) => (c.row.original.scheduled_weekly_hours == null ? "—" : fmt(c.row.original.scheduled_weekly_hours)),
        meta: { align: "right", width: "minmax(105px, 0.8fr)" },
      }),
      h.accessor((r) => (savingMode === "annualized" ? r.annual_saving : r.window_saving) ?? -1, {
        id: "saving",
        header: savingMode === "annualized" ? "Annualized saving" : `Possible saving / ${days}d`,
        cell: (c) => savingCell(c.row.original),
        meta: { align: "right", width: "minmax(130px, 0.9fr)" },
      }),
      h.accessor((r) => (r.always_on ? 2 : r.schedulable ? 1 : 0), {
        id: "pattern",
        header: "Pattern",
        cell: (c) => {
          const r = c.row.original;
          const label = r.always_on ? "Always on" : r.schedulable ? "Schedulable" : "—";
          return <span className={cn("text-xs font-medium", r.always_on && "text-warn", r.schedulable && "text-accent", !r.always_on && !r.schedulable && "text-muted")}>{label}</span>;
        },
        meta: { width: "minmax(100px, 0.7fr)" },
      }),
    ];
  }, [numbers, data?.currency, savingMode, days]);

  if (query.isError && !data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const t = data?.totals;
  return (
    <div>
      <PageHeader
        title="Hourly Billing"
        subtitle={
          data ? (
            <>
              Hour-meter billing quantities with direct schedule shutdown simulation · {data.days}-day window
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

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile label="Run schedule target" value={`${formatNumber(targetWeeklyHours, { system: numbers, digits: 0 })} h/week`} />
        <KpiTile label="Current cost / year" value={money(totalAnnualCurrent)} index={1} />
        <KpiTile label="Scheduled cost / year" value={money(totalAnnualScheduled)} index={2} />
        <KpiTile label={modeLabel} value={money(savingMode === "annualized" ? totalAnnualSaving : totalWindowSaving)} hint={savingMode === "window" ? `For this ${days}-day window` : "Projected from observed billed hours"} index={3} />
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Hourly billing resources"
          subtitle={data ? `${formatNumber(meters.length, { system: numbers, digits: 0 })} shown` : undefined}
          actions={
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-0 max-w-full flex-col gap-1">
                <span className="text-xs text-muted">Usage pattern</span>
                <Segmented label="Usage pattern" value={focus} onChange={(v) => setFocus(v as Focus)} options={FOCUS} />
              </div>
              <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-muted">
                Run schedule
                <select value={schedule} onChange={(e) => setSchedule(e.target.value as Schedule)} className="h-9 min-w-0 max-w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg">
                  <option value="business">Business hours only (Mon–Fri daytime)</option>
                  <option value="weekdays">Weekdays only (24x5)</option>
                  <option value="weekend">Weekends only (24x2)</option>
                  <option value="custom">Custom run hours / week</option>
                </select>
              </label>
              {schedule === "custom" && (
                <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-muted">
                  Weekly run hours
                  <input
                    type="number"
                    min={0}
                    max={168}
                    value={customHours}
                    onChange={(e) => setCustomHours(e.target.value)}
                    className="h-9 w-32 rounded-lg border border-border bg-surface px-3 text-sm text-fg"
                    aria-label="Weekly run hours"
                  />
                </label>
              )}
              <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-muted">
                Saving mode
                <select value={savingMode} onChange={(e) => setSavingMode(e.target.value as SavingMode)} className="h-9 min-w-0 max-w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg">
                  <option value="window">Possible saving</option>
                  <option value="annualized">Annualized saving</option>
                </select>
              </label>
              <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-muted">
                Search
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
                  <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Search resource, meter, group…"
                    aria-label="Search meters"
                    maxLength={200}
                    className="h-9 w-72 rounded-lg border border-border bg-surface pl-8 pr-3 text-sm outline-none focus:border-accent/60"
                  />
                </div>
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
              initialSort={{ id: "saving", desc: true }}
              height={560}
              empty="No hourly resources match these filters."
            />
          ) : (
            <Skeleton className="h-[560px] w-full" />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
