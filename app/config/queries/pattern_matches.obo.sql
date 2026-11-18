-- The pattern preview: jobs in this region whose newest definition has a name
-- the pattern matches and the exclusion does not, the way the system table
-- scan matches them (regexp_like finds the pattern anywhere in the name).
-- match_count is the number of matches before the limit. An invalid pattern
-- fails the query; pattern_check.obo.sql tells that apart from missing access.
-- @param pattern STRING = ^example$
-- @param exclude STRING = ""
-- @param workspace_id STRING = ""
-- @param refresh INT = 0
WITH latest_jobs AS (
  SELECT workspace_id, job_id, name
  FROM system.lakeflow.jobs
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) = 1
      AND delete_time IS NULL
)
SELECT
  workspace_id,
  job_id,
  name,
  COUNT(*) OVER () AS match_count
FROM latest_jobs
WHERE regexp_like(name, :pattern)
  AND (:exclude = '' OR NOT regexp_like(name, :exclude))
  AND (:workspace_id = '' OR workspace_id = :workspace_id)
  AND :refresh >= 0
ORDER BY name
LIMIT 50
