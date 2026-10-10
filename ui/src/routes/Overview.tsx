import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowDownRight, ArrowUpRight, Boxes, CalendarDays, Layers3, Sparkles, TrendingUp } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Chart, InsightChart } from "@/components/Chart";
import { CountUp, cssVar, escapeHtml, RadialGauge, Sparkline } from "@/components/premium";
import { RegionSpend } from "@/components/RegionSpend";
import { orderCurrencyViews } from "@/components/RegionSpendModel";
import { ErrorState, PageHeader, Segmented } from "@/components/blocks";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatMoney, formatMonth, formatNumber, type NumberSystem } from "@/lib/format";
import { isDark, usePrefs } from "@/lib/prefs";
import { chipOn, PALETTE } from "@/lib/palette";
import { formatRange, periodParam, validRange } from "@/lib/period";
import { executiveQuery, subscriptionsQuery, type ExecutiveView, type Ranked } from "@/lib/queries";

/** A mixed-currency estate has no honest single total, so the page shows one currency at a time. */
function useCurrencyViews(views: ExecutiveView[]) {
  const [picked, setPicked] = useState<string | null>(null);
  const ordered = useMemo(() => orderCurrencyViews(views), [views]);
  const view = ordered.find((v) => v.currency === picked) ?? ordered[0];
  return { view, ordered, setPicked };
}

type Money = (v: number | null | undefined, compact?: boolean) => string;

function useChartColors() {
  const { theme } = usePrefs();
  return useMemo(() => {
    const dark = isDark();
    return {
      dark,
      accent: cssVar("--cl-accent", "#4f46e5"),
      good: cssVar("--cl-good", "#047857"),
      bad: cssVar("--cl-bad", "#b91c1c"),
      muted: cssVar("--cl-muted", "#56627a"),
      surface: cssVar("--cl-surface", "#ffffff"),
      surface2: cssVar("--cl-surface-2", "#f1f3f9"),
      fg: cssVar("--cl-fg", "#0f172a"),
      border: cssVar("--cl-border", "#e3e6ef"),
    };
    // theme is the trigger to re-read CSS variables.
  }, [theme]);
}
type Colors = ReturnType<typeof useChartColors>;

function changeClass(pct: number | null | undefined) {
  return (pct ?? 0) > 0 ? "text-bad" : (pct ?? 0) < 0 ? "text-good" : "text-muted";
}

