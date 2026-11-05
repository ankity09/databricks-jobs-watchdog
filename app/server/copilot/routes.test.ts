import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const listConversations = vi.fn();
vi.mock("@databricks/appkit", () => ({
  getExecutionContext: () => ({ client: { genie: { listConversations } } }),
}));

const { COPILOT_NOT_SET_UP, genieConversations, registerCopilotNotSetUp, registerCopilotRoutes, toConversationSummary } = await import("./routes");
type ConversationSource = Parameters<typeof registerCopilotRoutes>[1]["conversations"];

let server: ReturnType<express.Application["listen"]> | null = null;

async function start(conversations: ConversationSource): Promise<string> {
  const app = express();
  registerCopilotRoutes(app, { conversations });
  server = app.listen(0);
  await new Promise((resolve) => server?.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function summary(i: number) {
  return { id: `conv-${i}`, title: `Question ${i}`, updatedAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() };
}

describe("GET /api/copilot/conversations", () => {
  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = null;
    listConversations.mockReset();
  });

  it("returns the person's own conversations, newest first, at most 20", async () => {
    const list = vi.fn((_req: express.Request, _limit: number) => Promise.resolve(Array.from({ length: 25 }, (_, i) => summary(i))));
    const base = await start({ list });
    const response = await fetch(`${base}/api/copilot/conversations`, { headers: { "x-forwarded-user": "4321@1234" } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { conversations: ReturnType<typeof summary>[] };
    expect(body.conversations).toHaveLength(20);
    expect(body.conversations[0]).toEqual(summary(24));
    expect(body.conversations[19]).toEqual(summary(5));
    const [request, limit] = list.mock.calls[0];
    expect(request.header("x-forwarded-user")).toBe("4321@1234");
    expect(limit).toBe(20);
  });

  it("passes on Genie's refusal, with a message", async () => {
    const refusal = Object.assign(new Error("User does not have permission"), { statusCode: 403 });
    const base = await start({ list: () => Promise.reject(refusal) });
    const response = await fetch(`${base}/api/copilot/conversations`);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "genie", message: "You don't have access to the copilot's Genie space." });
  });

  it("answers 502 when Genie fails for another reason", async () => {
    const base = await start({ list: () => Promise.reject(new Error("socket hang up")) });
    const response = await fetch(`${base}/api/copilot/conversations`);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "genie", message: "Recent chats could not be loaded from Genie." });
  });
});

describe("genieConversations", () => {
  it("lists the conversations as the person asking, in the copilot's space", async () => {
    listConversations.mockResolvedValue({
      conversations: [
        { conversation_id: "c-old", title: "What is failing right now?", created_timestamp: Date.UTC(2026, 10, 1) },
        { conversation_id: "c-new", title: "", created_timestamp: Date.UTC(2026, 10, 2) },
      ],
    });
    let runs = 0;
    const asUser = vi.fn((_req: express.Request) => ({
      run<T>(fn: () => Promise<T>): Promise<T> {
        runs += 1;
        return fn();
      },
    }));
    const request = { headers: {} } as express.Request;

    const source = genieConversations({ asUser }, "space-1");
    const conversations = await source.list(request, 20);

    expect(asUser).toHaveBeenCalledWith(request);
    expect(runs).toBe(1);
    expect(listConversations).toHaveBeenCalledWith({ space_id: "space-1", page_size: 20 });
    expect(conversations).toEqual([
      { id: "c-new", title: "Untitled chat", updatedAt: "2026-11-02T00:00:00.000Z" },
      { id: "c-old", title: "What is failing right now?", updatedAt: "2026-11-01T00:00:00.000Z" },
    ]);
  });
});

describe("toConversationSummary", () => {
  it("uses the first question as the title, trimmed, and Genie's time", () => {
    expect(toConversationSummary({ conversation_id: "c1", title: "  Why did orders_ingest fail?\n", created_timestamp: 0 })).toEqual({
      id: "c1",
      title: "Why did orders_ingest fail?",
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
  });
});

describe("without a Genie space", () => {
  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = null;
  });

  it("answers the copilot's routes and the genie plugin's paths with 503 and what to do", async () => {
    const app = express();
    registerCopilotNotSetUp(app);
    server = app.listen(0);
    await new Promise((resolve) => server?.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const [method, path] of [["GET", "/api/copilot/conversations"], ["POST", "/api/genie/default/messages"],
      ["GET", "/api/genie/default/conversations/abc"]]) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status, path).toBe(503);
      expect(await res.json()).toEqual({ error: "not_configured", message: COPILOT_NOT_SET_UP });
    }
    expect(COPILOT_NOT_SET_UP).toBe("The copilot isn't set up in this app. Set the Genie space for the app, then restart it.");
  });
});
