import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { anomalyDirection, canSimulate, csvCell, metricValue, nativeBuckets, nativeMoney, observedTokens, optimizeQuery, performanceScope, validateOptimizeReport, whatIfBody } from "./optimize-queries";

const id = "11111111-1111-1111-1111-111111111111";
const vm = `/subscriptions/${id}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm`;
afterEach(() => vi.unstubAllGlobals());
describe("Optimize evidence contracts", () => {
  it("requires an explicit 1–100 subscription performance scope", () => {
    expect(performanceScope("").error).toContain("1–100");
    expect(performanceScope(id).error).toBeNull();
    expect(performanceScope(`${id},${id}`).ids).toEqual([id]);
    expect(performanceScope("all").error).toContain("valid");
    const large = Array.from({ length: 101 }, (_, i) => `${String(i).padStart(8, "0")}-1111-1111-1111-111111111111`).join(",");
    expect(performanceScope(large).error).toContain("1–100");
  });
  it("keeps unknown, unsupported, partial and measured zero distinct", () => {
    expect(metricValue({ status: "unavailable", value: 0 })).toBe("Unavailable");
    expect(metricValue({ status: "no_data", value: null })).toBe("No observations");
    expect(metricValue({ status: "unsupported", value: null })).toBe("Not supported");
    expect(metricValue({ status: "not_applicable", value: null }, true)).toBe("Not applicable");
    expect(metricValue({ status: "partial", value: 0 }, true)).toBe("0.0%");
    expect(metricValue({ status: "ok", value: 30203, unit: "tokens" })).toBe("30,203 tokens");
    expect(metricValue({ status: "ok", value: 12.5, unit: "ms" })).toBe("12.500 ms");
    expect(nativeMoney(null, "USD")).toBe("Unavailable");
    expect(nativeMoney(0, null)).toContain("currency unknown");
    expect(nativeMoney(10, "USD")).toContain("USD");
    expect(nativeMoney(10, "INR")).toContain("INR");
  });
  it("counts observed tokens once and preserves partial measurement coverage", () => {
    const rows = [
      { tokens: { value: 50, input: 20, output: 30, status: "ok" } },
      { tokens: { value: null, status: "unavailable" } },
      { tokens: { value: 0, status: "partial" } },
    ];
    expect(observedTokens(rows)).toEqual({ value: 50, measured: 2, total: 3, partial: true });
    expect(observedTokens([rows[1]!]).value).toBeNull();
    expect(anomalyDirection({ anomalies: [{ direction: "up" }, { direction: "down" }] })).toBe("Spike and drop");
  });
  it("guards read-only what-if against missing SKU and unsupported resource types", () => {
    expect(canSimulate(vm)).toBe(true);
    expect(canSimulate(vm.replace("virtualMachines", "disks"))).toBe(false);
    expect(() => whatIfBody(vm, " ")).toThrow("valid target");
    expect(() => whatIfBody(vm, "<script>")).toThrow("valid target");
    expect(whatIfBody(vm, " Standard_B2s ")).toEqual({ resource_id: vm, target_sku: "Standard_B2s" });
    expect(whatIfBody(vm, "shutdown").target_sku).toBe("shutdown");
  });
  it("preserves scope and actual evidence API window parameters", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "partial", resources: [], notices: [], window: {}, generated_at: "2026-10-03T00:00:00Z" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient();
    await client.fetchQuery(optimizeQuery("performance", { scope: id, month: "2026-08" }, { window_days: 14 }));
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toContain("window_days=14");
    expect(url).toContain(`scope=${id}`);
    expect(url).not.toContain("month=");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(optimizeQuery("performance", { scope: id }, { window_days: 7 }).queryKey).not.toEqual(optimizeQuery("performance", { scope: id }, { window_days: 14 }).queryKey);
  });
  it("aborts superseded scope requests rather than painting stale evidence", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    }));
    const client = new QueryClient();
    const options = optimizeQuery("performance", { scope: id }, { window_days: 7 });
    const pending = client.fetchQuery(options).catch(() => undefined);
    await client.cancelQueries({ queryKey: options.queryKey });
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
  });
  it("does not hide unavailable HTTP evidence as empty rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Azure Monitor permission denied" }), { status: 502 })));
    const client = new QueryClient();
    await expect(client.fetchQuery(optimizeQuery("performance", { scope: id }, { window_days: 7 }))).rejects.toThrow("Azure Monitor permission denied");
  });
  it("escapes CSV cells and neutralizes spreadsheet formulas", () => {
    expect(csvCell('a,"b')).toBe('"a,""b"');
    expect(csvCell("=SUM(1,1)")).toBe('"\'=SUM(1,1)"');
  });
  it("retains native currency buckets and rejects incomplete source responses", () => {
    expect(nativeBuckets({ USD: 10, INR: 500 }, null, null)).toContain("USD");
    expect(nativeBuckets({ USD: 10, INR: 500 }, null, null)).toContain("INR");
    expect(() => validateOptimizeReport("ai-billing", { services: [] })).toThrow("incomplete evidence");
    expect(() => validateOptimizeReport("performance", { status: "unavailable", resources: [], notices: [], window: {}, generated_at: "2026-10-03" })).not.toThrow();
  });
});
