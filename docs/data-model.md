# Data model

The Watchdog keeps four Delta tables and one view in one schema, `<catalog>.<schema>` (the schema defaults to `watchdog`). Notebook 01 creates them from the files in `sql/setup` and `sql/views`. Every column has a comment, so `DESCRIBE TABLE <catalog>.<schema>.findings` shows the same descriptions as this page.

| Object | What it holds | How it changes |
|---|---|---|
| `monitored_jobs` | the jobs to check, with their limits | replaced each time notebook 02 loads your YAML file |
| `job_dependencies` | what each job depends on | replaced each time notebook 02 loads your YAML file |
| `monitored_workspaces` | an environment label for each workspace | replaced each time notebook 02 loads your YAML file |
| `findings` | what every scan found, from every source | rows are added, never updated or deleted |
| `findings_latest` (view) | the newest scan from each source | computed from `findings` each time it is read |

The scans read the config tables, not the YAML file. The scheduled job loads the file again on every run, so an edit counts from the next run. When you run a scan by hand, run notebook 02 first.

## monitored_jobs

One row per job you want checked.

| Column | Type | Meaning |
|---|---|---|
| `job_name` | STRING, required | Short logical name. It appears on every finding and alert. Unique in the file. |
| `job_name_regex` | STRING, required | Matches the job's real name in each workspace. Left out, it is `^<job_name>$`. |
| `job_name_exclude_regex` | STRING | Optional. A job whose real name matches this is skipped, even when `job_name_regex` matches it. Use it for test copies. |
| `schedule_type` | STRING, required | `scheduled` or `continuous`. Left out, it is `scheduled`. Only scheduled jobs get the `schedule_gap` check. |
| `max_gap_minutes` | INT | Scheduled jobs: the longest allowed time between run starts. Required for scheduled jobs. |
| `max_runtime_minutes` | INT | The longest allowed run. Left out turns off `long_runtime` and `live_long_runtime`. |
| `max_retries` | INT | A task retried more times than this is a retry loop. Left out turns off `retry_loop`. Set it below the job's own task retry limit: a job never retries past its own limit, so an equal value never fires. |
| `severity` | STRING, required | `CRITICAL` or `WARNING`. Left out, it is `WARNING`. Copied to every finding about this job that is not HEALTHY. |
| `owner` | STRING | Team or person to route findings to. Copied to every finding. |
| `enabled` | BOOLEAN, required | `true` or `false`, written without quotes. Any other value stops the load. `false` keeps the entry in the table without checking it. Left out, it is `true`. |
| `notes` | STRING | Free text. |
| `loaded_at` | TIMESTAMP, required | When notebook 02 loaded the row. |

About `job_name_regex` and `job_name_exclude_regex`:

- Each can match anywhere in the name unless you anchor it with `^` and `$`. That is on purpose: a bundle deployed in development mode adds a `[dev <user>]` prefix, and an unanchored regex still matches.
- `job_name_regex` can match several jobs, in one workspace or in many. Each match gets its own findings rows. Excluded names get none.
- The system table scan matches with Spark's `regexp_like`; the Jobs API scan matches with Python's `re.search`. Simple patterns (letters, `^`, `$`, `|`, groups, character classes) behave the same in both. Avoid engine-specific syntax in either field.
- The example config uses `_test(_|$)` rather than a bare `test`, because a bare `test` would also match names such as `daily_revenue_report_latest` and `contest`.

## monitored_workspaces

One row per workspace label. Notebook 02 loads the rows from the optional `workspaces` section of your monitored-jobs file, and replaces them each time it runs.

| Column | Type | Meaning |
|---|---|---|
| `workspace_id` | STRING | The workspace ID, as digits. Empty when the entry matches by name. |
| `workspace_name` | STRING | The workspace name. Empty when the entry matches by ID. |
| `environment` | STRING, required | The label, for example `production` or `lower`. Letters, digits, `-` and `_` only. |
| `notes` | STRING | Free text. |
| `loaded_at` | TIMESTAMP, required | When notebook 02 loaded the row. |

How a workspace gets its label:

