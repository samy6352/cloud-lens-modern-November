import { queryOptions } from "@tanstack/react-query";
import { api, type Query } from "./api";
import { formatMoney, formatNumber, type NumberSystem } from "./format";
import type { Scope } from "./queries";

export interface OptimizeScope extends Scope { currency?: string }
export interface Amount { currency: string; cost: number | null }
export interface Metric {
  name?: string; label?: string; value: number | null; status: string;
  unit?: string; aggregation?: string; samples?: number; last_sample?: string | null;
  note?: string; source?: string; input?: number | null; output?: number | null;
  maximum?: number | null; input_status?: string; output_status?: string; maximum_status?: string;
  expected_samples?: number; window?: { start?: string; end?: string } | null;
}
export interface Opportunity {
  key: string; id?: string; title: string; category: string; category_label: string;
  resource?: string; resource_id?: string; resource_group?: string; region?: string;
  currency?: string; window: number | null; annual: number | null; why?: string; action?: string;
  count: number; confidence?: string; corroborated?: boolean; folded?: number; more?: number;
  impact_class?: string; disputed?: { low: number; high: number };
  sources: Array<{ label: string; basis: string; claim: string }>;
  options: Array<{ label: string; annual: number | null; detail?: string }>;
  items?: Array<{ id?: string; name: string; group?: string; region?: string; cost: number | null; currency?: string }>;
}
export interface SavingsReport {
  currency: string | null; mixed_currency?: boolean; days: number; count: number;
  billed_total: number | null; projected_total: number | null; total?: number | null;
  merged?: number; variants_folded?: number; opportunities: Opportunity[];
  categories: Array<{ id: string; label: string; count: number; total: number | null }>;
  unavailable?: Record<string, string>; note?: string; error?: string;
  partial?: boolean; unconverted?: unknown[]; pricing_basis?: string;
  at_risk?: Opportunity[]; at_risk_count?: number; at_risk_total?: number | null; at_risk_note?: string;
  commitment_count?: number; commitment_annual?: number | null; commitment_note?: string;
  commitment_unpriced_count?: number;
  scan?: { status: string; completed?: string[]; errors?: Record<string, string>; total?: number };
  freshness?: { generated_at?: string; refreshing?: boolean; stale?: boolean; cached?: boolean };
}
export interface VmRow {
  id: string; name: string; resource_group?: string; region?: string; location?: string;
  size?: string; vm_size?: string; power_state?: string; state?: string;
  cpu_avg: number | null; cpu_max: number | null; cost: number | null; currency?: string;
  cost_by_currency?: Record<string, number | null>; pricing_status?: string; days_with_data?: number;
}
export interface RightsizingReport {
  vms: VmRow[]; currency: string | null; period_days: number; count: number;
  running?: number; idle_count?: number; stopped_count?: number; idle_cost?: number | null;
  cpu_threshold?: number; note?: string; error?: string; partial?: boolean;
  errors?: string[]; idle_cost_by_currency?: Record<string, number | null>;
}
export interface WasteItem {
  id?: string; name?: string; resource_group?: string; location?: string; region?: string;
  cost: number | null; currency?: string;
  cost_by_currency?: Record<string, number | null>; pricing_status?: string; detail?: string;
}
export interface WasteReport {
  currency: string | null; period_days: number; total_items: number; total_cost: number | null;
  subscriptions?: number; error?: string; note?: string;
  errors?: Record<string, string>; partial?: boolean; review_note?: string;
  total_by_currency?: Record<string, number | null>;
  findings: Array<{ category: string; count: number; cost?: number | null; why?: string; impact_note?: string; items: WasteItem[] }>;
}
export interface AdvisorRow {
  id?: string; impact?: string; problem?: string; solution?: string; resource?: string;
  currency?: string; annual_savings: number | null;
}
export interface AdvisorReport {
  category: string; count: number; currency: string | null; estimated_annual_savings: number | null;
  recommendations: AdvisorRow[]; note?: string; error?: string;
  errors?: Record<string, string>; partial?: boolean; annual_savings_by_currency?: Record<string, number | null>;
}
export interface ShutdownRow {
  id?: string; name: string; size?: string; resource_group?: string; location?: string; currency?: string;
  current: number | null; scheduled: number | null; saving: number | null; hours_saved?: number;
  avg_business?: number; avg_offhours?: number; ratio?: number; window?: string; busy_offhours_hours?: number;
}
export interface ShutdownReport {
  candidates: ShutdownRow[]; count: number; examined: number; currency: string | null;
  total_current: number | null; total_saving: number | null; hours_kept?: number;
  totals_by_currency?: Record<string, { total_current: number | null; total_saving: number | null }>;
  skipped_production?: number; skipped_steady?: number; partial?: boolean; note?: string; window?: string; days_analysed?: number; error?: string;
  errors?: string[];
}
export interface WhatIfReport {
  currency: string | null; days: number; current_size?: string; target_size: string;
  billed: { annual: number | null }; current_retail: { annual: number | null };
  target: { annual: number | null }; annual_saving: number | null; note?: string;
}
export interface Coverage {
  currency?: string | null; days?: number; empty?: boolean; mixed_currency?: boolean;
  total?: number | null; compute_total?: number | null; coverage_pct?: number | null;
  compute_coverage_pct?: number | null; coverage_status?: string; compute_coverage_status?: string;
  spot_pct?: number | null; split?: Record<string, number>; compute_split?: Record<string, number>;
  by_currency?: Record<string, Coverage>; trend?: CoverageTrend[]; trend_by_currency?: Record<string, CoverageTrend[]>;
}
export interface CoverageTrend { month: string; total?: number; on_demand: number; committed: number; spot: number }
export interface CommitmentRow {
  id?: string; name: string; kind: string; currency?: string; services?: string[]; resources: number;
  cost: number | null; idle?: boolean; resources_more?: number;
  resources_top?: Array<{ name: string; resource_group?: string; cost: number | null }>;
}
export interface PricingModel {
  label: string; baseline?: boolean; unavailable?: boolean; reason?: string; annual_cost: number | null;
  annual_saving: number | null; saving_pct?: number | null; commits_to?: string; term?: string;
  flexibility?: string; measured_over_days?: number; lookback_spread?: number;
  terms?: Array<{ term: string; annual_saving: number | null }>;
}
export interface Comparison {
  currency?: string | null; models?: PricingModel[]; best?: { annual_saving?: number | null };
  verdict?: string; note?: string; error?: string; source?: string; by_currency?: Record<string, Comparison>;
}
export interface SpotRow { month: string; currency?: string; spot_cost: number | null; would_have_cost: number | null; saved: number | null; priced_saving?: number | null; saved_pct?: number | null }
export interface CommitmentsReport {
  coverage: Coverage; comparison: Comparison;
  inventory: { commitments?: CommitmentRow[]; error?: string; count?: number; days?: number; truncated?: boolean; returned_count?: number; basis?: string; term_note?: string; idle?: string[]; currency?: string };
  spot: { empty?: boolean; currency?: string; total_saved?: number | null; trend?: SpotRow[]; trend_by_currency?: Record<string, SpotRow[]>; note?: string };
}
export interface RateRow { kind?: string; problem?: string; solution?: string; term?: string; sku?: string; region?: string; annual_savings?: number | null; annual_saving?: number | null; currency?: string; lookback_days?: number; impact?: string }
export interface RatesReport { commitments?: RateRow[]; usage?: RateRow[]; opportunities?: RateRow[]; recommendations?: RateRow[]; options?: RateRow[]; currency?: string; note?: string; error?: string; count?: number; estimated_annual_savings?: number | null }
export interface HybridRow {
  id?: string; name: string; resource_group?: string; size?: string; hybrid_benefit?: boolean;
  currency?: string; cost: number | null; estimated_annual_savings: number | null;
}
export interface HybridReport { vms: HybridRow[]; count: number; covered: number; uncovered: number; currency: string | null; estimated_annual_savings: number | null; days?: number; note?: string; error?: string }
export interface EsuRow { id?: string; name: string; product: string; kind: string; status: string; support_ends?: string; coverage?: string; monthly_esu_cost: number | null; currency?: string }
export interface EsuReport { machines: EsuRow[]; currency: string | null; out_of_support?: number; ending_soon?: number; exposed?: number; priced?: boolean; estimated_monthly_cost?: number | null; billed_esu?: number | null; scanned?: { vms?: number; arc?: number; sql?: number }; subscriptions?: number; note?: string; error?: string }
export interface PerformanceRow {
  id: string; name: string; type: string; region?: string; subscription_id?: string;
  status: string; metrics: Metric[]; notes?: string[];
  cost?: { from?: string; to?: string; by_currency: Amount[] } | null;
}
export interface PerformanceReport {
  status: string; resources: PerformanceRow[]; notices: string[]; generated_at: string;
  window: { start: string; end: string; days: number }; source: string;
  sampled_count: number; inventory_count: number | null; truncated?: boolean;
}
export interface AiAnomaly { metric: string; direction: string; day: string; actual: number | null; baseline: number | null; delta?: number | null; percent?: number | null; currency?: string; unit?: string; source?: string; severity?: string; score?: number; baseline_samples?: number; baseline_from?: string; baseline_to?: string; note?: string }
export interface AiAnomalyCheck {
  metric: string; currency?: string | null; status: string; note?: string;
  eligible_days: number; observed_days: number; checked_days: number; missing_days: number;
  insufficient_history_days: number; negative_days: number; excluded_tail_days: number;
}
interface AiEvidenceRow {
  resource_id: string | null; resource_name: string; subscription_id: string; service: string;
  tokens: Metric; utilization: Metric; cost_note?: string;
  recommendation?: string; notes?: string[] | null; anomaly_status?: string; anomaly_note?: string; anomalies?: AiAnomaly[] | null;
  anomaly_checks?: AiAnomalyCheck[];
}
export interface AiResourceRow extends AiEvidenceRow {
  id: string; subscription: string; services: string[]; models: string[];
  cost_by_currency: Amount[]; cost: number | null; currency: string | null;
  billing_rows: number; deployment_status?: string; metric_read_started?: boolean;
  meters: Array<{ product: string | null; meter: string | null; service: string; quantity: number | null; unit: string | null; cost: number | null; currency: string }>;
}
export interface AiDeploymentRow extends AiEvidenceRow {
  deployment: string; model: string | null; version: string | null; format: string | null; sku: string | null;
  cost: number | null; metadata_source: string;
  // Current ARM metadata has no deployment billing allocation or capacity/rate fields.
  cost_by_currency?: Amount[] | null;
}
export type AiRow = AiResourceRow | AiDeploymentRow;
export interface AiReport {
  status: "ok" | "partial"; services: AiResourceRow[]; models: AiDeploymentRow[]; totals: Amount[]; notices: string[];
  generated_at: string; window: { from: string | null; to: string | null; days?: number; timezone?: string; bounds?: string };
  source?: string; truncated?: boolean; metric_window?: Metric["window"];
  metric_coverage?: { accounts_with_tokens: number; eligible_accounts: number; queried_accounts?: number; accounts_with_complete_tokens?: number };
  anomaly_detection?: { method?: string; window_days?: number; min_history?: number; min_relative_change?: number; materiality?: { cost?: { delta: number }; tokens?: { delta: number }; utilization?: { delta: number } } };
}

