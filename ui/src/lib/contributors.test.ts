import { describe, expect, it } from "vitest";
import { forCurrency, type DayContributors } from "./contributors";

const mixed: DayContributors = {
  day: "2026-10-02",
  prior_day: "2026-10-01",
  dimension: "service",
  mixed_currency: true,
  totals: [
    { currency: "USD", cost: 60, prior: 40 },
    { currency: "EUR", cost: 20, prior: 0 },
  ],
  contributors: [
    { name: "Virtual Machines", currency: "USD", cost: 45, prior: 20, delta: 25, change_pct: 125, share_pct: 75 },
    { name: "Storage", currency: "EUR", cost: 20, prior: 0, delta: 20, change_pct: null, share_pct: 100 },
  ],
  other: [{ currency: "USD", cost: 15, prior: 20, count: 2 }],
};

describe("forCurrency", () => {
  it("keeps only the chart's currency, so a day is never added across currencies", () => {
    const usd = forCurrency(mixed, "USD");
    expect(usd.mixed_currency).toBe(false);
    expect(usd.totals).toEqual([{ currency: "USD", cost: 60, prior: 40 }]);
    expect(usd.contributors.map(c => c.name)).toEqual(["Virtual Machines"]);
    expect(usd.other).toEqual([{ currency: "USD", cost: 15, prior: 20, count: 2 }]);
  });

  it("leaves a single-currency day untouched", () => {
    const single: DayContributors = { ...mixed, mixed_currency: false, totals: [mixed.totals[0]!], contributors: [mixed.contributors[0]!], other: [] };
    expect(forCurrency(single, "EUR")).toBe(single);
  });

  it("keeps every currency when no single currency is chosen", () => {
    expect(forCurrency(mixed, null)).toBe(mixed);
  });
});
