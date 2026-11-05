import { describe, expect, it } from "vitest";
import { dependencyKey, type JobListDocument } from "../../../shared/joblist/types";
import { EXAMPLE_DOCUMENT } from "../test/example-document";
import {
  type GraphNode,
  buildGraph,
  changeIssues,
  downstreamOf,
  jobNodeId,
  linkChange,
  serviceNodeId,
  unlinkChange,
} from "./graph";
import type { Status } from "./status";

const STATUSES = new Map<string, Status>([
  ["watchdog_demo_fails", "FAILED"],
  ["watchdog_demo_slow", "WARNING"],
  ["watchdog_demo_succeeds", "HEALTHY"],
]);

function node(nodes: GraphNode[], id: string): GraphNode {
  const found = nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

function overlaps(a: GraphNode, b: GraphNode): boolean {
  return (
    a.position.x < b.position.x + b.width &&
    b.position.x < a.position.x + a.width &&
    a.position.y < b.position.y + b.height &&
    b.position.y < a.position.y + a.height
  );
}

describe("buildGraph", () => {
  const { nodes, edges } = buildGraph(EXAMPLE_DOCUMENT, STATUSES);

  it("makes each job a node with its live status, UNKNOWN when the scan has none", () => {
    const jobs = nodes.filter((n) => n.kind === "job");
    expect(jobs.map((n) => n.name)).toEqual(EXAMPLE_DOCUMENT.jobs.map((j) => j.job_name));
    expect(node(nodes, jobNodeId("watchdog_demo_fails")).status).toBe("FAILED");
    expect(node(nodes, jobNodeId("watchdog_demo_slow")).status).toBe("WARNING");
    expect(node(nodes, jobNodeId("orders_ingest")).status).toBe("UNKNOWN");
  });

  it("makes each service named in a service link a node of kind service", () => {
    const services = nodes.filter((n) => n.kind === "service");
    expect(services.map((n) => n.name)).toEqual(["kafka", "config_api", "object_storage"]);
    expect(services.every((n) => n.status === "UNKNOWN")).toBe(true);
  });

  it("draws a job link from depends_on to job_name, upstream to downstream", () => {
    const edge = edges.find((e) => e.id === "orders_enrich->orders_ingest:job");
    expect(edge).toMatchObject({ source: jobNodeId("orders_ingest"), target: jobNodeId("orders_enrich"), type: "job", line: "solid" });
  });

  it("draws a child_job link dashed, from the parent to the child", () => {
    const edge = edges.find((e) => e.type === "child_job");
    expect(edge).toMatchObject({
      source: jobNodeId("daily_revenue_report"),
      target: jobNodeId("daily_revenue_export"),
      line: "dashed",
    });
  });

  it("draws a service link dotted, from the service to the job", () => {
    const edge = edges.find((e) => e.id === "orders_ingest->kafka:service");
    expect(edge).toMatchObject({ source: serviceNodeId("kafka"), target: jobNodeId("orders_ingest"), type: "service", line: "dotted" });
  });

  it("keys every edge by dependencyKey, so removing it targets the same dependency", () => {
    expect(edges.map((e) => e.id)).toEqual((EXAMPLE_DOCUMENT.dependencies ?? []).map(dependencyKey));
  });

  it("lays the links out left to right: every edge points right", () => {
    for (const edge of edges) {
      const from = node(nodes, edge.source);
      const to = node(nodes, edge.target);
      expect(from.position.x + from.width, `${edge.id}`).toBeLessThan(to.position.x);
    }
  });

  it("places no box on top of another for the example job list", () => {
    for (const [i, a] of nodes.entries()) {
      for (const b of nodes.slice(i + 1)) expect(overlaps(a, b), `${a.id} and ${b.id}`).toBe(false);
    }
  });

  it("puts jobs without links in a grid below the linked ones", () => {
    const unlinked = nodes.filter((n) => !n.linked);
    expect(unlinked.map((n) => n.name)).toEqual(["watchdog_demo_slow", "watchdog_demo_retries"]);
    const linkedBottom = Math.max(...nodes.filter((n) => n.linked).map((n) => n.position.y + n.height));
    for (const n of unlinked) expect(n.position.y).toBeGreaterThan(linkedBottom);
  });

  it("marks jobs that are switched off everywhere", () => {
    expect(node(nodes, jobNodeId("orders_ingest")).active).toBe(false);
    expect(node(nodes, jobNodeId("watchdog_demo_fails")).active).toBe(true);
    const onInOneLabel: JobListDocument = { jobs: [{ job_name: "a", enabled: false, environments: { lower: { enabled: true } } }] };
    expect(buildGraph(onInOneLabel, new Map()).nodes[0].active).toBe(true);
    const offByDefault: JobListDocument = { defaults: { enabled: false }, jobs: [{ job_name: "a" }] };
    expect(buildGraph(offByDefault, new Map()).nodes[0].active).toBe(false);
  });

  it("draws a repeated dependency once", () => {
    const twice: JobListDocument = {
      jobs: [{ job_name: "a" }, { job_name: "b" }],
      dependencies: [
        { job_name: "b", depends_on: "a" },
        { job_name: "b", depends_on: "a", dependency_type: "job" },
      ],
    };
    expect(buildGraph(twice, new Map()).edges.map((e) => e.id)).toEqual(["b->a:job"]);
  });

  it("keeps a job and a service with the same name apart", () => {
    const sameName: JobListDocument = {
      jobs: [{ job_name: "kafka" }, { job_name: "orders" }],
      dependencies: [{ job_name: "orders", depends_on: "kafka", dependency_type: "service" }],
    };
    const graph = buildGraph(sameName, new Map());
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([jobNodeId("kafka"), jobNodeId("orders"), serviceNodeId("kafka")].sort());
    expect(graph.edges[0].source).toBe(serviceNodeId("kafka"));
  });

  it("still draws a box for a job a link names that is not in the list, marked as not listed", () => {
    const missing: JobListDocument = { jobs: [{ job_name: "b" }], dependencies: [{ job_name: "b", depends_on: "gone" }] };
    const graph = buildGraph(missing, new Map());
    expect(node(graph.nodes, jobNodeId("gone")).listed).toBe(false);
    expect(node(graph.nodes, jobNodeId("b")).listed).toBe(true);
  });

  it("gives an empty list an empty graph", () => {
    expect(buildGraph({ jobs: [] }, new Map())).toEqual({ nodes: [], edges: [] });
  });
});

describe("downstreamOf", () => {
  it("lists what a job's failure affects, from impactOf, and the links between them", () => {
    const result = downstreamOf(EXAMPLE_DOCUMENT, { kind: "job", name: "orders_ingest" });
    expect(result.jobs).toEqual(["daily_revenue_export", "daily_revenue_report", "orders_enrich"]);
    expect([...result.edges].sort()).toEqual(
      ["daily_revenue_export->daily_revenue_report:child_job", "daily_revenue_report->orders_enrich:job", "orders_enrich->orders_ingest:job"].sort(),
    );
  });

  it("follows a child job back to its parent, as the scan does", () => {
    expect(downstreamOf(EXAMPLE_DOCUMENT, { kind: "job", name: "daily_revenue_export" }).jobs).toEqual(["daily_revenue_report"]);
  });

  it("lists the jobs that need a service and everything downstream of them", () => {
    const result = downstreamOf(EXAMPLE_DOCUMENT, { kind: "service", name: "config_api" });
    expect(result.jobs).toEqual(["daily_revenue_export", "daily_revenue_report", "orders_enrich"]);
    expect(result.edges.has("orders_enrich->config_api:service")).toBe(true);
  });

  it("gives nothing for a job nobody depends on", () => {
    const result = downstreamOf(EXAMPLE_DOCUMENT, { kind: "job", name: "watchdog_demo_slow" });
    expect(result.jobs).toEqual([]);
    expect(result.edges.size).toBe(0);
  });
});

describe("changeIssues", () => {
  it("finds nothing wrong with a valid new link", () => {
    expect(changeIssues(EXAMPLE_DOCUMENT, linkChange("watchdog_demo_slow", "watchdog_demo_retries", "job"))).toEqual([]);
  });

  it("finds a second parent for a child job, with the rule's own message", () => {
    const issues = changeIssues(EXAMPLE_DOCUMENT, linkChange("orders_enrich", "daily_revenue_export", "child_job"));
    expect(issues.map((i) => i.message)).toEqual([
      "job daily_revenue_export is a child_job of both daily_revenue_report and orders_enrich; a job can have only one parent",
    ]);
  });

  it("finds a job link to a name that is not a job", () => {
    const issues = changeIssues(EXAMPLE_DOCUMENT, linkChange("kafka", "orders_ingest", "job"));
    expect(issues[0]?.message).toContain("kafka is not a configured job");
  });

  it("reports a change that cannot be applied, such as removing a link that is gone", () => {
    expect(changeIssues(EXAMPLE_DOCUMENT, unlinkChange("a->b:job"))).toEqual([
      { path: "dependency:a->b:job", message: "there is nothing to delete at dependency:a->b:job" },
    ]);
  });

  it("leaves out problems the list had before the change", () => {
    const broken: JobListDocument = { jobs: [{ job_name: "a", schedule_type: "scheduled" }, { job_name: "b", schedule_type: "triggered" }] };
    expect(changeIssues(broken, linkChange("a", "b", "job"))).toEqual([]);
  });
});

describe("linkChange and unlinkChange", () => {
  it("builds the upsert of a link, keyed by dependencyKey", () => {
    expect(linkChange("orders_ingest", "orders_enrich", "job")).toEqual({
      kind: "upsert",
      target: { type: "dependency", key: "orders_enrich->orders_ingest:job" },
      value: { job_name: "orders_enrich", depends_on: "orders_ingest", dependency_type: "job" },
    });
    expect(linkChange("kafka", "orders_ingest", "service", "Reads order events.")).toEqual({
      kind: "upsert",
      target: { type: "dependency", key: "orders_ingest->kafka:service" },
      value: { job_name: "orders_ingest", depends_on: "kafka", dependency_type: "service", notes: "Reads order events." },
    });
  });

  it("builds the delete of a link from its edge key", () => {
    expect(unlinkChange("daily_revenue_export->daily_revenue_report:child_job")).toEqual({
      kind: "delete",
      target: { type: "dependency", key: "daily_revenue_export->daily_revenue_report:child_job" },
    });
  });
});
