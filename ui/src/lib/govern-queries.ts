import { queryOptions } from "@tanstack/react-query";
import { api, type Query } from "./api";
import type { Me, Scope, Subscription } from "./queries";

export function globalScope(search: { scope?: unknown; month?: unknown }): Scope {
  return { scope: typeof search.scope === "string" ? search.scope : undefined, month: typeof search.month === "string" ? search.month : undefined };
}

export function explicitScopes(scope?: string): string[] {
  const ids = [...new Set((scope ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean))];
  return ids.length >= 1 && ids.length <= 100 && ids.every(id => /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) ? ids : [];
}

const read = <T>(key: string, path: string, params: Query = {}, enabled = true) => queryOptions({
  queryKey: ["govern", key, params], enabled,
  queryFn: ({ signal }) => api<T>(path, params, { signal }),
  staleTime: 120_000, retry: false,
});
export const governMeQuery = read<Me>("me", "auth/me");
export const governSubscriptionsQuery = read<{ subscriptions: Subscription[] }>("subscriptions", "subscriptions");
export interface BudgetTagInventory {
  native_currencies?: Record<string, string[]>; keys?: Array<{ key: string }>; values?: string[];
  resources?: Array<{ subscription_id?: string; keys: string[]; v: number[] }>; truncated?: boolean;
}
export const budgetTagInventoryQuery = (subscription: string, month?: string) =>
  read<BudgetTagInventory>("budget-tag-inventory", "dashboard/tags", { scope: subscription, period_month: month, days: 30 }, explicitScopes(subscription).length === 1);
export function budgetNativeCurrency(data: BudgetTagInventory | undefined, subscription: string): string | null {
  const currencies = data?.native_currencies?.[subscription.toLowerCase()] ?? [];
  return currencies.length === 1 && /^[A-Z]{3}$/.test(currencies[0] ?? "") ? currencies[0]! : null;
}

export interface Capability {
  feature: string; subscription_id?: string; status: string; authorization_status?: string; reason?: string;
  principal?: { kind?: string };
}
export interface Capabilities {
  identity?: { kind?: string }; capabilities: Capability[]; read_only?: boolean;
  deployment_policy?: { read_only?: boolean; mutations_blocked?: boolean };
}
export const governCapabilitiesQuery = (subscription: string) =>
  read<Capabilities>("capabilities", "capabilities", { scope: subscription }, explicitScopes(subscription).length === 1);

export function budgetPermission(me: Me | undefined, capabilities: Capabilities | undefined, subscription: string): { allowed: boolean; reason: string } {
  if (!me?.authenticated || !me.user) return { allowed: false, reason: "Sign in before creating a budget." };
  if (!capabilities) return { allowed: false, reason: "Verify this subscription's Azure access before reviewing a write." };
  if (capabilities.read_only || capabilities.deployment_policy?.read_only || capabilities.deployment_policy?.mutations_blocked)
    return { allowed: false, reason: "Deployment read-only policy blocks budget creation." };
  const delegated = me.user.source === "entra" && capabilities.identity?.kind === "delegated-user";
  if (!me.user.admin && !delegated) return { allowed: false, reason: "An admin or delegated Azure sign-in is required. Local non-admin users cannot borrow the app identity." };
  const capability = capabilities.capabilities.find(c => c.feature === "budgets-write" && c.subscription_id?.toLowerCase() === subscription.toLowerCase());
  if (!capability || !(capability.authorization_status === "declared-allowed" || (capability.authorization_status == null && capability.status === "declared-allowed")))
    return { allowed: false, reason: capability?.reason || "Budget write permission is denied or unknown. Azure permissions must be verified." };
  return { allowed: true, reason: "Declared budget access is not a trial write. Azure enforces permissions; explicit confirmation is still required." };
}

