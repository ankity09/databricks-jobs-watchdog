// @vitest-environment jsdom
import { SidebarProvider } from "@databricks/appkit-ui/react";
import { render, screen } from "@testing-library/react";
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

  it("says so when there are no scans yet", async () => {
    setClock("2026-11-05T11:30:00Z");
    mockApi([]);
    renderScanStatus();
    expect(await screen.findByText("No scans yet")).toBeInTheDocument();
  });
});
