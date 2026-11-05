import { vi } from "vitest";
import { z } from "zod";

/** What a mocked analytics query answers: rows, or an SSE error event as AppKit sends it. */
export type QueryAnswer = { rows: unknown[] } | { error: string; errorCode?: string };

/** One call to a mocked analytics query: its key and its parameter values. */
export interface QueryCall {
  key: string;
  params: Record<string, string>;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** An analytics request body: `{ parameters: { name: { __sql_type, value } } }`. */
const AnalyticsBody = z.object({ parameters: z.record(z.string(), z.looseObject({ value: z.union([z.string(), z.number(), z.boolean()]) })) });

/** The parameter values of an analytics request body, as strings. */
function paramsOf(body: unknown): Record<string, string> {
  if (typeof body !== "string") return {};
  const parsed = AnalyticsBody.safeParse(JSON.parse(body));
  if (!parsed.success) return {};
  return Object.fromEntries(Object.entries(parsed.data.parameters).map(([name, marker]) => [name, String(marker.value)]));
}

export type OtherRoute = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | null;

/**
 * Stubs fetch: analytics queries answer through `answer(key, params)` over SSE,
 * the way AppKit streams them, and `other` handles the app's own routes. Every
 * analytics call is recorded in `calls`.
 */
export function mockFetch(answer: (call: QueryCall) => QueryAnswer, other?: OtherRoute) {
  const calls: QueryCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const match = /^\/api\/analytics\/query\/([^/?]+)/.exec(url);
    if (match) {
      const call = { key: decodeURIComponent(match[1]), params: paramsOf(init?.body) };
      calls.push(call);
      const result = answer(call);
      const event = "rows" in result ? { type: "result", data: result.rows } : { type: "error", code: "EXECUTION_ERROR", ...result };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    const handled = other ? await other(url, init) : null;
    return handled ?? json({ error: "not_found", message: `No route for ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

export { json };
