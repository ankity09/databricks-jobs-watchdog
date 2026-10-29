-- Replaces every row of monitored_job_environments with the overrides in the
-- temp view watchdog_config_environments, which notebook 02 builds from the
-- environments sections of your monitored-jobs YAML file.
-- Parameters: :catalog, :schema
INSERT OVERWRITE TABLE IDENTIFIER(:catalog || '.' || :schema || '.monitored_job_environments')
SELECT
  job_name,
  environment,
  severity,
  owner,
  enabled,
  max_gap_minutes,
  max_runtime_minutes,
  max_retries,
  min_attempt_minutes,
  current_timestamp() AS loaded_at
FROM watchdog_config_environments
