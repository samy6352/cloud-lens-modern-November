import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  ApprovalSession, approvalBody, auditQuery, costJobsQuery, costRequest, costStatusQuery, dateWindow, downloadFile, pollInterval,
  postAdmin, rawDownloadHref, rawParams, reportDownloadHref, reportOptionsQuery, resumableJob, retailPricing, safeFilename, selectedScope, singleJobQuery, type AdminJob, type CostPlan,
} from "./admin-report-queries";

const plan: CostPlan = {
  action: "setup", cadence: "Daily", from: "2026-08-01", to: "2026-08-30", history_days: 30,
  can_start: true, preview_token: "server-signed-exact-review", identity: "workload", explanation: "Daily", notes: [],
  subscriptions: [{ subscription: "sub-a", name: "A", action: "import", blockers: [], can_write: true, export: null, destination: { account_id: "account", container: "focus", folder: "a" }, window: { from: "2026-08-01", to: "2026-08-30" }, permissions: [] }],
};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("cost data exact review contract", () => {
  it("never broadens a cleared selection", () => {
    expect(() => selectedScope([])).toThrow("Choose at least one");
    expect(() => costRequest([" "], "setup", "Daily", plan.from, plan.to)).toThrow();
    expect(selectedScope([" SUB-A ", "sub-a", "sub-b"])).toEqual(["sub-a", "sub-b"]);
    expect(() => selectedScope(Array.from({ length: 201 }, (_, i) => `sub-${i}`))).toThrow("200");
  });
  it("checks real calendar dates and inclusive history limits", () => {
    expect(dateWindow("2026-08-01", "2026-08-30", 365, "2026-10-03")).toBe(30);
    for (const [lo, hi] of [["2026-02-30", "2026-03-01"], ["2026-09-01", "2026-08-01"], ["2026-10-04", "2026-10-04"]]) expect(() => dateWindow(lo!, hi!, 365, "2026-10-03")).toThrow();
    expect(() => dateWindow("2025-01-01", "2026-01-01", 365, "2026-10-03")).toThrow();
  });
  it("carries exact scope/action/cadence/dates/token with a stable approval key", () => {
    const request = costRequest(["SUB-A"], "setup", "Daily", plan.from, plan.to);
    const body = approvalBody(request, plan, "one-confirmation-key", 1000, 1001);
    expect(body).toEqual({ scope: ["sub-a"], action: "setup", cadence: "Daily", start: plan.from, end: plan.to, history_days: 30, preview_token: plan.preview_token, idempotency_key: "one-confirmation-key" });
    expect(approvalBody(request, plan, "one-confirmation-key", 1000, 1002)).toEqual(body);
  });
  it("schedule-only approval sends no hidden history", () => {
    expect(costRequest(["sub-a"], "schedule", "Weekly", "bad", "bad")).toEqual({ scope: ["sub-a"], action: "schedule", cadence: "Weekly" });
    expect(costRequest(["sub-a"], "refresh", "Monthly", "bad", "bad")).toEqual({ scope: ["sub-a"], action: "refresh", cadence: "Monthly" });
    expect(costRequest(["sub-a"], "reconcile", "Daily", plan.from, plan.to)).not.toHaveProperty("history_days");
  });
  it("refuses stale, blocked, changed-scope, changed-cadence and changed-date approvals", () => {
    const request = costRequest(["sub-a"], "setup", "Daily", plan.from, plan.to);
    expect(() => approvalBody(request, plan, "key", 1, 600002)).toThrow("expired");
    expect(() => approvalBody(request, { ...plan, can_start: false }, "key", 1, 2)).toThrow("blocked");
    expect(() => approvalBody({ ...request, scope: ["sub-b"] }, plan, "key", 1, 2)).toThrow("changed");
    expect(() => approvalBody({ ...request, cadence: "Monthly" }, plan, "key", 1, 2)).toThrow("changed");
    expect(() => approvalBody({ ...request, start: "2026-08-02" }, plan, "key", 1, 2)).toThrow("Dates");
  });
  it("cancel or unmount aborts a read and suppresses late results", async () => {
    const session = new ApprovalSession();
    let signal: AbortSignal | undefined;
    let resolve: ((value: string) => void) | undefined;
    const result = session.run(s => { signal = s; return new Promise<string>(r => { resolve = r; }); });
    session.cancel();
    expect(signal?.aborted).toBe(true);
    resolve?.("stale preview");
    expect(await result).toBeUndefined();
  });
  it("a new generation cannot be overwritten by a cancelled preview", async () => {
    const session = new ApprovalSession();
    let resolve: ((value: string) => void) | undefined;
    const previous = session.run(() => new Promise<string>(r => { resolve = r; }));
    session.cancel();
    expect(await session.run(async () => "new preview")).toBe("new preview");
    resolve?.("old");
    expect(await previous).toBeUndefined();
  });
  it("duplicate confirm cannot submit twice concurrently", async () => {
    const session = new ApprovalSession();
    let resolve: ((value: string) => void) | undefined;
    const write = vi.fn(() => new Promise<string>(r => { resolve = r; }));
    const first = session.run(write);
    expect(await session.run(write)).toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
    resolve?.("queued");
    expect(await first).toBe("queued");
  });
  it("only explicit confirmed setup uses POST and carries exact body", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job_id: "mock-job" }), { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    const body = approvalBody(costRequest(["sub-a"], "setup", "Daily", plan.from, plan.to), plan, "key", 1, 2);
    await postAdmin("cost-data/setup", body);
    expect(fetch).toHaveBeenCalledWith("/api/cost-data/setup", expect.objectContaining({ method: "POST", credentials: "same-origin", body: JSON.stringify(body) }));
  });
});

