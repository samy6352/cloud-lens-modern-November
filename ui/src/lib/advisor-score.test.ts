import { QueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvisorScoreNotices, AdvisorScoreStrip } from "@/components/AdvisorScore";
import { AdvisorScoreTable } from "@/routes/AdvisorScore";
import { ADVISOR_PILLARS, advisorScore, advisorScoreDate, advisorScoreIncomplete, advisorScoreQuery, type AdvisorScoreReport } from "./advisor-score";

const first = "11111111-1111-1111-1111-111111111111";
const second = "22222222-2222-2222-2222-222222222222";
function report(): AdvisorScoreReport {
  return {
    pillars: ADVISOR_PILLARS.map((p, index) => ({ ...p, score: index === 0 ? 0 : index === 1 ? null : 87.6, available_subscriptions: index === 1 ? 0 : 1, total_subscriptions: 2 })),
    subscriptions: [
      { subscription_id: first, status: "partial", error: null, pillars: ADVISOR_PILLARS.map((p, index) => ({ ...p, score: index === 0 ? 0 : index === 1 ? null : 87.6, date: index === 1 ? null : "2026-11-10T12:30:00Z", impacted_resources: 2, potential_increase: null })) },
      { subscription_id: second, status: "error", error: "Advisor permission denied", pillars: [] },
    ],
    partial: true,
    errors: [{ subscription_id: second, message: "Advisor permission denied" }],
    aggregation: "unweighted_mean",
    note: "Latest Advisor evidence",
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("Advisor Score evidence", () => {
  it("uses Azure percentages as-is and keeps absent/invalid scores unavailable", () => {
    expect(advisorScore(87.6)).toBe("87.6%");
    expect(advisorScore(0.5)).toBe("0.5%");
    expect(advisorScore(0)).toBe("0.0%");
    expect(advisorScore(100)).toBe("100.0%");
    for (const value of [null, undefined, NaN, Infinity, -1, 101]) expect(advisorScore(value)).toBe("Unavailable");
  });
  it("renders all five compact pillars with per-pillar partial and missing coverage", () => {
    const html = renderToStaticMarkup(createElement(AdvisorScoreStrip, { data: report() }));
    for (const pillar of ADVISOR_PILLARS) expect(html).toContain(pillar.label);
    expect(html).toContain("0.0%");
    expect(html).toContain("87.6%");
    expect(html).not.toContain("8760");
    expect(html).toContain("Partial · 1/2 subscriptions");
    expect(html).toContain("Unavailable · 0/2 subscriptions");
    const missing = renderToStaticMarkup(createElement(AdvisorScoreStrip, { data: { ...report(), pillars: [] } }));
    expect(missing.match(/Unavailable · 0\/\? subscriptions/g)).toHaveLength(5);
    expect(missing).not.toContain("100.0%");
    const loading = renderToStaticMarkup(createElement(AdvisorScoreStrip, { loading: true }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("Checking coverage");
  });
  it("renders subscription failures, missing timestamps and source timestamps without substituting fetch time", () => {
    const html = renderToStaticMarkup(createElement(AdvisorScoreTable, { data: report() }));
    expect(html).toContain(first);
    expect(html).toContain(second);
    expect(html).toContain("Partial coverage");
    expect(html).toContain("Error · scores unavailable");
    expect(html).toContain("Advisor permission denied");
    expect(html).toContain("2026-11-10 12:30:00 UTC");
    expect(html).toContain("Timestamp unavailable");
    expect(html).toContain("0.0%");
    expect(advisorScoreDate("bad")).toBe("Timestamp unavailable");
    expect(advisorScoreDate(null)).toBe("Timestamp unavailable");
    const notices = renderToStaticMarkup(createElement(AdvisorScoreNotices, { data: report() }));
    expect(notices).toContain("Missing scores are excluded");
    expect(notices).toContain("Subscription read errors");
    expect(notices).not.toContain("Latest Advisor evidence");
  });
  it("recognizes incomplete coverage even if the top-level partial flag is false", () => {
    expect(advisorScoreIncomplete({ ...report(), partial: false })).toBe(true);
    const complete: AdvisorScoreReport = { ...report(), partial: false, errors: [], subscriptions: [], pillars: ADVISOR_PILLARS.map(p => ({ ...p, score: 100, available_subscriptions: 1, total_subscriptions: 1 })) };
    expect(advisorScoreIncomplete(complete)).toBe(false);
    expect(advisorScoreIncomplete({ ...complete, pillars: complete.pillars.slice(1) })).toBe(true);
  });
  it("partitions only by subscription scope, passing cancellation and no cost/date/currency filters", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(report())));
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const scope = `${first},${second}`;
    await client.fetchQuery(advisorScoreQuery(scope));
    const [url, init] = fetch.mock.calls[0]!;
    const parsed = new URL(url, "http://localhost");
    expect(parsed.pathname).toBe("/api/dashboard/advisor-score");
    expect([...parsed.searchParams.entries()]).toEqual([["scope", scope]]);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(advisorScoreQuery(first).queryKey).not.toEqual(advisorScoreQuery(second).queryKey);
    expect(advisorScoreQuery().queryKey).toEqual(["advisor-score", ""]);
    client.clear();
  });
  it("rejects HTTP and malformed evidence rather than displaying fabricated scores", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{"detail":"Advisor unavailable"}', { status: 503 }))
      .mockResolvedValueOnce(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await expect(client.fetchQuery(advisorScoreQuery(first))).rejects.toThrow("Advisor unavailable");
    await expect(client.fetchQuery(advisorScoreQuery(second))).rejects.toThrow("incomplete evidence");
    client.clear();
  });
  it("cancels superseded scope requests", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    }));
    const client = new QueryClient();
    const options = advisorScoreQuery(first);
    const pending = client.fetchQuery(options).catch(() => undefined);
    await client.cancelQueries({ queryKey: options.queryKey });
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    client.clear();
  });
});
