// @vitest-environment jsdom
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { installRadixPolyfills, mockApi, setClock } from "../../test/mockApi";
import { STATUS_ROWS } from "../../test/monitoringFixtures";
import { MonitoringPage } from "./MonitoringPage";

function renderPage() {
  const router = createMemoryRouter([{ path: "/monitoring", element: <MonitoringPage /> }], { initialEntries: ["/monitoring"] });
  render(
    <RefreshProvider>
      <TooltipProvider delayDuration={0}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </RefreshProvider>,
  );
}

function skeletons(): number {
  return document.querySelectorAll('[data-slot="skeleton"]').length;
}

describe("the Monitoring page", () => {
  beforeAll(installRadixPolyfills);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("says there are no scans yet, and what to do, when the scans found nothing", async () => {
    setClock("2026-11-05T10:10:00Z");
    mockApi({ queries: { job_status: [] } });
    renderPage();
    expect(await screen.findByText("No scans yet")).toBeInTheDocument();
    expect(screen.getByText("Click Scan now, or wait for the next scheduled scan.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(skeletons()).toBe(0);
    expect(screen.getByRole("heading", { level: 1, name: "Monitoring" })).toBeInTheDocument();
  });

  it("shows skeletons, never the empty state, until the first answer", async () => {
    setClock("2026-11-05T11:10:00Z");
    const api = mockApi({ queries: { job_status: "hold" } });
    renderPage();
    await waitFor(() => expect(api.callsTo("job_status")).toHaveLength(1));
    expect(skeletons()).toBeGreaterThan(0);
    expect(screen.queryByText("No scans yet")).toBeNull();
    await act(async () => {
      api.release("job_status", STATUS_ROWS);
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the answer stream in
    });
    expect(await screen.findByRole("table", { name: "Monitored jobs" })).toBeInTheDocument();
  });

  it.each([
    ["PERMISSION_DENIED: User does not have SELECT on Table 'main.watchdog.findings_latest'.", ["main.watchdog", "SELECT"], "12:11"],
    ["[INSUFFICIENT_PERMISSIONS] Insufficient privileges: User does not have USE SCHEMA on Schema 'main.watchdog'.", ["main.watchdog", "USE SCHEMA", "SELECT"], "12:12"],
    ["[TABLE_OR_VIEW_NOT_FOUND] The table or view `main`.`watchdog`.`findings_latest` cannot be found.", ["main.watchdog", "Scan now"], "12:13"],
  ])("names the schema and what to ask for when the query fails with %s", async (error, phrases, minute) => {
    setClock(`2026-11-05T${minute}:00Z`);
    mockApi({ queries: { job_status: { error } } });
    renderPage();
    const alert = await screen.findByRole("alert");
    for (const phrase of phrases) expect(alert).toHaveTextContent(phrase);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("explains AppKit's generic query failure with both next steps", async () => {
    setClock("2026-11-05T13:10:00Z");
    mockApi({ queries: { job_status: { error: "Query execution failed", errorCode: "BAD_REQUEST" } } });
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not read the Watchdog tables");
    expect(alert).toHaveTextContent("main.watchdog");
    expect(alert).toHaveTextContent("Scan now");
    expect(alert).toHaveTextContent("SELECT");
  });

  it("runs the query again with a new refresh key when Retry is clicked", async () => {
    setClock("2026-11-05T14:10:00Z");
    let fail = true;
    const api = mockApi({ queries: { job_status: () => (fail ? { error: "Query execution failed", errorCode: "BAD_REQUEST" } : STATUS_ROWS) } });
    const user = userEvent.setup();
    renderPage();
    const alert = await screen.findByRole("alert");
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("table", { name: "Monitored jobs" })).toBeInTheDocument();
    const [first, last] = [api.callsTo("job_status")[0], api.callsTo("job_status").at(-1)];
    expect(Number(last?.params.refresh)).toBeGreaterThan(Number(first?.params.refresh));
  });

  it("keeps the rows, and says so, when a refresh fails", async () => {
    setClock("2026-11-05T15:10:00Z");
    let fail = false;
    mockApi({ queries: { job_status: () => (fail ? { error: "Query execution failed", errorCode: "BAD_REQUEST" } : STATUS_ROWS) } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table", { name: "Monitored jobs" });
    fail = true;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not refresh");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Monitored jobs" })).toBeInTheDocument();
  });

  it("says how many rows had an unexpected shape", async () => {
    setClock("2026-11-05T16:10:00Z");
    mockApi({ queries: { job_status: [...STATUS_ROWS, { job_name: "odd_job", status: "BROKEN" }] } });
    renderPage();
    await screen.findByRole("table", { name: "Monitored jobs" });
    expect(screen.getByText("1 row had an unexpected shape and is not shown.")).toBeInTheDocument();
  });

  it("treats an answer where every row is malformed as an error, not as no scans", async () => {
    setClock("2026-11-05T17:10:00Z");
    mockApi({ queries: { job_status: [{ job_name: "odd_job", status: "BROKEN" }] } });
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("unexpected shape");
    expect(screen.queryByText("No scans yet")).toBeNull();
  });
});
