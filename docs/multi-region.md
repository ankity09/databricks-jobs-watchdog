# One Watchdog per region

The Watchdog runs once in every cloud region you want to cover. This page shows how to deploy all of them from one repo: a settings file per region, one script, and a CI example.

## Why one per region

Unity Catalog system tables are regional. `system.lakeflow` in a region holds the jobs and runs of the workspaces in that region and no others. A Watchdog in one region cannot see another region's jobs. So each region gets its own Watchdog: its own schema, tables, scan jobs, Watchdog app, Lakebase job list and copilot. Each region's data stays in that region. There is no roll-up across regions.

## What each region needs

- A Unity Catalog workspace in the region, with serverless jobs.
- A catalog in that region's metastore, and a SQL warehouse in the workspace.
- Databricks Apps, Lakebase and Genie turned on in the workspace.
- User authorization for apps, with the `sql` and `dashboards.genie` scopes allowed (see [Who can use the app](#who-can-use-the-app)).
- Serverless compute that can install `pg8000`, a pure-Python Postgres driver, from PyPI or your package mirror, when the scan reads the job list from the app (`scan.config_source: lakebase`), and for the `watchdog_app_access` job, which a deploy runs only after a teardown or a new `app.name`. A region without PyPI deploys and scans in YAML mode.
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
  warehouse_id: your_warehouse_id     # required: a Pro or Serverless SQL warehouse (the Genie agent needs one)
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
- With `config_source: lakebase`, every scan's `load_config` task (the second task) fails until the app holds a job list. So the examples ship with the schedule paused: deploy, import or add your jobs in the app, then set `schedule_status: UNPAUSED` and deploy again.

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

The copilot is a Genie agent over five Watchdog tables (`findings`, `monitored_jobs`, `job_dependencies`, `monitored_workspaces` and `monitored_job_environments`) and the `findings_latest` view, and the bundle creates it. Genie refuses to create a space over a schema that does not exist. So a fresh region needs its tables before `bundle deploy`.

The script does this for you. Before the deploy it runs, through the SQL Statement Execution API on the region's warehouse:

1. every file in `sql/setup/`, in order. They create the schema and the six tables, and each is safe to run again.
2. for each table, a read of its columns from `information_schema.columns`, and an `ALTER TABLE ... ADD COLUMNS` for the columns a table from an older version lacks, as notebook 01 adds them. The views come after this step because a view can name a column that only the newer tables have: `incidents` names `parent_job`, which `findings` has had since Phase 1.3.
3. each view in `sql/views/`, only when the view does not exist yet. It checks `information_schema.views` first, because replacing a view moves its owner.

Running the script again is safe. The catalog must exist already.

A single workspace deployed without a region file gets the same step from `python3 scripts/ensure_tables.py accelerator.local.yaml --profile <profile>`, before its first `bundle deploy`.

To do it by hand instead, run the `sql/setup/*.sql` files in order in the SQL editor with the `catalog` and `schema` parameters, then create each view from `sql/views/`, replacing `{schema}` with the catalog and schema in backticks. On a schema from an older version, run notebook 01 instead, which also adds the new columns. Then deploy with `--skip-ensure-tables`.

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

Run the teardown as the same identity that deployed the region, for the reason given in [one identity per region](#one-deploying-identity-per-region): the bundle state is in that identity's folder, so a teardown as anyone else does not remove what the first identity deployed. A plain teardown deletes the jobs, the app, the Genie agent with everyone's copilot conversations, and the bundle files, and keeps the Lakebase project (with the job list) and the Watchdog schema. `--drop-lakebase` and `--drop-schema` remove those too; each asks you to type a name first. Lakebase keeps a project that `--drop-lakebase` deleted for 7 days: `databricks postgres undelete-project projects/<project ID>` (Beta) brings it back with the job list, and `databricks postgres delete-project projects/<project ID> --purge` deletes it for good. Deleting the app also deletes its service principal, which leaves an empty home folder, `/Workspace/Users/<old client ID>`, that you can delete.

## Deploy again after a teardown

A plain teardown deletes the app and its service principal, but keeps the Lakebase project with the job list. The next deploy creates the app again with a new service principal, which cannot use the kept `watchdog_app` schema until it gets access. Changing `app.name` after a deploy replaces the app in the same way.

What a full teardown and redeploy showed, on 2026-11-05 on a throwaway copy: a plain teardown removes the app's Postgres role and gives everything it owned to the identity that ran the teardown, that is the `watchdog_app` schema with the job list and AppKit's `appkit` schema. The redeployed app answers 503 `no_access` on its job list until the access job runs, then reads and saves the kept list with no restart. AppKit creates its cache schema again at the app's next start. After a teardown and redeploy, [check the handover](#check-the-handover-after-a-redeploy).

To deploy again with the list kept, run these as the identity that ran the teardown, from the repo root. Teardown prints them at the end, with the profile and the settings file it was given; add `--profile <profile>` to each `databricks` command when you use one.

1. Set the bundle variables from the same settings file: `eval "$(python3 scripts/bundle_vars.py --export accelerator.local.yaml)"`, or the region file you gave teardown with `-c`.
2. Bind the kept Lakebase resources to the bundle again, with the three `databricks bundle deployment bind` commands teardown prints. Without them the next deploy fails on the project that already exists.
3. Wait until the old app is gone: `databricks apps get <app name>` says it does not exist. A deleted app takes about a minute.
4. Deploy and start the app: `databricks bundle deploy -t <target>`, then `databricks bundle run watchdog_app -t <target>`.
5. Give the new service principal access: `databricks bundle run watchdog_app_access -t <target>`. The job runs notebook 11, which grants it `USAGE` and `CREATE` on `watchdog_app` and `SELECT` and `INSERT` on its tables. It changes nothing when the app already has access. AppKit's query cache lives in its own schema, `appkit`, which changes hands in the same way, and grants cannot fix it: AppKit's start runs `CREATE INDEX IF NOT EXISTS` on its table, which only the owner may run, and you cannot make the app's role the owner. So the job drops `appkit` when someone else owns it; the app creates it again at its next start and caches query results in memory until then.

`scripts/deploy_regions.py` does steps 4 and 5 for each region, with that region file's variables. Until step 5, the app's job list says "The app has no access to its job list in Lakebase", and the app log names the job. The app tries again on each request, so it needs no restart. The scans keep reading the list meanwhile, because they run as the deploying identity.

If notebook 11 says the schema belongs to another role (the old app's service principal, when Lakebase did not hand the schema over), a Lakebase admin deletes that role and gives its objects to you, for example `databricks postgres delete-role <branch>/roles/dbrx-apps-<old client ID> --reassign-owned-to "<your Postgres role>"`. Then run step 5 again.

### Check the handover after a redeploy

1. Read what the access job did: notebook 11's one line, in the job run (`databricks bundle run watchdog_app_access -t <target>` prints its link). Serverless retries a task after an internal error, so when the run shows more than one attempt, the line is in the last one. It says it gave the new service principal access, or that the app already has access or owns the schema, and whether it dropped AppKit's cache schema. If it says the schema belongs to another role, follow the paragraph above.
2. Open the app's Job list. It should show the kept versions, not "The app has no access to its job list in Lakebase". Open the Dependency map too. It should not say "Saved positions couldn't load".
3. In the Lakebase SQL editor on the branch, as the deploying identity, check the owners and the new app's rights. `<client ID>` is the new app's `service_principal_client_id` from `databricks apps get <app name>`:

   ```sql
   SELECT nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname IN ('watchdog_app', 'appkit');
   SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'watchdog_app';
   SELECT has_schema_privilege('<client ID>', 'watchdog_app', 'USAGE') AS can_use,
          has_schema_privilege('<client ID>', 'watchdog_app', 'CREATE') AS can_create,
          has_table_privilege('<client ID>', 'watchdog_app.job_list_versions', 'SELECT') AS can_read,
          has_table_privilege('<client ID>', 'watchdog_app.job_list_versions', 'INSERT') AS can_write,
          has_table_privilege('<client ID>', 'watchdog_app.map_layout', 'SELECT') AS can_read_layout,
          has_table_privilege('<client ID>', 'watchdog_app.map_layout', 'INSERT') AS can_write_layout;
   ```

   All six should be true. The owner of `watchdog_app` should be the identity that ran the teardown (or the new app, if it created the schema), and `appkit` should be missing or owned by the client ID. Both tables should belong to the schema's owner, or `map_layout` to the client ID when the new app created it. When the two `map_layout` columns are false and `map_layout` belongs to another identity, teardowns ran as two identities (see [the app's known gaps](app.md#known-gaps)): the access job cannot grant on a table that identity owns, but that identity can, with `GRANT SELECT, INSERT ON watchdog_app.map_layout TO "<client ID>"`.
4. Restart the app once (`databricks bundle run watchdog_app -t <target>`). Its log should then have no `Migration step ... failed` line from AppKit's cache.

If a check fails, the handover did not go as described here: keep step 1's line and step 3's owners for the report.
