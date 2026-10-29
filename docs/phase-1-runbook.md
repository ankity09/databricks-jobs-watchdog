# Phase 1 runbook

Phase 1 ends with validated findings from both sources in one table. Phase 1.1, in this release, adds a scheduled scan and a first dashboard. Both are optional. This runbook goes role by role.

Most teams need three people, or one person with all three hats:

| Role | Does |
|---|---|
| Metastore admin (or account admin) | turns on and grants the system tables, grants the catalog |
| Workspace admin | sets up the service principal, only for checking every workspace in the region |
| Operator | clones the repo, writes the config, runs the notebooks or the bundle jobs, builds the dashboard |

## Before you start

Decide five things:

1. **The region.** System tables are regional: they cover the workspaces in one account and one cloud region. Run one Watchdog per region.
2. **The Watchdog workspace.** One Unity Catalog workspace in that region, with serverless notebooks and jobs. The Watchdog runs there.
3. **The catalog and schema.** Where the four tables and the view go, for example `<catalog>.watchdog`.
4. **The mode.**
   - `current_workspace`: checks only the Watchdog workspace, with the identity running the notebooks. Nothing extra to set up. Start here.
   - `service_principal`: checks every workspace in the region that has jobs, signing in to each as a service principal. Needs the workspace admin steps below.
5. **The schedule and the dashboard.** Both are optional. The scheduled scan is deployed paused, so nothing runs on a timer until you unpause it. The dashboard needs a SQL warehouse you can use.

> **Check the region before you scan.** System tables cover one account and one region, and a Watchdog sees only the workspaces there. Notebook 00 lists the workspaces this Watchdog can see, with their names. Workspace names often carry a region suffix, so compare the names with the regions you expect. A workspace in another region needs a Watchdog in that region.

## 1. Metastore admin

### Turn on the system tables

The Watchdog reads `system.lakeflow` (jobs, runs, task runs) and `system.access` (workspace names and URLs). If they are not there, an account admin turns them on for the region's metastore:

```bash
databricks system-schemas list <metastore-id>
databricks system-schemas enable <metastore-id> lakeflow
databricks system-schemas enable <metastore-id> access
```

`system.access.workspaces_latest` is in Public Preview. The Watchdog works without it in `current_workspace` mode (findings just have no workspace names or run links), but `service_principal` mode needs it for workspace URLs.

### Grant access

Grant to the operators, and to the identity the bundle job runs as. A group is easiest:

```sql
GRANT USE CATALOG ON CATALOG system TO `watchdog-operators`;
GRANT USE SCHEMA, SELECT ON SCHEMA system.lakeflow TO `watchdog-operators`;
GRANT USE SCHEMA, SELECT ON SCHEMA system.access TO `watchdog-operators`;

GRANT USE CATALOG, CREATE SCHEMA ON CATALOG <catalog> TO `watchdog-operators`;
```

Anyone with `SELECT` on `system.lakeflow` sees every job and run in the region, whatever the job's own permissions say. Grant it on purpose.

If the schema already exists, grant `USE SCHEMA`, `CREATE TABLE`, `SELECT` and `MODIFY` on it instead of `CREATE SCHEMA` on the catalog.

## 2. Workspace admin (service principal mode only)

Skip this section for `current_workspace` mode.

1. **Create a service principal** in the account console, and note its application ID.
2. **Add it to every workspace that has monitored jobs**, as a workspace user. Service principal mode visits every workspace in the region that has jobs. A workspace it cannot reach shows as a `WARN` line in notebook 00 and as `api_unreachable` rows in notebook 06; the scan carries on with the rest. Notebook 00 fails only if it reaches none of them.
3. **Give it CAN VIEW on each monitored job**, in every workspace. Adding it to a group that has CAN VIEW works too. It never needs CAN MANAGE RUN.
4. **Give it the metastore admin's grants** above, if the bundle job will run as this service principal.
5. **Create an OAuth secret** for it in the account console. The secret is shown once.
6. **Store both values in a secret scope** in the Watchdog workspace:

   ```bash
   databricks secrets create-scope watchdog
   databricks secrets put-secret watchdog client_id --string-value <application-id>
   databricks secrets put-secret watchdog client_secret
   ```

   The last command prompts for the secret, so it never lands in your shell history.
7. **Lock the scope down.** Only the operators and the identity the job runs as should read it:

   ```bash
   databricks secrets list-acls watchdog
   databricks secrets put-acl watchdog <operator-group> READ
   databricks secrets put-acl watchdog <job-run-as-identity> READ
   ```

   Remove any wider entry that `list-acls` shows.

