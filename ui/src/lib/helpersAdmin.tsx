import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

export const adminInput = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg";
export function AdminField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-xs font-medium text-muted">{label}{children}</label>;
}
export function AdminChecks({ title, options, selected, onChange, disabled = false }: {
  title: string; options: Array<{ id: string; label: string }>; selected: string[];
  onChange: (value: string[]) => void; disabled?: boolean;
}) {
  return <fieldset disabled={disabled} className="cl-checklist space-y-2"><legend className="mb-2 text-sm font-medium">{title} <span className="num text-xs font-normal text-muted">({options.filter(o => selected.includes(o.id)).length}/{options.length})</span></legend>
    <div className="flex gap-2"><Button size="sm" onClick={() => onChange(options.map(o => o.id))}>Select all</Button><Button size="sm" onClick={() => onChange([])}>Clear</Button></div>
    <div className="max-h-64 space-y-2 overflow-auto">{options.map(o => <label key={o.id} className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={selected.includes(o.id)} onChange={e => onChange(e.target.checked ? [...selected, o.id] : selected.filter(id => id !== o.id))} />{o.label}
    </label>)}</div>
  </fieldset>;
}
export function AdminConfirm({ title, children, confirm, cancel, disabled, busy, label = "Confirm", reason }: {
  title: string; children: ReactNode; confirm: () => void; cancel: () => void; disabled?: boolean; busy?: boolean; label?: string; reason?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} onCancel={e => { e.preventDefault(); if (!busy) cancel(); }} aria-labelledby="admin-confirm-title" className="m-auto max-h-[85vh] w-[min(760px,95vw)] overflow-auto rounded-xl border border-border bg-surface p-0 text-fg backdrop:bg-black/50">
    <Card><CardHeader title={<span id="admin-confirm-title">{title}</span>} /><CardBody>
      <div className="space-y-3 text-sm">{children}</div>
      {reason && <p className="mt-3 text-sm text-warn">{reason}</p>}
      <div className="cl-workflow-actions mt-5 flex flex-wrap gap-2"><Button variant="primary" disabled={disabled || busy} onClick={confirm}>{busy ? "Submitting…" : label}</Button><Button disabled={busy} onClick={cancel}>Cancel</Button></div>
    </CardBody></Card>
  </dialog>;
}
