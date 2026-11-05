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
2. **schema** (default `watchdog`): the schema for the six Watchdog tables and the `findings_latest` view.
3. **region** (required): the cloud region of this workspace's metastore, for example `us-east-2`. `SELECT current_metastore()` usually shows it in the form `<cloud>:<region>:<id>`. It is recorded on every finding. A Watchdog sees only the workspaces in its own region, so run one per region ([docs/multi-region.md](docs/multi-region.md) shows how to deploy several from one repo).
4. **auth mode** (default `current_workspace`):
   - `current_workspace`: the Jobs API scan checks only this workspace, as the identity running the notebooks or the job.
   - `service_principal`: the Jobs API scan checks every workspace in the region that has jobs, signing in as a service principal.
5. **Service principal mode only**: the **secret scope** holding its OAuth credentials, and the **key names** for the application ID (default `client_id`) and the secret (default `client_secret`).
6. **monitored-jobs file** (default `config/monitored_jobs.example.yml`): a path to the operator's own copy, outside the Git folder, such as `/Workspace/Users/<user>/watchdog/monitored_jobs.yml` or `/Volumes/<catalog>/<schema>/<volume>/monitored_jobs.yml`. The example file is fine for a first run with the demo jobs. Ask whether any test copies should be excluded (`job_name_exclude_regex`, which the example sets for every job in `defaults`), whether workspaces should get environment labels (the `workspaces` section), and whether any job needs other settings in one environment, such as a lower severity or no checks in lower environments (the job's `environments` section). If other regions run different jobs, each region's Watchdog needs its own file: a job that runs in no workspace of this region gets a `not_found` row here.
7. **lookback_hours** (default `48`): how far back the system table checks look.
8. **code_version_tag** (default `code_version`): the name of the job tag whose value is the deployed code version. Findings show that value when the job has the tag, so a CI pipeline that tags each deploy makes version changes visible.
   **pipeline_url_parameter** (default `PIPELINE_URL`): the name of the job parameter that holds the link to the CI pipeline that deployed the job. Findings show it as `pipeline_url`.
9. **Schedule** (default `0 0/20 * * * ?`, every 20 minutes in UTC, and `schedule_status` `PAUSED`): keep it paused until the first `watchdog_phase_1` run has passed. Then `UNPAUSED` turns the scan on, and the daily cleanup job with it.
10. **retention_days** (default 30): the daily `watchdog_cleanup` job deletes findings scans older than this many days, always keeping each source's newest scan. 0 keeps everything. Ask how long the operator wants the history.
11. **warehouse_id** (required): the SQL warehouse the Watchdog app, its copilot and the dashboard (notebook 08) read findings through, and that `scripts/ensure_tables.py` creates the tables through. It must be a Pro or Serverless warehouse: the copilot's Genie agent needs one, and with a Classic warehouse the first `bundle deploy` fails at the agent. The operator needs `CAN USE` on it, and so does everyone who will use the app.
12. **The app** (defaults `watchdog-app`, `jobs-watchdog` and `users`): `app.name` and `app.lakebase_project_id`, each unique in the workspace, and `app.users_group`, the workspace group whose members may open the app and ask its copilot. Ask whether the scan should read the job list from the app (`scan.config_source: lakebase`) or from the YAML file (`yaml`, the default). With `lakebase`, keep the schedule paused until the app holds the job list.

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
| A Pro or Serverless SQL warehouse the operator can use | the app, the copilot (its Genie agent refuses a Classic warehouse), the tables step and the dashboard | `databricks warehouses list -o json`: the chosen warehouse's `warehouse_type` is not `CLASSIC`; then check that the operator has `CAN USE` on it |
| Databricks Apps, Lakebase and Genie | the Watchdog app, its job list and its copilot | the workspace's Apps, Lakebase and Genie pages open, and the operator may create an app, a Lakebase project and a Genie space |
| User authorization for apps | Monitoring, the job picker and the copilot, which run as the person | the workspace admin settings allow apps the `sql` and `dashboards.genie` scopes |
| Users' grants | everyone who opens the app | the grants in [docs/multi-region.md](docs/multi-region.md#who-can-use-the-app); list who still needs them |
| Permission to create dashboards in the folder | the dashboard (notebook 08), optional | check the folder's permissions. Do not create a dashboard for the check. |
| A Git checkout of the repo | the demo target's `code_version` tags, optional | `git status` in the repo works. `bundle.git.branch` and `bundle.git.commit` need it. |

Report the results as a **capability matrix**: one row per capability, with PASS or FAIL, and for each FAIL the fix (the grant or setting from `docs/phase-1-runbook.md`) and what still works without it.

## Step 3. Write

