import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let browser: Browser;
let base = "";
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { makeRouter } from "/src/router.tsx";
import { LazyMotion, domAnimation } from "motion/react";
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const router = makeRouter(client);
createRoot(document.getElementById("root")).render(React.createElement(LazyMotion, { features: domAnimation }, React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router }))));
`;
const subscriptions = [{ id: "sub-a", name: "Subscription A" }, { id: "sub-b", name: "Subscription B" }];
const costs = (readOnly = false) => ({
  subscriptions: subscriptions.map(s => ({ ...s, configured: false, status: "idle", job_id: null, retry_job_id: null, config: {}, history: { from: "2026-08-01", to: "2026-08-30" }, coverage: { authoritative_days: 10, requested_days: 30, missing_days: 20 }, through: "2026-08-10", last_success: null, next_check: null, detail: null, tasks: [] })),
  cadences: { Daily: "Daily at 02:00 UTC", Weekly: "Monday at 02:00 UTC", Monthly: "First at 02:00 UTC" },
  can_review: !readOnly, read_only: readOnly, auto_enabled: true, checked_at: "2026-10-03", note: "Existing costs remain available",
});
interface Recorded { path: string; method: string; body: Record<string, unknown> | null }
interface MockOptions { admin?: boolean; readOnly?: boolean; audit403?: boolean; downloadFail?: boolean; previewDelay?: number; failedJob?: boolean; jobsError?: boolean; queuedInteractive?: boolean; runningInteractive?: boolean; resumeFail?: boolean; completePricing?: boolean; jobScope?: string[] }
async function mount(screen: string, options: MockOptions = {}) {
  const page = await browser.newPage({ acceptDownloads: true });
  page.setDefaultTimeout(8000);
  const requests: Recorded[] = [];
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/", "");
    const method = request.method();
    const body: Record<string, unknown> | null = request.postData() ? request.postDataJSON() : null;
    requests.push({ path: `${path}${url.search}`, method, body });
    let data: unknown = {};
    if (path === "auth/me") data = { authenticated: true, mode: "local", user: { name: "Mock", admin: options.admin !== false, source: "file" } };
    else if (path === "cost-data/subscriptions") data = { subscriptions };
    else if (path === "subscriptions") data = { subscriptions, count: subscriptions.length };
    else if (path === "reporting-period") data = { months: ["2026-08"], selected_month: null };
    else if (path === "cost-data") data = costs(options.readOnly);
    else if (path === "focus/jobs") {
      if (options.jobsError) { await route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"Mock job status unavailable"}' }); return; }
      data = { jobs: options.queuedInteractive || options.runningInteractive ? [{ job_id: "mock-interactive", kind: "focus-manual", identity: "interactive", scope: options.jobScope ?? ["sub-a", "sub-b"], status: options.runningInteractive ? "running" : "queued", detail: "Interrupted; awaiting authorized resumption.", tasks: [{ task_id: "ready-task", subscription: "sub-a", status: "ready" }, { task_id: "pending-task", subscription: options.jobScope?.[0] ?? "sub-b", status: "queued" }] }] : options.failedJob ? [{ job_id: "mock-failed", kind: "focus-update", scope: ["sub-a", "sub-b"], status: "partial", detail: "One window failed", tasks: [{ task_id: "t1", subscription: "sub-a", status: "failed", detail: "Azure delivery failed" }] }] : [] };
    }
    else if (path === "warehouse") data = { from: "2026-08-01", to: "2026-08-30", rows: 12 };
    else if (path === "cost-data/preview") {
      if (options.previewDelay) await new Promise(resolve => setTimeout(resolve, options.previewDelay));
      data = {
        action: body?.action, cadence: body?.cadence, from: body?.start ?? "2026-08-01", to: body?.end ?? "2026-08-30", history_days: body?.history_days ?? null,
        preview_token: "fresh-mock-token", can_start: true, identity: "Persistent workload", explanation: "Reviewed workload action", notes: ["No external schedules changed."],
        subscriptions: subscriptions.filter(s => Array.isArray(body?.scope) && body.scope.includes(s.id)).map(s => ({
          subscription: s.id, name: s.name, action: "Configure owned FOCUS export", blockers: [], can_write: true, export: null,
          destination: { account_id: "mock-account", container: "focus", folder: s.id },
          window: body?.start ? { from: body.start, to: body.end } : null, permissions: [],
        })),
      };
    } else if (path.endsWith("/resume")) {
      if (options.resumeFail) { await route.fulfill({ status: 409, contentType: "application/json", body: '{"detail":"Mock resumption rejected"}' }); return; }
      data = { job_id: path.split("/").at(-2), kind: "focus-manual", scope: options.jobScope ?? ["sub-a", "sub-b"], status: "queued", tasks: [] };
    } else if (path === "cost-data/setup") data = { job_id: "mock-job", kind: "focus-setup", scope: body?.scope ?? ["sub-a", "sub-b"], status: "queued", tasks: [] };
    else if (path === "report/options") data = { areas: [{ id: "compute", label: "Compute", cost: 100 }], blocks: ["trend", "services"], live: [{ id: "waste", label: "Orphaned resources" }], formats: [{ id: "csv", label: "CSV" }, { id: "xlsx", label: "Excel workbook" }, { id: "pptx", label: "PowerPoint deck" }], currency: "USD", as_of: "2026-08-30" };
    else if (path === "currency") data = { supported: ["USD"], source: "Mock reference" };
    else if (path === "archive") data = { enabled: true, days: { actual: ["2026-08-31"] } };
    else if (path === "archive/export") data = { rows: 12, name: "exports/mock.csv", account: "mock", container: "archive" };
    else if (/^report\/(csv|xlsx|pptx)$/.test(path) || path === "archive/export/download") {
      if (options.downloadFail) { await route.fulfill({ status: 500, contentType: "application/json", body: '{"detail":"Mock report failed"}' }); return; }
      const fmt = path.startsWith("report/") ? path.split("/")[1] : url.searchParams.get("fmt") ?? "csv";
      const media = fmt === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : fmt === "pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "text/csv";
      await route.fulfill({ status: 200, contentType: media, headers: { "Content-Disposition": `attachment; filename="mock.${fmt}"` }, body: "mock file" }); return;
    } else if (path === "dashboard/commitments") data = { inventory: { commitments: [] }, coverage: {}, comparison: {}, spot: {} };
    else if (path === "dashboard/hybrid-benefit") data = { currency: "INR", count: 2, uncovered: 2, covered: 0, estimated_annual_savings: options.completePricing ? 360 : 120, vms: [{ name: "Retail VM", hybrid_benefit: false, cost: 500, estimated_annual_savings: 120 }, { name: "Other VM", hybrid_benefit: false, cost: 600, estimated_annual_savings: options.completePricing ? 240 : null }] };
    else if (path === "dashboard/esu") data = { currency: "INR", priced: true, exposed: 2, estimated_monthly_cost: options.completePricing ? 30 : 10, billed_esu: 700, machines: [{ name: "Arc priced", kind: "Arc-connected server", product: "Windows Server", status: "out of support", covered: false, monthly_esu_cost: 10 }, { name: "Arc unknown", kind: "Arc-connected server", product: "Windows Server", status: "out of support", covered: false, monthly_esu_cost: options.completePricing ? 20 : null }] };
    else if (path === "dashboard/audit") {
      if (options.audit403) { await route.fulfill({ status: 403, contentType: "application/json", body: '{"detail":"Administrator audit access denied"}' }); return; }
      data = { entries: [{ user: "Alice", email: "alice@example.test", source: "file", admin: false, tab: "billing", at: "2026-10-03 08:00:00" }, { user: "Bob", email: null, source: "entra", admin: true, tab: "reports", at: "2026-10-02 08:00:00" }], count: 2 };
    } else if (path === "capabilities") data = { mode: url.searchParams.get("mode"), generated_at: "2026-10-03", capabilities: [{ feature: "FOCUS read", status: "unknown", principal: { id: "mock-workload" }, required_role: "Storage Blob Data Reader", scope: "/subscriptions/sub-a", reason: "Verify access", next_step: "Ask administrator" }] };
    else if (path === "schedules") data = { schedules: [{ name: "external-focus", subscription_id: "sub-a", metric: "FocusCost", recurrence: "Weekly", status: "Active", owned: false, account: "mock", container: "focus", folder: "exports" }] };
    else if (path === "schedules/history") data = { history: { "sub-a/external-focus": { last_status: "Completed", last_run: "2026-10-01" } } };
    else if (path === "exports") data = { exports: [{ id: "/subscriptions/sub-a/providers/Microsoft.CostManagement/exports/focus", name: "focus", subscription_id: "sub-a", type: "FocusCost", storage_account: "mock", container: "focus", root_folder: "exports" }] };
    else if (path === "exports/ingest") data = { status: "started", started: "manual-mock-job" };
    else if (path.startsWith("jobs/")) data = { job_id: "manual-mock-job", kind: "export", scope: ["sub-a", "sub-b"], status: "ready", tasks: [] };
    else if (path === "diagnostics/export") data = { source: "mock/focus/exports", file: "focus.csv", mapped: ["BilledCost", "Tags"], missing: [], empty_though_present: [], columns_in_file: 2, sampled_rows: 1, has_tags: true, rows_with_tags_in_sample: 1 };
    else { errors.push(`Unexpected API ${method} ${path}`); await route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"Not mocked; no real API access is allowed"}' }); return; }
    try { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) }); } catch { /* A deliberately cancelled request may already be gone. */ }
  });
  const routePath = screen === "reports" ? "/reports/export" : screen === "audit" ? "/admin/audit" : screen === "commitments" ? "/optimize/commitments" : "/admin/cost-data";
  await page.goto(`${base}/v2${routePath}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator("#main").getByRole("heading", { name: screen === "reports" ? "Export data" : screen === "audit" ? "Audit" : screen === "commitments" ? "Commitments" : "Cost data", exact: true }).waitFor({ timeout: 30000 });
  return { page, requests, errors };
}
const waitText = async (page: Page, text: string) => { await page.getByText(text, { exact: false }).first().waitFor({ timeout: 8000 }); };

