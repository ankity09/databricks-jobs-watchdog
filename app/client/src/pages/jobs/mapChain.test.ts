import { describe, expect, it } from "vitest";
import type { JobListDocument } from "../../../../shared/joblist/types";
import { buildEdges, jobNodeId, serviceNodeId } from "../../lib/graph";
import { EXAMPLE_DOCUMENT } from "../../test/example-document";
import { impactSteps, stepsLabel, upstreamOf } from "./mapChain";

describe("upstreamOf", () => {
  const edges = buildEdges(EXAMPLE_DOCUMENT);

  it("follows every link back from a job: what it depends on, and what those depend on", () => {
    const up = upstreamOf(edges, jobNodeId("daily_revenue_report"));
    expect([...up.nodes].sort()).toEqual([jobNodeId("orders_enrich"), jobNodeId("orders_ingest"), serviceNodeId("config_api"), serviceNodeId("kafka")].sort());
    expect([...up.edges].sort()).toEqual(
      ["daily_revenue_report->orders_enrich:job", "orders_enrich->config_api:service", "orders_enrich->orders_ingest:job", "orders_ingest->kafka:service"].sort(),
    );
  });

  it("gives a service, which depends on nothing, an empty path", () => {
    const up = upstreamOf(edges, serviceNodeId("kafka"));
    expect(up.nodes.size).toBe(0);
    expect(up.edges.size).toBe(0);
  });

  it("stops at a loop instead of going round it", () => {
    const loop: JobListDocument = {
      jobs: [{ job_name: "a" }, { job_name: "b" }],
      dependencies: [
        { job_name: "b", depends_on: "a" },
        { job_name: "a", depends_on: "b" },
      ],
    };
    const up = upstreamOf(buildEdges(loop), jobNodeId("a"));
    expect([...up.nodes]).toEqual([jobNodeId("b")]);
    expect([...up.edges].sort()).toEqual(["a->b:job", "b->a:job"]);
  });
});

describe("impactSteps", () => {
  it("counts the steps from a job to each job its failure affects", () => {
    const steps = impactSteps(EXAMPLE_DOCUMENT, { kind: "job", name: "orders_ingest" });
    expect(Object.fromEntries(steps)).toEqual({ orders_enrich: 1, daily_revenue_report: 2, daily_revenue_export: 3 });
  });

  it("counts a child job's parent as one step, as the scan's impact does", () => {
    expect(Object.fromEntries(impactSteps(EXAMPLE_DOCUMENT, { kind: "job", name: "daily_revenue_export" }))).toEqual({ daily_revenue_report: 1 });
  });

  it("counts from a service: the jobs that need it are one step away", () => {
    const steps = impactSteps(EXAMPLE_DOCUMENT, { kind: "service", name: "kafka" });
    expect(Object.fromEntries(steps)).toEqual({ orders_ingest: 1, orders_enrich: 2, daily_revenue_report: 3, daily_revenue_export: 4 });
  });

  it("lists the same jobs as the scan's impact, in a loop too, never the job itself", () => {
    const loop: JobListDocument = {
      jobs: [{ job_name: "a" }, { job_name: "b" }, { job_name: "c" }],
      dependencies: [
        { job_name: "b", depends_on: "a" },
        { job_name: "c", depends_on: "b" },
        { job_name: "a", depends_on: "c" },
      ],
    };
    expect(Object.fromEntries(impactSteps(loop, { kind: "job", name: "a" }))).toEqual({ b: 1, c: 2 });
  });

  it("gives nothing for a job nobody depends on", () => {
    expect(impactSteps(EXAMPLE_DOCUMENT, { kind: "job", name: "watchdog_demo_slow" }).size).toBe(0);
  });
});

describe("stepsLabel", () => {
  it("says 1 step, and 2 steps", () => {
    expect(stepsLabel(1)).toBe("1 step");
    expect(stepsLabel(2)).toBe("2 steps");
  });
});
