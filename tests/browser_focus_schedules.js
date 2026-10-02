async (page) => {
  // Current Cost data UI: schedules are reviewed separately from initial history imports.
  // Every request, including approval, is fulfilled offline.
  const context = await page.context().browser().newContext();
  const test = await context.newPage();
  const source = await (await context.request.get("http://127.0.0.1:18433/assets/dashboard-reports.js")).text();
  const css = await (await context.request.get("http://127.0.0.1:18433/assets/app.css")).text();
  const reads = [], writes = [], errors = [];
  test.on("pageerror", error => errors.push(error.message));
  const subscriptions = ["Alpha", "Beta"].map((name, i) => ({
    id: `sub-${i}`, name, status: "ready", configured: true,
    config: { cadence: "Daily", enabled: true },
    coverage: { requested_days: 90, authoritative_days: 90, missing_days: 0 }, tasks: [],
  }));
  const schedules = Array.from({ length: 12 }, (_, i) => ({
    name: `export-${i}`, subscription_id: `sub-${i % 2}`, subscription: subscriptions[i % 2].name,
    metric: i ? "FocusCost" : "AmortizedCost", owned: !!i, status: "Active",
    recurrence: "Daily", identity: true, account: "offline", container: "focus",
    folder: `focus/sub-${i % 2}`, last_status: "Completed",
  }));
  let canReview = true, blocked = true;
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === "/reports.js") return route.fulfill({ contentType: "text/javascript", body: source });
    if (path === "/app.css") return route.fulfill({ contentType: "text/css", body: css });
    if (path.startsWith("/api/")) {
      const scope = (url.searchParams.get("scope") || "").split(",");
      if (request.method() === "GET") {
        reads.push(request.url());
        return route.fulfill({ json: path === "/api/schedules" ? { schedules }
          : { can_review: canReview, setup_needed: false, auto_enabled: true,
            subscriptions: path.endsWith("/subscriptions") ? subscriptions : subscriptions.filter(s => scope.includes(s.id)) } });
      }
      const body = request.postDataJSON();
      writes.push({ path, body });
      if (path === "/api/cost-data/preview") return route.fulfill({ json: {
        can_start: !blocked, preview_token: "reviewed-etag", explanation: "Configure ongoing updates only.",
        identity: "Offline workload identity", notes: ["Existing exports and costs are retained."],
        subscriptions: subscriptions.filter(s => body.scope.includes(s.id)).map(s => ({
          subscription: s.id, name: s.name, action: "Configure owned export",
          export: { name: `owned-${s.id}`, etag: "v1" },
          destination: { account_id: "offline", container: "focus", folder: s.id },
          blockers: blocked ? ["Workload identity requires Blob read access."] : [],
        })),
      } });
      if (path !== "/api/cost-data/setup") throw Error(`Unexpected write ${path}`);
      for (const s of subscriptions.filter(s => body.scope.includes(s.id))) {
        s.config.cadence = body.cadence;
        s.status = "ready";
      }
      return route.fulfill({ json: { job_id: "offline-schedule-job", status: "queued" } });
    }
    return route.fulfill({ contentType: "text/html", body:
      '<html><head><link rel="stylesheet" href="/app.css"></head><body><main id="tabBody"></main></body></html>' });
  });
  let passed = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); passed++; };
  try {
    await test.goto("http://127.0.0.1:18433/focus-schedules-fixture");
    await test.evaluate(async () => {
      const { createTabs } = await import("/reports.js");
      window.ctx = {
        $: id => document.getElementById(id), loadToken: 1, scopeIds: () => ["sub-0"],
        allSubscriptions: () => [], key: x => x, qs: () => "?scope=sub-0",
        readStore: (_, fallback) => fallback, writeStore: () => {},
        esc: v => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
        get: async (url, options) => (await fetch(url, { signal: options?.signal })).json(),
        setContent: (host, html) => { host.innerHTML = html; }, toast: () => {},
        whoAmI: async () => ({ user: { admin: true }, azure_mode: "app" }),
      };
      window.reports = createTabs(window.ctx);
      await window.reports.renderSettings(1);
    });
    assert(reads.length === 2 && !reads.some(url => url.includes("/api/schedules")),
      "Initial paint loads catalog and saved status, not a live Azure export scan");
    assert(writes.length === 0, "Opening settings makes no changes");
    await test.locator("#cdTab-schedule").click();
    assert(await test.locator("#cdCadence-Daily").isChecked(), "Saved daily cadence is selected");
    assert(await test.locator("#cdFrequency input").count() === 3, "Daily, weekly and monthly remain available");
    await test.locator("#cdCadence-Monthly").check();
    assert((await test.locator("#cdChange").innerText()) === "Review monthly schedule", "Action names the chosen cadence");
    await test.locator("#cdChange").click();
    assert(writes.length === 1 && writes[0].path === "/api/cost-data/preview", "Review alone does not enable updates");
    assert(JSON.stringify(writes[0].body) === '{"scope":["sub-0"],"action":"schedule","cadence":"Monthly"}',
      "Schedule review binds ingest scope and cadence without a hidden history import");
    assert(await test.locator("#cdStart").isDisabled(), "Readiness blocker prevents authorization");
    assert((await test.locator("#cdPlan").innerText()).includes("Blob read access"), "Specific missing access is disclosed");
    blocked = false;
    await test.locator("#cdRecheck").click();
    await test.locator("#cdStart").waitFor({ state: "visible" });
    assert(await test.locator("#cdStart").isEnabled(), "Fresh readiness review can unblock approval");
    await test.locator("#cdCancel").click();
    assert(writes.every(w => w.path.endsWith("/preview")), "Cancellation never writes Azure schedules");
    await test.locator("#cdChange").click();
    await test.locator("#cdStart").click();
    await test.waitForFunction(() => !document.querySelector("#cdStart"));
    const approvals = writes.filter(w => w.path.endsWith("/setup"));
    assert(approvals.length === 1 && approvals[0].body.preview_token === "reviewed-etag"
      && !!approvals[0].body.idempotency_key && approvals[0].body.cadence === "Monthly"
      && approvals[0].body.action === "schedule"
      && JSON.stringify(approvals[0].body.scope) === '["sub-0"]',
      "Exactly one confirmed approval binds the reviewed scope, action, token and idempotency key");
    assert(!("history_days" in approvals[0].body) && !("start" in approvals[0].body),
      "Schedule-only approval never starts historical import");
    assert(subscriptions[0].config.cadence === "Monthly", "Selected subscription saves the approved cadence");
    assert(subscriptions[1].config.cadence === "Daily", "Unselected subscription remains unchanged");
    await test.locator("#cdAdvanced > summary").click();
    await test.locator("#cdInventory > summary").click();
    const beforeExports = reads.length;
    await test.locator("#cdLoadExports").click();
    await test.waitForFunction(() => document.querySelectorAll("#cdExports details.sched").length === 12);
    assert(reads.length === beforeExports + 1 && reads.at(-1).includes("scope=sub-0"), "Exports load only on explicit scoped request");
    assert(JSON.stringify(await test.locator("#cdExports summary > strong").allTextContents())
      === JSON.stringify(schedules.map(s => s.name)), "All returned exports are reachable, including external/legacy entries");
    assert(await test.locator("#cdExports details[open]").count() === 0, "Advanced export details start collapsed");
    assert(await test.locator("#cdExports [data-edit],#cdExports [data-run],#cdExports [data-del]").count() === 0,
      "Export evidence exposes no competing write controls");
    const beforeTabs = reads.length;
    await test.locator("#cdTab-access").click();
    await test.locator("#cdTab-schedule").click();
    assert(await test.locator("#cdCadence-Monthly").isChecked(), "Tab changes retain the selected cadence");
    assert(reads.length === beforeTabs, "Returning to export evidence does not rescan Azure");
    canReview = false;
    await test.evaluate(() => window.reports.renderSettings(1));
    await test.locator("#cdTab-schedule").click();
    assert(await test.locator("#cdChange").isDisabled(), "Read-only callers cannot authorize schedule changes");
    assert(errors.length === 0, errors.join("; "));
    return { passed, mockedApprovals: approvals.length, liveWrites: 0, errors };
  } catch (error) {
    throw Error(`${error.stack || error.message}\n${(await test.locator("#tabBody").innerText()).slice(0, 2500)}`);
  } finally { await context.close(); }
}