export interface BudgetTrend {
  labels: string[]; cumulative: number[]; daily?: number[]; currency?: string | null; total: number | null; filtered_exactly?: boolean;
}
export interface Budget {
  name: string; subscription: string; subscription_id: string; amount: number | null; current_spend: number | null;
  remaining: number | null; currency: string | null; time_grain: string; percent_used: number | null; status: string;
  start: string | null; end: string | null; filter?: string; filter_exact?: boolean; tag_filter?: Array<[string, string[]]>;
  alerts?: number; alerting?: number[]; trend?: BudgetTrend | null; trend_note?: string | null;
}
export interface BudgetList {
  budgets: Budget[]; count?: number; partial?: boolean; error?: string | null; note?: string;
  unavailable_subscriptions?: Array<{ id: string; name: string }>; subscriptions_requested?: number; subscriptions_read?: number; demo_mode?: boolean;
}
export const budgetsQuery = (s: Scope, refresh = false) => read<BudgetList>("budgets", "budgets", { scope: s.scope, refresh });
export const budgetTrendQuery = (b: Budget) => read<Pick<Budget, "trend" | "trend_note" | "filter_exact" | "tag_filter">>(
  "budget-trend", "budgets/trend", { subscription_id: b.subscription_id, name: b.name, currency: b.currency ?? undefined }, b.filter_exact !== false && !b.trend_note);
export function budgetStatus(b: Budget): string {
  return Number.isFinite(b.current_spend) && Number.isFinite(b.percent_used) && ["over", "near", "ok"].includes(b.status) ? b.status : "unknown";
}
export function nativeMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "Unavailable";
  return `${currency || "Unit not reported"} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export interface BudgetDraft {
  subscription: string; name: string; amount: number; time_grain: "Monthly" | "Quarterly" | "Annually";
  start: string; end: string; tags: Array<{ key: string; values: string[] }>; mode: "all" | "any"; thresholds: number[]; emails: string[];
}
export interface BudgetCreated {
  name: string; subscription_id?: string; amount: number; time_grain: string; start: string; end: string;
  notifications: number; thresholds?: number[]; emails?: string[]; portal_url?: string;
}
export function validateBudget(d: BudgetDraft, currency?: string | null): string[] {
  const errors: string[] = [];
  if (explicitScopes(d.subscription).length !== 1) errors.push("Select one valid subscription.");
  if (!currency) errors.push("Native billing currency is unknown or mixed; creation is disabled.");
  if (!/^[a-z\d][a-z\d_.-]{0,62}$/i.test(d.name)) errors.push("Name must start with a letter or digit; use up to 63 letters, digits, dots, hyphens or underscores.");
  if (!Number.isFinite(d.amount) || d.amount <= 0) errors.push("Amount must be finite and greater than zero.");
  if (!["Monthly", "Quarterly", "Annually"].includes(d.time_grain)) errors.push("Choose a supported reset period.");
  const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if (!validDate(d.start) || !d.start.endsWith("-01")) errors.push("Start on the first day of a month.");
  if (!validDate(d.end) || d.end <= d.start) errors.push("Expiry must be after the start date.");
  if (!d.tags.length || d.tags.length > 10) errors.push("Select between 1 and 10 tag clauses.");
  if (d.tags.some(t => !t.key.trim() || t.key.length > 512 || t.values.length > 50 || t.values.length === 0)) errors.push("Each tag needs a key and 1–50 values.");
  if (new Set(d.tags.map(t => t.key.toLowerCase())).size !== d.tags.length) errors.push("Use each tag key only once.");
  if (!["all", "any"].includes(d.mode)) errors.push("Choose all or any tag matching.");
  if (d.mode === "any" && d.tags.length > 1) errors.push("Azure cannot combine multiple tag keys with OR. Use all tags or a single key.");
  if (d.thresholds.length > 5 || d.thresholds.some(t => !Number.isFinite(t) || t <= 0 || t > 1000)) errors.push("Use at most five thresholds, each greater than 0 and at most 1000 percent.");
  if (d.thresholds.length && !d.emails.length) errors.push("Alerts need at least one email address.");
  if (d.emails.some(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) errors.push("Enter valid notification email addresses.");
  return errors;
}
export const createBudget = (draft: BudgetDraft, signal?: AbortSignal) => api<BudgetCreated>("budgets", undefined, {
  method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
});

const officialHosts = new Set(["azure.microsoft.com", "www.microsoft.com", "learn.microsoft.com", "portal.azure.com", "azure.status.microsoft", "status.azure.com"]);
export function safeOfficialUrl(value: string | null | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password && !url.port && officialHosts.has(url.hostname.toLowerCase()) ? url.href : null;
  } catch { return null; }
}
export function resourcePortal(id: string | null | undefined): string | null {
  if (!id || !/^\/subscriptions\/[\da-f-]{36}\/(?:resourceGroups\/[^/]+|providers\/[^/]+\/.+)/i.test(id) || /[\u0000-\u001f]/.test(id)) return null;
  return `https://portal.azure.com/#resource${id.split("/").map(encodeURIComponent).join("/")}/overview`;
}
export function budgetPortal(b: Pick<Budget, "subscription_id" | "name">): string | null {
  if (explicitScopes(b.subscription_id).length !== 1) return null;
  return `https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/budgets/scope/${encodeURIComponent(`/subscriptions/${b.subscription_id}`)}`;
}
export function subscriptionFromId(id?: string | null): string { return id?.match(/^\/subscriptions\/([^/]+)/i)?.[1] ?? ""; }

