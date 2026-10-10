import { describe, expect, it } from "vitest";
import { validateGlobalSearch } from "../router";
import { formatRange, periodParam, rangeDays, validRange } from "./period";
import { executiveQuery, tagsQuery, uptimeQuery, windowDays } from "./queries";

describe("global window and currency", () => {
  it("keeps only the offered windows and never writes the 30-day default", () => {
    expect(validateGlobalSearch({ days: "7" }).days).toBe(7);
    expect(validateGlobalSearch({ days: 90 }).days).toBe(90);
    expect(validateGlobalSearch({ days: "30" }).days).toBeUndefined();
    expect(validateGlobalSearch({ days: "45" }).days).toBeUndefined();
    expect(validateGlobalSearch({ days: "abc" }).days).toBeUndefined();
  });

  it("accepts only three-letter currency codes and upper-cases them", () => {
    expect(validateGlobalSearch({ currency: "eur" }).currency).toBe("EUR");
    expect(validateGlobalSearch({ currency: "EURO" }).currency).toBeUndefined();
    expect(validateGlobalSearch({ currency: "E1R" }).currency).toBeUndefined();
  });

  it("partitions the cache by window and currency", () => {
    expect(windowDays({})).toBe(30);
    const base = executiveQuery({}).queryKey;
    expect(executiveQuery({ days: 7 }).queryKey).not.toEqual(base);
    expect(executiveQuery({ currency: "EUR" }).queryKey).not.toEqual(base);
  });

  it("accepts a real, ordered range of at most 366 days and nothing else", () => {
    expect(validRange("2026-08-01", "2026-08-20")).toBe(true);
    expect(validRange("2026-08-20", "2026-08-20")).toBe(true);
    expect(validRange("2026-08-20", "2026-08-01")).toBe(false);
    expect(validRange("2026-02-30", "2026-03-01")).toBe(false);
    expect(validRange("2026-08-01", undefined)).toBe(false);
    expect(validRange("2024-12-31", "2026-01-01")).toBe(false);
    expect(validRange("2025-01-01", "2026-01-01")).toBe(true);
    expect(rangeDays("2024-02-01", "2024-02-29")).toBe(29);
  });

  it("sends a range, or a month, as the single period_month value and the month wins", () => {
    expect(periodParam({ from: "2026-08-01", to: "2026-08-20" })).toBe("2026-08-01..2026-08-20");
    expect(periodParam({ month: "2026-07", from: "2026-08-01", to: "2026-08-20" })).toBe("2026-07");
    expect(periodParam({ from: "2026-08-20", to: "2026-08-01" })).toBeUndefined();
    expect(periodParam({})).toBeUndefined();
  });

  it("drops half a range, a range beside a month, and the window beside a range from the URL", () => {
    const half = validateGlobalSearch({ from: "2026-08-01" });
    expect([half.from, half.to]).toEqual([undefined, undefined]);
    const both = validateGlobalSearch({ month: "2026-07", from: "2026-08-01", to: "2026-08-20" });
    expect([both.month, both.from, both.to]).toEqual(["2026-07", undefined, undefined]);
    const ranged = validateGlobalSearch({ days: "7", from: "2026-08-01", to: "2026-08-20" });
    expect([ranged.days, ranged.from, ranged.to]).toEqual([undefined, "2026-08-01", "2026-08-20"]);
  });

  it("partitions every window-driven query by the selected range", () => {
    const range = { from: "2026-08-01", to: "2026-08-20" };
    for (const make of [executiveQuery, (s: typeof range) => tagsQuery(s), (s: typeof range) => uptimeQuery(s)]) {
      expect(make(range).queryKey).not.toEqual(make({} as typeof range).queryKey);
    }
  });

  it("labels a range compactly", () => {
    expect(formatRange("2026-08-01", "2026-08-20")).toBe("1 Aug – 20 Aug 2026");
    expect(formatRange("2025-12-20", "2026-01-10")).toBe("20 Dec 2025 – 10 Jan 2026");
  });
});
