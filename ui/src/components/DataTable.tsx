import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
  type RowData,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { usePrefs } from "@/lib/prefs";

export const tableFeatureSet = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
});

export type Features = typeof tableFeatureSet;

export function columnHelper<T extends RowData>() {
  return createColumnHelper<Features, T>();
}

export interface ColumnMetaLike {
  align?: "left" | "right";
  width?: string;
}

/** Below this width a row becomes a card: the first column as its title, the rest as label/value pairs. */
const STACKED_QUERY = "(max-width: 639px)";

/**
 * Sortable, virtualised grid. Only the rows in view are in the DOM, so 400 or 40,000 rows
 * scroll the same. Uses div roles rather than <table> because virtual rows are absolutely
 * positioned, which a real table layout cannot express.
 */
export function DataTable<T extends RowData>({
  data,
  columns,
  height = 520,
  initialSort,
  sort,
  onSortChange,
  rowKey,
  empty = "No rows.",
  footer,
  busy = false,
  rowHeight: fixedRowHeight,
  label = "Cost and resource records",
}: {
  data: T[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: any[];
  height?: number;
  initialSort?: { id: string; desc: boolean };
  /**
   * Server-sorted mode: the rows arrive already in `sort` order and a header click asks
   * the caller (`onSortChange`) for a new order instead of re-sorting what is loaded.
   */
  sort?: { id: string; desc: boolean };
  onSortChange?: (sort: { id: string; desc: boolean }) => void;
  rowKey: (row: T) => string;
  empty?: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  /** Pixel height of every row in the wide layout; raise it when cells wrap onto two lines. */
  rowHeight?: number;
  label?: string;
}) {
  const controlled = sort !== undefined && onSortChange !== undefined;
  const table = useTable({
    features: tableFeatureSet,
    columns,
    data,
    getRowId: (row: T) => rowKey(row),
    enableSortingRemoval: false,
    ...(controlled
      ? {
          manualSorting: true,
          state: { sorting: [sort] },
          onSortingChange: (updater: unknown) => {
            const next = typeof updater === "function" ? (updater as (s: Array<{ id: string; desc: boolean }>) => Array<{ id: string; desc: boolean }>)([sort]) : updater;
            const first = (next as Array<{ id: string; desc: boolean }>)[0];
            if (first) onSortChange({ id: first.id, desc: first.desc });
          },
        }
      : { initialState: { sorting: initialSort ? [initialSort] : [] } }),
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const { density } = usePrefs();
  const stacked = useMediaQuery(STACKED_QUERY);
  // Cards vary in height, so a stacked row is only estimated here and measured once rendered.
  const rowHeight = stacked ? 116 : fixedRowHeight ?? (density === "compact" ? 32 : 40);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: (index) => rows[index]!.id,
    overscan: 12,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const template = headers
    .map((h) => (h.column.columnDef.meta as ColumnMetaLike | undefined)?.width ?? "minmax(120px, 1fr)")
    .join(" ");
  const minWidth = stacked
    ? undefined
    : headers.reduce((total, h) => {
        const width = (h.column.columnDef.meta as ColumnMetaLike | undefined)?.width;
        return total + Number(width?.match(/^(?:minmax\(\s*)?(\d+(?:\.\d+)?)px/)?.[1] ?? 120);
      }, 0);
  const labelOf = (h: (typeof headers)[number]) => {
    const header = h.column.columnDef.header;
    return typeof header === "string" ? header : "";
  };
  const sortable = headers.filter((h) => h.column.getCanSort());
  const current = sortable.find((h) => h.column.getIsSorted());

  const renderStacked = (cells: ReturnType<(typeof rows)[number]["getAllCells"]>) => {
    const [first, ...rest] = cells;
    return (
      <>
        {first && (
          <div role="cell" className="min-w-0 break-words font-medium">
            <table.FlexRender cell={first} />
          </div>
        )}
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1.5">
          {rest.map((cell) => {
            const header = headers.find((h) => h.column.id === cell.column.id);
            const label = header ? labelOf(header) : "";
            return (
              <div key={cell.id} role="cell" className="min-w-0">
                {label && <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>}
                <div className="num min-w-0 break-words text-xs">
                  <table.FlexRender cell={cell} />
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  };

  return (
    // The footer sits beside the table, not in it: a table may own only rows, and the
    // footer can hold controls (a pager).
    <div className="cl-data-table min-w-0 max-w-full overflow-hidden border border-border">
      {!stacked && headers.length > 4 && <div className="cl-table-guide">Scroll horizontally for all columns.{sortable.length > 0 ? " Select a column heading to sort." : ""}</div>}
      {stacked && sortable.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-3 py-2 text-xs">
          <label className="flex min-w-0 items-center gap-1.5 text-muted">
            Sort
            <select
              aria-label={`Sort ${label} by`}
              className="h-8 rounded-md border border-border bg-surface px-1.5 text-xs text-fg"
              value={current?.column.id ?? ""}
              onChange={(e) => {
                const next = sortable.find((h) => h.column.id === e.target.value);
                next?.column.toggleSorting((next.column.columnDef.meta as ColumnMetaLike | undefined)?.align === "right");
              }}
            >
              {!current && <option value="" disabled>Choose…</option>}
              {sortable.map((h) => <option key={h.id} value={h.column.id}>{labelOf(h) || h.column.id}</option>)}
            </select>
          </label>
          {current && (
            <button
              type="button"
              onClick={() => current.column.toggleSorting(current.column.getIsSorted() === "asc")}
              className="inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-surface px-2"
              aria-label={current.column.getIsSorted() === "desc" ? "Sorted high to low; switch to low to high" : "Sorted low to high; switch to high to low"}
            >
              {current.column.getIsSorted() === "desc" ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />}
              {current.column.getIsSorted() === "desc" ? "High to low" : "Low to high"}
            </button>
          )}
        </div>
      )}
      <div
        ref={scrollRef}
        role="table"
        aria-label={label}
        aria-rowcount={rows.length + (stacked ? 0 : 1)}
        aria-colcount={headers.length}
        aria-busy={busy}
        // With no sortable header nothing inside can take focus, so keyboard users could not scroll.
        tabIndex={0}
        className="max-w-full overflow-auto"
        style={{ maxHeight: `min(${height}px, 70dvh)` }}
      >
        {!stacked && (
        <div role="rowgroup" className="sticky top-0 z-10 border-b border-border bg-surface-2" style={{ minWidth }}>
          <div role="row" aria-rowindex={1} className="grid" style={{ gridTemplateColumns: template }}>
            {headers.map((header) => {
              const meta = header.column.columnDef.meta as ColumnMetaLike | undefined;
              const sorted = header.column.getIsSorted();
              const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
              return (
                <div
                  key={header.id}
                  role="columnheader"
                  aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                  className={cn("px-3 py-2 text-xs font-semibold text-muted", meta?.align === "right" && "text-right")}
                >
                  {header.column.getCanSort() ? (
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className={cn(
                        "inline-flex items-center gap-1 hover:text-fg",
                        meta?.align === "right" && "flex-row-reverse",
                        sorted && "text-fg",
                      )}
                    >
                      <table.FlexRender header={header} />
                      <Icon className={cn("size-3", !sorted && "opacity-40")} />
                    </button>
                  ) : (
                    <table.FlexRender header={header} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        )}

        {rows.length === 0 ? (
          <div className="px-3 py-12 text-center text-sm text-muted">{empty}</div>
        ) : (
          <div role="rowgroup" className="relative" style={{ minWidth, height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              return (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={item.index + (stacked ? 1 : 2)}
                  data-index={item.index}
                  data-row-id={row.id}
                  ref={stacked ? virtualizer.measureElement : undefined}
                  className={cn(
                    "cl-data-row absolute left-0 w-full border-b border-border/60 text-sm hover:bg-surface-2/60",
                    stacked ? "px-3 py-2" : "grid items-center",
                  )}
                  style={stacked ? { transform: `translateY(${item.start}px)` } : { gridTemplateColumns: template, height: item.size, transform: `translateY(${item.start}px)` }}
                >
                  {stacked ? (
                    renderStacked(row.getAllCells())
                  ) : row.getAllCells().map((cell) => {
                    const meta = cell.column.columnDef.meta as ColumnMetaLike | undefined;
                    return (
                      <div
                        key={cell.id}
                        role="cell"
                        className={cn("min-w-0 truncate px-3", meta?.align === "right" && "num text-right")}
                      >
                        <table.FlexRender cell={cell} />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {footer && <div className="border-t border-border bg-surface-2/60 px-3 py-2 text-xs text-muted">{footer}</div>}
    </div>
  );
}
