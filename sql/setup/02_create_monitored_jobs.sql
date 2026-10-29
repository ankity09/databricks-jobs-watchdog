-- Config table: the jobs the Watchdog checks. Notebook 02 replaces its rows
-- from your monitored-jobs YAML file each time you load the config.
-- Parameters: :catalog, :schema
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog || '.' || :schema || '.monitored_jobs') (
  job_name STRING NOT NULL COMMENT 'Short logical name used in findings and alerts',
  job_name_regex STRING NOT NULL COMMENT 'Matches the real job name in each workspace',
  schedule_type STRING NOT NULL COMMENT 'continuous or scheduled',
  max_gap_minutes INT COMMENT 'Scheduled jobs: longest allowed gap between run starts',
  max_runtime_minutes INT COMMENT 'Longest allowed run before a warning',
  max_retries INT COMMENT 'A task retried more times than this is a retry loop',
  severity STRING NOT NULL COMMENT 'CRITICAL or WARNING, used when the job is not healthy',
  owner STRING COMMENT 'Team or person to route findings to',
  enabled BOOLEAN NOT NULL COMMENT 'false keeps the entry without checking it',
  notes STRING,
  loaded_at TIMESTAMP NOT NULL COMMENT 'When this row was loaded from the YAML file',
  job_name_exclude_regex STRING COMMENT 'Job names matching this are skipped, for example test copies',
  min_attempt_minutes INT COMMENT 'A task attempt that ran shorter than this before a retry counts as a retry loop'
)
COMMENT 'Watchdog config: jobs to check'
