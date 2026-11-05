# One Watchdog per region

The Watchdog runs once in every cloud region you want to cover. This page shows how to deploy all of them from one repo: a settings file per region, one script, and a CI example.

## Why one per region

Unity Catalog system tables are regional. `system.lakeflow` in a region holds the jobs and runs of the workspaces in that region and no others. A Watchdog in one region cannot see another region's jobs. So each region gets its own Watchdog: its own schema, tables, scan jobs, Watchdog app, Lakebase job list and copilot. Each region's data stays in that region. There is no roll-up across regions.

## What each region needs

- A Unity Catalog workspace in the region, with serverless jobs.
- A catalog in that region's metastore, and a SQL warehouse in the workspace.
- Databricks Apps, Lakebase and Genie turned on in the workspace.
- A deploying identity. For CI this is a service principal that signs in with OAuth M2M. It needs:
  - `USE CATALOG` and `CREATE SCHEMA` on the catalog (or, when the schema exists, `USE SCHEMA`, `CREATE TABLE`, `SELECT` and `MODIFY` on it);
  - `CAN USE` on the SQL warehouse;
  - the right to create jobs, apps, Lakebase projects and Genie spaces;
  - `SELECT` on the `system.lakeflow` tables, and on `system.access.workspaces_latest` if you use `service_principal` mode.

[phase-1-runbook.md](phase-1-runbook.md) has the grants in detail.

## The region file

A region file is an [accelerator file](../accelerator.yaml) plus a `deploy` section. Name it `accelerator.<region>.yaml`. The part between `accelerator.` and `.yaml` is the region's name in the script's output and in `--only`.

```yaml
target:
  catalog: your_catalog
  schema: watchdog
  region: eu-west-1
  warehouse_id: your_warehouse_id     # required
auth:
  mode: current_workspace
scan:
  config_source: lakebase
app:
  name: watchdog-app
  lakebase_project_id: jobs-watchdog
deploy:
  workspace_host: https://your-workspace.example.com   # required, starts with https://
  profile: ""                         # optional
```

- `deploy.workspace_host` is the workspace where this region's Watchdog runs. A bundle target cannot take its host from a variable, so the script passes it to the CLI as `DATABRICKS_HOST`.
- `deploy.profile` is optional. With a profile, the script passes `--profile` to every command and does not set `DATABRICKS_HOST`. Without one, the script sets `DATABRICKS_HOST` from `deploy.workspace_host` and the CLI signs in with OAuth M2M (`DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET`). CI signs in the same way and takes the host from the region file, not from a CI variable. The script drops `DATABRICKS_CONFIG_PROFILE` from the environment it gives the CLI, so a profile set in your shell cannot send a region's deploy to another workspace. Whichever you choose, the profile must be for the same identity that CI deploys as (see the rule below).
- A file with no `target.warehouse_id` or no valid `deploy.workspace_host` fails before anything runs. The message names the file and the key.

[config/regions](../config/regions) holds two examples with placeholders. Real region files hold workspace details, so keep them in your own repo or a private one. A file named `accelerator.<region>.local.yaml` is git-ignored here.

## One deploying identity per region

**Deploy each region as the same identity every time.** The production target keeps the bundle's deployment state in the deploying identity's own folder. If a person deploys a region by hand and the CI service principal deploys it later (or the other way round), each identity gets its own state. The second deploy then starts a conflicting copy of the jobs and the app instead of updating the first.

So pick one identity per region, normally the CI service principal. For a run by hand, use a CLI profile that signs in as that service principal, not as yourself. Use `--validate-only` freely as anyone: it changes nothing.

## Deploy by script

```bash
python3 scripts/deploy_regions.py config/regions                          # every region, in file-name order
python3 scripts/deploy_regions.py config/regions --only prod-eu           # one region
python3 scripts/deploy_regions.py config/regions --validate-only          # validate, change nothing
python3 scripts/deploy_regions.py config/regions/accelerator.prod-eu.yaml --no-app-run
```

