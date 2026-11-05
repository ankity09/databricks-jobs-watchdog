// @vitest-environment jsdom
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyChange } from "../../../../shared/joblist/apply";
import type { Change, JobListDocument, JobListState } from "../../../../shared/joblist/types";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { json, mockFetch } from "../../test/analytics-mock";
import { EXAMPLE_DOCUMENT } from "../../test/example-document";
import { mockReactFlow } from "../../test/reactflow-mocks";
import { DependencyMapPage } from "./DependencyMapPage";

const APP_CONFIG = { catalog: "main", schema: "watchdog", region: "us-east-2", appName: "watchdog-app", lakebaseProject: "jobs-watchdog" };
const LIVE = [
  { job_name: "watchdog_demo_fails", status: "FAILED" },
  { job_name: "watchdog_demo_succeeds", status: "HEALTHY" },
];

interface SaveBody {
  baseVersion: number | null;
  change: Change;
}

type SaveReply = (body: SaveBody, state: JobListState) => Response;

/** A server that applies each change with the shared rules, like the real one. */
const applies: SaveReply = (body, state) => {
  const applied = applyChange(state.document, body.change);
  return json({ version: (state.version ?? 0) + 1, summary: applied.summary, document: applied.document }, 201);
};

function renderMap(document: JobListDocument = EXAMPLE_DOCUMENT, reply: SaveReply = applies) {
  let state: JobListState = { version: 3, savedAt: "2026-11-04T10:00:00Z", savedBy: "dana@example.com", document };
  const saves: SaveBody[] = [];
  let loads = 0;
  mockFetch(
    (call) => (call.key === "job_live_status" ? { rows: LIVE } : { rows: [] }),
    (url, init) => {
      if (url.startsWith("/api/app-config")) return json(APP_CONFIG);
      if (url === "/api/job-list" && (init?.method ?? "GET") === "GET") {
        loads += 1;
        return json(state);
      }
      if (url === "/api/job-list/changes" && init?.method === "POST") {
        const body = JSON.parse(typeof init.body === "string" ? init.body : "null") as SaveBody;
        saves.push(body);
        const response = reply(body, state);
        if (response.status === 201) {
          const applied = applyChange(state.document, body.change);
          state = { ...state, version: (state.version ?? 0) + 1, document: applied.document };
        }
        return response;
      }
      return null;
    },
  );
  const view = render(
    <MemoryRouter>
      <RefreshProvider>
        <TooltipProvider>
          <DependencyMapPage />
        </TooltipProvider>
      </RefreshProvider>
    </MemoryRouter>,
  );
  return { ...view, saves, loads: () => loads };
}

function box(name: RegExp | string) {
  return screen.findByRole("button", { name });
}