export function optimizeQuery<T>(endpoint: string, scope: OptimizeScope, extra: Query = {}) {
  const params = { scope: scope.scope, currency: scope.currency, ...extra };
  return queryOptions({
    queryKey: ["optimize", endpoint, params],
    queryFn: async ({ signal }) => {
      const data = await api<T>(`dashboard/${endpoint}`, params, { signal });
      validateOptimizeReport(endpoint, data);
      return data;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}
export function validateOptimizeReport(endpoint: string, data: unknown): void {
  if (endpoint !== "performance" && endpoint !== "ai-billing") return;
  const common = isRecord(data) && typeof data.status === "string" && ["ok", "partial", "unavailable"].includes(data.status)
    && Array.isArray(data.notices) && data.notices.every(v => typeof v === "string")
    && isRecord(data.window) && typeof data.generated_at === "string";
  const valid = common && (endpoint === "performance" ? Array.isArray(data.resources) : validAiReport(data));
  if (!valid) throw new Error(`${endpoint === "performance" ? "Performance" : "AI billing"} returned incomplete evidence. Refresh this view to retry.`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nullableNumber(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}
function nullableText(value: unknown): boolean { return value === null || typeof value === "string"; }
function validAmounts(value: unknown): boolean {
  return Array.isArray(value) && value.every(a => isRecord(a) && typeof a.currency === "string" && nullableNumber(a.cost));
}
function validAiMetric(value: unknown): boolean {
  return isRecord(value) && typeof value.status === "string" && nullableNumber(value.value)
    && ["input", "output", "maximum", "samples", "expected_samples"].every(key => value[key] === undefined || nullableNumber(value[key]))
    && ["source", "note", "unit", "aggregation", "input_status", "output_status", "maximum_status"].every(key => value[key] === undefined || typeof value[key] === "string")
    && (value.window == null || validMetricWindow(value.window));
}
function validMetricWindow(value: unknown): boolean {
  return isRecord(value) && ["start", "end"].every(key => value[key] === undefined || typeof value[key] === "string");
}
function validAiCoverage(value: unknown): boolean {
  return isRecord(value) && ["accounts_with_tokens", "eligible_accounts"].every(key => typeof value[key] === "number" && Number.isFinite(value[key]));
}
function validAiEvidence(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && nullableText(value.resource_id) && typeof value.resource_name === "string"
    && typeof value.subscription_id === "string" && typeof value.service === "string"
    && validAiMetric(value.tokens) && validAiMetric(value.utilization)
    && ["recommendation", "cost_note", "anomaly_status", "anomaly_note"].every(key => value[key] === undefined || typeof value[key] === "string")
    && (value.notes == null || (Array.isArray(value.notes) && value.notes.every(n => typeof n === "string")))
    && (value.anomalies == null || (Array.isArray(value.anomalies) && value.anomalies.every(a =>
      isRecord(a) && typeof a.metric === "string" && typeof a.direction === "string" && typeof a.day === "string"
      && nullableNumber(a.actual) && nullableNumber(a.baseline)
      && (a.percent === undefined || nullableNumber(a.percent)) && (a.delta === undefined || nullableNumber(a.delta))
      && ["currency", "unit", "source", "note", "baseline_from", "baseline_to"].every(key => a[key] === undefined || typeof a[key] === "string"))))
    && (value.anomaly_checks === undefined || (Array.isArray(value.anomaly_checks) && value.anomaly_checks.every(c =>
      isRecord(c) && typeof c.metric === "string" && typeof c.status === "string"
      && (c.currency === undefined || nullableText(c.currency)) && (c.note === undefined || typeof c.note === "string")
      && ["eligible_days", "observed_days", "checked_days", "missing_days", "insufficient_history_days", "negative_days", "excluded_tail_days"].every(key => typeof c[key] === "number" && Number.isFinite(c[key])))));
}
function validAiReport(data: Record<string, unknown>): boolean {
  return ["ok", "partial"].includes(String(data.status)) && isRecord(data.window)
    && nullableText(data.window.from) && nullableText(data.window.to)
    && validAmounts(data.totals)
    && Array.isArray(data.services) && data.services.every(r => validAiEvidence(r)
      && typeof r.id === "string" && typeof r.subscription === "string"
      && nullableNumber(r.cost) && nullableText(r.currency) && typeof r.billing_rows === "number" && Number.isFinite(r.billing_rows)
      && Array.isArray(r.services) && r.services.every(v => typeof v === "string")
      && Array.isArray(r.models) && r.models.every(v => typeof v === "string") && validAmounts(r.cost_by_currency)
      && Array.isArray(r.meters) && r.meters.every(m => isRecord(m) && nullableText(m.product)
        && nullableText(m.meter) && nullableText(m.unit) && nullableNumber(m.quantity)
        && nullableNumber(m.cost) && typeof m.currency === "string"))
    && Array.isArray(data.models) && data.models.every(r => validAiEvidence(r)
      && typeof r.deployment === "string" && ["model", "version", "format", "sku"].every(key => nullableText(r[key]))
      && typeof r.metadata_source === "string" && nullableNumber(r.cost)
      && (r.cost_by_currency == null || validAmounts(r.cost_by_currency)))
    && (data.metric_coverage === undefined || validAiCoverage(data.metric_coverage));
}
export function aiAmounts(row: AiRow): Amount[] | null {
  return row.cost_by_currency ?? null;
}
export function aiRowKey(row: AiRow): string {
  return "deployment" in row ? `${row.subscription_id}|${row.resource_id}|${row.deployment}` : row.id;
}
export function performanceScope(scope?: string): { ids: string[]; error: string | null } {
  const ids = [...new Set((scope ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean))];
  if (!ids.length || ids.length > 100) return { ids, error: "Select 1–100 accessible subscriptions to load performance evidence." };
  if (ids.some(id => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
    return { ids, error: "Subscription scope must contain valid Azure subscription IDs." };
  }
  return { ids, error: null };
}
export function nativeMoney(value: number | null | undefined, currency?: string | null, system?: NumberSystem): string {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  return /^[A-Z]{3}$/.test(currency ?? "")
    ? `${currency} ${formatMoney(value, currency, { system, digits: 2 })}`
    : `${formatNumber(value, { system, digits: 2 })} (currency unknown)`;
}
export function nativeBuckets(buckets: Record<string, number | null> | undefined, fallback: number | null | undefined, currency?: string | null, system?: NumberSystem): string {
  return buckets && Object.keys(buckets).length
    ? Object.entries(buckets).map(([code, value]) => nativeMoney(value, code, system)).join(" · ")
    : nativeMoney(fallback, currency, system);
}
export function metricValue(metric?: Metric, percent = false): string {
  if (metric?.status === "not_applicable") return "Not applicable";
  if (metric?.status === "unsupported") return "Not supported";
  if (metric?.status === "no_data") return "No observations";
  if (!metric || !["ok", "partial"].includes(metric.status) || metric.value == null || !Number.isFinite(metric.value)) return "Unavailable";
  return percent ? `${metric.value.toFixed(1)}%` : `${formatNumber(metric.value, { digits: Number.isInteger(metric.value) ? 0 : 3 })}${metric.unit ? ` ${metric.unit}` : ""}`;
}
export function canSimulate(resourceId?: string): boolean {
  return /^\/subscriptions\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/resourcegroups\/[^/]+\/providers\/microsoft\.compute\/virtualmachines\/[^/]+$/i.test(resourceId ?? "");
}
export function whatIfBody(resourceId: string, targetSku: string) {
  if (!canSimulate(resourceId)) throw new Error("Select a supported virtual machine for this simulation.");
  const sku = targetSku.trim();
  if (!sku || (sku !== "shutdown" && !/^Standard_[A-Za-z0-9_-]{1,100}$/i.test(sku))) throw new Error("Enter a valid target VM size, for example Standard_B2s.");
  return { resource_id: resourceId, target_sku: sku };
}
export function observedTokens(rows: ReadonlyArray<{ tokens: Metric }>) {
  const observed = rows.filter(row => ["ok", "partial"].includes(row.tokens?.status) && row.tokens.value != null && Number.isFinite(row.tokens.value));
  return { value: observed.length ? observed.reduce((sum, row) => sum + row.tokens.value!, 0) : null,
    measured: observed.length, total: rows.length, partial: observed.length !== rows.length || observed.some(row => row.tokens.status === "partial") };
}
export function anomalyDirection(row: { anomalies?: ReadonlyArray<{ direction: string }> | null }) {
  const directions = new Set((row.anomalies ?? []).map(a => a.direction).filter(d => d === "up" || d === "down"));
  return directions.size > 1 ? "Spike and drop" : directions.has("up") ? "Spike" : directions.has("down") ? "Drop" : null;
}
export function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
}
