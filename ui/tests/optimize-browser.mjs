import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

// Independent Vite dev server and completely mocked APIs; never touches the running backend.
const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)), server: { port: 0, strictPort: false, host: "127.0.0.1", proxy: {} } });
await server.listen();
const address = server.httpServer.address();
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const sub = "11111111-1111-1111-1111-111111111111";
const vm = `/subscriptions/${sub}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm`;
const metric = { status: "ok", value: 12, source: "Azure Monitor", note: "Hourly observations", aggregation: "Average" };
const aiRow = { id: vm, resource_id: vm, service: "Azure OpenAI", resource_name: "model-account", subscription: "Subscription A", models: ["GPT"], tokens: { ...metric, value: 100, input: 60, output: 40 }, utilization: { status: "not_applicable", value: null, note: "Pay as you go" }, cost_by_currency: [{ currency: "USD", cost: 50 }, { currency: "INR", cost: 250 }], recommendation: "Review usage evidence.", anomaly_status: "insufficient_history", anomalies: [], meters: [{ product: "GPT", meter: "Token-price meter", quantity: 3, unit: "units", cost: 50, currency: "USD" }], billing_rows: 1 };
let performanceUnavailable = false;
let performanceHttpError = false;
let savingsPolls = 0;
let whatIfPosts = [];
let performanceRequests = [];
const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
await page.route("**/api/**", async route => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  if (path === "/api/subscriptions") return fulfill(route, { subscriptions: [{ id: sub, name: "Subscription A", currency: "USD", cost: 50, in_warehouse: true }], count: 1 });
  if (path === "/api/dashboard/savings/progress") {
    const running = ++savingsPolls <= 2;
    if (savingsPolls <= 2) await new Promise(resolve => setTimeout(resolve, 600));
    return fulfill(route, { currency: "USD", days: 30, count: 1, billed_total: 50, projected_total: null, merged: 1, variants_folded: 2, categories: [{ id: "idle", label: "Idle compute", count: 1, total: 50 }], opportunities: [{ key: "vm", title: "Review idle VM", category: "idle", category_label: "Idle compute", resource: "vm", resource_id: vm, count: 1, confidence: "high", corroborated: true, currency: "USD", window: 50, annual: 600, why: "Low measured CPU.", action: "Validate workload before resizing.", sources: [{ label: "VM utilization", basis: "billed", claim: "CPU measured from Monitor" }, { label: "Inventory", basis: "billed", claim: "Running VM" }], options: [], items: [] }], scan: { status: running ? "running" : "complete", completed: running ? [] : ["rightsizing", "advisor"], errors: {} }, freshness: { generated_at: "2026-10-03T07:00:00Z", stale: false }, unavailable: { scheduling: "Missing permission" }, partial: true });
  }
  if (path === "/api/dashboard/recommendations") return fulfill(route, { narrative: "Review the corroborated VM first." });
  if (path === "/api/dashboard/whatif") {
    const body = route.request().postDataJSON(); whatIfPosts.push(body);
    return fulfill(route, { currency: "USD", days: 30, current_size: "Standard_D2s_v5", target_size: body.target_sku, billed: { annual: 600 }, current_retail: { annual: 800 }, target: { annual: body.target_sku === "shutdown" ? 0 : 400 }, annual_saving: body.target_sku === "shutdown" ? 600 : 200, note: "Read-only simulation; retained disks still charge." });
  }
  if (path === "/api/dashboard/rightsizing") return fulfill(route, { currency: "USD", period_days: 30, count: 1, running: 1, idle_count: 1, stopped_count: 0, idle_cost: 50, vms: [{ id: vm, name: "vm", size: "Standard_D2s_v5", power_state: "running", cpu_avg: 1, cpu_max: 50, cost: 50, currency: "USD" }] });
  if (path === "/api/dashboard/waste") return fulfill(route, { currency: "USD", period_days: 30, total_items: 1, total_cost: 25, subscriptions: 1, findings: [{ category: "unattached_disks", count: 1, why: "Review attachment evidence.", items: [{ id: "disk", name: "disk", resource_group: "rg", cost: 25, currency: "USD" }] }] });
  if (path === "/api/dashboard/advisor") return fulfill(route, { category: url.searchParams.get("category"), currency: "USD", count: 1, estimated_annual_savings: null, recommendations: [{ problem: "Review size", solution: "Validate SKU.", resource: "vm", impact: "High", annual_savings: null }] });
  if (path === "/api/dashboard/shutdown") return fulfill(route, { currency: "USD", count: 0, candidates: [], examined: 1, partial: true, total_current: null, total_saving: null, hours_kept: 60, note: "Metrics could not be read." });
  if (path === "/api/dashboard/performance") {
    performanceRequests.push(Object.fromEntries(url.searchParams));
    if (performanceHttpError) return fulfill(route, { detail: "Azure Monitor permission denied" }, 502);
    return fulfill(route, { status: performanceUnavailable ? "unavailable" : "partial", resources: performanceUnavailable ? [] : [{ id: vm, name: "performance-vm", type: "microsoft.compute/virtualmachines", region: "eastus", status: "partial", metrics: [{ ...metric, name: "Percentage CPU", label: "CPU", unit: "Percent", value: 0, samples: 20, last_sample: "2026-10-02T00:00:00Z" }, { name: "Network In Total", label: "Network received", unit: "Bytes", status: "unavailable", value: null, samples: 0, note: "Denied read" }], cost: { from: "2026-09-26", to: "2026-10-03", by_currency: [{ currency: "USD", cost: 10 }, { currency: "INR", cost: 200 }] }, notes: ["Not automatic resizing."] }], notices: [performanceUnavailable ? "Permission denied in source." : "One metric unavailable."], generated_at: "2026-10-03T07:00:00Z", window: { start: "2026-09-26T00:00:00Z", end: "2026-10-03T00:00:00Z", days: 7 }, source: "Azure Monitor", sampled_count: performanceUnavailable ? 0 : 1, inventory_count: 1 });
  }
  if (path === "/api/dashboard/ai-billing") return fulfill(route, { status: "partial", services: [aiRow], models: [{ ...aiRow, id: "model", model: "GPT-4", deployment: "chat-deployment", cost_by_currency: [], cost_note: "Billing cannot allocate this model.", tokens: { status: "unavailable", value: null, note: "Missing telemetry" } }], totals: aiRow.cost_by_currency, notices: ["Partial account telemetry."], generated_at: "2026-10-03T07:00:00Z", window: { from: "2026-09-03", to: "2026-10-03" }, metric_coverage: { accounts_with_tokens: 1, eligible_accounts: 2 } });
  if (path === "/api/dashboard/commitments") return fulfill(route, { coverage: { currency: "USD", total: 100, compute_total: 80, coverage_pct: null, compute_coverage_pct: null, coverage_status: "unknown", split: { "On demand": 100 }, compute_split: { "On demand": 80 } }, inventory: { error: "Missing inventory permission", commitments: [], count: null }, comparison: { currency: "USD", models: [{ label: "Pay-as-you-go", baseline: true, annual_cost: 1200, annual_saving: 0 }, { label: "Savings plan", unavailable: true, annual_cost: null, annual_saving: null, reason: "Not offered by Advisor." }], note: "Alternatives, not additive." }, spot: { empty: true, trend: [] } });
  if (path === "/api/dashboard/rates") return fulfill(route, { commitments: [{ problem: "Savings plan", term: "1 year", sku: "D2", annual_savings: 100, currency: "USD", lookback_days: 60 }], note: "Terms are alternatives." });
  if (path === "/api/dashboard/hybrid-benefit") return fulfill(route, { vms: [], count: 0, covered: 0, uncovered: 0, currency: "USD", estimated_annual_savings: null, error: "No license inventory access" });
  if (path === "/api/dashboard/esu") return fulfill(route, { machines: [], currency: "USD", error: "No support inventory access", scanned: {} });
  throw new Error(`Unmocked API request: ${path}`);
});
async function open(screen, scope = sub) {
  await page.goto(`${origin}/v2/tests/optimize-browser.html?screen=${screen}${scope ? `&scope=${scope}` : ""}`);
}
async function contains(text) { await page.getByText(text, { exact: false }).first().waitFor({ timeout: 15000 }); }
try {
  await open("savings");
  await contains("Loading savings scan");
  await contains("Provisional totals");
  await contains("scheduling unavailable");
  await contains("Review idle VM");
  await page.getByText("Review idle VM", { exact: true }).click();
  await contains("CPU measured from Monitor");
  assert.equal(await page.getByRole("button", { name: "Compare", exact: true }).isDisabled(), true);
  assert.equal(whatIfPosts.length, 0);
  await page.getByLabel("Target VM size").fill("Standard_B2s");
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await contains("Saves about");
  assert.equal(whatIfPosts[0].target_sku, "Standard_B2s");
  await page.getByRole("button", { name: "Shut down instead", exact: true }).click();
  await page.waitForFunction(() => document.body.textContent.includes("USD $600.00"));
  assert.equal(whatIfPosts[1].target_sku, "shutdown");
  await page.getByRole("radio", { name: "Rightsizing", exact: true }).click();
  await contains("Virtual machines by cost");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  assert.match((await downloadPromise).suggestedFilename(), /virtual-machines-by-cost\.csv/);
  await page.getByRole("radio", { name: "Idle & orphaned", exact: true }).click();
  await contains("unattached disks");
  await page.getByRole("radio", { name: "Advisor", exact: true }).click();
  await contains("Azure Advisor evidence");
  await page.getByLabel("Advisor category").selectOption("Performance");
  await contains("Performance recommendations");
  await page.getByRole("radio", { name: "Scheduling", exact: true }).click();
  await contains("Scheduling assessment incomplete");
  console.log("PASS Savings progress/evidence/subscreens and guarded read-only simulations");

  performanceRequests = [];
  await open("performance", "");
  await contains("Select 1–100");
  assert.equal(performanceRequests.length, 0);
  await page.getByRole("button", { name: "Subscription scope" }).click();
  await page.getByRole("option", { name: /Subscription A/ }).click();
  await page.keyboard.press("Escape");
  await contains("performance-vm");
  assert.match(page.url(), /scope=11111111/);
  assert.equal(performanceRequests.at(-1).window_days, "7");
  await page.getByLabel("Evidence window").selectOption("14");
  await contains("performance-vm");
  await page.waitForTimeout(300);
  assert.equal(performanceRequests.at(-1).window_days, "14");
  await page.getByRole("button", { name: "performance-vm", exact: true }).click();
  await contains("Denied read");
  await contains("0.000 Percent");
  performanceUnavailable = true;
  await page.getByRole("button", { name: "Refresh evidence", exact: true }).click();
  await contains("Performance evidence unavailable");
  performanceHttpError = true;
  await page.getByRole("button", { name: "Refresh evidence", exact: true }).click();
  await contains("Azure Monitor permission denied");
  console.log("PASS Performance explicit scope URL, actual lookback, measured zero, unavailable/502 evidence");

  await open("ai");
  await contains("AI resource billing");
  await contains("Partial account telemetry");
  await contains("INR");
  await page.getByRole("radio", { name: "Services", exact: true }).click();
  await contains("AI services");
  await page.getByRole("radio", { name: "Models", exact: true }).click();
  await contains("Not allocated");
  await page.getByRole("button", { name: /Not allocated.*view resource cost/i }).click();
  await contains("AI resource billing");
  await page.getByRole("button", { name: /Azure OpenAI.*model-account/ }).click();
  await contains("Billing products and meters");
  await contains("Token-price meter");
  await page.getByLabel("Only anomalies").check();
  await contains("No flagged rows match");
  console.log("PASS AI mixed currencies, partial coverage, service/resource/model breakdowns and cost drill");

  await open("commitments");
  await contains("Missing inventory permission");
  await contains("Not offered");
  assert.equal(await page.getByText("Active commitments", { exact: true }).count(), 1);
  await page.getByRole("radio", { name: "Rate recommendations", exact: true }).click();
  await contains("Reservation & savings plan recommendations");
  await page.getByRole("radio", { name: "Hybrid Benefit & support", exact: true }).click();
  await contains("No license inventory access");
  await contains("No support inventory access");
  console.log("PASS Commitments unavailable inventory, alternatives, rate terms and independent license evidence");
  assert.deepEqual(errors, []);
  console.log("PASS No browser runtime errors; all APIs mocked");
} catch (error) {
  console.error("Browser errors:", errors);
  console.error((await page.locator("body").innerText()).slice(0, 5000));
  throw error;
} finally {
  await browser.close();
  await server.close();
}
