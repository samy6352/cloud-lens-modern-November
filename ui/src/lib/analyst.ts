import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";
import { periodParam } from "./period";
import type { Scope } from "./queries";

export type Severity = "critical" | "high" | "medium" | "low";

export interface Finding {
  kind: string;
  title: string;
  detail: string;
  impact: number | null;
  currency: string | null;
  impact_period: string | null;
  severity: Severity | string;
  confidence: string;
  evidence: Array<Record<string, unknown>>;
  action: string | null;
  tab: string | null;
  caveat: string | null;
  because: string | null;
  risk: string | null;
  effort: string | null;
  steps: string[];
}

export interface InsightsResponse {
  findings: Finding[];
  currency?: string | null;
  days?: number;
  status?: string;
  detail?: string;
}

export type AnalystMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; tools: ToolStatus[]; error?: string; done: boolean };

export interface ToolStatus {
  id: string;
  name: string;
  status: string;
}

export interface StreamEvent {
  type: string;
  data: Record<string, unknown>;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Labels say what to do, not just how bad something is. */
export const SEVERITY_LABEL: Record<string, string> = {
  critical: "Act now",
  high: "High impact",
  medium: "Worth doing",
  low: "Minor",
};

export const CONFIDENCE_LABEL: Record<string, string> = {
  high: "Measured",
  medium: "Strong signal",
  low: "Needs judgement",
};

/** Most urgent first; within a severity, the largest saving first, with unknown amounts last. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const rank = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (rank !== 0) return rank;
    return (b.impact ?? -Infinity) - (a.impact ?? -Infinity);
  });
}

/** Questions that fit the estate, starting with the most urgent finding. */
export function suggestedQuestions(findings: Finding[]): string[] {
  const top = sortFindings(findings)[0];
  const questions = top ? [`Which resources are behind "${top.title}"?`] : [];
  questions.push(
    "What changed in spend this period, and why?",
    "What should I fix first, and what would it save?",
    "Which subscriptions carry the most cost?",
  );
  return questions.slice(0, 4);
}

/**
 * Split a streamed body into complete server-sent events. A frame can arrive in pieces, so the
 * unfinished tail is returned to be joined with the next chunk. Malformed frames are dropped rather
 * than ending the answer.
 */
export function takeEvents(buffer: string): { events: StreamEvent[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: StreamEvent[] = [];
  for (const frame of parts) {
    let type = "message";
    const lines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) type = line.slice(7).trim();
      else if (line.startsWith("data: ")) lines.push(line.slice(6));
    }
    if (!lines.length) continue;
    try {
      const data = JSON.parse(lines.join("\n")) as Record<string, unknown>;
      events.push({ type, data });
    } catch {
      /* skip a malformed frame; the rest of the answer still arrives */
    }
  }
  return { events, rest };
}

/** Everything the analyst depends on, so a change to any of it refetches and resets the conversation. */
export function analystKey(s: Scope) {
  return [periodParam(s) ?? "", s.scope ?? "", s.days ?? 30, s.currency ?? ""] as const;
}

export const insightsQuery = (s: Scope) =>
  queryOptions({
    queryKey: ["analyst-insights", ...analystKey(s)],
    // Reads several Azure sources and takes tens of seconds, so it runs only when asked for.
    queryFn: ({ signal }) =>
      api<InsightsResponse>(
        "insights",
        { days: s.days ?? 30, period_month: periodParam(s), scope: s.scope, currency: s.currency },
        { signal },
      ),
    staleTime: 5 * 60_000,
    retry: false,
    enabled: false,
  });

/** What each analysis step means to a person, not the internal tool name. */
const TOOL_LABELS: Record<string, string> = {
  query_costs: "Checked costs",
  render_chart: "Drew a chart",
  warehouse_status: "Checked data freshness",
  find_waste: "Looked for waste",
  vm_utilisation: "Checked VM use",
  advisor_recommendations: "Read Azure Advisor",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
}

/** Plain-language message for a failed question, saying what the person can do next. */
export function askFailure(status: number, detail: string): string {
  if (status === 401) return "Your session has ended. Sign in again to keep asking questions.";
  if (status === 403) return detail || "Your account has no Azure subscriptions to ask about.";
  if (status >= 500) return "The analyst is unavailable right now. Try again in a moment.";
  return detail || `The question could not be answered (${status}).`;
}

/**
 * Ask a question and stream the answer. Events are delivered as they arrive; the promise resolves
 * when the stream ends or the request is aborted. Failures before the stream starts throw an
 * `AskFailure` whose message is already written for a person to read.
 */
export async function askStream(args: {
  question: string;
  history: unknown[];
  scope: Scope;
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}): Promise<void> {
  const search = new URLSearchParams();
  const period = periodParam(args.scope);
  if (period) search.set("period_month", period);
  const scopeIds = (args.scope.scope ?? "").split(",").filter(Boolean);
  const response = await fetch(`/api/ask${search.size ? `?${search}` : ""}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ question: args.question, history: args.history, scope: scopeIds }),
    signal: args.signal,
  });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({}))) as { detail?: string };
    if (response.status === 401) window.location.assign(`/login?next=${encodeURIComponent(location.pathname)}`);
    throw new AskFailure(askFailure(response.status, body.detail ?? ""));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = takeEvents(buffer);
    buffer = rest;
    for (const event of events) args.onEvent(event);
  }
}

export class AskFailure extends Error {}

/** Render an answer's light markup as text: paragraphs and bullet lists, never raw HTML. */
export function answerBlocks(text: string): Array<{ kind: "p" | "ul"; lines: string[] }> {
  const blocks: Array<{ kind: "p" | "ul"; lines: string[] }> = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const lines = paragraph.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines.every(l => /^[-*•]\s+/.test(l))) {
      blocks.push({ kind: "ul", lines: lines.map(l => l.replace(/^[-*•]\s+/, "")) });
    } else {
      blocks.push({ kind: "p", lines: lines.map(l => l.replace(/^#+\s*/, "")) });
    }
  }
  return blocks;
}
