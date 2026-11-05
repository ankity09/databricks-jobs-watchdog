-- Adds the row in the temp view watchdog_config_load (notebook 02) to config_loads.
-- Parameters: :catalog, :schema
INSERT INTO IDENTIFIER(:catalog || '.' || :schema || '.config_loads')
SELECT loaded_at, scan_id, source, source_ref, version, job_count, status, error FROM watchdog_config_load
