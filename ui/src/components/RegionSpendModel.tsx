import type { Ranked } from "@/lib/queries";

/** Currency codes, not incomparable monetary magnitudes, determine the default view. */
export function orderCurrencyViews<T extends { currency: string | null }>(views: T[]): T[] {
  return [...views].sort((a, b) => (a.currency ?? "").localeCompare(b.currency ?? ""));
}

export function regionKey(row: Ranked): string {
  return row.id ?? row.name;
}

export function regionLabel(row: Ranked): string {
  return row.label?.trim() || row.name?.trim() || "Unspecified region";
}

/** Only the returned rows in one currency are summarized; this is not an estate-wide total. */
export function regionSpendModel(rows: Ranked[], currency: string | null) {
  const ranked = rows.filter((row) => Number.isFinite(row.cost)).sort((a, b) => b.cost - a.cost);
  const net = ranked.reduce((sum, row) => sum + row.cost, 0);
  const credits = ranked.filter((row) => row.cost < 0).reduce((sum, row) => sum + row.cost, 0);
  const hasUnavailable = ranked.length !== rows.length;
  const canDistribute = ranked.length > 0 && !hasUnavailable && credits === 0 && net > 0;
  const segments = canDistribute
    ? ranked.filter((row) => row.cost > 0).slice(0, 5).map((row) => ({
        name: regionLabel(row),
        value: row.cost,
        key: regionKey(row),
      }))
    : [];
  if (canDistribute) {
    const other = ranked.filter((row) => row.cost > 0).slice(5).reduce((sum, row) => sum + row.cost, 0);
    if (other > 0) segments.push({ name: "Other reported regions", value: other, key: "__other" });
  }
  return { currency, ranked, net: hasUnavailable ? null : net, credits, canDistribute, segments, hasUnavailable };
}
