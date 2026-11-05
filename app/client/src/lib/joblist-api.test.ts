import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobListDocument } from "../../../shared/joblist/types";
import { getJobList, withLoaderText } from "./joblist-api";

/**
 * A version saved before the server stored text as text: the YAML values as
 * parsed. Every one of these loads in jobs_watchdog/config.py, which reads
 * the text fields with str().
 */
function storedBeforeTextFix(): JobListDocument {
  return JSON.parse(
    JSON.stringify({
      defaults: { owner: 42, notes: false, job_name_exclude_regex: false, max_gap_minutes: 60 },
      workspaces: [
        { workspace_name: 2024, environment: 1, notes: 2024 },
        { workspace_id: "1111111111111111", workspace_name: true, environment: "lower", notes: true },
      ],
      jobs: [
        { job_name: 20241105, notes: true, owner: 7, job_name_exclude_regex: 0, enabled: true, max_retries: 2, job_ids: ["123"] },
        { job_name: true, job_name_regex: 0, environments: { lower: { owner: 5, max_gap_minutes: 30 }, "1": { owner: false } } },
        { job_name: "kept_as_written", owner: null, notes: "", job_name_regex: "", job_name_exclude_regex: null },
      ],
      dependencies: [{ job_name: 20241105, depends_on: 99, dependency_type: "service", notes: 3 }],
    }),
  ) as JobListDocument;
}

describe("withLoaderText", () => {
  it("reads each text field the way the loader's str() does", () => {
    const read = withLoaderText(storedBeforeTextFix());
    expect(read.defaults).toEqual({ owner: "42", notes: "", job_name_exclude_regex: "False", max_gap_minutes: 60 });
    expect(read.workspaces).toEqual([
      { workspace_name: "2024", environment: "1", notes: "2024" },
      { workspace_id: "1111111111111111", workspace_name: "True", environment: "lower", notes: "True" },
    ]);
    expect(read.jobs).toEqual([
      { job_name: "20241105", notes: "True", owner: "7", job_name_exclude_regex: "0", enabled: true, max_retries: 2, job_ids: ["123"] },
      { job_name: "True", job_name_regex: "", environments: { lower: { owner: "5", max_gap_minutes: 30 }, "1": { owner: "" } } },
      { job_name: "kept_as_written", owner: null, notes: "", job_name_regex: "", job_name_exclude_regex: null },
    ]);
    expect(read.dependencies).toEqual([{ job_name: "20241105", depends_on: "99", dependency_type: "service", notes: "3" }]);
  });

  it("leaves a document of text alone, and never changes the one it is given", () => {
    const stored = storedBeforeTextFix();
    const copy = structuredClone(stored);
    withLoaderText(stored);
    expect(stored).toEqual(copy);
    const text: JobListDocument = { jobs: [{ job_name: "orders_ingest", owner: " platform-team ", notes: "on" }] };
    expect(withLoaderText(text)).toEqual(text);
  });
});

describe("getJobList", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives the pages the stored text fields as text", async () => {
    const state = { version: 3, savedAt: "2026-11-05T10:05:00Z", savedBy: "someone@example.com", document: storedBeforeTextFix() };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(state), { headers: { "Content-Type": "application/json" } }))),
    );
    const loaded = await getJobList();
    expect(loaded.document.jobs.map((job) => job.job_name)).toEqual(["20241105", "True", "kept_as_written"]);
    expect(loaded.document.workspaces?.[0]?.workspace_name).toBe("2024");
  });
});
