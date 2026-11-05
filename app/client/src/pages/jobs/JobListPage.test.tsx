// @vitest-environment jsdom
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobListDocument, JobListState } from "../../../../shared/joblist/types";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { JobListPage, type JobListPageProps } from "./JobListPage";

const CONFIG = { catalog: "main", schema: "watchdog", region: "us-east-2", appName: "watchdog-app", lakebaseProject: "jobs-watchdog" };

const DOC: JobListDocument = {
  defaults: { schedule_type: "scheduled", severity: "WARNING", owner: "platform-team" },
  workspaces: [
    { workspace_name: "example-prod", environment: "production" },
    { workspace_id: "1111111111111111", environment: "lower" },
  ],
  jobs: [
    {
      job_name: "orders_ingest",
      job_name_regex: "^orders_ingest(_[a-z]+)?_(prod|dev)$",
      schedule_type: "continuous",
      max_retries: 3,
      min_attempt_minutes: 10,
      severity: "CRITICAL",
      owner: "ingestion-team",
      environments: { lower: { severity: "WARNING" } },
    },
    {
      job_name: "orders_enrich",
      job_ids: ["123456789012345", "234567890123456"],
      max_gap_minutes: 90,
      max_runtime_minutes: 45,
      enabled: false,
      environments: { lower: { enabled: false }, production: { severity: "CRITICAL" } },
    },
    { job_name: "daily_revenue_export", schedule_type: "triggered", max_runtime_minutes: 30 },
  ],
  dependencies: [
    { job_name: "orders_enrich", depends_on: "orders_ingest", dependency_type: "job" },
    { job_name: "orders_ingest", depends_on: "kafka", dependency_type: "service" },
  ],
};

