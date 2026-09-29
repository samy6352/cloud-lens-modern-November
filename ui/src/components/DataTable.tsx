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
import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

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
  rowKey,
  empty = "No rows.",
  footer,
}: {
  data: T[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: any[];
  height?: number;
  initialSort?: { id: string; desc: boolean };
  rowKey: (row: T) => string;
  empty?: ReactNode;
  footer?: ReactNode;
}) {
  const table = useTable({
    features: tableFeatureSet,
    columns,
    data,
    getRowId: (row: T) => rowKey(row),
    enableSortingRemoval: false,
    initialState: { sorting: initialSort ? [initialSort] : [] },
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const rowHeight = typeof document !== "undefined" && document.documentElement.dataset.density === "compact" ? 32 : 40;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: (index) => rows[index]!.id,
    overscan: 12,
  });

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const template = headers
    .map((h) => (h.column.columnDef.meta as ColumnMetaLike | undefined)?.width ?? "minmax(120px, 1fr)")
    .join(" ");

  return (
    <div role="table" aria-rowcount={rows.length} className="overflow-hidden rounded-xl border border-border">
      <div
        ref={scrollRef}
        className="overflow-auto"
        style={{ maxHeight: height }}
      >
        <div role="rowgroup" className="sticky top-0 z-10 border-b border-border bg-surface-2/95 backdrop-blur">
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
                </div>
              );
            })}
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="px-3 py-12 text-center text-sm text-muted">{empty}</div>
        ) : (
          <div role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }}>
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
