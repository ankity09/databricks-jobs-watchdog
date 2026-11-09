# Changelog

What changed, for people who already run the Watchdog. After every pull: restart Python on any open notebook, then run notebook 01 once. It creates any new table or view, adds any new columns to your existing tables (your rows stay) and brings the views up to date. If you deployed the jobs with the bundle, deploy it again right after the pull, so the jobs run the new code; each scheduled run of `watchdog_scan` then runs notebook 01 too.

## Phase 1.4 (2026-11-09)

### One row per problem: the `incidents` view

Every scan writes a row for every check into `findings`, HEALTHY or not. That is the history, and nothing in it is overwritten. A problem that lasts is therefore in every scan: a job that fails for three scans has three FAILED rows. Running the same scan again (the same `scan_id`) adds nothing; each new scan adds its own rows.

New in this release is the view **`incidents`**. It lists each problem once, from the scan that found it until it clears:

- A problem is a FAILED or WARNING row. An incident is one check of one job from one source (`source`, `workspace_id`, `job_id`, `job_name`, `check_id`) for as long as no HEALTHY row comes for it. FAILED and WARNING rows with no HEALTHY row between them are one incident.
- `state` says where it is:
  - `OPEN`: no HEALTHY row came after it, and the source's newest scan has a row for it;
  - `RESOLVED`: a HEALTHY row came after it. `resolved_at` and `resolved_scan_id` name that scan;
  - `NOT_CHECKED`: no HEALTHY row came after it, but the newest scan has no row for it: the job was removed from the list, switched off or not reached, or the check writes rows only while it finds a problem. If it comes back as a problem, it is the same incident again, `OPEN`. A fixed `duplicate_name` warning shows as `NOT_CHECKED`, not `RESOLVED`, because that check writes no HEALTHY row.
- An UNKNOWN row neither opens nor ends an incident: a check that cannot tell is not news. Any other status a custom check writes counts the same way.
- `opened_at` says when it started, `scans_seen` how many scans found it, `worst_status` the worst it got, `current_status` the newest status, and `is_new` whether it opened in the newest scan.
- `watchdog_cleanup` deletes old scans, so an incident older than `scan.retention_days` starts at the oldest row kept: read its `opened_at` as "open since at least".

The view reads `findings` each time, so it covers the rows you already have. [docs/data-model.md](docs/data-model.md#the-incidents-view) lists every column, and the runbook's [Read the incidents](docs/phase-1-runbook.md#read-the-incidents) has example queries. Later phases will alert when an incident opens and when it is resolved.

### Plainer scan output

Notebook 06 printed `Offered 2 rows to findings (rows already there for this scan_id are skipped)`, which was easy to read as "a problem that happens again is not written again". Notebooks 05 and 06 now both print two lines, each for its own source:

```
Scan 20261109T040000Z has 12 rows, one per check. Running the same scan again adds nothing.
Problems: 2 new, 3 still open, 1 resolved. The incidents view lists each problem once until it clears.
```

A scan with no rows prints only the first line. Notebook 09, your own checks, still prints the old line for now: `Offered N rows` is the number of rows it wrote for this scan, and running the same scan again adds nothing. Its incidents show up in the view all the same.

### Changed behavior

- Notebook 05 prints these two lines instead of the merge counts table.
- Notebook 07 has a sixth check, `open incidents match the newest scans`: every FAILED or WARNING row in `findings_latest` has an OPEN incident, and every OPEN incident was found in its source's newest scan (or that scan's row for it is neither HEALTHY nor a problem, such as UNKNOWN). Its first check now includes the `incidents` view.
- Notebooks 02, 05, 06, 09 and 10 stop until notebook 01 has created the view, with `incidents is missing or out of date: run notebook 01 once.`
- `teardown.sh --drop-schema` accepts the new view as a Watchdog object.
- Notebook 01 never replaces a table or view of yours named `findings_latest` or `incidents`. If an object with one of those names is not a view with the `watchdog.view_version` property, it stops and names it.

### How to upgrade from Phase 1.2 or 1.3

