-- Every run that started in the lookback window, one row per run.
-- job_run_timeline stores up to an hour of a run per row, so long runs span
-- several rows. This folds them together: run_start is the first row's start,
-- last_seen the newest row's end, and result_state comes from the newest row
-- (it stays empty while the run is still going). minutes is the time from
-- run_start to last_seen. A run that began before the window counts from the
-- window's first row, so its minutes are a lower bound.
-- The table's run_duration_seconds column is 0 for multi-task jobs, so it is
-- not used here.
-- Parameters: :lookback_hours
SELECT
  workspace_id,
  job_id,
  run_id,
  MIN(period_start_time) AS run_start,
  MAX(period_end_time) AS last_seen,
  timestampdiff(MINUTE, MIN(period_start_time), MAX(period_end_time)) AS minutes,
  MAX_BY(result_state, period_end_time) AS result_state,
  MAX_BY(termination_code, period_end_time) AS termination_code,
  MAX_BY(termination_type, period_end_time) AS termination_type,
  MAX(trigger_type) AS trigger_type
FROM system.lakeflow.job_run_timeline
WHERE period_start_time >= timestampadd(HOUR, -CAST(:lookback_hours AS INT), current_timestamp())
GROUP BY workspace_id, job_id, run_id
ORDER BY run_start DESC
