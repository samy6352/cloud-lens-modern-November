import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { ADVISOR_PILLARS, advisorScore, advisorScoreIncomplete, advisorScoreQuery, type AdvisorScoreReport } from "@/lib/advisor-score";
import { cn } from "@/lib/cn";
import { ErrorState } from "./blocks";
import { Card } from "./ui/card";

export const ADVISOR_SCORE_CONTEXT = "Live latest Azure Advisor data · independent of cost, date and currency filters.";

export function AdvisorScoreStrip({ data, loading = false, compact = false }: { data?: AdvisorScoreReport; loading?: boolean; compact?: boolean }) {
  return <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5" aria-label="Five Advisor pillar scores" aria-busy={loading}>
    {ADVISOR_PILLARS.map(({ category, label }) => {
      const pillar = data?.pillars.find(p => p.category === category);
      const score = advisorScore(pillar?.score);
      const available = pillar?.available_subscriptions ?? 0;
      const total = pillar?.total_subscriptions;
      const coverage = score === "Unavailable" || !available ? "Unavailable" : total != null && available < total ? "Partial" : "Available";
      return <div key={category} className={cn("min-w-0 bg-surface", compact ? "px-2 py-1" : "px-3 py-2")}>
        <div className="text-[11px] font-medium text-muted">{pillar?.label || label}</div>
        <div className={cn(compact && "flex flex-wrap items-baseline gap-x-1.5")}>
          <div className={cn("num font-semibold", compact ? "text-sm" : "mt-0.5 text-base")}>{loading ? "Loading…" : score}</div>
          <div className={cn("text-[11px] text-muted", !compact && "mt-0.5", compact && coverage === "Available" && "sr-only")}>{loading ? "Checking coverage…" : `${coverage} · ${available}/${total ?? "?"} subscriptions`}</div>
        </div>
      </div>;
    })}
  </div>;
}

/** Shared by Overview and the detail route; only subscription scope partitions this live query. */
export function AdvisorScorePanel({ details = false }: { details?: boolean }) {
  const search = useSearch({ from: "__root__" });
  const query = useQuery(advisorScoreQuery(search.scope));
  return <section aria-label="Advisor Score" className={details ? "mb-3 space-y-2" : "space-y-1"}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-sm font-semibold">Advisor Score{details && " · five pillars"}</h3>
        {!details && <span className="text-[11px] text-muted" title={ADVISOR_SCORE_CONTEXT}>Live Azure data · subscription scope only</span>}
      </div>
      {!details && <Link to="/optimize/advisor-score" search={search} className="text-xs font-medium text-accent hover:underline">View subscription scores →</Link>}
      {details && <button type="button" className="text-xs font-medium text-accent hover:underline disabled:opacity-50" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? "Refreshing…" : "Refresh scores"}</button>}
    </div>
    {details && <p className="text-xs text-muted">{ADVISOR_SCORE_CONTEXT}</p>}
    {query.isError ? details ? <><ErrorState error={query.error} onRetry={() => void query.refetch()} /><p className="text-xs text-muted">Scores unavailable: Advisor evidence could not be loaded.</p><AdvisorScoreStrip /></> :
      <p className="text-xs text-muted">Scores unavailable. <button type="button" className="font-medium text-accent hover:underline" onClick={() => void query.refetch()}>Retry Advisor scores</button></p> :
      <AdvisorScoreStrip data={query.data} loading={query.isPending} compact={!details} />}
    {query.data && !query.isError && <AdvisorScoreNotices data={query.data} />}
  </section>;
}

export function AdvisorScoreNotices({ data }: { data: AdvisorScoreReport }) {
  return <div className="space-y-1 text-xs text-muted" role="status">
    {advisorScoreIncomplete(data) && <p className="text-warn">Partial or unavailable coverage. Missing scores are excluded from averages, never treated as 0% or 100%.</p>}
    {!data.subscriptions.length && <p>No subscription score evidence was returned for this scope.</p>}
    {!!data.errors.length && <Card className="px-3 py-2"><p className="font-medium">Subscription read errors</p><ul className="mt-1 space-y-1">{data.errors.map((error, index) => <li className="break-words" key={`${error.subscription_id}-${index}`}>{error.subscription_id}: {error.message}</li>)}</ul></Card>}
  </div>;
}
