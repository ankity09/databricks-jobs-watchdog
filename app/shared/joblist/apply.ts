/**
 * Applying one change to a job list, without touching the input. The summary
 * is the plain sentence the version history shows.
 */
import { pySorted } from "./pyrepr";
import {
  dependencyKey, targetKey, workspaceKey,
  type Change, type ChangeKind, type DefaultsEntry, type DependencyEntry, type JobEntry,
  type JobListDocument, type Target, type WorkspaceEntry,
} from "./types";

export class ChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeError";
  }
}

export interface Applied {
  document: JobListDocument;
  changeKind: Exclude<ChangeKind, "import" | "restore">;
  changeTarget: string;
  summary: string;
}

type Entry = JobEntry | DependencyEntry | WorkspaceEntry | DefaultsEntry;

/** Deep equality that ignores key order and keys whose value is undefined. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const left = Object.entries(a).filter(([, v]) => v !== undefined);
    const right = Object.entries(b).filter(([, v]) => v !== undefined);
    if (left.length !== right.length) return false;
    const other = new Map(right);
    return left.every(([k, v]) => other.has(k) && deepEqual(v, other.get(k)));
  }
  return false;
}

function find<T>(items: T[] | undefined, match: (item: T) => boolean): number {
  return (items ?? []).findIndex(match);
}

/** The entry a target names in a document, or undefined when it is not there. */
export function targetValue(doc: JobListDocument, target: Target): unknown {
  switch (target.type) {
    case "job": return doc.jobs.find((j) => j.job_name === target.name);
    case "dependency": return doc.dependencies?.find((d) => dependencyKey(d) === target.key);
    case "workspace": return doc.workspaces?.find((w) => workspaceKey(w) === target.key);
    case "defaults": return doc.defaults && Object.keys(doc.defaults).length > 0 ? doc.defaults : undefined;
  }
}

export function sameTargetValue(a: JobListDocument, b: JobListDocument, target: Target): boolean {
  return deepEqual(targetValue(a, target), targetValue(b, target));
}

