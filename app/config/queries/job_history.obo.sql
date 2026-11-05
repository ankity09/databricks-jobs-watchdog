-- Each job's worst status in every fixed time window of the last few hours, oldest first, for the history strip.
-- A window is bucket_minutes long and starts on a multiple of it from the Unix epoch (a 120-minute window starts at an even UTC hour),
-- whatever the scan schedule is. So the strip has at most hours * 60 / bucket_minutes + 1 cells per job, and a job returns at most that many rows.
-- The status is the worst scan's in the window; scans counts the scans that saw the job in it.
-- @param catalog STRING = main
-- @param schema STRING = watchdog
-- @param refresh INT = 0
-- @param hours INT = 72
-- @param bucket_minutes INT = 120
SELECT job_name,
       workspace_id,
       job_id,
       timestamp_seconds(floor(unix_timestamp(observed_at) / (:bucket_minutes * 60)) * (:bucket_minutes * 60)) AS observed_at,
       max_by(status, CASE status WHEN 'FAILED' THEN 3 WHEN 'WARNING' THEN 2 WHEN 'UNKNOWN' THEN 1 ELSE 0 END) AS status,
       count(DISTINCT scan_id) AS scans
FROM IDENTIFIER(:catalog || '.' || :schema || '.findings')
WHERE :refresh >= 0 AND observed_at >= timestampadd(HOUR, -:hours, current_timestamp())
GROUP BY job_name, workspace_id, job_id, floor(unix_timestamp(observed_at) / (:bucket_minutes * 60))
ORDER BY observed_at
