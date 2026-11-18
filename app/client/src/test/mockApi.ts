import { vi } from "vitest";
import { z } from "zod";
import type { AppConfig } from "../../../shared/joblist/types";
import { appConfigRequest, type WatchdogConfig } from "../hooks/useAppConfig";

/**
 * A fetch mock for the app's routes in client tests: /api/app-config, the
 * analytics queries (answered over SSE, as AppKit does) and any other route.
 * Every analytics request is recorded with its key and parameter values.
 */

export const TEST_CONFIG: AppConfig = { catalog: "main", schema: "watchdog", region: "us-east-2", appName: "watchdog-app", lakebaseProject: "jobs-watchdog" };

/** What a query answers: rows, an error event (as AppKit sends it), or nothing yet (held until `release`). */
export type QueryAnswer = unknown[] | { error: string; errorCode?: string } | "hold";

export interface QueryCall {
  key: string;
  /** Parameter values by name, as the strings the SQL markers carry. */
  params: Record<string, string>;
}

export interface MockApiOptions {
  /** Answers by query key; a function gets the call's parameters. A key with no answer gets no rows. */
  queries?: Record<string, QueryAnswer | ((params: Record<string, string>) => QueryAnswer)>;
  /** Other routes. Return undefined to fall through to a 404. */
  routes?: (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
  config?: WatchdogConfig;
  /** Answers /api/app-config in place of the config, such as an error. Called on every request. */
  configResponse?: () => Response | undefined;
}

export interface MockApi {
  calls: QueryCall[];
  /** Calls to one query, in order. */
  callsTo(key: string): QueryCall[];
  /** Answers every held request to `key` with `answer`. */
  release(key: string, answer: Exclude<QueryAnswer, "hold">): void;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sse(answer: Exclude<QueryAnswer, "hold">): Response {
  const event = Array.isArray(answer) ? { type: "result", data: answer } : { error: answer.error, code: "UPSTREAM_ERROR", ...(answer.errorCode ? { errorCode: answer.errorCode } : {}) };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

/** The body useAnalyticsQuery posts: SQL markers by parameter name, each with its value as text. */
const QueryBody = z.object({ parameters: z.record(z.string(), z.object({ value: z.string() })) });

function paramsOf(body: BodyInit | null | undefined): Record<string, string> {
  if (typeof body !== "string") return {};
  const parsed = QueryBody.safeParse(JSON.parse(body));
  if (!parsed.success) return {};
  return Object.fromEntries(Object.entries(parsed.data.parameters).map(([name, marker]) => [name, marker.value]));
}

export function mockApi(options: MockApiOptions = {}): MockApi {
  // The app config is fetched once per page and cached; each test mocks its own, so start it over.
  appConfigRequest.reset();
  const calls: QueryCall[] = [];
  const held = new Map<string, Array<(answer: Exclude<QueryAnswer, "hold">) => void>>();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.startsWith("/api/app-config")) return Promise.resolve(options.configResponse?.() ?? json(options.config ?? TEST_CONFIG));
      const query = /^\/api\/analytics\/query\/([^/?]+)/.exec(url);
      if (query?.[1]) {
        const key = decodeURIComponent(query[1]);
        const params = paramsOf(init?.body);
        calls.push({ key, params });
        const configured = options.queries?.[key];
        const answer = typeof configured === "function" ? configured(params) : (configured ?? []);
        if (answer === "hold") {
          return new Promise<Response>((resolve) => {
            const waiting = held.get(key) ?? [];
            waiting.push((value) => resolve(sse(value)));
            held.set(key, waiting);
          });
        }
        return Promise.resolve(sse(answer));
      }
      const routed = options.routes?.(url, init);
      if (routed) return Promise.resolve(routed);
      return Promise.resolve(json({ error: "not_found", message: `No route for ${url}` }, 404));
    }),
  );
  return {
    calls,
    callsTo: (key) => calls.filter((call) => call.key === key),
    release(key, answer) {
      const waiting = held.get(key) ?? [];
      held.delete(key);
      for (const resolve of waiting) resolve(answer);
    },
  };
}

/**
 * Each test gets its own clock, so the refresh key (the current minute) is its
 * own, and AppKit's query store, which lives for the whole test file, does not
 * hand one test another test's rows.
 */
export function setClock(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

/** A ResizeObserver that never reports: Radix's popper (tooltips, selects) measures with one, and jsdom has none. */
class StillResizeObserver implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const ELEMENT_STUBS = {
  hasPointerCapture: () => false,
  releasePointerCapture: () => undefined,
  setPointerCapture: () => undefined,
  scrollIntoView: () => undefined,
};

/** jsdom lacks the pointer-capture, scroll and resize calls that Radix Select and Tooltip make. */
export function installRadixPolyfills(): void {
  const proto = window.HTMLElement.prototype;
  for (const [name, value] of Object.entries(ELEMENT_STUBS)) {
    if (!(name in proto)) Object.defineProperty(proto, name, { value, configurable: true, writable: true });
  }
  if (!("ResizeObserver" in window)) Object.defineProperty(window, "ResizeObserver", { value: StillResizeObserver, configurable: true, writable: true });
}
