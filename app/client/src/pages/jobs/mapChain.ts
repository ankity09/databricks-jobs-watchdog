import { impactEdges } from "../../../../shared/joblist/impact";
import type { JobListDocument } from "../../../../shared/joblist/types";
import type { GraphEdge, NodeKind } from "../../lib/graph";

/** What a selected box depends on: the boxes back along its links, and the links on the way. */
export interface Upstream {
  nodes: Set<string>;
  edges: Set<string>;
}

/**
 * Everything upstream of a box: what it depends on, what those depend on,
 * and so on, through every link drawn (services included). Each box is
 * visited once, so a loop ends.
 */
export function upstreamOf(edges: readonly GraphEdge[], nodeId: string): Upstream {
  const into = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const list = into.get(edge.target);
    if (list) list.push(edge);
    else into.set(edge.target, [edge]);
  }
  const nodes = new Set<string>();
  const onPath = new Set<string>();
  const stack = [nodeId];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    for (const edge of into.get(id) ?? []) {
      onPath.add(edge.id);
      if (edge.source === nodeId || nodes.has(edge.source)) continue;
      nodes.add(edge.source);
      stack.push(edge.source);
    }
  }
  return { nodes, edges: onPath };
}

/**
 * How many steps each affected job is from the selected box, along the same
 * impact links as the scan (impactEdges: a child job's failure reaches its
 * parent). From a service, the jobs that need it are one step away. The jobs
 * are the ones downstreamOf lists; the selected job itself is never one.
 */
export function impactSteps(doc: JobListDocument, selected: { kind: NodeKind; name: string }): Map<string, number> {
  const deps = doc.dependencies ?? [];
  const next = impactEdges(deps);
  let frontier =
    selected.kind === "job"
      ? [...(next.get(selected.name) ?? [])]
      : deps.filter((d) => d.dependency_type === "service" && d.depends_on === selected.name).map((d) => d.job_name);
  const steps = new Map<string, number>();
  for (let distance = 1; frontier.length > 0; distance++) {
    const following: string[] = [];
    for (const job of frontier) {
      if (steps.has(job) || (selected.kind === "job" && job === selected.name)) continue;
      steps.set(job, distance);
      following.push(...(next.get(job) ?? []));
    }
    frontier = following;
  }
  return steps;
}

/** "1 step", "2 steps". */
export function stepsLabel(steps: number): string {
  return steps === 1 ? "1 step" : `${steps} steps`;
}

/** What a failure of the selected box affects, in one sentence. */
export function affectsText(count: number): string {
  if (count === 0) return "A failure here affects no other job.";
  return count === 1 ? "A failure here affects 1 job." : `A failure here affects ${count} jobs.`;
}
