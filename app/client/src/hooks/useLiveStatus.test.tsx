// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LiveStatus, useLiveStatus } from "./useLiveStatus";
import { RefreshProvider, useRefreshKey } from "./useRefreshKey";

const CONFIG = { catalog: "main", schema: "watchdog", region: "us-east-2", appName: "watchdog-app", lakebaseProject: "jobs-watchdog" };

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * fetch answers /api/app-config at once, and holds every query until the test
 * answers it, so the test sees each render while the query is loading.
 */
function mockApi() {
  const waiting: Array<(event: unknown) => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (urlOf(input).startsWith("/api/app-config")) {
        return Promise.resolve(new Response(JSON.stringify(CONFIG), { headers: { "Content-Type": "application/json" } }));
      }
      return new Promise<Response>((resolve) => {
        waiting.push((event) => {
          resolve(new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
        });
      });
    }),
  );
  const send = async (event: unknown) => {
    await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
    await act(async () => {
      waiting.shift()?.(event);
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the answer stream in
    });
  };
  return {
    answer: (rows: unknown[]) => send({ type: "result", data: rows }),
    /** The query fails as AppKit sends a failed statement: a generic message and the warehouse's code. */
    fail: (error: string, errorCode: string) => send({ type: "error", error, errorCode }),
  };
}

/** Each test gets its own clock, so its refresh key (the minute) is its own in AppKit's query store. */
function setClock(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

describe("useLiveStatus", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports loading, never an empty result, until the first query answers", async () => {
    setClock("2026-11-05T10:30:00Z");
    const api = mockApi();
    const renders: LiveStatus[] = [];
    const { result } = renderHook(
      () => {
        const live = useLiveStatus();
        renders.push(live);
        return live;
      },
      { wrapper: RefreshProvider },
    );
    await api.answer([{ job_name: "orders_ingest", status: "FAILED" }]);
    await waitFor(() => expect(result.current.byJob.get("orders_ingest")).toBe("FAILED"));
    expect(result.current.loading).toBe(false);
    const beforeData = renders.slice(0, renders.findIndex((r) => r.byJob.size > 0));
    expect(beforeData.length).toBeGreaterThan(0);
    expect(beforeData.filter((r) => !r.loading && r.problem === null)).toEqual([]);
  });

  it("drops a row of an unexpected shape and keeps the others", async () => {
    setClock("2026-11-05T12:30:00Z");
    const api = mockApi();
    const { result } = renderHook(() => useLiveStatus(), { wrapper: RefreshProvider });
    await api.answer([
      { job_name: "orders_ingest", status: "FAILED" },
      { job_name: null, status: "WARNING" },
    ]);
    await waitFor(() => expect(result.current.byJob.get("orders_ingest")).toBe("FAILED"));
    expect(result.current.byJob.size).toBe(1);
    expect(result.current.problem).toBeNull();
  });

  it("names the problem and where the tables are when the query fails, as Monitoring does", async () => {
    setClock("2026-11-05T13:30:00Z");
    const api = mockApi();
    const { result } = renderHook(() => useLiveStatus(), { wrapper: RefreshProvider });
    await api.fail("Query execution failed", "BAD_REQUEST");
    await waitFor(() => expect(result.current.problem).toEqual({ kind: "query", message: "Query execution failed", code: "BAD_REQUEST" }));
    expect(result.current.location).toBe("main.watchdog");
    expect(result.current.loading).toBe(false);
  });

  it("keeps the previous statuses while a refresh loads", async () => {
    setClock("2026-11-05T11:30:00Z");
    const api = mockApi();
    const { result } = renderHook(() => ({ live: useLiveStatus(), key: useRefreshKey() }), { wrapper: RefreshProvider });
    await api.answer([{ job_name: "orders_ingest", status: "FAILED" }]);
    await waitFor(() => expect(result.current.live.byJob.get("orders_ingest")).toBe("FAILED"));

    act(() => result.current.key.bump());
    expect(result.current.live.loading).toBe(true);
    expect(result.current.live.byJob.get("orders_ingest")).toBe("FAILED");

    await api.answer([{ job_name: "orders_ingest", status: "HEALTHY" }]);
    await waitFor(() => expect(result.current.live.byJob.get("orders_ingest")).toBe("HEALTHY"));
    expect(result.current.live.loading).toBe(false);
  });
});
