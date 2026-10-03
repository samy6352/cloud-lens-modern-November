import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";
import { budgetNativeCurrency, budgetPermission, budgetPortal, budgetStatus, budgetsQuery, budgetTrendQuery, changesQuery, createBudget, emptyFeedFilters,
  explicitScopes, feedQuery, filterArticles, globalScope, governanceFindings, nativeMoney, needsAttention, resourcePortal, safeOfficialUrl,
  urgency, validateBudget, type Budget, type BudgetDraft, type Capabilities, type GovernanceReport } from "./govern-queries";
import type { Me } from "./queries";

const id = "11111111-1111-1111-1111-111111111111";
const second = "22222222-2222-2222-2222-222222222222";
const draft: BudgetDraft = { subscription: id, name: "production.web", amount: 500, time_grain: "Monthly", start: "2026-10-01", end: "2027-10-01",
  tags: [{ key: "Environment", values: ["Production"] }], mode: "all", thresholds: [80, 100], emails: ["owner@example.com"] };
const budget: Budget = { subscription_id: id, subscription: "Production", name: "prod", amount: 500, current_spend: 0, remaining: 500, currency: "USD",
  time_grain: "Monthly", percent_used: 0, status: "ok", start: draft.start, end: draft.end };
const me: Me = { authenticated: true, mode: "local", user: { name: "User", admin: false, source: "local" } };
const caps: Capabilities = { identity: { kind: "workload" }, capabilities: [{ feature: "budgets-write", subscription_id: id, status: "approval-required", authorization_status: "declared-allowed" }] };
afterEach(() => vi.unstubAllGlobals());

describe("explicit read-only scopes", () => {
  it("requires explicit UUIDs, never expands blank or all", () => {
    expect(explicitScopes()).toEqual([]); expect(explicitScopes("all")).toEqual([]); expect(explicitScopes(`${id},bad`)).toEqual([]);
    expect(explicitScopes(` ${id},${id}, ${second} `)).toEqual([id, second]);
  });
  it("bounds source selections to 100 subscriptions", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `${i.toString(16).padStart(8, "0")}-1111-1111-1111-111111111111`);
    expect(explicitScopes(ids.slice(0, 100).join(","))).toHaveLength(100);
    expect(explicitScopes(ids.join(","))).toEqual([]);
  });
  it("narrows unknown search values without assertions", () => {
    expect(globalScope({ scope: [id], month: 30 })).toEqual({ scope: undefined, month: undefined });
    expect(globalScope({ scope: id, month: "2026-09" })).toEqual({ scope: id, month: "2026-09" });
  });
  it("disables change fetches without explicit scopes or bounded days", () => {
    expect(changesQuery({}, 7).enabled).toBe(false);
    expect(changesQuery({ scope: id }, 14).enabled).toBe(true);
    expect(changesQuery({ scope: id }, 15).enabled).toBe(false);
    expect(changesQuery({ scope: id }, 1.5).enabled).toBe(false);
    expect(feedQuery("health", {}).enabled).toBe(false);
    expect(feedQuery("updates", {}).enabled).toBe(true);
  });
  it("keeps budget counters native and public feeds scope-independent", () => {
    const budgetParams = budgetsQuery({ scope: id, month: "2026-09" }).queryKey[2];
    expect(budgetParams).toEqual({ scope: id, refresh: false });
    expect(feedQuery("updates", { scope: id, month: "2026-09" }).queryKey).toEqual(feedQuery("updates", {}).queryKey);
  });
  it("propagates abort signals into GET requests", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ budgets: [] })));
    vi.stubGlobal("fetch", fetch);
    const options = budgetsQuery({ scope: id }); const controller = new AbortController();
    if (typeof options.queryFn !== "function") throw new Error("Missing query function");
    // Query execution context has only the fields consumed by this query.
    await options.queryFn({ signal: controller.signal, queryKey: options.queryKey, client: new QueryClient(), meta: undefined });
    expect(fetch).toHaveBeenCalledWith(`/api/budgets?scope=${id}&refresh=false`, expect.objectContaining({ signal: controller.signal }));
  });
});

