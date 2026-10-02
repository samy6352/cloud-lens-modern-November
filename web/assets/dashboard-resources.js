import { railIcon } from "./icons.js";
import { periodName } from "./reporting-period.js";
import { captureInteractions, restoreInteractions } from "./dashboard-state.js";
import { sumCostsByCurrency } from "./cost-totals.js";

const emptyFilters = () => ({ query: "", service: "", change: "", tags: "", currency: "" });
const normalized = value => String(value ?? "").trim().toLowerCase();
const facetKey = value => normalized(value) ? `value:${normalized(value)}` : "missing";
const currencyOf = row => String(row.currency || "").trim().toUpperCase() || "UNKNOWN";
const servicesOf = row => Array.isArray(row.service_names) && row.service_names.length ? row.service_names : [row.service];

export function resourceFacets(rows, field) {
  const values = new Map();
  for (const row of rows) {
    const entries = field === "service" ? servicesOf(row) : [field === "currency" ? currencyOf(row) : row[field]];
    for (const value of entries) values.set(facetKey(value), String(value || "Not recorded"));
  }
  return [...values].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
}

export function resourceChange(row) {
  if (!Number.isFinite(row.cost) || !Number.isFinite(row.prior_cost)) return "unavailable";
  const cents = value => {
    const [mantissa, exponent = "0"] = String(Math.abs(value)).split("e");
    return Math.sign(value) * Math.round(Number(`${mantissa}e${Number(exponent) + 2}`));
  };
  const cost = cents(row.cost), prior = cents(row.prior_cost);
  if (prior === 0) return "no-baseline";
  return cost === prior ? "unchanged" : cost > prior ? "increased" : "decreased";
}

export function filterResources(rows, filters = {}) {
  const query = normalized(filters.query);
  return rows.filter(row => {
    if (filters.service && !servicesOf(row).some(service => facetKey(service) === filters.service)) return false;
    if (filters.currency && facetKey(currencyOf(row)) !== filters.currency) return false;
    if (filters.change && resourceChange(row) !== filters.change) return false;
    const tags = Array.isArray(row.tags) ? row.tags : [];
    if (filters.tags === "recorded" && !tags.length) return false;
    if (filters.tags === "missing" && tags.length) return false;
    return !query || normalized([row.name, row.id, row.resource_group, row.subscription,
      row.subscription_id, ...servicesOf(row), row.area, row.region,
      ...tags.flatMap(tag => [tag.key, tag.value])].join(" ")).includes(query);
  });
}

export function resourceSummary(rows) {
  return {
    resources: new Set(rows.map(row => normalized(row.id))).size,
    groups: new Set(rows.filter(row => row.resource_group).map(row =>
      `${normalized(row.subscription_id || row.subscription)}|${normalized(row.resource_group)}`)).size,
    services: new Set(rows.flatMap(servicesOf).filter(Boolean).map(normalized)).size,
    costs: sumCostsByCurrency(rows),
  };
}

