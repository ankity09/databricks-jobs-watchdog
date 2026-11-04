# Databricks notebook source
# MAGIC %md
# MAGIC # 10 · Delete old findings
# MAGIC
# MAGIC **What it does.** Keeps `findings` from growing forever. It deletes every scan whose first row is more than `retention_days` days old, using `sql/maintenance/50_delete_old_findings.sql`. Each source's newest scan is always kept, even when it is older than that, so `findings_latest` still shows the current status after the scans have stopped for a while. A scan is deleted whole, never in part. With `retention_days` 0 it keeps everything and changes nothing. The `watchdog_cleanup` job runs this notebook once a day.
# MAGIC
# MAGIC **Inputs (widgets).** `catalog`, `schema`, `retention_days` (default `scan.retention_days` in your accelerator file, 30 if it is not set). The input boxes appear at the top of the notebook after you run the first two code cells; when the notebook runs as a job, its parameters fill them in.
# MAGIC
# MAGIC **What to look for.** A `Deleted N rows` line, then the scans that are left: how many per source, and the oldest one. Every scan older than the limit should be gone, except a source's newest.

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

# Shows the input boxes (widgets) at the top of the notebook. Fill them in, then run the cells below.
NAMES = ("catalog", "schema", "retention_days")
define_widgets(*NAMES)

# COMMAND ----------

s = settings(*NAMES)

# COMMAND ----------

from jobs_watchdog.sqlfiles import run_sql
from jobs_watchdog.upgrade import require_current_tables

require_current_tables(spark, s.catalog, s.schema)
if s.retention_days == 0:
    print("retention_days is 0: keeping every scan, nothing deleted.")
else:
    result = run_sql(spark, "sql/maintenance/50_delete_old_findings.sql",
                     catalog=s.catalog, schema=s.schema, retention_days=s.retention_days).collect()
    counts = result[0].asDict() if result else {}
    deleted = counts.get("num_deleted_rows", counts.get("num_affected_rows", 0))
    print(f"Deleted {deleted} rows from {s.catalog}.{s.schema}.findings: scans whose first row is more than "
          f"{s.retention_days} days old, keeping each source's newest scan.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## The scans that are left

# COMMAND ----------

from pyspark.sql import functions as F

scans = (
    spark.table(f"{s.catalog}.{s.schema}.findings")
    .groupBy("source", "scan_id")
    .agg(F.min("observed_at").alias("first_seen"), F.count("*").alias("rows"))
)
left = scans.groupBy("source").agg(
    F.count("*").alias("scans"),
    F.sum("rows").alias("rows"),
    F.min("first_seen").alias("oldest_scan_first_seen"),
    F.max("first_seen").alias("newest_scan_first_seen"),
).orderBy("source")
oldest = scans.agg(F.min("first_seen")).first()[0]
print(f"Oldest observed_at left: {oldest}" if oldest else "The findings table is empty.")
display(left)
