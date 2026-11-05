-- @param catalog STRING = main
-- @param schema STRING = watchdog
-- @param refresh INT = 0
SELECT source, max(observed_at) AS last_observed_at, max_by(scan_id, observed_at) AS scan_id
FROM IDENTIFIER(:catalog || '.' || :schema || '.findings_latest')
WHERE :refresh >= 0
GROUP BY source
