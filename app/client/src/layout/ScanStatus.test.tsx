// @vitest-environment jsdom
import { SidebarProvider, TooltipProvider } from "@databricks/appkit-ui/react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RefreshProvider, useRefreshKey } from "../hooks/useRefreshKey";
import { installRadixPolyfills, json, type MockApiOptions, mockApi, setClock } from "../test/mockApi";
import { ScanStatus } from "./ScanStatus";

/** A button that calls bump(), as any page's Refresh does. */
function BumpButton() {
  const { bump } = useRefreshKey();
  return (
    <button type="button" onClick={bump}>
      Refresh everything
    </button>
  );
}

function renderScanStatus({ open = true }: { open?: boolean } = {}) {
  render(
    <RefreshProvider>
      <TooltipProvider delayDuration={0}>
        <SidebarProvider defaultOpen={open}>
          <ScanStatus />
          <BumpButton />
        </SidebarProvider>
      </TooltipProvider>
    </RefreshProvider>,
  );
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

function freshness(minutes: number) {
  return [{ source: "JOBS_API", last_observed_at: minutesAgo(minutes), scan_id: "102" }];
}

const RUN_URL = "https://workspace.example.com/jobs/1/runs/77";

/** A run as server/scan/routes.ts sends it. */
function scanRun(runId: number, lifeCycle: string, resultState: string | null = null) {
  return {
    run_id: runId,
    life_cycle_state: lifeCycle,
    result_state: resultState,
    trigger: "ONE_TIME",
    start_time: "2026-11-05T05:20:00.000Z",
    end_time: null,
    run_page_url: `https://workspace.example.com/jobs/1/runs/${runId}`,
  };
}

const OTHER_RUN = scanRun(55, "RUNNING");

function run(lifeCycle: string, resultState?: string) {
  return json({ run: scanRun(77, lifeCycle, resultState ?? null) });
}

/** Scan now's routes: no scan running, a start that gives run 77, and polls that walk through `polls`. */
function jobsRoutes(polls: Array<() => Response>): MockApiOptions["routes"] {
  let poll = 0;
  return (url, init) => {
    if (url === "/api/scan/latest-run") return json({ run: null });
    if (url === "/api/jobs/default/run" && init?.method === "POST") return json({ runId: 77 });
    if (url === "/api/scan/runs/77") {
      const answer = polls[Math.min(poll, polls.length - 1)];
      poll += 1;
      return answer?.();
    }
    return undefined;
  };
}

/** Fake timers that still move with real time, so Testing Library's waits work while polls are skipped ahead. */
function scanClock(iso: string) {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(iso));
}

