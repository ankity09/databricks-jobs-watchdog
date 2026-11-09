// @vitest-environment jsdom
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FitViewOptions } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LayoutDirection } from "../../lib/graph";
import { MapToolbar } from "./MapToolbar";

const flow = vi.hoisted(() => ({
  zoomIn: vi.fn(() => Promise.resolve(true)),
  zoomOut: vi.fn(() => Promise.resolve(true)),
  fitView: vi.fn(() => Promise.resolve(true)),
  state: { transform: [0, 0, 0.83], minZoom: 0.2, maxZoom: 1.75 },
}));

// The toolbar on its own: React Flow's viewport helpers and store are stand-ins, so each button's call can be checked.
vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  useReactFlow: () => ({ zoomIn: flow.zoomIn, zoomOut: flow.zoomOut, fitView: flow.fitView }),
  useStore: (selector: (state: typeof flow.state) => unknown) => selector(flow.state),
}));

const FIT: FitViewOptions = { padding: { top: "64px", right: "24px", bottom: "148px", left: "24px" }, maxZoom: 1.1 };

function renderToolbar(direction: LayoutDirection = "LR", showServices = true) {
  const onDirectionChange = vi.fn();
  const onShowServicesChange = vi.fn();
  render(
    <TooltipProvider>
      <MapToolbar
        direction={direction}
        onDirectionChange={onDirectionChange}
        showServices={showServices}
        onShowServicesChange={onShowServicesChange}
        fitOptions={FIT}
      />
    </TooltipProvider>,
  );
  return { onDirectionChange, onShowServicesChange, toolbar: screen.getByRole("group", { name: "Map view" }) };
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
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    flow.state.transform = [0, 0, 0.83];
  });

  it("shows the zoom as a percentage, and zooms out and in with a short animation", async () => {
    const user = userEvent.setup();
    const { toolbar } = renderToolbar();
    expect(within(toolbar).getByText("83%")).toBeInTheDocument();
    await user.click(within(toolbar).getByRole("button", { name: "Zoom out" }));
    expect(flow.zoomOut).toHaveBeenCalledWith({ duration: 200 });
    await user.click(within(toolbar).getByRole("button", { name: "Zoom in" }));
    expect(flow.zoomIn).toHaveBeenCalledWith({ duration: 200 });
  });

  it("turns zoom out and zoom in off at the zoom limits", () => {
    flow.state.transform = [0, 0, 0.2];
    const { toolbar } = renderToolbar();
    expect(within(toolbar).getByRole("button", { name: "Zoom out" })).toBeDisabled();
    expect(within(toolbar).getByRole("button", { name: "Zoom in" })).toBeEnabled();
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
    expect(flow.zoomIn).toHaveBeenCalledWith({ duration: 0 });
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
});
