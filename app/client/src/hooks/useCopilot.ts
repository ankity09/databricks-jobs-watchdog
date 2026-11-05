import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { GENIE_BASE, type GenieEvent, type GenieMessage, type QueryRows, parseGenieEvent, toQueryRows } from "../lib/copilot-api";
import { readSse } from "../lib/sse";

/**
 * The copilot chat, over the AppKit genie plugin's routes. Genie runs every
 * question as the signed-in person and keeps the conversation, so a chat is
 * reopened by its Genie conversation ID.
 */

export type CopilotQueryResult = QueryRows;

/** A query Genie wrote and ran for an answer. */
export interface CopilotQuery {
  /** The query attachment's ID. */
  id: string;
  title: string | null;
  description: string | null;
  sql: string;
  /** The rows, once the query_result event came back. */
  result: CopilotQueryResult | null;
}

export interface CopilotMessage {
  id: string;
  role: "user" | "assistant";
  /** The question, or Genie's answer in Markdown. */
  text: string;
  /** Genie's step while this answer is on its way (for example EXECUTING_QUERY); null once it is done. */
  status: string | null;
  queries: CopilotQuery[];
  /** Follow-up questions Genie suggests. */
  suggestions: string[];
  error: string | null;
}

export interface UseCopilotOptions {
  /** A saved chat to open and continue. Read once: to open another chat, mount the hook again (CopilotPage keys the chat). */
  conversationId?: string;
  /** Called once Genie gives a chat started here its ID. */
  onConversationStart?: (conversationId: string) => void;
}

export interface UseCopilotResult {
  messages: CopilotMessage[];
  /** The step of the answer on its way, in plain words ("Thinking", "Running the query"); null when nothing is on its way. */
  status: string | null;
  streaming: boolean;
  /** Replaying a saved chat. */
  loading: boolean;
  /** The newest failure: of the answer, or of loading the saved chat. */
  error: string | null;
  /** Why the saved chat could not be loaded, when it could not. */
  loadError: string | null;
  conversationId: string | null;
  /** IDs of the answers whose rows are being fetched again. */
  loadingRows: string[];
  /** IDs of the answers whose last rows Retry failed; cleared when the next Retry starts. */
  rowsFailed: string[];
  send(text: string): Promise<void>;
  /** Asks the failed question again, or loads the saved chat again. */
  retry(): Promise<void>;
  /** Fetches the rows of one finished answer again, without asking the question again. */
  retryRows(messageId: string): Promise<void>;
}

const STATUS_LABELS = new Map([
  ["SUBMITTED", "Sending the question"],
  ["FETCHING_METADATA", "Reading the tables"],
  ["FILTERING_CONTEXT", "Thinking"],
  ["ASKING_AI", "Thinking"],
  ["PENDING_WAREHOUSE", "Starting the SQL warehouse"],
  ["EXECUTING_QUERY", "Running the query"],
  // The answer is in; the rows of its query are still on their way.
  ["COMPLETED", "Loading the results"],
]);

/** A Genie message status in plain words. */
export function statusLabel(status: string): string {
  return STATUS_LABELS.get(status) ?? "Working";
}

/** Genie is done with a message in one of these states. */
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "QUERY_RESULT_EXPIRED"]);

class CopilotRequestError extends Error {}

const NETWORK_ERROR = "The app server did not answer. Check your connection, then try again.";
const UNFINISHED = "The answer did not finish. Try again.";

/**
 * Genie passes some API errors on as the SDK's text, with the API's JSON body
 * after a prefix ("Response from server (Not Found) {...}"). Keep the body's
 * message; any other text stays as it is.
 */
export function readableError(text: string): string {
  const start = text.indexOf("{");
  if (start !== -1) {
    try {
      const body: unknown = JSON.parse(text.slice(start));
      if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" && body.message) return body.message;
    } catch {
      // Not a JSON body.
    }
  }
  return text;
}

