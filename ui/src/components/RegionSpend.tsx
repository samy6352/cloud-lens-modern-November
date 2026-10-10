import { Globe2, LocateFixed, MapPin, Minus, Plus } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/format";
import { PALETTE } from "@/lib/palette";
import { isDark, usePrefs } from "@/lib/prefs";
import type { Ranked } from "@/lib/queries";
import { placeRegions, regionDisplayName, resolveRegion } from "@/lib/regionGeo";
import { cssVar, escapeHtml } from "./premium";
import { regionKey, regionLabel, regionSpendModel } from "./RegionSpendModel";

const WorldMapChart = lazy(() => import("./WorldMapChart"));
const MAP_HEIGHT = 300;

function percent(value: number | null) {
  return value != null && Number.isFinite(value) ? `${value.toFixed(1)}%` : "Unavailable";
}

/** Azure display name for meter-style locations ("in central" -> "Central India"); source names stay in the data table. */
function friendlyName(row: Ranked) {
  const arm = resolveRegion(regionLabel(row));
  return (arm && regionDisplayName(arm)) || regionLabel(row);
}

function changeText(pct: number | null) {
  return pct == null ? "No baseline" : `${pct > 0 ? "+" : ""}${percent(pct)}`;
}

export function RegionSpend({ rows, currency }: { rows: Ranked[]; currency: string | null }) {
  const { numbers, theme } = usePrefs();
  const [picked, setPicked] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState<[number, number] | null>(null);
  const model = useMemo(() => regionSpendModel(rows, currency), [rows, currency]);
  const top = model.ranked[0];
  const selected = rows.find((row) => regionKey(row) === picked) ?? top;
  const money = (value: number | null | undefined, compact = false) =>
    value == null || !Number.isFinite(value) ? "Unavailable" : formatMoney(value, currency, { system: numbers, compact, digits: compact ? undefined : 2 });

  const { placed, unplaced } = useMemo(() => placeRegions(model.ranked), [model.ranked]);
  const unplacedSpend = unplaced.reduce((sum, row) => sum + row.cost, 0);
  const rankOf = useMemo(() => new Map(model.ranked.map((row, i) => [regionKey(row), i])), [model.ranked]);
  const maxCost = Math.max(...model.ranked.map((r) => Math.abs(r.cost)), 1);

  const colors = useMemo(() => {
    const dark = isDark();
    return {
      land: dark ? "#262c45" : "#cfd5e6",
      landBorder: dark ? "#363e60" : "#b8c0d6",
      accent: cssVar("--cl-accent", "#4f46e5"),
      glow: cssVar("--cl-surface", "#ffffff"),
      text: cssVar("--cl-fg", "#0f172a"),
      palette: PALETTE,
    };
  }, [theme]);

  const points = useMemo(
    () =>
      placed
        .filter((p) => p.row.cost > 0)
        .map((p) => ({
          key: regionKey(p.row),
          name: friendlyName(p.row),
          cost: p.row.cost,
          x: p.x,
          y: p.y,
          tooltip:
            `<div style="min-width:180px"><div style="font-weight:600;margin-bottom:4px">${escapeHtml(friendlyName(p.row))}</div>` +
            `<div style="display:flex;justify-content:space-between;gap:16px"><span>Spend</span><b>${escapeHtml(money(p.row.cost, true))}</b></div>` +
            `<div style="display:flex;justify-content:space-between;gap:16px"><span>Share</span><span>${escapeHtml(percent(p.row.share_pct))}</span></div>` +
            `<div style="display:flex;justify-content:space-between;gap:16px"><span>Change</span><span>${escapeHtml(changeText(p.row.change_pct))}</span></div></div>`,
        })),
    [placed, currency, numbers],
  );
  const pointColor = (key: string) => PALETTE[(points.findIndex((p) => p.key === key) + PALETTE.length) % PALETTE.length];

  const pick = (key: string) => {
    setPicked(key);
    const point = placed.find((p) => regionKey(p.row) === key);
    if (point) {
      setCenter([point.x, point.y]);
      setZoom((z) => Math.max(z, 2.4));
    }
  };

  return (
    <Card className="mt-4 min-w-0 overflow-hidden">
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><Globe2 className="size-4 text-accent" aria-hidden="true" />Regional spend</span>}
        subtitle={`Global footprint · billing locations · ${currency ?? "currency unspecified"} · current date and subscription scope`}
        actions={
          rows.length ? (
            <div className="flex items-center gap-1" role="group" aria-label="Map zoom">
              <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(z * 1.5, 10))} className="grid size-7 place-items-center rounded-md border border-border bg-surface hover:bg-surface-2"><Plus className="size-3.5" /></button>
              <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(z / 1.5, 1))} className="grid size-7 place-items-center rounded-md border border-border bg-surface hover:bg-surface-2"><Minus className="size-3.5" /></button>
              <button type="button" aria-label="Reset map" onClick={() => { setZoom(1); setCenter(null); }} className="grid size-7 place-items-center rounded-md border border-border bg-surface hover:bg-surface-2"><LocateFixed className="size-3.5" /></button>
            </div>
          ) : null
        }
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
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
              <div className="min-w-0">
                <div className="cl-map-surface relative overflow-hidden rounded-xl border border-border">
                  <div role="img" aria-label={`World map of ${points.length} reported billing locations sized by net spend in ${currency ?? "unspecified currency"}. Exact values are in the ranked list and regional data table.`}>
                    <div aria-hidden="true">
                      <Suspense fallback={<Skeleton style={{ height: MAP_HEIGHT }} className="w-full" />}>
                        <WorldMapChart points={points} selected={selected ? regionKey(selected) : null} zoom={zoom} center={center} colors={colors} height={MAP_HEIGHT} onPick={pick} />
                      </Suspense>
                    </div>
                  </div>
                  <div className="pointer-events-none absolute left-2 top-2 max-w-[60%] rounded-lg border border-border bg-surface/90 px-2.5 py-1.5 backdrop-blur">
                    <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted"><MapPin className="size-3" aria-hidden="true" />Top region</p>
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <span className="break-words text-sm font-semibold tracking-tight">{top ? friendlyName(top) : "Unavailable"}</span>
                      <span className="num text-sm font-semibold text-accent">{money(top?.cost, true)}</span>
                    </p>
                    <p className="hidden text-[11px] text-muted sm:block">{top ? `${percent(top.share_pct)} share of period spend` : "No usable regional cost values"}</p>
                  </div>
                  <div className="pointer-events-none absolute bottom-2 left-2 hidden items-center gap-2 rounded-full border border-border bg-surface/90 px-2.5 py-0.5 text-[11px] text-muted backdrop-blur sm:flex">
                    <span className="cl-live-dot inline-block size-2 rounded-full bg-accent text-accent" aria-hidden="true" />
                    Bubble area follows spend · ripples mark the five largest · drag to pan
                  </div>
                </div>
                {unplaced.length > 0 && (
                  <p className="mt-2 text-xs text-muted">
                    <span className="font-medium text-fg">Not tied to a location:</span>{" "}
                    {unplaced.map((r) => `${regionLabel(r)} ${money(r.cost, true)}`).join(" · ")}
                    {" "}— included in totals ({money(unplacedSpend, true)}), not drawn on the map.
                  </p>
                )}
              </div>

              <div className="flex min-w-0 flex-col rounded-lg border border-border bg-surface-2/50 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">Region leaderboard</h3>
                    <p className="mt-1 text-xs text-muted">Select a region to focus the map and compare periods</p>
                  </div>
                  <span className="num rounded-full border border-border bg-surface px-2 py-1 text-xs">{rows.length} reported</span>
                </div>
                {model.canDistribute && model.net ? (
                  <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-surface" role="img" aria-label="Share of returned regional spend for the largest five regions and the remainder">
                    {model.segments.map((segment, i) => (
                      <div key={segment.key} title={`${segment.name} ${percent((segment.value / model.net!) * 100)}`} style={{ width: `${(segment.value / model.net!) * 100}%`, background: PALETTE[i % PALETTE.length] }} />
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 rounded-lg border border-border bg-surface p-2 text-xs text-muted">
                    {model.credits < 0 ? `Credits of ${money(model.credits)} are preserved below; a share bar would misrepresent them.` : "A share bar needs complete, non-negative costs."}
                  </p>
                )}
                <div className="mt-2 max-h-[260px] min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1" role="group" aria-label="Choose regional comparison">
                  {rows.map((row) => {
                    const key = regionKey(row);
                    const rank = rankOf.get(key);
                    const active = selected === row;
                    const mapped = placed.some((p) => regionKey(p.row) === key);
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={active}
                        onClick={() => pick(key)}
                        className={cn(
                          "group block w-full rounded-md border px-2 py-1.5 text-left text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                          active ? "border-accent/50 bg-surface shadow-card" : "border-transparent hover:border-border hover:bg-surface",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="num grid size-5 shrink-0 place-items-center rounded-md bg-surface text-[10px] font-semibold text-muted ring-1 ring-border">{rank == null ? "–" : rank + 1}</span>
                          <span className="size-2 shrink-0 rounded-full" style={{ background: mapped && row.cost > 0 ? pointColor(key) : "var(--cl-muted)" }} aria-hidden="true" />
                          <span className={cn("min-w-0 flex-1 truncate font-medium", active && "text-accent")} title={regionLabel(row)}>{friendlyName(row)}{friendlyName(row) !== regionLabel(row) && <span className="ml-1.5 font-normal text-muted">{regionLabel(row)}</span>}</span>
                          <span className="num shrink-0 font-semibold">{money(row.cost, true)}</span>
                          <span className={cn("num w-14 shrink-0 text-right", (row.change_pct ?? 0) > 0 ? "text-bad" : (row.change_pct ?? 0) < 0 ? "text-good" : "text-muted")}>
                            {row.change_pct == null ? "—" : `${row.change_pct > 0 ? "+" : ""}${row.change_pct.toFixed(1)}%`}
                          </span>
                        </div>
                        <div className="ml-7 mt-1 h-0.5 overflow-hidden rounded-full bg-surface">
                          <div className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-700" style={{ width: `${Number.isFinite(row.cost) ? (Math.abs(row.cost) / maxCost) * 100 : 0}%`, background: row.cost < 0 ? "var(--cl-good)" : mapped ? pointColor(key) : "var(--cl-muted)" }} />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {selected && (
              <div aria-live="polite" className="mt-3 rounded-lg border border-border bg-surface-2/50 px-3 py-2">
                <h4 className="break-words text-sm font-semibold">{friendlyName(selected)} <span className="font-normal text-muted">· {currency ?? "currency unspecified"}</span></h4>
                <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                  {[["Current spend", money(selected.cost)], ["Previous period", money(selected.previous)], ["Net change", money(selected.delta)], ["Period change", changeText(selected.change_pct)]].map(([label, value]) => (
                    <div key={label}><dt className="text-[11px] text-muted">{label}</dt><dd className="num break-words text-sm font-semibold">{value}</dd></div>
                  ))}
                </dl>
              </div>
            )}
            <details className="mt-2">
              <summary className="w-fit cursor-pointer text-xs font-medium text-accent focus-visible:outline-2 focus-visible:outline-accent">View regional data and source ({rows.length} rows)</summary>
              <div className="mt-3 overflow-x-auto rounded-lg border border-border" tabIndex={0} role="region" aria-label="Regional spend table, horizontally scrollable">
                <table className="w-full text-left text-xs">
                  <caption className="px-3 py-2 text-left text-muted">Executive API · regional breakdown · {currency ?? "currency unspecified"}. Returned rows may not cover all period spend; API shares use period spend, while the share bar uses returned rows only.</caption>
                  <thead className="bg-surface-2"><tr>{["Region", "Current spend", "Previous spend", "Net change", "Change", "Period share"].map((label) => <th key={label} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{label}</th>)}</tr></thead>
                  <tbody>{rows.map((row) => <tr key={regionKey(row)} className="border-t border-border"><th scope="row" className="min-w-36 break-words px-3 py-2 font-medium">{regionLabel(row)}</th>{[money(row.cost), money(row.previous), money(row.delta), row.change_pct == null ? "No baseline" : percent(row.change_pct), percent(row.share_pct)].map((value, i) => <td key={i} className="num whitespace-nowrap px-3 py-2">{value}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </CardBody>
    </Card>
  );
}
