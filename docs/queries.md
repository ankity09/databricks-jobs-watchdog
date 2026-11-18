# Queries

Every SQL file in `sql/` holds one statement and starts with a comment that says what it does. This page adds the parameters, the columns it returns, how to read the result, and any temp view it needs. The views in `sql/views` are the one exception: they hold a template, explained below.

The notebooks run these files with named parameters (`jobs_watchdog/sqlfiles.py`). Object names reach SQL only through `IDENTIFIER(:catalog || '.' || :schema || '.<table>')`, and the notebook checks that `catalog` and `schema` contain only letters, digits and underscores before anything runs. The only parameters are `catalog`, `schema`, `region`, `lookback_hours`, `scan_id`, `code_version_tag`, `pipeline_url_parameter` and `retention_days`.

## Running a file in the SQL editor

1. Open the file in your Git folder and copy its text into a new query in the SQL editor.
2. Pick a SQL warehouse. The editor shows a field for each `:parameter`.
3. Fill in the fields, for example `catalog` = `main`, `schema` = `watchdog`, `lookback_hours` = `48`. Numbers can be typed as text; the queries cast them.
4. Run it.

Seven files read a temp view that a notebook creates first (see the table below). Temp views live only in the session that created them, so those files run from their notebook, not on their own. To try `20_resolve_monitored_jobs.sql` in the SQL editor, put these two statements in one query and run them together. `21_system_table_findings.sql` also needs the temp view `watchdog_affected_jobs`, which Python builds from your dependencies, so run it from notebook 05, or first call `jobs_watchdog.dependencies.register_affected_jobs(spark, catalog, schema)` in a notebook. Fill in `code_version_tag` (`code_version` by default) with the other parameters:

```sql
CREATE OR REPLACE TEMPORARY VIEW watchdog_workspace_names AS
-- paste the text of sql/explore/11_workspace_names.sql here, without its final semicolon
;
-- then paste the text of sql/scan/20_resolve_monitored_jobs.sql here
```

| File | Needs the temp view | Created by |
|---|---|---|
| `sql/config/01_load_monitored_jobs.sql` | `watchdog_config_jobs` | notebook 02 |
| `sql/config/02_load_job_dependencies.sql` | `watchdog_config_dependencies` | notebook 02 |
| `sql/config/03_load_monitored_workspaces.sql` | `watchdog_config_workspaces` | notebook 02 |
| `sql/config/04_load_monitored_job_environments.sql` | `watchdog_config_environments` | notebook 02 |
| `sql/scan/20_resolve_monitored_jobs.sql` | `watchdog_workspace_names` | notebook 02 (from `11_workspace_names.sql`) |
| `sql/scan/21_system_table_findings.sql` | `watchdog_workspace_names` and `watchdog_affected_jobs` | notebook 05 (from `11_workspace_names.sql`, and `register_affected_jobs` in `jobs_watchdog/dependencies.py`) |
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
| `04_create_findings.sql` | `catalog`, `schema` | Creates `findings`, the table both scans write. It has 30 columns. |
| `05_create_monitored_workspaces.sql` | `catalog`, `schema` | Creates `monitored_workspaces`, the environment label for each workspace. |
| `06_create_monitored_job_environments.sql` | `catalog`, `schema` | Creates `monitored_job_environments`, the settings each job changes in one environment. |
| `07_create_config_loads.sql` | `catalog`, `schema` | Creates `config_loads`, one row each time notebook 02 loads the job list, with its source, version, job count and result. |

## sql/config

Run by notebook 02, after it reads your job list (the YAML file, or the newest version saved in the Watchdog app) into four temp views.

| File | Parameters | What it does |
|---|---|---|
| `01_load_monitored_jobs.sql` | `catalog`, `schema` | Replaces every row of `monitored_jobs` with the rows of `watchdog_config_jobs`, stamping `loaded_at`. |
| `02_load_job_dependencies.sql` | `catalog`, `schema` | Replaces every row of `job_dependencies` with the rows of `watchdog_config_dependencies`. |
| `03_load_monitored_workspaces.sql` | `catalog`, `schema` | Replaces every row of `monitored_workspaces` with the rows of `watchdog_config_workspaces`. |
| `04_load_monitored_job_environments.sql` | `catalog`, `schema` | Replaces every row of `monitored_job_environments` with the rows of `watchdog_config_environments` (one per job and environment label in the `environments` sections), stamping `loaded_at`. |
| `05_record_config_load.sql` | `catalog`, `schema` | Adds the row in the temp view `watchdog_config_load` to `config_loads`. Notebook 02 runs it for every load, failed loads too. |

01 to 04 use `INSERT OVERWRITE`, which keeps the table definition and column comments. 05 only adds a row.

## sql/views

Made current by notebook 01, after the tables are upgraded. Notebook 01 creates each view when it is missing, and replaces it only when its columns change or its definition version (the table property `watchdog.view_version`) differs from the file's. A view that is current is left alone, so its owner and grants stay.

