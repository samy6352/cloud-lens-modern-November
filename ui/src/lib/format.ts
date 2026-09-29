export type NumberSystem = "indian" | "international";

export interface MoneyOptions {
  system?: NumberSystem;
  /** Short form for tiles and axes: ₹1.24 Cr / $3.4M. Full form for tables and tooltips. */
  compact?: boolean;
  /** Fraction digits for the full form. Defaults to 0 at or above 100, 2 below. */
  digits?: number;
}

const symbolCache = new Map<string, string>();

/** The currency's narrow symbol (₹, $, €), or the code itself when Intl does not know it. */
export function currencySymbol(currency: string | null | undefined): string {
  const code = (currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return "";
  const hit = symbolCache.get(code);
  if (hit !== undefined) return hit;
  let symbol = code + " ";
  try {
    const part = new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    })
      .formatToParts(0)
      .find((p) => p.type === "currency");
    if (part) symbol = part.value;
  } catch {
    /* unknown code: keep "XYZ " */
  }
  symbolCache.set(code, symbol);
  return symbol;
}

function trim(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0+$|(\.\d*?)0+$/, "$1");
}

/** Plain number with the chosen grouping: 12,34,56,789 (Indian) or 123,456,789 (international). */
export function formatNumber(
  value: number | null | undefined,
  { system = "international", compact = false, digits }: MoneyOptions = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (compact) {
    const steps: Array<[number, string]> =
      system === "indian"
        ? [[1e7, " Cr"], [1e5, " L"], [1e3, "K"]]
        : [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
    for (const [size, suffix] of steps) {
      if (abs >= size) {
        const scaled = abs / size;
        return sign + trim(scaled, scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2) + suffix;
      }
    }
    return sign + trim(abs, abs >= 100 ? 0 : 2);
  }
  const fraction = digits ?? (abs >= 100 ? 0 : 2);
  return (
    sign +
    new Intl.NumberFormat(system === "indian" ? "en-IN" : "en-US", {
      minimumFractionDigits: fraction,
      maximumFractionDigits: fraction,
    }).format(abs)
  );
}

export function formatMoney(
  value: number | null | undefined,
  currency: string | null | undefined,
  options: MoneyOptions = {},
): string {
  const body = formatNumber(value, options);
  if (body === "—") return body;
  const symbol = currencySymbol(currency);
  return body.startsWith("-") ? `-${symbol}${body.slice(1)}` : `${symbol}${body}`;
}

/** Signed percentage change, e.g. "+12.4%". Null when there is no base to compare with. */
export function formatDelta(current: number | null | undefined, previous: number | null | undefined): string | null {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return null;
  }
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09" -> "Sep 2026". Anything else is returned unchanged. */
export function formatMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const name = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && name ? `${name} ${m[1]}` : month;
}
