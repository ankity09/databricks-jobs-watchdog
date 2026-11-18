-- Every check of one job in the newest scans, for the job detail panel: worst status first, then by check and source.
-- The panel keeps the rows of the workspace and job ID it shows (a job name can run in several workspaces).
-- @param catalog STRING = main
-- @param schema STRING = watchdog
-- @param refresh INT = 0
-- @param job_name STRING = example_job
SELECT job_name,
       workspace_id,
       workspace_name,
       job_id,
       environment,
       owner,
       schedule_type,
       parent_job,
       check_id,
       source,
       status,
       severity,
       failure_category,
       error_summary,
       run_id,
       run_page_url,
       failed_task_keys,
       affected_jobs,
       code_version,
       pipeline_url,
       trigger_type,
       triggered_by,
       run_start_time,
       run_end_time,
       run_duration_seconds,
       observed_at
FROM IDENTIFIER(:catalog || '.' || :schema || '.findings_latest')
WHERE :refresh >= 0 AND job_name = :job_name
ORDER BY CASE status WHEN 'FAILED' THEN 3 WHEN 'WARNING' THEN 2 WHEN 'UNKNOWN' THEN 1 ELSE 0 END DESC, check_id, source
