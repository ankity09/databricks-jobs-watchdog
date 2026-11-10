// @vitest-environment jsdom
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FitViewOptions } from "@xyflow/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyChange } from "../../../../shared/joblist/apply";
import type { Change, JobListDocument, JobListState } from "../../../../shared/joblist/types";
import type { LayoutPosition, MapDirection } from "../../../../shared/maplayout/types";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { buildGraph } from "../../lib/graph";
import { type QueryAnswer, type QueryCall, json, mockFetch } from "../../test/analytics-mock";
import { EXAMPLE_DOCUMENT } from "../../test/example-document";
import { mockReactFlow } from "../../test/reactflow-mocks";
import { DependencyMapPage } from "./DependencyMapPage";

const flow = vi.hoisted(() => ({ fitView: vi.fn() }));

// React Flow as it is, with every fitView the map asks for counted, so a test can tell whether the view was fitted again.
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    useReactFlow: () => {
      const instance = actual.useReactFlow();
      return {
        ...instance,
        fitView: (options?: FitViewOptions) => {
          flow.fitView(options);
          return instance.fitView(options);
        },
      };
    },
  };
});

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

/** A save of moved boxes, as the map sends it. */
interface MovesBody {
  direction: MapDirection;
  moves: LayoutPosition[];
}

interface LayoutOptions {
  /** Saved box positions, by direction. */
  layout?: Partial<Record<MapDirection, LayoutPosition[]>>;
  /** The saved positions do not load (503) until failLayout(false). */
  layoutFails?: boolean;
  /** The saved positions wait for releaseLayout() before they answer. */
  layoutWaits?: boolean;
  /** Every save of a move fails (503). */
  movesFail?: boolean;
}

const NOT_READY = { error: "not_ready", message: "The map's database did not answer. Try again in a moment." };
const LOAD_LINE = "Saved positions couldn't load, so the map shows the automatic layout. Moving boxes is off until they load.";

/** The map layout routes, kept as the server keeps them: a move replaces a box's spot, and Tidy up clears the direction. */
function layoutServer(options: LayoutOptions = {}) {
  const saved = new Map<MapDirection, Map<string, LayoutPosition>>();
  for (const direction of ["LR", "TB"] as const) {
    const list = options.layout?.[direction];
    if (list) saved.set(direction, new Map(list.map((position) => [position.nodeKey, position])));
  }
  const layoutSaves: MovesBody[] = [];
  const resets: { direction: MapDirection }[] = [];
  const waiting: Array<() => void> = [];
  let loads = 0;
  let fails = options.layoutFails ?? false;
  const answer = (direction: MapDirection) => (fails ? json(NOT_READY, 503) : json({ direction, positions: [...(saved.get(direction)?.values() ?? [])] }));
  return {
    layoutSaves,
    resets,
    layoutLoads: () => loads,
    failLayout: (fail: boolean) => {
      fails = fail;
    },
    releaseLayout: () => {
      for (const release of waiting.splice(0)) release();
    },
    handle(url: string, init: RequestInit | undefined): Response | Promise<Response> | null {
      const read = /^\/api\/map-layout\?direction=(LR|TB)$/.exec(url);
      if (read && (init?.method ?? "GET") === "GET") {
        loads += 1;
        const direction = read[1] === "TB" ? "TB" : "LR";
        if (!options.layoutWaits) return answer(direction);
        return new Promise<Response>((resolve) => waiting.push(() => resolve(answer(direction))));
      }
      if (url === "/api/map-layout/moves" && init?.method === "POST") {
        const save = JSON.parse(typeof init.body === "string" ? init.body : "null") as MovesBody;
        layoutSaves.push(save);
        if (options.movesFail) return json(NOT_READY, 503);
        const spots = saved.get(save.direction) ?? new Map<string, LayoutPosition>();
        for (const move of save.moves) spots.set(move.nodeKey, move);
        saved.set(save.direction, spots);
        return new Response(null, { status: 204 });
      }
      if (url === "/api/map-layout/reset" && init?.method === "POST") {
        const reset = JSON.parse(typeof init.body === "string" ? init.body : "null") as { direction: MapDirection };
        resets.push(reset);
        saved.delete(reset.direction);
        return new Response(null, { status: 204 });
      }
      return null;
    },
  };
}

interface MapOptions extends LayoutOptions {
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
  const layout = layoutServer(options);
  mockFetch(
    (call) => (call.key === "job_live_status" ? (options.live?.() ?? { rows: LIVE }) : (options.queries?.(call) ?? { rows: [] })),
    (url, init) => {
      const answered = layout.handle(url, init);
      if (answered) return answered;
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
  const page = () => (
    <MemoryRouter>
      <RefreshProvider>
        <TooltipProvider>
          <DependencyMapPage />
        </TooltipProvider>
      </RefreshProvider>
    </MemoryRouter>
  );
  const view = render(page());
  return {
    ...view,
    ...layout,
    saves,
    loads: () => loads,
    /** Opens the page again, as a reload does: the same server, a new map. */
    reload: () => {
      view.unmount();
      return render(page());
    },
    failLoads: (fail: boolean) => {
      loadsFail = fail;
    },
    /** Someone else saves a new version behind the page: the next load returns it. */
    saveBehind: (next: JobListDocument) => {
      state = { ...state, version: (state.version ?? 0) + 1, document: next };
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

/** A box's wrapper on the canvas, which React Flow drags. */
function nodeOf(container: HTMLElement, id: string): HTMLElement {
  const wrapper = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  if (!wrapper) throw new Error(`no box ${id}`);
  return wrapper;
}

/**
 * A mouse event on an element, with the window as its view: d3's drag listens
 * for the move and the release there. jsdom refuses this test's window as a
 * view in the event's options, so it is set on the event itself.
 */
function mouse(type: "mouseDown" | "mouseMove" | "mouseUp", element: Element, clientX: number, clientY: number) {
  const event = createEvent[type](element, { clientX, clientY });
  Object.defineProperty(event, "view", { value: window });
  fireEvent(element, event);
}

/**
 * Drags a box with the mouse, as d3's drag reads it: press on the card, a
 * move that starts the drag (past React Flow's threshold), a move by (dx, dy)
 * from the press, and release. React Flow takes up the box at the first move,
 * so the box moves by half of (dx, dy) on screen.
 */
function dragBox(container: HTMLElement, id: string, dx: number, dy: number) {
  const card = nodeOf(container, id).querySelector("button");
  const canvas = container.querySelector<HTMLElement>(".react-flow");
  if (!card || !canvas) throw new Error(`no card ${id}`);
  // React Flow pans the view while a drag nears the canvas's edge, and jsdom's canvas has no size: give it one, with the
  // pointer well inside it.
  const size = vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1600,
    bottom: 1200,
    width: 1600,
    height: 1200,
    toJSON: () => ({}),
  });
  mouse("mouseDown", card, 800, 600);
  mouse("mouseMove", card, 800 + dx / 2, 600 + dy / 2);
  mouse("mouseMove", card, 800 + dx, 600 + dy);
  mouse("mouseUp", card, 800 + dx, 600 + dy);
  size.mockRestore();
}

/** A box's dot: "Link from <name>" where its links start, "Link to <name>" where they end. */
function dot(name: string): HTMLElement {
  return screen.getByRole("img", { name });
}

/**
 * Drags a new link from a box's dot and drops it on `drop`: another box's dot,
 * or its card. React Flow asks document.elementFromPoint what is under the
 * pointer, which jsdom lacks, so here it answers `drop`. The canvas is put far
 * from the boxes for the drag, so React Flow never snaps to a dot by distance
 * and never pans the view.
 */
function dragLink(container: HTMLElement, from: Element, drop: Element) {
  const canvas = container.querySelector<HTMLElement>(".react-flow");
  if (!canvas) throw new Error("The map has not rendered.");
  const far = 100_000;
  const size = vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    x: -far,
    y: -far,
    left: -far,
    top: -far,
    right: far,
    bottom: far,
    width: 2 * far,
    height: 2 * far,
    toJSON: () => ({}),
  });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => drop });
  try {
    mouse("mouseDown", from, 400, 300);
    mouse("mouseMove", drop, 500, 360);
    mouse("mouseMove", drop, 600, 420);
    mouse("mouseUp", drop, 600, 420);
  } finally {
    Reflect.deleteProperty(document, "elementFromPoint");
    size.mockRestore();
  }
}

/** Where the automatic layout puts a box of the example job list, left to right. */
function automaticSpot(id: string): { x: number; y: number } {
  const spot = buildGraph(EXAMPLE_DOCUMENT, new Map(), { direction: "LR" }).nodes.find((n) => n.id === id)?.position;
  if (!spot) throw new Error(`no box ${id}`);
  return spot;
}

