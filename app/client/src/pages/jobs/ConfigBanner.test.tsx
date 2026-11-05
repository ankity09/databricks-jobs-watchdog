// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { ConfigBanner } from "./ConfigBanner";

const CONFIG = { catalog: "main", schema: "watchdog", region: "us-east-2", appName: "watchdog-app", lakebaseProject: "jobs-watchdog" };

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** /api/app-config, and every analytics query answering over SSE with `event`. */
function mockApi(event: unknown) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (urlOf(input).startsWith("/api/app-config")) {
      return Promise.resolve(new Response(JSON.stringify(CONFIG), { headers: { "Content-Type": "application/json" } }));
    }
    return Promise.resolve(new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const rows = (list: unknown[]) => ({ type: "result", data: list });

/** A config_loads row as the SQL warehouse sends it: every value a string. */
function load(fields: Record<string, string | null>) {
  return {
    loaded_at: "2026-11-05T10:05:00.000Z",
    scan_id: "101",
    source: "lakebase",
    source_ref: "projects/jobs-watchdog/branches/production/databases/watchdog",
    version: "11",
    job_count: "9",
    status: "OK",
    error: null,
    ...fields,
  };
}

/**
 * Each test gets its own clock, so the refresh key (the current minute) differs
 * and AppKit's query store does not hand one test the rows of another.
 */
function setClock(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

function renderBanner(savedVersion: number | null | undefined) {
  return render(
    <RefreshProvider>
      <ConfigBanner savedVersion={savedVersion} />
      <p>page content</p>
    </RefreshProvider>,
  );
}

/** Waits until the query has answered: the fetch for config_load_latest ran and the page settled. */
async function answered(fetchMock: ReturnType<typeof mockApi>) {
  await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => urlOf(input).includes("config_load_latest"))).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("ConfigBanner", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("says the scan still reads the YAML file when the newest load came from YAML", async () => {
    setClock("2026-11-05T10:30:00Z");
    mockApi(rows([load({ source: "yaml", source_ref: "/Workspace/Shared/monitored_jobs.yml", version: null })]));
    renderBanner(12);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The scan still reads the YAML file. To use this list, set scan.config_source to lakebase and redeploy.",
    );
  });

  it("says which version the scan is on when it is behind the saved one", async () => {
    setClock("2026-11-05T11:30:00Z");
    mockApi(rows([load({ version: "11" })]));
    renderBanner(12);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved as version 12. The scan is on version 11. It applies at the next scan, or click Scan now in the sidebar.",
    );
  });

  it("shows the error and its time when the newest load failed, from the newest row only", async () => {
    setClock("2026-11-05T12:30:00Z");
    const failed = load({
      loaded_at: "2026-11-05T12:05:00.000Z",
      version: null,
      job_count: null,
      status: "FAILED",
      error: "LakebaseSourceError: the job list is empty: import your job list in the Watchdog app first",
    });
    // A failing serverless task retries, so one scan can write the same FAILED row more than once.
    mockApi(rows([failed, { ...failed, loaded_at: "2026-11-05T12:03:00.000Z" }, load({ loaded_at: "2026-11-05T11:00:00.000Z" })]));
    renderBanner(12);
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("The scan could not load the job list");
    expect(banner).toHaveTextContent("LakebaseSourceError: the job list is empty: import your job list in the Watchdog app first");
    expect(banner).toHaveTextContent("2026-11-05 12:05 UTC");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("shows nothing when the scan is on the saved version", async () => {
    setClock("2026-11-05T13:30:00Z");
    const fetchMock = mockApi(rows([load({ version: "12" })]));
    renderBanner(12);
    await answered(fetchMock);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows nothing when no load is recorded yet", async () => {
    setClock("2026-11-05T14:30:00Z");
    const fetchMock = mockApi(rows([]));
    renderBanner(null);
    await answered(fetchMock);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("waits for the saved version before it compares versions", async () => {
    setClock("2026-11-05T15:30:00Z");
    const fetchMock = mockApi(rows([load({ version: "11" })]));
    const view = renderBanner(undefined);
    await answered(fetchMock);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.rerender(
      <RefreshProvider>
        <ConfigBanner savedVersion={12} />
      </RefreshProvider>,
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Saved as version 12. The scan is on version 11.");
  });

  it("offers Retry when the loads cannot be read", async () => {
    setClock("2026-11-05T16:30:00Z");
    const fetchMock = mockApi({ type: "error", error: "Query execution failed", errorCode: "BAD_REQUEST" });
    renderBanner(12);
    expect(await screen.findByText("The app could not check which job-list version the scan uses.")).toBeInTheDocument();
    const before = fetchMock.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before));
  });
});
