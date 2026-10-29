-- Replaces every row of job_dependencies with the dependencies in the temp
-- view watchdog_config_dependencies, which notebook 02 builds from your
-- monitored-jobs YAML file.
-- Parameters: :catalog, :schema
INSERT OVERWRITE TABLE IDENTIFIER(:catalog || '.' || :schema || '.job_dependencies')
SELECT
  job_name,
  depends_on,
  dependency_type,
  notes,
  current_timestamp() AS loaded_at
FROM watchdog_config_dependencies
