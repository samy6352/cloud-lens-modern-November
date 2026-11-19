import { beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { launchNativeBrowser, nativeTestCleanup } from "./tests/native-test-cleanup";

let server: ViteDevServer;
let browser: Browser;
let base = "";
const first = "11111111-1111-1111-1111-111111111111";
const second = "22222222-2222-2222-2222-222222222222";
const fixture = `
import React from "react";
import "/src/styles.css";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { LazyMotion, domAnimation } from "motion/react";
import { makeRouter } from "/src/router.tsx";
const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
createRoot(document.getElementById("root")).render(
  React.createElement(LazyMotion,{features:domAnimation},
    React.createElement(QueryClientProvider,{client},
      React.createElement(RouterProvider,{router:makeRouter(client)}))));
`;
const ranked = (id: string, cost: number) => ({ id, name: "Production", cost, previous: 0, delta: cost, change_pct: null, share_pct: 50 });
const executive = {
  currency: "USD", days: 30, as_of: "2026-10-03",
  kpis: { total: 1900, previous: 0, change_pct: null, daily_avg: 100, resources: 2, services: 0, subscriptions: 2, regions: 0, top5_share_pct: null },
  trend: { labels: [], values: [], previous: [], partial_last: false },
  areas: [], movers: [], services: [], resource_groups: [], regions: [], monthly: null,
  subscriptions: [ranked(first, 1000), ranked(second, 900)],
};
const vm = (name: string, cost: number) => ({ id: `/subscriptions/${first}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/${name}`, name, cost, currency: "USD", cpu_avg: 1, cpu_max: 2 });
const anomaly = (currency: string) => ({
  id: currency, key: `${currency} spike`, currency, first_day: "2026-10-02", last_day: "2026-10-02",
  peak_day: "2026-10-02", duration_days: 1, dimension: "service", severity: "high", direction: "up",
  baseline: 1, cost: 10, total_delta: 9,
});

async function mount(path: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const requests: URL[] = [];
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    requests.push(url);
    const path = url.pathname.slice(5);
    let data: unknown;
    if (path === "auth/me") data = { authenticated: true, mode: "local", user: { name: "Fixture", admin: true, source: "file" } };
    else if (path === "subscriptions") data = { subscriptions: [{ id: first, name: "Production", azure_access: true }, { id: second, name: "Production", azure_access: true }], count: 2 };
    else if (path === "reporting-period") data = { available_months: ["2026-09"] };
    else if (path === "currency") data = { supported: ["USD", "EUR"], source: "Fixture" };
    else if (path === "dashboard/executive") {
      const trend = { labels: ["2026-10-02", "2026-10-03"], values: [17, 18], previous: [null, null], partial_last: true };
      data = url.searchParams.get("scope") === second
        ? { ...executive, currency: null, by_currency: [{ ...executive, trend }, { ...executive, currency: "INR", trend }] }
        : executive;
    } else if (path === "archive") data = { enabled: true, reachable: true, comparable: [], days: { focus: ["2026-10-03"] } };
    else if (path === "dashboard/advisor-score") return route.fulfill({ status: 503, json: { detail: "No Advisor fixture" } });
    else if (path === "dashboard/anomalies") {
      const currency = url.searchParams.get("currency");
      const daily = [{ day: "2026-10-02", cost: 10 }, { day: "2026-10-04", cost: 12 }];
      if (url.searchParams.get("scope") === second) {
        return route.fulfill({ json: {
          incidents: [], unavailable: true, partial: true, daily: [],
          reported_daily_by_currency: { USD: daily },
        } });
      }
      const incidents = (currency ? [currency] : ["USD", "INR"]).map(anomaly);
      data = { incidents, currency: currency || null, mixed_currency: !currency, daily: [],
        daily_by_currency: Object.fromEntries(incidents.map(i => [i.currency, daily])),
        incident_count: incidents.length, count: incidents.length, high: incidents.length, increases: incidents.length, decreases: 0, impact: currency ? 9 : null, days: 30 };
    } else if (path === "dashboard/governance") data = {
      tagging: {}, orphaned_resource_groups: {},
      accelerated_networking: { catalogue: true, eligible_count: 1, unverified: 2, eligible: [{
        vmName: "vm-ready", vmId: vm("vm-ready", 0).id, nicName: "nic-ready",
        nicId: `/subscriptions/${first}/resourceGroups/rg/providers/Microsoft.Network/networkInterfaces/nic-ready`,
        vmSize: "Standard_D4s_v5", powerState: "VM running", resourceGroup: "rg", location: "eastus",
      }] },
    };
    else if (path === "dashboard/savings/progress") data = { opportunities: [], count: 0 };
    else if (path === "dashboard/rightsizing") data = { vms: [vm("Small", 900), vm("Big", 1000)], count: 2, currency: "USD" };
    else if (path === "dashboard/waste") data = { findings: [{ category: "idle", count: 2, items: [vm("Small", 900), vm("Big", 1000)] }], total_items: 2, currency: "USD" };
    else return route.fulfill({ status: 404, json: { detail: `Unexpected fixture endpoint: ${path}` } });
    await route.fulfill({ json: data });
  });
  await page.goto(`${base}/v2${path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  const heading = path.startsWith("/explore/history") ? "History" : path.startsWith("/explore") ? "Anomalies" : path.startsWith("/optimize") ? "Savings" : path.startsWith("/govern") ? "Governance" : "Overview";
  await page.locator("#main").getByRole("heading", { name: heading, exact: true }).waitFor();
  return { page, requests, errors };
}

beforeAll(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-native-regressions",
    server: { host: "127.0.0.1", port: 0, hmr: false },
    plugins: [{
      name: "frontend-regression-fixture",
      resolveId: id => id.endsWith("/__regressions.js") ? "\0regressions" : undefined,
      load: id => id === "\0regressions" ? fixture : undefined,
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const path = "url" in req && typeof req.url === "string" ? req.url.split("?")[0] : "";
          if (!["/v2/", "/v2/explore/anomalies", "/v2/explore/history", "/v2/optimize/savings", "/v2/optimize/performance", "/v2/govern/governance", "/v2/govern/esu"].includes(path ?? "")) return next();
          const html = await vite.transformIndexHtml("/v2/__regressions", '<html><body><div id="root"></div><script type="module" src="/v2/__regressions.js"></script></body></html>');
          res.setHeader("Content-Type", "text/html");
          res.end(html);
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  base = `http://127.0.0.1:${address.port}`;
  browser = await launchNativeBrowser(server, [
    "/src/routes/Overview.tsx", "/src/routes/Anomalies.tsx", "/src/routes/History.tsx", "/src/routes/Savings.tsx", "/src/routes/Governance.tsx",
  ]);
  const warm = await mount("/");
  await warm.page.close();
}, 60_000);
nativeTestCleanup(() => browser, () => server, 120_000);

