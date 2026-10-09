import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { ChevronDown, Info, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Chart } from "@/components/Chart";
import { columnHelper, DataTable } from "@/components/DataTable";
import { ErrorState, KpiTile, PageHeader, Segmented } from "@/components/blocks";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney, formatNumber } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { billingQuery, type BillingKpis, type BillingRow } from "@/lib/queries";

type Dimension = "subscriptions" | "services" | "resources";
const DIMENSIONS: Array<{ value: Dimension; label: string }> = [
  { value: "subscriptions", label: "Subscriptions" },
  { value: "services", label: "Services" },
  { value: "resources", label: "Resources" },
];

const EMPTY: BillingRow[] = [];

function useColumns(dimension: Dimension, currency: string | null) {
  const { numbers } = usePrefs();
  return useMemo(() => {
    const h = columnHelper<BillingRow>();
    const money = (v: number | null | undefined) => formatMoney(v, currency, { system: numbers });
    const moneyCol = (key: "recorded_cost" | "effective_cost" | "list_cost" | "actual_savings", header: string) =>
      h.accessor((r) => r[key] ?? undefined, {
        id: key,
        header,
        sortUndefined: "last",
        cell: (c) => money(c.getValue() as number | undefined),
        meta: { align: "right", width: "minmax(120px, 0.8fr)" },
      });
    return [
      h.accessor("name", {
        header: dimension === "subscriptions" ? "Subscription" : dimension === "services" ? "Service" : "Resource",
        sortFn: "alphanumeric",
        cell: (c) => (
          <span title={c.row.original.id} className={c.row.original.is_other ? "italic text-muted" : undefined}>
            {c.getValue()}
          </span>
        ),
        meta: { width: "minmax(220px, 2fr)" },
      }),
      ...(dimension === "resources"
        ? [
            h.accessor((r) => r.resource_group ?? "", {
              id: "resource_group",
              header: "Resource group",
              sortFn: "alphanumeric",
              cell: (c) => <span className="text-muted">{c.getValue() as string}</span>,
              meta: { width: "minmax(160px, 1.2fr)" },
            }),
          ]
        : []),
      moneyCol("recorded_cost", "Recorded"),
      moneyCol("effective_cost", "Effective"),
      moneyCol("list_cost", "List price"),
      moneyCol("actual_savings", "Savings"),
      h.accessor((r) => r.effective_discount_pct ?? undefined, {
        id: "effective_discount_pct",
        header: "Discount",
        sortUndefined: "last",
        cell: (c) => {
          const v = c.getValue() as number | undefined;
          return v == null ? "—" : `${v.toFixed(1)}%`;
        },
        meta: { align: "right", width: "minmax(90px, 0.5fr)" },
      }),
    ];
  }, [dimension, currency, numbers]);
}

function barOption(rows: BillingRow[], currency: string | null, system: "indian" | "international") {
  const top = rows.filter((r) => !r.is_other).slice(0, 12).reverse();
  const money = (v: number) => formatMoney(v, currency, { system, compact: true });
  return {
    grid: { left: 8, right: 24, top: 28, bottom: 8, containLabel: true },
    legend: { top: 0, right: 0, itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11 } },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: number) => money(v) },
    xAxis: { type: "value", axisLabel: { formatter: money, fontSize: 11 } },
    yAxis: {
      type: "category",
      data: top.map((r) => r.name),
      axisTick: { show: false },
      axisLabel: { fontSize: 11, width: 180, overflow: "truncate" },
    },
    series: [
      { name: "Recorded", type: "bar", data: top.map((r) => r.recorded_cost ?? r.cost), barMaxWidth: 14, itemStyle: { borderRadius: [0, 4, 4, 0] } },
      { name: "List price", type: "bar", data: top.map((r) => r.list_cost), barMaxWidth: 14, itemStyle: { borderRadius: [0, 4, 4, 0], opacity: 0.45 } },
    ],
  };
}

