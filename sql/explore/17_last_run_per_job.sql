-- The newest finished run of every job: is each job's latest result good?
-- Parameters: :lookback_hours
WITH latest_jobs AS (
  SELECT workspace_id, job_id, name
  FROM system.lakeflow.jobs
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) = 1
      AND delete_time IS NULL
),
finished AS (
  SELECT workspace_id, job_id, run_id, period_end_time AS ended_at, result_state, termination_code
  FROM system.lakeflow.job_run_timeline
  WHERE period_start_time >= timestampadd(HOUR, -CAST(:lookback_hours AS INT), current_timestamp())
    AND result_state IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY period_end_time DESC) = 1
)
SELECT
  j.workspace_id,
  j.job_id,
  j.name AS job_name,
  f.run_id,
  f.ended_at,
  f.result_state,
  f.termination_code
FROM latest_jobs j
LEFT JOIN finished f ON f.workspace_id = j.workspace_id AND f.job_id = j.job_id
ORDER BY f.ended_at DESC NULLS LAST