/** Lets React Flow and the map's view keeper run their next frames. */
function frames(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/** A section of the side panel, by its heading. */
function panelSection(panel: HTMLElement, heading: string): HTMLElement {
  const section = within(panel).getByRole("heading", { name: heading }).closest("section");
  if (!(section instanceof HTMLElement)) throw new Error(`no section ${heading}`);
  return section;
}

/** Room for the rounding of a fit or a pan: React Flow's fit can land a pixel off its padding. */
const SUBPIXEL = 1.5;

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
    (await box("orders_enrich depends on orders_ingest (job link)")).focus();
    await user.keyboard("{Enter}");
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
    (await box("orders_ingest depends on kafka (service link)")).focus();
    await user.keyboard("{Enter}");
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

  it("saves a job's settings from the side panel and says so", async () => {
    const user = userEvent.setup();
    const { saves } = renderMap();
    fireEvent.click(await box("watchdog_demo_slow (Unknown)"));
    const panel = screen.getByRole("region", { name: "watchdog_demo_slow" });
    const owner = within(panel).getByRole("textbox", { name: "Owner" });
    await user.type(owner, "data-team");
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].change).toMatchObject({ kind: "upsert", target: { type: "job", name: "watchdog_demo_slow" }, value: { owner: "data-team" } });
    expect(await screen.findByRole("status")).toHaveTextContent(/^Saved version 4/);
  });

  it("a 409 from the side panel shows Reload", async () => {
    const user = userEvent.setup();
    const view = renderMap(EXAMPLE_DOCUMENT, () =>
      json({ error: "conflict", message: "Someone else changed this since you opened it. Reload to see their change.", latestVersion: 4 }, 409),
    );
    fireEvent.click(await box("watchdog_demo_slow (Unknown)"));
    const panel = screen.getByRole("region", { name: "watchdog_demo_slow" });
    await user.type(within(panel).getByRole("textbox", { name: "Owner" }), "data-team");
    await user.click(within(panel).getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Someone else changed the job list since you opened it.")).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(view.saves).toHaveLength(1);
  });

  it("Remove from Watchdog deletes after the confirm and closes the panel", async () => {
    const user = userEvent.setup();
    const { saves } = renderMap();
    fireEvent.click(await box("watchdog_demo_slow (Unknown)"));
    const panel = screen.getByRole("region", { name: "watchdog_demo_slow" });
    await user.click(within(panel).getByRole("button", { name: "Remove from Watchdog" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete watchdog_demo_slow?" });
    expect(saves).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Delete job" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].change).toEqual({ kind: "delete", target: { type: "job", name: "watchdog_demo_slow" } });
    await waitFor(() => expect(screen.queryByRole("region", { name: "watchdog_demo_slow" })).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "watchdog_demo_slow (Unknown)" })).toBeNull();
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

  it("Escape in the side panel's Owner field keeps the panel and what was typed", async () => {
    const user = userEvent.setup();
    renderMap();
    fireEvent.click(await box("watchdog_demo_slow (Unknown)"));
    const panel = screen.getByRole("region", { name: "watchdog_demo_slow" });
    const owner = within(panel).getByRole("textbox", { name: "Owner" });
    await user.type(owner, "data-team");
    await user.keyboard("{Escape}");
    await frames();
    expect(screen.getByRole("region", { name: "watchdog_demo_slow" })).toBe(panel);
    expect(owner).toHaveValue("data-team");
    expect(owner).toHaveFocus();

    // The same from the form's other controls: a switch that was just changed keeps its change.
    const monitored = within(panel).getByRole("switch", { name: "Monitored" });
    expect(monitored).toBeChecked();
    await user.click(monitored);
    expect(monitored).not.toBeChecked();
    expect(monitored).toHaveFocus();
    await user.keyboard("{Escape}");
    await frames();
    expect(screen.getByRole("region", { name: "watchdog_demo_slow" })).toBe(panel);
    expect(monitored).not.toBeChecked();
    expect(owner).toHaveValue("data-team");
  });

  it("Escape in the side panel's Severity list closes only the list, and the panel keeps the typed owner", async () => {
    const user = userEvent.setup();
    renderMap();
    fireEvent.click(await box("watchdog_demo_slow (Unknown)"));
    const panel = screen.getByRole("region", { name: "watchdog_demo_slow" });
    const owner = within(panel).getByRole("textbox", { name: "Owner" });
    await user.type(owner, "data-team");
    const severity = within(panel).getByRole("combobox", { name: "Severity" });
    await user.click(severity);
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    await frames();
    expect(screen.getByRole("region", { name: "watchdog_demo_slow" })).toBe(panel);
    expect(owner).toHaveValue("data-team");
    await waitFor(() => expect(severity).toHaveFocus());
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

  it("keeps a fit clear of the side panel while it is open, and moves the map only to bring a selection and its chain out from under it", async () => {
    const { container } = renderMap();
    await box("watchdog_demo_fails (Failed)");
    resizeMap(container, 1400, 800);
    await waitFor(() => expect(boxesOnScreen(container).zoom).toBeGreaterThan(0.4));
    const before = boxesOnScreen(container);
    // The panel is 360 pixels wide, 12 from the edge, and the map keeps 16 more clear of it.
    const panelEdge = 1400 - 388;
    expect(before.right).toBeGreaterThan(panelEdge);

    // A box whose chain is all on the left: selecting it opens the panel and leaves the view where it was.
    fireEvent.click(screen.getByRole("button", { name: "watchdog_demo_fails (Failed)" }));
    await screen.findByRole("region", { name: "watchdog_demo_fails" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(boxesOnScreen(container)).toEqual(before);

    // orders_enrich's chain ends under the panel: the map moves left at the same zoom until the chain clears the panel.
    expect(boxOnScreen(container, "job:daily_revenue_export").right).toBeGreaterThan(panelEdge);
    fireEvent.click(screen.getByRole("button", { name: "orders_enrich (Unknown, switched off)" }));
    await screen.findByRole("region", { name: "orders_enrich" });
    // The shift is the overlap, so the chain's last box ends at the panel's edge, and the selected box stays on screen.
    await waitFor(() => expect(boxOnScreen(container, "job:daily_revenue_export").right).toBeLessThanOrEqual(panelEdge + SUBPIXEL));
    expect(boxOnScreen(container, "job:orders_enrich").left).toBeGreaterThanOrEqual(24 - SUBPIXEL);
    expect(boxesOnScreen(container).zoom).toBe(before.zoom);

    // From a fresh fit, the last box of the chain, selected under the panel, comes out too.
    fireEvent.click(screen.getByRole("button", { name: "orders_enrich (Unknown, switched off)" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "orders_enrich" })).toBeNull());
    resizeMap(container, 1400, 790);
    await waitFor(() => expect(boxesOnScreen(container).left).toBeGreaterThanOrEqual(24 - SUBPIXEL));
    expect(boxOnScreen(container, "job:daily_revenue_export").right).toBeGreaterThan(panelEdge);
    fireEvent.click(screen.getByRole("button", { name: "daily_revenue_export (Unknown, switched off)" }));
    await screen.findByRole("region", { name: "daily_revenue_export" });
    await waitFor(() => expect(boxOnScreen(container, "job:daily_revenue_export").right).toBeLessThanOrEqual(panelEdge + SUBPIXEL));
    expect(boxOnScreen(container, "job:daily_revenue_export").left).toBeGreaterThanOrEqual(24 - SUBPIXEL);

    // A refit while the panel is open (an alert above the map took some height) keeps the zoom of a fit without the
    // panel: it never zooms for the panel. It only slides the chain clear of the panel again.
    expect(boxesOnScreen(container).left).toBeLessThan(24);
    resizeMap(container, 1400, 760);
    await waitFor(() => expect(boxOnScreen(container, "job:daily_revenue_export").right).toBeLessThanOrEqual(panelEdge + SUBPIXEL));
    expect(boxesOnScreen(container).zoom).toBeCloseTo(before.zoom, 6);

    // Closing the panel slides the map back to the fit: all of it on screen, at the same zoom.
    fireEvent.click(within(screen.getByRole("region", { name: "daily_revenue_export" })).getByRole("button", { name: "Clear the selection" }));
    await waitFor(() => {
      const shown = boxesOnScreen(container);
      expect(shown.left).toBeGreaterThanOrEqual(24 - SUBPIXEL);
      expect(shown.right).toBeLessThanOrEqual(1400 - 24 + SUBPIXEL);
    });
    expect(boxesOnScreen(container).zoom).toBeCloseTo(before.zoom, 6);
  });

  it("keeps the zoom of a fit without the panel when a save refits the map with the panel open", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    await box("orders_ingest (Unknown, switched off)");
    resizeMap(container, 1400, 800);
    await waitFor(() => expect(boxesOnScreen(container).zoom).toBeGreaterThan(0.4));
    const fitted = boxesOnScreen(container).zoom;
    fireEvent.click(screen.getByRole("button", { name: "orders_ingest (Unknown, switched off)" }));
    const panel = await screen.findByRole("region", { name: "orders_ingest" });
    // Remove a link in the panel: the save moves the boxes, so the map refits while the panel is open.
    await user.click(within(panel).getByRole("button", { name: "Remove the link: orders_enrich depends on orders_ingest (job link)" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "orders_enrich depends on orders_ingest (job link)" })).toBeNull());
    await waitFor(() => expect(boxesOnScreen(container).zoom).not.toBe(fitted));
    // The new layout's own fit, as with the panel closed: the space under the panel still counts.
    const shown = boxesOnScreen(container);
    expect(shown.right).toBeGreaterThan(1400 - 388);
    expect(shown.right).toBeLessThanOrEqual(1400 - 24 + SUBPIXEL);
    expect(screen.getByRole("region", { name: "orders_ingest" })).toBeInTheDocument();
  });

  it("keeps the selection and the panel when the layout direction changes", async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    const ingest = await box("orders_ingest (Unknown, switched off)");
    resizeMap(container, 1400, 800);
    fireEvent.click(ingest);
    await screen.findByRole("region", { name: "orders_ingest" });
    await user.click(screen.getByRole("radio", { name: "Top to bottom" }));
    await waitFor(() => expect(cornerOf(container, "job:orders_enrich").y).toBeGreaterThan(cornerOf(container, "job:orders_ingest").y + 68));
    expect(screen.getByRole("region", { name: "orders_ingest" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "orders_ingest (Unknown, switched off)" })).toHaveAttribute("data-highlight", "selected");
    expect(line("orders_enrich depends on orders_ingest (job link)")).toHaveAttribute("data-highlight", "downstream");
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
    // The owner, then the schedule; the whole line is also in the card's tooltip.
    expect(part(fails, "meta")).toHaveTextContent("platform-team · Scheduled");
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
    expect(part(ingest, "meta")).toHaveTextContent("ingestion-team · Continuous");
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
      // Faded, but its focus ring is not: a faded card with keyboard focus shows at full strength.
      expect(screen.getByRole("button", { name })).toHaveClass("opacity-35", "focus-visible:opacity-100");
    }
    // The child tag and the Affected chip keep the accent as an outline, with text in the foreground color (10 px #FF3621 on white is 3.6:1).
    const childTag = part(screen.getByRole("button", { name: "daily_revenue_export depends on daily_revenue_report (child job link)" }), "edge-tag");
    expect(childTag?.querySelector("text")).toHaveClass("fill-foreground");
    expect(childTag?.querySelector("rect")).toHaveClass("stroke-primary");
    expect(part(screen.getByRole("button", { name: "daily_revenue_report (Unknown, switched off)" }), "affected")).toHaveClass("text-foreground", "border-primary");

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

    expect(within(panel).getByRole("textbox", { name: "Owner" })).toHaveValue("ingestion-team");
    expect(within(panel).getByRole("radio", { name: "Continuous" })).toBeChecked();
    expect(within(panel).getByRole("combobox", { name: "Severity" })).toHaveTextContent("CRITICAL");
    expect(within(panel).getByRole("textbox", { name: /Max gap/ })).toHaveValue("");
    expect(within(panel).getByRole("textbox", { name: "Max retries" })).toHaveValue("3");
    expect(within(panel).getByRole("switch", { name: "Monitored" })).not.toBeChecked();

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

  it("says when a job depends on nothing, and gives a job that is not in the list a question-mark tile", async () => {
    renderMap({ jobs: [{ job_name: "orders_report" }], dependencies: [{ job_name: "orders_report", depends_on: "orders_feed" }] });
    fireEvent.click(await box("orders_report (Unknown)"));
    expect(within(panelSection(screen.getByRole("region", { name: "orders_report" }), "Depends on")).queryByText("It depends on nothing.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "orders_feed (not in the job list)" }));
    const missing = screen.getByRole("region", { name: "orders_feed" });
    expect(within(panelSection(missing, "Depends on")).getByText("It depends on nothing.")).toBeInTheDocument();
    expect(missing).toHaveTextContent("Not in the job list");
    expect(part(missing, "tile")?.querySelector("svg")).not.toBeNull();
  });

  it("shows the schedule icons in the legend", async () => {
    renderMap();
    await box("watchdog_demo_fails (Failed)");
    const schedules = within(screen.getByRole("group", { name: "Legend" })).getByRole("list", { name: "Schedule" });
    expect(within(schedules).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Scheduled", "Continuous", "Triggered"]);
    for (const item of within(schedules).getAllByRole("listitem")) expect(item.querySelector("svg")).not.toBeNull();
  });

  it("closes the job editor and says so when a reload shows the job is gone", async () => {
    const user = userEvent.setup();
    const { saveBehind } = renderMap(EXAMPLE_DOCUMENT, () =>
      json({ error: "conflict", message: "Someone else changed this since you opened it. Reload to see their change.", latestVersion: 4 }, 409),
    );
    fireEvent.click(await box("watchdog_demo_slow (Unknown)"));
    await user.click(within(screen.getByRole("region", { name: "watchdog_demo_slow" })).getByRole("button", { name: "Edit job" }));
    await screen.findByRole("heading", { name: "Edit watchdog_demo_slow" });
    await user.type(screen.getByLabelText("Notes"), "Checked by hand.");
    // Someone deletes the job meanwhile: the save gets a conflict, and its Reload loads the list without it.
    saveBehind({ ...EXAMPLE_DOCUMENT, jobs: EXAMPLE_DOCUMENT.jobs.filter((job) => job.job_name !== "watchdog_demo_slow") });
    const save = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await user.click(await screen.findByRole("button", { name: "Reload" }));
    expect(await screen.findByText("watchdog_demo_slow is no longer in the list. Someone deleted it while you were editing.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Edit watchdog_demo_slow" })).toBeNull());
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/is no longer in the list/)).toBeNull();
  });

  it("opens the side panel under a narrow map, so the selection's chain stays in view", async () => {
    const { container } = renderMap();
    await box("orders_enrich (Unknown, switched off)");
    resizeMap(container, 600, 900);
    // The refit for the narrow map: the map's width, less 24 pixels on each side.
    await waitFor(() => {
      const shown = boxesOnScreen(container);
      expect(shown.right - shown.left).toBeGreaterThan(600 - 48 - SUBPIXEL);
      expect(shown.right).toBeLessThanOrEqual(600 - 24 + SUBPIXEL);
    });
    const before = boxesOnScreen(container);
    fireEvent.click(screen.getByRole("button", { name: "orders_enrich (Unknown, switched off)" }));
    const panel = await screen.findByRole("region", { name: "orders_enrich" });
    expect(panel.closest(".react-flow")).toBeNull();
    expect(panel.compareDocumentPosition(container.querySelector(".react-flow") as Node) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(boxesOnScreen(container)).toEqual(before);

    // Back on a wide map, it opens over the map again.
    resizeMap(container, 1400, 800);
    await waitFor(() => expect(screen.getByRole("region", { name: "orders_enrich" }).closest(".react-flow")).not.toBeNull());
  });

  it("links the selected job to its history and to the copilot", async () => {
    renderMap();
    fireEvent.click(await box("watchdog_demo_fails (Failed)"));
    const panel = screen.getByRole("region", { name: "watchdog_demo_fails" });
    expect(within(panelSection(panel, "Depends on")).getByText("It depends on nothing.")).toBeInTheDocument();
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
    // Removed with the × of the selected line, which stays when the save is refused.
    fireEvent.click(await box("orders_enrich depends on orders_ingest (job link)"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove the link: orders_enrich depends on orders_ingest (job link)" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Someone else changed the job list since you opened it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "orders_enrich depends on orders_ingest (job link)" })).toBeInTheDocument();
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
    (await box("orders_enrich depends on orders_ingest (job link)")).focus();
    await user.keyboard("{Enter}");
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
    const layout = layoutServer();
    mockFetch(
      () => ({ rows: [] }),
      (url, init) => {
        const answered = layout.handle(url, init);
        if (answered) return answered;
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
    (await box("orders_enrich depends on orders_ingest (job link)")).focus();
    await user.keyboard("{Enter}");
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
    (await box("orders_enrich depends on orders_ingest (job link)")).focus();
    await user.keyboard("{Enter}");
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

  it("a drag saves one move per moved box and never calls saveChange", async () => {
    const { container, saves, layoutSaves } = renderMap();
    await box("orders_ingest (Unknown, switched off)");
    const start = cornerOf(container, "job:orders_ingest");
    dragBox(container, "job:orders_ingest", 120, 80);
    await waitFor(() => expect(layoutSaves).toHaveLength(1));
    const dropped = cornerOf(container, "job:orders_ingest");
    expect(dropped).not.toEqual(start);
    // The spot saved is where the box was dropped.
    expect(layoutSaves[0]).toEqual({ direction: "LR", moves: [{ nodeKey: "job:orders_ingest", ...dropped }] });

    // A second box: a save of its own, with only that box in it.
    dragBox(container, "service:kafka", -60, 40);
    await waitFor(() => expect(layoutSaves).toHaveLength(2));
    expect(layoutSaves[1]).toEqual({ direction: "LR", moves: [{ nodeKey: "service:kafka", ...cornerOf(container, "service:kafka") }] });
    expect(cornerOf(container, "job:orders_ingest")).toEqual(dropped);
    expect(saves).toEqual([]);
  });

  it("a press under 4 px opens the panel and saves nothing", async () => {
    const { container, saves, layoutSaves } = renderMap();
    const ingest = await box("orders_ingest (Unknown, switched off)");
    // The box can be dragged, yet a press that wobbles a few pixels is still a click.
    expect(nodeOf(container, "job:orders_ingest")).toHaveClass("draggable");
    const start = cornerOf(container, "job:orders_ingest");
    mouse("mouseDown", ingest, 300, 300);
    mouse("mouseMove", ingest, 303, 302);
    mouse("mouseUp", ingest, 303, 302);
    fireEvent.click(ingest, { clientX: 303, clientY: 302 });
    expect(await screen.findByRole("region", { name: "orders_ingest" })).toBeInTheDocument();
    expect(cornerOf(container, "job:orders_ingest")).toEqual(start);
    await frames();
    expect(layoutSaves).toEqual([]);
    expect(saves).toEqual([]);
  });

  it("a clicked box takes focus, so the arrow keys move it after a click in any browser", async () => {
    const user = userEvent.setup();
    const { container, layoutSaves } = renderMap();
    const ingest = await box("orders_ingest (Unknown, switched off)");
    const start = cornerOf(container, "job:orders_ingest");
    // fireEvent.click focuses nothing, like a click in Safari or in Firefox on macOS: the map focuses the box itself.
    fireEvent.click(ingest);
    await screen.findByRole("region", { name: "orders_ingest" });
    expect(ingest).toHaveFocus();
    // The arrow key goes to what has focus.
    await user.keyboard("{ArrowRight}");
    expect(cornerOf(container, "job:orders_ingest")).toEqual({ x: start.x + 10, y: start.y });
    await waitFor(() => expect(layoutSaves).toEqual([{ direction: "LR", moves: [{ nodeKey: "job:orders_ingest", x: start.x + 10, y: start.y }] }]));
  });

  it("arrow keys move the selected box and save once after 600 ms", async () => {
    const { container, saves, layoutSaves } = renderMap();
    const ingest = await box("orders_ingest (Unknown, switched off)");
    fireEvent.click(ingest);
    await screen.findByRole("region", { name: "orders_ingest" });
    const start = cornerOf(container, "job:orders_ingest");

    // Fake time: each wait also runs the promises it lets go, so a save that went out would be in layoutSaves.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    fireEvent.keyDown(ingest, { key: "ArrowRight" });
    await wait(400);
    fireEvent.keyDown(ingest, { key: "ArrowRight" });
    await wait(400);
    // 800 ms after the first key, but only 400 after the last: nothing is saved yet.
    expect(layoutSaves).toEqual([]);
    // Shift moves 50 pixels.
    fireEvent.keyDown(ingest, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(ingest, { key: "ArrowLeft" });
    const moved = { x: start.x + 10, y: start.y + 50 };
    expect(cornerOf(container, "job:orders_ingest")).toEqual(moved);
    await wait(599);
    expect(layoutSaves).toEqual([]);
    // 600 ms after the last key: one save, with where the keys left the box.
    await wait(1);
    expect(layoutSaves).toEqual([{ direction: "LR", moves: [{ nodeKey: "job:orders_ingest", ...moved }] }]);
    await wait(2000);
    expect(layoutSaves).toHaveLength(1);
    vi.useRealTimers();
    expect(cornerOf(container, "job:orders_ingest")).toEqual(moved);
    expect(saves).toEqual([]);
  });

  it("arrow keys in the side panel's inputs do not move the box", async () => {
    const { container, layoutSaves } = renderMap();
    const ingest = await box("orders_ingest (Unknown, switched off)");
    fireEvent.click(ingest);
    const panel = await screen.findByRole("region", { name: "orders_ingest" });
    const start = cornerOf(container, "job:orders_ingest");
    // Things a person types in: a text box, a text area, a list and editable text.
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const fields = [document.createElement("input"), document.createElement("textarea"), document.createElement("select"), editable];
    panel.append(...fields);
    for (const field of fields) {
      fireEvent.keyDown(field, { key: "ArrowRight" });
      fireEvent.keyDown(field, { key: "ArrowDown", shiftKey: true });
    }
    expect(cornerOf(container, "job:orders_ingest")).toEqual(start);

    // The same key on the box moves it.
    fireEvent.keyDown(ingest, { key: "ArrowRight" });
    expect(cornerOf(container, "job:orders_ingest")).toEqual({ x: start.x + 10, y: start.y });
    await waitFor(() => expect(layoutSaves).toHaveLength(1));
    for (const field of fields) field.remove();
  });

  it("arrow keys on the side panel's buttons and on the toolbar do not move the box", async () => {
    const { container, layoutSaves } = renderMap();
    const ingest = await box("orders_ingest (Unknown, switched off)");
    fireEvent.click(ingest);
    const panel = await screen.findByRole("region", { name: "orders_ingest" });
    const start = cornerOf(container, "job:orders_ingest");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // ArrowDown on a panel button is left to the panel, which scrolls: the map does not take the key.
    expect(fireEvent.keyDown(within(panel).getByRole("button", { name: "Edit job" }), { key: "ArrowDown" })).toBe(true);
    const remove = within(panel).getByRole("button", { name: "Remove the link: orders_enrich depends on orders_ingest (job link)" });
    expect(fireEvent.keyDown(remove, { key: "ArrowDown", shiftKey: true })).toBe(true);
    // Shift and an arrow on the direction toggle, which the toggle leaves alone, and an arrow on a zoom button.
    fireEvent.keyDown(screen.getByRole("radio", { name: "Left to right" }), { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(screen.getByRole("button", { name: "Zoom in" }), { key: "ArrowUp" });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    vi.useRealTimers();
    expect(cornerOf(container, "job:orders_ingest")).toEqual(start);
    expect(layoutSaves).toEqual([]);
  });

  it("keys typed in the side panel's Owner field move no box, remove no line and undo nothing", async () => {
    const user = userEvent.setup();
    const { container, saves, layoutSaves, resets } = renderMap();
    await box("watchdog_demo_slow (Unknown)");
    // Something for Undo to take back: a box moved by a drag.
    dragBox(container, "job:orders_ingest", 120, 80);
    await waitFor(() => expect(layoutSaves).toHaveLength(1));
    // A selected box with its panel open, and a selected line with its ×: the keys below would move the one and remove the other.
    fireEvent.click(screen.getByRole("button", { name: "watchdog_demo_slow (Unknown)" }));
    const panel = await screen.findByRole("region", { name: "watchdog_demo_slow" });
    const linkName = "orders_enrich depends on orders_ingest (job link)";
    fireEvent.click(screen.getByRole("button", { name: linkName }));
    expect(await screen.findByRole("button", { name: `Remove the link: ${linkName}` })).toBeInTheDocument();
    const ids = ["job:watchdog_demo_slow", "job:orders_ingest"];
    const corners = ids.map((id) => cornerOf(container, id));

    const owner = within(panel).getByRole("textbox", { name: "Owner" });
    await user.type(owner, "ops team");
    await user.keyboard("{ArrowLeft}{ArrowRight}{ArrowUp}{Shift>}{ArrowDown}{/Shift}");
    await user.keyboard("{Delete}{Backspace}");
    // As in a browser, Ctrl+Z and Cmd+Z reach the window listener from the field; user-event would type the z with Meta.
    fireEvent.keyDown(owner, { key: "z", ctrlKey: true });
    fireEvent.keyDown(owner, { key: "z", metaKey: true });
    await frames();

    // The field took the keys: Backspace removed the last letter.
    expect(owner).toHaveValue("ops tea");
    expect(owner).toHaveFocus();
    expect(ids.map((id) => cornerOf(container, id))).toEqual(corners);
    expect(screen.getByRole("button", { name: linkName })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Remove the link: ${linkName}` })).toBeInTheDocument();
    expect(layoutSaves).toHaveLength(1);
    expect(resets).toEqual([]);
    expect(saves).toEqual([]);
    expect(screen.getByRole("button", { name: "Undo: move 1 box" })).toBeInTheDocument();
  });

  it("saves a key move still waiting under its own direction when the direction changes", async () => {
    const { container, layoutSaves } = renderMap();
    const ingest = await box("orders_ingest (Unknown, switched off)");
    fireEvent.click(ingest);
    await screen.findByRole("region", { name: "orders_ingest" });
    const start = cornerOf(container, "job:orders_ingest");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.keyDown(ingest, { key: "ArrowRight" });
    // Top to bottom well before the 600 ms are up: the move is saved now, for left to right.
    fireEvent.click(screen.getByRole("radio", { name: "Top to bottom" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(layoutSaves).toEqual([{ direction: "LR", moves: [{ nodeKey: "job:orders_ingest", x: start.x + 10, y: start.y }] }]);
    // And only once: nothing more goes out after the wait, for either direction.
    await act(() => vi.advanceTimersByTimeAsync(1000));
    vi.useRealTimers();
    expect(layoutSaves).toHaveLength(1);
    await waitFor(() => expect(cornerOf(container, "job:orders_enrich").y).toBeGreaterThan(cornerOf(container, "job:orders_ingest").y + 68));
  });

  it("saves a key move still waiting when the page closes", async () => {
    const { container, layoutSaves, unmount } = renderMap();
    const ingest = await box("orders_ingest (Unknown, switched off)");
    fireEvent.click(ingest);
    await screen.findByRole("region", { name: "orders_ingest" });
    const start = cornerOf(container, "job:orders_ingest");
    fireEvent.keyDown(ingest, { key: "ArrowDown", shiftKey: true });
    unmount();
    // Saved as the page goes, well before the 600 ms wait would have saved it.
    await waitFor(() => expect(layoutSaves).toEqual([{ direction: "LR", moves: [{ nodeKey: "job:orders_ingest", x: start.x, y: start.y + 50 }] }]), {
      timeout: 300,
    });
  });

  it("a drag does not refit the view", async () => {
    const { container, layoutSaves } = renderMap();
    await box("orders_ingest (Unknown, switched off)");
    resizeMap(container, 1400, 800);
    await waitFor(() => expect(boxesOnScreen(container).zoom).toBeGreaterThan(0.4));
    await frames();
    flow.fitView.mockClear();
    const view = container.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform;

    // Far enough that a fit of the new spots would change the view.
    dragBox(container, "job:orders_ingest", 400, 300);
    await waitFor(() => expect(layoutSaves).toHaveLength(1));
    await frames();
    expect(flow.fitView).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform).toBe(view);
  });

  it("when positions fail to load, boxes cannot be dragged and Retry loads them", async () => {
    const user = userEvent.setup();
    const { container, layoutSaves, failLayout } = renderMap(EXAMPLE_DOCUMENT, applies, {
      layout: { LR: [{ nodeKey: "job:orders_ingest", x: 2000, y: 1200 }] },
      layoutFails: true,
    });
    const ingest = await box("orders_ingest (Unknown, switched off)");
    const line = (await screen.findByText(LOAD_LINE)).closest("[role='status']");
    if (!(line instanceof HTMLElement)) throw new Error("no layout problem line");
    // The automatic layout, with moving off: no arrow keys, no drag, no Tidy up.
    expect(cornerOf(container, "job:orders_ingest")).toEqual(automaticSpot("job:orders_ingest"));
    expect(nodeOf(container, "job:orders_ingest")).not.toHaveClass("draggable");
    fireEvent.click(ingest);
    fireEvent.keyDown(ingest, { key: "ArrowRight" });
    dragBox(container, "job:orders_ingest", 200, 100);
    await frames();
    expect(cornerOf(container, "job:orders_ingest")).toEqual(automaticSpot("job:orders_ingest"));
    expect(screen.getByRole("button", { name: "Tidy up" })).toHaveAttribute("aria-disabled", "true");

    failLayout(false);
    await user.click(within(line).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(cornerOf(container, "job:orders_ingest")).toEqual({ x: 2000, y: 1200 }));
    expect(screen.queryByText(LOAD_LINE)).toBeNull();
    expect(nodeOf(container, "job:orders_ingest")).toHaveClass("draggable");
    expect(layoutSaves).toEqual([]);
  });

  it("Tidy up resets and lays the map out again", async () => {
    const user = userEvent.setup();
    const { container, resets } = renderMap(EXAMPLE_DOCUMENT, applies, { layout: { LR: [{ nodeKey: "job:orders_ingest", x: 2000, y: 1200 }] } });
    await box("orders_ingest (Unknown, switched off)");
    expect(cornerOf(container, "job:orders_ingest")).toEqual({ x: 2000, y: 1200 });
    await frames();
    flow.fitView.mockClear();

    const tidy = screen.getByRole("button", { name: "Tidy up" });
    expect(tidy).not.toHaveAttribute("aria-disabled");
    await user.click(tidy);
    await waitFor(() => expect(cornerOf(container, "job:orders_ingest")).toEqual(automaticSpot("job:orders_ingest")));
    expect(resets).toEqual([{ direction: "LR" }]);
    // The view fits the automatic layout, and with nothing saved Tidy up is off.
    await waitFor(() => expect(flow.fitView).toHaveBeenCalled());
    expect(tidy).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps a dragged box where it was dropped after a reload", async () => {
    const { container, layoutSaves, reload } = renderMap();
    await box("orders_ingest (Unknown, switched off)");
    dragBox(container, "job:orders_ingest", 160, 120);
    await waitFor(() => expect(layoutSaves).toHaveLength(1));
    const dropped = cornerOf(container, "job:orders_ingest");
    expect(dropped).not.toEqual(automaticSpot("job:orders_ingest"));

    const again = reload();
    await box("orders_ingest (Unknown, switched off)");
    expect(cornerOf(again.container, "job:orders_ingest")).toEqual(dropped);
  });

  it("puts a box back and says so when its move can't be saved", async () => {
    const { container } = renderMap(EXAMPLE_DOCUMENT, applies, { movesFail: true });
    await box("orders_ingest (Unknown, switched off)");
    const start = cornerOf(container, "job:orders_ingest");
    dragBox(container, "job:orders_ingest", 150, 90);
    expect(await screen.findByText("That move couldn't be saved, so the box went back.")).toBeInTheDocument();
    expect(cornerOf(container, "job:orders_ingest")).toEqual(start);
  });

  it("takes a box out of the Not linked yet group once it is dragged", async () => {
    const { container, layoutSaves } = renderMap();
    await box("watchdog_demo_slow (Unknown)");
    const group = () => container.querySelector<HTMLElement>(".react-flow__node-section");
    expect(group()).toHaveTextContent("2 jobs");
    dragBox(container, "job:watchdog_demo_slow", 0, -400);
    await waitFor(() => expect(layoutSaves).toHaveLength(1));
    await waitFor(() => expect(group()).toHaveTextContent("1 job"));
    expect(group()).not.toHaveTextContent("2 jobs");
  });

  it("shows card skeletons, not boxes, until the saved positions load", async () => {
    const { container, releaseLayout } = renderMap(EXAMPLE_DOCUMENT, applies, {
      layout: { LR: [{ nodeKey: "job:orders_ingest", x: 2000, y: 1200 }] },
      layoutWaits: true,
    });
    // The job list is in, so the toolbar is there; the boxes wait for their spots.
    expect(await screen.findByRole("button", { name: "Tidy up" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: "orders_ingest (Unknown, switched off)" })).toBeNull();
    expect(container.querySelector(".react-flow")).toBeNull();
    releaseLayout();
    await box("orders_ingest (Unknown, switched off)");
    expect(cornerOf(container, "job:orders_ingest")).toEqual({ x: 2000, y: 1200 });
  });

  it("dropping a link opens the New link card and Save link saves one dependency upsert", async () => {
    const user = userEvent.setup();
    const { container, saves } = renderMap();
    const retries = await box("watchdog_demo_retries (Unknown)");
    // From the dot where watchdog_demo_slow's links start, dropped on watchdog_demo_retries's card.
    dragLink(container, dot("Link from watchdog_demo_slow"), retries);
    const card = await screen.findByRole("dialog", { name: "New link" });
    expect(card).toHaveAccessibleDescription("watchdog_demo_retries depends on watchdog_demo_slow.");
    expect(within(card).getByRole("radio", { name: /^Job/ })).toBeChecked();
    expect(saves).toEqual([]);

    await user.click(within(card).getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toEqual({
      baseVersion: 3,
      change: {
        kind: "upsert",
        target: { type: "dependency", key: "watchdog_demo_retries->watchdog_demo_slow:job" },
        value: { job_name: "watchdog_demo_retries", depends_on: "watchdog_demo_slow", dependency_type: "job" },
      },
    });
    // The line is drawn and the card goes.
    expect(await box("watchdog_demo_retries depends on watchdog_demo_slow (job link)")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New link" })).toBeNull());
    expect(saves).toHaveLength(1);
  });

  it("saves a dragged link the right way round, from either dot and with a service", async () => {
    const user = userEvent.setup();
    const { container, saves } = renderMap();
    const slow = await box("watchdog_demo_slow (Unknown)");
    // From the dot where watchdog_demo_retries's links end, dropped on watchdog_demo_slow: watchdog_demo_retries depends on it.
    dragLink(container, dot("Link to watchdog_demo_retries"), slow);
    let card = await screen.findByRole("dialog", { name: "New link" });
    expect(card).toHaveAccessibleDescription("watchdog_demo_retries depends on watchdog_demo_slow.");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New link" })).toBeNull());

    // From a job to a service: the job needs the service, and there is no type to choose.
    dragLink(container, dot("Link from watchdog_demo_slow"), screen.getByRole("button", { name: "kafka (service)" }));
    card = await screen.findByRole("dialog", { name: "New link" });
    expect(card).toHaveAccessibleDescription("watchdog_demo_slow depends on kafka.");
    expect(within(card).queryByRole("radio")).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].change).toEqual({
      kind: "upsert",
      target: { type: "dependency", key: "watchdog_demo_slow->kafka:service" },
      value: { job_name: "watchdog_demo_slow", depends_on: "kafka", dependency_type: "service" },
    });
  });

  it("a refused drop shows the reason and saves nothing", async () => {
    const user = userEvent.setup();
    const { container, saves } = renderMap();
    const enrich = await box("orders_enrich (Unknown, switched off)");
    // orders_enrich already depends on orders_ingest.
    dragLink(container, dot("Link from orders_ingest"), enrich);
    let card = await screen.findByRole("dialog", { name: "New link" });
    expect(card).toHaveAccessibleDescription("These two are already linked.");
    // Only Close: nothing to choose, nothing to save.
    expect(within(card).getAllByRole("button").map((button) => button.textContent)).toEqual(["Close"]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New link" })).toBeNull());

    // Two services, dropped dot on dot.
    dragLink(container, dot("Link from kafka"), dot("Link to config_api"));
    card = await screen.findByRole("dialog", { name: "New link" });
    expect(card).toHaveAccessibleDescription("Two services can't be linked.");
    await user.click(within(card).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New link" })).toBeNull());
    expect(saves).toEqual([]);
  });

  it("a drop on the box it started from opens nothing", async () => {
    const { container, saves } = renderMap();
    const slow = await box("watchdog_demo_slow (Unknown)");
    dragLink(container, dot("Link from watchdog_demo_slow"), dot("Link to watchdog_demo_slow"));
    dragLink(container, dot("Link from watchdog_demo_slow"), slow);
    await frames();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saves).toEqual([]);
  });

  it("a 409 on a dragged link shows Reload and keeps the card open", async () => {
    const user = userEvent.setup();
    let refuse = true;
    const view = renderMap(EXAMPLE_DOCUMENT, (body, state) => {
      if (!refuse) return applies(body, state);
      refuse = false;
      return json({ error: "conflict", message: "Someone else changed this since you opened it. Reload to see their change.", latestVersion: 4 }, 409);
    });
    await box("watchdog_demo_retries (Unknown)");
    // Someone else saves version 4 while the map shows version 3.
    view.saveBehind({ ...EXAMPLE_DOCUMENT, defaults: { ...EXAMPLE_DOCUMENT.defaults, owner: "data-team" } });
    dragLink(view.container, dot("Link from watchdog_demo_slow"), dot("Link to watchdog_demo_retries"));
    const card = await screen.findByRole("dialog", { name: "New link" });
    await user.click(within(card).getByRole("radio", { name: /Child job/ }));
    await user.type(within(card).getByRole("textbox", { name: "Notes (optional)" }), "Its last task");
    await user.click(within(card).getByRole("button", { name: "Save link" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Someone else changed the job list since you opened it.")).toBeInTheDocument();
    // The card stays with its choices, and the link is not drawn.
    expect(screen.getByRole("dialog", { name: "New link" })).toBe(card);
    expect(within(card).getByRole("radio", { name: /Child job/ })).toBeChecked();
    expect(within(card).getByRole("textbox", { name: "Notes (optional)" })).toHaveValue("Its last task");
    expect(screen.queryByRole("button", { name: /^watchdog_demo_retries depends on watchdog_demo_slow/ })).toBeNull();

    // Reload leaves the card open, so the link saves from the newest version.
    await user.click(within(alert).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("dialog", { name: "New link" })).toBe(card);
    await user.click(within(card).getByRole("button", { name: "Save link" }));
    await waitFor(() => expect(view.saves).toHaveLength(2));
    expect(view.saves.map((save) => save.baseVersion)).toEqual([3, 4]);
    expect(view.saves[1].change).toEqual({
      kind: "upsert",
      target: { type: "dependency", key: "watchdog_demo_retries->watchdog_demo_slow:child_job" },
      value: { job_name: "watchdog_demo_retries", depends_on: "watchdog_demo_slow", dependency_type: "child_job", notes: "Its last task" },
    });
    expect(await box("watchdog_demo_retries depends on watchdog_demo_slow (child job link)")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New link" })).toBeNull());
  });

  it("a selected line shows × and × removes it", async () => {
    const { saves } = renderMap();
    const link = await box("orders_enrich depends on orders_ingest (job link)");
    const remove = "Remove the link: orders_enrich depends on orders_ingest (job link)";
    expect(screen.queryByRole("button", { name: remove })).toBeNull();
    // A pointer click selects the line: it turns the accent and shows ×, and no menu opens.
    fireEvent.click(link);
    expect(await screen.findByRole("button", { name: remove })).toBeInTheDocument();
    expect(line("orders_enrich depends on orders_ingest (job link)")).toHaveClass("stroke-primary");
    expect(screen.queryByRole("dialog")).toBeNull();
    // Escape lets the line go.
    fireEvent.keyDown(link, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: remove })).toBeNull());

    fireEvent.click(link);
    fireEvent.click(await screen.findByRole("button", { name: remove }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toEqual({ baseVersion: 3, change: { kind: "delete", target: { type: "dependency", key: "orders_enrich->orders_ingest:job" } } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "orders_enrich depends on orders_ingest (job link)" })).toBeNull());
    expect(screen.queryByRole("button", { name: remove })).toBeNull();
  });

  it("Delete removes the selected line, and never a box", async () => {
    const { container, saves } = renderMap();
    const ingest = await box("orders_ingest (Unknown, switched off)");
    const boxes = () => container.querySelectorAll(".react-flow__node-job, .react-flow__node-service").length;
    const count = boxes();
    // A selected box: Delete and Backspace do nothing.
    fireEvent.click(ingest);
    const panel = await screen.findByRole("region", { name: "orders_ingest" });
    fireEvent.keyDown(ingest, { key: "Delete" });
    fireEvent.keyDown(ingest, { key: "Backspace" });
    await frames();
    expect(saves).toEqual([]);
    expect(boxes()).toBe(count);

    // A selected line: not from a field a person types in, then Delete on the line removes it.
    const fails = screen.getByRole("button", { name: "watchdog_demo_succeeds depends on watchdog_demo_fails (job link)" });
    fireEvent.click(fails);
    const field = document.createElement("input");
    panel.append(field);
    fireEvent.keyDown(field, { key: "Delete" });
    fireEvent.keyDown(field, { key: "Backspace" });
    field.remove();
    await frames();
    expect(saves).toEqual([]);
    fireEvent.keyDown(fails, { key: "Delete" });
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].change).toEqual({ kind: "delete", target: { type: "dependency", key: "watchdog_demo_succeeds->watchdog_demo_fails:job" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "watchdog_demo_succeeds depends on watchdog_demo_fails (job link)" })).toBeNull());

    // Backspace does the same.
    const report = screen.getByRole("button", { name: "daily_revenue_report depends on orders_enrich (job link)" });
    fireEvent.click(report);
    fireEvent.keyDown(report, { key: "Backspace" });
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1].change).toEqual({ kind: "delete", target: { type: "dependency", key: "daily_revenue_report->orders_enrich:job" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "daily_revenue_report depends on orders_enrich (job link)" })).toBeNull());
    // Every box is still on the map, and the selected one still selected.
    expect(boxes()).toBe(count);
    expect(screen.getByRole("button", { name: "orders_ingest (Unknown, switched off)" })).toHaveAttribute("data-highlight", "selected");
  });

  it("Enter on a focused line still opens the link menu", async () => {
    const user = userEvent.setup();
    renderMap();
    const link = await box("orders_enrich depends on orders_ingest (job link)");
    const remove = "Remove the link: orders_enrich depends on orders_ingest (job link)";
    // Selected with a pointer first: Enter still opens the menu, which takes the place of the ×.
    fireEvent.click(link);
    await screen.findByRole("button", { name: remove });
    link.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("dialog", { name: "orders_enrich depends on orders_ingest" });
    expect(within(menu).getByRole("button", { name: "Remove link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: remove })).toBeNull();
  });

  it("Delete removes no line after Tab takes focus from the selected line to another", async () => {
    const user = userEvent.setup();
    const { saves } = renderMap();
    const first = await box("orders_enrich depends on orders_ingest (job link)");
    const remove = "Remove the link: orders_enrich depends on orders_ingest (job link)";
    fireEvent.click(first);
    expect(await screen.findByRole("button", { name: remove })).toBeInTheDocument();
    expect(first).toHaveFocus();
    // Tab takes focus, and its ring, to the next line: the first line lets go of its ×.
    await user.tab();
    const next = screen.getByRole("button", { name: "daily_revenue_report depends on orders_enrich (job link)" });
    expect(next).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole("button", { name: remove })).toBeNull());
    // Delete and Backspace on the focused line remove neither line.
    await user.keyboard("{Delete}");
    await user.keyboard("{Backspace}");
    await frames();
    expect(saves).toEqual([]);
    expect(first).toBeInTheDocument();
    expect(next).toBeInTheDocument();
  });

  it("Delete on a box leaves the selected line alone", async () => {
    const { saves } = renderMap();
    const link = await box("orders_enrich depends on orders_ingest (job link)");
    fireEvent.click(link);
    await screen.findByRole("button", { name: "Remove the link: orders_enrich depends on orders_ingest (job link)" });
    // Focus goes on to a box, as Tab does past the line's ×: the line keeps its ×, and Delete on the box removes nothing.
    const ingest = screen.getByRole("button", { name: "orders_ingest (Unknown, switched off)" });
    ingest.focus();
    fireEvent.keyDown(ingest, { key: "Delete" });
    fireEvent.keyDown(ingest, { key: "Backspace" });
    await frames();
    expect(saves).toEqual([]);
    expect(link).toBeInTheDocument();
  });

  it("Undo after a drag puts the box back", async () => {
    const user = userEvent.setup();
    const { container, saves, layoutSaves, resets } = renderMap();
    await box("watchdog_demo_slow (Unknown)");
    const group = () => container.querySelector<HTMLElement>(".react-flow__node-section");
    const tidy = screen.getByRole("button", { name: "Tidy up" });
    const undo = screen.getByRole("button", { name: "Nothing to undo" });
    expect(group()).toHaveTextContent("2 jobs");
    expect(tidy).toHaveAttribute("aria-disabled", "true");
    expect(undo).toHaveAttribute("aria-disabled", "true");
    const start = cornerOf(container, "job:watchdog_demo_slow");
    // Out of the Not linked yet group: the box's first saved spot.
    dragBox(container, "job:watchdog_demo_slow", 0, -400);
    await waitFor(() => expect(layoutSaves).toHaveLength(1));
    await waitFor(() => expect(group()).toHaveTextContent("1 job"));
    expect(tidy).not.toHaveAttribute("aria-disabled");
    // Undo names what it takes back.
    expect(undo).toHaveAccessibleName("Undo: move 1 box");
    expect(undo).not.toHaveAttribute("aria-disabled");

    await user.click(undo);
    // The box had no saved spot: Undo clears the direction and saves back the spots from before, none here. The box is
    // back in the automatic layout, in its group, and with nothing saved Tidy up is off again.
    await waitFor(() => expect(resets).toEqual([{ direction: "LR" }]));
    await waitFor(() => expect(cornerOf(container, "job:watchdog_demo_slow")).toEqual(start));
    expect(group()).toHaveTextContent("2 jobs");
    await waitFor(() => expect(tidy).toHaveAttribute("aria-disabled", "true"));
    expect(layoutSaves).toHaveLength(1);
    // The undo's own saves are not an action: nothing is left to undo, and another press saves nothing.
    await waitFor(() => expect(undo).toHaveAccessibleName("Nothing to undo"));
    expect(undo).toHaveAttribute("aria-disabled", "true");
    await user.click(undo);
    await frames();
    expect(resets).toHaveLength(1);
    expect(layoutSaves).toHaveLength(1);
    expect(saves).toEqual([]);
  });

  it("Undo of a box's first move keeps the other boxes' saved spots", async () => {
    const { container, layoutSaves, resets, reload } = renderMap(EXAMPLE_DOCUMENT, applies, {
      layout: { LR: [{ nodeKey: "service:kafka", x: 900, y: 900 }] },
    });
    await box("watchdog_demo_slow (Unknown)");
    const start = cornerOf(container, "job:watchdog_demo_slow");
    dragBox(container, "job:watchdog_demo_slow", 0, -400);
    await waitFor(() => expect(layoutSaves).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Undo: move 1 box" }));
    // The direction is cleared, then the spots from before the move are saved again: kafka's.
    await waitFor(() => expect(layoutSaves).toHaveLength(2));
    expect(resets).toEqual([{ direction: "LR" }]);
    expect(layoutSaves[1]).toEqual({ direction: "LR", moves: [{ nodeKey: "service:kafka", x: 900, y: 900 }] });
    await waitFor(() => expect(cornerOf(container, "job:watchdog_demo_slow")).toEqual(start));
    expect(cornerOf(container, "service:kafka")).toEqual({ x: 900, y: 900 });
    // What the server keeps: kafka where it was put, and the box in the automatic layout.
    const again = reload();
    await box("watchdog_demo_slow (Unknown)");
    expect(cornerOf(again.container, "service:kafka")).toEqual({ x: 900, y: 900 });
    expect(cornerOf(again.container, "job:watchdog_demo_slow")).toEqual(start);
  });

  it("Ctrl+Z from an element outside the page saves nothing", async () => {
    const { container, layoutSaves } = renderMap(EXAMPLE_DOCUMENT, applies, { layout: { LR: [{ nodeKey: "job:orders_ingest", x: 2000, y: 1200 }] } });
    await box("orders_ingest (Unknown, switched off)");
    dragBox(container, "job:orders_ingest", 120, 80);
    await waitFor(() => expect(layoutSaves).toHaveLength(1));
    // A link in the left nav, outside the page.
    const nav = document.createElement("a");
    nav.href = "/jobs";
    nav.textContent = "Job list";
    document.body.append(nav);
    nav.focus();
    fireEvent.keyDown(nav, { key: "z", ctrlKey: true });
    fireEvent.keyDown(nav, { key: "z", metaKey: true });
    await frames();
    nav.remove();
    expect(layoutSaves).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Undo: move 1 box" })).toBeInTheDocument();
    // With nothing focused the key goes to the body, which counts as the page: Undo runs.
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(layoutSaves).toHaveLength(2));
    expect(layoutSaves[1]).toEqual({ direction: "LR", moves: [{ nodeKey: "job:orders_ingest", x: 2000, y: 1200 }] });
  });

  it("Undo after a dragged link saves one delete change", async () => {
    const user = userEvent.setup();
    const { container, saves } = renderMap();
    const retries = await box("watchdog_demo_retries (Unknown)");
    dragLink(container, dot("Link from watchdog_demo_slow"), retries);
    const card = await screen.findByRole("dialog", { name: "New link" });
    await user.click(within(card).getByRole("button", { name: "Save link" }));
    const link = await box("watchdog_demo_retries depends on watchdog_demo_slow (job link)");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New link" })).toBeNull());
    expect(screen.getByRole("button", { name: "Undo: add the link" })).toBeInTheDocument();

    // Ctrl+Z from the box the link was dropped on, which has focus.
    await waitFor(() => expect(retries).toHaveFocus());
    fireEvent.keyDown(retries, { key: "z", ctrlKey: true });
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]).toEqual({
      baseVersion: 4,
      change: { kind: "delete", target: { type: "dependency", key: "watchdog_demo_retries->watchdog_demo_slow:job" } },
    });
    await waitFor(() => expect(link).not.toBeInTheDocument());
    expect(await screen.findByText("Saved version 5: Removed link watchdog_demo_retries -> watchdog_demo_slow (job).")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nothing to undo" })).toHaveAttribute("aria-disabled", "true");
    await frames();
    expect(saves).toHaveLength(2);
  });

  it("Undo after removing a link saves the link again", async () => {
    const { saves } = renderMap();
    const name = "daily_revenue_export depends on daily_revenue_report (child job link)";
    fireEvent.click(await box(name));
    fireEvent.click(await screen.findByRole("button", { name: `Remove the link: ${name}` }));
    await waitFor(() => expect(saves).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name })).toBeNull());
    expect(screen.getByRole("button", { name: "Undo: remove the link" })).toBeInTheDocument();

    // Cmd+Z from the box that has focus after the removal.
    const report = screen.getByRole("button", { name: "daily_revenue_report (Unknown, switched off)" });
    await waitFor(() => expect(report).toHaveFocus());
    fireEvent.keyDown(report, { key: "z", metaKey: true });
    await waitFor(() => expect(saves).toHaveLength(2));
    // The link comes back as it was, with its type and notes, as a new version.
    expect(saves[1]).toEqual({
      baseVersion: 4,
      change: {
        kind: "upsert",
        target: { type: "dependency", key: "daily_revenue_export->daily_revenue_report:child_job" },
        value: {
          job_name: "daily_revenue_export",
          depends_on: "daily_revenue_report",
          dependency_type: "child_job",
          notes: "daily_revenue_report starts it as its last task.",
        },
      },
    });
    expect(await box(name)).toBeInTheDocument();
    expect(await screen.findByText(/^Saved version 5: Linked daily_revenue_export to daily_revenue_report/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nothing to undo" })).toHaveAttribute("aria-disabled", "true");
  });

  it("Ctrl+Z in an input does nothing", async () => {
    const user = userEvent.setup();
    const { container, layoutSaves } = renderMap(EXAMPLE_DOCUMENT, applies, { layout: { LR: [{ nodeKey: "job:orders_ingest", x: 2000, y: 1200 }] } });
    const ingest = await box("orders_ingest (Unknown, switched off)");
    dragBox(container, "job:orders_ingest", 120, 80);
    await waitFor(() => expect(layoutSaves).toHaveLength(1));
    const moved = cornerOf(container, "job:orders_ingest");
    fireEvent.click(ingest);
    const panel = await screen.findByRole("region", { name: "orders_ingest" });
    const owner = within(panel).getByRole("textbox", { name: "Owner" });
    await user.type(owner, "-ops");
    // In a text field, Ctrl+Z and Cmd+Z are the field's own: the map saves nothing, and the box stays where it was dropped.
    fireEvent.keyDown(owner, { key: "z", ctrlKey: true });
    fireEvent.keyDown(owner, { key: "z", metaKey: true });
    await frames();
    expect(layoutSaves).toHaveLength(1);
    expect(cornerOf(container, "job:orders_ingest")).toEqual(moved);
    expect(owner).toHaveValue("ingestion-team-ops");
    expect(screen.getByRole("button", { name: "Undo: move 1 box" })).toBeInTheDocument();

    // From the box, Ctrl+Z takes the move back.
    fireEvent.keyDown(ingest, { key: "z", ctrlKey: true });
    await waitFor(() => expect(layoutSaves).toHaveLength(2));
  });

  it("Ctrl+Z from the side panel's controls does nothing", async () => {
    const user = userEvent.setup();
    const { container, saves, layoutSaves, resets } = renderMap(EXAMPLE_DOCUMENT, applies, {
      layout: { LR: [{ nodeKey: "job:orders_ingest", x: 2000, y: 1200 }] },
    });
    const ingest = await box("orders_ingest (Unknown, switched off)");
    dragBox(container, "job:orders_ingest", 120, 80);
    await waitFor(() => expect(layoutSaves).toHaveLength(1));
    const moved = cornerOf(container, "job:orders_ingest");
    fireEvent.click(ingest);
    const panel = await screen.findByRole("region", { name: "orders_ingest" });
    // A changed switch turns Save on, so Save can take focus too.
    const monitored = within(panel).getByRole("switch", { name: "Monitored" });
    await user.click(monitored);
    const save = within(panel).getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    const controls = [within(panel).getByRole("combobox", { name: "Severity" }), monitored, save, within(panel).getByRole("button", { name: "Edit job" }), panel];
    for (const control of controls) {
      control.focus();
      expect(control).toHaveFocus();
      fireEvent.keyDown(control, { key: "z", ctrlKey: true });
      fireEvent.keyDown(control, { key: "z", metaKey: true });
    }
    await frames();
    expect(layoutSaves).toHaveLength(1);
    expect(resets).toEqual([]);
    expect(saves).toEqual([]);
    expect(cornerOf(container, "job:orders_ingest")).toEqual(moved);
    expect(screen.getByRole("button", { name: "Undo: move 1 box" })).toBeInTheDocument();
    expect(monitored).toBeChecked();

    // From the box, Ctrl+Z takes the move back.
    fireEvent.keyDown(ingest, { key: "z", ctrlKey: true });
    await waitFor(() => expect(layoutSaves).toHaveLength(2));
    expect(layoutSaves[1]).toEqual({ direction: "LR", moves: [{ nodeKey: "job:orders_ingest", x: 2000, y: 1200 }] });
  });

  it("Ctrl+Z waits while the New link card is open", async () => {
    const { container, saves, layoutSaves } = renderMap(EXAMPLE_DOCUMENT, applies, { layout: { LR: [{ nodeKey: "job:orders_ingest", x: 2000, y: 1200 }] } });
    const retries = await box("watchdog_demo_retries (Unknown)");
    dragBox(container, "job:orders_ingest", 120, 80);
    await waitFor(() => expect(layoutSaves).toHaveLength(1));
    dragLink(container, dot("Link from watchdog_demo_slow"), retries);
    const card = await screen.findByRole("dialog", { name: "New link" });
    // From the card, and from the map outside it: Undo waits until the card closes.
    fireEvent.keyDown(card, { key: "z", ctrlKey: true });
    fireEvent.keyDown(retries, { key: "z", metaKey: true });
    await frames();
    expect(layoutSaves).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "New link" })).toBe(card);

    fireEvent.keyDown(card, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New link" })).toBeNull());
    fireEvent.keyDown(retries, { key: "z", ctrlKey: true });
    await waitFor(() => expect(layoutSaves).toHaveLength(2));
    expect(saves).toEqual([]);
  });

  it("Undo after Tidy up saves the spots from before again", async () => {
    const user = userEvent.setup();
    const { container, resets, layoutSaves } = renderMap(EXAMPLE_DOCUMENT, applies, {
      layout: { LR: [{ nodeKey: "job:orders_ingest", x: 2000, y: 1200 }] },
    });
    await box("orders_ingest (Unknown, switched off)");
    await user.click(screen.getByRole("button", { name: "Tidy up" }));
    await waitFor(() => expect(cornerOf(container, "job:orders_ingest")).toEqual(automaticSpot("job:orders_ingest")));
    expect(resets).toEqual([{ direction: "LR" }]);
    const undo = screen.getByRole("button", { name: "Undo: Tidy up" });
    await frames();
    flow.fitView.mockClear();

    await user.click(undo);
    await waitFor(() => expect(layoutSaves).toEqual([{ direction: "LR", moves: [{ nodeKey: "job:orders_ingest", x: 2000, y: 1200 }] }]));
    await waitFor(() => expect(cornerOf(container, "job:orders_ingest")).toEqual({ x: 2000, y: 1200 }));
    // The view fits the spots it put back, as it does after a Tidy up.
    await waitFor(() => expect(flow.fitView).toHaveBeenCalled());
    expect(undo).toHaveAccessibleName("Nothing to undo");
  });

  it("Undo turns the map back to the direction a move was made in", async () => {
    const user = userEvent.setup();
    const { container, layoutSaves } = renderMap(EXAMPLE_DOCUMENT, applies, { layout: { LR: [{ nodeKey: "job:orders_ingest", x: 2000, y: 1200 }] } });
    await box("orders_ingest (Unknown, switched off)");
    const start = cornerOf(container, "job:orders_ingest");
    expect(start).toEqual({ x: 2000, y: 1200 });
    dragBox(container, "job:orders_ingest", 120, 80);
    await waitFor(() => expect(layoutSaves).toHaveLength(1));
    await user.click(screen.getByRole("radio", { name: "Top to bottom" }));
    await waitFor(() => expect(cornerOf(container, "job:orders_enrich").y).toBeGreaterThan(cornerOf(container, "job:orders_ingest").y + 68));

    // The move was made left to right: Undo turns the map back, then puts the box back there.
    await user.click(screen.getByRole("button", { name: "Undo: move 1 box" }));
    await waitFor(() => expect(layoutSaves).toHaveLength(2));
    expect(layoutSaves[1]).toEqual({ direction: "LR", moves: [{ nodeKey: "job:orders_ingest", ...start }] });
    expect(screen.getByRole("radio", { name: "Left to right" })).toBeChecked();
    await waitFor(() => expect(cornerOf(container, "job:orders_ingest")).toEqual(start));
    expect(screen.getByRole("button", { name: "Nothing to undo" })).toBeInTheDocument();
  });

  it("an undo the rules refuse leaves the stack and says why", async () => {
    const user = userEvent.setup();
    const { container, saves, layoutSaves, resets } = renderMap();
    await box("watchdog_demo_slow (Unknown)");
    // An older action, which Undo reaches once the refused one is gone.
    dragBox(container, "job:watchdog_demo_slow", 0, -400);
    await waitFor(() => expect(layoutSaves).toHaveLength(1));
    const name = "orders_enrich depends on orders_ingest (job link)";
    fireEvent.click(await box(name));
    fireEvent.click(await screen.findByRole("button", { name: `Remove the link: ${name}` }));
    await waitFor(() => expect(saves).toHaveLength(1));
    // Removing orders_ingest from Watchdog, which is not an action Undo takes back.
    fireEvent.click(screen.getByRole("button", { name: "orders_ingest (Unknown, switched off)" }));
    await user.click(within(screen.getByRole("region", { name: "orders_ingest" })).getByRole("button", { name: "Remove from Watchdog" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Delete orders_ingest?" })).getByRole("button", { name: "Delete job" }));
    await waitFor(() => expect(saves).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "orders_ingest (Unknown, switched off)" })).toBeNull());

    // The link would name a job that is gone: the rules refuse it, so nothing is saved and the action leaves the stack.
    await user.click(screen.getByRole("button", { name: "Undo: remove the link" }));
    expect(
      await screen.findByText(
        "That change can't be undone: dependency orders_enrich -> orders_ingest: orders_ingest is not a configured job (use dependency_type: service for services).",
      ),
    ).toBeInTheDocument();
    await frames();
    expect(saves).toHaveLength(2);
    const undo = screen.getByRole("button", { name: "Undo: move 1 box" });

    // The older move is in reach again, and its undo clears the line.
    await user.click(undo);
    await waitFor(() => expect(resets).toEqual([{ direction: "LR" }]));
    await waitFor(() => expect(undo).toHaveAccessibleName("Nothing to undo"));
    expect(screen.queryByText(/^That change can't be undone/)).toBeNull();
  });

  it("an undo the server's rules refuse leaves the stack and says why", async () => {
    const user = userEvent.setup();
    let refuse = false;
    const { saves } = renderMap(EXAMPLE_DOCUMENT, (body, state) =>
      refuse
        ? json(
            {
              error: "invalid",
              message: "The job list has a problem.",
              issues: [{ path: "dependencies[orders_enrich->orders_ingest:job]", message: "a rule only the server checks" }],
            },
            422,
          )
        : applies(body, state),
    );
    const name = "orders_enrich depends on orders_ingest (job link)";
    fireEvent.click(await box(name));
    fireEvent.click(await screen.findByRole("button", { name: `Remove the link: ${name}` }));
    await waitFor(() => expect(saves).toHaveLength(1));
    refuse = true;
    await user.click(screen.getByRole("button", { name: "Undo: remove the link" }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(await screen.findByText("That change can't be undone: a rule only the server checks.")).toBeInTheDocument();
    // That line says it, not the rule alert as well, and the action is off the stack.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Nothing to undo" })).toHaveAttribute("aria-disabled", "true");
  });

  it("a conflict on an undo keeps it on the stack, so Undo can try again after Reload", async () => {
    const user = userEvent.setup();
    let conflict = false;
    const view = renderMap(EXAMPLE_DOCUMENT, (body, state) => {
      if (!conflict) return applies(body, state);
      conflict = false;
      return json({ error: "conflict", message: "Someone else changed this since you opened it. Reload to see their change.", latestVersion: 4 }, 409);
    });
    const name = "orders_enrich depends on orders_ingest (job link)";
    fireEvent.click(await box(name));
    fireEvent.click(await screen.findByRole("button", { name: `Remove the link: ${name}` }));
    await waitFor(() => expect(view.saves).toHaveLength(1));
    conflict = true;
    await user.click(screen.getByRole("button", { name: "Undo: remove the link" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Someone else changed the job list since you opened it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo: remove the link" })).toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Undo: remove the link" }));
    await waitFor(() => expect(view.saves).toHaveLength(3));
    expect(view.saves.map((save) => save.baseVersion)).toEqual([3, 4, 4]);
    expect(await box(name)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nothing to undo" })).toBeInTheDocument();
  });

  it("Add job saves a new job and selects its box", async () => {
    const user = userEvent.setup();
    const picked = {
      workspace_id: "1111111111111111",
      workspace_name: "example-prod",
      job_id: "345678901234567",
      name: "Nightly Billing Rollup",
      trigger_type: "CONTINUOUS",
      paused: "false",
      creator_user_name: "someone@example.com",
      change_time: "2026-11-05T09:00:00.000Z",
    };
    const { saves } = renderMap(EXAMPLE_DOCUMENT, applies, { queries: (call) => (call.key === "region_jobs" ? { rows: [picked] } : null) });
    await box("orders_ingest (Unknown, switched off)");
    await user.click(screen.getByRole("button", { name: "Add job" }));
    // The workspace picker, then the job form in create mode with the pick.
    const picker = await screen.findByRole("dialog", { name: "Add from workspace" });
    await user.type(within(picker).getByRole("searchbox", { name: "Search jobs by name" }), "billing");
    await user.click(await within(picker).findByRole("button", { name: "Add Nightly Billing Rollup from example-prod" }));
    const sheet = await screen.findByRole("dialog", { name: "Add job" });
    expect(within(sheet).getByLabelText("Job name")).toHaveValue("nightly_billing_rollup");
    const save = within(sheet).getByRole("button", { name: "Add job" });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);

    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({
      baseVersion: 3,
      change: { kind: "upsert", target: { type: "job", name: "nightly_billing_rollup" }, value: { job_name: "nightly_billing_rollup", job_ids: ["345678901234567"] } },
    });
    expect(await screen.findByText("Saved version 4: Added job nightly_billing_rollup.")).toBeInTheDocument();
    // The new job's box is on the map, selected, with its side panel open, and it has focus.
    const added = await box("nightly_billing_rollup (Unknown)");
    await waitFor(() => expect(added).toHaveAttribute("data-highlight", "selected"));
    expect(screen.getByRole("region", { name: "nightly_billing_rollup" })).toBeInTheDocument();
    await waitFor(() => expect(added).toHaveFocus());
    // Adding a job is not a map action Undo takes back.
    expect(screen.getByRole("button", { name: "Nothing to undo" })).toHaveAttribute("aria-disabled", "true");
  });
});
