import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { Newspaper, Radio, ShieldCheck } from "lucide-react";
import { FilterBar, KpiTile, PageHeader } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { evidenceDate, GovernDetails, GovernError, GovernField, GovernLink, GovernLoading, GovernNotice, GovernRefresh, GovernSelect, governInput } from "@/components/GovernControls";
import { emptyFeedFilters, explicitScopes, feedQuery, filterArticles, globalScope, needsAttention, type AzureArticle, type FeedSource } from "@/lib/govern-queries";
import type { Scope } from "@/lib/queries";

function Article({ item }: { item: AzureArticle }) {
  return <details className={`cl-article group overflow-hidden border-b bg-surface ${needsAttention(item) ? "border-l-2 border-warn/40" : "border-border"}`}>
    <summary className="cursor-pointer list-none p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted"><span className="rounded-full bg-accent/10 px-2 py-1 font-medium text-accent">{item.category || item.type || "Other"}</span>
        {item.status && <span>{item.status}</span>}{item.level && <span>{item.level}</span>}<time>{evidenceDate(item.updated_at || item.published_at)}</time>{needsAttention(item) && <span className="font-medium text-warn">Customer attention</span>}</div>
      <h3 className="text-base font-semibold tracking-tight">{item.title || "Untitled notice"}</h3>
      {item.services?.length ? <p className="mt-2 text-sm text-muted">{item.services.join(" · ")}</p> : null}
      <p className="mt-2 line-clamp-2 text-sm text-muted">{item.summary || "Expand to inspect source and impact details."}</p><span className="mt-3 block text-xs font-medium text-accent">Read details <span className="group-open:hidden">↓</span></span>
    </summary>
    <div className="space-y-3 border-t border-border p-5 text-sm"><p className="whitespace-pre-wrap">{item.summary || "No summary supplied."}</p>
      {item.customer_impact && <p><strong>Customer impact:</strong> {item.customer_impact}</p>}{item.actions && <p><strong>Recommended actions:</strong> {item.actions}</p>}
      <div className="grid gap-2 text-muted sm:grid-cols-2"><p>Regions: {item.regions?.join(", ") || "Not specified"}</p><p>Tracking: {item.tracking_id || "Not specified"}</p><p>Published: {evidenceDate(item.published_at)}</p><p>Impact end: {evidenceDate(item.impact_end_at)}</p></div>
      {item.subscription_ids?.length ? <p className="break-all text-muted">Subscription scope: {item.subscription_ids.join(", ")}</p> : null}
      {item.resource_count != null && <p>Observed impacted resources: {item.resource_count} (not a complete impact assessment).</p>}
      {(item.resources ?? []).map(r => <div key={r.id} className="flex flex-wrap justify-between gap-2"><span className="min-w-0 break-all">{r.name || r.id}</span><GovernLink resourceId={r.id} /></div>)}
      {item.resources_truncated && <GovernNotice warning>Resource details are capped; observed counts may be lower bounds.</GovernNotice>}<GovernLink url={item.url}>Read official source</GovernLink>
    </div>
  </details>;
}

