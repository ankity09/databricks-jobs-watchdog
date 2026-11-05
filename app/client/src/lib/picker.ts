import { z } from "zod";
import type { JobEntry, JobListDocument, ScheduleType, WorkspaceEntry } from "../../../shared/joblist/types";

/**
 * A STRING column. AppKit JSON-parses STRING values that start with [ or {,
 * so a job named [1] arrives as an array: turn such values back into text.
 */
const text = z.preprocess(
  (value) => (value === null || value === undefined || typeof value === "string" ? value : JSON.stringify(value)),
  z.string().nullable(),
);

/** The warehouse sends every value as a string, so a BOOLEAN column arrives as "true" or "false". */
const flag = z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).nullable();

/** One row of region_jobs.obo.sql: a job's newest definition in this region. */
export const RegionJobRow = z.object({
  workspace_id: text,
  workspace_name: text,
  job_id: text,
  name: text,
  trigger_type: text,
  paused: flag,
  creator_user_name: text,
  change_time: text,
});
export type RegionJobRow = z.infer<typeof RegionJobRow>;

/** A whole number the warehouse sends as a string, such as COUNT(*). */
const count = z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)]);

/** One row of pattern_matches.obo.sql: a job whose name the pattern matches, and how many match in all. */
export const PatternMatchRow = z.object({
  workspace_id: text,
  job_id: text,
  name: text,
  match_count: count,
});
export type PatternMatchRow = z.infer<typeof PatternMatchRow>;

/** The schedule type the job list uses for a system table trigger_type. */
export function scheduleTypeOf(triggerType: string | null): ScheduleType {
  const trigger = (triggerType ?? "").toUpperCase();
  if (trigger === "CRON" || trigger === "PERIODIC") return "scheduled";
  if (trigger === "CONTINUOUS") return "continuous";
  return "triggered";
}

const TRIGGER_LABELS: Record<string, string> = {
  CRON: "Cron schedule",
  PERIODIC: "Periodic",
  CONTINUOUS: "Continuous",
  FILE_ARRIVAL: "File arrival",
  TABLE: "Table update",
  TABLE_UPDATE: "Table update",
  MULTIPLE: "Several triggers",
};

/** A short label for a trigger_type, for the picker's Trigger column. */
export function triggerLabel(triggerType: string | null): string {
  if (!triggerType) return "None";
  const upper = triggerType.toUpperCase();
  return Object.hasOwn(TRIGGER_LABELS, upper) ? TRIGGER_LABELS[upper] : triggerType;
}

/** The prefix a bundle in development mode puts on job names, such as "[dev dana_lee] ". */
const DEV_PREFIX = /^\s*\[dev [^\]]*\]\s*/i;

/**
 * A job_name for the job list from a job's real name: lowercased, without a
 * [dev ...] prefix, with every run of other characters than letters, digits
 * and _ turned into one _. Runs at the start and the end are dropped. Null
 * when nothing is left.
 */
export function jobNameFromRealName(realName: string): string | null {
  const name = realName
    .replace(DEV_PREFIX, "")
    .toLowerCase()
    .replace(/^\W+|\W+$/g, "")
    .replace(/\W+/g, "_");
  return name === "" ? null : name;
}

/**
 * A new job entry for a job picked from the region: its name, its exact job ID
 * and its schedule type. max_gap_minutes is left unset, so the form asks for it
 * when the job is scheduled. The name gets _2, _3 and so on when it is taken.
 */
export function draftFromRegionJob(row: RegionJobRow, document: JobListDocument): JobEntry {
  const base = (row.name === null ? null : jobNameFromRealName(row.name)) ?? `job_${row.job_id ?? "new"}`;
  const taken = new Set(document.jobs.map((job) => job.job_name));
  let jobName = base;
  for (let n = 2; taken.has(jobName); n++) jobName = `${base}_${n}`;
  const draft: JobEntry = { job_name: jobName };
  if (row.job_id !== null) draft.job_ids = [row.job_id];
  draft.schedule_type = scheduleTypeOf(row.trigger_type);
  return draft;
}

const compiled = new Map<string, RegExp | null>();

/** A pattern as a RegExp, or null when it does not compile. Cached, since every row checks every entry. */
function regex(pattern: string): RegExp | null {
  if (!compiled.has(pattern)) {
    try {
      compiled.set(pattern, new RegExp(pattern));
    } catch {
      compiled.set(pattern, null);
    }
  }
  return compiled.get(pattern) ?? null;
}

/** The scan's rule: a label by workspace ID first, then a label without an ID whose name matches, ignoring case. */
function environmentFor(workspaceId: string | null, workspaceName: string | null, labels: WorkspaceEntry[]): string | null {
  if (workspaceId !== null) {
    for (const label of labels) if (label.workspace_id && label.workspace_id === workspaceId) return label.environment;
  }
  if (workspaceName) {
    const wanted = workspaceName.toLowerCase();
    for (const label of labels) {
      if (!label.workspace_id && (label.workspace_name ?? "").toLowerCase() === wanted) return label.environment;
    }
  }
  return null;
}

/** The job IDs that apply in an environment: the environment's own list when it sets one, otherwise the job's. */
function jobIdsIn(job: JobEntry, environment: string | null): string[] {
  const overrides = environment !== null && job.environments && Object.hasOwn(job.environments, environment) ? job.environments[environment] : undefined;
  return (overrides?.job_ids ?? job.job_ids ?? []).map(String);
}

/**
 * Whether a real name matches an entry, as the scans match it: the pattern
 * anywhere in the name (the exact job_name when there is no pattern), and not
 * the exclusion. The entry's own exclusion wins over the defaults', and null
 * turns the default off.
 */
function nameMatches(job: JobEntry, document: JobListDocument, name: string): boolean {
  if (job.job_name_regex) {
    if (!regex(job.job_name_regex)?.test(name)) return false;
  } else if (name !== job.job_name) {
    return false;
  }
  const exclude = job.job_name_exclude_regex !== undefined ? job.job_name_exclude_regex : document.defaults?.job_name_exclude_regex;
  return !(exclude && regex(exclude)?.test(name));
}

/**
 * The name of the entry that already monitors a job of the region, or null.
 * In each workspace an entry matches by job ID where job IDs apply (its
 * environment's list, otherwise its own), and by name everywhere else, as
 * sql/scan/20_resolve_monitored_jobs.sql does. Switched-off entries count too.
 */
export function isMonitored(row: RegionJobRow, document: JobListDocument): string | null {
  const environment = environmentFor(row.workspace_id, row.workspace_name, document.workspaces ?? []);
  for (const job of document.jobs) {
    const ids = jobIdsIn(job, environment);
    if (ids.length > 0) {
      if (row.job_id !== null && ids.includes(row.job_id)) return job.job_name;
    } else if (row.name !== null && nameMatches(job, document, row.name)) {
      return job.job_name;
    }
  }
  return null;
}

/**
 * What a failed system table query means. AppKit sends only a generic message
 * and the warehouse's error code, and the warehouse reports a missing grant and
 * a bad regex alike as BAD_REQUEST, so "rejected" covers both.
 */
export type QueryFailure = "no_access" | "rejected" | "other";

export function queryFailure(error: string | null, errorCode: string | null): QueryFailure {
  const said = `${errorCode ?? ""} ${error ?? ""}`;
  if (/PERMISSION_DENIED|INSUFFICIENT_PERMISSIONS/.test(said)) return "no_access";
  if (errorCode === "BAD_REQUEST") return "rejected";
  return "other";
}
