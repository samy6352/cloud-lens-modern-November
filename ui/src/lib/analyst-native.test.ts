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

const findings = [
  { kind: "waste", title: "Idle disks", detail: "Two disks are unattached.", impact: 120, currency: "USD", impact_period: "month", severity: "critical", confidence: "high", evidence: [{ name: "disk-1", cost: 80 }, { name: "disk-2", cost: 40 }], action: "Delete unused disks", tab: null, caveat: null, because: "Not attached to any VM for 30 days.", risk: "Data loss if a disk is still needed.", effort: "low", steps: ["Snapshot the disk", "Delete it"] },
  { kind: "rightsizing", title: "Oversized VM", detail: "Runs at 8% CPU.", impact: 45, currency: "USD", impact_period: "month", severity: "medium", confidence: "medium", evidence: [], action: null, tab: null, caveat: null, because: null, risk: null, effort: null, steps: [] },
  { kind: "anomaly", title: "Storage spike", detail: "Unusual rise on 9 Oct.", impact: null, currency: "USD", impact_period: null, severity: "low", confidence: "low", evidence: [], action: null, tab: null, caveat: null, because: null, risk: null, effort: null, steps: [] },
];

const answer = [
  'event: tool\ndata: {"id":"t1","name":"query_costs","status":"running"}\n\n',
  'event: delta\ndata: {"text":"Spend rose "}\n\n',
  'event: delta\ndata: {"text":"12% this period."}\n\n',
  'event: tool\ndata: {"id":"t1","name":"query_costs","status":"done"}\n\n',
  'event: done\ndata: {"messages":[{"role":"user","content":"What changed?"},{"role":"assistant","content":"Spend rose 12% this period."}]}\n\n',
].join("");

async function mount(width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  const insights: number[] = [];
  const asks: Array<Record<string, unknown>> = [];
  page.on("pageerror", e => errors.push(e.message));
  let askStatus = 200;
  let askDetail = "";
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(5);
    if (path === "insights") {
      insights.push(Date.now());
      return route.fulfill({ json: { findings, currency: "USD", days: 30 } });
    }
    if (path === "ask") {
      asks.push(JSON.parse(request.postData() || "{}"));
      if (askStatus !== 200) return route.fulfill({ status: askStatus, json: { detail: askDetail } });
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: answer });
    }
    let data: unknown = {};
    if (path === "auth/me") data = { authenticated: true, mode: "local", user: { name: "Fixture", admin: true, source: "file" } };
    else if (path === "subscriptions") data = { subscriptions: [{ id: first, name: "First", azure_access: true }], count: 1 };
    else if (path === "reporting-period") data = { available_months: ["2026-09"] };
    else if (path === "currency") data = { supported: ["USD"], source: "Fixture", as_of: null, note: null };
    else if (path === "budgets") data = { budgets: [], demo_mode: false, subscriptions_requested: 1, subscriptions_read: 1 };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto(base + "/v2/govern/budgets", { waitUntil: "domcontentloaded", timeout: 180000 });
  await page.getByRole("button", { name: /^Analyst/ }).waitFor({ timeout: 180000 });
  return {
    page, errors, insights, asks,
    setAskFailure(status: number, detail: string) { askStatus = status; askDetail = detail; },
  };
}

beforeAll(async () => {
  server = await createServer({
    server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
    plugins: [{
      name: "isolated-analyst-tests",
      resolveId(id) { return id.endsWith("/__analyst-test.js") ? "\0analyst-test" : undefined; },
      load(id) { return id === "\0analyst-test" ? fixture : undefined; },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const path = "url" in req && typeof req.url === "string" ? req.url.split("?")[0] : "";
          if (path !== "/v2/govern/budgets") { next(); return; }
          const html = await vite.transformIndexHtml("/v2/__analyst-test", '<html><head></head><body><div id="root"></div><script type="module" src="/v2/__analyst-test.js"></script></body></html>');
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
  // Warm the dev server once so the first real test is not paying for the initial compile.
  const warm = await browser.newPage();
  await warm.goto(base + "/v2/govern/budgets", { waitUntil: "domcontentloaded", timeout: 180000 }).catch(() => {});
  await warm.close();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe("analyst panel", () => {
  it("does not run the analysis on page load", async () => {
    const { page, insights, errors } = await mount();
    try {
      await page.waitForTimeout(800);
      expect(insights.length).toBe(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it("runs the analysis when opened and lists findings most urgent first", async () => {
    const { page, insights, errors } = await mount();
    try {
      await page.getByRole("button", { name: /^Analyst/ }).click();
      const rows = page.getByRole("table").first().locator("tbody tr");
      await rows.first().waitFor();
      expect(insights.length).toBe(1);
      expect(await rows.count()).toBe(3);
      expect(await rows.first().innerText()).toContain("Idle disks");
      expect(await rows.first().innerText()).toContain("Act now");
      expect(await rows.nth(2).innerText()).toContain("Not estimated");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it("shows reasoning, evidence and a way to ask about a finding", async () => {
    const { page, errors } = await mount();
    try {
      await page.getByRole("button", { name: /^Analyst/ }).click();
      const toggle = page.getByRole("table").getByRole("button", { name: /Idle disks/ });
      await toggle.click();
      await page.getByText("Not attached to any VM for 30 days.").waitFor();
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      await page.getByRole("button", { name: "Ask about this" }).click();
      expect(await page.getByLabel("Ask a question about this period").inputValue()).toContain("Idle disks");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it("streams an answer, then sends the conversation so far with the next question", async () => {
    const { page, asks, errors } = await mount();
    try {
      await page.getByRole("button", { name: /^Analyst/ }).click();
      await page.getByRole("button", { name: "What changed in spend this period, and why?" }).click();
      await page.getByText("Spend rose 12% this period.").waitFor();
      await page.getByText("Checked costs: done").waitFor();
      await page.getByLabel("Ask a question about this period").fill("And for storage?");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelectorAll("[role=alert]").length === 0);
      await page.waitForTimeout(400);
      expect(asks.length).toBe(2);
      expect(Array.isArray(asks[1]?.history) && (asks[1]?.history as unknown[]).length).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it("explains a refused question in plain words", async () => {
    const { page, setAskFailure, errors } = await mount();
    try {
      setAskFailure(403, "No Azure subscriptions are visible to your account.");
      await page.getByRole("button", { name: /^Analyst/ }).click();
      await page.getByRole("button", { name: "What changed in spend this period, and why?" }).click();
      await page.getByRole("alert").getByText("No Azure subscriptions are visible to your account.").waitFor();
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it("closes with Escape and returns focus to the trigger", async () => {
    const { page, errors } = await mount();
    try {
      const trigger = page.getByRole("button", { name: /^Analyst/ });
      await trigger.click();
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      expect(await trigger.evaluate(el => el === document.activeElement)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);

  it("fills a phone screen without overflowing the page", async () => {
    const { page, errors } = await mount(390);
    try {
      await page.getByRole("button", { name: /^Analyst/ }).click();
      await page.getByRole("dialog").waitFor();
      const box = await page.getByRole("dialog").boundingBox();
      expect(Math.round(box?.width ?? 0)).toBe(390);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
});
