// @vitest-environment jsdom
import type { ChartType } from "@databricks/appkit-ui/react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AnswerChart from "./AnswerChart";

// Each AppKit chart as a stand-in that shows the ECharts options it was given: ECharts itself draws on a canvas, which jsdom lacks.
vi.mock("@databricks/appkit-ui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@databricks/appkit-ui/react")>();
  const chart = (type: ChartType) =>
    function Chart(props: { options?: Record<string, unknown> }) {
      return <div data-testid="chart" data-type={type} data-options={JSON.stringify(props.options ?? null)} />;
    };
  return {
    ...actual,
    BarChart: chart("bar"),
    LineChart: chart("line"),
    AreaChart: chart("area"),
    PieChart: chart("pie"),
    DonutChart: chart("donut"),
    ScatterChart: chart("scatter"),
    HeatmapChart: chart("heatmap"),
    RadarChart: chart("radar"),
  };
});

const TYPES: ChartType[] = ["bar", "line", "area", "pie", "donut", "scatter", "heatmap", "radar"];
const DATA = [
  { day: "2026-10-01", failed_jobs: 1 },
  { day: "2026-10-02", failed_jobs: 3 },
];

/** Makes prefers-reduced-motion match, as a person who asked for less motion would have it. */
function reduceMotion() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion: reduce"),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

describe("AnswerChart", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("draws every chart type without animation when reduced motion is on", () => {
    reduceMotion();
    for (const chartType of TYPES) {
      const { unmount } = render(<AnswerChart chartType={chartType} data={DATA} xKey="day" yKey="failed_jobs" height={260} />);
      const chart = screen.getByTestId("chart");
      expect(chart).toHaveAttribute("data-type", chartType);
      expect(chart).toHaveAttribute("data-options", JSON.stringify({ animation: false }));
      unmount();
    }
  });

  it("keeps the chart's own animation otherwise", () => {
    render(<AnswerChart chartType="line" data={DATA} xKey="day" yKey="failed_jobs" height={260} />);
    expect(screen.getByTestId("chart")).toHaveAttribute("data-options", "null");
  });
});
