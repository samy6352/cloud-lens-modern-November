import { describe, expect, it } from "vitest";
import type { Ranked } from "@/lib/queries";
import { orderCurrencyViews, regionLabel, regionSpendModel } from "./RegionSpendModel";

function row(name: string, cost: number): Ranked {
  return { name, cost, previous: null, delta: null, change_pct: null, share_pct: null };
}

describe("regional spend safety", () => {
  it("orders currencies by code, never by monetary magnitude or an estate sum", () => {
    const views = [{ currency: "USD", regions: [row("West", 2)] }, { currency: "INR", regions: [row("South", 2000)] }];
    expect(orderCurrencyViews(views).map((view) => view.currency)).toEqual(["INR", "USD"]);
    expect(regionSpendModel(views[0]!.regions, "USD").net).toBe(2);
    expect(views[0]!.currency).toBe("USD");
  });
  it("preserves credits and net financial identity without drawing a negative pie", () => {
    const model = regionSpendModel([row("East", 100), row("Adjustment", -20)], "USD");
    expect(model.net).toBe(80);
    expect(model.credits).toBe(-20);
    expect(model.ranked[1]!.cost).toBe(-20);
    expect(model.canDistribute).toBe(false);
    expect(model.segments).toEqual([]);
  });
  it("does not turn unavailable cost into zero or a misleading partial total", () => {
    const missing = regionSpendModel([row("Missing", Number.NaN), row("Known", 50)], "USD");
    expect(missing.net).toBeNull();
    expect(missing.canDistribute).toBe(false);
    const zero = regionSpendModel([row("Zero", 0)], "USD");
    expect(zero.net).toBe(0);
    expect(zero.canDistribute).toBe(false);
  });
  it("has no pie for empty data and safely retains unknown currency", () => {
    const model = regionSpendModel([], null);
    expect(model.currency).toBeNull();
    expect(model.ranked).toEqual([]);
    expect(model.canDistribute).toBe(false);
  });
  it("groups only the positive tail, preserving the complete returned total", () => {
    const model = regionSpendModel(Array.from({ length: 8 }, (_, i) => row(`Region ${i}`, i)), "EUR");
    expect(model.segments).toHaveLength(6);
    expect(model.segments.at(-1)!.name).toBe("Other reported regions");
    expect(model.segments.reduce((sum, segment) => sum + segment.value, 0)).toBe(model.net);
  });
  it("keeps full long labels for table and tooltip, and names unspecified locations", () => {
    const name = "A very long actual billing location ".repeat(5);
    expect(regionLabel(row(name, 1))).toBe(name.trim());
    expect(regionLabel(row("", 1))).toBe("Unspecified region");
  });
});