Then put the scope and key names in `accelerator.local.yaml` (`auth.secret_scope`, `auth.client_id_key`, `auth.client_secret_key`).

## 3. Operator

### Get the code

Clone this repo into a Git folder in the Watchdog workspace. [git-folder-setup.md](git-folder-setup.md) has the steps, and how to pull updates.

After every pull, restart Python on any notebook you have open, so it loads the new code. Then run notebook 01, which upgrades the existing tables and makes the view current. Each scheduled run runs notebook 01 too, so the next scheduled run upgrades them. Run `watchdog_phase_1` once before you turn the schedule on, to check access and validate the setup.

### Write your config

1. **The job list.** Copy `config/monitored_jobs.example.yml` somewhere outside the Git folder: your workspace home folder, or a Unity Catalog volume such as `/Volumes/<catalog>/<schema>/<volume>/monitored_jobs.yml`. Edits there never conflict with pulls. Replace the examples with your jobs and dependencies. The file's comments explain every field, and [data-model.md](data-model.md) explains how each is used.
2. **The settings.** In the repo root of your Git folder, create `accelerator.local.yaml` as a copy of `accelerator.yaml`, and fill in `target.catalog`, `target.schema`, `target.region`, the `auth` section, and `scan.monitored_jobs_path` (the path to your job list). The optional settings are:
   - `scan.code_version_tag`: the job tag that holds the deployed code version (`code_version` by default);
   - `scan.schedule` and `scan.schedule_status`: the schedule of `watchdog_scan` and whether it runs (see [Schedule the scan](#schedule-the-scan));
   - `target.warehouse_id`: the SQL warehouse for the dashboard (see [Build the dashboard](#build-the-dashboard-notebook-08)).

   The file is git-ignored, so it stays out of commits and pulls. Every notebook widget takes its default from it, and you can still override any widget by hand.

To write `job_name_regex` values, look at your real job names in notebook 03 (query 12) or the Jobs page. A regex matches anywhere in the name unless you anchor it with `^` and `$`.

### Exclude test copies

Test copies often share a job's name, for example `daily_revenue_report_test`. Add `job_name_exclude_regex` to the entry. The scans skip every job whose real name matches it, even when `job_name_regex` matches it too:

```yaml
  - job_name: daily_revenue_report
    job_name_regex: "^daily_revenue_report(_[a-z0-9]+)?$"
    job_name_exclude_regex: "_test(_|$)"
```

Like `job_name_regex`, the exclusion matches anywhere in the name unless you anchor it. The pattern needs `_test` to be followed by `_` or the end of the name, so it skips `daily_revenue_report_test` and keeps `daily_revenue_report_latest`. The example anchors it because a bare `test` would also match names such as `contest`. Notebook 02's match table applies the same exclusion, and the scans write no rows for excluded jobs.

### Label workspaces by environment

Add an optional top-level `workspaces` section to the same file:

```yaml
workspaces:
  - workspace_id: "1111111111111111"
    environment: production
    notes: Orders and billing jobs
  - workspace_name: example-lower-workspace
    environment: lower
```

- Give each entry a `workspace_id` (digits) or a `workspace_name`, and an `environment`: letters, digits, `-` or `_`.
- An entry with an ID matches only that workspace. An entry with only a name matches the workspace with that name, ignoring case. The ID is tried first, so give each workspace one entry. Two name entries that differ only in case are rejected as listed twice.
- Every finding from a labelled workspace carries its environment. You can filter the dashboard by it now, and route alerts to separate channels in Phase 3. Rows that cover no single workspace have no environment.

### Run Phase 1 by hand

Open each notebook in `notebooks/`, attach it to serverless compute, run its first two code cells (this shows its input boxes), then run all cells, in order:

| Notebook | What it does | Look for |
|---|---|---|
| `00_check_access` | checks system table access, the region's workspaces and the Jobs API | every line PASS, and the workspace names you expect in section 3 |
| `01_create_tables` | creates or upgrades the schema, the four tables and the view `findings_latest` | five `exists: True` lines, a `view findings_latest:` line that says created, replaced or current, and the columns it added, if any |
| `02_load_config` | loads your YAML file into the config tables, shows what each job matches | every enabled job matches a real job |
| `03_explore_system_tables` | runs the read-only system table queries | your jobs and runs, as you expect |
| `04_explore_jobs_api` | walks one job through the Jobs API calls | the newest run, its tasks, any error text |
| `05_scan_system_tables` | writes the system table findings | one row per check for each matched job |
| `06_scan_jobs_api` | writes the Jobs API findings | rows for each matched job |
| `07_validate_phase_1` | checks the result | five PASS lines |
| `08_create_dashboard` (optional) | creates or updates the "Watchdog findings" dashboard and publishes it | a `Dashboard ready` line with its link |
| `09_custom_check_example` (optional) | probes the services in its list and writes `CUSTOM` rows | one row per service, or a skip line for each placeholder host |

Notebooks 05 and 06 each make their own `scan_id` when the widget is empty. Notebook 07, with its `scan_id` empty, checks each source's newest scan, so the by-hand path validates without copying IDs.

### Or run Phase 1 as a job

From a machine with the Databricks CLI, in a clone of the repo with your `accelerator.local.yaml`:

```bash
eval "$(python3 scripts/bundle_vars.py --export accelerator.local.yaml)"
databricks bundle deploy -t dev --profile <profile>
databricks bundle run watchdog_phase_1 -t dev --profile <profile>
```

The job runs notebooks 00 to 07 on serverless compute, with one `scan_id` (the job's run ID) for both scans. In development mode the job runs as the person who deployed it.

To try it in a workspace with no jobs worth watching, use the `demo` target. It adds four sample jobs: one that succeeds, one whose `load` task fails on purpose, one that runs about three minutes, and one whose task fails twice and then succeeds. The example config lists all four, with limits that make the slow job warn for long runtime and the retrying job warn for a retry loop. Their schedules start paused. Set `BUNDLE_VAR_demo_schedule_status=UNPAUSED` in your shell to unpause them.

```bash
databricks bundle deploy -t demo --profile <profile>
databricks bundle run watchdog_demo_succeeds -t demo --profile <profile>
databricks bundle run watchdog_demo_fails -t demo --profile <profile>   # fails on purpose
databricks bundle run watchdog_demo_slow -t demo --profile <profile>
databricks bundle run watchdog_demo_retries -t demo --profile <profile>
databricks bundle run watchdog_phase_1 -t demo --profile <profile>
```

The sample jobs tag themselves with `code_version: <branch>@<commit>`, using `bundle.git.branch` and `bundle.git.commit`, so deploy the demo target from a Git folder or a clone.

### Schedule the scan

`watchdog_scan` is the scheduled scan. Every 20 minutes, in UTC, it runs four tasks in order:

1. `create_tables` (notebook 01) creates what is missing, adds new columns after an upgrade, and makes the view `findings_latest` current. Tables and views that are already current are left alone.
2. `load_config` (notebook 02) reloads your monitored-jobs file into the config tables.
3. `scan_system_tables` (notebook 05) writes the system table findings.
4. `scan_jobs_api` (notebook 06) writes the Jobs API findings.

Both scans run even if an earlier task failed, and each one checks the tables and the view before it writes. A bad config file therefore leaves the scans running on the config loaded last time, and the run shows as failed. Each run is one scan: its run ID is the `scan_id` for both scans. The job allows one run at a time, so runs never overlap.

Because every run brings the tables up to date, a deploy that adds columns needs no manual step. For that step, the identity that runs the job needs `CREATE TABLE` and `MODIFY` on the Watchdog schema, or ownership of it. Run `watchdog_phase_1` once before you turn the schedule on, to check access and validate the setup.

The job starts paused. To turn it on:

1. Check that `watchdog_phase_1` passes in this workspace.
2. Set `scan.schedule_status` to `UNPAUSED` in `accelerator.local.yaml`, or set `BUNDLE_VAR_scan_schedule_status=UNPAUSED` in your shell.
3. Run the `eval` line from the bundle steps again, then `databricks bundle deploy -t dev --profile <profile>`.

To change the timing, set `scan.schedule` to another Quartz cron expression. It is read in UTC. Each run adds rows for every check of every job, so 72 runs a day add up quickly. Plan retention as described in [data-model.md](data-model.md#governance).

### Build the dashboard (notebook 08)

Notebook 08 creates the dashboard "Watchdog findings" in your home folder, publishes it, and prints its link. Run it after the first scan has written rows. Running it again updates the same dashboard and publishes it again. Before you run it:

- Set `warehouse_id` to a SQL warehouse ID, in the notebook's box or as `target.warehouse_id` in `accelerator.local.yaml`. To find an ID, run `databricks warehouses list`, or open the warehouse's details page. The identity that runs the notebook needs `CAN USE` on the warehouse.
- The identity needs permission to create dashboards in the folder. To use another folder, change `dashboard_folder`.
- The view `findings_latest` must exist. Notebook 01 creates it, and each scheduled run runs notebook 01, so run a scan or notebook 01 first.

The dashboard has three pages:

- **Now**: counters for FAILED, WARNING, UNKNOWN and HEALTHY rows in the latest scans, every problem worst first, and the worst status of each job in each environment.
- **Versions and runs**: the latest run of each job in each workspace, with its code version and trigger. Jobs API rows come first, and system table rows fill the gaps.
- **History**: status per scan over 30 days, and FAILED rows by job over 7 days.

The environment and job filters narrow Now and Versions and runs. History shows every environment. Now and Versions and runs read `findings_latest`. History reads `findings`, because it needs every scan.

The dashboard is published without embedded credentials, so each viewer's queries run with their own permissions: a viewer needs `USE CATALOG`, `USE SCHEMA` and `SELECT` on `findings` and `findings_latest`, and permission to use the SQL warehouse. It shows error text, so share it with the people who may read `findings`. If the folder already holds two dashboards with this name, notebook 08 stops and names them: trash all but one, then run it again. The teardown script does not remove the dashboard, so delete it in the workspace when you no longer need it.

### Write your own checks (notebook 09)

Notebook 09 is a template. It probes each service in its `SERVICES` list with a TCP connection and then a TLS handshake, and it writes one row per service with `source` = `CUSTOM` and `check_id` = `service_connectivity`. Each entry sets the service's `severity` and `owner`. The service name is the row's `job_name`, and its `error_summary` starts with `host:port`. When a probe fails, `affected_jobs` lists the monitored jobs that depend on that service, from the `service` rows of your config. The notebook stops if two entries share a name, so give each service its own. If a client certificate secret cannot be read, that service gets a FAILED row with the error instead of stopping the notebook, and the temporary certificate files are deleted after use. Entries whose host ends in `.example.com` are skipped, so the example writes nothing until you replace them. Notebook 09 is not part of the Phase 1 job. It checks the tables and the view before it writes.

Serverless compute cannot reach private endpoints. Run the notebook on a job cluster whose network can reach the services. The scan job has a commented task, `custom_checks`, that does this. To use it, uncomment that task and its `job_clusters` block in `resources/watchdog_scan.job.yml`, and set `policy_id` to a cluster policy whose network can reach the services. Set the runtime and node type too.

To add your own checks, build rows with the keys `job_name`, `check_id`, `status`, `severity`, `owner`, `error_summary` and `source`. Give each kind of check its own `check_id`. A row whose `job_name` is not a configured job keeps the severity and owner it sets. `finalize_rows` fills in `failure_category` when a row does not set one, and it fills `affected_jobs` on FAILED rows. Then pass the rows through `finalize_rows` and `write_findings`, as notebook 09's last cells do.

## What success looks like

- Notebook 00 prints only PASS lines (and WARN lines in service principal mode, for workspaces the service principal cannot reach).
- Notebook 07 prints five PASS lines: the four tables and the view exist, config has enabled jobs, both sources wrote findings, every enabled job has findings, no duplicate keys.
- `findings` has rows with `source = SYSTEM_TABLES` and `source = JOBS_API` for the same `scan_id` (job runs) or for each source's newest scan (by hand).
- `findings_latest` returns the newest scan of each source, judged by when each scan first wrote.
- With the demo target: `watchdog_demo_succeeds` is HEALTHY, and `watchdog_demo_fails` is FAILED with `load` in `failed_task_keys` and the error text in `error_summary`. The example config is set so that `watchdog_demo_slow` warns for `long_runtime` and `watchdog_demo_retries` warns for `retry_loop`. The FAILED row for `watchdog_demo_fails` lists `watchdog_demo_succeeds` in `affected_jobs`. The system table rows for the demo jobs can say `not_found` or UNKNOWN for about an hour, until the system tables catch up. Run the job again later to see them.
- If you built the dashboard, each of its three pages shows rows.

## Troubleshooting

| You see | Cause | Fix |
|---|---|---|
| `FAIL  read system.lakeflow.<table> (required)` with an insufficient privileges or permission error | missing grants | the metastore admin grants in section 1 |
| `FAIL  read system.lakeflow.<table>` with a table, view or schema not found error | the system schema is not turned on, or the workspace is not on Unity Catalog | turn on `lakeflow` (section 1); run the Watchdog from a Unity Catalog workspace |
| `FAIL  read system.access.workspaces_latest (optional in this mode)` | the Preview table is off or not granted | fine in `current_workspace` mode (no names or links); turn it on and grant it for service principal mode |
| `FAIL  Jobs API in this workspace` | the identity cannot call the Jobs API here | check the identity's workspace access and entitlements, and any IP access list |
| `FAIL  read secret <scope>/<key>` | the scope or key does not exist, or the identity cannot read it | create the secret (section 2) and give the identity READ on the scope |
| `WARN  workspace URLs from system.access.workspaces_latest` | service principal mode cannot find workspace URLs | turn on and grant `system.access`; until then every workspace shows as unreachable |
| `WARN  service principal on <workspace>` with an authentication error | wrong application ID or secret, or an expired secret | check the two secrets in the scope; create a new OAuth secret if needed |
| `WARN  service principal on <workspace>` with a permission or not-a-member error | the service principal is not in that workspace | add it to the workspace (section 2), or ignore it if that workspace has no monitored jobs |
| `WARN  service principal on <workspace>` with a connection error or timeout | network rules block the call | see [Networking](#networking) |
| `WARN  service principal on <workspace>: the URL answered as workspace <id>` | the URL in the workspaces table points at another workspace | check `system.access.workspaces_latest` for that workspace |
| `WARN  service principal on <workspace>: no URL in system.access.workspaces_latest` | the workspaces table has no URL for it | check the table; that workspace is skipped and gets `api_unreachable` rows |
| `FAIL  service principal reaches none of the <n> workspaces tried` (or `reaches no workspaces`) | every workspace failed, or the region lists none | fix the WARN lines above it; check the secrets and that the service principal is in at least one workspace |
| `catalog is empty: type it in the catalog box at the top of the notebook, or set target.catalog in accelerator.local.yaml` | no catalog configured | type it in the `catalog` box, or fill in `accelerator.local.yaml` |
| `catalog must be letters, digits or underscores` (or `schema`) | the name has a hyphen, space or quote | use a name with only letters, digits and underscores |
| `job <name>: scheduled jobs need max_gap_minutes` (or another config error) | the YAML file has a mistake | fix the file; the message names the job and the field |
| `job <name>: enabled must be true or false` | `enabled` was quoted, for example `"false"`, or has another value | write `enabled: false` without quotes |
| `workspace <label>: ...` (workspace_id must be digits, environment is required, environment must be letters, digits, - or _, or listed twice) | an entry in the `workspaces` section is wrong | fix that entry; the message names it |
| `Cannot find the repo root above ...` | the notebook is not in the repo's `notebooks` folder | open the notebooks from the Git folder (or the deployed bundle) |
| `... is missing or unreadable (...). Run notebook 01 first.` | the Watchdog tables or the schema are not there yet | run notebook 01 |
| `... is missing columns ...: run notebook 01 once to add them` | you pulled a newer version, and the tables are from an older one | run notebook 01 (or `watchdog_phase_1`). It adds the columns and keeps your rows. A scheduled run does the same; if its `create_tables` task fails, check that task's output for a privilege error. |
| `findings_latest ... is missing or out of date: run notebook 01 once.` | the view is missing, or its columns differ from `findings` | run notebook 01. If it stops on the view, another identity owns the view: its owner runs notebook 01, or the owner drops the view and notebook 01 creates it again. |
| `FAIL  tables exist: missing ...` in notebook 07 | notebook 01 has not run with this catalog and schema | run notebook 01 |
| `FAIL  config has enabled jobs: 0 enabled` | the config is empty, or every job is disabled | edit the YAML file, then run notebook 02 |
| `FAIL  both sources wrote findings: no rows from ...` | that scan did not run, or ran with a different `scan_id` | run notebook 05 or 06; clear the `scan_id` widget in notebook 07 |
| `FAIL  every enabled job has findings: <job> (<source>)` | a scan wrote nothing for that job | re-run that scan and read its output |
| `FAIL  no duplicate keys` | a key was inserted twice | should not happen; open an issue with the output of query 41 |
| `not_found` from SYSTEM_TABLES only | the job is new (system tables are about an hour behind), the regex is wrong, or the job is in another region | wait an hour; check the regex with notebook 02; check the workspace list in notebook 00 for the region |
| `not_found` from JOBS_API only: "No job that this identity can see ... matches ..." | the identity cannot see the job (no CAN VIEW), the regex is wrong, or the job is in another workspace while you run in `current_workspace` mode | grant CAN VIEW; check the regex with notebook 02; use service principal mode for other workspaces |
| `api_unreachable` with a permission error for one job | no CAN VIEW on that job | grant CAN VIEW to the identity |
| `watchdog_scan` shows a failed `create_tables` or `load_config` | a privilege error in `create_tables`, or a mistake in the config file | grant `CREATE TABLE` and `MODIFY` on the schema to the scheduled identity, or fix the file. The two scans still run, with the config loaded last time if the load failed. Then wait for the next run or run `watchdog_phase_1`. |
| `warehouse_id is empty` (notebook 08) | no SQL warehouse is set for the dashboard | type an ID in the `warehouse_id` box, or set `target.warehouse_id` in `accelerator.local.yaml` |
| `N dashboards named 'Watchdog findings' are in <folder>` | two dashboards share the name in one folder | trash all but one in the workspace, then run notebook 08 again |
| Notebook 08 fails with a permission error when it creates or publishes | the identity cannot create dashboards in that folder, or cannot use the warehouse | grant the folder permission and `CAN USE` on the warehouse, then run it again |
| The dashboard is empty, or shows an error after a pull | no scan has written rows yet, or the view is missing or out of date | run a scan; if it shows an error, run notebook 01 |
| `workspace <label> is listed twice in <path>` | two entries repeat an ID, or two name entries differ only in case | keep one entry for each workspace |
| `teardown.sh: ... also holds other tables (...)` | the schema holds a table or view the Watchdog does not own, so `--drop-schema` stops before changing anything | move or rename those objects; if the schema holds only Watchdog objects, drop it by hand (see Cleanup) |
| `SERVICES lists these names more than once: <names>` (notebook 09) | two service entries share a name | give each service its own name |
| `service_connectivity` FAILED with an error about the client certificate | the mTLS secret scope or keys in notebook 09 cannot be read | check `MTLS_SECRET_SCOPE`, `MTLS_CERT_KEY` and `MTLS_KEY_KEY` in notebook 09, and the identity's READ access to the scope |

## System table lag

System table records arrive about an hour after the fact. The Watchdog allows for it:

- `schedule_gap` adds 60 minutes to `max_gap_minutes` before it reports a missed schedule.
- A job created in the last hour is `not_found` in the system table scan while the Jobs API scan already sees it.
- A run longer than an hour is split into hourly rows, and its result lands with the last row.

For anything that must be live, read the Jobs API rows.

## One Watchdog per region

Each region has its own metastore and its own system tables. A Watchdog sees the workspaces in its own account and region only. Check the workspace list in notebook 00 against the regions you expect, because workspace names often carry a region suffix.

For more regions, run one Watchdog in a workspace in each region, each writing to a catalog in that region, so each region's data stays in that region. Rolling results up across regions is a later phase, after your security team approves it.

## Networking

The Jobs API scan calls each workspace's public API from serverless compute in the Watchdog workspace. If your workspaces restrict inbound traffic, for example with IP access lists or private connectivity only, those calls may be refused or time out. We have not tested these setups. Talk to your network admins: you may need to allow traffic from serverless compute, or keep the scan in `current_workspace` mode in the restricted workspaces. Notebook 00 shows whether each workspace answers before you depend on it.

## Cleanup

```bash
./teardown.sh -t dev --profile <profile>                 # the Watchdog jobs and the bundle's files
./teardown.sh -t demo --profile <profile>                # also the four demo jobs
./teardown.sh -t dev --drop-schema --profile <profile>   # also the schema, its tables and the view
```

`--drop-schema` asks you to type the schema name first. Without it, the schema and its history stay.

It drops the four Watchdog tables and the `findings_latest` view. If the schema holds any other table or view, the script stops before changing anything. If the script refuses, check that the schema holds only Watchdog objects, then drop it by hand in the SQL editor. This deletes the findings history:

```sql
DROP SCHEMA <catalog>.<schema> CASCADE
```

These are not owned by the bundle. Remove them by hand when you are done:

- the dashboard "Watchdog findings": move it to the trash in the workspace (the teardown script does not delete it);
- the service principal, its OAuth secret, its workspace assignments and its CAN VIEW permissions;
- the secret scope (`databricks secrets delete-scope watchdog`);
- the grants on `system` and on your catalog;
- your copy of the monitored-jobs file and your `accelerator.local.yaml`;
- the Git folder.
