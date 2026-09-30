// Smoke test for the v3 interface at /v2, against a running CloudLens.
//
//   CLOUDLENS_URL=http://127.0.0.1:8100 CLOUDLENS_USER=admin CLOUDLENS_PASSWORD=... npm run test:v2
//
// Sign-in round trip, Overview renders with real numbers, ⌘K navigates, Billing's virtualised
// table renders and sorts, Resources pages and sorts on the server, the theme survives a
// reload, and the page raises no console errors (a CSP violation shows up there).
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const axeSource = await readFile(
  join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "axe-core", "axe.min.js"), "utf8");

async function axe(page, label) {
  // Tiles fade in over ~0.5 s; auditing mid-animation reports translucent text as low contrast.
  await page.waitForTimeout(1200);
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => await window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
  }));
  const serious = result.violations.filter((v) => ["serious", "critical"].includes(v.impact));
  check(serious.length === 0, `no serious WCAG violations on ${label}`,
    serious.map((v) => `${v.id} ×${v.nodes.length}`).join(", "));
  if (process.env.V2_AXE_DETAIL) {
    for (const v of serious) for (const n of v.nodes.slice(0, 40)) {
      console.log(`         ${n.target.join(" ")} :: ${(n.any[0]?.message || "").slice(0, 140)}`);
    }
  }
}

const BASE = (process.env.CLOUDLENS_URL || "http://localhost:8100").replace(/\/$/, "");
const USER = process.env.CLOUDLENS_USER || "";
const PASSWORD = process.env.CLOUDLENS_PASSWORD || "";
// Cold warehouse endpoints can take minutes on a fresh process; the UI shows skeletons meanwhile.
const DATA_TIMEOUT = Number(process.env.V2_DATA_TIMEOUT_MS || 240000);

const checks = [];
const check = (ok, name, detail = "") => {
  checks.push({ ok, name });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({ headless: !process.env.HEADED });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await page.goto(`${BASE}/v2/explore/billing`, { waitUntil: "domcontentloaded" });
  const onLogin = new URL(page.url()).pathname.startsWith("/login");
  check(onLogin, "an anonymous visit to /v2 goes to sign-in", page.url());
  if (onLogin) {
    if (!USER || !PASSWORD) throw new Error("Set CLOUDLENS_USER / CLOUDLENS_PASSWORD.");
    const status = await page.evaluate(async ([username, password]) => {
      const r = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      return r.status;
    }, [USER, PASSWORD]);
    if (status !== 200) throw new Error(`sign-in failed with HTTP ${status}`);
    const next = new URL(page.url()).searchParams.get("next");
    check(next === "/v2/explore/billing", "sign-in returns to the requested /v2 screen", String(next));
  }

  await page.goto(`${BASE}/v2/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("navigation", { name: "Workspaces" }).waitFor({ timeout: 30000 });
  check(true, "the shell renders");

  const total = page.locator("text=Total spend").locator("xpath=..").locator(".num").first();
  await total.waitFor({ timeout: DATA_TIMEOUT });
  const value = (await total.textContent())?.trim() ?? "";
  check(/\d/.test(value), "Overview shows a real total", value);
  await axe(page, "Overview (light)");

  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  const input = page.locator("input[cmdk-input]");
  await input.waitFor({ timeout: 5000 });
  check(true, "⌘K opens the command palette");
  await input.fill("billing");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/v2\/explore\/billing/, { timeout: 10000 });
  check(true, "the palette navigates to Billing");

  const rows = page.locator('[role="table"] [role="row"][aria-rowindex]');
  await rows.first().waitFor({ timeout: DATA_TIMEOUT });
  const rendered = await rows.count();
  const total_rows = Number(await page.locator('[role="table"]').getAttribute("aria-rowcount"));
  check(rendered > 0 && rendered <= total_rows, "Billing renders a virtualised table", `${rendered} of ${total_rows} rows in the DOM`);

  const header = page.locator('[role="columnheader"]').first();
  await header.locator("button").click();
  check((await header.getAttribute("aria-sort")) !== "none", "clicking a header sorts", await header.getAttribute("aria-sort"));
  await axe(page, "Billing (light)");

  await page.evaluate(() => localStorage.setItem("cl.v3.prefs", JSON.stringify({ theme: "dark" })));
  await page.reload({ waitUntil: "domcontentloaded" });
  const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  check(dark, "dark theme applies before the app boots (theme.js)");
  await rows.first().waitFor({ timeout: DATA_TIMEOUT });
  await axe(page, "Billing (dark)");

  // Resources: one server-sorted page of a list far too long to load whole.
  await page.goto(`${BASE}/v2/explore/resources`, { waitUntil: "domcontentloaded" });
  await rows.first().waitFor({ timeout: DATA_TIMEOUT });
  const range = (await page.getByText(/^\d[\d,]*–\d[\d,]* of \d/).first().textContent())?.trim() ?? "";
  check(/of \d/.test(range), "Resources shows a page of the full, counted list", range);
  const firstName = async () => (await rows.first().locator('[role="cell"]').first().textContent())?.trim();
  const before = await firstName();
  await page.getByRole("button", { name: "Next page" }).click();
  await page.waitForFunction((t) => !/^1–/.test(t), range, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[role="table"][aria-busy="true"]'), null, { timeout: DATA_TIMEOUT });
  check((await firstName()) !== before, "Next page loads different resources");
  const costHeader = page.locator('[role="columnheader"]', { hasText: "Period cost" });
  await costHeader.locator("button").click();
  await page.waitForFunction(() => !document.querySelector('[role="table"][aria-busy="true"]'), null, { timeout: DATA_TIMEOUT });
  check((await costHeader.getAttribute("aria-sort")) === "ascending", "sorting asks the server for a new order", await costHeader.getAttribute("aria-sort"));
  await axe(page, "Resources (dark)");

  // Setup progress: months × subscriptions for the unattended first run (S2).
  await page.goto(`${BASE}/v2/admin/setup`, { waitUntil: "domcontentloaded" });
  const grid = page.getByRole("table", { name: /import progress/i });
  await grid.waitFor({ timeout: DATA_TIMEOUT });
  const months = await grid.locator('thead th[scope="col"]').count();
  const subs = await grid.locator('tbody th[scope="row"]').count();
  check(months === 14 && subs > 0, "Setup shows 13 months × every subscription", `${subs} subscriptions, ${months - 1} months`);
  check(await page.getByText(/up to 24 hours/).first().isVisible(), "Setup states the 24-hour expectation");
  await axe(page, "Setup progress (dark)");

  const csp = errors.filter((e) => /Content Security Policy|Refused to/i.test(e));
  check(csp.length === 0, "no CSP violations", csp[0] ?? "");
  const other = errors.filter((e) => !/Content Security Policy|Refused to/i.test(e));
  check(other.length === 0, "no console errors", other[0] ?? "");
} catch (error) {
  check(false, "smoke run", String(error?.message || error).split("\n")[0]);
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
