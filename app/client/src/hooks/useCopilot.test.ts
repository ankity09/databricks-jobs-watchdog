// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlledSse, messageResult, queryResult, sseEvent, sseResponse } from "../test/sse";
import { statusLabel, useCopilot } from "./useCopilot";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** Answers each fetch with the next response from the list, and records the request. */
function answerWith(...responses: Response[]) {
  const queue = [...responses];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
      calls.push({ url: urlOf(input), method: init?.method ?? "GET", body });
      const next = queue.shift();
      return next ? Promise.resolve(next) : Promise.reject(new TypeError("no response left"));
    }),
  );
}

const SQL = "SELECT job_name FROM main.watchdog.findings_latest WHERE status = 'FAILED'";

describe("statusLabel", () => {
  it("names each step of a Genie answer in plain words", () => {
    expect(statusLabel("SUBMITTED")).toBe("Sending the question");
    expect(statusLabel("FETCHING_METADATA")).toBe("Reading the tables");
    expect(statusLabel("FILTERING_CONTEXT")).toBe("Thinking");
    expect(statusLabel("ASKING_AI")).toBe("Thinking");
    expect(statusLabel("PENDING_WAREHOUSE")).toBe("Starting the SQL warehouse");
    expect(statusLabel("EXECUTING_QUERY")).toBe("Running the query");
    expect(statusLabel("COMPLETED")).toBe("Loading the results");
    expect(statusLabel("SOMETHING_NEW")).toBe("Working");
  });
});