| File | Parameters | What it does |
|---|---|---|
| `01_findings_latest.sql` | `catalog`, `schema`, through the template below | Creates `findings_latest`: every row of the newest scan from each source. |
| `02_incidents.sql` | `catalog`, `schema`, through the template below | Creates `incidents`: one row per problem with one check of one job, from the scan that found it until a HEALTHY row clears it. |

- **Read `findings_latest`:** the view shows the current status. It keeps no history: `findings` does. Dashboards read the view. See [The findings_latest view](data-model.md#the-findings_latest-view).
- **Read `incidents`:** `state` is `OPEN`, `RESOLVED` or `NOT_CHECKED`. The file's comments hold the rules, and [The incidents view](data-model.md#the-incidents-view) explains every column.

**Why views use a template.** A view cannot take parameter markers, so the file holds `{schema}` where the name goes. `jobs_watchdog/upgrade.py` replaces it with the checked, quoted catalog and schema (`` `catalog`.`schema` ``) before it runs, so the names pass the same check as every other statement. To run the file in the SQL editor, replace `{schema}` with `` `<catalog>`.`<schema>` `` first.

## sql/explore

Read-only. Notebook 03 (`notebooks/explore/03_explore_system_tables`) runs them all; notebook 00 also runs `10`. Each takes `:lookback_hours` except `11` and `12`.

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
- **Needs:** the temp view `watchdog_workspace_names`, which notebook 02 creates before it runs this query. Workspace labels by name need it.
- **Columns:** `job_name`, `configured_workspace_id`, `enabled`, `job_name_regex`, `job_name_exclude_regex`, `job_ids`, `workspace_id`, `environment`, `checked_here`, `matched_by`, `job_id`, `matched_job_name`, `same_name_jobs`, `run_as`.
- **Workspace scope:** `configured_workspace_id` is the optional restriction from the job entry; `workspace_id` is the actual match. Both ID and name matches must satisfy that restriction. An empty configured scope keeps regional matching. A top-level workspace label is not required for direct-ID scope.
- **Read it:** one row per monitored job and matching job. In each workspace a job matches by ID where `job_ids` apply (its environment's list, otherwise its own) and by name elsewhere; `matched_by` says which. Names matching `job_name_exclude_regex` are left out of name matches, as the scans leave them out. `same_name_jobs` counts the jobs in that workspace with exactly the matched name: above 1 on a name match, the system table scan writes a `duplicate_name` warning. `environment` is the label of the match's workspace, and `checked_here` says whether the job is switched on there: its `enabled`, unless its `environments` section sets `enabled` for that label. A match with `checked_here` false gets no findings. A monitored job with empty workspace and job columns matches nothing, and the system table scan will report it as `not_found`. Fix its regex, or wait an hour if the job is new.

### 21_system_table_findings.sql

The system table checks, shaped as findings rows. Notebook 05 runs it, saves the result as `watchdog_new_findings`, and merges it with `30_merge_findings.sql`.

- **Parameters:** `catalog`, `schema`, `region`, `lookback_hours`, `scan_id`, `code_version_tag`, `pipeline_url_parameter`.
- **Needs:** the temp views `watchdog_workspace_names`, and `watchdog_affected_jobs` (job_name, affected_jobs, parent_job: each job's whole downstream chain and its parent), which notebook 05 creates with `register_affected_jobs` from the `job_dependencies` table.
- **Columns:** the 30 `findings` columns, in table order, with `source` = `SYSTEM_TABLES`. `triggered_by` is always empty here, because only the Jobs API knows who started a run.
- **Read it:** one row per check for each workspace job a monitored job matches where the job is switched on (by job ID where `job_ids` apply, by name elsewhere), plus one `not_found` row for each job, switched on in at least one environment, that has no such match or misses a listed job ID:
  - `last_run_result`: for scheduled and triggered jobs, the newest finished run in the window; for continuous jobs, the newest run, even while it runs (a healthy stream never finishes, so its last finished run is usually an old restart);
  - `task_failures`: tasks whose newest attempt failed, in the job's newest run;
  - `schedule_gap` (scheduled and continuous jobs; triggered jobs have none): for a scheduled job, minutes since the newest run started; for a continuous job, minutes with no run in progress since the newest run ended (a run in progress is HEALTHY), against `max_gap_minutes` (30 for a continuous job that sets none) plus 60 for system table lag; UNKNOWN when no run is in the window and the limit is longer than the window; the summary says so when the job is paused;
  - `long_runtime` (when `max_runtime_minutes` is set): runs still going and the newest finished run, measured up to their newest system table record, against the limit;
  - `duplicate_name` (jobs matched by name): two or more jobs in one workspace with exactly the same name, one WARNING row per job and workspace naming their IDs;
  - `not_found`: no job in the region matches the regex, or every match is in an environment where the job is switched off, or some listed job IDs that apply in this region were not found where they apply. The summary says which.

  [data-model.md](data-model.md#checks) lists the status each check gives.

- **Exclusions:** a job whose name matches its `job_name_exclude_regex` is skipped when matching by name, so it writes no rows. Jobs pinned by ID are not excluded.
- **Impact:** FAILED rows take `affected_jobs` from `watchdog_affected_jobs`: every job downstream of the failed one, with `child_job` links counted both ways. Every row about a child job takes its parent from the same view, as `parent_job`.
- **Workspace scope:** a non-NULL `monitored_jobs.workspace_id` limits matches and expected-ID checks to that workspace. A matching job in another workspace cannot satisfy the entry. NULL keeps the prior regional behavior.
- **Job IDs:** `job_ids` from `monitored_jobs` and `monitored_job_environments`. Where IDs apply, only those jobs match. The listed IDs a job expects here are the ones that apply in at least one workspace of the region where the job is switched on; any of them not found where it applies is named in the job's `not_found` row.
- **Environments:** `environment` comes from `monitored_workspaces`. An entry with the workspace's ID is used first. Otherwise an entry with no ID whose name matches the workspace name, ignoring case, is used.
- **Overrides:** each match uses its environment's row in `monitored_job_environments`, when there is one: `enabled`, `max_gap_minutes`, `max_runtime_minutes`, `severity`, `owner` and `job_ids`. An empty column there keeps the job's own setting. A match in an environment where the job is switched off writes no rows. A workspace with no label uses the job's own settings.
- **Run timing and trigger:** `run_start_time`, `run_end_time` and `run_duration_seconds` describe the run each row is about, as explained in [Run timing](data-model.md#run-timing). When the first hourly slice of a run falls in the window's first hour, the run may have begun before the window, so `run_start_time` and `run_duration_seconds` are left empty. `trigger_type` uses the same mapping as the Jobs API scan, described in [trigger_type](data-model.md#trigger_type), and it maps `ONETIME_RETRY` to `RETRY`.
- **Code version:** `code_version` is the value of the job tag named by `:code_version_tag` on the job's current definition, so it shows the version deployed now. It is empty when the job has no such tag. System table rows have no git commit to fall back on.
- **Pipeline link:** `pipeline_url` comes from the run's `job_parameters` column, which holds `{name: {value, default}}`: the value of the parameter named by `:pipeline_url_parameter`, or its default.

### 30_merge_findings.sql

Adds the rows of `watchdog_new_findings` to `findings`, each at most once.

- **Parameters:** `catalog`, `schema`.
- **Needs:** the temp view `watchdog_new_findings`.
- **Returns:** the merge counts, including `num_inserted_rows`.
- **Read it:** a row whose key (`scan_id`, `workspace_id`, `job_id`, `job_name`, `check_id`, `source`) is already in the table is skipped. `<=>` treats two NULLs as equal, so `not_found` rows are matched too. Re-running a scan with the same `scan_id` inserts 0 rows.

### 31_scan_summary.sql

What a scan wrote, and how its problems moved. Notebooks 05 and 06 print their own source's row as two lines after they write.

- **Parameters:** `catalog`, `schema`, `scan_id`.
- **Columns:** `source`, `rows_written`, `new_problems`, `still_open`, `resolved`.
- **Read it:** one row per source that has rows in this scan. `rows_written` counts the rows the scan holds in `findings`, one per job and check; running the same scan again adds none. `new_problems` counts incidents that opened in this scan, `still_open` OPEN incidents that opened in an earlier scan, and `resolved` incidents that a HEALTHY row in this scan cleared.

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
- **Read it:** expect no rows. It checks every job switched on in at least one environment: `enabled: true`, or `enabled: true` for a label in its `environments` section. The system table scan always writes `last_run_result` or `not_found` for such a job, and the Jobs API scan always writes `live_run_status`, `not_found` or `api_unreachable`. A row here names a job and the source that wrote nothing about it.

### 43_open_incidents_match_latest.sql

- **Parameters:** `catalog`, `schema`.
- **Columns:** `problem`, `source`, `job_name`, `check_id`, `workspace_id`, `job_id`, `scan_id`.
- **Read it:** expect no rows. Every FAILED or WARNING row in `findings_latest` has an OPEN incident with the same key, and every OPEN incident's newest problem row is in its source's newest scan, unless that scan's row for it is neither HEALTHY nor a problem, such as UNKNOWN. A row here names the key and what disagrees. Run notebook 01 first if the view is out of date.

## sql/maintenance

Run by notebook 10, which the daily `watchdog_cleanup` job runs.

### 50_delete_old_findings.sql

Deletes old scans from `findings`, so it does not grow forever.

- **Parameters:** `catalog`, `schema`, `retention_days`.
- **Returns:** the merge counts, including `num_deleted_rows`.
- **Read it:** a scan is old when its first row is more than `retention_days` days old. Each source's newest scan is always kept, and scans are deleted whole. `retention_days` `0` deletes nothing. It is a `MERGE ... WHEN MATCHED THEN DELETE`, because the scans to keep are found with a nested query, which `DELETE` does not allow.
