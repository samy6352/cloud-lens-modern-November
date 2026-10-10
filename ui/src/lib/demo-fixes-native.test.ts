import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { resourceCurrenciesQuery, resourcesQuery } from "./queries";

const first = "11111111-1111-1111-1111-111111111111";
const second = "22222222-2222-2222-2222-222222222222";
const note = "Budgets are not part of the PostgreSQL demo data. Live Azure budget reads and writes are disabled in demo mode.";
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

function resources(url: URL) {
  const available = url.searchParams.get("scope") === second ? ["EUR"] : url.searchParams.get("period_month") === "2026-08" ? [] : ["INR", "USD"];
  const picked = url.searchParams.get("billing_currency");
  const codes = available.filter(c => !picked || c === picked);
  const total = url.searchParams.get("q") || url.searchParams.get("change") ? 0 : codes.length * 101;
  const size = Number(url.searchParams.get("page_size") || 100), page = Number(url.searchParams.get("page") || 1);
  const rows = Array.from({ length: Math.max(0, Math.min(size, total - (page - 1) * size)) }, (_, i) => {
    const index = (page - 1) * size + i;
    return { id: `resource-${index}`, name: `Resource ${index}`, currency: codes[index % codes.length], cost: total - index, prior_cost: 1, delta: total - index - 1, change_pct: 1,
      service: "Compute", subscription_id: url.searchParams.get("scope") || first, subscription: "Fixture", resource_group: "Group", region: "Region", tag_count: 0, tags: [] };
  });
  return { days: 30, as_of: "2026-09-30", currency: codes.length === 1 ? codes[0] : null, mixed_currency: codes.length > 1, currencies: total ? codes : [], resources: rows,
    count: rows.length, page, page_size: size, pages: Math.ceil(total / size), total, resources_by_currency: Object.fromEntries(codes.map(c => [c, total ? 101 : 0])),
    total_cost_by_currency: Object.fromEntries(codes.map(c => [c, total ? 100 : 0])), prior_cost_by_currency: Object.fromEntries(codes.map(c => [c, total ? 50 : 0])),
    truncated: false, source: "ranked" };
}

