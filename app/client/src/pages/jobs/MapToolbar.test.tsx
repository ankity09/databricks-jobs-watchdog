// @vitest-environment jsdom
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FitViewOptions } from "@xyflow/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LayoutDirection } from "../../lib/graph";
import { mockReactFlow } from "../../test/reactflow-mocks";
import { MapToolbar, type MapToolbarProps } from "./MapToolbar";

const flow = vi.hoisted(() => ({
  zoomTo: vi.fn((_zoom: number, _options?: { duration?: number }) => Promise.resolve(true)),
  fitView: vi.fn((_options?: object) => Promise.resolve(true)),
  state: { transform: [0, 0, 0.83], minZoom: 0.2, maxZoom: 1.75 },
}));

// The toolbar on its own: React Flow's viewport helpers and store are stand-ins, so each button's call can be checked.
vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  useReactFlow: () => ({ zoomTo: flow.zoomTo, fitView: flow.fitView }),
  useStore: (selector: (state: typeof flow.state) => unknown) => selector(flow.state),
}));

/** The zoom each zoomTo call asked for, to two decimals. */
function zoomsAsked(): number[] {
  return flow.zoomTo.mock.calls.map(([zoom]) => Math.round(zoom * 100) / 100);
}

const FIT: FitViewOptions = { padding: { top: "64px", right: "24px", bottom: "148px", left: "24px" }, maxZoom: 1.1 };

/** The layout and undo controls, as the map passes them: by default no saved positions and nothing to undo. */
type EditProps = Pick<MapToolbarProps, "tidyDisabled" | "undoDisabled" | "undoLabel">;
const NOTHING_SAVED: EditProps = { tidyDisabled: true, undoDisabled: true, undoLabel: "Nothing to undo" };

function renderToolbar(direction: LayoutDirection = "LR", showServices = true, edit: EditProps = NOTHING_SAVED) {
  const onDirectionChange = vi.fn();
  const onShowServicesChange = vi.fn();
  const onTidy = vi.fn();
  const onUndo = vi.fn();
  const toolbar = (props: EditProps) => (
    <TooltipProvider>
      <MapToolbar
        direction={direction}
        onDirectionChange={onDirectionChange}
        showServices={showServices}
        onShowServicesChange={onShowServicesChange}
        fitOptions={FIT}
        onTidy={onTidy}
        onUndo={onUndo}
        {...props}
      />
    </TooltipProvider>
  );
  const view = render(toolbar(edit));
  return {
    onDirectionChange,
    onShowServicesChange,
    onTidy,
    onUndo,
    toolbar: screen.getByRole("group", { name: "Map view" }),
    rerender: (props: EditProps) => view.rerender(toolbar(props)),
  };
}

/** Makes prefers-reduced-motion match, as a person who asked for less motion would have it. */
function reduceMotion() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion: reduce"),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

