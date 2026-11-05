/** Server-sent event helpers for tests that stand in for the AppKit genie plugin's routes. */

/** One event the way AppKit's stream manager writes it: an event line, then the JSON data with its type. */
export function sseEvent(type: string, payload: Record<string, unknown>): string {
  return `id: ${type}-${Math.random().toString(16).slice(2)}\nevent: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** A finished event stream: every chunk at once. */
export function sseResponse(chunks: string[]): Response {
  return new Response(chunks.join(""), { headers: { "Content-Type": "text/event-stream" } });
}

export interface ControlledSse {
  response: Response;
  push(chunk: string): void;
  close(): void;
}

/** An event stream the test feeds chunk by chunk, to check what shows while an answer is still coming. */
export function controlledSse(): ControlledSse {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    push(chunk) {
      controller?.enqueue(encoder.encode(chunk));
    },
    close() {
      controller?.close();
    },
  };
}

/** A Genie message_result for a question and its answer, as the genie plugin sends it. */
export function messageResult(options: {
  conversationId: string;
  messageId: string;
  question: string;
  text?: string;
  sql?: string;
  attachmentId?: string;
  status?: string;
  error?: string;
  suggestions?: string[];
}): string {
  const attachments: Record<string, unknown>[] = [];
  if (options.sql) {
    attachments.push({
      attachmentId: options.attachmentId ?? `${options.messageId}-q`,
      query: { title: "Failing jobs", description: "Jobs that failed in the newest scan.", query: options.sql, statementId: "st-1" },
    });
  }
  if (options.text) attachments.push({ attachmentId: `${options.messageId}-t`, text: { content: options.text } });
  if (options.suggestions) attachments.push({ attachmentId: `${options.messageId}-s`, suggestedQuestions: options.suggestions });
  return sseEvent("message_result", {
    message: {
      messageId: options.messageId,
      conversationId: options.conversationId,
      spaceId: "space-1",
      status: options.status ?? "COMPLETED",
      content: options.question,
      attachments,
      ...(options.error ? { error: options.error } : {}),
    },
  });
}

/** A query_result for an attachment: the columns and rows Genie's query returned. */
export function queryResult(attachmentId: string, columns: string[], rows: (string | null)[][]): string {
  return sseEvent("query_result", {
    attachmentId,
    statementId: "st-1",
    data: {
      manifest: { schema: { columns: columns.map((name) => ({ name, type_name: "STRING" })) } },
      result: { data_array: rows },
    },
  });
}
