import { beforeAll, describe, expect, it } from "vitest";
import { launchNativeBrowser, nativeTestCleanup } from "./tests/native-test-cleanup";
import type { Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { ADVISOR_PILLARS } from "./advisor-score";

const first = "11111111-1111-1111-1111-111111111111";
const second = "22222222-2222-2222-2222-222222222222";
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
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")).render(React.createElement(LazyMotion, { features: domAnimation }, React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router: makeRouter(client) }))));
`;
const report = (scope: string | null) => ({
  pillars: ADVISOR_PILLARS.map(p => ({ ...p, score: scope === second ? null : 87.6, available_subscriptions: scope === second ? 0 : 1, total_subscriptions: 1 })),
  subscriptions: [{ subscription_id: scope || first, status: scope === second ? "error" : "ok", error: scope === second ? "Advisor permission denied" : null,
    pillars: ADVISOR_PILLARS.map(p => ({ ...p, score: scope === second ? null : 87.6, date: "2026-11-10T12:30:00Z", impacted_resources: 2, potential_increase: null })) }],
  partial: scope === second, errors: scope === second ? [{ subscription_id: second, message: "Advisor permission denied" }] : [],
  aggregation: "unweighted_mean", note: "Latest evidence",
});
const executive = {
  currency: "USD", days: 30, as_of: "2026-11-10", empty: true, mixed_currency: false,
  kpis: { total: null, previous: null, change_pct: null, daily_avg: null, resources: null, services: null, subscriptions: null, regions: null, top5_share_pct: null },
  trend: { labels: [], values: [], previous: [], partial_last: false },
  areas: [], movers: [], subscriptions: [], resource_groups: [], regions: [], services: [], monthly: null,
};

async function mount(route: string, costError = true, scoreError = false) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10_000);
  const requests: URL[] = [], errors: string[] = [];
  let failScore = scoreError;
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/**", async intercepted => {
    const url = new URL(intercepted.request().url()), path = url.pathname.slice(5);
    requests.push(url);
    if (path === "dashboard/executive" && costError) return intercepted.fulfill({ status: 503, json: { detail: "Cost source unavailable" } });
    if (path === "dashboard/advisor-score" && failScore) return intercepted.fulfill({ status: 503, json: { detail: "Advisor source unavailable" } });
    let data: unknown = {};
    if (path === "dashboard/advisor-score") data = report(url.searchParams.get("scope"));
    else if (path === "dashboard/executive") data = executive;
    else if (path === "auth/me") data = { authenticated: true, mode: "local", user: { name: "Fixture", admin: true, source: "file" } };
    else if (path === "subscriptions") data = { subscriptions: [{ id: first, name: "First", azure_access: true }, { id: second, name: "Second", azure_access: true }], count: 2 };
    else if (path === "reporting-period") data = { available_months: ["2026-09"], empty: false };
    else if (path === "currency") data = { supported: ["USD", "EUR"], source: "Fixture", as_of: null, note: null };
    await intercepted.fulfill({ json: data });
  });
  await page.goto(base + "/v2" + route, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return { page, requests, errors, recover: () => { failScore = false; } };
}
beforeAll(async () => {
  server = await createServer({
    cacheDir: "node_modules/.vite-native-advisor-score",
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    plugins: [{
      name: "isolated-advisor-score-tests",
      resolveId(id) { return id.endsWith("/__advisor-score-test.js") ? "\0advisor-score-test" : undefined; },
      load(id) { return id === "\0advisor-score-test" ? fixture : undefined; },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const path = "url" in req && typeof req.url === "string" ? req.url.split("?")[0] : "";
          if (!path || !["/v2/", "/v2/optimize/advisor-score"].includes(path)) { next(); return; }
          const html = await vite.transformIndexHtml("/v2/__advisor-score-test", '<html><body><div id="root"></div><script type="module" src="/v2/__advisor-score-test.js"></script></body></html>');
          res.setHeader("Content-Type", "text/html"); res.end(html);
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  base = `http://127.0.0.1:${address.port}`;
  browser = await launchNativeBrowser();
}, 60_000);
nativeTestCleanup(() => browser, () => server, 120_000);

describe("native Advisor Score navigation and independent landing strip", () => {
  it("keeps live scores visible when cost fails, preserves global search, and re-queries changed scope", async () => {
    const { page, requests, errors } = await mount(`/?scope=${first}&month=2026-09&currency=EUR`);
    try {
      const strip = page.getByRole("region", { name: "Advisor Score", exact: true });
      await strip.getByText("87.6%", { exact: true }).first().waitFor();
      await page.getByText("Cost source unavailable", { exact: true }).waitFor();
      await strip.getByRole("link", { name: "View subscription scores" }).click();
      await page.getByRole("table").waitFor();
      const url = new URL(page.url());
      expect(url.pathname).toBe("/v2/optimize/advisor-score");
      expect(url.searchParams.get("scope")).toBe(first);
      expect(url.searchParams.get("month")).toBe("2026-09");
      expect(url.searchParams.get("currency")).toBe("EUR");
      expect(await page.getByRole("table").innerText()).toContain("2026-11-10 12:30:00 UTC");
      await page.getByRole("button", { name: "Subscription scope", exact: true }).click();
      await page.getByRole("option", { name: "All subscriptions", exact: true }).click();
      await page.getByRole("option").filter({ hasText: "Second" }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("table").getByText("Advisor permission denied", { exact: true }).waitFor();
      expect(await page.getByRole("table").innerText()).not.toContain("87.6%");
      expect(requests.some(r => r.pathname === "/api/dashboard/advisor-score" && r.searchParams.get("scope") === second)).toBe(true);
      for (const request of requests.filter(r => r.pathname === "/api/dashboard/advisor-score")) {
        expect([...request.searchParams.keys()].every(key => key === "scope")).toBe(true);
      }
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
  it("shows all five scores with empty cost data and uses the native Optimize navigation entry", async () => {
    const { page, errors } = await mount(`/?scope=${first}`, false);
    try {
      const strip = page.getByRole("region", { name: "Advisor Score", exact: true });
      await strip.getByText("87.6%", { exact: true }).first().waitFor();
      expect(await strip.getByText("87.6%", { exact: true }).count()).toBe(5);
      const spend = await page.getByRole("region", { name: "Spend summary" }).boundingBox();
      const scores = await strip.boundingBox();
      expect(spend!.y + spend!.height).toBeLessThan(scores!.y);
      expect(scores!.height).toBeLessThan(85);
      await page.getByRole("navigation", { name: "Workspaces" }).getByRole("link", { name: "Advisor Score", exact: true }).click();
      await page.getByRole("table").waitFor();
      expect(new URL(page.url()).searchParams.get("scope")).toBe(first);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
  it("shows Advisor errors and retries without inventing scores", async () => {
    const { page, recover, errors } = await mount(`/optimize/advisor-score?scope=${first}`, true, true);
    try {
      await page.getByText("Advisor source unavailable", { exact: true }).waitFor();
      expect(await page.getByRole("table").count()).toBe(0);
      recover();
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await page.getByRole("table").waitFor();
      expect(await page.getByRole("table").innerText()).toContain("87.6%");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
});
