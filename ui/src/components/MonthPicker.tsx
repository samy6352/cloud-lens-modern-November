import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { DropdownMenu } from "radix-ui";
import { Calendar, Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatMonth } from "@/lib/format";
import { periodQuery } from "@/lib/queries";
import { Button } from "./ui/button";

export function MonthPicker() {
  const search = useSearch({ from: "__root__" });
  const navigate = useNavigate();
  const period = useQuery(periodQuery({}));
  const months = period.data?.available_months ?? [];
  const item =
    "flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none data-[highlighted]:bg-surface-2";
  const pick = (month: string | undefined) => void navigate({ to: ".", search: { ...search, month } });

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="outline" size="md" aria-label="Reporting period">
          <Calendar className="text-muted" />
          <span className="num">{search.month ? formatMonth(search.month) : "Last 30 days"}</span>
          <ChevronDown className="text-muted" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className="z-50 w-48 rounded-xl border border-border bg-surface p-1.5 shadow-card">
          <DropdownMenu.Item className={item} onSelect={() => pick(undefined)}>
            Last 30 days
            <Check className={cn("ml-auto size-4", search.month ? "opacity-0" : "opacity-100")} />
          </DropdownMenu.Item>
          {months.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
          {months.map((m) => (
            <DropdownMenu.Item key={m} className={item} onSelect={() => pick(m)}>
              <span className="num">{formatMonth(m)}</span>
              <Check className={cn("ml-auto size-4", search.month === m ? "opacity-100" : "opacity-0")} />
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