describe("budget validation and authorization", () => {
  it("accepts exact native valid draft and rejects unknown currency", () => {
    expect(validateBudget(draft, "USD")).toEqual([]);
    expect(validateBudget(draft, null).join(" ")).toMatch(/currency/);
  });
  it("rejects malformed names, amounts and calendar dates", () => {
    expect(validateBudget({ ...draft, name: "../x", amount: Infinity, start: "2026-02-30", end: "2026-02-31" }, "USD")).toHaveLength(4);
    expect(validateBudget({ ...draft, start: "2026-10-02" }, "USD").join(" ")).toMatch(/first day/);
    expect(validateBudget({ ...draft, end: draft.start }, "USD").join(" ")).toMatch(/Expiry/);
  });
  it("honours server tag and notification constraints", () => {
    expect(validateBudget({ ...draft, tags: [] }, "USD").join(" ")).toMatch(/1 and 10/);
    expect(validateBudget({ ...draft, tags: [{ key: "A", values: [""] }] }, "USD")).toEqual([]);
    expect(validateBudget({ ...draft, tags: [{ key: "A", values: [] }] }, "USD").join(" ")).toMatch(/values/);
    expect(validateBudget({ ...draft, tags: [...draft.tags, { key: "Owner", values: ["X"] }], mode: "any" }, "USD").join(" ")).toMatch(/OR/);
    expect(validateBudget({ ...draft, thresholds: [80], emails: [] }, "USD").join(" ")).toMatch(/email/);
    expect(validateBudget({ ...draft, thresholds: [1, 2, 3, 4, 5, 6] }, "USD").join(" ")).toMatch(/five/);
    expect(validateBudget({ ...draft, thresholds: [NaN] }, "USD").join(" ")).toMatch(/threshold/);
  });
  it("never authorizes a local non-admin via app permissions", () => {
    expect(budgetPermission(me, caps, id).allowed).toBe(false);
    expect(budgetPermission({ ...me, user: { ...me.user!, source: "local" } }, { ...caps, identity: { kind: "delegated-user" } }, id).allowed).toBe(false);
  });
  it("requires known write capability for admins and delegated users", () => {
    const admin = { ...me, user: { ...me.user!, admin: true } };
    expect(budgetPermission(admin, caps, id).allowed).toBe(true);
    expect(budgetPermission(admin, undefined, id).allowed).toBe(false);
    expect(budgetPermission(admin, caps, second).allowed).toBe(false);
    expect(budgetPermission(admin, { ...caps, capabilities: [{ ...caps.capabilities[0]!, authorization_status: "denied" }] }, id).allowed).toBe(false);
    expect(budgetPermission(admin, { ...caps, capabilities: [{ ...caps.capabilities[0]!, authorization_status: undefined }] }, id).allowed).toBe(false);
    expect(budgetPermission(admin, { ...caps, read_only: true }, id).allowed).toBe(false);
    expect(budgetPermission(admin, { ...caps, deployment_policy: { mutations_blocked: true } }, id).allowed).toBe(false);
    expect(budgetPermission({ ...me, user: { ...me.user!, source: "entra" } }, { ...caps, identity: { kind: "delegated-user" } }, id).allowed).toBe(true);
  });
  it("uses zero as known spend but unknown counters stay unknown", () => {
    expect(budgetStatus(budget)).toBe("ok"); expect(budgetStatus({ ...budget, current_spend: null })).toBe("unknown");
    expect(budgetStatus({ ...budget, percent_used: NaN })).toBe("unknown");
    expect(nativeMoney(0, "INR")).toMatch(/^INR 0\.00/); expect(nativeMoney(null, "USD")).toBe("Unavailable");
  });
  it("requires a single warehouse-native currency, never a display-currency fallback", () => {
    expect(budgetNativeCurrency({ native_currencies: { [id]: ["USD"] } }, id)).toBe("USD");
    expect(budgetNativeCurrency({ native_currencies: { [id]: ["USD", "INR"] } }, id)).toBeNull();
    expect(budgetNativeCurrency({ native_currencies: { [id]: ["unknown"] } }, id)).toBeNull();
    expect(budgetNativeCurrency(undefined, id)).toBeNull();
  });
  it("does not fetch a global trend when a filter is inexact", () => {
    expect(budgetTrendQuery({ ...budget, filter_exact: false }).enabled).toBe(false);
    expect(budgetTrendQuery(budget).queryKey[2]).toEqual({ subscription_id: id, name: budget.name, currency: "USD" });
  });
  it("POSTs the exact schema only to a mocked transport", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: draft.name, amount: draft.amount }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    await createBudget(draft);
    expect(fetch).toHaveBeenCalledWith("/api/budgets", expect.objectContaining({ method: "POST", body: JSON.stringify(draft), headers: { "Content-Type": "application/json" } }));
    const sent = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(Object.keys(sent).sort()).toEqual(["amount", "emails", "end", "mode", "name", "start", "subscription", "tags", "thresholds", "time_grain"]);
    expect(sent).not.toHaveProperty("currency");
  });
  it("surfaces Azure refusal rather than treating it as success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Azure refused" }), { status: 403 })));
    await expect(createBudget(draft)).rejects.toEqual(expect.objectContaining({ status: 403, message: "Azure refused" }));
    expect(new ApiError(403, "Denied").status).toBe(403);
  });
});

