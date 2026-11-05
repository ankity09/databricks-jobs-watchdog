# Databricks notebook source
# MAGIC %md
# MAGIC # 11 · Give the app access to the kept job list
# MAGIC
# MAGIC **What it does.** A plain teardown deletes the Watchdog app, and its service principal with it, but keeps the Lakebase project with the job list. Lakebase then hands the app's `watchdog_app` schema to the identity that ran the teardown. The next deploy creates the app again with a new service principal, which cannot use that schema, so the app's job list says it has no access. This notebook grants the new service principal what the app needs: `USAGE` and `CREATE` on `watchdog_app`, and `SELECT` and `INSERT` on its tables. Run it as the identity that deployed and tore down. It changes nothing when the app owns the schema, already has access, or has not created the schema yet, so it is safe to run again. The `watchdog_app_access` job runs it, and `scripts/deploy_regions.py` runs that job after a region's deploy when the app got a new service principal and the Lakebase project was kept. It installs the `psycopg` package from PyPI (or your package mirror) if the compute does not have it.
# MAGIC
# MAGIC **Inputs (widgets).** `app_name` (default `app.name` in your accelerator file), `lakebase_project_id`, `lakebase_branch` and `lakebase_database`, which name the app's database. The input boxes appear at the top of the notebook after you run the first two code cells; when the notebook runs as a job, its parameters fill them in.
# MAGIC
# MAGIC **What to look for.** One line that says what it did: it granted the rights, the app already had them, the app owns the schema, or the schema does not exist yet. Then open the app's Job list and click Retry. An error names the schema's owner when you cannot grant on it.

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

# Shows the input boxes (widgets) at the top of the notebook. Fill them in, then run the cells below.
NAMES = ("app_name", "lakebase_project_id", "lakebase_branch", "lakebase_database")
define_widgets(*NAMES)

# COMMAND ----------

s = settings(*NAMES)

# COMMAND ----------

from databricks.sdk import WorkspaceClient

from jobs_watchdog.app_access import app_service_principal, grant_app_access
from jobs_watchdog.lakebase_source import GRANT_APP_ACCESS, LakebaseTarget, open_branch, psycopg_connect

api = WorkspaceClient().api_client
role = app_service_principal(api, s.app_name)
target = LakebaseTarget(s.lakebase_project_id, s.lakebase_branch, s.lakebase_database)
with open_branch(api, target, psycopg_connect(GRANT_APP_ACCESS)) as connection:
    result = grant_app_access(connection, role)
print(f"{s.app_name}, {target.database_path}: {result.message}")
