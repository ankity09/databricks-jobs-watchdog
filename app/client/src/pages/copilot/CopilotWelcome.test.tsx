// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CopilotWelcome, STARTER_QUESTIONS } from "./CopilotWelcome";

describe("CopilotWelcome", () => {
  it("shows the title, the line and four starter cards with a hint each", () => {
    render(<CopilotWelcome onPick={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "What do you want to know?" })).toBeInTheDocument();
    expect(screen.getByText("Answers come from the Watchdog tables and run as you. Your recent chats are in the sidebar.")).toBeInTheDocument();
    expect(STARTER_QUESTIONS.map((s) => s.question)).toEqual([
      "What is failing right now?",
      "Which jobs missed their schedule?",
      "What breaks if orders_ingest fails?",
      "Summarize the last 24 hours.",
    ]);
    const cards = within(screen.getByRole("group", { name: "Suggested questions" })).getAllByRole("button");
    expect(cards).toHaveLength(4);
    for (const [i, { question, hint }] of STARTER_QUESTIONS.entries()) {
      expect(cards[i]).toHaveTextContent(question);
      expect(cards[i]).toHaveTextContent(hint);
    }
  });

  it("a starter card asks its question", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<CopilotWelcome onPick={onPick} />);
    await user.click(screen.getByRole("button", { name: /What is failing right now\?/ }));
    expect(onPick).toHaveBeenCalledWith("What is failing right now?");
  });
});