describe("safe links and meaningful evidence", () => {
  it("allows only official HTTPS links without credentials", () => {
    expect(safeOfficialUrl("https://learn.microsoft.com/en-us/azure/")).toBeTruthy();
    for (const url of ["javascript:alert(1)", "http://portal.azure.com/", "https://portal.azure.com.evil.invalid/", "https://user:pass@portal.azure.com/", "https://portal.azure.com:444/", "not a URL"])
      expect(safeOfficialUrl(url)).toBeNull();
    expect(resourcePortal(`/subscriptions/${id}/resourceGroups/My Group/providers/Microsoft.Compute/virtualMachines/a#b`)).toContain("My%20Group");
    expect(resourcePortal("javascript:alert(1)")).toBeNull();
    expect(budgetPortal({ subscription_id: id, name: "a/b" })).toContain(`budgets/scope/%2Fsubscriptions%2F${id}`);
  });
  it("maps native checks without claiming Azure Policy findings", () => {
    const data: GovernanceReport = { tagging: { resources: [{ id: `/subscriptions/${id}/resourceGroups/prod/providers/X/Y`, name: "vm", cost: 3, currency: "USD" }] },
      accelerated_networking: { catalogue: false, eligible: [{ vmName: "vm2", vmId: `/subscriptions/${id}/resourceGroups/prod/providers/X/Z`, vmSize: "D4" }] },
      orphaned_resource_groups: { groups: [{ name: "empty", subscriptionId: second }] } };
    const findings = governanceFindings(data);
    expect(findings).toHaveLength(3); expect(findings[0]?.subscription).toBe(id); expect(findings[1]?.severity).toBe("Unverified");
    expect(findings.map(f => f.category).join(" ")).not.toMatch(/Policy/);
  });
  it("keeps no-deadline last and overdue distinct", () => {
    expect(urgency({ days_left: null })).toBe("No deadline"); expect(urgency({ days_left: -1 })).toBe("Overdue");
    expect(urgency({ days_left: 0 })).toBe("Due in 30 days"); expect(urgency({ days_left: 91 })).toBe("Later");
  });
  it("filters rich news fields, attention and canonical region spellings", () => {
    const items = [{ id: "1", title: "Service retirement", category: "Retirement", regions: ["East US"], services: ["Storage"], actions: "Migrate now" },
      { id: "2", title: "General availability", category: "GA", regions: [], services: [] }];
    expect(needsAttention(items[0]!)).toBe(true);
    expect(filterArticles(items, { ...emptyFeedFilters(), attention: true, region: "eastus", service: "storage", query: "migrate" })).toEqual([items[0]]);
    expect(filterArticles(items, { ...emptyFeedFilters(), region: "__missing" })).toEqual([items[1]]);
    expect(filterArticles(items, { ...emptyFeedFilters(), category: "GA", attention: true })).toEqual([]);
  });
});