function FeedPanel({ source, scope, active }: { source: FeedSource; scope: Scope; active: boolean }) {
  const [refresh, setRefresh] = useState(false);
  const options = feedQuery(source, scope, refresh);
  const query = useQuery({ ...options, enabled: active && options.enabled });
  const [filters, setFilters] = useState(emptyFeedFilters);
  const [page, setPage] = useState(0);
  const all = query.data?.items ?? [];
  const rows = filterArticles(all, filters);
  const pages = Math.max(1, Math.ceil(rows.length / 10));
  const current = Math.min(page, pages - 1);
  const set = <K extends keyof typeof filters>(key: K, value: (typeof filters)[K]) => { setFilters(f => ({ ...f, [key]: value })); setPage(0); };
  const data = query.data;
  const freshness = data?.freshness;
  const stale = freshness?.stale || (freshness?.fetched_at && freshness.max_age_seconds != null && (Date.now() - Date.parse(freshness.fetched_at)) / 1000 >= freshness.max_age_seconds);
  const unscoped = source === "health" && !explicitScopes(scope.scope).length;
  function refreshRead() { if (unscoped) return; if (!refresh) setRefresh(true); else void query.refetch(); }
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted">{source === "health" ? "Private events for explicitly selected subscriptions. Azure access and Resource Graph visibility are enforced by the server." : "Global public listing. Subscription selection and billing month do not filter this feed."}</p><GovernRefresh busy={query.isFetching} disabled={unscoped} onClick={refreshRead} /></div>
    {unscoped ? <GovernNotice warning>Select 1–100 explicit subscription UUIDs to read private Service Health. No request is sent for “all subscriptions”. Public feeds remain available.</GovernNotice> : <>
      <div className="grid gap-3 sm:grid-cols-3"><KpiTile label="Retrieved listing" value={data?.status === "error" || query.isError ? "Unavailable" : data?.total ?? all.length} hint={data?.truncated ? "Capped result; counts may be lower bounds" : "Before display filters"} />
        <KpiTile label="Customer attention" value={all.filter(needsAttention).length} /><KpiTile label="Matching notices" value={rows.length} hint={`Page ${current + 1} of ${pages}`} /></div>
      {freshness && <GovernNotice warning={!!stale}>{stale ? "Stale" : freshness.cached ? "Cached" : "Fetched"} · {evidenceDate(freshness.fetched_at)}. Results describe the retrieved listing, not real-time universal availability.</GovernNotice>}
      {data?.notice && <GovernNotice>{data.notice}</GovernNotice>}
      <FilterBar title="Filter this source" summary={`${rows.length} of ${all.length} loaded notices`} active={!!filters.query || !!filters.category || !!filters.service || !!filters.region || !!filters.status || filters.attention} onReset={() => { setFilters(emptyFeedFilters()); setPage(0); }}>
        <GovernField label="Search news, impact and actions"><input className={governInput} type="search" maxLength={200} value={filters.query} onChange={e => set("query", e.target.value)} /></GovernField>
        <GovernSelect label="Category" value={filters.category} onChange={v => set("category", v)} options={all.map(i => i.category || i.type || "Other")} />
        <GovernSelect label="Service / product" value={filters.service} onChange={v => set("service", v)} options={[...all.flatMap(i => i.services ?? []), ...(all.some(i => !i.services?.length) ? ["__missing"] : [])]} />
        <GovernSelect label="Region" value={filters.region} onChange={v => set("region", v)} options={[...all.flatMap(i => i.regions ?? []), ...(all.some(i => !i.regions?.length) ? ["__missing"] : [])]} />
        <GovernSelect label="Status" value={filters.status} onChange={v => set("status", v)} options={all.map(i => i.status || "").filter(Boolean)} />
        <div className="flex flex-wrap items-end gap-3"><label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" checked={filters.attention} onChange={e => set("attention", e.target.checked)} />Customer attention</label></div>
      </FilterBar>
      {query.isError ? <GovernError error={query.error} retry={() => void query.refetch()} /> : query.isPending ? <GovernLoading /> : null}
      {data?.error || data?.status === "error" ? <GovernNotice warning>{data.error || "Source retrieval failed."} This is not an empty feed. {all.length ? "The last retrieved listing may be stale." : "Retry this source independently."}</GovernNotice> : null}
      {!query.isPending && !query.isError && !rows.length && data?.status !== "error" && <GovernNotice>{all.length ? "No notices match these filters." : source === "status" ? "No active public incidents returned. This does not guarantee every service or subscription is unaffected." : "No notices returned for this retrieved source and scope."}</GovernNotice>}
      <section aria-label="Azure articles" className="cl-article-list">{rows.slice(current * 10, (current + 1) * 10).map(i => <Article item={i} key={i.id} />)}</section>
      {rows.length > 10 && <div className="flex items-center justify-between"><Button disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</Button><span className="text-sm text-muted" aria-live="polite">Page {current + 1} of {pages} · {rows.length} matches</span><Button disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</Button></div>}
    </>}
  </div>;
}

export function AzureUpdatesPage() {
  const scope = globalScope(useSearch({ strict: false }));
  const [source, setSource] = useState<FeedSource>("updates");
  const sources = [{ id: "updates", label: "Azure Updates", Icon: Newspaper }, { id: "status", label: "Azure Status", Icon: Radio }, { id: "health", label: "Service Health", Icon: ShieldCheck }] as const;
  return <div className="space-y-5"><PageHeader title="Azure updates & health" subtitle="Official product news, public incidents and scoped private Service Health. Every refresh is a read-only GET; no Azure resources change." />
    <div role="tablist" aria-label="Azure sources" className="cl-source-tabs flex flex-wrap gap-2">{sources.map(({ id, label, Icon }, index) => <Button role="tab" id={`source-${id}`} aria-controls={`panel-${id}`} aria-selected={source === id} tabIndex={source === id ? 0 : -1} variant={source === id ? "primary" : "outline"} key={id} onClick={() => setSource(id)} onKeyDown={e => {
      if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
      e.preventDefault(); const next = e.key === "Home" ? 0 : e.key === "End" ? 2 : (index + (e.key === "ArrowRight" ? 1 : 2)) % 3;
      const id = sources[next]!.id; setSource(id); document.getElementById(`source-${id}`)?.focus();
    }}><Icon />{label}</Button>)}</div>
    {sources.map(s => <div key={s.id} role="tabpanel" id={`panel-${s.id}`} aria-labelledby={`source-${s.id}`} hidden={source !== s.id}><FeedPanel key={`${s.id}:${s.id === "health" ? scope.scope : "global"}`} source={s.id} scope={scope} active={source === s.id} /></div>)}
    <GovernDetails title="Scope, permissions and freshness"><p>Public announcements do not prove a subscription is impacted. Service Health requires explicit permitted subscriptions and source access; 403 means access denied, not no events. Refresh and retries are independently scoped to the selected source. External links are restricted to HTTPS official Microsoft/Azure hosts; content is rendered as text, never executable article HTML.</p></GovernDetails>
  </div>;
}
