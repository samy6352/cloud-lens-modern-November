import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AlertDialog } from "radix-ui";
import { Plus, ShieldCheck } from "lucide-react";
import { Chart } from "@/components/Chart";
import { columnHelper, DataTable } from "@/components/DataTable";
import { KpiTile, PageHeader } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GovernDetails, GovernError, GovernField, GovernLink, GovernLoading, GovernNotice, GovernRefresh, GovernSelect, governInput } from "@/components/GovernControls";
import { budgetNativeCurrency, budgetTagInventoryQuery, budgetPermission, budgetPortal, budgetStatus, budgetTrendQuery, budgetsQuery, createBudget, explicitScopes, globalScope, governCapabilitiesQuery,
  governMeQuery, governSubscriptionsQuery, nativeMoney, validateBudget, type Budget, type BudgetCreated, type BudgetDraft } from "@/lib/govern-queries";
import type { Scope } from "@/lib/queries";

function BudgetHistory({ budget }: { budget: Budget }) {
  const query = useQuery(budgetTrendQuery(budget));
  const data = query.data;
  const trend = data?.trend ?? budget.trend;
  if (budget.filter_exact === false || data?.filter_exact === false) return <GovernNotice warning>Local data cannot reproduce this filter exactly. Azure-reported filtered spend is authoritative; no subscription-wide trend is substituted.</GovernNotice>;
  if (query.isError) return <GovernError error={query.error} retry={() => void query.refetch()} />;
  if (query.isPending && !budget.trend_note) return <GovernLoading />;
  if (!trend?.labels.length || !budget.currency || budget.amount == null) return <GovernNotice>{data?.trend_note || budget.trend_note || "No comparable daily history. The meter is an Azure snapshot, not a trend."}</GovernNotice>;
  const gap = budget.current_spend != null && trend.total != null && Math.abs(trend.total - budget.current_spend) / Math.max(Math.abs(budget.current_spend), .01) > .15;
  return <div className="space-y-3"><Chart height={260} option={{
    tooltip: { trigger: "axis", renderMode: "richText" }, legend: { bottom: 0 }, grid: { left: 75, right: 20, top: 20, bottom: 55 },
    xAxis: { type: "category", data: trend.labels }, yAxis: { type: "value", name: budget.currency },
    series: [{ name: "Warehouse cumulative spend", type: "line", data: trend.cumulative, showSymbol: false, areaStyle: { opacity: .08 } },
      { name: "Native budget limit", type: "line", data: trend.labels.map(() => budget.amount), showSymbol: false, lineStyle: { type: "dashed" } }],
  }} /><p>Current budget-period warehouse history: {trend.labels[0]} to {trend.labels.at(-1)}. Historical month and display-currency preferences do not alter the Azure counter.</p>
    {gap && <GovernNotice warning>Warehouse total {nativeMoney(trend.total, budget.currency)} differs from Azure spend {nativeMoney(budget.current_spend, budget.currency)}. Source timing or coverage may differ.</GovernNotice>}</div>;
}

