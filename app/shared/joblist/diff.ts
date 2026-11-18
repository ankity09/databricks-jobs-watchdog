import { changedFields as fieldsOf, deepEqual } from "./apply";
import { dependencyKey, targetKey, workspaceKey, type DiffEntry, type JobListDocument, type Target } from "./types";

function compareSection<T>(
  before: T[], after: T[], key: (item: T) => string, target: (k: string) => Target, out: DiffEntry[],
): void {
  const b = new Map(before.map((item) => [key(item), item]));
  const a = new Map(after.map((item) => [key(item), item]));
  for (const k of new Set([...b.keys(), ...a.keys()])) {
    const was = b.get(k);
    const now = a.get(k);
    const name = targetKey(target(k));
    if (was === undefined) out.push({ target: name, kind: "added", fields: [] });
    else if (now === undefined) out.push({ target: name, kind: "removed", fields: [] });
    else if (!deepEqual(was, now)) out.push({ target: name, kind: "changed", fields: fieldsOf(was, now) });
  }
}

/** What differs between two job lists, section by section: defaults, workspaces, jobs, dependencies. */
export function diffDocuments(before: JobListDocument, after: JobListDocument): DiffEntry[] {
  const out: DiffEntry[] = [];
  const was = before.defaults && Object.keys(before.defaults).length > 0 ? before.defaults : undefined;
  const now = after.defaults && Object.keys(after.defaults).length > 0 ? after.defaults : undefined;
  if (was === undefined && now !== undefined) out.push({ target: "defaults", kind: "added", fields: [] });
  else if (was !== undefined && now === undefined) out.push({ target: "defaults", kind: "removed", fields: [] });
  else if (!deepEqual(was, now)) out.push({ target: "defaults", kind: "changed", fields: fieldsOf(was, now) });
  compareSection(before.workspaces ?? [], after.workspaces ?? [], workspaceKey, (key) => ({ type: "workspace", key }), out);
  compareSection(before.jobs, after.jobs, (j) => j.job_name, (name) => ({ type: "job", name }), out);
  compareSection(before.dependencies ?? [], after.dependencies ?? [], dependencyKey, (key) => ({ type: "dependency", key }), out);
  return out;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function importSummary(doc: JobListDocument): string {
  const jobs = count(doc.jobs.length, "job", "jobs");
  const links = count((doc.dependencies ?? []).length, "link", "links");
  const labels = count((doc.workspaces ?? []).length, "workspace label", "workspace labels");
  return `Imported ${jobs}, ${links} and ${labels} from YAML`;
}
