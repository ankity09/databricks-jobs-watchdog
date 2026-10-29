-- Which real jobs does each monitored job match?
-- One row per monitored job and matching job, using the newest definition of
-- every job in the region. Matching uses regexp_like, which finds the regex
-- anywhere in the name unless you anchor it with ^ and $. Names matching the
-- job_name_exclude_regex are left out, as the scans leave them out. A
-- monitored job with no match gets one row with empty workspace and job
-- columns, and the system table scan reports it as not_found.
-- Each match shows its workspace's environment label, and checked_here:
-- whether the job is switched on in that environment. Labels by workspace
-- name need the temp view watchdog_workspace_names, which notebook 02 creates
-- first.
-- Parameters: :catalog, :schema
WITH latest_jobs AS (
  SELECT workspace_id, job_id, name, run_as
  FROM system.lakeflow.jobs
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) = 1
      AND delete_time IS NULL
),
environments AS (
  -- the same rule as the system table scan: an entry with the workspace ID,
  -- otherwise an entry with no ID whose name matches the workspace name
  SELECT w.workspace_id, coalesce(by_id.environment, by_name.environment) AS environment
  FROM (SELECT DISTINCT workspace_id FROM latest_jobs) w
  LEFT JOIN watchdog_workspace_names n ON n.workspace_id = w.workspace_id
  LEFT JOIN IDENTIFIER(:catalog || '.' || :schema || '.monitored_workspaces') by_id
    ON by_id.workspace_id = w.workspace_id
  LEFT JOIN IDENTIFIER(:catalog || '.' || :schema || '.monitored_workspaces') by_name
    ON by_name.workspace_id IS NULL AND lower(by_name.workspace_name) = lower(n.workspace_name)
)
SELECT
  m.job_name,
  m.enabled,
  m.job_name_regex,
  m.job_name_exclude_regex,
  j.workspace_id,
  e.environment,
  coalesce(o.enabled, m.enabled) AS checked_here,
  j.job_id,
  j.name AS matched_job_name,
  j.run_as
FROM IDENTIFIER(:catalog || '.' || :schema || '.monitored_jobs') m
LEFT JOIN latest_jobs j
  ON regexp_like(j.name, m.job_name_regex)
  AND (m.job_name_exclude_regex IS NULL OR NOT regexp_like(j.name, m.job_name_exclude_regex))
LEFT JOIN environments e ON e.workspace_id = j.workspace_id
LEFT JOIN IDENTIFIER(:catalog || '.' || :schema || '.monitored_job_environments') o
  ON o.job_name = m.job_name AND o.environment = e.environment
ORDER BY m.job_name, j.workspace_id, j.name
