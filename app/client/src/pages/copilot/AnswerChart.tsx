import { AreaChart, BarChart, DonutChart, HeatmapChart, LineChart, PieChart, RadarChart, ScatterChart, useThemeColors, type ChartType } from "@databricks/appkit-ui/react";
import { prefersReducedMotion } from "../jobs/mapModel";

/** ECharts' options for a chart that draws without animation. AppKit merges them over its own. */
const STILL: Record<string, unknown> = { animation: false };

export interface AnswerChartProps {
  chartType: ChartType;
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string | string[];
  /** In pixels. */
  height: number;
}

/**
 * One Genie answer as a chart in AppKit's theme colors, drawn without animation when the person asked for less motion.
 * Loaded on demand, so ECharts stays out of the main bundle.
 */
export default function AnswerChart({ chartType, data, xKey, yKey, height }: AnswerChartProps) {
  const colors = useThemeColors("categorical");
  const options = prefersReducedMotion() ? STILL : undefined;
  const common = { data, xKey, yKey, colors, height, showLegend: Array.isArray(yKey), ariaLabel: "Chart of the answer", options };
  switch (chartType) {
    case "bar":
      return <BarChart {...common} />;
    case "line":
      return <LineChart {...common} />;
    case "area":
      return <AreaChart {...common} />;
    case "pie":
      return <PieChart {...common} />;
    case "donut":
      return <DonutChart {...common} />;
    case "scatter":
      return <ScatterChart {...common} />;
    case "heatmap":
      return <HeatmapChart {...common} />;
    case "radar":
      return <RadarChart {...common} />;
  }
}
