import { cn } from "@/lib/cn";
import { formatMonth } from "@/lib/format";
import type { ExecutiveView } from "@/lib/queries";

type Money = (value: number | null | undefined, compact?: boolean) => string;

/**
 * What moved between the previous period and this one, service by service. Rising spend is
 * amber and falling spend green, and the words carry the direction too, so colour is never the
 * only signal.
 */
export function ChangeBridge({ view, money }: { view: ExecutiveView; money: Money }) {
  const moved = view.services.filter(s => s.delta != null && s.delta !== 0);
  const ranked = [...moved].sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  const shown = ranked.slice(0, 8);
  const rest = ranked.slice(8);
  const restDelta = rest.reduce((sum, s) => sum + (s.delta ?? 0), 0);
  const largest = Math.max(1, ...shown.map(s => Math.abs(s.delta ?? 0)), Math.abs(restDelta));
  const signed = (value: number) => `${value > 0 ? "+" : ""}${money(value, false)}`;

  return (
    <div>
      <table className="w-full text-sm">
        <caption className="sr-only">Change from the previous period, by service, largest first</caption>
        <thead className="text-xs text-muted">
          <tr className="border-b border-border">
            <th scope="col" className="py-2 pr-3 text-left font-medium">Service</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Change</th>
            <th scope="col" className="w-1/3 py-2 font-medium"><span className="sr-only">Size of change</span></th>
          </tr>
        </thead>
        <tbody>
          {shown.map(row => {
            const delta = row.delta ?? 0;
            return (
              <tr key={row.name} className="border-b border-border">
                <td className="break-words py-2 pr-3">{row.name}</td>
                <td className={cn("num whitespace-nowrap py-2 pr-3 text-right", delta > 0 ? "text-warn" : "text-good")}>
                  {signed(delta)}
                </td>
                <td className="py-2">
                  <span className="block h-2 rounded bg-surface-2" aria-hidden="true">
                    <span className={cn("block h-2 rounded", delta > 0 ? "bg-warn" : "bg-good")}
                      style={{ width: `${(Math.abs(delta) / largest) * 100}%` }} />
                  </span>
                </td>
              </tr>
            );
          })}
          {rest.length > 0 && (
            <tr className="border-b border-border text-muted">
              <td className="py-2 pr-3">All other services ({rest.length})</td>
              <td className="num whitespace-nowrap py-2 pr-3 text-right">{signed(restDelta)}</td>
              <td className="py-2">
                <span className="block h-2 rounded bg-surface-2" aria-hidden="true">
                  <span className={cn("block h-2 rounded", restDelta > 0 ? "bg-warn" : "bg-good")}
                    style={{ width: `${(Math.abs(restDelta) / largest) * 100}%` }} />
                </span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {moved.length === 0 && <p className="py-6 text-center text-sm text-muted">No service changed between the two periods.</p>}
      <p className="mt-3 text-xs text-muted">
        Previous period {money(view.kpis.previous, false)} · this period {money(view.kpis.total, false)}.
        Services that appeared or stopped are included.
      </p>
    </div>
  );
}

/** Each calendar month's total, and how it compares with the month before. */
export function MonthOverMonth({ view, money }: { view: ExecutiveView; money: Money }) {
  const monthly = view.monthly;
  if (!monthly || monthly.months.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">Not enough calendar months yet.</p>;
  }
  const totals = monthly.months.map((_, i) => monthly.areas.reduce((sum, area) => sum + (area.data[i] ?? 0), 0));
  return (
    <div>
      <table className="w-full text-sm">
        <caption className="sr-only">Monthly spend and change from the month before</caption>
        <thead className="text-xs text-muted">
          <tr className="border-b border-border">
            <th scope="col" className="py-2 pr-3 text-left font-medium">Month</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Spend</th>
            <th scope="col" className="py-2 text-right font-medium">Vs month before</th>
          </tr>
        </thead>
        <tbody>
          {monthly.months.map((month, i) => {
            const before = i > 0 ? totals[i - 1] : null;
            const current = totals[i] ?? 0;
            const pct = before != null && before > 0 ? ((current - before) / before) * 100 : null;
            return (
              <tr key={month} className="border-b border-border">
                <th scope="row" className="py-2 pr-3 text-left font-normal">{formatMonth(month)}</th>
                <td className="num whitespace-nowrap py-2 pr-3 text-right">{money(current, false)}</td>
                <td className={cn("num whitespace-nowrap py-2 text-right",
                  pct == null ? "text-muted" : pct > 0 ? "text-warn" : "text-good")}>
                  {pct == null ? (before == null ? "—" : "Not comparable") : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-muted">
        The latest month can still be filling in, so compare it with care.
      </p>
    </div>
  );
}