export interface GovernResource {
  id?: string; name?: string; type?: string; resourceGroup?: string; location?: string; subscriptionId?: string;
  cost?: number | null; currency?: string | null; vmName?: string; vmId?: string; nicName?: string; vmSize?: string; powerState?: string;
}
export interface GovernanceReport {
  tagging: { error?: string; note?: string; reason?: string; days?: number; coverage_pct?: number | null; untagged_total?: number;
    scanned?: { resources: number; tagged: number }; resources?: GovernResource[];
    by_type?: Array<{ type: string; full_type: string; total: number; tagged: number; untagged: number; coverage_pct: number | null }>;
    tag_keys?: Array<{ key: string; count: number }> };
  accelerated_networking: { error?: string; note?: string; reason?: string; eligible?: GovernResource[]; enabled?: number; catalogue?: boolean; scanned?: { nics: number; vms?: number } };
  orphaned_resource_groups: { error?: string; note?: string; reason?: string; groups?: GovernResource[]; truncated?: boolean };
}
export const governanceQuery = (s: Scope, days: number) => read<GovernanceReport>("governance", "dashboard/governance", { scope: s.scope, days });
export interface GovernanceFinding {
  id: string; resource: string; resourceId: string; group: string; subscription: string; region: string;
  category: string; resourceType: string; severity: string; evidence: string; cost?: number | null; currency?: string | null;
}
export function governanceFindings(d: GovernanceReport): GovernanceFinding[] {
  const map = (r: GovernResource, category: string, severity: string, evidence: string, index: number): GovernanceFinding => {
    const resourceId = r.vmId || r.id || "";
    return { id: `${category}:${resourceId}:${index}`, resource: r.vmName || r.name || r.nicName || "Unnamed resource", resourceId,
      group: r.resourceGroup || "", subscription: r.subscriptionId || subscriptionFromId(resourceId), region: r.location || "",
      category, resourceType: r.type || (category === "Accelerated networking" ? "microsoft.compute/virtualmachines" : "microsoft.resources/resourcegroups"), severity, evidence, cost: r.cost, currency: r.currency };
  };
  return [
    ...(d.tagging.resources ?? []).map((r, i) => map(r, "Tag coverage", "Warning", "Billed resource has no allocation tags.", i)),
    ...(d.accelerated_networking.eligible ?? []).map((r, i) => map(r, "Accelerated networking", d.accelerated_networking.catalogue ? "Warning" : "Unverified",
      `${r.vmSize || "Size unknown"} · ${r.powerState || "Power state unknown"} · NIC ${r.nicName || "unknown"}. ${d.accelerated_networking.note || ""}`, i)),
    ...(d.orphaned_resource_groups.groups ?? []).map((r, i) => map(r, "Empty resource group", "Information",
      "No resources observed. Locks, roles and policies are not checked; verify before any cleanup.", i)),
  ];
}

export interface EsuMachine {
  id: string; name: string; resource_group: string; location: string; kind: string; detail: string; product: string;
  support_ends: string; esu_ends?: string; days_remaining: number; status: string; covered: boolean;
  coverage: string; monthly_esu_cost: number | null; cores?: number | null; connection?: string;
}
export interface EsuReport {
  machines: EsuMachine[]; count?: number; out_of_support?: number; ending_soon?: number; exposed?: number;
  estimated_monthly_cost?: number; billed_esu?: number; currency?: string; priced?: boolean; note?: string;
  scanned?: { vms: number; arc: number; sql: number }; error?: string;
}
export const esuQuery = (s: Scope, days: number) => read<EsuReport>("esu", "dashboard/esu", { scope: s.scope, days });

