// @vitest-environment jsdom
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyChange } from "../../../../shared/joblist/apply";
import type { Change, JobListDocument, JobListState } from "../../../../shared/joblist/types";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { type QueryAnswer, type QueryCall, json, mockFetch } from "../../test/analytics-mock";
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

interface MapOptions {
  /** Answers for analytics queries other than live status; null for no rows. */
  queries?: (call: QueryCall) => QueryAnswer | null;
  /** The live status answer, when it is not the LIVE rows. */
  live?: () => QueryAnswer;
  /** The saved version: null for a job list that was never saved. */
  version?: number | null;
}

function renderMap(document: JobListDocument = EXAMPLE_DOCUMENT, reply: SaveReply = applies, options: MapOptions = {}) {
  const version = options.version === undefined ? 3 : options.version;
  let state: JobListState =
    version === null
      ? { version, savedAt: null, savedBy: null, document }
      : { version, savedAt: "2026-11-04T10:00:00Z", savedBy: "dana@example.com", document };
  const saves: SaveBody[] = [];
  let loads = 0;
  let loadsFail = false;
  mockFetch(
    (call) => (call.key === "job_live_status" ? (options.live?.() ?? { rows: LIVE }) : (options.queries?.(call) ?? { rows: [] })),
    (url, init) => {
      if (url.startsWith("/api/app-config")) return json(APP_CONFIG);
      if (url === "/api/job-list" && (init?.method ?? "GET") === "GET") {
        loads += 1;
        return loadsFail ? json({ error: "unavailable", message: "The database is waking up." }, 503) : json(state);
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
  return {
    ...view,
    saves,
    loads: () => loads,
    failLoads: (fail: boolean) => {
      loadsFail = fail;
    },
  };
}

function box(name: RegExp | string) {
  return screen.findByRole("button", { name });
}

/** A named part of a card, a link or the panel, by its data-part attribute. */
function part(element: Element, name: string): HTMLElement | null {
  return element.querySelector<HTMLElement>(`[data-part="${name}"]`);
}

/** A link's drawn line, inside the focusable group that carries its name. */
function line(name: string): SVGPathElement {
  const path = screen.getByRole("button", { name }).querySelector<SVGPathElement>(".react-flow__edge-path");
  if (!path) throw new Error(`no line for ${name}`);
  return path;
}

/** A box's top-left corner on the canvas, from its wrapper's transform. */
function cornerOf(container: HTMLElement, id: string): { x: number; y: number } {
  const wrapper = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  if (!wrapper) throw new Error(`no box ${id}`);
  const [x, y] = numbersIn(wrapper.style.transform);
  return { x, y };
}

/** The value next to a label in the side panel's details. */
function detail(panel: HTMLElement, label: string): string {
  return within(panel).getByText(label, { selector: "dt" }).nextElementSibling?.textContent ?? "";
}

/** A section of the side panel, by its heading. */
function panelSection(panel: HTMLElement, heading: string): HTMLElement {
  const section = within(panel).getByRole("heading", { name: heading }).closest("section");
  if (!(section instanceof HTMLElement)) throw new Error(`no section ${heading}`);
  return section;
}

/** Room for the floating point of a fit or a pan: half a pixel. */
const SUBPIXEL = 0.5;

/** Numbers in a CSS transform, such as translate(10px,20px) scale(0.9). */
function numbersIn(transform: string): number[] {
  return (transform.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
}

/** Where the boxes are on screen: their flow positions and sizes, through the viewport's pan and zoom. */
function boxesOnScreen(container: HTMLElement) {
  const [x, y, zoom] = numbersIn(container.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "");
  const rects = Array.from(container.querySelectorAll<HTMLElement>(".react-flow__node")).map((node) => {
    const [left, top] = numbersIn(node.style.transform);
    return { left, top, right: left + parseFloat(node.style.width), bottom: top + parseFloat(node.style.height) };
  });
  return {
    zoom,
    top: y + Math.min(...rects.map((r) => r.top)) * zoom,
    bottom: y + Math.max(...rects.map((r) => r.bottom)) * zoom,
    left: x + Math.min(...rects.map((r) => r.left)) * zoom,
    right: x + Math.max(...rects.map((r) => r.right)) * zoom,
  };
}

/** Where one box is on screen, through the viewport's pan and zoom. */
function boxOnScreen(container: HTMLElement, id: string) {
  const [x, , zoom] = numbersIn(container.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "");
  const wrapper = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  if (!wrapper) throw new Error(`no box ${id}`);
  const [left] = numbersIn(wrapper.style.transform);
  return { left: x + left * zoom, right: x + (left + parseFloat(wrapper.style.width)) * zoom };
}

/** Gives the map's drawing area a size, as the browser would after a layout change, and tells React Flow. */
function resizeMap(container: HTMLElement, width: number, height: number) {
  const renderer = container.querySelector<HTMLElement>(".react-flow__renderer");
  if (!renderer) throw new Error("The map has not rendered.");
  renderer.style.width = `${width}px`;
  renderer.style.height = `${height}px`;
  fireEvent(window, new Event("resize"));
}

describe("DependencyMapPage", () => {
  beforeAll(() => mockReactFlow());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

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

  it("shows which link has keyboard focus, in the focus color and a wider line", async () => {
    renderMap();
    await box("orders_enrich depends on orders_ingest (job link)");
    const links = screen.getAllByRole("button", { name: / link\)$/ });
    expect(links).toHaveLength(7);
    // React Flow's own focus style loses to the line's color classes, so each link brings its own.
    for (const link of links) {
      expect(link).toHaveClass("group");
      expect(link.querySelector(".react-flow__edge-path")).toHaveClass("group-focus-visible:stroke-ring", "group-focus-visible:[stroke-width:2.5]");
    }
  });

  it("closes a link's menu with Escape without clearing the selected box, and gives focus back to the link", async () => {
    const user = userEvent.setup();
    renderMap();
    const ingest = await box("orders_ingest (Unknown, switched off)");
    fireEvent.click(ingest);
    expect(ingest).toHaveAttribute("data-highlight", "selected");
    const link = screen.getByRole("button", { name: "orders_enrich depends on orders_ingest (job link)" });
    link.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("dialog", { name: "orders_enrich depends on orders_ingest" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    expect(ingest).toHaveAttribute("data-highlight", "selected");
    await waitFor(() => expect(link).toHaveFocus());
  });

  it("says politely which box Enter selected and what a failure there affects, and keeps focus on the box", async () => {
    const user = userEvent.setup();
    renderMap();
    const ingest = await box("orders_ingest (Unknown, switched off)");
    ingest.focus();
    await user.keyboard("{Enter}");
    const panel = await screen.findByRole("region", { name: "orders_ingest" });
    const affects = within(panel).getByText(/^A failure here affects/).textContent ?? "";
    const said = await screen.findByText(`Selected orders_ingest. ${affects}`);
    expect(said).toHaveAttribute("aria-live", "polite");
    expect(said).toHaveClass("sr-only");
    expect(ingest).toHaveFocus();
  });

  it("keeps focus on a link when Escape is pressed with no menu open", async () => {
    const user = userEvent.setup();
    renderMap();
    const link = await box("orders_enrich depends on orders_ingest (job link)");
    link.focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(link).toHaveFocus());
  });

  it("gives focus back to the link when its menu's Close is pressed", async () => {
    const user = userEvent.setup();
    renderMap();
    const link = await box("orders_enrich depends on orders_ingest (job link)");
    link.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("dialog", { name: "orders_enrich depends on orders_ingest" });
    await user.click(within(menu).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(link).toHaveFocus());
  });

  it("after Remove link, gives focus to the box at the link's upstream end", async () => {
    const user = userEvent.setup();
    renderMap();
    const link = await box("orders_enrich depends on orders_ingest (job link)");
    link.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "orders_enrich depends on orders_ingest" });
    await user.tab();
    await user.tab();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "orders_enrich depends on orders_ingest (job link)" })).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "orders_ingest (Unknown, switched off)" })).toHaveFocus());
  });

  it("after Remove link, gives focus to the job when the upstream box goes with the link", async () => {
    const user = userEvent.setup();
    renderMap();
    // kafka has this one link, so its box goes too.
    fireEvent.click(await box("orders_ingest depends on kafka (service link)"));
    const menu = await screen.findByRole("dialog", { name: "orders_ingest depends on kafka" });
    await user.click(within(menu).getByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "kafka (service)" })).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "orders_ingest (Unknown, switched off)" })).toHaveFocus());
  });

  it("keeps focus in the side panel after a link is removed there", async () => {
    const user = userEvent.setup();
    renderMap();
    fireEvent.click(await box("orders_ingest (Unknown, switched off)"));
    const panel = screen.getByRole("region", { name: "orders_ingest" });
    await user.click(within(panel).getByRole("button", { name: "Remove the link: orders_enrich depends on orders_ingest (job link)" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "orders_enrich depends on orders_ingest (job link)" })).toBeNull());
    await waitFor(() => expect(panel).toHaveFocus());
  });

  it("gives focus back to the box when its side panel closes, with the button or with Escape", async () => {
    const user = userEvent.setup();
    renderMap();
    const ingest = await box("orders_ingest (Unknown, switched off)");
    fireEvent.click(ingest);
    await user.click(within(screen.getByRole("region", { name: "orders_ingest" })).getByRole("button", { name: "Clear the selection" }));
    await waitFor(() => expect(ingest).toHaveFocus());

    fireEvent.click(ingest);
    within(screen.getByRole("region", { name: "orders_ingest" })).getByRole("button", { name: "Clear the selection" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "orders_ingest" })).toBeNull();
    await waitFor(() => expect(ingest).toHaveFocus());
  });

  it("gives focus back to Add link and Add service when what they opened closes", async () => {
    const user = userEvent.setup();
    renderMap();
    await box("watchdog_demo_slow (Unknown)");
    const addService = screen.getByRole("button", { name: "Add service" });
    await user.click(addService);
    await screen.findByRole("dialog", { name: "Add a service" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(addService).toHaveFocus());

    const addLink = screen.getByRole("button", { name: "Add link" });
    await user.click(addLink);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Pick the upstream job or service.")).toBeNull();
    await waitFor(() => expect(addLink).toHaveFocus());

    await user.click(addLink);
    fireEvent.click(screen.getByRole("button", { name: "watchdog_demo_slow (Unknown)" }));
    fireEvent.click(screen.getByRole("button", { name: "watchdog_demo_retries (Unknown)" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a link" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(addLink).toHaveFocus());
  });

  it("fits the map again when its area changes size, clear of the toolbar above and the legend and minimap below", async () => {
    const { container } = renderMap();
    await box("watchdog_demo_fails (Failed)");
    resizeMap(container, 1200, 800);
    await waitFor(() => expect(boxesOnScreen(container).zoom).toBeGreaterThan(0.4));
    let shown = boxesOnScreen(container);
    expect(shown.top).toBeGreaterThanOrEqual(64 - SUBPIXEL);
    expect(shown.bottom).toBeLessThanOrEqual(800 - 148 + SUBPIXEL);
    expect(shown.left).toBeGreaterThanOrEqual(24 - SUBPIXEL);
    expect(shown.right).toBeLessThanOrEqual(1200 - 24 + SUBPIXEL);

    // An alert above the map takes 150 pixels of its height.
    resizeMap(container, 1200, 650);
    await waitFor(() => expect(boxesOnScreen(container).bottom).toBeLessThanOrEqual(650 - 148 + SUBPIXEL));
    shown = boxesOnScreen(container);
    expect(shown.top).toBeGreaterThanOrEqual(64 - SUBPIXEL);
  });

  it("keeps a fit clear of the side panel while it is open, and moves the map only to bring a selected box out from under it", async () => {
    const { container } = renderMap();
    await box("watchdog_demo_fails (Failed)");
    resizeMap(container, 1400, 800);
    await waitFor(() => expect(boxesOnScreen(container).zoom).toBeGreaterThan(0.4));
    const before = boxesOnScreen(container);
    // The panel is 360 pixels wide, 12 from the edge, and the map keeps 16 more clear of it.
    const panelEdge = 1400 - 388;
    expect(before.right).toBeGreaterThan(panelEdge);

    // A box on the left: selecting it opens the panel and leaves the view where it was.
    fireEvent.click(screen.getByRole("button", { name: "orders_ingest (Unknown, switched off)" }));
    await screen.findByRole("region", { name: "orders_ingest" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(boxesOnScreen(container)).toEqual(before);

    // The last box of the chain sits under the panel: selecting it moves the map left just enough, at the same zoom.
    fireEvent.click(screen.getByRole("button", { name: "daily_revenue_export (Unknown, switched off)" }));
    await screen.findByRole("region", { name: "daily_revenue_export" });
    // The shift is the overlap, so the box ends at the panel's edge.
    await waitFor(() => expect(boxOnScreen(container, "job:daily_revenue_export").right).toBeLessThanOrEqual(panelEdge + SUBPIXEL));
    expect(boxOnScreen(container, "job:daily_revenue_export").left).toBeGreaterThanOrEqual(24 - SUBPIXEL);
    expect(boxesOnScreen(container).zoom).toBe(before.zoom);

    // The pan moved the left of the map off screen. A fit while the panel is open brings it all back, clear of the panel.
    expect(boxesOnScreen(container).left).toBeLessThan(24);
    resizeMap(container, 1400, 760);
    await waitFor(() => {
      const shown = boxesOnScreen(container);
      expect(shown.left).toBeGreaterThanOrEqual(24 - SUBPIXEL);
      expect(shown.right).toBeLessThanOrEqual(panelEdge + SUBPIXEL);
    });
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

  it("draws each job as a card: its name, its owner and schedule, a status chip, and markers for critical and switched-off jobs", async () => {
    renderMap();
    const fails = await box("watchdog_demo_fails (Failed)");
    expect(within(fails).getByText("watchdog_demo_fails")).toBeInTheDocument();
    expect(within(fails).getByText("platform-team · Scheduled")).toBeInTheDocument();
    expect(part(fails, "status")).toHaveTextContent("Failed");
    expect(part(fails, "tile")).toHaveAttribute("data-schedule", "scheduled");
    expect(part(fails, "tile")).toHaveAttribute("data-tone", "destructive");
    expect(part(fails, "critical")).toHaveAccessibleName("Critical");
    expect(part(fails, "off")).toBeNull();

    const succeeds = screen.getByRole("button", { name: "watchdog_demo_succeeds (Healthy)" });
    expect(part(succeeds, "status")).toHaveTextContent("Healthy");
    expect(part(succeeds, "tile")).toHaveAttribute("data-tone", "success");
    expect(part(succeeds, "critical")).toBeNull();

    const ingest = screen.getByRole("button", { name: "orders_ingest (Unknown, switched off)" });
    expect(within(ingest).getByText("ingestion-team · Continuous")).toBeInTheDocument();
    expect(part(ingest, "tile")).toHaveAttribute("data-schedule", "continuous");
    expect(part(ingest, "status")).toHaveTextContent("Unknown");
    expect(part(ingest, "off")).toHaveTextContent("Off");
    expect(ingest).toHaveAttribute("data-active", "false");
    expect(part(screen.getByRole("button", { name: "daily_revenue_export (Unknown, switched off)" }), "tile")).toHaveAttribute("data-schedule", "triggered");

    const kafka = screen.getByRole("button", { name: "kafka (service)" });
    expect(within(kafka).getByText("kafka")).toBeInTheDocument();
    expect(within(kafka).getByText("Service")).toBeInTheDocument();
    expect(part(kafka, "status")).toBeNull();
  });

  it("puts the jobs with no links in a labeled group under the graph", async () => {
    const { container } = renderMap();
    await box("watchdog_demo_slow (Unknown)");
    const group = container.querySelector<HTMLElement>(".react-flow__node-section");
    if (!group) throw new Error("no group");
    expect(group).toHaveTextContent("Not linked yet");
    expect(group).toHaveTextContent("2 jobs");
    const groupTop = cornerOf(container, "section:unlinked").y;
    for (const id of ["job:watchdog_demo_slow", "job:watchdog_demo_retries"]) expect(cornerOf(container, id).y).toBeGreaterThan(groupTop);
    expect(cornerOf(container, "job:orders_enrich").y).toBeLessThan(groupTop);
  });

  it("draws each link type in its own style: job links solid, child-job links dashed with a label, service links dotted and lighter", async () => {
    renderMap();
    await box("orders_enrich depends on orders_ingest (job link)");
    const job = line("orders_enrich depends on orders_ingest (job link)");
    const child = line("daily_revenue_export depends on daily_revenue_report (child job link)");
    const service = line("orders_ingest depends on kafka (service link)");
    expect(job).toHaveAttribute("data-line", "solid");
    expect(child).toHaveAttribute("data-line", "dashed");
    expect(child).toHaveClass("[stroke-dasharray:6_4]");
    expect(service).toHaveAttribute("data-line", "dotted");
    expect(service).toHaveClass("[stroke-dasharray:1_4]");
    // A closed arrowhead at the dependent end; a service link's is as light as its line.
    expect(job).toHaveAttribute("marker-end", "url(#watchdog-map-arrow)");
    expect(service).toHaveAttribute("marker-end", "url(#watchdog-map-arrow-light)");
    const childLink = screen.getByRole("button", { name: "daily_revenue_export depends on daily_revenue_report (child job link)" });
    expect(within(childLink).getByText("child")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "orders_enrich depends on orders_ingest (job link)" })).queryByText("child")).toBeNull();
  });

  it("on select, shows the downstream chain in the accent, the upstream path in dark neutral, and fades the rest", async () => {
    renderMap();
    const enrich = await box("orders_enrich (Unknown, switched off)");
    fireEvent.click(enrich);
    expect(enrich).toHaveAttribute("data-highlight", "selected");

    const highlightOf = (name: string) => screen.getByRole("button", { name }).getAttribute("data-highlight");
    for (const name of ["daily_revenue_report (Unknown, switched off)", "daily_revenue_export (Unknown, switched off)"]) {
      expect(highlightOf(name)).toBe("downstream");
      expect(part(screen.getByRole("button", { name }), "affected")).toHaveTextContent("Affected");
    }
    for (const name of ["orders_ingest (Unknown, switched off)", "kafka (service)", "config_api (service)"]) expect(highlightOf(name)).toBe("upstream");
    for (const name of ["watchdog_demo_fails (Failed)", "object_storage (service)"]) {
      expect(highlightOf(name)).toBe("dimmed");
      expect(screen.getByRole("button", { name })).toHaveClass("opacity-35");
    }

    for (const name of ["daily_revenue_report depends on orders_enrich (job link)", "daily_revenue_export depends on daily_revenue_report (child job link)"]) {
      expect(line(name)).toHaveAttribute("data-highlight", "downstream");
      expect(line(name)).toHaveClass("stroke-primary", "motion-safe:animate-map-flow");
      expect(line(name)).toHaveAttribute("marker-end", "url(#watchdog-map-arrow-accent)");
    }
    for (const name of ["orders_enrich depends on orders_ingest (job link)", "orders_ingest depends on kafka (service link)", "orders_enrich depends on config_api (service link)"]) {
      expect(line(name)).toHaveAttribute("data-highlight", "upstream");
      expect(line(name)).toHaveAttribute("marker-end", "url(#watchdog-map-arrow-dark)");
    }
    for (const name of ["daily_revenue_export depends on object_storage (service link)", "watchdog_demo_succeeds depends on watchdog_demo_fails (job link)"]) {
      expect(line(name)).toHaveAttribute("data-highlight", "dimmed");
      expect(line(name)).toHaveClass("opacity-35");
    }
  });

  it("keeps the downstream chain still with reduced motion: its flow runs only under motion-safe", async () => {
    renderMap();
    fireEvent.click(await box("orders_ingest (Unknown, switched off)"));
    const flowing = line("orders_enrich depends on orders_ingest (job link)");
    expect(flowing).toHaveAttribute("data-highlight", "downstream");
    const classes = Array.from(flowing.classList);
    // With prefers-reduced-motion the line stays solid and still: no dash pattern or animation outside motion-safe.
    expect(classes.filter((c) => c.includes("animate-") || c.includes("stroke-dasharray"))).toEqual([
      "motion-safe:[stroke-dasharray:6_4]",
      "motion-safe:animate-map-flow",
    ]);
  });

  it("shows the selected job's details, its links both ways with Remove, and what it affects, with the steps", async () => {
    renderMap();
    fireEvent.click(await box("orders_ingest (Unknown, switched off)"));
    const panel = screen.getByRole("region", { name: "orders_ingest" });
    expect(within(panel).getByRole("heading", { level: 2, name: "orders_ingest" })).toBeInTheDocument();
    expect(part(panel, "status")).toHaveTextContent("Unknown");

    expect(detail(panel, "Owner")).toBe("ingestion-team");
    expect(detail(panel, "Schedule")).toBe("Continuous");
    expect(detail(panel, "Severity")).toBe("CRITICAL");
    expect(detail(panel, "Max gap")).toBe("30 min");
    expect(detail(panel, "Max runtime")).toBe("None");
    expect(detail(panel, "Max retries")).toBe("3");
    expect(detail(panel, "Enabled")).toBe("No");

    const dependsOn = panelSection(panel, "Depends on");
    expect(dependsOn).toHaveTextContent("kafka");
    expect(dependsOn).toHaveTextContent("Service");
    expect(within(dependsOn).getByRole("button", { name: "Remove the link: orders_ingest depends on kafka (service link)" })).toBeInTheDocument();
    const neededBy = panelSection(panel, "Needed by");
    expect(neededBy).toHaveTextContent("orders_enrich");
    expect(within(neededBy).getByRole("button", { name: "Remove the link: orders_enrich depends on orders_ingest (job link)" })).toBeInTheDocument();

    const affects = panelSection(panel, "Affects");
    expect(within(affects).getByText("A failure here affects 3 jobs.")).toBeInTheDocument();
    const rows = within(affects).getAllByRole("listitem").map((item) => item.textContent);
    expect(rows).toEqual(["orders_enrich1 step", "daily_revenue_report2 steps", "daily_revenue_export3 steps"]);
  });

  it("links the selected job to its history and to the copilot", async () => {
    renderMap();
    fireEvent.click(await box("watchdog_demo_fails (Failed)"));
    const panel = screen.getByRole("region", { name: "watchdog_demo_fails" });
    expect(within(panel).getByRole("link", { name: "View history" })).toHaveAttribute("href", "/jobs/changes?job=watchdog_demo_fails");
    expect(within(panel).getByRole("link", { name: "Ask the copilot" })).toHaveAttribute("href", "/copilot?job=watchdog_demo_fails&status=FAILED");
  });

  it("opens the job editor from the side panel and saves through the job list, then gives focus back to Edit job", async () => {
    const user = userEvent.setup();
    const { saves } = renderMap();
    fireEvent.click(await box("orders_ingest (Unknown, switched off)"));
    const panel = screen.getByRole("region", { name: "orders_ingest" });
    const edit = within(panel).getByRole("button", { name: "Edit job" });
    await user.click(edit);
    expect(await screen.findByRole("heading", { name: "Edit orders_ingest" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Notes"), "Checked by hand.");
    const save = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].baseVersion).toBe(3);
    expect(saves[0].change).toMatchObject({ kind: "upsert", target: { type: "job", name: "orders_ingest" }, value: { job_name: "orders_ingest", notes: "Checked by hand." } });
    expect(await screen.findByText(/^Saved version 4: /)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Edit orders_ingest" })).toBeNull());
    await waitFor(() => expect(within(screen.getByRole("region", { name: "orders_ingest" })).getByRole("button", { name: "Edit job" })).toHaveFocus());
  });

  it("shows a service's name, the jobs that need it with Remove, and its history, with nothing to edit", async () => {
    renderMap();
    fireEvent.click(await box("kafka (service)"));
    const panel = screen.getByRole("region", { name: "kafka" });
    const neededBy = panelSection(panel, "Needed by");
    expect(neededBy).toHaveTextContent("orders_ingest");
    expect(within(neededBy).getByRole("button", { name: "Remove the link: orders_ingest depends on kafka (service link)" })).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "View history" })).toHaveAttribute("href", "/jobs/changes?job=kafka");
    expect(within(panel).queryByRole("button", { name: "Edit job" })).toBeNull();
    expect(within(panel).queryByRole("link", { name: "Ask the copilot" })).toBeNull();
  });

  it("lays the map out top to bottom from the toolbar", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await box("orders_enrich (Unknown, switched off)");
    expect(cornerOf(container, "job:orders_enrich").x).toBeGreaterThan(cornerOf(container, "job:orders_ingest").x + 248);
    await user.click(screen.getByRole("radio", { name: "Top to bottom" }));
    await waitFor(() => expect(cornerOf(container, "job:orders_enrich").y).toBeGreaterThan(cornerOf(container, "job:orders_ingest").y + 68));
    expect(screen.getByRole("radio", { name: "Top to bottom" })).toBeChecked();
  });

  it("hides the services and their links from the toolbar, and shows them again", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await box("kafka (service)");
    const services = screen.getByRole("switch", { name: "Show services" });
    await user.click(services);
    await waitFor(() => expect(screen.queryByRole("button", { name: "kafka (service)" })).toBeNull());
    expect(screen.queryByRole("button", { name: "orders_ingest depends on kafka (service link)" })).toBeNull();
    await waitFor(() => expect(container.querySelectorAll(".react-flow__edge")).toHaveLength(4));
    // The side panel still lists the job's service link: the switch changes the view, not the list.
    fireEvent.click(screen.getByRole("button", { name: "orders_ingest (Unknown, switched off)" }));
    expect(panelSection(screen.getByRole("region", { name: "orders_ingest" }), "Depends on")).toHaveTextContent("kafka");
    await user.click(services);
    expect(await box("kafka (service)")).toBeInTheDocument();
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
    expect(await screen.findByText("The job list did not load.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await box("watchdog_demo_fails (Failed)")).toBeInTheDocument();
  });

  it("settles into its empty state when nothing was ever saved, as the smoke test answers", async () => {
    renderMap({ jobs: [] }, applies, { version: null });
    expect(await screen.findByText("Nothing on the map yet")).toBeInTheDocument();
    expect(screen.queryByText("The job list did not load.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says under the header which version of the job list the scan uses", async () => {
    // Its own minute for the refresh key, so AppKit's query store gives this test its own config_load_latest answer.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T19:30:00Z"));
    const load = {
      loaded_at: "2026-11-05T19:00:00.000Z",
      scan_id: "7",
      source: "lakebase",
      source_ref: "projects/jobs-watchdog/branches/production/databases/watchdog",
      version: "2",
      job_count: "8",
      status: "OK",
      error: null,
    };
    renderMap(EXAMPLE_DOCUMENT, applies, { queries: (call) => (call.key === "config_load_latest" ? { rows: [load] } : null) });
    const banner = await screen.findByText(/^Saved as version/);
    expect(banner).toHaveTextContent("Saved as version 3. The scan is on version 2. It applies at the next scan, or click Scan now in the sidebar.");
    const heading = screen.getByRole("heading", { level: 1, name: "Dependency map" });
    expect(heading.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the conflict when its Reload fails, and says the list did not reload", async () => {
    const user = userEvent.setup();
    const { failLoads } = renderMap(EXAMPLE_DOCUMENT, () =>
      json({ error: "conflict", message: "Someone else changed this since you opened it. Reload to see their change.", latestVersion: 5 }, 409),
    );
    fireEvent.click(await box("orders_enrich depends on orders_ingest (job link)"));
    await user.click(await screen.findByRole("button", { name: "Remove link" }));
    const alert = await screen.findByRole("alert");
    failLoads(true);
    await user.click(within(alert).getByRole("button", { name: "Reload" }));
    expect(await within(alert).findByText("The job list did not reload. The database is waking up.")).toBeInTheDocument();
    expect(within(alert).getByText("Someone else changed the job list since you opened it.")).toBeInTheDocument();

    failLoads(false);
    await user.click(within(alert).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.queryByText("Someone else changed the job list since you opened it.")).toBeNull());
  });

  it("offers Retry when a reload fails, and says the map shows the version loaded before", async () => {
    const user = userEvent.setup();
    const { failLoads } = renderMap(EXAMPLE_DOCUMENT, () =>
      json({ error: "conflict", message: "Someone else changed this since you opened it. Reload to see their change.", latestVersion: 5 }, 409),
    );
    fireEvent.click(await box("orders_enrich depends on orders_ingest (job link)"));
    await user.click(await screen.findByRole("button", { name: "Remove link" }));
    const conflict = await screen.findByRole("alert");
    failLoads(true);
    await user.click(within(conflict).getByRole("button", { name: "Reload" }));
    const stale = await screen.findByText("The newest job list did not load. The database is waking up. The map shows the version loaded before.");
    failLoads(false);
    const line = stale.closest("[role='status']");
    if (!(line instanceof HTMLElement)) throw new Error("no reload problem line");
    await user.click(within(line).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/The newest job list did not load/)).toBeNull());
  });

  it("says why live status is missing as Monitoring does, with Retry", async () => {
    // Its own minute for the refresh key, so AppKit's query store gives this test its own job_live_status answer.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T20:30:00Z"));
    const user = userEvent.setup();
    let failLive = true;
    renderMap(EXAMPLE_DOCUMENT, applies, {
      live: () => (failLive ? { error: "Query execution failed", errorCode: "BAD_REQUEST" } : { rows: LIVE }),
    });
    const title = await screen.findByText("Live status is not available.");
    const line = title.closest("[data-slot='query-problem']");
    if (!(line instanceof HTMLElement)) throw new Error("no problem line");
    expect(line).toHaveTextContent(
      "Live status is not available. The query on main.watchdog failed. If no scan has run yet, click Scan now to create the tables. Otherwise, ask the owner of main.watchdog for USE CATALOG, USE SCHEMA and SELECT on it. Every job shows Unknown until it loads.",
    );
    failLive = false;
    await user.click(within(line).getByRole("button", { name: "Retry" }));
    expect(await box("watchdog_demo_fails (Failed)")).toBeInTheDocument();
    expect(screen.queryByText("Live status is not available.")).toBeNull();
  });
});