describe("useCopilot", () => {
  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows Genie's steps as plain labels while the answer streams", async () => {
    const stream = controlledSse();
    answerWith(stream.response);
    const { result } = renderHook(() => useCopilot({}));

    let sent: Promise<void> = Promise.resolve();
    act(() => {
      sent = result.current.send("What is failing right now?");
    });
    expect(result.current.streaming).toBe(true);
    expect(result.current.status).toBe("Thinking");
    expect(result.current.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    stream.push(sseEvent("message_start", { conversationId: "conv-1", messageId: "msg-1", spaceId: "space-1" }));
    await waitFor(() => expect(result.current.conversationId).toBe("conv-1"));
    stream.push(sseEvent("status", { status: "PENDING_WAREHOUSE" }));
    await waitFor(() => expect(result.current.status).toBe("Starting the SQL warehouse"));
    stream.push(sseEvent("status", { status: "EXECUTING_QUERY" }));
    await waitFor(() => expect(result.current.status).toBe("Running the query"));

    stream.push(messageResult({ conversationId: "conv-1", messageId: "msg-1", question: "What is failing right now?", text: "Two jobs failed." }));
    stream.close();
    await act(() => sent);

    expect(result.current.streaming).toBe(false);
    expect(result.current.status).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.messages[1]).toMatchObject({ role: "assistant", text: "Two jobs failed.", error: null });
  });

  it("turns a message_result with a query attachment into an answer with its SQL, then adds the result rows", async () => {
    const stream = controlledSse();
    answerWith(stream.response);
    const { result } = renderHook(() => useCopilot({}));

    let sent: Promise<void> = Promise.resolve();
    act(() => {
      sent = result.current.send("Which jobs failed?");
    });
    stream.push(sseEvent("message_start", { conversationId: "conv-1", messageId: "msg-1", spaceId: "space-1" }));
    stream.push(
      messageResult({ conversationId: "conv-1", messageId: "msg-1", question: "Which jobs failed?", text: "orders_ingest failed.", sql: SQL, attachmentId: "att-1" }),
    );
    await waitFor(() => expect(result.current.messages[1]?.queries).toHaveLength(1));
    const answer = result.current.messages[1];
    expect(answer.queries[0]).toMatchObject({ id: "att-1", sql: SQL, title: "Failing jobs", result: null });
    // The SQL ran, and the rows are still on their way.
    expect(result.current.status).toBe("Loading the results");

    stream.push(queryResult("att-1", ["job_name", "status"], [["orders_ingest", "FAILED"], ["daily_revenue_report", null]]));
    stream.close();
    await act(() => sent);

    expect(result.current.messages[1].queries[0].result).toEqual({
      columns: ["job_name", "status"],
      rows: [
        ["orders_ingest", "FAILED"],
        ["daily_revenue_report", null],
      ],
    });
  });

  it("sets error on an error event, on the hook and on the answer", async () => {
    answerWith(
      sseResponse([
        sseEvent("message_start", { conversationId: "conv-1", messageId: "msg-1", spaceId: "space-1" }),
        sseEvent("error", { error: "You don't have access to this Genie Space." }),
      ]),
    );
    const { result } = renderHook(() => useCopilot({}));
    await act(() => result.current.send("What is failing right now?"));

    expect(result.current.error).toBe("You don't have access to this Genie Space.");
    expect(result.current.streaming).toBe(false);
    expect(result.current.messages[0]).toMatchObject({ role: "user", text: "What is failing right now?" });
    expect(result.current.messages[1]).toMatchObject({ role: "assistant", error: "You don't have access to this Genie Space." });
  });

  it("keeps only the message of an API error that Genie passes on with its JSON body", async () => {
    const raw =
      'Response from server (Not Found) {"error_code":"NOT_FOUND","message":"Conversation with id conv-x not found","details":[{"@type":"type.googleapis.com/google.rpc.RequestInfo"}]}';
    answerWith(sseResponse([sseEvent("error", { error: raw })]));
    const { result } = renderHook(() => useCopilot({ conversationId: "conv-x" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.loadError).toBe("Conversation with id conv-x not found");
  });

  it("reports an answer Genie could not finish as an error", async () => {
    answerWith(
      sseResponse([
        sseEvent("message_start", { conversationId: "conv-1", messageId: "msg-1", spaceId: "space-1" }),
        messageResult({ conversationId: "conv-1", messageId: "msg-1", question: "Rerun orders_ingest", status: "FAILED", error: "SQL_EXECUTION_EXCEPTION" }),
      ]),
    );
    const { result } = renderHook(() => useCopilot({}));
    await act(() => result.current.send("Rerun orders_ingest"));

    expect(result.current.messages[1].error).toBe("Genie could not answer: SQL_EXECUTION_EXCEPTION");
    expect(result.current.error).toBe("Genie could not answer: SQL_EXECUTION_EXCEPTION");
  });

  it("reports a request the server refused, with the server's message", async () => {
    answerWith(new Response(JSON.stringify({ error: "Unknown space alias: default" }), { status: 404, headers: { "Content-Type": "application/json" } }));
    const { result } = renderHook(() => useCopilot({}));
    await act(() => result.current.send("What is failing right now?"));

    expect(result.current.error).toBe("Unknown space alias: default");
    expect(result.current.messages[1].error).toBe("Unknown space alias: default");
  });

  it("continues an existing conversation: replays it, then sends with its conversationId", async () => {
    answerWith(
      sseResponse([
        messageResult({ conversationId: "conv-9", messageId: "msg-1", question: "What is failing right now?", text: "orders_ingest failed.", sql: SQL, attachmentId: "att-1" }),
        sseEvent("history_info", { conversationId: "conv-9", spaceId: "space-1", nextPageToken: null, loadedCount: 1 }),
        queryResult("att-1", ["job_name"], [["orders_ingest"]]),
      ]),
      sseResponse([
        sseEvent("message_start", { conversationId: "conv-9", messageId: "msg-2", spaceId: "space-1" }),
        messageResult({ conversationId: "conv-9", messageId: "msg-2", question: "What does it affect?", text: "daily_revenue_report waits on it." }),
      ]),
    );
    const { result } = renderHook(() => useCopilot({ conversationId: "conv-9" }));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(calls[0]).toMatchObject({ method: "GET" });
    expect(calls[0].url).toMatch(/^\/api\/genie\/default\/conversations\/conv-9\?/);
    expect(result.current.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "What is failing right now?"],
      ["assistant", "orders_ingest failed."],
    ]);
    expect(result.current.messages[1].queries[0].result).toEqual({ columns: ["job_name"], rows: [["orders_ingest"]] });

    await act(() => result.current.send("What does it affect?"));
    expect(calls[1].url).toMatch(/^\/api\/genie\/default\/messages\?/);
    expect(calls[1]).toMatchObject({ method: "POST", body: { content: "What does it affect?", conversationId: "conv-9" } });
    expect(result.current.messages).toHaveLength(4);
    expect(result.current.messages[3].text).toBe("daily_revenue_report waits on it.");
  });

  it("starts a new conversation without a conversationId, and reports it once Genie assigns one", async () => {
    answerWith(
      sseResponse([
        sseEvent("message_start", { conversationId: "conv-new", messageId: "msg-1", spaceId: "space-1" }),
        messageResult({ conversationId: "conv-new", messageId: "msg-1", question: "Summarize the last 24 hours.", text: "Quiet day." }),
      ]),
    );
    const started = vi.fn();
    const { result } = renderHook(() => useCopilot({ onConversationStart: started }));
    await act(() => result.current.send("Summarize the last 24 hours."));

    expect(calls[0].body).toEqual({ content: "Summarize the last 24 hours." });
    expect(started).toHaveBeenCalledWith("conv-new");
    expect(result.current.conversationId).toBe("conv-new");
  });

  it("asks Genie again for an answer whose stream ended early", async () => {
    answerWith(
      sseResponse([sseEvent("message_start", { conversationId: "conv-1", messageId: "msg-1", spaceId: "space-1" }), sseEvent("status", { status: "ASKING_AI" })]),
      sseResponse([messageResult({ conversationId: "conv-1", messageId: "msg-1", question: "What is failing right now?", text: "All healthy." })]),
    );
    const { result } = renderHook(() => useCopilot({}));
    await act(() => result.current.send("What is failing right now?"));

    expect(calls[1].url).toMatch(/^\/api\/genie\/default\/conversations\/conv-1\/messages\/msg-1\?/);
    expect(result.current.messages[1]).toMatchObject({ text: "All healthy.", error: null });
    expect(result.current.error).toBeNull();
  });

  it("retry sends the last question again after an error", async () => {
    answerWith(
      sseResponse([sseEvent("error", { error: "Genie request failed" })]),
      sseResponse([
        sseEvent("message_start", { conversationId: "conv-1", messageId: "msg-1", spaceId: "space-1" }),
        messageResult({ conversationId: "conv-1", messageId: "msg-1", question: "What is failing right now?", text: "Nothing." }),
      ]),
    );
    const { result } = renderHook(() => useCopilot({}));
    await act(() => result.current.send("What is failing right now?"));
    expect(result.current.error).toBe("Genie request failed");

    await act(() => result.current.retry());
    expect(calls[1].body).toEqual({ content: "What is failing right now?" });
    expect(result.current.error).toBeNull();
    expect(result.current.messages.map((m) => [m.role, m.text, m.error])).toEqual([
      ["user", "What is failing right now?", null],
      ["assistant", "Nothing.", null],
    ]);
  });
});
