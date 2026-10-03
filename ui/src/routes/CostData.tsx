import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { columnHelper, DataTable } from "@/components/DataTable";
import { ErrorState, PageHeader, Segmented } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api";
import { meQuery } from "@/lib/queries";
import { AdminChecks, AdminConfirm, AdminField, adminInput } from "@/lib/helpersAdmin";
import { AdminAccess } from "@/lib/helpersAdminAccess";
import {
  ApprovalSession, activeStatus, approvalBody, catalogQuery, costJobsQuery, costRequest, costStatusQuery, postAdmin, resumableJob, selectedScope, singleJobQuery,
  type AdminJob, type Cadence, type CostAction, type CostPlan, type CostRequest, type ExportInventory, type ScheduleInventory, type ScheduleRow, type Warehouse,
} from "@/lib/admin-report-queries";

interface Review { body: CostRequest; plan: CostPlan; key: string; idempotency: string; at: number }
interface ImportBody { scope: string[]; metric: "FocusCost"; export_id?: string; sas_url?: string; max_files: number; idempotency_key: string }
interface BlobEvidence { source?: string; file?: string; columns_in_file?: number; mapped?: string[]; missing?: string[]; empty_though_present?: string[]; sampled_rows?: number; has_tags?: boolean; rows_with_tags_in_sample?: number; error?: string; detail?: string }
const today = () => new Date().toISOString().slice(0, 10);
const startDate = (days: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);

function Jobs({ jobs, scope, writable, onRetry }: { jobs: AdminJob[]; scope: string[]; writable: boolean; onRetry: (job: AdminJob) => void }) {
  return <div className="space-y-3">{jobs.length ? jobs.map(job => {
    const selected = job.scope.every(s => scope.includes(s.toLowerCase()));
    const retry = resumableJob(job);
    const pendingInteractive = job.identity === "interactive" && ["queued", "pending"].includes(job.status);
    return <details key={job.job_id} className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">{job.kind} · {job.status} · {job.job_id}</summary>
      <p className="mt-2 text-xs text-muted">{job.created_at} · {job.scope.join(", ")}{job.detail ? ` · ${job.detail}` : ""}</p>
      {job.payload && <p className="mt-2 text-sm">Reviewed action: {job.payload.action ?? job.kind} · {job.payload.cadence ?? "No frequency change"}{job.payload.from ? ` · ${job.payload.from} → ${job.payload.to}` : ""}{job.payload.history_days ? ` · ${job.payload.history_days} history days` : ""}</p>}
      {job.progress && <p className="mt-2 text-xs text-muted">Progress: {job.progress.done ?? "?"}/{job.progress.total ?? "?"}{job.progress.loaded_rows !== undefined ? ` · ${job.progress.loaded_rows} rows loaded` : ""} · {job.progress.detail}</p>}
      <ul className="mt-3 space-y-2 text-sm">{job.tasks?.map(task => <li key={task.task_id}><strong>{task.name ?? task.subscription}</strong>: {task.from ? `${task.from} → ${task.to} · ` : ""}{task.operation ? `${task.operation} · ` : ""}{task.status}{task.detail ? ` — ${task.detail}` : ""}</li>)}</ul>
      {pendingInteractive && <p className="mt-2 text-xs text-warn">Interactive jobs do not automatically recover after a backend restart. Queued status does not confirm an active worker; review before authorizing resumption.</p>}
      {retry && <div className="mt-3"><Button disabled={!writable || !selected} onClick={() => onRetry(job)}>{pendingInteractive ? "Review resume pending job" : "Review retry missing work"}</Button>{!selected && <p className="mt-2 text-xs text-warn">Select every subscription covered by this job before retrying it.</p>}</div>}
    </details>;
  }) : <p className="text-sm text-muted">No persisted jobs found for this selection.</p>}</div>;
}

