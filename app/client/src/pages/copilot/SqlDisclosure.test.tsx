// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
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
    statement: null,
    rowCount: null,
    truncated: false,
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
    render(<SqlDisclosure query={query(2)} ranAs="dana@example.com" />);
    expect(screen.getByText("Ran as")).toBeInTheDocument();
    expect(screen.getByText("dana@example.com")).toBeInTheDocument();
    expect(screen.queryByText(/WHERE fl.status = 'FAILED'/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show SQL" })).toHaveAttribute("aria-expanded", "false");
  });

  it("expands to the SQL in mono, with a copy button", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SqlDisclosure query={query(2)} ranAs="dana@example.com" />);

    await user.click(screen.getByRole("button", { name: "Show SQL" }));
    expect(screen.getByRole("button", { name: "Hide SQL" })).toHaveAttribute("aria-expanded", "true");
    const code = screen.getByText(/WHERE fl.status = 'FAILED'/);
    expect(code.tagName).toBe("CODE");
    expect(code.closest("pre")).toHaveClass("font-mono");

    await user.click(screen.getByRole("button", { name: "Copy SQL" }));
    expect(writeText).toHaveBeenCalledWith(SQL);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("falls back to the word you when the email is unknown", () => {
    render(<SqlDisclosure query={query(1)} ranAs={null} />);
    expect(screen.getByText("you")).toBeInTheDocument();
  });
});
