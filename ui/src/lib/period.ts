/** The look-back windows offered in the top bar. 30 is the default and is never written to the URL. */
export const WINDOW_DAYS = [7, 30, 60, 90] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];
export const DEFAULT_DAYS: WindowDays = 30;
export const MAX_RANGE_DAYS = 366;

export const ISO_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const toUtc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** Whole days covered by an inclusive range; NaN when either end is not a real date. */
export function rangeDays(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000) + 1;
}

export function validRange(from: string | undefined, to: string | undefined): from is string {
  if (!from || !to || !ISO_DAY.test(from) || !ISO_DAY.test(to)) return false;
  if (new Date(toUtc(from)).toISOString().slice(0, 10) !== from || new Date(toUtc(to)).toISOString().slice(0, 10) !== to) return false;
  const days = rangeDays(from, to);
  return days >= 1 && days <= MAX_RANGE_DAYS;
}

/** The one `period_month` value the server understands: a month, or `from..to` for a custom range. */
export function periodParam(s: { month?: string; from?: string; to?: string }): string | undefined {
  if (s.month) return s.month;
  return validRange(s.from, s.to) ? `${s.from}..${s.to}` : undefined;
}

export function formatRange(from: string, to: string): string {
  const fmt = (iso: string, withYear: boolean) =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" }).format(toUtc(iso));
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${fmt(from, !sameYear)} – ${fmt(to, true)}`;
}