You need the Databricks CLI 1.23.0 or newer, PyYAML, and a sign-in for each workspace (a profile in the region file, or `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` for a service principal).

For each region, in turn, the script runs:

1. `databricks bundle validate --strict -t production`
2. the tables step (see the next section), unless you pass `--skip-ensure-tables`
3. `databricks bundle deploy -t production`
4. `databricks bundle run watchdog_app -t production`, unless you pass `--no-app-run`

`--validate-only` runs step 1 and nothing else. If a step fails, the script skips the rest of that region, carries on with the next region, prints a summary table (region, step, result) and exits 1. It exits 2 when a region file is wrong. It does not print secrets: it hides the values of credential variables and access tokens in any error text.

The `production` target uses production mode. [What production mode needs](#what-production-mode-needs) is below.

## The first deploy of a fresh region

The copilot is a Genie agent over the six Watchdog tables and views, and the bundle creates it. Genie refuses to create a space over a schema that does not exist. So a fresh region needs its tables before `bundle deploy`.

The script does this for you. Before the deploy it runs, through the SQL Statement Execution API on the region's warehouse:

1. every file in `sql/setup/`, in order. They create the schema and the five tables, and each is safe to run again.
2. each view in `sql/views/`, only when the view does not exist yet. It checks `information_schema.views` first, because replacing a view moves its owner.

Running the script again is safe. The catalog must exist already.

To do it by hand instead, run the `sql/setup/*.sql` files in order in the SQL editor with the `catalog` and `schema` parameters, then create the view from `sql/views/`, replacing `{schema}` with the catalog and schema in backticks. Then deploy with `--skip-ensure-tables`.

## What production mode needs

The CLI checks the `production` target more strictly than `dev`. Here is what it asked for:

- **A root path that is not shared.** The target deploys to `/Workspace/Users/${workspace.current_user.userName}/.bundle/${bundle.name}/${bundle.target}`, the folder of the deploying identity. A path under `/Workspace/Shared` makes `validate --strict` warn that every user can write to it. The only fix it offers is `CAN_MANAGE` for the group `users`, and that would also reach the jobs, the app and the copilot. So the target uses the deploying identity's folder and sets no permissions.
- **No `run_as`.** The jobs run as the deploying identity. This is why [one identity per region](#one-deploying-identity-per-region) matters.

If your policy needs a service principal for `run_as`, or a shared path with its own permissions, add them to the `production` target in `databricks.yml`.

## CI

[ci/gitlab-ci.example.yml](../ci/gitlab-ci.example.yml) is a GitLab CI example. It has:

- a `validate` stage on merge requests, one job per region (`parallel: matrix` over a `REGION` variable);
- a manual `deploy` stage on the default branch, one job per region;
- a GitLab environment per region, so the service principal's `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` are scoped to the region;
- a pinned Databricks CLI.

The CI service principal is the one deploying identity for each region. Do not also deploy a region by hand as a person, or the state splits (see [one identity per region](#one-deploying-identity-per-region)).

Each job runs `python3 scripts/deploy_regions.py config/regions/accelerator.$REGION.yaml`. Add a region by adding its file and its name to the two `matrix` lists.

## Remove one region

`teardown.sh` takes the region file with `-c`, and the target with `-t`:

```bash
./teardown.sh -t production -c config/regions/accelerator.prod-eu.yaml --profile <profile>
```

Run the teardown as the same identity that deployed the region, for the reason given in [one identity per region](#one-deploying-identity-per-region): the bundle state is in that identity's folder, so a teardown as anyone else does not remove what the first identity deployed. Without a profile, set `DATABRICKS_HOST` to the region's workspace and sign in as that identity first. A plain teardown deletes the jobs, the app, the Genie agent and the bundle files, and keeps the Lakebase project (with the job list) and the Watchdog schema. `--drop-lakebase` and `--drop-schema` remove those too; each asks you to type a name first. Teardown touches one region only.
