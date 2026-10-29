# Databricks notebook source
# MAGIC %md
# MAGIC # 01 · Create the Watchdog tables
# MAGIC
# MAGIC **What it does.** Runs the files in `sql/setup` in order: it creates the schema, then the two config tables (`monitored_jobs`, `job_dependencies`) and the one `findings` table. Every statement is `IF NOT EXISTS`, so re-running changes nothing.
# MAGIC
# MAGIC **Inputs (widgets).** `catalog`, `schema`.
# MAGIC
# MAGIC **What to look for.** Three `exists: True` lines. Creating the schema needs `USE CATALOG` and `CREATE SCHEMA` on the catalog (see the runbook).

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

define_widgets("catalog", "schema")
s = settings("catalog", "schema")

# COMMAND ----------

from jobs_watchdog.sqlfiles import run_sql

for path in sorted((REPO_ROOT / "sql" / "setup").glob("*.sql")):
    relpath = str(path.relative_to(REPO_ROOT))
    run_sql(spark, relpath, catalog=s.catalog, schema=s.schema)
    print(f"ran {relpath}")

for table in ("monitored_jobs", "job_dependencies", "findings"):
    print(f"{s.catalog}.{s.schema}.{table} exists: {spark.catalog.tableExists(f'{s.catalog}.{s.schema}.{table}')}")

# COMMAND ----------

# MAGIC %md
# MAGIC The column comments describe every column. To read them: `DESCRIBE TABLE <catalog>.<schema>.findings`, or open the table in Catalog Explorer. `docs/data-model.md` explains each column in more detail.
