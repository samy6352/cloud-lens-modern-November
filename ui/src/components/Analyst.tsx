import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { Dialog } from "radix-ui";
import { ChevronDown, RefreshCw, Send, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { ApiError } from "@/lib/api";
import {
  analystKey,
  answerBlocks,
  AskFailure,
  askStream,
  CONFIDENCE_LABEL,
  insightsQuery,
  sortFindings,
  SEVERITY_LABEL,
  suggestedQuestions,
  toolLabel,
  type AnalystMessage,
  type Finding,
  type InsightsResponse,
  type StreamEvent,
  type ToolStatus,
} from "@/lib/analyst";
import { formatMoney } from "@/lib/format";
import type { Scope } from "@/lib/queries";
import { usePrefs } from "@/lib/prefs";

const PERIOD_WORD: Record<string, string> = { year: "per year", month: "per month" };

function impactText(f: Finding, numbers: ReturnType<typeof usePrefs>["numbers"]): string {
  if (f.impact == null) return "Not estimated";
  return `${formatMoney(f.impact, f.currency, { system: numbers })} ${PERIOD_WORD[f.impact_period ?? ""] ?? "in this window"}`;
}

function describeScope(s: Scope): string {
  const parts: string[] = [];
  parts.push(s.month ? s.month : `Last ${s.days ?? 30} days`);
  parts.push(s.currency ? s.currency : "Native currencies");
  parts.push(s.scope ? `${s.scope.split(",").length} subscription(s)` : "All subscriptions");
  return parts.join(" · ");
}

export function AnalystButton() {
  const scope = useSearch({ from: "__root__" }) as Scope;
  const query = useQuery({ ...insightsQuery(scope) });
  const [open, setOpen] = useState(false);
  const count = query.data?.findings?.length;

  return (
    <Analyst scope={scope} query={query} open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="outline" size="md" aria-label={count != null ? `Analyst, ${count} findings` : "Analyst"} className="order-2 shrink-0">
          <span>Analyst</span>
          {count != null && (
            <span className="num rounded bg-surface-2 px-1.5 text-xs font-medium text-muted" aria-hidden="true">
              {count}
            </span>
          )}
        </Button>
      </Dialog.Trigger>
    </Analyst>
  );
}

function Analyst({
  scope,
  query,
  open,
  onOpenChange,
  children,
}: {
  scope: Scope;
  query: UseQueryResult<InsightsResponse, Error>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { numbers } = usePrefs();
  const [messages, setMessages] = useState<AnalystMessage[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const key = analystKey(scope).join("|");

  // Answers describe one period, scope and currency. Changing any of them starts a fresh conversation.
  useEffect(() => {
    controller.current?.abort();
    setMessages([]);
    setHistory([]);
    setBusy(false);
  }, [key]);

  // Analysis is requested by opening the panel, never on page load, because it reads many sources.
  useEffect(() => {
    if (open && !query.data && !query.isFetching) void query.refetch();
  }, [open, query]);

  useEffect(() => {
    if (!query.isFetching) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [query.isFetching]);

  const findings = useMemo(() => sortFindings(query.data?.findings ?? []), [query.data]);
  const questions = useMemo(() => suggestedQuestions(findings), [findings]);

  const patchLast = (update: (m: Extract<AnalystMessage, { role: "assistant" }>) => AnalystMessage) =>
    setMessages(prev => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === "assistant") next[next.length - 1] = update(last);
      return next;
    });

  const handle = (event: StreamEvent) => {
    if (event.type === "delta") {
      const text = String(event.data.text ?? "");
      patchLast(m => ({ ...m, text: m.text + text }));
    } else if (event.type === "tool") {
      const tool: ToolStatus = {
        id: String(event.data.id ?? event.data.name ?? Math.random()),
        name: String(event.data.name ?? "lookup"),
        status: String(event.data.status ?? "running"),
      };
      patchLast(m => ({ ...m, tools: [...m.tools.filter(t => t.id !== tool.id), tool] }));
    } else if (event.type === "error") {
      patchLast(m => ({ ...m, error: String(event.data.message ?? "The answer was interrupted.") }));
    } else if (event.type === "done") {
      setHistory(Array.isArray(event.data.messages) ? event.data.messages : []);
    }
  };

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setDraft("");
    setMessages(prev => [...prev, { role: "user", text }, { role: "assistant", text: "", tools: [], done: false }]);
    try {
      await askStream({ question: text, history, scope, signal: abort.signal, onEvent: handle });
    } catch (err) {
      if (abort.signal.aborted) patchLast(m => ({ ...m, error: "Stopped before the answer finished." }));
      else if (err instanceof AskFailure || err instanceof ApiError) patchLast(m => ({ ...m, error: err.message }));
      else patchLast(m => ({ ...m, error: "Connection lost. Check your network and try again." }));
    } finally {
      patchLast(m => ({ ...m, done: true }));
      setBusy(false);
      controller.current = null;
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(draft);
  };

  const askAbout = (f: Finding) => {
    setDraft(`Which resources are behind "${f.title}", and what has each cost?`);
    composer.current?.focus();
  };

  const status = query.isFetching
    ? `Reading every source… ${elapsed}s. This usually takes 20 to 30 seconds.`
    : query.error
      ? "The analysis could not finish."
      : query.data
        ? `${findings.length} ${findings.length === 1 ? "finding" : "findings"}`
        : "";

  return (
    <Dialog.Root open={open} onOpenChange={next => {
      if (!next) controller.current?.abort();
      onOpenChange(next);
    }}>
      {children}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          aria-describedby="analyst-status"
          className="fixed inset-0 z-50 flex min-h-0 flex-col bg-surface outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[min(640px,100vw)] sm:border-l sm:border-border sm:shadow-2xl"
        >
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold tracking-tight">Analyst</Dialog.Title>
              <p className="mt-0.5 truncate text-xs text-muted">{describeScope(scope)}</p>
              <p id="analyst-status" role="status" aria-live="polite" className="mt-1 text-xs text-muted">{status}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="icon" aria-label="Run the analysis again" title="Run the analysis again"
                disabled={query.isFetching} onClick={() => void query.refetch()}>
                <RefreshCw className={cn(query.isFetching && "animate-spin")} />
              </Button>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close analyst">
                  <X />
                </Button>
              </Dialog.Close>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <section aria-labelledby="analyst-findings" className="px-4 py-4 sm:px-5">
              <h2 id="analyst-findings" className="text-sm font-semibold">Findings</h2>
              {query.isPending && query.fetchStatus !== "idle" ? (
                <div className="mt-3 space-y-2" aria-hidden="true">
                  {[0, 1, 2].map(i => <div key={i} className="h-12 animate-pulse rounded bg-surface-2" />)}
                </div>
              ) : query.error ? (
                <div className="mt-3 rounded border border-border p-3 text-sm" role="alert">
                  <p>{query.error instanceof Error ? query.error.message : "The analysis could not finish."}</p>
                  <Button className="mt-2" size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
                </div>
              ) : findings.length === 0 && query.data ? (
                <p className="mt-3 text-sm text-muted">Nothing stood out for this period and scope.</p>
              ) : findings.length > 0 ? (
                <FindingsTable findings={findings} numbers={numbers} onAsk={askAbout} />
              ) : null}
              {/* Caveats live on each finding, shown when that finding is expanded. */}
            </section>

            <section aria-labelledby="analyst-ask" className="border-t border-border px-4 py-4 sm:px-5">
              <h2 id="analyst-ask" className="text-sm font-semibold">Ask about this period</h2>
              {messages.length === 0 && (
                <ul className="mt-2 divide-y divide-border border-y border-border text-sm">
                  {questions.map(q => (
                    <li key={q}>
                      <button type="button" className="w-full py-2 text-left hover:text-accent disabled:opacity-50"
                        disabled={busy} onClick={() => void ask(q)}>
                        {q}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 space-y-4">
                {messages.map((m, i) => m.role === "user" ? (
                  <p key={i} className="rounded bg-surface-2 px-3 py-2 text-sm"><span className="sr-only">You asked: </span>{m.text}</p>
                ) : (
                  <AnswerView key={i} message={m} />
                ))}
              </div>
            </section>
          </div>

          <form onSubmit={onSubmit} className="shrink-0 border-t border-border bg-surface px-4 py-3 sm:px-5">
            <label htmlFor="analyst-question" className="sr-only">Ask a question about this period</label>
            <div className="flex items-end gap-2">
              <textarea
                id="analyst-question"
                ref={composer}
                rows={2}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void ask(draft);
                  }
                }}
                placeholder="Ask about spend, savings or changes…"
                className="min-h-10 flex-1 resize-none rounded border border-border bg-surface px-3 py-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-accent"
              />
              {busy ? (
                <Button variant="outline" onClick={() => controller.current?.abort()} aria-label="Stop the answer">
                  <Square /> <span className="hidden sm:inline">Stop</span>
                </Button>
              ) : (
                <Button variant="primary" type="submit" disabled={!draft.trim()} aria-label="Send question">
                  <Send /> <span className="hidden sm:inline">Send</span>
                </Button>
              )}
            </div>
            <p className="mt-1 text-xs text-muted">Enter sends · Shift+Enter starts a new line</p>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FindingsTable({
  findings,
  numbers,
  onAsk,
}: {
  findings: Finding[];
  numbers: ReturnType<typeof usePrefs>["numbers"];
  onAsk: (f: Finding) => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <table className="mt-2 w-full text-sm">
      <caption className="sr-only">Findings, most urgent first</caption>
      <thead className="text-xs text-muted">
        <tr className="border-b border-border">
          <th scope="col" className="py-2 pr-3 text-left font-medium">Finding</th>
          <th scope="col" className="py-2 text-right font-medium">Impact</th>
        </tr>
      </thead>
      <tbody>
        {findings.map((f, i) => {
          const isOpen = expanded === i;
          return (
            <FindingRow key={`${f.kind}-${f.title}-${i}`} finding={f} index={i} open={isOpen} numbers={numbers}
              onToggle={() => setExpanded(isOpen ? null : i)} onAsk={() => onAsk(f)} />
          );
        })}
      </tbody>
    </table>
  );
}

function FindingRow({ finding: f, index, open, numbers, onToggle, onAsk }: {
  finding: Finding; index: number; open: boolean; numbers: ReturnType<typeof usePrefs>["numbers"];
  onToggle: () => void; onAsk: () => void;
}) {
  const detailId = `analyst-finding-${index}`;
  return (
    <>
      <tr className="border-b border-border align-top">
        <td className="py-3 pr-3">
          <button type="button" aria-expanded={open} aria-controls={detailId} onClick={onToggle}
            className="flex w-full min-w-0 items-start gap-2 text-left">
            <ChevronDown className={cn("mt-0.5 size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden="true" />
            <span className="min-w-0">
              <span className="block font-medium">{f.title}</span>
              <span className="mt-0.5 block text-xs text-muted">
                {SEVERITY_LABEL[f.severity] ?? f.severity} · {CONFIDENCE_LABEL[f.confidence] ?? f.confidence}
              </span>
            </span>
          </button>
        </td>
        <td className="num whitespace-nowrap py-3 text-right text-sm">{impactText(f, numbers)}</td>
      </tr>
      {open && (
        <tr id={detailId} className="border-b border-border">
          <td colSpan={2} className="pb-4 pl-6 pr-1 text-sm">
            {f.detail && <p>{f.detail}</p>}
            {f.because && <p className="mt-2 text-muted"><span className="font-medium text-fg">Why: </span>{f.because}</p>}
            {f.action && <p className="mt-2"><span className="font-medium">Next: </span>{f.action}</p>}
            {f.steps.length > 0 && (
              <ol className="mt-2 list-decimal space-y-1 pl-5">{f.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
            )}
            {f.risk && <p className="mt-2 text-muted"><span className="font-medium text-fg">Risk: </span>{f.risk}</p>}
            {f.caveat && <p className="mt-2 text-xs text-muted">{f.caveat}</p>}
            {f.evidence.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-xs">
                  <caption className="sr-only">Evidence for {f.title}</caption>
                  <tbody>
                    {f.evidence.slice(0, 8).map((e, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="py-1 pr-2">{String(e.name ?? e.problem ?? e.key ?? e.resource ?? e.day ?? "Item")}</td>
                        <td className="num py-1 text-right">
                          {typeof (e.cost ?? e.savings ?? e.spend) === "number"
                            ? formatMoney(Number(e.cost ?? e.savings ?? e.spend), f.currency, { system: numbers })
                            : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Button className="mt-3" size="sm" variant="outline" onClick={onAsk}>Ask about this</Button>
          </td>
        </tr>
      )}
    </>
  );
}

function AnswerView({ message }: { message: Extract<AnalystMessage, { role: "assistant" }> }) {
  const blocks = answerBlocks(message.text);
  return (
    <div className="text-sm">
      {message.tools.length > 0 && (
        <ul className="mb-2 space-y-0.5 text-xs text-muted">
          {message.tools.map(t => (
            <li key={t.id}>{toolLabel(t.name)}: {t.status === "done" ? "done" : t.status === "failed" ? "failed" : "checking…"}</li>
          ))}
        </ul>
      )}
      {blocks.map((b, i) => b.kind === "ul" ? (
        <ul key={i} className="mb-2 list-disc space-y-1 pl-5">{b.lines.map((l, j) => <li key={j}>{l}</li>)}</ul>
      ) : (
        <div key={i} className="mb-2 space-y-1">{b.lines.map((l, j) => <p key={j}>{l}</p>)}</div>
      ))}
      {!message.done && !message.text && !message.error && <p className="text-muted">Thinking…</p>}
      {message.error && <p role="alert" className="text-muted">{message.error}</p>}
    </div>
  );
}
