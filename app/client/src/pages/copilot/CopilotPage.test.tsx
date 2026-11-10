// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { routes } from "../../routes";
import { controlledSse, messageResult, queryResult, sseEvent, sseResponse } from "../../test/sse";

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

  it("a new chat shows the welcome view and a starter card asks its question", async () => {
    const user = userEvent.setup();
    genieAnswers = [answer("conv-1", "msg-1", SAMPLE_QUESTIONS[0], "Nothing is failing.")];
    await renderAt("/copilot");
    expect(await screen.findByRole("heading", { name: "What do you want to know?" })).toBeInTheDocument();
    const suggestions = await screen.findByRole("group", { name: "Suggested questions" });
    expect(within(suggestions).getAllByRole("button")).toHaveLength(SAMPLE_QUESTIONS.length);
    await user.click(within(suggestions).getByRole("button", { name: new RegExp(SAMPLE_QUESTIONS[0]) }));
    await screen.findByText("Nothing is failing.");
    expect(genieCalls[0].body).toEqual({ content: SAMPLE_QUESTIONS[0] });
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

  it("holds a question while the chat cannot be loaded, and sends it once Retry loads the chat", async () => {
    const user = userEvent.setup();
    const load = controlledSse();
    genieAnswers = [
      load.response,
      sseResponse([messageResult({ conversationId: "conv-7", messageId: "msg-1", question: "Summarize the last 24 hours.", text: "A quiet day." })]),
      answer("conv-7", "msg-2", "What does it affect?", "Nothing runs downstream of it."),
    ];
    await renderAt("/copilot/conv-7");

    // A question typed while the saved chat loads; then the chat fails to load.
    const input = screen.getByRole("textbox", { name: "Question" });
    await user.type(input, "What does it affect?");
    load.push(sseEvent("error", { error: "Conversation conv-7 not found" }));
    load.close();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This chat could not be loaded.");

    // Neither Enter nor Send sends it to a chat that is not on the page, and it stays in the input.
    await user.keyboard("{Enter}");
    const send = screen.getByRole("button", { name: "Send" });
    await user.click(send);
    expect(genieCalls.map((c) => c.method)).toEqual(["GET"]);
    expect(input).toHaveValue("What does it affect?");
    expect(input).toBeDisabled();
    expect(send).toBeDisabled();

    // Retry loads the chat; the question then goes to it and shows under its answers.
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("A quiet day.")).toBeInTheDocument();
    expect(input).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Nothing runs downstream of it.")).toBeInTheDocument();
    expect(screen.getByText("What does it affect?")).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(genieCalls.map((c) => [c.method, c.body])).toEqual([
      ["GET", null],
      ["GET", null],
      ["POST", { content: "What does it affect?", conversationId: "conv-7" }],
    ]);
  });

  it("leaves a chat that cannot be loaded for a new one with New chat", async () => {
    const user = userEvent.setup();
    genieAnswers = [json({ error: "Conversation not found" }, 404), answer("conv-2", "msg-1", "What is failing right now?", "orders_ingest failed.")];
    const router = await renderAt("/copilot/conv-7");
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/copilot"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Question" }), "What is failing right now?{Enter}");
    expect(await screen.findByText("orders_ingest failed.")).toBeInTheDocument();
    expect(genieCalls.map((c) => c.body)).toEqual([null, { content: "What is failing right now?" }]);
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

  it("shows a skeleton, not 'rows not available', while a reopened chat loads its rows", async () => {
    const user = userEvent.setup();
    const load = controlledSse();
    genieAnswers = [load.response];
    await renderAt("/copilot/conv-7");
    load.push(messageResult({ conversationId: "conv-7", messageId: "msg-1", question: "Which jobs failed?", text: "Two failed.", sql: "SELECT 1", attachmentId: "att-1" }));
    await screen.findByText("Two failed.");
    await user.click(screen.getByRole("button", { name: "Show SQL" }));
    expect(screen.getByLabelText("Loading the rows")).toBeInTheDocument();
    expect(screen.queryByText(/The rows are not available/)).not.toBeInTheDocument();

    load.push(queryResult("att-1", ["job_name"], [["orders_ingest"]]));
    load.close();
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("fetches missing rows again with Retry", async () => {
    const user = userEvent.setup();
    genieAnswers = [
      sseResponse([
        messageResult({ conversationId: "conv-7", messageId: "msg-1", question: "Which jobs failed?", text: "Two failed.", sql: "SELECT 1", attachmentId: "att-1" }),
        sseEvent("error", { error: "Failed to fetch query result" }),
      ]),
      sseResponse([
        messageResult({ conversationId: "conv-7", messageId: "msg-1", question: "Which jobs failed?", text: "Two failed.", sql: "SELECT 1", attachmentId: "att-1" }),
        queryResult("att-1", ["job_name"], [["orders_ingest"]]),
      ]),
    ];
    await renderAt("/copilot/conv-7");
    await screen.findByText("Two failed.");
    await user.click(screen.getByRole("button", { name: "Show SQL" }));
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(genieCalls[1].url).toMatch(/\/conversations\/conv-7\/messages\/msg-1\?/);
    expect(genieCalls[1].method).toBe("GET");
  });

  it("offers no Retry for rows that Genie says have expired, and says to ask again", async () => {
    const user = userEvent.setup();
    genieAnswers = [
      sseResponse([
        messageResult({ conversationId: "conv-8", messageId: "msg-1", question: "Which jobs failed?", text: "Two failed.", sql: "SELECT 1", attachmentId: "att-1", status: "QUERY_RESULT_EXPIRED" }),
        sseEvent("error", { error: "Failed to fetch query result" }),
      ]),
    ];
    await renderAt("/copilot/conv-8");
    await screen.findByText("Two failed.");
    await user.click(screen.getByRole("button", { name: "Show SQL" }));
    expect(await screen.findByText(/Ask again to run the query again/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("says so when Retry for the rows fails too, and drops the message when a later Retry works", async () => {
    const user = userEvent.setup();
    const first = messageResult({ conversationId: "conv-7", messageId: "msg-1", question: "Which jobs failed?", text: "Two failed.", sql: "SELECT 1", attachmentId: "att-1" });
    genieAnswers = [
      sseResponse([first, sseEvent("error", { error: "Failed to fetch query result" })]),
      sseResponse([sseEvent("error", { error: "Failed to fetch query result" })]),
      sseResponse([first, queryResult("att-1", ["job_name"], [["orders_ingest"]])]),
    ];
    await renderAt("/copilot/conv-7");
    await screen.findByText("Two failed.");
    await user.click(screen.getByRole("button", { name: "Show SQL" }));
    expect(screen.queryByText("Could not load the rows.")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Could not load the rows.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByText("Could not load the rows.")).not.toBeInTheDocument();
  });

  it("uses the query's description as the answer when Genie sent no text", async () => {
    genieAnswers = [sseResponse([messageResult({ conversationId: "conv-7", messageId: "msg-1", question: "Which jobs failed?", sql: "SELECT 1" })])];
    await renderAt("/copilot/conv-7");
    expect(await screen.findByText("Jobs that failed in the newest scan.")).toBeInTheDocument();
    expect(screen.queryByText("Genie sent no answer to this question.")).not.toBeInTheDocument();
  });

  describe("scrolling", () => {
    /** jsdom has no layout, so the log's size and position are set by hand; writes to scrollTop are recorded. */
    function measure(list: HTMLElement, position: { top: number }) {
      const writes: number[] = [];
      Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 1000 });
      Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 200 });
      Object.defineProperty(list, "scrollTop", {
        configurable: true,
        get: () => position.top,
        set: (value: number) => {
          writes.push(value);
          position.top = value;
        },
      });
      return writes;
    }

    async function startAnswer() {
      const user = userEvent.setup();
      const stream = controlledSse();
      genieAnswers = [stream.response];
      await renderAt("/copilot");
      await user.click(await screen.findByRole("button", { name: "What is failing right now?" }));
      const list = screen.getByRole("log", { name: "Messages" });
      const position = { top: 800 };
      const writes = measure(list, position);
      stream.push(sseEvent("message_start", { conversationId: "conv-1", messageId: "msg-1", spaceId: "space-1" }));
      await screen.findByText("Thinking");
      return { stream, list, position, writes };
    }

    it("scrolls when new content arrives and the reader is at the bottom, but not on a status change", async () => {
      const { stream, list, writes } = await startAnswer();
      writes.length = 0;
      stream.push(sseEvent("status", { status: "EXECUTING_QUERY" }));
      await screen.findByText("Running the query");
      expect(writes).toEqual([]);

      stream.push(messageResult({ conversationId: "conv-1", messageId: "msg-1", question: "What is failing right now?", text: "orders_ingest failed." }));
      await screen.findByText("orders_ingest failed.");
      expect(writes.at(-1)).toBe(list.scrollHeight);
      stream.close();
    });

    it("leaves the position alone when the reader has scrolled up", async () => {
      const { stream, list, position, writes } = await startAnswer();
      position.top = 100;
      list.dispatchEvent(new Event("scroll"));
      writes.length = 0;
      stream.push(messageResult({ conversationId: "conv-1", messageId: "msg-1", question: "What is failing right now?", text: "orders_ingest failed." }));
      await screen.findByText("orders_ingest failed.");
      expect(writes).toEqual([]);
      stream.close();
    });
  });
});
