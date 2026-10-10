import { queryOptions } from "@tanstack/react-query";
import { api, ApiError, toSearch, type Query } from "./api";
import { periodParam } from "./period";
import type { Scope } from "./queries";

export type Cadence = "Daily" | "Weekly" | "Monthly";
export type CostAction = "setup" | "schedule" | "refresh" | "reconcile";
export interface Catalog { subscriptions: Array<{ id: string; name: string }> }
export interface JobTask { task_id: string; subscription: string; name?: string; from?: string; to?: string; status: string; detail?: string; operation?: string }
export interface AdminJob { job_id: string; kind: string; scope: string[]; status: string; detail?: string; created_at?: string; identity?: string; progress?: { done?: number; total?: number; loaded_rows?: number; detail?: string }; payload?: { action?: string; cadence?: Cadence; from?: string; to?: string; history_days?: number }; tasks: JobTask[] }
export interface CostSubscription {
  id: string; name: string; configured: boolean; status: string; job_id: string | null; retry_job_id: string | null;
  config: { cadence?: Cadence; enabled?: boolean; revision?: number; updated_at?: string; detail?: string; history?: { from: string; to: string } };
  history: { from: string; to: string };
  coverage: { authoritative_days: number; requested_days: number; missing_days: number; current_day_provisional?: boolean };
  through: string | null; last_success: string | null; next_check: string | null; detail: string | null; tasks: JobTask[];
}
export interface CostStatus { subscriptions: CostSubscription[]; cadences: Record<Cadence, string>; can_review: boolean; read_only: boolean; auto_enabled: boolean; checked_at: string; note: string }
export interface CostRequest { scope: string[]; action: CostAction; cadence: Cadence; start?: string; end?: string; history_days?: number }
export interface CostPlan {
  action: CostAction; cadence: Cadence; from: string; to: string; history_days: number | null;
  can_start: boolean; preview_token: string; identity: string; explanation: string; notes: string[];
  subscriptions: Array<{
    subscription: string; name: string; action: string; blockers: string[]; can_write: boolean;
    export: { name?: string; etag?: string } | null;
    destination: { account_id: string; container: string; folder: string };
    window: { from: string; to: string } | null;
    permissions: Array<{ principal: string; scope: string | { account_id: string; container: string; folder: string }; requirement: string; evidence: string }>;
  }>;
}
export interface Capability { feature: string; status: string; principal?: { id?: string | null }; required_role?: string; scope?: string; reason?: string; next_step?: string }
export interface Capabilities { capabilities: Capability[]; generated_at?: string; read_only?: boolean; mode: string }
export interface ScheduleRow { name: string; subscription_id: string; metric: string; recurrence: string; status: string; owned: boolean; account?: string; container?: string; folder?: string; last_run?: string; last_status?: string }
export interface ScheduleInventory { schedules: ScheduleRow[]; error?: string; destination?: { account_id: string; container: string }; read_only?: boolean }
export interface ExportRow { id: string; name: string; subscription_id?: string; type?: string; metric?: string; storage_account?: string; container?: string; root_folder?: string }
export interface ExportInventory { exports: ExportRow[]; errors?: Array<{ detail?: string; subscription?: string }>; error?: string }
export interface Warehouse { from?: string; to?: string; rows?: number; ingest?: { job_id?: string; status?: string; detail?: string }; read_only?: boolean }
export interface AuditEntry { user: string; email: string | null; source: string; admin: boolean; tab: string; at: string }
export interface ReportOptions { areas: Array<{ id: string; label: string; cost: number }>; blocks: string[]; live: Array<{ id: string; label: string }>; formats: Array<{ id: string; label: string }>; currency: string | null; as_of: string | null }
export interface ReportSelection { format: string; days: number; period_month?: string; scope: string[]; summary: boolean; sections: string[]; blocks: string[]; live: string[]; currency: string }
export interface RawSelection { scope: string[]; fmt: string; since: string; until: string; source: string; dataset: string; label: string }
export interface ArchiveCatalog { enabled: boolean; days?: Record<string, string[]>; error?: string }

