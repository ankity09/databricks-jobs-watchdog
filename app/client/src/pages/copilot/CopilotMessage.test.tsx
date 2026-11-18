// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CopilotMessage as Message, CopilotQuery } from "../../hooks/useCopilot";
import { CopilotMessage } from "./CopilotMessage";

vi.mock("./AnswerChart", () => ({ default: () => <div data-testid="chart" /> }));

function makeQuery(id: string, title: string): CopilotQuery {
  const rows = [["orders_ingest", "1"]];
  return {
    id,
    title,
    description: null,
    sql: "SELECT 1",
    result: { columns: ["job", "steps_away"], rows },
    statement: {
      manifest: {
        schema: {
          columns: [
            { name: "job", type_name: "STRING" },
            { name: "steps_away", type_name: "INT" },
          ],
        },
      },
      result: { data_array: rows },
    },
    rowCount: 1,
    truncated: false,
  };
}

function makeMessage(over: Partial<Message> = {}): Message {
  return { id: "m1", role: "assistant", text: "One job is affected.", status: null, queries: [], suggestions: [], error: null, rowsExpired: false, ...over };
}

describe("CopilotMessage", () => {
  it("an answer with two queries shows two blocks in one card", () => {
    render(<CopilotMessage message={makeMessage({ queries: [makeQuery("a", "Affected jobs"), makeQuery("b", "Failed checks")] })} ranAs="dana@example.com" statusLabel={null} />);
    const card = screen.getByRole("article", { name: "Copilot answer" });
    expect(within(card).getAllByRole("region", { name: "Query result" })).toHaveLength(2);
    expect(screen.getAllByRole("article", { name: "Copilot answer" })).toHaveLength(1);
    expect(within(card).getByText("One job is affected.")).toBeInTheDocument();
    expect(within(card).getByText("AI-generated. Check before acting.")).toBeInTheDocument();
  });

  it("a suggestion chip asks its question", async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn();
    render(<CopilotMessage message={makeMessage({ suggestions: ["Which jobs failed on Nov 7?", "Show it by job"] })} ranAs={null} statusLabel={null} onAsk={onAsk} />);
    const chips = screen.getByRole("group", { name: "Follow-up questions" });
    expect(within(chips).getAllByRole("button").map((b) => b.textContent)).toEqual(["Which jobs failed on Nov 7?", "Show it by job"]);
    await user.click(within(chips).getByRole("button", { name: "Show it by job" }));
    expect(onAsk).toHaveBeenCalledWith("Show it by job");
  });

  it("while Genie runs, the status words and the skeleton show", () => {
    render(<CopilotMessage message={makeMessage({ text: "", status: "EXECUTING_QUERY" })} ranAs={null} statusLabel="Running the query" />);
    expect(screen.getByRole("status")).toHaveTextContent("Running the query");
    expect(screen.getByTestId("running-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("AI-generated. Check before acting.")).not.toBeInTheDocument();
  });

  it("with reduced motion, the skeleton does not pulse", () => {
    render(<CopilotMessage message={makeMessage({ text: "", status: "EXECUTING_QUERY" })} ranAs={null} statusLabel="Running the query" />);
    const block = screen.getByTestId("running-block");
    expect(block).toHaveClass("motion-safe:animate-pulse");
    expect(block.className).not.toMatch(/(^|\s)animate-pulse/);
    for (const line of screen.getByTestId("running-skeleton").children) expect(line).toHaveClass("motion-reduce:animate-none");
  });

  it("a finished answer in a chat has thumbs in its footer, and a running one has none", () => {
    const { rerender } = render(<CopilotMessage message={makeMessage()} ranAs={null} statusLabel={null} conversationId="conv-1" />);
    expect(screen.getByRole("button", { name: "Good answer" })).toBeInTheDocument();
    rerender(<CopilotMessage message={makeMessage({ status: "EXECUTING_QUERY" })} ranAs={null} statusLabel="Running" conversationId="conv-1" />);
    expect(screen.queryByRole("button", { name: "Good answer" })).not.toBeInTheDocument();
  });
});