async function skip(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function liveRegion(): HTMLElement {
  return screen.getByRole("status");
}

describe("ScanStatus", () => {
  beforeAll(installRadixPolyfills);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the newest scan over every source", async () => {
    setClock("2026-11-05T10:30:00Z");
    mockApi({
      queries: {
        scan_freshness: [
          { source: "SYSTEM_TABLES", last_observed_at: minutesAgo(95), scan_id: "101" },
          { source: "JOBS_API", last_observed_at: minutesAgo(12), scan_id: "102" },
        ],
      },
    });
    renderScanStatus();
    expect(await screen.findByText("Last scan 12 min ago")).toBeInTheDocument();
  });

  it("never says there are no scans while the query is still loading", async () => {
    setClock("2026-11-05T12:30:00Z");
    const api = mockApi({ queries: { scan_freshness: "hold" } });
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
    await waitFor(() => expect(api.callsTo("scan_freshness")).toHaveLength(1));
    await act(async () => {
      api.release("scan_freshness", freshness(5));
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the answer stream in
    });
    expect(await screen.findByText("Last scan 5 min ago")).toBeInTheDocument();
    observer.disconnect();
    expect(shown.filter((text) => text.includes("No scans yet"))).toEqual([]);
  });

  it("says so when there are no scans yet", async () => {
    setClock("2026-11-05T11:30:00Z");
    mockApi({ queries: { scan_freshness: [] } });
    renderScanStatus();
    expect(await screen.findByText("No scans yet")).toBeInTheDocument();
  });

  it("shows a green dot for a scan under 2 hours old, and an amber one after", async () => {
    setClock("2026-11-05T13:30:00Z");
    let minutes = 119;
    mockApi({ queries: { scan_freshness: () => freshness(minutes) } });
    const user = userEvent.setup();
    renderScanStatus();
    await screen.findByText("Last scan 1 h ago");
    expect(document.querySelector('[data-slot="live-dot"]')).toHaveAttribute("data-fresh", "true");
    minutes = 121;
    await user.click(screen.getByRole("button", { name: "Refresh everything" }));
    await screen.findByText("Last scan 2 h ago");
    expect(document.querySelector('[data-slot="live-dot"]')).toHaveAttribute("data-fresh", "false");
  });

  it("starts a scan: Running with a link to the run, then Done, and every query refreshes", async () => {
    scanClock("2026-11-05T14:30:00Z");
    // Read before the first render: with a clock that moves, a time taken later would look younger.
    const scanned = freshness(20);
    const api = mockApi({
      queries: { scan_freshness: scanned },
      routes: jobsRoutes([() => run("RUNNING"), () => run("TERMINATED", "SUCCESS")]),
    });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    renderScanStatus();
    await screen.findByText("Last scan 20 min ago");
    const before = api.callsTo("scan_freshness").length;

    await user.click(screen.getByRole("button", { name: "Scan now" }));
    expect(await screen.findByRole("button", { name: "Running" })).toHaveAttribute("aria-disabled", "true");
    expect(liveRegion()).toHaveTextContent("Scan started.");

    await skip(5_000);
    expect(await screen.findByRole("link", { name: /View run/ })).toHaveAttribute("href", RUN_URL);

    await skip(5_000);
    expect(await screen.findByText("Done: Succeeded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan now" })).not.toHaveAttribute("aria-disabled", "true");
    expect(liveRegion()).toHaveTextContent("Scan done: Succeeded.");
    await waitFor(() => expect(api.callsTo("scan_freshness").length).toBeGreaterThan(before));
    const refreshes = api.callsTo("scan_freshness").map((call) => Number(call.params.refresh));
    expect(refreshes.at(-1)).toBeGreaterThan(refreshes[0] ?? 0);
  });

  it.each([
    ["SUCCESS", "Done: Succeeded.", "muted"],
    ["FAILED", "Done: Failed.", "failed"],
    ["TIMEDOUT", "Done: Timed out.", "failed"],
    ["SUCCESS_WITH_FAILURES", "Done: Succeeded with failures.", "warning"],
    ["CANCELED", "Done: Canceled.", "warning"],
  ])("shows a scan that ended %s in its status tone", async (result, text, tone) => {
    scanClock("2026-11-05T14:40:00Z");
    const scanned = freshness(20);
    mockApi({ queries: { scan_freshness: scanned }, routes: jobsRoutes([() => run("TERMINATED", result)]) });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    renderScanStatus();
    await screen.findByText("Last scan 20 min ago");
    await user.click(screen.getByRole("button", { name: "Scan now" }));
    await skip(5_000);
    const line = (await screen.findByText(text)).closest("p");
    expect(line).toHaveAttribute("data-tone", tone);
    expect(line).toHaveClass({ muted: "text-muted-foreground", failed: "text-destructive", warning: "text-warning" }[tone] ?? "");
  });

  it("shows Starting while it checks for a running scan", async () => {
    setClock("2026-11-05T15:30:00Z");
    const neverAnswers = new Promise<Response>(() => undefined);
    mockApi({ queries: { scan_freshness: freshness(20) }, routes: (url) => (url === "/api/scan/latest-run" ? neverAnswers : undefined) });
    const user = userEvent.setup();
    renderScanStatus();
    await screen.findByText("Last scan 20 min ago");
    await user.click(screen.getByRole("button", { name: "Scan now" }));
    expect(await screen.findByRole("button", { name: "Starting" })).toHaveAttribute("aria-disabled", "true");
  });

  it("says a scan is already running, links to it, and starts no other", async () => {
    setClock("2026-11-05T16:30:00Z");
    const posts: string[] = [];
    mockApi({
      queries: { scan_freshness: freshness(20) },
      routes: (url, init) => {
        if (init?.method === "POST") posts.push(url);
        if (url === "/api/scan/latest-run") return json({ run: OTHER_RUN });
        return undefined;
      },
    });
    const user = userEvent.setup();
    renderScanStatus();
    await screen.findByText("Last scan 20 min ago");
    await user.click(screen.getByRole("button", { name: "Scan now" }));
    expect(await screen.findByText("A scan is already running.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View run/ })).toHaveAttribute("href", OTHER_RUN.run_page_url);
    expect(liveRegion()).toHaveTextContent("A scan is already running.");
    expect(posts).toEqual([]);
  });

  it("shows why Scan now failed next to the button, and can try again", async () => {
    setClock("2026-11-05T17:30:00Z");
    let posts = 0;
    mockApi({
      queries: { scan_freshness: freshness(20) },
      routes: (url, init) => {
        if (url === "/api/scan/latest-run") return json({ run: null });
        if (url === "/api/jobs/default/run" && init?.method === "POST") {
          posts += 1;
          return json({ error: "Forbidden", plugin: "jobs" }, 403);
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    renderScanStatus();
    await screen.findByText("Last scan 20 min ago");
    await user.click(screen.getByRole("button", { name: "Scan now" }));
    expect(await screen.findByText("Could not start the scan: Forbidden")).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent("Could not start the scan: Forbidden");
    await user.click(screen.getByRole("button", { name: "Scan now" }));
    await waitFor(() => expect(posts).toBe(2));
  });

  it("announces a new scan and Scan now changes, but not the minutes going by", async () => {
    scanClock("2026-11-05T18:30:00Z");
    // Read before the first render: with a clock that moves, a time taken later would look younger.
    let scanned = freshness(12);
    mockApi({ queries: { scan_freshness: () => scanned } });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    renderScanStatus();
    await screen.findByText("Last scan 12 min ago");
    expect(liveRegion()).toHaveTextContent("");

    await skip(60_000);
    expect(await screen.findByText("Last scan 13 min ago")).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent("");

    scanned = freshness(0);
    await user.click(screen.getByRole("button", { name: "Refresh everything" }));
    await screen.findByText("Last scan just now");
    expect(liveRegion()).toHaveTextContent(/^New scan results from 2026-11-05 18:3\d UTC\.$/);
  });

  it("has Retry when the last scan is unknown, and Retry asks again", async () => {
    setClock("2026-11-05T19:30:00Z");
    let fail = true;
    const api = mockApi({ queries: { scan_freshness: () => (fail ? { error: "Query execution failed", errorCode: "BAD_REQUEST" } : freshness(3)) } });
    const user = userEvent.setup();
    renderScanStatus();
    expect(await screen.findByText("Last scan unknown")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Last scan 3 min ago")).toBeInTheDocument();
    expect(api.callsTo("scan_freshness").length).toBeGreaterThan(1);
  });

  describe("collapsed", () => {
    it("shows the dot as an image named by the last scan, and Scan now as a labeled icon button", async () => {
      setClock("2026-11-05T20:30:00Z");
      mockApi({ queries: { scan_freshness: freshness(12) } });
      renderScanStatus({ open: false });
      const dot = await screen.findByRole("img", { name: /^Last scan/ });
      await waitFor(() => expect(dot).toHaveAccessibleName("Last scan 2026-11-05 20:18 UTC, 12 min ago"));
      expect(screen.getByRole("button", { name: "Scan now" })).toBeInTheDocument();
      expect(screen.queryByText("Last scan 12 min ago")).toBeNull();
    });

    it("lets a keyboard reach the dot, whose tooltip says when the last scan ran", async () => {
      setClock("2026-11-05T20:40:00Z");
      mockApi({ queries: { scan_freshness: freshness(12) } });
      const user = userEvent.setup();
      renderScanStatus({ open: false });
      const dot = await screen.findByRole("img", { name: /^Last scan/ });
      await user.tab();
      expect(dot).toHaveFocus();
      expect(await screen.findByRole("tooltip")).toHaveTextContent("Last scan 2026-11-05 20:28 UTC, 12 min ago");
      await user.tab();
      expect(screen.getByRole("button", { name: "Scan now" })).toHaveFocus();
    });

    it("has Retry when the last scan is unknown", async () => {
      setClock("2026-11-05T21:30:00Z");
      let fail = true;
      const api = mockApi({ queries: { scan_freshness: () => (fail ? { error: "Query execution failed", errorCode: "BAD_REQUEST" } : freshness(3)) } });
      const user = userEvent.setup();
      renderScanStatus({ open: false });
      const retry = await screen.findByRole("button", { name: "Retry loading the last scan" });
      fail = false;
      await user.click(retry);
      expect(await screen.findByRole("img", { name: /3 min ago/ })).toBeInTheDocument();
      expect(api.callsTo("scan_freshness").length).toBeGreaterThan(1);
    });

    it("puts the scan state in the Scan now button's name", async () => {
      setClock("2026-11-05T22:30:00Z");
      mockApi({
        queries: { scan_freshness: freshness(12) },
        routes: (url) => (url === "/api/scan/latest-run" ? json({ run: OTHER_RUN }) : undefined),
      });
      const user = userEvent.setup();
      renderScanStatus({ open: false });
      await user.click(await screen.findByRole("button", { name: "Scan now" }));
      const button = await screen.findByRole("button", { name: "Scan now. A scan is already running." });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(liveRegion()).toHaveTextContent("A scan is already running.");
    });
  });
});
