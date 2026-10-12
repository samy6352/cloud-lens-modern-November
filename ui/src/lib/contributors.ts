import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";
import { periodParam } from "./period";
import type { Scope } from "./queries";

export type Dimension = "service" | "subscription" | "resource_group";

export const DIMENSION_LABEL: Record<Dimension, string> = {
  service: "Service",
  subscription: "Subscription",
  resource_group: "Resource group",
};

export interface Contributor {
  name: string;
  currency: string | null;
  cost: number;
  prior: number;
  delta: number;
  /** Null when there was no prior spend to compare with, which is not the same as no change. */
  change_pct: number | null;
  share_pct: number | null;
}

export interface DayTotal {
  currency: string | null;
  cost: number;
  prior: number;
}

export interface DayContributors {
  day: string;
  prior_day: string;
  dimension: Dimension;
  mixed_currency: boolean;
  totals: DayTotal[];
  contributors: Contributor[];
  other: Array<DayTotal & { count: number }>;
}

export const dayContributorsQuery = (s: Scope, day: string, dimension: Dimension) =>
  queryOptions({
    queryKey: ["day-contributors", periodParam(s) ?? "", s.scope ?? "", s.currency ?? "", day, dimension],
    queryFn: ({ signal }) =>
      api<DayContributors>(
        "dashboard/day",
        { day, dimension, scope: s.scope, currency: s.currency, period_month: periodParam(s) },
        { signal },
      ),
    staleTime: 60_000,
    retry: false,
  });

/**
 * Keep only one currency's rows. A day can hold several billing currencies; the panel shows the
 * one the chart is showing, so the two never disagree about the same day.
 */
export function forCurrency(data: DayContributors, currency: string | null): DayContributors {
  if (!data.mixed_currency || currency == null) return data;
  const keep = <T extends { currency: string | null }>(rows: T[]) => rows.filter(r => r.currency === currency);
  return {
    ...data,
    mixed_currency: false,
    totals: keep(data.totals),
    contributors: keep(data.contributors),
    other: keep(data.other),
  };
}
