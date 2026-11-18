# Roadmap

The Watchdog is built in phases. Each phase keeps the `findings` table as the contract: new checks arrive as new `check_id` values, and alerts and the app read the same columns. See [data-model.md](data-model.md).

## Phase 1: tables and the first scans (built)

- The schema, the config tables (`monitored_jobs`, `job_dependencies`, `monitored_workspaces`), the `findings` table and the `findings_latest` view.
- Your monitored-jobs file loaded into the config tables.
- Read-only explore notebooks for the system tables and the Jobs API (now in `notebooks/explore`).
- Both scans, system tables and the Jobs API, writing to `findings`, with re-runs that never duplicate rows.
- A validation notebook, and an on-demand bundle job that runs all of it.

## Phase 1.1: a schedule and a first dashboard (built)

Delivered early, in Phase 1.1:

- **A 20-minute schedule.** `watchdog_scan` brings the tables and the view up to date, reloads the config, and runs both scans every 20 minutes in UTC. It is paused by default, and `scan.schedule_status` turns it on.
- **A first dashboard.** Notebook 08 creates "Watchdog findings", with three pages: Now, Versions and runs, and History.
- **Run and version context on every finding.** Run start and end, duration, trigger, job tags and code version, and the environment label of the workspace.
- **Exclusions and environment labels.** `job_name_exclude_regex` skips test copies, and the optional `workspaces` section labels each workspace with an environment.
- **Upgrades in place.** Notebook 01 adds new columns and keeps the rows. It creates `findings_latest`, and replaces it only when its columns or its definition version change.
- **A template for your own checks.** Notebook 09 writes `CUSTOM` rows, for example service connectivity. The bundle has a commented task that runs it on its own cluster.
- **Demo jobs.** Four sample jobs in the demo target, tagged with their code version and paused by default.

Not in 1.1: alerts, incidents, the app, and other regions. Those are in the phases below.

## Phase 1.2: one job list for many workspaces and environments (built)

Delivered in this release:

- **Shared defaults.** An optional `defaults` section holds the settings most jobs share, such as the owner, the severity and the test-copy exclusion.
- **Per-environment settings.** A job's `environments` section changes its severity, owner and limits, or switches it off, in one environment, so one entry covers the job's copies in production and in lower environments. A new table, `monitored_job_environments`, holds these settings.
- **Tasks that fail fast and restart.** `min_attempt_minutes` makes a retry after a short attempt a retry loop, alongside `max_retries`.
- **Stricter loading.** An unknown or misspelled key stops the load with a message that names it.
- **The CI pipeline link.** `pipeline_url` on every finding, from a job parameter.
- **A dashboard fix.** Notebook 08 creates the dashboard through the dashboards REST API, so it works on every SDK version.

## Phase 1.3: job IDs, child jobs and retention (built)

- **Pin jobs by job ID.** `job_ids` on a job, or per environment, lists the exact jobs to check; name patterns still cover jobs without stable IDs. Missing IDs get a `not_found` row, and a `duplicate_name` check warns when one pattern finds two jobs with the same name.
- **Child jobs and the whole chain.** `schedule_type: triggered` for jobs another job starts; `affected_jobs` lists everything downstream, with `child_job` links counted both ways; findings carry `parent_job`.
- **Continuous jobs that stop.** `schedule_gap` and `live_run_status` flag a continuous job with no run in progress for longer than `max_gap_minutes` (30 by default).
- **Retention.** The daily `watchdog_cleanup` job (notebook 10) deletes `findings` scans older than `scan.retention_days` (30 by default), always keeping each source's newest scan.
- **A shorter main path.** The read-only exploration notebooks moved to `notebooks/explore`, and `watchdog_phase_1` now runs 00, 01, 02, 05, 06 and 07.

## Phase 1.4: one row per problem (built)