function BudgetComposer({ scope, existing, demo, demoNote }: { scope: Scope; existing: Budget[]; demo: boolean; demoNote: string | null }) {
  const client = useQueryClient();
  const subscriptions = useQuery(governSubscriptionsQuery);
  const me = useQuery(governMeQuery);
  const selected = explicitScopes(scope.scope);
  const eligible = (subscriptions.data?.subscriptions ?? []).filter(s => !selected.length || selected.includes(s.id.toLowerCase()));
  const today = new Date();
  const first = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const [draft, setDraft] = useState<BudgetDraft>({ subscription: selected.length === 1 ? selected[0]! : "", name: "", amount: 0, time_grain: "Monthly",
    start: first, end: `${today.getFullYear() + 1}-${first.slice(5)}`, tags: [{ key: "", values: [] }], mode: "all", thresholds: [80, 100], emails: [] });
  const [amount, setAmount] = useState("");
  const [thresholds, setThresholds] = useState("80,100");
  const [emails, setEmails] = useState("");
  const [validation, setValidation] = useState<string[]>([]);
  const [review, setReview] = useState<BudgetDraft | null>(null);
  const [reviewCurrency, setReviewCurrency] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<BudgetCreated | null>(null);
  const tags = useQuery(budgetTagInventoryQuery(draft.subscription, scope.month));
  const native = budgetNativeCurrency(tags.data, draft.subscription);
  const capabilities = useQuery(governCapabilitiesQuery(draft.subscription));
  const permission = budgetPermission(me.data, capabilities.data, draft.subscription);
  const duplicate = existing.some(b => b.subscription_id.toLowerCase() === draft.subscription.toLowerCase() && b.name === draft.name.trim());
  function prepare() {
    const payload: BudgetDraft = { ...draft, name: draft.name.trim(), amount: Number(amount),
      thresholds: [...new Set(thresholds.trim() ? thresholds.split(/[,\s]+/).map(Number) : [])].sort((a, b) => a - b),
      emails: [...new Set(emails.split(/[,;\s]+/).filter(Boolean))],
      tags: draft.tags.map(t => ({ key: t.key.trim(), values: [...new Set(t.values)] })) };
    const errors = validateBudget(payload, native);
    if (!permission.allowed || demo) errors.push(demo ? "Demo mode does not permit Azure writes." : permission.reason);
    if (!eligible.some(s => s.id === payload.subscription)) errors.push("Choose a subscription inside the current selected scope.");
    setValidation(errors);
    if (!errors.length) { setReview(payload); setReviewCurrency(native); setConfirmed(false); setError(null); }
  }
  async function send() {
    if (!review || !confirmed || !permission.allowed || demo || sending) return;
    // Scope or capability changes while the dialog is open must not authorize a stale preview.
    if (!eligible.some(s => s.id === review.subscription) || review.subscription !== draft.subscription || native !== reviewCurrency || validateBudget(review, native).length) { setValidation(["Scope, native currency or validation changed; review the draft again."]); setReview(null); return; }
    setSending(true);
    try { setCreated(await createBudget(review)); setReview(null); await client.invalidateQueries({ queryKey: ["govern", "budgets"] }); }
    catch (e) { setError(e); setReview(null); }
    finally { setSending(false); }
  }
  return <Card className="space-y-5 p-5">
    <div><h3 className="font-semibold">Draft a tag-scoped Azure budget</h3><p className="mt-1 text-sm text-muted">Nothing is sent until you review the exact request and explicitly confirm. Azure creates or replaces a budget with the same name.</p></div>
    {demoNote && <GovernNotice warning>{demoNote}</GovernNotice>}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <GovernField label="Subscription"><select className={governInput} value={draft.subscription} onChange={e => setDraft({ ...draft, subscription: e.target.value })}><option value="">Select subscription</option>{eligible.map(s => <option value={s.id} key={s.id}>{s.name || s.id}</option>)}</select></GovernField>
      <GovernField label="Budget name"><input className={governInput} maxLength={63} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></GovernField>
      <GovernField label={`Amount in native ${native || "currency (unknown)"}`}><input className={governInput} type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></GovernField>
      <GovernField label="Reset period"><select className={governInput} value={draft.time_grain} onChange={e => { const v = e.target.value; if (v === "Monthly" || v === "Quarterly" || v === "Annually") setDraft({ ...draft, time_grain: v }); }}><option>Monthly</option><option>Quarterly</option><option>Annually</option></select></GovernField>
      <GovernField label="Start (first of month)"><input className={governInput} type="date" value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value })} /></GovernField>
      <GovernField label="Expiry"><input className={governInput} type="date" value={draft.end} onChange={e => setDraft({ ...draft, end: e.target.value })} /></GovernField>
      <GovernField label="Alert thresholds (%) · max 5"><input className={governInput} value={thresholds} onChange={e => setThresholds(e.target.value)} placeholder="80,100" /></GovernField>
      <GovernField label="Notification emails"><input className={governInput} value={emails} onChange={e => setEmails(e.target.value)} placeholder="owner@example.com" /></GovernField>
      <GovernField label="Tag combination"><select className={governInput} value={draft.mode} onChange={e => setDraft({ ...draft, mode: e.target.value === "any" ? "any" : "all" })}><option value="all">All keys (AND)</option><option value="any">Any (single key only)</option></select></GovernField>
    </div>
    <fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">Exact tag filters · values separated by commas; use "" for an empty value</legend>
      {draft.tags.map((tag, index) => <div key={index} className="grid items-end gap-3 sm:grid-cols-[1fr_2fr_auto]">
        <GovernField label={`Tag ${index + 1} key`}><input className={governInput} list="budget-tag-keys" value={tag.key} onChange={e => setDraft({ ...draft, tags: draft.tags.map((t, i) => i === index ? { ...t, key: e.target.value } : t) })} /></GovernField>
        <GovernField label={`Tag ${index + 1} values`}><input className={governInput} list={`budget-tag-values-${index}`} value={tag.values.map(v => v === "" ? '""' : v).join(",")} onChange={e => setDraft({ ...draft, tags: draft.tags.map((t, i) => i === index ? { ...t, values: e.target.value ? e.target.value.split(",").map(v => v.trim() === '""' ? "" : v.trim()) : [] } : t) })} /><datalist id={`budget-tag-values-${index}`}>{[...new Set((tags.data?.resources ?? []).flatMap(r => { const i = r.keys.findIndex(k => k.toLowerCase() === tag.key.toLowerCase()); return i >= 0 ? [tags.data?.values?.[r.v[i]!]].filter((v): v is string => v !== undefined) : []; }))].map(v => <option key={v} value={v || '""'} />)}</datalist></GovernField>
        <Button onClick={() => setDraft({ ...draft, tags: draft.tags.filter((_, i) => i !== index) })}>Remove tag {index + 1}</Button></div>)}
      <Button disabled={draft.tags.length >= 10} onClick={() => setDraft({ ...draft, tags: [...draft.tags, { key: "", values: [] }] })}><Plus />Add tag</Button>
    </fieldset>
    <datalist id="budget-tag-keys">{tags.data?.keys?.map(k => <option key={k.key} value={k.key} />)}</datalist>
    <p className="text-xs text-muted">Native currency is verified from the selected subscription's warehouse billing currencies, not from the global display preference. Unknown or mixed currencies block creation. Tag suggestions reflect the selected billing month; values are frozen in the reviewed filter.</p>
    {tags.isError && <GovernError error={tags.error} retry={() => void tags.refetch()} />}
    {subscriptions.isError && <GovernError error={subscriptions.error} retry={() => void subscriptions.refetch()} />}
    {capabilities.isError && <GovernError error={capabilities.error} retry={() => void capabilities.refetch()} />}
    <GovernNotice warning={!permission.allowed}><ShieldCheck className="mr-2 inline size-4" />{permission.reason}</GovernNotice>
    <Button className="h-auto min-h-9 max-w-full whitespace-normal py-2" disabled={!draft.subscription || capabilities.isFetching || tags.isFetching} onClick={() => { void capabilities.refetch(); void tags.refetch(); }}>Recheck scoped permissions & native currency</Button>
    {duplicate && <GovernNotice warning>This name already exists. The Azure request can replace its amount, filter and notifications. Review carefully.</GovernNotice>}
    {validation.length > 0 && <ul role="alert" className="list-inside list-disc text-sm text-bad">{validation.map(v => <li key={v}>{v}</li>)}</ul>}
    {error != null && <GovernError error={error} retry={() => { setError(null); prepare(); }} />}
    {created && <GovernNotice>Azure returned budget “{created.name}”: {nativeMoney(created.amount, native)} {created.time_grain}, {created.notifications} notification(s). <GovernLink url={created.portal_url || budgetPortal({ subscription_id: draft.subscription, name: created.name })} /> Review the live read before repeating a timed-out request.</GovernNotice>}
    <Button variant="primary" onClick={prepare} disabled={sending || demo || !permission.allowed || !native}>Review exact Azure request</Button>
    <AlertDialog.Root open={review !== null} onOpenChange={open => { if (!open && !sending) setReview(null); }}>
      <AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(94vw,650px)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl border border-border bg-surface p-6 shadow-2xl">
          <AlertDialog.Title className="text-lg font-semibold">Confirm an Azure budget write</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-muted">POST /api/budgets creates or replaces a real Azure budget. Amounts stay in native {native || "billing"} units. Cancel preserves every draft field.</AlertDialog.Description>
          <pre className="my-4 overflow-auto rounded-lg bg-surface-2 p-3 text-xs">{JSON.stringify(review, null, 2)}</pre>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={sending} />I approve this exact subscription, amount, tag filter and notification request, including replacement if the name exists.</label>
          <div className="mt-5 flex flex-wrap justify-end gap-2"><AlertDialog.Cancel asChild><Button disabled={sending}>Cancel · keep draft</Button></AlertDialog.Cancel><Button variant="primary" disabled={!confirmed || sending || !permission.allowed} onClick={() => void send()}>{sending ? "Sending…" : "Confirm and send to Azure"}</Button></div>
        </AlertDialog.Content></AlertDialog.Portal>
    </AlertDialog.Root>
  </Card>;
}

