# Databricks notebook source
# MAGIC %md
# MAGIC # 08 · Create the findings dashboard
# MAGIC
# MAGIC **What it does.** Creates the Watchdog findings dashboard in a folder, or updates it if it is already there, then publishes it. The dashboard reads the `findings` table and its `findings_latest` view, so run it after notebook 05 or 06 has written findings. Running it again updates the same dashboard and changes nothing else.
# MAGIC
# MAGIC **Inputs (widgets).** `catalog` and `schema` (where `findings` lives). `warehouse_id`: the SQL warehouse that runs the dashboard's queries, by default `target.warehouse_id` from your accelerator file. `dashboard_folder`: your home folder by default. `dashboard_name`: "Watchdog findings" by default. The input boxes appear at the top of the notebook after you run the first two code cells; when the notebook runs as a job, its parameters fill them in.
# MAGIC
# MAGIC **What to look for.** The link at the end opens the published dashboard. It has three pages:
# MAGIC
# MAGIC - **Now**: counters for FAILED, WARNING, UNKNOWN and HEALTHY rows in the latest scans, every problem worst first, and the worst status of each job in each environment.
# MAGIC - **Versions and runs**: the latest run of each job in each workspace, with its code version and trigger. Jobs API rows come first, and system table rows fill the gaps.
# MAGIC - **History**: status per scan over 30 days, and FAILED rows by job over 7 days.
# MAGIC
# MAGIC The environment and job filters narrow Now and Versions and runs. History always shows every environment.

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

# Shows the input boxes (widgets) at the top of the notebook. Fill them in, then run the cells below.
define_widgets("catalog", "schema")

# COMMAND ----------

from databricks.sdk import WorkspaceClient

from jobs_watchdog.config import load_accelerator
from jobs_watchdog.settings import accelerator_file

# Notebook-only inputs. The warehouse defaults to target.warehouse_id in the accelerator file.
client = WorkspaceClient()
home_folder = f"/Workspace/Users/{client.current_user.me().user_name}"
default_warehouse = load_accelerator(accelerator_file(REPO_ROOT))["target"].get("warehouse_id") or ""
dbutils.widgets.text("warehouse_id", str(default_warehouse).strip(), "warehouse_id")
dbutils.widgets.text("dashboard_folder", home_folder, "dashboard_folder")
dbutils.widgets.text("dashboard_name", "Watchdog findings", "dashboard_name")

s = settings("catalog", "schema")

# COMMAND ----------

warehouse_id = dbutils.widgets.get("warehouse_id").strip()
dashboard_folder = dbutils.widgets.get("dashboard_folder").strip().rstrip("/")
dashboard_name = dbutils.widgets.get("dashboard_name").strip()

if not warehouse_id:
    raise RuntimeError(
        "warehouse_id is empty. Type a SQL warehouse ID in the warehouse_id box, or set target.warehouse_id "
        "in accelerator.local.yaml. To find an ID, run `databricks warehouses list` in a terminal, or open "
        "SQL Warehouses in the workspace and copy the ID from a warehouse's details."
    )
if not dashboard_folder or not dashboard_name:
    raise RuntimeError("dashboard_folder and dashboard_name must not be empty.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Create or update the dashboard

# COMMAND ----------

from jobs_watchdog.dashboard import create_or_update_dashboard, render

template = (REPO_ROOT / "dashboards" / "watchdog_findings.lvdash.json").read_text()
path = create_or_update_dashboard(
    client,
    display_name=dashboard_name,
    parent_path=dashboard_folder,
    serialized_dashboard=render(template, s.catalog, s.schema),
    warehouse_id=warehouse_id,
)

# COMMAND ----------

print(f"Dashboard ready: {client.config.host.rstrip('/')}{path}")