export interface Advisory {
  tracking: string; headline: string; summary?: string; actions?: string; type?: string; level?: string; started?: string; updated?: string;
  due: string | null; days_left: number | null; overdue: boolean; retirement: boolean; resource_count: number;
  resources: Array<{ name?: string; id?: string }>; subscriptionId?: string;
}
export interface HealthReport {
  advisories?: Advisory[]; error?: string; reason?: string; note?: string; next_deadline?: string | null;
  counts?: { active: number; retirements: number; due_90_days: number; overdue: number; impacted_resources: number };
}
export const retirementsQuery = (s: Scope) => read<HealthReport>("retirements", "dashboard/health", { scope: s.scope });
export function urgency(a: Pick<Advisory, "days_left">): string {
  return a.days_left == null ? "No deadline" : a.days_left < 0 ? "Overdue" : a.days_left <= 30 ? "Due in 30 days" : a.days_left <= 90 ? "Due in 90 days" : "Later";
}

export interface ChangeCost { by_currency: Array<{ currency: string; cost: number | null }>; from?: string; to?: string; }
export interface ChangeRecord {
  id: string; resource_id: string; resource_name: string; resource_type: string; subscription_id: string;
  changed_at: string; change_type: string; actor: string | null; operation: string | null; cost: ChangeCost | null;
  properties: Array<{ name: string; before: unknown; after: unknown }>; properties_truncated: boolean;
}
export interface ChangesReport {
  status: "ok" | "partial" | "unavailable"; error?: string; generated_at: string; window: { start: string; end: string; days: number };
  notices: string[]; changes: ChangeRecord[]; truncated: boolean;
}
export const changesQuery = (s: Scope, days: number) => read<ChangesReport>("changes", "dashboard/change-analysis",
  { scope: s.scope, window_days: days }, explicitScopes(s.scope).length > 0 && Number.isInteger(days) && days >= 1 && days <= 14);

export type FeedSource = "updates" | "status" | "health";
export interface AzureArticle {
  id: string; title: string; summary?: string; url?: string; category?: string; type?: string; status?: string; level?: string;
  published_at?: string; updated_at?: string; impact_end_at?: string; tracking_id?: string; services?: string[]; regions?: string[];
  actions?: string; customer_impact?: string; subscription_ids?: string[]; resources?: Array<{ id: string; name?: string }>;
  resource_count?: number; resources_truncated?: boolean;
}
export interface AzureFeed {
  status: string; items: AzureArticle[]; total?: number; error?: string | null; notice?: string; truncated?: boolean;
  source?: { name?: string; url?: string }; freshness?: { fetched_at?: string; cached?: boolean; stale?: boolean; max_age_seconds?: number; age_seconds?: number };
}
export const feedQuery = (source: FeedSource, s: Scope, refresh = false) => read<AzureFeed>(`feed-${source}`, `dashboard/${{
  updates: "azure-updates", status: "azure-status", health: "service-health",
}[source]}`, { ...(source === "health" ? { scope: s.scope } : {}), refresh }, source !== "health" || explicitScopes(s.scope).length > 0);
export function needsAttention(item: AzureArticle): boolean {
  return /\b(retir\w*|deprecat\w*|security|action.required|breaking|critical|end.of.support)\b/i.test(`${item.category || ""} ${item.title} ${item.customer_impact || ""}`);
}
export interface FeedFilters { query: string; category: string; status: string; service: string; region: string; attention: boolean; }
export const emptyFeedFilters = (): FeedFilters => ({ query: "", category: "", status: "", service: "", region: "", attention: false });
export function filterArticles(items: AzureArticle[], f: FeedFilters): AzureArticle[] {
  const dimension = (values: string[] | undefined, choice: string, region = false) => {
    const normalize = (s: string) => region ? s.toLowerCase().replace(/[\s_-]/g, "") : s.toLowerCase().trim();
    return !choice || (choice === "__missing" ? !values?.length : values?.some(v => normalize(v) === normalize(choice)));
  };
  return items.filter(i => (!f.category || (i.category || i.type || "Other") === f.category) && (!f.status || i.status === f.status)
    && dimension(i.services, f.service) && dimension(i.regions, f.region, true) && (!f.attention || needsAttention(i))
    && (!f.query.trim() || [i.title, i.summary, i.actions, i.customer_impact, i.tracking_id, i.category, i.status, ...(i.services ?? []), ...(i.regions ?? [])]
      .join(" ").toLowerCase().includes(f.query.trim().toLowerCase())));
}
