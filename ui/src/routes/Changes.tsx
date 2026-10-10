import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { columnHelper, DataTable } from "@/components/DataTable";
import { EvidencePanel, FilterBar, KpiTile, PageHeader } from "@/components/blocks";
import { evidenceDate, evidenceValue, GovernDetails, GovernError, GovernField, GovernLink, GovernLoading, GovernNotice, GovernRefresh, GovernSelect, governInput } from "@/components/GovernControls";
import { changesQuery, explicitScopes, globalScope, nativeMoney, type ChangeRecord } from "@/lib/govern-queries";

export function ChangesPage() {
  const scope = globalScope(useSearch({ strict: false }));
  const scopes = explicitScopes(scope.scope);
  const [days, setDays] = useState("7");
  const query = useQuery(changesQuery(scope, Number(days)));
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [actor, setActor] = useState("");
  const [change, setChange] = useState("");
  const [group, setGroup] = useState("");
  const [currency, setCurrency] = useState("");
  const [cost, setCost] = useState("");
  const [picked, setPicked] = useState<ChangeRecord | null>(null);
  const all = query.data?.changes ?? [];
  const groupOf = (r: ChangeRecord) => r.resource_id.match(/\/resourceGroups\/([^/]+)/i)?.[1] || "__missing";
  const rows = all.filter(r => (!type || r.resource_type === type) && (!actor || (r.actor || "__missing") === actor) && (!change || r.change_type === change)
    && (!group || groupOf(r) === group) && (!currency || r.cost?.by_currency.some(c => c.currency === currency))
    && (!cost || (cost === "Recorded" ? r.cost?.by_currency.some(c => c.cost != null) : cost === "Positive" ? r.cost?.by_currency.some(c => c.cost != null && c.cost > 0)
      : cost === "Zero" ? r.cost?.by_currency.length && r.cost.by_currency.every(c => c.cost === 0) : !r.cost?.by_currency.some(c => c.cost != null)))
    && [r.resource_name, r.resource_id, r.resource_type, r.actor, r.operation, r.change_type, ...r.properties.flatMap(p => [p.name, evidenceValue(p.before), evidenceValue(p.after)])].join(" ").toLowerCase().includes(q.trim().toLowerCase()));
  const columns = useMemo(() => {
    const h = columnHelper<ChangeRecord>();
    return [h.accessor("changed_at", { header: "Changed at", cell: c => evidenceDate(c.getValue()), meta: { width: "minmax(190px,1.2fr)" } }),
      h.accessor("resource_name", { header: "Resource", cell: c => <button className="truncate font-medium text-accent hover:underline" onClick={() => setPicked(c.row.original)}>{c.getValue()}</button>, meta: { width: "minmax(200px,2fr)" } }),
      h.accessor("change_type", { header: "Change" }), h.accessor("actor", { header: "Actor", cell: c => c.getValue() || "Not supplied" }),
      h.accessor("operation", { header: "RBAC action", cell: c => c.getValue() || "Not supplied", meta: { width: "minmax(210px,2fr)" } }),
      h.accessor(r => r.cost?.by_currency.map(c => nativeMoney(c.cost, c.currency)).join(" · ") || "No billing rows", { id: "cost", header: "Window billed cost", meta: { width: "minmax(180px,1.3fr)" } })];
  }, []);
  const data = query.data;
  const selected = picked ? all.find(r => r.id === picked.id) : null;
  return <div className="space-y-5"><PageHeader title="Change Analysis" subtitle="Read-only Azure Resource Graph changes with bounded billing context. The cost month selector does not apply." actions={<GovernRefresh busy={query.isFetching} disabled={!scopes.length} onClick={() => { if (scopes.length) void query.refetch(); }} />} />
    {!scopes.length ? <GovernNotice warning>Select between 1 and 100 explicit subscription UUIDs in the global scope selector. “All subscriptions” is not expanded for this page; no request has been sent.</GovernNotice> : <>
      <GovernNotice>Reading {scopes.length} explicitly selected subscription(s). Window: {data?.window ? `${evidenceDate(data.window.start)} to ${evidenceDate(data.window.end)}` : `last ${days} days`} · retrieved {evidenceDate(data?.generated_at)}. Resource changes are retained for at most 14 days.</GovernNotice>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><KpiTile label="Changes returned" value={data?.status === "unavailable" || query.isError ? "Unavailable" : all.length} hint={data?.truncated ? "Partial results" : "Within selected live window"} />
        <KpiTile label="Distinct resources" value={new Set(all.map(r => r.resource_id)).size} /><KpiTile label="Recorded actors" value={new Set(all.map(r => r.actor).filter(Boolean)).size} /><KpiTile label="With billed context" value={all.filter(r => r.cost?.by_currency.some(c => c.cost != null)).length} hint="Not evidence that a change caused spend" /></div>
      <FilterBar title="Inspect changes" summary={`${rows.length} of ${all.length} loaded changes`} active={!!q || !!type || !!actor || !!change || !!group || !!currency || !!cost} onReset={() => { setQ(""); setType(""); setActor(""); setChange(""); setGroup(""); setCurrency(""); setCost(""); }}><GovernField label="Search resource, actor or property"><input className={governInput} type="search" value={q} onChange={e => setQ(e.target.value)} /></GovernField>
        <GovernField label="Live lookback"><select className={governInput} value={days} onChange={e => { setDays(e.target.value); setPicked(null); }}>{["1", "3", "7", "14"].map(d => <option key={d} value={d}>{d} days</option>)}</select></GovernField>
        <GovernSelect label="Resource type" value={type} onChange={setType} options={all.map(r => r.resource_type)} /><GovernSelect label="Change type" value={change} onChange={setChange} options={all.map(r => r.change_type)} />
        <GovernSelect label="Actor" value={actor} onChange={setActor} options={all.map(r => r.actor || "__missing")} /><GovernSelect label="Resource group" value={group} onChange={setGroup} options={all.map(groupOf)} />
        <GovernSelect label="Billing currency" value={currency} onChange={setCurrency} options={all.flatMap(r => r.cost?.by_currency.map(c => c.currency) ?? [])} /><GovernSelect label="Billed context" value={cost} onChange={setCost} options={["Recorded", "Positive", "Zero", "Missing"]} /></FilterBar>
      {query.isError ? <GovernError error={query.error} retry={() => void query.refetch()} /> : query.isPending ? <GovernLoading /> : data?.status === "unavailable" ?
        <GovernNotice warning>Change source unavailable: {data.error || data.notices?.join(" ") || "No observation could be established."} This is not an empty change history.</GovernNotice> :
        <DataTable data={rows} columns={columns} rowKey={r => r.id} height={430} initialSort={{ id: "changed_at", desc: true }} empty="No changes returned for the selected subscriptions, live window and filters." />}
      {(data?.notices ?? []).map((n, i) => <GovernNotice key={i} warning={data?.status === "partial" && /partial|limited|truncat/i.test(n)}>{n}</GovernNotice>)}
      {selected && <EvidencePanel key={selected.id} title={`${selected.resource_name} · ${selected.change_type}`} onClose={() => setPicked(null)}>
        <div className="grid gap-3 text-sm sm:grid-cols-2"><p>Changed {evidenceDate(selected.changed_at)}</p><p>Actor: {selected.actor || "Not supplied"}</p><p className="break-all">Operation: {selected.operation || "Not supplied"}</p><p className="break-all">Subscription: {selected.subscription_id}</p></div>
        <GovernLink resourceId={selected.resource_id} /><p className="break-all text-xs text-muted">{selected.resource_id}</p>
        <h4 className="font-medium">Allowlisted property evidence</h4>{selected.properties.length ? selected.properties.map((p, i) => <div className="rounded-lg border border-border p-3" key={`${p.name}:${i}`}><h5 className="break-all text-sm font-medium">{p.name}</h5><div className="mt-2 grid gap-3 sm:grid-cols-2"><div className="min-w-0"><div className="text-xs text-muted">Before</div><pre className="whitespace-pre-wrap break-all text-sm">{evidenceValue(p.before)}</pre></div><div className="min-w-0"><div className="text-xs text-muted">After</div><pre className="whitespace-pre-wrap break-all text-sm">{evidenceValue(p.after)}</pre></div></div></div>) : <GovernNotice>No allowlisted property values returned. Sensitive or unsupported properties are not exposed.</GovernNotice>}
        {selected.properties_truncated && <GovernNotice warning>Property evidence is truncated.</GovernNotice>}
        <p className="text-sm">Billed context: {selected.cost?.by_currency.map(c => nativeMoney(c.cost, c.currency)).join(" · ") || "No billing rows in the evidence window"} · {selected.cost?.from || "—"} to {selected.cost?.to || "—"}</p></EvidencePanel>}
    </>}
    <GovernDetails title="What change evidence does and does not prove"><p>Operation is the recorded RBAC authorization action, not necessarily a user-facing deployment command. Actors may not be supplied. Only allowlisted infrastructure properties are shown. Cost uses billed calendar dates and keeps currencies separate; temporal proximity does not establish causality. There are no rollback or deployment actions.</p></GovernDetails>
  </div>;
}
