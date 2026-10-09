import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import {
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import { usePrefs } from "@/lib/prefs";
import { PALETTE } from "@/lib/palette";

// Tree-shaken: only the chart types CloudLens draws. This module is loaded lazily (see Chart.tsx)
// so none of it is in the initial bundle.
echarts.use([
  BarChart,
  LineChart,
  PieChart,
  DataZoomComponent,
  DatasetComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  MarkPointComponent,
  TooltipComponent,
  CanvasRenderer,
]);

function tokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { fg: v("--cl-fg"), muted: v("--cl-muted"), border: v("--cl-border"), surface: v("--cl-surface"), accent: v("--cl-accent") };
}

type Axis = Record<string, unknown> & { splitLine?: { lineStyle?: Record<string, unknown> }; axisLine?: { lineStyle?: Record<string, unknown> } };

/** Canvas cannot read CSS variables, so grid and axis lines get the current theme's colours here. */
function themeAxes(option: EChartsCoreOption, border: string): EChartsCoreOption {
  const paint = (axis: unknown): unknown => {
    if (Array.isArray(axis)) return axis.map(paint);
    if (!axis || typeof axis !== "object") return axis;
    const a = axis as Axis;
    return {
      ...a,
      splitLine: { ...a.splitLine, lineStyle: { color: border, opacity: 1, ...a.splitLine?.lineStyle } },
      axisLine: { ...a.axisLine, lineStyle: { color: border, ...a.axisLine?.lineStyle } },
    };
  };
  const o = option as Record<string, unknown>;
  return { ...o, xAxis: paint(o.xAxis), yAxis: paint(o.yAxis) } as EChartsCoreOption;
}

export interface EChartProps {
  option: EChartsCoreOption;
  height?: number;
  className?: string;
  onClick?: (params: { name: string; seriesName?: string; value: unknown; dataIndex: number; data?: unknown }) => void;
}

export default function EChart({ option, height = 280, className, onClick }: EChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const { theme } = usePrefs();

  useEffect(() => {
    if (!ref.current) return;
    const instance = echarts.init(ref.current, undefined, { renderer: "canvas" });
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    instance.off("click");
    if (onClick) instance.on("click", (p) => onClick(p as never));
  }, [onClick]);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    const t = tokens();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    instance.setOption(
      {
        color: PALETTE,
        animation: !reduced,
        animationDuration: 450,
        textStyle: { fontFamily: "Inter Variable, ui-sans-serif, system-ui", color: t.muted },
        tooltip: {
          backgroundColor: t.surface,
          borderColor: t.border,
          textStyle: { color: t.fg, fontSize: 12 },
          extraCssText: "border-radius:10px;box-shadow:0 8px 24px -8px rgb(0 0 0 / .25);",
        },
        ...themeAxes(option, t.border),
      },
      { notMerge: true },
    );
    // theme is a dependency so colours are re-read from the CSS variables after a switch.
  }, [option, theme]);

  return <div ref={ref} className={className} style={{ height, width: "100%" }} />;
}
