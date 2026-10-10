import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ScopePicker } from "@/components/ScopePicker";
import { KpiTile, PageHeader } from "@/components/blocks";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { OptimizeAmounts, OptimizeBars, OptimizeMetric, OptimizeNotices, OptimizeQueryState, OptimizeSelect, OptimizeTable, OptimizeWindow, useOptimizeScope } from "@/components/OptimizeShared";
import { subscriptionsQuery } from "@/lib/queries";
import { metricValue, optimizeQuery, performanceScope, type OptimizeScope, type PerformanceReport, type PerformanceRow } from "@/lib/optimize-queries";

export function PerformancePage() {
  const scope = useOptimizeScope();
  return <PerformanceContent key={scope.scope ?? ""} scope={scope} />;
}
function PerformanceContent({ scope }: { scope: OptimizeScope }) {
  const [days, setDays] = useState(7);
  const [type, setType] = useState("");
  const [group, setGroup] = useState("");
  const [region, setRegion] = useState("");
  const [currency, setCurrency] = useState("");
  const [coverage, setCoverage] = useState("");
  const [cost, setCost] = useState("");
  const [selectedRow, setSelected] = useState<PerformanceRow>();
  const subs = useQuery(subscriptionsQuery);
  const accessible = (subs.data?.subscriptions ?? []).filter(s => s.azure_access !== false).map(s => s.id);
  const implicitScope = !scope.scope && accessible.length >= 1 && accessible.length <= 100 ? accessible.join(",") : undefined;
  const guard = performanceScope(scope.scope || implicitScope);
  const resolvingScope = !scope.scope && subs.isPending;
  const q = useQuery({ ...optimizeQuery<PerformanceReport>("performance", { scope: guard.ids.join(",") }, { window_days: days }), enabled: !guard.error });
  const d = q.data;
  const all = d?.resources ?? [];
  const selected = all.find(r => r.id === selectedRow?.id);
  const resourceGroup = (r: PerformanceRow) => r.id.match(/\/resourcegroups\/([^/]+)/i)?.[1] ?? "Not supplied";
  const measured = (r: PerformanceRow) => r.metrics.some(m => m.status === "ok" && m.value != null && Number.isFinite(m.value));
  const amounts = (r: PerformanceRow) => (r.cost?.by_currency ?? []).filter(a => !currency || a.currency === currency);
  const rows = all.filter(r => (!type || r.type === type) && (!group || resourceGroup(r) === group) && (!region || (r.region || "Not supplied") === region)
    && (!currency || amounts(r).length)
    && (!coverage || (coverage === "measured" ? measured(r) : coverage === "missing" ? !measured(r) : coverage === "partial" ? r.status === "partial" : r.metrics.some(m => m.status === "unavailable")))
    && (!cost || (cost === "present" ? amounts(r).some(a => a.cost != null) : cost === "missing" ? !amounts(r).some(a => a.cost != null) : cost === "positive" ? amounts(r).some(a => a.cost != null && a.cost > 0) : amounts(r).length > 0 && amounts(r).every(a => a.cost === 0))));
  const facet = (values: string[]) => [{ value: "", label: "All" }, ...[...new Set(values)].sort().map(v => ({ value: v, label: v }))];
  const clear = () => { setType(""); setGroup(""); setRegion(""); setCurrency(""); setCoverage(""); setCost(""); };
  const unavailable = d?.status === "unavailable";
  return <div><PageHeader title="Performance vs Spend" subtitle="Service-specific Azure Monitor observations alongside native-currency billed spend." actions={<><OptimizeWindow evidence days={days} onChange={v => { setDays(v); setSelected(undefined); }} /><Button variant="outline" disabled={!!guard.error || q.isFetching} onClick={() => void q.refetch()}>Refresh evidence</Button></>} />
    <Card className="mb-4 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-medium">Subscription scope</p><p className="mt-1 text-xs text-muted">Choose 1–100 accessible subscriptions; with no selection, all accessible subscriptions are used when there are 100 or fewer. The selection is saved in this page's URL.</p></div><ScopePicker /></div>{guard.error && !resolvingScope && <p role="alert" className="mt-3 text-sm text-warn">{guard.error}</p>}</Card>
    {!guard.error && <OptimizeQueryState query={q}>
      <OptimizeNotices notices={[unavailable ? "Performance evidence unavailable. Missing observations are not zero utilization or proof of idle resources." : null, d?.status === "partial" || d?.truncated ? "Partial coverage: this bounded sample does not describe the entire estate." : null, ...(d?.notices ?? [])]} />
      <div className="text-xs text-muted">{d?.window?.start} – {d?.window?.end} · Retrieved {d?.generated_at} · {d?.status}</div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3"><KpiTile label="Resources in filtered sample" value={rows.length} hint={`Of ${d?.sampled_count ?? all.length} sampled resources`} /><KpiTile label="With measured performance" value={rows.filter(measured).length} hint="Only valid numeric observations" index={1} /><KpiTile label="Without observations" value={rows.filter(r => !measured(r)).length} hint="Not classified as idle" index={2} /></div>
      <Card className="mt-4 p-4"><h3 className="mb-3 text-sm font-medium">Filter the loaded sample</h3><div className="flex flex-wrap items-end gap-3">
        <OptimizeSelect label="Resource type" value={type} onChange={setType} options={facet(all.map(r => r.type))} />
        <OptimizeSelect label="Resource group" value={group} onChange={setGroup} options={facet(all.map(resourceGroup))} />
        <OptimizeSelect label="Region" value={region} onChange={setRegion} options={facet(all.map(r => r.region || "Not supplied"))} />
        <OptimizeSelect label="Billing currency" value={currency} onChange={setCurrency} options={facet(all.flatMap(r => r.cost?.by_currency.map(a => a.currency) ?? []))} />
        <OptimizeSelect label="Metric coverage" value={coverage} onChange={setCoverage} options={[{ value: "", label: "All" }, { value: "measured", label: "With measurements" }, { value: "missing", label: "No measurements" }, { value: "partial", label: "Partial coverage" }, { value: "failed", label: "Denied / failed reads" }]} />
        <OptimizeSelect label="Cost evidence" value={cost} onChange={setCost} options={[{ value: "", label: "All" }, { value: "present", label: "With cost amounts" }, { value: "missing", label: "Missing cost amounts" }, { value: "positive", label: "Positive billed spend" }, { value: "zero", label: "Recorded zero cost" }]} />
        <Button variant="outline" onClick={clear} disabled={!type && !group && !region && !currency && !coverage && !cost}>Clear filters</Button>
      </div><p className="mt-3 text-xs text-muted" role="status">{rows.length} of {all.length} loaded resources. Local filters do not search beyond source or sample limits; a currency filter never converts or sums currencies.</p></Card>
      <OptimizeTable<PerformanceRow> title="Performance and billed spend" rows={rows} rowKey={r => r.id} onSelect={setSelected} columns={[
        { id: "name", label: "Resource / evidence", value: r => r.name, cell: r => <span title={r.id}>{r.name}</span> },
        { id: "type", label: "Type / region", value: r => `${r.type} · ${r.region || "Not supplied"}` },
        { id: "group", label: "Resource group", value: resourceGroup },
        { id: "cost", label: "Billed cost", value: r => amounts(r).map(a => `${a.currency} ${a.cost ?? "Unavailable"}`).join("; "), cell: r => r.cost?.by_currency?.length ? <OptimizeAmounts amounts={amounts(r)} /> : "No billing rows in window" },
        { id: "metrics", label: "Service-specific metrics", value: r => r.metrics.map(m => `${m.label || m.name}: ${metricValue(m)}`).join(" · "), width: "minmax(270px,2fr)" },
        { id: "coverage", label: "Coverage", value: r => r.status },
      ]} empty={all.length ? "No sampled resources match these filters." : unavailable || d?.status === "partial" ? "Performance evidence unavailable or incomplete. Missing observations are not zero." : "No resources supported by this release were returned in the selected subscriptions."} note="Select a resource for every metric, source, observation count and data gap. Hourly averages are not percentiles." />
      {!!rows.length && <OptimizeBars title="Observation coverage in loaded sample" labels={["Measured resources", "No measurements", "Partial resource coverage"]} values={[rows.filter(measured).length, rows.filter(r => !measured(r)).length, rows.filter(r => r.status === "partial").length]} />}
      {selected && <Card className="mt-4 p-5"><div className="flex flex-wrap justify-between gap-3"><h3 className="font-semibold">{selected.name} · evidence</h3><Button variant="ghost" onClick={() => setSelected(undefined)}>Close</Button></div><p className="mt-2 break-all text-xs text-muted">{selected.id}</p><p className="mt-2 text-sm">{selected.type} · {selected.region} · {selected.status}</p><OptimizeNotices notices={selected.notes} /><div className="mt-3 grid gap-3 md:grid-cols-2">{selected.metrics.map((m, i) => <section className="rounded-lg border border-border p-4" key={`${m.name}-${i}`}><h4 className="text-sm font-medium">{m.label || m.name}</h4><p className="num mt-2 text-xl font-semibold"><OptimizeMetric metric={m} /></p><p className="mt-2 text-xs text-muted">{m.aggregation || "No aggregation"} · {m.samples ?? 0} observations · latest {m.last_sample || "Unavailable"}</p><p className="mt-2 text-sm text-muted">{m.note}</p></section>)}</div><div className="mt-4 text-sm"><strong>Billed cost:</strong> <OptimizeAmounts amounts={selected.cost?.by_currency} /><p className="mt-1 text-xs text-muted">{selected.cost?.from} – {selected.cost?.to}. Missing billing rows are not a zero charge.</p></div><a className="mt-4 inline-block text-sm text-accent hover:underline" href={`https://portal.azure.com/#@/resource${encodeURI(selected.id)}`} target="_blank" rel="noreferrer">Open resource in Azure ↗</a></Card>}
      <details className="mt-4 rounded-xl border border-border p-4 text-sm"><summary className="cursor-pointer font-medium">Source, profiles & calculation details</summary><div className="mt-3 space-y-2 text-muted"><p>Source: {d?.source}. Live evidence uses its own {days}-day window, not the global billing month or display-currency filter. No currencies are combined.</p><p>Profiles: VMs expose CPU and network totals; web apps expose requests, response time and HTTP 5xx; App Service plans expose CPU and memory; SQL databases expose CPU and storage; storage accounts expose transactions, latency and availability. Metric definitions and units are checked live.</p><p>Resource sampling is deterministic and bounded to 24 supported ARM IDs, not top spend. Average values summarize returned hourly observations without filling missing hours with zero. Total metrics sum observed hourly totals only; they are not extrapolated. Nulls, unsupported metrics and denied reads remain distinct.</p><p>Inventory count: {d?.inventory_count ?? "Unavailable / bounded sample"}. Performance observations support manual review, not automatic resizing or guaranteed savings.</p></div></details>
    </OptimizeQueryState>}
  </div>;
}
