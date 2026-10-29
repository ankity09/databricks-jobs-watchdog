-- Runs that ended FAILED, ERROR or TIMED_OUT in the lookback window, with the
-- job's name and why it ended (termination_code and termination_type).
-- Parameters: :lookback_hours
WITH latest_jobs AS (
  SELECT workspace_id, job_id, name
  FROM system.lakeflow.jobs
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) = 1
)
SELECT
  r.workspace_id,
  r.job_id,
  j.name AS job_name,
  r.run_id,
  r.period_end_time AS ended_at,
  r.result_state,
  r.termination_code,
  r.termination_type
FROM system.lakeflow.job_run_timeline r
LEFT JOIN latest_jobs j ON j.workspace_id = r.workspace_id AND j.job_id = r.job_id
WHERE r.period_start_time >= timestampadd(HOUR, -CAST(:lookback_hours AS INT), current_timestamp())
  AND r.result_state IN ('FAILED', 'ERROR', 'TIMED_OUT')
ORDER BY ended_at DESC
