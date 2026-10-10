import * as echarts from "echarts/core";
import { EffectScatterChart, ScatterChart } from "echarts/charts";
import { GeoComponent } from "echarts/components";
import { WORLD } from "@cl/worldmap";
import { useMemo } from "react";
import EChart from "./EChart";
import { MAP_H, MAP_W } from "@/lib/regionGeo";

// Map-only modules stay in this lazily loaded chunk rather than the shared chart bundle.
echarts.use([GeoComponent, EffectScatterChart, ScatterChart]);

let registered = false;
function ensureMap() {
  if (registered) return;
  // One named path: ECharts styles it through geo.itemStyle, so land follows the theme.
  echarts.registerMap("cl-world", {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAP_W} ${MAP_H}"><path name="land" d="${WORLD}"/></svg>`,
  });
  registered = true;
}

export interface MapPoint {
  key: string;
  name: string;
  cost: number;
  x: number;
  y: number;
  tooltip: string;
}

export interface WorldMapProps {
  points: MapPoint[];
  selected: string | null;
  zoom: number;
  center: [number, number] | null;
  colors: { land: string; landBorder: string; accent: string; glow: string; text: string; palette: string[] };
  height: number;
  onPick: (key: string) => void;
}

export default function WorldMapChart({ points, selected, zoom, center, colors, height, onPick }: WorldMapProps) {
  ensureMap();
  const option = useMemo(() => {
    const max = Math.max(...points.map((p) => Math.max(p.cost, 0)), 1);
    const size = (cost: number) => 10 + 38 * Math.sqrt(Math.max(cost, 0) / max);
    const datum = (p: MapPoint, i: number) => ({
      name: p.name,
      value: [p.x, p.y, p.cost],
      key: p.key,
      tooltip: p.tooltip,
      symbolSize: size(p.cost),
      itemStyle: {
        color: colors.palette[i % colors.palette.length],
        opacity: selected && selected !== p.key ? 0.45 : 0.92,
        borderColor: selected === p.key ? colors.text : "rgba(255,255,255,0.85)",
        borderWidth: selected === p.key ? 2.5 : 1,
      },
    });
    const ranked = points.map(datum);
    // Label only the largest locations to preserve legibility without animated decoration.
    const hot = ranked.filter((p) => p.value[2]! > 0).slice(0, 5);
    const rest = ranked.filter((p) => !hot.includes(p));
    return {
      tooltip: {
        trigger: "item",
        formatter: (p: { data?: { tooltip?: string } }) => p.data?.tooltip ?? "",
      },
      geo: {
        map: "cl-world",
        roam: "move",
        zoom,
        center: center ?? undefined,
        aspectScale: 1,
        left: 8,
        right: 8,
        top: 16,
        bottom: 16,
        silent: true,
        itemStyle: { areaColor: colors.land, color: colors.land, borderColor: colors.landBorder, borderWidth: 1 },
        emphasis: { disabled: true },
        select: { disabled: true },
        animationDurationUpdate: 650,
        animationEasingUpdate: "cubicInOut",
      },
      series: [
        {
          type: "scatter",
          coordinateSystem: "geo",
          zlevel: 2,
          label: {
            show: true,
            position: "right",
            distance: 8,
            formatter: (p: { name: string }) => p.name,
            color: colors.text,
            fontSize: 11,
            fontWeight: 600,
            textBorderColor: colors.glow,
            textBorderWidth: 3,
          },
          labelLayout: { hideOverlap: true },
          data: hot,
        },
        {
          type: "scatter",
          coordinateSystem: "geo",
          zlevel: 1,
          label: { show: false },
          emphasis: { label: { show: true, position: "right", formatter: (p: { name: string }) => p.name, color: colors.text, fontSize: 11 } },
          data: rest,
        },
      ],
    };
  }, [points, selected, zoom, center, colors]);

  return (
    <EChart
      option={option}
      height={height}
      onClick={(p) => {
        const key = (p.data as { key?: string } | undefined)?.key;
        if (key) onPick(key);
      }}
    />
  );
}
