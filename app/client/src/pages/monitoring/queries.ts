import { sql } from "@databricks/appkit-ui/js";
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { useMemo } from "react";
import { type QueryRows, useQueryRows, type WatchdogLocation } from "../../hooks/useWatchdogRows";
import { CheckRow, HistoryRow, JobStatusRow } from "../../lib/rows";

/** The Monitoring page's queries, run as the signed-in person (the .obo.sql files in config/queries). */

/** Every job in every workspace, from the newest scans (job_status.obo.sql). */
export function useJobStatus(where: WatchdogLocation): QueryRows<JobStatusRow> {
  const query = useAnalyticsQuery("job_status", where.params, { autoStart: where.ready });
  return useQueryRows(query, JobStatusRow, where, "job_status");
}

/**
 * Every check of one job, in every workspace (job_checks.obo.sql). Nothing runs until there is a job, and
 * nothing runs while `active` is false (the panel is closed): the last rows stay, so a closing panel keeps them.
 */
export function useJobChecks(where: WatchdogLocation, jobName: string | null, active: boolean): QueryRows<CheckRow> {
  const params = useMemo(() => ({ ...where.params, job_name: sql.string(jobName ?? "") }), [where.params, jobName]);
  const query = useAnalyticsQuery("job_checks", params, { autoStart: where.ready && jobName !== null && active });
  return useQueryRows(query, CheckRow, where, `job_checks:${jobName ?? ""}`);
}

/**
 * Each job's worst status in every fixed window of `bucketMinutes` minutes over the last `hours` hours
 * (job_history.obo.sql). The number of rows per job depends on the two numbers, not on the scan schedule.
 */
export function useJobHistory(where: WatchdogLocation, hours: number, bucketMinutes: number): QueryRows<HistoryRow> {
  const params = useMemo(() => ({ ...where.params, hours: sql.int(hours), bucket_minutes: sql.int(bucketMinutes) }), [where.params, hours, bucketMinutes]);
  const query = useAnalyticsQuery("job_history", params, { autoStart: where.ready });
  return useQueryRows(query, HistoryRow, where, `job_history:${hours}:${bucketMinutes}`);
}