describe("read-only query and bounded job contracts", () => {
  it("allows explicit pending interactive resumption, not workload recovery or an active worker", () => {
    const job: AdminJob = { job_id: "same-job", kind: "focus-manual", identity: "interactive", status: "queued", scope: ["sub-a"], tasks: [] };
    expect(resumableJob(job)).toBe(true);
    expect(resumableJob({ ...job, status: "pending" })).toBe(true);
    expect(resumableJob({ ...job, identity: "workload" })).toBe(false);
    expect(resumableJob({ ...job, status: "running" })).toBe(false);
    expect(resumableJob({ ...job, status: "ready" })).toBe(false);
  });
  it("disables cleared-scope reads instead of falling back to all", () => {
    expect(costStatusQuery([]).enabled).toBe(false);
    expect(costJobsQuery([]).enabled).toBe(false);
    expect(singleJobQuery("", ["sub-a"]).enabled).toBe(false);
    expect(auditQuery(200, false).enabled).toBe(false);
  });
  it("stops active polling on completion, errors and the read bound", () => {
    expect(pollInterval(true, 2, null)).toBe(15000);
    expect(pollInterval(false, 2, null)).toBe(false);
    expect(pollInterval(true, 120, null)).toBe(false);
    expect(pollInterval(true, 2, new Error("403"))).toBe(false);
    expect(costJobsQuery(["sub-a"]).retry).toBe(false);
  });
  it("job restoration and report options are GET-only with exact scoped context", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const query = reportOptionsQuery({ month: "2026-08", scope: "sub-a,sub-b" }, 30, "USD");
    const fn = query.queryFn;
    if (!fn || typeof fn !== "function") throw new Error("No query function");
    await fn({ client: new QueryClient(), queryKey: query.queryKey, signal: new AbortController().signal, meta: undefined });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/report/options?scope=sub-a%2Csub-b&period_month=2026-08&days=30&currency=USD");
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("method", "POST");
  });
});