function show(value: unknown): string {
  if (value === undefined || value === null) return "unset";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

function asRecord(entry: unknown): Record<string, unknown> {
  return typeof entry === "object" && entry !== null ? Object.fromEntries(Object.entries(entry)) : {};
}

function changedFields(before: unknown, after: unknown): string[] {
  const b = asRecord(before);
  const a = asRecord(after);
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  return pySorted([...keys].filter((k) => !deepEqual(b[k], a[k])));
}

function linkType(d: DependencyEntry): string {
  const type = d.dependency_type ?? "job";
  return type === "child_job" ? "child job" : type;
}

function describeLink(d: DependencyEntry): string {
  return `${d.job_name} -> ${d.depends_on} (${linkType(d)})`;
}

function workspaceLabel(w: WorkspaceEntry, fallback: string): string {
  return w.workspace_id ?? w.workspace_name ?? fallback;
}

function settings(count: number): string {
  return `${count} settings`;
}

function upsertSummary(target: Target, before: unknown, after: Entry): string {
  const fields = changedFields(before, after);
  switch (target.type) {
    case "job": {
      if (before === undefined) return `Added job ${target.name}`;
      if (fields.length === 0) return `No changes to job ${target.name}`;
      if (fields.length === 1) {
        const f = fields[0];
        return `Changed ${f} on ${target.name} from ${show(asRecord(before)[f])} to ${show(asRecord(after)[f])}`;
      }
      return `Changed ${settings(fields.length)} on ${target.name}: ${fields.join(", ")}`;
    }
    case "dependency": {
      const dep = after as DependencyEntry;
      if (before === undefined) return `Linked ${dep.job_name} to ${dep.depends_on} (${linkType(dep)})`;
      if (fields.length === 0) return `No changes to link ${describeLink(dep)}`;
      return `Changed ${fields.join(", ")} on link ${describeLink(dep)}`;
    }
    case "workspace": {
      const ws = after as WorkspaceEntry;
      const label = workspaceLabel(ws, target.key);
      if (before === undefined) return `Labeled workspace ${label} as ${ws.environment}`;
      if (fields.length === 0) return `No changes to workspace ${label}`;
      if (fields.length === 1 && fields[0] === "environment") {
        return `Changed workspace ${label} from ${show(asRecord(before).environment)} to ${ws.environment}`;
      }
      return `Changed ${fields.join(", ")} on workspace ${label}`;
    }
    case "defaults": {
      if (fields.length === 0) return "No changes to the defaults";
      if (fields.length === 1) {
        const f = fields[0];
        return `Changed default ${f} from ${show(asRecord(before)[f])} to ${show(asRecord(after)[f])}`;
      }
      return `Changed ${fields.length} defaults: ${fields.join(", ")}`;
    }
  }
}

function replaceOrAppend<T>(items: T[] | undefined, index: number, item: T): T[] {
  const next = [...(items ?? [])];
  if (index >= 0) next[index] = item;
  else next.push(item);
  return next;
}

function upsert(doc: JobListDocument, target: Target, value: Entry): Applied {
  const before = targetValue(doc, target);
  const kind = before === undefined ? "create" : "update";
  const next = structuredClone(doc);
  const copy = structuredClone(value);
  switch (target.type) {
    case "job": {
      if ((value as JobEntry).job_name !== target.name) {
        throw new ChangeError("a job cannot be renamed: delete it and add it again");
      }
      next.jobs = replaceOrAppend(next.jobs, find(next.jobs, (j) => j.job_name === target.name), copy as JobEntry);
      break;
    }
    case "dependency": {
      if (dependencyKey(value as DependencyEntry) !== target.key) {
        throw new ChangeError("a link cannot change which jobs it joins: remove it and add it again");
      }
      next.dependencies = replaceOrAppend(next.dependencies, find(next.dependencies, (d) => dependencyKey(d) === target.key), copy as DependencyEntry);
      break;
    }
    case "workspace": {
      if (workspaceKey(value as WorkspaceEntry) !== target.key) {
        throw new ChangeError("a workspace label cannot change which workspace it names: remove it and add it again");
      }
      next.workspaces = replaceOrAppend(next.workspaces, find(next.workspaces, (w) => workspaceKey(w) === target.key), copy as WorkspaceEntry);
      break;
    }
    case "defaults":
      next.defaults = copy as DefaultsEntry;
      break;
  }
  return { document: next, changeKind: kind, changeTarget: targetKey(target), summary: upsertSummary(target, before, value) };
}

function remove(doc: JobListDocument, target: Target): Applied {
  const before = targetValue(doc, target);
  if (before === undefined) throw new ChangeError(`there is nothing to delete at ${targetKey(target)}`);
  const next = structuredClone(doc);
  let summary: string;
  switch (target.type) {
    case "job": {
      const links = (next.dependencies ?? []).filter((d) => {
        const type = d.dependency_type ?? "job";
        return d.job_name === target.name || (type !== "service" && d.depends_on === target.name);
      });
      next.jobs = next.jobs.filter((j) => j.job_name !== target.name);
      if (next.dependencies) next.dependencies = next.dependencies.filter((d) => !links.includes(d));
      const n = links.length;
      summary = n === 0 ? `Deleted job ${target.name}` : `Deleted job ${target.name} and ${n} ${n === 1 ? "link" : "links"}`;
      break;
    }
    case "dependency":
      next.dependencies = (next.dependencies ?? []).filter((d) => dependencyKey(d) !== target.key);
      summary = `Removed link ${describeLink(before as DependencyEntry)}`;
      break;
    case "workspace":
      next.workspaces = (next.workspaces ?? []).filter((w) => workspaceKey(w) !== target.key);
      summary = `Removed the label for workspace ${workspaceLabel(before as WorkspaceEntry, target.key)}`;
      break;
    case "defaults":
      delete next.defaults;
      summary = "Removed all defaults";
      break;
  }
  return { document: next, changeKind: "delete", changeTarget: targetKey(target), summary };
}

export function applyChange(doc: JobListDocument, change: Change): Applied {
  return change.kind === "upsert" ? upsert(doc, change.target, change.value) : remove(doc, change.target);
}
