-- The one findings table. Both scans (system tables and the Jobs API) write
-- here, and later phases read it for alerts and the Watchdog app.
-- One row per job, check and source in each scan. Re-running a scan never
-- duplicates rows (see sql/scan/30_merge_findings.sql). The table keeps every
-- scan as history; the view findings_latest shows only the newest scan.
-- Columns added after the first release come last, so notebook 01 can add
-- them to an existing table (jobs_watchdog/upgrade.py).
-- Parameters: :catalog, :schema
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog || '.' || :schema || '.findings') (
  observed_at TIMESTAMP NOT NULL COMMENT 'When the scan ran',
  scan_id STRING NOT NULL COMMENT 'One value per scan run',
  account_id STRING COMMENT 'Databricks account',
  region STRING COMMENT 'Cloud region of the metastore',
  workspace_id STRING COMMENT 'Workspace that runs the job; empty when the job was not found anywhere',
  workspace_name STRING COMMENT 'Workspace name, when available',
  job_id STRING COMMENT 'Job ID in that workspace',
  job_name STRING NOT NULL COMMENT 'Logical name from the monitored-jobs config',
  check_id STRING NOT NULL COMMENT 'Which check produced the row',
  status STRING NOT NULL COMMENT 'HEALTHY, WARNING, FAILED or UNKNOWN',
  severity STRING COMMENT 'CRITICAL or WARNING for rows that are not healthy',
  failure_category STRING COMMENT 'FUNCTIONAL, INFRASTRUCTURE, SLA_EXCEEDED, SCHEDULE_GAP, RETRY_LOOP, COVERAGE or NONE',
  run_id STRING COMMENT 'Run the row is about, when there is one',
  run_page_url STRING COMMENT 'Link to the run',
  failed_task_keys ARRAY<STRING> COMMENT 'Tasks that failed',
  error_summary STRING COMMENT 'What the check found; for failures, the start of the error text',
  affected_jobs ARRAY<STRING> COMMENT 'Jobs that depend on this one, filled on FAILED rows',
  owner STRING COMMENT 'Team or person from the config',
  source STRING NOT NULL COMMENT 'SYSTEM_TABLES, JOBS_API or CUSTOM (your own checks)',
  environment STRING COMMENT 'Environment label of the workspace, for example production or lower; empty when not configured',
  schedule_type STRING COMMENT 'continuous or scheduled, from the monitored-jobs config',
  run_start_time TIMESTAMP COMMENT 'When the run this row is about started, in UTC; empty from system tables when it began before the lookback window',
  run_end_time TIMESTAMP COMMENT 'When that run ended, in UTC; empty while it is still going',
  run_duration_seconds BIGINT COMMENT 'How long that run took, or has taken so far',
  trigger_type STRING COMMENT 'How the run started: SCHEDULE, ONE_TIME (Run now or the API), RETRY, CONTINUOUS, FILE_ARRIVAL, TABLE_UPDATE or JOB_TASK',
  triggered_by STRING COMMENT 'Who started a one-time run, from the Jobs API',
  job_tags MAP<STRING,STRING> COMMENT 'The job tags, for example the deployed code version',
  code_version STRING COMMENT 'Code version deployed now: the configured tag on the current job definition; Jobs API rows of untagged jobs fall back to the git commit of the run they judged'
)
COMMENT 'Watchdog findings: one row per job, check and source in each scan'
