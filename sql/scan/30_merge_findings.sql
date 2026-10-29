-- Adds a scan's rows to the findings table, each at most once.
-- The scan notebooks first put their rows in the temp view
-- watchdog_new_findings. A row whose key is already in the table (same
-- scan_id, workspace, job ID, job name, check and source) is skipped, so
-- re-running a scan with the same scan_id adds nothing.
-- <=> is equality that treats two NULLs as equal: not_found rows can have no
-- workspace or job ID.
-- Parameters: :catalog, :schema
MERGE INTO IDENTIFIER(:catalog || '.' || :schema || '.findings') AS t
USING watchdog_new_findings AS s
ON t.scan_id <=> s.scan_id
  AND t.workspace_id <=> s.workspace_id
  AND t.job_id <=> s.job_id
  AND t.job_name <=> s.job_name
  AND t.check_id <=> s.check_id
  AND t.source <=> s.source
WHEN NOT MATCHED THEN INSERT *
