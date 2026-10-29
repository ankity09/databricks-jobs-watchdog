-- Which workspaces do this region's system tables cover?
-- One row per workspace that has jobs, with how many jobs it has and how many
-- runs started in the lookback window. Use it to confirm the workspaces you
-- expect are in scope. Jobs tables cover every workspace in this account and
-- cloud region, including workspaces not yet on Unity Catalog.
-- Parameters: :lookback_hours
WITH latest_jobs AS (
  SELECT workspace_id, job_id
  FROM system.lakeflow.jobs
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) = 1
      AND delete_time IS NULL
),
runs AS (
  SELECT workspace_id, COUNT(DISTINCT run_id) AS runs_in_window
  FROM system.lakeflow.job_run_timeline
  WHERE period_start_time >= timestampadd(HOUR, -CAST(:lookback_hours AS INT), current_timestamp())
  GROUP BY workspace_id
)
SELECT
  j.workspace_id,
  COUNT(*) AS jobs,
  COALESCE(MAX(r.runs_in_window), 0) AS runs_in_window
FROM latest_jobs j
LEFT JOIN runs r ON r.workspace_id = j.workspace_id
GROUP BY j.workspace_id
ORDER BY jobs DESC
