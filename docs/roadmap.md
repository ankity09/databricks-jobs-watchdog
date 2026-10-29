# Roadmap

The Watchdog is built in phases. Each phase keeps the `findings` table as the contract: new checks arrive as new `check_id` values, and alerts and the app read the same columns. See [data-model.md](data-model.md).

## Phase 1: tables and the first scans (built)

- The schema and three tables: `monitored_jobs`, `job_dependencies`, `findings`.
- Your monitored-jobs file loaded into the config tables.
- Read-only explore notebooks for the system tables and the Jobs API.
- Both scans, system tables and the Jobs API, writing to `findings`, with re-runs that never duplicate rows.
- A validation notebook, and an on-demand bundle job that runs all of it.

Not in Phase 1: a schedule, alerts, incidents, the app, other regions, and checks beyond the ten `check_id` values listed in the README.

## Phase 2: run on a schedule

- **Schedule** the Watchdog job, for example every 20 minutes.
- **Incidents.** An incident view on top of `findings` that changes only when a job's status changes: it opens an incident when a job turns unhealthy, escalates it when it stays that way or gets worse, and records the recovery when the job is healthy again. Alerts in Phase 3 fire on these changes instead of on every scan.
- **More checks:**
  - a stuck batch, or no new input, for continuous jobs;
  - a growing backlog over several scans;
  - connectivity probes for the services jobs depend on, such as a message broker or an API (the `service` entries in your dependency map).

## Phase 3: alerts

- **Databricks SQL alerts** on `findings` (or the Phase 2 incident view). An alert runs a query on a schedule and notifies a notification destination: Slack, email, Microsoft Teams, PagerDuty or a webhook. A workspace admin creates the destinations.
- **Severity routing.** CRITICAL findings page the on-call engineer; WARNING findings go to a chat channel, tagged with the job's `owner`.
- **Impact.** A failure alert names the downstream jobs it affects, from `affected_jobs`.
- **Recovery messages.** When a job is healthy again, one closing message.

## Phase 4: the Watchdog app

A Databricks App that reads `findings`:

- **Health:** every monitored job and its latest status, across workspaces.
- **Incidents:** what is open, since when, and who owns it.
- **Impact:** the dependency map, with the jobs a failure affects.
- **Coverage:** jobs the Watchdog could not see (`not_found`, `api_unreachable`) and why.
- **Summary:** trends over days and weeks.

## Phase 5: more regions and production

- One Watchdog per region, so each region's data stays in that region.
- A cross-region roll-up of findings, only if your security team approves moving that data.
- Production hardening: the job running as a service principal, alerts on the Watchdog's own failures, and a review of who can read `findings`.
- Built-in Databricks job monitoring features, used alongside the Watchdog where they become available.
