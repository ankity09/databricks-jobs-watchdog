# Databricks notebook source
# MAGIC %md
# MAGIC # 03 · Explore the job system tables
# MAGIC
# MAGIC **What it does.** Runs each read-only query in `sql/explore`, with a note on what it answers. These are the same tables the system table scan (notebook 05) reads, so this is the place to see the raw data behind a finding. Nothing is written.
# MAGIC
# MAGIC **Inputs (widgets).** `lookback_hours` (how far back to look). The input boxes appear at the top of the notebook after you run the first two code cells; when the notebook runs as a job, its parameters fill them in.
# MAGIC
# MAGIC **What to look for.** Your jobs and runs appear as you expect. System tables run about an hour behind, so very recent runs are missing until they land. Every query also runs in the SQL editor, which shows a field for each `:parameter`.
# MAGIC
# MAGIC How the tables fit together: `system.lakeflow.jobs` holds job definitions (a new row each time a job changes), `job_run_timeline` holds job runs, and `job_task_run_timeline` holds task runs. Runs longer than an hour are split into one row per hour, and only the last row carries the result. All three cover every workspace in this account and region.

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

# Shows the input boxes (widgets) at the top of the notebook. Fill them in, then run the cells below.
define_widgets("lookback_hours")

# COMMAND ----------

s = settings("lookback_hours")

from jobs_watchdog.sqlfiles import run_sql


def show(relpath, optional=False):
    try:
        display(run_sql(spark, relpath, lookback_hours=s.lookback_hours))
    except Exception as err:
        if not optional:
            raise
        print(f"Skipped {relpath}: {short_error(err)}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 10 · Workspaces in this region
# MAGIC One row per workspace that has jobs: its account, how many jobs, and how many runs started in the window. If a workspace you expect is missing, it is in another region or has no jobs.

# COMMAND ----------

from jobs_watchdog.workspaces import NAMES_VIEW, register_workspace_names

register_workspace_names(spark)
named = spark.table(NAMES_VIEW).select("workspace_id", "workspace_name")
display(run_sql(spark, "sql/explore/10_workspaces_in_region.sql", lookback_hours=s.lookback_hours)
        .join(named, "workspace_id", "left").orderBy("workspace_name"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## 11 · Workspace names and URLs
# MAGIC From `system.access.workspaces_latest` (Public Preview), for the whole account. The scans use it to put names and run links on findings. If this cell fails, findings still work without them.

# COMMAND ----------

show("sql/explore/11_workspace_names.sql", optional=True)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 12 · Job inventory
# MAGIC Every job in the region at its newest definition, without deleted jobs. `run_as` is the identity a job runs as. Use the names here to write each monitored job's `job_name_regex`.

# COMMAND ----------

show("sql/explore/12_job_inventory.sql")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 13 · Runs in the window
# MAGIC One row per run, with its hourly rows folded together. An empty `result_state` means the run is still going (or its last hour has not landed yet).

# COMMAND ----------

show("sql/explore/13_runs_in_window.sql")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 14 · Failed runs
# MAGIC Runs that ended FAILED, ERROR or TIMED_OUT, with the termination code and type. A termination type of `CLIENT_ERROR` usually means the code or its inputs (a functional failure); `INTERNAL_ERROR` or `CLOUD_FAILURE` point at the platform or cloud (an infrastructure failure).

# COMMAND ----------

show("sql/explore/14_failed_runs.sql")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 15 · Failed tasks
# MAGIC Task runs that failed. A task can fail inside a run that keeps going, for example in a continuous job, so this catches problems the run level misses.

# COMMAND ----------

show("sql/explore/15_task_failures.sql")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 16 · Longest runs
# MAGIC The 50 longest runs, finished or still going. Compare with the `max_runtime_minutes` values in your config.

# COMMAND ----------

show("sql/explore/16_long_runs.sql")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 17 · Newest finished run of each job
# MAGIC Is every job's latest result good? Jobs with no finished run in the window show empty run columns.

# COMMAND ----------

show("sql/explore/17_last_run_per_job.sql")
