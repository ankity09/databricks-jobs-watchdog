// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopilotQuery } from "../../hooks/useCopilot";
import { AnswerBlock } from "./AnswerBlock";

vi.mock("./AnswerChart", () => ({
  default: (props: { chartType: string; xKey: string }) => <div data-testid="chart" data-type={props.chartType} data-x={props.xKey} />,
}));

function makeQuery(columns: [string, string][], rows: (string | null)[][], title = "Failed jobs per day"): CopilotQuery {
  const names = columns.map(([name]) => name);
  return {
    id: "att-1",
    title,
    description: null,
    sql: "SELECT 1",
    result: { columns: names, rows },
    statement: { manifest: { schema: { columns: columns.map(([name, type_name]) => ({ name, type_name })) } }, result: { data_array: rows } },
    rowCount: rows.length,
    truncated: false,
  };
}

const PER_DAY = makeQuery(
  [
    ["day", "DATE"],
    ["failed_jobs", "BIGINT"],
  ],
  Array.from({ length: 12 }, (_, i) => [`2026-10-${String(i + 1).padStart(2, "0")}`, String(i + 1)]),
);

describe("AnswerBlock", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a chartable answer shows the chart and a Table switch", async () => {
    render(<AnswerBlock query={PER_DAY} ranAs="dana@example.com" resultState="ready" />);
    expect(await screen.findByTestId("chart")).toHaveAttribute("data-x", "day");
    expect(screen.getByRole("heading", { name: "Failed jobs per day" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chart" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("12 rows")).toBeInTheDocument();
  });

  it("Table shows the rows", async () => {
    const user = userEvent.setup();
    render(<AnswerBlock query={PER_DAY} ranAs="dana@example.com" resultState="ready" />);
    await user.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["day", "failed_jobs"]);
    expect(within(table).getAllByRole("row")).toHaveLength(13);
    await user.click(screen.getByRole("button", { name: "Chart" }));
    expect(await screen.findByTestId("chart")).toBeInTheDocument();
  });

  it("the type menu lists only compatible types", async () => {
    const user = userEvent.setup();
    render(<AnswerBlock query={PER_DAY} ranAs="dana@example.com" resultState="ready" />);
    await user.click(await screen.findByRole("button", { name: "Chart type" }));
    const items = screen.getAllByRole("menuitemradio").map((item) => item.textContent);
    expect(items).toEqual(["Line", "Bar", "Area"]);
    await user.click(screen.getByRole("menuitemradio", { name: "Bar" }));
    expect(screen.getByTestId("chart")).toHaveAttribute("data-type", "bar");
  });

  it("a single number shows large", () => {
    const query = makeQuery([["failed_jobs", "BIGINT"]], [["42"]], "Failed jobs now");
    render(<AnswerBlock query={query} ranAs="dana@example.com" resultState="ready" />);
    const value = screen.getByText("42");
    expect(value).toHaveClass("font-mono", "text-4xl");
    expect(screen.getByText("failed_jobs")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Chart" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("an answer with no chart shows the table and no Chart switch", () => {
    const query = makeQuery(
      [
        ["job_name", "STRING"],
        ["owner", "STRING"],
      ],
      [["orders_ingest", "platform-team"]],
    );
    render(<AnswerBlock query={query} ranAs={null} resultState="ready" />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Chart" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Chart type" })).not.toBeInTheDocument();
  });

  it("CSV downloads every row the app has", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn((_blob: Blob) => "blob:csv");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    render(<AnswerBlock query={PER_DAY} ranAs="dana@example.com" resultState="ready" />);
    await user.click(screen.getByRole("button", { name: "Download the rows as CSV" }));

    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]?.[0];
    if (!blob) throw new Error("no blob");
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.readAsText(blob);
    });
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("day,failed_jobs");
    expect(lines).toHaveLength(13);
    expect(downloads).toEqual(["failed-jobs-per-day.csv"]);
  });

  it("CSV lets go of the file only after the download has started", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const revokeObjectURL = vi.fn((_url: string) => undefined);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn((_blob: Blob) => "blob:csv"), revokeObjectURL }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<AnswerBlock query={PER_DAY} ranAs="dana@example.com" resultState="ready" />);
    fireEvent.click(screen.getByRole("button", { name: "Download the rows as CSV" }));
    // The browser reads the file after the click returns: revoking its URL at once can cancel the download.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:csv");
  });

  it("a truncated result says so under its table", async () => {
    const user = userEvent.setup();
    render(<AnswerBlock query={{ ...PER_DAY, truncated: true }} ranAs="dana@example.com" resultState="ready" />);
    await user.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByText("Genie returned only part of this result. The table and the CSV hold the rows it sent.")).toBeInTheDocument();
  });

  it("rows loading show a skeleton, then the chart", async () => {
    const waiting: CopilotQuery = { ...PER_DAY, result: null, statement: null, rowCount: null };
    const { rerender } = render(<AnswerBlock query={waiting} ranAs="dana@example.com" resultState="loading" />);
    expect(screen.getByLabelText("Loading the rows")).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    rerender(<AnswerBlock query={PER_DAY} ranAs="dana@example.com" resultState="ready" />);
    expect(await screen.findByTestId("chart")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading the rows")).not.toBeInTheDocument();
  });

  it("offers Retry when the rows are missing", async () => {
    const user = userEvent.setup();
    const onRetryRows = vi.fn();
    const missing: CopilotQuery = { ...PER_DAY, result: null, statement: null, rowCount: null };
    render(<AnswerBlock query={missing} ranAs="dana@example.com" resultState="missing" onRetryRows={onRetryRows} retryFailed />);
    expect(screen.getByText("Could not load the rows.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryRows).toHaveBeenCalledOnce();
  });
});
