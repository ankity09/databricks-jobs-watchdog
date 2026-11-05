import { type EdgeLabel, Graph, type GraphLabel, type NodeLabel, layout } from "@dagrejs/dagre";
import { ChangeError, applyChange } from "../../../shared/joblist/apply";
import { impactOf } from "../../../shared/joblist/impact";
import { validateDocument } from "../../../shared/joblist/rules";
import {
  type Change,
  type DependencyEntry,
  type DependencyType,
  type JobEntry,
  type JobListDocument,
  type RuleIssue,
  dependencyKey,
  targetKey,
} from "../../../shared/joblist/types";
import type { Status } from "./status";

export type NodeKind = "job" | "service";
export type EdgeLine = "solid" | "dashed" | "dotted";

/** One box on the dependency map, with its top-left corner from the layout. */
export interface GraphNode {
  /** "job:<name>" or "service:<name>": a job and a service may share a name. */
  id: string;
  kind: NodeKind;
  name: string;
  /** The job's live status; services have none, so they are UNKNOWN. */
  status: Status;
  /** False for a job switched off in every environment. */
  active: boolean;
  /** False for a job a link names that is not in the jobs section. */
  listed: boolean;
  /** True when at least one link starts or ends here. */
  linked: boolean;
  position: { x: number; y: number };
  width: number;
  height: number;
}

/** One link on the map, drawn from upstream (source) to downstream (target). */
export interface GraphEdge {
  /** dependencyKey of the link, which is also the key that removes it. */
  id: string;
  source: string;
  target: string;
  type: DependencyType;
  line: EdgeLine;
  dependency: DependencyEntry;
}

export const JOB_SIZE = { width: 204, height: 54 } as const;
export const SERVICE_SIZE = { width: 148, height: 32 } as const;

const LINES: Record<DependencyType, EdgeLine> = { job: "solid", child_job: "dashed", service: "dotted" };
const NODE_GAP = 22; // between boxes in the same column
const RANK_GAP = 60; // between columns
const GRID_GAP_X = 20;
const GRID_GAP_Y = 18;
const SECTION_GAP = 64; // between the linked graph and the grid of jobs without links

export function jobNodeId(name: string): string {
  return `job:${name}`;
}

export function serviceNodeId(name: string): string {
  return `service:${name}`;
}

/** True when the job is checked in at least one environment (config.py's MonitoredJob.active). */
function isActive(job: JobEntry | undefined, doc: JobListDocument): boolean {
  if (!job) return true;
  if ((job.enabled ?? doc.defaults?.enabled ?? true) !== false) return true;
  return Object.values(job.environments ?? {}).some((overrides) => overrides.enabled === true);
}

type Unplaced = Omit<GraphNode, "position" | "linked">;

/**
 * Lays the linked boxes out with dagre, left to right, and puts the jobs with
 * no links in a grid below them, so a long list without links does not become
 * one tall column.
 */