- **The `incidents` view.** One row per problem with one check of one job, from the scan that found it until a HEALTHY row clears it: `OPEN`, `RESOLVED` or `NOT_CHECKED`, with when it opened and how many scans found it. Notebook 01 creates it. It reads `findings`, so it covers the rows already there.
- **Plainer scan output.** Notebooks 05 and 06 print how many rows the scan holds, one per check, and how many problems are new, still open and resolved.
- **A validation check.** Notebook 07 checks the open incidents against `findings_latest`.

## Phase 2: escalation and more checks

- **Escalation.** Escalate an incident in the `incidents` view (Phase 1.4) when it stays open or gets worse. Alerts in Phase 3 fire on these changes, and when an incident opens or is resolved, instead of on every scan.
- **More checks:**
  - a stuck batch, or no new input, for continuous jobs;
  - a growing backlog over several scans;
  - connectivity probes for the services jobs depend on, such as a message broker or an API (the `service` entries in your dependency map). Notebook 09 is a template for these.

## Phase 3: alerts

- **Databricks SQL alerts** on `findings` (or the `incidents` view). An alert runs a query on a schedule and notifies a notification destination: Slack, email, Microsoft Teams, PagerDuty or a webhook. A workspace admin creates the destinations.
- **Alert once on change, and again on recovery.** An alert fires when a job's status changes for a check, not on every scan, and again when the job recovers. This reads the history in `findings`, not only `findings_latest`.
- **Severity routing.** CRITICAL findings page the on-call engineer; WARNING findings go to a chat channel, tagged with the job's `owner`.
- **Routing by environment.** Route findings by the environment label, so production and lower-environment findings go to separate channels.
- **Impact.** A failure alert names the downstream jobs it affects, from `affected_jobs`.
- **Recovery messages.** When a job is healthy again, one closing message.

## Phase 4: The Watchdog app (built)

A Databricks App with a Lakebase project and a Genie copilot, deployed by the bundle. [app.md](app.md) describes it. It has:

- **Monitoring.** Counts of failed, warning, unknown and healthy jobs, one row per job and workspace with filters, a detail panel for each job (check results, error text, run and pipeline links, the jobs a failure affects), a history strip, and Scan now. Jobs the Watchdog could not find show as unknown, with the reason.
- **The job list, in the app.** Add, edit, switch off and delete jobs, shared defaults and workspace labels, a dependency map, a job picker that searches the region's real jobs, a change log of every saved version, and YAML import and export. The scan reads the newest saved version when `scan.config_source` is `lakebase`.
- **The copilot.** A read-only Genie agent over the Watchdog tables. Each answer shows the SQL it ran and who it ran as.
- **One Watchdog per region.** A `production` target, region files, a deploy script and a GitLab CI example ([multi-region.md](multi-region.md)).

Moved to the backlog:

- Incidents: what is open, since when, and who owns it, from the `incidents` view (Phase 1.4).
- Acknowledgements and triage notes on a failure.
- A restore button in the change log (the server already has the call).
- Copilot actions, such as rerunning a job, and approvals for them.
- A scan that runs as a service principal other than the deploying identity and reads the job list from Lakebase.
- Views across regions.
- Alerts (Phase 3).

## Phase 5: more regions and production

- One Watchdog per region, so each region's data stays in that region. The bundle and a deploy script for this are built ([multi-region.md](multi-region.md)).
- A cross-region roll-up of findings, only if your security team approves moving that data.
- Production hardening: the job running as a service principal, alerts on the Watchdog's own failures, and a review of who can read `findings`.
- Built-in Databricks job monitoring features, used alongside the Watchdog where they become available.

## Backlog

Not scheduled yet:

- Compare `code_version` with the newest commit on the main branch. Needs access to the Git provider's API.
- Who cancelled a run. Needs audit logs.
- Restart on known errors, through the job's retry settings or automation.
- An optional cross-region roll-up, subject to security approval.
- The app's backlog items listed under Phase 4.
- PagerDuty routing for CRITICAL findings.
