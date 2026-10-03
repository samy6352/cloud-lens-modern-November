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
  const rowHeight = density === "compact" ? 32 : 40;
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
  const minWidth = headers.reduce((total, h) => {
    const width = (h.column.columnDef.meta as ColumnMetaLike | undefined)?.width;
    return total + Number(width?.match(/^(?:minmax\(\s*)?(\d+(?:\.\d+)?)px/)?.[1] ?? 120);
  }, 0);

  return (
    // The footer sits beside the table, not in it: a table may own only rows, and the
    // footer can hold controls (a pager).
    <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-border">
      <div
        ref={scrollRef}
        role="table"
        aria-rowcount={rows.length}
        aria-busy={busy}
        // With no sortable header nothing inside can take focus, so keyboard users could not scroll.
        tabIndex={table.getHeaderGroups()[0]?.headers.some((h) => h.column.getCanSort()) ? undefined : 0}
        className="max-w-full overflow-auto"
        style={{ maxHeight: `min(${height}px, 70dvh)` }}
      >
        <div role="rowgroup" className="sticky top-0 z-10 border-b border-border bg-surface-2/95 backdrop-blur" style={{ minWidth }}>
          <div role="row" className="grid" style={{ gridTemplateColumns: template }}>
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
                  aria-rowindex={item.index + 1}
                  className="absolute left-0 grid w-full items-center border-b border-border/60 text-sm hover:bg-surface-2/60"
                  style={{ gridTemplateColumns: template, height: item.size, transform: `translateY(${item.start}px)` }}
                >
                  {row.getAllCells().map((cell) => {
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
