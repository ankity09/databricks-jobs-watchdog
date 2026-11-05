-- Config history: one row each time notebook 02 loads the job list, from the
-- monitored-jobs file or from the Watchdog app. The app reads the newest row to
-- show which version the scans use, and whether the last load failed.
-- Parameters: :catalog, :schema
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog || '.' || :schema || '.config_loads') (
  loaded_at TIMESTAMP NOT NULL COMMENT 'When notebook 02 loaded the job list, or tried to',
  scan_id STRING COMMENT 'The scan run that loaded it; a new ID for a run by hand',
  source STRING NOT NULL COMMENT 'yaml or lakebase',
  source_ref STRING COMMENT 'The YAML path, or the Lakebase database the list came from',
  version BIGINT COMMENT 'The Lakebase job list version; empty for YAML',
  job_count INT COMMENT 'How many jobs the list holds; empty when the load failed',
  status STRING NOT NULL COMMENT 'OK or FAILED',
  error STRING COMMENT 'Why the load failed; empty when it worked'
)
COMMENT 'Watchdog: each load of the monitored-jobs list, and its result'
