import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, Coins } from "lucide-react";
import { cn } from "@/lib/cn";
import { currencyOptionsQuery } from "@/lib/queries";
import { Button } from "./ui/button";

/** Display currency. "As billed" keeps native, per-currency figures; a code converts at the stated rate. */
export function CurrencyPicker() {
  const search = useSearch({ from: "__root__" });
  const navigate = useNavigate();
  const options = useQuery(currencyOptionsQuery());
  const supported = options.data?.supported ?? [];
  const item =
    "flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none data-[highlighted]:bg-surface-2";
  const pick = (currency: string | undefined) => void navigate({ to: ".", search: { ...search, currency } });

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="outline" size="md" aria-label="Display currency">
          <Coins className="text-muted max-sm:hidden" />
          <span className="num">{search.currency ?? "As billed"}</span>
          <ChevronDown className="text-muted" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className="z-50 w-56 rounded-xl border border-border bg-surface p-1.5 shadow-card">
          <DropdownMenu.Item className={item} onSelect={() => pick(undefined)}>
            As billed
            <Check className={cn("ml-auto size-4", search.currency ? "opacity-0" : "opacity-100")} />
          </DropdownMenu.Item>
          {supported.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
          {supported.map((c) => (
            <DropdownMenu.Item key={c} className={item} onSelect={() => pick(c)}>
              <span className="num">{c}</span>
              <Check className={cn("ml-auto size-4", search.currency === c ? "opacity-100" : "opacity-0")} />
            </DropdownMenu.Item>
          ))}
          {options.data && (
            <p className="mt-1 border-t border-border px-2 pt-2 text-xs text-muted">
              {options.data.source}
              {options.data.as_of ? ` · ${options.data.as_of}` : ""}
            </p>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
