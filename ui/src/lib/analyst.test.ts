import { describe, expect, it } from "vitest";
import {
  analystKey,
  answerBlocks,
  askFailure,
  claimsSaving,
  sortFindings,
  suggestedQuestions,
  takeEvents,
  toolLabel,
  type Finding,
} from "./analyst";

const finding = (over: Partial<Finding>): Finding => ({
  kind: "waste",
  title: "Idle VM",
  detail: "",
  impact: 10,
  currency: "USD",
  impact_period: "month",
  severity: "medium",
  confidence: "high",
  evidence: [],
  action: null,
  tab: null,
  caveat: null,
  because: null,
  risk: null,
  effort: null,
  steps: [],
  ...over,
});

describe("takeEvents", () => {
  it("reads complete frames and their event names", () => {
    const { events, rest } = takeEvents('event: delta\ndata: {"text":"Hi"}\n\nevent: done\ndata: {"messages":[]}\n\n');
    expect(events.map(e => e.type)).toEqual(["delta", "done"]);
    expect(events[0]!.data).toEqual({ text: "Hi" });
    expect(rest).toBe("");
  });

  it("keeps an unfinished frame for the next chunk", () => {
    const first = takeEvents('event: delta\ndata: {"text":"Hel');
    expect(first.events).toEqual([]);
    const second = takeEvents(first.rest + 'lo"}\n\n');
    expect(second.events[0]!.data).toEqual({ text: "Hello" });
  });

  it("drops a malformed frame without losing the ones after it", () => {
    const { events } = takeEvents('event: delta\ndata: {bad\n\nevent: delta\ndata: {"text":"ok"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ text: "ok" });
  });

  it("defaults the event type when none is named", () => {
    expect(takeEvents('data: {"a":1}\n\n').events[0]!.type).toBe("message");
  });
});

describe("sortFindings", () => {
  it("puts the most severe first, then the largest impact within a severity", () => {
    const sorted = sortFindings([
      finding({ title: "low-big", severity: "low", impact: 900 }),
      finding({ title: "crit-small", severity: "critical", impact: 5 }),
      finding({ title: "medium-unknown", severity: "medium", impact: null }),
      finding({ title: "medium-big", severity: "medium", impact: 50 }),
    ]);
    expect(sorted.map(f => f.title)).toEqual(["crit-small", "medium-big", "medium-unknown", "low-big"]);
  });

  it("does not mutate its input", () => {
    const input = [finding({ severity: "low" }), finding({ severity: "critical" })];
    sortFindings(input);
    expect(input[0]?.severity).toBe("low");
  });
});

describe("suggestedQuestions", () => {
  it("leads with the most urgent finding by name", () => {
    const [first] = suggestedQuestions([finding({ title: "Old disks", severity: "high" })]);
    expect(first).toContain("Old disks");
  });

  it("still offers useful questions when there are no findings", () => {
    const questions = suggestedQuestions([]);
    expect(questions.length).toBeGreaterThanOrEqual(2);
    expect(questions.every(q => q.endsWith("?"))).toBe(true);
  });

  it("never offers more than four", () => {
    expect(suggestedQuestions([finding({})]).length).toBeLessThanOrEqual(4);
  });
});

describe("analystKey", () => {
  it("changes with the period, scope, window and currency", () => {
    const base = analystKey({ month: "2026-09", scope: "a", days: 30, currency: "USD" });
    expect(analystKey({ month: "2026-08", scope: "a", days: 30, currency: "USD" })).not.toEqual(base);
    expect(analystKey({ month: "2026-09", scope: "b", days: 30, currency: "USD" })).not.toEqual(base);
    expect(analystKey({ month: "2026-09", scope: "a", days: 7, currency: "USD" })).not.toEqual(base);
    expect(analystKey({ month: "2026-09", scope: "a", days: 30, currency: "EUR" })).not.toEqual(base);
  });

  it("ignores unrelated search parameters", () => {
    expect(analystKey({ month: "2026-09", scope: "a", days: 30, currency: "USD" })).toEqual(
      analystKey({ month: "2026-09", scope: "a", days: 30, currency: "USD" }),
    );
  });
});

describe("claimsSaving", () => {
  it("claims a saving only for a positive amount", () => {
    expect(claimsSaving({ impact: 12 })).toBe(true);
    expect(claimsSaving({ impact: 0 })).toBe(false);
    expect(claimsSaving({ impact: null })).toBe(false);
  });
});

describe("tool labels", () => {
  it("reads like a person would, with an unknown tool still named sensibly", () => {
    expect(toolLabel("query_costs")).toBe("Checked costs");
    expect(toolLabel("some_new_tool")).toBe("Some new tool");
  });
});

describe("answerBlocks", () => {
  it("separates paragraphs from bullet lists", () => {
    const blocks = answerBlocks("Spend rose.\n\n- Compute: $40\n- Storage: $6");
    expect(blocks).toEqual([
      { kind: "p", lines: ["Spend rose."] },
      { kind: "ul", lines: ["Compute: $40", "Storage: $6"] },
    ]);
  });

  it("strips heading markers and keeps markup as plain text", () => {
    const [block] = answerBlocks("## Summary\n<script>alert(1)</script>");
    expect(block!.lines).toEqual(["Summary", "<script>alert(1)</script>"]);
  });
});

describe("askFailure", () => {
  it("tells a signed-out person to sign in", () => {
    expect(askFailure(401, "")).toMatch(/Sign in/);
  });

  it("uses the server's reason for a refusal", () => {
    expect(askFailure(403, "No subscriptions are visible to you.")).toBe("No subscriptions are visible to you.");
  });

  it("does not expose server errors", () => {
    expect(askFailure(502, "stack trace here")).not.toContain("stack");
  });
});
