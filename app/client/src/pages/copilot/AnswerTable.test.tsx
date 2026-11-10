// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnswerTable } from "./AnswerTable";

describe("AnswerTable", () => {
  it("status cells show badges", () => {
    render(
      <AnswerTable
        columns={["job_name", "status"]}
        rows={[
          ["orders_ingest", "FAILED"],
          ["daily_revenue_report", "healthy"],
        ]}
      />,
    );
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
  });

  it("unknown words stay text", () => {
    render(
      <AnswerTable
        columns={["job_name", "status"]}
        rows={[
          ["orders_ingest", "FAILED"],
          ["daily_revenue_report", "PAUSED"],
        ]}
      />,
    );
    expect(screen.getByText("PAUSED")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });

  it("shows null in italics and right-aligns numbers", () => {
    render(
      <AnswerTable
        columns={["job_name", "runs"]}
        rows={[
          ["orders_ingest", "12"],
          [null, "3"],
        ]}
      />,
    );
    expect(screen.getByText("null")).toHaveClass("italic");
    expect(screen.getByText("12").closest("td")).toHaveClass("text-right", "font-mono");
    expect(screen.getByText("orders_ingest").closest("td")).not.toHaveClass("text-right");
  });

  it("5,000 rows show 50 and the line 'Showing 50 of 5,000 rows'", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => [`job_${i}`]);
    render(<AnswerTable columns={["job_name"]} rows={rows} total={5000} />);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(1 + 50);
    expect(screen.getByText("Showing 50 of 5,000 rows")).toBeInTheDocument();
  });

  it("a truncated result shows Genie's total", () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`job_${i}`]);
    render(<AnswerTable columns={["job_name"]} rows={rows} total={12000} />);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(1 + 30);
    expect(screen.getByText("Showing 30 of 12,000 rows")).toBeInTheDocument();
  });

  it("says nothing when every row is shown", () => {
    render(<AnswerTable columns={["job_name"]} rows={[["orders_ingest"]]} total={1} />);
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });
});
