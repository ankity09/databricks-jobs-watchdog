# Data model

The Watchdog keeps three Delta tables in one schema, `<catalog>.<schema>` (the schema defaults to
`watchdog`). Notebook 01 creates them from the files in `sql/setup`. Every column has a comment, so
`DESCRIBE TABLE <catalog>.<schema>.findings` shows the same descriptions as this page.

| Table | What it holds | How it changes |
|---|---|---|
| `monitored_jobs` | the jobs to check, with their limits | replaced each time notebook 02 loads your YAML file |
| `job_dependencies` | what each job depends on | replaced each time notebook 02 loads your YAML file |
| `findings` | what every scan found, from both sources | rows are added, never updated or deleted |

The two scans read the config tables, not the YAML file. Edit the file, then run notebook 02 again
before the next scan.

## monitored_jobs

One row per job you want checked.

| Column | Type | Meaning |
|---|---|---|
| `job_name` | STRING, required | Short logical name. It appears on every finding and alert. Unique in the file. |
| `job_name_regex` | STRING, required | Matches the job's real name in each workspace. Defaults to `^<job_name>$`. |
| `schedule_type` | STRING, required | `scheduled` or `continuous`. Only scheduled jobs get the `schedule_gap` check. |
| `max_gap_minutes` | INT | Scheduled jobs: the longest allowed time between run starts. Required for scheduled jobs. |
| `max_runtime_minutes` | INT | The longest allowed run. Empty turns off `long_runtime` and `live_long_runtime`. |
| `max_retries` | INT | A task retried more times than this is a retry loop. Empty turns off `retry_loop`. Set it below the job's own task retry limit: a job never retries past its own limit, so an equal value never fires. |
| `severity` | STRING, required | `CRITICAL` or `WARNING`. Copied to every finding about this job that is not HEALTHY. |
| `owner` | STRING | Team or person to route findings to. Copied to every finding. |
| `enabled` | BOOLEAN, required | `false` keeps the entry in the table without checking it. |
| `notes` | STRING | Free text. |
| `loaded_at` | TIMESTAMP, required | When notebook 02 loaded the row. |

About `job_name_regex`:

- It can match anywhere in the name unless you anchor it with `^` and `$`. That is on purpose: a
  bundle deployed in development mode adds a `[dev <user>]` prefix, and an unanchored regex still
  matches.
- It can match several jobs, in one workspace or in many. Each match gets its own findings rows.
- The system table scan matches with Spark's `regexp_like`; the Jobs API scan matches with Python's
  `re.search`. Simple patterns (letters, `^`, `$`, `|`, groups, character classes) behave the same
  in both. Avoid engine-specific syntax.

## job_dependencies

One row per dependency. A failure lists the jobs that depend on the failed job directly.

| Column | Type | Meaning |
|---|---|---|
| `job_name` | STRING, required | The job that depends on something. Must be a job in `monitored_jobs`. |
| `depends_on` | STRING, required | What it needs: another monitored job, a child job, or a service. |
| `dependency_type` | STRING, required | `job`, `child_job` or `service`. For `job` and `child_job`, `depends_on` must be a monitored job. |
| `notes` | STRING | Free text. |
| `loaded_at` | TIMESTAMP, required | When notebook 02 loaded the row. |

Phase 1 uses `job` and `child_job` rows to fill `affected_jobs`. `service` rows are stored for
Phase 2, which adds service probes.

## findings

One row per check, for each job a monitored job matches, in each scan, from each source.

