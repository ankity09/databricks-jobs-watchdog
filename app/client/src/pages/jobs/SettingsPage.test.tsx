// @vitest-environment jsdom
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobListDocument, JobListState } from "../../../../shared/joblist/types";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { jobListServer, type SaveBody } from "../../test/jobListServer";
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

interface MockOptions {
  /** The job list GET /api/job-list answers with at first. */
  state?: JobListState;
  workspacesFail?: boolean;
  /** The first save answers 409, as if someone else saved this list meanwhile. */
  conflictThen?: JobListState;
  /** The first load after the page's own fails. */
  failReloadOnce?: boolean;
}

function mockApi(options: MockOptions = {}) {
  const posts: unknown[] = [];
  const asked: string[] = [];
  let current = options.state ?? STATE;
  let conflict = options.conflictThen;
  let failReload = options.failReloadOnce === true;
  let loads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      asked.push(url);
      if (url.startsWith("/api/app-config")) return Promise.resolve(json(200, CONFIG));
      if (url === "/api/job-list") {
        loads += 1;
        if (loads > 1 && failReload) {
          failReload = false;
          return Promise.resolve(json(500, { error: "server", message: "The job list could not be read or saved. Try again." }));
        }
        return Promise.resolve(json(200, current));
      }
      if (url.startsWith("/api/analytics/query/workspaces")) {
        const event = options.workspacesFail
          ? { type: "error", error: "Query execution failed", errorCode: "BAD_REQUEST" }
          : { type: "result", data: WORKSPACES };
        return Promise.resolve(new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
      }
      if (url === "/api/job-list/changes") {
        posts.push(JSON.parse(typeof init?.body === "string" ? init.body : "null"));
        if (conflict) {
          current = conflict;
          conflict = undefined;
          return Promise.resolve(
            json(409, { error: "conflict", message: "Someone else changed this since you opened it.", latestVersion: current.version }),
          );
        }
        return Promise.resolve(json(201, { version: (current.version ?? 0) + 1, summary: "Saved", document: current.document }));
      }
      return Promise.resolve(json(404, { error: "not_found", message: url }));
    }),
  );
  return { posts, asked };
}

const STAGING = { workspace_id: "1111111111111111", workspace_name: "example-staging", environment: "lower", notes: "Development" };
const asksForWorkspaces = (asked: string[]) => asked.some((url) => url.startsWith("/api/analytics/query/workspaces"));

/**
 * The page against a fake server that checks every save per target, like the real store. `hold()` keeps the
 * next save's answer back until the returned function is called.
 */
