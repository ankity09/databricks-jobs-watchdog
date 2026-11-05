-- One row per monitored job in each workspace, from the newest scans: the worst status of its checks,
-- the checks that are not healthy, the error of the worst one, and the newest run.
-- @param catalog STRING = main
-- @param schema STRING = watchdog
-- @param refresh INT = 0
SELECT job_name,
       workspace_id,
       job_id,
       max(workspace_name) AS workspace_name,
       max(environment) AS environment,
       max(owner) AS owner,
       max(schedule_type) AS schedule_type,
       max(parent_job) AS parent_job,
       max_by(status, CASE status WHEN 'FAILED' THEN 3 WHEN 'WARNING' THEN 2 WHEN 'UNKNOWN' THEN 1 ELSE 0 END) AS status,
       max_by(severity, CASE severity WHEN 'CRITICAL' THEN 2 WHEN 'WARNING' THEN 1 ELSE 0 END) FILTER (WHERE status <> 'HEALTHY') AS severity,
       array_sort(collect_set(check_id) FILTER (WHERE status <> 'HEALTHY')) AS failing_checks,
       -- The worst check's error. Ties go to the Jobs API (its text holds the task's own error), then to the
       -- check name, so the reason stays the same from one refresh to the next.
       max_by(error_summary, struct(CASE status WHEN 'FAILED' THEN 3 WHEN 'WARNING' THEN 2 WHEN 'UNKNOWN' THEN 1 ELSE 0 END, source = 'JOBS_API', check_id)) AS top_error,
       max(run_start_time) AS last_run_start,
       -- The newest run's link. That run's system-tables and Jobs API rows tie on the start time, and only one may
       -- have the link, so among rows that tie a link wins. Only rows with a start time count, so the link is
       -- never an older run's.
       max_by(run_page_url, struct(run_start_time, run_page_url IS NOT NULL)) FILTER (WHERE run_start_time IS NOT NULL) AS last_run_url,
       max(observed_at) AS observed_at
FROM IDENTIFIER(:catalog || '.' || :schema || '.findings_latest')
WHERE :refresh >= 0
GROUP BY job_name, workspace_id, job_id
