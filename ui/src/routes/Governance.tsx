import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Chart } from "@/components/Chart";
import { columnHelper, DataTable } from "@/components/DataTable";
import { KpiTile, PageHeader } from "@/components/blocks";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GovernDetails, GovernError, GovernField, GovernLink, GovernLoading, GovernNotice, GovernRefresh, GovernSelect, governInput } from "@/components/GovernControls";
import { globalScope, governanceFindings, governanceQuery, nativeMoney, type GovernanceFinding, type GovernanceReport, type GovernResource } from "@/lib/govern-queries";

const nic = columnHelper<GovernResource>();
const nicColumns = [
  nic.accessor("vmName", { header: "Virtual machine", cell: c => <GovernLink resourceId={c.row.original.vmId}>{c.getValue() || "Open VM"}</GovernLink>, meta: { width: "minmax(160px,1.3fr)" } }),
  nic.accessor("nicName", { header: "Network interface", cell: c => <GovernLink resourceId={c.row.original.nicId}>{c.getValue() || "Open NIC"}</GovernLink>, meta: { width: "minmax(160px,1.3fr)" } }),
  nic.accessor("vmSize", { header: "VM size" }),
  nic.accessor("powerState", { header: "Power state", cell: c => c.getValue() || "Not reported" }),
  nic.accessor("resourceGroup", { header: "Resource group" }),
  nic.accessor("location", { header: "Region" }),
];

function NetworkingCandidates({ report }: { report: GovernanceReport["accelerated_networking"] }) {
  const rows = (report.catalogue ? report.eligible ?? [] : []).filter(row => row.nicId && row.vmId);
  const count = report.eligible_count ?? rows.length;
  return <Card>
    <CardHeader title="Accelerated Networking candidates" subtitle="Attached NICs with Accelerated Networking off and verified Azure VM-size support." />
    <CardBody className="space-y-3">
      {rows.length > 0 && <DataTable data={rows} columns={nicColumns} rowKey={r => r.nicId ?? ""} height={Math.min(360, 56 + rows.length * 52)} />}
      {!rows.length && !(report.error || report.reason) && <p className="text-sm text-muted">{report.unverified ? "No candidates could be confirmed from the available evidence." : "No eligible interfaces found in the scanned inventory."}</p>}
      {!!report.unverified && <GovernNotice warning>{report.unverified} interfaces could not be verified and are excluded.</GovernNotice>}
      {report.truncated && <GovernNotice warning>Showing {rows.length} of {count} verified candidates in the scanned inventory. Narrow the subscription scope if the inventory is incomplete.</GovernNotice>}
      <p className="text-sm text-muted">Verify guest OS and driver support and plan downtime before enabling this in Azure. The VM must be deallocated first; CloudLens does not change it.</p>
    </CardBody>
  </Card>;
}

