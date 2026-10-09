/** The look-back windows offered in the top bar. 30 is the default and is never written to the URL. */
export const WINDOW_DAYS = [7, 30, 60, 90] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];
export const DEFAULT_DAYS: WindowDays = 30;

