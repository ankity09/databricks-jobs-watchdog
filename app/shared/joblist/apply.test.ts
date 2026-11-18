import { describe, expect, it } from "vitest";
import { applyChange, ChangeError, sameTargetValue, targetValue } from "./apply";
import type { Change, JobListDocument } from "./types";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const base = (): JobListDocument => ({
  defaults: { owner: "platform-team" },
  workspaces: [{ workspace_id: "123", environment: "lower" }],
  jobs: [
    { job_name: "orders_ingest", max_gap_minutes: 60, owner: "a", severity: "WARNING" },
    { job_name: "orders_enrich", max_gap_minutes: 30 },
  ],
  dependencies: [
    { job_name: "orders_enrich", depends_on: "orders_ingest" },
    { job_name: "orders_enrich", depends_on: "orders_ingest", dependency_type: "child_job" },
    { job_name: "orders_enrich", depends_on: "orders_ingest", dependency_type: "service" },
    { job_name: "orders_enrich", depends_on: "kafka", dependency_type: "service" },
  ],
});

const job = (name: string) => ({ type: "job", name }) as const;

describe("applyChange: jobs", () => {
  it("creates a job", () => {
    const r = applyChange(base(), { kind: "upsert", target: job("new_job"), value: { job_name: "new_job", max_gap_minutes: 5 } });
    expect(r.summary).toBe("Added job new_job");
    expect(r.changeKind).toBe("create");
    expect(r.changeTarget).toBe("job:new_job");
    expect(r.document.jobs.map((j) => j.job_name)).toEqual(["orders_ingest", "orders_enrich", "new_job"]);
  });
  it("changes one field", () => {
    const r = applyChange(base(), { kind: "upsert", target: job("orders_ingest"), value: { job_name: "orders_ingest", max_gap_minutes: 90, owner: "a", severity: "WARNING" } });
    expect(r.summary).toBe("Changed max_gap_minutes on orders_ingest from 60 to 90");
    expect(r.changeKind).toBe("update");
  });
  it("changes several fields, sorted", () => {
    const r = applyChange(base(), { kind: "upsert", target: job("orders_ingest"), value: { job_name: "orders_ingest", max_gap_minutes: 90, owner: "b", severity: "CRITICAL" } });
    expect(r.summary).toBe("Changed 3 settings on orders_ingest: max_gap_minutes, owner, severity");
  });
  it("prints unset values", () => {
    const r = applyChange(base(), { kind: "upsert", target: job("orders_enrich"), value: { job_name: "orders_enrich", max_gap_minutes: 30, owner: "z" } });
    expect(r.summary).toBe("Changed owner on orders_enrich from unset to z");
    const r2 = applyChange(base(), { kind: "upsert", target: job("orders_ingest"), value: { job_name: "orders_ingest", max_gap_minutes: 60, severity: "WARNING" } });
    expect(r2.summary).toBe("Changed owner on orders_ingest from a to unset");
  });
  it("refuses a rename", () => {
    expect(() => applyChange(base(), { kind: "upsert", target: job("orders_ingest"), value: { job_name: "other", max_gap_minutes: 1 } }))
      .toThrow("a job cannot be renamed: delete it and add it again");
  });
  it("deletes a job and its links, keeping a service of the same name", () => {
    const r = applyChange(
      { ...base(), dependencies: [
        { job_name: "orders_enrich", depends_on: "orders_ingest" },
        { job_name: "orders_ingest", depends_on: "orders_enrich", dependency_type: "child_job" },
        { job_name: "orders_enrich", depends_on: "orders_ingest", dependency_type: "service" },
      ] },
      { kind: "delete", target: job("orders_ingest") },
    );
    expect(r.summary).toBe("Deleted job orders_ingest and 2 links");
    expect(r.changeKind).toBe("delete");
    expect(r.document.jobs.map((j) => j.job_name)).toEqual(["orders_enrich"]);
    expect(r.document.dependencies).toEqual([{ job_name: "orders_enrich", depends_on: "orders_ingest", dependency_type: "service" }]);
  });
  it("says 'link' for one and nothing for none", () => {
    const one = applyChange({ jobs: [{ job_name: "a" }, { job_name: "b" }], dependencies: [{ job_name: "b", depends_on: "a" }] }, { kind: "delete", target: job("a") });
    expect(one.summary).toBe("Deleted job a and 1 link");
    expect(applyChange({ jobs: [{ job_name: "a" }] }, { kind: "delete", target: job("a") }).summary).toBe("Deleted job a");
  });
  it("throws when deleting a missing target", () => {
    expect(() => applyChange(base(), { kind: "delete", target: job("nope") })).toThrow(ChangeError);
  });
});

