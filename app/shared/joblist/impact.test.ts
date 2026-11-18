import { describe, expect, it } from "vitest";
import { affectedJobs, dependencyLoops, impactOf, parentJobs } from "./impact";
import type { DependencyEntry } from "./types";

const deps: DependencyEntry[] = [
  { job_name: "orders_enrich", depends_on: "orders_ingest", dependency_type: "job" },
  { job_name: "daily_revenue_report", depends_on: "orders_enrich", dependency_type: "job" },
  { job_name: "daily_revenue_export", depends_on: "daily_revenue_report", dependency_type: "child_job" },
  { job_name: "orders_ingest", depends_on: "kafka", dependency_type: "service" },
];

describe("impact", () => {
  it("follows the whole chain and never lists the job itself", () => {
    expect(affectedJobs(deps)["orders_ingest"]).toEqual(["daily_revenue_export", "daily_revenue_report", "orders_enrich"]);
  });
  it("counts a child_job link both ways", () => {
    expect(affectedJobs(deps)["daily_revenue_export"]).toEqual(["daily_revenue_report"]);
    expect(parentJobs(deps)).toEqual({ daily_revenue_export: "daily_revenue_report" });
  });
  it("ignores service links as job edges", () => {
    expect(affectedJobs(deps)["kafka"]).toBeUndefined();
  });
  it("finds loops through job links only", () => {
    const loop: DependencyEntry[] = [
      { job_name: "a", depends_on: "b", dependency_type: "job" },
      { job_name: "b", depends_on: "a", dependency_type: "job" },
    ];
    expect(dependencyLoops(loop)).toEqual([["a", "b"]]);
  });
  it("builds the impact of one job from a document", () => {
    expect(impactOf({ jobs: [], dependencies: deps }, "daily_revenue_export")).toEqual({
      jobName: "daily_revenue_export", parentJob: "daily_revenue_report",
      affectsDirectly: ["daily_revenue_report"], affectsInAll: ["daily_revenue_report"],
    });
  });
  it("finds a longer loop once", () => {
    const loop: DependencyEntry[] = [
      { job_name: "b", depends_on: "a" },
      { job_name: "c", depends_on: "b" },
      { job_name: "a", depends_on: "c" },
    ];
    expect(dependencyLoops(loop)).toEqual([["a", "b", "c"]]);
  });
  it("reads a missing dependency_type as job, like the Python loader", () => {
    expect(affectedJobs([{ job_name: "b", depends_on: "a" }])["a"]).toEqual(["b"]);
  });
  it("sorts names by code point, the way Python sorts strings", () => {
    const children: DependencyEntry[] = [
      { job_name: "\u{1F600}_export", depends_on: "parent", dependency_type: "job" },
      { job_name: "\uFF5E_export", depends_on: "parent", dependency_type: "job" },
    ];
    expect(affectedJobs(children)["parent"]).toEqual(["\uFF5E_export", "\u{1F600}_export"]);
  });
  it("treats job names like constructor or toString as plain keys", () => {
    const named: DependencyEntry[] = [{ job_name: "toString", depends_on: "constructor", dependency_type: "job" }];
    expect(parentJobs(named)["constructor"]).toBeUndefined();
    expect(affectedJobs(named)["toString"]).toBeUndefined();
    expect(impactOf({ jobs: [], dependencies: named }, "toString")).toEqual({
      jobName: "toString", parentJob: null, affectsDirectly: [], affectsInAll: [],
    });
  });
});
