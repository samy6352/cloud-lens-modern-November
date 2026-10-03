import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { KpiTile, PageHeader, Segmented } from "@/components/blocks";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { OptimizeBars, OptimizeMetric, OptimizeNotices, OptimizeQueryState, OptimizeTable, OptimizeWindow, useOptimizeScope } from "@/components/OptimizeShared";
import { api } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { aiAmounts, aiRowKey, anomalyDirection, nativeMoney, observedTokens, optimizeQuery, validateOptimizeReport, type AiReport, type AiRow, type AiResourceRow, type Amount, type OptimizeScope } from "@/lib/optimize-queries";

type View = "resources" | "services" | "models";
interface ServiceSummary { service: string; resources: number; models: number; tokens: number | null; partial: boolean; amounts: Amount[] }
function labels(r: AiRow): Array<string | null> {
  return [r.service, r.resource_name, r.resource_id, r.subscription_id,
    ...("deployment" in r ? [r.model, r.deployment, r.version, r.sku, r.format] : [r.subscription, ...r.models])];
}
function rowName(r: AiRow): string {
  return "deployment" in r ? `${r.model || "Model not reported"} · ${r.deployment}` : `${r.service || "AI service"} · ${r.resource_name || r.id}`;
}
function amountText(r: AiRow): string {
  const amounts = aiAmounts(r);
  return amounts?.length ? amounts.map(a => a.cost == null ? `${a.currency} Unavailable` : nativeMoney(a.cost, a.currency)).join("; ")
    : "deployment" in r ? "Not allocated" : "Unavailable";
}
function AiAmounts({ amounts }: { amounts?: Amount[] | null }) {
  const { numbers } = usePrefs();
  return <span className="num">{amounts?.length ? amounts.map((a, i) => <span className="block" key={`${a.currency}-${i}`}>{a.cost == null ? `${a.currency} Unavailable` : nativeMoney(a.cost, a.currency, numbers)}</span>) : "Unavailable"}</span>;
}
export function AiBillingPage() {
  const scope = useOptimizeScope();
  return <AiBillingContent key={`${scope.scope ?? ""}|${scope.currency ?? ""}`} scope={scope} />;
}
function AiBillingContent({ scope }: { scope: OptimizeScope }) {
  const { numbers } = usePrefs();
  const client = useQueryClient();
  const [view, setView] = useState<View>("resources");
  const [days, setDays] = useState(30);
  const [onlyAnomalies, setOnlyAnomalies] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<AiRow>();
  const [refreshError, setRefreshError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const options = optimizeQuery<AiReport>("ai-billing", scope, { days });
  const q = useQuery(options);
  const d = q.data;
  const services = d?.services ?? [];
  const source = view === "models" ? d?.models ?? [] : services;
  const tokenSummary = observedTokens(services);
  const flagged = source.filter(r => anomalyDirection(r)).length;
  const incomplete = source.filter(r => r.anomaly_status !== "checked").length;
  const matches = (r: AiRow) => (!onlyAnomalies || anomalyDirection(r)) && (!search || labels(r).some(v => v?.toLowerCase().includes(search.toLowerCase())));
  const filtered = source.filter(matches)
    .map((row, index) => ({ row, index })).sort((a, b) => Number(!!anomalyDirection(b.row)) - Number(!!anomalyDirection(a.row)) || a.index - b.index).map(x => x.row);
  const grouped = new Map<string, AiResourceRow[]>();
  if (view === "services") for (const r of services.filter(matches)) { const key = r.service || "AI service not reported"; grouped.set(key, [...(grouped.get(key) ?? []), r]); }
  const serviceGroups: ServiceSummary[] = [...grouped].map(([service, rows]) => {
    const currencies = [...new Set(rows.flatMap(r => r.cost_by_currency.map(a => a.currency)))];
    const summary = observedTokens(rows);
    return { service, resources: rows.length, models: new Set(rows.flatMap(r => r.models ?? [])).size, tokens: summary.value, partial: summary.partial,
      amounts: currencies.map(currency => { const entries = rows.flatMap(r => r.cost_by_currency.filter(a => a.currency === currency)); return { currency, cost: entries.some(a => a.cost == null) ? null : entries.reduce((sum, a) => sum + a.cost!, 0) }; }) };
  });
  async function refresh() {
    setRefreshError(""); setRefreshing(true); setSelected(undefined);
    try { await client.fetchQuery({ ...options, staleTime: 0, queryFn: async ({ signal }) => { const data = await api<AiReport>("dashboard/ai-billing", { scope: scope.scope, currency: scope.currency, days, force: true }, { signal }); validateOptimizeReport("ai-billing", data); return data; } }); }
    catch (e) { setRefreshError((e as Error).message); }
    finally { setRefreshing(false); }
  }
  const coverage = d?.metric_coverage;
  const currencies = [...new Set(services.flatMap(r => r.cost_by_currency.map(a => a.currency)))];
  return <div><PageHeader title="AI Billing" subtitle="Resource billing and measured model usage — costs and telemetry retain their own evidence and coverage." actions={<><OptimizeWindow days={days} onChange={v => { setDays(v); setSelected(undefined); }} /><Button variant="outline" disabled={q.isFetching || refreshing} onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh evidence"}</Button></>} />
    <OptimizeQueryState query={q}>
      <OptimizeNotices notices={[refreshError, d?.status === "partial" ? "Partial billing or usage coverage. Missing telemetry is never zero or proof of idle capacity." : null, coverage && coverage.accounts_with_tokens < coverage.eligible_accounts ? `${coverage.accounts_with_tokens} of ${coverage.eligible_accounts} eligible AI accounts returned token observations. Narrow subscription scope and refresh to retry missing evidence.` : null, ...(d?.notices ?? [])]} />
      <p className="mb-4 text-xs text-muted">{d?.window?.from && d?.window?.to ? `${d.window.from} to ${d.window.to}` : "Billing window unavailable"} · Read at {d?.generated_at} · UTC day-end billing window · Selected subscriptions</p>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><KpiTile label="AI billed cost" value={<AiAmounts amounts={d?.totals} />} hint="Separate totals per returned currency" /><KpiTile label="AI resources" value={services.length} hint="In loaded billing selection" index={1} /><KpiTile label={tokenSummary.partial ? "Observed tokens · partial" : "Observed tokens"} value={tokenSummary.value == null ? "Unavailable" : formatNumber(tokenSummary.value, { system: numbers, digits: 0 })} hint={`${tokenSummary.measured} of ${tokenSummary.total} resources measured`} index={2} /><KpiTile label="Model deployments" value={d?.models?.length ?? 0} hint="Returned model-level evidence" index={3} /></div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">{currencies.map(currency => {
        const rows = services.flatMap(r => r.cost_by_currency.filter(a => a.currency === currency && a.cost != null).map(a => ({ name: r.resource_name || r.service || r.id, cost: a.cost! }))).sort((a, b) => b.cost - a.cost).slice(0, 8);
        return rows.length ? <OptimizeBars key={currency} title={`AI resource spend · ${currency}`} labels={rows.map(r => r.name)} values={rows.map(r => r.cost)} currency={currency} /> : null;
      })}</div>
      <Card className="mt-4"><CardHeader title="Billing & usage breakdown" /><CardBody><div className="flex flex-wrap items-center gap-3"><Segmented label="AI billing detail" value={view} onChange={v => { setView(v); setSelected(undefined); }} options={[{ value: "resources", label: "Resources" }, { value: "services", label: "Services" }, { value: "models", label: "Models" }]} /><input aria-label="Search AI services and models" type="search" value={search} onChange={e => setSearch(e.target.value)} maxLength={200} placeholder="Service, model or resource…" className="h-9 w-64 rounded-lg border border-border bg-surface px-3 text-sm" /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyAnomalies} onChange={e => setOnlyAnomalies(e.target.checked)} />Only anomalies</label></div><p className="mt-3 text-xs text-muted" role="status">{filtered.length} of {source.length} loaded {view === "models" ? "model deployments" : "AI resources"} · {flagged} flagged{incomplete ? ` · ${incomplete} incomplete or unavailable assessments` : " · All rows assessed"}</p><p className="mt-2 text-sm text-muted">{view === "models" ? "Model usage comes from Azure Monitor. Resource-level cost is not divided between deployments." : view === "services" ? "Resource charges grouped by reported AI service; currencies stay separate. These are the same charges shown in Resources." : "Billed cost by AI resource. Expand evidence for billing products, meters, sources and anomalies."}</p></CardBody></Card>
      {view === "services" ? <OptimizeTable<ServiceSummary> title="AI services" rows={serviceGroups} rowKey={r => r.service} onSelect={r => { setView("resources"); setSearch(r.service); setSelected(undefined); }} columns={[
        { id: "service", label: "AI service / resources", value: r => r.service }, { id: "resources", label: "Resources", value: r => r.resources, numeric: true },
        { id: "models", label: "Billing product labels (not deployments)", value: r => r.models, numeric: true },
        { id: "tokens", label: "Observed tokens", value: r => r.tokens, cell: r => `${r.tokens == null ? "Unavailable" : formatNumber(r.tokens, { system: numbers, digits: 0 })}${r.partial ? " · partial" : ""}`, numeric: true },
        { id: "cost", label: "Billed cost", value: r => r.amounts.map(a => `${a.currency} ${a.cost ?? "Unavailable"}`).join("; "), cell: r => <AiAmounts amounts={r.amounts} /> },
      ]} empty="No AI services match this selection." /> : <OptimizeTable<AiRow> key={view} title={view === "models" ? "Model usage" : "AI resource billing"} rows={filtered} rowKey={aiRowKey} onSelect={setSelected} columns={[
        { id: "name", label: view === "models" ? "Model / deployment evidence" : "Service / resource evidence", value: rowName, width: "minmax(300px,2fr)" },
        { id: "scope", label: "Resource / subscription scope", value: r => `${r.resource_name} · ${r.subscription_id}`, width: "minmax(260px,1.6fr)" },
        ...(view === "models" ? [
          { id: "version", label: "Version / format (current)", value: (r: AiRow) => "deployment" in r ? `${r.version ?? "Unavailable"} · ${r.format ?? "Unavailable"}` : "Not applicable" },
          { id: "sku", label: "SKU (current)", value: (r: AiRow) => "deployment" in r ? r.sku ?? "Unavailable" : "Not applicable" },
          { id: "pricing", label: "Capacity / unit pricing", value: () => "Unavailable · not returned by API", width: "minmax(230px,1.5fr)" },
        ] : [{ id: "products", label: "Billing product labels", value: (r: AiRow) => "models" in r ? r.models.join(", ") || "Not reported" : "Not applicable" }]),
        { id: "tokens", label: "Token consumption", value: r => r.tokens.value, cell: r => <div><OptimizeMetric metric={r.tokens} /><p className="mt-1 text-xs text-muted">In {r.tokens.input == null ? "Unavailable" : formatNumber(r.tokens.input, { digits: 0 })} · Out {r.tokens.output == null ? "Unavailable" : formatNumber(r.tokens.output, { digits: 0 })}</p></div>, numeric: true },
        { id: "cost", label: "Billed cost (not unit pricing)", value: amountText, cell: r => "deployment" in r && !aiAmounts(r)?.length ? <button type="button" className="text-accent hover:underline" onClick={() => { setView("resources"); setSearch(r.resource_id || r.resource_name || ""); setOnlyAnomalies(false); setSelected(undefined); }}>Not allocated · view resource cost</button> : <AiAmounts amounts={aiAmounts(r)} /> },
        { id: "utilization", label: "Utilization", value: r => r.utilization?.value, cell: r => <OptimizeMetric metric={r.utilization} percent />, numeric: true },
        { id: "anomaly", label: "Anomaly assessment", value: r => anomalyDirection(r) || ({ checked: "No significant change", partial: "Partial assessment", insufficient_history: "Insufficient history", not_applicable: "Not applicable" }[r.anomaly_status ?? ""] ?? "Not assessed"), cell: r => <span className={anomalyDirection(r) ? "text-warn" : "text-muted"}>{anomalyDirection(r) || r.anomaly_status?.replaceAll("_", " ") || "Not assessed"}</span> },
        { id: "recommendation", label: "Recommendation", value: r => r.recommendation || "Review available evidence.", width: "minmax(240px,1.6fr)" },
      ]} empty={onlyAnomalies ? "No flagged rows match this selection. Unassessed data is not proof of normal activity." : search ? "No records match this search." : view === "models" ? "No model-level usage available. Resource billing remains available." : "No AI billing rows found in the selected cost data."} note="Service/resource and model usage overlap; do not add their costs or token totals." />}
      {selected && <AiEvidence key={aiRowKey(selected)} row={selected} onClose={() => setSelected(undefined)} onResource={() => { setView("resources"); setSearch(selected.resource_id || selected.resource_name || ""); setOnlyAnomalies(false); setSelected(undefined); }} />}
      <details className="mt-4 rounded-xl border border-border p-4 text-sm"><summary className="cursor-pointer font-medium">Sources & definitions</summary><div className="mt-3 space-y-3 text-muted"><p>Billed cost uses the returned warehouse window. Model names and measured tokens come from deployment metadata and Azure Monitor, not guesses from resource names, price meters or spend. Input plus output tokens are counted once; total-token metrics are not added again.</p><p>Utilization is the provisioned-capacity metric Azure exposes, with aggregation shown in resource evidence. Pay-as-you-go capacity utilization may not apply. Generic billing quantities are not measured token consumption. No model charge is inferred when billing does not identify the deployment.</p><p>Recommendations are evidence-based review prompts, not guaranteed savings or automatic changes. Resource/service totals overlap Overview, not additional spend. Model and resource anomaly flags can describe the same activity and are not additive.</p><p>Spikes and drops compare complete daily observations with a trailing baseline. Missing days and incomplete telemetry are never filled with zero; unsettled recent billing days are not judged. {d?.anomaly_detection?.method}{d?.anomaly_detection?.window_days ? ` · ${d.anomaly_detection.window_days}-day baseline` : ""}{d?.anomaly_detection?.min_history ? ` · at least ${d.anomaly_detection.min_history} complete prior days` : ""}{d?.anomaly_detection?.min_relative_change != null ? ` · minimum ${d.anomaly_detection.min_relative_change * 100}% relative change` : ""}.</p><p>Daily snapshots are reused until newer billing data is available for this selection, subject to retention. Same-day corrections do not automatically repeat Azure reads. Refresh evidence requests a new read; these daily amounts may differ from the latest Billing view.</p></div></details>
    </OptimizeQueryState>
  </div>;
}
function AiEvidence({ row: r, onClose, onResource }: { row: AiRow; onClose: () => void; onResource: () => void }) {
  const { numbers } = usePrefs();
  const model = "deployment" in r;
  return <Card className="mt-4 p-5"><div className="flex flex-wrap justify-between gap-3"><h3 className="font-semibold">{rowName(r)} · source evidence</h3><Button variant="ghost" onClick={onClose}>Close</Button></div><p className="mt-2 text-sm text-muted">{labels(r).filter(Boolean).join(" · ")}</p><p className="mt-1 break-all text-xs text-muted">{r.resource_id}</p><OptimizeNotices notices={r.notes ?? undefined} />
    {model && <section className="mt-4 rounded-xl border border-border p-4 text-sm"><h4 className="font-medium">Current deployment metadata · not historical</h4><dl className="mt-3 grid gap-2 sm:grid-cols-2"><dt>Model / deployment</dt><dd>{r.model || "Unavailable"} · {r.deployment}</dd><dt>Version / format</dt><dd>{r.version || "Unavailable"} · {r.format || "Unavailable"}</dd><dt>SKU</dt><dd>{r.sku || "Unavailable"}</dd><dt>Capacity</dt><dd>Unavailable · not returned by API</dd><dt>Unit pricing / rates</dt><dd>Unavailable · not returned by API</dd></dl><p className="mt-3 text-xs text-muted">{r.metadata_source}. SKU labels do not establish capacity or a token price. Billing products and meter units are not deployment rate metadata.</p></section>}
    <div className="mt-4 grid gap-4 md:grid-cols-2">{[{ label: "Token consumption", metric: r.tokens, percent: false }, { label: "Capacity utilization", metric: r.utilization, percent: true }].map(({ label, metric, percent }) => <section key={label} className="rounded-xl border border-border p-4"><h4 className="text-sm font-medium">{label}</h4><p className="num mt-2 text-xl font-semibold"><OptimizeMetric metric={metric} percent={percent} /></p>{!percent && <p className="mt-2 text-sm">In {metric.input == null ? "Unavailable" : formatNumber(metric.input, { digits: 0 })} · Out {metric.output == null ? "Unavailable" : formatNumber(metric.output, { digits: 0 })}</p>}{percent && <p className="mt-2 text-sm">Maximum {metric.maximum == null ? "Unavailable" : `${formatNumber(metric.maximum)}%`}{metric.maximum_status ? ` · ${metric.maximum_status}` : ""}</p>}<p className="mt-2 text-xs text-muted">{metric.source || "Source unavailable"} · {metric.aggregation || "Aggregation not reported"} · {metric.status}</p><p className="mt-2 text-xs text-muted">{metric.samples ?? "Unknown"} of {metric.expected_samples ?? "Unknown"} expected samples · {metric.window?.start || "Window unavailable"} to {metric.window?.end || "Window unavailable"}</p><p className="mt-2 text-sm text-muted">{metric.note}</p></section>)}</div>
    <section className="mt-4 text-sm"><h4 className="font-medium">Billed cost · separate from unit pricing</h4><AiAmounts amounts={aiAmounts(r)} /><p className="mt-2 text-muted">{r.cost_note || (model ? "Billing is not allocated to this deployment." : "Resource billing from the scoped warehouse.")}</p>{model && !aiAmounts(r)?.length && <Button className="mt-3" variant="outline" onClick={onResource}>View resource cost (not allocated to model)</Button>}</section>
    <p className="mt-4 text-sm">{r.recommendation || "Review available billing and usage evidence."}</p>
    {"meters" in r && !!r.meters.length && <OptimizeTable title="Billing products and meters" rows={r.meters} rowKey={(m, i) => `${m.meter}-${m.currency}-${i}`} columns={[{ id: "product", label: "Product", value: m => m.product }, { id: "meter", label: "Meter", value: m => m.meter }, { id: "quantity", label: "Billing quantity (not measured tokens)", value: m => m.quantity, cell: m => `${m.quantity == null ? "Unavailable" : formatNumber(m.quantity)} ${m.unit || ""}` }, { id: "cost", label: "Cost", value: m => `${m.currency} ${m.cost ?? "Unavailable"}`, cell: m => m.cost == null ? `${m.currency} Unavailable` : nativeMoney(m.cost, m.currency, numbers) }]} note={`${r.billing_rows} billing rows. Meter quantities do not establish token consumption.`} />}
    <section className="mt-4"><h4 className="text-sm font-semibold">Anomaly evidence · {anomalyDirection(r) || r.anomaly_status?.replaceAll("_", " ") || "Not assessed"}</h4>{(r.anomalies ?? []).map((a, i) => {
      const value = (v: number | null) => a.metric === "cost" ? nativeMoney(v, a.currency, numbers) : v == null ? "Unavailable" : `${formatNumber(v)}${a.metric === "utilization" ? "%" : " tokens"}`;
      return <div key={i} className="mt-3 rounded-lg bg-surface-2 p-3 text-sm"><strong>{a.metric} {a.direction === "up" ? "spike" : "drop"} · {a.day}</strong><p className="mt-2">{value(a.actual)} vs typical {value(a.baseline)} · {a.percent == null ? a.baseline === 0 ? "Zero baseline; percentage unavailable" : "Percentage unavailable" : `${a.percent > 0 ? "+" : ""}${a.percent.toFixed(1)}%`}</p>{a.metric === "utilization" && <p>Change {a.delta == null ? "Unavailable" : `${a.delta > 0 ? "+" : ""}${formatNumber(a.delta)} percentage points`}</p>}<p className="mt-1 text-xs text-muted">{a.baseline_samples ?? "Unknown"} baseline days · {a.baseline_from || "Unavailable"} to {a.baseline_to || "Unavailable"}</p><p className="mt-1 text-xs text-muted">{a.source || "Source unavailable"} · {a.note}</p></div>;
    })}<p className="mt-2 text-sm text-muted">{r.anomaly_note}</p></section>
    {!!r.anomaly_checks?.length && <OptimizeTable title="Anomaly assessment coverage" rows={r.anomaly_checks} rowKey={(c, i) => `${c.metric}-${c.currency}-${i}`} columns={[{ id: "metric", label: "Metric / currency", value: c => `${c.metric}${c.currency ? ` · ${c.currency}` : ""}` }, { id: "status", label: "Assessment", value: c => c.status.replaceAll("_", " ") }, { id: "days", label: "Checked / eligible days", value: c => `${c.checked_days} / ${c.eligible_days}` }, { id: "missing", label: "Missing days", value: c => c.missing_days, numeric: true }, { id: "note", label: "Evidence", value: c => c.note, width: "minmax(300px,2fr)" }]} />}
    {r.resource_id && <a className="mt-4 inline-block text-sm text-accent hover:underline" href={`https://portal.azure.com/#@/resource${encodeURI(r.resource_id)}`} target="_blank" rel="noreferrer">Open resource in Azure ↗</a>}
  </Card>;
}