function signedPct(pct: number | null | undefined) {
  return pct == null || !Number.isFinite(pct) ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function RankedBars({ rows, money, onPick, empty = "Nothing to show for this period." }: { rows: Ranked[]; money: Money; onPick?: (row: Ranked) => void; empty?: string }) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted">{empty}</p>;
  const max = Math.max(...rows.map((r) => Math.abs(r.cost)), 1);
  return (
    <ul className="space-y-1">
      {rows.map((r, i) => (
        <li key={r.id ?? r.name}>
          <button
            type="button"
            disabled={!onPick}
            onClick={() => onPick?.(r)}
            className={cn("group block w-full rounded-lg px-2 py-1.5 text-left", onPick && "hover:bg-surface-2")}
          >
            <div className="flex items-center gap-2.5 text-sm">
              <span
                className="num grid size-5 shrink-0 place-items-center rounded-md text-[10px] font-semibold"
                style={chipOn(PALETTE[i % PALETTE.length]!)}
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate" title={r.name}>
                {r.name}
              </span>
              <span className="num shrink-0 font-medium">{money(r.cost)}</span>
              <span className={cn("num w-14 shrink-0 text-right text-xs", changeClass(r.change_pct))}>{signedPct(r.change_pct)}</span>
            </div>
            <div className="ml-7.5 mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-700"
                style={{
                  width: `${(Math.abs(r.cost) / max) * 100}%`,
                  background: r.cost < 0 ? "var(--cl-good)" : `linear-gradient(90deg, ${PALETTE[i % PALETTE.length]}, color-mix(in srgb, ${PALETTE[i % PALETTE.length]} 45%, transparent))`,
                }}
              />
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function trendOption(view: ExecutiveView, money: Money, c: Colors, style: "area" | "bars") {
  const values = view.trend.values;
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  const avg = finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null;
  const hex = (alpha: number) => `${c.accent}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
  return {
    grid: { left: 8, right: 16, top: 36, bottom: 44, containLabel: true },
    legend: { top: 0, right: 0, itemWidth: 14, itemHeight: 8, textStyle: { fontSize: 11 } },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => money(v), axisPointer: { type: style === "bars" ? "shadow" : "line", lineStyle: { color: c.accent, type: "dashed" } } },
    xAxis: {
      type: "category",
      data: view.trend.labels,
      boundaryGap: style === "bars",
      axisLabel: { formatter: (d: string) => d.slice(5), fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => money(v), fontSize: 11 }, splitLine: { lineStyle: { type: "dashed" } } },
    dataZoom: [{ type: "slider", height: 16, bottom: 4, borderColor: "transparent", fillerColor: hex(0.12), handleSize: 14, showDetail: false, brushSelect: false, dataBackground: { lineStyle: { color: hex(0.5) }, areaStyle: { color: hex(0.15) } } }],
    series: [
      style === "area"
        ? {
            name: "This period",
            type: "line",
            data: values,
            smooth: 0.35,
            symbol: "circle",
            symbolSize: 6,
            showSymbol: false,
            lineStyle: { width: 3, color: c.accent, shadowBlur: 12, shadowColor: hex(0.45), shadowOffsetY: 6 },
            itemStyle: { color: c.accent },
            areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: hex(0.35) }, { offset: 1, color: hex(0) }] } },
            markPoint: {
              symbol: "pin",
              symbolSize: 44,
              itemStyle: { color: c.accent },
              label: { fontSize: 9, color: "#fff", formatter: (p: { value: number }) => money(p.value) },
              data: [{ type: "max", name: "Peak" }],
            },
            markLine: avg == null ? undefined : {
              symbol: "none",
              lineStyle: { color: c.muted, type: "dotted", width: 1.5 },
              label: { position: "insideEndTop", color: c.muted, fontSize: 10, formatter: () => `avg ${money(avg)}` },
              data: [{ yAxis: avg }],
            },
          }
        : {
            name: "This period",
            type: "bar",
            data: values.map((v) => ({ value: v, itemStyle: { color: v != null && avg != null && v > avg * 1.5 ? c.bad : c.accent, borderRadius: [2, 2, 0, 0] } })),
            barMaxWidth: 18,
            markLine: avg == null ? undefined : {
              symbol: "none",
              lineStyle: { color: c.muted, type: "dotted", width: 1.5 },
              label: { position: "insideEndTop", color: c.muted, fontSize: 10, formatter: () => `avg ${money(avg)}` },
              data: [{ yAxis: avg }],
            },
          },
      {
        name: "Previous period",
        type: "line",
        data: view.trend.previous,
        smooth: 0.35,
        symbol: "none",
        lineStyle: { width: 1.5, type: "dashed", color: "#94a3b8" },
        itemStyle: { color: "#94a3b8" },
      },
    ],
  };
}

function areaOption(view: ExecutiveView, money: Money, c: Colors) {
  const signed = view.areas.some((area) => area.cost < 0);
  if (signed) {
    return {
      grid: { left: 8, right: 16, top: 8, bottom: 8, containLabel: true },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => money(v) },
      xAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => money(v) } },
      yAxis: { type: "category", inverse: true, data: view.areas.map((a) => a.label ?? a.name), axisLabel: { width: 95, overflow: "truncate", fontSize: 10 } },
      series: [{ type: "bar", barMaxWidth: 16, itemStyle: { borderRadius: 2 }, data: view.areas.map((a) => a.cost) }],
    };
  }
  return {
    tooltip: { trigger: "item", valueFormatter: (v: number) => money(v) },
    series: [
      {
        type: "pie",
        radius: ["62%", "86%"],
        padAngle: 2,
        itemStyle: { borderRadius: 2, borderColor: c.surface, borderWidth: 2 },
        label: { show: false },
        emphasis: { scale: true, scaleSize: 8, itemStyle: { shadowBlur: 20, shadowColor: "rgba(79,70,229,0.35)" } },
        animationType: "scale",
        animationEasing: "elasticOut",
        data: view.areas.map((a) => ({ name: a.label ?? a.name, value: a.cost })),
      },
    ],
  };
}

/** Linear blend of two #rrggbb colours; canvas charts cannot use CSS color-mix(). */
function mixHex(from: string, to: string, t: number) {
  const parse = (hex: string) => {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? h.split("").map((ch) => ch + ch).join("") : h.slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const a = parse(from);
  const b = parse(to);
  if ([...a, ...b].some((n) => !Number.isFinite(n))) return to;
  return `#${a.map((v, i) => Math.round(v + (b[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
}
const TREND_NEUTRAL = "#6366f1";
const TREND_UP = "#e11d48";
const TREND_DOWN = "#059669";

/** Blends falling (emerald) through neutral (indigo) to rising (rose) so colour carries the period change. */
function changeColor(pct: number | null, c: Colors) {
  if (pct == null || !Number.isFinite(pct)) return c.dark ? "#3b4261" : "#94a3b8";
  const t = Math.max(-1, Math.min(1, pct / 25));
  return mixHex(TREND_NEUTRAL, t > 0 ? TREND_UP : TREND_DOWN, Math.abs(t) * 0.85 + 0.15);
}

function treemapOption(rows: Ranked[], money: Money, c: Colors) {
  const data = rows
    .filter((r) => Number.isFinite(r.cost) && r.cost > 0)
    .map((r) => ({
      name: r.name,
      value: r.cost,
      change: r.change_pct,
      share: r.share_pct,
      itemStyle: { color: changeColor(r.change_pct, c) },
    }));
  return {
    tooltip: {
      formatter: (p: { name: string; value: number; data: { change: number | null; share: number | null } }) =>
        `<div style="min-width:180px"><div style="font-weight:600;margin-bottom:4px">${escapeHtml(p.name)}</div>` +
        `<div style="display:flex;justify-content:space-between;gap:16px"><span>Spend</span><b>${escapeHtml(money(p.value))}</b></div>` +
        `<div style="display:flex;justify-content:space-between;gap:16px"><span>Share</span><span>${p.data.share == null ? "—" : p.data.share.toFixed(1) + "%"}</span></div>` +
        `<div style="display:flex;justify-content:space-between;gap:16px"><span>Change</span><span>${escapeHtml(signedPct(p.data.change))}</span></div></div>`,
    },
    series: [
      {
        type: "treemap",
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        width: "100%",
        height: "100%",
        top: 0,
        left: 0,
        squareRatio: 0.8,
        itemStyle: { borderColor: c.surface, borderWidth: 1, gapWidth: 1, borderRadius: 2 },
        label: {
          show: true,
          position: "insideTopLeft",
          padding: [8, 10],
          formatter: (p: { name: string; value: number; data: { change: number | null } }) => `{name|${p.name}}\n{value|${money(p.value)}}  {chg|${signedPct(p.data.change)}}`,
          rich: {
            name: { fontSize: 12, fontWeight: 600, color: "#fff", lineHeight: 18 },
            value: { fontSize: 15, fontWeight: 700, color: "#fff", lineHeight: 22 },
            chg: { fontSize: 11, color: "rgba(255,255,255,0.85)" },
          },
          overflow: "truncate",
        },
        upperLabel: { show: false },
        emphasis: { itemStyle: { shadowBlur: 18, shadowColor: "rgba(15,23,42,0.35)" } },
        data,
      },
    ],
  };
}

function moversOption(rows: Ranked[], money: Money, c: Colors) {
  const ranked = rows.filter((r) => r.delta != null && Number.isFinite(r.delta)).slice(0, 8);
  return {
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (ps: Array<{ dataIndex: number }>) => {
        const r = ranked[ps[0]?.dataIndex ?? 0];
        if (!r) return "";
        return `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(r.name)}</div>Change ${escapeHtml(money(r.delta))} (${escapeHtml(signedPct(r.change_pct))})<br/>Now ${escapeHtml(money(r.cost))}`;
      },
    },
    xAxis: { type: "value", axisLabel: { fontSize: 10, formatter: (v: number) => money(v) }, splitLine: { lineStyle: { type: "dashed" } } },
    yAxis: { type: "category", inverse: true, data: ranked.map((r) => r.name), axisLabel: { width: 110, overflow: "truncate", fontSize: 11 }, axisTick: { show: false }, axisLine: { show: false } },
    series: [
      {
        type: "bar",
        barMaxWidth: 16,
        data: ranked.map((r) => ({
          value: r.delta,
          itemStyle: { color: (r.delta ?? 0) > 0 ? c.bad : c.good, borderRadius: (r.delta ?? 0) > 0 ? [0, 2, 2, 0] : [2, 0, 0, 2] },
        })),
        label: { show: true, position: "right", fontSize: 10, color: c.muted, formatter: (p: { dataIndex: number }) => signedPct(ranked[p.dataIndex]?.change_pct) },
      },
    ],
  };
}

function calendarOption(view: ExecutiveView, money: Money, c: Colors) {
  const points = view.trend.labels
    .map((day, i) => [day, view.trend.values[i]] as const)
    .filter((p): p is readonly [string, number] => p[1] != null && Number.isFinite(p[1]));
  const values = points.map((p) => p[1]);
  const first = view.trend.labels[0]!;
  const last = view.trend.labels[view.trend.labels.length - 1]!;
  return {
    tooltip: { formatter: (p: { value: [string, number] }) => `${escapeHtml(p.value[0])}<br/><b>${escapeHtml(money(p.value[1]))}</b>` },
    visualMap: {
      show: false,
      min: Math.min(...values, 0),
      max: Math.max(...values, 1),
      inRange: { color: c.dark ? ["#1e2340", "#4338ca", "#818cf8", "#f472b6"] : ["#eef2ff", "#a5b4fc", "#6366f1", "#db2777"] },
    },
    calendar: {
      range: [first, last],
      orient: "vertical",
      top: 28,
      left: 8,
      right: 8,
      bottom: 8,
      cellSize: ["auto", "auto"],
      splitLine: { show: false },
      itemStyle: { borderWidth: 3, borderColor: c.surface, color: c.surface2 },
      dayLabel: { firstDay: 1, nameMap: ["S", "M", "T", "W", "T", "F", "S"], fontSize: 10, color: c.muted },
      monthLabel: { show: false },
      yearLabel: { show: false },
    },
    series: [{ type: "heatmap", coordinateSystem: "calendar", data: points, itemStyle: { borderRadius: 1 } }],
  };
}

function monthlyOption(view: ExecutiveView, money: Money, c: Colors) {
  const monthly = view.monthly!;
  return {
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    legend: { top: 0, type: "scroll", itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11 } },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: number) => money(v) },
    xAxis: { type: "category", data: monthly.months.map(formatMonth), axisTick: { show: false } },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => money(v), fontSize: 11 }, splitLine: { lineStyle: { type: "dashed" } } },
    series: monthly.areas.map((a, i) => ({
      name: a.label,
      type: "bar",
      stack: "total",
      barMaxWidth: 64,
      emphasis: { focus: "series" },
      itemStyle: { borderColor: c.surface, borderWidth: 1, borderRadius: i === monthly.areas.length - 1 ? [2, 2, 0, 0] : 0 },
      data: a.data,
    })),
  };
}

