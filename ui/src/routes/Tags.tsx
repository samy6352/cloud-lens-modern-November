import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Chart } from "@/components/Chart";
import { columnHelper, DataTable } from "@/components/DataTable";
import { ErrorState, KpiTile, PageHeader, Segmented } from "@/components/blocks";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatMoney, formatNumber } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { tagsQuery, liveTagKeysQuery, type TagReport, type TagResource } from "@/lib/queries";

const WINDOWS = [
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days" },
];
const NO_VALUE = "(not set)";
const EMPTY_VALUE = "(empty)";
const KEY_LIMIT = 80;

interface ValueRow {
  value: string;
  cost: number;
  resources: number;
}

function valueOf(data: TagReport, r: TagResource, key: string): string {
  const at = r.keys.indexOf(key);
  const raw = at >= 0 && r.v[at] != null ? data.values[r.v[at]!] : undefined;
  if (raw === undefined) return NO_VALUE;
  return raw.trim() === "" ? EMPTY_VALUE : raw;
}

/** Cost by the value each resource carries for one tag key. Resources without the key group as "(not set)". */
function breakdown(data: TagReport, key: string): ValueRow[] {
  const by = new Map<string, ValueRow>();
  for (const r of data.resources) {
    const value = valueOf(data, r, key);
    const row = by.get(value) ?? { value, cost: 0, resources: 0 };
    row.cost += r.cost;
    row.resources += 1;
    by.set(value, row);
  }
  return [...by.values()].sort((a, b) => b.cost - a.cost);
}



