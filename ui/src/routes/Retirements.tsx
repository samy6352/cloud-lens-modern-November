import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { columnHelper, DataTable } from "@/components/DataTable";
import { EvidencePanel, FilterBar, KpiTile, PageHeader } from "@/components/blocks";
import { evidenceDate, GovernDetails, GovernError, GovernField, GovernLink, GovernLoading, GovernNotice, GovernRefresh, GovernSelect, governInput } from "@/components/GovernControls";
import { globalScope, retirementsQuery, urgency, type Advisory } from "@/lib/govern-queries";

export function RetirementsPage() {
  const scope = globalScope(useSearch({ strict: false }));
  const query = useQuery(retirementsQuery(scope));
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [priority, setPriority] = useState("");
  const [subscription, setSubscription] = useState("");
  const [picked, setPicked] = useState<Advisory | null>(null);
  const all = query.data?.advisories ?? [];
  const rows = all.filter(a => (!kind || (a.retirement ? "Retirement" : a.level || "Advisory") === kind) &&
    (!priority || urgency(a) === priority) && (!subscription || a.subscriptionId === subscription) &&
    [a.headline, a.tracking, a.summary, a.actions, ...a.resources.map(r => r.name)].join(" ").toLowerCase().includes(q.trim().toLowerCase()));
  const columns = useMemo(() => {
    const h = columnHelper<Advisory>();
    return [h.accessor("headline", { header: "Advisory", cell: c => <button className="truncate text-left font-medium text-accent hover:underline" onClick={() => setPicked(c.row.original)}>{c.getValue()}</button>, meta: { width: "minmax(280px,3fr)" } }),
      h.accessor(a => a.retirement ? "Retirement" : a.level || "Advisory", { id: "kind", header: "Kind" }),
      h.accessor(a => a.days_left ?? Number.MAX_SAFE_INTEGER, { id: "urgency", header: "Urgency", cell: c => <span className={c.row.original.overdue ? "text-bad" : ""}>{urgency(c.row.original)}</span> }),
      h.accessor("due", { header: "Deadline", cell: c => c.getValue() || "Not supplied" }), h.accessor("resource_count", { header: "Observed resources" }),
      h.accessor("tracking", { header: "Tracking" })];
  }, []);
  const data = query.data;
  const selected = picked ? all.find(a => a.tracking === picked.tracking) : null;
  return <div className="space-y-5"><PageHeader title="Retirements & required migrations" subtitle="Active Azure Service Health advisories, ordered by deadline. Overdue is not a negative countdown." actions={<GovernRefresh busy={query.isFetching} onClick={() => void query.refetch()} />} />
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><KpiTile label="Active advisories" value={data?.counts?.active ?? "—"} /><KpiTile label="Retirements" value={data?.counts?.retirements ?? "—"} /><KpiTile label="Due within 90 days" value={data?.counts?.due_90_days ?? "—"} hint={`Next deadline: ${data?.next_deadline || "Not supplied"}`} /><KpiTile label="Past deadline" value={data?.counts?.overdue ?? "—"} /></div>
    <FilterBar title="Prioritise advisories" summary={`${rows.length} of ${all.length} loaded advisories`} active={!!q || !!kind || !!priority || !!subscription} onReset={() => { setQ(""); setKind(""); setPriority(""); setSubscription(""); }}><GovernField label="Search advisories"><input type="search" className={governInput} value={q} onChange={e => setQ(e.target.value)} /></GovernField>
      <GovernSelect label="Kind" value={kind} onChange={setKind} options={all.map(a => a.retirement ? "Retirement" : a.level || "Advisory")} />
      <GovernSelect label="Urgency" value={priority} onChange={setPriority} options={["Overdue", "Due in 30 days", "Due in 90 days", "Later", "No deadline"]} />
      <GovernSelect label="Subscription" value={subscription} onChange={setSubscription} options={all.map(a => a.subscriptionId || "").filter(Boolean)} /></FilterBar>
    {query.isError ? <GovernError error={query.error} retry={() => void query.refetch()} /> : query.isPending ? <GovernLoading /> : data?.error ? <GovernNotice warning>{data.error}</GovernNotice> :
      <DataTable data={rows} columns={columns} rowKey={r => r.tracking} initialSort={{ id: "urgency", desc: false }} height={390} empty={data?.reason || "No active advisories match this scope and filters. This is not a general service-health guarantee."} />}
    {selected && <EvidencePanel key={selected.tracking} title={selected.headline} onClose={() => setPicked(null)}>
      <p className="text-sm text-muted">{selected.tracking} · {urgency(selected)} · {selected.due || "No deadline"}</p><p>{selected.summary || "No summary supplied."}</p><p><strong>Recommended action:</strong> {selected.actions || "Review the Azure advisory."}</p>
      <p className="text-sm text-muted">Started {evidenceDate(selected.started)} · updated {evidenceDate(selected.updated)}</p>
      {selected.subscriptionId && <GovernLink url={`https://portal.azure.com/#view/Microsoft_Azure_Health/EventDetailsBlade/eventTrackingId/${encodeURIComponent(selected.tracking)}/subscriptionId/${encodeURIComponent(selected.subscriptionId)}`} />}
      <div className="space-y-2">{selected.resources.map((r, i) => <div key={r.id || `${r.name}:${i}`} className="flex flex-wrap justify-between gap-2 text-sm"><span>{r.name || r.id || "Unnamed resource"}</span><GovernLink resourceId={r.id} /></div>)}</div>
      {!selected.resources.length && <GovernNotice>No individual resources supplied; the advisory may apply to the subscription, not no impact.</GovernNotice>}
      {selected.resource_count > selected.resources.length && <GovernNotice warning>Showing {selected.resources.length} of {selected.resource_count} observed resources.</GovernNotice>}</EvidencePanel>}
    <section aria-label="Upcoming action timeline" className="space-y-3"><h3 className="font-semibold">Action timeline</h3>{rows.slice().sort((a, b) => (a.days_left ?? Infinity) - (b.days_left ?? Infinity)).slice(0, 8).map(a =>
      <button key={a.tracking} onClick={() => setPicked(a)} className="flex w-full gap-4 rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:bg-surface-2"><span className={`mt-1 size-2 shrink-0 rounded-full ${a.overdue ? "bg-bad" : "bg-accent"}`} /><span className="min-w-0"><span className="text-xs font-medium text-muted">{a.due || "Undated"} · {urgency(a)}</span><span className="mt-1 block font-medium">{a.headline}</span><span className="mt-1 block text-sm text-muted">{a.actions || "Review the advisory in Azure."}</span></span></button>)}</section>
    <GovernDetails title="Source and coverage"><p>{data?.note}</p><p>Results are deduplicated by tracking ID across subscriptions by the existing endpoint; the retained subscription field is not a complete affected-subscription list. Resource counts can be unavailable or capped. Dates and global cost-month selection do not change the active advisory feed.</p></GovernDetails>
  </div>;
}