const SAVED: JobListState = { version: 12, savedAt: "2026-11-05T10:05:00Z", savedBy: "dana@example.com", document: DOC };
const EMPTY: JobListState = { version: null, savedAt: null, savedBy: null, document: { jobs: [] } };

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sse(rows: unknown[]): Response {
  return new Response(`data: ${JSON.stringify({ type: "result", data: rows })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

/** The job list, the app config, live status over SSE, and POST /api/job-list/changes answering with `post`. */
function mockApi(state: JobListState, post?: (body: unknown) => Response) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.startsWith("/api/app-config")) return Promise.resolve(json(200, CONFIG));
    if (url === "/api/job-list") return Promise.resolve(json(200, state));
    if (url.startsWith("/api/analytics/query/job_live_status"))
      return Promise.resolve(sse([{ job_name: "orders_ingest", status: "FAILED" }]));
    if (url.startsWith("/api/analytics/query/")) return Promise.resolve(sse([]));
    if (url === "/api/job-list/changes" && post)
      return Promise.resolve(post(JSON.parse(typeof init?.body === "string" ? init.body : "null")));
    return Promise.resolve(json(404, { error: "not_found", message: url }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Each test gets its own clock, so AppKit's query store does not share live status rows between tests. */
function setClock(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

function renderPage(props: JobListPageProps = {}) {
  render(
    <RefreshProvider>
      <TooltipProvider>
        <MemoryRouter>
          <JobListPage {...props} />
        </MemoryRouter>
      </TooltipProvider>
    </RefreshProvider>,
  );
}

const row = (name: string) => {
  const cell = screen.getByRole("button", { name: `Edit ${name}` });
  const tr = cell.closest("tr");
  if (!tr) throw new Error(`no row for ${name}`);
  return tr;
};

describe("JobListPage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows each job's settings, environments and live status in its columns", async () => {
    setClock("2026-11-05T10:30:00Z");
    mockApi(SAVED);
    renderPage();
    expect(await screen.findByRole("columnheader", { name: "Job" })).toBeInTheDocument();
    for (const name of ["Schedule", "Limits", "Severity", "Owner", "Environments", "Enabled", "Live status"]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }

    const ingest = within(row("orders_ingest"));
    expect(ingest.getByText("^orders_ingest(_[a-z]+)?_(prod|dev)$")).toBeInTheDocument();
    expect(ingest.getByText("continuous")).toBeInTheDocument();
    expect(ingest.getByText("gap 30 min")).toBeInTheDocument();
    expect(ingest.getByText("retries 3")).toBeInTheDocument();
    expect(ingest.getByText("attempt 10 min")).toBeInTheDocument();
    expect(ingest.getByText("CRITICAL")).toBeInTheDocument();
    expect(ingest.getByText("ingestion-team")).toBeInTheDocument();
    expect(ingest.getByText("lower")).toBeInTheDocument();
    expect(ingest.getByRole("switch", { name: "Check orders_ingest" })).toBeChecked();
    expect(await ingest.findByText("FAILED")).toBeInTheDocument();
    expect(ingest.getByRole("button", { name: "Delete orders_ingest" })).toBeInTheDocument();

    const enrich = within(row("orders_enrich"));
    expect(enrich.getByText("2 job IDs")).toBeInTheDocument();
    expect(enrich.getByText("scheduled")).toBeInTheDocument();
    expect(enrich.getByText("gap 90 min")).toBeInTheDocument();
    expect(enrich.getByText("runtime 45 min")).toBeInTheDocument();
    expect(enrich.getByText("WARNING")).toBeInTheDocument();
    expect(enrich.getByText("platform-team")).toBeInTheDocument();
    expect(enrich.getByText("lower")).toBeInTheDocument();
    expect(enrich.getByText("production")).toBeInTheDocument();
    expect(enrich.getByRole("switch", { name: "Check orders_enrich" })).not.toBeChecked();
    expect(enrich.getByText("Off")).toBeInTheDocument();

    const exportRow = within(row("daily_revenue_export"));
    expect(exportRow.getByText("triggered")).toBeInTheDocument();
    expect(exportRow.getByText("^daily_revenue_export$")).toBeInTheDocument();
    expect(exportRow.getByText("Not scanned yet")).toBeInTheDocument();
  });

  it("filters the jobs by name", async () => {
    setClock("2026-11-05T11:30:00Z");
    mockApi(SAVED);
    renderPage();
    await screen.findByRole("button", { name: "Edit orders_ingest" });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search jobs by name" }), "ENRICH");
    expect(screen.queryByRole("button", { name: "Edit orders_ingest" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit orders_enrich" })).toBeInTheDocument();
    expect(screen.getByText("1 of 3 jobs")).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox", { name: "Search jobs by name" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search jobs by name" }), "nothing");
    expect(screen.getByText("No job names match nothing.")).toBeInTheDocument();
  });

  it("saves an update change when the Enabled switch is clicked", async () => {
    setClock("2026-11-05T12:30:00Z");
    const posts: unknown[] = [];
    mockApi(SAVED, (body) => {
      posts.push(body);
      const document = { ...DOC, jobs: DOC.jobs.map((job) => (job.job_name === "orders_ingest" ? { ...job, enabled: false } : job)) };
      return json(201, { version: 13, summary: "Changed enabled on orders_ingest from unset to false", document });
    });
    renderPage();
    await userEvent.click(await screen.findByRole("switch", { name: "Check orders_ingest" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    const ingest = DOC.jobs[0];
    expect(posts[0]).toEqual({
      baseVersion: 12,
      change: { kind: "upsert", target: { type: "job", name: "orders_ingest" }, value: { ...ingest, enabled: false } },
    });
    expect(await screen.findByText("Saved version 13: Changed enabled on orders_ingest from unset to false.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Check orders_ingest" })).not.toBeChecked();
  });

  it("names the job when the switch conflicts, and keeps the alert until a reload works", async () => {
    setClock("2026-11-05T12:45:00Z");
    const conflict = {
      error: "conflict",
      message: "Someone else changed this since you opened it. Reload to see their change.",
      latestVersion: 13,
    };
    const fetchMock = mockApi(SAVED, () => json(409, conflict));
    renderPage();
    const toggle = await screen.findByRole("switch", { name: "Check orders_ingest" });
    // From here the next load of the job list fails once.
    const answer = fetchMock.getMockImplementation();
    let failLoad = true;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input) === "/api/job-list" && failLoad) {
        failLoad = false;
        return Promise.resolve(json(500, { error: "server", message: "The job list could not be read or saved. Try again." }));
      }
      return answer ? answer(input, init) : Promise.resolve(json(404, { error: "not_found", message: "" }));
    });
    await userEvent.click(toggle);
    const message = "Someone else changed orders_ingest since you opened the list. Reload to see their change.";
    expect(await screen.findByText(message)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(await screen.findByText("The job list did not reload. The job list could not be read or saved. Try again.")).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.queryByText(message)).not.toBeInTheDocument());
    expect(screen.queryByText(/did not reload/)).not.toBeInTheDocument();
  });

  it("asks before a delete, and names the links it also removes", async () => {
    setClock("2026-11-05T13:30:00Z");
    const posts: unknown[] = [];
    mockApi(SAVED, (body) => {
      posts.push(body);
      const document = { ...DOC, jobs: DOC.jobs.slice(1), dependencies: [] };
      return json(201, { version: 13, summary: "Deleted job orders_ingest and 2 links", document });
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Delete orders_ingest" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete orders_ingest?" });
    expect(within(dialog).getByText("This also removes 2 links:")).toBeInTheDocument();
    expect(within(dialog).getByText("orders_enrich -> orders_ingest (job)")).toBeInTheDocument();
    expect(within(dialog).getByText("orders_ingest -> kafka (service)")).toBeInTheDocument();
    expect(posts).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete job" }));
    await waitFor(() =>
      expect(posts).toEqual([{ baseVersion: 12, change: { kind: "delete", target: { type: "job", name: "orders_ingest" } } }]),
    );
    expect(await screen.findByText("Saved version 13: Deleted job orders_ingest and 2 links.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit orders_ingest" })).not.toBeInTheDocument();
  });

  it("shows the next step when nothing is saved yet, with both buttons", async () => {
    setClock("2026-11-05T14:30:00Z");
    mockApi(EMPTY);
    renderPage();
    const empty = await screen.findByText("No jobs yet. Import your monitored-jobs YAML file, or add a job.");
    const box = empty.closest('[data-slot="empty"]');
    if (!(box instanceof HTMLElement)) throw new Error("no empty state");
    expect(within(box).getByRole("button", { name: "Import YAML" })).toBeInTheDocument();
    expect(within(box).getByRole("button", { name: "Add job" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export YAML" })).toBeDisabled();
  });

  it("links Export YAML to the export route once a version is saved", async () => {
    setClock("2026-11-05T15:30:00Z");
    mockApi(SAVED);
    renderPage();
    const exportLink = await screen.findByRole("link", { name: "Export YAML" });
    expect(exportLink).toHaveAttribute("href", "/api/job-list/export");
    expect(screen.getByText(/Version 12/)).toBeInTheDocument();
  });

  it("opens the editor with the job's values, and in create mode from an extra action", async () => {
    setClock("2026-11-05T16:30:00Z");
    mockApi(SAVED);
    renderPage({
      extraActions: ({ openCreate }) => (
        <button type="button" onClick={() => openCreate({ job_name: "picked_job", job_ids: ["9007199254740993"] })}>
          Add from workspace
        </button>
      ),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Edit orders_enrich" }));
    expect(await screen.findByRole("heading", { name: "Edit orders_enrich" })).toBeInTheDocument();
    expect(screen.getByLabelText("Max gap (minutes)")).toHaveValue(90);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Edit orders_enrich" })).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Add from workspace" }));
    expect(await screen.findByRole("heading", { name: "Add job" })).toBeInTheDocument();
    expect(screen.getByLabelText("Job name")).toHaveValue("picked_job");
    expect(screen.getByText("9007199254740993")).toBeInTheDocument();
  });
});
