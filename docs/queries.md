# Queries

Every SQL file in `sql/` holds one statement and starts with a comment that says what it does. This page adds the parameters, the columns it returns, how to read the result, and any temp view it needs. The views in `sql/views` are the one exception: they hold a template, explained below.

The notebooks run these files with named parameters (`jobs_watchdog/sqlfiles.py`). Object names reach SQL only through `IDENTIFIER(:catalog || '.' || :schema || '.<table>')`, and the notebook checks that `catalog` and `schema` contain only letters, digits and underscores before anything runs. The only parameters are `catalog`, `schema`, `region`, `lookback_hours`, `scan_id` and `code_version_tag`.

## Running a file in the SQL editor

1. Open the file in your Git folder and copy its text into a new query in the SQL editor.
2. Pick a SQL warehouse. The editor shows a field for each `:parameter`.
3. Fill in the fields, for example `catalog` = `main`, `schema` = `watchdog`, `lookback_hours` = `48`. Numbers can be typed as text; the queries cast them.
4. Run it.

Five files read a temp view that a notebook creates first (see the table below). Temp views live only in the session that created them, so those files run from their notebook, not on their own. To try `21_system_table_findings.sql` in the SQL editor, put these two statements in one query and run them together, and fill in `code_version_tag` (`code_version` by default) with the other parameters:

```sql
CREATE OR REPLACE TEMPORARY VIEW watchdog_workspace_names AS
-- paste the text of sql/explore/11_workspace_names.sql here, without its final semicolon
;
-- then paste the text of sql/scan/21_system_table_findings.sql here
```

| File | Needs the temp view | Created by |
|---|---|---|
| `sql/config/01_load_monitored_jobs.sql` | `watchdog_config_jobs` | notebook 02 |
| `sql/config/02_load_job_dependencies.sql` | `watchdog_config_dependencies` | notebook 02 |
| `sql/config/03_load_monitored_workspaces.sql` | `watchdog_config_workspaces` | notebook 02 |
| `sql/scan/21_system_table_findings.sql` | `watchdog_workspace_names` | notebooks 05 and 06 (from `11_workspace_names.sql`) |
| `sql/scan/30_merge_findings.sql` | `watchdog_new_findings` | notebook 05 (system table rows), notebook 06 (Jobs API rows) and notebook 09 (custom rows) |

## How the system tables fit together

- `system.lakeflow.jobs` holds job definitions. It adds a row each time a job changes, so the queries keep the newest row per `workspace_id, job_id`, and drop jobs whose newest row has a `delete_time`.
- `system.lakeflow.job_run_timeline` holds job runs. A run longer than an hour is split into one row per hour, and only the last row carries `result_state` and `termination_code`.
- `system.lakeflow.job_task_run_timeline` holds task runs, sliced the same way. `job_run_id` is the job run a task belongs to.
- All three cover every workspace in this account and cloud region, including workspaces not yet on Unity Catalog. You query them from a Unity Catalog workspace in that region.
- Records arrive about an hour after the fact.
- `system.access.workspaces_latest` (Public Preview) lists every workspace in the account with its name and URL.

## sql/setup

