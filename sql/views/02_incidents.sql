-- One row per incident: one problem with one check of one job, from the scan
-- that found it until a HEALTHY row clears it. Every scan writes a row for
-- every check into findings, so a problem that lasts is in every scan there;
-- this view lists it once. Later phases alert when an incident opens and when
-- it is resolved.
--
-- The rules:
-- - The key is one check of one job from one source: source, workspace_id,
--   job_id, job_name and check_id. job_id is part of it because a name pattern
--   can match several jobs. workspace_id and job_id are empty on some rows
--   (not_found, duplicate_name and CUSTOM rows). The view only groups and
--   partitions by the key, never joins on it, and both treat two empty values
--   as equal, so those rows group correctly.
-- - A source's scans are ordered by when each first wrote (its earliest
--   observed_at), as in findings_latest, so re-running an old scan_id never
--   makes it the newest. Times in this view are those scan times.
-- - A problem is a FAILED or WARNING row. An incident is a run of problem rows
--   for one key, in scan order, with no HEALTHY row for that key between them.
--   Every other status, such as UNKNOWN, neither opens nor ends an incident: a
--   check that cannot tell is not news. A scan without the key does not end
--   it either.
-- - state:
--     OPEN         no HEALTHY row came after it, and the key is in its
--                  source's newest scan (as a problem, or as UNKNOWN; then
--                  current_status says UNKNOWN);
--     RESOLVED     a HEALTHY row came after it; resolved_at and
--                  resolved_scan_id are that first HEALTHY row's scan;
--     NOT_CHECKED  no HEALTHY row came after it, and the key is not in its
--                  source's newest scan: the job was removed from the list,
--                  switched off, or not reached. If the key comes back as a
--                  problem with no HEALTHY row in between, it is the same
--                  incident again, OPEN.
-- - scans_seen counts the incident's problem rows. worst_status is FAILED if
--   any of them is FAILED. current_status is the key's newest status in any
--   row. The other columns come from the incident's newest problem row.
-- - Retention: watchdog_cleanup deletes scans older than retention_days, so
--   an incident older than that starts at the oldest row kept. Read opened_at
--   as "open since at least". When the scan it opened in is deleted,
--   opened_scan_id moves to the next kept scan and incident_id changes too.
--
-- A view cannot take parameter markers, so {schema} is replaced with the
-- checked, quoted catalog and schema (jobs_watchdog/upgrade.py). Notebook 01
-- creates it when it is missing and replaces it only when its columns differ
-- from jobs_watchdog.incidents.INCIDENT_COLUMNS or its watchdog.view_version
-- differs from the one below. Raise that number whenever you change this
-- definition.
CREATE OR REPLACE VIEW {schema}.incidents
COMMENT 'Watchdog: one row per problem (FAILED or WARNING rows for one check of one job), from the scan that found it until a HEALTHY row clears it'
TBLPROPERTIES ('watchdog.view_version' = '1')
AS
WITH scans AS (
  SELECT source, scan_id, min(observed_at) AS scan_time
  FROM {schema}.findings
  GROUP BY source, scan_id
),
ordered_scans AS (
  SELECT
    source,
    scan_id,
    scan_time,
    row_number() OVER (PARTITION BY source ORDER BY scan_time, scan_id) AS scan_order,
    last_value(scan_id) OVER (
      PARTITION BY source ORDER BY scan_time, scan_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS newest_scan_id
  FROM scans
),
history AS (
  SELECT
    f.source,
    f.workspace_id,
    f.job_id,
    f.job_name,
    f.check_id,
    f.scan_id,
    f.status,
    f.workspace_name,
    f.environment,
    f.owner,
    f.schedule_type,
    f.parent_job,
    f.severity,
    f.failure_category,
    f.error_summary,
    f.run_page_url,
    f.affected_jobs,
    s.scan_time,
    s.scan_order,
    s.newest_scan_id
  FROM {schema}.findings f
  JOIN ordered_scans s ON s.source = f.source AND s.scan_id = f.scan_id
),
marked AS (
  SELECT
    h.*,
    -- HEALTHY rows for this key up to this row: problem rows with the same
    -- count have no HEALTHY row between them, so they are one incident
    sum(CASE WHEN status = 'HEALTHY' THEN 1 ELSE 0 END) OVER (
      PARTITION BY source, workspace_id, job_id, job_name, check_id
      ORDER BY scan_order ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS healthy_before,
    -- the first HEALTHY row for this key after this row: it resolves the incident
    min(CASE WHEN status = 'HEALTHY' THEN named_struct('scan_order', scan_order, 'scan_id', scan_id,
                                                       'scan_time', scan_time) END) OVER (
      PARTITION BY source, workspace_id, job_id, job_name, check_id
      ORDER BY scan_order ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
    ) AS next_healthy,
    -- the key's newest row in any status
    max_by(named_struct('scan_id', scan_id, 'status', status), scan_order) OVER (
      PARTITION BY source, workspace_id, job_id, job_name, check_id
    ) AS key_newest
  FROM history h
),
incident_rows AS (
  SELECT
    source,
    workspace_id,
    job_id,
    job_name,
    check_id,
    min_by(scan_id, scan_order) AS opened_scan_id,
    min_by(scan_time, scan_order) AS opened_at,
    max_by(scan_id, scan_order) AS last_seen_scan_id,
    max_by(scan_time, scan_order) AS last_seen_at,
    count(*) AS scans_seen,
    CASE WHEN count_if(status = 'FAILED') > 0 THEN 'FAILED' ELSE 'WARNING' END AS worst_status,
    -- the incident's newest problem row
    max_by(named_struct('workspace_name', workspace_name, 'environment', environment, 'owner', owner,
                        'schedule_type', schedule_type, 'parent_job', parent_job, 'severity', severity,
                        'failure_category', failure_category, 'error_summary', error_summary,
                        'run_page_url', run_page_url, 'affected_jobs', affected_jobs), scan_order) AS latest,
    -- the same in every row of the incident: its next HEALTHY row, the key's
    -- newest row and the source's newest scan
    max_by(next_healthy, scan_order) AS resolved_by,
    max_by(key_newest, scan_order) AS key_newest,
    max_by(newest_scan_id, scan_order) AS newest_scan_id
  FROM marked
  WHERE status IN ('FAILED', 'WARNING')
  GROUP BY source, workspace_id, job_id, job_name, check_id, healthy_before
)
SELECT
  sha2(to_json(array(source, workspace_id, job_id, job_name, check_id, opened_scan_id)), 256) AS incident_id,
  CASE
    WHEN resolved_by IS NOT NULL THEN 'RESOLVED'
    WHEN key_newest.scan_id = newest_scan_id THEN 'OPEN'
    ELSE 'NOT_CHECKED'
  END AS state,
  source,
  check_id,
  workspace_id,
  latest.workspace_name AS workspace_name,
  job_id,
  job_name,
  latest.environment AS environment,
  latest.owner AS owner,
  latest.schedule_type AS schedule_type,
  latest.parent_job AS parent_job,
  latest.severity AS severity,
  latest.failure_category AS failure_category,
  opened_at,
  opened_scan_id,
  last_seen_at,
  last_seen_scan_id,
  scans_seen,
  worst_status,
  key_newest.status AS current_status,
  resolved_by.scan_time AS resolved_at,
  resolved_by.scan_id AS resolved_scan_id,
  latest.error_summary AS error_summary,
  latest.run_page_url AS run_page_url,
  latest.affected_jobs AS affected_jobs,
  opened_scan_id = newest_scan_id AS is_new
FROM incident_rows
