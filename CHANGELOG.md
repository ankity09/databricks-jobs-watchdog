# Changelog

What changed, for people who already run the Watchdog. After every pull: restart Python on any open notebook, then run notebook 01 once. It creates any new table, adds any new columns to your existing tables (your rows stay) and brings the view up to date. Each scheduled run of `watchdog_scan` does this too.

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
2. Restart Python on any open notebook (detach and reattach).
3. Run notebook 01. It creates the tables that are new since your version, such as `monitored_job_environments`, adds the new columns (for example `min_attempt_minutes`, and `pipeline_url` if you do not have it yet), and prints `view findings_latest:` followed by created, replaced or current. Your rows stay.
4. Run notebook 02 with your job list. If it stops on a key it does not know, fix that key (the message names it) and run it again.
5. Optional: move shared settings into `defaults`, and add `environments` and `min_attempt_minutes` where you need them. Then run notebook 02 again.
6. Run notebooks 05 and 06, and check that notebook 07 prints only PASS lines.

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
