import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";

export const ADVISOR_PILLARS = [
  { category: "Cost", label: "Cost" },
  { category: "Security", label: "Security" },
  { category: "HighAvailability", label: "High availability" },
  { category: "OperationalExcellence", label: "Operational excellence" },
  { category: "Performance", label: "Performance" },
] as const;

export type AdvisorCategory = typeof ADVISOR_PILLARS[number]["category"];
export interface AdvisorScorePillar {
  category: AdvisorCategory;
  label: string;
  score: number | null;
  date: string | null;
  impacted_resources: number | null;
  potential_increase: number | null;
}
export interface AdvisorScoreReport {
  pillars: Array<{
    category: AdvisorCategory;
    label: string;
    score: number | null;
    available_subscriptions: number;
    total_subscriptions: number;
  }>;
  subscriptions: Array<{
    subscription_id: string;
    status: "ok" | "partial" | "error";
    error: string | null;
    pillars: AdvisorScorePillar[];
  }>;
  partial: boolean;
  errors: Array<{ subscription_id: string; message: string }>;
  aggregation: "unweighted_mean";
  note: string;
}

/** Azure already returns percentages, not fractions. Missing/invalid evidence is never a score. */
export function advisorScore(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? `${value.toFixed(1)}%`
    : "Unavailable";
}

export function advisorScoreDate(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Timestamp unavailable";
  return `${new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")} UTC`;
}

export function advisorScoreIncomplete(data: AdvisorScoreReport): boolean {
  return data.partial || data.errors.length > 0 || data.subscriptions.some(s => s.status !== "ok") ||
    ADVISOR_PILLARS.some(({ category }) => {
      const pillar = data.pillars.find(p => p.category === category);
      return !pillar || advisorScore(pillar.score) === "Unavailable" ||
        pillar.available_subscriptions < pillar.total_subscriptions;
    });
}

export function advisorScoreQuery(scope?: string) {
  return queryOptions({
    queryKey: ["advisor-score", scope ?? ""],
    queryFn: async ({ signal }) => {
      const data = await api<AdvisorScoreReport>("dashboard/advisor-score", { scope }, { signal });
      if (!data || !Array.isArray(data.pillars) || !Array.isArray(data.subscriptions) ||
        !Array.isArray(data.errors) || data.aggregation !== "unweighted_mean") {
        throw new Error("Advisor Score returned incomplete evidence. Try again.");
      }
      return data;
    },
    staleTime: 60_000,
  });
}
