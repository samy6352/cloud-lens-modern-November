import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { columnHelper, DataTable } from "@/components/DataTable";
import { ErrorState, KpiTile, PageHeader } from "@/components/blocks";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney, formatNumber } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { archiveCompareQuery, archiveQuery, type ArchiveChange } from "@/lib/queries";

const DATASETS: Record<string, string> = { focus: "FOCUS", amortized: "Amortized", actual: "Actual" };
const DIMENSIONS: Array<[string, string]> = [
  ["ServiceName", "Service"],
  ["SubAccountName", "Subscription"],
  ["ResourceGroup", "Resource group"],
  ["ResourceName", "Resource"],
  ["RegionName", "Region"],
  ["MeterName", "Meter"],
];

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <label className="block text-xs font-medium text-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block h-9 w-full rounded-lg border border-border bg-surface px-2 text-sm text-fg outline-none focus:border-accent/60"
      >
        {children}
      </select>
    </label>
  );
}

export function HistoryPage() {
  const search = useSearch({ from: "__root__" });
  const { numbers } = usePrefs();
  const status = useQuery(archiveQuery);
  const a = status.data;
  const sets = a?.comparable ?? [];
  const [dataset, setDataset] = useState("");
  const [earlierPick, setEarlierPick] = useState("");
  const [laterPick, setLaterPick] = useState("");
  const [groupBy, setGroupBy] = useState("ServiceName");

  // Picks that no longer exist (another dataset has other days) fall back to the newest two.
  const activeSet = sets.includes(dataset) ? dataset : (sets[0] ?? "");
  const days = a?.days?.[activeSet] ?? [];
  const later = days.includes(laterPick) ? laterPick : (days[0] ?? "");
  const earlier = days.includes(earlierPick) && earlierPick !== later ? earlierPick : (days.find((d) => d !== later) ?? "");
  const ready = Boolean(activeSet && earlier && later && earlier !== later);

  const compare = useQuery({ ...archiveCompareQuery(search, { dataset: activeSet, earlier, later, groupBy }), enabled: ready });
  const d = compare.data;
  const money = (v: number | null | undefined, compact = false) => formatMoney(v, d?.currency ?? null, { system: numbers, compact });

  const columns = useMemo(() => {
    const h = columnHelper<ArchiveChange>();
    return [
      h.accessor((r) => r.key ?? "—", {
        id: "key",
        header: DIMENSIONS.find(([v]) => v === groupBy)?.[1] ?? "Key",
        cell: (c) => <span className="font-medium" title={c.getValue() as string}>{c.getValue() as string}</span>,
        meta: { width: "minmax(240px, 2.4fr)" },
      }),
      h.accessor("was", { header: `As read ${earlier}`, cell: (c) => money(c.getValue()), meta: { align: "right", width: "minmax(140px, 1fr)" } }),
      h.accessor("now", { header: `As read ${later}`, cell: (c) => money(c.getValue()), meta: { align: "right", width: "minmax(140px, 1fr)" } }),
      h.accessor("delta", {
        header: "Change",
        cell: (c) => (
          <span className={c.getValue() > 0 ? "text-bad" : "text-good"}>
            {c.getValue() > 0 ? "+" : ""}
            {money(c.getValue())}
          </span>
        ),
        meta: { align: "right", width: "minmax(140px, 1fr)" },
      }),
      h.accessor((r) => r.percent ?? 0, {
        id: "percent",
        header: "%",
        cell: (c) => (c.row.original.percent == null ? <span className="text-muted">—</span> : `${c.row.original.percent > 0 ? "+" : ""}${c.row.original.percent}%`),
        meta: { align: "right", width: "minmax(80px, 0.5fr)" },
      }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numbers, groupBy, earlier, later, d?.currency]);

  if (status.isError && !a) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;

  if (!a) {
    return (
      <div>
        <PageHeader title="History" subtitle={<Skeleton className="h-4 w-72" />} />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!a.enabled || !a.reachable) {
    return (
      <div>
        <PageHeader title="History" subtitle="Cost restatements between archived daily snapshots" />
        <Card className="p-5">
          <h3 className="text-sm font-semibold">Archive unavailable</h3>
          <p className="mt-2 rounded-lg border border-warn/40 p-3 text-sm">{a.error || "The archive is not configured."}</p>
          <p className="mt-3 text-sm text-muted">A refresh creates dated snapshots. Costs can be compared once two snapshots exist for the same dataset.</p>
        </Card>
      </div>
    );
  }

  if (!sets.length) {
    const have = Object.entries(a.days ?? {})
      .map(([k, v]) => `${DATASETS[k] ?? k} (${v.length} day${v.length === 1 ? "" : "s"})`)
      .join(", ");
    return (
      <div>
        <PageHeader title="History" subtitle="Cost restatements between archived daily snapshots" />
        <Card className="p-5">
          <h3 className="text-sm font-semibold">More history needed</h3>
          <p className="mt-2 text-sm text-muted">
            A comparison needs two snapshots of the same dataset on different days. The archive currently holds {have || "nothing"}. Refresh again tomorrow and this screen will show what Azure restated overnight.
          </p>
        </Card>
      </div>
    );
  }

  const same = d?.total_delta != null && Math.abs(d.total_delta) < 0.005;
  const up = (d?.total_delta ?? 0) > 0;
  return (
    <div>
      <PageHeader
        title="History"
        subtitle={
          <>
            Cost restatements · {formatNumber(a.count, { system: numbers, digits: 0 })} snapshots in {a.account}/{a.container}
          </>
        }
      />

      <Card>
        <CardBody>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Select label="Dataset" value={activeSet} onChange={setDataset}>
              {sets.map((k) => (
                <option key={k} value={k}>
                  {DATASETS[k] ?? k}
                </option>
              ))}
            </Select>
            <Select label="Read on" value={earlier} onChange={setEarlierPick}>
              {days.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
            <Select label="Compared with" value={later} onChange={setLaterPick}>
              {days.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
            <Select label="Broken down by" value={groupBy} onChange={setGroupBy}>
              {DIMENSIONS.map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </Select>
          </div>
          <p className="mt-3 text-xs text-muted">
            Azure can revise cost data for several days after usage. Both snapshots describe the same spend period as read on different days. The warehouse holds only the latest read; archived snapshots keep earlier reported figures.
          </p>
        </CardBody>
      </Card>

      {!ready && <Card className="mt-4 p-4 text-sm text-muted">Pick two different days.</Card>}
      {ready && compare.isError && !d && <div className="mt-4"><ErrorState error={compare.error} onRetry={() => void compare.refetch()} /></div>}
      {ready && !d && !compare.isError && <Skeleton className="mt-4 h-64 w-full" />}

      {d && (
        <>
          {d.total_delta == null && <Card className="mt-4 border-bad/40 p-4 text-sm">No shared subscription/day usage coverage. A restatement cannot be calculated.</Card>}
          {d.coverage_changed && (
            <Card className="mt-4 p-4 text-sm">
              Coverage changed separately from restatements: {formatNumber(d.coverage_added?.coverage_keys ?? 0, { system: numbers, digits: 0 })} new covered subscription/day keys ({money(d.coverage_added?.cost)}); {formatNumber(d.coverage_removed?.coverage_keys ?? 0, { system: numbers, digits: 0 })} keys no longer covered ({money(d.coverage_removed?.cost)}). These amounts are excluded from the comparison below.
            </Card>
          )}
          {d.comparison_period && (
            <p className="mt-4 text-xs text-muted">
              Shared usage period: <span className="num">{d.comparison_period.from}</span> → <span className="num">{d.comparison_period.to}</span> ({d.comparison_period.days} usage dates)
            </p>
          )}

          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiTile index={0} label={`Comparable total as read ${d.earlier.day}`} value={d.total_delta == null ? "—" : money(d.earlier.cost, true)} hint={`${formatNumber(d.earlier.rows, { system: numbers, digits: 0 })} rows`} />
            <KpiTile index={1} label={`Comparable total as read ${d.later.day}`} value={d.total_delta == null ? "—" : money(d.later.cost, true)} hint={`${formatNumber(d.later.rows, { system: numbers, digits: 0 })} rows`} />
            <KpiTile
              index={2}
              label="Restated by"
              value={d.total_delta == null ? "—" : `${up ? "+" : ""}${money(d.total_delta, true)}`}
              changePct={same ? null : d.total_percent}
              hint={d.total_percent == null ? undefined : `${d.total_percent > 0 ? "+" : ""}${d.total_percent}%`}
            />
            <KpiTile index={3} label="Rows added" value={`${d.row_delta > 0 ? "+" : ""}${formatNumber(d.row_delta, { system: numbers, digits: 0 })}`} hint="record-count change within comparable coverage" />
          </div>

          {same && (
            <Card className="mt-4 border-good/40 p-4 text-sm">
              Nothing moved. The two reads of {d.earlier.from ?? ""} → {d.earlier.to ?? ""} agree within display precision. Azure may still restate this period later.
            </Card>
          )}

          {d.changes.length > 0 && (
            <Card className="mt-4">
              <CardHeader title={`Top restatements by ${DIMENSIONS.find(([v]) => v === d.group_by)?.[1] ?? d.group_by}`} subtitle="Changed rows only. Resources absent from one snapshot show zero on that side." />
              <CardBody>
                <DataTable data={d.changes} columns={columns} rowKey={(r) => r.key ?? "—"} height={520} />
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
