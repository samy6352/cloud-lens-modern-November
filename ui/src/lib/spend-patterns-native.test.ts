import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const first = "11111111-1111-1111-1111-111111111111";
let server: ViteDevServer;
let browser: Browser;
let base = "";

const fixture = `
import React from "react";
import "/src/styles.css";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { makeRouter } from "/src/router.tsx";
import { LazyMotion, domAnimation } from "motion/react";
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
createRoot(document.getElementById("root")).render(React.createElement(LazyMotion, { features: domAnimation }, React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router: makeRouter(client) }))));
`;

const executive = {
  currency: "USD", days: 7, as_of: "2026-10-03", empty: false,
  kpis: { total: 130, previous: 90, change_pct: 44.4, daily_avg: 43, resources: 3, services: 2, subscriptions: 1, regions: 1, top5_share_pct: 100 },
  trend: { labels: ["2026-10-01", "2026-10-02", "2026-10-03"], values: [40, 60, 30], previous: [30, 30, 30], partial_last: false },
  areas: [], movers: [], subscriptions: [], resource_groups: [], regions: [],
  services: [
    { name: "Virtual Machines", cost: 100, previous: 51, delta: 49, change_pct: 96.1, share_pct: 77 },
    { name: "Storage", cost: 20, previous: 41, delta: -21, change_pct: -51.2, share_pct: 15 },
    { name: "Networking", cost: 10, previous: 0, delta: 10, change_pct: null, share_pct: 8 },
  ],
  monthly: { months: ["2026-08", "2026-09"], currency: "USD", areas: [{ id: "compute", label: "Compute", data: [100, 120] }] },
};

const dayFor = (day: string, dimension: string) => ({
  day, prior_day: "2026-10-01", dimension, mixed_currency: false,
  totals: [{ currency: "USD", cost: 60, prior: 40 }],
  contributors: dimension === "subscription"
    ? [{ name: "Production", currency: "USD", cost: 60, prior: 40, delta: 20, change_pct: 50, share_pct: 100 }]
    : [
      { name: "Virtual Machines", currency: "USD", cost: 45, prior: 20, delta: 25, change_pct: 125, share_pct: 75 },
      { name: "Storage", currency: "USD", cost: 15, prior: 20, delta: -5, change_pct: -25, share_pct: 25 },
    ],
  other: [],
});

async function mount(width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  const dayRequests: URL[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(5);
    if (path === "dashboard/day") {
      dayRequests.push(url);
      return route.fulfill({ json: dayFor(url.searchParams.get("day") ?? "", url.searchParams.get("dimension") ?? "service") });
    }
    let data: unknown = {};
    if (path === "dashboard/executive") data = executive;
    else if (path === "auth/me") data = { authenticated: true, mode: "local", user: { name: "Fixture", admin: true, source: "file" } };
    else if (path === "subscriptions") data = { subscriptions: [{ id: first, name: "First", azure_access: true }], count: 1 };
    else if (path === "reporting-period") data = { available_months: ["2026-09"] };
    else if (path === "currency") data = { supported: ["USD"], source: "Fixture", as_of: null, note: null };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(base + "/v2/", { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.getByRole("heading", { name: "Overview", level: 1 }).waitFor({ timeout: 180000 });
  return { page, errors, dayRequests };
}

beforeAll(async () => {
  server = await createServer({
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    plugins: [{
      name: "isolated-spend-pattern-tests",
      resolveId(id) { return id.endsWith("/__spend-test.js") ? "\0spend-test" : undefined; },
      load(id) { return id === "\0spend-test" ? fixture : undefined; },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const path = "url" in req && typeof req.url === "string" ? req.url.split("?")[0] : "";
          if (path !== "/v2/") { next(); return; }
          const html = await vite.transformIndexHtml("/v2/__spend-test", '<html><head></head><body><div id="root"></div><script type="module" src="/v2/__spend-test.js"></script></body></html>');
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
  browser = await chromium.launch({ headless: true });
  const warm = await browser.newPage();
  await warm.goto(base + "/v2/", { waitUntil: "domcontentloaded", timeout: 180000 }).catch(() => {});
  await warm.close();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
}, 60_000);

describe("spend patterns on the Overview", () => {
  it("opens a day when its point on the daily chart is clicked", async () => {
    const { page, errors } = await mount();
    try {
      await page.locator("div[role=img][aria-label^='Daily spend in'] canvas").first().waitFor();
      const chart = page.locator("div[role=img][aria-label^='Daily spend in'] canvas").first();
      const box = await chart.boundingBox();
      if (!box) throw new Error("Daily spend chart has no size");
      await chart.click({ position: { x: box.width * 0.5, y: box.height * 0.45 }, force: true });
      await page.getByRole("heading", { name: /Top contributors on/ }).waitFor({ timeout: 8000 });
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("shows a day's top contributors, compared with the day before", async () => {
    const { page, errors, dayRequests } = await mount();
    try {
      await page.getByLabel("Inspect contributors on").selectOption("2026-10-02");
      await page.getByRole("heading", { name: /Top contributors on/ }).waitFor();
      await page.getByRole("cell", { name: "Virtual Machines" }).first().waitFor();
      const panel = page.getByRole("region", { name: /Top contributors on/ }).or(page.locator("section[aria-labelledby=day-contributors-title]"));
      const text = await panel.innerText();
      expect(text).toContain("Virtual Machines");
      expect(text).toContain("+125.0%");
      expect(text).toContain("-25.0%");
      expect(text).toContain("75.0%");
      expect(dayRequests.at(-1)?.searchParams.get("day")).toBe("2026-10-02");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("regroups the same day by subscription on request", async () => {
    const { page, dayRequests, errors } = await mount();
    try {
      await page.getByLabel("Inspect contributors on").selectOption("2026-10-02");
      await page.locator("section[aria-labelledby='day-contributors-title']").getByRole("radio", { name: "Subscription", exact: true }).click();
      await page.getByRole("cell", { name: "Production" }).waitFor();
      expect(dayRequests.at(-1)?.searchParams.get("dimension")).toBe("subscription");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("closes the day and returns to the chart", async () => {
    const { page, errors } = await mount();
    try {
      await page.getByLabel("Inspect contributors on").selectOption("2026-10-03");
      await page.getByRole("button", { name: "Close day details" }).click();
      await page.getByRole("heading", { name: /Top contributors on/ }).waitFor({ state: "detached" });
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("shows the service changes with their direction in words and sign", async () => {
    const { page, errors } = await mount();
    try {
      const bridge = page.getByRole("table", { name: /Change from the previous period/ });
      const text = await bridge.innerText();
      expect(text).toContain("Virtual Machines");
      expect(text).toMatch(/\+\$49/);
      expect(text).toMatch(/-\$21/);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("compares each month with the one before", async () => {
    const { page, errors } = await mount();
    try {
      const months = page.getByRole("table", { name: /Monthly spend and change/ });
      expect(await months.innerText()).toMatch(/\+20\.0%/);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);

  it("opens a day without overflowing a phone screen", async () => {
    const { page, errors } = await mount(390);
    try {
      await page.getByLabel("Inspect contributors on").selectOption("2026-10-02");
      await page.getByRole("heading", { name: /Top contributors on/ }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
});
