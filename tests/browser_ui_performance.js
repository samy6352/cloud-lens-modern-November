async (page) => {
  const origin = page.url().match(/^https?:\/\/[^/]+/)?.[0];
  if (!origin) throw new Error("Open the local CloudLens app before performance checks.");
  const context = await page.context().browser().newContext({
    storageState: await page.context().storageState(),
    viewport: { width: 1440, height: 960 }, reducedMotion: "reduce",
  });
  const test = await context.newPage();
  const errors = [];
  let resourceRequests = 0;
  const rows = Array.from({ length: 8000 }, (_, index) => ({
    id: `/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/team-production-rg/providers/Microsoft.Compute/virtualMachines/resource-${index}`,
    name: `resource-${index}`, resource_group: "team-production-rg", subscription: "Subscription One",
    subscription_id: "11111111-1111-4111-8111-111111111111", region: "eastus",
    service: index % 2 ? "Virtual Machines" : "Storage", area: "Compute", currency: "USD",
    cost: index, prior_cost: index / 2, tags: [{ key: "owner", value: `team-${index % 20}` }],
  }));
  test.on("pageerror", error => errors.push(error.message));
  try {
    await context.route("**/api/dashboard/resources?**", route => {
      resourceRequests++;
      const params = new URL(route.request().url()).searchParams;
      const page = Number(params.get("page")), pageSize = Number(params.get("page_size"));
      const matches = rows.filter(row => row.id.toLowerCase().includes((params.get("q") || "").toLowerCase()));
      const direction = params.get("order") === "asc" ? 1 : -1;
      const value = row => params.get("sort") === "delta" ? row.cost - row.prior_cost : row.cost;
      matches.sort((a, b) => (value(a) - value(b)) * direction);
      return route.fulfill({ json: { resources: matches.slice((page - 1) * pageSize, page * pageSize),
        days: 30, as_of: "2026-09-08", page, page_size: pageSize,
        pages: Math.ceil(matches.length / pageSize), total: matches.length,
        total_cost_by_currency: matches.length ? { USD: matches.reduce((sum, row) => sum + row.cost, 0) } : {},
        resources_by_currency: matches.length ? { USD: matches.length } : {} } });
    });
    await test.goto(origin);
    await test.waitForFunction(() => document.documentElement.dataset.dashboardReady === "true", null, { timeout: 120000 });
    await test.evaluate(() => {
      window.uiNavigations = [];
      window.addEventListener("cl:dashboard-performance", event => window.uiNavigations.push(event.detail));
    });
    await test.locator('#tabs [data-main-section="resources"]').click();
    await test.waitForFunction(() => document.documentElement.dataset.dashboardReady === "true");
    const measureSearch = async query => test.evaluate(query => new Promise((resolve, reject) => {
      const input = document.querySelector("#resourceSearch");
      const body = document.querySelector("#tabBody");
      const start = performance.now();
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Search did not repaint")); }, 10000);
      const observer = new MutationObserver(() => {
        const count = document.querySelector("#resourceResultCount");
        if (!count || document.querySelector("#resourceSearch")?.value !== query ||
            document.querySelector("#resourceExplorer")?.getAttribute("aria-busy") === "true") return;
        observer.disconnect();
        clearTimeout(timeout);
        requestAnimationFrame(() => requestAnimationFrame(() =>
          resolve({ query, ms: performance.now() - start, count: count.textContent })));
      });
      observer.observe(body, { subtree: true, childList: true, characterData: true });
      input.focus();
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }), query);
    const searches = [];
    for (const query of ["resource", "team-1", "", "resource-7", ""]) {
      searches.push(await measureSearch(query));
    }
    await test.locator('#tabs [data-main-section="overview"]').click();
    await test.waitForFunction(() => document.documentElement.dataset.dashboardReady === "true");
    await test.locator('#tabs [data-main-section="resources"]').click();
    await test.waitForFunction(() => document.documentElement.dataset.dashboardReady === "true");
    const result = await test.evaluate(() => ({
      navigations: window.uiNavigations.map(({ tab, cached, total_ms, render_ms, module_ms, api_ms }) =>
        ({ tab, cached, total_ms, render_ms, module_ms, api_ms })),
      displayedRows: document.querySelectorAll("#resourceResults tr[data-explore-row]").length,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    }));
    if (resourceRequests !== 4 || result.displayedRows !== 20 || result.overflow || errors.length) {
      throw new Error(JSON.stringify({ resourceRequests, ...result, errors }));
    }
    return { ...result, searches, resourceRequests, errors };
  } finally {
    await context.close();
  }
}
