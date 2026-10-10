import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { ErrorState, PageHeader } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { api } from "@/lib/api";
import { periodParam } from "@/lib/period";
import { meQuery, type Scope } from "@/lib/queries";
import { AdminChecks, AdminConfirm, AdminField, adminInput } from "@/lib/helpersAdmin";
import { ApprovalSession, catalogQuery, costStatusQuery, postAdmin, rawDownloadHref, rawParams, reportDownloadHref, reportOptionsQuery, type ArchiveCatalog, type RawSelection, type ReportSelection, type Warehouse } from "@/lib/admin-report-queries";

const BLOCKS: Record<string, string> = { trend: "Daily trend", services: "By service", regions: "By region", resources: "Top resources" };
type Content = Pick<ReportSelection, "summary" | "sections" | "blocks" | "live">;

export function ReportsPage() {
  const search = useSearch({ strict: false });
  const scope: Scope = { month: search.month, from: search.from, to: search.to, scope: search.scope };
  const [days, setDays] = useState(30);
  const [currency, setCurrency] = useState("");
  const options = useQuery(reportOptionsQuery(scope, days, currency));
  const currencies = useQuery({ queryKey: ["admin-report-currencies"], queryFn: ({ signal }) => api<{ supported: string[]; source: string; as_of?: string }>("currency", undefined, { signal }), staleTime: 300_000 });
  const catalog = useQuery(catalogQuery);
  const archive = useQuery({ queryKey: ["admin-report-archive"], queryFn: ({ signal }) => api<ArchiveCatalog>("archive", { limit: 200 }, { signal }) });
  const me = useQuery(meQuery);
  const context = JSON.stringify([scope, days, currency]);
  const [choice, setChoice] = useState<{ key: string; value: Content } | null>(null);
  const content: Content = choice?.key === context ? choice.value : { summary: true, sections: options.data?.areas.map(a => a.id) ?? [], blocks: options.data?.blocks ?? [], live: [] };
  const update = (patch: Partial<Content>) => setChoice({ key: context, value: { ...content, ...patch } });
  const [format, setFormat] = useState("xlsx");
  const [rawScope, setRawScope] = useState<string[] | null>(null);
  const selected = rawScope ?? catalog.data?.subscriptions.filter(s => !scope.scope || scope.scope.split(",").includes(s.id)).map(s => s.id) ?? [];
  useEffect(() => {
    if (!catalog.data) return;
    const allowed = catalog.data.subscriptions.map(s => s.id);
    setRawScope(previous => previous === null ? allowed.filter(id => !scope.scope || scope.scope.split(",").includes(id)) : previous.filter(id => allowed.includes(id)));
  }, [catalog.data]);
  const rawStatus = useQuery(costStatusQuery(selected));
  const warehouse = useQuery({ queryKey: ["admin-report-warehouse", selected.join(",")], enabled: !!selected.length, queryFn: ({ signal }) => api<Warehouse>("warehouse", { scope: selected }, { signal }) });
  const [since, setSince] = useState<string | null>(null);
  const [until, setUntil] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [dataset, setDataset] = useState("actual");
  const [rawFormat, setRawFormat] = useState("csv");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [storageReview, setStorageReview] = useState<RawSelection | null>(null);
  const session = useRef(new ApprovalSession());
  const raw: RawSelection = { scope: selected, fmt: rawFormat, since: since ?? warehouse.data?.from ?? "", until: until ?? warehouse.data?.to ?? "", source, dataset, label };
  const fingerprint = JSON.stringify([context, content, format, raw]);
  useEffect(() => {
    const current = session.current;
    current.cancel(); setBusy(false); setStorageReview(null); setError(null);
    return () => current.cancel();
  }, [fingerprint]);
  const report: ReportSelection = { ...content, sections: content.sections.filter(id => options.data?.areas.some(a => a.id === id)), format, days, period_month: periodParam(scope), scope: scope.scope?.split(",").filter(Boolean) ?? [], currency };
  let reportHref: string | undefined;
  let rawHref: string | undefined;
  let rawReason = "";
  try { reportHref = reportDownloadHref(report); } catch { /* Server format options may still be loading. */ }
  try { rawHref = rawDownloadHref(raw); } catch (e) { rawReason = e instanceof Error ? e.message : "Choose a valid raw export selection."; }
  const reportDisabled = busy || options.isPending || !options.data?.formats.some(f => f.id === format) || (!content.summary && !report.sections.length && !content.live.length) || !reportHref;
  const reportReason = busy ? "Wait for the storage write to finish." : options.isPending ? "Loading report options." : !reportHref || !options.data?.formats.some(f => f.id === format) ? "Choose a supported report format." : !content.summary && !report.sections.length && !content.live.length ? "Select a summary, cost area or live finding before downloading." : "";
  const reviewStorage = () => {
    try { rawParams(raw); setError(null); setStorageReview({ ...raw, scope: [...raw.scope] }); }
    catch (e) { setError(e); }
  };
  const saveStorage = async () => {
    if (!storageReview || JSON.stringify(storageReview) !== JSON.stringify(raw)) return;
    setBusy(true); setError(null);
    try {
      const saved = await session.current.run(signal => postAdmin<{ name: string; rows: number; account: string; container: string }>("archive/export", {}, signal, rawParams(storageReview)));
      if (saved) { setNotice(`Saved ${saved.rows} rows to ${saved.account}/${saved.container}/${saved.name}. The daily archive is unchanged.`); setStorageReview(null); setBusy(false); }
    } catch (e) { setError(e); setBusy(false); }
  };
  const canSave = !!archive.data?.enabled && rawStatus.data?.read_only === false && !rawStatus.isError && !!me.data?.authenticated;
  const saveReason = rawStatus.data?.read_only ? "This deployment is read-only; local downloads remain available." : !archive.data?.enabled ? "Archive storage is not configured. Download locally instead." : !rawStatus.data ? "Read deployment policy and choose subscriptions before saving." : "";
  return <>
    <PageHeader title="Export data" subtitle="Build a report for the selected period and subscriptions, or export underlying FOCUS rows." />
    {options.isError ? <ErrorState error={options.error} onRetry={() => void options.refetch()} /> : <Card className="mb-5">
      <CardHeader title="Report builder" subtitle="Warehouse content is the default. Live findings query Azure only when explicitly selected." />
      <CardBody>
        <div className="mb-5 grid gap-4 sm:grid-cols-3">
          <AdminField label="Period"><div className="mt-2 text-sm">{scope.month ? `Calendar month ${scope.month}` : periodParam(scope) ? `Custom range ${periodParam(scope)}` : "Latest reporting window"} · {scope.scope ? `${scope.scope.split(",").length} subscriptions` : "All entitled subscriptions"}</div></AdminField>
          <AdminField label="Window days"><input className={adminInput} type="number" min={1} max={365} value={days} disabled={!!periodParam(scope)} onChange={e => setDays(Math.min(365, Math.max(1, Number(e.target.value) || 30)))} /></AdminField>
          <AdminField label="Report currency"><select className={adminInput} value={currency} onChange={e => setCurrency(e.target.value)}><option value="">Billed currency</option>{currencies.data?.supported.map(c => <option key={c}>{c}</option>)}</select></AdminField>
        </div>
        <p className="mb-4 text-xs text-muted">As of {options.data?.as_of ?? "not reported"} · {options.data?.currency ?? "billed currencies"} · {currencies.data?.source}</p>
        {currencies.isError && <ErrorState error={currencies.error} />}
        <label className="mb-4 flex gap-2 text-sm"><input type="checkbox" checked={content.summary} onChange={e => update({ summary: e.target.checked })} />Summary and by-area breakdown</label>
        <div className="grid gap-6 md:grid-cols-3">
          <AdminChecks title="Cost areas" options={options.data?.areas.map(a => ({ id: a.id, label: `${a.label} · ${a.cost.toLocaleString()} ${options.data?.currency ?? ""}` })) ?? []} selected={content.sections} onChange={sections => update({ sections })} />
          <AdminChecks title="Area details / dimensions" options={options.data?.blocks.map(id => ({ id, label: BLOCKS[id] ?? id })) ?? []} selected={content.blocks} onChange={blocks => update({ blocks })} />
          <AdminChecks title="Live findings (slower, Azure reads)" options={options.data?.live ?? []} selected={content.live} onChange={live => update({ live })} />
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <select aria-label="Report file format" className={`${adminInput} w-auto`} value={format} onChange={e => setFormat(e.target.value)}>{options.data?.formats.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
          <Button asChild variant="primary" className={reportDisabled ? "opacity-50" : ""}><a href={reportDisabled ? undefined : reportHref} aria-disabled={reportDisabled} target="_blank" rel="noopener" onClick={e => { if (reportDisabled) { e.preventDefault(); return; } setNotice("Report requested. The browser handles the download; check its downloads or the server response in the new tab."); }}><Download />Download report</a></Button>
          <span className="text-xs text-muted">{content.summary ? "Summary · " : ""}{content.sections.length} areas · {content.blocks.length} detail blocks · {content.live.length} live findings</span>
        </div>
        {reportReason && <p className="mt-2 text-xs text-muted">{reportReason}</p>}
      </CardBody>
    </Card>}
    <Card><CardHeader title="Custom cost export" subtitle="Independent subscription selection. Same FOCUS columns and order as Azure exports; these are raw rows, not report presentation columns." /><CardBody>
      {catalog.isError ? <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} /> : <AdminChecks title="Export subscriptions" options={catalog.data?.subscriptions.map(s => ({ id: s.id, label: s.name })) ?? []} selected={selected} onChange={setRawScope} />}
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <AdminField label="Cost period from"><input type="date" className={adminInput} value={raw.since} onChange={e => setSince(e.target.value)} /></AdminField>
        <AdminField label="Through"><input type="date" className={adminInput} value={raw.until} onChange={e => setUntil(e.target.value)} /></AdminField>
        <AdminField label="Dataset"><select className={adminInput} value={dataset} onChange={e => { setDataset(e.target.value); setSource(""); }}><option value="actual">Actual / FOCUS</option><option value="amortized">Amortized</option></select></AdminField>
        <AdminField label="Data as read on"><select className={adminInput} value={source} onChange={e => setSource(e.target.value)}><option value="">Current warehouse</option>{archive.data?.days?.[dataset]?.map(day => <option key={day}>{day}</option>)}</select></AdminField>
        <AdminField label="Format"><select className={adminInput} value={rawFormat} onChange={e => setRawFormat(e.target.value)}><option value="csv">CSV (FOCUS)</option><option value="parquet">Parquet</option></select></AdminField>
        <AdminField label="File label"><input className={adminInput} maxLength={40} value={label} placeholder="finance-review" onChange={e => setLabel(e.target.value)} /></AdminField>
      </div>
      <p className="mt-3 text-xs text-muted">Warehouse: {warehouse.data?.from ?? "no data"} → {warehouse.data?.to ?? "no data"}. Azure may restate costs between snapshot dates. Raw exports preserve source currencies.</p>
      {[warehouse.error, archive.error, rawStatus.error].filter(Boolean).map((e, i) => <div key={i} className="mt-3"><ErrorState error={e} /></div>)}
      <div className="mt-5 flex flex-wrap gap-3"><Button asChild variant="primary" className={busy || !rawHref ? "opacity-50" : ""}><a href={busy ? undefined : rawHref} aria-disabled={busy || !rawHref} target="_blank" rel="noopener" onClick={e => { if (busy || !rawHref) { e.preventDefault(); return; } setNotice("Raw export requested. The browser handles the download; check its downloads or the server response in the new tab."); }}><Download />Download raw data</a></Button><Button disabled={busy || !selected.length || !canSave} onClick={reviewStorage}>Review save to storage</Button></div>
      {rawReason && <p className="mt-2 text-xs text-warn">{rawReason}</p>}
      {saveReason && <p className="mt-2 text-xs text-muted">{saveReason}</p>}
    </CardBody></Card>
    {error != null && <div className="mt-4" role="alert"><ErrorState error={error} /></div>}
    <p role="status" className="mt-3 text-sm text-muted">{notice}</p>
    {storageReview && <AdminConfirm title="Save custom export to storage?" confirm={() => void saveStorage()} cancel={() => { session.current.cancel(); setStorageReview(null); setNotice("Cancelled. No storage changes made."); }} busy={busy} disabled={!canSave}>
      <p>{storageReview.scope.length} subscriptions · {storageReview.since || "all dates"} → {storageReview.until || "all dates"} · {storageReview.fmt.toUpperCase()} · {storageReview.source || "current warehouse"}.</p><p>This writes a separate labelled file to configured storage. The daily archive is not overwritten. Storage charges may apply.</p>
    </AdminConfirm>}
  </>;
}
