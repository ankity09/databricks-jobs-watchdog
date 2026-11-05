import { z } from "zod";
import { STATUSES } from "./status";
import { parseTime } from "./time";

/**
 * Row schemas for the Monitoring queries (config/queries/*.obo.sql).
 *
 * How AppKit sends a row: every value is text or null, as the SQL statement API
 * returns it (JSON_ARRAY), except that AppKit JSON-parses STRING values that
 * start with { or [. So ARRAY columns arrive as JSON text ('["a","b"]'), BIGINT
 * as a numeric string, TIMESTAMP as an ISO string, and an error message that
 * happens to look like JSON can arrive as an object.
 */

const Status = z.enum(STATUSES);

/** CRITICAL or WARNING; anything else (or nothing) is no severity, so a new value never hides the job. */
const Severity = z.enum(["CRITICAL", "WARNING"]).nullable().catch(null);

/** An ISO time, kept as the string it arrived as. */
const Time = z.string().refine((value) => parseTime(value) !== null, "Expected a time");

/** Free text, such as an error message: an object AppKit parsed out of it becomes text again. */
const Text = z.preprocess((value) => (value === null || typeof value === "string" ? value : JSON.stringify(value)), z.string().nullable());

/** An ARRAY<STRING> column: JSON text, or null for no items. */
const StringList = z.preprocess((value) => {
  if (value === null || value === undefined) return [];
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return value;
  }
}, z.array(z.string()));

/** A BIGINT column: a string of digits, or null. */
const WholeNumber = z.preprocess((value) => (typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value), z.number().int().nullable());

const NullableString = z.string().nullable();

/** One job in one workspace, from job_status.obo.sql. A job the scan could not find has no workspace and no job ID. */
export const JobStatusRow = z.object({
  job_name: z.string(),
  workspace_id: NullableString,
  job_id: NullableString,
  workspace_name: NullableString,
  environment: NullableString,
  owner: NullableString,
  schedule_type: NullableString,
  parent_job: NullableString,
  status: Status,
  severity: Severity,
  failing_checks: StringList,
  top_error: Text,
  last_run_start: Time.nullable(),
  last_run_url: NullableString,
  observed_at: Time,
});
export type JobStatusRow = z.infer<typeof JobStatusRow>;

/** One check of one job, from job_checks.obo.sql. */
export const CheckRow = z.object({
  job_name: z.string(),
  workspace_id: NullableString,
  workspace_name: NullableString,
  job_id: NullableString,
  environment: NullableString,
  owner: NullableString,
  schedule_type: NullableString,
  parent_job: NullableString,
  check_id: z.string(),
  source: z.string(),
  status: Status,
  severity: Severity,
  failure_category: NullableString,
  error_summary: Text,
  run_id: NullableString,
  run_page_url: NullableString,
  failed_task_keys: StringList,
  affected_jobs: StringList,
  code_version: Text,
  pipeline_url: NullableString,
  trigger_type: NullableString,
  triggered_by: NullableString,
  run_start_time: Time.nullable(),
  run_end_time: Time.nullable(),
  run_duration_seconds: WholeNumber,
  observed_at: Time,
});
export type CheckRow = z.infer<typeof CheckRow>;

/** One job's worst status at one scan, from job_history.obo.sql. */
export const HistoryRow = z.object({
  job_name: z.string(),
  workspace_id: NullableString,
  job_id: NullableString,
  scan_id: z.string(),
  observed_at: Time,
  status: Status,
});
export type HistoryRow = z.infer<typeof HistoryRow>;

/** The newest scan of one source, from scan_freshness.obo.sql. */
export const FreshnessRow = z.object({
  source: z.string(),
  last_observed_at: Time.nullable(),
  scan_id: NullableString,
});
export type FreshnessRow = z.infer<typeof FreshnessRow>;

/**
 * The rows that match `schema`, and how many did not. An answer that is not a
 * list counts as one bad row, so it is never taken for an empty result.
 */
export function parseRows<T>(schema: z.ZodType<T>, data: unknown): { rows: T[]; bad: number } {
  if (!Array.isArray(data)) return { rows: [], bad: 1 };
  const rows: T[] = [];
  let bad = 0;
  for (const item of data) {
    const result = schema.safeParse(item);
    if (result.success) rows.push(result.data);
    else bad += 1;
  }
  return { rows, bad };
}
