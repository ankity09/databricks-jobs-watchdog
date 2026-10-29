# DEPLOY.md: Genie Code playbook for Watchdog Phase 1

This playbook is for Genie Code, the Databricks coding agent, running in the operator's workspace. Follow the steps in order. Do not skip step 4: nothing may be created before the operator approves.

Phase 1 is done when the operator can see validated findings from both sources (system tables and the Jobs API) in one table. Phase 1.1 adds a scheduled scan and a dashboard. Both are optional, and the steps below say where they come in.

## Step 0. Read

Read these files before doing anything else:

- `README.md`: what the Watchdog is and what it deploys.
- `DEPLOY.md`: this playbook.
- `accelerator.yaml`: the settings, with a comment on each.
- `config/monitored_jobs.example.yml`: the format of the monitored-jobs file, including the optional `workspaces` section.

## Step 1. Interview

Ask for each value **one at a time**. Offer the default where there is one, and say why the value matters.

1. **catalog** (required): the catalog that will hold the Watchdog schema. The operator needs `USE CATALOG` and `CREATE SCHEMA` on it, or, when the schema already exists, `USE CATALOG` on the catalog plus `USE SCHEMA`, `CREATE TABLE`, `SELECT` and `MODIFY` on the schema.
2. **schema** (default `watchdog`): the schema for the four Watchdog tables and the `findings_latest` view.
3. **region** (required): the cloud region of this workspace's metastore, for example `us-east-2`. `SELECT current_metastore()` usually shows it in the form `<cloud>:<region>:<id>`. It is recorded on every finding. A Watchdog sees only the workspaces in its own region, so run one per region.
4. **auth mode** (default `current_workspace`):
   - `current_workspace`: the Jobs API scan checks only this workspace, as the identity running the notebooks or the job.
   - `service_principal`: the Jobs API scan checks every workspace in the region that has jobs, signing in as a service principal.
5. **Service principal mode only**: the **secret scope** holding its OAuth credentials, and the **key names** for the application ID (default `client_id`) and the secret (default `client_secret`).
6. **monitored-jobs file** (default `config/monitored_jobs.example.yml`): a path to the operator's own copy, outside the Git folder, such as `/Workspace/Users/<user>/watchdog/monitored_jobs.yml` or `/Volumes/<catalog>/<schema>/<volume>/monitored_jobs.yml`. The example file is fine for a first run with the demo jobs. Ask whether any test copies should be excluded (`job_name_exclude_regex`) and whether workspaces should get environment labels (the `workspaces` section).
7. **lookback_hours** (default `48`): how far back the system table checks look.
8. **code_version_tag** (default `code_version`): the name of the job tag whose value is the deployed code version. Findings show that value when the job has the tag, so a CI pipeline that tags each deploy makes version changes visible.
9. **Schedule** (default `0 0/20 * * * ?`, every 20 minutes in UTC, and `schedule_status` `PAUSED`): keep it paused until the first `watchdog_phase_1` run has passed. Then `UNPAUSED` turns the scan on.
10. **warehouse_id** (optional): a SQL warehouse for the dashboard (notebook 08). Skip it if the operator does not want a dashboard yet.

## Step 2. Preflight

Check what the workspace allows, **without creating or changing anything**. Notebook `notebooks/00_check_access` is read-only and covers most rows; run it with the values from step 1.

| Capability | Needed for | How to check |
|---|---|---|
| Read `system.lakeflow.jobs`, `job_run_timeline`, `job_task_run_timeline` | everything | notebook 00, section 2 |
| Read `system.access.workspaces_latest` | names and run links; required in service principal mode | notebook 00, section 2 |
| Workspaces covered in this region | knowing what the scan will see, and whether a Watchdog is needed in another region | notebook 00, section 3. Check the names: workspace names often carry a region suffix. |
| Create the schema in the catalog | notebook 01 | `SHOW GRANTS ON CATALOG <catalog>`: the operator, or a group they are in, has `USE CATALOG` and `CREATE SCHEMA`, or owns the catalog. If the schema already exists, they need `USE SCHEMA`, `CREATE TABLE`, `SELECT` and `MODIFY` on it. |
| Tables from an earlier version | every scheduled run, and notebooks 02, 05, 06 and 09 | `SHOW TABLES IN <catalog>.<schema>`. Notebook 01 adds any missing columns and keeps the rows. Each scheduled run runs it first, so a new schema needs nothing. |
| Create and alter tables and views in the schema | notebook 01, which every scheduled run also runs | the identity that runs the job or notebooks has `CREATE TABLE` and `MODIFY` on the schema, or owns it |
| Serverless compute | the notebooks and the bundle job | a notebook attaches to Serverless |
| Jobs API in this workspace | notebook 06 | notebook 00, section 4 |
| Read the secret scope | service principal mode | `dbutils.secrets.list("<scope>")` lists both keys |
| The service principal signs in to each workspace | service principal mode | notebook 00, section 4, one line per workspace |
| Read the monitored-jobs file | notebook 02 | the file opens from a notebook at the given path |
| A SQL warehouse the operator can use | the dashboard (notebook 08), optional | `databricks warehouses list`, then check that the operator has `CAN USE` on the chosen warehouse |
| Permission to create dashboards in the folder | the dashboard (notebook 08), optional | check the folder's permissions. Do not create a dashboard for the check. |
| A Git checkout of the repo | the demo target's `code_version` tags, optional | `git status` in the repo works. `bundle.git.branch` and `bundle.git.commit` need it. |

