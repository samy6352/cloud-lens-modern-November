import { Globe2, MapPin } from "lucide-react";
import { useState } from "react";
import { Chart } from "@/components/Chart";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/format";
import { PALETTE } from "@/lib/palette";
import { usePrefs } from "@/lib/prefs";
import type { Ranked } from "@/lib/queries";
import { regionKey, regionLabel, regionSpendModel } from "./RegionSpendModel";

function percent(value: number | null) {
  return value != null && Number.isFinite(value) ? `${value.toFixed(1)}%` : "Unavailable";
}

export function RegionSpend({ rows, currency }: { rows: Ranked[]; currency: string | null }) {
  const { numbers } = usePrefs();
  const [picked, setPicked] = useState<string | null>(null);
  const model = regionSpendModel(rows, currency);
  const top = model.ranked[0];
  const selected = rows.find((row) => regionKey(row) === picked) ?? top;
  const money = (value: number | null | undefined, compact = false) =>
    value == null || !Number.isFinite(value) ? "Unavailable" : formatMoney(value, currency, { system: numbers, compact, digits: compact ? undefined : 2 });
  const bars = model.ranked.slice(0, 8);
  const credits = model.credits < 0;

  return (
    <Card className="mt-4 min-w-0 overflow-hidden">
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><Globe2 className="size-4 text-accent" aria-hidden="true" />Regional spend</span>}
        subtitle={`Billing locations · ${currency ?? "currency unspecified"} · current date and subscription scope`}
      />
      <CardBody>
        {!rows.length ? (
          <div className="rounded-xl border border-dashed border-border bg-surface-2 p-8 text-center">
            <Globe2 className="mx-auto mb-3 size-8 text-muted" aria-hidden="true" />
            <p className="font-medium">No regional spend reported</p>
            <p className="mt-1 text-sm text-muted">Try another period or subscription scope. Missing regional data is not zero spend.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <div className="min-w-0">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-accent/20 bg-accent/5 p-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-muted"><MapPin className="size-3.5" aria-hidden="true" />Highest reported net spend</p>
                    <h3 className="mt-1 break-words text-xl font-semibold tracking-tight">{top ? regionLabel(top) : "Unavailable"}</h3>
                    <p className="mt-1 text-xs text-muted">{top ? `${percent(top.share_pct)} share of period spend` : "No usable regional cost values"}</p>
                  </div>
                  <div className="num text-2xl font-semibold tracking-tight">{money(top?.cost, true)}</div>
                </div>
                {bars.length > 0 && (
                  <div role="img" aria-label={`Largest ${bars.length} reported regions by net spend in ${currency ?? "unspecified currency"}. Exact values and comparisons are in the regional data table below.`}>
                    <div aria-hidden="true">
                      <Chart height={Math.max(200, bars.length * 38 + 38)} option={{
                        grid: { top: 8, bottom: 24, left: 8, right: 24, containLabel: true },
                        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (value: number) => money(value) },
                        xAxis: { type: "value", splitNumber: 3, axisLabel: { fontSize: 10, hideOverlap: true, formatter: (value: number) => money(value, true) }, axisLine: { show: false } },
                        yAxis: { type: "category", inverse: true, data: bars.map(regionLabel), axisLabel: { width: 100, overflow: "truncate", fontSize: 11 }, axisTick: { show: false }, axisLine: { show: false } },
                        series: [{ type: "bar", barMaxWidth: 18, showBackground: true, backgroundStyle: { color: "rgba(128,128,128,0.06)", borderRadius: 5 }, itemStyle: { borderRadius: 4 }, data: bars.map((row, i) => ({ value: row.cost, itemStyle: { color: row.cost < 0 ? PALETTE[5] : PALETTE[i % PALETTE.length] } })) }],
                      }} />
                    </div>
                  </div>
                )}
              </div>
              <div className="min-w-0 rounded-xl border border-border bg-surface-2/50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div><h3 className="text-sm font-semibold">Geographic distribution</h3><p className="mt-1 text-xs text-muted">Composition of returned regional rows</p></div>
                  <span className="num rounded-full border border-border bg-surface px-2 py-1 text-xs">{rows.length} reported</span>
                </div>
                {model.canDistribute ? (
                  <>
                    <div className="relative mt-2" role="img" aria-label={`Spend distribution across returned regional rows in ${currency ?? "unspecified currency"}. Largest five regions and the remainder.`}>
                      <div aria-hidden="true"><Chart height={210} option={{
                        tooltip: { trigger: "item", valueFormatter: (value: number) => money(value) },
                        series: [{ type: "pie", radius: ["68%", "88%"], center: ["50%", "50%"], padAngle: 2, itemStyle: { borderRadius: 5 }, label: { show: false }, data: model.segments }],
                      }} /></div>
                      <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="text-xs text-muted">Reported net spend</span><span className="num mt-1 text-xl font-semibold">{money(model.net, true)}</span><span className="mt-1 text-xs text-muted">{currency ?? "Currency unspecified"}</span></div>
                    </div>
                    <ul className="mt-2 space-y-2">
                      {model.segments.map((segment, i) => (
                        <li key={segment.key} className="flex items-center gap-2 text-xs">
                          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: PALETTE[i % PALETTE.length] }} aria-hidden="true" />
                          <span className="min-w-0 flex-1 break-words">{segment.name}</span>
                          <span className="num shrink-0 text-muted">{money(segment.value, true)}</span>
                          <span className="num shrink-0 font-medium">{percent(segment.value / model.net! * 100)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <div className="my-6 rounded-lg border border-border bg-surface p-4">
                    <p className="text-sm font-medium">{credits ? "Credits change the picture" : model.hasUnavailable ? "Some cost values are unavailable" : "No positive spend to distribute"}</p>
                    <p className="mt-2 text-xs leading-relaxed text-muted">{credits ? "Negative costs are preserved in the bars and data below. A share-of-spend ring would misrepresent credits, so it is not drawn." : "A distribution ring needs complete, non-negative costs and a positive total. Zero and unavailable values remain distinct below."}</p>
                    {credits && <p className="num mt-3 text-sm">Reported credits: {money(model.credits)}</p>}
                    <p className="num mt-2 text-sm">Reported net spend: {money(model.net)}</p>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-5 border-t border-border pt-4">
              <h3 className="text-sm font-semibold">Explore a region</h3>
              <p className="mt-1 text-xs text-muted">Select a region for its reported comparison. This does not filter the dashboard.</p>
              <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Choose regional comparison">
                {rows.map((row) => (
                  <button key={regionKey(row)} type="button" aria-pressed={selected === row} onClick={() => setPicked(regionKey(row))}
                    className={cn("max-w-full rounded-full border px-3 py-1.5 text-left text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent", selected === row ? "border-accent/40 bg-accent/10 text-accent" : "border-border bg-surface hover:bg-surface-2")}>
                    <span className="break-words">{regionLabel(row)}</span><span className="num ml-2 text-muted">{percent(row.share_pct)}</span>
                  </button>
                ))}
              </div>
              {selected && (
                <div aria-live="polite" className="mt-3 rounded-xl border border-border bg-surface-2 p-4">
                  <h4 className="break-words text-sm font-semibold">{regionLabel(selected)} <span className="font-normal text-muted">· {currency ?? "currency unspecified"}</span></h4>
                  <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                    {[["Current spend", money(selected.cost)], ["Previous period", money(selected.previous)], ["Net change", money(selected.delta)], ["Period change", selected.change_pct == null ? "No baseline" : `${selected.change_pct > 0 ? "+" : ""}${percent(selected.change_pct)}`]].map(([label, value]) => (
                      <div key={label}><dt className="text-xs text-muted">{label}</dt><dd className="num mt-1 break-words text-sm font-semibold">{value}</dd></div>
                    ))}
                  </dl>
                </div>
              )}
              <details className="mt-4">
                <summary className="w-fit cursor-pointer text-xs font-medium text-accent focus-visible:outline-2 focus-visible:outline-accent">View regional data and source ({rows.length} rows)</summary>
                <div className="mt-3 overflow-x-auto rounded-lg border border-border" tabIndex={0} role="region" aria-label="Regional spend table, horizontally scrollable">
                  <table className="w-full text-left text-xs">
                    <caption className="px-3 py-2 text-left text-muted">Executive API · regional breakdown · {currency ?? "currency unspecified"}. Returned rows may not cover all period spend; API shares use period spend, while the ring uses returned rows only.</caption>
                    <thead className="bg-surface-2"><tr>{["Region", "Current spend", "Previous spend", "Net change", "Change", "Period share"].map((label) => <th key={label} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{label}</th>)}</tr></thead>
                    <tbody>{rows.map((row) => <tr key={regionKey(row)} className="border-t border-border"><th scope="row" className="min-w-36 break-words px-3 py-2 font-medium">{regionLabel(row)}</th>{[money(row.cost), money(row.previous), money(row.delta), row.change_pct == null ? "No baseline" : percent(row.change_pct), percent(row.share_pct)].map((value, i) => <td key={i} className="num whitespace-nowrap px-3 py-2">{value}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              </details>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
