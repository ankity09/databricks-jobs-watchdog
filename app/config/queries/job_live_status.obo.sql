-- @param catalog STRING = main
-- @param schema STRING = watchdog
-- @param refresh INT = 0
SELECT job_name,
       max_by(status, CASE status WHEN 'FAILED' THEN 3 WHEN 'WARNING' THEN 2 WHEN 'UNKNOWN' THEN 1 ELSE 0 END) AS status
FROM IDENTIFIER(:catalog || '.' || :schema || '.findings_latest')
WHERE :refresh >= 0
GROUP BY job_name
