/**
 * What a failure of each job affects, through the whole dependency chain.
 * A line-for-line port of jobs_watchdog/dependencies.py, so the app shows the
 * same impact as the scan.
 *
 * For a `job` dependency, a failure of depends_on affects job_name. A
 * `child_job` dependency (job_name is a child that depends_on starts) counts
 * both ways: a parent failure affects its children, which will not start, and a
 * child failure affects its parent, whose run fails, and so everything
 * downstream of the parent. `service` dependencies are not job-to-job edges.
 *
 * Lists are sorted the way Python sorts strings (by code point), and the
 * records have no prototype, so a job named "constructor" is just a key.
 */
import type { DependencyEntry, DependencyType, Impact, JobListDocument } from "./types";

function typeOf(d: DependencyEntry): DependencyType {
  return d.dependency_type ?? "job";
}

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Python's string order: by code point, not by UTF-16 code unit. */
function compareStrings(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(j) ?? 0;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}

/** Python's list order: item by item, and a shorter prefix first. */
function compareLists(a: string[], b: string[]): number {
  for (let k = 0; k < Math.min(a.length, b.length); k++) {
    const order = compareStrings(a[k], b[k]);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

function sorted(items: Iterable<string>): string[] {
  return Array.from(items).sort(compareStrings);
}

function addEdge(edges: Map<string, Set<string>>, from: string, to: string): void {
  const targets = edges.get(from);
  if (targets) targets.add(to);
  else edges.set(from, new Set([to]));
}

/** child job name -> its parent's job name, from the child_job dependencies. */
export function parentJobs(deps: DependencyEntry[]): Record<string, string> {
  const parents = emptyRecord<string>();
  for (const d of deps) {
    if (typeOf(d) === "child_job") parents[d.job_name] = d.depends_on;
  }
  return parents;
}

/** job name -> the jobs its failure affects directly. */
export function impactEdges(deps: DependencyEntry[]): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const d of deps) {
    const type = typeOf(d);
    if (type === "job") {
      addEdge(edges, d.depends_on, d.job_name);
    } else if (type === "child_job") {
      addEdge(edges, d.depends_on, d.job_name); // a parent failure: the child does not start
      addEdge(edges, d.job_name, d.depends_on); // a child failure: the parent's run fails
    }
  }
  return edges;
}

/** job name -> every job downstream of it, sorted, never the job itself. Loops are fine: each job is visited once. */
export function affectedJobs(deps: DependencyEntry[]): Record<string, string[]> {
  const edges = impactEdges(deps);
  const affected = emptyRecord<string[]>();
  for (const [start, targets] of edges) {
    const seen = new Set<string>();
    const stack = Array.from(targets);
    for (let job = stack.pop(); job !== undefined; job = stack.pop()) {
      if (job === start || seen.has(job)) continue;
      seen.add(job);
      for (const next of edges.get(job) ?? []) stack.push(next);
    }
    affected[start] = sorted(seen);
  }
  return affected;
}

/**
 * Groups of jobs that depend on each other in a loop, through job dependencies only.
 * child_job links always point both ways, so they are left out here. Each loop
 * is a sorted list of job names, and the loops are sorted too.
 */
export function dependencyLoops(deps: DependencyEntry[]): string[][] {
  const edges = new Map<string, Set<string>>();
  for (const d of deps) {
    if (typeOf(d) === "job") addEdge(edges, d.depends_on, d.job_name);
  }
  const nodes = new Set<string>(edges.keys());
  for (const targets of edges.values()) for (const job of targets) nodes.add(job);
  const reach = new Map<string, Set<string>>();
  for (const start of nodes) {
    const seen = new Set<string>();
    const stack = Array.from(edges.get(start) ?? []);
    for (let job = stack.pop(); job !== undefined; job = stack.pop()) {
      if (seen.has(job)) continue;
      seen.add(job);
      for (const next of edges.get(job) ?? []) stack.push(next);
    }
    reach.set(start, seen);
  }
  const loops = new Map<string, string[]>();
  for (const start of nodes) {
    const fromStart = reach.get(start) ?? new Set<string>();
    if (!fromStart.has(start)) continue;
    const members = new Set<string>([start]);
    for (const job of fromStart) if (reach.get(job)?.has(start)) members.add(job);
    const loop = sorted(members);
    loops.set(JSON.stringify(loop), loop);
  }
  return Array.from(loops.values()).sort(compareLists);
}

/** One job's row of the impact table: its parent, what it affects directly, and everything downstream. */
export function impactOf(doc: JobListDocument, jobName: string): Impact {
  const deps = doc.dependencies ?? [];
  const parents = parentJobs(deps);
  const affected = affectedJobs(deps);
  return {
    jobName,
    parentJob: has(parents, jobName) ? parents[jobName] : null,
    affectsDirectly: sorted(impactEdges(deps).get(jobName) ?? []),
    affectsInAll: has(affected, jobName) ? affected[jobName] : [],
  };
}
