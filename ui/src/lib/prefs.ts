import { useSyncExternalStore } from "react";
import type { NumberSystem } from "./format";

export type Theme = "light" | "dark" | "system";
export type Density = "comfortable" | "compact";

export interface Prefs {
  theme: Theme;
  density: Density;
  numbers: NumberSystem;
  sidebarCollapsed: boolean;
}

// public/theme.js reads the same key before first paint; keep the two in step.
const KEY = "cl.v3.prefs";
const DEFAULTS: Prefs = { theme: "system", density: "compact", numbers: "indian", sidebarCollapsed: false };

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

let state: Prefs = typeof localStorage === "undefined" ? DEFAULTS : read();
const listeners = new Set<() => void>();
const media = typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)");

function apply(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const dark = state.theme === "dark" || (state.theme === "system" && !!media?.matches);
  root.classList.toggle("dark", dark);
  root.dataset.density = state.density;
}

media?.addEventListener("change", () => {
  if (state.theme === "system") {
    apply();
    listeners.forEach((l) => l());
  }
});

export function setPrefs(patch: Partial<Prefs>): void {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private browsing: the choice lasts for this page only */
  }
  apply();
  listeners.forEach((l) => l());
}

export function isDark(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, () => state, () => DEFAULTS);
}

apply();
