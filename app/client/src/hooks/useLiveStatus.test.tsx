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
  const waiting: Array<(rows: unknown[]) => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (urlOf(input).startsWith("/api/app-config")) {
        return Promise.resolve(new Response(JSON.stringify(CONFIG), { headers: { "Content-Type": "application/json" } }));
      }
      return new Promise<Response>((resolve) => {
        waiting.push((rows) => {
          const event = `data: ${JSON.stringify({ type: "result", data: rows })}\n\n`;
          resolve(new Response(event, { headers: { "Content-Type": "text/event-stream" } }));
        });
      });
    }),
  );
  return {
    async answer(rows: unknown[]) {
      await waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      await act(async () => {
        waiting.shift()?.(rows);
        await new Promise((resolve) => setTimeout(resolve, 0)); // let the answer stream in
      });
    },
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
    expect(beforeData.filter((r) => !r.loading && r.error === null)).toEqual([]);
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
