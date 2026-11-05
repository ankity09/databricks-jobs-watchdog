// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopilotQuery } from "../../hooks/useCopilot";
import { SqlDisclosure } from "./SqlDisclosure";

const SQL = "SELECT fl.job_name, fl.status\nFROM main.watchdog.findings_latest fl\nWHERE fl.status = 'FAILED'";

function query(rows: number | null): CopilotQuery {
  return {
    id: "att-1",
    title: "Failing jobs",
    description: "Jobs that failed in the newest scan.",
    sql: SQL,
    result:
      rows === null
        ? null
        : {
            columns: ["job_name", "status"],
            rows: Array.from({ length: rows }, (_, i) => [`job_${String(i + 1).padStart(2, "0")}`, i === 0 ? null : "FAILED"]),
          },
  };
}

describe("SqlDisclosure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says who the query ran as, and keeps the SQL folded until asked", () => {
    render(<SqlDisclosure query={query(2)} ranAs="dana@example.com" resultState="ready" />);
    expect(screen.getByText("Ran as")).toBeInTheDocument();
    expect(screen.getByText("dana@example.com")).toBeInTheDocument();
    expect(screen.queryByText(/WHERE fl.status = 'FAILED'/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show SQL" })).toHaveAttribute("aria-expanded", "false");
  });

  it("expands to the SQL in mono, with a copy button", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SqlDisclosure query={query(2)} ranAs="dana@example.com" resultState="ready" />);

    await user.click(screen.getByRole("button", { name: "Show SQL" }));
    expect(screen.getByRole("button", { name: "Hide SQL" })).toHaveAttribute("aria-expanded", "true");
    const code = screen.getByText(/WHERE fl.status = 'FAILED'/);
    expect(code.tagName).toBe("CODE");
    expect(code.closest("pre")).toHaveClass("font-mono");

    await user.click(screen.getByRole("button", { name: "Copy SQL" }));
    expect(writeText).toHaveBeenCalledWith(SQL);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("shows a small result table, at most 20 rows, when the rows came back", async () => {
    const user = userEvent.setup();
    render(<SqlDisclosure query={query(25)} ranAs="dana@example.com" resultState="ready" />);
    await user.click(screen.getByRole("button", { name: "Show SQL" }));

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["job_name", "status"]);
    expect(within(table).getAllByRole("row")).toHaveLength(1 + 20);
    expect(within(table).getByText("job_20")).toBeInTheDocument();
    expect(within(table).queryByText("job_21")).not.toBeInTheDocument();
    expect(within(table).getByText("null")).toBeInTheDocument();
    expect(screen.getByText("Showing 20 of 25 rows.")).toBeInTheDocument();
  });

  it("says so when the query returned no rows, and when the rows are not available", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SqlDisclosure query={query(0)} ranAs="dana@example.com" resultState="ready" />);
    await user.click(screen.getByRole("button", { name: "Show SQL" }));
    expect(screen.getByText("The query returned no rows.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    rerender(<SqlDisclosure query={query(null)} ranAs="dana@example.com" resultState="missing" />);
    expect(screen.getByText("The rows are not available. Ask again to run the query again.")).toBeInTheDocument();
  });

  it("falls back to the signed-in person when the email is unknown", () => {
    render(<SqlDisclosure query={query(1)} ranAs={null} resultState="ready" />);
    expect(screen.getByText("you, the signed-in person")).toBeInTheDocument();
  });
});
