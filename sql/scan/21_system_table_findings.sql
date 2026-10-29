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
--   last_run_result  scheduled jobs: the newest finished run in the window;
--                    continuous jobs: the newest run, even while it runs
--   task_failures    tasks whose newest attempt failed, in the newest run
--   schedule_gap     scheduled jobs: time since the newest run started
--   long_runtime     the newest finished run, and any run still going,
--                    measured up to its newest system table record
-- A monitored job that matches no job in the region gets one not_found row.
-- System tables run about an hour behind, so a job created in the last hour
-- is not_found here while the Jobs API scan (notebook 06) already sees it.
-- Job names matching a job's job_name_exclude_regex (for example test copies)
-- are skipped. A job's environments section (monitored_job_environments) can
-- switch it off, or change its limits, severity and owner, in one environment;
-- a job found only where it is switched off still gets a not_found row. Each
-- row also carries the environment label of its workspace
-- (monitored_workspaces), when and how the run it is about started, the job
-- tags, the code version (the value of the job tag named :code_version_tag),
-- and the CI pipeline link (the run's job parameter named :pipeline_url_parameter).
-- Parameters: :catalog, :schema, :region, :lookback_hours, :scan_id, :code_version_tag, :pipeline_url_parameter
WITH monitored AS (
  -- every configured job; whether it is checked is decided per environment below
  SELECT job_name, job_name_regex, job_name_exclude_regex, schedule_type, max_gap_minutes, max_runtime_minutes,
         severity, owner, enabled
  FROM IDENTIFIER(:catalog || '.' || :schema || '.monitored_jobs')
),
overrides AS (
  -- per-environment settings from the environments sections of the job list
  SELECT job_name, environment, severity, owner, enabled, max_gap_minutes, max_runtime_minutes
  FROM IDENTIFIER(:catalog || '.' || :schema || '.monitored_job_environments')
),
active AS (
  -- jobs switched on in at least one environment
  SELECT m.job_name, m.job_name_regex
  FROM monitored m
  WHERE m.enabled OR EXISTS (SELECT 1 FROM overrides o WHERE o.job_name = m.job_name AND o.enabled)
),
dependents AS (
  -- the jobs that directly depend on each job, listed on its FAILED rows
  SELECT depends_on AS job_name, sort_array(collect_set(job_name)) AS affected_jobs
  FROM IDENTIFIER(:catalog || '.' || :schema || '.job_dependencies')
  WHERE dependency_type IN ('job', 'child_job')
  GROUP BY depends_on
),
latest_jobs AS (
  SELECT account_id, workspace_id, job_id, name, paused, tags
  FROM system.lakeflow.jobs
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) = 1
      AND delete_time IS NULL
),
environments AS (
  -- the environment label of each workspace: an entry with this workspace ID,
  -- otherwise an entry with no ID whose name matches the workspace name
  SELECT w.workspace_id, coalesce(by_id.environment, by_name.environment) AS environment
  FROM (SELECT DISTINCT workspace_id FROM latest_jobs) w
  LEFT JOIN watchdog_workspace_names n ON n.workspace_id = w.workspace_id
  LEFT JOIN IDENTIFIER(:catalog || '.' || :schema || '.monitored_workspaces') by_id
    ON by_id.workspace_id = w.workspace_id
  LEFT JOIN IDENTIFIER(:catalog || '.' || :schema || '.monitored_workspaces') by_name
    ON by_name.workspace_id IS NULL AND lower(by_name.workspace_name) = lower(n.workspace_name)
),
regex_matched AS (
  -- every job in the region a monitored job's patterns match, with its workspace's environment
  SELECT
    m.job_name,
    m.schedule_type,
    m.max_gap_minutes,
    m.max_runtime_minutes,
    m.severity,
    m.enabled,
    j.account_id,
    j.workspace_id,
    j.job_id,
    j.paused,
    j.tags,
    e.environment
  FROM monitored m
  JOIN latest_jobs j
    ON regexp_like(j.name, m.job_name_regex)
    AND (m.job_name_exclude_regex IS NULL OR NOT regexp_like(j.name, m.job_name_exclude_regex))
  LEFT JOIN environments e ON e.workspace_id = j.workspace_id
),
matched AS (
  -- the matches switched on in their environment, with that environment's settings
  SELECT
    r.job_name,
    r.schedule_type,
    coalesce(o.max_gap_minutes, r.max_gap_minutes) AS max_gap_minutes,
    coalesce(o.max_runtime_minutes, r.max_runtime_minutes) AS max_runtime_minutes,
    coalesce(o.severity, r.severity) AS severity,
    r.account_id,
    r.workspace_id,
    r.job_id,
    r.paused,
    r.tags
  FROM regex_matched r
  LEFT JOIN overrides o ON o.job_name = r.job_name AND o.environment = r.environment
  WHERE coalesce(o.enabled, r.enabled)
),
switched_off AS (
  -- monitored jobs found in the region only where they are switched off
  SELECT DISTINCT job_name FROM regex_matched
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
    MAX_BY(termination_type, period_end_time) AS termination_type,
    MAX(trigger_type) AS trigger_type,
    MAX_BY(job_parameters, period_end_time) AS job_parameters,
    -- rows are hourly slices, so a first slice in the window's first hour
    -- usually means the run began before the window: its real start is unknown
    MIN(period_start_time) < timestampadd(HOUR, 1 - CAST(:lookback_hours AS INT), current_timestamp())
      AS started_before_window
  FROM system.lakeflow.job_run_timeline
  WHERE period_start_time >= timestampadd(HOUR, -CAST(:lookback_hours AS INT), current_timestamp())
  GROUP BY workspace_id, job_id, run_id
),
newest_run AS (
  -- each job's newest run in the window, finished or still going
  SELECT *
  FROM runs
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY run_start DESC) = 1
),
newest_finished AS (
  SELECT *
  FROM runs
  WHERE result_state IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY last_seen DESC) = 1
),
last_runs AS (
  -- what last_run_result judges: a scheduled job's newest finished run, or a
  -- continuous job's newest run while it is still going (a healthy stream
  -- never finishes, so its last finished run is usually an old restart)
  SELECT
    mt.job_name,
    mt.account_id,
    mt.workspace_id,
    mt.job_id,
    mt.tags,
    mt.schedule_type = 'continuous' AND n.run_id IS NOT NULL AND n.result_state IS NULL AS running,
    n.run_id AS newest_run_id,
    n.run_start AS newest_start,
    n.last_seen AS newest_seen,
    n.trigger_type AS newest_trigger,
    n.started_before_window AS newest_before_window,
    n.job_parameters AS newest_parameters,
    f.run_id,
    f.run_start,
    f.result_state,
    f.termination_code,
    f.termination_type,
    f.trigger_type,
    f.started_before_window,
    f.job_parameters,
    f.last_seen
  FROM matched mt
  LEFT JOIN newest_run n ON n.workspace_id = mt.workspace_id AND n.job_id = mt.job_id
  LEFT JOIN newest_finished f ON f.workspace_id = mt.workspace_id AND f.job_id = mt.job_id
),
task_attempts AS (
  -- the newest row of each task in each run: a retried task counts by its
  -- newest attempt, and a task still running (no result yet) is not failed
  SELECT workspace_id, job_id, job_run_id, task_key, period_end_time, result_state, termination_code, termination_type
  FROM system.lakeflow.job_task_run_timeline
  WHERE period_start_time >= timestampadd(HOUR, -CAST(:lookback_hours AS INT), current_timestamp())
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY workspace_id, job_id, job_run_id, task_key ORDER BY period_end_time DESC) = 1
),
failed_tasks AS (
  -- tasks whose newest attempt failed, in the job's newest run; failures in
  -- older runs are settled by the newer run
  SELECT
    t.workspace_id,
    t.job_id,
    sort_array(collect_set(t.task_key)) AS failed_task_keys,
    MAX(t.job_run_id) AS run_id,
    MAX_BY(t.termination_code, t.period_end_time) AS termination_code,
    MAX_BY(t.termination_type, t.period_end_time) AS termination_type
  FROM task_attempts t
  JOIN newest_run n ON n.workspace_id = t.workspace_id AND n.job_id = t.job_id AND n.run_id = t.job_run_id
  WHERE t.result_state IN ('FAILED', 'ERROR', 'TIMED_OUT')
  GROUP BY t.workspace_id, t.job_id
),
over_limit AS (
  -- the longest run over max_runtime_minutes, among runs still going and the
  -- newest finished run. Runs are measured up to their newest system table
  -- record, not to now: a finished run whose last hourly row has not landed
  -- yet would otherwise look like it is still going
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
      timestampdiff(MINUTE, run_start, last_seen) AS minutes
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
    l.job_name,
    l.account_id,
    l.workspace_id,
    l.job_id,
    'last_run_result' AS check_id,
    CASE
      WHEN l.running THEN 'HEALTHY'
      WHEN l.run_id IS NULL THEN 'UNKNOWN'
      WHEN l.result_state = 'SUCCEEDED' THEN 'HEALTHY'
      WHEN l.result_state IN ('FAILED', 'ERROR', 'TIMED_OUT') THEN 'FAILED'
      WHEN l.result_state IN ('CANCELLED', 'SKIPPED', 'BLOCKED') THEN 'WARNING'
      ELSE 'UNKNOWN'
    END AS status,
    CASE WHEN l.running THEN NULL ELSE l.termination_type END AS termination_type,
    CASE WHEN l.running THEN l.newest_run_id ELSE l.run_id END AS run_id,
    CAST(NULL AS ARRAY<STRING>) AS failed_task_keys,
    CASE
      WHEN l.running THEN concat(
        format_string(
          'Continuous job: the newest run is still going (newest system table record %d minutes old).',
          timestampdiff(MINUTE, l.newest_seen, current_timestamp())),
        CASE WHEN l.result_state IS NULL THEN '' ELSE concat(' The newest finished run ended ', l.result_state, '.') END)
      WHEN l.run_id IS NULL
        THEN format_string('No finished run in the last %d hours.', CAST(:lookback_hours AS INT))
      ELSE format_string(
        'Newest finished run ended %s%s, %d minutes ago.',
        l.result_state,
        coalesce(concat(' (', l.termination_code, ')'), ''),
        timestampdiff(MINUTE, l.last_seen, current_timestamp()))
    END AS error_summary,
    l.tags AS job_tags,
    CASE
      WHEN l.running THEN CASE WHEN l.newest_before_window THEN NULL ELSE l.newest_start END
      WHEN l.started_before_window THEN NULL
      ELSE l.run_start
    END AS run_start_time,
    CASE WHEN l.running THEN CAST(NULL AS TIMESTAMP) ELSE l.last_seen END AS run_end_time,
    CASE
      WHEN l.running THEN CASE WHEN l.newest_before_window THEN NULL
                               ELSE timestampdiff(SECOND, l.newest_start, l.newest_seen) END
      WHEN l.started_before_window THEN NULL
      ELSE timestampdiff(SECOND, l.run_start, l.last_seen)
    END AS run_duration_seconds,
    CASE WHEN l.running THEN l.newest_trigger ELSE l.trigger_type END AS raw_trigger,
    CASE WHEN l.running THEN l.newest_parameters ELSE l.job_parameters END AS job_parameters
  FROM last_runs l

  UNION ALL

  SELECT
    mt.job_name,
    mt.account_id,
    mt.workspace_id,
    mt.job_id,
    'task_failures',
    CASE WHEN t.run_id IS NULL THEN 'HEALTHY' ELSE 'FAILED' END,
    t.termination_type,
    coalesce(t.run_id, n.run_id),
    t.failed_task_keys,
    CASE
      WHEN t.run_id IS NULL THEN 'No failed tasks in the newest run.'
      ELSE format_string(
        '%d task(s) failed in the newest run, judged by the newest attempt of each task. Newest termination code: %s.',
        size(t.failed_task_keys),
        coalesce(t.termination_code, 'none'))
    END,
    mt.tags,
    CASE WHEN n.started_before_window THEN NULL ELSE n.run_start END,
    CASE WHEN n.result_state IS NULL THEN CAST(NULL AS TIMESTAMP) ELSE n.last_seen END,
    CASE WHEN n.started_before_window THEN NULL ELSE timestampdiff(SECOND, n.run_start, n.last_seen) END,
    n.trigger_type,
    n.job_parameters
  FROM matched mt
  LEFT JOIN failed_tasks t ON t.workspace_id = mt.workspace_id AND t.job_id = mt.job_id
  LEFT JOIN newest_run n ON n.workspace_id = mt.workspace_id AND n.job_id = mt.job_id

  UNION ALL

  SELECT
    mt.job_name,
    mt.account_id,
    mt.workspace_id,
    mt.job_id,
    'schedule_gap',
    CASE
      WHEN s.run_start IS NOT NULL
        AND timestampdiff(MINUTE, s.run_start, current_timestamp()) <= mt.max_gap_minutes + 60
        THEN 'HEALTHY'
      WHEN s.run_start IS NULL AND mt.max_gap_minutes + 60 > CAST(:lookback_hours AS INT) * 60
        THEN 'UNKNOWN'
      WHEN mt.severity = 'CRITICAL' THEN 'FAILED'
      ELSE 'WARNING'
    END,
    CAST(NULL AS STRING),
    s.run_id,
    CAST(NULL AS ARRAY<STRING>),
    concat(
      CASE
        WHEN s.run_start IS NOT NULL
          THEN format_string('Newest run started %d minutes ago', timestampdiff(MINUTE, s.run_start, current_timestamp()))
        ELSE format_string('No run started in the last %d hours', CAST(:lookback_hours AS INT))
      END,
      format_string('. The limit is %d minutes, plus 60 for system table lag.', mt.max_gap_minutes),
      CASE
        WHEN s.run_start IS NULL AND mt.max_gap_minutes + 60 > CAST(:lookback_hours AS INT) * 60
          THEN ' The window is shorter than the limit, so raise lookback_hours to check this job.'
        ELSE ''
      END,
      CASE WHEN mt.paused THEN ' The job is paused.' ELSE '' END),
    mt.tags,
    CASE WHEN s.started_before_window THEN NULL ELSE s.run_start END,
    CASE WHEN s.result_state IS NULL THEN CAST(NULL AS TIMESTAMP) ELSE s.last_seen END,
    CASE WHEN s.started_before_window THEN NULL ELSE timestampdiff(SECOND, s.run_start, s.last_seen) END,
    s.trigger_type,
    s.job_parameters
  FROM matched mt
  LEFT JOIN newest_run s ON s.workspace_id = mt.workspace_id AND s.job_id = mt.job_id
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
    lr.run_id,
    CAST(NULL AS ARRAY<STRING>),
    CASE
      WHEN o.run_id IS NULL
        THEN format_string('No run over the %d-minute limit (newest finished run and runs still going).', mt.max_runtime_minutes)
      WHEN o.still_running
        THEN format_string(
          'A run still going had run %d minutes by its newest system table record. The limit is %d.',
          o.minutes, mt.max_runtime_minutes)
      ELSE format_string('The newest finished run took %d minutes. The limit is %d.', o.minutes, mt.max_runtime_minutes)
    END,
    mt.tags,
    CASE WHEN lr.started_before_window THEN NULL ELSE lr.run_start END,
    CASE WHEN lr.result_state IS NULL THEN CAST(NULL AS TIMESTAMP) ELSE lr.last_seen END,
    CASE WHEN lr.started_before_window THEN NULL ELSE timestampdiff(SECOND, lr.run_start, lr.last_seen) END,
    lr.trigger_type,
    lr.job_parameters
  FROM matched mt
  LEFT JOIN over_limit o
    ON o.job_name = mt.job_name AND o.workspace_id = mt.workspace_id AND o.job_id = mt.job_id
  LEFT JOIN newest_finished nf ON nf.workspace_id = mt.workspace_id AND nf.job_id = mt.job_id
  LEFT JOIN runs lr
    ON lr.workspace_id = mt.workspace_id AND lr.job_id = mt.job_id AND lr.run_id = coalesce(o.run_id, nf.run_id)
  WHERE mt.max_runtime_minutes IS NOT NULL

  UNION ALL

  SELECT
    a.job_name,
    (SELECT MAX(account_id) FROM latest_jobs),
    CAST(NULL AS STRING),
    CAST(NULL AS STRING),
    'not_found',
    'UNKNOWN',
    CAST(NULL AS STRING),
    CAST(NULL AS STRING),
    CAST(NULL AS ARRAY<STRING>),
    CASE
      WHEN s.job_name IS NOT NULL THEN format_string(
        'Every job in this region that matches %s is in an environment where this job is switched off.',
        a.job_name_regex)
      ELSE format_string(
        'No job in the system tables for this region matches %s. A new job takes about an hour to appear.',
        a.job_name_regex)
    END,
    CAST(NULL AS MAP<STRING, STRING>),
    CAST(NULL AS TIMESTAMP),
    CAST(NULL AS TIMESTAMP),
    CAST(NULL AS BIGINT),
    CAST(NULL AS STRING),
    CAST(NULL AS MAP<STRING, MAP<STRING, STRING>>)
  FROM active a
  LEFT JOIN switched_off s ON s.job_name = a.job_name
  WHERE NOT EXISTS (SELECT 1 FROM matched mt WHERE mt.job_name = a.job_name)
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
  CASE WHEN c.status <> 'HEALTHY' THEN coalesce(so.severity, m.severity) END AS severity,
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
  coalesce(so.owner, m.owner) AS owner,
  'SYSTEM_TABLES' AS source,
  e.environment,
  m.schedule_type,
  c.run_start_time,
  c.run_end_time,
  c.run_duration_seconds,
  -- the same mapping as jobs_watchdog.states.normalize_trigger
  CASE c.raw_trigger
    WHEN 'CRON' THEN 'SCHEDULE'
    WHEN 'PERIODIC' THEN 'SCHEDULE'
    WHEN 'ONETIME' THEN 'ONE_TIME'
    WHEN 'ONE_TIME' THEN 'ONE_TIME'
    WHEN 'RETRY' THEN 'RETRY'
    WHEN 'ONETIME_RETRY' THEN 'RETRY'
    WHEN 'CONTINUOUS' THEN 'CONTINUOUS'
    WHEN 'CONTINUOUS_RESTART' THEN 'CONTINUOUS'
    WHEN 'FILE_ARRIVAL' THEN 'FILE_ARRIVAL'
    WHEN 'TABLE' THEN 'TABLE_UPDATE'
    WHEN 'RUN_JOB_TASK' THEN 'JOB_TASK'
    ELSE nullif(c.raw_trigger, '')
  END AS trigger_type,
  CAST(NULL AS STRING) AS triggered_by,
  c.job_tags,
  CASE WHEN :code_version_tag <> '' THEN try_element_at(c.job_tags, :code_version_tag) END AS code_version,
  -- job_parameters holds {name: {value, default}} for the run
  CASE WHEN :pipeline_url_parameter <> '' THEN coalesce(
    try_element_at(try_element_at(c.job_parameters, :pipeline_url_parameter), 'value'),
    try_element_at(try_element_at(c.job_parameters, :pipeline_url_parameter), 'default'))
  END AS pipeline_url
FROM checks c
JOIN monitored m ON m.job_name = c.job_name
LEFT JOIN dependents d ON d.job_name = c.job_name
LEFT JOIN watchdog_workspace_names w ON w.workspace_id = c.workspace_id
LEFT JOIN environments e ON e.workspace_id = c.workspace_id
LEFT JOIN overrides so ON so.job_name = c.job_name AND so.environment = e.environment
