import type { JobStatusRow } from "../../lib/rows";
import { type Status, statusRank } from "../../lib/status";
import { parseTime } from "../../lib/time";

/** Sorting, filtering and counting the job status rows. Pure, so the page stays a thin layer. */

export type Severity = "CRITICAL" | "WARNING";
export const SEVERITIES: readonly Severity[] = ["CRITICAL", "WARNING"];

/** One job in one workspace. A job the scan could not find has neither a workspace nor a job ID. */
export interface JobRef {
  job_name: string;
  workspace_id: string | null;
  job_id: string | null;
}

/** A stable key for a job in a workspace, for maps and React keys. */
export function jobKey(job: JobRef): string {
  return JSON.stringify([job.job_name, job.workspace_id, job.job_id]);
}

/** The same job, workspace and job ID (two missing IDs are the same). */
export function sameJob(a: JobRef, b: JobRef): boolean {
  return a.job_name === b.job_name && a.workspace_id === b.workspace_id && a.job_id === b.job_id;
}

/** The workspace name, else its ID, else "Not found" for a job the scan could not find. */
export function workspaceLabel(row: { workspace_name: string | null; workspace_id: string | null }): string {
  return row.workspace_name ?? row.workspace_id ?? "Not found";
}

/** An accessible name that tells two rows of the same job apart. */
export function jobLabel(row: JobRef & { workspace_name: string | null }): string {
  if (row.workspace_id === null && row.workspace_name === null) return `${row.job_name}, not found in any workspace`;
  return `${row.job_name} in ${workspaceLabel(row)}`;
}

function severityRank(severity: Severity | null): number {
  if (severity === "CRITICAL") return 2;
  if (severity === "WARNING") return 1;
  return 0;
}

/** CRITICAL if any is, else WARNING if any is, else null. */
export function highestSeverity(severities: Iterable<Severity | null>): Severity | null {
  let highest: Severity | null = null;
  for (const severity of severities) if (severityRank(severity) > severityRank(highest)) highest = severity;
  return highest;
}

/** Code-point order, the same on every machine. */
export function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Worst status first, then the higher severity, then by job name, workspace and job ID. */
export function sortJobs(rows: readonly JobStatusRow[]): JobStatusRow[] {
  return [...rows].sort(
    (a, b) =>
      statusRank(b.status) - statusRank(a.status) ||
      severityRank(b.severity) - severityRank(a.severity) ||
      compareText(a.job_name, b.job_name) ||
      compareText(workspaceLabel(a), workspaceLabel(b)) ||
      compareText(a.job_id ?? "", b.job_id ?? ""),
  );
}

/** When a job's newest run started: in the last 24 hours, longer ago, or never. */
export type LastRunFilter = "recent" | "older" | "none";
export const LAST_RUN_FILTERS: readonly LastRunFilter[] = ["recent", "older", "none"];

const DAY_MS = 24 * 60 * 60 * 1000;

export function lastRunBucket(row: Pick<JobStatusRow, "last_run_start">, now: Date): LastRunFilter {
  const started = row.last_run_start === null ? null : parseTime(row.last_run_start);
  if (started === null) return "none";
  return now.getTime() - started <= DAY_MS ? "recent" : "older";
}

export interface JobFilterValue {
  status: Status | null;
  environment: string | null;
  owner: string | null;
  severity: Severity | null;
  /** A workspace ID. */
  workspace: string | null;
  /** A check that fails (is not healthy) for the job. */
  check: string | null;
  lastRun: LastRunFilter | null;
  /** Only the jobs with a new open incident (see incidents.ts). */
  onlyNew: true | null;
}

const NO_JOBS: ReadonlySet<string> = new Set();

export const NO_FILTERS: JobFilterValue = { status: null, environment: null, owner: null, severity: null, workspace: null, check: null, lastRun: null, onlyNew: null };

export function hasFilters(filters: JobFilterValue): boolean {
  return Object.values(filters).some((value) => value !== null);
}

/** The rows that pass every filter that is set. `now` places each last run in its bucket; `newJobs` holds the keys of the jobs with a new open incident. */
export function filterJobs(rows: readonly JobStatusRow[], filters: JobFilterValue, now: Date, newJobs: ReadonlySet<string> = NO_JOBS): JobStatusRow[] {
  return rows.filter(
    (row) =>
      (filters.status === null || row.status === filters.status) &&
      (filters.environment === null || row.environment === filters.environment) &&
      (filters.owner === null || row.owner === filters.owner) &&
      (filters.severity === null || row.severity === filters.severity) &&
      (filters.workspace === null || row.workspace_id === filters.workspace) &&
      (filters.check === null || row.failing_checks.includes(filters.check)) &&
      (filters.lastRun === null || lastRunBucket(row, now) === filters.lastRun) &&
      (filters.onlyNew === null || newJobs.has(jobKey(row))),
  );
}

export function countByStatus(rows: readonly JobStatusRow[]): Record<Status, number> {
  const counts: Record<Status, number> = { FAILED: 0, WARNING: 0, UNKNOWN: 0, HEALTHY: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

export interface FilterOption {
  value: string;
  label: string;
  /** The filter's text once this option is chosen, when "<filter>: <label>" would read badly. */
  selected?: string;
}

export interface FilterOptions {
  environments: FilterOption[];
  owners: FilterOption[];
  workspaces: FilterOption[];
  /** The checks that are not healthy in some row. */
  checks: FilterOption[];
}

function distinct(values: Iterable<string | null>): FilterOption[] {
  const set = new Set<string>();
  for (const value of values) if (value !== null && value !== "") set.add(value);
  return [...set].sort(compareText).map((value) => ({ value, label: value }));
}

/** The values each filter can take, from every row (not only the filtered ones). */
export function filterOptions(rows: readonly JobStatusRow[]): FilterOptions {
  const workspaces = new Map<string, string>();
  for (const row of rows) if (row.workspace_id !== null) workspaces.set(row.workspace_id, workspaceLabel(row));
  return {
    environments: distinct(rows.map((row) => row.environment)),
    owners: distinct(rows.map((row) => row.owner)),
    checks: distinct(rows.flatMap((row) => row.failing_checks)),
    workspaces: [...workspaces.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => compareText(a.label, b.label)),
  };
}

/** The newest observed_at of the rows, or null. */
export function newestScan(rows: readonly { observed_at: string }[]): string | null {
  let newest: string | null = null;
  let newestMs = -Infinity;
  for (const row of rows) {
    const ms = parseTime(row.observed_at);
    if (ms !== null && ms > newestMs) {
      newest = row.observed_at;
      newestMs = ms;
    }
  }
  return newest;
}

