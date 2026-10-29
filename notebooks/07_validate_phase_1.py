# Databricks notebook source
# MAGIC %md
# MAGIC # 07 · Validate Phase 1
# MAGIC
# MAGIC **What it does.** Checks that Phase 1 is complete and prints one PASS or FAIL line per check:
# MAGIC
# MAGIC 1. the three tables exist;
# MAGIC 2. the config has enabled jobs;
# MAGIC 3. both sources (system tables and the Jobs API) wrote findings;
# MAGIC 4. every enabled job got at least one finding from each source;
# MAGIC 5. no findings key appears twice.
# MAGIC
# MAGIC **Inputs (widgets).** `catalog`, `schema`, `scan_id`. With `scan_id` empty, it checks each source's newest scan, which is what you want after running notebooks 05 and 06 by hand.
# MAGIC
# MAGIC **What to look for.** Five PASS lines. The notebook fails if any check fails, so a job run of the Watchdog shows red.

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

define_widgets("catalog", "schema", "scan_id")
s = settings("catalog", "schema", "scan_id")

# COMMAND ----------

from jobs_watchdog.sqlfiles import run_sql
from jobs_watchdog.validation import phase_1_checks

prefix = f"{s.catalog}.{s.schema}"
tables = {name: spark.catalog.tableExists(f"{prefix}.{name}") for name in ("monitored_jobs", "job_dependencies", "findings")}
enabled_jobs, by_source, missing, duplicates = 0, [], [], []
if all(tables.values()):
    params = dict(catalog=s.catalog, schema=s.schema, scan_id=s.scan_id)
    enabled_jobs = spark.table(f"{prefix}.monitored_jobs").where("enabled").count()
    by_source = [row.asDict() for row in run_sql(spark, "sql/validate/40_findings_by_source.sql", **params).collect()]
    duplicates = [row.asDict() for row in run_sql(spark, "sql/validate/41_duplicate_keys.sql", **params).collect()]
    missing = [row.asDict() for row in run_sql(spark, "sql/validate/42_enabled_jobs_without_findings.sql", **params).collect()]

results = phase_1_checks(tables, enabled_jobs, by_source, missing, duplicates)
for name, passed, detail in results:
    print(f"{'PASS' if passed else 'FAIL'}  {name}: {detail}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Findings by source and status

# COMMAND ----------

import pandas as pd

if by_source:
    display(pd.DataFrame(by_source))
else:
    print("No findings for the chosen scan.")

# COMMAND ----------

failed = [name for name, passed, _ in results if not passed]
if failed:
    raise AssertionError("Phase 1 validation failed: " + ", ".join(failed))
print("Phase 1 is complete.")
