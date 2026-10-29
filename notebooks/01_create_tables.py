# Databricks notebook source
# MAGIC %md
# MAGIC # 01 · Create the Watchdog tables
# MAGIC
# MAGIC **What it does.** Runs the files in `sql/setup` in order: it creates the schema, then the config tables (`monitored_jobs`, `job_dependencies`, `monitored_workspaces`) and the one `findings` table. Every statement is `IF NOT EXISTS`, so re-running keeps your data. Then it upgrades tables made by an older version, adding any new columns at the end, and creates the view `findings_latest` (the newest scan from each source) when it is missing. It replaces the view only when its columns or its definition version change, so the view's owner and grants stay otherwise; replacing it needs ownership of the view. **Run it again after every pull.**
# MAGIC
# MAGIC **Inputs (widgets).** `catalog`, `schema`. The input boxes appear at the top of the notebook after you run the first two code cells; when the notebook runs as a job, its parameters fill them in.
# MAGIC
# MAGIC **What to look for.** Five `exists: True` lines (four tables and the view), and the columns it added, if any. It never creates a catalog. A schema that already exists is left as it is, so this notebook then needs `USE CATALOG` on the catalog plus `USE SCHEMA` and `CREATE TABLE` on the schema; creating a new schema needs `USE CATALOG` and `CREATE SCHEMA` on the catalog instead (see the runbook).

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

# Shows the input boxes (widgets) at the top of the notebook. Fill them in, then run the cells below.
define_widgets("catalog", "schema")

# COMMAND ----------

s = settings("catalog", "schema")

# COMMAND ----------

from jobs_watchdog.sqlfiles import run_sql

for path in sorted((REPO_ROOT / "sql" / "setup").glob("*.sql")):
    relpath = str(path.relative_to(REPO_ROOT))
    run_sql(spark, relpath, catalog=s.catalog, schema=s.schema)
    print(f"ran {relpath}")

from jobs_watchdog.upgrade import create_views, upgrade_tables

added = upgrade_tables(spark, s.catalog, s.schema)
for table, columns in added.items():
    print(f"added to {table}: {', '.join(columns)}")
if not added:
    print("every table already has the current columns")
for view, action in create_views(spark, s.catalog, s.schema):
    print(f"view {view}: {action}")

from jobs_watchdog.upgrade import watchdog_objects

for name in watchdog_objects():
    print(f"{s.catalog}.{s.schema}.{name} exists: {spark.catalog.tableExists(f'{s.catalog}.{s.schema}.{name}')}")

# COMMAND ----------

# MAGIC %md
# MAGIC The column comments describe every column. To read them: `DESCRIBE TABLE <catalog>.<schema>.findings`, or open the table in Catalog Explorer. `docs/data-model.md` explains each column in more detail.
