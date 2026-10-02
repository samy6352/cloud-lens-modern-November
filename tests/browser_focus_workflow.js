async (page) => {
  // Exercise the durable review/setup API, not the retired immediate schedule-creation form.
  const context = await page.context().browser().newContext();
  const test = await context.newPage();
  const source = await (await context.request.get("http://127.0.0.1:18439/assets/dashboard-reports.js")).text();
  const css = await (await context.request.get("http://127.0.0.1:18439/assets/app.css")).text();
  const reads = [], writes = [], errors = [];
  test.on("pageerror", error => errors.push(error.message));
  const subscriptions = ["Alpha", "Beta"].map((name, i) => ({
    id: `sub-${i}`, name, status: "idle", configured: false, config: {}, tasks: [],
    coverage: { requested_days: 90, authoritative_days: 0, missing_days: 90 },
  }));
  let failApproval = true;
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === "/reports.js") return route.fulfill({ contentType: "text/javascript", body: source });
    if (path === "/app.css") return route.fulfill({ contentType: "text/css", body: css });
    if (path.startsWith("/api/")) {
      if (request.method() === "GET") {
        reads.push(request.url());
        const selected = (url.searchParams.get("scope") || "").split(",");
        return route.fulfill({ json: { can_review: true, setup_needed: subscriptions.some(s => !s.configured),
          auto_enabled: true, checked_at: "2026-09-10T09:35:00Z",
          subscriptions: path.endsWith("/subscriptions") ? subscriptions : subscriptions.filter(s => selected.includes(s.id)) } });
      }
      const body = request.postDataJSON();
      writes.push({ path, body });
      if (path.endsWith("/preview")) return route.fulfill({ json: {
        can_start: true, preview_token: `review-${writes.length}`, from: body.start, to: body.end,
        identity: "Offline workload identity", explanation: "Import reviewed history and configure ongoing updates.",
        notes: ["External exports remain untouched. Storage costs grow with retained reports."],
        subscriptions: subscriptions.filter(s => body.scope.includes(s.id)).map(s => ({
          subscription: s.id, name: s.name, action: "Reuse deployment-owned FOCUS export",
          export: { name: `owned-${s.id}`, etag: "v1" }, window: { from: body.start, to: body.end },
          destination: { account_id: "offline", container: "focus", folder: s.id }, blockers: [],
        })),
      } });
      if (path !== "/api/cost-data/setup") throw Error(`Unexpected write ${path}`);
      if (failApproval) {
        failApproval = false;
        return route.fulfill({ status: 503, json: { detail: "Offline transient response failure" } });
      }
      for (const s of subscriptions.filter(s => body.scope.includes(s.id))) {
        s.status = "waiting-for-Azure"; s.configured = true;
        s.job_id = "offline-durable-job";
        s.config = { cadence: body.cadence, enabled: true };
      }
      return route.fulfill({ json: { job_id: "offline-durable-job", status: "queued" } });
    }
    return route.fulfill({ contentType: "text/html", body:
      '<html><head><link rel="stylesheet" href="/app.css"></head><body><main id="tabBody" style="max-width:1100px;margin:20px auto"></main></body></html>' });
  });
  let passed = 0;
  const assert = (ok, message) => { if (!ok) throw Error(message); passed++; };
  try {
    await test.goto("http://127.0.0.1:18439/focus-workflow-fixture");
    await test.evaluate(async () => {
      const { createTabs } = await import("/reports.js");
      window.feedback = []; window.events = [];
      window.addEventListener("cloudlens:focus-synced", event => window.events.push(event.detail));
      window.ctx = {
        $: id => document.getElementById(id), loadToken: 1, scopeIds: () => [],
        allSubscriptions: () => [], qs: () => "", key: v => v,
        readStore: (_, fallback) => fallback, writeStore: () => {},
        esc: v => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
        get: async (url, options) => {
          const response = await fetch(url, { signal: options?.signal });
          if (!response.ok) throw Error("Read failed");
          return response.json();
        },
        setContent: (host, markup) => { host.innerHTML = markup; },
        toast: (...args) => window.feedback.push(args),
        whoAmI: async () => ({ user: { admin: true }, azure_mode: "app" }),
      };
      window.reports = createTabs(window.ctx);
      await window.reports.renderSettings(1);
    });
    assert(await test.locator("#cdHistoryDays").inputValue() === "90", "Default history is the current 90-day contract");
    assert(await test.locator("#cdCadence-Daily").isChecked(), "Daily is recommended before setup");
    assert(writes.length === 0 && reads.length === 2, "Opening the current workflow only reads catalog and saved status");
    await test.locator("#cdHistoryPreset").selectOption("30");
    const historyFrom = await test.locator("#cdFrom").inputValue();
    await test.locator("#cdTab-schedule").click();
    await test.locator("#cdCadence-Weekly").check();
    await test.locator("#cdTab-first").click();
    await test.locator("#cdReview").click();
    await test.locator("#cdStart").waitFor();
    assert(writes.length === 1 && writes[0].path.endsWith("/preview"), "Review performs no setup mutation");
    assert(writes[0].body.history_days === 30 && writes[0].body.cadence === "Weekly"
      && JSON.stringify(writes[0].body.scope) === '["sub-0","sub-1"]', "Preview binds exact history, cadence and selected subscriptions");
    await test.locator("#cdReviewDetails > summary").click();
    const review = await test.locator("#cdPlan").innerText();
    assert(review.includes("Alpha") && review.includes("Beta") && review.includes("30 days")
      && review.includes("Weekly") && review.includes("FOCUS"), "Review exposes scope, import period and ongoing updates");
    await test.locator("#cdCancel").click();
    assert(writes.length === 1 && await test.locator("#cdStart").count() === 0, "Cancellation invalidates authorization");
    await test.locator("#cdReview").click();
    await test.locator("#cdStart").click();
    await test.waitForFunction(() => document.querySelector("#cdNotice").textContent.includes("same approval key"));
    assert(await test.locator("#cdStart").isEnabled(), "Transient setup failure leaves a retry available");
    await test.locator("#cdStart").click();
    await test.waitForFunction(() => document.querySelector("#cdStatus").textContent.includes("Awaiting Azure"));
    const approvals = writes.filter(w => w.path.endsWith("/setup"));
    assert(approvals.length === 2 && JSON.stringify(approvals[0].body) === JSON.stringify(approvals[1].body),
      "Retry sends the identical reviewed token and idempotency key, never a duplicate intent");
    assert(approvals[0].body.preview_token === "review-2" && !!approvals[0].body.idempotency_key,
      "Cancelled review token is not reused");
    assert(await test.locator("#cdReview").isDisabled(), "Pending setup cannot be approved again");
    assert((await test.evaluate(() => window.feedback)).length === 0, "Azure acceptance is never announced as successful import");
    assert(await test.locator("#cdFrom").inputValue() === historyFrom, "Status reads preserve history draft");
    for (const s of subscriptions) {
      s.status = "partial"; s.coverage.authoritative_days = 30; s.coverage.missing_days = 60;
    }
    await test.locator("#cdCheck").click();
    await test.waitForFunction(() => document.querySelector("#cdProgress").textContent.includes("60 of 180"));
    await test.locator("#cdTab-schedule").click();
    await test.locator("#cdStatusDetails > summary").click();
    assert((await test.locator("#cdStatus").innerText()).includes("Previous work incomplete")
      && (await test.locator("#cdStatus").innerText()).includes("partial / not yet complete"),
      "Incomplete coverage is not called ready");
    for (const s of subscriptions) {
      s.status = "ready"; s.coverage.authoritative_days = 90; s.coverage.missing_days = 0;
      s.last_success = "2026-09-10T09:35:00Z";
    }
    const catalogReads = reads.filter(url => url.includes("/api/cost-data/subscriptions")).length;
    await test.evaluate(() => {
      window.reports.stop();
      window.saved = document.createDocumentFragment();
      window.saved.append(...document.getElementById("tabBody").childNodes);
      document.getElementById("tabBody").innerHTML = "<p>Another cached tab</p>";
      window.ctx.loadToken = 2;
    });
    await test.evaluate(async () => {
      document.getElementById("tabBody").replaceChildren(window.saved);
      await window.reports.resume(2);
    });
    await test.locator("#cdCheck").click();
    await test.waitForFunction(() => document.querySelector("#cdStatus").textContent.includes("Last update completed")
      && document.querySelector("#cdProgress").textContent.includes("180 of 180"));
    assert(reads.filter(url => url.includes("/api/cost-data/subscriptions")).length === catalogReads,
      "Cached return reuses the entitled catalog and rechecks status");
    assert(await test.locator("#cdCadence-Weekly").isChecked()
      && await test.locator("#cdHistoryDays").inputValue() === "30", "Cached return preserves cadence and history drafts");
    assert((await test.evaluate(() => window.events)).some(event => event.status === "ready"),
      "Verified ready coverage publishes the completion event");
    for (const width of [1440, 390, 320]) {
      await test.setViewportSize({ width, height: 900 });
      assert(await test.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `Workflow stays within ${width}px`);
    }
    assert(errors.length === 0, errors.join("; "));
    return { passed, mockedApprovalAttempts: approvals.length, liveWrites: 0, errors };
  } catch (error) {
    throw Error(`${error.stack || error.message}\n${(await test.locator("#tabBody").innerText()).slice(0, 2500)}`);
  } finally { await context.close(); }
}
