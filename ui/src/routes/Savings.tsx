import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader, KpiTile, Segmented } from "@/components/blocks";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { OptimizeBars, OptimizeNotices, OptimizePriorities, OptimizeQueryState, OptimizeSelect, OptimizeTable, OptimizeWhatIf, OptimizeWindow, useOptimizeScope } from "@/components/OptimizeShared";
import { api, toSearch } from "@/lib/api";
import { usePrefs } from "@/lib/prefs";
import { canSimulate, nativeBuckets, nativeMoney, optimizeQuery, type AdvisorReport, type AdvisorRow, type Opportunity, type OptimizeScope, type RightsizingReport, type SavingsReport, type ShutdownReport, type ShutdownRow, type VmRow, type WasteItem, type WasteReport } from "@/lib/optimize-queries";

type View = "overview" | "rightsizing" | "waste" | "advisor" | "shutdown";
const views: Array<{ value: View; label: string }> = [
  { value: "overview", label: "Overview" }, { value: "rightsizing", label: "Rightsizing" },
  { value: "waste", label: "Idle & orphaned" }, { value: "advisor", label: "Advisor" }, { value: "shutdown", label: "Scheduling" },
];

export function SavingsPage() {
  const scope = useOptimizeScope();
  return <SavingsContent key={`${scope.scope ?? ""}|${scope.currency ?? ""}`} scope={scope} />;
}
function SavingsContent({ scope }: { scope: OptimizeScope }) {
  const [view, setView] = useState<View>("overview");
  const [days, setDays] = useState(30);
  return <div><PageHeader title="Savings" subtitle="One reconciled opportunity list. Review evidence before acting; all actions here are read-only." actions={<OptimizeWindow days={days} onChange={setDays} />} /><div className="mb-4 overflow-x-auto"><Segmented label="Savings views" value={view} onChange={setView} options={views} /></div>
    {view === "overview" && <SavingsOverview key={days} scope={scope} days={days} />}
    {view === "rightsizing" && <Rightsizing key={days} scope={scope} days={days} />}
    {view === "waste" && <Waste key={days} scope={scope} days={days} />}
    {view === "advisor" && <Advisor scope={scope} />}
    {view === "shutdown" && <Shutdown key={days} scope={scope} days={days} />}
  </div>;
}
function SavingsOverview({ scope, days }: { scope: OptimizeScope; days: number }) {
  const client = useQueryClient();
  const { numbers } = usePrefs();
  const [category, setCategory] = useState("");
  const [text, setText] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const options = optimizeQuery<SavingsReport>("savings/progress", scope, { days });
  const query = useQuery({ ...options, refetchInterval: q => q.state.data?.scan?.status === "running" || q.state.data?.freshness?.refreshing ? 2000 : false });
  const d = query.data;
  const running = refreshing || d?.scan?.status === "running" || !!d?.freshness?.refreshing;
  async function refresh() {
    setRefreshing(true); setRefreshError("");
    try {
      await client.fetchQuery({ ...options, staleTime: 0, queryFn: ({ signal }) => api<SavingsReport>("dashboard/savings/progress", { scope: scope.scope, currency: scope.currency, days, refresh: true }, { signal }) });
    } catch (e) { setRefreshError((e as Error).message); }
    finally { setRefreshing(false); }
  }
  const money = (v: number | null | undefined, currency = d?.currency) => nativeMoney(v, currency, numbers);
  const opportunities = d?.opportunities ?? [];
  const shown = opportunities.filter(o => (!category || o.category === category) && (!text || `${o.title} ${o.resource} ${o.resource_group} ${o.category_label}`.toLowerCase().includes(text.toLowerCase())));
  const unpriced = opportunities.filter(o => o.window == null).length;
  const notices = [refreshError, d?.error, d?.note, ...Object.entries(d?.unavailable ?? {}).map(([s, e]) => `${s} unavailable: ${e}`),
    ...Object.entries(d?.scan?.errors ?? {}).map(([s, e]) => `${s} scan failed: ${e}`),
    d?.freshness?.stale ? "Cached results are stale; refresh the scan to request new evidence." : null,
    running ? "Provisional totals: findings are reconciled as sources finish. Counts and estimates may change." : null,
    unpriced ? `${unpriced} opportunities have no saving estimate. Totals include known estimates only; unavailable estimates are not zero.` : null,
    d?.mixed_currency ? "Currencies are not combined. Review native-currency amounts on each opportunity." : null];
  if (d?.partial && !running) notices.push("Incomplete assessment: review source failures, missing prices and coverage before estimating savings.");
  if (d?.unconverted?.length) notices.push(`${d.unconverted.length} source amounts could not be converted or priced and are excluded from estimates.`);
  if (d?.pricing_basis) notices.push(d.pricing_basis);
  return <><Card className="mb-4 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium" aria-live="polite">{running ? "Scanning for savings…" : d?.scan?.status === "error" ? "Scan unavailable or incomplete" : d ? "Savings scan results" : "Loading savings scan…"}</p><p className="mt-1 text-xs text-muted">{d?.freshness?.generated_at ? `Generated ${d.freshness.generated_at}` : "No completed scan yet"}{d?.scan?.completed?.length ? ` · Sources completed: ${d.scan.completed.join(", ")}` : ""}</p></div><Button variant="outline" disabled={running || query.isPending} onClick={() => void refresh()}>{running ? "Refreshing…" : "Refresh scan"}</Button></div></Card>
    <OptimizeQueryState query={query}><OptimizeNotices notices={notices} /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile label="Potential savings" value={money(d?.billed_total)} hint={`Billing-based estimate · ${days}d source window`} />
      <KpiTile label="Additional estimate" value={money(d?.projected_total)} hint="Projected by Advisor; not realised savings" index={1} />
      <KpiTile label="Opportunities" value={d?.count ?? opportunities.length} hint="Resource overlap reconciled" index={2} />
      <KpiTile label="Scans agree" value={d?.merged ?? 0} hint={`${d?.variants_folded ?? 0} duplicate estimates folded`} index={3} />
    </div>
    {!!d?.categories?.length && <OptimizeBars title="Where to focus" labels={d.categories.map(c => c.label)} values={d.categories.map(c => c.count)} />}
    <OptimizePriorities scope={scope} days={days} />
    <div className="my-4 flex flex-wrap items-end gap-3"><OptimizeSelect label="Opportunity category" value={category} onChange={setCategory} options={[{ value: "", label: "Everything" }, ...(d?.categories ?? []).map(c => ({ value: c.id, label: `${c.label} (${c.count})` }))]} /><label className="text-xs text-muted">Search opportunities<input type="search" aria-label="Search opportunities" maxLength={200} value={text} onChange={e => setText(e.target.value)} className="ml-2 h-9 rounded-lg border border-border bg-surface px-3 text-sm text-fg" /></label><span role="status" className="text-xs text-muted">{shown.length} of {opportunities.length} opportunities</span></div>
    {!shown.length && <Card className="p-6 text-sm text-muted">{running ? "Scanning — opportunities will appear as sources finish." : Object.keys(d?.unavailable ?? {}).length || Object.keys(d?.scan?.errors ?? {}).length || d?.scan?.status === "error" ? "Some sources could not be read. The result is incomplete, not evidence of no savings." : opportunities.length ? "No opportunities match these filters." : "No savings opportunities were found in this scope."}</Card>}
    <div className="space-y-3">{shown.map((o, i) => <OpportunityCard key={o.key ?? o.id ?? i} opportunity={o} currency={d?.currency} days={days} scope={scope} />)}</div>
    {!!d?.at_risk?.length && <section className="mt-6"><h3 className="font-semibold">Continuing spend at risk · not recoverable savings</h3><p className="my-3 text-sm text-muted">{d.at_risk_note} Known spend: {money(d.at_risk_total)} over {days} days.</p><div className="space-y-3">{d.at_risk.map((o, i) => <OpportunityCard key={o.key ?? i} opportunity={o} currency={d.currency} days={days} scope={scope} />)}</div></section>}
    {!!d?.commitment_count && <Card className="mt-4 p-5"><h3 className="font-semibold">Commitment options</h3><p className="mt-2 text-sm text-muted">{d.commitment_count} Advisor recommendations · {money(d.commitment_annual)} a year{d.commitment_unpriced_count ? " (known estimates only)" : ""}. {d.commitment_note}</p><a href={`/v2/optimize/commitments${toSearch({ scope: scope.scope, month: scope.month })}`} className="mt-3 inline-block text-sm font-medium text-accent hover:underline">Compare against pay-as-you-go →</a></Card>}
    <details className="mt-4 rounded-xl border border-border p-4 text-sm"><summary className="cursor-pointer font-medium">Sources & definitions</summary><p className="mt-2 text-muted">This reconciles Advisor, VM utilization, idle inventory and scheduling scans. Billing-based estimates describe costs in the source window; additional Advisor estimates are separate. Corroboration means independent scans agree, not guaranteed savings. Alternatives and repeated lookback windows are not additive. Retained-resource spend at risk is not a saving. Currency conversions and missing evidence must be reviewed before acting.</p></details>
    </OptimizeQueryState></>;
}
function OpportunityCard({ opportunity: o, currency, days, scope }: { opportunity: Opportunity; currency?: string | null; days: number; scope: OptimizeScope }) {
  const { numbers } = usePrefs();
  const money = (v: number | null | undefined) => nativeMoney(v, o.currency || currency, numbers);
  return <details className="rounded-xl border border-border bg-surface p-4"><summary className="cursor-pointer"><span className="inline-flex w-[95%] flex-wrap items-center justify-between gap-3 align-middle"><span><span className="block text-sm font-semibold">{o.title}</span><span className="mt-1 block text-xs text-muted">{o.category_label} · {o.count} item{o.count === 1 ? "" : "s"}{o.confidence ? ` · ${o.confidence} confidence` : ""}{o.corroborated ? ` · ${o.sources.length} scans agree` : ""}</span><span className="mt-1 block text-xs text-muted">{[o.resource, o.resource_group, o.region].filter(Boolean).join(" · ")}</span></span><span className="text-right"><span className="num block text-base font-semibold text-accent">{money(o.window)}</span><span className="block text-xs text-muted">over {days} days{o.impact_class && o.impact_class !== "potential_savings" ? ` · ${o.impact_class.replaceAll("_", " ")}` : ""}</span>{o.annual != null && <span className="num block text-xs text-muted">{money(o.annual)} a year</span>}</span></span></summary>
    <div className="mt-4 space-y-3 text-sm"><p>{o.why}</p>{o.disputed && <OptimizeNotices notices={[`Scans priced this differently: ${money(o.disputed.low)} versus ${money(o.disputed.high)}. The larger is shown, not an average.`]} />}<h4 className="font-medium">Evidence</h4><ul className="space-y-2">{o.sources.map((s, i) => <li className="rounded-lg bg-surface-2 p-3" key={i}><span className="font-medium">{s.label}</span><span className="ml-2 text-xs text-muted">{s.basis === "billed" ? "From the bill" : "Estimate"}</span><p className="mt-1 text-muted">{s.claim}</p></li>)}</ul>
      {!!o.folded && <p className="text-muted">{o.folded} repeated lookback estimates folded into this decision.</p>}
      {o.options.length > 1 && <div><h4 className="font-medium">Purchase alternatives · choose one, never add</h4>{o.options.map((x, i) => <p key={i} className="mt-2">{x.label}: <strong>{money(x.annual)} a year</strong> <span className="text-muted">{x.detail}</span></p>)}</div>}
      {o.action && <p><strong>What to do:</strong> {o.action}</p>}
      {o.resource_id && <a className="inline-block text-accent hover:underline" href={`https://portal.azure.com/#@/resource${encodeURI(o.resource_id)}`} target="_blank" rel="noreferrer">Open resource in Azure ↗</a>}
      {!!o.items?.length && <OptimizeTable title="Affected resources" rows={o.items} rowKey={(r, i) => r.id ?? `${r.name}-${i}`} columns={[{ id: "name", label: "Resource", value: r => r.name }, { id: "group", label: "Group", value: r => r.group }, { id: "region", label: "Region", value: r => r.region }, { id: "cost", label: "Cost", value: r => r.cost, cell: r => nativeMoney(r.cost, r.currency || o.currency || currency, numbers), numeric: true }]} note={o.more ? `And ${o.more} more resources.` : undefined} />}
      {o.category === "idle" && canSimulate(o.resource_id) && <OptimizeWhatIf resourceId={o.resource_id!} scope={scope} days={days} />}
    </div></details>;
}
function Rightsizing({ scope, days }: { scope: OptimizeScope; days: number }) {
  const q = useQuery(optimizeQuery<RightsizingReport>("rightsizing", scope, { days }));
  const d = q.data; const { numbers } = usePrefs();
  const [selected, setSelected] = useState<VmRow>();
  return <OptimizeQueryState query={q}><OptimizeNotices notices={[d?.error, d?.note, ...(d?.errors ?? []), d?.partial ? "Partial metrics or pricing coverage. Missing CPU is not zero." : null]} /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><KpiTile label="Virtual machines" value={d?.count} /><KpiTile label="Running" value={d?.running ?? "Unavailable"} index={1} /><KpiTile label={`Idle (under ${d?.cpu_threshold ?? 5}% CPU)`} value={d?.idle_count ?? "Unavailable"} index={2} /><KpiTile label="Cost of idle machines" value={nativeBuckets(d?.idle_cost_by_currency, d?.idle_cost, d?.currency, numbers)} hint={`Over ${d?.period_days ?? days} days`} index={3} /></div><p className="mt-4 text-sm text-muted">CPU average and peak from Azure Monitor. A low average with a high peak is bursty, not idle. Select a VM to compare a resize or shutdown without changing it. Stopped: {d?.stopped_count ?? "Unavailable"}.</p>
    <OptimizeTable<VmRow> title="Virtual machines by cost" rows={d?.vms ?? []} rowKey={(r, i) => r.id || `${r.name}-${i}`} onSelect={setSelected} columns={[
      { id: "name", label: "Virtual machine / scenario", value: r => r.name }, { id: "size", label: "Size", value: r => r.size || r.vm_size },
      { id: "state", label: "Power state", value: r => r.power_state || r.state },
      { id: "avg", label: "CPU average", value: r => r.cpu_avg, cell: r => r.cpu_avg == null ? "Unavailable" : `${r.cpu_avg.toFixed(1)}%`, numeric: true },
      { id: "peak", label: "CPU peak", value: r => r.cpu_max, cell: r => r.cpu_max == null ? "Unavailable" : `${r.cpu_max.toFixed(1)}%`, numeric: true },
      { id: "cost", label: "Billed cost", value: r => nativeBuckets(r.cost_by_currency, r.cost, r.currency || d?.currency, numbers), cell: r => nativeBuckets(r.cost_by_currency, r.cost, r.currency || d?.currency, numbers), numeric: true },
    ]} empty={d?.error ? "VM evidence is unavailable." : "No VMs returned in this scope."} />
    {selected && <Card className="mt-4 p-4"><div className="flex justify-between"><h3 className="font-medium">{selected.name} · scenario</h3><Button variant="ghost" onClick={() => setSelected(undefined)}>Close</Button></div>{canSimulate(selected.id) ? <OptimizeWhatIf key={selected.id} resourceId={selected.id} scope={scope} days={days} /> : <p className="mt-2 text-sm text-muted">No supported VM resource ID was returned. A scenario cannot be priced safely.</p>}</Card>}
  </OptimizeQueryState>;
}
function Waste({ scope, days }: { scope: OptimizeScope; days: number }) {
  const q = useQuery(optimizeQuery<WasteReport>("waste", scope, { days })); const d = q.data; const { numbers } = usePrefs();
  return <OptimizeQueryState query={q}><OptimizeNotices notices={[d?.error, d?.note, d?.review_note, ...Object.entries(d?.errors ?? {}).map(([rule, error]) => `${rule}: ${error}`), d?.partial ? "Waste inventory is incomplete. Source failures do not mean no waste." : null]} /><div className="grid gap-4 sm:grid-cols-3"><KpiTile label="Idle or orphaned items" value={d?.total_items} /><KpiTile label={`Cost over ${d?.period_days ?? days} days`} value={nativeBuckets(d?.total_by_currency, d?.total_cost, d?.currency, numbers)} index={1} /><KpiTile label="Subscriptions scanned" value={d?.subscriptions ?? "Unavailable"} index={2} /></div><p className="mt-4 text-sm text-muted">Live inventory joined to actual billed cost. Deliberate idle resources may be valid; nothing is deleted. Retained disks may still charge when a VM is stopped.</p>
    {!(d?.findings ?? []).some(f => f.count > 0) && <OptimizeNotices notices={[d?.error || d?.partial ? "Inventory unavailable or incomplete — no complete waste assessment." : "No idle or orphaned findings were returned for this scope."]} />}
    {(d?.findings ?? []).filter(f => f.count > 0).map(f => <OptimizeTable<WasteItem> key={f.category} title={`${f.category.replaceAll("_", " ")} · ${f.count} items`} rows={f.items ?? []} rowKey={(r, i) => r.id ?? `${r.name}-${i}`} note={[f.why, f.impact_note, f.items.length < f.count ? `Showing ${f.items.length} of ${f.count} findings.` : ""].filter(Boolean).join(" ")} columns={[{ id: "name", label: "Resource", value: r => r.name || r.id }, { id: "group", label: "Resource group", value: r => r.resource_group }, { id: "region", label: "Region", value: r => r.location || r.region }, { id: "detail", label: "Inventory evidence", value: r => r.detail || r.pricing_status }, { id: "cost", label: "Billed cost", value: r => nativeBuckets(r.cost_by_currency, r.cost, r.currency || d?.currency, numbers), cell: r => nativeBuckets(r.cost_by_currency, r.cost, r.currency || d?.currency, numbers), numeric: true }]} />)}
  </OptimizeQueryState>;
}
function Advisor({ scope }: { scope: OptimizeScope }) {
  const [category, setCategory] = useState("Cost");
  const [selected, setSelected] = useState<AdvisorRow>();
  const q = useQuery(optimizeQuery<AdvisorReport>("advisor", scope, { category })); const d = q.data; const { numbers } = usePrefs();
  return <><OptimizeSelect label="Advisor category" value={category} onChange={v => { setCategory(v); setSelected(undefined); }} options={["Cost", "Security", "HighAvailability", "OperationalExcellence", "Performance", "All"].map(v => ({ value: v, label: v.replace(/([a-z])([A-Z])/g, "$1 $2") }))} /><OptimizeQueryState query={q}><OptimizeNotices notices={[d?.error, d?.note, ...Object.entries(d?.errors ?? {}).map(([sub, error]) => `${sub}: ${error}`), d?.partial ? "Advisor assessment incomplete; unavailable subscriptions are not empty recommendations." : null]} /><div className="grid gap-4 sm:grid-cols-2"><KpiTile label={`${d?.category ?? category} recommendations`} value={d?.count} /><KpiTile label="Provider estimated annual saving" value={nativeBuckets(d?.annual_savings_by_currency, d?.estimated_annual_savings, d?.currency, numbers)} index={1} /></div><OptimizeTable<AdvisorRow> title="Azure Advisor evidence" rows={d?.recommendations ?? []} rowKey={(r, i) => r.id ?? `${r.resource}-${i}`} onSelect={setSelected} columns={[{ id: "problem", label: "Recommendation", value: r => r.problem || r.solution }, { id: "impact", label: "Impact", value: r => r.impact }, { id: "resource", label: "Resource", value: r => r.resource }, { id: "saving", label: "Annual saving", value: r => r.annual_savings, cell: r => nativeMoney(r.annual_savings, r.currency || d?.currency, numbers), numeric: true }]} note="Estimates from Azure Advisor, not realised savings." />{selected && <Card className="mt-4 p-5"><h3 className="font-medium">{selected.problem}</h3><p className="mt-2 text-sm">{selected.solution}</p><p className="mt-2 text-sm text-muted">{selected.resource} · {selected.impact}</p><Button className="mt-3" variant="ghost" onClick={() => setSelected(undefined)}>Close details</Button></Card>}</OptimizeQueryState></>;
}
function Shutdown({ scope, days }: { scope: OptimizeScope; days: number }) {
  const q = useQuery(optimizeQuery<ShutdownReport>("shutdown", scope, { days })); const d = q.data; const { numbers } = usePrefs();
  const totals = (field: "total_current" | "total_saving") => Object.keys(d?.totals_by_currency ?? {}).length
    ? Object.entries(d!.totals_by_currency!).map(([c, v]) => nativeMoney(v[field], c, numbers)).join(" · ")
    : nativeMoney(d?.[field], d?.currency, numbers);
  return <OptimizeQueryState query={q}><OptimizeNotices notices={[d?.error, d?.note, ...(d?.errors ?? []), d?.partial ? "Scheduling assessment incomplete: currency, pricing or telemetry evidence is unavailable for some machines." : null]} /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><KpiTile label="Schedulable machines" value={d?.count ?? d?.candidates?.length} hint={`Of ${d?.examined ?? "unknown"} running VMs`} /><KpiTile label="Costing now / month" value={totals("total_current")} index={1} /><KpiTile label="Up to / month" value={totals("total_saving")} hint="Compute share only, not guaranteed" index={2} /><KpiTile label="Weekly hours kept" value={d?.hours_kept ?? "Unavailable"} hint="Of 168 hours" index={3} /></div><p className="mt-4 text-sm text-muted">{d?.window} · {d?.days_analysed ?? days} days of hourly CPU. {d?.skipped_production ?? 0} production-tagged VMs excluded; {d?.skipped_steady ?? 0} steady-load VMs skipped. Disks and reserved IPs keep charging; commitment discounts can reduce realised savings.</p>
    <OptimizeTable<ShutdownRow> title="Scheduling candidates" rows={d?.candidates ?? []} rowKey={(r, i) => r.id ?? `${r.name}-${i}`} columns={[{ id: "name", label: "Virtual machine", value: r => r.name }, { id: "window", label: "Active window", value: r => r.window }, { id: "in", label: "In-hours CPU", value: r => r.avg_business, cell: r => r.avg_business == null ? "Unavailable" : `${r.avg_business}%`, numeric: true }, { id: "out", label: "Off-hours CPU", value: r => r.avg_offhours, cell: r => r.avg_offhours == null ? "Unavailable" : `${r.avg_offhours}%`, numeric: true }, { id: "current", label: "Current / month", value: r => r.current, cell: r => nativeMoney(r.current, r.currency, numbers), numeric: true }, { id: "scheduled", label: "Scheduled / month", value: r => r.scheduled, cell: r => nativeMoney(r.scheduled, r.currency, numbers), numeric: true }, { id: "saving", label: "Up to / month", value: r => r.saving, cell: r => nativeMoney(r.saving, r.currency, numbers), numeric: true }]} empty={d?.partial ? "No complete scheduling candidates; assessment is incomplete." : "No clear daily scheduling pattern was found."} />
    {(d?.candidates ?? []).map((r, i) => <Card key={r.id ?? i} className="mt-3 p-4 text-sm"><h3 className="font-medium">{r.name} · {r.size} · {r.resource_group}</h3><p className="mt-2 text-muted">Busy {r.ratio ?? "unknown"}× more during {r.window}. {r.hours_saved ?? "Unknown"} weekly hours could be off. {r.busy_offhours_hours ? `${r.busy_offhours_hours} active off-hours samples — check overnight jobs.` : "No off-hours activity returned in the sampled period."}</p></Card>)}
  </OptimizeQueryState>;
}