export const activeStatus = (status: string) => ["queued", "pending", "running", "waiting-for-Azure", "downloading", "importing", "validating", "committing", "warming-cache", "authenticating", "submitting", "loading"].includes(status);
export function resumableJob(job: AdminJob): boolean {
  return ["failed", "partial", "interrupted", "cancelled"].includes(job.status)
    || (job.identity === "interactive" && ["queued", "pending"].includes(job.status));
}
export function reportDownloadHref(selection: ReportSelection): string {
  if (!["csv", "xlsx", "pptx"].includes(selection.format)) throw new Error("Choose a supported report format.");
  const params = new URLSearchParams({
    days: String(selection.days), summary: String(selection.summary),
    sections: selection.sections.join(","), blocks: selection.blocks.join(","), live: selection.live.join(","),
  });
  if (selection.scope.length) params.set("scope", selectedScope(selection.scope).join(","));
  if (selection.period_month) params.set("period_month", selection.period_month);
  if (selection.currency) params.set("currency", selection.currency);
  // Empty sections/blocks are intentional exclusions; toSearch omits them and would broaden the report.
  return `/api/report/${selection.format}?${params}`;
}
export function rawDownloadHref(selection: RawSelection): string {
  return `/api/archive/export/download${toSearch(rawParams(selection))}`;
}
export function retailPricing(values: Array<number | null | undefined>, required = values.length) {
  const priced = values.filter((value): value is number => value != null && Number.isFinite(value));
  const unpriced = Math.max(required, values.length) - priced.length;
  return { complete: unpriced === 0, unpriced, assessed: priced.reduce((sum, value) => sum + value, 0) };
}
export function pollInterval(active: boolean, reads: number, error: unknown): number | false {
  return active && reads < 120 && !error ? 15_000 : false;
}
export function selectedScope(ids: string[]): string[] {
  const scope = [...new Set(ids.map(id => id.trim().toLowerCase()).filter(Boolean))].sort();
  if (!scope.length) throw new Error("Choose at least one subscription. An empty selection never means all subscriptions.");
  if (scope.length > 200) throw new Error("Choose at most 200 subscriptions.");
  return scope;
}
export function dateWindow(start: string, end: string, max = 365, today = new Date().toISOString().slice(0, 10)): number {
  const dates = [start, end].map(value => new Date(`${value}T00:00:00Z`));
  if (![start, end].every((value, i) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(dates[i]!.getTime()) && dates[i]!.toISOString().slice(0, 10) === value)) throw new Error("Choose valid UTC dates.");
  const count = (dates[1]!.getTime() - dates[0]!.getTime()) / 86400000 + 1;
  if (count < 1 || count > max || end > today) throw new Error(`Choose 1–${max} inclusive days, with no future dates.`);
  return count;
}
export function costRequest(scope: string[], action: CostAction, cadence: Cadence, start: string, end: string): CostRequest {
  const request: CostRequest = { scope: selectedScope(scope), action, cadence };
  if (action === "setup" || action === "reconcile") {
    const count = dateWindow(start, end, action === "reconcile" ? 366 : 365);
    Object.assign(request, { start, end }, action === "setup" ? { history_days: count } : {});
  }
  return request;
}
export const catalogQuery = queryOptions({ queryKey: ["admin-cost-catalog"], queryFn: ({ signal }) => api<Catalog>("cost-data/subscriptions", undefined, { signal }), staleTime: 60_000 });
export const costStatusQuery = (scope: string[]) => queryOptions({
  queryKey: ["admin-cost-status", scope.join(",")], enabled: !!scope.length,
  queryFn: ({ signal }) => api<CostStatus>("cost-data", { scope: selectedScope(scope) }, { signal }), retry: false,
  refetchInterval: q => pollInterval(!!q.state.data?.subscriptions.some(s => activeStatus(s.status)), q.state.dataUpdateCount, q.state.error),
});
export const costJobsQuery = (scope: string[]) => queryOptions({
  queryKey: ["admin-cost-jobs", scope.join(",")], enabled: !!scope.length,
  queryFn: ({ signal }) => api<{ jobs: AdminJob[] }>("focus/jobs", { scope: selectedScope(scope) }, { signal }), retry: false,
  refetchInterval: q => pollInterval(!!q.state.data?.jobs.some(j => activeStatus(j.status)), q.state.dataUpdateCount, q.state.error),
});
export const singleJobQuery = (id: string, scope: string[]) => queryOptions({
  queryKey: ["admin-import-job", id, scope.join(",")], enabled: !!id && !!scope.length,
  queryFn: ({ signal }) => api<AdminJob>(`jobs/${encodeURIComponent(id)}`, undefined, { signal }), retry: false,
  refetchInterval: q => pollInterval(activeStatus(q.state.data?.status ?? ""), q.state.dataUpdateCount, q.state.error),
});
export const reportOptionsQuery = (scope: Scope, days: number, currency: string) => queryOptions({
  queryKey: ["admin-report-options", scope.scope ?? "", periodParam(scope) ?? "", days, currency],
  queryFn: ({ signal }) => api<ReportOptions>("report/options", { scope: scope.scope, period_month: periodParam(scope), days, currency }, { signal }),
});
export const auditQuery = (limit: number, enabled: boolean) => queryOptions({
  queryKey: ["admin-audit", limit], enabled, retry: false,
  queryFn: ({ signal }) => api<{ entries: AuditEntry[]; count: number }>("dashboard/audit", { limit }, { signal }),
});
export const postAdmin = <T>(path: string, body: unknown, signal?: AbortSignal, params?: Query) =>
  api<T>(path, params, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });

