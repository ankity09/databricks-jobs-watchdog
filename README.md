# Watchdog: job monitoring across Databricks workspaces

Watchdog checks your Databricks jobs in every workspace of a cloud region and writes what it finds into one Unity Catalog table. It is built in phases. **Phase 1.2**, in this repo today, creates the tables, loads your list of jobs to watch (with shared defaults and per-environment settings), runs the scans on a schedule (paused until you turn it on), and adds a first dashboard.

> **Already running the first release?** [CHANGELOG.md](CHANGELOG.md) lists everything that changed and how to upgrade: pull, restart Python on open notebooks, then run notebook 01 once.

## Why

A platform team often runs hundreds of jobs spread over many workspaces. When an upstream job fails, the jobs that depend on it fail or go stale too, and often nobody notices until a report is wrong. The Jobs page in each workspace shows that workspace only, so answering "is everything healthy right now?" means opening each one.

Watchdog answers that question in one place. It reads two sources:

- **System tables**: read-only tables that Databricks keeps for you in the `system` catalog. One query covers the job and run history of every workspace in the same account and region. They run about an hour behind.
- **The Jobs API**: the REST API of each workspace. It is live and returns the real error text of a failed task, but each call answers for one workspace.

Every check writes a row to one table, `findings`. A row says which job, which check, its status (HEALTHY, WARNING, FAILED or UNKNOWN), what was found, and which downstream jobs a failure affects. Later phases add alerts and an app, and both read the same data.

## Architecture

![Unity Catalog, system tables and the Watchdog identity](docs/images/watchdog-unity-catalog-system-tables.png)

Each region has one Unity Catalog metastore, and its system tables collect job history from every workspace in that account and region. The Watchdog runs as a job in one Unity Catalog workspace in the region. It queries the system tables once, calls each workspace's Jobs API for live detail, and writes findings to one table. Run one Watchdog per region.

> **Check the region first.** System tables cover one account and one region, so a Watchdog sees only the workspaces in its own region. Workspace names often carry a region suffix. Check the workspaces that notebook 00 lists before you rely on a Watchdog, and run one Watchdog in each region you need to cover.

![Inside the Watchdog: three steps, one findings table, alerts and an app](docs/images/watchdog-inside-steps-findings-alerts.png)

Inside a scan, step 1 reads the system tables, step 2 calls the Jobs API, and step 3 checks both against your config and writes findings. The schedule repeats these steps every 20 minutes by default. The dashboard (notebook 08) reads the same table now, through the view `findings_latest`; alerts (Phase 3) and the app (Phase 4) will too. [docs/architecture.md](docs/architecture.md) walks through both diagrams.

### What Phase 1 checks

| Source | `check_id` | Finds |
|---|---|---|
| System tables | `last_run_result` | scheduled jobs: the newest finished run in the lookback window; continuous jobs: the newest run, even while it runs |
| | `task_failures` | tasks whose newest attempt failed, in the job's newest run |
| | `schedule_gap` | a scheduled job with no run started within `max_gap_minutes` (plus 60 minutes for system table lag) |
| | `long_runtime` | the newest finished run, or a run still going, over `max_runtime_minutes`, measured up to its newest system table record |
| | `not_found` | a monitored job whose name pattern matches no job in the region, or matches only where the job is switched off |
| Jobs API | `live_run_status` | the state of the newest run, right now |
| | `live_task_failures` | failed tasks in the newest run, with their error text, even while the run continues |
| | `live_long_runtime` | a run still going past `max_runtime_minutes` |
| | `retry_loop` | a task retried more than `max_retries` times, or retried after an attempt shorter than `min_attempt_minutes` |
| | `not_found` | no job matches the name pattern in the workspaces that answered. A job found in any workspace is not reported. |
| | `api_unreachable` | a workspace or job could not be read (a coverage gap) |
| Your own checks | `service_connectivity` (example) | a service your jobs depend on can be reached (notebook 09) |

### What each finding row holds

Each row names the job, the check, its status and severity, and the run the row is about: when it started and ended, how long it took, how it was triggered, and the code version and environment label where they are known. Failed rows also list the jobs that depend on the failed one. [docs/data-model.md](docs/data-model.md) describes every column.

### History and current status: `findings` and `findings_latest`

The Watchdog keeps two views of the same results:

