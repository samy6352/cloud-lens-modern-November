import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { columnHelper, DataTable } from "@/components/DataTable";
import { KpiTile, PageHeader } from "@/components/blocks";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GovernDetails, GovernError, GovernField, GovernLink, GovernLoading, GovernNotice, GovernRefresh, GovernSelect, governInput } from "@/components/GovernControls";
import { esuQuery, globalScope, nativeMoney, subscriptionFromId, type EsuMachine } from "@/lib/govern-queries";

export function EsuPage() {
  const scope = globalScope(useSearch({ strict: false }));
  const [days, setDays] = useState("30");
  const query = useQuery(esuQuery(scope, Number(days)));
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [coverage, setCoverage] = useState("");
  const [kind, setKind] = useState("");
  const [region, setRegion] = useState("");
  const [subscription, setSubscription] = useState("");
  const [picked, setPicked] = useState<EsuMachine | null>(null);
  const all = query.data?.machines ?? [];
  const rows = all.filter(r => (!status || r.status === status) && (!coverage || r.covered === (coverage === "Covered")) && (!kind || r.kind === kind)
    && (!region || r.location === region) && (!subscription || subscriptionFromId(r.id) === subscription)
    && [r.name, r.id, r.product, r.detail, r.resource_group, r.coverage].join(" ").toLowerCase().includes(q.trim().toLowerCase()));
  const columns = useMemo(() => {
    const h = columnHelper<EsuMachine>();
    return [h.accessor("name", { header: "Machine", cell: c => <button className="truncate font-medium text-accent hover:underline" onClick={() => setPicked(c.row.original)}>{c.getValue()}</button>, meta: { width: "minmax(180px,2fr)" } }),
      h.accessor("product", { header: "Product" }), h.accessor("status", { header: "Lifecycle" }), h.accessor("support_ends", { header: "Support ended / ends" }),
      h.accessor("covered", { header: "ESU", cell: c => c.getValue() ? "Covered" : "Exposed" }), h.accessor("kind", { header: "Environment" }),
      h.accessor("monthly_esu_cost", { header: "Est. monthly", cell: c => nativeMoney(c.getValue(), c.row.original.kind === "Arc-connected server" ? "USD" : query.data?.currency) })];
  }, [query.data?.currency]);
  const data = query.data;
  const selected = picked ? all.find(r => r.id === picked.id) : null;
  return <div className="space-y-5"><PageHeader title="Extended Security Updates" subtitle="Windows and SQL lifecycle inventory, Azure entitlement and Arc licence evidence. Read-only; no licence purchases." actions={<GovernRefresh busy={query.isFetching} onClick={() => void query.refetch()} />} />
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><KpiTile label="Out of support" value={data?.out_of_support ?? "—"} /><KpiTile label="Ending soon" value={data?.ending_soon ?? "—"} /><KpiTile label="No ESU licence" value={data?.exposed ?? "—"} /><KpiTile label="Observed machines" value={data?.count ?? all.length} hint="Recognised Windows / SQL products only" /></div>
    <GovernNotice warning>Inventory queries can fail independently without the server exposing a per-query failure flag. Zero listed machines is not proof of complete coverage. Billing currency and retail USD estimates are separate; do not combine them.</GovernNotice>
    <div className="grid gap-3 sm:grid-cols-2"><KpiTile label="Estimated exposed Arc ESU / month" value={data?.priced && all.filter(m => !m.covered).every(m => m.monthly_esu_cost != null) ? nativeMoney(data.estimated_monthly_cost, "USD") : "Pricing unavailable / incomplete"} hint="Retail USD · Standard · 8-core floor · 730 h/month" /><KpiTile label="Billed ESU evidence" value={nativeMoney(data?.billed_esu, data?.currency)} hint="Retained billing data; endpoint does not bound this total to the selected lookback" /></div>
    <Card className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4"><GovernField label="Search machines"><input className={governInput} type="search" value={q} onChange={e => setQ(e.target.value)} /></GovernField>
      <GovernSelect label="Lifecycle" value={status} onChange={setStatus} options={all.map(r => r.status)} /><GovernSelect label="ESU coverage" value={coverage} onChange={setCoverage} options={["Covered", "Exposed"]} />
      <GovernSelect label="Environment" value={kind} onChange={setKind} options={all.map(r => r.kind)} /><GovernSelect label="Region" value={region} onChange={setRegion} options={all.map(r => r.location)} />
      <GovernSelect label="Subscription" value={subscription} onChange={setSubscription} options={all.map(r => subscriptionFromId(r.id))} /><GovernField label="Requested cost lookback"><select className={governInput} value={days} onChange={e => setDays(e.target.value)}>{["30", "60", "90"].map(d => <option key={d} value={d}>{d} days</option>)}</select></GovernField></Card>
    {query.isError ? <GovernError error={query.error} retry={() => void query.refetch()} /> : query.isPending ? <GovernLoading /> : data?.error ? <GovernNotice warning>{data.error}</GovernNotice> : <DataTable data={rows} columns={columns} rowKey={r => r.id} height={420} empty="No recognised lifecycle machines match these filters; inventory completeness is not guaranteed." />}
    {selected && <Card className="space-y-3 p-5"><div className="flex justify-between"><h3 className="font-semibold">{selected.name}</h3><Button onClick={() => setPicked(null)}>Close details</Button></div>
      <p>{selected.product} · {selected.detail}</p><p className="text-sm text-muted">{selected.kind} · {selected.resource_group} · {selected.location}</p>
      <p>Support date: {selected.support_ends} · {selected.days_remaining < 0 ? `${Math.abs(selected.days_remaining)} days past support` : `${selected.days_remaining} days remaining`}</p>
      <p>{selected.coverage}</p><p className="text-sm text-muted">Detected logical cores: {selected.cores ?? "Not supplied"} · Arc connection: {selected.connection || "Not applicable"}</p>
      {selected.kind === "Arc-connected server" && <GovernNotice>Licence assignment is observed evidence, not an entitlement audit. Estimated cost {nativeMoney(selected.monthly_esu_cost, "USD")} uses live retail pricing; unknown price is not free.</GovernNotice>}
      <GovernLink resourceId={selected.id} /><GovernLink url="https://learn.microsoft.com/en-us/windows-server/get-started/extended-security-updates-overview">Lifecycle and licence guidance</GovernLink></Card>}
    <GovernDetails title="Inventory, pricing and evidence limitations"><p>{data?.note}</p><p>Scanned: Azure VMs {data?.scanned?.vms ?? "unknown"}, Arc {data?.scanned?.arc ?? "unknown"}, SQL {data?.scanned?.sql ?? "unknown"}. Source queries cap each inventory at 500 rows. Recognised images only; unrecognised custom OS images are not assessed. Covered Azure VMs have server-reported zero incremental ESU cost; this is not zero compute cost.</p><p>ESU billing lookup failures can be returned as zero by the existing server. Verify invoice evidence before treating it as no charges. Estimates are retail USD, even where observed billing is in another currency.</p></GovernDetails>
  </div>;
}
