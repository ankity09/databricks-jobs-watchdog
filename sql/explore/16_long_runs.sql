-- The longest runs in the lookback window. Every run counts from its first
-- row's start to its newest row's end (last_seen). For a run still going (no
-- result yet) that is a lower bound, because its newest hour has not landed;
-- measuring to now would make a finished run whose last row is late look
-- long. Compare with your max_runtime_minutes settings.
-- Parameters: :lookback_hours
WITH runs AS (
  SELECT
    workspace_id,
    job_id,
    run_id,
    MIN(period_start_time) AS run_start,
    MAX(period_end_time) AS last_seen,
    MAX_BY(result_state, period_end_time) AS result_state
  FROM system.lakeflow.job_run_timeline
  WHERE period_start_time >= timestampadd(HOUR, -CAST(:lookback_hours AS INT), current_timestamp())
  GROUP BY workspace_id, job_id, run_id
)
SELECT
  workspace_id,
  job_id,
  run_id,
  run_start,
  last_seen,
  result_state,
  result_state IS NULL AS still_running,
  timestampdiff(MINUTE, run_start, last_seen) AS minutes
FROM runs
ORDER BY minutes DESC
LIMIT 50
