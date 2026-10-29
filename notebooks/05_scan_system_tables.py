# Databricks notebook source
# MAGIC %md
# MAGIC # 05 · Scan with system tables
# MAGIC
# MAGIC **What it does.** Runs the system table checks for every enabled monitored job and adds the results to `findings`, with `source = SYSTEM_TABLES`:
# MAGIC
# MAGIC | check_id | What it checks |
# MAGIC |---|---|
# MAGIC | `last_run_result` | scheduled jobs: the newest finished run in the window; continuous jobs: the newest run, even while it is still going |
# MAGIC | `task_failures` | tasks whose newest attempt failed, in the job's newest run |
# MAGIC | `schedule_gap` | scheduled jobs: no run started within `max_gap_minutes` (plus 60 for system table lag) |
# MAGIC | `long_runtime` | the newest finished run, or a run still going, over `max_runtime_minutes`, measured up to its newest system table record |
# MAGIC | `not_found` | the job's regex matches no job in this region |
# MAGIC
# MAGIC **Inputs (widgets).** `catalog`, `schema`, `region`, `lookback_hours`, `scan_id`. With `scan_id` empty, a new one is made from the current UTC time. Re-running with the same `scan_id` adds nothing. The input boxes appear at the top of the notebook after you run the first two code cells; when the notebook runs as a job, its parameters fill them in.
# MAGIC
# MAGIC **What to look for.** One row per check for each matched job. System tables run about an hour behind, so a brand-new job shows `not_found` here until it lands.

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

# Shows the input boxes (widgets) at the top of the notebook. Fill them in, then run the cells below.
NAMES = ("catalog", "schema", "region", "lookback_hours", "scan_id")
define_widgets(*NAMES)

# COMMAND ----------

s = settings(*NAMES)

# COMMAND ----------

from datetime import datetime, timezone

from pyspark.sql import functions as F

from jobs_watchdog.findings import MERGE_SQL, NEW_FINDINGS_VIEW, new_scan_id
from jobs_watchdog.sqlfiles import run_sql
from jobs_watchdog.workspaces import register_workspace_names

scan_id = s.scan_id or new_scan_id(datetime.now(timezone.utc))
print(f"scan_id: {scan_id}")

names, names_error = register_workspace_names(spark)
if names_error:
    print(f"Workspace names are unavailable, so findings get no names or run links: {names_error}")

new_rows = run_sql(
    spark,
    "sql/scan/21_system_table_findings.sql",
    catalog=s.catalog,
    schema=s.schema,
    region=s.region,
    lookback_hours=s.lookback_hours,
    scan_id=scan_id,
)
new_rows.createOrReplaceTempView(NEW_FINDINGS_VIEW)
display(run_sql(spark, MERGE_SQL, catalog=s.catalog, schema=s.schema))

# COMMAND ----------

# MAGIC %md
# MAGIC ## This scan's system table findings

# COMMAND ----------

findings = spark.table(f"{s.catalog}.{s.schema}.findings")
display(
    findings.where((F.col("scan_id") == scan_id) & (F.col("source") == "SYSTEM_TABLES"))
    .orderBy("job_name", "workspace_id", "check_id")
)