beforeAll(async () => {
  server = await createServer({
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    plugins: [{
      name: "isolated-admin-report-tests",
      resolveId(id) { return id.endsWith("/__admin-report-test.js") ? "\0admin-report-test" : undefined; },
      load(id) { return id === "\0admin-report-test" ? fixture : undefined; },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const path = "url" in req && typeof req.url === "string" ? req.url.split("?")[0] : "";
          if (!path || !["/v2/admin/cost-data", "/v2/admin/audit", "/v2/reports/export", "/v2/optimize/commitments"].includes(path)) { next(); return; }
          const html = await vite.transformIndexHtml("/v2/__admin-report-test", '<html><head></head><body><div id="root"></div><script type="module" src="/v2/__admin-report-test.js"></script></body></html>');
          res.setHeader("Content-Type", "text/html"); res.end(html);
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Test Vite listener not available");
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

describe("native admin/report interactions (all APIs mocked)", () => {
  it("requires review and explicit approval, sends the exact token/scope and cancels without writes", async () => {
    const { page, requests, errors } = await mount("cost");
    await waitText(page, "Ready to review.");
    expect(requests.some(r => r.path.startsWith("schedules"))).toBe(false);
    await page.getByRole("button", { name: "Review import and updates" }).click();
    await page.getByRole("dialog").waitFor();
    expect(requests.filter(r => r.path === "cost-data/setup")).toHaveLength(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(requests.filter(r => r.path === "cost-data/setup")).toHaveLength(0);
    await page.getByRole("button", { name: "Review import and updates" }).click();
    await page.getByRole("button", { name: "Approve exact reviewed work" }).click();
    await waitText(page, "Approved work is queued");
    const preview = requests.filter(r => r.path === "cost-data/preview").at(-1)?.body;
    const written = requests.find(r => r.path === "cost-data/setup")?.body;
    expect(written).toMatchObject({ ...preview, scope: ["sub-a", "sub-b"], preview_token: "fresh-mock-token" });
    expect(written?.idempotency_key).toEqual(expect.any(String));
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
  it("clearing selection cannot widen scope and read-only deployments cannot review imports", async () => {
    const { page, requests } = await mount("cost");
    await waitText(page, "Ready to review.");
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await waitText(page, "Choose at least one subscription");
    expect(await page.getByRole("button", { name: "Review import and updates" }).isDisabled()).toBe(true);
    expect(requests.some(r => r.path === "cost-data?" || r.path === "cost-data/setup")).toBe(false);
    await page.close();
    const readOnly = await mount("cost", { readOnly: true });
    await waitText(readOnly.page, "This deployment is read-only.");
    expect(await readOnly.page.getByRole("button", { name: "Review import and updates" }).isDisabled()).toBe(true);
    expect(readOnly.requests.some(r => r.method === "POST")).toBe(false);
    await readOnly.page.close();
  }, 30_000);
  it("cancelled late previews cannot produce a confirmation dialog", async () => {
    const { page, requests } = await mount("cost", { previewDelay: 500 });
    await waitText(page, "Ready to review.");
    await page.getByRole("button", { name: "Review import and updates" }).click();
    await page.getByRole("button", { name: "Cancel pending browser request" }).click();
    await page.waitForTimeout(700);
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(requests.some(r => r.path === "cost-data/setup")).toBe(false);
    await page.close();
  }, 30_000);
  it("keeps fast inventory separate from execution history and inspects caller/workload access", async () => {
    const { page, requests, errors } = await mount("cost");
    await waitText(page, "Ready to review.");
    await page.getByRole("button", { name: "Load exports (fast listing)" }).click();
    await waitText(page, "external-focus");
    expect(requests.some(r => r.path.startsWith("schedules/history"))).toBe(false);
    expect(requests.find(r => r.path.startsWith("schedules?"))?.path).toContain("history=false");
    await page.getByRole("button", { name: "Load execution history (slower)" }).click();
    await waitText(page, "Completed");
    await page.getByRole("radio", { name: "Access & fixes", exact: true }).click();
    await page.getByRole("button", { name: "Inspect my access" }).click();
    await waitText(page, "Caller declarations");
    await page.getByRole("button", { name: "Inspect background identity" }).click();
    await waitText(page, "Background identity declarations");
    expect(requests.filter(r => r.path.startsWith("capabilities?")).map(r => r.path)).toEqual([
      "capabilities?scope=sub-a%2Csub-b&mode=caller&refresh=true", "capabilities?scope=sub-a%2Csub-b&mode=workload&refresh=true",
    ]);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
  it("manual FOCUS source selection reviews first and restores the persisted import with GET", async () => {
    const { page, requests, errors } = await mount("cost");
    await waitText(page, "Ready to review.");
    await page.getByRole("button", { name: "Discover existing import sources" }).click();
    await page.getByLabel("Existing FOCUS export").selectOption("/subscriptions/sub-a/providers/Microsoft.CostManagement/exports/focus");
    await page.getByRole("button", { name: "Inspect Blob source (read only)" }).click();
    await waitText(page, "Mapped: BilledCost, Tags");
    await page.getByRole("button", { name: "Review manual FOCUS import" }).click();
    expect(requests.some(r => r.path === "exports/ingest")).toBe(false);
    await page.getByRole("button", { name: "Import selected FOCUS data" }).click();
    await waitText(page, "FOCUS import runs in the backend");
    await waitText(page, "manual-mock-job");
    expect(requests.find(r => r.path === "exports/ingest")?.body).toMatchObject({ scope: ["sub-a", "sub-b"], metric: "FocusCost", export_id: "/subscriptions/sub-a/providers/Microsoft.CostManagement/exports/focus", max_files: 60 });
    expect(requests.find(r => r.path === "jobs/manual-mock-job")?.method).toBe("GET");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
  it("all three cadences, refresh and reconciliation carry distinct exact approval contracts", async () => {
    const { page, requests, errors } = await mount("cost");
    await waitText(page, "Ready to review.");
    await page.getByRole("radio", { name: "Scheduled updates", exact: true }).click();
    for (const cadence of ["Weekly", "Monthly", "Daily"]) {
      await page.getByRole("radio", { name: cadence === "Daily" ? "Daily (recommended)" : cadence, exact: true }).check();
      await page.getByRole("button", { name: `Review ${cadence.toLowerCase()} schedule` }).click();
      await page.getByRole("dialog").waitFor();
      const preview = requests.filter(r => r.path === "cost-data/preview").at(-1)?.body;
      expect(preview).toEqual({ scope: ["sub-a", "sub-b"], action: "schedule", cadence });
      await page.getByRole("button", { name: `Enable ${cadence.toLowerCase()} updates` }).click();
      await waitText(page, "Approved work is queued");
    }
    await page.getByRole("button", { name: "Review refresh now" }).click();
    await page.getByRole("dialog").waitFor();
    expect(requests.filter(r => r.path === "cost-data/preview").at(-1)?.body).toEqual({ scope: ["sub-a", "sub-b"], action: "refresh", cadence: "Daily" });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByText("Reconcile exact historical dates", { exact: true }).click();
    await page.getByLabel("From (UTC)", { exact: true }).fill("2026-08-01");
    await page.getByLabel("Through (UTC)", { exact: true }).fill("2026-08-30");
    await page.getByRole("button", { name: "Review reconciliation" }).click();
    await page.getByRole("dialog").waitFor();
    expect(requests.filter(r => r.path === "cost-data/preview").at(-1)?.body).toEqual({ scope: ["sub-a", "sub-b"], action: "reconcile", cadence: "Daily", start: "2026-08-01", end: "2026-08-30" });
    await page.getByRole("button", { name: "Approve exact reviewed work" }).click();
    await waitText(page, "Approved work is queued");
    expect(requests.filter(r => r.path === "cost-data/setup")).toHaveLength(4);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
  it("retry missing work requires confirmation and stops job polling on errors", async () => {
    const { page, requests, errors } = await mount("cost", { failedJob: true });
    await waitText(page, "Ready to review.");
    await waitText(page, "mock-failed");
    await page.getByRole("radio", { name: "Scheduled updates", exact: true }).click();
    await page.getByRole("button", { name: "Retry missing work", exact: true }).click();
    expect(requests.some(r => r.path.includes("/resume"))).toBe(false);
    await page.getByRole("button", { name: "Authorize retry" }).click();
    await waitText(page, "Retry authorized");
    expect(requests.find(r => r.path.includes("/resume"))).toMatchObject({ path: "focus/jobs/mock-failed/resume?scope=sub-a%2Csub-b", method: "POST", body: {} });
    expect(errors).toEqual([]);
    await page.close();
    const failed = await mount("cost", { jobsError: true });
    await waitText(failed.page, "Mock job status unavailable");
    await failed.page.clock.install();
    const reads = failed.requests.filter(r => r.path.startsWith("focus/jobs?")).length;
    await failed.page.clock.fastForward(60_000);
    expect(failed.requests.filter(r => r.path.startsWith("focus/jobs?"))).toHaveLength(reads);
    await failed.page.close();
  }, 30_000);
  it("downloads selected reports and raw FOCUS without saving externally until storage confirmation", async () => {
    const { page, requests, errors } = await mount("reports");
    await waitText(page, "Compute");
    await page.evaluate(() => { HTMLAnchorElement.prototype.click = () => { throw new Error("Synthetic anchor clicks are blocked in this managed-browser mock."); }; });
    await page.getByLabel("Report file format").selectOption("csv");
    const downloaded = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download report", exact: true }).click();
    expect((await downloaded).suggestedFilename()).toBe("mock.csv");
    const reportRequest = requests.find(r => r.path.startsWith("report/csv?"));
    expect(reportRequest).toMatchObject({ method: "GET", body: null });
    expect(Object.fromEntries(new URL(`https://example.test/${reportRequest?.path}`).searchParams)).toEqual({ days: "30", summary: "true", sections: "compute", blocks: "trend,services", live: "" });
    expect(await page.getByRole("status").last().innerText()).not.toContain("saved locally");
    await page.getByRole("button", { name: "Review save to storage" }).click();
    expect(requests.some(r => r.path.startsWith("archive/export?"))).toBe(false);
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    const raw = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download raw data" }).click();
    await raw;
    expect(requests.some(r => r.path.startsWith("archive/export/download?") && r.path.includes("scope=sub-a%2Csub-b"))).toBe(true);
    await page.getByRole("button", { name: "Review save to storage" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
    await waitText(page, "Saved 12 rows to mock/archive/exports/mock.csv");
    expect(requests.filter(r => r.path.startsWith("archive/export?"))).toHaveLength(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
  it("native GET links carry selected month/scope and deliberately empty summary/area/detail choices", async () => {
    const { page, requests, errors } = await mount("reports");
    await page.goto(`${base}/v2/reports/export?month=2026-08&scope=sub-b`);
    await waitText(page, "Calendar month 2026-08");
    await waitText(page, "Compute");
    await page.getByLabel("Summary and by-area breakdown").uncheck();
    await page.getByLabel("Compute ·", { exact: false }).uncheck();
    await page.getByLabel("Daily trend", { exact: true }).uncheck();
    await page.getByLabel("By service", { exact: true }).uncheck();
    await page.getByLabel("Orphaned resources", { exact: true }).check();
    for (const fmt of ["csv", "xlsx", "pptx"]) {
      await page.getByLabel("Report file format").selectOption(fmt);
      const href = await page.getByRole("link", { name: "Download report", exact: true }).getAttribute("href");
      const url = new URL(href!, base);
      expect(url.pathname).toBe(`/api/report/${fmt}`);
      expect(Object.fromEntries(url.searchParams)).toEqual({ days: "30", summary: "false", sections: "", blocks: "", live: "waste", scope: "sub-b", period_month: "2026-08" });
      const download = page.waitForEvent("download");
      await page.getByRole("link", { name: "Download report", exact: true }).click();
      expect((await download).suggestedFilename()).toBe(`mock.${fmt}`);
    }
    expect(requests.filter(r => r.path.startsWith("report/") && !r.path.startsWith("report/options")).every(r => r.method === "GET" && r.body === null)).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
  it("surfaces a failed download and never turns error JSON into a file", async () => {
    const { page, requests } = await mount("reports", { downloadFail: true });
    let downloads = 0; page.on("download", () => downloads++);
    await waitText(page, "Compute");
    const popup = page.waitForEvent("popup");
    await page.getByRole("link", { name: "Download report", exact: true }).click();
    const response = await popup;
    await waitText(response, "Mock report failed");
    expect(downloads).toBe(0);
    expect(requests.some(r => r.path.startsWith("report/xlsx?") && r.method === "GET")).toBe(true);
    expect(await page.getByRole("status").last().innerText()).not.toContain("saved");
    await response.close();
    await page.close();
  }, 30_000);
  it("queued interactive jobs require explicit review/resume, preserve the exact job, and never auto-run on render", async () => {
    const { page, requests, errors } = await mount("cost", { queuedInteractive: true, jobScope: ["sub-a"] });
    await waitText(page, "mock-interactive");
    expect(requests.some(r => r.method === "POST")).toBe(false);
    expect(await page.getByRole("button", { name: "Review import and updates" }).isDisabled()).toBe(true);
    await page.getByText("focus-manual · queued · mock-interactive", { exact: true }).click();
    await page.getByRole("button", { name: "Review resume pending job" }).click();
    expect(requests.some(r => r.path.includes("/resume"))).toBe(false);
    await waitText(page, "same persisted job and original approval key");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(requests.some(r => r.method === "POST")).toBe(false);
    await page.getByRole("button", { name: "Review resume pending job" }).click();
    await page.getByRole("button", { name: "Authorize retry" }).click();
    await waitText(page, "not yet completed");
    expect(requests.filter(r => r.path.includes("/resume"))).toEqual([{ path: "focus/jobs/mock-interactive/resume?scope=sub-a", method: "POST", body: {} }]);
    expect(errors).toEqual([]);
    await page.close();
    const active = await mount("cost", { runningInteractive: true });
    await waitText(active.page, "mock-interactive");
    expect(await active.page.getByRole("button", { name: "Review resume pending job" }).count()).toBe(0);
    expect(active.requests.some(r => r.method === "POST")).toBe(false);
    await active.page.close();
  }, 30_000);
  it("failed resume has no fake success and queued interactive resumption retains write guards", async () => {
    const { page, requests } = await mount("cost", { queuedInteractive: true, resumeFail: true });
    await waitText(page, "mock-interactive");
    await page.getByText("focus-manual · queued · mock-interactive", { exact: true }).click();
    await page.getByRole("button", { name: "Review resume pending job" }).click();
    await page.getByRole("button", { name: "Authorize retry" }).click();
    await waitText(page, "Mock resumption rejected");
    expect(await page.getByText("Retry authorized", { exact: false }).count()).toBe(0);
    expect(requests.filter(r => r.path.includes("/resume"))).toHaveLength(1);
    await page.close();
    const readOnly = await mount("cost", { queuedInteractive: true, readOnly: true });
    await waitText(readOnly.page, "mock-interactive");
    await readOnly.page.getByText("focus-manual · queued · mock-interactive", { exact: true }).click();
    expect(await readOnly.page.getByRole("button", { name: "Review resume pending job" }).isDisabled()).toBe(true);
    expect(readOnly.requests.some(r => r.method === "POST")).toBe(false);
    await readOnly.page.close();
  }, 30_000);
  it("retail USD remains separate from INR billing and incomplete prices never claim a full total", async () => {
    const { page, errors } = await mount("commitments");
    await page.getByRole("radio", { name: "Hybrid Benefit & support" }).click();
    await waitText(page, "1 uncovered VMs unpriced");
    await waitText(page, "1 uncovered machines unpriced");
    const vm = page.getByRole("row").filter({ hasText: "Retail VM" });
    expect(await vm.innerText()).toContain("₹500");
    expect(await vm.innerText()).toContain("$120");
    expect(await vm.innerText()).not.toContain("₹120");
    expect(await page.getByRole("row").filter({ hasText: "Arc priced" }).innerText()).toContain("$10");
    expect(await page.getByText("ESU billed:", { exact: false }).innerText()).toContain("₹700");
    expect(errors).toEqual([]);
    await page.close();
    const full = await mount("commitments", { completePricing: true });
    await full.page.getByRole("radio", { name: "Hybrid Benefit & support" }).click();
    await waitText(full.page, "Windows Server license evidence");
    await waitText(full.page, "Support lifecycle evidence");
    expect(await full.page.getByText("Partial pricing", { exact: false }).count()).toBe(0);
    expect(await full.page.getByText(/USD \$360/).count()).toBe(1);
    expect(await full.page.getByText(/USD \$30/).count()).toBe(1);
    await full.page.close();
  }, 30_000);
  it("guards audit locally and surfaces a server 403 instead of an empty table", async () => {
    const member = await mount("audit", { admin: false });
    await waitText(member.page, "Administrator access is required");
    expect(member.requests.some(r => r.path.startsWith("dashboard/audit"))).toBe(false);
    await member.page.close();
    const denied = await mount("audit", { audit403: true });
    await waitText(denied.page, "Administrator audit access denied");
    expect(await denied.page.getByRole("table").count()).toBe(0);
    await denied.page.close();
    const admin = await mount("audit");
    await waitText(admin.page, "Alice");
    await admin.page.getByLabel("Actor or email").fill("alice");
    expect(await admin.page.getByText("Bob", { exact: true }).count()).toBe(0);
    await admin.page.close();
  }, 30_000);
});
