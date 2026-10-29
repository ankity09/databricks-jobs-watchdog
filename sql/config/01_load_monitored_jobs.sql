-- Replaces every row of monitored_jobs with the jobs in the temp view
-- watchdog_config_jobs, which notebook 02 builds from your monitored-jobs
-- YAML file. loaded_at records when the load ran.
-- Parameters: :catalog, :schema
INSERT OVERWRITE TABLE IDENTIFIER(:catalog || '.' || :schema || '.monitored_jobs')
SELECT
  job_name,
  job_name_regex,
  schedule_type,
  max_gap_minutes,
  max_runtime_minutes,
  max_retries,
  severity,
  owner,
  enabled,
  notes,
  current_timestamp() AS loaded_at,
  job_name_exclude_regex
FROM watchdog_config_jobs
