import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { columnHelper, DataTable } from "@/components/DataTable";
import { ErrorState, PageHeader } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { meQuery } from "@/lib/queries";
import { auditQuery, type AuditEntry } from "@/lib/admin-report-queries";
import { AdminField, adminInput } from "@/lib/helpersAdmin";

export function AuditPage() {
  const me = useQuery(meQuery);
  const [limit, setLimit] = useState(200);
  const entries = useQuery(auditQuery(limit, me.data?.user?.admin === true));
  const [actor, setActor] = useState("");
  const [route, setRoute] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const rows = useMemo(() => (entries.data?.entries ?? []).map((entry, index) => ({ ...entry, rowId: `${entry.at}:${index}` })).filter(e => `${e.user} ${e.email ?? ""}`.toLowerCase().includes(actor.toLowerCase()) && e.tab.toLowerCase().includes(route.toLowerCase()) && (!from || e.at.slice(0, 10) >= from) && (!to || e.at.slice(0, 10) <= to)), [entries.data, actor, route, from, to]);
  const columns = useMemo(() => {
    const h = columnHelper<AuditEntry>();
    return [
      h.accessor("at", { header: "When (server timestamp)", meta: { width: "minmax(190px,1fr)" } }),
      h.accessor("user", { header: "Actor", cell: c => <div><div>{c.getValue()}</div><div className="text-xs text-muted">{c.row.original.email ?? "No email recorded"}</div></div>, meta: { width: "minmax(220px,1.4fr)" } }),
      h.accessor("tab", { header: "Route / tab", meta: { width: "minmax(200px,1.2fr)" } }),
      h.accessor("source", { header: "Identity source" }),
      h.accessor("admin", { header: "Role", cell: c => c.getValue() ? "Administrator" : "Member" }),
    ];
  }, []);
  return <><PageHeader title="Audit" subtitle="Read-only access history across all accounts. Subscription filters do not apply to records about people." actions={<Button disabled={!me.data?.user?.admin || entries.isFetching} onClick={() => void entries.refetch()}>Refresh log</Button>} />
    {me.isError ? <ErrorState error={me.error} onRetry={() => void me.refetch()} /> : me.isPending ? <p role="status">Checking administrator access…</p> : !me.data?.user?.admin ? <Card><CardBody><p role="alert">403 — Administrator access is required to view the audit log. No audit records have been requested.</p></CardBody></Card> : <>
      <Card className="mb-5"><CardHeader title="Search recent activity" subtitle="Filters apply to the newest loaded records, not the entire lifetime log." /><CardBody><div className="grid gap-4 sm:grid-cols-5">
        <AdminField label="Actor or email"><input className={adminInput} value={actor} onChange={e => setActor(e.target.value)} /></AdminField>
        <AdminField label="Route or tab"><input className={adminInput} value={route} onChange={e => setRoute(e.target.value)} /></AdminField>
        <AdminField label="From date"><input type="date" className={adminInput} value={from} onChange={e => setFrom(e.target.value)} /></AdminField>
        <AdminField label="Through date"><input type="date" className={adminInput} value={to} onChange={e => setTo(e.target.value)} /></AdminField>
        <AdminField label="Recent record limit"><select className={adminInput} value={limit} onChange={e => setLimit(Number(e.target.value))}>{[100, 200, 500].map(n => <option key={n}>{n}</option>)}</select></AdminField>
      </div>{from && to && from > to && <p role="alert" className="mt-3 text-warn">The start date must be on or before the end date.</p>}</CardBody></Card>
      {entries.isError ? <ErrorState error={entries.error} onRetry={() => void entries.refetch()} /> : <Card><CardHeader title="Access records" subtitle={`${rows.length} matching / ${entries.data?.count ?? 0} recent records. Viewing this page does not change the log.`} /><DataTable data={rows} columns={columns} rowKey={r => r.rowId} initialSort={{ id: "at", desc: true }} busy={entries.isFetching} empty={entries.isPending ? "Loading access records…" : "No access records match these filters."} /></Card>}
    </>}
  </>;
}
