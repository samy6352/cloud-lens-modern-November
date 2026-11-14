import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { ADVISOR_PILLARS, advisorScore, advisorScoreIncomplete, advisorScoreQuery, type AdvisorScoreReport } from "@/lib/advisor-score";
import { ErrorState } from "./blocks";
import { Card } from "./ui/card";

export const ADVISOR_SCORE_CONTEXT = "Live latest Azure Advisor data · independent of cost, date and currency filters.";

export function AdvisorScoreStrip({ data, loading = false }: { data?: AdvisorScoreReport; loading?: boolean }) {
  return <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5" aria-label="Five Advisor pillar scores" aria-busy={loading}>
    {ADVISOR_PILLARS.map(({ category, label }) => {
      const pillar = data?.pillars.find(p => p.category === category);
      const score = advisorScore(pillar?.score);
      const available = pillar?.available_subscriptions ?? 0;
      const total = pillar?.total_subscriptions;
      const coverage = score === "Unavailable" || !available ? "Unavailable" : total != null && available < total ? "Partial" : "Available";
      return <div key={category} className="min-w-0 bg-surface px-3 py-2">
        <div className="text-[11px] font-medium text-muted">{pillar?.label || label}</div>
        <div className="num mt-0.5 text-base font-semibold">{loading ? "Loading…" : score}</div>
        <div className="mt-0.5 text-[11px] text-muted">{loading ? "Checking coverage…" : `${coverage} · ${available}/${total ?? "?"} subscriptions`}</div>
      </div>;
    })}
  </div>;
}

/** Shared by Overview and the detail route; only subscription scope partitions this live query. */
export function AdvisorScorePanel({ details = false }: { details?: boolean }) {
  const search = useSearch({ from: "__root__" });
  const query = useQuery(advisorScoreQuery(search.scope));
  return <section aria-label="Advisor Score" className="mb-3 space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">Advisor Score · five pillars</h3>
      {!details && <Link to="/optimize/advisor-score" search={search} className="text-xs font-medium text-accent hover:underline">View subscription scores →</Link>}
      {details && <button type="button" className="text-xs font-medium text-accent hover:underline disabled:opacity-50" disabled={query.isFetching} onClick={() => void query.refetch()}>{query.isFetching ? "Refreshing…" : "Refresh scores"}</button>}
    </div>
    <p className="text-xs text-muted">{ADVISOR_SCORE_CONTEXT}</p>
    {query.isError ? <><ErrorState error={query.error} onRetry={() => void query.refetch()} /><p className="text-xs text-muted">Scores unavailable: Advisor evidence could not be loaded.</p><AdvisorScoreStrip /></> :
      <AdvisorScoreStrip data={query.data} loading={query.isPending} />}
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
