import { ArrowDownRight, ArrowUpRight, TriangleAlert } from "lucide-react";
import * as m from "motion/react-m";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ApiError } from "@/lib/api";
import { Card } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { Button } from "./ui/button";

export function KpiTile({
  label,
  value,
  hint,
  changePct,
  goodWhenDown = true,
  loading,
  index = 0,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  changePct?: number | null;
  /** For cost, going down is good. For savings, going up is. */
  goodWhenDown?: boolean;
  loading?: boolean;
  index?: number;
}) {
  const up = (changePct ?? 0) > 0;
  const good = changePct == null || changePct === 0 ? null : up !== goodWhenDown;
  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
    >
      <Card className="cl-kpi h-full px-3 py-2.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
        {loading ? (
          <>
            <Skeleton className="mt-2 h-6 w-28" />
            <Skeleton className="mt-1.5 h-3 w-20" />
          </>
        ) : (
          <>
            <div className="cl-kpi-value num mt-0.5 text-xl font-semibold leading-tight tracking-tight">{value}</div>
            <div className="mt-1 flex flex-wrap items-start gap-2 text-xs text-muted">
              {changePct != null && (
                <span
                  className={cn(
                    "num inline-flex items-center gap-0.5 rounded px-1 py-px font-medium",
                    good === true && "bg-good/10 text-good",
                    good === false && "bg-bad/10 text-bad",
                    good === null && "bg-surface-2",
                  )}
                >
                  {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
                  {Math.abs(changePct).toFixed(1)}%
                </span>
              )}
              {hint && <span className="min-w-0">{hint}</span>}
            </div>
          </>
        )}
      </Card>
    </m.div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={label} className="cl-segmented inline-flex">
      {options.map((o, index) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active || (!options.some(option => option.value === value) && index === 0) ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(event) => {
              if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
                : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
              onChange(options[next]!.value);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
            }}
            className={cn("relative h-7 rounded-md px-2.5 text-xs font-medium transition-colors", active ? "text-fg" : "text-muted hover:text-fg")}
          >
            {active && (
              <m.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 rounded-md bg-surface-2 ring-1 ring-border"
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
              />
            )}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof ApiError || error instanceof Error ? error.message : "Something went wrong.";
  return (
    <Card role="alert" className="cl-error flex flex-wrap items-start gap-3 p-5">
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">This view could not be loaded</div>
        <p className="mt-1 break-words text-sm text-muted">{message}</p>
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="text-sm font-medium text-accent hover:underline">
          Try again
        </button>
      )}
    </Card>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="cl-page-header mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Operational filters are separate from evidence panels; clearing never changes global scope. */
export function FilterBar({ children, title = "Filter records", summary, onReset, active = false }: {
  children: ReactNode; title?: string; summary?: ReactNode; onReset?: () => void; active?: boolean;
}) {
  return <section className="cl-filter-bar" aria-label={title}>
    <div className="cl-filter-heading">
      <h2>{title}</h2>
      {summary && <span role="status" className="num text-xs text-muted">{summary}</span>}
      {onReset && <Button size="sm" variant="ghost" disabled={!active} onClick={onReset}>Clear filters</Button>}
    </div>
    <div className="cl-filter-fields">{children}</div>
  </section>;
}

export function SectionHeading({ title, note }: { title: string; note?: string }) {
  return <div className="cl-section-heading"><h2>{title}</h2>{note && <p>{note}</p>}</div>;
}

/** Inline evidence keeps table context while bringing a newly opened review into view. */
export function EvidencePanel({ title, children, onClose }: { title: ReactNode; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const returnFocus = useRef(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const returnTable = useRef(returnFocus.current?.closest<HTMLElement>('[role="table"]') ?? null);
  const returnRow = useRef(returnFocus.current?.closest<HTMLElement>('[data-row-id]')?.dataset.rowId);
  const returnText = useRef(returnFocus.current?.textContent);
  const id = useId();
  useEffect(() => {
    const panel = ref.current;
    panel?.focus({ preventScroll: true });
    panel?.scrollIntoView({ block: "nearest", behavior: "instant" });
    return () => {
      const previous = returnFocus.current;
      if (panel?.contains(document.activeElement) && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return <Card ref={ref} tabIndex={-1} aria-labelledby={id} className="cl-evidence mt-4">
    <div className="cl-evidence-header"><h2 id={id} className="min-w-0 break-words text-sm font-semibold">{title}</h2><Button variant="ghost" onClick={() => {
      onClose();
      // Closing can also replace virtual cells. Restore focus after that commit, not before it.
      requestAnimationFrame(() => {
        const row = returnRow.current ? returnTable.current?.querySelector(`[data-row-id="${CSS.escape(returnRow.current)}"]`) : null;
        const replacement = Array.from(row?.querySelectorAll<HTMLElement>("button, a") ?? []).find(element => element.textContent === returnText.current);
        const target = returnFocus.current?.isConnected ? returnFocus.current : replacement ?? returnTable.current;
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    }}>Close details</Button></div>
    <div className="space-y-3 p-[var(--cl-pad)]">{children}</div>
  </Card>;
}
