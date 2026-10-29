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
# MAGIC **Inputs (widgets).** `lookback_hours`, `auth_mode`, and for service principal mode `secret_scope`, `client_id_key`, `client_secret_key`.
# MAGIC
# MAGIC **What to look for.** Every line says PASS. A FAIL line names what is missing; `docs/phase-1-runbook.md` lists the grant or setting that fixes it. The notebook fails at the end if a required check failed.

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

NAMES = ("lookback_hours", "auth_mode", "secret_scope", "client_id_key", "client_secret_key")
define_widgets(*NAMES)
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
# MAGIC One row per workspace in this account and region that has jobs. Check that the workspaces you expect are listed. Workspaces in other regions need a run of the Watchdog from a workspace in that region.

# COMMAND ----------

from jobs_watchdog.sqlfiles import run_sql

system_tables_readable = not any(item.startswith("read system.lakeflow") for item in required_failures)
if system_tables_readable:
    region_workspaces = run_sql(spark, "sql/explore/10_workspaces_in_region.sql", lookback_hours=s.lookback_hours)
    display(region_workspaces)
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
    client_id = dbutils.secrets.get(s.secret_scope, s.client_id_key)
    client_secret = dbutils.secrets.get(s.secret_scope, s.client_secret_key)
    names, names_error = register_workspace_names(spark)
    if names_error:
        print(f"FAIL  workspace URLs from system.access.workspaces_latest: {names_error}")
    rows = [row.asDict() for row in region_workspaces.collect()]
    targets, missing = build_targets("service_principal", current_workspace_id, rows, names)
    for target in targets:
        label = f"{target.workspace_name or target.workspace_id} ({target.workspace_id})"
        try:
            client = make_client("service_principal", target.host, client_id, client_secret)
            answered = str(client.get_workspace_id())
            next(iter(client.jobs.list(limit=1)), None)
            if answered == target.workspace_id:
                print(f"PASS  service principal reaches {label}")
            else:
                print(f"FAIL  {label}: the URL answered as workspace {answered}")
                required_failures.append(f"service principal on {target.workspace_id}")
        except Exception as err:
            print(f"FAIL  service principal on {label}: {short_error(err)}")
            required_failures.append(f"service principal on {target.workspace_id}")
    for target in missing:
        print(f"FAIL  {target.workspace_id}: no URL in system.access.workspaces_latest")
        required_failures.append(f"URL for {target.workspace_id}")

# COMMAND ----------

if required_failures:
    raise RuntimeError("Access check failed: " + "; ".join(required_failures))
print("All required access checks passed.")