function StatTile({ icon, label, children, loading }: { icon: ReactNode; label: string; children: ReactNode; loading?: boolean }) {
  return (
    <Card className="h-full px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
        <span className="text-accent">{icon}</span>
        {label}
      </div>
      {loading ? (
        <>
          <Skeleton className="mt-2 h-5 w-24" />
          <Skeleton className="mt-1.5 h-3 w-20" />
        </>
      ) : (
        children
      )}
    </Card>
  );
}

function SummaryBar({ view, money, numbers, loading }: { view: ExecutiveView | undefined; money: Money; numbers: NumberSystem; loading: boolean }) {
  const peak = useMemo(() => {
    if (!view) return null;
    let best: { day: string; value: number } | null = null;
    view.trend.values.forEach((v, i) => {
      if (v != null && Number.isFinite(v) && (!best || v > best.value)) best = { day: view.trend.labels[i]!, value: v };
    });
    return best as { day: string; value: number } | null;
  }, [view]);
  const change = view?.kpis.change_pct;
  const up = (change ?? 0) > 0;
  const stats: Array<[string, string, string?]> = view
    ? [
        ["Daily average", money(view.kpis.daily_avg), "per billing day"],
        ["Peak day", peak ? money(peak.value) : "—", peak ? peak.day : undefined],
        ["Subscriptions", formatNumber(view.kpis.subscriptions, { system: numbers, digits: 0 }), "with spend"],
        ["Footprint", `${view.kpis.services ?? "—"} · ${view.kpis.regions ?? "—"}`, "services · regions"],
      ]
    : [];
  return (
    <section aria-label="Spend summary" className="rounded-card border border-border bg-surface px-3 py-2.5 shadow-card">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Total spend</p>
          {loading || !view ? (
            <Skeleton className="mt-1 h-7 w-36" />
          ) : (
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="num text-2xl font-semibold leading-tight tracking-tight">
                <CountUp value={view.kpis.total} format={(v) => money(v)} />
              </span>
              {change != null && Number.isFinite(change) && (
                <span className={cn("num inline-flex items-center gap-0.5 text-xs font-semibold", up ? "text-bad" : "text-good")}>
                  {up ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
                  {Math.abs(change).toFixed(1)}%
                </span>
              )}
              {view.kpis.previous != null && <span className="text-xs text-muted">vs {money(view.kpis.previous)} previous</span>}
            </div>
          )}
        </div>
        <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          {(stats.length ? stats : Array.from({ length: 4 }, () => ["", "", ""] as [string, string, string])).map(([label, value, hint], i) => (
            <div key={label || i} className="min-w-0 border-l border-border pl-3">
              {label ? (
                <>
                  <dt className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</dt>
                  <dd className="num truncate text-sm font-semibold">{value}</dd>
                  {hint && <p className="num truncate text-[10px] text-muted">{hint}</p>}
                </>
              ) : (
                <Skeleton className="h-9 w-full" />
              )}
            </div>
          ))}
        </dl>
        {view && view.trend.values.length > 1 && (
          <div className="hidden w-44 shrink-0 lg:block" aria-hidden="true">
            <Sparkline values={view.trend.values} stroke={TREND_NEUTRAL} height={36} highlightMax />
          </div>
        )}
      </div>
    </section>
  );
}

type Landscape = "services" | "resource_groups" | "subscriptions";

export function OverviewPage() {
  const search = useSearch({ from: "__root__" });
  const navigate = useNavigate();
  const { numbers } = usePrefs();
  const colors = useChartColors();
  const query = useQuery(executiveQuery(search));
  const subs = useQuery(subscriptionsQuery);
  const [trendStyle, setTrendStyle] = useState<"area" | "bars">("area");
  const [landscape, setLandscape] = useState<Landscape>("services");

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
  const money: Money = (v, compact = true) =>
    v == null || !Number.isFinite(v) ? "Unavailable" : formatMoney(v, currency, { system: numbers, compact });
  const period = search.month ? formatMonth(search.month) : validRange(search.from, search.to) ? formatRange(search.from, search.to!) : `Last ${view?.days ?? 30} days`;
  const scopeTo = (r: Ranked) => {
    const id = subIds.get(r.name);
    if (id) void navigate({ to: ".", search: { ...search, scope: id } });
  };

  const options = useMemo(() => {
    if (!view) return null;
    return {
      trend: trendOption(view, money, colors, trendStyle),
      area: areaOption(view, money, colors),
      landscape: treemapOption(view[landscape] ?? [], money, colors),
      movers: moversOption(view.movers, money, colors),
      calendar: view.trend.labels.length >= 7 ? calendarOption(view, money, colors) : null,
      monthly: view.monthly && view.monthly.months.length > 1 ? monthlyOption(view, money, colors) : null,
    };
    // money is derived from currency and numbers.
  }, [view, colors, trendStyle, landscape, currency, numbers]);

  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const topArea = view ? [...view.areas].sort((a, b) => b.cost - a.cost)[0] : undefined;
  const topMover = view?.movers.find((r) => r.delta != null);
  const landscapeRows = view?.[landscape] ?? [];
  const hiddenLandscape = landscapeRows.filter((r) => !(Number.isFinite(r.cost) && r.cost > 0)).length;

  return (
    <div className="min-w-0">
      <PageHeader
        title="Overview"
        subtitle={
          view ? (
            <>
              {period} · data to <span className="num">{view.as_of}</span>
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
      {query.data?.notice && <p className="mb-2 text-xs text-muted">{query.data.notice}</p>}

      <SummaryBar view={view} money={(v) => money(v)} numbers={numbers} loading={loading} />
      {view && ordered.length > 1 && <p className="mt-1 text-right text-[11px] text-muted">One currency at a time. Totals are never combined or converted.</p>}

      <div className="mt-3 grid grid-cols-1 gap-3 [&>*]:min-w-0 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile loading={loading} icon={<Boxes className="size-3.5" />} label="Resources billed">
          <div className="num mt-1 text-xl font-semibold leading-tight tracking-tight">
            <CountUp value={view?.kpis.resources} format={(v) => formatNumber(Math.round(v), { system: numbers, compact: true })} />
          </div>
          <p className="text-xs text-muted">{view ? `${view.kpis.services ?? "Unavailable"} services · ${view.kpis.regions ?? "Unavailable"} regions` : null}</p>
        </StatTile>
        <StatTile loading={loading} icon={<Layers3 className="size-3.5" />} label="Top-5 service concentration">
          <div className="mt-1 flex items-center gap-2">
            <RadialGauge pct={view?.kpis.top5_share_pct} size={36} />
            <div>
              <div className="num text-xl font-semibold leading-tight tracking-tight">{view?.kpis.top5_share_pct != null ? `${view.kpis.top5_share_pct.toFixed(1)}%` : "Unavailable"}</div>
              <p className="text-[11px] text-muted">of spend in the five largest services</p>
            </div>
          </div>
        </StatTile>
        <StatTile loading={loading} icon={<Sparkles className="size-3.5" />} label="Largest area">
          <div className="mt-1 truncate text-base font-semibold leading-tight tracking-tight">{topArea ? topArea.label ?? topArea.name : "Unavailable"}</div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
            <span className="num font-semibold text-fg">{money(topArea?.cost)}</span>
            {topArea?.share_pct != null && <span className="num rounded-full bg-accent/10 px-1.5 py-0.5 font-medium text-accent">{topArea.share_pct.toFixed(1)}%</span>}
            <span>of period spend</span>
          </div>
        </StatTile>
        <StatTile loading={loading} icon={<TrendingUp className="size-3.5" />} label="Biggest mover">
          <div className="mt-1 truncate text-base font-semibold leading-tight tracking-tight" title={topMover?.name}>{topMover?.name ?? "No movement"}</div>
          {topMover && (
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
              <span className={cn("num font-semibold", changeClass(topMover.delta))}>{(topMover.delta ?? 0) > 0 ? "+" : ""}{money(topMover.delta)}</span>
              <span className={cn("num", changeClass(topMover.change_pct))}>{signedPct(topMover.change_pct)}</span>
              <span>vs previous</span>
            </div>
          )}
        </StatTile>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="min-w-0 xl:col-span-2">
          <CardHeader
            title="Daily spend"
            subtitle="This period against the one before it · drag the handle to zoom"
            actions={<Segmented label="Daily spend style" value={trendStyle} onChange={setTrendStyle} options={[{ value: "area", label: "Area" }, { value: "bars", label: "Bars" }]} />}
          />
          <CardBody>
            {view && options && view.trend.labels.length ? (
              <>
                <div role="img" aria-label={`Daily spend in ${currency ?? "unspecified currency"}, this and previous period. Exact daily values are available below.`}><div aria-hidden="true"><Chart height={240} option={options.trend} /></div></div>
                {view.trend.partial_last && <p className="mt-2 text-xs text-muted">Latest day is partial; do not compare it with a complete billing day.</p>}
                <details className="mt-3 text-xs">
                  <summary className="w-fit cursor-pointer font-medium text-accent">View daily values</summary>
                  <div className="mt-2 max-h-64 overflow-auto" tabIndex={0} role="region" aria-label="Daily spend data">
                    <table className="w-full text-left"><caption className="py-2 text-left text-muted">Executive API · {currency ?? "currency unspecified"} · previous period aligned by day</caption><thead><tr><th scope="col" className="py-2">Date</th><th scope="col">Current</th><th scope="col">Previous</th></tr></thead><tbody>{view.trend.labels.map((day, i) => <tr key={day} className="border-t border-border"><th scope="row" className="py-2 font-normal">{day}{view.trend.partial_last && i === view.trend.labels.length - 1 ? " (partial)" : ""}</th><td className="num">{money(view.trend.values[i], false)}</td><td className="num">{money(view.trend.previous[i], false)}</td></tr>)}</tbody></table>
                  </div>
                </details>
              </>
            ) : loading ? (
              <Skeleton className="h-[240px] w-full" />
            ) : (
              <p className="py-12 text-center text-sm text-muted">No daily data in this period.</p>
            )}
          </CardBody>
        </Card>
        <Card className="min-w-0">
          <CardHeader title="Spend by area" subtitle="Where the money goes" />
          <CardBody>
            {view && options && view.areas.length ? (
              <>
                {view.areas.every((a) => Number.isFinite(a.cost)) && view.areas.some((a) => a.cost !== 0) ? (
                  <div className="relative" role="img" aria-label={`Spend by billing area in ${currency ?? "unspecified currency"}. Exact values are listed below.`}>
                    <div aria-hidden="true"><Chart height={150} option={options.area} /></div>
                    {!view.areas.some((a) => a.cost < 0) && (
                      <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                        <span className="text-[11px] text-muted">{view.areas.length} areas</span>
                        <span className="num text-lg font-semibold">{money(view.kpis.total)}</span>
                      </div>
                    )}
                  </div>
                ) : <p className="py-8 text-center text-xs text-muted">No complete, non-zero area costs to chart.</p>}
                {view.areas.some((a) => a.cost < 0) && <p className="mt-2 text-xs text-muted">Credits included. Signed bars replace the ring to preserve net spend.</p>}
                <ul className="mt-2 space-y-1 text-xs">
                  {view.areas.map((a, i) => (
                    <li key={a.id ?? a.name} className="flex items-center gap-2">
                      <span className="size-2 shrink-0 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
                      <span className="min-w-0 flex-1 break-words">{a.label ?? a.name}</span>
                      <span className="num text-xs text-muted">{a.share_pct == null ? "—" : `${a.share_pct.toFixed(1)}%`}</span>
                      <span className="num w-20 text-right font-medium">{money(a.cost)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : loading ? (
              <Skeleton className="h-[220px] w-full" />
            ) : (
              <p className="py-12 text-center text-sm text-muted">No area data in this period.</p>
            )}
          </CardBody>
        </Card>
      </div>

      {view ? <RegionSpend key={`${currency}-${periodParam(search) ?? ""}-${search.scope ?? ""}`} rows={view.regions ?? []} currency={currency} /> : loading ? <Skeleton className="mt-3 h-[380px] w-full" /> : null}

      <div className="mt-3 grid grid-cols-1 gap-3 [&>*]:min-w-0 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Spend landscape"
            subtitle="Tile size is spend · colour is change against the previous period"
            actions={
              <Segmented
                label="Spend landscape grouping"
                value={landscape}
                onChange={setLandscape}
                options={[{ value: "services", label: "Services" }, { value: "resource_groups", label: "Resource groups" }, { value: "subscriptions", label: "Subscriptions" }]}
              />
            }
          />
          <CardBody>
            {view && options ? (
              landscapeRows.some((r) => r.cost > 0) ? (
                <>
                  <div role="img" aria-label={`Treemap of the largest ${landscape.replace("_", " ")} by spend, coloured by period change. Exact values are listed in the ranked cards.`}>
                    <div aria-hidden="true"><InsightChart height={240} option={options.landscape} onClick={landscape === "subscriptions" ? (p) => scopeTo({ name: p.name } as Ranked) : undefined} /></div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
                    <div className="flex items-center gap-2">
                      <span>Falling</span>
                      <span className="h-2 w-28 rounded-full" style={{ background: `linear-gradient(90deg, ${TREND_DOWN}, ${TREND_NEUTRAL}, ${TREND_UP})` }} aria-hidden="true" />
                      <span>Rising</span>
                    </div>
                    <span>{landscape === "subscriptions" ? "Click a tile to scope the dashboard · " : ""}{hiddenLandscape ? `${hiddenLandscape} credit or zero rows not drawn` : `Top ${landscapeRows.length} shown`}</span>
                  </div>
                </>
              ) : (
                <p className="py-12 text-center text-sm text-muted">No positive spend to map for this grouping.</p>
              )
            ) : (
              <Skeleton className="h-[240px] w-full" />
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Biggest movers" subtitle="Largest change against the previous period" />
          <CardBody>
            {view && options ? (
              view.movers.some((r) => r.delta != null) ? (
                <div role="img" aria-label="Largest period-over-period changes. Increases in red, decreases in green.">
                  <div aria-hidden="true"><Chart height={240} option={options.movers} /></div>
                </div>
              ) : (
                <RankedBars rows={view.movers} money={money} />
              )
            ) : (
              <Skeleton className="h-40" />
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 [&>*]:min-w-0 lg:grid-cols-3">
        <Card>
          <CardHeader title="Top services" />
          <CardBody>{view ? <RankedBars rows={view.services} money={money} /> : <Skeleton className="h-40" />}</CardBody>
        </Card>
        <Card>
          <CardHeader title="Top subscriptions" subtitle="Click to scope the dashboard" />
          <CardBody>{view ? <RankedBars rows={view.subscriptions} money={money} onPick={scopeTo} /> : <Skeleton className="h-40" />}</CardBody>
        </Card>
        <Card>
          <CardHeader title={<span className="inline-flex items-center gap-2"><CalendarDays className="size-4 text-accent" aria-hidden="true" />Daily intensity</span>} subtitle="Each day shaded by spend" />
          <CardBody>
            {options?.calendar ? (
              <div role="img" aria-label="Calendar heatmap of daily spend. Exact daily values are in the Daily spend card.">
                <div aria-hidden="true"><InsightChart height={220} option={options.calendar} /></div>
              </div>
            ) : view ? (
              <p className="py-12 text-center text-sm text-muted">Needs at least a week of daily data.</p>
            ) : (
              <Skeleton className="h-40" />
            )}
          </CardBody>
        </Card>
      </div>

      {view?.monthly && options?.monthly && (
        <Card className="mt-3 min-w-0">
          <CardHeader title="Monthly spend by area" subtitle={`Calendar months in the warehouse · ${view.monthly.currency}`} />
          <CardBody>
            <Chart height={240} option={options.monthly} />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
