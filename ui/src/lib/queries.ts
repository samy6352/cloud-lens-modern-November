import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";

export interface Me {
  authenticated: boolean;
  mode: string;
  user: { name: string; email?: string; admin: boolean; source: string } | null;
}

export interface Subscription {
  id: string;
  name: string | null;
  currency?: string | null;
  cost: number | null;
  in_warehouse: boolean;
  /** false is historical-only; null/absence means live access could not be verified. */
  azure_access?: boolean | null;
  tenant_name?: string;
}

export interface ReportingPeriod {
  from: string;
  to: string;
  month: string | null;
  days: number;
  as_of: string;
  available_months: string[];
  empty: boolean;
}

export interface Ranked {
  id?: string;
  name: string;
  /** Areas carry a display label instead of a name. */
  label?: string;
  cost: number;
  previous: number | null;
  delta: number | null;
  change_pct: number | null;
  share_pct: number | null;
}

export interface ExecutiveView {
  currency: string | null;
  days: number;
  as_of: string;
  kpis: {
    total: number | null;
    previous: number | null;
    change_pct: number | null;
    daily_avg: number | null;
    resources: number | null;
    services: number | null;
    subscriptions: number | null;
    regions: number | null;
    top5_share_pct: number | null;
  };
  trend: { labels: string[]; values: Array<number | null>; previous: Array<number | null>; partial_last: boolean };
  areas: Ranked[];
  monthly: { months: string[]; areas: Array<{ id: string; label: string; data: number[] }>; currency: string } | null;
  movers: Ranked[];
  services: Ranked[];
  subscriptions: Ranked[];
  resource_groups: Ranked[];
  regions: Ranked[];
}

export interface Executive extends ExecutiveView {
  mixed_currency: boolean;
  by_currency?: ExecutiveView[];
  notice?: string;
}

export const BILLING_METRICS = [
  "recorded_cost",
  "billed_cost",
  "effective_cost",
  "list_cost",
  "contracted_cost",
  "azure_discounts",
  "reservation_savings",
  "savings_plan_savings",
  "actual_savings",
] as const;
export type BillingMetric = (typeof BILLING_METRICS)[number];

export type BillingKpis = Record<BillingMetric, number | null> & { effective_discount_pct: number | null };

export interface BillingRow extends Record<BillingMetric, number | null> {
  id: string;
  name: string;
  subscription_id: string | null;
  resource_group: string | null;
  currency: string | null;
  cost: number | null;
  effective_discount_pct: number | null;
  rows: number;
  is_other: boolean;
  group_count: number;
}

export interface Billing {
  period: { month: string; label: string; start: string; end: string; days: number; previous_month: string };
  currency: string | null;
  kpis: BillingKpis;
  per_currency: Array<{ currency: string; kpis: BillingKpis }>;
  breakdowns: { subscriptions: BillingRow[]; services: BillingRow[]; resources: BillingRow[] };
  warnings: string[];
  definitions: Array<{ label: string; explanation: string }>;
}

/** Global filters carried in the URL: ?month=2026-08&scope=<id>,<id> */
export interface Scope {
  month?: string;
  scope?: string;
}

export interface ResourceRow {
  id: string;
  name: string;
  resource_group: string | null;
  subscription: string | null;
  subscription_id: string | null;
  service: string | null;
  service_names: string[];
  area: string;
  area_id: string;
  region: string | null;
  currency: string;
  cost: number;
  prior_cost: number;
  delta: number;
  change_pct: number | null;
  tags: Array<{ key: string; value: string }>;
  tag_count: number;
  first_seen: string | null;
  last_seen: string | null;
}

export type ResourceSort = "cost" | "prior" | "delta";
export type ResourceChange = "" | "increased" | "decreased" | "unchanged" | "no-baseline";

export interface ResourcePage {
  empty?: boolean;
  days: number;
  as_of?: string;
  currency: string | null;
  mixed_currency: boolean;
  currencies: string[];
  resources: ResourceRow[];
  page: number;
  page_size: number;
  pages: number;
  total: number;
  resources_by_currency: Record<string, number>;
  total_cost_by_currency: Record<string, number | null>;
  prior_cost_by_currency: Record<string, number | null>;
  truncated: boolean;
  source: "ranked" | "window" | "filtered" | "legacy";
}

export interface ResourceQuery {
  page: number;
  pageSize: number;
  sort: ResourceSort;
  desc: boolean;
  q: string;
  currency: string;
  change: ResourceChange;
}

const scopeParams = ({ month, scope }: Scope) => ({ period_month: month, scope });

export type SetupState = "queued" | "running" | "landed" | "loaded" | "failed" | "none";

export interface SetupBlocker {
  capability: string;
  detail: string;
  fix?: string;
}

