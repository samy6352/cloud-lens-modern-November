import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Counts up to `value` once; screen readers and reduced-motion users get the final figure. */
export function CountUp({ value, format, duration = 1100, className }: { value: number | null | undefined; format: (v: number) => string; duration?: number; className?: string }) {
  const finite = value != null && Number.isFinite(value);
  const [shown, setShown] = useState<number | null>(finite && reducedMotion() ? value : finite ? 0 : null);
  const frame = useRef(0);
  useEffect(() => {
    if (!finite) {
      setShown(null);
      return;
    }
    if (reducedMotion()) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      setShown(value * eased);
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [value, finite, duration]);
  const final = finite ? format(value) : "Unavailable";
  return (
    <span className={className}>
      <span aria-hidden="true">{shown == null ? final : format(shown)}</span>
      <span className="sr-only">{final}</span>
    </span>
  );
}

/** A small, dependency-free area sparkline. Gaps (null) break the line rather than drop to zero. */
export function Sparkline({
  values,
  className,
  stroke = "currentColor",
  fill = true,
  height = 40,
  highlightMax = false,
}: {
  values: Array<number | null>;
  className?: string;
  stroke?: string;
  fill?: boolean;
  height?: number;
  highlightMax?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (finite.length < 2) return null;
  const w = 200;
  const min = Math.min(...finite, 0);
  const max = Math.max(...finite);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * w;
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 8);
  let line = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    line += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  const firstIdx = values.findIndex((v) => v != null && Number.isFinite(v));
  const lastIdx = values.length - 1 - [...values].reverse().findIndex((v) => v != null && Number.isFinite(v));
  const area = `${line}L${x(lastIdx).toFixed(1)} ${height}L${x(firstIdx).toFixed(1)} ${height}Z`;
  const peak = values.indexOf(max);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className={cn("w-full overflow-visible", className)} style={{ height }} aria-hidden="true">
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#spark-${id})`} />}
      <path d={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" className="cl-draw" />
      {highlightMax && peak >= 0 && <circle cx={x(peak)} cy={y(max)} r="3.5" fill={stroke} className="cl-pulse" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/** Ring gauge for a 0–100 share. */
export function RadialGauge({ pct, size = 64, color = "var(--cl-accent)" }: { pct: number | null | undefined; size?: number; color?: string }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const value = pct != null && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className="-rotate-90">
      <circle cx="32" cy="32" r={r} fill="none" stroke="var(--cl-surface-2)" strokeWidth="7" />
      <circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={drawn ? c * (1 - value / 100) : c}
        className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-1000 motion-safe:ease-out"
      />
    </svg>
  );
}

/** Reads a theme token at render time; canvas charts cannot use CSS variables directly. */
export function cssVar(name: string, fallback = ""): string {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
