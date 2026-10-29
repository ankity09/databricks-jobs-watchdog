-- Every job in the region, as of its newest definition.
-- system.lakeflow.jobs keeps a row per change, so this keeps the newest row
-- per job and drops deleted jobs. run_as is the identity the job runs as.
-- trigger_type, paused and the *_user_name columns were added in December
-- 2025, so they are empty for jobs nobody has changed since then.
SELECT
  workspace_id,
  job_id,
  name,
  trigger_type,
  paused,
  run_as,
  run_as_user_name,
  creator_user_name,
  change_time
FROM system.lakeflow.jobs
QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) = 1
    AND delete_time IS NULL
ORDER BY workspace_id, name
