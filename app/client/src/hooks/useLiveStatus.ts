import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { useMemo } from "react";
import { z } from "zod";
import type { QueryProblem } from "../lib/queryProblem";
import { type Status, toStatus } from "../lib/status";
import { useQueryRows, useWatchdogLocation } from "./useWatchdogRows";

/** One row of job_live_status.obo.sql: a job's worst status in the newest scans. */
const LiveStatusRow = z.object({ job_name: z.string(), status: z.string().nullable() });

export interface LiveStatus {
  byJob: Map<string, Status>;
  /** The current query has not answered yet. `byJob` keeps the last answer meanwhile. */
  loading: boolean;
  /** Why the current query has no answer, for describeProblem. `byJob` may still hold an older answer. */
  problem: QueryProblem | null;
  /** True when the query failed and `byJob` holds the answer from before. */
  stale: boolean;
  /** "catalog.schema" of the Watchdog tables, for the problem's text. */
  location: string | null;
}

/**
 * Each job's worst status in the newest scans (job_live_status.obo.sql, run as
 * the signed-in person), through the same query path as Monitoring: the idle
 * snapshot rule, the last good answer during a refresh, and a row of an
 * unexpected shape dropped instead of the whole answer.
 */
export function useLiveStatus(): LiveStatus {
  const where = useWatchdogLocation();
  const query = useAnalyticsQuery("job_live_status", where.params, { autoStart: where.ready });
  const result = useQueryRows(query, LiveStatusRow, where, "job_live_status");
  const byJob = useMemo(() => new Map((result.rows ?? []).map((row) => [row.job_name, toStatus(row.status)] as const)), [result.rows]);
  return {
    byJob,
    loading: result.loading,
    problem: result.problem,
    stale: result.problem !== null && result.rows !== null,
    location: where.location,
  };
}
