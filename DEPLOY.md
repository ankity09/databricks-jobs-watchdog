# DEPLOY.md: Genie Code playbook for Watchdog Phase 1

This playbook is for Genie Code, the Databricks coding agent, running in the operator's workspace. Follow the steps in order. Do not skip step 4: nothing may be created before the operator approves.

Phase 1 is done when the operator can see validated findings from both sources (system tables and the Jobs API) in one table.

## Step 0. Read

Read these files before doing anything else:

- `README.md`: what the Watchdog is and what Phase 1 deploys.
- `DEPLOY.md`: this playbook.
- `accelerator.yaml`: the settings, with a comment on each.
- `config/monitored_jobs.example.yml`: the format of the monitored-jobs file.

## Step 1. Interview

Ask for each value **one at a time**. Offer the default where there is one, and say why the value matters.

1. **catalog** (required): the catalog that will hold the Watchdog schema. The operator needs `USE CATALOG` and `CREATE SCHEMA` on it.
2. **schema** (default `watchdog`): the schema for the three Watchdog tables.
3. **region** (required): the cloud region of this workspace's metastore, for example `us-east-2`. `SELECT current_metastore()` usually shows it in the form `<cloud>:<region>:<id>`. It is recorded on every finding.
4. **auth mode** (default `current_workspace`):
   - `current_workspace`: the Jobs API scan checks only this workspace, as the identity running the notebooks or the job.
   - `service_principal`: the Jobs API scan checks every workspace in the region that has jobs, signing in as a service principal.
5. **Service principal mode only**: the **secret scope** holding its OAuth credentials, and the **key names** for the application ID (default `client_id`) and the secret (default `client_secret`).
6. **monitored-jobs file** (default `config/monitored_jobs.example.yml`): a path to the operator's own copy, outside the Git folder, such as `/Workspace/Users/<user>/watchdog/monitored_jobs.yml` or `/Volumes/<catalog>/<schema>/<volume>/monitored_jobs.yml`. The example file is fine for a first run with the demo jobs.
7. **lookback_hours** (default `48`): how far back the system table checks look.

## Step 2. Preflight

Check what the workspace allows, **without creating or changing anything**. Notebook `notebooks/00_check_access` is read-only and covers most rows; run it with the values from step 1.

| Capability | Needed for | How to check |
|---|---|---|
| Read `system.lakeflow.jobs`, `job_run_timeline`, `job_task_run_timeline` | everything | notebook 00, section 2 |
| Read `system.access.workspaces_latest` | names and run links; required in service principal mode | notebook 00, section 2 |
| Workspaces covered in this region | knowing what the scan will see | notebook 00, section 3 |
| Create the schema in the catalog | notebook 01 | `SHOW GRANTS ON CATALOG <catalog>`: the operator, or a group they are in, has `USE CATALOG` and `CREATE SCHEMA`, or owns the catalog. If the schema already exists, they need `USE SCHEMA`, `CREATE TABLE`, `SELECT` and `MODIFY` on it. |
| Serverless compute | the notebooks and the bundle job | a notebook attaches to Serverless |
| Jobs API in this workspace | notebook 06 | notebook 00, section 4 |
| Read the secret scope | service principal mode | `dbutils.secrets.list("<scope>")` lists both keys |
| The service principal signs in to each workspace | service principal mode | notebook 00, section 4, one line per workspace |
| Read the monitored-jobs file | notebook 02 | the file opens from a notebook at the given path |

Report the results as a **capability matrix**: one row per capability, with PASS or FAIL, and for each FAIL the fix (the grant or setting from `docs/phase-1-runbook.md`) and what still works without it.

## Step 3. Write

Write the values into `accelerator.local.yaml` at the repo root: start from a copy of `accelerator.yaml` and fill in `target`, `auth` and `scan`. This file is git-ignored, so pulls from the repo never conflict with it. Never write secrets into it: only the secret scope name and key names.

## Step 4. Stop for review

Show the operator:

1. the completed `accelerator.local.yaml`;
2. the capability matrix from step 2;
3. what step 5 will create: the schema `<catalog>.<schema>` with three tables, and with the bundle path, the `watchdog_phase_1` job (plus two sample jobs with the demo target).

**Wait for the operator to approve.** Nothing has been created yet. If they change a value, update `accelerator.local.yaml` and show it again.

## Step 5. Deploy

Deploy only what preflight supports, and say clearly what was skipped and why. Pick the path the operator prefers.

**Path A: notebooks, in the workspace.** Run in order: `01_create_tables`, `02_load_config`, `03_explore_system_tables`, `04_explore_jobs_api`, `05_scan_system_tables`, `06_scan_jobs_api`. Give notebooks 05 and 06 the same `scan_id`, or leave it empty in both.

**Path B: the bundle.** From a terminal with the Databricks CLI:

```bash
eval "$(python3 scripts/bundle_vars.py --export accelerator.local.yaml)"
databricks bundle deploy -t dev --profile <profile>
databricks bundle run watchdog_phase_1 -t dev --profile <profile>
```

Use `-t demo` instead of `-t dev` to add the two sample jobs. Run `watchdog_demo_succeeds` and `watchdog_demo_fails` once before `watchdog_phase_1`; the failing job's run reports an error on purpose.

Known degradations:

| If preflight showed | Then |
|---|---|
| `system.access.workspaces_latest` unreadable | Use `current_workspace` mode. Findings have no workspace names or run links. |
| The service principal fails in some workspaces | Those workspaces get `api_unreachable` rows; the others are scanned. |
| The schema cannot be created | Stop. A catalog owner or metastore admin must grant `CREATE SCHEMA`, or create the schema and grant access to it. |
| System tables unreadable | Stop. A metastore admin must grant access to `system.lakeflow`. |

## Step 6. Verify

Run `notebooks/07_validate_phase_1` with the same `catalog` and `schema`, and the `scan_id` from step 5 (or empty, to check each source's newest scan). Print its PASS and FAIL lines. All five should pass:

1. the three tables exist;
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

System tables run about an hour behind. A job created in the last hour shows `not_found` from the system tables while the Jobs API already reports it. Run notebook 05 again later to see it.

## Step 7. Teardown

Point the operator at `teardown.sh`:

```bash
./teardown.sh -t dev --profile <profile>                   # remove the bundle's job and files
./teardown.sh -t demo --drop-schema --profile <profile>    # also the sample jobs and the Watchdog schema
```

The schema is dropped only with `--drop-schema`, after the operator types its name. A service principal, secret scope and grants created for the Watchdog are not removed by the script; list them for the operator to remove by hand.
