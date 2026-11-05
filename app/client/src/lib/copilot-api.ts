import { z } from "zod";
import { apiFetch } from "./api";
import type { SseEvent } from "./sse";

/**
 * The copilot's calls. The chat goes through the AppKit genie plugin's routes
 * for the copilot's space (alias "default" in server.ts); the Recent chats list
 * comes from the app's own GET /api/copilot/conversations.
 */
export const GENIE_BASE = "/api/genie/default";

const Attachment = z.object({
  attachmentId: z.string().nullish(),
  query: z
    .object({
      title: z.string().nullish(),
      description: z.string().nullish(),
      query: z.string().nullish(),
      statementId: z.string().nullish(),
    })
    .nullish(),
  text: z.object({ content: z.string().nullish() }).nullish(),
  suggestedQuestions: z.array(z.string()).nullish(),
});

const GenieMessageSchema = z.object({
  messageId: z.string(),
  conversationId: z.string(),
  status: z.string().nullish(),
  /** The person's question. Genie's answer is in the attachments. */
  content: z.string().nullish(),
  attachments: z.array(Attachment).nullish(),
  error: z.string().nullish(),
});

export type GenieMessage = z.infer<typeof GenieMessageSchema>;

const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** The statement_response of a query attachment: the columns and the rows, as strings. */
const StatementResponse = z.object({
  manifest: z.object({ schema: z.object({ columns: z.array(z.object({ name: z.string() })).nullish() }).nullish() }).nullish(),
  result: z.object({ data_array: z.array(z.array(Cell)).nullish() }).nullish(),
});

/** The events the genie plugin streams: message_start, status, message_result, query_result, history_info and error. */
const GenieEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message_start"), conversationId: z.string(), messageId: z.string() }),
  z.object({ type: z.literal("status"), status: z.string() }),
  z.object({ type: z.literal("message_result"), message: GenieMessageSchema }),
  z.object({ type: z.literal("query_result"), attachmentId: z.string(), data: StatementResponse }),
  z.object({ type: z.literal("history_info"), nextPageToken: z.string().nullish() }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);

export type GenieEvent = z.infer<typeof GenieEventSchema>;

/**
 * One SSE event from the genie plugin, checked. AppKit's stream manager writes
 * its own errors (a failed or expired stream) without a type in the data, so the
 * SSE event name fills it in. Anything else unknown is skipped.
 */
export function parseGenieEvent(sse: SseEvent): GenieEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(sse.data);
  } catch {
    return null;
  }
  if (typeof data === "object" && data !== null && !("type" in data) && sse.event) data = { ...data, type: sse.event };
  const parsed = GenieEventSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export interface QueryRows {
  columns: string[];
  rows: (string | null)[][];
}

/** The rows of a query_result event, with every cell as a string or null. */
export function toQueryRows(data: z.infer<typeof StatementResponse>): QueryRows {
  return {
    columns: (data.manifest?.schema?.columns ?? []).map((c) => c.name),
    rows: (data.result?.data_array ?? []).map((row) => row.map((cell) => (cell === null ? null : String(cell)))),
  };
}

const ConversationsSchema = z.object({
  conversations: z.array(z.object({ id: z.string(), title: z.string(), updatedAt: z.string() })),
});

export type ConversationSummary = z.infer<typeof ConversationsSchema>["conversations"][number];

/** GET /api/copilot/conversations: the signed-in person's own chats, newest first. */
export async function listConversations(): Promise<ConversationSummary[]> {
  const body = await apiFetch("/api/copilot/conversations", ConversationsSchema);
  return body.conversations;
}

const listeners = new Set<() => void>();

/** Calls the listener each time the copilot starts a chat, so the Recent chats list can reload. */
export function onConversationsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells the Recent chats list that a chat started. */
export function conversationsChanged(): void {
  for (const listener of [...listeners]) listener();
}