export function GovernancePage() {
  const scope = globalScope(useSearch({ strict: false }));
  const [days, setDays] = useState("30");
  const query = useQuery(governanceQuery(scope, Number(days)));
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [severity, setSeverity] = useState("");
  const [subscription, setSubscription] = useState("");
  const [group, setGroup] = useState("");
  const [region, setRegion] = useState("");
  const [type, setType] = useState("");
  const [picked, setPicked] = useState<GovernanceFinding | null>(null);
  const all = query.data ? governanceFindings(query.data) : [];
  const rows = all.filter(r => (!category || r.category === category) && (!severity || r.severity === severity) &&
    (!subscription || r.subscription === subscription) && (!group || (r.group || "__missing") === group) &&
    (!region || (r.region || "__missing") === region) && (!type || r.resourceType.toLowerCase() === type.toLowerCase()) && [r.resource, r.resourceId, r.evidence, r.group].join(" ").toLowerCase().includes(q.trim().toLowerCase()));
  const [view, setView] = useState("Resource");
  const groups = [...new Set(rows.map(r => view === "Severity" ? r.severity : view === "Resource group" ? r.group || "Not supplied" : r.category))];
  const columns = useMemo(() => {
    const h = columnHelper<GovernanceFinding>();
    return [h.accessor("resource", { header: "Resource", cell: c => <button className="truncate text-left font-medium text-accent hover:underline" onClick={() => setPicked(c.row.original)}>{c.getValue()}</button>, meta: { width: "minmax(200px,2fr)" } }),
      h.accessor("category", { header: "Finding" }), h.accessor("severity", { header: "Review priority" }), h.accessor("group", { header: "Resource group" }),
      h.accessor("region", { header: "Region" }), h.accessor("cost", { header: "Billed cost", cell: c => nativeMoney(c.getValue(), c.row.original.currency) })];
  }, []);
  const data = query.data;
  const typeRows = data?.tagging.by_type ?? [];
  const selected = picked ? all.find(r => r.id === picked.id) : null;
  return <div className="space-y-5"><PageHeader title="Governance" subtitle="Read-only configuration findings: tag allocation, network eligibility and empty groups. This endpoint does not evaluate Azure Policy compliance." actions={<GovernRefresh busy={query.isFetching} onClick={() => void query.refetch()} />} />
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><KpiTile label="Tag coverage" value={data?.tagging.coverage_pct == null ? "Unavailable" : `${data.tagging.coverage_pct}%`} hint={`${data?.tagging.scanned?.tagged ?? "—"} of ${data?.tagging.scanned?.resources ?? "—"} taggable`} />
      <KpiTile label="Untagged inventory" value={data?.tagging.error ? "Unavailable" : data?.tagging.untagged_total ?? "—"} hint="Finding list contains billed resources only" />
      <KpiTile label="Networking candidates" value={data?.accelerated_networking.error || data?.accelerated_networking.reason ? "Unavailable" : data?.accelerated_networking.eligible_count ?? "—"} hint="Off on a supported VM size" />
      <KpiTile label="Empty groups listed" value={data?.orphaned_resource_groups.error ? "Unavailable" : data?.orphaned_resource_groups.groups?.length ?? "—"} hint={data?.orphaned_resource_groups.truncated ? "Partial inventory" : "Roles and locks not checked"} /></div>
    {data && [data.tagging, data.accelerated_networking, data.orphaned_resource_groups].map((section, i) => section.error || section.reason ? <GovernNotice key={i} warning>{["Tag coverage", "Accelerated networking", "Empty resource groups"][i]}: {section.error || section.reason}</GovernNotice> : null)}
    {data && <NetworkingCandidates report={data.accelerated_networking} />}
    <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4"><GovernField label="Search findings"><input className={governInput} type="search" value={q} onChange={e => setQ(e.target.value)} /></GovernField>
      <GovernSelect label="Finding" value={category} onChange={setCategory} options={all.map(r => r.category)} />
      <GovernSelect label="Review priority" value={severity} onChange={setSeverity} options={all.map(r => r.severity)} />
      <GovernSelect label="Subscription sub-scope" value={subscription} onChange={setSubscription} options={all.map(r => r.subscription).filter(Boolean)} />
      <GovernSelect label="Resource group" value={group} onChange={setGroup} options={all.map(r => r.group || "__missing")} />
      <GovernSelect label="Region" value={region} onChange={setRegion} options={all.map(r => r.region || "__missing")} />
      <GovernSelect label="Resource type" value={type} onChange={setType} options={all.map(r => r.resourceType)} />
      <GovernField label="Cost lookback"><select className={governInput} value={days} onChange={e => setDays(e.target.value)}>{["30", "60", "90"].map(d => <option key={d} value={d}>{d} days</option>)}</select></GovernField>
      <GovernField label="Group findings"><select className={governInput} value={view} onChange={e => setView(e.target.value)}>{["Resource", "Severity", "Resource group", "Finding"].map(v => <option key={v}>{v}</option>)}</select></GovernField>
    </Card>
    {query.isError ? <GovernError error={query.error} retry={() => void query.refetch()} /> : query.isPending ? <GovernLoading /> : view === "Resource" ?
      <DataTable data={rows} columns={columns} rowKey={r => r.id} height={410} empty="No findings match these filters. Check independent source warnings before concluding compliance." /> :
      <div className="space-y-4">{groups.length ? groups.map(g => <GovernDetails key={g} title={`${g} · ${rows.filter(r => (view === "Severity" ? r.severity : view === "Resource group" ? r.group || "Not supplied" : r.category) === g).length} findings`}>
        <DataTable data={rows.filter(r => (view === "Severity" ? r.severity : view === "Resource group" ? r.group || "Not supplied" : r.category) === g)} columns={columns} rowKey={r => r.id} height={260} /></GovernDetails>) : <GovernNotice>No findings match these filters.</GovernNotice>}</div>}
    {selected && <Card className="space-y-3 p-5"><div className="flex items-start justify-between"><h3 className="font-semibold">{selected.resource}</h3><Button onClick={() => setPicked(null)}>Close details</Button></div>
      <p className="text-sm text-muted">{selected.category} · {selected.severity} · {selected.subscription}</p><p>{selected.evidence}</p><p className="break-all text-xs text-muted">{selected.resourceId}</p>
      <GovernLink resourceId={selected.resourceId} /><p className="text-sm">Billed context over {days} days: {nativeMoney(selected.cost, selected.currency)}. Never add different currencies.</p></Card>}
    {typeRows.length > 0 && <div className="grid gap-4 lg:grid-cols-2"><Card className="p-5"><h3 className="mb-3 font-semibold">Untagged resources by type</h3><Chart height={280} onClick={p => { const picked = typeRows.find(r => r.type === p.name); if (picked) { setCategory("Tag coverage"); setType(picked.full_type); } }} option={{
      tooltip: { trigger: "axis", renderMode: "richText" }, grid: { left: 130, right: 20, top: 15, bottom: 30 }, xAxis: { type: "value" }, yAxis: { type: "category", data: typeRows.slice(0, 10).map(r => r.type), inverse: true },
      series: [{ type: "bar", data: typeRows.slice(0, 10).map(r => r.untagged), barMaxWidth: 22 }],
    }} /><div className="mt-3 space-y-2">{typeRows.slice(0, 10).map(r => <button key={r.full_type} onClick={() => { setCategory("Tag coverage"); setType(r.full_type); }} className="flex w-full justify-between gap-3 text-left text-xs hover:text-accent"><span>{r.type}</span><span>{r.coverage_pct == null ? "Unknown coverage" : `${r.coverage_pct}% tagged`} · {r.untagged} untagged</span></button>)}</div></Card><Card className="p-5"><h3 className="mb-3 font-semibold">Existing tag conventions</h3><div className="space-y-3">{(data?.tagging.tag_keys ?? []).map(k => <div className="flex justify-between border-b border-border pb-2 text-sm" key={k.key}><span>{k.key}</span><span className="num text-muted">{k.count} resources</span></div>)}</div></Card></div>}
    <GovernDetails title="Evidence and remediation caveats"><p>{data?.tagging.note}</p><p>{data?.accelerated_networking.note}</p><p>{data?.orphaned_resource_groups.note}</p><p>The review-priority labels are local triage labels, not Azure Policy severity. Open the resource and verify its actual configuration before remediation. No configuration changes or deletions are available here.</p></GovernDetails>
  </div>;
}
