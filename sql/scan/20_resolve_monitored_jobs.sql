-- Which real jobs does each monitored job match?
-- One row per monitored job and matching job, using the newest definition of
-- every job in the region. In each workspace, a monitored job matches by job
-- ID when job_ids apply there (its environment's job_ids, otherwise the job's
-- own); otherwise it matches by name: regexp_like finds job_name_regex
-- anywhere in the name unless you anchor it with ^ and $, and names matching
-- job_name_exclude_regex are left out, as the scans leave them out. A
-- monitored job with no match gets one row with empty workspace and job
-- columns, and the system table scan reports it as not_found.
-- Each match shows its workspace's environment label; checked_here: whether
-- the job is switched on in that environment; matched_by: job_id or name; and
-- same_name_jobs: how many jobs in that workspace have exactly the matched
-- job's name (more than 1 is a duplicate_name warning when matched by name).
-- Labels by workspace name need the temp view watchdog_workspace_names, which
-- notebook 02 creates first.
-- Parameters: :catalog, :schema
WITH monitored AS (
  SELECT * FROM IDENTIFIER(:catalog || '.' || :schema || '.monitored_jobs')
),
overrides AS (
  SELECT * FROM IDENTIFIER(:catalog || '.' || :schema || '.monitored_job_environments')
),
latest_jobs AS (
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
),
jobs_here AS (
  -- every job in the region with its workspace's environment label, and how
  -- many jobs in its workspace share its exact name
  SELECT j.*, e.environment, COUNT(*) OVER (PARTITION BY j.workspace_id, j.name) AS same_name_jobs
  FROM latest_jobs j
  LEFT JOIN environments e ON e.workspace_id = j.workspace_id
),
candidates AS (
  -- jobs whose name a monitored job's pattern matches, and jobs whose ID it lists
  SELECT m.job_name, j.workspace_id, j.job_id, j.name, j.run_as, j.environment, j.same_name_jobs, 'name' AS matched_by
  FROM monitored m
  JOIN jobs_here j
    ON regexp_like(j.name, m.job_name_regex)
    AND (m.job_name_exclude_regex IS NULL OR NOT regexp_like(j.name, m.job_name_exclude_regex))
  UNION ALL
  SELECT l.job_name, j.workspace_id, j.job_id, j.name, j.run_as, j.environment, j.same_name_jobs, 'job_id'
  FROM (
    SELECT DISTINCT job_name, job_id FROM (
      SELECT job_name, explode(job_ids) AS job_id FROM monitored
      UNION ALL
      SELECT job_name, explode(job_ids) AS job_id FROM overrides
    )
  ) l
  JOIN jobs_here j ON j.job_id = l.job_id
),
matches AS (
  -- in each workspace, a job matches by ID where job_ids apply, by name elsewhere
  SELECT c.*, coalesce(o.enabled, m.enabled) AS checked_here
  FROM candidates c
  JOIN monitored m ON m.job_name = c.job_name
  LEFT JOIN overrides o ON o.job_name = c.job_name AND o.environment = c.environment
  WHERE (c.matched_by = 'job_id') = (coalesce(size(coalesce(o.job_ids, m.job_ids)), 0) > 0)
    AND (c.matched_by = 'name' OR array_contains(coalesce(o.job_ids, m.job_ids), c.job_id))
)
SELECT
  m.job_name,
  m.enabled,
  m.job_name_regex,
  m.job_name_exclude_regex,
  m.job_ids,
  x.workspace_id,
  x.environment,
  x.checked_here,
  x.matched_by,
  x.job_id,
  x.name AS matched_job_name,
  x.same_name_jobs,
  x.run_as
FROM monitored m
LEFT JOIN matches x ON x.job_name = m.job_name
ORDER BY m.job_name, x.workspace_id, x.name
