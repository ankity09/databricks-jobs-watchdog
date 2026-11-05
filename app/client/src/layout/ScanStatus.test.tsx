// @vitest-environment jsdom
import { SidebarProvider } from "@databricks/appkit-ui/react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefreshProvider } from "../hooks/useRefreshKey";
import { ScanStatus } from "./ScanStatus";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** /api/app-config, and scan_freshness answering over SSE with `rows`. */
function mockApi(rows: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.startsWith("/api/app-config")) {
        const config = { catalog: "main", schema: "watchdog", region: "us-east-2", appName: "watchdog-app", lakebaseProject: "jobs-watchdog" };
        return Promise.resolve(new Response(JSON.stringify(config), { headers: { "Content-Type": "application/json" } }));
      }
      const event = `data: ${JSON.stringify({ type: "result", data: rows })}\n\n`;
      return Promise.resolve(new Response(event, { headers: { "Content-Type": "text/event-stream" } }));
    }),
  );
}

function renderScanStatus() {
  render(
    <RefreshProvider>
      <SidebarProvider>
        <ScanStatus />
      </SidebarProvider>
    </RefreshProvider>,
  );
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/**
 * Each test gets its own clock, so the refresh key (the current minute) differs
 * and AppKit's query store does not hand one test the other's rows.
 */
function setClock(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

describe("ScanStatus (placeholder)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the newest scan over every source", async () => {
    setClock("2026-11-05T10:30:00Z");
    mockApi([
      { source: "system_tables", last_observed_at: minutesAgo(95), scan_id: "101" },
      { source: "jobs_api", last_observed_at: minutesAgo(12), scan_id: "102" },
    ]);
    renderScanStatus();
    expect(await screen.findByText("Last scan 12 min ago")).toBeInTheDocument();
  });

  it("never says there are no scans while the query is still loading", async () => {
    setClock("2026-11-05T12:30:00Z");
    let answer: ((rows: unknown[]) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (urlOf(input).startsWith("/api/app-config")) {
          const config = { catalog: "main", schema: "watchdog", region: "us-east-2", appName: "watchdog-app", lakebaseProject: "jobs-watchdog" };
          return Promise.resolve(new Response(JSON.stringify(config), { headers: { "Content-Type": "application/json" } }));
        }
        return new Promise<Response>((resolve) => {
          answer = (rows) => {
            const event = `data: ${JSON.stringify({ type: "result", data: rows })}\n\n`;
            resolve(new Response(event, { headers: { "Content-Type": "text/event-stream" } }));
          };
        });
      }),
    );
    // Every text that was ever on the page, including texts that showed for a single render: the
    // observer runs later, so a text that came and went is read from the removed nodes and old values.
    const shown: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") shown.push(record.oldValue ?? "", record.target.textContent ?? "");
        for (const node of [...record.addedNodes, ...record.removedNodes]) shown.push(node.textContent ?? "");
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
    renderScanStatus();
    await waitFor(() => expect(answer).not.toBeNull());
    await act(async () => {
      answer?.([{ source: "jobs_api", last_observed_at: minutesAgo(5), scan_id: "7" }]);
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the answer stream in
    });
    expect(await screen.findByText("Last scan 5 min ago")).toBeInTheDocument();
    observer.disconnect();
    expect(shown.filter((text) => text.includes("No scans yet"))).toEqual([]);
  });

  it("says so when there are no scans yet", async () => {
    setClock("2026-11-05T11:30:00Z");
    mockApi([]);
    renderScanStatus();
    expect(await screen.findByText("No scans yet")).toBeInTheDocument();
  });
});
