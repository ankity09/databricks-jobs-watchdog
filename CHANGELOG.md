# Changelog

What changed, for people who already run the Watchdog. After every pull: restart Python on any open notebook, then run notebook 01 once. It adds any new columns to your existing tables (your rows stay) and brings the view up to date. Each scheduled run of `watchdog_scan` does this too.

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
- `pipeline_url`: the link to the CI pipeline that deployed the job, from the job parameter named by `scan.pipeline_url_parameter` (default `PIPELINE_URL`).

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
