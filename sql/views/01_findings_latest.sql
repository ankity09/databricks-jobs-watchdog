-- The current snapshot: every row from each source's newest scan.
-- Dashboards, Genie and alerts read this view; the findings table itself
-- keeps every scan as history, which change-only alerts need.
-- A view cannot take parameter markers, so {schema} is replaced with the
-- checked, quoted catalog and schema (jobs_watchdog/upgrade.py). Notebook 01
-- creates it when it is missing and replaces it only when its columns differ
-- from the findings table or its watchdog.view_version differs from the one
-- below. Raise that number whenever you change this definition.
CREATE OR REPLACE VIEW {schema}.findings_latest
COMMENT 'Watchdog: the newest scan from each source, the current status of every monitored job'
TBLPROPERTIES ('watchdog.view_version' = '2')
AS
SELECT f.*
FROM {schema}.findings f
JOIN (
  -- each scan is ranked by when it first wrote, so re-running an old scan_id
  -- never makes that old scan the newest one
  SELECT source, max_by(scan_id, first_seen) AS scan_id
  FROM (
    SELECT source, scan_id, min(observed_at) AS first_seen
    FROM {schema}.findings
    GROUP BY source, scan_id
  ) scans
  GROUP BY source
) newest
  ON newest.source = f.source AND newest.scan_id = f.scan_id
