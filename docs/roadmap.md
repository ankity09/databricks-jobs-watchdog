# Roadmap

The Watchdog is built in phases. Each phase keeps the `findings` table as the contract: new checks arrive as new `check_id` values, and alerts and the app read the same columns. See [data-model.md](data-model.md).

## Phase 1: tables and the first scans (built)

- The schema, the config tables (`monitored_jobs`, `job_dependencies`, `monitored_workspaces`), the `findings` table and the `findings_latest` view.
- Your monitored-jobs file loaded into the config tables.
- Read-only explore notebooks for the system tables and the Jobs API.
- Both scans, system tables and the Jobs API, writing to `findings`, with re-runs that never duplicate rows.
- A validation notebook, and an on-demand bundle job that runs all of it.

## Phase 1.1: a schedule and a first dashboard (built)

Delivered early, in this release:

- **A 20-minute schedule.** `watchdog_scan` brings the tables and the view up to date, reloads the config, and runs both scans every 20 minutes in UTC. It is paused by default, and `scan.schedule_status` turns it on.
- **A first dashboard.** Notebook 08 creates "Watchdog findings", with three pages: Now, Versions and runs, and History.
- **Run and version context on every finding.** Run start and end, duration, trigger, job tags and code version, and the environment label of the workspace.
- **Exclusions and environment labels.** `job_name_exclude_regex` skips test copies, and the optional `workspaces` section labels each workspace with an environment.
- **Upgrades in place.** Notebook 01 adds new columns and keeps the rows. It creates `findings_latest`, and replaces it only when its columns change.
- **A template for your own checks.** Notebook 09 writes `CUSTOM` rows, for example service connectivity. The bundle has a commented task that runs it on its own cluster.
- **Demo jobs.** Four sample jobs in the demo target, tagged with their code version and paused by default.

Not in 1.1: alerts, incidents, the app, and other regions. Those are in the phases below.

## Phase 2: incidents and more checks

- **Incidents.** An incident view on top of `findings` that changes only when a job's status changes: it opens an incident when a job turns unhealthy, escalates it when it stays that way or gets worse, and records the recovery when the job is healthy again. Alerts in Phase 3 fire on these changes instead of on every scan.
- **More checks:**
  - a stuck batch, or no new input, for continuous jobs;
  - a growing backlog over several scans;
  - connectivity probes for the services jobs depend on, such as a message broker or an API (the `service` entries in your dependency map). Notebook 09 is a template for these.
- **Retention.** A rule and a job for deleting old scans from `findings`, since the schedule adds rows every 20 minutes.

## Phase 3: alerts

- **Databricks SQL alerts** on `findings` (or the Phase 2 incident view). An alert runs a query on a schedule and notifies a notification destination: Slack, email, Microsoft Teams, PagerDuty or a webhook. A workspace admin creates the destinations.
- **Alert once on change, and again on recovery.** An alert fires when a job's status changes for a check, not on every scan, and again when the job recovers. This reads the history in `findings`, not only `findings_latest`.
- **Severity routing.** CRITICAL findings page the on-call engineer; WARNING findings go to a chat channel, tagged with the job's `owner`.
- **Routing by environment.** Route findings by the environment label, so production and lower-environment findings go to separate channels.
- **Impact.** A failure alert names the downstream jobs it affects, from `affected_jobs`.
- **Recovery messages.** When a job is healthy again, one closing message.

## Phase 4: the Watchdog app

A Databricks App that reads `findings_latest` for the current picture, and `findings` for history:

- **Health:** every monitored job and its latest status, across workspaces.
- **Incidents:** what is open, since when, and who owns it.
- **Impact:** the dependency map, with the jobs a failure affects.
- **Coverage:** jobs the Watchdog could not see (`not_found`, `api_unreachable`) and why.
- **Summary:** trends over days and weeks.
- **Genie questions** over `findings_latest`, so people can ask about the current status in plain language.
- **Write-back:** acknowledgements and notes on incidents.

## Phase 5: more regions and production

- One Watchdog per region, so each region's data stays in that region.
- A cross-region roll-up of findings, only if your security team approves moving that data.
- Production hardening: the job running as a service principal, alerts on the Watchdog's own failures, and a review of who can read `findings`.
- Built-in Databricks job monitoring features, used alongside the Watchdog where they become available.

## Backlog

Not scheduled yet:

- Compare `code_version` with the newest commit on the main branch. Needs access to the Git provider's API.
- Who cancelled a run. Needs audit logs.
- Restart on known errors, through the job's retry settings or automation.
- One Watchdog per region, plus an optional cross-region roll-up, subject to security approval.
- PagerDuty routing for CRITICAL findings.
