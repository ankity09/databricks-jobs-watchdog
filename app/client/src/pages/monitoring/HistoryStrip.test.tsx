// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { mockApi, setClock } from "../../test/mockApi";
import { HistoryStrip, type HistoryJob } from "./HistoryStrip";

const JOBS: HistoryJob[] = [
  { job_name: "orders_ingest", workspace_id: "1001", job_id: "11", workspace_name: "example-prod" },
  { job_name: "inventory_snapshot", workspace_id: null, job_id: null, workspace_name: null },
];

/** One row of job_history: a job's worst status in the window that starts at `window`, over `scans` scans. */
function history(job_name: string, workspace_id: string | null, job_id: string | null, window: string, status: string, scans = 3) {
  return { job_name, workspace_id, job_id, observed_at: window, status, scans: String(scans) };
}

/** Windows of 2 hours (the 3 days view). Clock: 10:10, so the newest window starts at 10:00 and the view starts 3 days before. The 08:00 window did not see inventory_snapshot; other_job is not shown. */
const HISTORY = [
  history("orders_ingest", "1001", "11", "2026-11-05T06:00:00.000Z", "HEALTHY"),
  history("inventory_snapshot", null, null, "2026-11-05T06:00:00.000Z", "UNKNOWN"),
  history("orders_ingest", "1001", "11", "2026-11-05T08:00:00.000Z", "WARNING", 6),
  history("orders_ingest", "1001", "11", "2026-11-05T10:00:00.000Z", "FAILED", 1),
  history("inventory_snapshot", null, null, "2026-11-05T10:00:00.000Z", "UNKNOWN", 1),
  history("other_job", "1001", "99", "2026-11-05T10:00:00.000Z", "FAILED"),
  // Before the first window of the view: not drawn.
  history("orders_ingest", "1001", "11", "2026-11-02T08:00:00.000Z", "FAILED"),
];

function renderStrip(jobs: HistoryJob[] = JOBS) {
  render(
    <RefreshProvider>
      <HistoryStrip jobs={jobs} />
    </RefreshProvider>,
  );
}

/** The strip's line for one job. */
async function lineOf(label: string): Promise<HTMLElement> {
  const list = await screen.findByRole("list", { name: "Scan history by job" });
  const line = within(list)
    .getAllByRole("listitem")
    .find((item) => within(item).queryByText(label) !== null);
  if (!line) throw new Error(`No history line for ${label}`);
  return line;
}

function cellsOf(line: HTMLElement): HTMLElement[] {
  return Array.from(line.querySelectorAll<HTMLElement>('[data-slot="history-cell"]'));
}

describe("the history strip", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("draws one column per fixed window, colored by the window's worst status, and leaves gaps where a job had no scan", async () => {
    setClock("2026-11-05T10:10:00Z");
    mockApi({ queries: { job_history: HISTORY } });
    const user = userEvent.setup();
    renderStrip();

    const ordersLine = await lineOf("orders_ingest");
    const orders = cellsOf(ordersLine);
    expect(orders.map((cell) => cell.dataset.status)).toEqual(["HEALTHY", "WARNING", "FAILED"]);
    expect(orders[0]).toHaveClass("bg-success");
    expect(orders[1]).toHaveClass("bg-warning");
    expect(orders[2]).toHaveClass("bg-destructive");
    // 3 days in 2-hour windows: 37 columns, whatever the scan schedule. The rest are gaps.
    expect(ordersLine.querySelectorAll('[data-slot="history-gap"]')).toHaveLength(37 - 3);

    const inventory = await lineOf("inventory_snapshot");
    expect(cellsOf(inventory).map((cell) => cell.dataset.status)).toEqual(["UNKNOWN", "UNKNOWN"]);
    expect(cellsOf(inventory)[0]).toHaveClass("bg-muted-foreground/50");
    expect(inventory.querySelectorAll('[data-slot="history-gap"]')).toHaveLength(37 - 2);
    expect(screen.queryByText("other_job")).toBeNull();

    const failed = orders[2];
    if (!failed) throw new Error("No third cell");
    await user.hover(failed);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("2026-11-05 10:00 UTC");
    expect(tooltip).toHaveTextContent("Failed");
    expect(tooltip).toHaveTextContent("1 scan in this 2-hour window");
    await user.unhover(failed);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    await user.hover(orders[1] ?? failed);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("6 scans in this 2-hour window");
  });

  it("gives each line a text summary for screen readers", async () => {
    setClock("2026-11-05T11:10:00Z");
    mockApi({ queries: { job_history: HISTORY } });
    renderStrip();
    const orders = await lineOf("orders_ingest");
    // At 11:10 the newest window starts at 10:00 and the view starts 3 days earlier.
    expect(orders).toHaveTextContent("3 windows with scans: 1 failed, 1 warning, 1 healthy. Newest: Failed in the window from 2026-11-05 10:00 UTC.");
  });

  it("asks for 3 days first (2-hour windows), and switches to 7 days (4 hours) and 24 h (1 hour)", async () => {
    setClock("2026-11-05T12:10:00Z");
    const api = mockApi({ queries: { job_history: HISTORY } });
    const user = userEvent.setup();
    renderStrip();
    await waitFor(() => expect(api.callsTo("job_history").at(-1)?.params).toMatchObject({ hours: "72", bucket_minutes: "120" }));
    expect(screen.getByRole("radio", { name: "3 days" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "7 days" }));
    await waitFor(() => expect(api.callsTo("job_history").at(-1)?.params).toMatchObject({ hours: "168", bucket_minutes: "240" }));
    expect(screen.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "24 h" }));
    await waitFor(() => expect(api.callsTo("job_history").at(-1)?.params).toMatchObject({ hours: "24", bucket_minutes: "60" }));
  });

  it.each([
    ["24 h", 25],
    ["3 days", 37],
    ["7 days", 43],
  ])("draws %s with %i columns per job, so the strip stays readable at any scan schedule", async (label, columns) => {
    setClock(`2026-11-05T13:${label === "24 h" ? "11" : label === "3 days" ? "12" : "13"}:00Z`);
    mockApi({ queries: { job_history: [history("orders_ingest", "1001", "11", "2026-11-05T12:00:00.000Z", "HEALTHY")] } });
    const user = userEvent.setup();
    renderStrip(JOBS.slice(0, 1));
    await lineOf("orders_ingest");
    await user.click(screen.getByRole("radio", { name: label }));
    await waitFor(async () => {
      const line = await lineOf("orders_ingest");
      expect(line.querySelectorAll('[data-slot="history-cell"], [data-slot="history-gap"]')).toHaveLength(columns);
    });
  });

  it("shows an error with Retry, which runs the query again", async () => {
    setClock("2026-11-05T13:10:00Z");
    let fail = true;
    const api = mockApi({ queries: { job_history: () => (fail ? { error: "Query execution failed", errorCode: "BAD_REQUEST" } : HISTORY) } });
    const user = userEvent.setup();
    renderStrip();
    expect(await screen.findByText("Could not load the scan history")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(cellsOf(await lineOf("orders_ingest"))).toHaveLength(3);
    const refreshes = api.callsTo("job_history").map((call) => Number(call.params.refresh));
    expect(refreshes.at(-1)).toBeGreaterThan(refreshes[0] ?? 0);
  });

  it("says so when the jobs have no scans in the range", async () => {
    setClock("2026-11-05T14:10:00Z");
    mockApi({ queries: { job_history: [] } });
    renderStrip();
    expect(await screen.findByText("No scans in the last 3 days.")).toBeInTheDocument();
  });
});
