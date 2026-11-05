-- The job picker: jobs in this region whose name contains the search text, as
-- of each job's newest definition (system.lakeflow.jobs keeps a row per
-- change), without deleted jobs. Runs as the signed-in person, so it needs
-- SELECT on system.lakeflow.jobs and system.access.workspaces_latest.
-- A backslash in the search is doubled, so it matches itself instead of
-- breaking the ILIKE pattern.
-- @param search STRING = orders
-- @param refresh INT = 0
WITH latest_jobs AS (
  SELECT workspace_id, job_id, name, trigger_type, paused, creator_user_name, change_time
  FROM system.lakeflow.jobs
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) = 1
      AND delete_time IS NULL
)
SELECT
  j.workspace_id,
  w.workspace_name,
  j.job_id,
  j.name,
  j.trigger_type,
  j.paused,
  j.creator_user_name,
  j.change_time
FROM latest_jobs j
LEFT JOIN system.access.workspaces_latest w ON w.workspace_id = j.workspace_id
WHERE j.name ILIKE concat('%', replace(:search, '\\', '\\\\'), '%')
  AND :refresh >= 0
ORDER BY j.name
LIMIT 100