function messageOf(error: unknown): string {
  if (error instanceof CopilotRequestError) return error.message;
  if (error instanceof TypeError) return NETWORK_ERROR;
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

let localCount = 0;
function localId(): string {
  localCount += 1;
  return `local-${localCount}`;
}

function requestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${localId()}`;
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null) {
      if ("message" in body && typeof body.message === "string" && body.message) return body.message;
      if ("error" in body && typeof body.error === "string" && body.error) return body.error;
    }
  } catch {
    // Not JSON: fall through to the status.
  }
  return `The copilot request failed with HTTP ${response.status}.`;
}

/** Calls one of the genie plugin's SSE routes and hands each checked event to onEvent. */
async function streamGenie(path: string, init: { method: "GET" | "POST"; body?: string }, signal: AbortSignal, onEvent: (event: GenieEvent) => void) {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (init.body) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { method: init.method, body: init.body, headers, signal, credentials: "same-origin" });
  if (!response.ok) throw new CopilotRequestError(await errorText(response));
  if (!response.body) throw new CopilotRequestError(UNFINISHED);
  await readSse(response.body, (sse) => {
    const event = parseGenieEvent(sse);
    if (event && !signal.aborted) onEvent(event);
  });
}

function failureOf(message: GenieMessage): string | null {
  if (message.status === "FAILED") return message.error ? `Genie could not answer: ${readableError(message.error)}` : "Genie could not answer this question.";
  if (message.status === "CANCELLED") return "The question was cancelled.";
  return null;
}

/** Genie's answer: the text attachments, the queries and the suggested questions. */
function answerFrom(message: GenieMessage, status: string | null): CopilotMessage {
  const attachments = message.attachments ?? [];
  const queries: CopilotQuery[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const sql = attachment.query?.query;
    if (!sql) continue;
    queries.push({
      id: attachment.attachmentId ?? `${message.messageId}-query-${index}`,
      title: attachment.query?.title ?? null,
      description: attachment.query?.description ?? null,
      sql,
      result: null,
    });
  }
  const written = attachments
    .map((a) => a.text?.content?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
  // An answer that is only a query reads as the query's description.
  const described = queries
    .map((q) => q.description?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
  return {
    id: message.messageId,
    role: "assistant",
    text: written || described,
    status,
    queries,
    suggestions: attachments.flatMap((a) => a.suggestedQuestions ?? []),
    error: failureOf(message),
  };
}

/** The newest item that matches, searching from the end. */
function lastWhere<T>(items: readonly T[], match: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i])) return items[i];
  return undefined;
}

function userMessage(id: string, text: string): CopilotMessage {
  return { id, role: "user", text, status: null, queries: [], suggestions: [], error: null };
}

interface ChatState {
  conversationId: string | null;
  messages: CopilotMessage[];
  streaming: boolean;
  loading: boolean;
  loadError: string | null;
  error: string | null;
  /** Answers whose rows are being fetched again. */
  loadingRows: string[];
  /** Answers whose last rows Retry failed. */
  rowsFailed: string[];
}

type Action =
  | { type: "load-message"; message: GenieMessage }
  | { type: "load-done" }
  | { type: "load-failed"; error: string }
  | { type: "load-again" }
  | { type: "send"; question: CopilotMessage; pending: CopilotMessage; dropFailed: boolean }
  | { type: "follow"; id: string }
  | { type: "started"; id: string; conversationId: string; messageId: string }
  | { type: "status"; id: string; status: string }
  | { type: "answer"; id: string; message: GenieMessage }
  | { type: "rows"; attachmentId: string; rows: QueryRows }
  | { type: "rows-start"; id: string }
  | { type: "rows-end"; id: string }
  | { type: "rows-failed"; id: string }
  | { type: "failed"; id: string; error: string }
  | { type: "done"; id: string };

function update(messages: CopilotMessage[], id: string, change: (m: CopilotMessage) => CopilotMessage): CopilotMessage[] {
  return messages.map((m) => (m.id === id && m.role === "assistant" ? change(m) : m));
}

/** Drops the newest question and its answer when that answer failed, so Retry replaces them. */
function withoutFailedExchange(messages: CopilotMessage[]): CopilotMessage[] {
  const last = messages.at(-1);
  const before = messages.at(-2);
  if (last?.role === "assistant" && last.error && before?.role === "user") return messages.slice(0, -2);
  return messages;
}

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "load-message": {
      const { message } = action;
      const status = TERMINAL.has(message.status ?? "COMPLETED") ? null : (message.status ?? null);
      return {
        ...state,
        messages: [...state.messages, userMessage(`${message.messageId}-question`, message.content ?? ""), answerFrom(message, status)],
      };
    }
    case "load-done":
      return { ...state, loading: false };
    case "load-failed":
      return { ...state, loading: false, loadError: action.error, error: action.error };
    case "load-again":
      return { ...state, messages: [], loading: true, loadError: null, error: null };
    case "send":
      return {
        ...state,
        messages: [...(action.dropFailed ? withoutFailedExchange(state.messages) : state.messages), action.question, action.pending],
        streaming: true,
        error: null,
      };
    case "follow":
      return { ...state, streaming: true };
    case "started":
      return {
        ...state,
        conversationId: state.conversationId ?? action.conversationId,
        messages: update(state.messages, action.id, (m) => ({ ...m, id: action.messageId })),
      };
    case "status":
      return { ...state, messages: update(state.messages, action.id, (m) => ({ ...m, status: action.status })) };
    case "answer": {
      const answer = answerFrom(action.message, null);
      const failure = answer.error;
      return {
        ...state,
        error: failure ?? state.error,
        // While its rows load, the answer stays in progress ("Loading the results").
        messages: update(state.messages, action.id, () => ({ ...answer, status: failure ? null : "COMPLETED" })),
      };
    }
    case "rows":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.queries.some((q) => q.id === action.attachmentId)
            ? { ...m, queries: m.queries.map((q) => (q.id === action.attachmentId ? { ...q, result: action.rows } : q)) }
            : m,
        ),
      };
    case "rows-start":
      return {
        ...state,
        loadingRows: state.loadingRows.includes(action.id) ? state.loadingRows : [...state.loadingRows, action.id],
        rowsFailed: state.rowsFailed.filter((id) => id !== action.id),
      };
    case "rows-failed":
      return { ...state, rowsFailed: state.rowsFailed.includes(action.id) ? state.rowsFailed : [...state.rowsFailed, action.id] };
    case "rows-end":
      return { ...state, loadingRows: state.loadingRows.filter((id) => id !== action.id) };
    case "failed":
      return {
        ...state,
        streaming: false,
        error: action.error,
        messages: update(state.messages, action.id, (m) => ({ ...m, status: null, error: action.error })),
      };
    case "done":
      return { ...state, streaming: false, messages: update(state.messages, action.id, (m) => ({ ...m, status: null })) };
  }
}

function initialState(conversationId: string | null): ChatState {
  return { conversationId, messages: [], streaming: false, loading: conversationId !== null, loadError: null, error: null, loadingRows: [], rowsFailed: [] };
}

const encode = encodeURIComponent;

export function useCopilot(options: UseCopilotOptions = {}): UseCopilotResult {
  const [openedId] = useState(options.conversationId ?? null);
  const [state, dispatch] = useReducer(reducer, openedId, initialState);
  const [loadRound, setLoadRound] = useState(0);

  const stateRef = useRef(state);
  const conversationRef = useRef(openedId);
  const runRef = useRef<AbortController | null>(null);
  const rowRunsRef = useRef(new Set<AbortController>());
  const onStartRef = useRef(options.onConversationStart);
  useEffect(() => {
    stateRef.current = state;
    onStartRef.current = options.onConversationStart;
  });
  useEffect(() => {
    const rowRuns = rowRunsRef.current;
    return () => {
      runRef.current?.abort();
      for (const run of rowRuns) run.abort();
    };
  }, []);

  /**
   * Streams events about one Genie message into the chat. `id` is the chat's
   * ID for that answer; message_start replaces a local ID with Genie's.
   * Returns whether the answer came, and the first error before it.
   */
  const handlerFor = useCallback((initialId: string) => {
    const track = { id: initialId, messageId: null as string | null, answered: false, error: null as string | null };
    const onEvent = (event: GenieEvent) => {
      switch (event.type) {
        case "message_start":
          dispatch({ type: "started", id: track.id, conversationId: event.conversationId, messageId: event.messageId });
          track.id = event.messageId;
          track.messageId = event.messageId;
          if (conversationRef.current === null) {
            conversationRef.current = event.conversationId;
            onStartRef.current?.(event.conversationId);
          }
          break;
        case "status":
          dispatch({ type: "status", id: track.id, status: event.status });
          break;
        case "message_result":
          track.answered = true;
          dispatch({ type: "answer", id: track.id, message: event.message });
          break;
        case "query_result":
          dispatch({ type: "rows", attachmentId: event.attachmentId, rows: toQueryRows(event.data) });
          break;
        case "error":
          // After the answer, an error is about one query's rows: the answer stays, without them.
          if (!track.answered) track.error ??= readableError(event.error);
          break;
        case "history_info":
          break;
      }
    };
    return { track, onEvent };
  }, []);

  /** Follows a message Genie is still working on to its end, through the plugin's message route. */
  const follow = useCallback(async (conversationId: string, messageId: string, signal: AbortSignal, onEvent: (event: GenieEvent) => void) => {
    await streamGenie(`${GENIE_BASE}/conversations/${encode(conversationId)}/messages/${encode(messageId)}?requestId=${requestId()}`, { method: "GET" }, signal, onEvent);
  }, []);

  const ask = useCallback(
    async (text: string, dropFailed: boolean) => {
      const question = text.trim();
      if (!question || runRef.current) return;
      const controller = new AbortController();
      runRef.current = controller;
      const { track, onEvent } = handlerFor(localId());
      dispatch({ type: "send", question: userMessage(localId(), question), pending: { ...userMessage(track.id, ""), role: "assistant", status: "ASKING_AI" }, dropFailed });
      const conversationId = conversationRef.current;
      try {
        const body = JSON.stringify(conversationId ? { content: question, conversationId } : { content: question });
        await streamGenie(`${GENIE_BASE}/messages?requestId=${requestId()}`, { method: "POST", body }, controller.signal, onEvent);
        if (!track.answered && track.messageId && conversationRef.current) {
          // The stream stopped before the answer (a proxy or polling time limit), but Genie may still finish it.
          try {
            await follow(conversationRef.current, track.messageId, controller.signal, onEvent);
          } catch (error) {
            if (controller.signal.aborted) return;
            track.error ??= messageOf(error);
          }
        }
        if (controller.signal.aborted) return;
        if (track.answered) dispatch({ type: "done", id: track.id });
        else dispatch({ type: "failed", id: track.id, error: track.error ?? UNFINISHED });
      } catch (error) {
        if (!controller.signal.aborted) dispatch({ type: "failed", id: track.id, error: track.error ?? messageOf(error) });
      } finally {
        if (runRef.current === controller) runRef.current = null;
      }
    },
    [follow, handlerFor],
  );

  // Replays a saved chat, then follows an answer that was still on its way.
  useEffect(() => {
    if (openedId === null) return;
    const controller = new AbortController();
    void (async () => {
      let loaded = 0;
      let failure: string | null = null;
      const replayed: { newest: GenieMessage | null } = { newest: null };
      try {
        await streamGenie(
          `${GENIE_BASE}/conversations/${encode(openedId)}?requestId=${requestId()}`,
          { method: "GET" },
          controller.signal,
          (event) => {
            if (event.type === "message_result") {
              loaded += 1;
              replayed.newest = event.message;
              dispatch({ type: "load-message", message: event.message });
            } else if (event.type === "query_result") {
              dispatch({ type: "rows", attachmentId: event.attachmentId, rows: toQueryRows(event.data) });
            } else if (event.type === "error" && loaded === 0) {
              failure ??= readableError(event.error);
            }
          },
        );
        if (controller.signal.aborted) return;
        if (failure !== null) {
          dispatch({ type: "load-failed", error: failure });
          return;
        }
        dispatch({ type: "load-done" });
        const pending = replayed.newest;
        if (pending === null || TERMINAL.has(pending.status ?? "COMPLETED") || runRef.current) return;
        runRef.current = controller;
        const { track, onEvent } = handlerFor(pending.messageId);
        dispatch({ type: "follow", id: track.id });
        try {
          await follow(openedId, pending.messageId, controller.signal, onEvent);
          if (controller.signal.aborted) return;
          if (track.answered) dispatch({ type: "done", id: track.id });
          else dispatch({ type: "failed", id: track.id, error: track.error ?? UNFINISHED });
        } catch (error) {
          if (!controller.signal.aborted) dispatch({ type: "failed", id: track.id, error: track.error ?? messageOf(error) });
        } finally {
          if (runRef.current === controller) runRef.current = null;
        }
      } catch (error) {
        if (!controller.signal.aborted) dispatch({ type: "load-failed", error: messageOf(error) });
      }
    })();
    return () => controller.abort();
  }, [openedId, loadRound, follow, handlerFor]);

  const send = useCallback((text: string) => ask(text, false), [ask]);

  /** The message route sends a finished answer again with its rows; only the rows are kept. */
  const retryRows = useCallback(
    async (messageId: string) => {
      const conversationId = conversationRef.current;
      if (conversationId === null || stateRef.current.loadingRows.includes(messageId)) return;
      const controller = new AbortController();
      rowRunsRef.current.add(controller);
      dispatch({ type: "rows-start", id: messageId });
      try {
        let gotRows = false;
        await follow(conversationId, messageId, controller.signal, (event) => {
          if (event.type !== "query_result") return;
          gotRows = true;
          dispatch({ type: "rows", attachmentId: event.attachmentId, rows: toQueryRows(event.data) });
        });
        // Genie reports a failed fetch as an error event, which ends the stream without throwing.
        if (!gotRows && !controller.signal.aborted) dispatch({ type: "rows-failed", id: messageId });
      } catch {
        // The rows stay missing and the Retry button stays; say that this Retry failed.
        if (!controller.signal.aborted) dispatch({ type: "rows-failed", id: messageId });
      } finally {
        rowRunsRef.current.delete(controller);
        if (!controller.signal.aborted) dispatch({ type: "rows-end", id: messageId });
      }
    },
    [follow],
  );

  const retry = useCallback(async () => {
    const current = stateRef.current;
    if (current.loadError !== null) {
      dispatch({ type: "load-again" });
      setLoadRound((n) => n + 1);
      return;
    }
    const question = lastWhere(current.messages, (m) => m.role === "user");
    if (question) await ask(question.text, true);
  }, [ask]);

  const inProgress = state.streaming ? lastWhere(state.messages, (m) => m.role === "assistant" && m.status !== null) : undefined;
  return {
    messages: state.messages,
    status: inProgress?.status ? statusLabel(inProgress.status) : null,
    streaming: state.streaming,
    loading: state.loading,
    error: state.error,
    loadError: state.loadError,
    conversationId: state.conversationId,
    loadingRows: state.loadingRows,
    rowsFailed: state.rowsFailed,
    send,
    retry,
    retryRows,
  };
}
