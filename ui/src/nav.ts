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
  /** Route inside /v2. Screens without a React view yet open a hand-off page to the classic UI. */
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

const classic = (id: string, label: string, icon: LucideIcon, keywords: string[] = [], adminOnly = false): Screen => ({
  id,
  label,
  icon,
  to: `/classic/${id}`,
  migrated: false,
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
      classic("ai-billing", "AI Billing", Brain, ["openai", "foundry", "tokens"]),
    ],
  },
  {
    id: "optimize",
    label: "Optimize",
    icon: Gauge,
    screens: [
      classic("savings", "Savings", PiggyBank, ["advisor", "rightsizing", "waste"]),
      classic("commitments", "Reservation & Savings", Wallet, ["reservation", "savings plan", "commitment"]),
      classic("performance", "Performance vs Spend", BarChart3, ["metrics"]),
    ],
  },
  {
    id: "govern",
    label: "Govern",
    icon: ShieldCheck,
    screens: [
      classic("budgets", "Budgets", ClipboardList, ["budget", "forecast"]),
      classic("governance", "Governance", ShieldCheck, ["policy"]),
      classic("esu", "End of support", CalendarClock, ["esu", "extended security"]),
      classic("health", "Retirements", ScrollText, ["retirement", "deprecation"]),
      classic("changes", "Change Analysis", GitCompare, ["change"]),
      classic("azure-updates", "Azure Updates", Newspaper, ["news", "status"]),
    ],
  },
  {
    id: "reports",
    label: "Reports",
    icon: FileDown,
    screens: [classic("report", "Export data", FileDown, ["excel", "csv", "powerpoint", "download"])],
  },
  {
    id: "admin",
    label: "Admin",
    icon: Database,
    screens: [
      { id: "setup", label: "Setup progress", icon: CloudDownload, to: "/admin/setup", migrated: true, keywords: ["exports", "backfill", "onboarding", "history"] },
      classic("settings", "Cost data", Database, ["exports", "ingest", "setup"]),
      classic("audit", "Audit log", ScrollText, ["access", "who"], true),
    ],
  },
];

export const SCREENS: Screen[] = WORKSPACES.flatMap((w) => w.screens);

export function screenById(id: string): Screen | undefined {
  return SCREENS.find((s) => s.id === id);
}
