# Databricks notebook source
# MAGIC %md
# MAGIC # 02 · Load the monitored-jobs config
# MAGIC
# MAGIC **What it does.** Reads your monitored-jobs list, from a YAML file or from the Watchdog app, checks it, fills in its `defaults`, and replaces the rows of four tables with its contents: `monitored_jobs`, `job_dependencies`, `monitored_workspaces` (the optional `workspaces` section, which gives each workspace an environment label such as production or lower) and `monitored_job_environments` (each job's optional `environments` section: its settings for one environment label). It also adds one row to `config_loads` for every load, with the source, the version (for the app), the job count and whether it worked. Then it shows which real jobs each monitored job matches.
# MAGIC
# MAGIC **Inputs (widgets).** `catalog`, `schema`, `config_source`, `monitored_jobs_path`, and `lakebase_project_id`, `lakebase_branch`, `lakebase_database`. With `config_source` set to `yaml` (the default), the list is the file at `monitored_jobs_path`. With `lakebase`, it is the newest version saved in the Watchdog app, read from the Lakebase project, branch and database named by the other three widgets, as the identity that runs the notebook. That path installs the `psycopg` package from PyPI (or your package mirror) if the compute does not have it; a YAML load needs no package. An empty list, or a failed install, fails the load with a message in `config_loads`, and the tables keep their last good rows. Keep your own copy of the file outside the Git folder (your workspace home folder, or a Unity Catalog volume such as `/Volumes/<catalog>/<schema>/<volume>/monitored_jobs.yml`) so a pull never conflicts with your edits. Relative paths start at the repo root. The input boxes appear at the top of the notebook after you run the first two code cells; when the notebook runs as a job, its parameters fill them in.
# MAGIC
# MAGIC **What to look for.** The impact table shows what a failure of each job affects: check it against how your jobs really depend on each other. Every enabled job matches at least one real job in the last table, and nothing you meant to skip (names matching `job_name_exclude_regex` are left out). The `environment` and `checked_here` columns show each match's environment label and whether the job is checked there, after any `environments` overrides. `matched_by` says whether the match came from the job's `job_ids` (exact jobs, used wherever IDs apply in that environment) or from its name pattern, and `same_name_jobs` counts the jobs in that workspace with exactly that name: above 1 on a name match is a `duplicate_name` warning in notebook 05. A monitored job with an empty `workspace_id` matches nothing: fix its `job_name_regex` or its `job_ids`. A job created in the last hour may not match yet, because system tables run about an hour behind; notebook 06 matches through the Jobs API and finds it straight away.

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

# Shows the input boxes (widgets) at the top of the notebook. Fill them in, then run the cells below.
define_widgets("catalog", "schema", "monitored_jobs_path", "config_source", "lakebase_project_id", "lakebase_branch",
               "lakebase_database", "scan_id")

# COMMAND ----------

s = settings("catalog", "schema", "monitored_jobs_path", "config_source", "lakebase_project_id", "lakebase_branch",
             "lakebase_database", "scan_id")

# COMMAND ----------

from datetime import datetime, timezone

from jobs_watchdog.config_loads import ConfigLoad, record_config_load, record_config_load_safely
from jobs_watchdog.config_source import load_config, source_ref_for
from jobs_watchdog.config_tables import write_config
from jobs_watchdog.findings import new_scan_id
from jobs_watchdog.upgrade import require_current_tables

require_current_tables(spark, s.catalog, s.schema)
now = datetime.now(timezone.utc)
scan_id = s.scan_id or new_scan_id(now)
try:
    if s.config_source == "lakebase":
        from databricks.sdk import WorkspaceClient

        from jobs_watchdog.lakebase_source import psycopg_connect
        # psycopg is installed here, only for a Lakebase load, so a YAML load never needs PyPI.
        loaded = load_config(s, api=WorkspaceClient().api_client, connect=psycopg_connect())
    else:
        loaded = load_config(s)
    write_config(spark, loaded.jobs, loaded.dependencies, s.catalog, s.schema, loaded.workspaces)
except Exception as err:
    problem = record_config_load_safely(spark, s.catalog, s.schema,
                                        ConfigLoad(now, scan_id, s.config_source, source_ref_for(s),
                                                   None, None, "FAILED", short_error(err)))
    if problem:
        print(f"Could not record the failed load in config_loads: {problem}")
    raise
record_config_load(spark, s.catalog, s.schema, ConfigLoad(now, scan_id, loaded.source, loaded.source_ref,
                                                          loaded.version, len(loaded.jobs), "OK", None))
enabled = sum(job.enabled for job in loaded.jobs)
where = f"Lakebase job list version {loaded.version}" if loaded.version is not None else loaded.source_ref
print(f"Read {len(loaded.jobs)} jobs ({enabled} enabled), {len(loaded.dependencies)} dependencies and "
      f"{len(loaded.workspaces)} workspace labels from {where}")
print(f"Replaced the rows of {s.catalog}.{s.schema}.monitored_jobs, job_dependencies, "
      "monitored_workspaces and monitored_job_environments")

# COMMAND ----------

display(spark.table(f"{s.catalog}.{s.schema}.monitored_jobs"))

# COMMAND ----------

display(spark.table(f"{s.catalog}.{s.schema}.job_dependencies"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## What a failure of each job affects
# MAGIC
# MAGIC A FAILED finding lists these jobs in `affected_jobs`. `affects_directly` follows one dependency; `affects_in_all` follows the whole chain. A `child_job` link counts both ways: a parent failure stops its children, and a child failure fails its parent's run, so everything downstream of the parent is affected too. `service` dependencies are not listed here. Loops between jobs are printed below the table.

# COMMAND ----------

from jobs_watchdog.dependencies import IMPACT_SCHEMA, dependency_loops, impact_table

display(spark.createDataFrame(impact_table(loaded.jobs, loaded.dependencies), schema=IMPACT_SCHEMA))
loops = dependency_loops(loaded.dependencies)
for loop in loops:
    print("Loop in the job dependencies: " + " and ".join(loop) + " depend on each other")
if not loops:
    print("No loops in the job dependencies.")

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