export function BillingPage() {
  const search = useSearch({ from: "__root__" });
  const { numbers } = usePrefs();
  const query = useQuery(billingQuery(search));
  const [dimension, setDimension] = useState<Dimension>("subscriptions");
  const [pickedCurrency, setPickedCurrency] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);

  const data = query.data;
  const currencies = useMemo(
    () => [...(data?.per_currency ?? [])].sort((a, b) => (b.kpis.recorded_cost ?? 0) - (a.kpis.recorded_cost ?? 0)),
    [data],
  );
  const active = currencies.find((c) => c.currency === pickedCurrency) ?? currencies[0];
  const currency = active?.currency ?? data?.currency ?? null;
  const kpis: BillingKpis | undefined = active?.kpis ?? data?.kpis;

  const rows = useMemo(() => {
    const all = data?.breakdowns[dimension] ?? EMPTY;
    const needle = filter.trim().toLowerCase();
    return all.filter(
      (r) =>
        (!currency || r.currency === currency) &&
        (!needle || r.name.toLowerCase().includes(needle) || (r.resource_group ?? "").toLowerCase().includes(needle)),
    );
  }, [data, dimension, currency, filter]);

  const columns = useColumns(dimension, currency);
  const money = (v: number | null | undefined) => formatMoney(v, currency, { system: numbers, compact: true });
  const loading = query.isPending;

  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  return (
    <div>
      <PageHeader
        title="Billing"
        subtitle={
          data ? (
            <>
              Calendar statement for <span className="font-medium text-fg">{data.period.label}</span> ·{" "}
              <span className="num">
                {data.period.start} → {data.period.end}
              </span>
            </>
          ) : (
            <Skeleton className="h-4 w-64" />
          )
        }
        actions={
          currencies.length > 1 ? (
            <Segmented
              label="Billing currency"
              value={currency ?? ""}
              onChange={setPickedCurrency}
              options={currencies.map((c) => ({ value: c.currency, label: c.currency }))}
            />
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile index={0} loading={loading} label="Recorded cost" value={money(kpis?.recorded_cost)} hint="as recorded in the export, not an invoice" />
        <KpiTile index={1} loading={loading} label="Effective cost" value={money(kpis?.effective_cost)} hint="after commitments are amortised" />
        <KpiTile index={2} loading={loading} label="List price" value={money(kpis?.list_cost)} hint="what the same usage costs at retail" />
        <KpiTile
          index={3}
          loading={loading}
          label="Actual savings"
          value={money(kpis?.actual_savings)}
          hint={kpis?.effective_discount_pct != null ? `${kpis.effective_discount_pct.toFixed(1)}% effective discount` : undefined}
        />
      </div>

      <Card className="mt-4">
        <CardHeader
          title="Largest contributors"
          subtitle="Recorded cost against list price"
          actions={<Segmented label="Breakdown" value={dimension} onChange={setDimension} options={DIMENSIONS} />}
        />
        <CardBody>
          {data ? <Chart height={360} option={barOption(rows, currency, numbers)} /> : <Skeleton className="h-[360px] w-full" />}
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHeader
          title={DIMENSIONS.find((d) => d.value === dimension)!.label}
          subtitle={<><span className="sm:hidden">Use Sort to reorder.</span><span className="hidden sm:inline">Click a column to sort.</span> Every row is here; only the visible ones are drawn.</>}
          actions={
            <label className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter…"
                aria-label="Filter rows"
                className="h-9 w-56 rounded-lg border border-border bg-surface pl-8 pr-3 text-sm outline-none focus:border-accent/60"
              />
            </label>
          }
        />
        <CardBody>
          {data ? (
            <DataTable
              key={dimension}
              data={rows}
              columns={columns}
              rowKey={(r) => `${r.id}|${r.currency ?? ""}`}
              initialSort={{ id: "recorded_cost", desc: true }}
              empty={filter ? "No rows match the filter." : "Nothing billed in this period."}
              footer={`${formatNumber(rows.length, { system: numbers, digits: 0 })} rows`}
            />
          ) : (
            <Skeleton className="h-[520px] w-full" />
          )}
        </CardBody>
      </Card>

      {data && data.warnings.length > 0 && (
        <Card className="mt-4">
          <button
            type="button"
            onClick={() => setNotesOpen((o) => !o)}
            aria-expanded={notesOpen}
            className="flex w-full items-center gap-2 px-[var(--cl-pad)] py-3 text-left text-sm"
          >
            <Info className="size-4 text-muted" />
            <span className="font-medium">How to read this statement</span>
            <span className="text-muted">({data.warnings.length} notes)</span>
            <ChevronDown className={`ml-auto size-4 text-muted transition-transform ${notesOpen ? "rotate-180" : ""}`} />
          </button>
          {notesOpen && (
            <ul className="list-disc space-y-1.5 px-[var(--cl-pad)] pb-4 pl-10 text-sm text-muted">
              {data.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
