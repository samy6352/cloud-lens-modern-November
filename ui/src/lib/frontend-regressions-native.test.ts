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
    } else if (path === "dashboard/day") {
      const day = url.searchParams.get("day");
      const name = url.searchParams.get("dimension") === "resource_group" ? `rg-${day}`
        : day === "2026-08-03" ? "Storage workload" : "Compute workload";
      data = {
        day, contributors: [{ name, currency: "USD", cost: 9, prior: 0, share_pct: 100 }],
        mixed_currency: false, other: [], totals: [{ currency: "USD", cost: 9, prior: 0 }],
      };
    }
    else if (path === "dashboard/compare-days") data = {
      first_day: url.searchParams.get("first"), second_day: url.searchParams.get("second"),
      totals: [{ currency: "USD", first: 10, second: 15, delta: 5, change_pct: 50 },
        { currency: "EUR", first: null, second: 20, delta: null, change_pct: null }]
        .map(row => url.searchParams.get("second") === "2026-08-20"
          ? { ...row, second: null, delta: null, change_pct: null } : row),
    };
    else if (path === "archive") data = { enabled: true, reachable: true, comparable: [], days: { focus: ["2026-10-03"] } };
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
nativeTestCleanup(() => browser, () => server);

describe("frontend assessment regressions", () => {
  it("keeps all sidebar destinations reachable without scrolling the rail", async () => {
    const { page } = await mount(`/?days=7&scope=${second}&currency=USD`);
    const aside = page.locator("aside").filter({ has: page.getByRole("link", { name: "CloudLens home" }) });
    const nav = aside.getByRole("navigation", { name: "Workspaces" });
    const expectFits = async () => {
      expect(await aside.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
      expect(await nav.evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual((await aside.boundingBox())!.height);
    };

    await page.setViewportSize({ width: 1280, height: 784 });
    await nav.getByRole("link", { name: "Audit log" }).waitFor();
    expect(await nav.getByText("Reports", { exact: true }).isVisible()).toBe(true);
    const categoryGaps = await nav.evaluate(el => Array.from(el.children).slice(1).map(group =>
      group.getBoundingClientRect().top - group.previousElementSibling!.getBoundingClientRect().bottom));
    expect(categoryGaps).toHaveLength(5);
    expect(Math.min(...categoryGaps)).toBeGreaterThanOrEqual(8);
    expect(await nav.getByRole("link", { name: "Audit log" }).evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThan(784);
    await expectFits();

    await page.setViewportSize({ width: 1280, height: 720 });
    const workspace = nav.getByRole("combobox", { name: "Choose workspace" });
    const destination = nav.getByRole("combobox", { name: "Choose page" });
    await workspace.selectOption("admin");
    expect(await destination.locator("option").allTextContents()).toContain("Audit log");
    await expectFits();
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expectFits();

    await page.setViewportSize({ width: 390, height: 360 });
    await workspace.selectOption("explore");
    await destination.selectOption("history");
    await expectFits();
    await nav.getByRole("button", { name: "Go to History" }).click();
    await page.locator("#main").getByRole("heading", { name: "History", exact: true }).waitFor();
    const url = new URL(page.url());
    expect(url.searchParams.get("days")).toBe("7");
    expect(url.searchParams.get("scope")).toBe(second);
    expect(url.searchParams.get("currency")).toBe("USD");
    await page.close();
  }, 30_000);

  it("returns to Overview from the sidebar logo without dropping filters", async () => {
    const { page } = await mount(`/explore/history?days=7&scope=${second}&currency=USD`);
    const home = page.getByRole("link", { name: "CloudLens home", exact: true });
    await home.locator("img").click();
    await page.locator("#main").getByRole("heading", { name: "Overview", exact: true }).waitFor();
    const url = new URL(page.url());
    expect(url.pathname).toBe("/v2/");
    expect(url.searchParams.get("days")).toBe("7");
    expect(url.searchParams.get("scope")).toBe(second);
    expect(url.searchParams.get("currency")).toBe("USD");

    await page.goBack();
    await page.locator("#main").getByRole("heading", { name: "History", exact: true }).waitFor();
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await home.focus();
    await page.keyboard.press("Enter");
    await page.locator("#main").getByRole("heading", { name: "Overview", exact: true }).waitFor();
  }, 30_000);

  it("opens top contributors from a chart date or the full calendar list", async () => {
    const { page, requests } = await mount(`/explore/anomalies?scope=${first}`);
    const dates = page.getByLabel("Contributor date");
    await dates.waitFor();
    expect(await dates.locator("option").evaluateAll(options => options.map(o => o.getAttribute("value"))))
      .toEqual(["", "2026-10-02", "2026-10-03", "2026-10-04"]);
    const canvas = page.locator("#main canvas").last();
    await canvas.waitFor();
    const box = await canvas.boundingBox();
    await canvas.click({ position: { x: box!.width / 2, y: 80 } });
    await expect.poll(() => dates.inputValue()).toBe("2026-10-03");
    await page.getByText("Compute workload", { exact: true }).waitFor();
    await dates.selectOption("2026-10-04");
    await expect.poll(() => requests.some(url => url.pathname.endsWith("/day") &&
      url.searchParams.get("day") === "2026-10-04" && url.searchParams.get("scope") === first &&
      url.searchParams.get("current_only") === "true")).toBe(true);
  }, 30_000);

  it("compares two nonadjacent billing dates even without archive snapshots", async () => {
    const { page, requests } = await mount(`/explore/history?scope=${second}&month=2026-09`);
    await page.getByLabel("First billing date").fill("2026-08-03");
    await page.getByLabel("Second billing date").fill("2026-08-19");
    await page.getByText("(+50%)", { exact: true }).waitFor();
    await page.getByText("Not comparable", { exact: true }).waitFor();
    const usdChart = page.getByRole("img", { name: /^USD billed cost:/ });
    const eurChart = page.getByRole("img", { name: /^EUR billed cost:.*No data/ });
    await usdChart.locator("canvas").waitFor();
    await eurChart.locator("canvas").waitFor();
    expect(await usdChart.getAttribute("aria-label")).toMatch(/\$10(?:\.00)?;.*\$15/);
    expect(requests.some(url => url.pathname.endsWith("/compare-days") && url.searchParams.get("scope") === second &&
      url.searchParams.get("first") === "2026-08-03" && url.searchParams.get("second") === "2026-08-19")).toBe(true);
    const contributors = page.getByRole("region", { name: "Top cost contributors for both dates" });
    const early = contributors.getByRole("region", { name: /Top contributors on .*Aug.*3|Top contributors on .*3.*Aug/ });
    const late = contributors.getByRole("region", { name: /Top contributors on .*19/ });
    await early.getByText("Storage workload", { exact: true }).waitFor();
    await late.getByText("Compute workload", { exact: true }).waitFor();
    await contributors.getByRole("radio", { name: "Resource group", exact: true }).click();
    await early.getByText("rg-2026-08-03", { exact: true }).waitFor();
    await late.getByText("rg-2026-08-19", { exact: true }).waitFor();
    for (const day of ["2026-08-03", "2026-08-19"]) {
      expect(requests.some(url => url.pathname.endsWith("/dashboard/day") &&
        url.searchParams.get("day") === day && url.searchParams.get("scope") === second &&
        url.searchParams.get("current_only") === "true" && url.searchParams.get("dimension") === "resource_group" &&
        !url.searchParams.has("period_month"))).toBe(true);
    }
    await page.getByLabel("Second billing date").fill("2026-08-20");
    await contributors.getByText("No billing data for this date in the selected scope.").waitFor();
    expect(await late.count()).toBe(0);
    expect(requests.some(url => url.pathname.endsWith("/dashboard/day") && url.searchParams.get("day") === "2026-08-20")).toBe(false);
    await page.getByLabel("Second billing date").fill("2026-08-03");
    await page.getByText("Choose two different dates.", { exact: true }).waitFor();
    expect(await usdChart.count()).toBe(0);
    await page.close();
  }, 30_000);

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
