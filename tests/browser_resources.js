async (page, { assetOrigin } = {}) => {
  const origin = page.url().match(/^https?:\/\/[^/]+/)?.[0];
  if (!origin) throw new Error("Open CloudLens before resource explorer checks.");
  const context = await page.context().browser().newContext({
    storageState: await page.context().storageState(),
    viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce",
  });
  const test = await context.newPage();
  const errors = [], layouts = [];
  let requests = 0, mode = "normal", passed = 0;
  const requestURLs = [];
  test.on("pageerror", error => errors.push(error.message));
  const check = (ok, message) => { if (!ok) throw new Error(message); passed++; };
  const rows = Array.from({ length: 45 }, (_, index) => ({
    id: `/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/production/providers/Microsoft.Compute/virtualMachines/vm-${index}`,
    name: `vm-${String(index).padStart(2, "0")}`, service: index % 2 ? "Virtual Machines" : "Storage",
    area_id: index % 2 ? "compute" : "storage", area: "Compute",
    resource_group: "production-resource-group-with-a-deliberately-long-readable-name",
    subscription: "A long subscription name for resource explorer layout coverage",
    subscription_id: "11111111-1111-4111-8111-111111111111", region: "eastus",
    cost: index * 10, prior_cost: index % 3 ? 10 : 0, delta: index * 10 - (index % 3 ? 10 : 0),
    change_pct: index % 3 ? (index * 10 - 10) * 10 : null,
    tags: index % 2 ? [{ key: "owner", value: "Explorer Owner" }] : [], currency: index % 2 ? "USD" : "EUR",
    first_seen: "2026-08-01", last_seen: "2026-09-07",
  }));
  rows[0].name = '<img src=x onerror="window.badResource=true">';
  const ready = () => test.waitForFunction(
    () => document.documentElement.dataset.dashboardReady === "true", null, { timeout: 120000 });
  const open = async () => {
    await test.goto(origin);
    await ready();
    await test.locator('#tabs [data-main-section="resources"]').click();
    await test.locator("#resourceExplorer").waitFor();
    await ready();
  };
  try {
    if (assetOrigin) {
      for (const name of ["app.css", "dashboard.js", "dashboard-navigation.js", "dashboard-spend.js", "dashboard-resources.js", "tooltips.js"]) {
        const response = await page.request.get(`${assetOrigin}/assets/${name}`);
        if (!response.ok()) throw new Error(`Missing resource asset: ${name}`);
        const body = await response.body();
        await context.route(`**/assets/${name}`, route => route.fulfill({
          body, contentType: name.endsWith(".css") ? "text/css" : "text/javascript",
        }));
      }
    }
    await context.route("**/api/dashboard/resources?**", async route => {
      requests++;
      const params = new URL(route.request().url()).searchParams;
      requestURLs.push(Object.fromEntries(params));
      check(params.get("page") && params.get("page_size") === "20", "Every Resources request must be bounded");
      const changeOf = row => !row.prior_cost ? "no-baseline" : Math.abs(row.delta) < 0.01 ? "unchanged" : row.delta > 0 ? "increased" : "decreased";
      let matches = mode === "empty" ? [] : rows.filter(row =>
        (!params.get("q") || row.id.toLowerCase().includes(params.get("q").toLowerCase())) &&
        (!params.get("billing_currency") || row.currency.toLowerCase() === params.get("billing_currency").toLowerCase()) &&
        (!params.get("change") || changeOf(row) === params.get("change")));
      const field = { cost: "cost", prior: "prior_cost", delta: "delta" }[params.get("sort")];
      check(Boolean(field), "Only backend-supported sorts are requested");
      matches.sort((a, b) => (a[field] - b[field]) * (params.get("order") === "asc" ? 1 : -1) || a.id.localeCompare(b.id));
      const costs = {}, counts = {};
      for (const row of matches) {
        costs[row.currency] = (costs[row.currency] || 0) + row.cost;
        counts[row.currency] = (counts[row.currency] || 0) + 1;
      }
      const pageNumber = Number(params.get("page"));
      const payload = { resources: matches.slice((pageNumber - 1) * 20, pageNumber * 20),
        page: pageNumber, page_size: 20, pages: Math.ceil(matches.length / 20), total: matches.length,
        total_cost_by_currency: costs, resources_by_currency: counts,
        days: Number(params.get("days")) || 30, as_of: "2026-09-07", total_cost: 999999999,
        truncated: mode === "partial", mixed_currency: Object.keys(counts).length > 1 };
      if (params.get("q") === "vm-1") await new Promise(resolve => setTimeout(resolve, 700));
      await route.fulfill({ json: payload }).catch(() => {});
    });
    const settled = () => test.waitForFunction(() => {
      const root = document.querySelector("#resourceExplorer");
      return root && root.getAttribute("aria-busy") !== "true" && !document.querySelector("#resourceRequestStatus")?.textContent;
    });
    await open();
    check(await test.locator("#viewActions [data-subsection]").count() === 0, "Resources must not have a duplicate single subtab");
    check(await test.locator("#tabBody").getAttribute("aria-labelledby") === "primary-resources", "Resources must label its own panel");
    check(await test.locator("#resourceSummary .kpi").count() === 4, "Four matching summary cards");
    check(await test.locator("#resourceSummary .resource-total").count() === 2, "Native currencies stay separate");
    check(!(await test.locator("#resourceSummary").textContent()).includes("999,999,999"), "Do not display a mixed-currency backend sum");
    check(await test.locator("#resourceResults tbody > tr[data-explore-row]").count() === 20, "Resource table is paged");
    check(!await test.evaluate(() => window.badResource === true) && await test.locator("#resourceResults img").count() === 0, "Resource names must be escaped");
    check(requestURLs.at(-1).page === "1" && requestURLs.at(-1).sort === "cost" &&
      requestURLs.at(-1).order === "desc", "Initial page is server sorted by descending cost");
    await test.locator('#resourceResults th[data-col="3"]').click();
    await test.waitForFunction(() => document.querySelector('#resourceResults th[data-col="3"]')?.getAttribute("aria-sort") === "ascending");
    check(!await test.evaluate(() => window.badResource === true) && await test.locator("#resourceResults img").count() === 0,
      "Escaped hostile names stay safe after sorting onto their page");
    await test.locator('#resourceResults [data-page="next"]').click();
    await test.waitForFunction(() => document.querySelector("#resourceResults .pager-count")?.textContent.startsWith("21"));
    check(requestURLs.at(-1).page === "2" && requestURLs.at(-1).order === "asc", "Next page uses server paging and preserves sort");
    check((await test.locator("#resourceSummary .kpi .v").first().textContent()) === "45", "Count is all matching records, not this page");
    check((await test.locator("#resourceSummary .kpi").nth(2).textContent()).includes("on this page only"), "Page-only group counts are labelled");
    const expected = await test.locator(".resource-name > :first-child").first().textContent();
    await test.locator("#resourceResults [data-row-detail]").first().focus();
    await test.keyboard.press("Enter");
    check((await test.locator("#resourceResults .row-detail").textContent()).includes(expected), "Details must match the sorted paged row");
    await test.locator('#resourceResults th[data-col="4"]').click();
    await test.waitForFunction(() => document.querySelector("#resourceResults .pager-count")?.textContent.startsWith("1"));
    check(requestURLs.at(-1).sort === "delta" && requestURLs.at(-1).page === "1" &&
      requestURLs.at(-1).order === "desc", "Changing sort from another page resets the server page");
    const searched = test.waitForResponse(response => response.url().includes("/api/dashboard/resources?") &&
      new URL(response.url()).searchParams.get("q") === "vm-");
    await test.locator("#resourceSearch").fill("vm-");
    await searched;
    await settled();
    check(requestURLs.at(-1).q === "vm-" && requestURLs.at(-1).page === "1", "Search is server-side and resets pagination");
    check((await test.locator("#resourceResults .pager-count").textContent()).startsWith("1"), "Filtering resets pagination");
    const beforeNavigation = requests;
    await test.locator('#tabs [data-main-section="billing"]').click();
    await ready();
    check(await test.locator('#viewActions [data-subsection="resources"]').count() === 0, "Resources is no longer inside Billing");
    await test.locator('#tabs [data-main-section="billing"]').hover();
    check(await test.evaluate(() => {
      const next = document.querySelector('#tabs [data-main-section="resources"]');
      const box = next.getBoundingClientRect();
      return next.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    }), "Billing tooltip must not cover the Resources tab");
    await test.locator('#tabs [data-main-section="resources"]').click();
    await ready();
    check(await test.locator("#resourceSearch").inputValue() === "vm-", "Cached navigation preserves resource filters");
    check(requests === beforeNavigation, "Cached navigation does not refetch completed pages");
    await test.locator("#resourceClear").click();
    await settled();
    await test.locator('[data-resource-filter="currency"]').selectOption("value:eur");
    await test.waitForFunction(() => document.querySelector("#resourceSummary .resource-total") &&
      document.querySelectorAll("#resourceSummary .resource-total").length === 1);
    check(await test.locator("#resourceSummary .resource-total").count() === 1, "Currency filter updates summaries");
    check(requestURLs.at(-1).billing_currency === "eur" && requestURLs.at(-1).page === "1", "Currency is a server filter");
    await test.locator('[data-resource-filter="change"]').selectOption("no-baseline");
    await test.waitForFunction(() => document.querySelector("#resourceResultCount").textContent.startsWith("8 matching"));
    check((await test.locator("#resourceResults tbody").textContent()).includes("No prior spend"), "Zero prior cost is not labelled as a newly created resource");
    await test.locator("#resourceSearch").fill("cannot match any resource");
    await test.getByRole("heading", { name: "No matching resources" }).waitFor();
    await test.locator("#resourceClear").click();
    check(await test.locator("#resourceSearch").evaluate(element => element === document.activeElement), "Clear filters retains keyboard flow");
    await settled();
    const beforeLocal = requests;
    await test.locator('[data-resource-filter="tags"]').selectOption("recorded");
    check(requests === beforeLocal, "Explicitly page-local tag evidence does not fetch the estate");
    check((await test.locator("#resourceResultCount").textContent()).startsWith("45 matching"), "Page-local tags never rewrite matching totals");
    await test.locator('[data-resource-filter="tags"]').selectOption("");
    await test.locator("#resourceSearch").fill("vm-1");
    await test.waitForFunction(() => document.querySelector("#resourceRequestStatus").textContent.includes("Loading"));
    await test.locator("#resourceSearch").fill("vm-44");
    await test.waitForFunction(() => document.querySelector("#resourceResultCount").textContent.startsWith("1 matching"));
    await test.waitForTimeout(800);
    check((await test.locator("#resourceResults tbody").textContent()).includes("vm-44") &&
      (await test.locator("#resourceResultCount").textContent()).startsWith("1 matching"), "Superseded delayed search cannot replace the latest response");
    await test.locator('[data-days="7"]').click();
    await ready();
    await test.locator("#resourceExplorer").waitFor();
    check(requestURLs.at(-1).days === "7" && requestURLs.at(-1).page === "1" && !requestURLs.at(-1).q,
      "Global period changes request an independent first page with reset local filters");
    for (const theme of ["light", "dark", "vivid"]) {
      await test.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const width of [1600, 1200, 800, 390]) {
        await test.setViewportSize({ width, height: 1000 });
        const result = await test.evaluate(() => {
          const cards = [...document.querySelectorAll("#resourceSummary .kpi")].map(card => card.getBoundingClientRect());
          const spread = key => Math.max(...cards.map(card => card[key])) - Math.min(...cards.map(card => card[key]));
          return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
            uneven: spread("width") > 1 || spread("height") > 1,
            clippedControls: [...document.querySelectorAll(".resource-toolbar input,.resource-toolbar select")].some(element => {
              const box = element.getBoundingClientRect(); return box.left < 0 || box.right > innerWidth + 1;
            }) };
        });
        check(!result.overflow && !result.uneven && !result.clippedControls, JSON.stringify({ theme, width, ...result }));
        layouts.push({ theme, width, ...result });
      }
    }
    mode = "partial";
    await open();
    check((await test.locator("#resourceExplorer .banner").textContent()).includes("Partial results"), "Truncated results stay visible");
    mode = "empty";
    await open();
    await test.getByRole("heading", { name: "No resource cost records" }).waitFor();
    check((await test.locator("#resourceSummary .kpi .v").first().textContent()) === "0", "Empty result has an explicit zero resource count");
    check(errors.length === 0, errors.join("\n"));
    return { passed, layouts, requests, errors };
  } finally {
    await context.close();
  }
}