describe("MapToolbar", () => {
  // The tooltips that open on keyboard focus measure themselves with ResizeObserver, which jsdom lacks.
  beforeAll(() => mockReactFlow());
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    flow.zoomTo.mockImplementation(() => Promise.resolve(true));
    flow.state.transform = [0, 0, 0.83];
  });

  it("shows the zoom as a percentage, and zooms out and in by a step with a short animation", async () => {
    const user = userEvent.setup();
    const { toolbar } = renderToolbar();
    expect(within(toolbar).getByText("83%")).toBeInTheDocument();
    await user.click(within(toolbar).getByRole("button", { name: "Zoom out" }));
    expect(flow.zoomTo).toHaveBeenLastCalledWith(0.83 / 1.2, { duration: 200 });
    await user.click(within(toolbar).getByRole("button", { name: "Zoom in" }));
    expect(flow.zoomTo).toHaveBeenLastCalledWith(0.83 * 1.2, { duration: 200 });
  });

  it("takes a step for each click while the last zoom is still moving, and stops at the limits", async () => {
    const user = userEvent.setup();
    // The glide never ends in this test: each click starts from where the last one is going.
    flow.zoomTo.mockImplementation(() => new Promise<boolean>(() => undefined));
    const { toolbar } = renderToolbar();
    const zoomOut = within(toolbar).getByRole("button", { name: "Zoom out" });
    await user.click(zoomOut);
    await user.click(zoomOut);
    await user.click(zoomOut);
    expect(zoomsAsked()).toEqual([0.69, 0.58, 0.48]);
    for (let i = 0; i < 6; i++) await user.click(zoomOut);
    expect(zoomsAsked().at(-1)).toBe(0.2);
  });

  it("forgets where the last zoom was going once its glide is over, as when a fit, a wheel or a drag cut it short", async () => {
    const user = userEvent.setup();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // The glide is cut short and never reports its end.
    flow.zoomTo.mockImplementation(() => new Promise<boolean>(() => undefined));
    const { toolbar } = renderToolbar();
    const zoomOut = within(toolbar).getByRole("button", { name: "Zoom out" });
    await user.click(zoomOut);
    now += 1000;
    await user.click(zoomOut);
    // Both steps start from the zoom on screen, 83%: the first target is stale by then.
    expect(zoomsAsked()).toEqual([0.69, 0.69]);
  });

  it("marks zoom out and zoom in as unavailable at the zoom limits, and keeps them focusable", async () => {
    const user = userEvent.setup();
    flow.state.transform = [0, 0, 0.2];
    const { toolbar } = renderToolbar();
    const zoomOut = within(toolbar).getByRole("button", { name: "Zoom out" });
    expect(zoomOut).toHaveAttribute("aria-disabled", "true");
    expect(zoomOut).not.toBeDisabled();
    zoomOut.focus();
    await user.keyboard("{Enter}");
    expect(flow.zoomTo).not.toHaveBeenCalled();
    expect(zoomOut).toHaveFocus();
    expect(within(toolbar).getByRole("button", { name: "Zoom in" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("fits the map clear of the overlays", async () => {
    const user = userEvent.setup();
    const { toolbar } = renderToolbar();
    await user.click(within(toolbar).getByRole("button", { name: "Fit the map to the screen" }));
    expect(flow.fitView).toHaveBeenCalledWith({ ...FIT, duration: 200 });
  });

  it("zooms and fits without animation when reduced motion is on", async () => {
    reduceMotion();
    const user = userEvent.setup();
    const { toolbar } = renderToolbar();
    await user.click(within(toolbar).getByRole("button", { name: "Zoom in" }));
    await user.click(within(toolbar).getByRole("button", { name: "Fit the map to the screen" }));
    expect(flow.zoomTo).toHaveBeenCalledWith(0.83 * 1.2, { duration: 0 });
    expect(flow.fitView).toHaveBeenCalledWith({ ...FIT, duration: 0 });
  });

  it("switches the layout between left to right and top to bottom", async () => {
    const user = userEvent.setup();
    const { toolbar, onDirectionChange } = renderToolbar("LR");
    const direction = within(toolbar).getByRole("group", { name: "Layout direction" });
    expect(within(direction).getByRole("radio", { name: "Left to right" })).toBeChecked();
    await user.click(within(direction).getByRole("radio", { name: "Top to bottom" }));
    expect(onDirectionChange).toHaveBeenCalledWith("TB");
    // Pressing the direction already chosen keeps it: the group never ends with no direction.
    await user.click(within(direction).getByRole("radio", { name: "Left to right" }));
    expect(onDirectionChange).toHaveBeenCalledTimes(1);
  });

  it("shows and hides the services with a switch", async () => {
    const user = userEvent.setup();
    const { toolbar, onShowServicesChange } = renderToolbar("LR", true);
    const services = within(toolbar).getByRole("switch", { name: "Show services" });
    expect(services).toBeChecked();
    await user.click(services);
    expect(onShowServicesChange).toHaveBeenCalledWith(false);
  });

  it("Tidy up is disabled with no saved positions", async () => {
    const user = userEvent.setup();
    const { toolbar, onTidy, rerender } = renderToolbar();
    const tidy = within(toolbar).getByRole("button", { name: "Tidy up" });
    act(() => tidy.focus());
    // Tidy up changes the layout everyone sees, and its tooltip says so.
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/^Put the automatic layout back, for everyone$/);
    // Unavailable, but it keeps focus, as the zoom buttons do at their limits.
    expect(tidy).toHaveAttribute("aria-disabled", "true");
    await user.click(tidy);
    expect(onTidy).not.toHaveBeenCalled();

    rerender({ ...NOTHING_SAVED, tidyDisabled: false });
    expect(tidy).not.toHaveAttribute("aria-disabled");
    await user.click(tidy);
    expect(onTidy).toHaveBeenCalledTimes(1);
  });

  it("names what Undo would undo, and does nothing when there is nothing to undo", async () => {
    const user = userEvent.setup();
    const { toolbar, onUndo, rerender } = renderToolbar();
    const undo = within(toolbar).getByRole("button", { name: "Nothing to undo" });
    expect(undo).toHaveTextContent("Undo");
    expect(undo).toHaveAttribute("aria-disabled", "true");
    await user.click(undo);
    expect(onUndo).not.toHaveBeenCalled();

    rerender({ tidyDisabled: true, undoDisabled: false, undoLabel: "Undo: move 2 boxes" });
    await user.click(within(toolbar).getByRole("button", { name: "Undo: move 2 boxes" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
