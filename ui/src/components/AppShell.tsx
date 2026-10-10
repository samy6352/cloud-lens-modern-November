import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { Dialog, DropdownMenu } from "radix-ui";
import {
  Check,
  ChevronDown,
  ExternalLink,
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
  Menu,
  X,
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

function Sidebar({ mobile = false, onNavigate }: { mobile?: boolean; onNavigate?: () => void }) {
  const { sidebarCollapsed: collapsed } = usePrefs();
  const compact = !mobile && collapsed;
  const me = useQuery(meQuery);
  const current = useCurrentScreen();
  const search = useSearch({ from: "__root__" });

  return (
    <aside
      className={cn(
        "cl-sidebar sticky top-0 h-dvh shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-300 ease-out-soft",
        mobile ? "flex w-full" : compact ? "hidden w-16 sm:flex" : "hidden w-56 sm:flex",
      )}
    >
      <div className="flex h-14 items-center gap-2.5 px-4">
        <img src={logo} alt="" className="size-7 shrink-0" />
        {!compact && (
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight">CloudLens</div>
            <div className="text-[10px] uppercase tracking-widest text-muted">Cost intelligence / v3</div>
          </div>
        )}
        {mobile && <Dialog.Close asChild><Button variant="ghost" size="icon" className="ml-auto" aria-label="Close navigation"><X /></Button></Dialog.Close>}
      </div>

      <nav aria-label="Workspaces" className="flex-1 overflow-y-auto px-2 pb-4">
        {WORKSPACES.map((ws) => {
          const screens = ws.screens.filter((s) => !s.adminOnly || me.data?.user?.admin);
          if (!screens.length) return null;
          return (
            <div key={ws.id} className="mt-4 first:mt-1">
              {!compact && ws.screens.length > 1 && (
               <div className="cl-nav-label px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">{ws.label}</div>
              )}
              <ul className="space-y-0.5">
                {screens.map((s) => {
                  const active = s.id === current.id;
                  const Icon = s.icon;
                  return (
                    <li key={s.id}>
                      <Link
                        to={s.to}
                        search={search}
                        title={s.label}
                        aria-label={s.label}
                        aria-current={active ? "page" : undefined}
                        onClick={onNavigate}
                        className={cn(
                          "cl-nav-link group relative flex min-h-9 items-center gap-2.5 px-2.5 text-xs transition-colors",
                          active ? "text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
                        )}
                      >
                        <Icon className="relative size-4 shrink-0" />
                        {!compact && (
                          <>
                            <span className="relative min-w-0">{s.label}</span>
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

      {!mobile && <div className="hidden border-t border-border p-2 sm:block">
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
      </div>}
    </aside>
  );
}

function MobileNavigation() {
  const [open, setOpen] = useState(false);
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><Button size="icon" variant="ghost" className="sm:hidden" aria-label="Open navigation"><Menu /></Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <Dialog.Content className="cl-mobile-nav fixed inset-y-0 left-0 z-50 w-[min(320px,90vw)] bg-surface" aria-describedby={undefined}>
        <Dialog.Title className="sr-only">CloudLens navigation</Dialog.Title>
        <Sidebar mobile onNavigate={() => setOpen(false)} />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
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
          <DropdownMenu.Item className={item} onSelect={() => window.location.assign("/")}>
            <ExternalLink /> Classic interface
          </DropdownMenu.Item>
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
    try { await client.invalidateQueries(); }
    finally { setSpinning(false); }
  };

  return (
    <header className="cl-topbar z-30 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-3 py-2 sm:sticky sm:top-0 sm:px-5">
      <div className="order-1 flex min-w-0 max-w-full items-center gap-1.5 text-xs">
        <MobileNavigation />
        {workspace && workspace.screens.length > 1 && (
          <>
            <span className="text-muted">{workspace.label}</span>
            <ChevronDown className="size-3.5 -rotate-90 text-muted" />
          </>
        )}
        <span className="truncate font-medium">{screen.label}</span>
      </div>

      <button
        type="button"
        onClick={onOpenPalette}
        className="order-2 ml-auto flex h-8 shrink-0 items-center gap-2 rounded-md border border-border bg-surface px-2 text-xs text-muted transition-colors hover:border-accent/40 sm:ml-3 xl:w-56"
      >
        <Search className="size-4" />
        <span className="sr-only lg:not-sr-only">Find a view or action</span>
        <span className="ml-auto hidden gap-1 xl:flex">
          <Kbd>{mac ? "⌘" : "Ctrl"}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div className="cl-context-bar order-4 flex w-full min-w-0 flex-wrap items-center gap-2 border-t border-border pt-2">
        <span className="hidden text-[10px] font-semibold uppercase tracking-widest text-muted lg:block">Reporting context</span>
        <MonthPicker />
        <CurrencyPicker />
        <ScopePicker />
      </div>
      <div className="order-3 flex items-center gap-1 sm:ml-auto sm:gap-2">
        <Button variant="ghost" size="icon" disabled={spinning} onClick={() => void refresh()} aria-label={spinning ? "Refreshing data" : "Refresh data"} title="Refresh data">
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
          tabIndex={-1}
          key={pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="cl-content mx-auto min-w-0 w-full max-w-[1600px] flex-1 px-3 py-4 sm:px-5 sm:py-5"
        >
          <Outlet />
        </m.main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} navigate={navigate} />
    </div>
  );
}