async function mount(route: string, options: { demo?: boolean; note?: string; partial?: boolean; error?: boolean; width?: number } = {}) {
  const page = await browser.newPage({ viewport: { width: options.width || 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const requests: URL[] = [], errors: string[] = [], writes: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/**", async intercepted => {
    const request = intercepted.request(), url = new URL(request.url()), path = url.pathname.slice(5);
    requests.push(url);
    if (request.method() !== "GET") { writes.push(path); await intercepted.abort(); return; }
    let data: unknown;
    if (path === "auth/me") data = { authenticated: true, mode: "local", user: { name: "Fixture", admin: true, source: "file" } };
    else if (path === "subscriptions") data = { subscriptions: [{ id: first, name: "First", azure_access: true }, { id: second, name: "Second", azure_access: true }], count: 2 };
    else if (path === "reporting-period") data = { available_months: ["2026-09", "2026-08"] };
    else if (path === "currency") data = { supported: ["USD"], source: "Fixture", as_of: null, note: null };
    else if (path === "dashboard/resources") data = resources(url);
    else if (path === "budgets") {
      if (options.error) { await intercepted.fulfill({ status: 503, contentType: "application/json", body: '{"detail":"Fixture budget source unavailable"}' }); return; }
      data = { budgets: [], demo_mode: options.demo === true, note: options.note, partial: options.partial, subscriptions_requested: options.demo ? 0 : 1, subscriptions_read: options.partial || options.demo ? 0 : 1 };
    } else if (path === "dashboard/tags") data = { native_currencies: { [first]: ["USD"] }, keys: [], values: [], resources: [] };
    else if (path === "capabilities") data = { identity: { kind: "workload" }, capabilities: [{ feature: "budgets-write", subscription_id: first, status: "approval-required", authorization_status: "declared-allowed" }] };
    else { errors.push(`Unexpected API ${path}`); await intercepted.abort(); return; }
    await intercepted.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(base + "/v2" + route, { waitUntil: "domcontentloaded" });
  await page.locator("main").getByRole("heading").first().waitFor();
  return { page, requests, errors, writes };
}

beforeAll(async () => {
  server = await createServer({
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    plugins: [{
      name: "isolated-demo-fix-tests",
      resolveId(id) { return id.endsWith("/__demo-fix-test.js") ? "\0demo-fix-test" : undefined; },
      load(id) { return id === "\0demo-fix-test" ? fixture : undefined; },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const path = "url" in req && typeof req.url === "string" ? req.url.split("?")[0] : "";
          if (!path || !["/v2/explore/resources", "/v2/govern/budgets"].includes(path)) { next(); return; }
          const html = await vite.transformIndexHtml("/v2/__demo-fix-test", '<html><head></head><body><div id="root"></div><script type="module" src="/v2/__demo-fix-test.js"></script></body></html>');
          res.setHeader("Content-Type", "text/html"); res.end(html);
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

describe("resource currency facets", () => {
  it("uses a separate minimal unfiltered query with the exact period/scope cache partition", async () => {
    const scope = { month: "2026-09", scope: first };
    const facets = resourceCurrenciesQuery(scope);
    expect(facets.queryKey).toEqual(["resources", "2026-09", first, 30, "", 1, 1, "cost", true, "", "", ""]);
    expect(resourceCurrenciesQuery({ ...scope, days: 7 }).queryKey).not.toEqual(facets.queryKey);
    expect(resourceCurrenciesQuery({ ...scope, currency: "EUR" }).queryKey).not.toEqual(facets.queryKey);
    expect(facets.queryKey).not.toEqual(resourcesQuery(scope, { page: 2, pageSize: 100, sort: "delta", desc: false, q: "Group", currency: "USD", change: "increased" }).queryKey);
    expect(resourceCurrenciesQuery({ month: "2026-08", scope: second }).queryKey).not.toEqual(facets.queryKey);
    const { page, requests, errors } = await mount(`/explore/resources?scope=${first}&month=2026-09`);
    try {
      await page.getByRole("radiogroup", { name: "Billing currency" }).waitFor();
      expect(requests.some(u => u.pathname === "/api/dashboard/resources" && u.searchParams.get("page_size") === "1" && u.searchParams.get("scope") === first && u.searchParams.get("period_month") === "2026-09" && !u.searchParams.has("q") && !u.searchParams.has("billing_currency") && !u.searchParams.has("change"))).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
  it("keeps both currencies and All through paging, USD/INR switching, search-empty and reset without reload", async () => {
    const { page, errors, writes } = await mount("/explore/resources");
    try {
      const group = page.getByRole("radiogroup", { name: "Billing currency" });
      await group.getByRole("radio", { name: "USD", exact: true }).waitFor();
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await page.getByText("Page 2 of 3", { exact: true }).waitFor();
      await group.getByRole("radio", { name: "USD", exact: true }).click();
      await page.getByText("Page 1 of 2", { exact: true }).waitFor();
      expect(await group.getByRole("radio").allTextContents()).toEqual(["All", "INR", "USD"]);
      expect(await group.getByRole("radio", { name: "USD", exact: true }).getAttribute("aria-checked")).toBe("true");
      await page.getByRole("textbox", { name: "Search resources" }).fill("no-result");
      await page.getByText("No resources match these filters.", { exact: true }).waitFor();
      expect(await group.getByRole("radio").count()).toBe(3);
      await page.getByRole("textbox", { name: "Search resources" }).fill("");
      await page.getByText("Page 1 of 2", { exact: true }).waitFor();
      await group.getByRole("radio", { name: "INR", exact: true }).click();
      expect(await group.getByRole("radio", { name: "INR", exact: true }).getAttribute("aria-checked")).toBe("true");
      await group.getByRole("radio", { name: "All", exact: true }).click();
      await page.getByText("Page 1 of 3", { exact: true }).waitFor();
      expect(await group.getByRole("radio", { name: "All", exact: true }).getAttribute("aria-checked")).toBe("true");
      expect(errors).toEqual([]); expect(writes).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
  it("isolates scope changes, resets the old selection and never exposes previous-scope currency options", async () => {
    const { page, requests, errors } = await mount(`/explore/resources?scope=${first}`);
    try {
      const group = page.getByRole("radiogroup", { name: "Billing currency" });
      await group.getByRole("radio", { name: "USD", exact: true }).click();
      await page.getByRole("button", { name: "Subscription scope" }).click();
      await page.locator("[cmdk-item]").filter({ hasText: "All subscriptions" }).click();
      await page.locator("[cmdk-item]").filter({ hasText: "Second" }).click();
      await page.keyboard.press("Escape");
      await page.waitForURL(u => u.searchParams.get("scope") === second);
      await page.getByText("Page 1 of 2", { exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('[aria-label="Billing currency"]'));
      expect(requests.filter(u => u.pathname === "/api/dashboard/resources" && u.searchParams.get("page_size") === "1").map(u => u.searchParams.get("scope"))).toContain(second);
      expect(requests.some(u => u.searchParams.get("scope") === second && !u.searchParams.has("billing_currency"))).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
  it("handles a no-currency month and narrow-screen reset without carrying old facet data", async () => {
    const { page, errors } = await mount("/explore/resources", { width: 390 });
    try {
      const group = page.getByRole("radiogroup", { name: "Billing currency" });
      await group.getByRole("radio", { name: "USD", exact: true }).click();
      await group.getByRole("radio", { name: "All", exact: true }).click();
      await page.getByRole("button", { name: "Reporting period" }).click();
      await page.getByRole("menuitem", { name: "Aug 2026" }).click();
      await page.getByText("No resource-attributed cost in this period.", { exact: true }).waitFor();
      expect(await group.count()).toBe(0);
      expect(await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))).toEqual({ viewport: 390, document: 390 });
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
});

describe("native budget demo evidence", () => {
  it("renders the actual backend note on list, empty state and composer while keeping review disabled", async () => {
    const { page, errors, writes } = await mount(`/govern/budgets?scope=${first}`, { demo: true, note, width: 390 });
    try {
      await page.getByText("Not in demo", { exact: true }).waitFor();
      expect(await page.getByRole("status").filter({ hasText: note }).count()).toBe(1);
      expect(await page.getByRole("table").getByText(note, { exact: true }).isVisible()).toBe(true);
      await page.getByRole("button", { name: "Draft budget", exact: true }).click();
      await page.getByLabel("Budget name", { exact: true }).fill("never-send");
      await page.getByRole("button", { name: "Add tag", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('[role="status"]').length >= 2);
      expect(await page.getByRole("status").filter({ hasText: note }).count()).toBe(2);
      expect(await page.getByRole("button", { name: "Review exact Azure request" }).isDisabled()).toBe(true);
      expect(await page.getByRole("alertdialog").count()).toBe(0);
      const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
        offenders: [...document.querySelectorAll("main *")].filter(e => e.getBoundingClientRect().right > innerWidth + 2).slice(0, 8).map(e => ({ tag: e.tagName, class: e.className, right: e.getBoundingClientRect().right })) }));
      expect(layout.document, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport + 2);
      expect(errors).toEqual([]); expect(writes).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
  it("explains demo mode even when an older backend omits the note", async () => {
    const { page, errors } = await mount("/govern/budgets", { demo: true });
    try {
      await page.getByRole("status").filter({ hasText: "Demo mode: live Azure budget reads and writes are disabled." }).waitFor();
      expect(await page.getByText("No budgets match this scope and filters.", { exact: true }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
  it("preserves legitimate live empty budgets without a demo notice or disabled live review", async () => {
    const { page, errors } = await mount(`/govern/budgets?scope=${first}`, { note: "Live note, not demo" });
    try {
      await page.getByText("No budgets match this scope and filters.", { exact: true }).waitFor();
      expect(await page.getByText("Not in demo", { exact: true }).count()).toBe(0);
      await page.getByRole("button", { name: "Draft budget", exact: true }).click();
      await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Review exact Azure request")?.disabled);
      expect(await page.getByRole("button", { name: "Review exact Azure request" }).isEnabled()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
  it("retains unavailable/partial source messaging instead of substituting demo empty evidence", async () => {
    for (const options of [{ partial: true }, { error: true }]) {
      const { page, errors } = await mount("/govern/budgets", options);
      try {
        await page.getByText(options.error ? "Fixture budget source unavailable" : "Unavailable subscriptions may contain budgets. Retry the read.", { exact: false }).first().waitFor();
        expect(await page.getByText("Not in demo", { exact: true }).count()).toBe(0);
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }
  }, 30_000);
});

describe("financial workbench interactions", () => {
  it("supports roving radio focus, arrow keys and Home/End without changing global scope", async () => {
    const { page, errors, writes } = await mount(`/explore/resources?scope=${first}`);
    try {
      const group = page.getByRole("radiogroup", { name: "Billing currency" });
      const all = group.getByRole("radio", { name: "All", exact: true });
      await all.focus();
      await page.keyboard.press("ArrowRight");
      const inr = group.getByRole("radio", { name: "INR", exact: true });
      expect(await inr.getAttribute("aria-checked")).toBe("true");
      expect(await inr.evaluate(e => e === document.activeElement)).toBe(true);
      await page.keyboard.press("End");
      expect(await group.getByRole("radio", { name: "USD", exact: true }).getAttribute("aria-checked")).toBe("true");
      await page.keyboard.press("Home");
      expect(await all.getAttribute("aria-checked")).toBe("true");
      expect(await group.locator('[tabindex="0"]').count()).toBe(1);
      expect(new URL(page.url()).searchParams.get("scope")).toBe(first);
      expect(errors).toEqual([]); expect(writes).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it("offers labelled mobile navigation, escape dismissal and route selection without an icon rail", async () => {
    const { page, errors, writes } = await mount(`/explore/resources?scope=${first}`, { width: 390 });
    try {
      expect(await page.getByRole("navigation", { name: "Workspaces" }).isVisible()).toBe(false);
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "CloudLens navigation" });
      await drawer.waitFor();
      expect(await drawer.getByRole("link", { name: "All resources", exact: true }).getAttribute("aria-current")).toBe("page");
      await page.keyboard.press("Escape");
      expect(await drawer.count()).toBe(0);
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await drawer.getByRole("link", { name: "Budgets", exact: true }).click();
      await page.locator("main").getByRole("heading", { name: "Budgets", exact: true }).waitFor();
      expect(await drawer.count()).toBe(0);
      expect(new URL(page.url()).searchParams.get("scope")).toBe(first);
      expect(await page.locator("main h1").count()).toBe(1);
      expect(errors).toEqual([]); expect(writes).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it("clears local filters only and keeps the scrollable ledger labelled and correctly indexed", async () => {
    const { page, errors, writes } = await mount(`/explore/resources?scope=${first}`);
    try {
      const table = page.getByRole("table", { name: "Billed resource ledger", exact: true });
      await table.getByRole("row").filter({ hasText: "Resource 0" }).first().waitFor();
      expect(await table.getAttribute("tabindex")).toBe("0");
      expect(await table.getAttribute("aria-colcount")).toBe("7");
      expect(await table.locator('[role="row"][data-index="0"]').getAttribute("aria-rowindex")).toBe("2");
      await page.getByRole("textbox", { name: "Search resources" }).fill("no-match");
      await page.getByText("No resources match these filters.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Clear filters", exact: true }).click();
      await table.getByRole("row").filter({ hasText: "Resource 0" }).first().waitFor();
      expect(await page.getByRole("textbox", { name: "Search resources" }).inputValue()).toBe("");
      expect(new URL(page.url()).searchParams.get("scope")).toBe(first);
      expect(errors).toEqual([]); expect(writes).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it("fits the mobile workbench in light and dark modes at 320 and 390 pixels", async () => {
    const { page, errors } = await mount("/explore/resources", { width: 320 });
    try {
      await page.getByText("Page 1 of 3", { exact: true }).waitFor();
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const dark of [false, true]) {
          await page.evaluate(value => document.documentElement.classList.toggle("dark", value), dark);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        }
      }
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
});