describe("applyChange: links", () => {
  it("links each type", () => {
    const doc: JobListDocument = { jobs: [] };
    const link = (dependency_type?: "job" | "child_job" | "service"): Change => ({
      kind: "upsert",
      target: { type: "dependency", key: `orders_enrich->orders_ingest:${dependency_type ?? "job"}` },
      value: { job_name: "orders_enrich", depends_on: "orders_ingest", ...(dependency_type ? { dependency_type } : {}) },
    });
    expect(applyChange(doc, link()).summary).toBe("Linked orders_enrich to orders_ingest (job)");
    expect(applyChange(doc, link("child_job")).summary).toBe("Linked orders_enrich to orders_ingest (child job)");
    expect(applyChange(doc, link("service")).summary).toBe("Linked orders_enrich to orders_ingest (service)");
    expect(applyChange(doc, link()).changeTarget).toBe("dependency:orders_enrich->orders_ingest:job");
  });
  it("removes a link", () => {
    const r = applyChange(base(), { kind: "delete", target: { type: "dependency", key: "orders_enrich->orders_ingest:job" } });
    expect(r.summary).toBe("Removed link orders_enrich -> orders_ingest (job)");
    expect(r.document.dependencies).toHaveLength(3);
  });
});

describe("applyChange: workspaces and defaults", () => {
  it("labels, changes and removes", () => {
    const empty: JobListDocument = { jobs: [] };
    const label = applyChange(empty, { kind: "upsert", target: { type: "workspace", key: "123" }, value: { workspace_id: "123", environment: "lower" } });
    expect(label.summary).toBe("Labeled workspace 123 as lower");
    expect(label.changeKind).toBe("create");
    const change = applyChange(label.document, { kind: "upsert", target: { type: "workspace", key: "123" }, value: { workspace_id: "123", environment: "production" } });
    expect(change.summary).toBe("Changed workspace 123 from lower to production");
    const gone = applyChange(change.document, { kind: "delete", target: { type: "workspace", key: "123" } });
    expect(gone.summary).toBe("Removed the label for workspace 123");
    expect(gone.document.workspaces).toEqual([]);
  });
  it("changes a default", () => {
    const r = applyChange(base(), { kind: "upsert", target: { type: "defaults" }, value: { owner: "data-team" } });
    expect(r.summary).toBe("Changed default owner from platform-team to data-team");
    expect(r.changeTarget).toBe("defaults");
    expect(r.changeKind).toBe("update");
  });
  it("sets a default that was unset", () => {
    const r = applyChange({ jobs: [] }, { kind: "upsert", target: { type: "defaults" }, value: { owner: "data-team" } });
    expect(r.summary).toBe("Changed default owner from unset to data-team");
    expect(r.changeKind).toBe("create");
  });
});

describe("applyChange: purity and comparison", () => {
  it("never mutates its input", () => {
    const frozen = deepFreeze(base());
    expect(() => applyChange(frozen, { kind: "delete", target: job("orders_ingest") })).not.toThrow();
    expect(() => applyChange(frozen, { kind: "upsert", target: job("orders_enrich"), value: { job_name: "orders_enrich", max_gap_minutes: 99 } })).not.toThrow();
    expect(frozen.jobs).toHaveLength(2);
  });
  it("sameTargetValue ignores key order", () => {
    const a: JobListDocument = { jobs: [{ job_name: "a", max_gap_minutes: 1, owner: "x" }] };
    const b: JobListDocument = { jobs: [{ owner: "x", max_gap_minutes: 1, job_name: "a" }] };
    expect(sameTargetValue(a, b, job("a"))).toBe(true);
    expect(sameTargetValue(a, { jobs: [{ job_name: "a", max_gap_minutes: 2, owner: "x" }] }, job("a"))).toBe(false);
    expect(sameTargetValue(a, { jobs: [] }, job("a"))).toBe(false);
    expect(sameTargetValue(a, { jobs: [] }, job("zzz"))).toBe(true);
  });
  it("targetValue returns the entry or undefined", () => {
    expect(targetValue(base(), job("orders_enrich"))).toEqual({ job_name: "orders_enrich", max_gap_minutes: 30 });
    expect(targetValue(base(), job("x"))).toBeUndefined();
    expect(targetValue(base(), { type: "defaults" })).toEqual({ owner: "platform-team" });
    expect(targetValue({ jobs: [] }, { type: "defaults" })).toBeUndefined();
  });
});