export interface SetupProgress {
  enabled: boolean;
  months: string[];
  subscriptions: Array<{
    id: string;
    name: string;
    configured: boolean;
    job_id: string | null;
    cells: Record<string, { state: SetupState; detail: string; retry_at: string | null }>;
    blockers: SetupBlocker[];
  }>;
  totals: Record<SetupState, number>;
  history: { from: string; to: string };
  /** Months managed setup imports: `chosen` (3 unless an administrator added earlier months), at most `max`. */
  history_months: { chosen: number; default: number; max: number };
  expectation: string;
  checked_at: string | null;
  error: string | null;
  deployment_blockers: SetupBlocker[];
  concurrency: number;
  states: Record<SetupState, string>;
}

/** First-run export setup. Polls while Azure is still generating or importing months. */
export const setupProgressQuery = (s: Scope) =>
  queryOptions({
    queryKey: ["setup-progress", s.scope ?? ""],
    queryFn: () => api<SetupProgress>("cost-data/progress", { scope: s.scope }),
    staleTime: 15_000,
    refetchInterval: (query) => {
      const t = query.state.data?.totals;
      return t && t.queued + t.running + t.landed > 0 ? 30_000 : false;
    },
  });

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => api<Me>("auth/me"),
  staleTime: 5 * 60_000,
});

export const subscriptionsQuery = queryOptions({
  queryKey: ["subscriptions"],
  queryFn: () => api<{ subscriptions: Subscription[]; count: number }>("subscriptions"),
  staleTime: 10 * 60_000,
});

export const periodQuery = (s: Scope) =>
  queryOptions({
    queryKey: ["reporting-period", s.month ?? "", s.scope ?? ""],
    queryFn: () => api<ReportingPeriod>("reporting-period", scopeParams(s)),
    staleTime: 10 * 60_000,
  });

export const executiveQuery = (s: Scope) =>
  queryOptions({
    queryKey: ["executive", s.month ?? "", s.scope ?? ""],
    queryFn: () => api<Executive>("dashboard/executive", { days: 30, ...scopeParams(s) }),
  });

export const billingQuery = (s: Scope) =>
  queryOptions({
    queryKey: ["billing", s.month ?? "", s.scope ?? ""],
    // Billing is a calendar statement; without a month the server picks the latest complete one.
    queryFn: () => api<Billing>("dashboard/billing", { month: s.month, scope: s.scope }),
  });

/** One server-sorted, server-filtered page of every billed resource. */
export const resourcesQuery = (s: Scope, r: ResourceQuery) =>
  queryOptions({
    queryKey: ["resources", s.month ?? "", s.scope ?? "", r.page, r.pageSize, r.sort, r.desc, r.q, r.currency, r.change],
    queryFn: () =>
      api<ResourcePage>("dashboard/resources", {
        days: 30,
        ...scopeParams(s),
        page: r.page,
        page_size: r.pageSize,
        sort: r.sort,
        order: r.desc ? "desc" : "asc",
        q: r.q,
        billing_currency: r.currency,
        change: r.change,
      }),
  });

export interface AnomalyIncident {
  id: string;
  dimension: string;
  key: string;
  currency: string;
  direction: "up" | "down";
  first_day: string;
  last_day: string;
  duration_days: number;
  days: number;
  peak_day: string;
  cost: number | null;
  baseline: number | null;
  peak_delta: number | null;
  total_delta: number;
  score: number;
  severity: string;
}

export interface AnomalyReport {
  incidents: AnomalyIncident[];
  incident_count: number;
  count: number;
  high: number;
  increases: number;
  decreases: number;
  impact: number | null;
  currency: string | null;
  mixed_currency: boolean;
  partial: boolean;
  unavailable: boolean;
  note: string | null;
  days: number;
  window_from: string | null;
  window_to: string | null;
  daily: Array<{ day: string; cost: number }>;
}

/** Days that did not look like the others, collapsed into incidents. Warehouse-only on the server. */
export const anomaliesQuery = (s: Scope, days: number, currency: string) =>
  queryOptions({
    queryKey: ["anomalies", s.scope ?? "", days, currency],
    queryFn: () => api<AnomalyReport>("dashboard/anomalies", { days, scope: s.scope, currency }),
    staleTime: 60_000,
  });

export interface TagKey {
  key: string;
  cost: number;
  resources: number;
  platform: boolean;
  values: number;
}

export interface TagResource {
  id: string;
  name: string;
  service: string | null;
  subscription: string | null;
  subscription_id: string | null;
  group: string | null;
  cost: number;
  /** Tag keys on this resource; `v[i]` is the index into `TagReport.values` of the value for `keys[i]`. */
  keys: string[];
  v: number[];
  tag_status: "tagged" | "untagged" | "unknown";
}

