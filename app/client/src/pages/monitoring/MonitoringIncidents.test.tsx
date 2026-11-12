// @vitest-environment jsdom
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { installRadixPolyfills, mockApi, setClock } from "../../test/mockApi";
import { checkRow, INCIDENT_ROWS, incidentRow, ORDERS_INGEST_CHECKS, STATUS_ROWS } from "../../test/monitoringFixtures";
import { MonitoringPage } from "./MonitoringPage";

function renderPage() {
  const router = createMemoryRouter([{ path: "/monitoring", element: <MonitoringPage /> }, { path: "/copilot", element: <p>Copilot page</p> }], { initialEntries: ["/monitoring"] });
  render(
    <RefreshProvider>
      <TooltipProvider delayDuration={0}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </RefreshProvider>,
  );
}

function table(): HTMLElement {
  return screen.getByRole("table", { name: "Monitored jobs" });
}

function order(): string[] {
  return within(table())
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? "");
}

function rowOf(label: string): HTMLElement {
  const row = screen.getByRole("button", { name: label }).closest("tr");
  if (!row) throw new Error("Not inside a table row");
  return row;
}

const MISSING = { error: "Query execution failed", errorCode: "BAD_REQUEST" };

describe("Monitoring with the incidents view", () => {
  beforeAll(installRadixPolyfills);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("marks only the jobs with a new open incident as New", async () => {
    setClock("2026-11-06T10:10:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS, job_incidents: INCIDENT_ROWS } });
    renderPage();
    await screen.findByRole("table", { name: "Monitored jobs" });
    await waitFor(() => expect(within(rowOf("orders_ingest in example-stage")).getByText("New")).toBeInTheDocument());
    expect(within(rowOf("archive_cleanup in example-stage")).getByText("New")).toBeInTheDocument();
    expect(within(rowOf("orders_ingest in example-prod")).queryByText("New")).toBeNull();
    expect(within(rowOf("billing_export in example-prod")).queryByText("New")).toBeNull();
    expect(within(table()).getAllByText("New")).toHaveLength(2);
  });

  it("does not call a job new for a resolved incident that opened in the newest scan", async () => {
    setClock("2026-11-06T10:11:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS, job_incidents: [incidentRow({ state: "RESOLVED", is_new: "true", resolved_at: "2026-11-05T10:20:00.000Z", current_status: "HEALTHY" })] } });
    renderPage();
    await screen.findByRole("table", { name: "Monitored jobs" });
    await screen.findByRole("button", { name: /^New this scan/ });
    expect(within(table()).queryByText("New")).toBeNull();
  });

  it("shows the oldest open incident's start and its scans under a failing job's status", async () => {
    setClock("2026-11-06T10:12:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS, job_incidents: INCIDENT_ROWS } });
    renderPage();
    await screen.findByRole("table", { name: "Monitored jobs" });
    expect(await within(rowOf("orders_ingest in example-prod")).findByText("Open since 2026-11-03 08:05 UTC, 12 scans")).toBeInTheDocument();
    expect(within(rowOf("orders_ingest in example-stage")).getByText("Open since 2026-11-05 10:00 UTC, 1 scan")).toBeInTheDocument();
    expect(within(rowOf("billing_export in example-prod")).getByText("Open since 2026-11-04 10:00 UTC, 36 scans")).toBeInTheDocument();
    // A job with no open incident has no line.
    expect(within(rowOf("customer_sync in example-stage")).queryByText(/Open since/)).toBeNull();
    expect(within(rowOf("daily_revenue_report in example-prod")).queryByText(/Open since/)).toBeNull();
  });

  it("counts the jobs with a new open incident in New this scan, and filters to them when clicked", async () => {
    setClock("2026-11-06T10:13:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS, job_incidents: INCIDENT_ROWS } });
    const user = userEvent.setup();
    renderPage();
    const tile = await screen.findByRole("button", { name: /^New this scan/ });
    await waitFor(() => expect(tile).toHaveTextContent("2"));
    expect(tile).toHaveAttribute("aria-pressed", "false");
    // The status counts do not change.
    expect(screen.getByRole("button", { name: /^Failed/ })).toHaveTextContent("4");
    expect(screen.getByRole("button", { name: /^Healthy/ })).toHaveTextContent("2");

    await user.click(tile);
    expect(tile).toHaveAttribute("aria-pressed", "true");
    expect(order()).toEqual(["archive_cleanup in example-stage", "orders_ingest in example-stage"]);
    expect(screen.getByText(/Showing/)).toHaveTextContent("Showing 2 of 8 jobs");
    expect(screen.getByRole("button", { name: /^Failed/ })).toHaveTextContent("2");

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(tile).toHaveAttribute("aria-pressed", "false");
    expect(order()).toHaveLength(8);
  });

  it("lists the job's open problems and what cleared in the last 24 hours in the panel", async () => {
    setClock("2026-11-06T10:14:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS, job_incidents: INCIDENT_ROWS, job_checks: ORDERS_INGEST_CHECKS } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "orders_ingest in example-prod" }));
    const panel = await screen.findByRole("dialog", { name: "orders_ingest" });

    const open = await within(panel).findByRole("region", { name: "Open problems" });
    const items = within(open).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    // Oldest first.
    expect(items[0]).toHaveTextContent("last_run_result");
    expect(items[0]).toHaveTextContent("Open since 2026-11-03 08:05 UTC");
    expect(items[0]).toHaveTextContent("12 scans");
    expect(items[0]).toHaveTextContent("Failed");
    expect(items[0]).toHaveTextContent("Newest finished run ended FAILED.");
    expect(within(items[0]).getByRole("link", { name: /Run/ })).toHaveAttribute("href", "https://workspace.example.com/jobs/21/runs/600");
    expect(items[1]).toHaveTextContent("task_failures");
    expect(items[1]).toHaveTextContent("5 scans");

    // The prod workspace's job has nothing cleared. The stage one's incident cleared at 09:25.
    const cleared = within(panel).getByRole("region", { name: "Cleared in the last 24 hours" });
    expect(cleared).toHaveTextContent("Nothing cleared in the last 24 hours.");
  });

  it("lists a cleared problem with when it cleared, and says when there is no open problem", async () => {
    setClock("2026-11-06T10:15:00Z");
    mockApi({
      queries: {
        job_status: STATUS_ROWS,
        job_incidents: INCIDENT_ROWS.filter((row) => row.job_id === "21" && row.state === "RESOLVED"),
        job_checks: [checkRow({})],
      },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "orders_ingest in example-stage" }));
    const panel = await screen.findByRole("dialog", { name: "orders_ingest" });
    const cleared = await within(panel).findByRole("region", { name: "Cleared in the last 24 hours" });
    await waitFor(() => expect(cleared).toHaveTextContent("last_run_result"));
    expect(cleared).toHaveTextContent("Cleared 2026-11-05 09:25 UTC");
    expect(within(panel).getByRole("region", { name: "Open problems" })).toHaveTextContent("No open problems for this job.");
  });

  it("shows skeletons in the panel while the incidents load", async () => {
    setClock("2026-11-06T10:16:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS, job_incidents: "hold", job_checks: ORDERS_INGEST_CHECKS } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "orders_ingest in example-prod" }));
    const panel = await screen.findByRole("dialog", { name: "orders_ingest" });
    const open = within(panel).getByRole("region", { name: "Open problems" });
    expect(open.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(open).not.toHaveTextContent("No open problems");
  });
});

describe("Monitoring when the incidents view is missing", () => {
  beforeAll(installRadixPolyfills);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("still shows the page, with one line where the new parts would be", async () => {
    setClock("2026-11-06T11:10:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS, job_incidents: MISSING } });
    renderPage();
    await screen.findByRole("table", { name: "Monitored jobs" });
    const line = await screen.findByText(/incidents view isn't there yet/);
    expect(line).toHaveTextContent("Notebook 01");
    expect(line).toHaveTextContent("next scheduled scan");
    expect(screen.getAllByText(/incidents view isn't there yet/)).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /^New this scan/ })).toBeNull();
    expect(within(table()).queryByText("New")).toBeNull();
    expect(within(table()).queryByText(/Open since/)).toBeNull();
    expect(screen.getByRole("button", { name: /^Failed/ })).toHaveTextContent("4");
    expect(order()).toHaveLength(8);
  });

  it("says the same in the panel, in place of the two lists", async () => {
    setClock("2026-11-06T11:11:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS, job_incidents: MISSING, job_checks: ORDERS_INGEST_CHECKS } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "orders_ingest in example-prod" }));
    const panel = await screen.findByRole("dialog", { name: "orders_ingest" });
    await within(panel).findByText(/incidents view isn't there yet/);
    expect(within(panel).queryByRole("region", { name: "Open problems" })).toBeNull();
    expect(within(panel).queryByRole("region", { name: "Cleared in the last 24 hours" })).toBeNull();
    expect(await within(panel).findByRole("heading", { name: "last_run_result" })).toBeInTheDocument();
  });
});
