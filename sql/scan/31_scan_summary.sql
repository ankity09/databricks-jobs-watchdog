-- What one scan holds, and how its problems moved, for each source with rows
-- in that scan. Notebooks 05 and 06 print their own source's row after they
-- write (jobs_watchdog/incidents.py scan_summary); a source with no row here
-- wrote nothing in this scan.
-- rows_written: the rows the scan holds in findings, one per job and check.
-- Running the same scan again adds none.
-- new_problems: incidents that opened in this scan.
-- still_open: OPEN incidents that opened in an earlier scan.
-- resolved: incidents that a HEALTHY row in this scan cleared.
-- Parameters: :catalog, :schema, :scan_id
WITH written AS (
  SELECT source, count(*) AS rows_written
  FROM IDENTIFIER(:catalog || '.' || :schema || '.findings')
  WHERE scan_id = :scan_id
  GROUP BY source
),
moved AS (
  SELECT
    source,
    count_if(opened_scan_id = :scan_id) AS new_problems,
    count_if(state = 'OPEN' AND opened_scan_id <> :scan_id) AS still_open,
    count_if(resolved_scan_id = :scan_id) AS resolved
  FROM IDENTIFIER(:catalog || '.' || :schema || '.incidents')
  GROUP BY source
)
SELECT
  w.source,
  w.rows_written,
  coalesce(m.new_problems, 0) AS new_problems,
  coalesce(m.still_open, 0) AS still_open,
  coalesce(m.resolved, 0) AS resolved
FROM written w
LEFT JOIN moved m ON m.source = w.source
ORDER BY w.source
