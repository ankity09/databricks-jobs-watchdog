// @vitest-environment jsdom
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { installRadixPolyfills, json, mockApi, setClock } from "../../test/mockApi";
import { STATUS_ROWS } from "../../test/monitoringFixtures";
import { MonitoringPage } from "./MonitoringPage";

// Its own file: the app config is fetched once per page load and kept for the whole module.
const MESSAGE = "The app could not read the scan job's settings. Check that the app can view the scan job, then try again.";

describe("the Monitoring page when the app config cannot be read", () => {
  beforeAll(installRadixPolyfills);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the server's message with Retry, not 'No catalog set', and loads after a good retry", async () => {
    setClock("2026-11-05T14:10:00Z");
    let failing = true;
    mockApi({
      queries: { job_status: STATUS_ROWS },
      configResponse: () => (failing ? json({ error: "app_config", message: MESSAGE }, 503) : undefined),
    });
    const router = createMemoryRouter([{ path: "/monitoring", element: <MonitoringPage /> }], { initialEntries: ["/monitoring"] });
    render(
      <RefreshProvider>
        <TooltipProvider delayDuration={0}>
          <RouterProvider router={router} />
        </TooltipProvider>
      </RefreshProvider>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(MESSAGE);
    expect(alert).not.toHaveTextContent("The app needs them");
    expect(screen.queryByText(/No catalog set/)).toBeNull();
    failing = false;
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("table", { name: "Monitored jobs" })).toBeInTheDocument();
  });
});