describe("report/raw downloads", () => {
  it("serializes the native GET contract including deliberate empty sections and blocks", () => {
    const href = reportDownloadHref({ format: "pptx", days: 30, period_month: "2026-08", scope: ["sub-b", "SUB-A"], currency: "INR", summary: false, sections: [], blocks: [], live: ["esu", "waste"] });
    const url = new URL(href, "https://example.test");
    expect(url.pathname).toBe("/api/report/pptx");
    expect(Object.fromEntries(url.searchParams)).toEqual({ days: "30", period_month: "2026-08", scope: "sub-a,sub-b", currency: "INR", summary: "false", sections: "", blocks: "", live: "esu,waste" });
    expect(reportDownloadHref({ format: "csv", days: 14, scope: [], currency: "", summary: true, sections: ["compute"], blocks: ["trend"], live: [] })).toContain("summary=true");
    expect(() => reportDownloadHref({ format: "exe", days: 14, scope: [], currency: "", summary: true, sections: [], blocks: [], live: [] })).toThrow();
  });
  it("raw GET href preserves the same exact parameters as the storage POST", () => {
    const selection = { scope: ["sub-a"], fmt: "parquet", since: "2026-08-01", until: "2026-08-30", source: "2026-09-01", dataset: "amortized", label: "review & audit" };
    expect(Object.fromEntries(new URL(rawDownloadHref(selection), "https://example.test").searchParams)).toEqual({ ...rawParams(selection), scope: "sub-a" });
  });
  it("retail aggregate coverage requires every price, including unreturned required machines", () => {
    expect(retailPricing([12, null], 2)).toEqual({ complete: false, assessed: 12, unpriced: 1 });
    expect(retailPricing([12], 2)).toEqual({ complete: false, assessed: 12, unpriced: 1 });
    expect(retailPricing([0, 12], 2)).toEqual({ complete: true, assessed: 12, unpriced: 0 });
    expect(retailPricing([NaN, Infinity])).toEqual({ complete: false, assessed: 0, unpriced: 2 });
  });
  it("raw selections preserve independent scope, snapshot, period, format and dataset", () => {
    const value = { scope: ["sub-a"], fmt: "parquet", since: "2026-08-01", until: "2026-08-30", source: "2026-09-01", dataset: "actual", label: "review" };
    expect(rawParams(value)).toEqual(value);
    expect(() => rawParams({ ...value, scope: [] })).toThrow();
    expect(() => rawParams({ ...value, fmt: "exe" })).toThrow();
  });
  it("rejects encoded paths, unsafe Windows filenames and wrong extensions", () => {
    expect(safeFilename('attachment; filename="costs.csv"', "fallback.csv")).toBe("costs.csv");
    for (const value of ['attachment; filename="../../secret.csv"', "attachment; filename*=UTF-8''..%2Fsecret.csv", "attachment; filename*=UTF-8''..%5Csecret.csv", 'attachment; filename="NUL.csv"', 'attachment; filename="costs.exe"', "attachment; filename*=UTF-8''%XX.csv"]) expect(safeFilename(value, "fallback.csv")).toBe("fallback.csv");
  });
  it("surfaces report errors rather than downloading error JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"detail":"Could not build report"}', { status: 500, headers: { "Content-Type": "application/json" } })));
    await expect(downloadFile("report/csv", "report.csv")).rejects.toThrow("Could not build report");
  });
  it("refuses unexpected successful HTML content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>error</html>", { headers: { "Content-Type": "text/html" } })));
    await expect(downloadFile("report/csv", "report.csv")).rejects.toThrow("unexpected file type");
  });
  it("uses the same-origin login adapter on an expired download session", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/v2/reports/export", search: "?month=2026-08", assign } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    await expect(downloadFile("report/csv", "report.csv")).rejects.toThrow("Sign in");
    expect(assign).toHaveBeenCalledWith("/login?next=%2Fv2%2Freports%2Fexport%3Fmonth%3D2026-08");
  });
  it("downloads CSV, XLSX, PPTX and Parquet as validated blobs and revokes URLs", async () => {
    const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    const appendChild = vi.fn();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild } });
    vi.stubGlobal("window", { setTimeout: (fn: () => void) => { fn(); return 1; } });
    for (const [extension, media] of [["csv", "text/csv"], ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"], ["parquet", "application/vnd.apache.parquet"]]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("mock file", { headers: { "Content-Type": media!, "Content-Disposition": `attachment; filename="selection.${extension}"` } })));
      await downloadFile("report", `selection.${extension}`);
      expect(anchor.download).toBe(`selection.${extension}`);
    }
    expect(createObjectURL).toHaveBeenCalledTimes(4);
    expect(anchor.click).toHaveBeenCalledTimes(4);
    expect(revokeObjectURL).toHaveBeenCalledTimes(4);
  });
});
