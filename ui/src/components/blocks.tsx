import { ArrowDownRight, ArrowUpRight, TriangleAlert } from "lucide-react";
import * as m from "motion/react-m";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ApiError } from "@/lib/api";
import { Card } from "./ui/card";
import { Skeleton } from "./ui/skeleton";

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
      <Card className="h-full p-[var(--cl-pad)]">
        <div className="text-xs font-medium text-muted">{label}</div>
        {loading ? (
          <>
            <Skeleton className="mt-3 h-8 w-32" />
            <Skeleton className="mt-2 h-4 w-24" />
          </>
        ) : (
          <>
            <div className="num mt-2 text-[1.75rem] font-semibold leading-tight tracking-tight">{value}</div>
            <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
              {changePct != null && (
                <span
                  className={cn(
                    "num inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium",
                    good === true && "bg-good/10 text-good",
                    good === false && "bg-bad/10 text-bad",
                    good === null && "bg-surface-2",
                  )}
                >
                  {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
                  {Math.abs(changePct).toFixed(1)}%
                </span>
              )}
              {hint && <span className="truncate">{hint}</span>}
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
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn("relative h-7 rounded-md px-2.5 text-xs font-medium transition-colors", active ? "text-fg" : "text-muted hover:text-fg")}
          >
            {active && (
              <m.span
                layoutId={`seg-${label}`}
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
    <Card className="flex items-start gap-3 p-5">
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
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {subtitle && <div className="mt-1 text-sm text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