export function TagsPage() {
  const search = useSearch({ from: "__root__" });
  const { numbers } = usePrefs();
  const [days, setDays] = useState("30");
  const query = useQuery(tagsQuery(search, Number(days)));
  const data = query.data;
  const live = useQuery(liveTagKeysQuery(search));
  const uncosted = live.data?.keys.filter(k => !data?.keys.some(costed => costed.key === k.key)) ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const [value, setValue] = useState<string | null>(null);
  const [keyText, setKeyText] = useState("");
  const [showPlatform, setShowPlatform] = useState(false);
  const deferredKey = useDeferredValue(keyText.trim().toLowerCase());

  const keys = useMemo(() => {
    if (!data) return [];
    return data.keys.filter((k) => (showPlatform || !k.platform) && (!deferredKey || k.key.toLowerCase().includes(deferredKey)));
  }, [data, showPlatform, deferredKey]);
  const key = picked ?? keys[0]?.key ?? null;
  useEffect(() => setValue(null), [key, days]);

  const money = (v: number | null | undefined, compact = true) => formatMoney(v, data?.currency ?? null, { system: numbers, compact });
  const rows = useMemo(() => (data && key ? breakdown(data, key) : []), [data, key]);
  const keyInfo = data?.keys.find((k) => k.key === key);
  const keyTotal = rows.reduce((s, r) => s + r.cost, 0);
  const resources = useMemo(
    () => (data && key && value != null ? data.resources.filter((r) => valueOf(data, r, key) === value).sort((a, b) => b.cost - a.cost) : []),
    [data, key, value],
  );

  const valueColumns = useMemo(() => {
    const h = columnHelper<ValueRow>();
    return [
      h.accessor("value", {
        header: "Value",
        enableSorting: false,
        cell: (c) => (
          <button
            type="button"
            onClick={() => setValue(c.getValue())}
            aria-pressed={value === c.getValue()}
            className={cn("max-w-full truncate text-left font-medium hover:text-accent", value === c.getValue() && "text-accent")}
            title={c.getValue()}
          >
            {c.getValue()}
          </button>
        ),
        meta: { width: "minmax(180px, 2fr)" },
      }),
      h.accessor("resources", {
        header: "Resources",
        enableSorting: false,
        cell: (c) => formatNumber(c.getValue(), { system: numbers, digits: 0 }),
        meta: { align: "right", width: "minmax(100px, 0.7fr)" },
      }),
      h.accessor("cost", {
        header: "Cost",
        enableSorting: false,
        cell: (c) => formatMoney(c.getValue(), data?.currency ?? null, { system: numbers }),
        meta: { align: "right", width: "minmax(130px, 0.9fr)" },
      }),
      h.accessor((r) => (keyTotal ? (r.cost / keyTotal) * 100 : 0), {
        id: "share",
        header: "Share",
        enableSorting: false,
        cell: (c) => <span className="text-muted">{(c.getValue() as number).toFixed(1)}%</span>,
        meta: { align: "right", width: "minmax(80px, 0.5fr)" },
      }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numbers, value, keyTotal, data?.currency]);

  const resourceColumns = useMemo(() => {
    const h = columnHelper<TagResource>();
    return [
      h.accessor("name", {
        header: "Resource",
        enableSorting: false,
        cell: (c) => (
          <div className="flex min-w-0 items-baseline gap-2" title={c.row.original.id}>
            <div className="min-w-0 shrink truncate font-medium">{c.getValue()}</div>
            <div className="min-w-0 shrink-[2] truncate text-xs text-muted">{c.row.original.service ?? "—"}</div>
          </div>
        ),
        meta: { width: "minmax(240px, 2.2fr)" },
      }),
      h.accessor((r) => r.group ?? "", {
        id: "group",
        header: "Resource group",
        enableSorting: false,
        cell: (c) => <span className="text-muted">{(c.getValue() as string) || "—"}</span>,
        meta: { width: "minmax(180px, 1.4fr)" },
      }),
      h.accessor((r) => r.subscription ?? r.subscription_id ?? "", {
        id: "subscription",
        header: "Subscription",
        enableSorting: false,
        cell: (c) => <span className="text-muted">{(c.getValue() as string) || "—"}</span>,
        meta: { width: "minmax(150px, 1fr)" },
      }),
      h.accessor("cost", {
        header: "Cost",
        enableSorting: false,
        cell: (c) => formatMoney(c.getValue(), data?.currency ?? null, { system: numbers }),
        meta: { align: "right", width: "minmax(130px, 0.9fr)" },
      }),
    ];
  }, [numbers, data?.currency]);

  if (query.isError && !data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const taggedShare = data && data.total ? (data.tagged.cost / data.total) * 100 : null;
  const chartRows = rows.slice(0, 12);
  const chart = {
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: { type: "value", axisLabel: { formatter: (v: number) => formatNumber(v, { compact: true }) } },
    yAxis: { type: "category", inverse: true, data: chartRows.map((r) => r.value), axisLabel: { width: 140, overflow: "truncate" } },
    series: [{ type: "bar", name: "Cost", data: chartRows.map((r) => Math.round(r.cost * 100) / 100), barMaxWidth: 18 }],
  };

  return (
    <div>
      <PageHeader
        title="Cost by Application / Tags"
        subtitle={
          data ? (
            <>
              {data.days}-day cost grouped by the tags on each resource
              {data.latest && (
                <>
                  {" "}· data through <span className="num">{data.latest}</span>
                </>
              )}
            </>
          ) : (
            <Skeleton className="h-4 w-72" />
          )
        }
        actions={<Segmented label="Window" value={days} onChange={setDays} options={WINDOWS} />}
      />

      {data?.tags_not_loaded && (
        <Card className="mb-4 border-warn/40 p-4 text-sm">
          The latest data load could not carry tags, so resources may appear untagged. The figures below are not a statement that these resources have no tags.
        </Card>
      )}
      {data?.truncated && (
        <Card className="mb-4 border-warn/40 p-4 text-sm">
          Showing the {formatNumber(data.resources.length, { system: numbers, digits: 0 })} highest-cost resources. Totals cover these resources only.
        </Card>
      )}
      <Card className="mb-4 p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>Cost tags come from imported billing. Check Azure separately for current keys without cost in this window.</span>
          <Button variant="outline" disabled={!data || live.isFetching} onClick={() => void live.refetch()}>
            {live.isFetching ? "Checking live tag keys…" : "Check live tag keys"}
          </Button>
        </div>
        {live.isError && <p role="alert" className="mt-3 text-warn">Live tag keys unavailable: {live.error.message}. Imported cost evidence is unchanged.</p>}
        {live.data && (
          <div className="mt-3" role="status">
            <p>{live.data.keys.length} current keys returned by {live.data.source}. This is live metadata, not cost attribution.</p>
            {uncosted.length > 0 ? (
              <ul className="mt-2 list-inside list-disc">
                {uncosted.map(k => <li key={k.key}>{k.key} · {formatNumber(k.resources, { system: numbers, digits: 0 })} resources{k.platform ? " · platform-generated" : ""}</li>)}
              </ul>
            ) : <p>No additional live keys were returned beyond the cost keys shown.</p>}
          </div>
        )}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile index={0} loading={!data} label="Tagged cost" value={money(data?.tagged.cost)} hint={`${formatNumber(data?.tagged.resources, { system: numbers, digits: 0 })} resources`} />
        <KpiTile index={1} loading={!data} label="Untagged cost" value={money(data?.untagged.cost)} hint={`${formatNumber(data?.untagged.resources, { system: numbers, digits: 0 })} resources`} />
        <KpiTile index={2} loading={!data} label="Tag status unknown" value={money(data?.unknown.cost)} hint={`${formatNumber(data?.unknown.resources, { system: numbers, digits: 0 })} resources`} />
        <KpiTile index={3} loading={!data} label="Tagged share" value={taggedShare == null ? "—" : `${taggedShare.toFixed(1)}%`} hint={`${formatNumber(data?.keys.length, { system: numbers, digits: 0 })} tag keys in use`} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Tag keys" subtitle="Pick a key to group cost by its values." />
          <CardBody>
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <input
                value={keyText}
                onChange={(e) => setKeyText(e.target.value)}
                placeholder="Find a tag key…"
                aria-label="Find a tag key"
                maxLength={100}
                className="h-9 w-full rounded-lg border border-border bg-surface pl-8 pr-3 text-sm outline-none focus:border-accent/60"
              />
            </label>
            <label className="mt-2 flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={showPlatform} onChange={(e) => setShowPlatform(e.target.checked)} />
              Include platform-generated tags
            </label>
            {data ? (
              <ul className="mt-3 max-h-[460px] space-y-1 overflow-auto" aria-label="Tag keys">
                {keys.slice(0, KEY_LIMIT).map((k) => (
                  <li key={k.key}>
                    <button
                      type="button"
                      onClick={() => setPicked(k.key)}
                      aria-pressed={k.key === key}
                      className={cn("flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-2", k.key === key && "bg-surface-2 ring-1 ring-border")}
                    >
                      <span className="min-w-0 truncate font-medium" title={k.key}>
                        {k.key}
                      </span>
                      <span className="num shrink-0 text-xs text-muted">{money(k.cost)}</span>
                    </button>
                  </li>
                ))}
                {keys.length === 0 && <li className="px-2.5 py-6 text-center text-sm text-muted">No tag keys match.</li>}
                {keys.length > KEY_LIMIT && <li className="px-2.5 py-2 text-xs text-muted">Showing {KEY_LIMIT} of {keys.length}. Search to narrow.</li>}
              </ul>
            ) : (
              <Skeleton className="mt-3 h-[300px] w-full" />
            )}
          </CardBody>
        </Card>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader
              title={key ? `Cost by ${key}` : "Cost by tag value"}
              subtitle={
                keyInfo
                  ? `${formatNumber(keyInfo.resources, { system: numbers, digits: 0 })} resources carry this key · ${formatNumber(keyInfo.values, { system: numbers, digits: 0 })} distinct values`
                  : undefined
              }
            />
            <CardBody>
              {!data ? (
                <Skeleton className="h-[300px] w-full" />
              ) : key ? (
                <>
                  <Chart height={Math.max(160, chartRows.length * 26 + 24)} option={chart} />
                  <div className="mt-4">
                    <DataTable
                      data={rows}
                      columns={valueColumns}
                      rowKey={(r) => r.value}
                      height={320}
                      empty="No resources in this window."
                    />
                  </div>
                </>
              ) : (
                <p className="py-10 text-center text-sm text-muted">No tag keys in this window.</p>
              )}
            </CardBody>
          </Card>

          {key && value != null && (
            <Card>
              <CardHeader
                title={`${key} = ${value}`}
                subtitle={`${formatNumber(resources.length, { system: numbers, digits: 0 })} resources`}
                actions={
                  <button type="button" onClick={() => setValue(null)} className="text-sm font-medium text-accent hover:underline">
                    Clear
                  </button>
                }
              />
              <CardBody>
                <DataTable data={resources} columns={resourceColumns} rowKey={(r) => `${r.subscription_id ?? ""}|${r.id}`} height={420} empty="No resources." />
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