export function createTabs(ctx) {
  const { $, cached, esc, get, key, kpiRow, moneyHtml, portalLinkMarkup, qs, setContent, table, wireTables } = ctx;
  let filters = emptyFilters(), timer = null, pending = false, repaint = null;
  let page = 1, sort = "cost", descending = true, revision = 0, controller = null, currentToken = null;
  const invalidate = () => { revision++; controller?.abort(); };
  const reload = (resetPage = false) => {
    clearTimeout(timer);
    if (resetPage) page = 1;
    pending = true;
    invalidate();
    const root = $("resourceExplorer");
    root?.setAttribute("aria-busy", "true");
    const status = root?.querySelector("#resourceRequestStatus");
    if (status) status.textContent = "Loading matching resources…";
    const token = currentToken;
    const update = renderResources(token);
    const expectedRevision = revision;
    update.catch(error => {
      if (token !== ctx.loadToken || expectedRevision !== revision || error?.name === "AbortError") return;
      const status = $("resourceExplorer")?.querySelector("#resourceRequestStatus");
      if (status) status.textContent = "Resources could not be updated. Displayed rows belong to the previous request. Change filters or use Refresh views to retry.";
      $("resourceExplorer")?.setAttribute("aria-busy", "false");
    });
  };
  const amount = (value, currency) => {
    if (!Number.isFinite(value)) return '<span class="muted">Unavailable</span>';
    return currency === "UNKNOWN"
      ? `${esc(value.toLocaleString(undefined, { maximumFractionDigits: 2 }))} <small class="muted">currency unknown</small>`
      : moneyHtml(value, currency, 2);
  };
  const costTotals = costs => costs.map(total =>
    `<span class="resource-total">${amount(total.amount, total.currency)}${total.missing ? ' <small class="muted">(partial)</small>' : ""}</span>`
  ).join("") || '<span class="muted">No matches</span>';
  const select = (field, label, options) => {
    if (filters[field] && !options.some(option => option.value === filters[field])) {
      options = [...options, { value: filters[field], label: `${filters[field].replace(/^value:/, "")} (not in these results)` }];
    }
    return `<label>${esc(label)}
    <select data-resource-filter="${field}" aria-label="${esc(label)}">
      <option value="">All</option>${options.map(option => `<option value="${esc(option.value)}"${
        filters[field] === option.value ? " selected" : ""}>${esc(option.label)}</option>`).join("")}
    </select></label>`;
  };
  // An absent value reads as a dash with the reason kept for assistive technology, rather than
  // as prose that repeats down the column and outweighs the figures beside it.
  const absent = (reason = "Not recorded") =>
    `<span class="cell-empty" title="${esc(reason)}"><span aria-hidden="true">—</span><span class="sr-only">${esc(reason)}</span></span>`;
  const secondary = text => text
    ? `<span class="resource-secondary" title="${esc(text)}">${esc(text)}</span>`
    : `<span class="resource-secondary">${absent()}</span>`;

  async function renderResources(token) {
    currentToken = token;
    invalidate();
    const requestRevision = revision;
    controller = new AbortController();
    const signal = controller.signal;
    const params = new URLSearchParams(qs().replace(/^\?/, ""));
    const request = { page, page_size: 20, sort, order: descending ? "desc" : "asc",
      q: filters.query.trim(), billing_currency: filters.currency.replace(/^value:/, ""), change: filters.change };
    for (const [name, value] of Object.entries(request)) params.set(name, value);
    const query = `?${params}`;
    const read = () => cached(key(`resources:${query}`), () =>
      get(`/api/dashboard/resources${query}`, { timeout: 45000, signal }));
    let data;
    try { data = await read(); }
    catch (error) {
      // A rapid return to the same page may encounter its cancelled cached promise.
      if (error?.name !== "AbortError" || signal.aborted || requestRevision !== revision) throw error;
      data = await read();
    }
    if (token !== ctx.loadToken || requestRevision !== revision || signal.aborted) return;
    if (!data || !Array.isArray(data.resources) || !Number.isInteger(data.total) ||
        !Number.isInteger(data.page) || !Number.isInteger(data.pages)) {
      throw new Error("Resource data is unavailable or incomplete. Refresh to retry.");
    }
    pending = false;
    controller = null;
    if (data.pages && page > data.pages) { page = data.pages; reload(); return; }
    const rows = data.resources;
    const period = periodName(data.days || ctx.days, ctx.periodMonth);
    const fixed = values => values.map(([value, label]) => ({ value, label }));
    const previous = $("resourceExplorer");
    const interactions = previous ? captureInteractions(previous) : null;
    setContent($("tabBody"), `<div class="resource-explorer" id="resourceExplorer">
      <section class="portal-workbench" aria-label="Resource summary and filters">
      <div class="resource-context"><span>Cost-backed resources</span><span>${esc(period)}</span>
        ${data.as_of ? `<span>Data through ${esc(data.as_of)}</span>` : ""}</div>
      ${data.truncated ? `<p class="banner warn" role="status">Partial results: matching counts and costs cover only the backend's capped results. Narrow the subscription or global filters to see the rest.</p>` : ""}
      ${data.mixed_currency ? '<p class="resource-notice">Multiple currencies: totals stay separate. Select a billing currency to compare resource costs.</p>' : ""}
      <div class="resource-summary" id="resourceSummary"></div>
      <div class="resource-toolbar" role="search" aria-label="Find resources">
        <label class="resource-search">Search resources<input type="search" id="resourceSearch"
          aria-label="Search resources" placeholder="Resource ID, name or resource group in ID"
          maxlength="200" value="${esc(filters.query)}"></label>
        ${select("service", "Service (this page)", resourceFacets(rows, "service"))}
        ${select("change", "Cost change", fixed([["increased", "Increased"], ["decreased", "Decreased"],
          ["unchanged", "Unchanged"], ["no-baseline", "No prior spend"]]))}
        ${select("tags", "Tag evidence (this page)", fixed([["recorded", "Tags recorded"], ["missing", "No tags recorded"]]))}
        ${select("currency", "Billing currency", Object.keys(data.resources_by_currency || {}).map(currency =>
          ({ value: facetKey(currency), label: currency.toUpperCase() })))}
      </div>
      <p class="resource-notice">Search matches the resource ID (including names and groups within it), not tags or subscription display names.
        Service and tag evidence controls narrow only this page; matching counts and costs are unchanged.
        Use the global Service filter to filter services across all resources.
        Period cost and Change headers sort all matches; other columns are not sortable.</p>
      <p id="resourceRequestStatus" role="status" aria-live="polite"></p>
      <div class="resource-result-bar"><span id="resourceResultCount" role="status" aria-live="polite"></span>
        <button type="button" class="ghost" id="resourceClear">Clear filters</button></div>
      </section>
      <div class="resource-results" id="resourceResults"></div>
      <details class="view-help" data-state-key="resource-coverage"><summary>About these resources</summary>
        <p>Resources observed in cost data for the selected and comparison periods, not live Azure inventory.
          Unbilled resources may be absent. Global subscription, period and dimension filters still apply.</p>
        <p>No prior spend means no non-zero baseline, not that a resource was newly created.
          No tags recorded means tags were absent from the loaded cost data, not confirmed missing in Azure.
          Open Details for resource IDs, tags and billing dates.</p>
      </details></div>`);
    const root = $("resourceExplorer");
    const costChange = row => {
      const change = resourceChange(row);
      if (change === "unavailable") return '<span class="muted">Unknown</span>';
      if (change === "no-baseline") return '<span class="muted">No prior spend</span>';
      if (change === "unchanged") return '<span class="delta flat">Unchanged</span>';
      const delta = row.cost - row.prior_cost;
      return `<span class="delta ${delta > 0 ? "up" : "down"}">${delta > 0 ? "+" : "-"}${amount(Math.abs(delta), currencyOf(row))}</span>
        ${secondary(Number.isFinite(row.change_pct) ? `${row.change_pct > 0 ? "+" : ""}${row.change_pct}% vs prior` : "vs prior period")}`;
    };
    repaint = () => {
      if (!root.isConnected) return;
      const filtered = filterResources(rows, { service: filters.service, tags: filters.tags });
      const summary = resourceSummary(filtered);
      const totals = Object.entries(data.total_cost_by_currency || {}).map(([currency, value]) =>
        ({ currency: currency.toUpperCase(), amount: value }));
      const totalMarkup = totals.length ? costTotals(totals) : '<span class="muted">Unavailable</span>';
      setContent(root.querySelector("#resourceSummary"), kpiRow([
        { label: "Resource cost records", value: data.total.toLocaleString(), sub: data.truncated ? "matching capped results; per currency" : "all matches; one record per currency" },
        { label: "Matching period cost", value: totalMarkup, sub: data.truncated ? "matching capped results" : "all matching resource-attributed cost" },
        { label: "Resource groups", value: summary.groups.toLocaleString(), sub: "on this page only" },
        { label: "Services", value: summary.services.toLocaleString(), sub: "on this page only" },
      ]));
      root.querySelector("#resourceResultCount").textContent =
        `${data.total.toLocaleString()} matching resource cost records · Page ${data.pages ? page : 0} of ${data.pages}` +
        ` · ${filtered.length} of ${rows.length} page rows shown`;
      root.querySelector("#resourceClear").disabled = !Object.values(filters).some(Boolean);
      const results = root.querySelector("#resourceResults");
      setContent(results, filtered.length ? table("Resource explorer", filtered, [
        { label: "Resource", value: row => `${row.name} ${row.service || ""}`, cell: row =>
          `<div class="resource-identity"><span class="resource-icon" aria-hidden="true">${railIcon(row.area_id || "resources")}</span>
            <span class="resource-name">${portalLinkMarkup(row, ctx.portalScopeIds(), row.name || row.id)}${secondary(row.service)}</span></div>` },
        { label: "Group / region", value: row => `${row.resource_group || ""} ${row.region || ""}`,
          cell: row => `<span class="resource-primary" title="${esc(row.resource_group || "")}">${row.resource_group ? esc(row.resource_group) : absent()}</span>${secondary(row.region)}` },
        { label: "Subscription", value: row => row.subscription || row.subscription_id || "",
          cell: row => `<span class="resource-primary" title="${esc(row.subscription || row.subscription_id || "")}">${row.subscription || row.subscription_id ? esc(row.subscription || row.subscription_id) : absent()}</span>` },
        { label: "Period cost", num: true, serverSort: "cost", value: row => row.cost, cell: row => amount(row.cost, currencyOf(row)),
          total: () => totalMarkup },
        { label: "Change", num: true, serverSort: "delta", value: row => Number.isFinite(row.cost) && Number.isFinite(row.prior_cost) ? row.cost - row.prior_cost : null,
          cell: costChange },
        { label: "Tags", value: row => Array.isArray(row.tags) ? row.tags.length : 0,
          cell: row => Array.isArray(row.tags) && row.tags.length ? `<span class="resource-tag-count">${row.tags.length} ${row.tags.length === 1 ? "tag" : "tags"}</span>`
            : absent("No tags recorded") },
      ], null, { key: "resource-explorer", pageSize: 20, search: false, scroll: false, highlightOutliers: false,
        server: { page, total: data.total, sort, descending, onChange: next => {
          page = next.page;
          if (next.sort) { sort = next.sort; descending = next.descending; }
          reload();
        } } })
        : `<section class="card resource-empty"><h3>${data.total ? "No matching rows on this page" : Object.values(filters).some(Boolean) ? "No matching resources" : "No resource cost records"}</h3>
          <p class="muted">${data.total || Object.values(filters).some(Boolean) ? "Change or clear the resource filters to broaden the results." :
            "No resource-attributed cost records were found for the selected scope and periods. Review the global filters or load cost data."}</p></section>`);
      if (!filtered.length && data.pages > 1) {
        results.insertAdjacentHTML("beforeend", `<div class="pager"><span class="pager-count">Page ${page} of ${data.pages}</span>
          <span class="pager-btns"><button type="button" data-resource-page="-1"${page === 1 ? " disabled" : ""}>Previous</button>
          <button type="button" data-resource-page="1"${page >= data.pages ? " disabled" : ""}>Next</button></span></div>`);
        for (const button of results.querySelectorAll("[data-resource-page]")) button.onclick = () => {
          page += Number(button.dataset.resourcePage); reload();
        };
      }
      wireTables(results);
    };
    root.querySelector("#resourceSearch").oninput = event => {
      filters.query = event.target.value;
      page = 1;
      clearTimeout(timer);
      pending = true;
      invalidate();
      timer = setTimeout(() => reload(true), 250);
    };
    for (const control of root.querySelectorAll("[data-resource-filter]")) {
      control.onchange = () => {
        clearTimeout(timer);
        filters[control.dataset.resourceFilter] = control.value;
        if (["service", "tags"].includes(control.dataset.resourceFilter)) {
          if (pending) reload(true);
          else repaint();
        } else reload(true);
      };
    }
    root.querySelector("#resourceClear").onclick = () => {
      clearTimeout(timer);
      filters = emptyFilters();
      root.querySelector("#resourceSearch").value = "";
      for (const control of root.querySelectorAll("[data-resource-filter]")) control.value = "";
      reload(true);
      root.querySelector("#resourceSearch").focus();
    };
    repaint();
    // Restore once both the controls and the shared table's expanded rows exist.
    restoreInteractions(root, interactions);
  }
  return { renderResources, stop: () => { clearTimeout(timer); invalidate(); },
    resume: token => { currentToken = token; if (pending) reload(); } };
}
