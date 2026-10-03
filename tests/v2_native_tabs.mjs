// Read-only integrated browser acceptance: a running CloudLens with real API data.
// CLOUDLENS_URL=http://127.0.0.1:8101 node tests/v2_native_tabs.mjs
// Optional V2_SCREENSHOT_DIR and V2_REPORT_PATH persist screenshots/status-only evidence.
// V2_SCREENS=overview,report narrows a rerun; V2_MATRIX_ONLY=1 runs all six layout/theme cases.
import { chromium } from "playwright";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const base = (process.env.CLOUDLENS_URL || "http://127.0.0.1:8101").replace(/\/$/, "");
const timeout = Number(process.env.V2_DATA_TIMEOUT_MS || 90000);
const navSource = await readFile(join(root, "ui", "src", "nav.ts"), "utf8");
const routes = [...navSource.matchAll(/(?:native\("([^"]+)", "([^"]+)", \w+, "([^"]+)"|\{ id: "([^"]+)", label: "([^"]+)", icon: \w+, to: "([^"]+)")/g)]
  .map(m => ({ id: m[1] || m[4], label: m[2] || m[5], route: m[3] || m[6] }));
if (routes.length !== 21 || new Set(routes.map(r => r.route)).size !== routes.length) throw new Error("Expected all 21 unique native screens declared in nav.ts");
const requestedScreens = process.env.V2_SCREENS?.split(",").filter(Boolean);
if (requestedScreens?.some(id => !routes.some(route => route.id === id))) throw new Error("Unknown V2_SCREENS screen id");
const selectedRoutes = requestedScreens ? routes.filter(route => requestedScreens.includes(route.id)) : routes;
let dotenv = "";
try { dotenv = await readFile(join(root, ".env"), "utf8"); } catch {}
const envValue = key => {
  const raw = dotenv.split(/\r?\n/).find(line => line.startsWith(`${key}=`))?.slice(key.length + 1).trim() || "";
  return raw.replace(/^(['"])(.*)\1$/, "$2");
};
const username = process.env.CLOUDLENS_USER || envValue("AUTH_USERNAME");
const password = process.env.CLOUDLENS_PASSWORD || envValue("AUTH_PASSWORD");
if (!username || !password) throw new Error("Set CLOUDLENS_USER/CLOUDLENS_PASSWORD or AUTH_USERNAME/AUTH_PASSWORD in .env");
const axeSource = await readFile(join(root, "node_modules", "axe-core", "axe.min.js"), "utf8");
const evidence = { mode: process.env.V2_MATRIX_ONLY ? "matrix-only" : "full", routes: [], checks: [], blockedWrites: [], exceptions: [], consoleErrors: [], renderFailures: [], aliases: [], layouts: [], allApi: [] };
const check = (ok, name, detail) => {
  evidence.checks.push({ ok, name, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(15000);
let active = "login";
let responses = [];
let bookmarkScope;
const pending = new Map();
const payloadTasks = new Map();
const failedRequests = [];
page.on("pageerror", error => {
  evidence.exceptions.push({ screen: active, error: error.message });
  console.log(`BROWSER_EXCEPTION ${active}: ${error.message}`);
});
page.on("console", message => {
  if (message.type() === "error") evidence.consoleErrors.push({ screen: active, error: message.text() });
});
page.on("request", request => {
  const path = new URL(request.url()).pathname;
  if (path.startsWith("/api/") && path !== "/api/auth/login") pending.set(request, active);
});
page.on("requestfinished", request => pending.delete(request));
page.on("requestfailed", request => {
  pending.delete(request);
  if (new URL(request.url()).pathname.startsWith("/api/")) failedRequests.push({ screen: active, path: new URL(request.url()).pathname, error: request.failure()?.errorText });
});
page.on("response", response => {
  const url = new URL(response.url());
  if (!url.pathname.startsWith("/api/")) return;
  const row = { screen: pending.get(response.request()) || active, path: url.pathname, query: url.search, status: response.status() };
  if (row.screen === active) responses.push(row);
  evidence.allApi.push(row);
  if (url.pathname === "/api/auth/login") return;
  const task = (async () => {
    try {
      const body = await response.json();
      if (body && typeof body === "object") {
        if (url.pathname === "/api/cost-data/subscriptions" && Array.isArray(body.subscriptions)) {
          bookmarkScope = body.subscriptions.find(subscription => typeof subscription.id === "string")?.id || bookmarkScope;
        }
        for (const key of ["status", "partial", "error", "detail", "unavailable", "notices"]) {
          if (body[key] !== undefined && body[key] !== null && body[key] !== false) row[key === "status" ? "payloadStatus" : key] = body[key];
        }
      }
    } catch {}
  })();
  payloadTasks.set(task, row.screen);
  task.finally(() => {
    payloadTasks.delete(task);
    pending.delete(response.request());
  });
});
// Guard against accidental writes, including read-like GET endpoints that generate exports.
await context.route("**/api/**", async route => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if ((request.method() !== "GET" && path !== "/api/auth/login") ||
      /\/(?:report\/(?:xlsx|pptx|csv)|archive\/export\/download|refresh)(?:\/|$)/.test(path)) {
    evidence.blockedWrites.push({ screen: active, path, method: request.method() });
    return route.abort("blockedbyclient");
  }
  return route.continue();
});
async function settle() {
  const started = Date.now();
  const currentRequests = () => [...pending].filter(([, screen]) => screen === active).map(([request]) => request);
  while (Date.now() - started < timeout) {
    if (!currentRequests().length) {
      await page.waitForTimeout(700);
      if (!currentRequests().length) {
        const tasks = [...payloadTasks].filter(([, screen]) => screen === active).map(([task]) => task);
        await Promise.race([Promise.all(tasks), page.waitForTimeout(3000)]);
        if (!currentRequests().length) return [];
      }
    } else await page.waitForTimeout(250);
  }
  const currentPayloadTasks = [...payloadTasks].filter(([, screen]) => screen === active).map(([task]) => task);
  await Promise.race([Promise.all(currentPayloadTasks), page.waitForTimeout(3000)]);
  return currentRequests().map(request => new URL(request.url()).pathname);
}
async function audit(label) {
  await page.waitForTimeout(1200);
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
  }));
  const violations = result.violations.filter(v => ["serious", "critical"].includes(v.impact))
    .map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) }));
  check(!violations.length, `WCAG serious/critical ${label}`, violations);
  return violations;
}
async function layout(label) {
  const result = await page.evaluate(() => ({
    viewport: innerWidth, document: document.documentElement.scrollWidth,
    overflow: document.documentElement.scrollWidth - innerWidth,
    offenders: [...document.querySelectorAll("body *")].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > innerWidth + 2 || r.left < -2) &&
        !el.closest('[role="table"],.overflow-x-auto,.overflow-auto') &&
        getComputedStyle(el).position !== "absolute";
    }).slice(0, 8).map(el => ({ tag: el.tagName, class: el.className, text: el.textContent?.slice(0, 65) })),
  }));
  evidence.layouts.push({ label, ...result });
  check(result.overflow <= 2, `no document overflow ${label}`, result);
  if (result.overflow > 2) await screenshot(`overflow-${active}`);
}
async function screenshot(name) {
  if (!process.env.V2_SCREENSHOT_DIR) return;
  await mkdir(process.env.V2_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.V2_SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}
async function palette(screen) {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  const input = page.locator("input[cmdk-input]");
  await input.waitFor({ timeout: 5000 });
  await input.fill(screen.label);
  const selected = page.locator("[cmdk-item]").filter({ hasText: screen.label }).first();
  await selected.click();
  await page.waitForURL(url => url.pathname === `/v2${screen.route}` || (screen.route === "/" && url.pathname === "/v2"), { timeout: 15000 });
}
async function readOnlyActions(screen) {
  if (["billing", "resources"].includes(screen.id)) {
    const rows = page.locator('[role="table"] [role="row"][aria-rowindex]');
    if (!await rows.count()) {
      check(false, `live row actions available ${screen.label}`, "No live rows: cannot establish sorting/detail functionality");
      return;
    }
    const header = page.locator('[role="columnheader"]').filter({ has: page.locator("button") }).first();
    await header.locator("button").click();
    await settle();
    check(["ascending", "descending"].includes(await header.getAttribute("aria-sort")), `${screen.label} sorts from real header click`);
    if (screen.id === "resources") {
      const next = page.getByRole("button", { name: "Next page", exact: true });
      if (await next.isEnabled()) {
        const before = await rows.first().innerText();
        await next.click();
        await settle();
        check(await rows.first().innerText() !== before, "Resources pagination changes actual rows");
      }
    }
  }
  if (["savings", "ai-billing"].includes(screen.id)) {
    const group = page.getByRole("radiogroup", { name: screen.id === "savings" ? "Savings views" : "AI billing detail" });
    if (!await group.count()) {
      check(false, `${screen.label} detail tabs are present`);
      return;
    }
    for (const radio of await group.getByRole("radio").all()) {
      const label = await radio.innerText();
      await radio.click();
      await settle();
      check(await radio.getAttribute("aria-checked", { timeout: 5000 }) === "true", `${screen.label} detail ${label} activates`);
      check(evidence.exceptions.length === 0, `${screen.label} detail ${label} has no render exceptions`);
    }
  }
  if (["governance", "esu"].includes(screen.id)) {
    const input = page.getByRole("searchbox", { name: screen.id === "governance" ? "Search findings" : "Search machines", exact: true });
    await input.fill("qa-no-resource-can-have-this-name");
    await page.waitForTimeout(300);
    check(await input.inputValue() === "qa-no-resource-can-have-this-name", `${screen.label} text filter accepts input`);
    await input.fill("");
    if (screen.id === "governance") {
      const group = page.getByLabel("Group findings", { exact: true });
      await group.selectOption({ label: "Severity" });
      check(await group.inputValue() === "Severity", "Governance severity grouping changes");
      await group.selectOption({ label: "Resource" });
    }
  }
  if (screen.id === "report") {
    const format = page.getByRole("combobox", { name: "Report file format", exact: true });
    const options = await format.locator("option").evaluateAll(options => options.map(option => option.value));
    check(options.length >= 2, "Reports offers actual supported file formats", options);
    for (const value of options) {
      await format.selectOption(value);
      const href = await page.getByRole("link", { name: "Download report", exact: true }).getAttribute("href");
      check(!!href && new URL(href, base).pathname === `/api/report/${value}`, `Reports ${value} produces matching download link without downloading`);
    }
    const fields = page.getByRole("checkbox");
    if (await fields.count()) {
      const field = fields.first();
      const before = await field.isChecked();
      await field.setChecked(!before);
      check(await field.isChecked() !== before, "Reports selection changes from actual checkbox click");
      await field.setChecked(before);
    }
    const exportSubscriptions = page.locator("fieldset").filter({ has: page.locator("legend", { hasText: "Export subscriptions" }) });
    const subscription = exportSubscriptions.getByRole("checkbox").first();
    if (await subscription.count()) {
      await subscription.check();
      await settle();
      const rawLink = page.getByRole("link", { name: "Download raw data", exact: true });
      const href = await rawLink.getAttribute("href");
      check(!!href && new URL(href, base).pathname === "/api/archive/export/download", "Reports actual selected subscriptions produce raw download link without generating export");
      await page.getByLabel(/^Dataset/).selectOption("amortized");
      const amortized = await rawLink.getAttribute("href");
      check(!!amortized && new URL(amortized, base).searchParams.get("dataset") === "amortized", "Reports raw dataset updates download parameters");
      await page.getByLabel(/^Dataset/).selectOption("actual");
    }
  }
}
try {
  await page.goto(`${base}/v2/explore/billing`, { waitUntil: "domcontentloaded" });
  check(new URL(page.url()).pathname === "/login", "anonymous native visit requires login");
  const login = await page.evaluate(async credentials => {
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials) });
    return response.status;
  }, { username, password });
  if (login !== 200) throw new Error(`Login failed HTTP ${login}`);
  active = "overview";
  await page.goto(`${base}/v2/`, { waitUntil: "domcontentloaded" });
  const nav = page.getByRole("navigation", { name: "Workspaces" });
  await nav.waitFor({ timeout: 30000 });
  await nav.getByRole("link", { name: routes.find(route => route.id === "audit").label, exact: true }).waitFor({ timeout: 30000 });
  check(await nav.getByRole("link").count() === routes.length, `all ${routes.length} native screens visible in sidebar`);
  if (!process.env.V2_MATRIX_ONLY) {
  for (const screen of selectedRoutes) {
    active = screen.id;
    responses = screen.id === "overview" ? responses.filter(r => r.screen === "overview" && r.path !== "/api/auth/login") : [];
    const exceptionStart = evidence.exceptions.length;
    const start = Date.now();
    try {
      await nav.getByRole("link", { name: screen.label, exact: true }).click();
      await page.waitForURL(url => url.pathname === `/v2${screen.route}` || (screen.route === "/" && url.pathname === "/v2"), { timeout: 15000 });
      await page.getByRole("heading", { level: 1, name: screen.label, exact: true }).waitFor({ timeout: 15000 });
      if (screen.id === "performance" && !new URL(page.url()).searchParams.has("scope")) {
        const catalog = await context.request.get(`${base}/api/cost-data/subscriptions`, { timeout });
        if (!catalog.ok()) throw new Error(`Current subscription catalog failed HTTP ${catalog.status()}`);
        const current = await catalog.json();
        const accessibleId = current.subscriptions?.find(subscription => typeof subscription.id === "string")?.id;
        if (!accessibleId) throw new Error("No currently accessible subscription is available for scoped acceptance");
        const scopePicker = page.getByRole("button", { name: "Subscription scope", exact: true }).first();
        await scopePicker.click();
        await page.getByPlaceholder("Filter subscriptions…").fill(accessibleId);
        const subscription = page.locator("[cmdk-item]").filter({ hasNotText: "All subscriptions" }).first();
        await subscription.waitFor({ timeout: 15000 });
        await subscription.click();
        await page.keyboard.press("Escape");
        await page.waitForURL(url => url.searchParams.get("scope") === accessibleId, { timeout: 15000 });
        check(true, "Performance selects actual entitled subscription via scope picker");
      }
      const outstanding = await settle();
      const alerts = await page.locator('[role="alert"]').allTextContents();
      const text = await page.locator("main").innerText().catch(() => "");
      const loading = await page.locator('[aria-busy="true"]').count();
      const record = { ...screen, url: `${new URL(page.url()).pathname}${new URL(page.url()).search}`, durationMs: Date.now() - start,
        api: [...responses], outstanding, alerts, loading, bodyCharacters: text.length,
        visibleNotices: text.split("\n").filter(line => /unavailable|permission|could not|failed|partial|unsupported|denied|error/i.test(line)).slice(0, 16) };
      evidence.routes.push(record);
      check(true, `native sidebar navigation ${screen.label}`, { api: record.api, outstanding, alerts, loading, notices: record.visibleNotices });
      check(!outstanding.length && !loading, `settled ${screen.label}`);
      check(evidence.exceptions.length === exceptionStart && text.length > 100, `rendered content ${screen.label}`, text.length);
      record.axe = await audit(`${screen.label} light`);
      await layout(`${screen.label} 1440 light`);
      try { await readOnlyActions(screen); }
      catch (error) {
        check(false, `read-only actions ${screen.label}`, error.message);
        const showError = page.getByRole("button", { name: "Show Error", exact: true });
        if (await showError.count()) {
          await showError.click();
          const detail = await page.locator("body").innerText();
          evidence.renderFailures.push({ screen: screen.id, detail });
          check(false, `no action error boundary ${screen.label}`, detail);
        }
        check(evidence.exceptions.length === exceptionStart && await nav.count() > 0, `no action render exceptions ${screen.label}`, evidence.exceptions.slice(exceptionStart));
        await screenshot(`failure-${screen.id}`);
        if (!await nav.count()) await page.goto(`${base}/v2${screen.route}`, { waitUntil: "domcontentloaded" });
      }
      record.api = [...responses].filter(response => response.screen === screen.id);
      if (screen.id === "overview") {
        const regional = page.getByText("Regional spend", { exact: true });
        check(await regional.isVisible(), "Overview regional spend renders");
        const charts = await page.locator("canvas").evaluateAll(canvases => canvases.map(c => ({ width: c.width, height: c.height })));
        check(charts.length >= 3 && charts.every(c => c.width > 0 && c.height > 0), "Overview chart canvases initialized", charts);
        await screenshot("native-overview-1440-light");
        const daily = page.locator("summary").filter({ hasText: "View daily values" });
        await daily.click();
        check(await page.getByRole("region", { name: "Daily spend data", exact: true }).isVisible(), "Overview daily comparison values expand");
        await daily.click();
        const regionalDetails = page.locator("summary").filter({ hasText: "View regional data and source" });
        await regionalDetails.click();
        check(await page.getByRole("region", { name: "Regional spend table, horizontally scrollable", exact: true }).isVisible(), "Overview regional source table expands");
        await regionalDetails.click();
        const comparisons = page.getByRole("group", { name: "Choose regional comparison", exact: true }).getByRole("button");
        if (await comparisons.count() > 1) {
          await comparisons.nth(1).click();
          check(await comparisons.nth(1).getAttribute("aria-pressed") === "true", "Overview regional comparison changes through actual button click");
        }
      }
    } catch (error) {
      check(false, `screen ${screen.label}`, error.message);
      await page.keyboard.press("Escape").catch(() => {});
      if (!await nav.count()) await page.goto(`${base}/v2/`, { waitUntil: "domcontentloaded" });
    }
  }
  // All palette destinations are exercised independently of sidebar links.
  for (const screen of selectedRoutes) {
    active = screen.id;
    try { await palette(screen); check(true, `command palette ${screen.label}`); }
    catch (error) { check(false, `command palette ${screen.label}`, error.message); await page.keyboard.press("Escape"); }
  }
  // Bookmarks must remain in React, preserving global scope.
  if (!bookmarkScope) {
    const response = await context.request.get(`${base}/api/cost-data/subscriptions`, { timeout });
    const body = await response.json();
    bookmarkScope = body.subscriptions?.[0]?.id;
  }
  if (!bookmarkScope) throw new Error("No actual subscription is available for scoped bookmark validation");
  const scope = bookmarkScope;
  for (const id of ["settings", "report", "health", "ai-billing", "audit"]) {
    const screen = routes.find(r => r.id === id);
    active = `alias-${id}`;
    await page.goto(`${base}/v2/classic/${id}?month=2026-09&scope=${scope}`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(url => url.pathname === `/v2${screen.route}`, { timeout: 15000 });
    const url = new URL(page.url());
    const preserved = url.searchParams.get("month") === "2026-09" && url.searchParams.get("scope") === scope;
    evidence.aliases.push({ id, path: url.pathname, preserved });
    check(preserved, `legacy bookmark ${id} stays native and preserves month/scope`);
  }
  }
  // Test actual rendering at mobile/tablet/desktop, both themes, all native pages.
  active = "responsive-warmup";
  await page.goto(`${base}/v2/`, { waitUntil: "domcontentloaded" });
  await settle();
  for (const theme of ["light", "dark"]) {
    active = `theme-${theme}-warmup`;
    await page.evaluate(theme => localStorage.setItem("cl.v3.prefs", JSON.stringify({ ...JSON.parse(localStorage.getItem("cl.v3.prefs") || "{}"), theme })), theme);
    await page.reload({ waitUntil: "domcontentloaded" });
    await settle();
    check(await page.evaluate(theme => document.documentElement.classList.contains("dark") === (theme === "dark"), theme), `${theme} persists through reload`);
    for (const width of [390, 800, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const screen of selectedRoutes) {
        active = `${screen.id}-${width}-${theme}`;
        await nav.getByRole("link", { name: screen.label, exact: true }).click();
        await page.waitForURL(url => url.pathname === `/v2${screen.route}` || (screen.route === "/" && url.pathname === "/v2"), { timeout: 15000 });
        const heading = page.getByRole("heading", { level: 1, name: screen.label, exact: true });
        await heading.waitFor({ state: "attached", timeout: 15000 });
        await settle();
        const visibleHeading = await heading.isVisible();
        check(visibleHeading, `visible screen heading ${screen.label} ${width} ${theme}`);
        if (!visibleHeading) await screenshot(`hidden-heading-${active}`);
        await layout(`${screen.label} ${width} ${theme}`);
        if (width === 1440 && theme === "dark" && screen.id !== "overview") await audit(`${screen.label} dark`);
        if (screen.id === "overview") {
          await audit(`Overview ${width} ${theme}`);
          await screenshot(`native-overview-${width}-${theme}`);
        }
      }
    }
  }
  check(evidence.exceptions.length === 0, "no React/browser exceptions", evidence.exceptions);
  check(evidence.renderFailures.length === 0, "no root error-boundary failures", evidence.renderFailures);
  check(evidence.blockedWrites.length === 0, "no write/export-generation actions attempted", evidence.blockedWrites);
  const failedApi = evidence.routes.flatMap(r => r.api.filter(api => api.status >= 400));
  check(failedApi.length === 0, "live primary API reads return successful HTTP responses", failedApi);
  const renderErrors = evidence.consoleErrors.filter(row => /TypeError|ReferenceError|SyntaxError|Objects are not valid|Cannot read properties|is not a function|Encountered two children/i.test(row.error));
  check(renderErrors.length === 0, "no React render/payload errors in console", renderErrors);
  console.log(`LIVE_API_FAILURES ${JSON.stringify(failedApi)}`);
  console.log(`CONSOLE_ERRORS ${JSON.stringify(evidence.consoleErrors)}`);
  console.log(`REQUEST_FAILURES ${JSON.stringify(failedRequests)}`);
} catch (error) {
  check(false, "integration suite completed", error.message);
} finally {
  if (process.env.V2_REPORT_PATH) await writeFile(process.env.V2_REPORT_PATH, JSON.stringify(evidence, null, 2));
  await browser.close();
}
const failures = evidence.checks.filter(c => !c.ok);
console.log(`SUMMARY ${evidence.checks.length - failures.length}/${evidence.checks.length} checks passed; ${process.env.V2_MATRIX_ONLY ? `${evidence.layouts.length}/${selectedRoutes.length * 6} viewport/theme screen cases` : `${evidence.routes.length}/${selectedRoutes.length} selected real native screens`} (${routes.length} declared); ${evidence.exceptions.length} browser exceptions`);
process.exitCode = failures.length ? 1 : 0;