/** Cancelling a review invalidates even a server response that ignores AbortSignal. */
export class ApprovalSession {
  private generation = 0;
  private controller: AbortController | null = null;
  private locked = false;
  cancel() { this.generation++; this.controller?.abort(); this.controller = null; this.locked = false; }
  async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (this.locked) return undefined;
    this.locked = true;
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    try { const result = await work(controller.signal); return generation === this.generation ? result : undefined; }
    catch (error) { if (generation !== this.generation || controller.signal.aborted) return undefined; throw error; }
    finally { if (generation === this.generation) { this.locked = false; this.controller = null; } }
  }
}
export function approvalBody(request: CostRequest, plan: CostPlan, idempotency: string, reviewedAt: number, now = Date.now()) {
  if (!plan.can_start || !plan.preview_token || !idempotency || now - reviewedAt > 600_000) throw new Error("Review expired or blocked. Review the exact selection again.");
  if (request.action !== plan.action || request.cadence !== plan.cadence || selectedScope(request.scope).join(",") !== selectedScope(plan.subscriptions.map(s => s.subscription)).join(",")) throw new Error("Scope or action changed. Review again.");
  if (request.start && (request.start !== plan.from || request.end !== plan.to)) throw new Error("Dates changed. Review again.");
  if (request.history_days !== undefined && request.history_days !== plan.history_days) throw new Error("History length changed. Review again.");
  return { ...request, preview_token: plan.preview_token, idempotency_key: idempotency };
}
export function rawParams(selection: RawSelection): Query {
  const scope = selectedScope(selection.scope);
  if (!["csv", "parquet"].includes(selection.fmt)) throw new Error("Choose CSV or Parquet.");
  if (selection.since || selection.until) dateWindow(selection.since, selection.until, 36500);
  return { ...selection, scope };
}
export function safeFilename(header: string | null, fallback: string): string {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  let value = header?.match(/filename="?([^";]+)"?/i)?.[1] ?? fallback;
  if (encoded) { try { value = decodeURIComponent(encoded); } catch { return fallback; } }
  if (/[/\\:\x00-\x1f\x7f]/.test(value) || /%(?:2f|5c|00|0a|0d)/i.test(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || value === "." || value === ".." || value.length > 180 || value.split(".").pop()?.toLowerCase() !== fallback.split(".").pop()?.toLowerCase()) return fallback;
  return value;
}
export async function downloadFile(path: string, fallback: string, params?: Query, init?: RequestInit): Promise<void> {
  const response = await fetch(`/api/${path}${toSearch(params)}`, { credentials: "same-origin", ...init });
  if (response.status === 401) {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new ApiError(401, "Sign in to continue.");
  }
  if (!response.ok) {
    const text = await response.text();
    let message = text.slice(0, 300);
    try { const body: unknown = JSON.parse(text); if (body && typeof body === "object" && "detail" in body) message = String(body.detail); } catch { /* Plain error bodies remain visible. */ }
    throw new ApiError(response.status, message || response.statusText);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/csv|application\/(octet-stream|vnd\.openxmlformats-officedocument\.(spreadsheetml\.sheet|presentationml\.presentation)|vnd\.apache\.parquet|parquet)/i.test(contentType)) throw new Error("The server returned an unexpected file type. No file was saved.");
  const blob = await response.blob();
  if (init?.signal?.aborted) return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = safeFilename(response.headers.get("content-disposition"), fallback);
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
