# Architecture

The Watchdog is a job that runs in one Unity Catalog workspace per cloud region. Each scan reads two sources, checks them against your list of monitored jobs, and writes the results into one table, `findings`. This page walks through the two diagrams and the timing details that shape the checks.

## Diagram 1: Unity Catalog, system tables and the Watchdog identity

![Unity Catalog, system tables and the Watchdog identity](images/watchdog-unity-catalog-system-tables.png)

**Account, region, metastore.** A Databricks account can have workspaces in several cloud regions. Each region has one Unity Catalog metastore, and the workspaces in that region attach to it.

**System tables.** Every metastore has a `system` catalog: read-only tables that Databricks fills for you. The four job tables in `system.lakeflow` are:

| Table | Holds |
|---|---|
| `jobs` | job definitions; a new row each time a job changes |
| `job_tasks` | the tasks of each job and how they depend on each other |
| `job_run_timeline` | job runs |
| `job_task_run_timeline` | task runs |

They cover every workspace in the same account and region, including workspaces not yet on Unity Catalog, as long as you query them from a Unity Catalog workspace in that region. So the Watchdog needs one Unity Catalog workspace per region, not every workspace migrated first. Records arrive within about an hour, and the tables keep 365 days of history. Phase 1 reads `jobs`, `job_run_timeline` and `job_task_run_timeline`.

**The Watchdog.** A job in one Unity Catalog workspace in the region. In each scan it:

1. queries the system tables once, for every workspace in the region;
2. calls the Jobs API of each workspace for live detail;
3. writes findings to one Unity Catalog table.

**The identity.** The Jobs API answers for one workspace at a time, and only for jobs the caller may view. There are two modes:

- `current_workspace`: the identity running the notebook or the job reads the Jobs API of its own workspace only.
- `service_principal`: one service principal, created once for the account and added to each workspace it monitors, reads every workspace's Jobs API with OAuth machine-to-machine credentials kept in a secret scope.

Either identity needs `CAN VIEW` on each monitored job, access to the system tables, and write access to the Watchdog schema. `CAN MANAGE RUN`, which allows starting and cancelling runs, is never needed in Phase 1. [phase-1-runbook.md](phase-1-runbook.md) lists the grants.

**Other regions.** Each region has its own metastore and its own system tables. Run one Watchdog per region, so each region's data stays in that region. A roll-up across regions can come later, if your security team approves.

## Diagram 2: inside the Watchdog

![Inside the Watchdog: three steps, one findings table, alerts and an app](images/watchdog-inside-steps-findings-alerts.png)

**Step 1: read the system tables.** One SQL query covers every workspace in the region. It takes the newest definition of each job from `system.lakeflow.jobs`, joins its runs from `job_run_timeline` and its task runs from `job_task_run_timeline`, and gets each run's result, termination code and timing. This is the best source for coverage, missed schedules and history. The query that writes findings is [`sql/scan/21_system_table_findings.sql`](../sql/scan/21_system_table_findings.sql); the read-only queries in `sql/explore` show the same data. See [queries.md](queries.md).

**Step 2: call the Jobs API.** For each monitored job in each workspace, the Watchdog makes three calls:

1. `list_runs(job_id, limit=2)`: the two newest runs;
2. `get_run(run_id)`: the newest run with every task, its state and its retry attempt;
3. `get_run_output(task_run_id)`: the error text of each failed task.

This is the best source for live checks: a task that failed inside a run that is still going, a run that has been going too long, and retry loops. The Jobs API spells states differently from system tables (SUCCESS versus SUCCEEDED, for example), so the Watchdog maps both onto the same four statuses. See [jobs-api.md](jobs-api.md).

**Step 3: check and write.** The checks compare both sources with your config: the jobs to watch, their limits, their owners and the dependency map. Each check writes one row to `findings` for each job it applies to, including HEALTHY rows, so you can see that a check ran and passed. The diagram's column list matches the real table, and its example rows are illustrative; [data-model.md](data-model.md) explains each column.

**Alerts and the app.** Phases 3 and 4 add Databricks SQL alerts and a Databricks App, both reading `findings`. See [roadmap.md](roadmap.md).

## Region scoping

