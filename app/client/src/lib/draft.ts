import { applyChange, ChangeError } from "../../../shared/joblist/apply";
import { validateDocument } from "../../../shared/joblist/rules";
import {
  type Change,
  type DependencyEntry,
  dependencyKey,
  type JobEntry,
  type JobListDocument,
  type RuleIssue,
  type WorkspaceEntry,
  workspaceKey,
} from "../../../shared/joblist/types";

/**
 * The issues the job list would have after `change`, checked with the same
 * rules the server and the scan use; empty when the server would accept it.
 * A change that cannot apply at all (a rename, deleting what is not there)
 * comes back as one issue with an empty path.
 */
export function changeIssues(document: JobListDocument, change: Change): RuleIssue[] {
  let next: JobListDocument;
  try {
    next = applyChange(document, change).document;
  } catch (error) {
    if (error instanceof ChangeError) return [{ path: "", message: error.message }];
    throw error;
  }
  return validateDocument(next);
}

export interface EnvironmentIssues {
  /** About the label itself: not defined in the workspaces section, unknown keys, not a mapping. */
  label: string[];
  /** By override key (severity, max_gap_minutes, ...). */
  fields: Record<string, string[]>;
}

/** The issues of one job, sorted onto the editor's fields. */
export interface JobIssues {
  /** By job key (job_name, max_gap_minutes, ...). The "job <name>: " prefix is dropped: the field says which job. */
  fields: Record<string, string[]>;
  /** By environment label. */
  environments: Record<string, EnvironmentIssues>;
  /** Issues about anything else in the list, as the rules wrote them. */
  other: RuleIssue[];
}

function push(map: Record<string, string[]>, key: string, message: string): void {
  (map[key] ??= []).push(message);
}

/**
 * Sorts issues onto the fields of the job named `jobName`, which sits at
 * `index` in the checked document. The rules' paths look like
 * `jobs[orders_ingest].max_gap_minutes`, `jobs[orders_ingest].environments.lower.severity`,
 * or `jobs[3]` for an entry with no name yet.
 */
export function jobIssues(issues: RuleIssue[], jobName: string, index: number): JobIssues {
  const grouped: JobIssues = { fields: {}, environments: {}, other: [] };
  const base = `jobs[${jobName}]`;
  const prefix = `job ${jobName}: `;
  const env = (label: string): EnvironmentIssues => (grouped.environments[label] ??= { label: [], fields: {} });
  for (const issue of issues) {
    const message = issue.message.startsWith(prefix) ? issue.message.slice(prefix.length) : issue.message;
    if (issue.path === `jobs[${index}]`) {
      push(grouped.fields, "job_name", jobName.trim() === "" ? "Enter a job name." : message);
    } else if (jobName !== "" && issue.path === base) {
      push(grouped.fields, "job_name", message);
    } else if (jobName !== "" && issue.path.startsWith(`${base}.environments.`)) {
      const rest = issue.path.slice(`${base}.environments.`.length);
      const dot = rest.indexOf(".");
      if (dot < 0) env(rest).label.push(message);
      else push(env(rest.slice(0, dot)).fields, rest.slice(dot + 1), message);
    } else if (jobName !== "" && issue.path.startsWith(`${base}.`)) {
      push(grouped.fields, issue.path.slice(base.length + 1), message);
    } else {
      grouped.other.push(issue);
    }
  }
  return grouped;
}

/**
 * The issues of a job draft: the upsert applied to a copy of the document, and
 * the whole list checked. A create whose name is taken is checked as a second
 * entry, so the rules report the duplicate; an upsert would replace the saved
 * job without a word.
 */
export function draftIssues(document: JobListDocument, entry: JobEntry, mode: "create" | "edit"): RuleIssue[] {
  if (mode === "create" && document.jobs.some((job) => job.job_name === entry.job_name)) {
    return validateDocument({ ...document, jobs: [...document.jobs, entry] });
  }
  return changeIssues(document, { kind: "upsert", target: { type: "job", name: entry.job_name }, value: entry });
}

/** The links that deleting the job also removes, as applyChange removes them. Empty when the job is not in the list. */
export function linksRemovedWith(document: JobListDocument, jobName: string): DependencyEntry[] {
  let kept: Set<string>;
  try {
    const applied = applyChange(document, { kind: "delete", target: { type: "job", name: jobName } });
    kept = new Set((applied.document.dependencies ?? []).map(dependencyKey));
  } catch (error) {
    if (error instanceof ChangeError) return [];
    throw error;
  }
  return (document.dependencies ?? []).filter((dependency) => !kept.has(dependencyKey(dependency)));
}

/**
 * The issues of a workspace label draft, like draftIssues: a new label for a
 * workspace that already has one is checked as a second entry, so the rules
 * report it as listed twice instead of the upsert replacing the saved label.
 */
export function workspaceIssues(document: JobListDocument, entry: WorkspaceEntry, mode: "create" | "edit"): RuleIssue[] {
  const key = workspaceKey(entry);
  const workspaces = document.workspaces ?? [];
  if (mode === "create" && workspaces.some((workspace) => workspaceKey(workspace) === key)) {
    return validateDocument({ ...document, workspaces: [...workspaces, entry] });
  }
  return changeIssues(document, { kind: "upsert", target: { type: "workspace", key }, value: entry });
}
