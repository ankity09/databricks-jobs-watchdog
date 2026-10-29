# Databricks notebook source
# MAGIC %md
# MAGIC # 00 · Check access
# MAGIC
# MAGIC **What it does.** Confirms that the identity running this notebook can do what Phase 1 needs:
# MAGIC
# MAGIC 1. read the job system tables and the workspaces system table;
# MAGIC 2. see which workspaces the system tables for this region cover;
# MAGIC 3. call the Jobs API in this workspace, and with `auth_mode = service_principal`, in every workspace in the region.
# MAGIC
# MAGIC Nothing is created or changed.
# MAGIC
# MAGIC **Inputs (widgets).** `lookback_hours`, `auth_mode`, and for service principal mode `secret_scope`, `client_id_key`, `client_secret_key`. The input boxes appear at the top of the notebook after you run the first two code cells; when the notebook runs as a job, its parameters fill them in.
# MAGIC
# MAGIC **What to look for.** Every line says PASS. A FAIL line names what is missing; `docs/phase-1-runbook.md` lists the grant or setting that fixes it. The notebook fails at the end if a required check failed. In service principal mode, a workspace the service principal cannot reach shows as a WARN line here, and as `api_unreachable` rows in notebook 06; the notebook fails only if it reaches none of them.

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

# Shows the input boxes (widgets) at the top of the notebook. Fill them in, then run the cells below.
NAMES = ("lookback_hours", "auth_mode", "secret_scope", "client_id_key", "client_secret_key")
define_widgets(*NAMES)

# COMMAND ----------

s = settings(*NAMES)
required_failures = []

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Who is running this
# MAGIC
# MAGIC System table reads, and Jobs API calls in this workspace, use this identity. When the notebooks run as a job, this is the job's "run as" identity.

# COMMAND ----------

from databricks.sdk import WorkspaceClient

here = WorkspaceClient()
current_workspace_id = str(here.get_workspace_id())
print(f"Running as:   {here.current_user.me().user_name}")
print(f"Workspace ID: {current_workspace_id}")
print(f"Auth mode:    {s.auth_mode}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. System table access
# MAGIC
# MAGIC The three `system.lakeflow` tables are required. `system.access.workspaces_latest` (Public Preview) adds workspace names and run links, and service principal mode needs it for workspace URLs. A FAIL here usually means a missing grant, which a metastore admin adds (see the runbook).

# COMMAND ----------

TABLES = [
    ("system.lakeflow.jobs", True),
    ("system.lakeflow.job_run_timeline", True),
    ("system.lakeflow.job_task_run_timeline", True),
    ("system.access.workspaces_latest", s.auth_mode == "service_principal"),
]
for table, required in TABLES:
    try:
        spark.table(table).limit(1).collect()
        print(f"PASS  read {table}")
    except Exception as err:
        need = "required" if required else "optional in this mode"
        print(f"FAIL  read {table} ({need}): {short_error(err)}")
        if required:
            required_failures.append(f"read {table}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Workspaces the system tables cover
# MAGIC
# MAGIC One row per workspace in this account and region that has jobs, with its name and URL when the workspaces table is readable. Check that the workspaces you expect are listed. System tables only cover this region: a workspace in another region (often visible in its name, for example a region suffix) needs a Watchdog run from a workspace in that region.

# COMMAND ----------

from jobs_watchdog.sqlfiles import run_sql
from jobs_watchdog.workspaces import NAMES_VIEW, register_workspace_names

system_tables_readable = not any(item.startswith("read system.lakeflow") for item in required_failures)
if system_tables_readable:
    region_workspaces = run_sql(spark, "sql/explore/10_workspaces_in_region.sql", lookback_hours=s.lookback_hours)
    _, names_error = register_workspace_names(spark)
    named = spark.table(NAMES_VIEW).select("workspace_id", "workspace_name", "workspace_url")
    display(region_workspaces.join(named, "workspace_id", "left").orderBy("workspace_name"))
    if names_error:
        print(f"Names are unavailable, so only workspace IDs are shown: {names_error}")
else:
    print("Skipped: needs read access to the system.lakeflow tables above.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Jobs API access
# MAGIC
# MAGIC Lists one job in each workspace the Jobs API scan will visit. Reading a job's runs needs at least CAN VIEW on that job; this check only proves the API answers.

# COMMAND ----------

from jobs_watchdog.jobs_api import make_client
from jobs_watchdog.workspaces import build_targets, register_workspace_names

try:
    next(iter(here.jobs.list(limit=1)), None)
    print(f"PASS  Jobs API in this workspace ({current_workspace_id})")
except Exception as err:
    print(f"FAIL  Jobs API in this workspace: {short_error(err)}")
    required_failures.append("Jobs API in this workspace")

if s.auth_mode == "service_principal" and not system_tables_readable:
    print("Skipped the service principal checks: they need the system.lakeflow tables to list workspaces.")
elif s.auth_mode == "service_principal":
    from jobs_watchdog.validation import service_principal_verdict

    secrets = {}
    for role, key in (("client_id", s.client_id_key), ("client_secret", s.client_secret_key)):
        try:
            secrets[role] = dbutils.secrets.get(s.secret_scope, key)
            print(f"PASS  read secret {s.secret_scope}/{key}")
        except Exception as err:
            print(f"FAIL  read secret {s.secret_scope}/{key}: {short_error(err)}")
            required_failures.append(f"read secret {s.secret_scope}/{key}: {short_error(err)}")
    if len(secrets) < 2:
        print("Skipped the per-workspace checks: they need both secrets.")
    else:
        names, names_error = register_workspace_names(spark)
        if names_error:
            print(f"WARN  workspace URLs from system.access.workspaces_latest: {names_error}")
        rows = [row.asDict() for row in region_workspaces.collect()]
        targets, missing = build_targets("service_principal", current_workspace_id, rows, names)
        results = []
        for target in targets:
            label = f"{target.workspace_name or target.workspace_id} ({target.workspace_id})"
            try:
                client = make_client("service_principal", target.host, secrets["client_id"],
                                     secrets["client_secret"])
                answered = str(client.get_workspace_id())
                next(iter(client.jobs.list(limit=1)), None)
                if answered == target.workspace_id:
                    results.append((label, True, "reached"))
                    print(f"PASS  service principal reaches {label}")
                else:
                    results.append((label, False, f"the URL answered as workspace {answered}"))
            except Exception as err:
                results.append((label, False, short_error(err)))
        for target in missing:
            label = f"{target.workspace_name or target.workspace_id} ({target.workspace_id})"
            results.append((label, False, "no URL in system.access.workspaces_latest"))
        failures, warnings = service_principal_verdict(results)
        for warning in warnings:
            print(f"WARN  {warning}")
        for failure in failures:
            print(f"FAIL  {failure}")
        required_failures.extend(failures)

# COMMAND ----------

if required_failures:
    raise RuntimeError("Access check failed: " + "; ".join(required_failures))
print("All required access checks passed.")