- The `system.lakeflow` tables are regional: they hold the account's jobs in this metastore's region.
- `system.access.workspaces_latest` (Public Preview) is account-wide. The Watchdog reads it only for workspace names and URLs.
- In `service_principal` mode, the Jobs API scan visits the workspaces that have jobs in this region (from `sql/explore/10_workspaces_in_region.sql`) and have a URL in `workspaces_latest`. A workspace without a URL gets `api_unreachable` rows.
- The `region` setting is recorded on every finding. It does not filter anything.

## Why two sources

| | System tables | Jobs API |
|---|---|---|
| Coverage | every workspace in the account and region, in one query | one workspace per call |
| Freshness | about an hour behind | live |
| Detail | results, termination codes, timing, history | live states, retry attempts, the error text of failed tasks |
| Access | `SELECT` grants on the system schemas | `CAN VIEW` on each job, in each workspace |
| Best for | coverage, missed schedules, history and trends | failed or stuck tasks right now, long runs, retry loops |

Each source covers the other's blind spot. A job created ten minutes ago is missing from the system tables but present in the Jobs API. A workspace the service principal cannot reach still shows up in the system tables.

## How data flows

1. You keep a monitored-jobs YAML file outside the Git folder: the jobs to watch, a name pattern (`job_name_regex`) for each, limits, severity, owner and dependencies.
2. Notebook `02_load_config` checks the file and loads it into `monitored_jobs` and `job_dependencies` through two temp views and the files in `sql/config`. Both scans read these tables, so they always use the same config.
3. Notebook `05_scan_system_tables` runs `sql/scan/21_system_table_findings.sql`. The query reads the config tables, the system tables, and the temp view `watchdog_workspace_names` (workspace names and URLs). Its rows go into the temp view `watchdog_new_findings`, and `sql/scan/30_merge_findings.sql` adds them to `findings`.
4. Notebook `06_scan_jobs_api` reads the config tables, chooses the workspaces to visit, and calls the Jobs API through `jobs_watchdog/jobs_api.py`. `jobs_watchdog/findings.py` fills the columns that are the same for the whole scan (scan ID, time, region, account), plus severity, owner and affected jobs. The rows go through the same temp view and merge file.
5. Notebook `07_validate_phase_1` checks the result.

**Re-runs never duplicate rows.** The merge adds a row only when its key is new: `scan_id`, `workspace_id`, `job_id`, `job_name`, `check_id` and `source`. Running a scan again with the same `scan_id` adds nothing. The bundle job passes its run ID as `scan_id` to both scans, so one job run is one scan across both sources.

## Timing details

- **System tables run about an hour behind.** So:
  - a job created in the last hour is `not_found` from the system tables while the Jobs API scan already reports it;
  - `schedule_gap` allows 60 extra minutes before it reports a missed schedule;
  - very recent runs appear only in the Jobs API findings.
- **Long runs are split into hourly rows** in `job_run_timeline` and `job_task_run_timeline`, and only the last row of a run carries its result. The Watchdog folds the rows of each run together and takes the result from the newest row. An empty result means the run is still going.
- **Durations come from timestamps.** The `run_duration_seconds` column is 0 for multi-task jobs, so the Watchdog measures from a run's first row to its last row, or to now for a run still going. A run that began before the lookback window counts from the window's first row, so its time is a lower bound.
- **The lookback window** (`lookback_hours`, default 48) limits how far back the system table checks look. History is kept for 365 days. If no run started in the window and a job's `max_gap_minutes` plus 60 is longer than the window, `schedule_gap` reports UNKNOWN and asks for a longer window.
- **The Jobs API is live.** It shows a run the moment it starts.

## Statuses at a glance

- `status`: HEALTHY, WARNING, FAILED or UNKNOWN. UNKNOWN means the Watchdog could not tell: no matching job, no access, no finished run in the window, or a window too short to judge.
- `severity`: CRITICAL or WARNING from your config, on rows that are not HEALTHY.
- `failure_category`: FUNCTIONAL (the code or its inputs), INFRASTRUCTURE (the platform or cloud), SLA_EXCEEDED, SCHEDULE_GAP, RETRY_LOOP, COVERAGE, or NONE for healthy rows.
- `affected_jobs`: on FAILED rows, the jobs that depend directly on this one.

[data-model.md](data-model.md) has the full rules.
