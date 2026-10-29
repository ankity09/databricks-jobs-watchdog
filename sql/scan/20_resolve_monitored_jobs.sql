-- Which real jobs does each monitored job match?
-- One row per monitored job and matching job, using the newest definition of
-- every job in the region. Matching uses regexp_like, which finds the regex
-- anywhere in the name unless you anchor it with ^ and $. Names matching the
-- job_name_exclude_regex are left out, as the scans leave them out. A monitored job
-- with no match gets one row with empty workspace and job columns, and the
-- system table scan reports it as not_found.
-- Parameters: :catalog, :schema
WITH latest_jobs AS (
  SELECT workspace_id, job_id, name, run_as
  FROM system.lakeflow.jobs
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) = 1
      AND delete_time IS NULL
)
SELECT
  m.job_name,
  m.enabled,
  m.job_name_regex,
  m.job_name_exclude_regex,
  j.workspace_id,
  j.job_id,
  j.name AS matched_job_name,
  j.run_as
FROM IDENTIFIER(:catalog || '.' || :schema || '.monitored_jobs') m
LEFT JOIN latest_jobs j
  ON regexp_like(j.name, m.job_name_regex)
  AND (m.job_name_exclude_regex IS NULL OR NOT regexp_like(j.name, m.job_name_exclude_regex))
ORDER BY m.job_name, j.workspace_id, j.name
