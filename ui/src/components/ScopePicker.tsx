import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { Command } from "cmdk";
import { Popover } from "radix-ui";
import { Check, ChevronDown, Layers } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/format";
import { usePrefs } from "@/lib/prefs";
import { subscriptionsQuery } from "@/lib/queries";
import { Button } from "./ui/button";

export function ScopePicker() {
  const search = useSearch({ from: "__root__" });
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { numbers } = usePrefs();
  const subs = useQuery(subscriptionsQuery);
  const [open, setOpen] = useState(false);

  const selected = useMemo(() => new Set((search.scope ?? "").split(",").filter(Boolean)), [search.scope]);
  const list = subs.data?.subscriptions ?? [];
  const names = new Map(list.map((s) => [s.id.toLowerCase(), s.name ?? s.id]));
  const selectedIds = new Set([...selected].map(id => id.toLowerCase()));
  const routePath = pathname.replace(/^\/v2(?=\/|$)/, "") || "/";
  const liveOnly = routePath.startsWith("/govern/") || routePath.startsWith("/admin/")
    || routePath === "/optimize/performance";
  const historicalSelected = list.some(s => selectedIds.has(s.id.toLowerCase()) && s.azure_access === false);

  const apply = (next: Set<string>) =>
    void navigate({ to: ".", search: { ...search, scope: next.size ? [...next].join(",") : undefined } });

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (selectedIds.has(id.toLowerCase())) {
      for (const existing of next) if (existing.toLowerCase() === id.toLowerCase()) next.delete(existing);
    }
    else next.add(id);
    apply(next);
  };

  const label =
    selected.size === 0
      ? `All subscriptions${subs.data ? ` (${subs.data.count})` : ""}`
      : selected.size === 1
        ? (names.get([...selected][0]!.toLowerCase()) ?? "1 subscription")
        : `${selected.size} subscriptions`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="outline" size="md" className="max-w-64" aria-label="Subscription scope">
          <Layers className="text-muted" />
          <span className="truncate">{label}{historicalSelected ? " · historical" : ""}</span>
          <ChevronDown className="text-muted" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} className="z-50 w-96 overflow-hidden rounded-xl border border-border bg-surface shadow-card">
          {historicalSelected && <p role="status" className="border-b border-border p-3 text-xs text-warn">Selected historical subscriptions retain imported costs, but are not currently Azure-accessible. Choose a current subscription for live evidence or administration; your scope has not been changed.</p>}
          {liveOnly && <p className="border-b border-border p-3 text-xs text-muted">Historical-only subscriptions cannot be added to this live/admin view. Return to Billing to inspect their imported costs.</p>}
          <Command loop>
            <Command.Input
              placeholder="Filter subscriptions…"
              className="h-11 w-full border-b border-border bg-transparent px-3 text-sm outline-none placeholder:text-muted"
            />
            <Command.List className="max-h-80 overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted">No subscriptions match.</Command.Empty>
              <Command.Item
                value="__all__ all subscriptions"
                onSelect={() => apply(new Set())}
                className="flex h-9 cursor-default items-center gap-2 rounded-md px-2 text-sm data-[selected=true]:bg-surface-2"
              >
                <Check className={cn("size-4", selected.size === 0 ? "opacity-100" : "opacity-0")} />
                All subscriptions
              </Command.Item>
              {list.map((s) => (
                <Command.Item
                  key={s.id}
                  value={`${s.name ?? ""} ${s.id}`}
                  disabled={liveOnly && s.azure_access === false && !selectedIds.has(s.id.toLowerCase())}
                  onSelect={() => toggle(s.id)}
                  className="flex h-9 cursor-default items-center gap-2 rounded-md px-2 text-sm data-[selected=true]:bg-surface-2"
                >
                  <span
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded border",
                      selectedIds.has(s.id.toLowerCase()) ? "border-accent bg-accent text-accent-fg" : "border-border",
                    )}
                  >
                    {selectedIds.has(s.id.toLowerCase()) && <Check className="size-3" />}
                  </span>
                  <span className="truncate">{s.name ?? s.id}</span>
                  {s.azure_access !== true && <span className="shrink-0 text-xs text-muted">{s.azure_access === false ? "Historical only" : "Live access unverified"}</span>}
                  <span className="num ml-auto shrink-0 text-xs text-muted">
                    {formatMoney(s.cost, s.currency, { system: numbers, compact: true })}
                  </span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
