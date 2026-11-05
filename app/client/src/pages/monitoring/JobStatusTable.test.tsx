// @vitest-environment jsdom
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { installRadixPolyfills, mockApi, setClock } from "../../test/mockApi";
import { checkRow, ORDERS_INGEST_CHECKS, STATUS_ROWS } from "../../test/monitoringFixtures";
import { MonitoringPage } from "./MonitoringPage";

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: "/monitoring", element: <MonitoringPage /> },
      { path: "/copilot", element: <p>Copilot page</p> },
    ],
    { initialEntries: ["/monitoring"] },
  );
  render(
    <RefreshProvider>
      <TooltipProvider delayDuration={0}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </RefreshProvider>,
  );
  return router;
}

function table(): HTMLElement {
  return screen.getByRole("table", { name: "Monitored jobs" });
}

/** The jobs in the table, top to bottom, by the name of each row's job button ("<job> in <workspace>"). */
function order(): string[] {
  return within(table())
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? "");
}

function rowOf(element: HTMLElement): HTMLElement {
  const row = element.closest("tr");
  if (!row) throw new Error("Not inside a table row");
  return row;
}

async function choose(user: ReturnType<typeof userEvent.setup>, filter: string, option: string) {
  await user.click(screen.getByRole("combobox", { name: filter }));
  await user.click(await screen.findByRole("option", { name: option }));
}

const ALL = [
  "billing_export in example-prod",
  "orders_ingest in example-prod",
  "archive_cleanup in example-stage",
  "orders_ingest in example-stage",
  "daily_revenue_report in example-prod",
  "inventory_snapshot, not found in any workspace",
  "audit_rollup in example-prod",
  "customer_sync in example-stage",
];

