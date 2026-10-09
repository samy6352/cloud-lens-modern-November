import { describe, expect, it } from "vitest";
import { validateGlobalSearch } from "../router";
import { executiveQuery, windowDays } from "./queries";

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
});