export interface TagReport {
  keys: TagKey[];
  values: string[];
  resources: TagResource[];
  currency: string | null;
  mixed: boolean;
  tagged: { cost: number; resources: number };
  untagged: { cost: number; resources: number };
  unknown: { cost: number; resources: number };
  tags_not_loaded: boolean;
  total: number;
  days: number;
  truncated: boolean;
  latest: string | null;
}

/** Heavy on purpose (every tagged resource, filtered in the browser), so cached for minutes. */
export const tagsQuery = (s: Scope, days: number) =>
  queryOptions({
    queryKey: ["tags", s.scope ?? "", days, "warehouse"],
    queryFn: () => api<TagReport>("dashboard/tags", { days, scope: s.scope, include_live: false }),
    staleTime: 5 * 60_000,
  });

export interface LiveTagKeys {
  keys: Array<{ key: string; resources: number; platform: boolean }>;
  source: string;
}

export const liveTagKeysQuery = (s: Scope) =>
  queryOptions({
    queryKey: ["live-tag-keys", s.scope ?? ""],
    queryFn: () => api<LiveTagKeys>("dashboard/tags/live", { scope: s.scope }),
    enabled: false,
    retry: false,
  });

export interface UptimeMeter {
  id: string;
  key: string;
  name: string;
  service: string | null;
  subscription: string | null;
  resource_group: string | null;
  region: string | null;
  meter: string | null;
  hours: number;
  cost: number;
  rate: number;
  units: number;
  span_days: number;
  days_billed: number;
  uptime_pct: number | null;
  always_on: boolean;
  schedulable: boolean;
  schedule_status: string;
  first_day: string;
  last_day: string;
}

export interface UptimeReport {
  days: number;
  latest: string | null;
  currency: string | null;
  mixed_currency: boolean;
  truncated: boolean;
  totals: {
    hours: number;
    cost: number;
    total_spend: number;
    coverage_pct: number | null;
    avg_rate: number | null;
    run_rate: number | null;
    resources: number;
    meters: number;
    always_on: number;
    always_on_cost: number;
    schedulable: number;
    schedulable_cost: number;
  };
  resources: UptimeMeter[];
  trend: { labels: string[]; hours: number[]; cost: number[]; rate: number[] };
  weekday: Array<{ day: string; short: string; days: number; hours: number; cost: number }>;
  tags_not_loaded: boolean;
}

/** Hour-meter billing quantities (not monitored availability). Heavy: cached for minutes. */
export const uptimeQuery = (s: Scope, days: number) =>
  queryOptions({
    queryKey: ["uptime", s.scope ?? "", days],
    queryFn: () => api<UptimeReport>("dashboard/uptime", { days, scope: s.scope }),
    staleTime: 5 * 60_000,
  });

export interface ArchiveStatus {
  enabled: boolean;
  reachable: boolean;
  account: string;
  container: string;
  error?: string | null;
  count?: number;
  /** Datasets with at least two snapshot days, so they can be compared. */
  comparable?: string[];
  /** Snapshot days per dataset, newest first. */
  days?: Record<string, string[]>;
}

export interface ArchiveSide {
  day: string;
  cost: number;
  rows: number;
  from?: string | null;
  to?: string | null;
}

export interface ArchiveChange {
  key: string | null;
  was: number;
  now: number;
  delta: number;
  percent: number | null;
}

export interface ArchiveComparison {
  currency: string | null;
  group_by: string;
  earlier: ArchiveSide;
  later: ArchiveSide;
  total_delta: number | null;
  total_percent: number | null;
  row_delta: number;
  coverage_changed?: boolean;
  coverage_added?: { coverage_keys?: number; cost?: number };
  coverage_removed?: { coverage_keys?: number; cost?: number };
  comparison_period?: { from: string; to: string; days: number } | null;
  changes: ArchiveChange[];
}

export const archiveQuery = queryOptions({
  queryKey: ["archive"],
  queryFn: () => api<ArchiveStatus>("archive", { limit: 200 }),
  staleTime: 60_000,
});

/** What changed between two archived reads of the same dataset. */
export const archiveCompareQuery = (s: Scope, p: { dataset: string; earlier: string; later: string; groupBy: string }) =>
  queryOptions({
    queryKey: ["archive-compare", s.scope ?? "", p.dataset, p.earlier, p.later, p.groupBy],
    queryFn: () => api<ArchiveComparison>("archive/compare", { dataset: p.dataset, earlier: p.earlier, later: p.later, group_by: p.groupBy, top: 20, scope: s.scope }),
    staleTime: 5 * 60_000,
  });
