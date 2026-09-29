import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseNavigateResult } from "@tanstack/react-router";
import { useSearch } from "@tanstack/react-router";
import { Command } from "cmdk";
import { Calendar, ExternalLink, Layers, LogOut, Monitor, Moon, RefreshCw, Rows3, Server, Sun } from "lucide-react";
import { formatMonth, formatMoney } from "@/lib/format";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { meQuery, periodQuery, subscriptionsQuery } from "@/lib/queries";
import { signOut } from "@/lib/session";
import { SCREENS } from "@/nav";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate: UseNavigateResult<string>;
}

const group =
  "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] " +
  "[&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted";
const item =
  "flex h-10 cursor-default select-none items-center gap-3 rounded-lg px-3 text-sm outline-none data-[selected=true]:bg-surface-2 " +
  "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted";

export function CommandPalette({ open, onOpenChange, navigate }: Props) {
  const client = useQueryClient();
  const search = useSearch({ from: "__root__" });
  const prefs = usePrefs();
  const me = useQuery(meQuery);
  const subs = useQuery({ ...subscriptionsQuery, enabled: open });
  const period = useQuery({ ...periodQuery({}), enabled: open });

  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      loop
      overlayClassName="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px]"
      contentClassName="fixed left-1/2 top-[14vh] z-50 w-[min(640px,92vw)] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
    >
      <Command.Input
        autoFocus
        placeholder="Jump to a screen, subscription, month or action…"
        className="h-14 w-full border-b border-border bg-transparent px-4 text-[15px] outline-none placeholder:text-muted"
      />
      <Command.List className="max-h-[min(60vh,440px)] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-8 text-center text-sm text-muted">No matches.</Command.Empty>

        <Command.Group heading="Screens" className={group}>
          {SCREENS.filter((s) => !s.adminOnly || me.data?.user?.admin).map((s) => {
            const Icon = s.icon;
            return (
              <Command.Item
                key={s.id}
                value={`screen ${s.label}`}
                keywords={s.keywords}
                className={item}
                onSelect={() => run(() => void navigate({ to: s.to, search }))}
              >
                <Icon />
                {s.label}
                {!s.migrated && <span className="ml-auto text-[11px] text-muted">classic</span>}
              </Command.Item>
            );
          })}
        </Command.Group>

        <Command.Group heading="Actions" className={group}>
          <Command.Item className={item} value="refresh data reload" onSelect={() => run(() => void client.invalidateQueries())}>
            <RefreshCw /> Refresh data
          </Command.Item>
          <Command.Item
            className={item}
            value="theme dark light toggle"
            onSelect={() => run(() => setPrefs({ theme: document.documentElement.classList.contains("dark") ? "light" : "dark" }))}
          >
            {prefs.theme === "dark" ? <Sun /> : <Moon />} Toggle dark mode
          </Command.Item>
          <Command.Item className={item} value="theme system auto" onSelect={() => run(() => setPrefs({ theme: "system" }))}>
            <Monitor /> Use system theme
          </Command.Item>
          <Command.Item
            className={item}
            value="density compact comfortable rows"
            onSelect={() => run(() => setPrefs({ density: prefs.density === "compact" ? "comfortable" : "compact" }))}
          >
            <Rows3 /> {prefs.density === "compact" ? "Comfortable density" : "Compact density"}
          </Command.Item>
          <Command.Item
            className={item}
            value="numbers lakh crore million indian international"
            onSelect={() => run(() => setPrefs({ numbers: prefs.numbers === "indian" ? "international" : "indian" }))}
          >
            <span className="w-4 text-center text-xs text-muted">₹</span>
            {prefs.numbers === "indian" ? "Show thousand / million" : "Show lakh / crore"}
          </Command.Item>
          <Command.Item
            className={item}
            value="all subscriptions clear scope"
            onSelect={() => run(() => void navigate({ to: ".", search: { ...search, scope: undefined } }))}
          >
            <Layers /> All subscriptions
          </Command.Item>
          <Command.Item className={item} value="classic interface old ui" onSelect={() => run(() => window.location.assign("/"))}>
            <ExternalLink /> Open classic interface
          </Command.Item>
          <Command.Item className={item} value="sign out logout" onSelect={() => run(() => void signOut())}>
            <LogOut /> Sign out
          </Command.Item>
        </Command.Group>

        {period.data?.available_months?.length ? (
          <Command.Group heading="Months" className={group}>
            <Command.Item
              className={item}
              value="month last 30 days rolling"
              onSelect={() => run(() => void navigate({ to: ".", search: { ...search, month: undefined } }))}
            >
              <Calendar /> Last 30 days
            </Command.Item>
            {period.data.available_months.map((m) => (
              <Command.Item
                key={m}
                className={item}
                value={`month ${formatMonth(m)} ${m}`}
                onSelect={() => run(() => void navigate({ to: ".", search: { ...search, month: m } }))}
              >
                <Calendar /> {formatMonth(m)}
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {subs.data?.subscriptions?.length ? (
          <Command.Group heading="Subscriptions" className={group}>
            {subs.data.subscriptions.map((s) => (
              <Command.Item
                key={s.id}
                className={item}
                value={`subscription ${s.name ?? ""} ${s.id}`}
                onSelect={() => run(() => void navigate({ to: ".", search: { ...search, scope: s.id } }))}
              >
                <Server />
                <span className="truncate">{s.name ?? s.id}</span>
                <span className="num ml-auto text-xs text-muted">
                  {formatMoney(s.cost, s.currency, { system: prefs.numbers, compact: true })}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
      </Command.List>
      <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted">
        <span>↑↓ navigate</span>
        <span>↵ select</span>
        <span>esc close</span>
      </div>
    </Command.Dialog>
  );
}
