import { Children, cloneElement, isValidElement, useId, type ReactNode } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { ApiError } from "@/lib/api";
import { resourcePortal, safeOfficialUrl } from "@/lib/govern-queries";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { ErrorState } from "./blocks";

export const governInput = "h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
export function GovernField({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return <div className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted"><label htmlFor={id}>{label}</label>
    {Children.map(children, (child, index) => index === 0 && isValidElement<{ id?: string }>(child) ? cloneElement(child, { id }) : child)}
  </div>;
}
export function GovernSelect({ label, value, onChange, options, all = "All" }: {
  label: string; value: string; onChange: (v: string) => void; options: string[]; all?: string;
}) {
  return <GovernField label={label}><select className={governInput} value={value} onChange={e => onChange(e.target.value)}>
    <option value="">{all}</option>{[...new Set([...options, ...(value ? [value] : [])])].sort().map(v => <option key={v} value={v}>{v === "__missing" ? "Not specified" : v}</option>)}
  </select></GovernField>;
}
export function GovernNotice({ children, warning = false }: { children: ReactNode; warning?: boolean }) {
  return <div role="status" className={`cl-notice border-l-2 p-3 text-sm ${warning ? "border-warn/60 bg-warn/5 text-warn" : "border-border bg-surface-2 text-muted"}`}>{children}</div>;
}
export function GovernLoading() { return <Card className="p-6 text-sm text-muted" role="status">Loading live evidence…</Card>; }
export function GovernError({ error, retry }: { error: unknown; retry: () => void }) {
  return <div className="space-y-3">{error instanceof ApiError && <GovernNotice warning>
    {error.status === 403 ? "Access denied. This is not an empty result." : error.status >= 500 ? "Source unavailable. No conclusion about your resources can be drawn." : `Request rejected (${error.status}).`}
  </GovernNotice>}<ErrorState error={error} onRetry={retry} /></div>;
}
export function GovernRefresh({ busy, disabled = false, onClick }: { busy: boolean; disabled?: boolean; onClick: () => void }) {
  return <Button onClick={onClick} disabled={busy || disabled}><RefreshCw className={busy ? "animate-spin" : ""} />{busy ? "Refreshing…" : "Refresh read"}</Button>;
}
export function GovernLink({ url, resourceId, children = "Open in Azure" }: { url?: string | null; resourceId?: string | null; children?: ReactNode }) {
  const href = resourceId ? resourcePortal(resourceId) : safeOfficialUrl(url);
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">{children}<ExternalLink className="size-3" /></a> : null;
}
export function GovernDetails({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <details className="rounded-xl border border-border bg-surface p-4"><summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{title}</summary><div className="mt-3 space-y-3 text-sm text-muted">{children}</div></details>;
}
export function evidenceDate(value?: string | null): string {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Not provided";
}
export function evidenceValue(value: unknown): string {
  if (value == null) return "Not provided";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
