-- Checks the incidents view against findings_latest, the newest scan of each
-- source. Expect no rows:
-- - every FAILED or WARNING row in findings_latest has an OPEN incident with
--   the same key (source, workspace, job ID, job name and check);
-- - every OPEN incident's newest problem row is in its source's newest scan.
--   An incident is flagged only when that scan has no row for its key, a
--   HEALTHY row, or a problem row that is not its newest problem row. A row
--   with any other status (l.status NOT IN ('HEALTHY', 'FAILED', 'WARNING'),
--   such as UNKNOWN) neither opens nor ends an incident, so it stays OPEN.
-- <=> is equality that treats two NULLs as equal: some keys have no
-- workspace or job ID.
-- Parameters: :catalog, :schema
WITH latest AS (
  SELECT source, workspace_id, job_id, job_name, check_id, scan_id, status
  FROM IDENTIFIER(:catalog || '.' || :schema || '.findings_latest')
),
open_incidents AS (
  SELECT source, workspace_id, job_id, job_name, check_id, last_seen_scan_id
  FROM IDENTIFIER(:catalog || '.' || :schema || '.incidents')
  WHERE state = 'OPEN'
)
SELECT
  'FAILED or WARNING in the newest scan, but no OPEN incident' AS problem,
  l.source,
  l.job_name,
  l.check_id,
  l.workspace_id,
  l.job_id,
  l.scan_id
FROM latest l
WHERE l.status IN ('FAILED', 'WARNING')
  AND NOT EXISTS (
    SELECT 1
    FROM open_incidents i
    WHERE i.source <=> l.source
      AND i.workspace_id <=> l.workspace_id
      AND i.job_id <=> l.job_id
      AND i.job_name <=> l.job_name
      AND i.check_id <=> l.check_id
  )

UNION ALL

SELECT
  'OPEN incident, but its newest problem row is older than the newest scan' AS problem,
  i.source,
  i.job_name,
  i.check_id,
  i.workspace_id,
  i.job_id,
  i.last_seen_scan_id AS scan_id
FROM open_incidents i
LEFT JOIN latest l
  ON i.source <=> l.source
  AND i.workspace_id <=> l.workspace_id
  AND i.job_id <=> l.job_id
  AND i.job_name <=> l.job_name
  AND i.check_id <=> l.check_id
WHERE l.scan_id IS NULL
  OR l.status = 'HEALTHY'
  OR (l.status IN ('FAILED', 'WARNING') AND l.scan_id <> i.last_seen_scan_id)
ORDER BY source, job_name, check_id
