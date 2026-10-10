import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { aiAmounts, aiRowKey, observedTokens, validateOptimizeReport, type AiDeploymentRow, type AiReport, type AiResourceRow, type Amount, type Metric } from "./optimize-queries";

const subscription = "11111111-1111-1111-1111-111111111111";
const resource = `/subscriptions/${subscription}/resourcegroups/ai/providers/microsoft.cognitiveservices/accounts/account`;
const window = { from: "2026-09-01", to: "2026-09-30", days: 30, timezone: "UTC", bounds: "inclusive" };
const metricWindow = { start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" };
function tokens(value: number | null = 50): Metric {
  return { value, status: value == null ? "unavailable" : "partial", input: value == null ? null : 20, output: value == null ? null : 30, input_status: "partial", output_status: "partial", unit: "tokens", aggregation: "Total", source: "Azure Monitor", note: "Completed hourly observations retained.", samples: 10, expected_samples: 720, window: metricWindow };
}
const utilization: Metric = { value: null, maximum: null, status: "not_applicable", unit: "Percent", aggregation: "Average", source: "Azure Monitor", samples: 0, expected_samples: 0, window: metricWindow, note: "Current deployment SKU is non-provisioned, not a historical SKU assertion." };
// Field-for-field public row shapes from ai_billing._costs / _probe / _attach_anomalies.
function resourceRow(): AiResourceRow {
  return {
    id: resource, resource_id: resource, resource_name: "account", subscription_id: subscription, subscription: "AI subscription",
    service: "Azure OpenAI", services: ["Azure OpenAI"], models: ["Billing product (not deployment)"], billing_rows: 2,
    cost_by_currency: [{ currency: "USD", cost: 10 }, { currency: "INR", cost: null }], cost: null, currency: null,
    meters: [{ product: "Billing product (not deployment)", meter: "1M Tokens", service: "Azure OpenAI", quantity: 2, unit: "Units", cost: 10, currency: "USD" },
      { product: null, meter: null, service: "Azure OpenAI", quantity: null, unit: null, cost: null, currency: "INR" }],
    notes: [], deployment_status: "ok", metric_read_started: true, tokens: tokens(), utilization,
    recommendation: "Review metric coverage.", anomaly_status: "unavailable", anomaly_note: "No complete observed days.", anomalies: [],
    anomaly_checks: [{ metric: "tokens", currency: null, status: "unavailable", note: "Incomplete telemetry is not zero.", eligible_days: 30, observed_days: 0, checked_days: 0, missing_days: 30, insufficient_history_days: 0, negative_days: 0, excluded_tail_days: 0 }],
  };
}
function deploymentRow(deployment = "chat"): AiDeploymentRow {
  return {
    deployment, model: "gpt-4o", version: "2024-08-06", format: "OpenAI", sku: "GlobalStandard",
    resource_id: resource, resource_name: "account", subscription_id: subscription, service: "Azure OpenAI",
    cost: null, cost_note: "Billing is recorded at resource/meter level; not allocated to this deployment",
    metadata_source: "Azure ARM deployment metadata (current, not historical)", tokens: tokens(), utilization,
    recommendation: "Review workload and source data.", anomaly_status: "partial", anomaly_note: "Missing days not judged.",
    anomalies: [{ metric: "tokens", direction: "up", day: "2026-09-28", actual: 200000, baseline: 0, delta: 200000, percent: null, unit: "tokens", severity: "high", score: 10, baseline_samples: 7, baseline_from: "2026-09-21", baseline_to: "2026-09-27", source: "Azure Monitor", note: "Missing days were not filled with zero." }],
    anomaly_checks: [{ metric: "tokens", currency: null, status: "partial", eligible_days: 30, observed_days: 8, checked_days: 1, missing_days: 22, insufficient_history_days: 7, negative_days: 0, excluded_tail_days: 0 }],
  };
}
function report(): AiReport {
  return { status: "partial", generated_at: "2026-10-03T08:00:00Z", window, services: [resourceRow()], models: [deploymentRow()],
    totals: [{ currency: "USD", cost: 10 }, { currency: "INR", cost: null }], notices: ["Billing products are labels, not deployments."], source: "Scoped warehouse BilledCost", truncated: false,
    metric_coverage: { eligible_accounts: 1, queried_accounts: 1, accounts_with_tokens: 1, accounts_with_complete_tokens: 0 } };
}

describe("Actual AI billing wire contract", () => {
  it("reproduces the old undefined .map and keeps metadata distinct from costs", () => {
    const model = deploymentRow();
    const legacyAmounts = (r: { cost_by_currency?: Amount[] | null }) => r.cost_by_currency!.map(a => a.currency);
    expect(() => legacyAmounts(model)).toThrow(TypeError);
    expect(() => validateOptimizeReport("ai-billing", report())).not.toThrow();
    expect(aiAmounts(model)).toBeNull();
    expect(aiRowKey(model)).toContain(`${resource}|chat`);
    expect(aiRowKey(deploymentRow("embeddings"))).not.toBe(aiRowKey(model));
    expect(observedTokens(report().services).value).toBe(50);
    expect(aiAmounts(resourceRow())).toEqual([{ currency: "USD", cost: 10 }, { currency: "INR", cost: null }]);
  });
  it("accepts exact empty/null window and optional mappings, rejects malformed billing and telemetry", () => {
    expect(() => validateOptimizeReport("ai-billing", { ...report(), services: [], models: [], totals: [], window: { ...window, from: null, to: null } })).not.toThrow();
    expect(() => validateOptimizeReport("ai-billing", { ...report(), models: [{ ...deploymentRow(), model: null, version: null, sku: null, format: null, cost_by_currency: null }] })).not.toThrow();
    expect(() => validateOptimizeReport("ai-billing", { ...report(), models: [{ ...deploymentRow(), cost_by_currency: [{ currency: "EUR", cost: 0 }] }] })).not.toThrow();
    for (const bad of [
      { ...report(), models: [{ ...deploymentRow(), tokens: null }] },
      { ...report(), services: [{ ...resourceRow(), cost_by_currency: undefined }] },
      { ...report(), models: [{ ...deploymentRow(), anomalies: [{ metric: "tokens", direction: "up", day: "2026-09-28", actual: 5, baseline: 0, percent: "bad" }] }] },
      { ...report(), models: { value: [deploymentRow()] } },
    ]) expect(() => validateOptimizeReport("ai-billing", bad)).toThrow("incomplete evidence");
  });
  it("agrees with the actual classic module on rows, partial tokens and anomaly filtering", async () => {
    const modulePath = new URL("../../../web/assets/dashboard-ai.js", import.meta.url).href;
    const classic: {
      validAiBilling: (data: unknown) => boolean;
      aiTokenSummary: (rows: AiResourceRow[]) => ReturnType<typeof observedTokens>;
      filterAiRows: (rows: AiDeploymentRow[], query: string) => AiDeploymentRow[];
      prioritizeAiAnomalies: (rows: AiDeploymentRow[], only: boolean) => AiDeploymentRow[];
    } = await import(/* @vite-ignore */ modulePath);
    const data = report();
    expect(classic.validAiBilling(data)).toBe(true);
    expect(classic.aiTokenSummary(data.services)).toEqual(observedTokens(data.services));
    expect(classic.filterAiRows(data.models, "chat")).toEqual(data.models);
    expect(classic.prioritizeAiAnomalies(data.models, true)).toEqual(data.models);
  });
});

let server: ViteDevServer;
let browser: Browser;
let base = "";
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import "/src/styles.css";
import { makeRouter } from "/src/router.tsx";
import { LazyMotion, domAnimation } from "motion/react";
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")).render(React.createElement(LazyMotion, { features: domAnimation }, React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router: makeRouter(client) }))));
`;
beforeAll(async () => {
  server = await createServer({
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    plugins: [{
      name: "isolated-ai-billing-tests",
      resolveId(id) { return id.endsWith("/__ai-billing-test.js") ? "\0ai-billing-test" : undefined; },
      load(id) { return id === "\0ai-billing-test" ? fixture : undefined; },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const path = "url" in req && typeof req.url === "string" ? req.url.split("?")[0] : "";
          if (path !== "/v2/explore/ai-billing") { next(); return; }
          const html = await vite.transformIndexHtml("/v2/__ai-billing-test", '<html><head></head><body><div id="root"></div><script type="module" src="/v2/__ai-billing-test.js"></script></body></html>');
          res.setHeader("Content-Type", "text/html"); res.end(html);
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Test Vite listener unavailable");
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

async function mount(data: AiReport, offline = false) {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  const requests: Array<{ path: string; method: string }> = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/", "");
    requests.push({ path: `${path}${url.search}`, method: request.method() });
    let response: unknown;
    if (request.method() !== "GET") { errors.push(`Unexpected write: ${path}`); await route.abort(); return; }
    if (path === "dashboard/ai-billing") {
      if (offline) { await route.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"AI evidence offline"}' }); return; }
      response = data;
    } else if (path === "auth/me") response = { authenticated: true, mode: "local", user: { name: "Mock", admin: true, source: "file" } };
    else if (path === "subscriptions" || path === "cost-data/subscriptions") response = { subscriptions: [{ id: subscription, name: "AI subscription" }] };
    else if (path === "reporting-period") response = { months: ["2026-09"], selected_month: null };
    else if (path === "currency") response = { supported: ["USD", "INR"], source: "Mock" };
    else if (path === "warehouse") response = { from: window.from, to: window.to, rows: 2 };
    else { errors.push(`Unexpected API: ${path}`); await route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"No real API access allowed"}' }); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.goto(`${base}/v2/explore/ai-billing?scope=${subscription}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator("#main").getByRole("heading", { name: "AI Billing", exact: true }).waitFor({ timeout: 30000 });
  return { page, errors, requests };
}

