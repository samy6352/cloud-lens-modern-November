import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { AdvisorScorePanel } from "@/components/AdvisorScore";
import { PageHeader } from "@/components/blocks";
import { Card } from "@/components/ui/card";
import { ADVISOR_PILLARS, advisorScore, advisorScoreDate, advisorScoreQuery, type AdvisorScoreReport } from "@/lib/advisor-score";

export function AdvisorScoreTable({ data }: { data: AdvisorScoreReport }) {
  return <Card className="overflow-hidden">
    <div className="border-b border-border px-3 py-2">
      <h3 className="text-sm font-semibold">Per-subscription scores</h3>
      <p className="mt-1 text-[11px] text-muted">Percentages from Azure, 0–100. Each cell shows its source timestamp (UTC), not the browser fetch time.</p>
    </div>
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">Azure Advisor scores and source timestamps by subscription and pillar</caption>
        <thead className="bg-surface-2 text-muted"><tr>
          <th scope="col" className="px-3 py-2 font-medium">Subscription / coverage</th>
          {ADVISOR_PILLARS.map(p => <th scope="col" className="px-3 py-2 font-medium" key={p.category}>{p.label}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-border">{data.subscriptions.map(subscription => {
          const available = subscription.status === "error" ? 0 : ADVISOR_PILLARS.filter(({ category }) =>
            advisorScore(subscription.pillars.find(p => p.category === category)?.score) !== "Unavailable").length;
          const partial = subscription.status !== "ok" || available < ADVISOR_PILLARS.length;
          return <tr key={subscription.subscription_id}>
          <th scope="row" className="max-w-64 px-3 py-2 align-top font-normal">
            <span className="block break-words font-medium">{subscription.subscription_id}</span>
            <span className={partial ? "text-warn" : "text-muted"}>{subscription.status === "error" ? "Error · scores unavailable" : partial ? "Partial coverage" : "Available"} · {available}/5 pillars</span>
            {subscription.error && <span className="mt-1 block break-words text-warn">{subscription.error}</span>}
          </th>
          {ADVISOR_PILLARS.map(({ category }) => {
            const pillar = subscription.pillars.find(p => p.category === category);
            const score = subscription.status === "error" ? "Unavailable" : advisorScore(pillar?.score);
            return <td className="px-3 py-2 align-top" key={category}>
              <span className="num block font-medium">{score}</span>
              <span className="mt-1 block whitespace-nowrap text-[10px] text-muted">{advisorScoreDate(pillar?.date)}</span>
            </td>;
          })}
        </tr>;
        })}</tbody>
      </table>
    </div>
    {!data.subscriptions.length && <p className="px-3 py-3 text-xs text-muted">No subscription scores returned. This is unavailable evidence, not a perfect or zero score.</p>}
  </Card>;
}

export function AdvisorScorePage() {
  const search = useSearch({ from: "__root__" });
  const query = useQuery(advisorScoreQuery(search.scope));
  return <div className="min-w-0">
    <PageHeader title="Advisor Score" subtitle="Review five pillars and subscription-level evidence in the selected scope." />
    <AdvisorScorePanel details />
    {!query.isError && query.data && <AdvisorScoreTable data={query.data} />}
  </div>;
}
