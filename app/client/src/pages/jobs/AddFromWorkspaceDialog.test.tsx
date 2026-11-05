// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobListDocument } from "../../../../shared/joblist/types";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { type QueryAnswer, type QueryCall, mockFetch } from "../../test/analytics-mock";
import { AddFromWorkspaceDialog } from "./AddFromWorkspaceDialog";

const NO_ACCESS = "You don't have access to system.lakeflow.jobs. Ask an admin for SELECT on it. You can still add jobs by hand.";

const ROWS = [
  {
    workspace_id: "1111111111111111",
    workspace_name: "example-prod",
    job_id: "9007199254740993",
    name: "orders_ingest_prod",
    trigger_type: "CRON",
    paused: "false",
    creator_user_name: "dana@example.com",
    change_time: "2026-11-04T10:00:00.000Z",
  },
  {
    workspace_id: "2222222222222222",
    workspace_name: "example-staging",
    job_id: "123",
    name: "orders_enrich_web_dev",
    trigger_type: "CONTINUOUS",
    paused: "true",
    creator_user_name: "lee@example.com",
    change_time: "2026-11-03T08:00:00.000Z",
  },
];

const DOCUMENT: JobListDocument = { jobs: [{ job_name: "orders_enrich", job_name_regex: "^orders_enrich_" }] };

function searches(calls: QueryCall[]): string[] {
  return calls.filter((c) => c.key === "region_jobs").map((c) => c.params.search);
}

function renderDialog(answer: (call: QueryCall) => QueryAnswer, onPick = vi.fn()) {
  const { calls } = mockFetch(answer);
  render(
    <RefreshProvider>
      <AddFromWorkspaceDialog open onOpenChange={() => undefined} document={DOCUMENT} onPick={onPick} />
    </RefreshProvider>,
  );
  return { calls, onPick };
}

describe("AddFromWorkspaceDialog", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows a hint and runs no query while the search is empty", async () => {
    const { calls } = renderDialog(() => ({ rows: ROWS }));
    expect(screen.getByText("Type part of a job name to search every workspace in this region.")).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(calls).toEqual([]);
  });

  it("searches 300 ms after the typing stops", async () => {
    const { calls } = renderDialog(() => ({ rows: ROWS }));
    const input = screen.getByRole("searchbox", { name: "Search jobs by name" });
    vi.useFakeTimers();
    fireEvent.change(input, { target: { value: "or" } });
    await act(() => vi.advanceTimersByTimeAsync(200));
    fireEvent.change(input, { target: { value: "ord" } });
    await act(() => vi.advanceTimersByTimeAsync(299));
    expect(searches(calls)).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(searches(calls)).toEqual(["ord"]);
  });

  it("lists workspace, name, job ID, trigger, paused and creator, and which jobs are monitored already", async () => {
    const user = userEvent.setup();
    renderDialog(() => ({ rows: ROWS }));
    await user.type(screen.getByRole("searchbox", { name: "Search jobs by name" }), "orders");
    const first = await screen.findByRole("row", { name: /orders_ingest_prod/ });
    expect(within(first).getByText("example-prod")).toBeInTheDocument();
    expect(within(first).getByText("9007199254740993")).toBeInTheDocument();
    expect(within(first).getByText("Cron schedule")).toBeInTheDocument();
    expect(within(first).getByRole("cell", { name: "No" })).toBeInTheDocument();
    expect(within(first).getByText("dana@example.com")).toBeInTheDocument();
    expect(within(first).queryByText(/Monitored as/)).toBeNull();

    const second = screen.getByRole("row", { name: /orders_enrich_web_dev/ });
    expect(within(second).getByText("Continuous")).toBeInTheDocument();
    expect(within(second).getByRole("cell", { name: "Yes" })).toBeInTheDocument();
    expect(within(second).getByText("Monitored as orders_enrich")).toBeInTheDocument();
    expect(screen.getByText("2 jobs")).toBeInTheDocument();
  });

  it("calls onPick with a draft when a row is chosen", async () => {
    const user = userEvent.setup();
    const { onPick } = renderDialog(() => ({ rows: ROWS }));
    await user.type(screen.getByRole("searchbox", { name: "Search jobs by name" }), "ingest");
    await user.click(await screen.findByRole("button", { name: "Add orders_ingest_prod from example-prod" }));
    expect(onPick).toHaveBeenCalledWith({ job_name: "orders_ingest_prod", job_ids: ["9007199254740993"], schedule_type: "scheduled" });
  });

  it.each([
    ["the warehouse refuses the statement", { error: "Query execution failed", errorCode: "BAD_REQUEST" }],
    ["the code says PERMISSION_DENIED", { error: "Query execution failed", errorCode: "PERMISSION_DENIED" }],
    ["the message says INSUFFICIENT_PERMISSIONS", { error: "[INSUFFICIENT_PERMISSIONS] Insufficient privileges" }],
  ])("says the person has no access when %s, and Retry searches again once access is granted", async (_case, failure) => {
    const user = userEvent.setup();
    let granted = false;
    const { calls } = renderDialog(() => (granted ? { rows: ROWS } : failure));
    const term = `x${_case.length}`;
    await user.type(screen.getByRole("searchbox", { name: "Search jobs by name" }), term);
    expect(await screen.findByText(NO_ACCESS)).toBeInTheDocument();
    granted = true;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("row", { name: /orders_ingest_prod/ })).toBeInTheDocument();
    expect(searches(calls)).toEqual([term, term]);
  });

  it("offers Retry for other failures, and searches again", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { calls } = renderDialog(() => (fail ? { error: "Network error. Please check your connection." } : { rows: ROWS }));
    await user.type(screen.getByRole("searchbox", { name: "Search jobs by name" }), "retry");
    expect(await screen.findByText("Could not search the jobs.")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("row", { name: /orders_ingest_prod/ })).toBeInTheDocument();
    expect(searches(calls)).toEqual(["retry", "retry"]);
  });

  it("says so when no job matches", async () => {
    const user = userEvent.setup();
    renderDialog(() => ({ rows: [] }));
    await user.type(screen.getByRole("searchbox", { name: "Search jobs by name" }), "zzz");
    expect(await screen.findByText("No job in this region has zzz in its name.")).toBeInTheDocument();
  });

  it("clears the search with its own button: the browser's own one is hidden", async () => {
    const user = userEvent.setup();
    renderDialog(() => ({ rows: ROWS }));
    const input = screen.getByRole("searchbox", { name: "Search jobs by name" });
    // Chrome draws its clear button in blue, which is not the app's accent.
    expect(input).toHaveClass("[&::-webkit-search-cancel-button]:hidden");
    expect(screen.queryByRole("button", { name: "Clear the search" })).toBeNull();
    await user.type(input, "orders");
    await screen.findByRole("row", { name: /orders_ingest_prod/ });
    await user.click(screen.getByRole("button", { name: "Clear the search" }));
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(await screen.findByText("Type part of a job name to search every workspace in this region.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear the search" })).toBeNull();
  });

  it("says when the list is cut at 100 jobs", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 100 }, (_, i) => ({ ...ROWS[0], job_id: String(1000 + i), name: `orders_${1000 + i}` }));
    renderDialog(() => ({ rows: many }));
    await user.type(screen.getByRole("searchbox", { name: "Search jobs by name" }), "orders_1");
    expect(await screen.findByText("The first 100 jobs. Type more of the name to narrow the list.")).toBeInTheDocument();
  });
});
