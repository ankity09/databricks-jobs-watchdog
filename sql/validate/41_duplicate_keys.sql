-- Findings keys that appear more than once, across every scan. Expect no
-- rows: the merge adds each key (scan, workspace, job ID, job name, check,
-- source) at most once.
-- Parameters: :catalog, :schema
SELECT scan_id, workspace_id, job_id, job_name, check_id, source, COUNT(*) AS copies
FROM IDENTIFIER(:catalog || '.' || :schema || '.findings')
GROUP BY scan_id, workspace_id, job_id, job_name, check_id, source
HAVING COUNT(*) > 1
ORDER BY copies DESC