function place(nodes: Unplaced[], edges: GraphEdge[]): GraphNode[] {
  const linkedIds = new Set(edges.flatMap((e) => [e.source, e.target]));
  const positions = new Map<string, { x: number; y: number }>();
  let bottom = 0;

  if (linkedIds.size > 0) {
    const g = new Graph<GraphLabel, NodeLabel, EdgeLabel>();
    g.setGraph({ rankdir: "LR", nodesep: NODE_GAP, ranksep: RANK_GAP, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of nodes) if (linkedIds.has(n.id)) g.setNode(n.id, { width: n.width, height: n.height });
    for (const e of edges) g.setEdge(e.source, e.target);
    layout(g);
    for (const n of nodes) {
      if (!linkedIds.has(n.id)) continue;
      const placed = g.node(n.id);
      const x = Math.round((placed.x ?? 0) - n.width / 2);
      const y = Math.round((placed.y ?? 0) - n.height / 2);
      positions.set(n.id, { x, y });
      bottom = Math.max(bottom, y + n.height);
    }
  }

  const unlinked = nodes.filter((n) => !linkedIds.has(n.id));
  const columns = Math.min(unlinked.length, Math.max(4, Math.ceil(Math.sqrt(unlinked.length))), 8);
  const top = linkedIds.size > 0 ? bottom + SECTION_GAP : 0;
  unlinked.forEach((n, i) => {
    const column = i % columns;
    const row = Math.floor(i / columns);
    positions.set(n.id, { x: column * (JOB_SIZE.width + GRID_GAP_X), y: top + row * (JOB_SIZE.height + GRID_GAP_Y) });
  });

  return nodes.map((n) => ({ ...n, linked: linkedIds.has(n.id), position: positions.get(n.id) ?? { x: 0, y: 0 } }));
}

/**
 * The dependency map of a job list: a box per job (with its live status,
 * UNKNOWN when the scan has none) and per service, and an edge per link, from
 * depends_on to job_name. Job links are solid, child_job links dashed (parent
 * to child), service links dotted (service to job). A repeated link is drawn once.
 */
export function buildGraph(doc: JobListDocument, statuses: ReadonlyMap<string, Status>): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const entries = new Map(doc.jobs.map((job) => [job.job_name, job] as const));
  const jobs = new Map<string, Unplaced>();
  const services = new Map<string, Unplaced>();

  const addJob = (name: string) => {
    if (jobs.has(name)) return;
    const entry = entries.get(name);
    jobs.set(name, {
      id: jobNodeId(name),
      kind: "job",
      name,
      status: statuses.get(name) ?? "UNKNOWN",
      active: isActive(entry, doc),
      listed: entry !== undefined,
      ...JOB_SIZE,
    });
  };
  const addService = (name: string) => {
    if (services.has(name)) return;
    services.set(name, { id: serviceNodeId(name), kind: "service", name, status: "UNKNOWN", active: true, listed: true, ...SERVICE_SIZE });
  };

  for (const job of doc.jobs) addJob(job.job_name);
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const dependency of doc.dependencies ?? []) {
    const key = dependencyKey(dependency);
    if (seen.has(key)) continue;
    seen.add(key);
    const type = dependency.dependency_type ?? "job";
    addJob(dependency.job_name);
    if (type === "service") addService(dependency.depends_on);
    else addJob(dependency.depends_on);
    edges.push({
      id: key,
      source: type === "service" ? serviceNodeId(dependency.depends_on) : jobNodeId(dependency.depends_on),
      target: jobNodeId(dependency.job_name),
      type,
      line: LINES[type],
      dependency,
    });
  }

  return { nodes: place([...jobs.values(), ...services.values()], edges), edges };
}

/** What to highlight when a box is selected: the jobs a failure there affects, and the links between them. */
export interface Downstream {
  jobs: string[];
  edges: Set<string>;
}

/**
 * The jobs downstream of a selected box. For a job, what its failure affects
 * through the whole chain (impactOf, as the scan computes it). For a service,
 * the jobs that need it and everything downstream of those.
 */
export function downstreamOf(doc: JobListDocument, selected: { kind: NodeKind; name: string }): Downstream {
  const deps = doc.dependencies ?? [];
  const affected = new Set<string>();
  const edges = new Set<string>();
  const members = new Set<string>();

  if (selected.kind === "job") {
    for (const job of impactOf(doc, selected.name).affectsInAll) affected.add(job);
    members.add(selected.name);
  } else {
    for (const d of deps) {
      if ((d.dependency_type ?? "job") !== "service" || d.depends_on !== selected.name) continue;
      edges.add(dependencyKey(d));
      affected.add(d.job_name);
      for (const job of impactOf(doc, d.job_name).affectsInAll) affected.add(job);
    }
  }
  for (const job of affected) members.add(job);
  for (const d of deps) {
    if ((d.dependency_type ?? "job") === "service") continue;
    if (members.has(d.job_name) && members.has(d.depends_on)) edges.add(dependencyKey(d));
  }
  return { jobs: [...affected].sort(), edges };
}

/**
 * What would be wrong with the job list after a change, from the shared rules
 * (the same port of config.py the server checks with). Problems the list had
 * before the change are left out, so the map only blames the new link.
 */
export function changeIssues(doc: JobListDocument, change: Change): RuleIssue[] {
  let next: JobListDocument;
  try {
    next = applyChange(doc, change).document;
  } catch (error) {
    if (error instanceof ChangeError) return [{ path: targetKey(change.target), message: error.message }];
    throw error;
  }
  const before = new Set(validateDocument(doc).map((issue) => `${issue.path}\n${issue.message}`));
  return validateDocument(next).filter((issue) => !before.has(`${issue.path}\n${issue.message}`));
}

/** The change that adds a link: target depends on source. */
export function linkChange(source: string, target: string, type: DependencyType, notes?: string): Change {
  const value: DependencyEntry = { job_name: target, depends_on: source, dependency_type: type };
  if (notes) value.notes = notes;
  return { kind: "upsert", target: { type: "dependency", key: dependencyKey(value) }, value };
}

/** The change that removes the link with this edge key (its dependencyKey). */
export function unlinkChange(edgeKey: string): Change {
  return { kind: "delete", target: { type: "dependency", key: edgeKey } };
}