describe("AI billing native router regression", () => {
  it("loads Resources / Services / Models, opens model evidence and links only to resource billing", async () => {
    const { page, errors, requests } = await mount(report());
    try {
      await page.getByRole("heading", { name: "AI resource billing", exact: true }).waitFor();
      await page.getByRole("radio", { name: "Services", exact: true }).click();
      await page.getByRole("heading", { name: "AI services", exact: true }).waitFor();
      expect(await page.locator("#main").innerText()).toContain("INR");
      await page.getByRole("radio", { name: "Models", exact: true }).click();
      await page.getByRole("heading", { name: "Model usage", exact: true }).waitFor();
      const model = page.getByRole("button", { name: "gpt-4o · chat", exact: true });
      await model.waitFor();
      expect(await page.locator("#main").innerText()).toContain("GlobalStandard");
      expect(await page.locator("#main").innerText()).toContain("2024-08-06");
      // A two-line token cell must sit inside its row: no overlap onto the next line, no clipping.
      const fit = await page.locator('[role="row"] [role="cell"]').evaluateAll(cells => cells
        .filter(c => /^\s*\S.*In .* Out /s.test(c.textContent ?? ""))
        .map(c => { const row = c.closest('[role="row"]')!.getBoundingClientRect(), box = c.firstElementChild!.getBoundingClientRect(); return { inside: box.top >= row.top - 0.5 && box.bottom <= row.bottom + 0.5, wide: c.scrollWidth <= c.clientWidth + 1 }; }));
      expect(fit.length).toBeGreaterThan(0);
      expect(fit.every(f => f.inside && f.wide)).toBe(true);
      expect(await page.locator("#main").innerText()).not.toMatch(/\d\.000 tokens/);
      await model.click();
      await page.getByRole("heading", { name: "Current deployment metadata · not historical", exact: true }).waitFor();
      expect(await page.locator("#main").innerText()).toContain("Unavailable · not returned by API");
      expect(await page.locator("#main").innerText()).toContain("Zero baseline; percentage unavailable");
      await page.getByRole("heading", { name: "Anomaly assessment coverage", exact: true }).waitFor();
      await page.getByRole("checkbox", { name: "Only anomalies" }).check();
      expect(await model.count()).toBe(1);
      await page.getByRole("button", { name: "View resource cost (not allocated to model)", exact: true }).click();
      await page.getByRole("heading", { name: "AI resource billing", exact: true }).waitFor();
      expect(await page.getByRole("checkbox", { name: "Only anomalies" }).isChecked()).toBe(false);
      await page.getByRole("button", { name: "Azure OpenAI · account", exact: true }).click();
      await page.getByRole("heading", { name: "Billing products and meters", exact: true }).waitFor();
      expect(await page.locator("#main").innerText()).toContain("2.00 Units");
      await page.getByRole("button", { name: "Refresh evidence", exact: true }).click();
      await page.getByRole("heading", { name: "AI resource billing", exact: true }).waitFor();
      const nextWindow = page.waitForResponse(response => response.url().includes("dashboard/ai-billing") && response.url().includes("days=14"));
      await page.getByRole("combobox", { name: "Source window", exact: true }).selectOption("14");
      await nextWindow;
      await page.getByRole("radio", { name: "Models", exact: true }).click();
      await page.getByRole("heading", { name: "Model usage", exact: true }).waitFor();
      expect(requests.some(r => r.path.includes("force=true"))).toBe(true);
      expect(requests.some(r => r.path.includes("days=14"))).toBe(true);
      expect(requests.some(r => r.path.includes(`scope=${subscription}`))).toBe(true);
      expect(requests.every(r => r.method === "GET")).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 40_000);
  it("renders empty billing with null dates without claiming missing telemetry is zero", async () => {
    const { page, errors } = await mount({ ...report(), services: [], models: [], totals: [], window: { ...window, from: null, to: null } });
    try {
      await page.getByText("Billing window unavailable", { exact: false }).waitFor();
      await page.getByRole("radio", { name: "Models", exact: true }).click();
      await page.getByText("No model-level usage available. Resource billing remains available.", { exact: true }).waitFor();
      await page.getByRole("radio", { name: "Services", exact: true }).click();
      await page.getByText("No AI services match this selection.", { exact: true }).waitFor();
      expect(await page.locator("#main").innerText()).toContain("Unavailable");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
  it("uses only an explicit deployment currency mapping, never a scalar cost as USD or a unit rate", async () => {
    const { page, errors } = await mount({ ...report(), models: [{ ...deploymentRow(), cost: 999, cost_by_currency: [{ currency: "EUR", cost: 0 }] }] });
    try {
      await page.getByRole("radio", { name: "Models", exact: true }).click();
      await page.getByRole("button", { name: "gpt-4o · chat", exact: true }).waitFor();
      expect(await page.locator("#main").innerText()).toContain("EUR €0.00");
      expect(await page.getByRole("button", { name: "Not allocated · view resource cost", exact: true }).count()).toBe(0);
      expect(await page.locator("#main").innerText()).not.toContain("999");
      expect(await page.locator("#main").innerText()).toContain("Unavailable · not returned by API");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
  it("renders missing metadata and unavailable token components honestly, including model search and empty anomaly filter", async () => {
    const model: AiDeploymentRow = { ...deploymentRow(), model: null, version: null, format: null, sku: null, tokens: tokens(null), anomalies: [], anomaly_status: "unavailable" };
    const { page, errors } = await mount({ ...report(), models: [model] });
    try {
      await page.getByRole("radio", { name: "Models", exact: true }).click();
      const button = page.getByRole("button", { name: "Model not reported · chat", exact: true });
      await button.waitFor();
      expect(await page.locator("#main").innerText()).toContain("In Unavailable · Out Unavailable");
      await page.getByRole("searchbox", { name: "Search AI services and models", exact: true }).fill("unmatched");
      await page.getByText("No records match this search.", { exact: true }).waitFor();
      await page.getByRole("searchbox", { name: "Search AI services and models", exact: true }).fill("chat");
      await button.waitFor();
      await page.getByRole("checkbox", { name: "Only anomalies" }).check();
      await page.getByText("No flagged rows match this selection.", { exact: false }).waitFor();
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
  it("shows unavailable offline evidence and retries only a read, not a fabricated empty report", async () => {
    const { page, errors, requests } = await mount(report(), true);
    try {
      await page.getByText("AI evidence offline", { exact: false }).first().waitFor();
      expect(await page.getByRole("heading", { name: "Model usage", exact: true }).count()).toBe(0);
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await page.getByText("AI evidence offline", { exact: false }).first().waitFor();
      expect(requests.filter(r => r.path.startsWith("dashboard/ai-billing")).length).toBeGreaterThanOrEqual(2);
      expect(requests.every(r => r.method === "GET")).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
});