describe("DependencyMapPage", () => {
  beforeAll(() => mockReactFlow());
  afterEach(() => vi.unstubAllGlobals());

  it("draws every job and service as a box and every link as an arrow, with the live status", async () => {
    const { container } = renderMap();
    expect(screen.getByRole("heading", { level: 1, name: "Dependency map" })).toBeInTheDocument();
    expect(await box("watchdog_demo_fails (Failed)")).toBeInTheDocument();
    expect(await box("watchdog_demo_succeeds (Healthy)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "orders_ingest (Unknown, switched off)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "kafka (service)" })).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll(".react-flow__edge")).toHaveLength(7));
    // React Flow turns pointer events off on a node that is neither selectable nor clickable: every box must take clicks.
    const wrappers = Array.from(container.querySelectorAll<HTMLElement>(".react-flow__node-job, .react-flow__node-service"));
    expect(wrappers).toHaveLength(11);
    for (const wrapper of wrappers) expect(wrapper.style.pointerEvents).not.toBe("none");
    expect(screen.getByRole("button", { name: "daily_revenue_export depends on daily_revenue_report (child job link)" })).toBeInTheDocument();
  });

  it("removes a link from the popover that opens on the link", async () => {
    const user = userEvent.setup();
    const { saves } = renderMap();
    fireEvent.click(await box("orders_enrich depends on orders_ingest (job link)"));
    const popover = await screen.findByRole("dialog", { name: "orders_enrich depends on orders_ingest" });
    await user.click(within(popover).getByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toEqual({ baseVersion: 3, change: { kind: "delete", target: { type: "dependency", key: "orders_enrich->orders_ingest:job" } } });
    expect(await screen.findByText("Saved version 4: Removed link orders_enrich -> orders_ingest (job).")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "orders_enrich depends on orders_ingest (job link)" })).toBeNull());
  });

  it("opens a link's menu from the keyboard, and the key press does not close it again", async () => {
    const user = userEvent.setup();
    renderMap();
    const link = await box("orders_enrich depends on orders_ingest (job link)");
    link.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("dialog", { name: "orders_enrich depends on orders_ingest" });
    // Focus starts on the menu itself, so the Enter that opened it cannot press Close or Remove link.
    expect(menu).toHaveFocus();
    await user.tab();
    expect(within(menu).getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab();
    expect(within(menu).getByRole("button", { name: "Remove link" })).toHaveFocus();
  });

  it("selects a box from the keyboard", async () => {
    const user = userEvent.setup();
    renderMap();
    const ingest = await box("orders_ingest (Unknown, switched off)");
    ingest.focus();
    await user.keyboard("{Enter}");
    expect(ingest).toHaveAttribute("data-highlight", "selected");
    await user.keyboard("{Escape}");
    expect(ingest).toHaveAttribute("data-highlight", "none");
  });

  it("adds a link: pick the upstream box, then the downstream box, then the type", async () => {
    const user = userEvent.setup();
    const { saves } = renderMap();
    await box("watchdog_demo_slow (Unknown)");
    await user.click(screen.getByRole("button", { name: "Add link" }));
    expect(screen.getByText("Pick the upstream job or service.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "watchdog_demo_slow (Unknown)" }));
    expect(screen.getByText("Now pick the job that depends on watchdog_demo_slow.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "watchdog_demo_retries (Unknown)" }));

    const dialog = await screen.findByRole("dialog", { name: "Add a link" });
    expect(dialog).toHaveAccessibleDescription("watchdog_demo_retries depends on watchdog_demo_slow.");
    await user.click(within(dialog).getByRole("radio", { name: /Child job/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].change).toEqual({
      kind: "upsert",
      target: { type: "dependency", key: "watchdog_demo_retries->watchdog_demo_slow:child_job" },
      value: { job_name: "watchdog_demo_retries", depends_on: "watchdog_demo_slow", dependency_type: "child_job" },
    });
    expect(await screen.findByText("Saved version 4: Linked watchdog_demo_retries to watchdog_demo_slow (child job).")).toBeInTheDocument();
  });

  it("shows a rule problem before saving, and does not save it", async () => {
    const user = userEvent.setup();
    const { saves } = renderMap();
    await user.click(await screen.findByRole("button", { name: "Add link" }));
    fireEvent.click(screen.getByRole("button", { name: "orders_enrich (Unknown, switched off)" }));
    fireEvent.click(screen.getByRole("button", { name: "daily_revenue_export (Unknown, switched off)" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a link" });
    // daily_revenue_export already has a parent, so it cannot be a child job of orders_enrich too.
    expect(within(dialog).getByRole("radio", { name: /Child job/ })).toBeDisabled();
    expect(within(dialog).getByText("daily_revenue_export already has a parent job, daily_revenue_report. A job can have only one.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(saves).toEqual([]);
  });

  it("adds a service: it asks for a name, then for the job that needs it", async () => {
    const user = userEvent.setup();
    const { saves } = renderMap();
    await box("kafka (service)");
    await user.click(screen.getByRole("button", { name: "Add service" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a service" });
    await user.type(within(dialog).getByRole("textbox", { name: "Service name" }), "warehouse_api");
    await user.click(within(dialog).getByRole("combobox", { name: "Job that needs it" }));
    await user.click(await screen.findByRole("option", { name: "watchdog_demo_slow" }));
    await user.click(within(dialog).getByRole("button", { name: "Save service" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].change).toEqual({
      kind: "upsert",
      target: { type: "dependency", key: "watchdog_demo_slow->warehouse_api:service" },
      value: { job_name: "watchdog_demo_slow", depends_on: "warehouse_api", dependency_type: "service" },
    });
    expect(await screen.findByRole("button", { name: "warehouse_api (service)" })).toBeInTheDocument();
  });

  it("highlights what a selected job's failure affects downstream", async () => {
    const user = userEvent.setup();
    renderMap();
    const ingest = await box("orders_ingest (Unknown, switched off)");
    fireEvent.click(ingest);
    expect(ingest).toHaveAttribute("aria-pressed", "true");
    expect(ingest).toHaveAttribute("data-highlight", "selected");
    for (const name of ["orders_enrich", "daily_revenue_report", "daily_revenue_export"]) {
      expect(screen.getByRole("button", { name: `${name} (Unknown, switched off)` })).toHaveAttribute("data-highlight", "downstream");
    }
    expect(screen.getByRole("button", { name: "watchdog_demo_fails (Failed)" })).toHaveAttribute("data-highlight", "dimmed");
    const panel = screen.getByRole("region", { name: "orders_ingest" });
    expect(within(panel).getByText("A failure here affects 3 jobs.")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Clear the selection" }));
    expect(ingest).toHaveAttribute("data-highlight", "none");
  });

  it("shows a conflict from saving as an alert with Reload", async () => {
    const user = userEvent.setup();
    const { loads } = renderMap(EXAMPLE_DOCUMENT, () =>
      json({ error: "conflict", message: "Someone else changed this since you opened it. Reload to see their change.", latestVersion: 5 }, 409),
    );
    fireEvent.click(await box("orders_enrich depends on orders_ingest (job link)"));
    await user.click(await screen.findByRole("button", { name: "Remove link" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Someone else changed the job list since you opened it.")).toBeInTheDocument();
    const before = loads();
    await user.click(within(alert).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(loads()).toBe(before + 1));
  });

  it("shows rule errors from saving as an alert", async () => {
    const user = userEvent.setup();
    renderMap(EXAMPLE_DOCUMENT, () =>
      json(
        {
          error: "invalid",
          message: "The job list has a problem.",
          issues: [{ path: "dependencies[a->b:job]", message: "dependency a -> b: b is not a configured job" }],
        },
        422,
      ),
    );
    fireEvent.click(await box("orders_enrich depends on orders_ingest (job link)"));
    await user.click(await screen.findByRole("button", { name: "Remove link" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The job list has a problem.")).toBeInTheDocument();
    expect(within(alert).getByText("dependency a -> b: b is not a configured job")).toBeInTheDocument();
  });

  it("says there are no links yet when the list has none, and still shows the jobs", async () => {
    renderMap({ jobs: [{ job_name: "orders_ingest" }, { job_name: "orders_enrich" }] });
    expect(await screen.findByText("No links yet. Add a link, or import a job list that has dependencies.")).toBeInTheDocument();
    expect(await box("orders_ingest (Unknown)")).toBeInTheDocument();
  });

  it("says there are no links yet when nothing is saved", async () => {
    renderMap({ jobs: [] });
    expect(await screen.findByText("No links yet. Add a link, or import a job list that has dependencies.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add link" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Go to the job list" })).toHaveAttribute("href", "/jobs");
  });

  it("offers Retry when the job list does not load", async () => {
    const user = userEvent.setup();
    let fail = true;
    mockFetch(
      () => ({ rows: [] }),
      (url) => {
        if (url.startsWith("/api/app-config")) return json(APP_CONFIG);
        if (url === "/api/job-list") {
          return fail
            ? json({ error: "unavailable", message: "The database is waking up." }, 503)
            : json({ version: 1, savedAt: null, savedBy: null, document: EXAMPLE_DOCUMENT });
        }
        return null;
      },
    );
    render(
      <MemoryRouter>
        <RefreshProvider>
          <TooltipProvider>
            <DependencyMapPage />
          </TooltipProvider>
        </RefreshProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Could not load the job list.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await box("watchdog_demo_fails (Failed)")).toBeInTheDocument();
  });
});