export function BudgetsPage() {
  const search = useSearch({ strict: false });
  const scope = globalScope(search);
  const [refresh, setRefresh] = useState(false);
  const query = useQuery(budgetsQuery(scope, refresh));
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [currency, setCurrency] = useState("");
  const [tag, setTag] = useState("");
  const [picked, setPicked] = useState<Budget | null>(null);
  const [compose, setCompose] = useState(false);
  const all = query.data?.budgets ?? [];
  const demo = query.data?.demo_mode === true;
  const demoNote = demo ? (query.data?.note || "Demo mode: live Azure budget reads and writes are disabled.") : null;
  const rows = all.filter(b => (!status || (status === "attention" ? ["over", "near"].includes(budgetStatus(b)) : budgetStatus(b) === status))
    && (!currency || (b.currency || "__missing") === currency) && (!tag || b.tag_filter?.some(([k]) => k === tag))
    && [b.name, b.subscription, b.filter, ...(b.tag_filter ?? []).flat()].join(" ").toLowerCase().includes(q.trim().toLowerCase()));
  const columns = useMemo(() => {
    const h = columnHelper<Budget>();
    return [h.accessor("name", { header: "Budget", cell: c => <button className="truncate font-medium text-accent hover:underline" onClick={() => setPicked(c.row.original)}>{c.getValue()}</button>, meta: { width: "minmax(180px, 2fr)" } }),
      h.accessor("subscription", { header: "Subscription" }), h.accessor(b => budgetStatus(b), { id: "status", header: "State" }),
      h.accessor("amount", { header: "Native limit", cell: c => nativeMoney(c.getValue(), c.row.original.currency) }),
      h.accessor("current_spend", { header: "Azure spend", cell: c => nativeMoney(c.getValue(), c.row.original.currency) }),
      h.accessor("percent_used", { header: "Used", cell: c => c.getValue() == null ? "Unknown" : `${c.getValue()}%` }),
      h.accessor("time_grain", { header: "Period" })];
  }, []);
  const selected = picked ? all.find(b => b.name === picked.name && b.subscription_id === picked.subscription_id) : null;
  function refreshRead() { if (!refresh) setRefresh(true); else void query.refetch(); }
  return <div className="space-y-5"><PageHeader title="Budgets" subtitle="Azure-native limits and current-period counters. No display-currency conversion or global cost-month substitution." actions={<><GovernRefresh busy={query.isFetching} onClick={refreshRead} /><Button onClick={() => setCompose(v => !v)}><Plus />{compose ? "Hide draft" : "Draft budget"}</Button></>} />
    {demoNote && <GovernNotice warning>{demoNote}</GovernNotice>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><KpiTile label="Budgets read" value={query.isError ? "Unavailable" : query.isPending ? "…" : demo ? "Not in demo" : all.length} hint={demo ? "Live budget reads are disabled" : `${query.data?.subscriptions_read ?? "—"} of ${query.data?.subscriptions_requested ?? "—"} subscriptions read`} />
      <KpiTile label="Over budget" value={query.isError ? "Unavailable" : demo ? "—" : all.filter(b => budgetStatus(b) === "over").length} loading={query.isPending} /><KpiTile label="Near limit" value={query.isError ? "Unavailable" : demo ? "—" : all.filter(b => budgetStatus(b) === "near").length} loading={query.isPending} /><KpiTile label="Counter unavailable" value={query.isError ? "Unavailable" : demo ? "—" : all.filter(b => budgetStatus(b) === "unknown").length} loading={query.isPending} /></div>
    {query.data?.error || query.data?.partial ? <GovernNotice warning>{query.data.error || "Budget reads are incomplete."} An empty list does not prove there are no budgets.</GovernNotice> : null}
    {compose && <BudgetComposer scope={scope} existing={all} demo={demo} demoNote={demoNote} />}
    <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4"><GovernField label="Search budgets"><input type="search" className={governInput} value={q} onChange={e => setQ(e.target.value)} /></GovernField>
      <GovernSelect label="State" value={status} onChange={setStatus} options={["attention", "over", "near", "ok", "unknown"]} />
      <GovernSelect label="Native currency" value={currency} onChange={setCurrency} options={all.map(b => b.currency || "__missing")} />
      <GovernSelect label="Exact tag key" value={tag} onChange={setTag} options={all.flatMap(b => b.tag_filter?.map(([key]) => key) ?? [])} /></Card>
    {query.isError ? <GovernError error={query.error} retry={() => void query.refetch()} /> : query.isPending ? <GovernLoading /> : <DataTable data={rows} columns={columns} rowKey={b => `${b.subscription_id}:${b.name}`} height={390} empty={query.data?.partial || query.data?.error ? "Unavailable subscriptions may contain budgets. Retry the read." : demoNote || "No budgets match this scope and filters."} />}
    {selected && <Card className="space-y-4 p-5"><div className="flex items-center justify-between gap-2"><h3 className="font-semibold">{selected.name}</h3><Button onClick={() => setPicked(null)}>Close details</Button></div>
      <GovernLink url={budgetPortal(selected)} /><div className="grid gap-3 sm:grid-cols-3"><KpiTile label="Azure-reported spend" value={nativeMoney(selected.current_spend, selected.currency)} /><KpiTile label="Remaining" value={nativeMoney(selected.remaining, selected.currency)} /><KpiTile label="Usage" value={selected.percent_used == null ? "Unknown" : `${selected.percent_used}%`} /></div>
      {selected.percent_used != null && <div role="meter" aria-label={`${selected.name} usage`} aria-valuenow={selected.percent_used} aria-valuemin={0} aria-valuemax={Math.max(100, selected.percent_used)} className="h-2 overflow-hidden rounded-full bg-surface-2"><div className="h-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, selected.percent_used))}%` }} /></div>}
      <p className="text-sm text-muted">{selected.time_grain} reset · lifespan {selected.start || "unknown"} to {selected.end || "unknown"} · alerts {(selected.alerting ?? []).map(n => `${n}%`).join(", ") || "None reported"}</p>
      <p className="break-words text-sm">Filter: {selected.filter || "Whole subscription"}{selected.tag_filter?.map(([key, values]) => <span key={key} className="ml-2 inline-block rounded-lg bg-surface-2 px-2 py-1">{key}: {values.join(", ")}</span>)}</p>
      <BudgetHistory key={`${selected.subscription_id}:${selected.name}`} budget={selected} /></Card>}
    <GovernDetails title="How to interpret budget counters"><p>Amounts and percentages come from Azure, in the currency Azure reports. Unknown spend is not zero. Budgets alert; they do not automatically shut down services. Daily history uses the warehouse and only exact reproducible tag filters.</p></GovernDetails>
  </div>;
}
