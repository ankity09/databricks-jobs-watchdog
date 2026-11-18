// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import type { EntryJobIds } from "../../lib/picker";
import { type QueryAnswer, type QueryCall, mockFetch } from "../../test/analytics-mock";
import { PatternMatches } from "./PatternMatches";

function matchRows(names: string[], total = names.length) {
  return names.map((name, i) => ({ workspace_id: "1111111111111111", job_id: String(100 + i), name, match_count: String(total) }));
}

function renderMatches(pattern: string, exclude: string, answer: (call: QueryCall) => QueryAnswer, jobIds?: EntryJobIds) {
  const { calls } = mockFetch(answer);
  render(
    <RefreshProvider>
      <PatternMatches pattern={pattern} exclude={exclude} jobIds={jobIds} />
    </RefreshProvider>,
  );
  return calls;
}

describe("PatternMatches", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes workspace scope to the warehouse before it counts and limits matches", async () => {
    const calls = renderMatches("^workspace_scope_preview_", "", (call) => ({
      rows: call.params.workspace_id === "1234" ? matchRows(["workspace_scope_preview_a"]) : matchRows(["workspace_scope_preview_a", "workspace_scope_preview_b"]),
    }), { workspaceId: "1234", jobIds: [], environments: {} });
    expect(await screen.findByText("Matches 1 job")).toBeInTheDocument();
    expect(calls[0].params.workspace_id).toBe("1234");
  });

  // Each test below has its own pattern: AppKit shares a finished request with the next test that sends the same one.
  it("says the scan finds the job by its job ID, and gives no not-found warning, when the entry has job IDs", async () => {
    // A picked job: its ID applies everywhere, and its name pattern matches nothing (a dev-mode job's name has a prefix).
    renderMatches("^nightly_billing_rollup$", "", () => ({ rows: [] }), { jobIds: ["9007199254740993"], environments: {} });
    expect(await screen.findByText("The scan finds this job by its job ID.")).toBeInTheDocument();
    expect(screen.getByText("The pattern matches 0 jobs.")).toBeInTheDocument();
    expect(screen.queryByText("The scan would report this job as not found.")).toBeNull();
  });

  it("keeps the pattern's matches as information under the job ID line", async () => {
    renderMatches("^by_id_with_matches_", "", () => ({ rows: matchRows(["by_id_with_matches_a", "by_id_with_matches_b"]) }), {
      jobIds: ["123"],
      environments: {},
    });
    expect(await screen.findByText("The pattern matches 2 jobs.")).toBeInTheDocument();
    expect(screen.getByText("The scan finds this job by its job ID.")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["by_id_with_matches_a", "by_id_with_matches_b"]);
  });

  it("names the environments where the scan uses the pattern instead, and warns for them", async () => {
    renderMatches("^falls_back_in_lower$", "", () => ({ rows: [] }), { jobIds: ["123"], environments: { lower: [] } });
    expect(await screen.findByText("The scan finds this job by its job ID, except in lower, where it uses the pattern.")).toBeInTheDocument();
    expect(screen.getByText("In lower, the scan would report this job as not found.")).toBeInTheDocument();
  });

  it("names the environments where the scan finds the job by ID, and warns for the others", async () => {
    renderMatches("^by_id_in_production$", "", () => ({ rows: [] }), { jobIds: [], environments: { production: ["456"] } });
    expect(await screen.findByText("In production, the scan finds this job by its job ID. Elsewhere it uses the pattern.")).toBeInTheDocument();
    expect(screen.getByText("Elsewhere, the scan would report this job as not found.")).toBeInTheDocument();
  });

  it("shows how many jobs match and the first 10 names, in mono", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `orders_ingest_${String(i).padStart(2, "0")}_prod`);
    renderMatches("^orders_ingest_", "", () => ({ rows: matchRows(names) }));
    expect(await screen.findByText("Matches 12 jobs")).toBeInTheDocument();
    const shown = screen.getAllByRole("listitem");
    expect(shown.map((item) => item.textContent)).toEqual(names.slice(0, 10));
    expect(shown[0]).toHaveClass("font-mono");
    expect(screen.getByText("and 2 more")).toBeInTheDocument();
  });

  it("counts every match, not just the rows it shows", async () => {
    renderMatches("^daily_", "", () => ({ rows: matchRows(["daily_a", "daily_b"], 75) }));
    expect(await screen.findByText("Matches 75 jobs")).toBeInTheDocument();
    expect(screen.getByText("and 73 more")).toBeInTheDocument();
  });

  it("names a job once when it runs in several workspaces", async () => {
    renderMatches("^export$", "", () => ({ rows: matchRows(["export", "export", "export"]) }));
    expect(await screen.findByText("Matches 3 jobs")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["export in 3 workspaces"]);
  });

  it("says so when nothing matches", async () => {
    renderMatches("^nothing$", "", () => ({ rows: [] }));
    expect(await screen.findByText("Matches 0 jobs")).toBeInTheDocument();
    expect(screen.getByText("The scan would report this job as not found.")).toBeInTheDocument();
  });

  it("passes the pattern and the exclusion to the query", async () => {
    const calls = renderMatches("^orders_", "_test(_|$)", () => ({ rows: matchRows(["orders_x"]) }));
    expect(await screen.findByText("Matches 1 job")).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ key: "pattern_matches", params: { pattern: "^orders_", exclude: "_test(_|$)" } });
  });

  it("says the pattern has an error when the SQL engine rejects it", async () => {
    const calls = renderMatches("(", "", () => ({ error: "Query execution failed", errorCode: "BAD_REQUEST" }));
    expect(await screen.findByText("This pattern has an error.")).toBeInTheDocument();
    expect(calls.map((c) => c.key)).toEqual(["pattern_matches", "pattern_check"]);
  });

  it("says the person has no access when the pattern itself is fine", async () => {
    renderMatches("^fine$", "", (call) =>
      call.key === "pattern_check"
        ? { rows: [{ pattern_matches_empty: "false", exclude_matches_empty: "true", refresh: "1" }] }
        : { error: "Query execution failed", errorCode: "BAD_REQUEST" },
    );
    expect(await screen.findByText("You don't have access to system.lakeflow.jobs, so the app can't show which jobs match.")).toBeInTheDocument();
    expect(screen.queryByText("This pattern has an error.")).toBeNull();
  });

  it("offers Retry, not a pattern error, when the pattern check fails for another reason", async () => {
    // Its own pattern: AppKit shares a finished request with the next test that sends the same one.
    renderMatches("^unchecked$", "", (call) =>
      call.key === "pattern_check"
        ? { error: "Network error. Please check your connection." }
        : { error: "Query execution failed", errorCode: "BAD_REQUEST" },
    );
    expect(await screen.findByText("Could not check the pattern.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByText("Network error. Please check your connection.")).toBeInTheDocument();
    expect(screen.queryByText("This pattern has an error.")).toBeNull();
  });

  it("offers Retry for other failures", async () => {
    renderMatches("^retry$", "", () => ({ error: "Network error. Please check your connection." }));
    expect(await screen.findByText("Could not check the pattern.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows a hint and runs no query when there is no pattern", async () => {
    const calls = renderMatches("", "", () => ({ rows: [] }));
    expect(screen.getByText("Type a name pattern to see which jobs in this region it matches.")).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(calls).toEqual([]);
  });
});
