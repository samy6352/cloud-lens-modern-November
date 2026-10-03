import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { Chart } from "./Chart";
import { columnHelper, DataTable } from "./DataTable";
import type { RowData } from "@tanstack/react-table";
import { ErrorState } from "./blocks";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { api } from "@/lib/api";
import { usePrefs } from "@/lib/prefs";
import { csvCell, metricValue, nativeMoney, optimizeQuery, whatIfBody, type Amount, type Metric, type OptimizeScope, type WhatIfReport } from "@/lib/optimize-queries";

export function useOptimizeScope(): OptimizeScope {
  return useSearch({ strict: false }) as OptimizeScope;
}
export function OptimizeNotices({ notices }: { notices?: Array<string | undefined | null> }) {
  const list = notices?.filter((n): n is string => !!n) ?? [];
  return list.length ? <Card role="status" className="my-4 border-warn/30 p-4 text-sm"><ul className="space-y-2">{list.map((n, i) => <li key={i}>{n}</li>)}</ul></Card> : null;
}
export function OptimizeLoading({ label = "Loading evidence…" }: { label?: string }) {
  return <div aria-busy="true" role="status"><p className="mb-3 text-sm text-muted">{label}</p><Skeleton className="h-28 w-full" /><Skeleton className="mt-4 h-64 w-full" /></div>;
}
export function OptimizeQueryState({ query, children }: { query: UseQueryResult<unknown>; children: ReactNode }) {
  return <>{query.isError && <div className="mb-4"><ErrorState error={query.error} onRetry={() => void query.refetch()} />{query.data != null && <p role="status" className="mt-2 text-sm text-warn">Previously retrieved evidence below may be stale; the latest read is unavailable.</p>}</div>}{query.data ? children : query.isPending ? <OptimizeLoading /> : null}</>;
}
export function OptimizeAmounts({ amounts }: { amounts?: Amount[] }) {
  const { numbers } = usePrefs();
  return <span className="num">{amounts?.length ? amounts.map((a, i) => <span className="block" key={`${a.currency}-${i}`}>{nativeMoney(a.cost, a.currency, numbers)}</span>) : "Unavailable"}</span>;
}
export function OptimizeMetric({ metric, percent }: { metric?: Metric; percent?: boolean }) {
  return <span title={[metric?.source, metric?.aggregation, metric?.note].filter(Boolean).join(" · ")} className={metric?.status === "partial" ? "text-warn" : ""}>{metricValue(metric, percent)}</span>;
}
export function OptimizeSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return <label className="flex min-w-0 max-w-full flex-col gap-1 text-xs text-muted">{label}<select aria-label={label} value={value} onChange={e => onChange(e.target.value)} className="h-9 min-w-0 max-w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg">{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>;
}
export function OptimizeWindow({ days, onChange, evidence = false }: { days: number; onChange: (v: number) => void; evidence?: boolean }) {
  return <OptimizeSelect label={evidence ? "Evidence window" : "Source window"} value={String(days)} onChange={v => onChange(Number(v))} options={(evidence ? [1, 7, 14] : [14, 30, 60, 90, 365]).map(v => ({ value: String(v), label: v === 1 ? "Last 24 hours" : `Last ${v} days` }))} />;
}
export interface OptimizeColumn<T> { id: string; label: string; value: (row: T) => string | number | null | undefined; cell?: (row: T) => ReactNode; width?: string; numeric?: boolean }
export function OptimizeTable<T extends RowData>({ title, rows, columns, rowKey, empty = "No records returned for this selection.", onSelect, note }: {
  title: string; rows: T[]; columns: OptimizeColumn<T>[]; rowKey: (r: T, i: number) => string; empty?: string; onSelect?: (r: T) => void; note?: ReactNode;
}) {
  const [search, setSearch] = useState("");
  const filtered = rows.filter(r => !search || columns.some(c => String(c.value(r) ?? "").toLowerCase().includes(search.toLowerCase())));
  const h = columnHelper<T>();
  const defs = columns.map((c, i) => h.accessor(c.value, {
    id: c.id, header: c.label,
    cell: ctx => onSelect && i === 0
      ? <button type="button" onClick={() => onSelect(ctx.row.original)} className="font-medium text-accent hover:underline">{c.cell?.(ctx.row.original) ?? String(ctx.getValue() ?? "—")}</button>
      : c.cell?.(ctx.row.original) ?? String(ctx.getValue() ?? "—"),
    meta: { width: c.width ?? (i === 0 ? "minmax(230px,2fr)" : "minmax(130px,1fr)"), align: c.numeric ? "right" : "left" },
  }));
  function exportRows() {
    const csv = [columns.map(c => csvCell(c.label)).join(","), ...filtered.map(r => columns.map(c => {
      const rendered = c.cell?.(r);
      return csvCell(typeof rendered === "string" ? rendered : c.value(r));
    }).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`; a.click(); URL.revokeObjectURL(url);
  }
  return <Card className="mt-4"><CardHeader title={title} subtitle={`${filtered.length} of ${rows.length} records`} actions={<div className="flex flex-wrap gap-2"><input aria-label={`Search ${title}`} type="search" maxLength={200} value={search} onChange={e => setSearch(e.target.value)} placeholder="Search records…" className="h-9 w-48 rounded-lg border border-border bg-surface px-3 text-sm" /><Button variant="outline" onClick={exportRows} disabled={!filtered.length}>Export CSV</Button></div>} /><CardBody><DataTable data={filtered} columns={defs} rowKey={r => rowKey(r, rows.indexOf(r))} height={480} empty={empty} footer={note} /></CardBody></Card>;
}
export function OptimizeBars({ title, labels, values, currency }: { title: string; labels: string[]; values: Array<number | null>; currency?: string | null }) {
  const { numbers } = usePrefs();
  return <Card className="mt-4"><CardHeader title={title} subtitle={currency ? `Native currency · ${currency}` : "Counts, not a monetary total"} /><CardBody><Chart height={Math.max(220, Math.min(labels.length * 38 + 50, 420))} option={{
    tooltip: { trigger: "axis", valueFormatter: (v: number) => currency ? nativeMoney(v, currency, numbers) : String(v) },
    grid: { left: 8, right: 24, top: 12, bottom: 12, containLabel: true },
    xAxis: { type: "value" }, yAxis: { type: "category", data: labels, inverse: true, axisLabel: { width: 180, overflow: "truncate" } },
    series: [{ type: "bar", data: values, barMaxWidth: 22 }],
  }} /></CardBody></Card>;
}
export function OptimizeWhatIf({ resourceId, scope, days }: { resourceId: string; scope: OptimizeScope; days: number }) {
  const { numbers } = usePrefs();
  const [sku, setSku] = useState("");
  const [result, setResult] = useState<WhatIfReport>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), [resourceId, scope.scope, days]);
  async function run(target: string) {
    setError("");
    let body;
    try { body = whatIfBody(resourceId, target); } catch (e) { setError((e as Error).message); return; }
    controller.current?.abort(); const current = new AbortController(); controller.current = current; setBusy(true); setResult(undefined);
    try {
      const response = await api<WhatIfReport>("dashboard/whatif", { scope: scope.scope, days }, { method: "POST", signal: current.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!current.signal.aborted) setResult(response);
    } catch (e) { if (!current.signal.aborted) setError((e as Error).message); }
    finally { if (!current.signal.aborted) setBusy(false); }
  }
  const money = (v: number | null) => nativeMoney(v, result?.currency, numbers);
  return <Card className="mt-4 p-4"><h3 className="font-semibold">What if…</h3><p className="mt-1 text-sm text-muted">Read-only price simulation. No VM is resized, stopped or changed.</p><form onSubmit={e => { e.preventDefault(); void run(sku); }} className="mt-3 flex flex-wrap items-end gap-2"><label className="text-xs text-muted">Target VM size<input aria-label="Target VM size" value={sku} onChange={e => setSku(e.target.value)} placeholder="Standard_B2s" maxLength={110} className="ml-2 h-9 rounded-lg border border-border bg-surface px-3 text-sm text-fg" /></label><Button type="submit" disabled={busy || !sku.trim()}>Compare</Button><Button type="button" variant="outline" disabled={busy} onClick={() => void run("shutdown")}>Shut down instead</Button></form>{busy && <p role="status" className="mt-3 text-sm">Comparing…</p>}{error && <p role="alert" className="mt-3 text-sm text-bad">{error}</p>}{result && <div aria-live="polite" className="mt-4 text-sm"><dl className="grid gap-2 sm:grid-cols-2"><dt>Billed, last {result.days}d, annualised</dt><dd className="num">{money(result.billed.annual)}</dd><dt>{result.current_size || "Current size"} at today's retail rate</dt><dd className="num">{money(result.current_retail.annual)}</dd><dt>{result.target_size}</dt><dd className="num">{money(result.target.annual)}</dd></dl><p className="mt-3 font-medium">{result.annual_saving == null ? "Saving unavailable — pricing evidence is incomplete." : result.annual_saving > 0 ? `Saves about ${money(result.annual_saving)} a year` : result.annual_saving < 0 ? `Costs about ${money(-result.annual_saving)} a year more` : "No price change"}</p><p className="mt-2 text-muted">{result.note}</p></div>}</Card>;
}
export function OptimizePriorities({ scope, days }: { scope: OptimizeScope; days: number }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({ ...optimizeQuery<{ narrative?: string; note?: string; error?: string }>("recommendations", scope, { days }), enabled: open });
  return <details className="mt-4 rounded-xl border border-border bg-surface p-4" onToggle={e => setOpen(e.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">AI priorities · optional interpretation</summary>{open && <OptimizeQueryState query={query}><p className="mt-3 whitespace-pre-wrap text-sm">{query.data?.narrative || query.data?.note || query.data?.error || "No narrative returned."}</p></OptimizeQueryState>}</details>;
}