function mockServer(server: ReturnType<typeof jobListServer>) {
  let held: ((release: () => void) => void) | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.startsWith("/api/app-config")) return Promise.resolve(json(200, CONFIG));
      if (url === "/api/job-list") return Promise.resolve(json(200, server.state()));
      if (url.startsWith("/api/analytics/query/")) {
        return Promise.resolve(new Response(`data: ${JSON.stringify({ type: "result", data: WORKSPACES })}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
      }
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
    /** Holds the next save's answer; resolves with the function that sends it. */
    hold(): Promise<() => void> {
      return new Promise((resolve) => {
        held = resolve;
      });
    },
  };
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

  it("shows a cleared default that a job needs next to its field, with that job, and keeps Save off", async () => {
    setClock("2026-11-05T10:30:00Z");
    mockApi();
    renderPage();
    const defaults = await screen.findByRole("region", { name: "Defaults" });
    const gap = within(defaults).getByLabelText("Max gap (minutes)");
    expect(gap).toHaveValue(60);
    await userEvent.clear(gap);
    await waitFor(() => expect(gap).toHaveAccessibleDescription(/scheduled jobs need max_gap_minutes \(used by orders_ingest\)/), {
      timeout: 3000,
    });
    expect(within(defaults).queryByText(/This change breaks/)).not.toBeInTheDocument();
    expect(within(defaults).getByRole("button", { name: "Save defaults" })).toBeDisabled();
  });

  it("shows a bad default once, next to its field, not once per job", async () => {
    setClock("2026-11-05T10:45:00Z");
    mockApi();
    renderPage();
    const defaults = await screen.findByRole("region", { name: "Defaults" });
    const retries = within(defaults).getByLabelText("Max retries");
    await userEvent.type(retries, "-1");
    const exclude = within(defaults).getByLabelText("Exclude pattern");
    await userEvent.type(exclude, "(");
    // On a slow machine a check can run between the two fields, so wait for the check that has both.
    await waitFor(
      () => {
        expect(retries).toHaveAccessibleDescription(
          /max_retries must be a whole number of zero or more, got -1 \(used by orders_ingest and orders_enrich\)/,
        );
        expect(exclude).toHaveAccessibleDescription(/job_name_exclude_regex does not compile/);
      },
      { timeout: 3000 },
    );
    expect(within(defaults).getAllByText(/max_retries must be a whole number/)).toHaveLength(1);
    expect(within(defaults).getAllByText(/job_name_exclude_regex does not compile/)).toHaveLength(1);
    expect(within(defaults).queryByText(/This change breaks/)).not.toBeInTheDocument();
    expect(within(defaults).getByRole("button", { name: "Save defaults" })).toBeDisabled();
  });

  it("says when the reload after a conflict fails, and starts the defaults again once it works", async () => {
    setClock("2026-11-05T11:00:00Z");
    const newer: JobListState = { ...STATE, version: 5, document: { ...DOC, defaults: { owner: "data-platform", max_gap_minutes: 60 } } };
    mockApi({ conflictThen: newer, failReloadOnce: true });
    renderPage();
    const defaults = await screen.findByRole("region", { name: "Defaults" });
    await userEvent.type(within(defaults).getByLabelText("Owner"), "-eu");
    await userEvent.click(within(defaults).getByRole("button", { name: "Save defaults" }));
    expect(await within(defaults).findByText("Someone else changed the defaults since you opened this page.")).toBeInTheDocument();
    await userEvent.click(within(defaults).getByRole("button", { name: "Reload" }));
    expect(
      await within(defaults).findByText("The job list did not reload. The job list could not be read or saved. Try again."),
    ).toBeInTheDocument();
    expect(within(defaults).getByLabelText("Owner")).toHaveValue("platform-team-eu");
    await userEvent.click(within(defaults).getByRole("button", { name: "Reload" }));
    // The form starts again from the newest defaults, and focus moves to the notice that says so.
    const notice = await screen.findByText("This form now shows the newest saved values. Make your change again.");
    expect(notice).toHaveFocus();
    const fresh = screen.getByRole("region", { name: "Defaults" });
    expect(within(fresh).getByLabelText("Owner")).toHaveValue("data-platform");
    expect(within(fresh).queryByText(/Someone else changed/)).not.toBeInTheDocument();
    expect(within(fresh).getByRole("button", { name: "Save defaults" })).toBeDisabled();
  });

  it("saves a changed default as one change", async () => {
    setClock("2026-11-05T11:30:00Z");
    const { posts } = mockApi();
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
    const { posts } = mockApi();
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
    const { posts } = mockApi();
    renderPage();
    const labels = await screen.findByRole("region", { name: "Workspace labels" });
    await userEvent.click(within(labels).getByRole("button", { name: "Remove the label for 1111111111111111" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove the label for 1111111111111111?" });
    expect(within(dialog).getByText(/orders_enrich sets settings for lower/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove label" })).toBeDisabled();
    expect(posts).toHaveLength(0);
  });

  it("starts the label form again from the newest saved label after a conflict, and saves only a real change", async () => {
    setClock("2026-11-05T15:30:00Z");
    const newer: JobListState = { ...STATE, version: 5, document: { ...DOC, workspaces: [DOC.workspaces?.[0] ?? STAGING, STAGING] } };
    const { posts } = mockApi({ conflictThen: newer });
    renderPage();
    const labels = await screen.findByRole("region", { name: "Workspace labels" });
    await userEvent.click(within(labels).getByRole("button", { name: "Edit the label for 1111111111111111" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit the label for 1111111111111111" });
    const save = within(dialog).getByRole("button", { name: "Save label" });
    expect(save).toBeDisabled();
    const notes = within(dialog).getByLabelText("Notes");
    await userEvent.clear(notes);
    await userEvent.type(notes, "Dev team");
    await waitFor(() => expect(save).toBeEnabled(), { timeout: 3000 });
    await userEvent.click(save);
    expect(await within(dialog).findByText("Someone else changed this label since you opened it.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Reload" }));

    // The form starts again from the newest saved label, so their change is kept, and Save waits for a new change.
    const fresh = await screen.findByRole("dialog", { name: "Edit the label for example-staging" });
    expect(within(fresh).getByText("This form now shows the newest saved values. Make your change again.")).toBeInTheDocument();
    expect(within(fresh).getByLabelText("Workspace name")).toHaveValue("example-staging");
    expect(within(fresh).getByLabelText("Notes")).toHaveValue("Development");
    const saveAgain = within(fresh).getByRole("button", { name: "Save label" });
    expect(saveAgain).toBeDisabled();
    await userEvent.clear(within(fresh).getByLabelText("Notes"));
    await userEvent.type(within(fresh).getByLabelText("Notes"), "Dev team");
    await waitFor(() => expect(saveAgain).toBeEnabled(), { timeout: 3000 });
    await userEvent.click(saveAgain);
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({
      baseVersion: 5,
      change: { kind: "upsert", target: { type: "workspace", key: "1111111111111111" }, value: { ...STAGING, notes: "Dev team" } },
    });
  });

  it("closes the label form with a notice when the reload shows someone removed the label", async () => {
    setClock("2026-11-05T15:45:00Z");
    const newer: JobListState = { ...STATE, version: 5, document: { ...DOC, workspaces: [STAGING] } };
    mockApi({ conflictThen: newer });
    renderPage();
    const labels = await screen.findByRole("region", { name: "Workspace labels" });
    await userEvent.click(within(labels).getByRole("button", { name: "Edit the label for example-prod" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit the label for example-prod" });
    await userEvent.type(within(dialog).getByLabelText("Notes"), "Main region");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save label" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: "Reload" }));
    expect(
      await within(labels).findByText("The label for example-prod is no longer in the list. Someone removed it while you were editing."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reads the region's workspaces only once Add label opens", async () => {
    setClock("2026-11-05T16:30:00Z");
    const { asked } = mockApi();
    renderPage();
    const labels = await screen.findByRole("region", { name: "Workspace labels" });
    await userEvent.click(within(labels).getByRole("button", { name: "Edit the label for example-prod" }));
    await screen.findByRole("dialog", { name: "Edit the label for example-prod" });
    expect(asksForWorkspaces(asked)).toBe(false);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(labels).getByRole("button", { name: "Add label" }));
    await screen.findByRole("dialog", { name: "Add a workspace label" });
    await waitFor(() => expect(asksForWorkspaces(asked)).toBe(true));
  });

  it("asks for jobs first when the list has none", async () => {
    setClock("2026-11-05T17:30:00Z");
    mockApi({ state: { version: null, savedAt: null, savedBy: null, document: { jobs: [] } } });
    renderPage();
    expect(await screen.findByText("Add jobs first")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the job list" })).toHaveAttribute("href", "/jobs");
    expect(screen.queryByRole("region", { name: "Defaults" })).not.toBeInTheDocument();
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

describe("SettingsPage saves from the version each form opened at", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Someone else changes the default owner after the page loaded: the page still shows version 4. */
  const ownerChange = { kind: "upsert", target: { type: "defaults" }, value: { owner: "data-platform", max_gap_minutes: 60 } } as const;

  /** Edits the notes of the label for 1111111111111111 and saves it. */
  async function saveLabelNotes(text: string) {
    const labels = screen.getByRole("region", { name: "Workspace labels" });
    await userEvent.click(within(labels).getByRole("button", { name: "Edit the label for 1111111111111111" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit the label for 1111111111111111" });
    await userEvent.clear(within(dialog).getByLabelText("Notes"));
    await userEvent.type(within(dialog).getByLabelText("Notes"), text);
    const save = within(dialog).getByRole("button", { name: "Save label" });
    await waitFor(() => expect(save).toBeEnabled(), { timeout: 3000 });
    await userEvent.click(save);
  }

  it("refuses a defaults save that a label save overtook, so the newer default owner stays", async () => {
    setClock("2026-11-05T18:30:00Z");
    const server = jobListServer(DOC, 4);
    mockServer(server);
    renderPage();
    const defaults = await screen.findByRole("region", { name: "Defaults" });
    server.saveAsSomeoneElse(ownerChange);

    const gap = within(defaults).getByLabelText("Max gap (minutes)");
    await userEvent.clear(gap);
    await userEvent.type(gap, "90");
    // The label save goes through (the label did not change), and its answer brings the newer defaults.
    await saveLabelNotes("Dev team");
    expect(await screen.findByText("Saved version 6: Changed notes on workspace 1111111111111111.")).toBeInTheDocument();

    const save = within(defaults).getByRole("button", { name: "Save defaults" });
    await waitFor(() => expect(save).toBeEnabled(), { timeout: 3000 });
    await userEvent.click(save);
    expect(await within(defaults).findByText("Someone else changed the defaults since you opened this page.")).toBeInTheDocument();
    expect(server.saves.map((body) => body.baseVersion)).toEqual([4, 4]);
    expect(server.state().document.defaults).toEqual({ owner: "data-platform", max_gap_minutes: 60 });
  });

  it("starts a defaults form with no edits again when a newer version changed the defaults", async () => {
    setClock("2026-11-05T19:30:00Z");
    const server = jobListServer(DOC, 4);
    mockServer(server);
    renderPage();
    await screen.findByRole("region", { name: "Defaults" });
    server.saveAsSomeoneElse(ownerChange);
    await saveLabelNotes("Dev team");
    await screen.findByText("Saved version 6: Changed notes on workspace 1111111111111111.");

    const defaults = screen.getByRole("region", { name: "Defaults" });
    await waitFor(() => expect(within(defaults).getByLabelText("Owner")).toHaveValue("data-platform"));
    const gap = within(defaults).getByLabelText("Max gap (minutes)");
    await userEvent.clear(gap);
    await userEvent.type(gap, "90");
    const save = within(defaults).getByRole("button", { name: "Save defaults" });
    await waitFor(() => expect(save).toBeEnabled(), { timeout: 3000 });
    await userEvent.click(save);
    expect(await screen.findByText("Saved version 7: Changed default max_gap_minutes from 60 to 90.")).toBeInTheDocument();
    expect(server.saves.at(-1)?.baseVersion).toBe(6);
    expect(server.state().document.defaults).toEqual({ owner: "data-platform", max_gap_minutes: 90 });
  });

  it("saves a label from the version its form opened at, even when another save lands meanwhile", async () => {
    setClock("2026-11-05T20:30:00Z");
    const server = jobListServer(DOC, 4);
    const api = mockServer(server);
    renderPage();
    const defaults = await screen.findByRole("region", { name: "Defaults" });
    await userEvent.type(within(defaults).getByLabelText("Owner"), "-eu");
    const next = api.hold();
    await userEvent.click(within(defaults).getByRole("button", { name: "Save defaults" }));
    const release = await next;

    // The label form opens at version 4, while the defaults save is still on its way.
    const labels = screen.getByRole("region", { name: "Workspace labels" });
    await userEvent.click(within(labels).getByRole("button", { name: "Edit the label for 1111111111111111" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit the label for 1111111111111111" });
    release();
    expect(await screen.findByText("Saved version 5: Changed default owner from platform-team to platform-team-eu.")).toBeInTheDocument();

    await userEvent.clear(within(dialog).getByLabelText("Notes"));
    await userEvent.type(within(dialog).getByLabelText("Notes"), "Dev team");
    const save = within(dialog).getByRole("button", { name: "Save label" });
    await waitFor(() => expect(save).toBeEnabled(), { timeout: 3000 });
    await userEvent.click(save);
    await waitFor(() => expect(server.saves).toHaveLength(2));
    expect(server.saves[1]?.baseVersion).toBe(4);
    expect(await screen.findByText("Saved version 6: Changed notes on workspace 1111111111111111.")).toBeInTheDocument();
  });
});

describe("SettingsPage with stored values that are not text", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows and edits a label whose stored name, label and notes are numbers, as the loader reads them", async () => {
    setClock("2026-11-05T21:30:00Z");
    // Saved before the server stored text as text: workspace_name: 2024, environment: 1 and notes: 2024, as parsed.
    const stored = JSON.parse(
      JSON.stringify({
        ...STATE,
        document: { ...DOC, workspaces: [...(DOC.workspaces ?? []), { workspace_name: 2024, environment: 1, notes: 2024 }] },
      }),
    ) as JobListState;
    const { posts } = mockApi({ state: stored });
    renderPage();
    const labels = await screen.findByRole("region", { name: "Workspace labels" });
    expect(within(labels).getByText("2024", { selector: "span" })).toBeInTheDocument();
    await userEvent.click(within(labels).getByRole("button", { name: "Edit the label for 2024" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit the label for 2024" });
    expect(within(dialog).getByLabelText("Environment label")).toHaveValue("1");
    const notes = within(dialog).getByLabelText("Notes");
    expect(notes).toHaveValue("2024");
    await userEvent.type(notes, " and later");
    const save = within(dialog).getByRole("button", { name: "Save label" });
    await waitFor(() => expect(save).toBeEnabled(), { timeout: 3000 });
    await userEvent.click(save);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      baseVersion: 4,
      change: {
        kind: "upsert",
        target: { type: "workspace", key: "2024" },
        value: { workspace_name: "2024", environment: "1", notes: "2024 and later" },
      },
    });
  });
});
