import { useEffect, useRef, useState } from "react";
import { columnHelper, DataTable } from "@/components/DataTable";
import { ErrorState } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { api } from "./api";
import { ApprovalSession, selectedScope, type Capabilities, type Capability } from "./admin-report-queries";

const h = columnHelper<Capability>();
const columns = [
  h.accessor("feature", { header: "Capability", meta: { width: "minmax(160px,1fr)" } }),
  h.accessor("status", { header: "Evidence" }),
  h.accessor(row => row.principal?.id ?? "Not resolved", { id: "principal", header: "Principal", meta: { width: "minmax(220px,1.4fr)" } }),
  h.accessor(row => row.required_role ?? "Review configuration", { id: "role", header: "Required role", meta: { width: "minmax(200px,1fr)" } }),
  h.accessor(row => row.scope ?? "Not configured", { id: "scope", header: "Scope", meta: { width: "minmax(250px,1.5fr)" } }),
  h.accessor(row => `${row.reason ?? ""} ${row.next_step ?? ""}`, { id: "reason", header: "Reason and next step", meta: { width: "minmax(300px,2fr)" } }),
];
export function AdminAccess({ scope, admin }: { scope: string[]; admin: boolean }) {
  const [result, setResult] = useState<Capabilities | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const session = useRef(new ApprovalSession());
  const key = scope.join(",");
  useEffect(() => { const current = session.current; current.cancel(); setResult(null); setBusy(false); setError(null); return () => current.cancel(); }, [key]);
  const inspect = async (mode: "caller" | "workload") => {
    setBusy(true); setError(null);
    try {
      const read = await session.current.run(signal => api<Capabilities>("capabilities", { scope: selectedScope(scope), mode, refresh: true }, { signal }));
      if (read) { setResult(read); setBusy(false); }
    } catch (e) { setError(e); setBusy(false); }
  };
  const instructions = result?.capabilities.map(c => `${c.feature}: ${c.status}\nPrincipal: ${c.principal?.id ?? "Not resolved"}\nRequired role: ${c.required_role ?? "Review configuration"}\nScope: ${c.scope ?? "Not configured"}\n${c.reason ?? ""}\nNext step: ${c.next_step ?? ""}`).join("\n\n") ?? "";
  return <div className="space-y-4">
    <p className="text-sm text-muted">Read-only access declarations for the locally selected subscriptions. Unknown evidence is not a denial. This does not grant roles or prove storage-network access.</p>
    <div className="flex flex-wrap gap-2"><Button disabled={busy || !scope.length} onClick={() => void inspect("caller")}>Inspect my access</Button>{admin && <Button disabled={busy || !scope.length} onClick={() => void inspect("workload")}>Inspect background identity</Button>}</div>
    {busy && <p role="status">Reading permission evidence…</p>}
    {error != null && <ErrorState error={error} />}
    {result && <>
      <p className="text-sm">{result.mode === "workload" ? "Background identity" : "Caller"} declarations · {result.generated_at ?? "time not reported"}{result.read_only ? " · deployment is read-only" : ""}</p>
      <DataTable data={result.capabilities} columns={columns} rowKey={r => `${r.feature}:${r.scope}:${r.principal?.id}`} height={350} />
      <Button onClick={() => { void navigator.clipboard.writeText(instructions).then(() => setNotice("Administrator instructions copied."), () => setNotice("Clipboard unavailable. Copy the instructions below.")); }}>Copy administrator instructions</Button>
      <details><summary className="cursor-pointer text-sm">Administrator instructions</summary><pre className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 text-xs">{instructions}</pre></details>
      <p role="status" className="text-sm text-muted">{notice}</p>
    </>}
  </div>;
}