export function CostDataPage() {
  const client = useQueryClient();
  const me = useQuery(meQuery);
  const catalog = useQuery(catalogQuery);
  const [picked, setPicked] = useState<string[] | null>(null);
  const scope = useMemo(() => [...new Set(picked ?? catalog.data?.subscriptions.map(s => s.id.toLowerCase()) ?? [])].sort(), [picked, catalog.data]);
  useEffect(() => {
    if (!catalog.data) return;
    const allowed = catalog.data.subscriptions.map(s => s.id.toLowerCase());
    setPicked(previous => {
      if (previous === null) return allowed;
      const next = previous.filter(id => allowed.includes(id));
      return next.length === previous.length ? previous : next;
    });
  }, [catalog.data]);
  const [search, setSearch] = useState("");
  const status = useQuery(costStatusQuery(scope));
  const jobs = useQuery({ ...costJobsQuery(scope), enabled: !!scope.length && status.isSuccess });
  const warehouse = useQuery({ queryKey: ["admin-cost-warehouse", scope.join(",")], enabled: !!scope.length && status.isSuccess, retry: false, queryFn: ({ signal }) => api<Warehouse>("warehouse", { scope }, { signal }) });
  const [manualJob, setManualJob] = useState("");
  const restoredJob = manualJob || warehouse.data?.ingest?.job_id || "";
  const imported = useQuery(singleJobQuery(restoredJob, scope));
  const [tab, setTab] = useState<"first" | "schedule" | "access">("first");
  const [cadence, setCadence] = useState<Cadence>("Daily");
  const [preset, setPreset] = useState("90");
  const [days, setDays] = useState("90");
  const [start, setStart] = useState(() => startDate(90));
  const [end, setEnd] = useState(today);
  const draftInitialized = useRef(false);
  useEffect(() => {
    if (draftInitialized.current || !status.data?.subscriptions.length) return;
    draftInitialized.current = true;
    const saved = status.data.subscriptions.map(s => s.config.cadence).filter(c => c !== undefined);
    if (saved.length && saved.every(c => c === saved[0])) setCadence(saved[0]!);
    const histories = status.data.subscriptions.map(s => s.config.history);
    const history = histories[0];
    if (history && histories.every(h => h?.from === history.from && h?.to === history.to)) {
      const count = (Date.parse(history.to) - Date.parse(history.from)) / 86400000 + 1;
      if (Number.isInteger(count) && count >= 1 && count <= 365 && history.to <= today()) {
        setStart(history.from); setEnd(history.to); setDays(String(count));
        setPreset([30, 90, 180, 365].includes(count) ? String(count) : "custom");
      }
    }
  }, [status.data]);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [retryJob, setRetryJob] = useState<AdminJob | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [inventoryEnabled, setInventoryEnabled] = useState(false);
  const [historyEnabled, setHistoryEnabled] = useState(false);
  const inventory = useQuery({
    queryKey: ["admin-cost-inventory", scope.join(",")], enabled: inventoryEnabled && !!scope.length && status.isSuccess, retry: false,
    queryFn: ({ signal }) => api<ScheduleInventory>("schedules", { scope: selectedScope(scope), history: false }, { signal }), staleTime: 60_000,
  });
  const history = useQuery({
    queryKey: ["admin-cost-inventory-history", scope.join(",")], enabled: historyEnabled && inventory.isSuccess && !!scope.length, retry: false,
    queryFn: ({ signal }) => api<{ history: Record<string, { last_run?: string; last_status?: string }>; error?: string }>("schedules/history", { scope: selectedScope(scope) }, { signal }),
  });
  const [exportsEnabled, setExportsEnabled] = useState(false);
  const exports = useQuery({ queryKey: ["admin-cost-import-exports"], enabled: exportsEnabled, retry: false, queryFn: ({ signal }) => api<ExportInventory>("exports", undefined, { signal }) });
  const [exportId, setExportId] = useState("");
  const [sas, setSas] = useState("");
  const [account, setAccount] = useState("");
  const [container, setContainer] = useState("");
  const [prefix, setPrefix] = useState("");
  const [maxFiles, setMaxFiles] = useState(60);
  const [evidence, setEvidence] = useState<BlobEvidence | null>(null);
  const [importReview, setImportReview] = useState<ImportBody | null>(null);
  const session = useRef(new ApprovalSession());
  const fingerprint = JSON.stringify([scope, tab, cadence, preset, days, start, end, account, container, prefix, exportId, sas, maxFiles]);
  const currentKey = useRef(fingerprint);
  currentKey.current = fingerprint;
  useEffect(() => {
    const current = session.current;
    current.cancel(); setBusy(false); setReview(null); setRetryJob(null); setImportReview(null); setError(null); setEvidence(null);
    return () => current.cancel();
  }, [fingerprint]);
  useEffect(() => { setInventoryEnabled(false); setHistoryEnabled(false); setManualJob(""); }, [scope.join(",")]);
  const refreshed = useRef("");
  const refreshStatus = () => { void status.refetch(); void jobs.refetch(); void warehouse.refetch(); if (restoredJob) void imported.refetch(); };
  useEffect(() => {
    const signature = JSON.stringify([jobs.data?.jobs.map(j => [j.job_id, j.status]), imported.data?.status]);
    if (signature !== refreshed.current) { refreshed.current = signature; void client.invalidateQueries({ queryKey: ["admin-cost-status", scope.join(",")] }); }
  }, [jobs.data, imported.data?.status, client, scope]);
  const writable = me.data?.user?.admin === true && status.data?.can_review === true && status.data.read_only === false && !status.isError;
  const currentRetryJob = jobs.data?.jobs.find(j => j.job_id === retryJob?.job_id) ?? (imported.data?.job_id === retryJob?.job_id ? imported.data : undefined) ?? retryJob;
  const running = status.data?.subscriptions.some(s => activeStatus(s.status)) || jobs.data?.jobs.some(j => activeStatus(j.status));
  const sameCadence = !!status.data?.subscriptions.length && status.data.subscriptions.every(s => s.configured && s.config.cadence === cadence);
  const reason = !scope.length ? "Choose at least one subscription; clearing the picker never widens the import scope." : status.isError ? "Current setup could not be read. Retry status before approving any changes." : status.data?.read_only ? "This deployment is read-only. Inspection and progress are available; changes are disabled." : !me.data?.user?.admin ? "An administrator must authorize imports and updates." : !status.data?.can_review ? "Waiting for server authorization and setup state." : running ? "A cost-data job is pending. Check progress before reviewing more work." : "";
  const cancel = () => { session.current.cancel(); setReview(null); setRetryJob(null); setImportReview(null); setBusy(false); setNotice("Cancelled. No new changes were submitted."); };
  const reviewAction = async (action: CostAction) => {
    if (!writable || running || busy) return;
    setError(null); setBusy(true); setReview(null); setNotice("");
    const key = fingerprint;
    try {
      const body = costRequest(scope, action, cadence, start, end);
      if (action === "setup" && (!/^\d+$/.test(days) || Number(days) !== body.history_days)) throw new Error("Choose 1–365 whole days matching the exact selected history dates.");
      const plan = await session.current.run(signal => postAdmin<CostPlan>("cost-data/preview", body, signal));
      if (plan && key === currentKey.current) { setReview({ body, plan, key, idempotency: crypto.randomUUID(), at: Date.now() }); setBusy(false); }
    } catch (e) { setError(e); setBusy(false); }
  };
  const approve = async () => {
    if (!review || review.key !== currentKey.current || !writable || busy) return;
    setBusy(true); setError(null);
    try {
      const body = approvalBody(review.body, review.plan, review.idempotency, review.at);
      const result = await session.current.run(signal => postAdmin<AdminJob>("cost-data/setup", body, signal));
      if (result && review.key === currentKey.current) {
        if (!result.job_id) throw new Error("The response did not include a job ID. Check persisted status before retrying.");
        setReview(null); setBusy(false); setNotice("Approved work is queued, not yet completed. The backend continues after this browser closes; check status for exact errors."); refreshStatus();
      }
    } catch (e) { setError(e); setBusy(false); if (e instanceof ApiError && e.status === 409) setReview(null); setNotice("Check persisted status before retrying. A retry of this review reuses the same approval key."); }
  };
  const retry = async () => {
    if (!retryJob || !currentRetryJob || !writable || busy || !resumableJob(currentRetryJob) || !retryJob.scope.length || !retryJob.scope.every(s => scope.includes(s.toLowerCase()))) return;
    setBusy(true); setError(null);
    try {
      const result = await session.current.run(signal => postAdmin<AdminJob>(`${retryJob.kind.startsWith("focus-") ? "focus/jobs" : "jobs"}/${encodeURIComponent(retryJob.job_id)}/resume`, {}, signal, retryJob.kind.startsWith("focus-") ? { scope: selectedScope(retryJob.scope) } : undefined));
      if (result) {
        if (result.job_id !== retryJob.job_id || selectedScope(result.scope).join(",") !== selectedScope(retryJob.scope).join(",")) throw new Error("The server did not confirm the same persisted job and scope. Check status before retrying.");
        setRetryJob(null); setBusy(false); setNotice("Retry authorized; missing work was accepted for the same job, not yet completed. Ready tasks and the original approval identity are preserved."); refreshStatus();
      }
    } catch (e) { setError(e); setBusy(false); }
  };
  const inspectBlob = async () => {
    if (!scope.length || !me.data?.user?.admin || !account.trim() || !container.trim() || busy) return;
    setBusy(true); setError(null); setEvidence(null);
    try {
      const result = await session.current.run(signal => api<BlobEvidence>("diagnostics/export", { account: account.trim(), container: container.trim(), prefix: prefix.trim() }, { signal }));
      if (result) { setEvidence(result); setBusy(false); }
    } catch (e) { setError(e); setBusy(false); }
  };
  const reviewImport = () => {
    try {
      if (!writable || busy || running) return;
      const body: ImportBody = { scope: selectedScope(scope), metric: "FocusCost", max_files: maxFiles, idempotency_key: crypto.randomUUID() };
      if (sas.trim()) {
        const url = new URL(sas.trim());
        if (url.protocol !== "https:" || !url.hostname.endsWith(".blob.core.windows.net") || url.username || url.password || !url.searchParams.has("sig") || url.pathname.split("/").filter(Boolean).length !== 1) throw new Error("Use an HTTPS Azure container SAS URL. It is kept only in this page's memory.");
        body.sas_url = sas.trim();
      } else {
        const selected = exports.data?.exports.find(e => e.id === exportId && e.type === "FocusCost");
        if (!selected || (selected.subscription_id && !scope.includes(selected.subscription_id.toLowerCase()))) throw new Error("Choose a FOCUS export covering the selected subscriptions or supply a container SAS URL.");
        body.export_id = selected.id;
      }
      if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 500) throw new Error("Choose 1–500 files.");
      setError(null); setImportReview(body);
    } catch (e) { setError(e); }
  };
  const approveImport = async () => {
    if (!importReview || !writable || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await session.current.run(signal => postAdmin<{ status: string; started?: string; ingest?: { job_id?: string }; detail?: string }>("exports/ingest", importReview, signal));
      if (result) { setManualJob(result.ingest?.job_id ?? result.started ?? ""); setImportReview(null); setSas(""); setBusy(false); setNotice(`${result.status}. FOCUS import runs in the backend; check job progress below.`); refreshStatus(); }
    } catch (e) { setError(e); setBusy(false); }
  };
  const schedules = useMemo(() => (inventory.data?.schedules ?? []).map(row => ({ ...row, ...history.data?.history[`${row.subscription_id}/${row.name}`] })), [inventory.data, history.data]);
  const h = columnHelper<ScheduleRow>();
  const inventoryColumns = [
    h.accessor("name", { header: "Export", meta: { width: "minmax(220px,1.5fr)" } }),
    h.accessor("subscription_id", { header: "Subscription", meta: { width: "minmax(220px,1fr)" } }),
    h.accessor("metric", { header: "Dataset" }), h.accessor("recurrence", { header: "Azure cadence" }),
    h.accessor(row => `${row.account ?? ""}/${row.container ?? ""}/${row.folder ?? ""}`, { id: "destination", header: "Destination", meta: { width: "minmax(260px,1.5fr)" } }),
    h.accessor(row => row.owned ? "Deployment-owned" : "External / legacy (not changed)", { id: "ownership", header: "Ownership" }),
    h.accessor(row => row.last_status ? `${row.last_status}${row.last_run ? ` · ${row.last_run}` : ""}` : "Load history for evidence", { id: "last_status", header: "Last execution", meta: { width: "minmax(180px,1fr)" } }),
  ];
  const jobList = jobs.data?.jobs ?? [];
  const completed = status.data?.subscriptions.reduce((sum, s) => sum + s.coverage.authoritative_days, 0) ?? 0;
  const total = status.data?.subscriptions.reduce((sum, s) => sum + s.coverage.requested_days, 0) ?? 0;
  const changeDays = (value: string) => {
    setDays(value);
    const count = Number(value);
    if (Number.isInteger(count) && count >= 1 && count <= 365) { setStart(startDate(count)); setEnd(today()); }
  };
  const changeDate = (value: string, side: "start" | "end") => {
    const lo = side === "start" ? value : start;
    const hi = side === "end" ? value : end;
    if (side === "start") setStart(value); else setEnd(value);
    setPreset("custom");
    const count = (Date.parse(`${hi}T00:00:00Z`) - Date.parse(`${lo}T00:00:00Z`)) / 86400000 + 1;
    if (Number.isFinite(count)) setDays(String(count));
  };
  return <>
    <PageHeader title="Cost data" subtitle="Review and approve the exact local import scope. The global header changes display context, not this selection." actions={<><Button disabled={!scope.length || status.isFetching} onClick={refreshStatus}>Check status</Button><Button asChild><Link to="/admin/setup">Setup progress & history months</Link></Button></>} />
    {catalog.isError && <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />}
    <Card className="mb-5"><CardHeader title="Import subscriptions" subtitle="Explicit local selection; no import starts when a checkbox or frequency changes." /><CardBody>
      <div className="mb-3 flex gap-2"><input aria-label="Find import subscriptions" className={adminInput} placeholder="Search subscriptions" value={search} onChange={e => setSearch(e.target.value)} /><Button onClick={() => void catalog.refetch()}>Refresh catalog</Button></div>
      <AdminChecks title={`${scope.length} selected subscriptions`} options={catalog.data?.subscriptions.filter(s => `${s.name} ${s.id}`.toLowerCase().includes(search.toLowerCase())).map(s => ({ id: s.id.toLowerCase(), label: s.name })) ?? []} selected={scope} onChange={ids => setPicked(ids)} disabled={busy} />
      <p className="mt-3 text-sm text-muted">{reason || "Ready to review. Azure write permission is verified separately in the review."}</p>
    </CardBody></Card>
    {status.isError && <div className="mb-5"><ErrorState error={status.error} onRetry={() => void status.refetch()} /></div>}
    <Card className="mb-5"><CardHeader title="Current state" subtitle={`${completed} / ${total} subscription-days verified${total ? ` (${Math.floor(completed * 100 / total)}%)` : ""}. Quick estimates do not count as authoritative FOCUS coverage.`} /><CardBody>
      {!scope.length ? <p>Choose subscriptions to read their status.</p> : status.isPending ? <p role="status">Reading saved setup…</p> : status.data?.subscriptions.map(s => <details key={s.id} className="mb-3 rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">{s.name} · {s.status} · {s.configured ? `${s.config.cadence} updates` : "Not configured"}</summary>
        <dl className="mt-3 grid gap-2 text-xs text-muted sm:grid-cols-2"><div>Available through: {s.through ?? "Not reported"}</div><div>Last success: {s.last_success ?? "None"}</div><div>Next check: {s.next_check ?? "Not enabled"}</div><div>Saved revision: {s.config.revision ?? "Not configured"}</div><div>History: {s.history.from} → {s.history.to}</div><div>Coverage: {s.coverage.authoritative_days}/{s.coverage.requested_days} days{ s.coverage.current_day_provisional ? " · today is provisional" : ""}</div></dl>
        {s.detail && <p className="mt-3 text-sm text-warn">{s.detail}</p>}
        {s.tasks?.filter(t => t.status !== "ready").map(t => <p key={t.task_id} className="mt-2 text-sm">{t.from} → {t.to} · {t.status} · {t.detail}</p>)}
      </details>)}
      {status.data?.auto_enabled === false && <p className="text-sm text-warn">Automatic checks or deployment storage are disabled. Ask the deployment administrator to enable the pipeline.</p>}
      <p className="mt-3 text-xs text-muted">{status.data?.note} Checked {status.data?.checked_at ?? "not yet"}.</p>
    </CardBody></Card>
    <div className="mb-4"><Segmented label="Cost import workflow" value={tab} options={[{ value: "first", label: "First-time import" }, { value: "schedule", label: "Scheduled updates" }, { value: "access", label: "Access & fixes" }]} onChange={value => { cancel(); setTab(value); }} /></div>
    <Card className="mb-5"><CardBody>
      {tab === "access" ? <AdminAccess scope={scope} admin={me.data?.user?.admin === true} /> : <>
        <fieldset disabled={busy} className="mb-4"><legend className="mb-2 text-sm font-medium">Automatic update frequency</legend><div className="flex flex-wrap gap-5">{(["Daily", "Weekly", "Monthly"] satisfies Cadence[]).map(c => <label key={c} className="flex gap-2 text-sm"><input type="radio" name="cost-cadence" value={c} checked={cadence === c} onChange={() => setCadence(c)} />{c}{c === "Daily" ? " (recommended)" : ""}</label>)}</div><p className="mt-3 text-xs text-muted">{status.data?.cadences[cadence] ?? "Runs at 02:00 UTC. Weekly checks Mondays; monthly checks completed months on the first."}</p></fieldset>
        {tab === "first" ? <>
          <div className="grid gap-4 sm:grid-cols-4">
            <AdminField label="History"><select disabled={busy} className={adminInput} value={preset} onChange={e => { setPreset(e.target.value); if (e.target.value !== "custom") changeDays(e.target.value); }}>{["30", "90", "180", "365"].map(n => <option key={n} value={n}>{n} days</option>)}<option value="custom">Custom days / dates</option></select></AdminField>
            <AdminField label="Number of days (1–365)"><input disabled={busy} className={adminInput} type="number" min={1} max={365} value={days} onChange={e => { setPreset("custom"); changeDays(e.target.value); }} /></AdminField>
            <AdminField label="From (inclusive UTC)"><input disabled={busy} className={adminInput} type="date" max={today()} value={start} onChange={e => changeDate(e.target.value, "start")} /></AdminField>
            <AdminField label="Through (inclusive UTC)"><input disabled={busy} className={adminInput} type="date" max={today()} value={end} onChange={e => changeDate(e.target.value, "end")} /></AdminField>
          </div><p className="my-4 text-sm text-muted">This approval imports the selected dates and enables {cadence} automatic updates. Complete reports are reused. Existing data is not deleted; history is not a retention policy.</p><Button variant="primary" disabled={busy || !writable || !!running} onClick={() => void reviewAction("setup")}>Review import and updates</Button>
        </> : <>
          <p className="mb-4 text-sm text-muted">Draft frequency is not saved until approved. Schedule-only approval preserves history and catch-up progress; it does not start a historical import.</p>
          <div className="flex flex-wrap gap-3"><Button variant="primary" disabled={busy || !writable || !!running || sameCadence} onClick={() => void reviewAction("schedule")}>Review {cadence.toLowerCase()} schedule</Button><Button disabled={busy || !writable || !!running} onClick={() => void reviewAction("refresh")}>Review refresh now</Button><Button disabled={busy || !writable || !jobList.some(j => ["failed", "partial"].includes(j.status))} onClick={() => { const job = jobList.find(j => ["failed", "partial"].includes(j.status)); if (job) setRetryJob(job); }}>Retry missing work</Button></div>
          {sameCadence && <p className="mt-3 text-xs text-muted">{cadence} updates are already enabled for this entire selection. Choose another frequency to review a change.</p>}
          <details className="mt-5"><summary className="cursor-pointer text-sm font-medium">Reconcile exact historical dates</summary><div className="mt-3 grid gap-4 sm:grid-cols-2"><AdminField label="From (UTC)"><input className={adminInput} type="date" value={start} max={today()} onChange={e => changeDate(e.target.value, "start")} /></AdminField><AdminField label="Through (UTC)"><input className={adminInput} type="date" value={end} max={today()} onChange={e => changeDate(e.target.value, "end")} /></AdminField></div><p className="my-3 text-xs text-muted">Rechecks these inclusive dates without changing saved frequency. Azure may generate new reports; unsupported history remains incomplete.</p><Button disabled={busy || !writable || !!running} onClick={() => void reviewAction("reconcile")}>Review reconciliation</Button></details>
        </>}
      </>}
      {busy && <div className="mt-3"><p role="status" className="text-sm">Reading or submitting the exact selection…</p>{!review && !retryJob && !importReview && <Button className="mt-2" onClick={cancel}>Cancel pending browser request</Button>}</div>}
    </CardBody></Card>
    {error != null && <div className="mb-5" role="alert"><ErrorState error={error} /></div>}
    <p role="status" className="mb-4 text-sm text-muted">{notice}</p>
    <Card className="mb-5"><CardHeader title="Persistent import jobs" subtitle="Restored with GET requests, not redirects. Polls only while work is active, up to 120 reads; polling stops on errors. Use Check status to resume inspection." /><CardBody>
      {jobs.isError ? <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} /> : <Jobs jobs={jobList} scope={scope} writable={writable && !busy} onRetry={setRetryJob} />}
      {restoredJob && !jobList.some(j => j.job_id === restoredJob) && <div className="mt-4">{imported.isError ? <ErrorState error={imported.error} onRetry={() => void imported.refetch()} /> : imported.data ? <Jobs jobs={[imported.data]} scope={scope} writable={writable && !busy} onRetry={setRetryJob} /> : <p>Reading last persisted import job…</p>}</div>}
      {warehouse.isError && <ErrorState error={warehouse.error} onRetry={() => void warehouse.refetch()} />}
    </CardBody></Card>
    <Card className="mb-5"><CardHeader title="Export inventory (read only)" subtitle="Load live Azure listings explicitly. External and legacy exports are evidence only; no competing legacy cadence editor." /><CardBody>
      <div className="mb-3 flex flex-wrap gap-2"><Button disabled={!scope.length || inventory.isFetching} onClick={() => { setInventoryEnabled(true); if (inventoryEnabled) void inventory.refetch(); }}>Load exports (fast listing)</Button><Button disabled={!inventory.isSuccess || history.isFetching} onClick={() => { setHistoryEnabled(true); if (historyEnabled) void history.refetch(); }}>Load execution history (slower)</Button></div>
      {inventory.isFetching && <p role="status">Listing exports…</p>}
      {inventory.error && <ErrorState error={inventory.error} />}
      {inventory.data?.error && <p role="alert" className="text-warn">{inventory.data.error}</p>}
      {history.error && <ErrorState error={history.error} />}
      {history.data?.error && <p role="alert" className="text-warn">{history.data.error}</p>}
      {inventory.isSuccess && <DataTable data={schedules} columns={inventoryColumns} rowKey={r => `${r.subscription_id}/${r.name}`} height={320} empty="No exports found. Listing failures are shown separately above." />}
    </CardBody></Card>
    <Card><CardHeader title="Manual FOCUS / Blob import" subtitle="Import an existing selected export or a container SAS; never create or edit a legacy schedule." /><CardBody>
      <Button disabled={exports.isFetching || !scope.length} onClick={() => { setExportsEnabled(true); if (exportsEnabled) void exports.refetch(); }}>Discover existing import sources</Button>
      {exports.error && <ErrorState error={exports.error} />}
      {exports.data?.error && <p role="alert">{exports.data.error}</p>}
      {exports.data?.errors?.map((e, i) => <p key={i} role="alert" className="mt-2 text-sm text-warn">{e.subscription}: {e.detail}</p>)}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <AdminField label="Existing FOCUS export"><select className={adminInput} value={exportId} disabled={busy} onChange={e => {
          setExportId(e.target.value); setSas("");
          const source = exports.data?.exports.find(x => x.id === e.target.value);
          if (source) { setAccount(source.storage_account ?? ""); setContainer(source.container ?? ""); setPrefix(source.root_folder ?? ""); }
        }}><option value="">Choose explicitly</option>{exports.data?.exports.filter(e => e.type === "FocusCost" && (!e.subscription_id || scope.includes(e.subscription_id.toLowerCase()))).map(e => <option key={e.id} value={e.id}>{e.name} · {e.storage_account}/{e.container}/{e.root_folder}</option>)}</select></AdminField>
        <AdminField label="Or container SAS URL (never persisted)"><input type="password" autoComplete="off" className={adminInput} value={sas} disabled={busy} onChange={e => { setSas(e.target.value); setExportId(""); }} placeholder="https://account.blob.core.windows.net/container?…" /></AdminField>
        <AdminField label="Storage account (inspection)"><input className={adminInput} value={account} disabled={busy} onChange={e => setAccount(e.target.value)} /></AdminField>
        <AdminField label="Container (inspection)"><input className={adminInput} value={container} disabled={busy} onChange={e => setContainer(e.target.value)} /></AdminField>
        <AdminField label="Prefix (inspection)"><input className={adminInput} value={prefix} disabled={busy} onChange={e => setPrefix(e.target.value)} /></AdminField>
        <AdminField label="Maximum files"><input className={adminInput} type="number" min={1} max={500} value={maxFiles} disabled={busy} onChange={e => setMaxFiles(Number(e.target.value))} /></AdminField>
      </div>
      <p className="my-4 text-xs text-muted">Account/container/prefix inspect columns using workload storage access. They do not override the import source: export imports use its configured folder; SAS imports read the container. This backend does not offer arbitrary-prefix imports. Scope always limits imported subscriptions. SAS credentials stay in memory and are sent only to this service on confirmation.</p>
      <div className="flex flex-wrap gap-3"><Button disabled={busy || !account || !container || !scope.length || !me.data?.user?.admin} onClick={() => void inspectBlob()}>Inspect Blob source (read only)</Button><Button variant="primary" disabled={busy || !writable || !!running || (!exportId && !sas)} onClick={reviewImport}>Review manual FOCUS import</Button></div>
      {evidence && <div className="mt-4 space-y-2 rounded-lg bg-surface-2 p-3 text-sm"><p>Source: {evidence.source ?? `${account}/${container}/${prefix}`}</p><p>File: {evidence.file ?? "Not reported"} · {evidence.columns_in_file ?? "?"} source columns · {evidence.sampled_rows ?? "?"} sampled rows</p><p>Mapped: {evidence.mapped?.join(", ") || "Not reported"}</p><p>Missing: {evidence.missing?.join(", ") || "None reported"}</p><p>Present but empty: {evidence.empty_though_present?.join(", ") || "None reported"}</p><p>Tags: {evidence.has_tags ? `${evidence.rows_with_tags_in_sample ?? 0} sampled rows with tags` : "Not present"}</p>{(evidence.error || evidence.detail) && <p>{evidence.error ?? evidence.detail}</p>}</div>}
    </CardBody></Card>
    {review && review.key === fingerprint && <AdminConfirm title={`Review ${review.body.action === "setup" ? "import and automatic updates" : review.body.action}`} label={review.body.action === "schedule" ? `Enable ${review.body.cadence.toLowerCase()} updates` : "Approve exact reviewed work"} disabled={!review.plan.can_start || !writable || Date.now() - review.at > 600_000} busy={busy} confirm={() => void approve()} cancel={cancel} reason={!review.plan.can_start ? "Resolve the blockers below, cancel, and review again. No changes have been made." : undefined}>
      <p><strong>{review.body.scope.length} selected subscriptions · {review.body.cadence}</strong>{review.body.action === "schedule" ? " · no historical import" : ` · ${review.plan.from} → ${review.plan.to} (inclusive UTC)`}</p>
      <p>Identity: {review.plan.identity}</p><p>{review.plan.explanation}</p>
      {review.plan.subscriptions.map(s => <section key={s.subscription} className="rounded-lg border border-border p-3"><h4 className="font-medium">{s.name} ({s.subscription})</h4><p>{s.action}</p><p>Export: {s.export?.name ?? "New deployment-owned FOCUS export"}</p><p className="break-all">Destination: {s.destination.account_id}/{s.destination.container}/{s.destination.folder}</p>{s.window && <p>Coverage: {s.window.from} → {s.window.to}</p>}{s.blockers.map((b, i) => <p key={i} className="mt-2 text-warn">{b}</p>)}<details className="mt-2"><summary>Required permissions and evidence</summary>{s.permissions.map((p, i) => <p key={i} className="mt-2 break-all">{p.principal} · {p.requirement}<br />{typeof p.scope === "string" ? p.scope : `${p.scope.account_id}/${p.scope.container}/${p.scope.folder}`}<br />{p.evidence}</p>)}</details></section>)}
      {review.plan.notes.map((note, i) => <p key={i} className="text-muted">{note}</p>)}
      {!review.plan.can_start && <div className="flex gap-2"><Button disabled={busy || !writable} onClick={() => void reviewAction(review.body.action)}>Recheck readiness</Button><Button disabled={busy} onClick={() => { cancel(); setTab("access"); }}>Access & fixes</Button></div>}
      {error != null && <div role="alert"><ErrorState error={error} /></div>}
    </AdminConfirm>}
    {retryJob && <AdminConfirm title="Retry missing job work?" busy={busy} disabled={!writable || !currentRetryJob || !resumableJob(currentRetryJob) || !retryJob.scope.every(s => scope.includes(s.toLowerCase()))} confirm={() => void retry()} cancel={cancel} label="Authorize retry">
      <p>{retryJob.kind} · {retryJob.job_id} · {retryJob.status}</p><p>Subscriptions: {retryJob.scope.join(", ")}</p><p>Identity: {retryJob.identity ?? "Not reported"}. The same persisted job and original approval key are reused.</p><p>Completed tasks are retained. Missing work may execute Azure exports and import reports; fresh server authorization is required. This is not cancellation of previously approved backend work. The server does not expose worker ownership; check progress before resuming a pending job.</p>{error != null && <ErrorState error={error} />}
    </AdminConfirm>}
    {importReview && <AdminConfirm title="Review manual FOCUS import" confirm={() => void approveImport()} cancel={cancel} busy={busy} disabled={!writable} label="Import selected FOCUS data">
      <p>Subscriptions: {importReview.scope.join(", ")}</p><p>Source: {importReview.sas_url ? `${new URL(importReview.sas_url).hostname}${new URL(importReview.sas_url).pathname} (SAS credential hidden)` : exports.data?.exports.find(e => e.id === importReview.export_id)?.name ?? importReview.export_id}</p><p>FOCUS only · up to {importReview.max_files} files. Only selected subscriptions are imported. Existing exports are not modified; authoritative records may replace estimates. Import progress is restored from the persisted backend job.</p>{error != null && <ErrorState error={error} />}
    </AdminConfirm>}
  </>;
}
