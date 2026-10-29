-- How many findings each source wrote in a scan, by status.
-- Set :scan_id to check one scan. Leave it empty to check each source's
-- newest scan, which is what you want after running notebooks 05 and 06 by
-- hand (each makes its own scan_id). Expect a SYSTEM_TABLES row and a
-- JOBS_API row.
-- Parameters: :catalog, :schema, :scan_id
WITH chosen AS (
  SELECT source, MAX_BY(scan_id, observed_at) AS scan_id
  FROM IDENTIFIER(:catalog || '.' || :schema || '.findings')
  WHERE :scan_id = '' OR scan_id = :scan_id
  GROUP BY source
)
SELECT f.source, f.scan_id, f.status, COUNT(*) AS findings
FROM IDENTIFIER(:catalog || '.' || :schema || '.findings') f
JOIN chosen c ON c.source = f.source AND c.scan_id = f.scan_id
GROUP BY f.source, f.scan_id, f.status
ORDER BY f.source, f.status
