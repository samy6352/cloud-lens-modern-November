import { lazy, Suspense } from "react";
import type { EChartProps } from "./EChart";
import { Skeleton } from "./ui/skeleton";

const EChart = lazy(() => import("./EChart"));

/** ECharts in its own chunk: the shell and tables paint before a single chart byte arrives. */
export function Chart(props: EChartProps) {
  const height = props.height ?? 280;
  return (
    <Suspense fallback={<Skeleton style={{ height }} className="w-full" />}>
      <EChart {...props} />
    </Suspense>
  );
}
