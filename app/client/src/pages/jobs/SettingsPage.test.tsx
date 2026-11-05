// @vitest-environment jsdom
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobListDocument, JobListState } from "../../../../shared/joblist/types";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { SettingsPage } from "./SettingsPage";

const CONFIG = { catalog: "main", schema: "watchdog", region: "us-east-2", appName: "watchdog-app", lakebaseProject: "jobs-watchdog" };

const DOC: JobListDocument = {
  defaults: { owner: "platform-team", max_gap_minutes: 60 },
  workspaces: [
    { workspace_name: "example-prod", environment: "production" },
    { workspace_id: "1111111111111111", environment: "lower", notes: "Development" },
  ],
  jobs: [{ job_name: "orders_ingest" }, { job_name: "orders_enrich", max_gap_minutes: 90, environments: { lower: { enabled: false } } }],
};

const STATE: JobListState = { version: 4, savedAt: "2026-11-05T10:05:00Z", savedBy: "dana@example.com", document: DOC };

const WORKSPACES = [
  { workspace_id: "2222222222222222", workspace_name: "example-dev", status: "RUNNING" },
  { workspace_id: "1111111111111111", workspace_name: "example-staging", status: "RUNNING" },
];

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockApi(options: { workspacesFail?: boolean } = {}) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.startsWith("/api/app-config")) return Promise.resolve(json(200, CONFIG));
      if (url === "/api/job-list") return Promise.resolve(json(200, STATE));
      if (url.startsWith("/api/analytics/query/workspaces")) {
        const event = options.workspacesFail
          ? { type: "error", error: "Query execution failed", errorCode: "BAD_REQUEST" }
          : { type: "result", data: WORKSPACES };
        return Promise.resolve(new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
      }
      if (url === "/api/job-list/changes") {
        posts.push(JSON.parse(typeof init?.body === "string" ? init.body : "null"));
        return Promise.resolve(json(201, { version: 5, summary: "Saved", document: DOC }));
      }
      return Promise.resolve(json(404, { error: "not_found", message: url }));
    }),
  );
  return posts;
}

/** Each test gets its own clock, so AppKit's query store does not share the workspace rows between tests. */
function setClock(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

function renderPage() {
  render(
    <RefreshProvider>
      <TooltipProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </TooltipProvider>
    </RefreshProvider>,
  );
}

describe("SettingsPage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("names the jobs a new default would break, and keeps Save off", async () => {
    setClock("2026-11-05T10:30:00Z");
    mockApi();
    renderPage();
    const defaults = await screen.findByRole("region", { name: "Defaults" });
    const gap = within(defaults).getByLabelText("Max gap (minutes)");
    expect(gap).toHaveValue(60);
    await userEvent.clear(gap);
    expect(await within(defaults).findByText("This change breaks 1 job:")).toBeInTheDocument();
    expect(within(defaults).getByText("job orders_ingest: scheduled jobs need max_gap_minutes")).toBeInTheDocument();
    expect(within(defaults).getByRole("button", { name: "Save defaults" })).toBeDisabled();
  });

  it("saves a changed default as one change", async () => {
    setClock("2026-11-05T11:30:00Z");
    const posts = mockApi();
    renderPage();
    const defaults = await screen.findByRole("region", { name: "Defaults" });
    const owner = within(defaults).getByLabelText("Owner");
    await userEvent.clear(owner);
    await userEvent.type(owner, "data-team");
    const save = within(defaults).getByRole("button", { name: "Save defaults" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      baseVersion: 4,
      change: { kind: "upsert", target: { type: "defaults" }, value: { owner: "data-team", max_gap_minutes: 60 } },
    });
    expect(await screen.findByText("Saved version 5: Saved.")).toBeInTheDocument();
  });

  it("lists the workspace labels, and adds one with suggestions from the region's workspaces", async () => {
    setClock("2026-11-05T12:30:00Z");
    const posts = mockApi();
    renderPage();
    const labels = await screen.findByRole("region", { name: "Workspace labels" });
    expect(within(labels).getByText("example-prod")).toBeInTheDocument();
    expect(within(labels).getByText("1111111111111111")).toBeInTheDocument();
    await userEvent.click(within(labels).getByRole("button", { name: "Add label" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a workspace label" });
    const id = within(dialog).getByLabelText("Workspace ID");
    await waitFor(() => expect(dialog.querySelector('datalist option[value="2222222222222222"]')).not.toBeNull());
    await userEvent.type(id, "2222222222222222");
    await userEvent.type(within(dialog).getByLabelText("Environment label"), "lower");
    const add = within(dialog).getByRole("button", { name: "Add label" });
    await waitFor(() => expect(add).toBeEnabled());
    await userEvent.click(add);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      baseVersion: 4,
      change: {
        kind: "upsert",
        target: { type: "workspace", key: "2222222222222222" },
        value: { workspace_id: "2222222222222222", environment: "lower" },
      },
    });
  });

  it("will not remove a label that a job still uses", async () => {
    setClock("2026-11-05T13:30:00Z");
    const posts = mockApi();
    renderPage();
    const labels = await screen.findByRole("region", { name: "Workspace labels" });
    await userEvent.click(within(labels).getByRole("button", { name: "Remove the label for 1111111111111111" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove the label for 1111111111111111?" });
    expect(within(dialog).getByText(/orders_enrich sets settings for lower/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove label" })).toBeDisabled();
    expect(posts).toHaveLength(0);
  });

  it("says when the workspace suggestions cannot be read, and still lets you type", async () => {
    setClock("2026-11-05T14:30:00Z");
    mockApi({ workspacesFail: true });
    renderPage();
    const labels = await screen.findByRole("region", { name: "Workspace labels" });
    await userEvent.click(within(labels).getByRole("button", { name: "Add label" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a workspace label" });
    expect(
      await within(dialog).findByText(
        "No suggestions: the app could not read system.access.workspaces_latest, often because you have no SELECT on it. You can still type a workspace ID or name.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Workspace ID")).toBeEnabled();
  });
});
