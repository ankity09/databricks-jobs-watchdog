-- Enabled monitored jobs that a source wrote nothing about in the chosen
-- scan. Expect no rows: the system table scan always writes last_run_result
-- or not_found, and the Jobs API scan always writes live_run_status,
-- not_found or api_unreachable. :scan_id works as in 40_findings_by_source.sql.
-- Parameters: :catalog, :schema, :scan_id
WITH chosen AS (
  SELECT source, MAX_BY(scan_id, observed_at) AS scan_id
  FROM IDENTIFIER(:catalog || '.' || :schema || '.findings')
  WHERE :scan_id = '' OR scan_id = :scan_id
  GROUP BY source
),
sources AS (
  SELECT 'SYSTEM_TABLES' AS source
  UNION ALL
  SELECT 'JOBS_API'
),
seen AS (
  SELECT DISTINCT f.job_name, f.source
  FROM IDENTIFIER(:catalog || '.' || :schema || '.findings') f
  JOIN chosen c ON c.source = f.source AND c.scan_id = f.scan_id
)
SELECT m.job_name, s.source
FROM IDENTIFIER(:catalog || '.' || :schema || '.monitored_jobs') m
CROSS JOIN sources s
LEFT JOIN seen x ON x.job_name = m.job_name AND x.source = s.source
WHERE m.enabled AND x.job_name IS NULL
ORDER BY m.job_name, s.source
