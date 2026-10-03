import type { LucideIcon } from "lucide-react";
import {
  BadgeIndianRupee,
  BarChart3,
  Bell,
  Boxes,
  Brain,
  CalendarClock,
  ClipboardList,
  Clock,
  CloudDownload,
  Compass,
  Database,
  FileDown,
  GitCompare,
  Gauge,
  History,
  LayoutDashboard,
  Newspaper,
  PiggyBank,
  ScrollText,
  ShieldCheck,
  Tags,
  Wallet,
} from "lucide-react";

export interface Screen {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Native route inside /v2. */
  to: string;
  migrated: boolean;
  keywords?: string[];
  adminOnly?: boolean;
}

export interface Workspace {
  id: string;
  label: string;
  icon: LucideIcon;
  screens: Screen[];
}

const native = (id: string, label: string, icon: LucideIcon, to: string, keywords: string[] = [], adminOnly = false): Screen => ({
  id,
  label,
  icon,
  to,
  migrated: true,
  keywords,
  adminOnly,
});

export const WORKSPACES: Workspace[] = [
  {
    id: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    screens: [{ id: "overview", label: "Overview", icon: LayoutDashboard, to: "/", migrated: true, keywords: ["home", "kpi", "summary"] }],
  },
  {
    id: "explore",
    label: "Explore",
    icon: Compass,
    screens: [
      { id: "billing", label: "Billing", icon: BadgeIndianRupee, to: "/explore/billing", migrated: true, keywords: ["statement", "invoice", "cost"] },
      { id: "uptime", label: "Hourly Billing", icon: Clock, to: "/explore/uptime", migrated: true, keywords: ["uptime", "hours", "usage"] },
      { id: "tags", label: "Cost by Application / Tags", icon: Tags, to: "/explore/tags", migrated: true, keywords: ["application", "tag"] },
      { id: "resources", label: "All resources", icon: Boxes, to: "/explore/resources", migrated: true, keywords: ["inventory", "resource"] },
      { id: "anomalies", label: "Anomalies", icon: Bell, to: "/explore/anomalies", migrated: true, keywords: ["spike", "alert"] },
      { id: "history", label: "History", icon: History, to: "/explore/history", migrated: true, keywords: ["archive", "compare"] },
      native("ai-billing", "AI Billing", Brain, "/explore/ai-billing", ["openai", "foundry", "tokens"]),
    ],
  },
  {
    id: "optimize",
    label: "Optimize",
    icon: Gauge,
    screens: [
      native("savings", "Savings", PiggyBank, "/optimize/savings", ["advisor", "rightsizing", "waste"]),
      native("commitments", "Reservation & Savings", Wallet, "/optimize/commitments", ["reservation", "savings plan", "commitment"]),
      native("performance", "Performance vs Spend", BarChart3, "/optimize/performance", ["metrics"]),
    ],
  },
  {
    id: "govern",
    label: "Govern",
    icon: ShieldCheck,
    screens: [
      native("budgets", "Budgets", ClipboardList, "/govern/budgets", ["budget", "forecast"]),
      native("governance", "Governance", ShieldCheck, "/govern/governance", ["policy"]),
      native("esu", "End of support", CalendarClock, "/govern/esu", ["esu", "extended security"]),
      native("health", "Retirements", ScrollText, "/govern/retirements", ["retirement", "deprecation"]),
      native("changes", "Change Analysis", GitCompare, "/govern/changes", ["change"]),
      native("azure-updates", "Azure Updates", Newspaper, "/govern/azure-updates", ["news", "status"]),
    ],
  },
  {
    id: "reports",
    label: "Reports",
    icon: FileDown,
    screens: [native("report", "Export data", FileDown, "/reports/export", ["excel", "csv", "powerpoint", "download"])],
  },
  {
    id: "admin",
    label: "Admin",
    icon: Database,
    screens: [
      { id: "setup", label: "Setup progress", icon: CloudDownload, to: "/admin/setup", migrated: true, keywords: ["exports", "backfill", "onboarding", "history"] },
      native("settings", "Cost data", Database, "/admin/cost-data", ["exports", "ingest", "setup"]),
      native("audit", "Audit log", ScrollText, "/admin/audit", ["access", "who"], true),
    ],
  },
];

export const SCREENS: Screen[] = WORKSPACES.flatMap((w) => w.screens);

export function screenById(id: string): Screen | undefined {
  return SCREENS.find((s) => s.id === id);
}
