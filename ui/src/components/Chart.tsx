import { lazy, Suspense } from "react";
import type { EChartProps } from "./EChart";
import { Skeleton } from "./ui/skeleton";

const EChart = lazy(() => import("./EChart"));
const InsightEChart = lazy(() => import("./InsightEChart"));

/** ECharts in its own chunk: the shell and tables paint before a single chart byte arrives. */
export function Chart(props: EChartProps) {
  const height = props.height ?? 280;
  return (
    <Suspense fallback={<Skeleton style={{ height }} className="w-full" />}>
      <EChart {...props} />
    </Suspense>
  );
}

/** Treemaps and calendar heatmaps, loaded only by the screens that draw them. */
export function InsightChart(props: EChartProps) {
  const height = props.height ?? 280;
  return (
    <Suspense fallback={<Skeleton style={{ height }} className="w-full" />}>
      <InsightEChart {...props} />
    </Suspense>
  );
}
