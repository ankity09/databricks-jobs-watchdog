# Phase 1 runbook

Phase 1 ends with validated findings from both sources in one table. This runbook goes role by role.
Most teams need three people, or one person with all three hats:

| Role | Does |
|---|---|
| Metastore admin (or account admin) | turns on and grants the system tables, grants the catalog |
| Workspace admin | sets up the service principal, only for checking every workspace in the region |
| Operator | clones the repo, writes the config, runs the notebooks or the bundle job |

## Before you start

Decide four things:

1. **The region.** System tables are regional: they cover the workspaces in one account and one
   cloud region. Run one Watchdog per region.
2. **The Watchdog workspace.** One Unity Catalog workspace in that region, with serverless notebooks
   and jobs. The Watchdog runs there.
3. **The catalog and schema.** Where the three tables go, for example `<catalog>.watchdog`.
4. **The mode.**
   - `current_workspace`: checks only the Watchdog workspace, with the identity running the
     notebooks. Nothing extra to set up. Start here.
   - `service_principal`: checks every workspace in the region that has jobs, signing in to each as
     a service principal. Needs the workspace admin steps below.

## 1. Metastore admin

### Turn on the system tables

The Watchdog reads `system.lakeflow` (jobs, runs, task runs) and `system.access` (workspace names and
URLs). If they are not there, an account admin turns them on for the region's metastore:

```bash
databricks system-schemas list <metastore-id>
databricks system-schemas enable <metastore-id> lakeflow
databricks system-schemas enable <metastore-id> access
```

`system.access.workspaces_latest` is in Public Preview. The Watchdog works without it in
`current_workspace` mode (findings just have no workspace names or run links), but
`service_principal` mode needs it for workspace URLs.

### Grant access

Grant to the operators, and to the identity the bundle job runs as. A group is easiest:

```sql
GRANT USE CATALOG ON CATALOG system TO `watchdog-operators`;
GRANT USE SCHEMA, SELECT ON SCHEMA system.lakeflow TO `watchdog-operators`;
GRANT USE SCHEMA, SELECT ON SCHEMA system.access TO `watchdog-operators`;

GRANT USE CATALOG, CREATE SCHEMA ON CATALOG <catalog> TO `watchdog-operators`;
```

Anyone with `SELECT` on `system.lakeflow` sees every job and run in the region, whatever the job's own
permissions say. Grant it on purpose.

If the schema already exists, grant `USE SCHEMA`, `CREATE TABLE`, `SELECT` and `MODIFY` on it instead
of `CREATE SCHEMA` on the catalog.

## 2. Workspace admin (service principal mode only)

Skip this section for `current_workspace` mode.

1. **Create a service principal** in the account console, and note its application ID.
2. **Add it to every workspace that has monitored jobs**, as a workspace user. Service principal
   mode visits every workspace in the region that has jobs. A workspace it cannot reach shows as a
   `WARN` line in notebook 00 and as `api_unreachable` rows in notebook 06; the scan carries on with
   the rest. Notebook 00 fails only if it reaches none of them.
3. **Give it CAN VIEW on each monitored job**, in every workspace. Adding it to a group that has CAN
   VIEW works too. It never needs CAN MANAGE RUN.
4. **Give it the metastore admin's grants** above, if the bundle job will run as this service
   principal.
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

Then put the scope and key names in `accelerator.local.yaml` (`auth.secret_scope`,
`auth.client_id_key`, `auth.client_secret_key`).

## 3. Operator

### Get the code

Clone this repo into a Git folder in the Watchdog workspace. [git-folder-setup.md](git-folder-setup.md)
has the steps, and how to pull updates. After a pull, restart Python on any notebook you have open, so
it loads the new code.

### Write your config

1. **The job list.** Copy `config/monitored_jobs.example.yml` somewhere outside the Git folder: your
   workspace home folder, or a Unity Catalog volume such as
   `/Volumes/<catalog>/<schema>/<volume>/monitored_jobs.yml`. Edits there never conflict with pulls.
   Replace the examples with your jobs and dependencies. The file's comments explain every field, and
   [data-model.md](data-model.md) explains how each is used.
2. **The settings.** In the repo root of your Git folder, create `accelerator.local.yaml` as a copy
   of `accelerator.yaml`, and fill in `target.catalog`, `target.schema`, `target.region`, the `auth`
   section, and `scan.monitored_jobs_path` (the path to your job list). The file is git-ignored, so
   it stays out of commits and pulls. Every notebook widget takes its default from it, and you can
   still override any widget by hand.

To write `job_name_regex` values, look at your real job names in notebook 03 (query 12) or the Jobs
page. A regex matches anywhere in the name unless you anchor it with `^` and `$`.

### Run Phase 1 by hand

Open each notebook in `notebooks/`, attach it to serverless compute, and run all cells, in order:

| Notebook | What it does | Look for |
|---|---|---|
| `00_check_access` | checks system table access, the region's workspaces and the Jobs API | every line PASS |
| `01_create_tables` | creates the schema and the three tables | three `exists: True` lines |
| `02_load_config` | loads your YAML file into the config tables, shows what each job matches | every enabled job matches a real job |
| `03_explore_system_tables` | runs the read-only system table queries | your jobs and runs, as you expect |
| `04_explore_jobs_api` | walks one job through the Jobs API calls | the newest run, its tasks, any error text |
| `05_scan_system_tables` | writes the system table findings | one row per check for each matched job |
| `06_scan_jobs_api` | writes the Jobs API findings | rows for each matched job |
| `07_validate_phase_1` | checks the result | five PASS lines |

