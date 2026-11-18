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

/** The issues with every repeat (same path and message) left out: the rules can report one twice, for example a name listed three times. */
export function uniqueIssues(issues: RuleIssue[]): RuleIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const messages = (map[key] ??= []);
  if (!messages.includes(message)) messages.push(message);
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
  for (const issue of uniqueIssues(issues)) {
    const message = issue.message.startsWith(prefix) ? issue.message.slice(prefix.length) : issue.message;
    if (issue.path === `jobs[${index}]`) {
      push(grouped.fields, "job_name", jobName.trim() === "" ? "Enter a job name." : message);
    } else if (jobName !== "" && issue.path === base) {
      push(grouped.fields, "job_name", message);
    } else if (jobName !== "" && issue.path.startsWith(`${base}.environments.`)) {
      const rest = issue.path.slice(`${base}.environments.`.length);
      const dot = rest.indexOf(".");
      if (dot < 0) {
        const label = env(rest).label;
        if (!label.includes(message)) label.push(message);
      } else push(env(rest.slice(0, dot)).fields, rest.slice(dot + 1), message);
    } else if (jobName !== "" && issue.path.startsWith(`${base}.`)) {
      push(grouped.fields, issue.path.slice(base.length + 1), message);
    } else {
      grouped.other.push(issue);
    }
  }
  return grouped;
}

/** The keys the defaults form edits. */
const DEFAULT_FIELDS: readonly string[] = [
  "schedule_type",
  "severity",
  "max_gap_minutes",
  "max_runtime_minutes",
  "max_retries",
  "min_attempt_minutes",
  "owner",
  "enabled",
  "job_name_exclude_regex",
  "notes",
];

/** One message for a default field, and the jobs that take the default and so report it. */
export interface DefaultIssue {
  message: string;
  jobs: string[];
}

/** The issues of a change to the defaults, sorted for the defaults form. */
export interface DefaultsIssues {
  /** By default key: each message once, without the "job <name>: " prefix. */
  fields: Record<string, DefaultIssue[]>;
  /** The jobs the change breaks through their own settings, each once, with the rules' messages. */
  jobs: { name: string; messages: string[] }[];
  /** Issues about anything else in the list, as the rules wrote them. */
  other: RuleIssue[];
}

/** The job an issue path such as `jobs[orders_ingest].max_retries` is about. The longest name wins, for names that hold "]" or ".". */
function jobAt(document: JobListDocument, path: string): JobEntry | undefined {
  let found: JobEntry | undefined;
  for (const job of document.jobs) {
    const base = `jobs[${job.job_name}]`;
    if ((path === base || path.startsWith(`${base}.`)) && (found === undefined || job.job_name.length > found.job_name.length)) found = job;
  }
  return found;
}

/**
 * Sorts the issues of a defaults change. The rules check a default only on
 * each job that takes it, so a bad default comes back once per job, as
 * `jobs[<name>].<key>`. When the job does not set that key itself, the issue
 * is about the default: it goes on the default's field, once. An issue the
 * job's own setting causes (a gap on a job that the new default makes
 * triggered) stays with the job.
 */
export function defaultsIssues(document: JobListDocument, issues: RuleIssue[]): DefaultsIssues {
  const grouped: DefaultsIssues = { fields: {}, jobs: [], other: [] };
  const onField = (key: string, message: string, job: string | null) => {
    const list = (grouped.fields[key] ??= []);
    let entry = list.find((item) => item.message === message);
    if (entry === undefined) {
      entry = { message, jobs: [] };
      list.push(entry);
    }
    if (job !== null && !entry.jobs.includes(job)) entry.jobs.push(job);
  };
  for (const issue of uniqueIssues(issues)) {
    const defaultKey = issue.path.startsWith("defaults.") ? issue.path.slice("defaults.".length) : null;
    if (defaultKey !== null && DEFAULT_FIELDS.includes(defaultKey)) {
      onField(defaultKey, issue.message, null);
      continue;
    }
    const job = jobAt(document, issue.path);
    if (job === undefined) {
      grouped.other.push(issue);
      continue;
    }
    const base = `jobs[${job.job_name}]`;
    const key = issue.path.startsWith(`${base}.`) ? issue.path.slice(base.length + 1) : "";
    const prefix = `job ${job.job_name}: `;
    if (DEFAULT_FIELDS.includes(key) && !Object.prototype.hasOwnProperty.call(job, key)) {
      onField(key, issue.message.startsWith(prefix) ? issue.message.slice(prefix.length) : issue.message, job.job_name);
      continue;
    }
    let broken = grouped.jobs.find((item) => item.name === job.job_name);
    if (broken === undefined) {
      broken = { name: job.job_name, messages: [] };
      grouped.jobs.push(broken);
    }
    if (!broken.messages.includes(issue.message)) broken.messages.push(issue.message);
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
