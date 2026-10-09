import * as echarts from "echarts/core";
import { HeatmapChart, TreemapChart } from "echarts/charts";
import { CalendarComponent, VisualMapComponent } from "echarts/components";
import EChart, { type EChartProps } from "./EChart";

// Overview-only chart types live in their own lazy chunk so the shared chart bundle stays lean.
echarts.use([HeatmapChart, TreemapChart, CalendarComponent, VisualMapComponent]);

export default function InsightEChart(props: EChartProps) {
  return <EChart {...props} />;
}
