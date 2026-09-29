import { describe, expect, it } from "vitest";
import { currencySymbol, formatDelta, formatMoney, formatMonth, formatNumber } from "./format";

describe("formatNumber", () => {
  it("groups the Indian way when asked", () => {
    expect(formatNumber(123456789, { system: "indian" })).toBe("12,34,56,789");
    expect(formatNumber(123456789, { system: "international" })).toBe("123,456,789");
  });

  it("uses lakh and crore in the compact Indian form", () => {
    expect(formatNumber(12_345_678, { system: "indian", compact: true })).toBe("1.23 Cr");
    expect(formatNumber(456_000, { system: "indian", compact: true })).toBe("4.56 L");
    expect(formatNumber(2_500_000_000, { system: "indian", compact: true })).toBe("250 Cr");
  });

  it("uses K/M/B in the compact international form", () => {
    expect(formatNumber(12_345_678, { compact: true })).toBe("12.3M");
    expect(formatNumber(999, { compact: true })).toBe("999");
    expect(formatNumber(1_000, { compact: true })).toBe("1K");
  });

  it("keeps cents below 100 and drops them above", () => {
    expect(formatNumber(12.5)).toBe("12.50");
    expect(formatNumber(1234.56)).toBe("1,235");
  });

  it("renders missing values as an em dash, never as 0", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(Number.NaN)).toBe("—");
  });
});

describe("formatMoney", () => {
  it("prefixes the currency symbol and keeps the sign outside it", () => {
    expect(formatMoney(1500000, "INR", { system: "indian", compact: true })).toBe("₹15 L");
    expect(formatMoney(-42.1, "USD")).toBe("-$42.10");
  });

  it("falls back to no symbol for a missing currency", () => {
    expect(currencySymbol("")).toBe("");
    expect(formatMoney(10, null)).toBe("10.00");
  });
});

describe("formatDelta", () => {
  it("is signed and null without a base", () => {
    expect(formatDelta(110, 100)).toBe("+10%");
    expect(formatDelta(95, 100)).toBe("-5.0%");
    expect(formatDelta(5, 0)).toBeNull();
  });
});

describe("formatMonth", () => {
  it("names the month", () => {
    expect(formatMonth("2026-09")).toBe("Sep 2026");
    expect(formatMonth("latest")).toBe("latest");
  });
});