- **`findings` is the history, like a logbook.** It is a table that keeps every scan. Each scan adds rows, one per job, check and source, and nothing is overwritten. Re-running a scan never adds duplicates.
- **`findings_latest` is the current status, like a status board.** It is a view, a saved query rather than a second copy of the data, that shows only the newest scan from each source. It is up to date as soon as a scan finishes.

Use `findings_latest` for "what is wrong right now". The dashboard's Now and Versions and runs pages read it. Use `findings` for "since when, how often, and did it recover". The dashboard's History page reads it, and the alerts in Phase 3 need it to alert once when a job breaks and once when it recovers, instead of on every scan.

## What this deploys

In the catalog and schema you choose (schema `watchdog` by default):

- `monitored_jobs`, `job_dependencies`, `monitored_workspaces` and `monitored_job_environments`: your config, loaded from a YAML file.
- `findings`: the history, every scan, one row per job, check and source. Re-running a scan never adds duplicate rows.
- `findings_latest`: a view of the newest scan from each source, the current status (see [History and current status](#history-and-current-status-findings-and-findings_latest)).

Notebook `01_create_tables` creates these, and upgrades existing tables and the view in place. Run it after each pull; each scheduled run runs it too. The bundle does not own them, so they and your findings history survive a teardown unless you ask for the schema to be dropped.

With the bundle (`databricks.yml`):

- `watchdog_phase_1`: an on-demand job (no schedule) that runs notebooks 00 to 07 as serverless tasks. Use it for setup and validation.
- `watchdog_scan`: the scheduled scan. Every 20 minutes in UTC, it brings the tables and the view up to date (notebook 01), reloads your config (notebook 02), then runs both scans (notebooks 05 and 06). It is deployed paused.
- With `-t demo`, four sample jobs as well: `watchdog_demo_succeeds`, `watchdog_demo_fails` (its `load` task fails on purpose), `watchdog_demo_slow` and `watchdog_demo_retries`. Their schedules are paused too.

Outside the bundle, you run two notebooks by hand. Notebook `08_create_dashboard` creates the "Watchdog findings" dashboard in your folder. Notebook `09_custom_check_example` is a template for your own checks.

Phase 1 creates no clusters, apps, alerts or secrets. The dashboard uses a SQL warehouse you already have. The scan job uses serverless compute unless you uncomment its custom-check task, which runs on a job cluster.

## Prerequisites and features to enable

- **A Unity Catalog workspace** in the region you want to watch, with **serverless compute** for notebooks and jobs.
- **System tables**: the `system.lakeflow` schema (jobs, runs and task runs). `system.access.workspaces_latest` (Public Preview) adds workspace names and run links; it is optional in `current_workspace` mode and required in `service_principal` mode. An account admin enables system schemas if they are not on yet.
- **Grants for the identity that runs the notebooks or the job** (a metastore admin grants these):
  - `USE CATALOG` on `system`, plus `USE SCHEMA` and `SELECT` on `system.lakeflow` and `system.access`;
  - `USE CATALOG` and `CREATE SCHEMA` on the catalog that holds the Watchdog schema. If you create the schema yourself first, `USE CATALOG` on the catalog plus `USE SCHEMA`, `CREATE TABLE`, `SELECT` and `MODIFY` on the schema instead.
  - The scheduled scan runs notebook 01 on every run, so the identity that runs `watchdog_scan` also needs `CREATE TABLE` and `MODIFY` on the Watchdog schema, or ownership of it.
- **Job permissions**: `CAN VIEW` on each job you monitor, to read its runs and error output. Phase 1 never needs `CAN MANAGE RUN`.
- **Every-workspace mode only** (`auth_mode: service_principal`): a service principal with an OAuth secret, added to each workspace it monitors, with `CAN VIEW` on the monitored jobs. Store its application ID and secret in a secret scope that only you and the job's identity can read. If your workspaces use IP access lists or private networking, the job must be able to reach each workspace's address.
- **The dashboard (notebook 08, optional)**: a SQL warehouse the identity can use (`CAN USE`), and permission to create dashboards in the folder you choose.
- **The demo target's version tags**: the sample jobs tag themselves with `bundle.git.branch` and `bundle.git.commit`, so deploy the demo target from a Git folder or a clone.

[docs/phase-1-runbook.md](docs/phase-1-runbook.md) lists every step by role, with the exact grants.

## Deploy with Genie Code

[DEPLOY.md](DEPLOY.md) is a step-by-step playbook for Genie Code, the Databricks coding agent, to run inside your workspace. It asks you for each value, including the schedule and the dashboard warehouse, checks permissions and features, writes `accelerator.local.yaml`, and **stops for your review** before it creates anything.

## Run Phase 1 by hand, or as a job

Both paths use the same notebooks. Settings come from `accelerator.yaml`: copy it to `accelerator.local.yaml` (git-ignored) and fill in `target.catalog` and `target.region`. Copy `config/monitored_jobs.example.yml` somewhere outside the repo, list your own jobs, and point `scan.monitored_jobs_path` at it. One entry covers a job in every workspace where it runs, each copy with its own job ID, so you never list job IDs. Use `defaults` for settings most jobs share, `job_name_exclude_regex` to skip test copies, the optional `workspaces` section to label each workspace with an environment, and a job's `environments` section to change its settings in one environment, for example `WARNING` instead of `CRITICAL` in lower environments, or not checked there at all. The example file works as is with the demo jobs.

### By hand, in a Git folder

1. Clone this repo into a Databricks Git folder ([docs/git-folder-setup.md](docs/git-folder-setup.md)).
2. Open `notebooks/` and run, in order, on serverless compute. Run each notebook's first two code cells before you fill in its input boxes.

| Notebook | Does |
|---|---|
| `00_check_access` | confirms system table and Jobs API access, and lists the workspaces this region covers; changes nothing |
| `01_create_tables` | creates the schema, the tables and the view, and upgrades existing tables. **Run it after every pull.** |
| `02_load_config` | loads your monitored-jobs file and shows which real jobs each entry matches |
| `03_explore_system_tables` | runs each read-only query in `sql/explore`, with notes |
| `04_explore_jobs_api` | walks one job through the three Jobs API calls |
| `05_scan_system_tables` | writes the system table findings |
| `06_scan_jobs_api` | writes the Jobs API findings |
| `07_validate_phase_1` | prints PASS or FAIL for each Phase 1 check |
| `08_create_dashboard` | optional: creates or updates the "Watchdog findings" dashboard and publishes it |
| `09_custom_check_example` | optional: a template for your own checks, such as service connectivity |

Each notebook takes its inputs from widgets (input boxes) at the top, with defaults from `accelerator.local.yaml` (or `accelerator.yaml`). Give notebooks 05 and 06 the same `scan_id` to make one scan across both sources, or leave it empty in both: notebook 07 then checks each source's newest scan.

### As a job, with the bundle

From a laptop with the [Databricks CLI](https://docs.databricks.com/dev-tools/cli/) and Python 3.10 or later with PyYAML (`pip install pyyaml`):

```bash
cp accelerator.yaml accelerator.local.yaml        # then fill in catalog and region
eval "$(python3 scripts/bundle_vars.py --export accelerator.local.yaml)"
databricks bundle validate -t dev --profile <your-profile>
databricks bundle deploy -t dev --profile <your-profile>
databricks bundle run watchdog_phase_1 -t dev --profile <your-profile>
```

`scripts/bundle_vars.py` turns `accelerator.local.yaml` into `BUNDLE_VAR_*` environment variables, which the CLI reads as bundle variables. Each job passes its run ID as `scan_id`, so both scans in one run share one scan.

**The schedule.** `watchdog_scan` is deployed paused. After `watchdog_phase_1` has passed in your workspace, set `scan.schedule_status` to `UNPAUSED` in `accelerator.local.yaml`, run the `eval` line again, and deploy again. `scan.schedule` sets the Quartz cron, in UTC; it is every 20 minutes by default. Each run brings the tables up to date first, so a deploy that adds columns needs no manual step. The [runbook](docs/phase-1-runbook.md#schedule-the-scan) explains what each run does.

**The dashboard.** Notebook 08 creates it. Run it in the workspace after the first scan has written rows, with a SQL warehouse ID in its `warehouse_id` box. The [runbook](docs/phase-1-runbook.md#build-the-dashboard-notebook-08) has the steps.

To see results in a workspace with no jobs of its own yet, deploy the `demo` target and run the four sample jobs once (`watchdog_demo_fails` reports an error on purpose, as intended), then run the Watchdog:

```bash
databricks bundle deploy -t demo --profile <your-profile>
databricks bundle run watchdog_demo_succeeds -t demo --profile <your-profile>
databricks bundle run watchdog_demo_fails -t demo --profile <your-profile>
databricks bundle run watchdog_demo_slow -t demo --profile <your-profile>
databricks bundle run watchdog_demo_retries -t demo --profile <your-profile>
databricks bundle run watchdog_phase_1 -t demo --profile <your-profile>
```

Both targets use development mode, so deployed names start with `[dev <your name>]`. Every schedule starts paused, so nothing runs on a timer until you unpause it. To run the demo jobs on their schedules, set `BUNDLE_VAR_demo_schedule_status=UNPAUSED` before you deploy the demo target. The example config's patterns match the sample jobs with that prefix.

### Remove it

```bash
./teardown.sh -t dev --profile <your-profile>                 # the bundle's jobs and files
./teardown.sh -t demo --drop-schema --profile <your-profile>  # also the sample jobs and the Watchdog schema
```

`--drop-schema` asks you to type the schema name first. It drops the schema with its five tables and the `findings_latest` view. It stops before changing anything if the schema holds any other table. The script does not delete the dashboard: move it to the trash in the workspace yourself. Any service principal, secret scope or grants you created are yours to remove.

## Phases

| Phase | What it adds | Status |
|---|---|---|
| 1 | Tables, config, both scans into one `findings` table, validation, and an on-demand job | Built |
| 1.1 | A scan every 20 minutes (paused until you unpause it), the `findings_latest` view, a first dashboard, environment labels, run timing, trigger and code version on each finding, and a template for your own checks | Built |
| 1.2 | Shared `defaults` and per-environment settings in the job list, a retry rule for tasks that fail fast and restart, and the CI pipeline link on each finding | Built: this repo |
| 2 | An incident view that changes only when a status changes, more checks such as stuck batches and service probes, and a retention rule for `findings` | Planned |
| 3 | Databricks SQL alerts on `findings`, sent to Slack, email, Microsoft Teams, PagerDuty or a webhook, with severity routing, alerts on change and recovery, and routing by environment | Planned |
| 4 | The Watchdog app, a Databricks App reading `findings` and `findings_latest`: health, incidents, impact, coverage, and Genie questions | Planned |
| 5 | Other regions and production, and a cross-region roll-up if your security team approves | Planned |

[docs/roadmap.md](docs/roadmap.md) has the detail.

## Security notes

- `findings` can hold error text from your jobs, and the dashboard shows it too. Govern `findings`, `findings_latest` and `monitored_workspaces` with Unity Catalog grants like any operational table, and share the dashboard only with people who may read them.
- Catalog and schema names must be letters, digits or underscores, and are checked before any SQL runs. Values reach SQL only as named parameters, and table names only through `IDENTIFIER()`.
- The service principal's secret stays in a secret scope. Nothing in this repo stores a token, host or secret.

## Repo layout

```
accelerator.yaml       the settings you review; copy to accelerator.local.yaml
DEPLOY.md              Genie Code playbook
databricks.yml         bundle: dev and demo targets
resources/             watchdog_phase_1 (on demand) and watchdog_scan (scheduled)
teardown.sh            bundle destroy, plus an optional schema drop
config/                example monitored-jobs file
dashboards/            the dashboard template that notebook 08 publishes
notebooks/             00 to 09, plus _setup (shared widgets and paths)
sql/setup/             schema and table DDL
sql/config/            loads the config tables
sql/explore/           read-only system table queries
sql/scan/              system table checks and the findings merge
sql/validate/          checks used by notebook 07
sql/views/             the findings_latest view, created by notebook 01
jobs_watchdog/         Python package the notebooks use
demo/                  the four sample job notebooks
scripts/               bundle_vars.py
tests/                 pytest, no network: python -m pytest
docs/                  guides and diagrams
```

## Docs

- [Architecture](docs/architecture.md): both diagrams, explained, plus the scheduled scan and the region rule.
- [Data model](docs/data-model.md): the tables, the view, and every findings column.
- [Queries](docs/queries.md): every SQL file, what it answers and how to read it.
- [Jobs API](docs/jobs-api.md): every Jobs API field the Watchdog reads.
- [Phase 1 runbook](docs/phase-1-runbook.md): step by step, by role.
- [Git folder setup](docs/git-folder-setup.md): cloning this repo into a workspace and pulling updates.
- [Roadmap](docs/roadmap.md): Phases 2 to 5, and the backlog.
- [Changelog](CHANGELOG.md): what changed in each release, and how to upgrade.

## License

Apache License 2.0. Copyright 2026 Databricks, Inc. See [LICENSE](LICENSE).