Notebooks 05 and 06 each make their own `scan_id` when the widget is empty. Notebook 07, with its
`scan_id` empty, checks each source's newest scan, so the by-hand path validates without copying IDs.

### Or run Phase 1 as a job

From a machine with the Databricks CLI, in a clone of the repo with your `accelerator.local.yaml`:

```bash
eval "$(python3 scripts/bundle_vars.py --export accelerator.local.yaml)"
databricks bundle deploy -t dev --profile <profile>
databricks bundle run watchdog_phase_1 -t dev --profile <profile>
```

The job runs all eight notebooks on serverless compute, with one `scan_id` (the job's run ID) for
both scans. In development mode the job runs as the person who deployed it.

To try it in a workspace with no jobs worth watching, use the `demo` target. It adds two sample jobs,
one that succeeds and one whose `load` task fails on purpose. The example config already lists both.

```bash
databricks bundle deploy -t demo --profile <profile>
databricks bundle run watchdog_demo_succeeds -t demo --profile <profile>
databricks bundle run watchdog_demo_fails -t demo --profile <profile>   # fails on purpose
databricks bundle run watchdog_phase_1 -t demo --profile <profile>
```

## What success looks like

- Notebook 00 prints only PASS lines.
- Notebook 07 prints five PASS lines: tables exist, config has enabled jobs, both sources wrote
  findings, every enabled job has findings, no duplicate keys.
- `findings` has rows with `source = SYSTEM_TABLES` and `source = JOBS_API` for the same `scan_id`
  (job runs) or for each source's newest scan (by hand).
- With the demo target: `watchdog_demo_succeeds` is HEALTHY, and `watchdog_demo_fails` is FAILED with
  `load` in `failed_task_keys` and the error text in `error_summary`. The system table rows for the
  demo jobs can say `not_found` or UNKNOWN for about an hour, until the system tables catch up. Run
  the job again later to see them.

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
| `Cannot find the repo root above ...` | the notebook is not in the repo's `notebooks` folder | open the notebooks from the Git folder (or the deployed bundle) |
| `FAIL  tables exist: missing ...` in notebook 07 | notebook 01 has not run with this catalog and schema | run notebook 01 |
| `FAIL  config has enabled jobs: 0 enabled` | the config is empty, or every job is disabled | edit the YAML file, then run notebook 02 |
| `FAIL  both sources wrote findings: no rows from ...` | that scan did not run, or ran with a different `scan_id` | run notebook 05 or 06; clear the `scan_id` widget in notebook 07 |
| `FAIL  every enabled job has findings: <job> (<source>)` | a scan wrote nothing for that job | re-run that scan and read its output |
| `FAIL  no duplicate keys` | a key was inserted twice | should not happen; open an issue with the output of query 41 |
| `not_found` from SYSTEM_TABLES only | the job is new (system tables are about an hour behind), or the regex is wrong | wait an hour; check the regex with notebook 02 |
| `not_found` from JOBS_API only: "No job that this identity can see ... matches ..." | the identity cannot see the job (no CAN VIEW), the regex is wrong, or the job is in another workspace while you run in `current_workspace` mode | grant CAN VIEW; check the regex with notebook 02; use service principal mode for other workspaces |
| `api_unreachable` with a permission error for one job | no CAN VIEW on that job | grant CAN VIEW to the identity |

## System table lag

System table records arrive about an hour after the fact. The Watchdog allows for it:

- `schedule_gap` adds 60 minutes to `max_gap_minutes` before it reports a missed schedule.
- A job created in the last hour is `not_found` in the system table scan while the Jobs API scan
  already sees it.
- A run longer than an hour is split into hourly rows, and its result lands with the last row.

For anything that must be live, read the Jobs API rows.

## One Watchdog per region

Each region has its own metastore and its own system tables. A Watchdog sees the workspaces in its
own account and region only. For more regions, run one Watchdog in a workspace in each region, each
writing to a catalog in that region, so each region's data stays in that region. Rolling results up
across regions is a later phase, after your security team approves it.

## Networking

The Jobs API scan calls each workspace's public API from serverless compute in the Watchdog
workspace. If your workspaces restrict inbound traffic, for example with IP access lists or private
connectivity only, those calls may be refused or time out. We have not tested these setups. Talk to
your network admins: you may need to allow traffic from serverless compute, or keep the scan in
`current_workspace` mode in the restricted workspaces. Notebook 00 shows whether each workspace
answers before you depend on it.

## Cleanup

```bash
./teardown.sh -t dev --profile <profile>                 # the Phase 1 job and the bundle's files
./teardown.sh -t demo --profile <profile>                # also the two demo jobs
./teardown.sh -t dev --profile <profile> --drop-schema   # also the schema and its three tables
```

`--drop-schema` asks you to type the schema name first. Without it, the schema and its history stay.

These are not owned by the bundle. Remove them by hand when you are done:

- the service principal, its OAuth secret, its workspace assignments and its CAN VIEW permissions;
- the secret scope (`databricks secrets delete-scope watchdog`);
- the grants on `system` and on your catalog;
- your copy of the monitored-jobs file and your `accelerator.local.yaml`;
- the Git folder.
