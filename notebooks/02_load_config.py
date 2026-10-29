# Databricks notebook source
# MAGIC %md
# MAGIC # 02 · Load the monitored-jobs config
# MAGIC
# MAGIC **What it does.** Reads your monitored-jobs YAML file, checks it, and replaces the rows of `monitored_jobs`, `job_dependencies` and `monitored_workspaces` (the optional `workspaces` section, which gives each workspace an environment label such as production or lower) with its contents. Then it shows which real jobs each monitored job matches.
# MAGIC
# MAGIC **Inputs (widgets).** `catalog`, `schema`, `monitored_jobs_path`. Keep your own copy of the file outside the Git folder (your workspace home folder, or a Unity Catalog volume such as `/Volumes/<catalog>/<schema>/<volume>/monitored_jobs.yml`) so a pull never conflicts with your edits. Relative paths start at the repo root. The input boxes appear at the top of the notebook after you run the first two code cells; when the notebook runs as a job, its parameters fill them in.
# MAGIC
# MAGIC **What to look for.** Every enabled job matches at least one real job in the last table, and nothing you meant to skip (names matching `job_name_exclude_regex` are left out). The `environment` and `checked_here` columns show each match's environment label and whether the job is checked there, after any `environments` overrides. A monitored job with an empty `workspace_id` matches nothing: fix its `job_name_regex`. A job created in the last hour may not match yet, because system tables run about an hour behind; notebook 06 matches through the Jobs API and finds it straight away.

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

# Shows the input boxes (widgets) at the top of the notebook. Fill them in, then run the cells below.
define_widgets("catalog", "schema", "monitored_jobs_path")

# COMMAND ----------

s = settings("catalog", "schema", "monitored_jobs_path")

# COMMAND ----------

from jobs_watchdog.config import load_monitored_jobs, load_monitored_workspaces
from jobs_watchdog.config_tables import write_config
from jobs_watchdog.upgrade import require_current_tables

require_current_tables(spark, s.catalog, s.schema)
jobs, dependencies = load_monitored_jobs(s.monitored_jobs_path)
workspaces = load_monitored_workspaces(s.monitored_jobs_path)
enabled = sum(job.enabled for job in jobs)
print(f"Read {len(jobs)} jobs ({enabled} enabled), {len(dependencies)} dependencies and "
      f"{len(workspaces)} workspace labels from {s.monitored_jobs_path}")
write_config(spark, jobs, dependencies, s.catalog, s.schema, workspaces)
print(f"Replaced the rows of {s.catalog}.{s.schema}.monitored_jobs, job_dependencies and monitored_workspaces")

# COMMAND ----------

display(spark.table(f"{s.catalog}.{s.schema}.monitored_jobs"))

# COMMAND ----------

display(spark.table(f"{s.catalog}.{s.schema}.job_dependencies"))

# COMMAND ----------

display(spark.table(f"{s.catalog}.{s.schema}.monitored_workspaces"))

# COMMAND ----------

# MAGIC %md
# MAGIC Per-environment overrides, from each job's `environments` section: one row per job and environment label. An empty setting means the job's own setting applies.

# COMMAND ----------

display(spark.table(f"{s.catalog}.{s.schema}.monitored_job_environments"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Which real jobs does each monitored job match?
# MAGIC
# MAGIC From `sql/scan/20_resolve_monitored_jobs.sql`. The regex can match anywhere in the job name unless it is anchored with `^` and `$`.

# COMMAND ----------

from jobs_watchdog.sqlfiles import run_sql
from jobs_watchdog.workspaces import register_workspace_names

register_workspace_names(spark)
display(run_sql(spark, "sql/scan/20_resolve_monitored_jobs.sql", catalog=s.catalog, schema=s.schema))
