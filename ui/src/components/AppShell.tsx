import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { DropdownMenu } from "radix-ui";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Compass,
  LogOut,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Rows3,
  Rows4,
  Search,
  Sun,
} from "lucide-react";
import * as m from "motion/react-m";
import { useEffect, useState } from "react";
import logo from "@/logo.svg";
import { cn } from "@/lib/cn";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { meQuery } from "@/lib/queries";
import { signOut } from "@/lib/session";
import { WORKSPACES, SCREENS } from "@/nav";
import { CommandPalette } from "./CommandPalette";
import { AnalystButton } from "./Analyst";
import { CurrencyPicker } from "./CurrencyPicker";
import { MonthPicker } from "./MonthPicker";
import { ScopePicker } from "./ScopePicker";
import { Button } from "./ui/button";
import { Kbd } from "./ui/skeleton";

export function useCurrentScreen() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const path = pathname.replace(/^\/v2/, "") || "/";
  return SCREENS.find((s) => (s.to === "/" ? path === "/" : path.startsWith(s.to))) ?? SCREENS[0]!;
}

function Sidebar() {
  const { sidebarCollapsed: collapsed } = usePrefs();
  const me = useQuery(meQuery);
  const current = useCurrentScreen();
  const search = useSearch({ from: "__root__" });
  const navigate = useNavigate();
  const workspaces = WORKSPACES.map(ws => ({
    ...ws,
    screens: ws.screens.filter(s => !s.adminOnly || me.data?.user?.admin),
  })).filter(ws => ws.screens.length > 0);
  const activeWorkspace = workspaces.find(ws => ws.screens.some(s => s.id === current.id)) ?? workspaces[0]!;
  const [selection, setSelection] = useState<{ from: string; workspace: string; screen: string }>();
  const pending = selection?.from === current.id ? selection : undefined;
  const workspace = workspaces.find(ws => ws.id === pending?.workspace) ?? activeWorkspace;
  const destination = workspace.screens.find(s => s.id === (pending?.screen ?? current.id)) ?? workspace.screens[0]!;
  const compactSelect = cn(
    "relative h-9 w-full appearance-none rounded-md border border-border bg-surface px-2 text-sm text-transparent focus-visible:outline-2 focus-visible:outline-accent [&_option]:text-fg",
    !collapsed && "sm:pr-7 sm:text-fg",
  );

  return (
    <aside
      className={cn(
        "sticky top-0 flex h-dvh shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-300 ease-out-soft",
        collapsed ? "w-16" : "w-16 sm:w-64",
      )}
    >
      <Link
        to="/"
        search={search}
        activeOptions={{ exact: true }}
        aria-label="CloudLens home"
        title="CloudLens home"
        className="flex h-11 shrink-0 items-center gap-2.5 px-4 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <img src={logo} alt="" className="size-7 shrink-0" />
        {!collapsed && (
          <div className="hidden min-w-0 sm:block">
            <div className="text-sm font-semibold tracking-tight">CloudLens</div>
            <div className="text-[11px] text-muted">v3 preview</div>
          </div>
        )}
      </Link>

      <nav aria-label="Workspaces" className="hidden space-y-2 px-2 py-1 [@media(min-height:49em)]:block">
        {workspaces.map((ws) => {
          return (
            <div key={ws.id}>
              {!collapsed && ws.id !== "overview" && (
                <div className="hidden px-2 text-[11px] font-semibold uppercase tracking-wider text-muted sm:block">{ws.label}</div>
              )}
              <ul>
                {ws.screens.map((s) => {
                  const active = s.id === current.id;
                  const Icon = s.icon;
                  return (
                    <li key={s.id}>
                      <Link
                        to={s.to}
                        search={search}
                        title={s.label}
                        aria-label={s.label}
                        className={cn(
                          "group relative flex h-7 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
                          active ? "text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
                        )}
                      >
                        {active && (
                          <m.span
                            layoutId="nav-active"
                            className="absolute inset-0 rounded-lg bg-surface-2 ring-1 ring-border"
                            transition={{ type: "spring", stiffness: 500, damping: 40 }}
                          />
                        )}
                        <Icon className="relative size-4 shrink-0" />
                        {!collapsed && (
                          <>
                            <span className="relative hidden truncate sm:block">{s.label}</span>
                            {!s.migrated && (
                              <span className="relative ml-auto rounded bg-surface-2 px-1.5 py-px text-[10px] text-muted group-hover:bg-canvas">
                                classic
                              </span>
                            )}
                          </>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <nav aria-label="Workspaces" className="grid gap-1 px-2 py-1 [@media(min-height:49em)]:hidden">
        <div className="relative">
          <select aria-label="Choose workspace" title={`Workspace: ${workspace.label}`} className={compactSelect}
            value={workspace.id} onChange={(event) => {
              const next = workspaces.find(ws => ws.id === event.target.value);
              if (next) setSelection({ from: current.id, workspace: next.id, screen: next.screens[0]!.id });
            }}>
            {workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.label}</option>)}
          </select>
          <workspace.icon aria-hidden className={cn("pointer-events-none absolute inset-0 m-auto size-4", !collapsed && "sm:hidden")} />
          {!collapsed && <ChevronDown aria-hidden className="pointer-events-none absolute inset-y-0 right-2 my-auto hidden size-4 sm:block" />}
        </div>
        <div className="relative">
          <select aria-label="Choose page" title={`Page: ${destination.label}`} className={compactSelect}
            value={destination.id} onChange={(event) => setSelection({ from: current.id, workspace: workspace.id, screen: event.target.value })}>
            {workspace.screens.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <Compass aria-hidden className={cn("pointer-events-none absolute inset-0 m-auto size-4", !collapsed && "sm:hidden")} />
          {!collapsed && <ChevronDown aria-hidden className="pointer-events-none absolute inset-y-0 right-2 my-auto hidden size-4 sm:block" />}
        </div>
        <Button type="button" variant="ghost" size="md" className="h-9 text-muted"
          aria-label={`Go to ${destination.label}`} title={`Go to ${destination.label}`}
          onClick={() => {
            setSelection(undefined);
            void navigate({ to: destination.to, search });
          }}>
          <ArrowRight />
          {!collapsed && <span className="hidden sm:inline">Go to page</span>}
        </Button>
      </nav>

      <div className="mt-auto hidden border-t border-border p-1 sm:block">
        <Button
          variant="ghost"
          size={collapsed ? "icon" : "md"}
          className="w-full justify-start text-muted"
          onClick={() => setPrefs({ sidebarCollapsed: !collapsed })}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          {!collapsed && "Collapse"}
        </Button>
      </div>
    </aside>
  );
}

function PrefsMenu() {
  const prefs = usePrefs();
  const me = useQuery(meQuery);
  const item =
    "flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none data-[highlighted]:bg-surface-2 [&_svg]:size-4";
  const label = "px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted";
  const tick = (on: boolean) => <Check className={cn("ml-auto", on ? "opacity-100" : "opacity-0")} />;
  const initials = (me.data?.user?.name ?? "?").slice(0, 2).toUpperCase();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account and display settings" className="rounded-full">
          <span className="grid size-8 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-fg">{initials}</span>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-50 w-60 rounded-xl border border-border bg-surface p-1.5 shadow-card"
        >
          <div className="px-2 py-1.5">
            <div className="text-sm font-medium">{me.data?.user?.name ?? "Signed in"}</div>
            <div className="text-xs text-muted">{me.data?.user?.admin ? "Administrator" : "Viewer"}</div>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <div className={label}>Theme</div>
          {(
            [
              ["light", "Light", Sun],
              ["dark", "Dark", Moon],
              ["system", "System", Monitor],
            ] as const
          ).map(([value, text, Icon]) => (
            <DropdownMenu.Item key={value} className={item} onSelect={() => setPrefs({ theme: value })}>
              <Icon /> {text} {tick(prefs.theme === value)}
            </DropdownMenu.Item>
          ))}
          <div className={label}>Density</div>
          <DropdownMenu.Item className={item} onSelect={() => setPrefs({ density: "comfortable" })}>
            <Rows3 /> Comfortable {tick(prefs.density === "comfortable")}
          </DropdownMenu.Item>
          <DropdownMenu.Item className={item} onSelect={() => setPrefs({ density: "compact" })}>
            <Rows4 /> Compact {tick(prefs.density === "compact")}
          </DropdownMenu.Item>
          <div className={label}>Numbers</div>
          <DropdownMenu.Item className={item} onSelect={() => setPrefs({ numbers: "indian" })}>
            <span className="w-4 text-center text-xs">₹</span> Lakh / crore {tick(prefs.numbers === "indian")}
          </DropdownMenu.Item>
          <DropdownMenu.Item className={item} onSelect={() => setPrefs({ numbers: "international" })}>
            <span className="w-4 text-center text-xs">$</span> Thousand / million {tick(prefs.numbers === "international")}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item className={item} onSelect={() => void signOut()}>
            <LogOut /> Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const screen = useCurrentScreen();
  const workspace = WORKSPACES.find((w) => w.screens.some((s) => s.id === screen.id));
  const client = useQueryClient();
  const [spinning, setSpinning] = useState(false);
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  const refresh = async () => {
    setSpinning(true);
    await client.invalidateQueries();
    setSpinning(false);
  };

  return (
    <header className="z-30 flex min-h-11 sm:sticky sm:top-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-canvas/80 px-3 py-1.5 backdrop-blur-md sm:gap-x-3 sm:px-5 xl:py-0">
      <div className="order-1 flex min-w-0 max-w-full shrink-0 items-center gap-1.5 text-sm">
        {workspace && workspace.screens.length > 1 && (
          <>
            <span className="text-muted">{workspace.label}</span>
            <ChevronDown className="size-3.5 -rotate-90 text-muted" />
          </>
        )}
        <h1 className="truncate font-semibold">{screen.label}</h1>
      </div>

      <button
        type="button"
        onClick={onOpenPalette}
        className="order-2 ml-2 hidden h-8 shrink-0 items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm text-muted transition-colors hover:border-accent/40 md:flex xl:ml-4 xl:w-72"
      >
        <Search className="size-4" />
        <span className="sr-only xl:not-sr-only">Search or jump to…</span>
        <span className="ml-auto hidden gap-1 xl:flex">
          <Kbd>{mac ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div className="order-4 flex w-full min-w-0 flex-wrap items-center gap-1 pb-0.5 sm:order-3 sm:ml-auto sm:w-auto sm:gap-2 sm:pb-0">
        <MonthPicker />
        <CurrencyPicker />
        <ScopePicker />
      </div>
      <div className="order-3 ml-auto flex items-center gap-1 sm:order-4 sm:ml-0 sm:gap-2">
        <AnalystButton />
        <Button variant="ghost" size="icon" onClick={() => void refresh()} aria-label="Refresh data" title="Refresh data">
          <RefreshCw className={cn(spinning && "animate-spin")} />
        </Button>
        <PrefsMenu />
      </div>
    </header>
  );
}

export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Keyed on the *resolved* location: while a lazy route is still loading, the old page stays put
  // instead of replaying its entrance animation under the new URL.
  const pathname = useRouterState({ select: (s) => s.resolvedLocation?.pathname ?? s.location.pathname });
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenPalette={() => setPaletteOpen(true)} />
        <m.main
          id="main"
          key={pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className={cn("cl-content mx-auto w-full min-w-0 max-w-[1600px] flex-1 px-3 pb-3 sm:px-5 sm:pb-4",
            pathname === "/v2" || pathname === "/v2/" ? "pt-2" : "pt-3 sm:pt-4")}
        >
          <Outlet />
        </m.main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} navigate={navigate} />
    </div>
  );
}
