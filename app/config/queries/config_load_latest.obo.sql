-- @param catalog STRING = main
-- @param schema STRING = watchdog
-- @param refresh INT = 0
SELECT loaded_at, scan_id, source, source_ref, version, job_count, status, error
FROM IDENTIFIER(:catalog || '.' || :schema || '.config_loads')
WHERE :refresh >= 0
ORDER BY loaded_at DESC
LIMIT 5
