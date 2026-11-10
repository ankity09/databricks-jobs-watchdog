import { AreaChart, BarChart, DonutChart, HeatmapChart, LineChart, PieChart, RadarChart, ScatterChart, useThemeColors, type ChartType } from "@databricks/appkit-ui/react";

export interface AnswerChartProps {
  chartType: ChartType;
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string | string[];
  /** In pixels. */
  height: number;
}

/** One Genie answer as a chart in AppKit's theme colors. Loaded on demand, so ECharts stays out of the main bundle. */
export default function AnswerChart({ chartType, data, xKey, yKey, height }: AnswerChartProps) {
  const colors = useThemeColors("categorical");
  const common = { data, xKey, yKey, colors, height, showLegend: Array.isArray(yKey), ariaLabel: "Chart of the answer" };
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