Write the values into `accelerator.local.yaml` at the repo root: start from a copy of `accelerator.yaml` and fill in `target` (with `warehouse_id`), `auth`, `scan` and `app`. This file is git-ignored, so pulls from the repo never conflict with it. Never write secrets into it: only the secret scope name and key names.

## Step 4. Stop for review

Show the operator:

1. the completed `accelerator.local.yaml`;
2. the capability matrix from step 2;
3. what step 5 will create: the schema `<catalog>.<schema>` with six tables and the view `findings_latest`. With the bundle path, also the `watchdog_phase_1` and `watchdog_app_access` jobs, the `watchdog_scan` and `watchdog_cleanup` jobs (created paused), the Watchdog app, its Lakebase project and the copilot's Genie agent, which the `app.users_group` group may use. With the demo target, four sample jobs as well. The dashboard is created only if the operator runs notebook 08.

**Wait for the operator to approve.** Nothing has been created yet. If they change a value, update `accelerator.local.yaml` and show it again.

## Step 5. Deploy

Deploy only what preflight supports, and say clearly what was skipped and why. Pick the path the operator prefers.

**Path A: notebooks, in the workspace.** Run in order: `01_create_tables`, `02_load_config`, `05_scan_system_tables`, `06_scan_jobs_api`. The read-only notebooks in `notebooks/explore` (03 and 04) are optional, for looking at the raw data. Give notebooks 05 and 06 the same `scan_id`, or leave it empty in both. If the operator wants a dashboard, run `08_create_dashboard` after the scans, with the warehouse ID in its `warehouse_id` box.

**Path B: the bundle.** From a terminal with the Databricks CLI:

```bash
python3 scripts/ensure_tables.py accelerator.local.yaml --profile <profile>
eval "$(python3 scripts/bundle_vars.py --export accelerator.local.yaml)"
databricks bundle deploy -t dev --profile <profile>
databricks bundle run watchdog_app -t dev --profile <profile>
databricks bundle run watchdog_phase_1 -t dev --profile <profile>
```

`scripts/ensure_tables.py` creates the schema, the tables and the view through the warehouse first: the bundle creates the copilot's Genie agent over them, and Genie refuses a schema that does not exist. `bundle run watchdog_app` deploys the app's code and starts it. Use `-t demo` instead of `-t dev` to add the four sample jobs. Run `watchdog_demo_succeeds`, `watchdog_demo_fails`, `watchdog_demo_slow` and `watchdog_demo_retries` once before `watchdog_phase_1`. `watchdog_demo_fails` reports an error on purpose.

`watchdog_phase_1` checks access, creates or upgrades the tables and the view, and validates the setup, so run it before anything else. The scheduled scan `watchdog_scan` and the daily `watchdog_cleanup` job are deployed paused. Leave them paused until `watchdog_phase_1` has passed in this workspace. To turn it on, set `scan.schedule_status` to `UNPAUSED` in `accelerator.local.yaml`, run the `eval` line again, and deploy again. Each scheduled run then brings the tables up to date itself.

Known degradations:

| If preflight showed | Then |
|---|---|
| `system.access.workspaces_latest` unreadable | Use `current_workspace` mode. Findings have no workspace names or run links. |
| The service principal fails in some workspaces | Those workspaces get `api_unreachable` rows; the others are scanned. |
| No SQL warehouse, or no permission to create dashboards | Skip notebook 08. The scans and the schedule do not need it. |
| Tables from an earlier version | Run `watchdog_phase_1` once before you unpause the schedule. Each scheduled run then upgrades the tables itself. A privilege error in `create_tables` means the scheduled identity lacks `CREATE TABLE` or `MODIFY` on the schema. |
| The schema cannot be created | Stop. A catalog owner or metastore admin must grant `CREATE SCHEMA`, or create the schema and grant access to it. |
| System tables unreadable | Stop. A metastore admin must grant access to `system.lakeflow`. |

## Step 6. Install the app

The bundle deploys the Watchdog app, its Lakebase project and the copilot's Genie agent in step 5. This step puts your job list in the app and points the scan at it. [docs/app.md](docs/app.md) explains the app.

**Prerequisites.** Check these before step 5, and report any that fail:

