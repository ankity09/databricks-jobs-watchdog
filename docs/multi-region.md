# One Watchdog per region

The Watchdog runs once in every cloud region you want to cover. This page shows how to deploy all of them from one repo: a settings file per region, one script, and a CI example.

## Why one per region

Unity Catalog system tables are regional. `system.lakeflow` in a region holds the jobs and runs of the workspaces in that region and no others. A Watchdog in one region cannot see another region's jobs. So each region gets its own Watchdog: its own schema, tables, scan jobs, Watchdog app, Lakebase job list and copilot. Each region's data stays in that region. There is no roll-up across regions.

## What each region needs

- A Unity Catalog workspace in the region, with serverless jobs.
- A catalog in that region's metastore, and a SQL warehouse in the workspace.
- Databricks Apps, Lakebase and Genie turned on in the workspace.
- User authorization for apps, with the `sql` and `dashboards.genie` scopes allowed (see [Who can use the app](#who-can-use-the-app)).
- Serverless compute that can install `psycopg` from PyPI or your package mirror, when the scan reads the job list from the app (`scan.config_source: lakebase`), and for the `watchdog_app_access` job, which a deploy runs only after a teardown or a new `app.name`. A region without PyPI deploys and scans in YAML mode.
- A deploying identity. For CI this is a service principal that signs in with OAuth M2M. It needs:
  - `USE CATALOG` and `CREATE SCHEMA` on the catalog (or, when the schema exists, `USE SCHEMA`, `CREATE TABLE`, `SELECT` and `MODIFY` on it);
  - `CAN USE` on the SQL warehouse;
  - the right to create jobs, apps, Lakebase projects and Genie spaces;
  - `SELECT` on the `system.lakeflow` tables, and on `system.access.workspaces_latest` if you use `service_principal` mode.

[phase-1-runbook.md](phase-1-runbook.md) has the grants in detail.

## Who can use the app

The bundle grants `CAN USE` on the Watchdog app, and `CAN RUN` on the copilot's Genie agent, to the workspace group in `app.users_group` (default `users`, every user). Set it to a smaller group to limit who can open the app.

Monitoring, the job picker and the copilot run their queries as the person using the app, so each person sees only what Unity Catalog lets them see. So each person, or a group they are in, also needs:

- `CAN USE` on the SQL warehouse in `target.warehouse_id`;
- `USE CATALOG` on the catalog, and `USE SCHEMA` and `SELECT` on the Watchdog schema. The deploying identity created the schema, so it owns it and can grant these;
- `USE CATALOG` on `system`, `USE SCHEMA` on `system.lakeflow` and `system.access`, and `SELECT` on `system.lakeflow.jobs` (the job picker) and `system.access.workspaces_latest` (workspace names). A metastore admin grants these.

Saving the job list needs nothing more: the app's service principal reads and writes it in Lakebase.

```sql
GRANT USE CATALOG ON CATALOG <catalog> TO `<group>`;
GRANT USE SCHEMA, SELECT ON SCHEMA <catalog>.<schema> TO `<group>`;
-- as a metastore admin
GRANT USE CATALOG ON CATALOG system TO `<group>`;
GRANT USE SCHEMA ON SCHEMA system.lakeflow TO `<group>`;
GRANT USE SCHEMA ON SCHEMA system.access TO `<group>`;
GRANT SELECT ON TABLE system.lakeflow.jobs TO `<group>`;
GRANT SELECT ON TABLE system.access.workspaces_latest TO `<group>`;
```

```bash
databricks warehouses update-permissions <warehouse_id> --profile <profile> \
  --json '{"access_control_list": [{"group_name": "<group>", "permission_level": "CAN_USE"}]}'
```

**User authorization is required.** The app declares the user scopes `sql` and `dashboards.genie`. A workspace admin chooses which scopes apps may use; if these are not allowed, the app cannot be deployed or started. The app has no fallback that runs these queries as its service principal. AppKit's per-person queries and its Genie plugin refuse a request without the person's token, and running them as the service principal would show every user what the service principal can read, which defeats Unity Catalog's per-person access. (The design planned such a fallback while user authorization was in preview. It is not built, for that reason.)

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
  schedule_status: PAUSED             # unpause once the app holds your job list
app:
  name: watchdog-app
  lakebase_project_id: jobs-watchdog
  users_group: users                  # who may open the app
deploy:
  workspace_host: https://your-workspace.example.com   # required, starts with https://
  profile: ""                         # optional
```

- `deploy.workspace_host` is the workspace where this region's Watchdog runs. A bundle target cannot take its host from a variable, so the script passes it to the CLI as `DATABRICKS_HOST`.
- `deploy.profile` is optional. With a profile, the script passes `--profile` to every command and does not set `DATABRICKS_HOST`. Without one, the script sets `DATABRICKS_HOST` from `deploy.workspace_host` and the CLI signs in with OAuth M2M (`DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET`). CI signs in the same way and takes the host from the region file, not from a CI variable. The script drops `DATABRICKS_CONFIG_PROFILE` from the environment it gives the CLI, so a profile set in your shell cannot send a region's deploy to another workspace. Whichever you choose, the profile must be for the same identity that CI deploys as (see the rule below).
- A file with no `target.warehouse_id` or no valid `deploy.workspace_host` fails before anything runs. The message names the file and the key.
- With `config_source: lakebase`, every scan fails at its first step (load the job list) until the app holds a job list. So the examples ship with the schedule paused: deploy, import or add your jobs in the app, then set `schedule_status: UNPAUSED` and deploy again.

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
5. `databricks bundle run watchdog_app_access -t production`, when the deploy gave the app a new service principal and the Lakebase project was there before it: after a plain teardown, or a new `app.name`. It gives the new app access to the job list the project kept (see [Deploy again after a teardown](#deploy-again-after-a-teardown)). The script asks the CLI for the app's service principal before and after the deploy, and whether the project exists, and on any other deploy it prints `app access not needed` with the reason, as the app owns its schema. `--skip-app-access` always leaves the step out. If the step fails, for example because serverless cannot reach PyPI, run `databricks bundle run watchdog_app_access -t production` once it can: the next deploy does not run it again, since the service principal no longer changes.

`--validate-only` runs step 1 and nothing else. If a step fails, the script skips the rest of that region, carries on with the next region, prints a summary table (region, step, result) and exits 1. It exits 2 when a region file is wrong. It does not print secrets: it hides the values of credential variables and access tokens in any error text.

The `production` target uses production mode. [What production mode needs](#what-production-mode-needs) is below.

## The first deploy of a fresh region

The copilot is a Genie agent over the six Watchdog tables and views, and the bundle creates it. Genie refuses to create a space over a schema that does not exist. So a fresh region needs its tables before `bundle deploy`.

The script does this for you. Before the deploy it runs, through the SQL Statement Execution API on the region's warehouse:

1. every file in `sql/setup/`, in order. They create the schema and the six tables, and each is safe to run again.
2. each view in `sql/views/`, only when the view does not exist yet. It checks `information_schema.views` first, because replacing a view moves its owner.

Running the script again is safe. The catalog must exist already.

A single workspace deployed without a region file gets the same step from `python3 scripts/ensure_tables.py accelerator.local.yaml --profile <profile>`, before its first `bundle deploy`.

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

GitLab passes protected variables only to pipelines on protected branches and tags, so a merge request never sees the deploy secret. The example's validate jobs therefore sign in with a second, validate-only service principal (`VALIDATE_CLIENT_ID` and `VALIDATE_CLIENT_SECRET`, masked but not protected), which only needs to read the workspace. They set `DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET` to those values on the script's command line, not in the job's `variables:` block: a variable set in Settings outranks a job's `variables:`, so the deploy principal's ID would go out with the validate secret and sign-in would fail. If you would rather not have a second principal, drop that prefix and the merge request rule, and validate on the default branch only.

Each job runs `python3 scripts/deploy_regions.py config/regions/accelerator.$REGION.yaml`. Add a region by adding its file and its name to the two `matrix` lists.

## Remove one region

`teardown.sh` takes the region file with `-c`, and the target with `-t`:

```bash
./teardown.sh -t production -c config/regions/accelerator.prod-eu.yaml --profile <profile>
```

Every call goes to the file's `deploy.workspace_host`, and the prompts name that workspace. If `DATABRICKS_HOST`, the `--profile`, the file's `deploy.profile` or `DATABRICKS_CONFIG_PROFILE` points at another workspace, teardown stops before it changes anything. To check a profile it reads the CLI's config file (`DATABRICKS_CONFIG_FILE`, else `~/.databrickscfg`) with Python; if Python cannot read that file (a key twice in one section, or a key before the first section), teardown says so and stops, and without a profile it does not read the file. Without a profile it sets `DATABRICKS_HOST` from the file, and the CLI signs in with OAuth M2M (`DATABRICKS_CLIENT_ID` and `DATABRICKS_CLIENT_SECRET`).

Run the teardown as the same identity that deployed the region, for the reason given in [one identity per region](#one-deploying-identity-per-region): the bundle state is in that identity's folder, so a teardown as anyone else does not remove what the first identity deployed. A plain teardown deletes the jobs, the app, the Genie agent with everyone's copilot conversations, and the bundle files, and keeps the Lakebase project (with the job list) and the Watchdog schema. `--drop-lakebase` and `--drop-schema` remove those too; each asks you to type a name first.

## Deploy again after a teardown

A plain teardown deletes the app and its service principal, but keeps the Lakebase project with the job list. Lakebase hands the app's `watchdog_app` schema to the identity that ran the teardown. The next deploy creates the app again with a new service principal, which cannot use that schema until it gets access. Changing `app.name` after a deploy replaces the app in the same way. To deploy again with the list kept, as the identity that ran the teardown:

1. Bind the kept Lakebase resources to the bundle again. Teardown prints the three `databricks bundle deployment bind` commands at the end; without them the next deploy fails on the project that already exists.
2. Deploy and start the app: `databricks bundle deploy -t <target>`, then `databricks bundle run watchdog_app -t <target>`.
3. Give the new service principal access: `databricks bundle run watchdog_app_access -t <target>`. The job runs notebook 11, which grants it `USAGE` and `CREATE` on `watchdog_app` and `SELECT` and `INSERT` on its tables. It changes nothing when the app already has access. AppKit's query cache lives in its own schema, `appkit`, which changes hands too, and grants cannot fix it: AppKit's start runs `CREATE INDEX IF NOT EXISTS` on its table, which only the owner may run, and you cannot make the app's role the owner. So the job drops `appkit` when someone else owns it; the app creates it again at its next start and caches query results in memory until then.

`scripts/deploy_regions.py` does steps 2 and 3 for each region. Until step 3, the app's job list says "The app has no access to its job list in Lakebase", and the app log names the job. The app tries again on each request, so it needs no restart. The scans keep reading the list meanwhile, because they run as the deploying identity.

If notebook 11 says the schema belongs to another role (the old app's service principal, when Lakebase did not hand the schema over), a Lakebase admin deletes that role and gives its objects to you, for example `databricks postgres delete-role <branch>/roles/dbrx-apps-<old client ID> --reassign-owned-to "<your Postgres role>"`. Then run step 3 again.
