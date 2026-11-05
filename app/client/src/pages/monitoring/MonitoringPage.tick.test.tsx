// @vitest-environment jsdom
import { TooltipProvider } from "@databricks/appkit-ui/react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { installRadixPolyfills, mockApi } from "../../test/mockApi";
import { STATUS_ROWS } from "../../test/monitoringFixtures";
import type { JobStatusRow } from "../../lib/rows";
import { MonitoringPage } from "./MonitoringPage";

// The history strip's input, as the page passes it on each render.
const stripInputs: ReadonlyArray<JobStatusRow>[] = [];
vi.mock("./HistoryStrip", () => ({
  HistoryStrip: ({ jobs }: { jobs: ReadonlyArray<JobStatusRow> }) => {
    stripInputs.push(jobs);
    return null;
  },
}));

function renderPage() {
  const router = createMemoryRouter([{ path: "/monitoring", element: <MonitoringPage /> }], { initialEntries: ["/monitoring"] });
  render(
    <RefreshProvider>
      <TooltipProvider delayDuration={0}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </RefreshProvider>,
  );
}

describe("the Monitoring page on the minute tick", () => {
  beforeAll(installRadixPolyfills);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    stripInputs.length = 0;
  });

  it("passes the history strip the same jobs array when no last-run filter is set", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-11-05T18:10:00Z"));
    mockApi({ queries: { job_status: STATUS_ROWS } });
    renderPage();
    await screen.findByRole("table", { name: "Monitored jobs" });
    const before = stripInputs[stripInputs.length - 1];
    expect(before.length).toBeGreaterThan(0);
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(stripInputs[stripInputs.length - 1]).toBe(before);
  });

  it("still re-filters on the tick when a last-run filter is set", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-11-05T19:10:00Z"));
    mockApi({ queries: { job_status: STATUS_ROWS } });
    renderPage();
    await screen.findByRole("table", { name: "Monitored jobs" });
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("combobox", { name: /last run/i }));
    const options = screen.getAllByRole("option");
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(options[options.length - 1]);
    const before = stripInputs[stripInputs.length - 1];
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(stripInputs[stripInputs.length - 1]).not.toBe(before);
  });
});
