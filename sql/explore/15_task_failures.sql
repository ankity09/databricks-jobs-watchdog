-- Individual tasks that failed in the lookback window. A task can fail inside
-- a run that keeps going (for example a continuous job), so this catches
-- problems the run-level view misses. job_run_id is the run the task belongs to.
-- Parameters: :lookback_hours
SELECT
  workspace_id,
  job_id,
  job_run_id,
  run_id AS task_run_id,
  task_key,
  period_end_time AS ended_at,
  result_state,
  termination_code,
  termination_type
FROM system.lakeflow.job_task_run_timeline
WHERE period_start_time >= timestampadd(HOUR, -CAST(:lookback_hours AS INT), current_timestamp())
  AND result_state IN ('FAILED', 'ERROR', 'TIMED_OUT')
ORDER BY ended_at DESC
