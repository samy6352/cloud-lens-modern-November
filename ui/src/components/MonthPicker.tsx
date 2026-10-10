import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { DropdownMenu, Popover } from "radix-ui";
import { Calendar, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatMonth } from "@/lib/format";
import { DEFAULT_DAYS, formatRange, MAX_RANGE_DAYS, rangeDays, validRange, WINDOW_DAYS } from "@/lib/period";
import { periodQuery } from "@/lib/queries";
import { Button } from "./ui/button";

const today = () => new Date().toISOString().slice(0, 10);

export function MonthPicker() {
  const search = useSearch({ from: "__root__" });
  const navigate = useNavigate();
  const period = useQuery(periodQuery({}));
  const months = period.data?.available_months ?? [];
  const days = search.days ?? DEFAULT_DAYS;
  const ranged = validRange(search.from, search.to);
  const [custom, setCustom] = useState(false);
  const wantsCustom = useRef(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const item =
    "flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none data-[highlighted]:bg-surface-2";
  // A window, a calendar month and a custom range are alternatives: choosing one clears the others.
  const pick = (next: { month?: string; days?: number; from?: string; to?: string }) =>
    void navigate({
      to: ".",
      search: {
        ...search,
        month: next.month,
        from: next.from,
        to: next.to,
        days: next.days === DEFAULT_DAYS ? undefined : (next.days as typeof search.days),
      },
    });

  const span = from && to ? rangeDays(from, to) : NaN;
  const problem = !from || !to ? "Pick both dates." : !validRange(from, to)
    ? span < 1 ? "The end date must not be before the start." : `A range can cover at most ${MAX_RANGE_DAYS} days.`
    : "";
  const label = search.month ? formatMonth(search.month) : ranged ? formatRange(search.from!, search.to!) : `Last ${days} days`;
  // Opened only once the menu has finished closing: the focus it hands back to the trigger would
  // otherwise read as an outside interaction and dismiss the popover straight away.
  const openCustom = () => {
    setFrom(search.from ?? "");
    setTo(search.to ?? "");
    wantsCustom.current = true;
  };

  return (
    <Popover.Root open={custom} onOpenChange={setCustom}>
      <DropdownMenu.Root>
        <Popover.Anchor asChild>
          <DropdownMenu.Trigger asChild>
            <Button variant="outline" size="md" aria-label="Reporting period">
              <Calendar className="text-muted max-sm:hidden" />
              <span className="num">{label}</span>
              <ChevronDown className="text-muted" />
            </Button>
          </DropdownMenu.Trigger>
        </Popover.Anchor>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={8}
            className="z-50 w-52 rounded-xl border border-border bg-surface p-1.5 shadow-card"
            onCloseAutoFocus={(e) => {
              if (!wantsCustom.current) return;
              e.preventDefault();
              wantsCustom.current = false;
              setCustom(true);
            }}
          >
            {WINDOW_DAYS.map((d) => (
              <DropdownMenu.Item key={d} className={item} onSelect={() => pick({ days: d })}>
                Last {d} days
                <Check className={cn("ml-auto size-4", !search.month && !ranged && days === d ? "opacity-100" : "opacity-0")} />
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Item className={item} onSelect={openCustom}>
              Custom range…
              <Check className={cn("ml-auto size-4", ranged ? "opacity-100" : "opacity-0")} />
            </DropdownMenu.Item>
            {months.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
            {months.map((m) => (
              <DropdownMenu.Item key={m} className={item} onSelect={() => pick({ month: m })}>
                <span className="num">{formatMonth(m)}</span>
                <Check className={cn("ml-auto size-4", search.month === m ? "opacity-100" : "opacity-0")} />
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          aria-label="Custom date range"
          className="z-50 w-64 rounded-xl border border-border bg-surface p-3 shadow-card"
        >
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (problem) return;
              setCustom(false);
              pick({ from, to });
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-muted">
              From
              <input type="date" value={from} max={to || today()} onChange={(e) => setFrom(e.target.value)}
                className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-fg" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              To
              <input type="date" value={to} min={from || undefined} max={today()} onChange={(e) => setTo(e.target.value)}
                className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-fg" />
            </label>
            <p role="status" className="min-h-4 text-xs text-muted">
              {problem || `${span} ${span === 1 ? "day" : "days"}, both ends included`}
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="md" onClick={() => setCustom(false)}>Cancel</Button>
              <Button type="submit" size="md" disabled={!!problem}>Apply</Button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
