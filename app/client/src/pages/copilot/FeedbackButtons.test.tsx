// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendFeedback = vi.fn();
vi.mock("../../lib/copilot-api", () => ({ sendFeedback: (input: unknown): Promise<void> => sendFeedback(input) as Promise<void> }));

import { FeedbackButtons } from "./FeedbackButtons";

describe("FeedbackButtons", () => {
  beforeEach(() => {
    sendFeedback.mockReset();
    sendFeedback.mockResolvedValue(undefined);
  });

  it("a click sends NEGATIVE and presses the button", async () => {
    render(<FeedbackButtons conversationId="conv-1" messageId="msg-1" />);
    const bad = screen.getByRole("button", { name: "Bad answer" });
    expect(bad).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(bad);

    expect(sendFeedback).toHaveBeenCalledWith({ conversationId: "conv-1", messageId: "msg-1", rating: "NEGATIVE" });
    expect(bad).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Good answer" })).toHaveAttribute("aria-pressed", "false");
  });

  it("a second click sends NONE", async () => {
    render(<FeedbackButtons conversationId="conv-1" messageId="msg-1" />);
    const bad = screen.getByRole("button", { name: "Bad answer" });
    await userEvent.click(bad);
    await userEvent.click(bad);

    expect(sendFeedback).toHaveBeenLastCalledWith({ conversationId: "conv-1", messageId: "msg-1", rating: "NONE" });
    expect(bad).toHaveAttribute("aria-pressed", "false");
  });

  it("a failed send reverts and says so", async () => {
    sendFeedback.mockRejectedValue(new Error("nope"));
    render(<FeedbackButtons conversationId="conv-1" messageId="msg-1" />);
    const good = screen.getByRole("button", { name: "Good answer" });
    await userEvent.click(good);

    expect(good).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status")).toHaveTextContent("Your feedback couldn't be sent.");
  });

  it("no buttons before Genie names the message", () => {
    const { rerender } = render(<FeedbackButtons conversationId="conv-1" messageId="local-3" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(<FeedbackButtons conversationId={null} messageId="msg-1" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("a reopened chat starts with Genie's stored rating", () => {
    render(<FeedbackButtons conversationId="conv-1" messageId="msg-1" initial="POSITIVE" />);
    expect(screen.getByRole("button", { name: "Good answer" })).toHaveAttribute("aria-pressed", "true");
  });
});