- An entry with a `workspace_id` matches that ID only.
- An entry with only a `workspace_name` matches the workspace with that name. Case does not matter.
- The ID is tried first. A workspace with no ID match falls back to its name.
- Name entries are matched ignoring case, so two entries whose names differ only in case are rejected as listed twice. Give each workspace one entry.

Every finding from a labelled workspace carries its environment (the `environment` column). Rows with no workspace have none.

## job_dependencies

One row per dependency. A failure lists the jobs that depend on the failed job directly.

| Column | Type | Meaning |
|---|---|---|
| `job_name` | STRING, required | The job that depends on something. Must be a job in `monitored_jobs`. |
| `depends_on` | STRING, required | What it needs: another monitored job, a child job, or a service. |
| `dependency_type` | STRING, required | `job`, `child_job` or `service`. Left out, it is `job`. For `job` and `child_job`, `depends_on` must be a monitored job. |
| `notes` | STRING | Free text. |
| `loaded_at` | TIMESTAMP, required | When notebook 02 loaded the row. |

The scans fill `affected_jobs` from `job` and `child_job` rows. `service` rows are used in two places: the custom check template (notebook 09) lists the jobs that depend on a service it found down. Built-in service probes come in Phase 2.

## findings

One row per check, for each job a monitored job matches, in each scan, from each source.

