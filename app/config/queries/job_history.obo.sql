-- Each job's worst status at every scan in the last few hours (the hours parameter), oldest first, for the history strip.
-- Six columns only, so a week of hourly scans for a few hundred jobs stays small.
-- @param catalog STRING = main
-- @param schema STRING = watchdog
-- @param refresh INT = 0
-- @param hours INT = 72
SELECT job_name,
       workspace_id,
       job_id,
       scan_id,
       min(observed_at) AS observed_at,
       max_by(status, CASE status WHEN 'FAILED' THEN 3 WHEN 'WARNING' THEN 2 WHEN 'UNKNOWN' THEN 1 ELSE 0 END) AS status
FROM IDENTIFIER(:catalog || '.' || :schema || '.findings')
WHERE :refresh >= 0 AND observed_at >= timestampadd(HOUR, -:hours, current_timestamp())
GROUP BY job_name, workspace_id, job_id, scan_id
ORDER BY observed_at
