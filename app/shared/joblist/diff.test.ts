import { describe, expect, it } from "vitest";
import { diffDocuments, importSummary } from "./diff";
import type { JobListDocument } from "./types";

describe("diffDocuments", () => {
  it("is empty for equal documents", () => {
    const doc: JobListDocument = { jobs: [{ job_name: "a", max_gap_minutes: 1 }] };
    expect(diffDocuments(doc, structuredClone(doc))).toEqual([]);
  });
  it("reports added, removed and changed, in section order", () => {
    const before: JobListDocument = {
      defaults: { owner: "x" },
      workspaces: [{ workspace_id: "1", environment: "lower" }],
      jobs: [{ job_name: "a", max_gap_minutes: 1, owner: "o" }, { job_name: "gone", max_gap_minutes: 1 }],
      dependencies: [{ job_name: "a", depends_on: "gone" }],
    };
    const after: JobListDocument = {
      defaults: { owner: "y" },
      workspaces: [{ workspace_id: "1", environment: "production" }, { workspace_name: "Dev", environment: "lower" }],
      jobs: [{ job_name: "a", max_gap_minutes: 2, severity: "CRITICAL" }, { job_name: "fresh", max_gap_minutes: 1 }],
      dependencies: [{ job_name: "fresh", depends_on: "a", dependency_type: "child_job" }],
    };
    expect(diffDocuments(before, after)).toEqual([
      { target: "defaults", kind: "changed", fields: ["owner"] },
      { target: "workspace:1", kind: "changed", fields: ["environment"] },
      { target: "workspace:dev", kind: "added", fields: [] },
      { target: "job:a", kind: "changed", fields: ["max_gap_minutes", "owner", "severity"] },
      { target: "job:gone", kind: "removed", fields: [] },
      { target: "job:fresh", kind: "added", fields: [] },
      { target: "dependency:a->gone:job", kind: "removed", fields: [] },
      { target: "dependency:fresh->a:child_job", kind: "added", fields: [] },
    ]);
  });
  it("ignores key order", () => {
    expect(diffDocuments({ jobs: [{ job_name: "a", owner: "x", max_gap_minutes: 1 }] }, { jobs: [{ max_gap_minutes: 1, owner: "x", job_name: "a" }] })).toEqual([]);
  });
});

describe("importSummary", () => {
  it("counts jobs, links and workspace labels", () => {
    const doc: JobListDocument = {
      workspaces: [{ workspace_id: "1", environment: "a" }, { workspace_id: "2", environment: "b" }],
      jobs: Array.from({ length: 9 }, (_, i) => ({ job_name: `j${i}` })),
      dependencies: Array.from({ length: 4 }, (_, i) => ({ job_name: `j${i}`, depends_on: "j8" })),
    };
    expect(importSummary(doc)).toBe("Imported 9 jobs, 4 links and 2 workspace labels from YAML");
  });
  it("uses singular forms and zero for missing sections", () => {
    expect(importSummary({ jobs: [{ job_name: "a" }] })).toBe("Imported 1 job, 0 links and 0 workspace labels from YAML");
    expect(importSummary({ jobs: [{ job_name: "a" }], workspaces: [{ workspace_id: "1", environment: "a" }], dependencies: [{ job_name: "a", depends_on: "a" }] }))
      .toBe("Imported 1 job, 1 link and 1 workspace label from YAML");
  });
});
