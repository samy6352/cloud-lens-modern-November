import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { Check, CircleAlert, Clock, Copy, Download, LoaderCircle, Minus, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ErrorState, KpiTile, PageHeader } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatNumber } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { meQuery, setupProgressQuery, type SetupBlocker, type SetupProgress, type SetupState } from "@/lib/queries";

const STATE_STYLE: Record<SetupState, { icon: LucideIcon; label: string; cell: string }> = {
  loaded: { icon: Check, label: "Loaded", cell: "bg-good/15 text-good ring-good/30" },
  landed: { icon: Download, label: "Importing", cell: "bg-accent/15 text-accent ring-accent/30" },
  running: { icon: LoaderCircle, label: "Generating", cell: "bg-accent/10 text-accent ring-accent/25" },
  queued: { icon: Clock, label: "Queued", cell: "bg-surface-2 text-muted ring-border" },
  failed: { icon: CircleAlert, label: "Failed", cell: "bg-bad/15 text-bad ring-bad/30" },
  none: { icon: Minus, label: "Not started", cell: "text-muted/60 ring-border ring-dashed" },
};
const LEGEND: SetupState[] = ["loaded", "landed", "running", "queued", "failed", "none"];

function monthLabel(month: string, short = true): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;
  return new Date(Date.UTC(year, index, 1)).toLocaleDateString(undefined, {
    month: short ? "short" : "long",
    year: short ? "2-digit" : "numeric",
    timeZone: "UTC",
  });
}

function FixCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg bg-surface-2 p-2">
      <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed">{command}</code>
      <button
        type="button"
        aria-label="Copy command"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="shrink-0 rounded-md p-1 text-muted hover:bg-surface hover:text-fg"
      >
        {copied ? <Check className="size-4 text-good" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

function Blockers({ data }: { data: SetupProgress }) {
  const perSub = data.subscriptions.filter((s) => s.blockers.length);
  if (!data.deployment_blockers.length && !perSub.length && !data.error) return null;
  const item = (b: SetupBlocker, key: string) => (
    <li key={key} className="py-3 first:pt-0 last:pb-0">
      <p className="text-sm">{b.detail}</p>
      {b.fix && <FixCommand command={b.fix} />}
    </li>
  );
  return (
    <Card className="mb-5 border-warn/40">
      <CardHeader
        title="Needs an administrator"
        subtitle="Setup skips these until fixed and retries automatically every hour. Run each command once in Cloud Shell."
      />
      <CardBody>
        {data.error && <p className="mb-3 text-sm text-bad">Last check failed: {data.error}</p>}
        <ul className="divide-y divide-border">
          {data.deployment_blockers.map((b, i) => item(b, `d${i}`))}
          {perSub.map((s) => (
            <li key={s.id} className="py-3 first:pt-0 last:pb-0">
              <div className="text-xs font-medium text-muted">{s.name}</div>
              <ul>{s.blockers.map((b, i) => item(b, `${s.id}${i}`))}</ul>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function Grid({ data }: { data: SetupProgress }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-1 text-xs">
        <caption className="sr-only">Cost data import progress by subscription and month, newest month first</caption>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-10 bg-surface px-2 py-1 text-left font-medium text-muted">
              Subscription
            </th>
            {data.months.map((month) => (
              <th key={month} scope="col" className="px-1 py-1 text-center font-medium text-muted" title={monthLabel(month, false)}>
                {monthLabel(month)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.subscriptions.map((sub) => (
            <tr key={sub.id}>
              <th scope="row" className="sticky left-0 z-10 max-w-56 truncate bg-surface px-2 py-1 text-left font-medium" title={sub.id}>
                {sub.name}
              </th>
              {data.months.map((month) => {
                const cell = sub.cells[month] ?? { state: "none" as const, detail: "", retry_at: null };
                const style = STATE_STYLE[cell.state];
                const Icon = style.icon;
                const text = `${monthLabel(month, false)}: ${style.label}`;
                return (
                  <td key={month} className="p-0">
                    <div
                      title={cell.detail ? `${text} — ${cell.detail}` : text}
                      className={cn("mx-auto grid size-8 place-items-center rounded-md ring-1 ring-inset", style.cell)}
                    >
                      <Icon aria-hidden className={cn("size-3.5", cell.state === "running" && "animate-spin [animation-duration:2.5s]")} />
                      <span className="sr-only">{style.label}</span>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SetupPage() {
  const search = useSearch({ strict: false }) as { scope?: string };
  const me = useQuery(meQuery);
  const progress = useQuery(setupProgressQuery({ scope: search.scope }));
  const client = useQueryClient();
  const { numbers } = usePrefs();
  const count = (value: number) => formatNumber(value, { system: numbers, digits: 0 });
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const data = progress.data;
  const admin = Boolean(me.data?.user?.admin);

  const checkNow = async () => {
    setChecking(true);
    setNotice(null);
    try {
      const result = await api<{ onboarding?: string[]; skipped?: string; error?: string | null }>("cost-data/bootstrap", undefined, {
        method: "POST",
      });
      setNotice(
        result.skipped ??
          result.error ??
          (result.onboarding?.length
            ? `Setting up ${result.onboarding.length} subscription${result.onboarding.length === 1 ? "" : "s"}.`
            : "Everything visible is already set up."),
      );
      await client.invalidateQueries({ queryKey: ["setup-progress"] });
    } catch (error) {
      setNotice(error instanceof ApiError || error instanceof Error ? error.message : "The check failed.");
    } finally {
      setChecking(false);
    }
  };

  const total = data ? data.subscriptions.length * data.months.length : 0;
  return (
    <div>
      <PageHeader
        title="Cost data setup"
        subtitle={data ? data.expectation : "Exports this deployment creates, and the history it imports."}
        actions={
          admin && data?.enabled ? (
            <Button variant="outline" size="sm" onClick={checkNow} disabled={checking}>
              <RefreshCw className={cn("size-4", checking && "animate-spin")} />
              Check now
            </Button>
          ) : null
        }
      />
      {notice && (
        <p role="status" className="mb-4 text-sm text-muted">
          {notice}
        </p>
      )}
      {progress.isError ? (
        <ErrorState error={progress.error} onRetry={() => progress.refetch()} />
      ) : !data ? (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <KpiTile key={i} label="…" value="" loading />
            ))}
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          {!data.enabled && (
            <Card className="mb-5 p-[var(--cl-pad)] text-sm">
              Automatic export setup is off for this deployment, so nothing is created or imported from here. The installer turns
              it on; until then exports are managed on the{" "}
              <a href="/?tab=settings" className="font-medium text-accent hover:underline">
                Cost data
              </a>{" "}
              page.
            </Card>
          )}
          {admin && <Blockers data={data} />}
          <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiTile index={0} label="Months loaded" value={`${count(data.totals.loaded)} of ${count(total)}`} hint={`${data.subscriptions.length} subscriptions × ${data.months.length} months`} />
            <KpiTile index={1} label="Generating or importing" value={count(data.totals.running + data.totals.landed)} hint={`at most ${data.concurrency} Azure runs at once`} />
            <KpiTile index={2} label="Queued" value={count(data.totals.queued)} hint="newest month first" />
            <KpiTile index={3} label="Failed" value={count(data.totals.failed)} hint={data.totals.failed ? "existing costs are kept" : "none"} />
          </div>
          <Card>
            <CardHeader
              title="Import progress"
              subtitle={`${monthLabel(data.months[data.months.length - 1] ?? data.history.from.slice(0, 7), false)} to ${monthLabel(data.months[0] ?? data.history.to.slice(0, 7), false)}${
                data.checked_at ? ` · checked ${new Date(data.checked_at).toLocaleString()}` : ""
              }`}
            />
            <CardBody>
              {data.subscriptions.length ? <Grid data={data} /> : <p className="text-sm text-muted">No subscriptions are visible to you.</p>}
              <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted" aria-label="Legend">
                {LEGEND.map((state) => {
                  const style = STATE_STYLE[state];
                  const Icon = style.icon;
                  return (
                    <li key={state} className="flex items-center gap-1.5">
                      <span className={cn("grid size-5 place-items-center rounded ring-1 ring-inset", style.cell)}>
                        <Icon aria-hidden className="size-3" />
                      </span>
                      <span>
                        <span className="font-medium text-fg">{style.label}</span> — {data.states[state]}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