| Column | Type | Meaning |
|---|---|---|
| `observed_at` | TIMESTAMP, required | When the scan ran (UTC). |
| `scan_id` | STRING, required | One value per scan. See [Scan IDs](#scan-ids). |
| `account_id` | STRING | The Databricks account. Empty on `CUSTOM` rows. |
| `region` | STRING | The region from your config. Empty config gives NULL. |
| `workspace_id` | STRING | The workspace that runs the job. NULL on system table `not_found` rows, and on a Jobs API `not_found` row that covers several workspaces. |
| `workspace_name` | STRING | The workspace name, from `system.access.workspaces_latest` when it can be read. Otherwise NULL. |
| `job_id` | STRING | The job's ID in that workspace. NULL when no job matched. |
| `job_name` | STRING, required | The logical name from `monitored_jobs`. For a `CUSTOM` row, the service name. |
| `check_id` | STRING, required | Which check wrote the row. See [Checks](#checks). |
| `status` | STRING, required | `HEALTHY`, `WARNING`, `FAILED` or `UNKNOWN`. |
| `severity` | STRING | The job's configured severity on rows that are not HEALTHY. NULL on HEALTHY rows. A row whose `job_name` is not a configured job keeps the severity it sets, so a `CUSTOM` row has one only if its check sets it. |
| `failure_category` | STRING | Why the row is not healthy. A row that sets none gets one from the rules below. See [failure_category](#failure_category). |
| `run_id` | STRING | The job run the row is about, when there is one. HEALTHY rows that judged a run carry it too. |
| `run_page_url` | STRING | A link to that run. |
| `failed_task_keys` | ARRAY&lt;STRING&gt; | The tasks the row is about: failed tasks, or tasks in a retry loop. |
| `error_summary` | STRING | What the check found, on every row. For failures, the start of the error text. At most 1,000 characters. |
| `affected_jobs` | ARRAY&lt;STRING&gt; | On FAILED rows: the jobs that depend on this one (see [affected_jobs](#affected_jobs)). NULL on other rows. |
| `owner` | STRING | The job's owner from the config. A row whose `job_name` is not a configured job keeps the owner it sets. |
| `source` | STRING, required | `SYSTEM_TABLES`, `JOBS_API` or `CUSTOM` (your own checks). |
| `environment` | STRING | The environment label of the workspace, from `monitored_workspaces`. Empty when the workspace has no label, and on rows with no workspace. |
| `schedule_type` | STRING | `scheduled` or `continuous`, from the config. |
| `run_start_time` | TIMESTAMP | When the run the row is about started, in UTC. Empty on a system table row whose run may have begun before the lookback window. See [Run timing](#run-timing). |
| `run_end_time` | TIMESTAMP | When that run ended, in UTC. Empty while it is still going, and on rows that are not about a run. |
| `run_duration_seconds` | BIGINT | How long that run took, or has taken so far. Empty when the start is empty, and on a finished Jobs API run with no end time. Never negative. See [Run timing](#run-timing). |
| `trigger_type` | STRING | How the run started. See [trigger_type](#trigger_type). |
| `triggered_by` | STRING | Who started a one-time run. Jobs API only. |
| `job_tags` | MAP&lt;STRING,STRING&gt; | The job's tags, as set on the job. |
| `code_version` | STRING | The version deployed now: the tag named by `code_version_tag` on the job's current definition. On an untagged Jobs API row, it is the git commit of the run the row judged. See [Code version and job tags](#code-version-and-job-tags). |

### status

| Status | Meaning |
|---|---|
| `HEALTHY` | The check passed. Every check writes a HEALTHY row when it passes, so you can see what was checked. |
| `WARNING` | Something needs a look, but the job did not fail: a long run, a retry loop, a cancelled run, a missed schedule on a WARNING job. |
| `FAILED` | A run or task failed, or a CRITICAL job missed its schedule. |
| `UNKNOWN` | The Watchdog could not tell: no matching job, no finished run, an unreadable workspace or job. Treat it as a coverage gap. |

### severity

`severity` comes from the job's config. It says how much the job matters, while `status` says what happened. A HEALTHY row has no severity. A WARNING row about a CRITICAL job keeps `CRITICAL`.

### failure_category

The same rules apply to both sources (`jobs_watchdog/states.py` holds them, and `sql/scan/21_system_table_findings.sql` repeats them in SQL). They are applied in this order:

| Rule | failure_category |
|---|---|
| status is HEALTHY | `NONE` |
| status is UNKNOWN | `COVERAGE` |
| `long_runtime` or `live_long_runtime` | `SLA_EXCEEDED` |
| `schedule_gap` | `SCHEDULE_GAP` |
| `retry_loop` | `RETRY_LOOP` |
| termination type `INTERNAL_ERROR` or `CLOUD_FAILURE` | `INFRASTRUCTURE` |
| anything else (termination type `CLIENT_ERROR`, `SUCCESS` or empty) | `FUNCTIONAL` |

The termination type is the run's for run checks and the newest failed task's for task checks. `CLIENT_ERROR` usually means the code or its inputs. `INTERNAL_ERROR` and `CLOUD_FAILURE` point at the platform or the cloud provider.

### affected_jobs

On a FAILED row, `affected_jobs` lists the monitored jobs with a `job` or `child_job` dependency on the failed job, sorted by name. Only direct dependents are listed. A FAILED job that nothing depends on gets an empty list. On a `CUSTOM` row about a service, it lists the jobs that depend on that service. Every other row gets NULL.

### error_summary

Every row explains itself, including HEALTHY rows, for example "Newest finished run ended SUCCEEDED (SUCCESS), 35 minutes ago." On a failed task from the Jobs API it holds the task's error text, as `<task_key>: <error>`, with several tasks joined by ` | `. It is cut to 1,000 characters.

### run_page_url

Jobs API rows take the link the API returns. System table rows build it as `<workspace_url>/jobs/<job_id>/runs/<run_id>`, using the URL from `system.access.workspaces_latest`. When that table cannot be read, system table rows have no link.

### Run timing

`run_start_time`, `run_end_time` and `run_duration_seconds` describe the run the row is about. Each source measures it differently:

- **Jobs API rows** take the start and end from the run, so their start is always real. A finished run lasts from its start to its end. A run still going is timed from its start to the scan's own clock, so its duration grows from one scan to the next. A finished run with no end time gets no duration, and a duration is never negative.
- **System table rows** take the start from the run's first timeline row and the end from its last row. A run still going is timed up to its newest system table record, which can be up to about an hour behind the clock. Timeline rows are hourly slices, so when the first slice falls in the window's first hour, the run may have begun before the window. The start and the duration are then left empty, which also blanks a run that began within that first hour. `run_end_time` is unchanged.
- The `run_duration_seconds` column of `system.lakeflow.job_run_timeline` is not used. It is 0 for multi-task jobs.

### trigger_type

How the run started, with one vocabulary for both sources. The sources spell some values differently (system tables say `CRON` where the Jobs API says `PERIODIC`), so the Watchdog maps them:

| trigger_type | Raw values that map to it | Meaning |
|---|---|---|
| `SCHEDULE` | `PERIODIC`, `CRON` | a cron or periodic schedule |
| `ONE_TIME` | `ONE_TIME`, `ONETIME` | a run started by hand (Run now) or through the API |
| `RETRY` | `RETRY`, `ONETIME_RETRY` | a retry of a failed run or task |
| `CONTINUOUS` | `CONTINUOUS_RESTART`, `CONTINUOUS` | a continuous job's run, including a restart |
| `FILE_ARRIVAL` | `FILE_ARRIVAL` | a run started by a file arrival |
| `TABLE_UPDATE` | `TABLE` | a run started by a table update |
| `JOB_TASK` | `RUN_JOB_TASK` | a run started by a task of another job |

Any other raw value passes through unchanged. An empty value stays empty.

### triggered_by

Who started a one-time run. Only the Jobs API has it, and it is filled only when `trigger_type` is `ONE_TIME`. For other trigger types the run's creator did not start the run, so the column stays empty.

### Code version and job tags

`job_tags` holds the job's tags, as set on the job.

`code_version` is the version the job is deployed with now: the value of the tag named by `code_version_tag` (default `code_version`) on the job's current definition. A CI pipeline that tags a deploy with `code_version: <branch>@<commit>` therefore shows that value on every row of that job, including rows about older runs. Those rows still show the version deployed now, because the tag is read from the current definition.

An untagged job has no tag to read. Its Jobs API rows then show the git commit of the run each row judged, when that run came from a Git source. System table rows have no commit to fall back on, so their `code_version` stays empty unless the tag is set.

## Scan IDs

`scan_id` ties together the rows of one scan.

- When notebooks 05 and 06 run by hand with an empty `scan_id` widget, each makes its own from the UTC time, for example `20261028T120005Z`.
- To make one scan across both sources by hand, type the same value into both widgets.
- The bundle jobs (`watchdog_phase_1` and `watchdog_scan`) set `scan_id` to their run ID, so one run is one scan across both sources. Each scheduled run is a scan, so the schedule adds a new set of rows every 20 minutes by default.

## The merge key, and why re-runs add nothing

Both scans add rows through `sql/scan/30_merge_findings.sql`. It inserts a row only when no row with the same key is already in the table. The key has six columns:

`scan_id`, `workspace_id`, `job_id`, `job_name`, `check_id`, `source`

The comparison uses `<=>`, which treats two NULLs as equal, so `not_found` rows (no workspace or job ID) are matched too. Re-running a scan with the same `scan_id` therefore adds nothing, even when the underlying data has changed since the first run. A new `scan_id` adds a new set of rows. Nothing ever updates or deletes a row, so the table is the full history of every scan.

`job_id` is part of the key because one regex can match two jobs in the same workspace. Each gets its own rows. `sql/validate/41_duplicate_keys.sql` checks that no key appears twice.

## The findings_latest view

`findings_latest` is a view, not a table. For each source, it returns every row of that source's newest scan. A scan is judged by when it first wrote rows: the earliest `observed_at` among its rows. Re-running an old `scan_id` adds only rows whose keys are new, stamped with a later time, so it never becomes the newest scan. The view holds the current status of every check, so dashboards read it. Genie spaces built on the Watchdog should read it too.

`findings` keeps every scan. The table and the view answer different questions:

| | `findings` | `findings_latest` |
|---|---|---|
| Rows | every scan, every check, every source | the newest scan of each source |
| Use | history, trends, and alerts that fire on change | the current status |
| Changes | a new scan adds rows; nothing is updated or deleted | follows the newest scan of each source |

Each source has its own newest scan. If a run's Jobs API scan fails before it writes rows, the view keeps the Jobs API rows from the last scan that wrote them, while the system table rows come from the newest run. Check `observed_at` before you trust an old row.

Change-only alerts (Phase 3) compare each finding with the previous one for the same job and check, so they need the history in `findings`.

## Upgrades

Notebook 01 creates whatever is missing, and it is safe to run again. The scheduled job runs it at the start of every run, and you run it after every pull. It does three things:

1. Runs the `CREATE TABLE IF NOT EXISTS` files in `sql/setup`. Existing tables keep their rows.
2. Adds any column the current DDL declares but the table lacks, at the end of the table and as a nullable column. Rows stay. This release adds nine columns to `findings` and one (`job_name_exclude_regex`) to `monitored_jobs`, and creates `monitored_workspaces`.
3. Makes the view `findings_latest` current. It creates the view when it is missing, and replaces it only when the view's columns no longer match `findings`. A view that already matches is left alone, so its owner and grants stay. Notebook 01 prints `view findings_latest: created`, `replaced` or `current`.

Two limits follow from how the view is kept:

- A change to the view's SQL does not reach a view whose columns still match `findings`. The change in this release, which ranks each source's scans by when they first wrote, reaches only views that are created or replaced after it. To apply it to an existing view, its owner runs the view file with `{schema}` filled in, or the owner drops the view and notebook 01 creates it again.
- Replacing a view needs ownership. If another identity owns a view whose columns have changed, notebook 01 stops with an error.

Notebooks 02, 05, 06 and 09 check the tables and the view first. A missing table or column, or an out-of-date view, stops them with a message that says to run notebook 01. Each scheduled run runs notebook 01 before its config load and its scans, so a deploy that adds columns is picked up by the next run.

## Checks

Each check writes one row per scan for every job a monitored job matches, HEALTHY when it passes. The exceptions are in the "Written when" column. Rows about a run carry that run's ID, including HEALTHY rows, so you can see which run a check judged. They carry its link too, when the link can be built (see [run_page_url](#run_page_url)). `task_failures`, `schedule_gap` and `long_runtime` rows link the run they judged even when they are HEALTHY.

### From system tables (notebook 05, source `SYSTEM_TABLES`)

System tables cover every workspace in the account and region, and run about an hour behind.

| check_id | What it checks | Status | Written when |
|---|---|---|---|
| `last_run_result` | Scheduled jobs: the newest finished run in the lookback window. Continuous jobs: the newest run, so a stream that restarted and is running again is HEALTHY. | A continuous job's run still going is HEALTHY. SUCCEEDED is HEALTHY. FAILED, ERROR or TIMED_OUT is FAILED. CANCELLED, SKIPPED or BLOCKED is WARNING. No finished run is UNKNOWN. | always |
| `task_failures` | Tasks in the job's newest run whose newest attempt ended FAILED, ERROR or TIMED_OUT. A task retried to success is not counted, and a newer run settles failures in older runs. | FAILED, with `failed_task_keys` | always |
| `schedule_gap` | Minutes since the newest run started, against `max_gap_minutes` plus 60 minutes of allowance for system table lag. | FAILED for CRITICAL jobs, WARNING for WARNING jobs. UNKNOWN when no run is in the window and the limit is longer than the window. | scheduled jobs only |
| `long_runtime` | Runs still going, plus the newest finished run, against `max_runtime_minutes`, each measured up to its newest system table record. | WARNING | `max_runtime_minutes` is set |
| `not_found` | The regex matches no job in the region. | UNKNOWN, with no workspace or job ID | once per unmatched job |

Run lengths come from the timeline rows, as described in [Run timing](#run-timing). That keeps a finished run whose last hourly row is late from looking long.

### From the Jobs API (notebook 06, source `JOBS_API`)

The Jobs API is live. It shows a run that started a minute ago, and the error text of failed tasks.

| check_id | What it checks | Status | Written when |
|---|---|---|---|
| `live_run_status` | The newest run's life cycle and result state. | Running or succeeded is HEALTHY. FAILED, TIMEDOUT or INTERNAL_ERROR is FAILED. CANCELED is WARNING. A job with no runs is UNKNOWN. | always |
| `live_task_failures` | Failed tasks in the newest run, even while the run continues, judged on each task's newest attempt. | FAILED, with `failed_task_keys` and the error text | the job has runs |
| `live_long_runtime` | The newest run, if it is still going, against `max_runtime_minutes`. | WARNING | the job has runs and `max_runtime_minutes` is set |
| `retry_loop` | Each task's newest attempt number in the newest run, against `max_retries`. | WARNING, with the tasks in `failed_task_keys` | the job has runs and `max_retries` is set |
| `not_found` | No job this identity can see matches the regex in the workspaces that answered. | UNKNOWN | once per unmatched job, as described below |
| `api_unreachable` | A workspace or job could not be read. The scan carries on with the rest. | UNKNOWN, with the error in `error_summary` | on errors only |

The Jobs API scan writes `not_found` (UNKNOWN) for a monitored job that matches no job in the workspaces it checked. Only workspaces that answered count. With one workspace the row carries that workspace's ID. With several, a job found in any of them gets no `not_found` row, and a job that two or more answering workspaces did not find gets one row with no workspace, saying how many workspaces were checked. A workspace that could not be read does not count as checked: it gets `api_unreachable` rows instead. [jobs-api.md](jobs-api.md) has the field-by-field detail.

## Example rows

Illustrative values, one row per source. Both rows describe the same run.

| Column | System table row | Jobs API row |
|---|---|---|
| `observed_at` | 2026-10-28 12:00:41 | 2026-10-28 12:01:05 |
| `scan_id` | 20261028T120005Z | 20261028T120005Z |
| `account_id` | 00000000-0000-0000-0000-000000000000 | 00000000-0000-0000-0000-000000000000 |
| `region` | us-east-2 | us-east-2 |
| `workspace_id` | 1111111111111111 | 1111111111111111 |
| `workspace_name` | analytics | analytics |
| `job_id` | 123 | 123 |
| `job_name` | orders_ingest | orders_ingest |
| `check_id` | task_failures | live_task_failures |
| `status` | FAILED | FAILED |
| `severity` | CRITICAL | CRITICAL |
| `failure_category` | FUNCTIONAL | FUNCTIONAL |
| `run_id` | 456 | 456 |
| `run_page_url` | https://&lt;workspace-host&gt;/jobs/123/runs/456 | https://&lt;workspace-host&gt;/jobs/123/runs/456 |
| `failed_task_keys` | [load] | [load] |
| `error_summary` | 1 task(s) failed in the newest run, judged by the newest attempt of each task. Newest termination code: RUN_EXECUTION_ERROR. | load: ValueError: order_id must not be null |
| `affected_jobs` | [orders_enrich] | [orders_enrich] |
| `owner` | ingestion-team | ingestion-team |
| `source` | SYSTEM_TABLES | JOBS_API |
| `environment` | production | production |
| `schedule_type` | continuous | continuous |
| `run_start_time` | 2026-10-28 11:40:12 | 2026-10-28 11:40:12 |
| `run_end_time` | 2026-10-28 11:52:03 | 2026-10-28 11:52:03 |
| `run_duration_seconds` | 711 | 711 |
| `trigger_type` | CONTINUOUS | CONTINUOUS |
| `triggered_by` | (empty) | (empty) |
| `job_tags` | {"code_version": "main@3b1f0c2"} | {"code_version": "main@3b1f0c2"} |
| `code_version` | main@3b1f0c2 | main@3b1f0c2 |

The two rows describe the same failure from two sides. The Jobs API row is live and has the error text. The system table row has only the termination code, and it appears once the system tables catch up, about an hour after the run.

## Reading the table

The current status of every check for every job:

```sql
SELECT *
FROM <catalog>.<schema>.findings_latest
ORDER BY status, job_name, check_id
```

Everything that is not healthy in one scan:

```sql
SELECT job_name, workspace_name, check_id, status, severity, error_summary, affected_jobs, run_page_url
FROM <catalog>.<schema>.findings
WHERE scan_id = '<scan_id>' AND status <> 'HEALTHY'
ORDER BY severity, job_name
```

One job's history, scan by scan:

```sql
SELECT observed_at, scan_id, check_id, status, source, error_summary
FROM <catalog>.<schema>.findings
WHERE job_name = '<job_name>'
ORDER BY observed_at DESC, check_id
```

## Governance

`findings` and `findings_latest` hold error text copied from job runs. Error text can include file paths, table names, parameter values or pieces of data. `monitored_workspaces` holds workspace names and labels. Treat these like any other operational table:

- grant `SELECT` on them, or on the schema, only to the people and identities that need them;
- the identity that runs the scheduled job needs `CREATE TABLE` and `MODIFY` on the schema, because each scheduled run runs notebook 01; it owns the tables when it creates them;
- the table grows with every scan. The schedule runs a scan every 20 minutes by default, so plan retention now, for example by deleting rows older than 90 days.
