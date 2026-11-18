// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedbackInput, FeedbackRating } from "../../lib/copilot-api";

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

  it("keeps the shown rating consistent when the first write finishes after a second click", async () => {
    let finishFirst: () => void = () => { throw new Error("feedback was not sent"); };
    let stored: FeedbackRating = "NONE";
    sendFeedback.mockImplementation(({ rating }: FeedbackInput) => {
      stored = rating;
      return Promise.resolve();
    });
    sendFeedback.mockImplementationOnce(({ rating }: FeedbackInput) => new Promise<void>((resolve) => {
      finishFirst = () => { stored = rating; resolve(); };
    }));
    render(<FeedbackButtons conversationId="conv-1" messageId="msg-1" />);
    const good = screen.getByRole("button", { name: "Good answer" });
    const bad = screen.getByRole("button", { name: "Bad answer" });

    await userEvent.click(good);
    await userEvent.click(bad);
    await act(() => Promise.resolve(finishFirst()));

    expect(stored).toBe("POSITIVE");
    expect(good).toHaveAttribute("aria-pressed", "true");
    expect(bad).toHaveAttribute("aria-pressed", "false");
    expect(sendFeedback).toHaveBeenCalledTimes(1);
    await userEvent.click(bad);
    expect(stored).toBe("NEGATIVE");
    expect(bad).toHaveAttribute("aria-pressed", "true");
  });

  it("a failed pending write cannot undo a competing successful rating", async () => {
    let failFirst: () => void = () => { throw new Error("feedback was not sent"); };
    let stored: FeedbackRating = "NONE";
    sendFeedback.mockImplementation(({ rating }: FeedbackInput) => {
      stored = rating;
      return Promise.resolve();
    });
    sendFeedback.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      failFirst = () => reject(new Error("not saved"));
    }));
    render(<FeedbackButtons conversationId="conv-1" messageId="msg-1" />);
    const good = screen.getByRole("button", { name: "Good answer" });
    const bad = screen.getByRole("button", { name: "Bad answer" });

    await userEvent.click(good);
    await userEvent.click(bad);
    await act(() => Promise.resolve(failFirst()));

    expect(stored).toBe("NONE");
    expect(good).toHaveAttribute("aria-pressed", "false");
    expect(bad).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status")).toHaveTextContent("Your feedback couldn't be sent.");
    await userEvent.click(bad);
    expect(stored).toBe("NEGATIVE");
    expect(bad).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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