- Databricks Apps, Lakebase and Genie are turned on in the workspace, and the operator may create an app, a Lakebase project and a Genie space.
- User authorization for apps is on, with the `sql` and `dashboards.genie` scopes allowed. A workspace admin sets this. The app cannot start without it, and it has no fallback.
- `target.warehouse_id` names a Pro or Serverless SQL warehouse. A Classic warehouse fails the first deploy at the Genie agent.
- The schema and its tables exist before the first `bundle deploy`, because the Genie agent cannot be created over a schema that does not exist. `scripts/ensure_tables.py` does this (step 5, path B). It is safe to run again.
- The people who will use the app have the grants in [Who can use the app](docs/multi-region.md#who-can-use-the-app): access to the app (the bundle gives `CAN USE` to `app.users_group`), `CAN USE` on the warehouse, `SELECT` on the Watchdog schema, and `SELECT` on `system.lakeflow.jobs` and `system.access.workspaces_latest` for the job picker. Without these, Monitoring and the picker show a message that names the missing table.
- Serverless compute can install `psycopg` from PyPI or your package mirror. The scan needs it only when it reads the job list from the app.

**A fresh workspace.** The first deploy into a workspace that has never had a Watchdog needs `target.warehouse_id` set (the deploy fails without it), the tables created first (above), and the app's name and Lakebase project ID to be free: they must be unique in the workspace, so there is one install per workspace.

**The steps, in order.**

1. Set `target.warehouse_id` in `accelerator.local.yaml`.
2. Deploy, then start the app. Step 5, path B, runs these commands; the two that matter here are:

   ```bash
   databricks bundle deploy -t dev --profile <profile>
   databricks bundle run watchdog_app -t dev --profile <profile>
   ```

   `bundle run watchdog_app` deploys the app's code and starts it. The platform installs the app's packages and builds it, so the workspace needs access to an npm registry or a mirror. The first start creates the app's Lakebase schema.
3. Open the app (the `watchdog_app` link in the Apps page) and go to Jobs and dependencies, then Job list. Click Import YAML, choose your monitored-jobs file, read the preview of the differences, and confirm. A file that breaks a rule is not imported, and the message names the job and the field.
4. Set `scan.config_source: lakebase` in `accelerator.local.yaml`, run the `eval "$(python3 scripts/bundle_vars.py --export accelerator.local.yaml)"` line again, and deploy again. Run `watchdog_scan` once, or click Scan now in the app. The banner on the Job list should clear, and the `config_loads` table should have an `OK` row with `source` `lakebase`. Keep `scan.schedule_status` at `PAUSED` until the app holds the job list: with `lakebase`, a scan fails at its first step until it does.

Until step 4, the scan keeps reading the YAML file, and the app says so in a banner. To go back, set `scan.config_source` to `yaml` and deploy again. Export YAML in the app gives you the newest list as a file.

**Teardown and a redeploy.** Step 8 has the commands.

- A plain teardown deletes the app, the Genie agent (and everyone's copilot conversations) and the jobs. It keeps the Lakebase project with the job list.
- `--drop-lakebase` also deletes the project and the job list, after the operator types the project ID. Export the list first if you want it.
- A redeploy after a plain teardown needs a second step: the new app has a new service principal, and it cannot use the kept job list until it gets access. Teardown prints the commands: bind the kept Lakebase resources, deploy, run the app, then run `databricks bundle run watchdog_app_access -t <target>`. [Deploy again after a teardown](docs/multi-region.md#deploy-again-after-a-teardown) explains each one. Say plainly to the operator that a full teardown and redeploy has not been run end to end. The grant, the access check and the cache-schema step were tested piece by piece on Lakebase branches, and the page lists the checks to run after the first real redeploy.

## Step 7. Verify

Run `notebooks/07_validate_phase_1` with the same `catalog` and `schema`, and the `scan_id` from step 5 (or empty, to check each source's newest scan). Print its PASS and FAIL lines. All five should pass:

1. the six tables and the `findings_latest` view exist (`monitored_jobs`, `job_dependencies`, `monitored_workspaces`, `monitored_job_environments`, `findings`, `config_loads`, `findings_latest`);
2. the config has enabled jobs (switched on in at least one environment);
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

## Step 8. Teardown

Point the operator at `teardown.sh`:

```bash
./teardown.sh -t dev --profile <profile>                   # remove the jobs, the app, the Genie agent and the files
./teardown.sh -t demo --drop-schema --profile <profile>    # also the sample jobs and the Watchdog schema
```

A plain teardown keeps the Lakebase project with the job list, and prints how to deploy again with it ([docs/multi-region.md](docs/multi-region.md#deploy-again-after-a-teardown)); `--drop-lakebase` deletes it, after the operator types its name. The schema is dropped only with `--drop-schema`, after the operator types its name. It drops the six tables and the `findings_latest` view. If the schema holds any other table, the script stops before changing anything. The script does not delete the dashboard from notebook 08: the operator moves it to the trash in the workspace. A service principal, secret scope and grants created for the Watchdog are not removed either; list them for the operator to remove by hand. If the script refuses, the [runbook's cleanup section](docs/phase-1-runbook.md#cleanup) has a manual fallback.
