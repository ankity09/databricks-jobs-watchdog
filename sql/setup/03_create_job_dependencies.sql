-- Config table: what each job depends on. Used to list the jobs a failure
-- affects. Notebook 02 replaces its rows from your monitored-jobs YAML file.
-- Parameters: :catalog, :schema
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog || '.' || :schema || '.job_dependencies') (
  job_name STRING NOT NULL COMMENT 'The job that depends on something',
  depends_on STRING NOT NULL COMMENT 'The upstream job, child job or service it needs',
  dependency_type STRING NOT NULL COMMENT 'job, child_job or service',
  notes STRING,
  loaded_at TIMESTAMP NOT NULL COMMENT 'When this row was loaded from the YAML file'
)
COMMENT 'Watchdog config: job and service dependencies'