1. In the Git folder, click Pull. If Pull reports a conflict in a notebook you have only run, keep the incoming version: Databricks saves the serverless environment into a notebook when it runs it. If you edited a notebook yourself, such as notebook 09 for your own checks, copy your edits first, as the conflict row in [docs/git-folder-setup.md](docs/git-folder-setup.md#troubleshooting) says.
2. If you deployed the jobs with the bundle, deploy it again right after the pull, so the jobs run the new code. From Phase 1.2, this also creates `watchdog_cleanup`, paused unless `scan.schedule_status` is UNPAUSED.
3. Restart Python on any open notebook (detach and reattach).
4. Run notebook 01 once. It prints `view incidents: created`. Your rows stay. Until you run it, the scans refuse to run: notebooks 05 and 06 stop with a message that says to run notebook 01.
   - From Phase 1.2 it also adds the Phase 1.3 columns and prints `view findings_latest: replaced`; read the Phase 1.3 notes below for what they add. On compute where replacing a view does not keep its grants, that drops any grant made on `findings_latest` itself, so grant `SELECT` on it again. Grants on the schema are not affected.
   - Grant `SELECT` on `incidents` to the readers who have `SELECT` on `findings_latest` itself. A grant on the schema already covers both views.
5. Run notebooks 05 and 06, and check that notebook 07 prints six PASS lines.

## Phase 1.3 (2026-11-04)

### Pin jobs by job ID

- **`job_ids`** on a job, or in one environment of its `environments` section, lists the exact jobs to check. In each workspace the environment's list applies, otherwise the job's own. Where IDs apply, the name pattern and the exclusion are not used; everywhere else the job still matches by name. Keep name patterns for jobs that get a new ID each time, such as jobs created by code.
- **Missing IDs are reported.** The system table scan writes a `not_found` row naming listed job IDs that apply in this region but were not found, for example `1 of 3 listed job IDs were not found in this region: 111.` The Jobs API scan reports a pinned job only when it finds none of its IDs.
- **New check `duplicate_name`** (system tables, WARNING, failure_category `COVERAGE`): two or more jobs that one name pattern matches in a workspace have exactly the same name. Rename the extra job, or pin the right one by ID.
- Notebook 02's match table shows `job_ids`, `matched_by` (`job_id` or `name`) and `same_name_jobs`.

### Child jobs, and impact through the whole chain

- **`schedule_type: triggered`** is for jobs that another job starts, or that run only by hand. They get no `schedule_gap` row, and `max_gap_minutes` on such a job stops the load (one from `defaults` is ignored).
- **`affected_jobs` now lists every job downstream** of a failed job, through the whole chain, not only its direct dependents. A `child_job` link counts both ways: a parent failure lists its children, and a child failure lists its parent and everything downstream of it. Loops between jobs are allowed, and notebook 02 prints them.
- **New `findings` column `parent_job`:** on rows about a child job, the job that starts it, so a child's findings can be read and routed with its parent's. A job can be the child of only one job.
- Notebook 02 shows what a failure of each job affects.

### Continuous jobs that stop are flagged

- A paused or stopped continuous job used to read HEALTHY. Now `max_gap_minutes` on a continuous job is the longest it may have no run in progress (30 minutes when not set; a value in `defaults` does not apply to continuous jobs, because a scheduled job's gap between runs is a different limit).
- The system table scan's `schedule_gap` now covers continuous jobs: a stream with no run in progress after the limit, plus 60 minutes of system table lag, is FAILED for CRITICAL jobs and WARNING for WARNING jobs, and the summary says when the job is paused.
- The Jobs API scan's `live_run_status` reports the same once the limit passes, with failure_category `SCHEDULE_GAP`.
- Jobs API rows for continuous runs now say `CONTINUOUS` in `trigger_type`. Older databricks-sdk versions, such as the one on serverless, read that trigger as empty.

### Delete old findings

- **`scan.retention_days`** (default 30; `0` keeps everything) and a daily **`watchdog_cleanup`** job (03:30 UTC, paused and unpaused with the scan through `scan.schedule_status`). It runs the new notebook `10_delete_old_findings` (`sql/maintenance/50_delete_old_findings.sql`), which deletes whole scans older than the limit and always keeps each source's newest scan, so `findings_latest` never goes empty.

### A shorter main path

- Notebooks 03 and 04 moved to `notebooks/explore`, to run by hand when you want to look at the raw data. `watchdog_phase_1` now runs 00, 01, 02, 05, 06 and 07.

### Changed behavior

- `affected_jobs` lists the whole downstream chain, so it can be longer than before.
- A paused or stopped continuous job that read HEALTHY now gets FAILED or WARNING rows. Notebook 02 shows 30 in `max_gap_minutes` for continuous jobs that set none.
- Running `sql/scan/21_system_table_findings.sql` by hand now also needs the temp view `watchdog_affected_jobs`, which notebook 05 creates. Run it from notebook 05.

### Docs

- The runbook has four new sections: "First run, step by step", "Child jobs and jobs with no schedule", "Pin jobs by job ID" and "Delete old findings".

### How to upgrade from Phase 1.2

1. In the Git folder, click Pull. If Pull reports a conflict in a notebook you have run, keep the incoming version: Databricks saves the serverless environment into a notebook when it runs it, and that is the only local change.
2. If you deployed the jobs with the bundle, deploy it again. This also creates `watchdog_cleanup`, paused unless `scan.schedule_status` is UNPAUSED.
3. Restart Python on any open notebook (detach and reattach).
4. Run notebook 01. It adds `job_ids` to `monitored_jobs` and `monitored_job_environments`, adds `parent_job` to `findings`, and prints `view findings_latest: replaced`. Your rows stay.
5. Run notebook 02. Job lists without `job_ids` or `triggered` jobs work unchanged. Optionally pin jobs by ID, mark child jobs and jobs with no schedule as `triggered`, set `max_gap_minutes` on continuous jobs whose restarts take longer than 30 minutes, and set `scan.retention_days`.
6. Run notebooks 05 and 06, and check that notebook 07 prints only PASS lines. Open notebooks 03 and 04 from `notebooks/explore` from now on.

## Phase 1.2 (2026-10-29)

### One job list for many workspaces and environments

One entry in the job list covers a job everywhere it runs: its `job_name_regex` finds the copy in each workspace, each with its own job ID, and every finding names the workspace and the job ID. New in the file:

- **`defaults`**, a new top-level section: settings every job gets unless it sets its own, such as `owner`, `severity` or `job_name_exclude_regex: "_test(_|$)"`. It can hold any job setting except `job_name`, `job_name_regex` and `environments`.
- **`environments`** on any job: settings for one environment label from the `workspaces` section, for example `lower: {severity: WARNING}` or `lower: {enabled: false}`. It can set `severity`, `owner`, `enabled`, `max_gap_minutes`, `max_runtime_minutes`, `max_retries` and `min_attempt_minutes`. Both scans use the settings for each workspace's label. A job switched off in an environment is not checked there. A job switched on somewhere, but found only where it is switched off, gets a `not_found` row that says so.
- **`min_attempt_minutes`** on any job: when a task attempt ran shorter than this and was then retried, the Jobs API scan's `retry_loop` row is a WARNING, alongside the `max_retries` rule. Use it for tasks that fail fast and restart.

`config/monitored_jobs.example.yml` is rewritten to show all of it: a `defaults` section, a `workspaces` section with placeholder names, and an illustrative pipeline whose jobs are named `<family>[_<variant>][_<region>]_<environment>`, with per-environment settings, a job with variants, a child job and service dependencies. The demo jobs are unchanged.

### New column and table

- `pipeline_url` on every finding: the link to the CI pipeline that deployed the job, from the job parameter named by `scan.pipeline_url_parameter` (default `PIPELINE_URL`).
- `min_attempt_minutes` on `monitored_jobs`.
- `monitored_job_environments`, a new table: one row per job and environment label, loaded by notebook 02 from the `environments` sections. Teardown with `--drop-schema` removes it too.

### Changed behavior

- **Unknown keys stop the load.** A key that `defaults`, a job or a job's `environments` section does not know now stops notebook 02 with a message that names it and lists the allowed keys. Before, a misspelled setting was ignored without a word. An `environments` label that the `workspaces` section does not define stops the load too.
- Notebook 02's match table shows each match's `environment`, and `checked_here`: whether the job is checked there.
- Notebook 07 counts a job as enabled when it is switched on in at least one environment.
- Notebook 08 creates and publishes the dashboard through the dashboards REST API, so it works on every SDK version, including the older one on serverless compute.

### Docs

- The README section "History and current status" and the runbook section "Reading the results" explain `findings` (the history) and `findings_latest` (the current status).
- Both diagrams show the Phase 1.1 design.
- The runbook explains `defaults`, per-environment settings, and tasks that fail fast and restart.

### How to upgrade from Phase 1 or 1.1

1. In the Git folder, click Pull.
2. If you deployed the jobs with the bundle, deploy it again from your updated clone (the `eval` line, then `databricks bundle deploy`). The jobs run their own copy of the code, and an older copy cannot load the job list once notebook 01 has added a column: notebook 02 stops with `DELTA_INSERT_COLUMN_ARITY_MISMATCH`.
3. Restart Python on any open notebook (detach and reattach).
4. Run notebook 01. It creates the tables that are new since your version, such as `monitored_job_environments`, adds the new columns (for example `min_attempt_minutes`, and `pipeline_url` if you do not have it yet), and prints `view findings_latest:` followed by created, replaced or current. Your rows stay.
5. Run notebook 02 with your job list. If it stops on a key it does not know, fix that key (the message names it) and run it again.
6. Optional: move shared settings into `defaults`, and add `environments` and `min_attempt_minutes` where you need them. Then run notebook 02 again.
7. Run notebooks 05 and 06, and check that notebook 07 prints only PASS lines.

From Phase 1, also read the Phase 1.1 section below: it lists the columns, options and jobs that release added.

## Phase 1.1 (2026-10-29)

### History and current status: `findings` and the new `findings_latest`

Nothing changed in how `findings` works: it keeps **every scan** as history. Each scan adds rows (one per job, check and source), and re-running a scan never duplicates them. Nothing is overwritten.

New in this release is the view **`findings_latest`**. A view is a saved query, not a second copy of the data. It shows only the **newest scan** from each source, which is the current status of every job.

- Use `findings_latest` for "what is wrong right now". The dashboard's Now and Versions and runs pages read it.
- Use `findings` for "since when, how often, did it recover". The dashboard's History page reads it, and alerts that fire once when a job breaks and once when it recovers (Phase 3) need it.

### New columns on every finding

- `environment`: the environment label of the workspace, from the new `workspaces` section of your job list.
- `schedule_type`: continuous or scheduled, from your job list.
- `run_start_time`, `run_end_time` (UTC) and `run_duration_seconds`: when the run the row is about started and ended, and how long it took.
- `trigger_type`: how the run started: SCHEDULE, ONE_TIME (Run now or the API), RETRY, CONTINUOUS, FILE_ARRIVAL, TABLE_UPDATE or JOB_TASK.
- `triggered_by`: who started a one-time run (Jobs API rows).
- `job_tags`: every tag on the job.
- `code_version`: the deployed code version, from the job tag named by `scan.code_version_tag` (default `code_version`).

[docs/data-model.md](docs/data-model.md) explains each one.

### New in the job list file

- `job_name_exclude_regex` on any job: job names matching it are skipped, for example `"_test(_|$)"` for test copies.
- An optional `workspaces:` section that labels workspaces with an environment, such as `production` or `lower`, by workspace ID or name.
- `enabled` must now be `true` or `false`, not a quoted word.

### New notebooks and jobs

- Notebooks 00 and 03 show workspace **names** next to IDs. System tables only cover workspaces in this region, so use these names to check which workspaces this Watchdog can see.
- Notebook 08 creates the "Watchdog findings" dashboard. It needs a SQL warehouse.
- Notebook 09 is a template for your own checks, such as service connectivity probes on your own compute.
- The bundle has a `watchdog_scan` job that runs every 20 minutes. It is **paused** until you turn it on.
- The demo target has two more sample jobs (`slow` and `retries`), and their schedules are paused by default.

### Changed behavior

- Each notebook creates its input boxes in its own first code cell. Run the first two code cells and the boxes appear at the top.
- `task_failures`, `schedule_gap` and `long_runtime` rows link the run they judged, even when HEALTHY.
- A job not found in several workspaces counts only the workspaces that answered.
- Teardown with `--drop-schema` removes the new table and view too.

### How to upgrade from Phase 1

1. In the Git folder, click Pull.
2. Restart Python on any open notebook (detach and reattach).
3. Run notebook 01. It prints the columns it added to each table and `view findings_latest: created`.
4. If you use the new options, add them to your job list file, then run notebook 02.
5. Run notebooks 05 and 06. The new columns fill in.
6. Optional: run notebook 08 for the dashboard.

## Phase 1 (2026-10-28)

First release: access checks, the config and findings tables, the system table and Jobs API scans, and validation.
