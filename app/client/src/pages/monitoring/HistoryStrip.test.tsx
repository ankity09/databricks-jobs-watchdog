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

function history(job_name: string, workspace_id: string | null, job_id: string | null, scan_id: string, observed_at: string, status: string) {
  return { job_name, workspace_id, job_id, scan_id, observed_at, status };
}

/** Three scans. The second one did not see inventory_snapshot; other_job is not one of the jobs shown. */
const HISTORY = [
  history("orders_ingest", "1001", "11", "s1", "2026-11-05T07:05:00Z", "HEALTHY"),
  history("inventory_snapshot", null, null, "s1", "2026-11-05T07:05:20Z", "UNKNOWN"),
  history("orders_ingest", "1001", "11", "s2", "2026-11-05T08:05:00Z", "WARNING"),
  history("orders_ingest", "1001", "11", "s3", "2026-11-05T09:05:00Z", "FAILED"),
  history("inventory_snapshot", null, null, "s3", "2026-11-05T09:05:30Z", "UNKNOWN"),
  history("other_job", "1001", "99", "s3", "2026-11-05T09:05:40Z", "FAILED"),
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

  it("draws one cell per scan, oldest first, colored by status, with the time and status on hover", async () => {
    setClock("2026-11-05T10:10:00Z");
    mockApi({ queries: { job_history: HISTORY } });
    const user = userEvent.setup();
    renderStrip();

    const orders = cellsOf(await lineOf("orders_ingest"));
    expect(orders.map((cell) => cell.dataset.status)).toEqual(["HEALTHY", "WARNING", "FAILED"]);
    expect(orders[0]).toHaveClass("bg-success");
    expect(orders[1]).toHaveClass("bg-warning");
    expect(orders[2]).toHaveClass("bg-destructive");

    // The scans line up across jobs: inventory_snapshot has no cell for the scan that missed it.
    const inventory = await lineOf("inventory_snapshot");
    expect(cellsOf(inventory).map((cell) => cell.dataset.status)).toEqual(["UNKNOWN", "UNKNOWN"]);
    expect(cellsOf(inventory)[0]).toHaveClass("bg-muted-foreground/50");
    expect(inventory.querySelectorAll('[data-slot="history-gap"]')).toHaveLength(1);
    expect(screen.queryByText("other_job")).toBeNull();

    const failed = orders[2];
    if (!failed) throw new Error("No third cell");
    await user.hover(failed);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("2026-11-05 09:05 UTC");
    expect(tooltip).toHaveTextContent("Failed");
    await user.unhover(failed);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("gives each line a text summary for screen readers", async () => {
    setClock("2026-11-05T11:10:00Z");
    mockApi({ queries: { job_history: HISTORY } });
    renderStrip();
    const orders = await lineOf("orders_ingest");
    expect(orders).toHaveTextContent("3 scans: 1 failed, 1 warning, 1 healthy. Newest: Failed at 2026-11-05 09:05 UTC.");
  });

  it("asks for 3 days first, and switches to 7 days and 24 h", async () => {
    setClock("2026-11-05T12:10:00Z");
    const api = mockApi({ queries: { job_history: HISTORY } });
    const user = userEvent.setup();
    renderStrip();
    await waitFor(() => expect(api.callsTo("job_history").at(-1)?.params.hours).toBe("72"));
    expect(screen.getByRole("radio", { name: "3 days" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "7 days" }));
    await waitFor(() => expect(api.callsTo("job_history").at(-1)?.params.hours).toBe("168"));
    expect(screen.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "24 h" }));
    await waitFor(() => expect(api.callsTo("job_history").at(-1)?.params.hours).toBe("24"));
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