describe("the job status table", () => {
  beforeAll(installRadixPolyfills);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("puts the worst status first, then the higher severity, then sorts by name", async () => {
    setClock("2026-11-05T10:10:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS } });
    renderPage();
    await screen.findByRole("table", { name: "Monitored jobs" });
    expect(order()).toEqual(ALL);
  });

  it("filters to the failed jobs when the Failed count is clicked, and back when it is clicked again", async () => {
    setClock("2026-11-05T11:10:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS } });
    const user = userEvent.setup();
    renderPage();
    const failed = await screen.findByRole("button", { name: /^Failed/ });
    expect(failed).toHaveTextContent("4");
    expect(screen.getByRole("button", { name: /^Warning/ })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: /^Unknown/ })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: /^Healthy/ })).toHaveTextContent("2");
    expect(failed).toHaveAttribute("aria-pressed", "false");

    await user.click(failed);
    expect(failed).toHaveAttribute("aria-pressed", "true");
    expect(order()).toEqual(["billing_export in example-prod", "orders_ingest in example-prod", "archive_cleanup in example-stage", "orders_ingest in example-stage"]);
    expect(screen.getByText(/Showing/)).toHaveTextContent("Showing 4 of 8 jobs");

    await user.click(failed);
    expect(failed).toHaveAttribute("aria-pressed", "false");
    expect(order()).toEqual(ALL);
  });

  it("combines the environment, owner, severity and workspace filters, and counts within them", async () => {
    setClock("2026-11-05T12:10:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table", { name: "Monitored jobs" });

    await choose(user, "Environment", "production");
    expect(order()).toEqual(["billing_export in example-prod", "orders_ingest in example-prod", "daily_revenue_report in example-prod", "audit_rollup in example-prod"]);
    expect(screen.getByRole("button", { name: /^Failed/ })).toHaveTextContent("2");

    await choose(user, "Owner", "finance-data");
    expect(order()).toEqual(["billing_export in example-prod", "daily_revenue_report in example-prod"]);

    await choose(user, "Severity", "Critical");
    expect(order()).toEqual(["billing_export in example-prod"]);

    await choose(user, "Workspace", "example-stage");
    expect(screen.getByText("No jobs match these filters.")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Monitored jobs" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(order()).toEqual(ALL);
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("filters to the jobs where a check fails, from a list of the checks that fail, and counts within it", async () => {
    setClock("2026-11-05T12:20:00Z");
    let rows = STATUS_ROWS;
    mockApi({ queries: { job_status: () => rows } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table", { name: "Monitored jobs" });
    expect(screen.getByRole("combobox", { name: "Failing check" })).toHaveTextContent("Any check");

    await user.click(screen.getByRole("combobox", { name: "Failing check" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Any check",
      "last_run_result",
      "long_runtime",
      "not_found",
      "schedule_gap",
      "task_failures",
    ]);
    await user.click(screen.getByRole("option", { name: "task_failures" }));
    expect(order()).toEqual(["orders_ingest in example-prod", "orders_ingest in example-stage"]);
    expect(screen.getByRole("combobox", { name: "Failing check" })).toHaveTextContent("Failing check: task_failures");
    expect(screen.getByRole("button", { name: /^Failed/ })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: /^Warning/ })).toHaveTextContent("0");
    expect(screen.getByRole("button", { name: /^Healthy/ })).toHaveTextContent("0");

    // After a scan where that check passes everywhere, the filter still says what it is, so it can be cleared.
    rows = STATUS_ROWS.map((row) => ({ ...row, failing_checks: String(row.failing_checks).replace(/,?"task_failures"/, "").replace('[,', "[") }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("No jobs match these filters.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Failing check" })).toHaveTextContent("Failing check: task_failures");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("combobox", { name: "Failing check" })).toHaveTextContent("Any check");
  });

  it("filters by when the job last ran, and counts within it", async () => {
    setClock("2026-11-05T12:30:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS } });
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("table", { name: "Monitored jobs" });
    expect(screen.getByRole("combobox", { name: "Last run" })).toHaveTextContent("Any last run");

    await choose(user, "Last run", "More than 24 hours ago");
    expect(order()).toEqual(["audit_rollup in example-prod"]);
    expect(screen.getByRole("combobox", { name: "Last run" })).toHaveTextContent("Last run over 24 hours ago");
    expect(screen.getByRole("button", { name: /^Healthy/ })).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: /^Failed/ })).toHaveTextContent("0");

    await choose(user, "Last run", "No run");
    expect(order()).toEqual(["inventory_snapshot, not found in any workspace"]);
    expect(screen.getByRole("button", { name: /^Unknown/ })).toHaveTextContent("1");

    await choose(user, "Last run", "In the last 24 hours");
    expect(order()).toEqual(ALL.filter((job) => job !== "audit_rollup in example-prod" && !job.startsWith("inventory_snapshot")));
    expect(screen.getByRole("button", { name: /^Failed/ })).toHaveTextContent("4");
    expect(screen.getByRole("button", { name: /^Healthy/ })).toHaveTextContent("1");
    expect(screen.getByText(/Showing/)).toHaveTextContent("Showing 6 of 8 jobs");

    // With the Failed count chosen too, both filters apply.
    await user.click(screen.getByRole("button", { name: /^Failed/ }));
    expect(order()).toEqual(["billing_export in example-prod", "orders_ingest in example-prod", "archive_cleanup in example-stage", "orders_ingest in example-stage"]);
  });

  it("shows a job the scan could not find as Unknown, with its reason", async () => {
    setClock("2026-11-05T13:10:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS } });
    renderPage();
    const row = rowOf(await screen.findByRole("button", { name: "inventory_snapshot, not found in any workspace" }));
    expect(within(row).getByText("Unknown")).toBeInTheDocument();
    expect(within(row).getByText("No job named inventory_snapshot was found in any workspace.")).toBeInTheDocument();
    expect(within(row).getByText("Not found")).toBeInTheDocument();
  });

  it("opens the detail panel for that job, workspace and job ID when a row is clicked", async () => {
    setClock("2026-11-05T14:10:00Z");
    const api = mockApi({ queries: { job_status: STATUS_ROWS, job_checks: ORDERS_INGEST_CHECKS } });
    const user = userEvent.setup();
    renderPage();
    const row = rowOf(await screen.findByRole("button", { name: "orders_ingest in example-stage" }));
    expect(row).not.toHaveAttribute("data-state", "selected");
    await user.click(within(row).getByText("load: ValueError: bad input in stage"));

    const panel = await screen.findByRole("dialog", { name: "orders_ingest" });
    expect(row).toHaveAttribute("data-state", "selected");
    await waitFor(() => expect(api.callsTo("job_checks").at(-1)?.params.job_name).toBe("orders_ingest"));
    expect(within(panel).getByText("example-stage")).toBeInTheDocument();
    expect(within(panel).getByText("2002")).toBeInTheDocument();
    expect(within(panel).getByText("21")).toBeInTheDocument();
    // Only the checks of this workspace and job ID.
    expect(await within(panel).findByRole("heading", { name: "task_failures" })).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "schedule_gap" })).toBeInTheDocument();
    expect(within(panel).queryByRole("heading", { name: "last_run_result" })).toBeNull();
    expect(within(panel).queryByText("Only in the prod workspace")).toBeNull();

    expect(within(panel).getByRole("link", { name: "Ask the copilot" })).toHaveAttribute("href", "/copilot?job=orders_ingest&workspace=2002&status=FAILED");
    expect(within(panel).getByRole("link", { name: /^Open run/ })).toHaveAttribute("href", "https://workspace.example.com/jobs/21/runs/600");
  });

  it("opens the panel from the keyboard, and Escape returns focus to the job", async () => {
    setClock("2026-11-05T15:10:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS, job_checks: ORDERS_INGEST_CHECKS } });
    const user = userEvent.setup();
    renderPage();
    const button = await screen.findByRole("button", { name: "billing_export in example-prod" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "billing_export" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(button).toHaveFocus();
  });

  it("shows why the checks did not load, with Retry, and no skeleton left pulsing", async () => {
    setClock("2026-11-05T16:10:00Z");
    let fail = true;
    const api = mockApi({ queries: { job_status: STATUS_ROWS, job_checks: () => (fail ? { error: "Query execution failed", errorCode: "BAD_REQUEST" } : ORDERS_INGEST_CHECKS) } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "orders_ingest in example-stage" }));
    const panel = await screen.findByRole("dialog", { name: "orders_ingest" });
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the checks");
    expect(panel.querySelector('[data-slot="skeleton"]')).toBeNull();

    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await within(panel).findByRole("heading", { name: "task_failures" })).toBeInTheDocument();
    const refreshes = api.callsTo("job_checks").map((call) => Number(call.params.refresh));
    expect(refreshes.at(-1)).toBeGreaterThan(refreshes[0] ?? 0);
  });
  it("lists the jobs a failed check affects", async () => {
    setClock("2026-11-05T17:10:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS, job_checks: ORDERS_INGEST_CHECKS } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "orders_ingest in example-stage" }));
    const panel = await screen.findByRole("dialog", { name: "orders_ingest" });
    const section = await within(panel).findByRole("region", { name: "Affected jobs" });
    expect(within(section).getByRole("listitem")).toHaveTextContent("daily_revenue_report");
  });

  it("says no other jobs depend on a job whose failed check lists none", async () => {
    setClock("2026-11-05T17:20:00Z");
    mockApi({ queries: { job_status: STATUS_ROWS, job_checks: [checkRow({ affected_jobs: "[]" })] } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "orders_ingest in example-stage" }));
    const panel = await screen.findByRole("dialog", { name: "orders_ingest" });
    const section = await within(panel).findByRole("region", { name: "Affected jobs" });
    expect(section).toHaveTextContent("No other jobs depend on this one.");
  });

  it("has no affected-jobs section for a job with no failed check, since only failed checks list them", async () => {
    setClock("2026-11-05T17:30:00Z");
    const warningOnly = [
      checkRow({ job_name: "daily_revenue_report", workspace_id: "1001", workspace_name: "example-prod", job_id: "12", check_id: "long_runtime", status: "WARNING", affected_jobs: null }),
      checkRow({ job_name: "daily_revenue_report", workspace_id: "1001", workspace_name: "example-prod", job_id: "12", check_id: "schedule_gap", status: "HEALTHY", severity: null, affected_jobs: null }),
    ];
    mockApi({ queries: { job_status: STATUS_ROWS, job_checks: warningOnly } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "daily_revenue_report in example-prod" }));
    const panel = await screen.findByRole("dialog", { name: "daily_revenue_report" });
    expect(await within(panel).findByRole("heading", { name: "long_runtime" })).toBeInTheDocument();
    expect(within(panel).queryByRole("region", { name: "Affected jobs" })).toBeNull();
    expect(within(panel).queryByText("No other jobs depend on this one.")).toBeNull();
  });

  it("gives a healthy check a compact line with the run facts it has, and no error block", async () => {
    setClock("2026-11-05T17:40:00Z");
    const noRun = checkRow({
      check_id: "coverage",
      status: "HEALTHY",
      severity: null,
      failure_category: "NONE",
      error_summary: "The job is in the job list.",
      run_id: null,
      run_page_url: null,
      pipeline_url: null,
      code_version: null,
      trigger_type: null,
      run_start_time: null,
      run_end_time: null,
      run_duration_seconds: null,
      failed_task_keys: null,
      affected_jobs: null,
    });
    mockApi({ queries: { job_status: STATUS_ROWS, job_checks: [...ORDERS_INGEST_CHECKS, noRun] } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "orders_ingest in example-stage" }));
    const panel = await screen.findByRole("dialog", { name: "orders_ingest" });
    const healthy = await within(panel).findByRole("list", { name: "Healthy checks" });
    const [withRun, withoutRun] = within(healthy).getAllByRole("listitem");
    if (!withRun || !withoutRun) throw new Error("Expected two healthy checks");

    expect(within(withRun).getByRole("heading", { name: "schedule_gap" })).toBeInTheDocument();
    expect(within(withRun).getByRole("link", { name: "600, opens in a new tab" })).toHaveAttribute("href", "https://workspace.example.com/jobs/21/runs/600");
    expect(within(withRun).getByRole("link", { name: "Open, opens in a new tab" })).toHaveAttribute("href", "https://git.example.com/pipelines/42");
    expect(within(withRun).getByText("main@f6509ec")).toBeInTheDocument();
    expect(within(withRun).getByText("Schedule")).toBeInTheDocument();
    expect(within(withRun).getByText("2026-11-05 10:00 UTC")).toBeInTheDocument();
    // The run ended the same day, so the end is the time alone.
    expect(within(withRun).getByText("10:00 UTC")).toBeInTheDocument();
    expect(within(withRun).getByText("31 s")).toBeInTheDocument();

    expect(within(withoutRun).getByRole("heading", { name: "coverage" })).toBeInTheDocument();
    expect(within(withoutRun).queryByRole("link")).toBeNull();
    expect(within(withoutRun).queryByRole("term")).toBeNull();
    expect(within(healthy).queryByText("Not set")).toBeNull();
    expect(healthy.querySelector('[data-slot="check-error"]')).toBeNull();
    expect(panel.querySelector('[data-slot="check-error"]')).toHaveTextContent("load: ValueError: bad input in stage");
  });

  it("gives the copilot link the row's status while the checks load, and when they fail", async () => {
    setClock("2026-11-05T17:50:00Z");
    const api = mockApi({ queries: { job_status: STATUS_ROWS, job_checks: "hold" } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "billing_export in example-prod" }));
    const panel = await screen.findByRole("dialog", { name: "billing_export" });
    await waitFor(() => expect(api.callsTo("job_checks")).toHaveLength(1));
    expect(within(panel).getByRole("link", { name: "Ask the copilot" })).toHaveAttribute("href", "/copilot?job=billing_export&workspace=1001&status=FAILED");
    expect(within(panel).getByText("Failed")).toBeInTheDocument();

    api.release("job_checks", { error: "Query execution failed" });
    await within(panel).findByRole("alert");
    expect(within(panel).getByRole("link", { name: "Ask the copilot" })).toHaveAttribute("href", "/copilot?job=billing_export&workspace=1001&status=FAILED");
  });
});
