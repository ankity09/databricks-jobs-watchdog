-- Config table: per-environment overrides for monitored jobs. Each row
-- changes some settings of one job in one environment label, for example a
-- lower severity, or switching the job off, in lower environments. Notebook
-- 02 replaces its rows from the environments sections of your monitored-jobs
-- YAML file. An empty setting means the job's own setting applies.
-- Parameters: :catalog, :schema
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog || '.' || :schema || '.monitored_job_environments') (
  job_name STRING NOT NULL COMMENT 'The monitored job',
  environment STRING NOT NULL COMMENT 'Environment label from the workspaces section',
  severity STRING COMMENT 'CRITICAL or WARNING in this environment',
  owner STRING COMMENT 'Team or person to route findings to in this environment',
  enabled BOOLEAN COMMENT 'false switches the job off in this environment',
  max_gap_minutes INT COMMENT 'Longest allowed gap between run starts in this environment',
  max_runtime_minutes INT COMMENT 'Longest allowed run in this environment',
  max_retries INT COMMENT 'Retry limit in this environment',
  min_attempt_minutes INT COMMENT 'Shortest allowed attempt before a retry in this environment',
  loaded_at TIMESTAMP NOT NULL COMMENT 'When this row was loaded from the YAML file'
)
COMMENT 'Watchdog config: per-environment overrides for monitored jobs'