describe("frontend assessment regressions", () => {
  it("removes redundant navigation and routes old Performance bookmarks to Savings", async () => {
    const { page } = await mount(`/optimize/performance?scope=${first}`);
    expect(new URL(page.url()).pathname).toBe("/v2/optimize/savings");
    expect(new URL(page.url()).searchParams.get("scope")).toBe(first);
    expect(await page.getByRole("link", { name: "Performance vs Spend" }).count()).toBe(0);
    expect(await page.getByRole("radio", { name: "Scheduling" }).count()).toBe(0);
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("classic interface");
    expect(await page.getByRole("option", { name: "Open classic interface" }).count()).toBe(0);
  }, 30_000);

  it("lists verified NIC candidates with Azure links and discloses unverified inventory", async () => {
    const { page, requests } = await mount(`/govern/esu?scope=${first}`);
    expect(new URL(page.url()).pathname).toBe("/v2/govern/governance");
    expect(new URL(page.url()).searchParams.get("scope")).toBe(first);
    expect(await page.getByRole("link", { name: "End of support", exact: true }).count()).toBe(0);
    const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Accelerated Networking candidates" }) });
    const nic = card.getByRole("link", { name: "nic-ready" });
    await nic.waitFor();
    expect(await nic.getAttribute("href")).toContain("/networkInterfaces/nic-ready/overview");
    await card.getByRole("link", { name: "vm-ready" }).waitFor();
    await card.getByText("2 interfaces could not be verified and are excluded.").waitFor();
    expect(requests.some(url => url.pathname.endsWith("/dashboard/esu"))).toBe(false);
  }, 30_000);

  it("draws separate anomaly trends for mixed currencies and shows reported data without verified coverage", async () => {
    const mixed = await mount("/explore/anomalies");
    await mixed.page.getByRole("heading", { name: "Verified daily cost" }).waitFor();
    await expect.poll(() => mixed.page.locator("#main canvas").count()).toBe(2);
    expect(mixed.errors).toEqual([]);
    await mixed.page.close();

    const partial = await mount(`/explore/anomalies?scope=${second}`);
    await partial.page.getByRole("heading", { name: "Reported daily cost" }).waitFor();
    await partial.page.locator("#main canvas").waitFor();
    await partial.page.getByText("Not enough verified history to assess this window.").waitFor();
    expect(partial.errors).toEqual([]);
    await partial.page.close();
  }, 30_000);

  it("shows scoped daily spend by currency when there are not enough archive snapshots", async () => {
    const { page, requests, errors } = await mount(`/explore/history?scope=${second}&days=7`);
    await page.getByRole("heading", { name: "Daily spend history" }).waitFor();
    await page.getByRole("heading", { name: "More history needed" }).waitFor();
    await expect.poll(() => page.locator("#main canvas").count()).toBe(2);
    expect(requests.some(url => url.pathname.endsWith("/executive") && url.searchParams.get("scope") === second && url.searchParams.get("days") === "7")).toBe(true);
    expect(requests.some(url => url.pathname.endsWith("/archive/compare"))).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  it.each(["days=7", "month=2026-09&days=90", "from=2026-10-01&to=2026-10-03"])("palette Last 30 days clears %s without dropping scope/currency", async period => {
      const { page } = await mount(`/?${period}&currency=EUR&scope=${first}`);
      await page.keyboard.press("Control+k");
      await page.getByRole("combobox").fill("month last 30 days rolling");
      await page.getByRole("option", { name: "Last 30 days", exact: true }).click();
      await page.waitForURL(url => !["month", "days", "from", "to"].some(key => url.searchParams.has(key)));
      const url = new URL(page.url());
      expect(url.searchParams.get("scope")).toBe(first);
      expect(url.searchParams.get("currency")).toBe("EUR");
      await page.close();
  }, 30_000);

  it("keeps anomaly currency recovery after filtering and resets it when the period changes", async () => {
    const { page, requests, errors } = await mount("/explore/anomalies");
    await page.getByRole("radio", { name: "USD", exact: true }).click();
    await page.getByRole("table").getByText("INR spike", { exact: true }).waitFor({ state: "detached" });
    await page.getByRole("radio", { name: "All", exact: true }).click();
    await page.getByRole("table").getByText("INR spike", { exact: true }).waitFor();
    await page.getByRole("radio", { name: "USD", exact: true }).click();
    await page.getByRole("table").getByText("INR spike", { exact: true }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Reporting period" }).click();
    await page.getByRole("menuitem", { name: "Last 7 days", exact: true }).click();
    await page.getByRole("table").getByText("INR spike", { exact: true }).waitFor();
    expect(requests.some(url => url.pathname.endsWith("/anomalies") && url.searchParams.get("days") === "7" && !url.searchParams.has("currency"))).toBe(true);
    await page.getByRole("radio", { name: "USD", exact: true }).click();
    await page.getByRole("table").getByText("INR spike", { exact: true }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Subscription scope" }).click();
    await page.getByRole("option", { name: "Production" }).first().click();
    await page.keyboard.press("Escape");
    await page.getByRole("table").getByText("INR spike", { exact: true }).waitFor();
    expect(requests.some(url => url.pathname.endsWith("/anomalies") && url.searchParams.get("scope") === first && !url.searchParams.has("currency"))).toBe(true);
    expect(errors).toEqual([]);
  }, 30_000);

  it("sorts Rightsizing and waste by numeric billed cost instead of formatted money", async () => {
    const { page, errors } = await mount("/optimize/savings");
    for (const view of ["Rightsizing", "Idle & orphaned"]) {
      await page.getByRole("radio", { name: view, exact: true }).click();
      const table = page.getByRole("table");
      const rows = table.getByRole("rowgroup").last().getByRole("row");
      await rows.first().waitFor();
      const sort = table.getByRole("button", { name: "Billed cost", exact: true });
      await sort.click();
      expect(await rows.first().innerText()).toContain("Big");
      await sort.click();
      expect(await rows.first().innerText()).toContain("Small");
    }
    expect(errors).toEqual([]);
  }, 30_000);
});
