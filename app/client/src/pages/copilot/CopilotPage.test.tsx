// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { routes } from "../../routes";
import { messageResult, sseEvent, sseResponse } from "../../test/sse";

const SAMPLE_QUESTIONS = [
  "What is failing right now?",
  "Which jobs missed their schedule?",
  "What breaks if orders_ingest fails?",
  "Summarize the last 24 hours.",
];

let genieAnswers: Response[] = [];
let genieCalls: { url: string; method: string; body: unknown }[] = [];

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function respond(url: string, init?: RequestInit): Response {
  if (url.startsWith("/api/genie/")) {
    genieCalls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null });
    return genieAnswers.shift() ?? json({ error: "no answer queued" }, 500);
  }
  if (url.startsWith("/api/app-config")) {
    return json({ catalog: "main", schema: "watchdog", region: "us-east-2", appName: "watchdog-app", lakebaseProject: "jobs-watchdog" });
  }
  if (url.startsWith("/api/whoami")) return json({ user: "4321@1234", email: "dana@example.com" });
  if (url.startsWith("/api/copilot/conversations")) return json({ conversations: [] });
  if (url.startsWith("/api/analytics/query/")) {
    return new Response('data: {"type":"result","data":[]}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  }
  return json({ error: "not_found", message: `No route for ${url}` }, 404);
}

function answer(conversationId: string, messageId: string, question: string, text: string): Response {
  return sseResponse([
    sseEvent("message_start", { conversationId, messageId, spaceId: "space-1" }),
    messageResult({ conversationId, messageId, question, text, sql: "SELECT 1", attachmentId: `${messageId}-q` }),
  ]);
}

async function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} />);
  await screen.findByRole("heading", { level: 1, name: "Copilot" });
  return router;
}

describe("the copilot page", () => {
  beforeEach(() => {
    window.localStorage.clear();
    genieAnswers = [];
    genieCalls = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(respond(urlOf(input), init))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the suggested questions in an empty chat", async () => {
    await renderAt("/copilot");
    const suggestions = await screen.findByRole("group", { name: "Suggested questions" });
    expect(within(suggestions).getAllByRole("button").map((b) => b.textContent)).toEqual(SAMPLE_QUESTIONS);
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("");
  });

  it("fills in the question from a Monitoring deep link, without sending it", async () => {
    await renderAt("/copilot?job=orders_ingest&workspace=1234567890&status=FAILED");
    expect(await screen.findByRole("textbox", { name: "Question" })).toHaveValue(
      "Why is orders_ingest failing in workspace 1234567890, and what does it affect?",
    );
    expect(genieCalls).toEqual([]);
  });

  it("asks for a warning or a status in words that fit the deep link", async () => {
    await renderAt("/copilot?job=orders_ingest&status=WARNING");
    expect(await screen.findByRole("textbox", { name: "Question" })).toHaveValue("Why does orders_ingest have a warning, and what should I check?");
  });

  it("puts the AI note under every answer, and moves to the new chat's address", async () => {
    const user = userEvent.setup();
    genieAnswers = [
      answer("conv-1", "msg-1", "What is failing right now?", "orders_ingest failed."),
      answer("conv-1", "msg-2", "What does it affect?", "daily_revenue_report waits on it."),
    ];
    const router = await renderAt("/copilot");

    await user.click(await screen.findByRole("button", { name: "What is failing right now?" }));
    await screen.findByText("orders_ingest failed.");
    await waitFor(() => expect(router.state.location.pathname).toBe("/copilot/conv-1"));

    await user.type(screen.getByRole("textbox", { name: "Question" }), "What does it affect?{Enter}");
    await screen.findByText("daily_revenue_report waits on it.");

    expect(genieCalls.map((c) => c.body)).toEqual([
      { content: "What is failing right now?" },
      { content: "What does it affect?", conversationId: "conv-1" },
    ]);
    const answers = screen.getAllByRole("article", { name: "Copilot answer" });
    expect(answers).toHaveLength(2);
    for (const article of answers) {
      expect(within(article).getByText("AI-generated. Check before acting.")).toBeInTheDocument();
      expect(within(article).getByText("dana@example.com")).toBeInTheDocument();
    }
    expect(screen.getAllByText("AI-generated. Check before acting.")).toHaveLength(2);
  });

  it("shows an error in the chat, with Retry", async () => {
    const user = userEvent.setup();
    genieAnswers = [
      sseResponse([sseEvent("error", { error: "Genie request failed" })]),
      answer("conv-1", "msg-1", "Which jobs missed their schedule?", "None missed it."),
    ];
    await renderAt("/copilot");

    await user.click(await screen.findByRole("button", { name: "Which jobs missed their schedule?" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Genie request failed");

    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    await screen.findByText("None missed it.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(genieCalls).toHaveLength(2);
    expect(genieCalls[1].body).toEqual({ content: "Which jobs missed their schedule?" });
  });

  it("replays a saved chat, and shows Retry when it cannot be loaded", async () => {
    const user = userEvent.setup();
    genieAnswers = [
      json({ error: "Conversation not found" }, 404),
      sseResponse([messageResult({ conversationId: "conv-7", messageId: "msg-1", question: "Summarize the last 24 hours.", text: "A quiet day." })]),
    ];
    await renderAt("/copilot/conv-7");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This chat could not be loaded.");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("A quiet day.")).toBeInTheDocument();
    expect(screen.getByText("Summarize the last 24 hours.")).toBeInTheDocument();
    expect(genieCalls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  it("starts over with New chat", async () => {
    const user = userEvent.setup();
    genieAnswers = [answer("conv-1", "msg-1", "What is failing right now?", "orders_ingest failed.")];
    const router = await renderAt("/copilot");
    await user.click(await screen.findByRole("button", { name: "What is failing right now?" }));
    await screen.findByText("orders_ingest failed.");

    await user.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/copilot"));
    expect(await screen.findByRole("group", { name: "Suggested questions" })).toBeInTheDocument();
    expect(screen.queryByText("orders_ingest failed.")).not.toBeInTheDocument();
  });
});