Run in order by notebook 01. Every statement is `IF NOT EXISTS`, so re-running changes nothing. Notebook 01 then adds any new columns to existing tables; see [Upgrades](data-model.md#upgrades). [data-model.md](data-model.md) describes every column.

| File | Parameters | What it does |
|---|---|---|
| `01_create_schema.sql` | `catalog`, `schema` | Creates the schema. Needs `USE CATALOG` and `CREATE SCHEMA` on the catalog. |
| `02_create_monitored_jobs.sql` | `catalog`, `schema` | Creates `monitored_jobs`, the jobs to check. |
| `03_create_job_dependencies.sql` | `catalog`, `schema` | Creates `job_dependencies`, what each job depends on. |
| `04_create_findings.sql` | `catalog`, `schema` | Creates `findings`, the table both scans write. It has 28 columns. |
| `05_create_monitored_workspaces.sql` | `catalog`, `schema` | Creates `monitored_workspaces`, the environment label for each workspace. |

## sql/config

Run by notebook 02, after it reads your monitored-jobs YAML file into three temp views.

| File | Parameters | What it does |
|---|---|---|
| `01_load_monitored_jobs.sql` | `catalog`, `schema` | Replaces every row of `monitored_jobs` with the rows of `watchdog_config_jobs`, stamping `loaded_at`. |
| `02_load_job_dependencies.sql` | `catalog`, `schema` | Replaces every row of `job_dependencies` with the rows of `watchdog_config_dependencies`. |
| `03_load_monitored_workspaces.sql` | `catalog`, `schema` | Replaces every row of `monitored_workspaces` with the rows of `watchdog_config_workspaces`. |

All three use `INSERT OVERWRITE`, which keeps the table definition and column comments.

## sql/views

Made current by notebook 01, after the tables are upgraded. Notebook 01 creates the view when it is missing, and replaces it only when its columns no longer match `findings`. A view that already matches is left alone, so its owner and grants stay.

| File | Parameters | What it does |
|---|---|---|
| `01_findings_latest.sql` | `catalog`, `schema`, through the template below | Creates `findings_latest`: every row of the newest scan from each source. |

- **Read it:** the view shows the current status. It keeps no history: `findings` does. Dashboards read the view. See [The findings_latest view](data-model.md#the-findings_latest-view).

**Why views use a template.** A view cannot take parameter markers, so the file holds `{schema}` where the name goes. `jobs_watchdog/upgrade.py` replaces it with the checked, quoted catalog and schema (`` `catalog`.`schema` ``) before it runs, so the names pass the same check as every other statement. To run the file in the SQL editor, replace `{schema}` with `` `<catalog>`.`<schema>` `` first.

## sql/explore

Read-only. Notebook 03 runs them all; notebook 00 also runs `10`. Each takes `:lookback_hours` except `11` and `12`.

### 10_workspaces_in_region.sql

Which workspaces the system tables for this region cover.

- **Columns:** `workspace_id`, `account_id`, `jobs` (jobs in their newest, not deleted, definition), `runs_in_window` (runs that started in the window).
- **Read it:** every workspace you expect should be here. A missing one is in another region, or has no jobs. The Jobs API scan in service principal mode visits exactly these workspaces. Notebooks 00 (section 3) and 03 (section 10) show each workspace's name next to its ID.

### 11_workspace_names.sql

Workspace names and URLs for the whole account, from `system.access.workspaces_latest`.

- **Columns:** `workspace_id`, `workspace_name`, `workspace_url` (with `https://` and no trailing slash), `status` (for example `RUNNING`).
- **Read it:** the scans use it for `workspace_name` and run links, and service principal mode uses it to find each workspace's URL. If you cannot read the table, findings still work without names and links, but service principal mode cannot reach other workspaces.

### 12_job_inventory.sql

Every job in the region, as of its newest definition.

- **Columns:** `workspace_id`, `job_id`, `name`, `trigger_type`, `paused`, `run_as`, `run_as_user_name`, `creator_user_name`, `change_time`.
- **Read it:** use the names to write each monitored job's `job_name_regex`. `run_as` is the identity the job runs as. `trigger_type`, `paused` and the `*_user_name` columns were added in December 2025, so they are empty for jobs nobody has changed since then.

### 13_runs_in_window.sql

Every run that started in the window, one row per run.

- **Columns:** `workspace_id`, `job_id`, `run_id`, `run_start`, `last_seen`, `minutes`, `result_state`, `termination_code`, `termination_type`, `trigger_type`.
- **Read it:** the hourly rows are folded together. `run_start` is the first row's start, `last_seen` the newest row's end, `minutes` the time between them. An empty `result_state` means the run is still going, or its last hour has not landed yet. A run that began before the window counts from the window's first row, so its `minutes` is a lower bound. The table's `run_duration_seconds` column is 0 for multi-task jobs, so it is not used.

### 14_failed_runs.sql

Runs that ended FAILED, ERROR or TIMED_OUT in the window.

- **Columns:** `workspace_id`, `job_id`, `job_name`, `run_id`, `ended_at`, `result_state`, `termination_code`, `termination_type`.
- **Read it:** `termination_type` `CLIENT_ERROR` usually means the code or its inputs (functional); `INTERNAL_ERROR` or `CLOUD_FAILURE` point at the platform or the cloud (infrastructure). Names come from each job's newest definition, so a job deleted since it failed still shows its name. A run that was repaired can appear once per attempt.

### 15_task_failures.sql

Task runs that ended FAILED, ERROR or TIMED_OUT in the window.

- **Columns:** `workspace_id`, `job_id`, `job_run_id`, `task_run_id`, `task_key`, `ended_at`, `result_state`, `termination_code`, `termination_type`.
- **Read it:** a task can fail inside a run that keeps going, for example in a continuous job, so this catches failures the run level misses. This lists every failure in the window; the scan's `task_failures` check only counts tasks whose newest attempt failed, in the job's newest run.

### 16_long_runs.sql

The 50 longest runs in the window, finished or still going.

- **Columns:** `workspace_id`, `job_id`, `run_id`, `run_start`, `last_seen`, `result_state`, `still_running`, `minutes`.
- **Read it:** every run counts from its first row's start to its newest row's end (`last_seen`). For a run still going, that is a lower bound: the newest hour has not landed yet. Measuring to now instead would make a finished run whose last row is late look long. Compare with your `max_runtime_minutes` values.

### 17_last_run_per_job.sql

The newest finished run of every job.

- **Columns:** `workspace_id`, `job_id`, `job_name`, `run_id`, `ended_at`, `result_state`, `termination_code`.
- **Read it:** is every job's latest result good? A job with no finished run in the window shows empty run columns.

## sql/scan

### 20_resolve_monitored_jobs.sql

Which real jobs each monitored job matches. Notebook 02 shows it after loading the config.

- **Parameters:** `catalog`, `schema`.
- **Columns:** `job_name`, `enabled`, `job_name_regex`, `job_name_exclude_regex`, `workspace_id`, `job_id`, `matched_job_name`, `run_as`.
- **Read it:** one row per monitored job and matching job. Names matching `job_name_exclude_regex` are left out, as the scans leave them out. A monitored job with empty workspace and job columns matches nothing, and the system table scan will report it as `not_found`. Fix its regex, or wait an hour if the job is new.

### 21_system_table_findings.sql

The system table checks, shaped as findings rows. Notebook 05 runs it, saves the result as `watchdog_new_findings`, and merges it with `30_merge_findings.sql`.

- **Parameters:** `catalog`, `schema`, `region`, `lookback_hours`, `scan_id`, `code_version_tag`.
- **Needs:** the temp view `watchdog_workspace_names`.
- **Columns:** the 28 `findings` columns, in table order, with `source` = `SYSTEM_TABLES`. `triggered_by` is always empty here, because only the Jobs API knows who started a run.
- **Read it:** one row per check for each workspace job a monitored job matches, plus one `not_found` row for each enabled job that matches nothing:
  - `last_run_result`: for scheduled jobs, the newest finished run in the window; for continuous jobs, the newest run, even while it runs (a healthy stream never finishes, so its last finished run is usually an old restart);
  - `task_failures`: tasks whose newest attempt failed, in the job's newest run;
  - `schedule_gap` (scheduled jobs): minutes since the newest run started, against `max_gap_minutes` plus 60 for system table lag; UNKNOWN when no run is in the window and the limit is longer than the window; the summary says so when the job is paused;
  - `long_runtime` (when `max_runtime_minutes` is set): runs still going and the newest finished run, measured up to their newest system table record, against the limit;
  - `not_found`: no job in the region matches the regex.

  [data-model.md](data-model.md#checks) lists the status each check gives.

- **Exclusions:** a job whose name matches its `job_name_exclude_regex` is skipped, so it writes no rows.
- **Environments:** `environment` comes from `monitored_workspaces`. An entry with the workspace's ID is used first. Otherwise an entry with no ID whose name matches the workspace name, ignoring case, is used.
- **Run timing and trigger:** `run_start_time`, `run_end_time` and `run_duration_seconds` describe the run each row is about, as explained in [Run timing](data-model.md#run-timing). When the first hourly slice of a run falls in the window's first hour, the run may have begun before the window, so `run_start_time` and `run_duration_seconds` are left empty. `trigger_type` uses the same mapping as the Jobs API scan, described in [trigger_type](data-model.md#trigger_type), and it maps `ONETIME_RETRY` to `RETRY`.
- **Code version:** `code_version` is the value of the job tag named by `:code_version_tag` on the job's current definition, so it shows the version deployed now. It is empty when the job has no such tag. System table rows have no git commit to fall back on.

### 30_merge_findings.sql

Adds the rows of `watchdog_new_findings` to `findings`, each at most once.

- **Parameters:** `catalog`, `schema`.
- **Needs:** the temp view `watchdog_new_findings`.
- **Returns:** the merge counts, including `num_inserted_rows`.
- **Read it:** a row whose key (`scan_id`, `workspace_id`, `job_id`, `job_name`, `check_id`, `source`) is already in the table is skipped. `<=>` treats two NULLs as equal, so `not_found` rows are matched too. Re-running a scan with the same `scan_id` inserts 0 rows.

## sql/validate

Run by notebook 07. `:scan_id` works the same way in `40` and `42`: set it to check one scan, or leave it empty to check each source's newest scan. Empty is what you want after running notebooks 05 and 06 by hand, because each makes its own `scan_id`.

### 40_findings_by_source.sql

- **Parameters:** `catalog`, `schema`, `scan_id`.
- **Columns:** `source`, `scan_id`, `status`, `findings` (row count).
- **Read it:** expect rows for both `SYSTEM_TABLES` and `JOBS_API`. A missing source means its scan did not run, or ran with another `scan_id`.

### 41_duplicate_keys.sql

- **Parameters:** `catalog`, `schema`.
- **Columns:** `scan_id`, `workspace_id`, `job_id`, `job_name`, `check_id`, `source`, `copies`.
- **Read it:** expect no rows, across every scan. A row here means a key was inserted twice, which the merge is designed to prevent.

### 42_enabled_jobs_without_findings.sql

- **Parameters:** `catalog`, `schema`, `scan_id`.
- **Columns:** `job_name`, `source`.
- **Read it:** expect no rows. The system table scan always writes `last_run_result` or `not_found` for an enabled job, and the Jobs API scan always writes `live_run_status`, `not_found` or `api_unreachable`. A row here names a job and the source that wrote nothing about it.
