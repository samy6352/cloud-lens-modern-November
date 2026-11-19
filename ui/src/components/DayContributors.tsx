import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { ErrorState, Segmented } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatMoney, formatNumber } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import {
  DIMENSION_LABEL,
  dayContributorsQuery,
  forCurrency,
  type Contributor,
  type Dimension,
  type DayTotal,
} from "@/lib/contributors";
import type { Scope } from "@/lib/queries";

export function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    : day;
}

function changeText(row: Pick<Contributor, "cost" | "prior" | "change_pct">): { text: string; tone: string } {
  if (row.change_pct != null) {
    const sign = row.change_pct > 0 ? "+" : "";
    return { text: `${sign}${row.change_pct.toFixed(1)}%`, tone: row.change_pct > 0 ? "text-warn" : "text-good" };
  }
  if (row.prior === 0 && row.cost > 0) return { text: "New", tone: "text-muted" };
  if (row.cost === 0 && row.prior > 0) return { text: "Stopped", tone: "text-muted" };
  return { text: "No change", tone: "text-muted" };
}

export function DayContributorsPanel({
  scope,
  day,
  currency,
  partial,
  currentOnly = false,
  dimension: sharedDimension,
  onClose,
}: {
  scope: Scope;
  day: string;
  /** The currency the chart is showing; rows are limited to it. */
  currency: string | null;
  partial: boolean;
  currentOnly?: boolean;
  dimension?: Dimension;
  onClose?: () => void;
}) {
  const [localDimension, setDimension] = useState<Dimension>("service");
  const dimension = sharedDimension ?? localDimension;
  const titleId = useId();
  const { numbers } = usePrefs();
  const query = useQuery(dayContributorsQuery(scope, day, dimension, currentOnly));
  const data = useMemo(() => {
    if (!query.data) return null;
    if (!currentOnly) return forCurrency(query.data, currency);
    const matches = (row: { currency: string | null }) =>
      currency == null || (row.currency ?? "unknown") === currency;
    const contributors = query.data.contributors.filter(matches);
    const other = query.data.other.filter(matches);
    const currencies = new Set([...contributors, ...other].map(row => row.currency));
    return { ...query.data, contributors, other, mixed_currency: currencies.size > 1,
      totals: query.data.totals.filter(row => currencies.has(row.currency)) };
  }, [query.data, currency, currentOnly]);
  const money = (value: number | null | undefined, code: string | null) =>
    value == null || !Number.isFinite(value) ? "Unavailable" : formatMoney(value, code, { system: numbers });

  const topByCurrency = new Map<string | null, number>();
  const totalsByCurrency = new Map(data?.totals.map(row => [row.currency, row.cost]));
  for (const row of data?.contributors ?? []) {
    topByCurrency.set(row.currency, Math.max(topByCurrency.get(row.currency) ?? 0, row.cost));
  }

  return (
    <section aria-labelledby={titleId} className="mt-3 min-w-0 border-t border-border pt-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={titleId} className="text-sm font-semibold">Top contributors on {dayLabel(day)}</h3>
          {data && (
            <p className="text-xs text-muted">
              {currentOnly ? "Reported charges" : `Compared with ${dayLabel(data.prior_day ?? day)}`}
              {partial ? currentOnly ? " · billing coverage for this date is not verified" : " · this day is partial, so totals are not complete" : ""}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {sharedDimension == null && <Segmented
            label="Group contributors by"
            value={dimension}
            onChange={setDimension}
            options={(Object.keys(DIMENSION_LABEL) as Dimension[]).map(value => ({ value, label: DIMENSION_LABEL[value] }))}
          />}
          {onClose && <Button variant="ghost" size="icon" aria-label="Close day details" onClick={onClose}>
            <X />
          </Button>}
        </div>
      </div>

      {query.isPending ? (
        <div className="mt-3 space-y-2" aria-busy="true" aria-label="Loading contributors">
          {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-8 w-full" />)}
        </div>
      ) : query.error ? (
        <div className="mt-3">
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : !data || (data.contributors.length === 0 && data.other.length === 0) ? (
        <p className="mt-3 text-sm text-muted">{sharedDimension == null
          ? "No spend was recorded on this day for the selected scope."
          : "No non-zero contributors were found for this grouping."}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          {data.mixed_currency && (
            <p className="mb-2 text-xs text-muted">Billing currencies are shown separately and never added together.</p>
          )}
          <table className="w-full text-sm">
            <caption className="sr-only">Contributors on {dayLabel(day)}, largest first</caption>
            <thead className="text-xs text-muted">
              <tr className="border-b border-border">
                <th scope="col" className="py-2 pr-3 text-left font-medium">{DIMENSION_LABEL[dimension]}</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Spend that day</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Share</th>
                {!currentOnly && <th scope="col" className="py-2 text-right font-medium">Vs day before</th>}
              </tr>
            </thead>
            <tbody>
              {data.contributors.map((row, i) => {
                const change = changeText(row);
                const top = topByCurrency.get(row.currency) ?? 0;
                const width = top > 0 && row.cost > 0 ? Math.max(2, (row.cost / top) * 100) : 0;
                return (
                  <tr key={`${row.name}-${row.currency}-${i}`} className="border-b border-border align-top">
                    <td className="py-2 pr-3">
                      <span className="block break-words font-medium">{row.name}</span>
                      <span className="mt-1 block h-1 rounded bg-surface-2" aria-hidden="true">
                        <span className="block h-1 rounded bg-accent" style={{ width: `${width}%` }} />
                      </span>
                    </td>
                    <td className="num whitespace-nowrap py-2 pr-3 text-right">{money(row.cost, row.currency)}</td>
                    <td className="num whitespace-nowrap py-2 pr-3 text-right">
                      {row.share_pct == null ? "—" : `${row.share_pct.toFixed(1)}%`}
                    </td>
                    {!currentOnly && <td className={cn("num whitespace-nowrap py-2 text-right", change.tone)}>
                      {change.text}
                      <span className="sr-only">
                        {" "}— {money(row.prior, row.currency)} the day before
                      </span>
                    </td>}
                  </tr>
                );
              })}
              {data.other.map((row, i) => (
                <tr key={`other-${row.currency}-${i}`} className="border-b border-border text-muted">
                  <td className="py-2 pr-3">Other ({formatNumber(row.count, { system: numbers, digits: 0 })})</td>
                  <td className="num whitespace-nowrap py-2 pr-3 text-right">{money(row.cost, row.currency)}</td>
                  <td className="num whitespace-nowrap py-2 pr-3 text-right">
                    {totalsByCurrency.get(row.currency) ? `${((row.cost / totalsByCurrency.get(row.currency)!) * 100).toFixed(1)}%` : "—"}
                  </td>
                  {!currentOnly && <td className="py-2 text-right">{changeText({ ...row, change_pct: row.prior ? ((row.cost - row.prior) / row.prior) * 100 : null }).text}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              {data.totals.map((t: DayTotal) => (
                <tr key={`total-${t.currency}`} className="font-medium">
                  <th scope="row" className="py-2 pr-3 text-left">Total for the day</th>
                  <td className="num whitespace-nowrap py-2 pr-3 text-right">{money(t.cost, t.currency)}</td>
                  <td className="num py-2 pr-3 text-right">{t.cost === 0 ? "—" : "100%"}</td>
                  {!currentOnly && <td className="num whitespace-nowrap py-2 text-right text-muted">
                    Before: {money(t.prior, t.currency)}
                  </td>}
                </tr>
              ))}
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
