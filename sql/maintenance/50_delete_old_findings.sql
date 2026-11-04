-- Deletes old scans from the findings table, so it does not grow forever.
-- A scan is old when its first row is more than :retention_days days old.
-- Each source's newest scan is always kept, even when it is older than that,
-- so findings_latest never goes empty when the scans stop for a while. Scans
-- are ranked by when they first wrote, as in findings_latest, and a scan is
-- deleted whole, never in part. :retention_days 0 keeps everything.
-- Notebook 10 and the watchdog_cleanup job run this once a day.
-- Parameters: :catalog, :schema, :retention_days
MERGE INTO IDENTIFIER(:catalog || '.' || :schema || '.findings') AS t
USING (
  SELECT source, scan_id
  FROM (
    SELECT
      source,
      scan_id,
      first_seen,
      row_number() OVER (PARTITION BY source ORDER BY first_seen DESC, scan_id DESC) AS newest_first
    FROM (
      SELECT source, scan_id, min(observed_at) AS first_seen
      FROM IDENTIFIER(:catalog || '.' || :schema || '.findings')
      GROUP BY source, scan_id
    ) scans
  ) ranked
  WHERE newest_first > 1
    AND CAST(:retention_days AS INT) > 0
    AND first_seen < timestampadd(DAY, -CAST(:retention_days AS INT), current_timestamp())
) old
ON t.source = old.source AND t.scan_id = old.scan_id
WHEN MATCHED THEN DELETE