Report the results as a **capability matrix**: one row per capability, with PASS or FAIL, and for each FAIL the fix (the grant or setting from `docs/phase-1-runbook.md`) and what still works without it.

## Step 3. Write

Write the values into `accelerator.local.yaml` at the repo root: start from a copy of `accelerator.yaml` and fill in `target`, `auth` and `scan`, and `target.warehouse_id` if the dashboard is wanted. This file is git-ignored, so pulls from the repo never conflict with it. Never write secrets into it: only the secret scope name and key names.

## Step 4. Stop for review

Show the operator:

1. the completed `accelerator.local.yaml`;
2. the capability matrix from step 2;
3. what step 5 will create: the schema `<catalog>.<schema>` with four tables and the view `findings_latest`. With the bundle path, the `watchdog_phase_1` job and the `watchdog_scan` job, which is created paused. With the demo target, four sample jobs as well. The dashboard is created only if the operator runs notebook 08.

**Wait for the operator to approve.** Nothing has been created yet. If they change a value, update `accelerator.local.yaml` and show it again.

## Step 5. Deploy

Deploy only what preflight supports, and say clearly what was skipped and why. Pick the path the operator prefers.

**Path A: notebooks, in the workspace.** Run in order: `01_create_tables`, `02_load_config`, `03_explore_system_tables`, `04_explore_jobs_api`, `05_scan_system_tables`, `06_scan_jobs_api`. Give notebooks 05 and 06 the same `scan_id`, or leave it empty in both. If the operator wants a dashboard, run `08_create_dashboard` after the scans, with the warehouse ID in its `warehouse_id` box.

**Path B: the bundle.** From a terminal with the Databricks CLI:

```bash
eval "$(python3 scripts/bundle_vars.py --export accelerator.local.yaml)"
databricks bundle deploy -t dev --profile <profile>
databricks bundle run watchdog_phase_1 -t dev --profile <profile>
```

Use `-t demo` instead of `-t dev` to add the four sample jobs. Run `watchdog_demo_succeeds`, `watchdog_demo_fails`, `watchdog_demo_slow` and `watchdog_demo_retries` once before `watchdog_phase_1`. `watchdog_demo_fails` reports an error on purpose.

`watchdog_phase_1` checks access, creates or upgrades the tables and the view, and validates the setup, so run it before anything else. The scheduled scan `watchdog_scan` is deployed paused. Leave it paused until `watchdog_phase_1` has passed in this workspace. To turn it on, set `scan.schedule_status` to `UNPAUSED` in `accelerator.local.yaml`, run the `eval` line again, and deploy again. Each scheduled run then brings the tables up to date itself.

Known degradations:

| If preflight showed | Then |
|---|---|
| `system.access.workspaces_latest` unreadable | Use `current_workspace` mode. Findings have no workspace names or run links. |
| The service principal fails in some workspaces | Those workspaces get `api_unreachable` rows; the others are scanned. |
| No SQL warehouse, or no permission to create dashboards | Skip notebook 08. The scans and the schedule do not need it. |
| Tables from an earlier version | Run `watchdog_phase_1` once before you unpause the schedule. Each scheduled run then upgrades the tables itself. A privilege error in `create_tables` means the scheduled identity lacks `CREATE TABLE` or `MODIFY` on the schema. |
| The schema cannot be created | Stop. A catalog owner or metastore admin must grant `CREATE SCHEMA`, or create the schema and grant access to it. |
| System tables unreadable | Stop. A metastore admin must grant access to `system.lakeflow`. |

## Step 6. Verify

Run `notebooks/07_validate_phase_1` with the same `catalog` and `schema`, and the `scan_id` from step 5 (or empty, to check each source's newest scan). Print its PASS and FAIL lines. All five should pass:

1. the four tables and the `findings_latest` view exist (`monitored_jobs`, `job_dependencies`, `monitored_workspaces`, `findings`, `findings_latest`);
2. the config has enabled jobs;
3. both sources wrote findings;
4. every enabled job has findings from each source;
5. no findings key appears twice.

Then show a sample of the results:

```sql
SELECT job_name, workspace_name, check_id, status, severity, error_summary, affected_jobs, source
FROM <catalog>.<schema>.findings
WHERE scan_id = '<scan_id>'
ORDER BY status, job_name, check_id
```

For the current status of every check, query `<catalog>.<schema>.findings_latest` with the same columns and no `scan_id` filter.

System tables run about an hour behind. A job created in the last hour shows `not_found` from the system tables while the Jobs API already reports it. Run notebook 05 again later to see it.

## Step 7. Teardown

Point the operator at `teardown.sh`:

```bash
./teardown.sh -t dev --profile <profile>                   # remove the bundle's jobs and files
./teardown.sh -t demo --drop-schema --profile <profile>    # also the sample jobs and the Watchdog schema
```

The schema is dropped only with `--drop-schema`, after the operator types its name. It drops the four tables and the `findings_latest` view. If the schema holds any other table, the script stops before changing anything. The script does not delete the dashboard from notebook 08: the operator moves it to the trash in the workspace. A service principal, secret scope and grants created for the Watchdog are not removed either; list them for the operator to remove by hand. If the script refuses, the [runbook's cleanup section](docs/phase-1-runbook.md#cleanup) has a manual fallback.
