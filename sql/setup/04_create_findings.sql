-- The one findings table. Both scans (system tables and the Jobs API) write
-- here, and later phases read it for alerts and the Watchdog app.
-- One row per job, check and source in each scan. Re-running a scan never
-- duplicates rows (see sql/scan/30_merge_findings.sql).
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
  source STRING NOT NULL COMMENT 'SYSTEM_TABLES or JOBS_API'
)
COMMENT 'Watchdog findings: one row per job, check and source in each scan'