| Column | Type | Meaning |
|---|---|---|
| `observed_at` | TIMESTAMP, required | When the scan ran (UTC). |
| `scan_id` | STRING, required | One value per scan. See [Scan IDs](#scan-ids). |
| `account_id` | STRING | The Databricks account, from `system.lakeflow.jobs`. |
| `region` | STRING | The region from your config. Empty config gives NULL. |
| `workspace_id` | STRING | The workspace that runs the job. NULL on a `not_found` row that covers several workspaces. |
| `workspace_name` | STRING | From `system.access.workspaces_latest` when it can be read, otherwise NULL. |
| `job_id` | STRING | The job's ID in that workspace. NULL when no job matched. |
| `job_name` | STRING, required | The logical name from `monitored_jobs`. |
| `check_id` | STRING, required | Which check wrote the row. See [Checks](#checks). |
| `status` | STRING, required | `HEALTHY`, `WARNING`, `FAILED` or `UNKNOWN`. |
| `severity` | STRING | The job's configured severity on rows that are not HEALTHY. NULL on HEALTHY rows. |
| `failure_category` | STRING | Why the row is not healthy. See [failure_category](#failure_category). |
| `run_id` | STRING | The job run the row is about, when there is one. |
| `run_page_url` | STRING | A link to that run. |
| `failed_task_keys` | ARRAY&lt;STRING&gt; | The tasks the row is about: failed tasks, or tasks in a retry loop. |
| `error_summary` | STRING | What the check found, on every row. For failures, the start of the error text. At most 1,000 characters. |
| `affected_jobs` | ARRAY&lt;STRING&gt; | On FAILED rows: the jobs that depend on this one directly. NULL on other rows. |
| `owner` | STRING | The job's owner from the config. |
| `source` | STRING, required | `SYSTEM_TABLES` or `JOBS_API`. |

### status

| Status | Meaning |
|---|---|
| `HEALTHY` | The check passed. Every check writes a HEALTHY row when it passes, so you can see what was checked. |
| `WARNING` | Something needs a look, but the job did not fail: a long run, a retry loop, a cancelled run, a missed schedule on a WARNING job. |
| `FAILED` | A run or task failed, or a CRITICAL job missed its schedule. |
| `UNKNOWN` | The Watchdog could not tell: no matching job, no finished run, an unreadable workspace or job. Treat it as a coverage gap. |

### severity

`severity` comes from the job's config. It says how much the job matters, while `status` says what
happened. A HEALTHY row has no severity. A WARNING row about a CRITICAL job keeps `CRITICAL`.

### failure_category

The same rules apply to both sources (`jobs_watchdog/states.py` holds them, and
`sql/scan/21_system_table_findings.sql` repeats them in SQL). They are applied in this order:

| Rule | failure_category |
|---|---|
| status is HEALTHY | `NONE` |
| status is UNKNOWN | `COVERAGE` |
| `long_runtime` or `live_long_runtime` | `SLA_EXCEEDED` |
| `schedule_gap` | `SCHEDULE_GAP` |
| `retry_loop` | `RETRY_LOOP` |
| termination type `INTERNAL_ERROR` or `CLOUD_FAILURE` | `INFRASTRUCTURE` |
| anything else (termination type `CLIENT_ERROR`, `SUCCESS` or empty) | `FUNCTIONAL` |

The termination type is the run's for run checks and the newest failed task's for task checks.
`CLIENT_ERROR` usually means the code or its inputs. `INTERNAL_ERROR` and `CLOUD_FAILURE` point at
the platform or the cloud provider.

### affected_jobs

On a FAILED row, `affected_jobs` lists the monitored jobs with a `job` or `child_job` dependency on
the failed job, sorted by name. Only direct dependents are listed. A FAILED job that nothing depends
on gets an empty list. Every other row gets NULL.

### error_summary

Every row explains itself, including HEALTHY rows, for example "Newest finished run ended SUCCEEDED
(SUCCESS), 35 minutes ago." On a failed task from the Jobs API it holds the task's error text, as
`<task_key>: <error>`, with several tasks joined by ` | `. It is cut to 1,000 characters.

### run_page_url

Jobs API rows take the link the API returns. System table rows build it as
`<workspace_url>/jobs/<job_id>/runs/<run_id>`, using the URL from `system.access.workspaces_latest`.
When that table cannot be read, system table rows have no link.

### Scan IDs

`scan_id` ties together the rows of one scan.

- When notebooks 05 and 06 run by hand with an empty `scan_id` widget, each makes its own from the
  UTC time, for example `20261028T120005Z`.
- To make one scan across both sources by hand, type the same value into both widgets.
- The bundle job sets `scan_id` to its run ID, so one run of the job is one scan across both sources.

## The merge key, and why re-runs add nothing

Both scans add rows through `sql/scan/30_merge_findings.sql`. It inserts a row only when no row with
the same key is already in the table. The key has six columns:

`scan_id`, `workspace_id`, `job_id`, `job_name`, `check_id`, `source`

The comparison uses `<=>`, which treats two NULLs as equal, so `not_found` rows (no workspace or job
ID) are matched too. Re-running a scan with the same `scan_id` therefore adds nothing, even when the
underlying data has changed since the first run. A new `scan_id` adds a new set of rows. Nothing ever
updates or deletes a row, so the table is the full history of every scan.

`job_id` is part of the key because one regex can match two jobs in the same workspace. Each gets its
own rows. `sql/validate/41_duplicate_keys.sql` checks that no key appears twice.

## Checks

Each check writes one row per scan for every job a monitored job matches, HEALTHY when it passes. The
exceptions are in the "Written when" column.

### From system tables (notebook 05, source `SYSTEM_TABLES`)

System tables cover every workspace in the account and region, and run about an hour behind.

| check_id | What it checks | Status | Written when |
|---|---|---|---|
| `last_run_result` | Scheduled jobs: the newest finished run in the lookback window. Continuous jobs: the newest run, so a stream that restarted and is running again is HEALTHY. | A continuous job's run still going is HEALTHY. SUCCEEDED is HEALTHY. FAILED, ERROR or TIMED_OUT is FAILED. CANCELLED, SKIPPED or BLOCKED is WARNING. No finished run is UNKNOWN. | always |
| `task_failures` | Tasks in the job's newest run whose newest attempt ended FAILED, ERROR or TIMED_OUT. A task retried to success is not counted, and a newer run settles failures in older runs. | FAILED, with `failed_task_keys` | always |
| `schedule_gap` | Minutes since the newest run started, against `max_gap_minutes` plus 60 minutes of allowance for system table lag. | FAILED for CRITICAL jobs, WARNING for WARNING jobs. UNKNOWN when no run is in the window and the limit is longer than the window. | scheduled jobs only |
| `long_runtime` | Runs still going, plus the newest finished run, against `max_runtime_minutes`, each measured up to its newest system table record. | WARNING | `max_runtime_minutes` is set |
| `not_found` | The regex matches no job in the region. | UNKNOWN, with no workspace or job ID | once per unmatched job |

Run lengths come from the timeline rows (first row's start to last row's end), not from the
`run_duration_seconds` column, which is 0 for multi-task jobs. A run that started before the lookback
window counts from the window's first row, and a run still going counts up to its newest row, so both
lengths are lower bounds. That keeps a finished run whose last hourly row is late from looking long.

### From the Jobs API (notebook 06, source `JOBS_API`)

The Jobs API is live. It shows a run that started a minute ago, and the error text of failed tasks.

| check_id | What it checks | Status | Written when |
|---|---|---|---|
| `live_run_status` | The newest run's life cycle and result state. | Running or succeeded is HEALTHY. FAILED, TIMEDOUT or INTERNAL_ERROR is FAILED. CANCELED is WARNING. A job with no runs is UNKNOWN. | always |
| `live_task_failures` | Failed tasks in the newest run, even while the run continues, judged on each task's newest attempt. | FAILED, with `failed_task_keys` and the error text | the job has runs |
| `live_long_runtime` | The newest run, if it is still going, against `max_runtime_minutes`. | WARNING | the job has runs and `max_runtime_minutes` is set |
| `retry_loop` | Each task's attempt number in the newest run, against `max_retries`. | WARNING, with the tasks in `failed_task_keys` | the job has runs and `max_retries` is set |
| `api_unreachable` | A workspace or job could not be read. The scan carries on with the rest. | UNKNOWN, with the error in `error_summary` | on errors only |

The Jobs API scan also writes `not_found` (UNKNOWN) for a monitored job that matches no job in the
workspaces it checked. With one workspace the row carries that workspace's ID. With several, a job
found in any of them gets no `not_found` row, and a job found in none gets one row with no workspace.
[jobs-api.md](jobs-api.md) has the field-by-field detail.

## Example rows

Illustrative values, one row per source.

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
| `run_id` | 456 | 789 |
| `run_page_url` | https://&lt;workspace-host&gt;/jobs/123/runs/456 | https://&lt;workspace-host&gt;/jobs/123/runs/789 |
| `failed_task_keys` | [load] | [load] |
| `error_summary` | 1 task(s) failed in the newest run, judged by the newest attempt of each task. Newest termination code: RUN_EXECUTION_ERROR. | load: ValueError: order_id must not be null |
| `affected_jobs` | [daily_revenue_report, orders_enrich] | [daily_revenue_report, orders_enrich] |
| `owner` | ingestion-team | ingestion-team |
| `source` | SYSTEM_TABLES | JOBS_API |

The two rows describe the same failure from two sides. The system table row arrives about an hour
later and has only the termination code. The Jobs API row is live and has the error text.

## Reading the table

The latest result of every check for every job:

```sql
SELECT *
FROM <catalog>.<schema>.findings
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY job_name, workspace_id, job_id, check_id, source
  ORDER BY observed_at DESC) = 1
ORDER BY status, job_name, check_id
```

Everything that is not healthy in one scan:

```sql
SELECT job_name, workspace_name, check_id, status, severity, error_summary, affected_jobs, run_page_url
FROM <catalog>.<schema>.findings
WHERE scan_id = '<scan_id>' AND status <> 'HEALTHY'
ORDER BY severity, job_name
```

## Governance

`findings` holds error text copied from job runs. Error text can include file paths, table names,
parameter values or pieces of data. Treat the table like any other operational table:

- grant `SELECT` on it, or on the schema, only to the people and identities that need it;
- the identity that runs the scans needs to write to the schema; it owns the tables when it creates
  them in notebook 01;
- the table grows with every scan, so plan retention (for example, delete rows older than 90 days)
  when you schedule the scans in Phase 2.
