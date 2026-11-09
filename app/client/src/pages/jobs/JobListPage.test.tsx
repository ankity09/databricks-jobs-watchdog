// @vitest-environment jsdom
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobEntry, JobListDocument, JobListState } from "../../../../shared/joblist/types";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { jobListServer, type SaveBody } from "../../test/jobListServer";
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

/**
 * The job list, the app config, live status over SSE, and POST /api/job-list/changes answering with `post`.
 * Other analytics queries answer with their rows in `queries`, or none.
 */
function mockApi(state: JobListState, post?: (body: unknown) => Response, queries: Record<string, unknown[]> = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.startsWith("/api/app-config")) return Promise.resolve(json(200, CONFIG));
    if (url === "/api/job-list") return Promise.resolve(json(200, state));
    if (url.startsWith("/api/analytics/query/job_live_status"))
      return Promise.resolve(sse([{ job_name: "orders_ingest", status: "FAILED" }]));
    const query = /^\/api\/analytics\/query\/([^/?]+)/.exec(url);
    if (query) return Promise.resolve(sse(queries[decodeURIComponent(query[1])] ?? []));
    if (url === "/api/job-list/changes" && post)
      return Promise.resolve(post(JSON.parse(typeof init?.body === "string" ? init.body : "null")));
    return Promise.resolve(json(404, { error: "not_found", message: url }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * The page against a fake server that checks every save per target, like the real store. `hold()` keeps the
 * next save's answer back until the function it resolves with is called.
 */
function mockServer(server: ReturnType<typeof jobListServer>, live: unknown[] = []) {
  let held: ((release: () => void) => void) | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.startsWith("/api/app-config")) return Promise.resolve(json(200, CONFIG));
      if (url === "/api/job-list") return Promise.resolve(json(200, server.state()));
      if (url.startsWith("/api/analytics/query/job_live_status")) return Promise.resolve(sse(live));
      if (url.startsWith("/api/analytics/query/")) return Promise.resolve(sse([]));
      if (url === "/api/job-list/changes") {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as SaveBody;
        const hold = held;
        held = null;
        if (!hold) return Promise.resolve(server.answer(body));
        return new Promise<Response>((resolve) => hold(() => resolve(server.answer(body))));
      }
      return Promise.resolve(json(404, { error: "not_found", message: url }));
    }),
  );
  return {
    hold(): Promise<() => void> {
      return new Promise((resolve) => {
        held = resolve;
      });
    },
  };
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
    // The same badge as Monitoring: an icon and the word.
    expect(await ingest.findByText("Failed")).toBeInTheDocument();
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

  it("shows no limit and no owner where the job's own null switches the default off", async () => {
    setClock("2026-11-06T13:30:00Z");
    // null as stored: the loader reads no runtime limit and no owner, so the defaults do not apply to this job.
    const off = JSON.parse('{"job_name": "no_runtime_limit", "max_gap_minutes": 60, "max_runtime_minutes": null, "owner": null}') as JobEntry;
    mockApi({ ...SAVED, document: { ...DOC, defaults: { ...DOC.defaults, max_runtime_minutes: 120 }, jobs: [...DOC.jobs, off] } });
    renderPage();
    await screen.findByRole("button", { name: "Edit no_runtime_limit" });
    const cells = within(row("no_runtime_limit"));
    expect(cells.queryByText(/^runtime /)).toBeNull();
    expect(cells.queryByText("platform-team")).toBeNull();
    expect(cells.getByText("Not set")).toBeInTheDocument();
    // Another job still takes the default runtime.
    expect(within(row("orders_ingest")).getByText("runtime 120 min")).toBeInTheDocument();
  });

  it("links each job to its history", async () => {
    setClock("2026-11-05T11:30:00Z");
    mockApi(SAVED);
    renderPage();
    const link = await screen.findByRole("link", { name: "View history of orders_ingest" });
    expect(link).toHaveAttribute("href", "/jobs/changes?job=orders_ingest");
    expect(screen.getByRole("link", { name: "View history of orders_enrich" })).toHaveAttribute("href", "/jobs/changes?job=orders_enrich");
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
    expect(screen.getByLabelText("Max gap (minutes)")).toHaveValue("90");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Edit orders_enrich" })).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Add from workspace" }));
    expect(await screen.findByRole("heading", { name: "Add job" })).toBeInTheDocument();
    expect(screen.getByLabelText("Job name")).toHaveValue("picked_job");
    expect(screen.getByText("9007199254740993")).toBeInTheDocument();
  });

  it("adds a job from the workspace: the pick opens the editor in create mode with its draft", async () => {
    setClock("2026-11-05T17:30:00Z");
    const picked = {
      workspace_id: "1111111111111111",
      workspace_name: "example-prod",
      job_id: "9007199254740993",
      name: "[dev dana_lee] Nightly Billing Rollup",
      trigger_type: "CONTINUOUS",
      paused: "false",
      creator_user_name: "dana@example.com",
      change_time: "2026-11-05T09:00:00.000Z",
    };
    mockApi(SAVED, undefined, { region_jobs: [picked] });
    renderPage();
    await screen.findByRole("button", { name: "Edit orders_enrich" });
    await userEvent.click(screen.getByRole("button", { name: "Add from workspace" }));
    const picker = await screen.findByRole("dialog", { name: "Add from workspace" });
    await userEvent.type(within(picker).getByRole("searchbox", { name: "Search jobs by name" }), "billing");
    await userEvent.click(await within(picker).findByRole("button", { name: "Add [dev dana_lee] Nightly Billing Rollup from example-prod" }));

    expect(await screen.findByRole("heading", { name: "Add job" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Add from workspace" })).toBeNull();
    expect(screen.getByLabelText("Job name")).toHaveValue("nightly_billing_rollup");
    expect(screen.getByText("9007199254740993")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Schedule type" })).toHaveTextContent("continuous");

    // The real name has the dev prefix, so ^nightly_billing_rollup$ matches nothing: the scan finds the job by its ID instead.
    expect(await screen.findByText("The scan finds this job by its job ID.", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(await screen.findByText("The pattern matches 0 jobs.", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText("The scan would report this job as not found.")).toBeNull();
  });

  it("still warns in the editor when a job without IDs matches no job by name", async () => {
    setClock("2026-11-05T19:30:00Z");
    mockApi(SAVED);
    renderPage();
    await screen.findByRole("button", { name: "Edit orders_enrich" });
    await userEvent.click(screen.getByRole("button", { name: "Add job" }));
    await userEvent.type(await screen.findByLabelText("Job name"), "brand_new_job");
    expect(await screen.findByText("Matches 0 jobs", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText("The scan would report this job as not found.")).toBeInTheDocument();
    expect(screen.queryByText(/finds this job by its job ID/)).toBeNull();
  });

  it("shows the jobs the name pattern matches in the editor, and a hint while there is no pattern", async () => {
    setClock("2026-11-05T18:30:00Z");
    const matches = ["orders_ingest_eu_prod", "orders_ingest_us_prod"].map((name, i) => ({
      workspace_id: "1111111111111111",
      job_id: String(500 + i),
      name,
      match_count: "2",
    }));
    mockApi(SAVED, undefined, { pattern_matches: matches });
    renderPage();
    await screen.findByRole("button", { name: "Edit orders_enrich" });
    await userEvent.click(screen.getByRole("button", { name: "Add job" }));
    expect(await screen.findByRole("heading", { name: "Add job" })).toBeInTheDocument();
    // A new job has no name yet, so there is no pattern to check.
    expect(screen.getByText("Type a name pattern to see which jobs in this region it matches.")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Name pattern"), "^orders_ingest_");
    expect(await screen.findByText("Matches 2 jobs", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText("orders_ingest_eu_prod")).toHaveClass("font-mono");
    expect(screen.getByText("orders_ingest_us_prod")).toBeInTheDocument();
  });

  it("refuses an editor save that would undo the Enabled switch saved after the editor opened", async () => {
    setClock("2026-11-05T20:30:00Z");
    const server = jobListServer(DOC, 12);
    const api = mockServer(server);
    renderPage();
    const toggle = await screen.findByRole("switch", { name: "Check orders_ingest" });
    const next = api.hold();
    await userEvent.click(toggle);
    const release = await next;

    // The editor opens from version 12 while the switch's save is on its way, then the save lands as version 13.
    await userEvent.click(screen.getByRole("button", { name: "Edit orders_ingest" }));
    const owner = await screen.findByLabelText("Owner");
    release();
    expect(await screen.findByText("Saved version 13: Changed enabled on orders_ingest from unset to false.")).toBeInTheDocument();

    await userEvent.type(owner, "-eu");
    const save = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    expect(await screen.findByText("Someone else changed this job since you opened it.")).toBeInTheDocument();
    expect(server.saves.map((body) => body.baseVersion)).toEqual([12, 12]);
    expect(server.state().document.jobs.find((job) => job.job_name === "orders_ingest")?.enabled).toBe(false);
  });

  it("shows and edits a job whose stored name and notes are not text, as the loader reads them", async () => {
    setClock("2026-11-05T21:30:00Z");
    // Saved before the server stored text as text: YAML's job_name: 20241105 and notes: yes, as parsed.
    const stored = JSON.parse(
      JSON.stringify({ ...SAVED, document: { ...DOC, jobs: [...DOC.jobs, { job_name: 20241105, max_gap_minutes: 60, notes: true }] } }),
    ) as JobListState;
    const posts: unknown[] = [];
    mockApi(stored, (body) => {
      posts.push(body);
      return json(201, { version: 13, summary: "Changed max_gap_minutes on 20241105 from 60 to 90", document: stored.document });
    });
    renderPage();
    await screen.findByRole("button", { name: "Edit 20241105" });
    const dated = within(row("20241105"));
    expect(dated.getByText("^20241105$")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit 20241105" }));
    expect(await screen.findByLabelText("Notes")).toHaveValue("True");
    const gap = screen.getByLabelText("Max gap (minutes)");
    await userEvent.clear(gap);
    await userEvent.type(gap, "90");
    const save = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(posts).toHaveLength(1));
    // The notes stay, as the text the loader reads.
    expect(posts[0]).toEqual({
      baseVersion: 12,
      change: { kind: "upsert", target: { type: "job", name: "20241105" }, value: { job_name: "20241105", max_gap_minutes: 90, notes: "True" } },
    });
  });

  it("says why live status is missing as Monitoring does, names the grants, and offers Retry", async () => {
    setClock("2026-11-05T22:30:00Z");
    let liveCalls = 0;
    let failLive = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.startsWith("/api/app-config")) return Promise.resolve(json(200, CONFIG));
        if (url === "/api/job-list") return Promise.resolve(json(200, SAVED));
        if (url.startsWith("/api/analytics/query/job_live_status")) {
          liveCalls += 1;
          // AppKit sends a failed statement as a generic message with the warehouse's code, as for a missing grant.
          const event = failLive ? { type: "error", error: "Query execution failed", errorCode: "BAD_REQUEST" } : { type: "result", data: [{ job_name: "orders_ingest", status: "FAILED" }] };
          return Promise.resolve(new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
        }
        if (url.startsWith("/api/analytics/query/")) return Promise.resolve(sse([]));
        return Promise.resolve(json(404, { error: "not_found", message: url }));
      }),
    );
    renderPage();
    const title = await screen.findByText("Live status is not available.");
    const line = title.closest("[data-slot='query-problem']");
    if (!(line instanceof HTMLElement)) throw new Error("no problem line");
    expect(line).toHaveTextContent(
      "Live status is not available. The query on main.watchdog failed. If no scan has run yet, click Scan now to create the tables. Otherwise, ask the owner of main.watchdog for USE CATALOG, USE SCHEMA and SELECT on it.",
    );
    expect(within(row("orders_ingest")).getByText("Not available")).toBeInTheDocument();

    failLive = false;
    const before = liveCalls;
    await userEvent.click(within(line).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(liveCalls).toBeGreaterThan(before));
    expect(await within(row("orders_ingest")).findByText("Failed")).toBeInTheDocument();
    expect(screen.queryByText("Live status is not available.")).not.toBeInTheDocument();
  });
});

describe("JobListPage gives focus back when a sheet or dialog closes", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("to the button that opened the editor, after Cancel and after a save", async () => {
    setClock("2026-11-06T09:30:00Z");
    mockApi(SAVED, () => json(201, { version: 13, summary: "Changed owner on orders_enrich from unset to data-team", document: DOC }));
    renderPage();
    const edit = await screen.findByRole("button", { name: "Edit orders_enrich" });
    await userEvent.click(edit);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(edit).toHaveFocus());

    const name = screen.getByRole("button", { name: "orders_enrich" });
    await userEvent.click(name);
    await userEvent.type(await screen.findByLabelText("Owner"), "data-team");
    const save = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(name).toHaveFocus());
  });

  it("to Delete after Cancel, and to the search field once the job is gone", async () => {
    setClock("2026-11-06T10:30:00Z");
    mockApi(SAVED, () => json(201, { version: 13, summary: "Deleted job orders_ingest and 2 links", document: { ...DOC, jobs: DOC.jobs.slice(1), dependencies: [] } }));
    renderPage();
    const remove = await screen.findByRole("button", { name: "Delete orders_ingest" });
    await userEvent.click(remove);
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(remove).toHaveFocus());

    await userEvent.click(remove);
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete job" }));
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search jobs by name" })).toHaveFocus());
  });

  it("to Import YAML when the import closes", async () => {
    setClock("2026-11-06T11:30:00Z");
    mockApi(SAVED);
    renderPage();
    const open = await screen.findByRole("button", { name: "Import YAML" });
    await userEvent.click(open);
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Import YAML" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(open).toHaveFocus());
  });

  it("to Add from workspace when the picker closes, and when the editor a pick opened closes", async () => {
    setClock("2026-11-06T12:30:00Z");
    const picked = {
      workspace_id: "1111111111111111",
      workspace_name: "example-prod",
      job_id: "9007199254740993",
      name: "Nightly Billing Rollup",
      trigger_type: "CONTINUOUS",
      paused: "false",
      creator_user_name: "someone@example.com",
      change_time: "2026-11-05T09:00:00.000Z",
    };
    mockApi(SAVED, undefined, { region_jobs: [picked] });
    renderPage();
    const add = await screen.findByRole("button", { name: "Add from workspace" });
    await userEvent.click(add);
    await screen.findByRole("dialog", { name: "Add from workspace" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(add).toHaveFocus());

    await userEvent.click(add);
    const picker = await screen.findByRole("dialog", { name: "Add from workspace" });
    await userEvent.type(within(picker).getByRole("searchbox", { name: "Search jobs by name" }), "billing");
    await userEvent.click(await within(picker).findByRole("button", { name: "Add Nightly Billing Rollup from example-prod" }));
    // The editor keeps the focus the picker leaves it: it does not go back to the page while the editor is open.
    const jobName = await screen.findByLabelText("Job name");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add from workspace" })).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(jobName).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(add).toHaveFocus());
  });
});

describe("JobListPage round 2", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("after a conflict's Reload, a new job saves from the newest version and keeps what was typed", async () => {
    setClock("2026-11-06T15:30:00Z");
    const server = jobListServer(DOC, 12);
    mockServer(server);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Add job" }));
    const name = await screen.findByLabelText("Job name");
    // Meanwhile someone else adds nightly_rollup and deletes daily_revenue_export.
    server.saveAsSomeoneElse({ kind: "upsert", target: { type: "job", name: "nightly_rollup" }, value: { job_name: "nightly_rollup", max_gap_minutes: 60 } });
    server.saveAsSomeoneElse({ kind: "delete", target: { type: "job", name: "daily_revenue_export" } });

    await userEvent.type(name, "nightly_rollup");
    await userEvent.type(screen.getByLabelText("Max gap (minutes)"), "60");
    const add = screen.getByRole("button", { name: "Add job" });
    await waitFor(() => expect(add).toBeEnabled());
    await userEvent.click(add);
    expect(await screen.findByText("Someone else changed this job since you opened it.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    // The form keeps what was typed, and now knows that name is taken.
    await waitFor(() => expect(name).toHaveAccessibleDescription(/duplicate job_name 'nightly_rollup'/), { timeout: 3000 });
    expect(screen.getByLabelText("Max gap (minutes)")).toHaveValue("60");

    // A name that was in the list when the form opened, and is gone now, saves from the newest version.
    await userEvent.clear(name);
    await userEvent.type(name, "daily_revenue_export");
    await waitFor(() => expect(add).toBeEnabled(), { timeout: 3000 });
    await userEvent.click(add);
    expect(await screen.findByText(/^Saved version 15: Added job daily_revenue_export/)).toBeInTheDocument();
    expect(server.saves.map((body) => body.baseVersion)).toEqual([12, 14]);
  });

  it("after the first import, gives focus to the search field once the list arrives", async () => {
    setClock("2026-11-06T19:30:00Z");
    let imported = false;
    const list: { release?: () => void } = {};
    const preview = {
      document: DOC,
      diff: [{ target: "job:orders_ingest", kind: "added", fields: [] }],
      issues: [],
      summary: "Imported 3 jobs, 2 links and 2 workspace labels from YAML",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.startsWith("/api/app-config")) return Promise.resolve(json(200, CONFIG));
        if (url === "/api/job-list") {
          if (!imported) return Promise.resolve(json(200, EMPTY));
          // The list after the import arrives late, after the dialog has closed.
          return new Promise<Response>((resolve) => {
            list.release = () => resolve(json(200, { ...SAVED, version: 1 }));
          });
        }
        if (url === "/api/job-list/import/preview") return Promise.resolve(json(200, preview));
        if (url === "/api/job-list/import") {
          imported = true;
          return Promise.resolve(json(201, { version: 1, summary: preview.summary, document: DOC }));
        }
        if (url.startsWith("/api/analytics/query/")) return Promise.resolve(sse([]));
        return Promise.resolve(json(404, { error: "not_found", message: url }));
      }),
    );
    renderPage();
    const empty = (await screen.findByText("No jobs yet. Import your monitored-jobs YAML file, or add a job.")).closest('[data-slot="empty"]');
    if (!(empty instanceof HTMLElement)) throw new Error("no empty state");
    await userEvent.click(within(empty).getByRole("button", { name: "Import YAML" }));
    const dialog = await screen.findByRole("dialog", { name: "Import YAML" });
    await userEvent.click(within(dialog).getByLabelText("YAML"));
    await userEvent.paste("jobs:\n  - job_name: orders_ingest\n    max_gap_minutes: 60\n");
    await userEvent.click(await within(dialog).findByRole("button", { name: "Import" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import YAML" })).toBeNull());
    await waitFor(() => expect(list.release).toBeDefined());
    list.release?.();
    const search = await screen.findByRole("searchbox", { name: "Search jobs by name" });
    await waitFor(() => expect(search).toHaveFocus());
  });
});
