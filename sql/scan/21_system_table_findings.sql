-- System table checks for every enabled monitored job, shaped as findings rows.
--
-- Notebook 05 runs this query, saves the result as the temp view
-- watchdog_new_findings, then adds it to the findings table with
-- 30_merge_findings.sql. The query also reads the temp view
-- watchdog_workspace_names (workspace names and URLs), which notebook 05
-- creates from sql/explore/11_workspace_names.sql first. To run this query in
-- the SQL editor, create that view yourself.
--
-- For each workspace job that a monitored job's regex matches, it returns one
-- row per check:
--   last_run_result  the newest finished run in the window
--   task_failures    tasks that failed since the job's newest successful run
--   schedule_gap     scheduled jobs: time since the newest run started
--   long_runtime     the newest finished run, and any run still going
-- A monitored job that matches no job in the region gets one not_found row.
-- System tables run about an hour behind, so a job created in the last hour
-- is not_found here while the Jobs API scan (notebook 06) already sees it.
-- Parameters: :catalog, :schema, :region, :lookback_hours, :scan_id
WITH monitored AS (
  SELECT job_name, job_name_regex, schedule_type, max_gap_minutes, max_runtime_minutes, severity, owner
  FROM IDENTIFIER(:catalog || '.' || :schema || '.monitored_jobs')
  WHERE enabled
),
dependents AS (
  -- the jobs that directly depend on each job, listed on its FAILED rows
  SELECT depends_on AS job_name, sort_array(collect_set(job_name)) AS affected_jobs
  FROM IDENTIFIER(:catalog || '.' || :schema || '.job_dependencies')
  WHERE dependency_type IN ('job', 'child_job')
  GROUP BY depends_on
),
latest_jobs AS (
  SELECT account_id, workspace_id, job_id, name, paused
  FROM system.lakeflow.jobs
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) = 1
      AND delete_time IS NULL
),
matched AS (
  SELECT
    m.job_name,
    m.schedule_type,
    m.max_gap_minutes,
    m.max_runtime_minutes,
    m.severity,
    j.account_id,
    j.workspace_id,
    j.job_id,
    j.paused
  FROM monitored m
  JOIN latest_jobs j ON regexp_like(j.name, m.job_name_regex)
),
runs AS (
  -- one row per run; a run longer than an hour spans several timeline rows,
  -- and only the newest row carries the result
  SELECT
    workspace_id,
    job_id,
    run_id,
    MIN(period_start_time) AS run_start,
    MAX(period_end_time) AS last_seen,
    MAX_BY(result_state, period_end_time) AS result_state,
    MAX_BY(termination_code, period_end_time) AS termination_code,
    MAX_BY(termination_type, period_end_time) AS termination_type
  FROM system.lakeflow.job_run_timeline
  WHERE period_start_time >= timestampadd(HOUR, -CAST(:lookback_hours AS INT), current_timestamp())
  GROUP BY workspace_id, job_id, run_id
),
newest_finished AS (
  SELECT *
  FROM runs
  WHERE result_state IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY last_seen DESC) = 1
),
newest_start AS (
  SELECT workspace_id, job_id, MAX(run_start) AS last_start
  FROM runs
  GROUP BY workspace_id, job_id
),
newest_success AS (
  SELECT workspace_id, job_id, MAX(last_seen) AS succeeded_at
  FROM runs
  WHERE result_state = 'SUCCEEDED'
  GROUP BY workspace_id, job_id
),
failed_tasks AS (
  -- failures already followed by a successful run of the job are left out
  SELECT
    t.workspace_id,
    t.job_id,
    sort_array(collect_set(t.task_key)) AS failed_task_keys,
    COUNT(*) AS failed_task_runs,
    MAX_BY(t.job_run_id, t.period_end_time) AS run_id,
    MAX_BY(t.termination_code, t.period_end_time) AS termination_code,
    MAX_BY(t.termination_type, t.period_end_time) AS termination_type
  FROM system.lakeflow.job_task_run_timeline t
  LEFT JOIN newest_success s ON s.workspace_id = t.workspace_id AND s.job_id = t.job_id
  WHERE t.period_start_time >= timestampadd(HOUR, -CAST(:lookback_hours AS INT), current_timestamp())
    AND t.result_state IN ('FAILED', 'ERROR', 'TIMED_OUT')
    AND (s.succeeded_at IS NULL OR t.period_end_time > s.succeeded_at)
  GROUP BY t.workspace_id, t.job_id
),
over_limit AS (
  -- the longest run over max_runtime_minutes, among runs still going and the
  -- newest finished run
  SELECT
    mt.job_name,
    mt.workspace_id,
    mt.job_id,
    MAX_BY(r.run_id, r.minutes) AS run_id,
    MAX(r.minutes) AS minutes,
    MAX_BY(r.still_running, r.minutes) AS still_running
  FROM matched mt
  JOIN (
    SELECT
      workspace_id,
      job_id,
      run_id,
      TRUE AS still_running,
      timestampdiff(MINUTE, run_start, current_timestamp()) AS minutes
    FROM runs
    WHERE result_state IS NULL
    UNION ALL
    SELECT workspace_id, job_id, run_id, FALSE, timestampdiff(MINUTE, run_start, last_seen)
    FROM newest_finished
  ) r ON r.workspace_id = mt.workspace_id AND r.job_id = mt.job_id
  WHERE r.minutes > mt.max_runtime_minutes
  GROUP BY mt.job_name, mt.workspace_id, mt.job_id
),
checks AS (
  SELECT
    mt.job_name,
    mt.account_id,
    mt.workspace_id,
    mt.job_id,
    'last_run_result' AS check_id,
    CASE
      WHEN f.run_id IS NULL THEN 'UNKNOWN'
      WHEN f.result_state = 'SUCCEEDED' THEN 'HEALTHY'
      WHEN f.result_state IN ('FAILED', 'ERROR', 'TIMED_OUT') THEN 'FAILED'
      WHEN f.result_state IN ('CANCELLED', 'SKIPPED', 'BLOCKED') THEN 'WARNING'
      ELSE 'UNKNOWN'
    END AS status,
    f.termination_type,
    f.run_id,
    CAST(NULL AS ARRAY<STRING>) AS failed_task_keys,
    CASE
      WHEN f.run_id IS NULL
        THEN format_string('No finished run in the last %d hours.', CAST(:lookback_hours AS INT))
      ELSE format_string(
        'Newest finished run ended %s%s, %d minutes ago.',
        f.result_state,
        coalesce(concat(' (', f.termination_code, ')'), ''),
        timestampdiff(MINUTE, f.last_seen, current_timestamp()))
    END AS error_summary
  FROM matched mt
  LEFT JOIN newest_finished f ON f.workspace_id = mt.workspace_id AND f.job_id = mt.job_id

  UNION ALL

  SELECT
    mt.job_name,
    mt.account_id,
    mt.workspace_id,
    mt.job_id,
    'task_failures',
    CASE WHEN t.run_id IS NULL THEN 'HEALTHY' ELSE 'FAILED' END,
    t.termination_type,
    t.run_id,
    t.failed_task_keys,
    CASE
      WHEN t.run_id IS NULL THEN 'No failed tasks since the newest successful run in the window.'
      ELSE format_string(
        '%d task run(s) failed since the newest successful run in the window. Newest termination code: %s.',
        t.failed_task_runs,
        coalesce(t.termination_code, 'none'))
    END
  FROM matched mt
  LEFT JOIN failed_tasks t ON t.workspace_id = mt.workspace_id AND t.job_id = mt.job_id

  UNION ALL

  SELECT
    mt.job_name,
    mt.account_id,
    mt.workspace_id,
    mt.job_id,
    'schedule_gap',
    CASE
      WHEN s.last_start IS NOT NULL
        AND timestampdiff(MINUTE, s.last_start, current_timestamp()) <= mt.max_gap_minutes + 60
        THEN 'HEALTHY'
      WHEN s.last_start IS NULL AND mt.max_gap_minutes + 60 > CAST(:lookback_hours AS INT) * 60
        THEN 'UNKNOWN'
      WHEN mt.severity = 'CRITICAL' THEN 'FAILED'
      ELSE 'WARNING'
    END,
    CAST(NULL AS STRING),
    CAST(NULL AS STRING),
    CAST(NULL AS ARRAY<STRING>),
    concat(
      CASE
        WHEN s.last_start IS NOT NULL
          THEN format_string('Newest run started %d minutes ago', timestampdiff(MINUTE, s.last_start, current_timestamp()))
        ELSE format_string('No run started in the last %d hours', CAST(:lookback_hours AS INT))
      END,
      format_string('. The limit is %d minutes, plus 60 for system table lag.', mt.max_gap_minutes),
      CASE
        WHEN s.last_start IS NULL AND mt.max_gap_minutes + 60 > CAST(:lookback_hours AS INT) * 60
          THEN ' The window is shorter than the limit, so raise lookback_hours to check this job.'
        ELSE ''
      END,
      CASE WHEN mt.paused THEN ' The job is paused.' ELSE '' END)
  FROM matched mt
  LEFT JOIN newest_start s ON s.workspace_id = mt.workspace_id AND s.job_id = mt.job_id
  WHERE mt.schedule_type = 'scheduled' AND mt.max_gap_minutes IS NOT NULL

  UNION ALL

  SELECT
    mt.job_name,
    mt.account_id,
    mt.workspace_id,
    mt.job_id,
    'long_runtime',
    CASE WHEN o.run_id IS NULL THEN 'HEALTHY' ELSE 'WARNING' END,
    CAST(NULL AS STRING),
    o.run_id,
    CAST(NULL AS ARRAY<STRING>),
    CASE
      WHEN o.run_id IS NULL
        THEN format_string('No run over the %d-minute limit (newest finished run and runs still going).', mt.max_runtime_minutes)
      WHEN o.still_running
        THEN format_string('A run has been going for %d minutes. The limit is %d.', o.minutes, mt.max_runtime_minutes)
      ELSE format_string('The newest finished run took %d minutes. The limit is %d.', o.minutes, mt.max_runtime_minutes)
    END
  FROM matched mt
  LEFT JOIN over_limit o
    ON o.job_name = mt.job_name AND o.workspace_id = mt.workspace_id AND o.job_id = mt.job_id
  WHERE mt.max_runtime_minutes IS NOT NULL

  UNION ALL

  SELECT
    m.job_name,
    (SELECT MAX(account_id) FROM latest_jobs),
    CAST(NULL AS STRING),
    CAST(NULL AS STRING),
    'not_found',
    'UNKNOWN',
    CAST(NULL AS STRING),
    CAST(NULL AS STRING),
    CAST(NULL AS ARRAY<STRING>),
    format_string(
      'No job in the system tables for this region matches %s. A new job takes about an hour to appear.',
      m.job_name_regex)
  FROM monitored m
  WHERE NOT EXISTS (SELECT 1 FROM matched mt WHERE mt.job_name = m.job_name)
)
SELECT
  current_timestamp() AS observed_at,
  :scan_id AS scan_id,
  c.account_id,
  nullif(:region, '') AS region,
  c.workspace_id,
  w.workspace_name,
  c.job_id,
  c.job_name,
  c.check_id,
  c.status,
  CASE WHEN c.status <> 'HEALTHY' THEN m.severity END AS severity,
  CASE
    WHEN c.status = 'HEALTHY' THEN 'NONE'
    WHEN c.status = 'UNKNOWN' THEN 'COVERAGE'
    WHEN c.check_id = 'long_runtime' THEN 'SLA_EXCEEDED'
    WHEN c.check_id = 'schedule_gap' THEN 'SCHEDULE_GAP'
    WHEN c.termination_type IN ('INTERNAL_ERROR', 'CLOUD_FAILURE') THEN 'INFRASTRUCTURE'
    ELSE 'FUNCTIONAL'
  END AS failure_category,
  c.run_id,
  CASE
    WHEN c.run_id IS NOT NULL AND w.workspace_url IS NOT NULL
      THEN concat(w.workspace_url, '/jobs/', c.job_id, '/runs/', c.run_id)
  END AS run_page_url,
  c.failed_task_keys,
  substr(c.error_summary, 1, 1000) AS error_summary,
  CASE
    WHEN c.status = 'FAILED' THEN coalesce(d.affected_jobs, CAST(array() AS ARRAY<STRING>))
  END AS affected_jobs,
  m.owner,
  'SYSTEM_TABLES' AS source
FROM checks c
JOIN monitored m ON m.job_name = c.job_name
LEFT JOIN dependents d ON d.job_name = c.job_name
LEFT JOIN watchdog_workspace_names w ON w.workspace_id = c.workspace_id
