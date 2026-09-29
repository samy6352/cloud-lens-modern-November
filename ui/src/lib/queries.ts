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

const scopeParams = ({ month, scope }: Scope) => ({ period_month: month, scope });

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
