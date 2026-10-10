async (page) => {
  const origin = page.url().match(/^https?:\/\/[^/]+/)?.[0];
  if (!origin) throw new Error("Open local CloudLens before responsive checks.");
  const context = await page.context().browser().newContext({
    storageState: await page.context().storageState(),
    viewport: { width: 1440, height: 960 }, hasTouch: true, reducedMotion: "reduce",
  });
  const test = await context.newPage(), errors = [], layouts = [];
  let requests = 0;
  test.on("pageerror", error => errors.push(error.message));
  const rows = Array.from({ length: 45 }, (_, index) => ({
    id: `/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/demo/providers/Microsoft.Compute/virtualMachines/vm-${index}`,
    name: `vm-${index}`, resource_group: "demo", region: "eastus", subscription: "Demo",
    service: "Virtual Machines", currency: "USD", cost: index, prior_cost: index / 2, tags: [],
  }));
  try {
    await context.route("**/api/dashboard/resources?**", route => {
      requests++;
      const params = new URL(route.request().url()).searchParams;
      const page = Number(params.get("page")), pageSize = Number(params.get("page_size"));
      const matches = rows.filter(row => row.id.toLowerCase().includes((params.get("q") || "").toLowerCase()));
      const direction = params.get("order") === "asc" ? 1 : -1;
      const value = row => params.get("sort") === "delta" ? row.cost - row.prior_cost : row.cost;
      matches.sort((a, b) => (value(a) - value(b)) * direction);
      return route.fulfill({ json: { resources: matches.slice((page - 1) * pageSize, page * pageSize),
        days: 30, page, page_size: pageSize, pages: Math.ceil(matches.length / pageSize), total: matches.length,
        total_cost_by_currency: matches.length ? { USD: matches.reduce((sum, row) => sum + row.cost, 0) } : {},
        resources_by_currency: matches.length ? { USD: matches.length } : {} } });
    });
    await test.goto(origin);
    await test.waitForFunction(() => document.documentElement.dataset.dashboardReady === "true", null, { timeout: 120000 });
    const tab = test.locator('#tabs [data-main-section="resources"]');
    const warmed = test.waitForResponse(response => /\/assets\/(?:v\/[^/]+\/)?dashboard-resources\.js$/.test(new URL(response.url()).pathname));
    await tab.hover();
    await warmed;
    if (requests) throw new Error("Hover preloading started a data request.");
    await test.keyboard.press("Escape");
    await tab.click();
    await test.waitForFunction(() => document.documentElement.dataset.dashboardReady === "true");
    for (const theme of ["light", "dark", "vivid"]) {
      await test.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const width of [600, 390, 320]) {
        await test.setViewportSize({ width, height: 844 });
        const result = await test.evaluate(async () => {
          const scroll = document.querySelector("#resourceResults .table-wrap");
          scroll.scrollLeft = 0;
          const cell = scroll.querySelector("tr[data-explore-row] > td:first-child");
          const before = cell.getBoundingClientRect().left;
          scroll.scrollLeft = 300;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const control = document.querySelector("#resourceSearch");
          const buttons = [...document.querySelectorAll("#resourceResults .pager button")];
          return {
            width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1,
            compact: matchMedia("(max-width: 620px)").matches,
            pinnedName: Math.abs(before - cell.getBoundingClientRect().left) < 2,
            inputFont: parseFloat(getComputedStyle(control).fontSize),
            inputHeight: control.getBoundingClientRect().height,
            buttonHeights: buttons.map(button => button.getBoundingClientRect().height),
          };
        });
        if (result.overflow || !result.pinnedName || result.inputFont < 16
          || result.inputHeight < 39 || result.buttonHeights.some(height => height < 39)) {
          throw new Error(JSON.stringify({ theme, ...result }));
        }
        layouts.push({ theme, ...result });
      }
    }
    if (requests !== 1 || errors.length) throw new Error(JSON.stringify({ requests, errors }));
    return { modulePreloadWithoutData: true, requests, layouts, errors };
  } finally {
    await context.close();
  }
}
